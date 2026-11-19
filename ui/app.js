"use strict";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const state = {
  config: null,
  status: null,
  commands: [],
  apkPath: "",
  busy: false,
  lastResult: null,
  lastWeb: null,
  codeInfo: null,
  codeCheckTimer: null,
  codeCheckSeq: 0,
  codeChecking: false,
  mcpAvailable: null,
  mcpRunning: false,
  mcpChecking: false,
  mcpBusy: false,
  webPreflight: null,
  webProgressTimer: null,
  webProgress: null,
  webProgressFinished: false,
  blueprintSource: "",
  blueprintResult: null,
  blueprintTimer: null,
  blueprintBusy: false,
  toastTimer: null,
  requestTable: { rows: [], filter: "", sortKey: null, sortDirection: 1 },
};

const CHECK_LABELS = {
  node: "Node.js",
  npm: "npm",
  host: "System",
  jadx: "JADX",
  apktool: "apktool",
  adb: "ADB",
  java: "Java",
  python: "Python",
};

function escapeHtml(value) {
  const node = document.createElement("div");
  node.textContent = String(value ?? "");
  return node.innerHTML;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms)) return "–";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "–";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function expandHome(value) {
  const path = String(value || "").trim();
  if (!path) return "";
  if (path === "~") return state.config?.home || path;
  if (path.startsWith("~/") && state.config?.home) {
    return `${state.config.home}/${path.slice(2)}`;
  }
  return path;
}

function toast(message, bad = false) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.toggle("bad", bad);
  element.classList.remove("hidden");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => element.classList.add("hidden"), 4200);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const raw = await response.text();
  let data = null;
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = { error: raw || `HTTP ${response.status}` };
  }
  if (!response.ok) {
    throw new Error(data?.error || `HTTP ${response.status}`);
  }
  return data;
}

function setConnection(mode, label) {
  const element = $("#connection");
  element.classList.remove("online", "offline");
  if (mode === "online") element.classList.add("online");
  if (mode === "offline") element.classList.add("offline");
  $("#connectionText").textContent = label;
}

function setNavMore(open) {
  $("#navMoreMenu").classList.toggle("hidden", !open);
  $("#navMoreToggle").setAttribute("aria-expanded", String(open));
}

function showTab(name) {
  $$(".tab[data-tab]").forEach((button) =>
    button.classList.toggle("active", button.dataset.tab === name),
  );
  const inMore = name === "mcp" || name === "commands";
  $("#navMoreToggle").classList.toggle("active", inMore);
  setNavMore(inMore);
  $$("[data-panel]").forEach((panel) =>
    panel.classList.toggle("active", panel.dataset.panel === name),
  );
  window.scrollTo({ top: 0, behavior: "smooth" });
  if (name === "mcp") refreshMcp();
  if (name === "apk") refreshApkActions();
  if (name === "web") refreshWebPreflight(false);
  if (name === "blueprint") refreshBlueprintPanel();
}

function setActionState(button, disabled, reason = "") {
  if (!button) return;
  button.disabled = disabled;
  button.setAttribute("aria-disabled", String(disabled));
  const normalTitle = button.dataset.defaultTitle || button.title;
  if (disabled) button.title = reason || normalTitle;
  else button.title = normalTitle;
}

function renderStatus(data) {
  state.status = data;
  const checks = Array.isArray(data.checks) ? data.checks : [];
  const byName = (name) => checks.find((check) => check.name === name);
  const web = state.webPreflight?.browser;
  const webOk = Boolean(web?.ok);
  const node = byName("node");
  const missingRequired = [
    !node?.ok ? "Node.js" : "",
    !webOk ? "Chromium" : "",
  ].filter(Boolean);

  const summary = [
    `<span class="pill ${data.version && data.version !== "unbekannt" ? "good" : "warn"}">REA ${escapeHtml(data.version)}</span>`,
    `<span class="pill good">Basis bereit</span>`,
    data.termux
      ? `<span class="pill good">Termux erkannt</span>`
      : `<span class="pill">Desktop</span>`,
  ].join("");

  const readiness = `
    <div class="readiness">
      <div class="readiness-item ${webOk ? "good" : "warn"}">
        <div>
          <strong>Web-Aufnahme ${webOk ? "bereit" : "nicht bereit"}</strong>
          <span>
            ${
              webOk
                ? `Bereit${web.version ? ` – ${escapeHtml(web.version)}` : ""}.`
                : escapeHtml(web?.detail || "Chromium/Chrome fehlt.")
            }
            Pflicht dafür: REA, Node.js und Chromium.
            ${missingRequired.length > 0 ? `Fehlt: ${escapeHtml(missingRequired.join(", "))}.` : "Alles vorhanden."}
          </span>
        </div>
        <button class="btn small ghost" type="button" data-go="web" title="Zum Bereich Web-App wechseln und eine URL aufnehmen.">
          Zur Web-Aufnahme
        </button>
      </div>
      <div class="readiness-item good">
        <div>
          <strong>APK-Analyse</strong>
          <span>
            Überblick und Signatur brauchen keine Zusatzwerkzeuge. Manifest,
            Klassen und Methoden liest JADX; Ressourcen und Strings apktool.
          </span>
        </div>
        <button class="btn small ghost" type="button" data-go="apk" title="Zum Bereich APK prüfen wechseln.">
          Zu APK
        </button>
      </div>
      <div class="readiness-item ${node?.ok ? "good" : "warn"}">
        <div>
          <strong>Apps &amp; Dateien</strong>
          <span>
            JavaScript/Electron und die Härtungsprüfung brauchen keine
            Zusatzwerkzeuge. Native Binärdateien analysiert Ghidra headless;
            Symbole, Abschnitte, Strings und Einstiegspunkte erscheinen direkt
            in der Oberfläche.
          </span>
        </div>
        <button class="btn small ghost" type="button" data-go="code" title="Zum Bereich Apps & Dateien wechseln.">
          Zu Dateien
        </button>
      </div>
    </div>
    <p class="hint readiness-note">
      Für Web-Aufnahmen sind JADX, apktool und Ghidra nicht nötig. JADX und
      apktool werden für die APK-Analyse verwendet; Ghidra für native Dateien.
      Die Werkzeuge liegen im Projekt und werden beim Start automatisch
      gefunden.
    </p>`;

  const lines = checks
    .map((check) => {
      const label = CHECK_LABELS[check.name] || check.name;
      const detail = check.detail ? String(check.detail) : "";
      const remediation = check.remediation ? String(check.remediation) : "";
      return `<div class="status-line ${check.ok ? "ok" : "bad"}">
        <span class="mark">${check.ok ? "✓" : "!"}</span>
        <div><strong>${escapeHtml(label)}</strong>
          ${detail ? `<span> ${escapeHtml(detail.length > 150 ? `${detail.slice(0, 150)}…` : detail)}</span>` : ""}
          ${!check.ok && remediation ? `<small>${escapeHtml(remediation.length > 190 ? `${remediation.slice(0, 190)}…` : remediation)}</small>` : ""}
        </div>
      </div>`;
    })
    .join("");

  const details = `
    <details class="status-details">
      <summary>Alle technischen Prüfungen anzeigen (${checks.length})</summary>
      ${lines || `<p class="muted">Keine Detailprüfungen gemeldet.</p>`}
      ${data.doctorError ? `<div class="status-line bad"><span class="mark">!</span><div><strong>Doctor</strong><span> ${escapeHtml(data.doctorError)}</span></div></div>` : ""}
    </details>`;

  $("#statusBox").innerHTML = `
    <div class="status-summary">${summary}</div>
    ${readiness}
    ${details}
  `;
  refreshApkActions();
  refreshCodeActions();
}

async function refreshStatus() {
  setConnection("checking", "Prüfe …");
  try {
    const [data, web] = await Promise.all([
      api("/api/status?refresh=1"),
      api("/api/web/preflight").catch(() => null),
    ]);
    state.webPreflight = web;
    renderStatus(data);
    setConnection("online", "Lokal verbunden");
  } catch (error) {
    setConnection("offline", "Nicht erreichbar");
    $("#statusBox").innerHTML =
      `<div class="status-line bad"><span class="mark">!</span><div><strong>Server</strong><span> ${escapeHtml(
        error.message,
      )}</span></div></div>`;
  }
}

function refreshCommandActions() {
  const command = $("#commandSelect").value;
  const runButton = $("#runCommand");
  const helpButton = $("#commandHelp");
  const hint = $("#commandActionHint");

  if (!command || state.commands.length === 0) {
    setActionState(
      runButton,
      true,
      state.commands.length === 0
        ? "Die Befehlsliste ist nicht geladen."
        : "Bitte zuerst einen Befehl auswählen.",
    );
    setActionState(helpButton, true, "Bitte zuerst einen Befehl auswählen.");
    if (hint) {
      hint.textContent = state.commands.length
        ? "Bitte einen Befehl auswählen. Danach kannst du seine Hilfe ansehen oder ihn ausführen."
        : "Die Befehlsliste konnte nicht geladen werden. Prüfe, ob der lokale REA-Server läuft.";
      hint.classList.add("warn");
    }
    return;
  }

  setActionState(runButton, false);
  setActionState(helpButton, false);
  if (!hint) return;
  if (command === "capabilities" || command === "version") {
    hint.textContent = `Vorbelegt ist „${command}“ – ein sicherer Test ohne Argumente, der nichts verändert. Wähle links einen anderen Befehl oder trage Argumente ein.`;
  } else {
    hint.textContent = `Vorbelegt ist „${command}“. Prüfe die Argumente, bevor du „Ausführen“ drückst; „Hilfe anzeigen“ erklärt den Befehl.`;
  }
  hint.classList.remove("warn");
}

function populateCommands() {
  const select = $("#commandSelect");
  select.innerHTML = "";
  for (const command of state.commands) {
    const option = document.createElement("option");
    option.value = command.name;
    option.textContent = command.name;
    select.append(option);
  }

  const preferred = ["capabilities", "version"].find((name) =>
    state.commands.some((command) => command.name === name),
  );
  if (preferred) {
    select.value = preferred;
  } else {
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Bitte wählen …";
    select.prepend(placeholder);
    select.value = "";
  }
  refreshCommandActions();
}

function renderCommandList(filter = "") {
  const list = $("#commandList");
  const needle = filter.trim().toLowerCase();
  const matches = state.commands.filter(
    (command) =>
      !needle ||
      command.name.toLowerCase().includes(needle) ||
      command.description.toLowerCase().includes(needle),
  );

  list.innerHTML = "";
  if (matches.length === 0) {
    list.innerHTML = `<p class="empty">Kein Befehl gefunden.</p>`;
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const command of matches) {
    const button = document.createElement("button");
    button.className = "command-item";
    button.type = "button";
    const name = document.createElement("code");
    name.textContent = command.name;
    const description = document.createElement("span");
    description.textContent = command.description;
    button.append(name, description);
    button.addEventListener("click", () => selectCommand(command.name));
    fragment.append(button);
  }
  list.append(fragment);
}

function selectCommand(name) {
  const select = $("#commandSelect");
  select.value = name;
  $("#commandArgs").value = "";
  refreshCommandActions();
  $("#commandRunner").scrollIntoView({ behavior: "smooth", block: "start" });
  $("#commandArgs").focus();
}

function parseArguments(input) {
  const result = [];
  let current = "";
  let quote = null;
  let escaped = false;

  for (const character of input) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current) {
        result.push(current);
        current = "";
      }
      continue;
    }
    current += character;
  }

  if (quote) throw new Error("Anführungszeichen wurde nicht geschlossen.");
  if (escaped) current += "\\";
  if (current) result.push(current);
  return result;
}

const RESULT_HELP = [
  [
    /^APK-Überblick/,
    "Die Ausgabe ist technische Evidenz. „subject“ ist die Datei, „coverage“ sagt, wie vollständig geprüft wurde, und „next_probes“ sind Vorschläge für den nächsten Schritt.",
  ],
  [
    /^APK-Signatur/,
    "Achte besonders auf „matches_apk“ und die Zertifikat-Fingerabdrücke. Eine gültige Signatur bedeutet nicht automatisch, dass die App vertrauenswürdig ist.",
  ],
  [
    /^APK-Werkzeuge prüfen/,
    "„healthy: false“ heißt hier nur: Mindestens ein optionaler Prüfpunkt ist nicht aktiv. Die Tabelle „scope_checks“ zeigt den Status je Punkt. Überblick, Signatur und Härtung funktionieren unabhängig davon.",
  ],
  [
    /^Manifest/,
    "„package“ ist der Paketname. Die Komponenten zeigen Activities, Services, Receiver und Provider der App.",
  ],
  [
    /^(Alle Klassen|Klassen:)/,
    "Die Liste zeigt Klassennamen aus der APK. Mit „Methode anzeigen“ kannst du eine Klasse gezielt öffnen.",
  ],
  [
    /^Methode:/,
    "Der angezeigte Code ist ein Dekompilat, keine Originalquelle. Namen und Struktur können durch Optimierung verändert sein.",
  ],
  [
    /^Ressourcen/,
    "Strings und Manifest sind aus der APK dekodiert. Das ist lesbarer als die Binärform, aber keine Garantie auf vollständige Semantik.",
  ],
  [
    /^(Anwendung|JavaScript)/,
    "„coverage“ zeigt, wie weit die Analyse trägt. Die App wurde dabei nicht ausgeführt.",
  ],
  [
    /^Technische Übersicht/,
    "Die Übersicht beschreibt Struktur und Metadaten. Für Code und Verhalten sind weitere, gezielte Schritte nötig.",
  ],
  [
    /^Web-App/,
    "Die Aufnahme zeigt den beobachteten Lauf: Netzwerk, Events, DOM und Skripte. Die Beweise und exportierten Skripte liegen lokal. Unter „Weitere Exporte“ bekommst du Event-Arten und Evidenzpfade als Text oder CSV sowie alles als JSON.",
  ],
];

function helpForLabel(label) {
  const match = RESULT_HELP.find(([pattern]) => pattern.test(label));
  return (
    match?.[1] ||
    "Die Ausgabe ist technische Evidenz. In der Hilfe stehen die wichtigsten Begriffe; für den Alltag reicht meist der erste Überblick."
  );
}

function setWebActions(visible) {
  $$(".web-only").forEach((element) =>
    element.classList.toggle("hidden", !visible),
  );
  if (!visible) $("#exportMenu").removeAttribute("open");
}

function hasWebResultData(result) {
  const web = result?.web;
  if (!web) return false;
  return Boolean(
    web.evidence?.capture ||
    web.evidence?.scripts ||
    web.analysis?.completed ||
    web.network?.requests?.length,
  );
}

const REQUEST_COLUMNS = [
  { key: "number", label: "#" },
  { key: "method", label: "Methode" },
  { key: "status", label: "Status" },
  { key: "type", label: "Typ" },
  { key: "url", label: "URL" },
];

function requestDisplayStatus(request) {
  return String(
    request.status ?? (request.failed ? "Netzwerkfehler" : "offen"),
  );
}

function buildRequestRows(requests) {
  return requests.map((request, index) => {
    const hasStatus = Number.isInteger(request.status);
    return {
      number: index + 1,
      method: String(request.method || "?"),
      status: requestDisplayStatus(request),
      statusRank: hasStatus ? request.status : Number.MAX_SAFE_INTEGER,
      statusClass: hasStatus
        ? `${Math.floor(request.status / 100)}xx`
        : request.failed
          ? "failed"
          : "unknown",
      type: String(request.resource_type || "unbekannt"),
      url: String(request.url || ""),
    };
  });
}

function requestSortValue(row, key) {
  if (key === "number") return row.number;
  if (key === "status") return row.statusRank;
  return row[key];
}

function compareRequestRows(left, right, key) {
  const a = requestSortValue(left, key);
  const b = requestSortValue(right, key);
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), "de", {
    numeric: true,
    sensitivity: "base",
  });
}

function requestMatchesFilter(row, needle) {
  if (!needle) return true;
  return [row.method, row.status, row.type, row.url].some((value) =>
    value.toLowerCase().includes(needle),
  );
}

function hideRequestTable() {
  state.requestTable = {
    rows: [],
    filter: "",
    sortKey: null,
    sortDirection: 1,
  };
  $("#requestTableSection").classList.add("hidden");
  const tail = $("#resultOutputTail");
  tail.classList.add("hidden");
  tail.textContent = "";
}

function showRequestTable(requests) {
  state.requestTable = {
    rows: buildRequestRows(requests),
    filter: "",
    sortKey: null,
    sortDirection: 1,
  };
  $("#requestFilter").value = "";
  $("#requestTableTitle").textContent = `Requests (${requests.length})`;
  $("#requestTableSection").classList.remove("hidden");
  drawRequestTable();
}

function currentRequestRows() {
  const view = state.requestTable;
  const needle = view.filter.trim().toLowerCase();
  const rows = view.rows.filter((row) => requestMatchesFilter(row, needle));
  if (view.sortKey) {
    rows.sort(
      (left, right) =>
        compareRequestRows(left, right, view.sortKey) * view.sortDirection,
    );
  }
  return rows;
}

function drawRequestTable() {
  const view = state.requestTable;
  const rows = currentRequestRows();

  const table = $("#requestTableGrid");
  table.textContent = "";
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const column of REQUEST_COLUMNS) {
    const cell = document.createElement("th");
    cell.scope = "col";
    const active = view.sortKey === column.key;
    cell.setAttribute(
      "aria-sort",
      active ? (view.sortDirection === 1 ? "ascending" : "descending") : "none",
    );
    const button = document.createElement("button");
    button.type = "button";
    button.className = "request-sort";
    const label = document.createElement("span");
    label.textContent = column.label;
    const mark = document.createElement("span");
    mark.className = "request-sort-mark";
    mark.classList.toggle("is-active", active);
    mark.setAttribute("aria-hidden", "true");
    mark.textContent = active ? (view.sortDirection === 1 ? "▲" : "▼") : "↕";
    button.append(label, mark);
    button.addEventListener("click", () => {
      if (view.sortKey === column.key) {
        view.sortDirection *= -1;
      } else {
        view.sortKey = column.key;
        view.sortDirection = 1;
      }
      drawRequestTable();
    });
    cell.append(button);
    headRow.append(cell);
  }
  head.append(headRow);
  table.append(head);

  const body = document.createElement("tbody");
  if (rows.length === 0) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = REQUEST_COLUMNS.length;
    cell.className = "request-table-empty";
    cell.textContent = "Kein Request passt zum Filter.";
    row.append(cell);
    body.append(row);
  } else {
    for (const entry of rows) {
      const row = document.createElement("tr");
      const values = [
        { text: String(entry.number), className: "request-number" },
        { text: entry.method, className: "request-method" },
        {
          text: entry.status,
          className: `request-status ${entry.statusClass}`,
        },
        { text: entry.type, className: "request-type" },
        { text: entry.url, className: "request-url" },
      ];
      for (const value of values) {
        const cell = document.createElement("td");
        cell.className = value.className;
        cell.textContent = value.text;
        row.append(cell);
      }
      body.append(row);
    }
  }
  table.append(body);

  const sortColumn = REQUEST_COLUMNS.find(
    (column) => column.key === view.sortKey,
  );
  const sortLabel = sortColumn
    ? `${sortColumn.label} ${view.sortDirection === 1 ? "aufsteigend" : "absteigend"}`
    : "Reihenfolge der Aufnahme";
  $("#requestTableStatus").textContent =
    `Zeige ${rows.length} von ${view.rows.length} Requests. ` +
    `Sortierung: ${sortLabel}. Export übernimmt genau diese Zeilen.`;
}

function requestRowsText(rows) {
  const cells = rows.map((row) => ({
    number: String(row.number),
    method: row.method,
    status: row.status,
    type: row.type,
    url: row.url,
  }));
  const width = (header, values) =>
    values.reduce((max, value) => Math.max(max, value.length), header.length);
  const numberWidth = width(
    "#",
    cells.map((row) => row.number),
  );
  const methodWidth = width(
    "Methode",
    cells.map((row) => row.method),
  );
  const statusWidth = width(
    "Status",
    cells.map((row) => row.status),
  );
  const typeWidth = width(
    "Typ",
    cells.map((row) => row.type),
  );
  const line = (row) =>
    [
      row.number.padStart(numberWidth),
      row.method.padEnd(methodWidth),
      row.status.padEnd(statusWidth),
      row.type.padEnd(typeWidth),
      row.url,
    ].join("  ");
  return [
    line({
      number: "#",
      method: "Methode",
      status: "Status",
      type: "Typ",
      url: "URL",
    }),
    ...cells.map(line),
  ].join("\n");
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[";\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function requestRowsCsv(rows) {
  const lines = ["Nr.;Methode;Status;Typ;URL"];
  for (const row of rows) {
    lines.push(
      [row.number, row.method, row.status, row.type, row.url]
        .map(csvCell)
        .join(";"),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}

function webExportFilename(kind, extension) {
  let host = "";
  try {
    host = new URL(state.lastResult?.web?.url || "").hostname.replace(
      /[^\w.-]+/g,
      "-",
    );
  } catch {
    // Neutraler Dateiname, wenn die Adresse fehlt.
  }
  const prefix = host ? `${host}-${kind}` : kind;
  return `${prefix}-${new Date().toISOString().slice(0, 10)}.${extension}`;
}

async function copyRequestTable() {
  const rows = currentRequestRows();
  if (rows.length === 0) {
    toast("Kein Request passt zum Filter.", true);
    return;
  }
  await copyText(
    requestRowsText(rows),
    `${rows.length} Requests als Text kopiert.`,
  );
}

function downloadRequestCsv() {
  const rows = currentRequestRows();
  if (rows.length === 0) {
    toast("Kein Request passt zum Filter.", true);
    return;
  }
  downloadText(
    `\uFEFF${requestRowsCsv(rows)}`,
    webExportFilename("requests", "csv"),
    "text/csv;charset=utf-8",
    `${rows.length} Requests als CSV gespeichert.`,
  );
}

const WEB_PROGRESS_ORDER = [
  "preflight",
  "prepare",
  "capture",
  "scripts",
  "analyze",
  "report",
];

function updateWebProgressUI(progress) {
  const data = progress || {};
  const stage = data.stage || "preflight";
  const percent = Number.isFinite(Number(data.percent))
    ? Number(data.percent)
    : 0;
  $("#webProgressLabel").textContent = data.label || "Lauf wird vorbereitet …";
  $("#webProgressPercent").textContent = `${Math.round(percent)} %`;
  $("#webProgressDetail").textContent = data.detail || "Bitte warten …";
  $("#webProgressBar").style.width = `${Math.max(3, Math.min(100, percent))}%`;
  const currentIndex = WEB_PROGRESS_ORDER.indexOf(stage);
  $$("#webProgressSteps li").forEach((item) => {
    const index = WEB_PROGRESS_ORDER.indexOf(item.dataset.stage);
    item.classList.toggle(
      "done",
      stage === "done" || (currentIndex >= 0 && index < currentIndex),
    );
    item.classList.toggle("active", stage !== "done" && index === currentIndex);
  });
  $("#webProgress").classList.toggle("is-error", stage === "error");
  $("#webProgress").classList.toggle("is-done", stage === "done");
}

function startWebProgress() {
  stopWebProgress();
  state.webProgressFinished = false;
  showWebProgress({
    stage: "preflight",
    label: "Browser wird geprüft",
    detail: "Die Voraussetzungen für die Aufnahme werden geprüft.",
    percent: 3,
  });
  state.webProgressTimer = setInterval(pollWebProgress, 700);
  setTimeout(pollWebProgress, 250);
}

function showWebProgress(progress) {
  state.webProgress = progress;
  $("#webProgress").classList.remove("hidden");
  updateWebProgressUI(progress);
}

async function pollWebProgress() {
  if (!state.busy || state.webProgressFinished) return;
  try {
    const data = await api("/api/web/progress");
    if (!state.busy || state.webProgressFinished) return;
    if (data?.stage) {
      state.webProgress = data;
      updateWebProgressUI(data);
      if (data.stage === "done" || data.stage === "error") {
        stopWebProgress();
      }
    }
  } catch {
    // The final POST response remains authoritative; keep the last known stage.
  }
}

function stopWebProgress() {
  state.webProgressFinished = true;
  if (state.webProgressTimer) {
    clearInterval(state.webProgressTimer);
    state.webProgressTimer = null;
  }
}

function completeWebProgress() {
  stopWebProgress();
  state.webProgressFinished = true;
  const progress = {
    stage: "done",
    label: "Fertig",
    detail: "Aufnahme und Auswertung sind abgeschlossen.",
    percent: 100,
  };
  state.webProgress = progress;
  updateWebProgressUI(progress);
  setTimeout(() => {
    if (state.webProgress?.stage === "done") {
      $("#webProgress").classList.add("hidden");
    }
  }, 2500);
}

function failWebProgress(message) {
  stopWebProgress();
  state.webProgressFinished = true;
  const progress = {
    stage: "error",
    label: "Lauf abgebrochen",
    detail: message || "Die Analyse konnte nicht abgeschlossen werden.",
    percent: 100,
  };
  state.webProgress = progress;
  $("#webProgress").classList.remove("hidden");
  updateWebProgressUI(progress);
}

function showResult(label, args) {
  state.lastResult = null;
  stopWebProgress();
  setWebActions(false);
  hideRequestTable();
  $("#resultHelp").textContent = helpForLabel(label);
  $("#resultCard").classList.remove("hidden");
  $("#resultLabel").textContent = label;
  $("#resultTitle").textContent = "Ausgabe";
  $("#resultMeta").innerHTML = `<span class="meta-pill">läuft …</span>`;
  $("#commandBox").classList.remove("hidden");
  $("#resultCommand").textContent = args.join(" ");
  $("#resultOutput").textContent = "Bitte warten …";
  $("#resultError").classList.add("hidden");
  $("#resultError").textContent = "";
  $("#webProgress").classList.add("hidden");
  $("#resultOverview").classList.add("hidden");
  $("#evidencePanel").classList.add("hidden");
  $("#evidenceTree").classList.add("hidden");
  $("#rawReport").open = false;
  $("#resultCard").scrollIntoView({ behavior: "smooth", block: "start" });
}

function visibleStderr(value) {
  const lines = String(value || "").split(/\r?\n/);
  const kept = lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return true;
    try {
      const parsed = JSON.parse(trimmed);
      return !parsed || typeof parsed !== "object" || !parsed.rea_progress;
    } catch {
      return true;
    }
  });
  return kept.join("\n").trim();
}

function stripLimitationText(value) {
  const lines = String(value || "").split(/\r?\n/);
  const kept = [];
  let skipping = false;
  for (const line of lines) {
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      skipping = /limitation|einschränk|grenzen/i.test(heading[1]);
      if (skipping) continue;
      kept.push(line);
      continue;
    }
    if (skipping) continue;
    if (/^\|.*(limitation|einschränk|grenzen).*\|/i.test(line)) continue;
    kept.push(line);
  }
  return kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function renderResult(result, label, args) {
  setWebActions(hasWebResultData(result));
  $("#resultLabel").textContent = label;
  const hasOutput = Boolean(result.stdout?.trim());
  const status = result.ok ? "Erfolg" : hasOutput ? "Mit Hinweisen" : "Fehler";
  const statusClass = result.ok ? "good" : hasOutput ? "warn" : "bad";
  $("#resultTitle").textContent = result.ok
    ? "Fertig"
    : hasOutput
      ? "Mit Hinweisen"
      : "Fehlgeschlagen";
  const evidenceIndex = args.indexOf("--evidence_output");
  const evidencePath = evidenceIndex >= 0 ? args[evidenceIndex + 1] : null;
  const evidenceName = evidencePath ? evidencePath.split("/").pop() : null;
  const shortEvidence =
    evidenceName && evidenceName.length > 42
      ? `${evidenceName.slice(0, 39)}…`
      : evidenceName;

  $("#resultMeta").innerHTML = [
    `<span class="meta-pill ${statusClass}">${status}</span>`,
    `<span class="meta-pill">${formatDuration(result.durationMs)}</span>`,
    `<span class="meta-pill">Exit ${escapeHtml(result.exitCode ?? "–")}</span>`,
    result.timedOut ? `<span class="meta-pill bad">Zeitlimit</span>` : "",
    result.truncated ? `<span class="meta-pill">Ausgabe gekürzt</span>` : "",
    shortEvidence
      ? `<span class="meta-pill">Evidenz: ${escapeHtml(shortEvidence)}</span>`
      : "",
  ].join("");
  $("#commandBox").classList.remove("hidden");
  $("#resultCommand").textContent = args.join(" ");

  const rawOutput = result.stdout || "";
  const cleanedOutput = stripLimitationText(rawOutput);
  state.lastResult = { ...result, stdout: cleanedOutput, label, args };
  if (state.lastResult.web) state.lastWeb = state.lastResult.web;
  const requests = result.web?.network?.requests;
  const range = result.web?.reportTable;
  const canSplitReport =
    Array.isArray(requests) &&
    requests.length > 0 &&
    Boolean(cleanedOutput) &&
    cleanedOutput.length === rawOutput.length &&
    range &&
    Number.isInteger(range.start) &&
    Number.isInteger(range.end) &&
    range.start >= 0 &&
    range.end > range.start &&
    range.end <= rawOutput.length;
  const shownOutput = cleanedOutput.trim()
    ? cleanedOutput
    : result.stderr?.trim()
      ? ""
      : "(keine Ausgabe)";
  const tail = $("#resultOutputTail");
  if (canSplitReport) {
    $("#resultOutput").textContent = shownOutput
      .slice(0, range.start)
      .trimEnd();
    const tailText = shownOutput.slice(range.end).replace(/^\n+/, "");
    tail.textContent = tailText;
    tail.classList.toggle("hidden", !tailText.trim());
  } else {
    $("#resultOutput").textContent = shownOutput;
    tail.textContent = "";
    tail.classList.add("hidden");
  }
  if (Array.isArray(requests) && requests.length > 0)
    showRequestTable(requests);
  else hideRequestTable();

  const error = $("#resultError");
  const stderr = stripLimitationText(visibleStderr(result.stderr));
  if (stderr) {
    error.textContent = stderr;
    error.classList.remove("hidden");
  } else {
    error.textContent = "";
    error.classList.add("hidden");
  }

  const webResult = hasWebResultData(result);
  if (webResult) {
    renderWebOverview(result);
    renderEvidencePanel(result);
    completeWebProgress();
  } else {
    $("#resultOverview").classList.add("hidden");
    $("#evidencePanel").classList.add("hidden");
    $("#evidenceTree").classList.add("hidden");
  }
  $("#rawReport").open = !webResult;

  $("#resultCard").scrollIntoView({ behavior: "smooth", block: "start" });
}

const SECTION_LABELS = {
  events: "Events",
  network: "Netzwerk",
  dom: "DOM",
  storage: "Speicher",
  accessibility: "Barrierefreiheit",
  history: "Verlauf",
  workers: "Worker",
  frames: "Frames",
  console: "Konsole",
  cookies: "Cookies",
};

function completenessView(completeness) {
  const status = String(completeness?.status || "unknown");
  const missing = Array.isArray(completeness?.missing_sections)
    ? completeness.missing_sections.map(
        (section) => SECTION_LABELS[section] || String(section),
      )
    : [];
  if (status === "complete") {
    return {
      value: "Vollständig",
      help: "Alle angeforderten Bereiche wurden aufgenommen.",
      warn: false,
    };
  }
  if (status === "incomplete") {
    return {
      value: "Unvollständig",
      help: missing.length
        ? `Hinweis: Der Bericht meldet fehlende Abschnitte: ${missing.join(", ")}. Die Aufnahme ist trotzdem nutzbar – das ist kein Fehlschlag.`
        : "Hinweis: Einzelne Berichtsabschnitte konnten nicht bestätigt werden. Die Aufnahme ist trotzdem nutzbar.",
      warn: true,
    };
  }
  return {
    value: "Unbekannt",
    help: "Der Abschlussstatus wurde nicht gemeldet. Die vorhandenen Daten können trotzdem genutzt werden.",
    warn: true,
  };
}

function renderWebOverview(result) {
  const web = result?.web;
  if (!web || !hasWebResultData(result)) {
    $("#resultOverview").classList.add("hidden");
    return;
  }

  const requests = Array.isArray(web.network?.requests)
    ? web.network.requests.length
    : Number(web.network?.transactions) || 0;
  const retained = Number(web.events?.retained) || 0;
  const dropped = Number(web.events?.dropped) || 0;
  const kinds = Array.isArray(web.events?.by_kind)
    ? web.events.by_kind.length
    : 0;
  const completeness = completenessView(web.completeness);
  const analysisDone = Boolean(web.analysis?.completed);
  const stats = web.analysis?.summary?.statistics || {};
  const parsedScripts =
    stats.parsed_javascript_files ??
    stats.parsed_files ??
    web.scripts?.fileCount ??
    0;
  const findings = Number.isFinite(Number(stats.findings))
    ? Number(stats.findings)
    : null;

  $("#overviewRequests").textContent = String(requests);
  $("#overviewEvents").textContent = String(retained);
  $("#overviewEventsHelp").textContent = `${dropped} verworfen${
    kinds > 0 ? ` · ${kinds} Arten` : ""
  }.`;
  $("#overviewCompleteness").textContent = completeness.value;
  $("#overviewCompletenessHelp").textContent = completeness.help;
  $("#overviewAnalysis").textContent = analysisDone
    ? "Geprüft"
    : "Nicht geprüft";
  $("#overviewAnalysisHelp").textContent = analysisDone
    ? `${parsedScripts} ${
        parsedScripts === 1 ? "Skript" : "Skripte"
      } statisch geprüft${findings !== null ? `, ${findings} Findings` : ""}.`
    : "Es wurden keine JavaScript-Dateien zur Analyse gefunden.";

  $("#overviewRequestsCard").classList.remove("warn");
  $("#overviewEventsCard").classList.toggle(
    "warn",
    retained === 0 && requests > 0,
  );
  $("#overviewCompletenessCard").classList.toggle("warn", completeness.warn);
  $("#overviewAnalysisCard").classList.toggle("warn", !analysisDone);

  $("#overviewNote").textContent = completeness.warn
    ? "Ein fehlender Berichtsabschnitt ist ein Hinweis, kein Abbruch: Requests, Beweise und die übrigen Daten bleiben nutzbar. Details stehen im vollständigen Bericht."
    : analysisDone
      ? "Die Aufnahme ist vollständig. Beweise und Skripte stehen unten zum Ansehen und Herunterladen bereit."
      : "Die Aufnahme ist vollständig; JavaScript-Dateien wurden nicht gefunden oder nicht analysiert.";
  $("#resultOverview").classList.remove("hidden");
}

function artifactUrl(path, download = false) {
  return `/api/web/artifact?path=${encodeURIComponent(path)}${
    download ? "&download=1" : ""
  }`;
}

function evidenceLabelPath(path) {
  const parts = String(path).split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join("/");
}

function addEvidenceItem(actions, label, path) {
  const row = document.createElement("div");
  row.className = "evidence-item";
  const info = document.createElement("div");
  const strong = document.createElement("strong");
  strong.textContent = label;
  const small = document.createElement("small");
  small.textContent = evidenceLabelPath(path);
  small.title = path;
  info.append(strong, small);

  const buttons = document.createElement("div");
  buttons.className = "evidence-item-actions";
  const view = document.createElement("button");
  view.type = "button";
  view.className = "btn small ghost";
  view.textContent = "Ansehen";
  view.title = `${label} im Fenster öffnen, ohne sie zu verändern.`;
  view.dataset.artifactView = path;
  view.dataset.artifactLabel = label;
  const download = document.createElement("a");
  download.className = "btn small ghost";
  download.textContent = "Herunterladen";
  download.title = `${label} als Originaldatei speichern.`;
  download.href = artifactUrl(path, true);
  download.setAttribute("download", "");
  buttons.append(view, download);
  row.append(info, buttons);
  actions.append(row);
}

function renderEvidencePanel(result) {
  const panel = $("#evidencePanel");
  const actions = $("#evidenceActions");
  if (!result?.web || !hasWebResultData(result)) {
    panel.classList.add("hidden");
    return;
  }

  actions.textContent = "";
  $("#evidenceTree").classList.add("hidden");
  $("#evidenceTreeList").textContent = "";
  const evidence = result.web.evidence || {};
  const files = [
    ["Aufnahme", evidence.capture],
    ["Szenario", evidence.scenario],
    ["Analyse-Evidenz", evidence.analysis],
  ].filter(([, path]) => Boolean(path));

  for (const [label, path] of files) addEvidenceItem(actions, label, path);

  if (evidence.scripts) {
    const row = document.createElement("div");
    row.className = "evidence-item";
    const info = document.createElement("div");
    const strong = document.createElement("strong");
    strong.textContent = "Skripte";
    const small = document.createElement("small");
    const scriptCount = result.web.scripts?.fileCount ?? 0;
    small.textContent =
      scriptCount === 1
        ? "1 JavaScript-Datei; der Ordner enthält auch manifest.json"
        : `${scriptCount} JavaScript-Dateien im Skript-Ordner`;
    small.title = evidence.scripts;
    info.append(strong, small);
    const buttons = document.createElement("div");
    buttons.className = "evidence-item-actions";
    const open = document.createElement("button");
    open.type = "button";
    open.className = "btn small";
    open.textContent = "Skripte anzeigen";
    open.title = "Liste der exportierten JavaScript-Dateien öffnen.";
    open.dataset.evidenceScripts = evidence.scripts;
    buttons.append(open);
    row.append(info, buttons);
    actions.append(row);
  }

  if (actions.children.length === 0) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "Für diesen Lauf wurden keine Beweise gespeichert.";
    actions.append(empty);
  }
  panel.classList.remove("hidden");
}

async function loadEvidenceTree(path) {
  const tree = $("#evidenceTree");
  const list = $("#evidenceTreeList");
  const meta = $("#evidenceTreeMeta");
  tree.classList.remove("hidden");
  meta.textContent = "";
  list.textContent = "Lade Dateiliste …";
  try {
    const data = await api(artifactUrl(path));
    if (data?.type !== "directory" || !Array.isArray(data.files)) {
      throw new Error("Der Skript-Ordner konnte nicht gelesen werden.");
    }
    meta.textContent = `${data.files.length} Datei(en)${
      data.truncated ? " · Liste gekürzt" : ""
    }`;
    list.textContent = "";
    if (data.files.length === 0) {
      const empty = document.createElement("p");
      empty.className = "hint";
      empty.textContent =
        "In diesem Lauf wurden keine JavaScript-Dateien exportiert.";
      list.append(empty);
    }
    for (const file of data.files) {
      const row = document.createElement("div");
      row.className = "script-row";
      const name = document.createElement("code");
      name.textContent = file.relative;
      name.title = file.path;
      const size = document.createElement("span");
      size.className = "script-size";
      size.textContent = formatBytes(file.size);
      const buttons = document.createElement("div");
      buttons.className = "script-actions";
      const view = document.createElement("button");
      view.type = "button";
      view.className = "btn small ghost";
      view.textContent = "Ansehen";
      view.title = "Diese JavaScript-Datei als Text im Fenster öffnen.";
      view.dataset.artifactView = file.path;
      view.dataset.artifactLabel = file.relative;
      const download = document.createElement("a");
      download.className = "btn small ghost";
      download.textContent = "Herunterladen";
      download.title = "Diese JavaScript-Datei unverändert speichern.";
      download.href = artifactUrl(file.path, true);
      download.setAttribute("download", "");
      buttons.append(view, download);
      row.append(name, size, buttons);
      list.append(row);
    }
    tree.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (error) {
    meta.textContent = "";
    list.textContent = error.message;
    toast(error.message, true);
  }
}

async function openArtifact(path, label) {
  const viewer = $("#artifactViewer");
  const text = $("#artifactViewerText");
  const meta = $("#artifactViewerMeta");
  const download = $("#artifactDownload");
  $("#artifactViewerTitle").textContent = label || "Datei ansehen";
  meta.textContent = "Lade Datei …";
  text.textContent = "";
  download.href = artifactUrl(path, true);
  download.setAttribute("download", "");
  viewer.classList.remove("hidden");
  try {
    const response = await fetch(artifactUrl(path));
    const raw = await response.text();
    if (!response.ok) {
      let message = raw || `HTTP ${response.status}`;
      try {
        message = JSON.parse(raw)?.error || message;
      } catch {
        // Keep the plain response text.
      }
      throw new Error(message);
    }
    let body = raw;
    if (path.toLowerCase().endsWith(".json")) {
      try {
        body = JSON.stringify(JSON.parse(raw), null, 2);
      } catch {
        // Show the original JSON text if it is not parseable.
      }
    }
    text.textContent = body || "(Die Datei ist leer.)";
    meta.textContent = `${label || "Datei"} · ${formatBytes(
      new Blob([raw]).size,
    )}`;
  } catch (error) {
    text.textContent = error.message;
    meta.textContent = "Datei konnte nicht geöffnet werden.";
    toast(error.message, true);
  }
}

function closeArtifact() {
  $("#artifactViewer").classList.add("hidden");
  $("#artifactViewerText").textContent = "";
  $("#artifactViewerMeta").textContent = "";
}

async function run(args, label) {
  if (state.busy) {
    toast("Es läuft bereits ein Befehl. Bitte warte, bis er fertig ist.");
    return;
  }
  state.busy = true;
  showResult(label, args);
  try {
    const result = await api("/api/run", {
      method: "POST",
      body: JSON.stringify({ args, timeoutMs: 900_000 }),
    });
    renderResult(result, label, args);
  } catch (error) {
    renderResult(
      {
        ok: false,
        exitCode: null,
        stdout: "",
        stderr: error.message,
        durationMs: 0,
        timedOut: false,
        truncated: false,
      },
      label,
      args,
    );
    toast(error.message, true);
  } finally {
    state.busy = false;
  }
}

async function withEvidence(args, label) {
  try {
    const data = await api(
      `/api/evidence-path?label=${encodeURIComponent(label)}`,
    );
    await run(
      [...args, "--detail", "summary", "--evidence_output", data.path],
      label,
    );
  } catch (error) {
    toast(error.message, true);
  }
}

function showBlocked(label, title, message, check) {
  state.lastResult = null;
  stopWebProgress();
  setWebActions(false);
  hideRequestTable();
  $("#resultCard").classList.remove("hidden");
  $("#resultLabel").textContent = label;
  $("#resultTitle").textContent = title;
  $("#resultMeta").innerHTML =
    `<span class="meta-pill warn">Nicht gestartet</span>`;
  $("#resultHelp").textContent =
    "Die Aktion wurde bewusst nicht ausgeführt, weil eine Voraussetzung fehlt. So bekommst du keine rohe Fehlermeldung.";
  $("#commandBox").classList.add("hidden");

  const details = [message];
  if (check?.technical) {
    details.push(`Technische Meldung:\n${check.technical}`);
  } else if (check?.detail) {
    details.push(`Technische Meldung:\n${check.detail}`);
  }
  if (check?.remediation) details.push(`Einrichtung:\n${check.remediation}`);
  details.push("Die Aktion wurde nicht gestartet.");
  $("#resultOutput").textContent = details.join("\n\n");
  $("#resultError").classList.add("hidden");
  $("#resultError").textContent = "";
  $("#webProgress").classList.add("hidden");
  $("#resultOverview").classList.add("hidden");
  $("#evidencePanel").classList.add("hidden");
  $("#evidenceTree").classList.add("hidden");
  $("#rawReport").open = true;
  $("#resultCard").scrollIntoView({ behavior: "smooth", block: "start" });
}

function apkActionBlockReason() {
  if (!state.apkPath) {
    return "Zuerst eine APK auswählen oder einen Pfad übernehmen.";
  }
  return "";
}

function refreshApkActions() {
  const hint = $("#apkActionHint");
  const hasApk = Boolean(state.apkPath);

  $$("[data-apk-action]").forEach((button) => {
    const reason = apkActionBlockReason();
    setActionState(button, Boolean(reason), reason);
  });

  if (!hint) return;
  hint.textContent = hasApk
    ? "APK ausgewählt. Alle Aktionen sind bereit."
    : "Noch keine APK ausgewählt. Wähle oben eine Datei oder trage einen Pfad ein und tippe auf „Pfad übernehmen“. Bis dahin sind die Aktionen deaktiviert.";
  hint.classList.toggle("warn", !hasApk);
}

function requireApk() {
  if (!state.apkPath) {
    toast("Bitte zuerst eine APK auswählen oder einen Pfad übernehmen.", true);
    showTab("apk");
    return null;
  }
  return state.apkPath;
}

function setApkPath(path, source) {
  const resolved = expandHome(path);
  if (!resolved) {
    toast("Der Pfad ist leer.", true);
    return;
  }
  state.apkPath = resolved;
  $("#apkPath").value = resolved;
  const chosen = $("#apkChosen");
  chosen.textContent = `${source}: ${resolved}`;
  chosen.classList.remove("hidden");
  refreshApkActions();
  refreshBlueprintPanel();
}

async function useApkPath() {
  const raw = expandHome($("#apkPath").value);
  if (!raw) {
    toast("Bitte einen APK-Pfad eingeben.", true);
    $("#apkPath").focus();
    return;
  }
  try {
    const info = await api(`/api/path-info?path=${encodeURIComponent(raw)}`);
    if (!info.exists) {
      toast(
        `Diese APK wurde nicht gefunden: ${info.path}. Prüfe den Pfad oder lade die Datei oben hoch.`,
        true,
      );
      return;
    }
    if (!info.isFile) {
      toast("Das ist ein Ordner. Bitte eine APK-Datei auswählen.", true);
      return;
    }
    setApkPath(info.path, "Pfad");
    toast(`APK übernommen (${formatBytes(info.size)}).`);
  } catch (error) {
    toast(friendlyClientError(error), true);
  }
}

function setUploadStatus(text) {
  const element = $("#uploadText");
  if (!element) return;
  element.textContent = text || "";
  element.classList.toggle("hidden", !text);
}

function uploadFile(file) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", `/api/upload?name=${encodeURIComponent(file.name)}`);
    xhr.timeout = 120_000;
    xhr.addEventListener("timeout", () =>
      reject(
        new Error(
          "Der Upload hat zu lange gedauert. Prüfe die Verbindung und versuche es erneut.",
        ),
      ),
    );
    xhr.addEventListener("abort", () =>
      reject(new Error("Der Upload wurde abgebrochen.")),
    );
    xhr.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable) return;
      const percent = Math.max(
        1,
        Math.min(99, Math.round((event.loaded / event.total) * 100)),
      );
      $("#uploadProgress").classList.remove("hidden");
      $("#uploadBar").style.width = `${percent}%`;
      setUploadStatus(`Wird hochgeladen: ${file.name} – ${percent} %`);
    });
    xhr.addEventListener("load", () => {
      let data = null;
      try {
        data = JSON.parse(xhr.responseText || "{}");
      } catch {
        data = { error: xhr.responseText || `HTTP ${xhr.status}` };
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data?.error || `HTTP ${xhr.status}`));
    });
    xhr.addEventListener("error", () =>
      reject(new Error("Upload fehlgeschlagen.")),
    );
    xhr.send(file);
  });
}

async function handleApkFile(file) {
  if (!file) {
    toast(
      "Es wurde keine Datei ausgewählt. Tippe erneut auf „APK auswählen“.",
      true,
    );
    return;
  }
  const progress = $("#uploadProgress");
  const bar = $("#uploadBar");
  const choose = $("#apkChoose");
  choose.disabled = true;
  progress.classList.remove("hidden");
  bar.style.width = "2%";
  setUploadStatus(`Wird hochgeladen: ${file.name} (${formatBytes(file.size)})`);
  try {
    const data = await uploadFile(file);
    bar.style.width = "100%";
    setUploadStatus(
      `Übernommen: ${file.name}. Die Werkzeuge werden jetzt geprüft …`,
    );
    setApkPath(data.path, "Hochgeladen");
    if (state.blueprintSource === "apk") refreshBlueprintPanel();
    toast(`${file.name} wurde lokal übernommen (${formatBytes(data.size)}).`);
  } catch (error) {
    bar.style.width = "0%";
    setUploadStatus("");
    toast(error.message, true);
  } finally {
    choose.disabled = false;
    setTimeout(() => {
      progress.classList.add("hidden");
      setUploadStatus("");
    }, 1400);
  }
}

async function apkAction(action) {
  const path = requireApk();
  if (!path) return;
  const classQuery = $("#classQuery").value.trim();
  const methodClass = $("#methodClass").value.trim();
  const methodName = $("#methodName").value.trim();
  const overloadIndex = $("#overloadIndex").value.trim();

  switch (action) {
    case "overview":
      await withEvidence(
        ["inspect-artifact", path, "--format", "md"],
        "APK-Überblick",
      );
      return;
    case "signature":
      await run(
        [
          "inspect-apk-signature",
          path,
          "--format",
          "md",
          "--token-limit",
          "6000",
        ],
        "APK-Signatur",
      );
      return;
    case "manifest":
      await withEvidence(
        ["inspect-android-package", path, "--format", "md"],
        "Manifest und Komponenten",
      );
      return;
    case "classes":
      await run(
        [
          "search-android-classes",
          path,
          classQuery,
          "--format",
          "md",
          "--token-limit",
          "6000",
        ],
        classQuery ? `Klassen: ${classQuery}` : "Alle Klassen",
      );
      return;
    case "method":
      if (!methodClass || !methodName) {
        toast("Bitte Klasse und Methodenname eingeben.", true);
        $("#methodClass").focus();
        return;
      }
      {
        const args = [
          "inspect-android-method",
          path,
          methodClass,
          methodName,
          "--format",
          "md",
          "--token-limit",
          "6000",
        ];
        if (overloadIndex) args.push("--overload-index", overloadIndex);
        await run(args, `Methode: ${methodClass}.${methodName}`);
      }
      return;
    case "resources":
      await run(
        [
          "decode-android-resources",
          path,
          "--format",
          "md",
          "--strings",
          "--string-limit",
          "200",
          "--token-limit",
          "6000",
        ],
        "Ressourcen und Strings",
      );
      return;
    case "doctor":
      await run(
        ["doctor", "--target", path, "--format", "md"],
        "APK-Werkzeuge prüfen",
      );
      return;
    default:
      toast("Unbekannte Aktion.", true);
  }
}

function codeActionBlockReason(action, info) {
  if (!info) return "Der Pfad wird noch geprüft …";
  if (!info.exists) return info.error || "Dieser Pfad wurde nicht gefunden.";

  const kind =
    info.kind ||
    (info.isDirectory ? "directory" : info.isNativeBinary ? "native" : "other");

  if (kind === "directory") {
    return action === "analyze" || action === "javascript"
      ? ""
      : "Diese Aktion braucht eine Datei, keinen Ordner.";
  }

  if (kind === "native") {
    if (
      action === "hardening" ||
      action === "analyze" ||
      action === "inspect"
    ) {
      return "";
    }
    if (action === "extract") {
      return "Eine native Binärdatei ist kein Archiv. Entpacken ist hier nicht möglich.";
    }
    if (action === "javascript") {
      return "Eine native Binärdatei ist kein JavaScript-/Electron-Projekt.";
    }
  }

  if (kind === "archive") {
    return action === "extract"
      ? ""
      : "Dieses Archiv muss zuerst entpackt werden. Nutze „Entpacken“ und wähle danach den entpackten Ordner.";
  }

  if (kind === "javascript") {
    return action === "javascript"
      ? ""
      : "Für eine einzelne JavaScript-Quelldatei ist „JavaScript/Electron analysieren“ die passende Aktion.";
  }

  if (kind === "text") {
    return "Für diese Textdatei gibt es keine passende Analyseaktion.";
  }

  return "Das Dateiformat wurde nicht erkannt. Deshalb bleiben die Aktionen deaktiviert.";
}

function codeActionApplies(action, info) {
  if (!info?.exists || state.codeChecking) return true;
  const kind =
    info.kind ||
    (info.isDirectory ? "directory" : info.isNativeBinary ? "native" : "other");
  if (kind === "native") {
    return (
      action === "analyze" || action === "inspect" || action === "hardening"
    );
  }
  if (kind === "directory") {
    return action === "analyze" || action === "javascript";
  }
  if (kind === "archive") return action === "extract";
  if (kind === "javascript") return action === "javascript";
  return true;
}

function refreshCodeActions() {
  const value = expandHome($("#codePath").value);
  const info = state.codeInfo;
  let baseReason = "";

  if (!value) {
    baseReason =
      "Trage zuerst einen Datei- oder Ordnerpfad ein. Bis dahin sind die Aktionen deaktiviert.";
  } else if (state.codeChecking || !info) {
    baseReason = "Der Pfad wird noch geprüft …";
  } else if (!info.exists) {
    baseReason = info.error || "Dieser Pfad wurde nicht gefunden.";
  }

  $$("[data-code-action]").forEach((button) => {
    const action = button.dataset.codeAction;
    const card = button.closest(".action");
    card?.classList.toggle("hidden", !codeActionApplies(action, info));
    const reason = baseReason || codeActionBlockReason(action, info);
    setActionState(button, Boolean(reason), reason);
  });
  const extractField = $("#extractOut")?.closest(".field");
  extractField?.classList.toggle(
    "hidden",
    Boolean(value && info?.exists) && !codeActionApplies("extract", info),
  );

  const hint = $("#codeActionHint");
  if (!hint) return;
  if (!value) {
    hint.textContent =
      "Trage zuerst einen Pfad ein. Danach prüft die Oberfläche, ob die Datei oder der Ordner existiert, und schaltet die passenden Aktionen frei.";
    hint.classList.add("warn");
  } else if (state.codeChecking || !info) {
    hint.textContent = "Der Pfad wird geprüft …";
    hint.classList.add("warn");
  } else if (!info.exists) {
    hint.textContent = `${info.path} wurde nicht gefunden. Prüfe den Pfad; die Aktionen bleiben deaktiviert.`;
    hint.classList.add("warn");
  } else if (info.kind === "directory" || info.isDirectory) {
    hint.textContent = `Ordner erkannt: ${info.path}. Analyse und JavaScript/Electron sind möglich; die übrigen Aktionen brauchen eine bestimmte Datei.`;
    hint.classList.remove("warn");
  } else if (info.kind === "native" || info.isNativeBinary) {
    hint.textContent = `Native Binärdatei erkannt: ${info.name}. Analyse, Technische Übersicht und Härtung sind bereit; Ghidra liefert die Ergebnisse.`;
    hint.classList.remove("warn");
  } else if (info.kind === "archive" || info.isArchive) {
    hint.textContent = `Archiv erkannt: ${info.name}. „Entpacken“ ist möglich; danach kannst du den entpackten Ordner analysieren.`;
    hint.classList.remove("warn");
  } else if (info.kind === "javascript") {
    hint.textContent = `JavaScript-Datei erkannt: ${info.name}. Nutze „JavaScript/Electron analysieren“.`;
    hint.classList.remove("warn");
  } else if (info.kind === "text") {
    hint.textContent = `Textdatei erkannt: ${info.name}. Für dieses Format gibt es keine passende Analyseaktion; die Aktionen bleiben deaktiviert.`;
    hint.classList.add("warn");
  } else {
    hint.textContent = `Datei erkannt: ${info.name} (${formatBytes(info.size)}). Das Format passt zu keiner der angebotenen Aktionen; deshalb sind sie deaktiviert.`;
    hint.classList.add("warn");
  }
}

function scheduleCodeCheck() {
  clearTimeout(state.codeCheckTimer);
  state.codeCheckSeq += 1;
  const sequence = state.codeCheckSeq;
  const value = expandHome($("#codePath").value);
  state.codeInfo = null;
  state.codeChecking = Boolean(value);
  refreshCodeActions();
  if (!value) return;

  state.codeCheckTimer = setTimeout(async () => {
    try {
      const info = await api(
        `/api/path-info?path=${encodeURIComponent(value)}`,
      );
      if (sequence !== state.codeCheckSeq) return;
      state.codeInfo = info;
    } catch (error) {
      if (sequence !== state.codeCheckSeq) return;
      state.codeInfo = {
        path: value,
        exists: false,
        error: friendlyClientError(error),
      };
    } finally {
      if (sequence === state.codeCheckSeq) {
        state.codeChecking = false;
        refreshCodeActions();
        refreshBlueprintPanel();
      }
    }
  }, 300);
}

function requireCodePath() {
  const path = expandHome($("#codePath").value);
  if (!path) {
    toast("Bitte einen Pfad eingeben.", true);
    $("#codePath").focus();
    return null;
  }
  if (state.codeChecking) {
    toast("Der Pfad wird noch geprüft. Bitte einen Moment warten.");
    return null;
  }
  if (!state.codeInfo?.exists) {
    toast(
      "Dieser Pfad wurde nicht gefunden. Prüfe die Schreibweise oder wähle eine vorhandene Datei bzw. einen Ordner.",
      true,
    );
    $("#codePath").focus();
    return null;
  }
  return path;
}

async function codeAction(action) {
  const path = requireCodePath();
  if (!path) return;
  const blockReason = codeActionBlockReason(action, state.codeInfo);
  if (blockReason) {
    toast(blockReason, true);
    return;
  }

  switch (action) {
    case "analyze":
      if (state.codeInfo?.kind === "native" || state.codeInfo?.isNativeBinary) {
        await run(
          ["analyze", path, "--format", "md", "--token-limit", "6000"],
          "Anwendung analysieren",
        );
        return;
      }
      await withEvidence(
        ["analyze", path, "--format", "md"],
        "Anwendung analysieren",
      );
      return;
    case "javascript":
      await withEvidence(
        ["analyze-javascript-application", path, "--format", "md"],
        "JavaScript/Electron analysieren",
      );
      return;
    case "inspect":
      await run(
        ["inspect", path, "--format", "md", "--token-limit", "6000"],
        "Technische Übersicht",
      );
      return;
    case "hardening":
      await run(
        [
          "inspect-binary-hardening",
          path,
          "--format",
          "md",
          "--token-limit",
          "6000",
        ],
        "Härtung prüfen",
      );
      return;
    case "extract": {
      const args = ["extract-artifact", path, "--format", "md"];
      const output = expandHome($("#extractOut").value);
      if (output) args.push("--output-root", output);
      await run(args, "Archiv entpacken");
      return;
    }
    default:
      toast("Unbekannte Aktion.", true);
  }
}

function refreshMcpButtons() {
  const checking = state.mcpChecking;
  const available = state.mcpAvailable;
  const running = state.mcpRunning;
  const busy = state.mcpBusy;
  const up = $("[data-mcp-action='up']");
  const restart = $("[data-mcp-action='restart']");
  const down = $("[data-mcp-action='down']");

  setActionState(
    up,
    checking || busy || available !== true || running,
    checking
      ? "Der Dienststatus wird geprüft …"
      : available !== true
        ? "termux-services (sv) fehlt. Starten ist deshalb nicht möglich."
        : running
          ? "Der Dienst läuft bereits. Nutze bei Bedarf „Neu starten“."
          : "",
  );
  setActionState(
    restart,
    checking || busy || available !== true || !running,
    checking
      ? "Der Dienststatus wird geprüft …"
      : available !== true
        ? "termux-services (sv) fehlt. Neu starten ist deshalb nicht möglich."
        : !running
          ? "Der Dienst ist gestoppt. Starte ihn zuerst."
          : "",
  );
  setActionState(
    down,
    checking || busy || available !== true || !running,
    checking
      ? "Der Dienststatus wird geprüft …"
      : available !== true
        ? "termux-services (sv) fehlt. Stoppen ist deshalb nicht möglich."
        : !running
          ? "Der Dienst ist bereits gestoppt."
          : "",
  );

  const hint = $("#mcpActionHint");
  if (!hint) return;
  if (checking) {
    hint.textContent = "Der Dienststatus wird geprüft …";
    hint.classList.add("warn");
  } else if (busy) {
    hint.textContent =
      "Die MCP-Aktion läuft. Die Schaltflächen sind bis zum Ende gesperrt.";
    hint.classList.add("warn");
  } else if (available !== true) {
    hint.textContent =
      "Start, Neustart und Stopp sind deaktiviert, weil termux-services (sv) auf diesem System fehlt. Installation und Einrichtung stehen in der Hilfe; „Log anzeigen“ bleibt verfügbar.";
    hint.classList.add("warn");
  } else if (running) {
    hint.textContent =
      "Der Dienst läuft. „Stoppen“ beendet ihn, „Neu starten“ lädt die aktuelle Konfiguration.";
    hint.classList.remove("warn");
  } else {
    hint.textContent =
      "Der Dienst ist gestoppt. „Starten“ ist jetzt möglich; „Neu starten“ und „Stoppen“ sind deaktiviert.";
    hint.classList.remove("warn");
  }
}

function renderMcp(data) {
  const box = $("#mcpStatus");
  const available = data.available !== false;
  const running = Boolean(data.running);
  state.mcpAvailable = available;
  state.mcpRunning = running;
  box.innerHTML = `
    <div class="status-summary">
      <span class="pill ${available ? (running ? "good" : "warn") : "warn"}">${available ? (running ? "läuft" : "gestoppt") : "nicht verfügbar"}</span>
      <span class="pill">Port 8765</span>
    </div>
    <div class="status-line ${running ? "ok" : "bad"}">
      <span class="mark">${running ? "✓" : "!"}</span>
      <div><strong>rea-mcp</strong><span> ${escapeHtml(data.raw || "")}</span></div>
    </div>
    ${
      !available
        ? `<small>Nächster Schritt: termux-services im Termux installieren und den Dienst einmal starten. Danach hier „Aktualisieren“ drücken. Auf einem reinen Desktop-System bleibt diese Steuerung deaktiviert.</small>`
        : !running
          ? `<small>Nächster Schritt: „Starten“ drücken und danach den Status erneut prüfen.</small>`
          : ""
    }
  `;
  refreshMcpButtons();
}

async function refreshMcp() {
  state.mcpChecking = true;
  refreshMcpButtons();
  $("#mcpStatus").innerHTML = `<p class="muted">Prüfe …</p>`;
  try {
    renderMcp(await api("/api/mcp/status"));
  } catch (error) {
    state.mcpAvailable = false;
    state.mcpRunning = false;
    $("#mcpStatus").innerHTML =
      `<div class="status-line bad"><span class="mark">!</span><div><strong>MCP</strong><span> ${escapeHtml(
        friendlyClientError(error),
      )}</span></div></div>`;
  } finally {
    state.mcpChecking = false;
    refreshMcpButtons();
  }
}

async function mcpAction(action) {
  if (state.mcpBusy) {
    toast("Eine MCP-Aktion läuft bereits. Bitte warten.");
    return;
  }
  if (state.mcpAvailable !== true) {
    toast(
      "Der MCP-Dienst ist auf diesem System nicht verfügbar. Installiere termux-services; die Hilfe nennt die Schritte.",
      true,
    );
    return;
  }
  state.mcpBusy = true;
  refreshMcpButtons();
  const labels = { up: "starten", restart: "neu starten", down: "stoppen" };
  $("#mcpStatus").innerHTML =
    `<p class="muted">MCP-Dienst ${labels[action] || action} …</p>`;
  try {
    const result = await api("/api/mcp/action", {
      method: "POST",
      body: JSON.stringify({ action }),
    });
    toast(result.output || `MCP: ${labels[action] || action}`);
  } catch (error) {
    toast(friendlyClientError(error), true);
  } finally {
    state.mcpBusy = false;
    await refreshMcp();
  }
}

function renderWebPreflight(data) {
  state.webPreflight = data;
  const box = $("#webStatus");
  const browser = data?.browser || data || {};
  const ok = Boolean(browser.ok);
  box.innerHTML = `
    <div class="status-summary">
      <span class="pill ${ok ? "good" : "warn"}">${ok ? "Browser bereit" : "Browser fehlt"}</span>
      ${browser.source ? `<span class="pill">${escapeHtml(browser.source)}</span>` : ""}
      ${browser.version ? `<span class="pill">${escapeHtml(browser.version)}</span>` : ""}
    </div>
    <div class="status-line ${ok ? "ok" : "bad"}">
      <span class="mark">${ok ? "✓" : "!"}</span>
      <div><strong>Chromium/Chrome</strong><span> ${escapeHtml(browser.path || browser.detail || "Nicht gefunden.")}</span>
        ${!ok && browser.remediation ? `<small>${escapeHtml(browser.remediation)}</small>` : ""}
      </div>
    </div>
  `;
  if (state.status) renderStatus(state.status);
}

function friendlyClientError(error) {
  const raw = String(error?.message || "").trim();
  if (/Failed to fetch|NetworkError|Load failed|fetch failed/i.test(raw)) {
    return "Der lokale REA-Server ist nicht erreichbar. Läuft die Oberfläche noch?";
  }
  return raw || "Die Anfrage ist fehlgeschlagen.";
}

function showWebInputError(title, message) {
  showBlocked("Web-App analysieren", title, message, {
    remediation: "Beispiel: https://example.com",
  });
  toast(message, true);
}

const WEB_PRESETS = {
  quick: {
    waitMs: 3000,
    help: "REA lädt die Seite, wartet kurz und sammelt Requests, Events, DOM und Skripte. Für die meisten Seiten ist das richtig.",
  },
  slow: {
    waitMs: 8000,
    help: "REA wartet länger, damit nachgeladene Inhalte und Hintergrundanfragen erfasst werden. Gut für schwere oder langsame Seiten.",
  },
  clicks: {
    waitMs: 3000,
    help: "REA wartet kurz und tippt danach die Klick-Schritte aus den „Mehr Optionen“ der Reihe nach an. Gut für Menüs, Dialoge und einfache Abläufe.",
  },
};

function applyWebPreset(value) {
  const preset = WEB_PRESETS[value] || WEB_PRESETS.quick;
  $("#webWait").value = String(preset.waitMs);
  $("#webPresetHelp").textContent = preset.help;
  if (value === "clicks") {
    $("#webAdvanced").open = true;
    $("#webClicks").focus();
  }
}

async function refreshWebPreflight(showToast = false) {
  const path = expandHome($("#webBrowser").value);
  $("#webStatus").innerHTML = `<p class="muted">Prüfe Browser …</p>`;
  try {
    const data = await api(
      `/api/web/preflight${path ? `?path=${encodeURIComponent(path)}` : ""}`,
    );
    renderWebPreflight(data);
    if (showToast) {
      const browser = data.browser || {};
      toast(
        browser.ok
          ? `Browser bereit: ${browser.path}`
          : browser.detail || "Kein Browser gefunden.",
        !browser.ok,
      );
    }
    return data;
  } catch (error) {
    const message = friendlyClientError(error);
    renderWebPreflight({
      browser: { ok: false, detail: message, remediation: "" },
    });
    if (showToast) toast(message, true);
    return { browser: { ok: false, detail: message } };
  }
}

async function runWebAnalysis() {
  if (state.busy) {
    toast("Es läuft bereits ein Befehl. Bitte warte, bis er fertig ist.");
    return;
  }

  const url = $("#webUrl").value.trim();
  if (!url) {
    showWebInputError(
      "URL fehlt",
      "Bitte eine vollständige Internetadresse eingeben, zum Beispiel https://example.com.",
    );
    $("#webUrl").focus();
    return;
  }
  if (url.length > 8192) {
    showWebInputError(
      "URL zu lang",
      "Die URL ist länger als 8192 Zeichen und wird deshalb nicht verarbeitet.",
    );
    $("#webUrl").focus();
    return;
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    showWebInputError(
      "URL ungültig",
      "Die URL ist ungültig. Gib eine vollständige Adresse mit http:// oder https:// ein.",
    );
    $("#webUrl").focus();
    return;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    showWebInputError(
      "URL ungültig",
      "Nur http:// und https:// werden unterstützt.",
    );
    $("#webUrl").focus();
    return;
  }
  if (parsed.username || parsed.password) {
    showWebInputError(
      "URL ungültig",
      "URLs mit Benutzername oder Passwort werden nicht unterstützt.",
    );
    $("#webUrl").focus();
    return;
  }

  const preflight = await refreshWebPreflight(false);
  if (!preflight.browser?.ok) {
    showBlocked(
      "Web-App analysieren",
      "Browser fehlt",
      "Für die Aufnahme einer URL braucht REA Chromium oder Chrome. Die Aktion wurde nicht gestartet, damit du keine rohe Fehlermeldung bekommst.",
      { ...preflight.browser, technical: "" },
    );
    toast("Browser fehlt – die Analyse wurde nicht gestartet.", true);
    return;
  }

  const button = $("#runWeb");
  const browserPath = expandHome($("#webBrowser").value);
  const waitMs = Number($("#webWait").value) || 3000;
  const clickSelectors = $("#webClicks")
    .value.split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);

  state.busy = true;
  button.disabled = true;
  showResult("Web-App analysieren", ["web-app", url]);
  startWebProgress();
  try {
    const result = await api("/api/web/analyze", {
      method: "POST",
      body: JSON.stringify({
        url,
        browserPath,
        waitMs,
        clickSelectors,
        captureBodies: $("#webBodies").checked,
        captureHeaders: $("#webHeaders").checked,
        allowServiceWorkers: $("#webServiceWorkers").checked,
      }),
    });
    renderResult(result, "Web-App analysieren", ["web-app", url]);
    if (result.ok) {
      toast("Aufnahme und Analyse sind fertig.");
      refreshWebPreflight(false);
    } else {
      toast("Die Aufnahme wurde mit Hinweisen beendet.", true);
    }
  } catch (error) {
    const message = friendlyClientError(error);
    failWebProgress(message);
    renderResult(
      {
        ok: false,
        exitCode: null,
        stdout: "",
        stderr: message,
        durationMs: 0,
        timedOut: false,
        truncated: false,
      },
      "Web-App analysieren",
      ["web-app", url],
    );
    toast(message, true);
  } finally {
    stopWebProgress();
    state.busy = false;
    button.disabled = false;
    refreshBlueprintPanel();
  }
}

async function loadMcpLog() {
  const output = $("#mcpLog");
  output.classList.remove("hidden");
  output.textContent = "Lade …";
  try {
    const data = await api("/api/mcp/log");
    output.textContent = data.text || "Kein Log vorhanden.";
  } catch (error) {
    output.textContent = error.message;
  }
}

function currentResultText() {
  if (!state.lastResult) return "";
  const { stdout } = state.lastResult;
  const stderr = stripLimitationText(visibleStderr(state.lastResult.stderr));
  return [stdout, stderr].filter(Boolean).join("\n\n--- Hinweise ---\n\n");
}

function currentWebEventRows() {
  const events = state.lastResult?.web?.events;
  if (!events) return [];
  const kinds = Array.isArray(events.by_kind) ? events.by_kind : [];
  return [
    ["Ereignisse behalten", events.retained ?? 0],
    ["Ereignisse verworfen", events.dropped ?? 0],
    ...kinds.map((item) => [String(item.kind ?? "unbekannt"), item.count ?? 0]),
  ];
}

function currentWebEventsText() {
  if (!state.lastResult?.web?.events) return "";
  return currentWebEventRows()
    .map(([label, count]) => `${label}: ${count}`)
    .join("\n");
}

function currentWebEventsCsv() {
  if (!state.lastResult?.web?.events) return "";
  const lines = [
    "Kategorie;Anzahl",
    ...currentWebEventRows().map((row) => row.map(csvCell).join(";")),
  ];
  return `${lines.join("\r\n")}\r\n`;
}

function currentWebPaths() {
  const web = state.lastResult?.web;
  if (!web) return [];
  const evidence = web.evidence || {};
  return [
    ["Aufnahme", evidence.capture],
    ["Szenario", evidence.scenario],
    ["Skripte", evidence.scripts],
    ["Analyse-Evidenz", evidence.analysis],
    ["Analyse-Eingabe", web.scripts?.analysisInput],
  ].filter(([, path]) => Boolean(path));
}

function currentWebPathsText() {
  return currentWebPaths()
    .map(([label, path]) => `${label}: ${path}`)
    .join("\n");
}

function currentWebPathsCsv() {
  const paths = currentWebPaths();
  if (paths.length === 0) return "";
  const lines = [
    "Zweck;Pfad",
    ...paths.map((row) => row.map(csvCell).join(";")),
  ];
  return `${lines.join("\r\n")}\r\n`;
}

function currentWebJsonObject() {
  const result = state.lastResult;
  if (!result?.web) return null;
  return {
    generator: "REA Studio",
    generatedAt: new Date().toISOString(),
    label: result.label,
    ok: Boolean(result.ok),
    url: result.web.url,
    finalUrl: result.web.finalUrl,
    durationMs: result.durationMs,
    exitCode: result.exitCode ?? null,
    timedOut: Boolean(result.timedOut),
    truncated: Boolean(result.truncated),
    completeness: result.web.completeness,
    network: result.web.network,
    events: result.web.events,
    steps: result.web.steps,
    scripts: result.web.scripts,
    analysis: result.web.analysis,
    evidence: result.web.evidence,
    errors: result.web.errors ?? [],
    report: result.stdout || "",
  };
}

async function copyText(text, successMessage) {
  if (!text) {
    toast("Es gibt noch keine Ausgabe.", true);
    return;
  }
  try {
    let copied = false;
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        copied = true;
      } catch {
        copied = false;
      }
    }
    if (!copied) {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.append(area);
      area.select();
      copied = document.execCommand("copy");
      area.remove();
    }
    if (!copied) throw new Error("copy failed");
    toast(successMessage);
  } catch {
    showCopyFallback(text);
    toast("Kopieren nicht möglich – der Text ist unten markiert.", true);
  }
}

function showCopyFallback(text) {
  const area = $("#copyFallbackText");
  area.value = text;
  $("#copyFallback").classList.remove("hidden");
  area.focus();
  area.select();
}

function selectCopyFallbackText() {
  const area = $("#copyFallbackText");
  area.focus();
  area.select();
}

function hideCopyFallback() {
  $("#copyFallback").classList.add("hidden");
  $("#copyFallbackText").value = "";
}

function downloadText(
  text,
  filename,
  mime = "text/plain;charset=utf-8",
  successMessage = "Datei gespeichert.",
) {
  if (!text) {
    toast("Es gibt noch keine Ausgabe.", true);
    return;
  }
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(successMessage);
}

async function copyResult() {
  await copyText(currentResultText(), "Bericht kopiert.");
}

function downloadResult() {
  const text = currentResultText();
  const label = (state.lastResult?.label || "rea-ergebnis")
    .replace(/[^\w\-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  downloadText(
    text,
    `${label || "rea-ergebnis"}-${new Date().toISOString().slice(0, 10)}.txt`,
  );
}

async function copyWebEvents() {
  const text = currentWebEventsText();
  if (!text) {
    toast("Es wurden keine Ereignisse erfasst.", true);
    return;
  }
  await copyText(text, "Event-Arten kopiert.");
}

async function copyWebPaths() {
  const text = currentWebPathsText();
  if (!text) {
    toast("Es sind keine Evidenzpfade vorhanden.", true);
    return;
  }
  await copyText(text, "Evidenzpfade kopiert.");
}

function downloadWebEventsCsv() {
  const text = currentWebEventsCsv();
  if (!text) {
    toast("Es wurden keine Ereignisse erfasst.", true);
    return;
  }
  downloadText(
    `\uFEFF${text}`,
    webExportFilename("events", "csv"),
    "text/csv;charset=utf-8",
    "Event-Übersicht als CSV gespeichert.",
  );
}

function downloadWebPathsCsv() {
  const text = currentWebPathsCsv();
  if (!text) {
    toast("Es sind keine Evidenzpfade vorhanden.", true);
    return;
  }
  const count = currentWebPaths().length;
  downloadText(
    `\uFEFF${text}`,
    webExportFilename("pfade", "csv"),
    "text/csv;charset=utf-8",
    `${count} Evidenzpfade als CSV gespeichert.`,
  );
}

async function copyWebJson() {
  const data = currentWebJsonObject();
  if (!data) {
    toast("Es gibt noch keine Web-App-Analyse.", true);
    return;
  }
  await copyText(JSON.stringify(data, null, 2), "JSON kopiert.");
}

function downloadWebJson() {
  const data = currentWebJsonObject();
  if (!data) {
    toast("Es gibt noch keine Web-App-Analyse.", true);
    return;
  }
  let host = "web-analyse";
  try {
    host =
      new URL(data.url).hostname.replace(/[^\w.-]+/g, "-") || "web-analyse";
  } catch {
    // Keep the neutral filename.
  }
  downloadText(
    JSON.stringify(data, null, 2),
    `${host}-${new Date().toISOString().slice(0, 10)}.json`,
    "application/json;charset=utf-8",
  );
}

function sourceFileName(path) {
  const parts = String(path || "")
    .split(/[\\/]/)
    .filter(Boolean);
  return parts.at(-1) || path || "";
}

function blueprintWebInfo() {
  const web = state.lastWeb || state.lastResult?.web;
  if (!web?.evidence?.capture) return null;
  const localSource = expandHome($("#blueprintLocalSource")?.value || "");
  return {
    kind: "web",
    available: true,
    target: web.url || "",
    tab: "web",
    label: `Web-Analyse: ${web.url || "ohne URL"}`,
    help: `${web.network?.transactions ?? 0} Requests, ${web.scripts?.fileCount ?? 0} Skripte und die Aufnahme werden übernommen.${localSource ? " Der lokale Quellordner wird zusätzlich statisch ausgewertet." : ""}`,
    input: {
      url: web.url || "",
      web: {
        capture: web.evidence.capture,
        analysis: web.evidence.analysis || null,
        scripts: web.evidence.scripts || null,
        analysisInput: web.scripts?.analysisInput || null,
        source: localSource || null,
      },
    },
  };
}

function blueprintApkInfo() {
  if (!state.apkPath) return null;
  return {
    kind: "apk",
    available: true,
    target: state.apkPath,
    tab: "apk",
    label: `APK: ${sourceFileName(state.apkPath)}`,
    help: "Manifest, Signatur, Klassen, Ressourcen und dekompilierter Java-Code werden gebündelt.",
    input: {},
  };
}

function blueprintCodeInfo() {
  const info = state.codeInfo;
  if (!info?.exists) return null;
  const codeKind =
    info.kind ||
    (info.isDirectory ? "directory" : info.isNativeBinary ? "native" : "other");
  return {
    kind: "code",
    available: true,
    target: info.path || expandHome($("#codePath").value),
    tab: "code",
    codeKind,
    label: `${codeKind === "native" ? "Programm" : codeKind === "javascript" ? "JavaScript" : "Datei"}: ${info.name || sourceFileName(info.path)}`,
    help:
      codeKind === "native"
        ? "Ghidra liefert Segmente, Exporte und Pseudocode für den Nachbau."
        : "Module, Funktionen, Routen und IPC werden aus der JavaScript-Analyse übernommen.",
    input: { codeKind },
  };
}

function blueprintCandidate(kind) {
  if (kind === "web") return blueprintWebInfo();
  if (kind === "apk") return blueprintApkInfo();
  if (kind === "code") return blueprintCodeInfo();
  return null;
}

function currentBlueprintInfo() {
  return blueprintCandidate(state.blueprintSource);
}

function refreshBlueprintPanel() {
  if (!$("#blueprintTarget")) return;
  const web = blueprintWebInfo();
  const apk = blueprintApkInfo();
  const code = blueprintCodeInfo();

  const setStatus = (id, info, empty) => {
    const element = $(id);
    if (!element) return;
    element.textContent = info ? info.label : empty;
  };
  setStatus(
    "#blueprintWebStatus",
    web,
    "Noch keine Web-Analyse. Öffne „Web-App“.",
  );
  setStatus(
    "#blueprintApkStatus",
    apk,
    "Noch keine APK ausgewählt. Öffne „APK prüfen“.",
  );
  setStatus(
    "#blueprintCodeStatus",
    code,
    "Noch kein Programm ausgewählt. Öffne „Apps & Dateien“.",
  );

  if (!state.blueprintSource) {
    state.blueprintSource = web ? "web" : apk ? "apk" : code ? "code" : "";
  }
  $$("[data-blueprint-source]").forEach((button) => {
    button.classList.toggle(
      "active",
      button.dataset.blueprintSource === state.blueprintSource,
    );
  });

  const info = currentBlueprintInfo();
  const sourceField = $("#blueprintSourceField");
  if (sourceField) {
    sourceField.classList.toggle("hidden", state.blueprintSource !== "web");
  }
  const target = $("#blueprintTarget");
  const help = $("#blueprintTargetHelp");
  const hint = $("#blueprintHint");
  const button = $("#buildBlueprint");
  const available = Boolean(
    info?.available && info.target && !state.blueprintBusy,
  );

  target.value = info?.target || "";
  if (info) {
    target.title = info.target;
    help.textContent = info.help;
    hint.textContent = state.blueprintBusy
      ? "Die Blaupause wird erstellt. Der Fortschritt steht direkt darunter."
      : "Alles bereit. REA bündelt jetzt Oberfläche, Verhalten, Innenleben und Beweise in einer ZIP-Datei.";
    hint.classList.remove("warn");
  } else {
    target.title = "";
    help.textContent =
      "Wähle oben eine Quelle. Danach zeigt REA hier das Ziel und schaltet die Erstellung frei.";
    hint.textContent =
      "Für eine Blaupause brauchst du zuerst eine Analyse: Web-App aufnehmen, APK auswählen oder ein Programm prüfen.";
    hint.classList.add("warn");
  }
  if (button) {
    button.disabled = !available;
    button.setAttribute("aria-disabled", String(!available));
    button.title = available
      ? "Erstellt die herunterladbare Blaupause aus der aktuellen Analyse."
      : info
        ? "Bitte warte, bis die laufende Erstellung fertig ist."
        : "Zuerst eine Quelle analysieren oder auswählen.";
  }
}

function selectBlueprintSource(kind) {
  state.blueprintSource = kind;
  refreshBlueprintPanel();
}

function startBlueprintProgress() {
  const progress = $("#blueprintProgress");
  progress.classList.remove("hidden", "is-done", "is-error");
  $("#blueprintProgressBar").style.width = "2%";
  $("#blueprintProgressPercent").textContent = "0 %";
  $("#blueprintProgressLabel").textContent = "Wird vorbereitet";
  $("#blueprintProgressDetail").textContent = "";
  clearInterval(state.blueprintTimer);
  state.blueprintTimer = setInterval(pollBlueprintProgress, 800);
  void pollBlueprintProgress();
}

function renderBlueprintProgress(progress) {
  const panel = $("#blueprintProgress");
  if (!panel) return;
  panel.classList.remove("hidden");
  panel.classList.toggle(
    "is-done",
    !progress.active && progress.stage === "done",
  );
  panel.classList.toggle("is-error", progress.stage === "error");
  $("#blueprintProgressBar").style.width =
    `${Math.max(2, Math.min(100, Number(progress.percent) || 0))}%`;
  $("#blueprintProgressPercent").textContent =
    `${Math.max(0, Math.min(100, Number(progress.percent) || 0))} %`;
  $("#blueprintProgressLabel").textContent = progress.label || "Blaupause";
  $("#blueprintProgressDetail").textContent = progress.detail || "";
}

async function pollBlueprintProgress() {
  try {
    const progress = await api("/api/blueprint/progress");
    renderBlueprintProgress(progress);
  } catch {
    // The final build response is authoritative.
  }
}

function stopBlueprintProgress() {
  clearInterval(state.blueprintTimer);
  state.blueprintTimer = null;
}

function failBlueprintProgress(message) {
  const panel = $("#blueprintProgress");
  panel.classList.remove("hidden", "is-done");
  panel.classList.add("is-error");
  $("#blueprintProgressBar").style.width = "100%";
  $("#blueprintProgressPercent").textContent = "–";
  $("#blueprintProgressLabel").textContent = "Blaupause nicht erstellt";
  $("#blueprintProgressDetail").textContent = message;
}

async function buildBlueprintNow() {
  if (state.blueprintBusy) {
    toast("Es wird bereits eine Blaupause erstellt.");
    return;
  }
  const info = currentBlueprintInfo();
  if (!info?.available || !info.target) {
    toast("Bitte zuerst eine Quelle analysieren oder auswählen.", true);
    refreshBlueprintPanel();
    return;
  }
  state.blueprintBusy = true;
  refreshBlueprintPanel();
  startBlueprintProgress();
  try {
    const result = await api("/api/blueprint/build", {
      method: "POST",
      body: JSON.stringify({
        kind: info.kind,
        target: info.target,
        input: info.input,
        includeSources: $("#blueprintSources").checked,
        fullSources: $("#blueprintFull").checked,
      }),
    });
    renderBlueprintResult(result);
    renderBlueprintProgress({
      active: false,
      stage: "done",
      label: "Blaupause ist fertig",
      detail: "Download und Agentenauftrag stehen bereit.",
      percent: 100,
    });
    toast("Blaupause ist fertig.");
  } catch (error) {
    const message = friendlyClientError(error);
    failBlueprintProgress(message);
    toast(message, true);
  } finally {
    stopBlueprintProgress();
    state.blueprintBusy = false;
    refreshBlueprintPanel();
  }
}

function renderBlueprintCompleteness(completeness) {
  const root = $("#blueprintCompleteness");
  if (!completeness?.checks) {
    root.classList.add("hidden");
    return;
  }
  root.classList.remove(
    "hidden",
    "status-complete",
    "status-partial",
    "status-insufficient",
  );
  root.classList.add(`status-${completeness.status || "insufficient"}`);
  $("#blueprintCompletenessLabel").textContent =
    {
      complete: "Vollständig belegt",
      partial: "Teilweise belegt",
      insufficient: "Unvollständig",
    }[completeness.status] || "Nicht geprüft";
  $("#blueprintCompletenessScore").textContent =
    `${completeness.score ?? 0} % · ${completeness.passed ?? 0}/${completeness.checks.length}`;

  const checks = $("#blueprintCompletenessChecks");
  checks.replaceChildren();
  for (const check of completeness.checks) {
    const item = document.createElement("li");
    item.classList.add(check.ok ? "is-ok" : "is-missing");
    const mark = document.createElement("span");
    mark.className = "completeness-mark";
    mark.textContent = check.ok ? "✓" : "✗";
    const text = document.createElement("span");
    const label = document.createElement("strong");
    label.textContent = `${check.label}: `;
    text.append(label, document.createTextNode(check.detail || ""));
    item.append(mark, text);
    checks.append(item);
  }

  const gaps = $("#blueprintCompletenessGaps");
  gaps.replaceChildren();
  if (completeness.gaps?.length) {
    for (const gap of completeness.gaps) {
      const item = document.createElement("div");
      item.className = "completeness-gap";
      const title = document.createElement("strong");
      title.textContent = `${gap.id} · ${gap.label}`;
      const why = document.createElement("p");
      why.textContent = gap.why || "";
      const action = document.createElement("p");
      action.className = "gap-action";
      action.textContent = `Aufgabe: ${gap.action || "Beleg ergänzen."}`;
      item.append(title, why, action);
      gaps.append(item);
    }
  } else {
    const done = document.createElement("p");
    done.className = "hint";
    done.textContent = "Keine Lücken im Rahmen dieser Prüfung.";
    gaps.append(done);
  }
}

function renderBlueprintResult(data) {
  state.blueprintResult = data;
  $("#blueprintResult").classList.remove("hidden");
  $("#blueprintTitle").textContent = `Blaupause: ${data.target || data.kind}`;
  $("#blueprintSize").textContent = formatBytes(data.zipBytes);
  $("#blueprintSurfaceCount").textContent = String(data.counts?.surface ?? 0);
  $("#blueprintBehaviorCount").textContent = String(data.counts?.behavior ?? 0);
  $("#blueprintInternalsCount").textContent = String(
    data.counts?.internals ?? 0,
  );
  const gaps = data.completeness?.gaps || [];
  const open = gaps.length || data.openQuestions?.length || 0;
  $("#blueprintOpenCount").textContent = String(open);
  $("#blueprintOpenCount").parentElement?.classList.toggle("warn", open > 0);
  const coverage = Array.isArray(data.coverage?.available)
    ? data.coverage.available.join(", ")
    : "";
  const gapText = gaps.length
    ? `${gaps.length} Lücken für den Coding-Agenten benannt.`
    : "Keine Lücken im Rahmen der automatischen Prüfung.";
  $("#blueprintSummary").textContent = coverage
    ? `Belegt: ${coverage}. ${gapText}`
    : gapText;
  renderBlueprintCompleteness(data.completeness);
  $("#blueprintDownload").href = data.downloadUrl || "#";
  $("#blueprintPreview").classList.add("hidden");
  $("#blueprintPreview").textContent = "";
  $("#blueprintResult").scrollIntoView({ behavior: "smooth", block: "start" });
}

function gotoBlueprintSource() {
  const info = currentBlueprintInfo();
  const selectedTab = { web: "web", apk: "apk", code: "code" }[
    state.blueprintSource
  ];
  showTab(
    info?.tab ||
      selectedTab ||
      (blueprintWebInfo() ? "web" : blueprintApkInfo() ? "apk" : "code"),
  );
}

async function copyBlueprintPrompt() {
  await copyText(
    state.blueprintResult?.prompt || "",
    "Agentenauftrag kopiert. Füge ihn in deinen Coding-Agenten ein.",
  );
}

function toggleBlueprintPreview() {
  const preview = $("#blueprintPreview");
  if (preview.classList.contains("hidden")) {
    preview.textContent =
      state.blueprintResult?.markdown || "Der Bauplan ist noch nicht geladen.";
    preview.classList.remove("hidden");
    preview.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } else {
    preview.classList.add("hidden");
  }
}

function bindEvents() {
  $$(".tab[data-tab]").forEach((button) => {
    button.addEventListener("click", () => showTab(button.dataset.tab));
  });
  $("#navMoreToggle").addEventListener("click", () => {
    setNavMore($("#navMoreMenu").classList.contains("hidden"));
  });

  document.addEventListener("click", (event) => {
    const go = event.target.closest?.("[data-go]");
    if (go) showTab(go.dataset.go);
  });

  $$("[data-blueprint-source]").forEach((button) => {
    button.addEventListener("click", () =>
      selectBlueprintSource(button.dataset.blueprintSource),
    );
  });
  $("#buildBlueprint").addEventListener("click", buildBlueprintNow);
  $("#gotoBlueprintSource").addEventListener("click", gotoBlueprintSource);
  $("#copyBlueprintPrompt").addEventListener("click", copyBlueprintPrompt);
  $("#viewBlueprint").addEventListener("click", toggleBlueprintPreview);

  $("#refreshStatus").addEventListener("click", refreshStatus);
  $("#apkChoose").addEventListener("click", () => {
    const input = $("#apkFile");
    input.value = "";
    input.click();
  });
  $("#apkFile").addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    handleApkFile(file);
  });
  const dropZone = $("#apkDrop");
  for (const type of ["dragenter", "dragover"]) {
    dropZone.addEventListener(type, (event) => {
      event.preventDefault();
      dropZone.classList.add("drop-active");
    });
  }
  for (const type of ["dragleave", "dragend", "drop"]) {
    dropZone.addEventListener(type, (event) => {
      event.preventDefault();
      dropZone.classList.remove("drop-active");
    });
  }
  dropZone.addEventListener("drop", (event) => {
    const file = event.dataTransfer?.files?.[0];
    if (file) {
      handleApkFile(file);
      return;
    }
    toast(
      "Die abgelegte Datei konnte nicht gelesen werden. Nutze „APK auswählen“.",
      true,
    );
  });
  $("#useApkPath").addEventListener("click", useApkPath);
  $("#apkPath").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      useApkPath();
    }
  });
  $$("[data-apk-action]").forEach((button) => {
    button.addEventListener("click", () => apkAction(button.dataset.apkAction));
  });
  $$("[data-code-action]").forEach((button) => {
    button.addEventListener("click", () =>
      codeAction(button.dataset.codeAction),
    );
  });
  $("#codePath").addEventListener("input", scheduleCodeCheck);

  $("#commandSearch").addEventListener("input", (event) =>
    renderCommandList(event.target.value),
  );
  $("#commandSelect").addEventListener("change", refreshCommandActions);
  $("#runCommand").addEventListener("click", async () => {
    const command = $("#commandSelect").value;
    if (!command) {
      toast("Bitte einen Befehl auswählen.", true);
      return;
    }
    let args = [];
    try {
      args = parseArguments($("#commandArgs").value);
    } catch (error) {
      toast(error.message, true);
      return;
    }
    await run([command, ...args], command);
  });
  $("#commandHelp").addEventListener("click", async () => {
    const command = $("#commandSelect").value;
    if (!command) {
      toast("Bitte zuerst einen Befehl auswählen.", true);
      $("#commandSelect").focus();
      return;
    }
    await run([command, "--help"], `${command} --help`);
  });

  $("#runWeb").addEventListener("click", runWebAnalysis);
  $("#checkWeb").addEventListener("click", () => refreshWebPreflight(true));
  $("#webPreset").addEventListener("change", (event) =>
    applyWebPreset(event.target.value),
  );
  $("#webUrl").addEventListener("keydown", (event) => {
    if (event.key === "Enter") runWebAnalysis();
  });

  $("#refreshMcp").addEventListener("click", refreshMcp);
  $("#loadMcpLog").addEventListener("click", loadMcpLog);
  $$("[data-mcp-action]").forEach((button) => {
    button.addEventListener("click", () => mcpAction(button.dataset.mcpAction));
  });

  $("#requestFilter").addEventListener("input", (event) => {
    state.requestTable.filter = event.target.value;
    drawRequestTable();
  });
  $("#requestReset").addEventListener("click", () => {
    state.requestTable.filter = "";
    state.requestTable.sortKey = null;
    state.requestTable.sortDirection = 1;
    $("#requestFilter").value = "";
    drawRequestTable();
    $("#requestFilter").focus();
  });
  $("#requestCopyText").addEventListener("click", copyRequestTable);
  $("#requestCsv").addEventListener("click", downloadRequestCsv);

  $("#copyResult").addEventListener("click", copyResult);
  $("#downloadResult").addEventListener("click", downloadResult);
  $("#copyWebEvents").addEventListener("click", copyWebEvents);
  $("#downloadWebEvents").addEventListener("click", downloadWebEventsCsv);
  $("#copyWebPaths").addEventListener("click", copyWebPaths);
  $("#downloadWebPaths").addEventListener("click", downloadWebPathsCsv);
  $("#copyWebJson").addEventListener("click", copyWebJson);
  $("#downloadWebJson").addEventListener("click", downloadWebJson);
  $("#exportMenu").addEventListener("click", (event) => {
    if (event.target.closest("button"))
      $("#exportMenu").removeAttribute("open");
  });
  $("#copyFallbackSelect").addEventListener("click", selectCopyFallbackText);
  $("#copyFallbackClose").addEventListener("click", hideCopyFallback);
  $("#copyFallback").addEventListener("click", (event) => {
    if (event.target === $("#copyFallback")) hideCopyFallback();
  });

  $("#evidenceActions").addEventListener("click", (event) => {
    const view = event.target.closest("[data-artifact-view]");
    if (view) {
      openArtifact(view.dataset.artifactView, view.dataset.artifactLabel);
      return;
    }
    const scripts = event.target.closest("[data-evidence-scripts]");
    if (scripts) loadEvidenceTree(scripts.dataset.evidenceScripts);
  });
  $("#evidenceTreeList").addEventListener("click", (event) => {
    const view = event.target.closest("[data-artifact-view]");
    if (view)
      openArtifact(view.dataset.artifactView, view.dataset.artifactLabel);
  });
  $("#evidenceTreeClose").addEventListener("click", () => {
    $("#evidenceTree").classList.add("hidden");
  });
  $("#artifactClose").addEventListener("click", closeArtifact);
  $("#artifactViewer").addEventListener("click", (event) => {
    if (event.target === $("#artifactViewer")) closeArtifact();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!$("#artifactViewer").classList.contains("hidden")) {
      closeArtifact();
      return;
    }
    if (!$("#copyFallback").classList.contains("hidden")) hideCopyFallback();
  });

  const controlTitles = {
    refreshStatus: "Prüft REA, Browser und die verfügbaren Werkzeuge neu.",
    runWeb: "Startet die echte Aufnahme der eingegebenen URL.",
    checkWeb: "Prüft nur, ob Chromium/Chrome gefunden wird – ohne Aufnahme.",
    webPreset: "Wählt eine sinnvolle Wartezeit für die Aufnahme.",
    webUrl: "Die vollständige Adresse der Seite, die aufgenommen werden soll.",
    webBrowser: "Optional: eigener Pfad zu Chromium oder Chrome.",
    webWait:
      "Wie lange nach dem Laden gewartet wird, bevor die Aufnahme endet.",
    webClicks: "Optional: CSS-Selektoren, die REA nach der Wartezeit anklickt.",
    copyResult: "Kopiert den vollständigen Bericht als Text.",
    downloadResult: "Speichert den vollständigen Bericht als Textdatei.",
    closeResult: "Blendet die Ergebnisanzeige aus; die Daten bleiben erhalten.",
    exportMenu: "Weitere Exporte für Events, Pfade und alle Daten als JSON.",
    copyWebEvents: "Kopiert behaltene und verworfene Events als Text.",
    downloadWebEvents: "Speichert behaltene und verworfene Events als CSV.",
    copyWebPaths: "Kopiert die Pfade aller Beweis- und Skriptdateien.",
    downloadWebPaths:
      "Speichert die Pfade aller Beweis- und Skriptdateien als CSV.",
    copyWebJson: "Kopiert die komplette Web-Auswertung als JSON.",
    downloadWebJson: "Speichert die komplette Web-Auswertung als JSON.",
    requestFilter:
      "Filtert die Request-Tabelle nach Methode, Status, Typ oder URL.",
    requestReset: "Setzt Filter und Sortierung der Request-Tabelle zurück.",
    requestCopyText: "Kopiert die sichtbaren Requests als Text.",
    requestCsv: "Speichert die sichtbaren Requests als CSV.",
    commandSearch: "Durchsucht alle REA-Befehle nach Namen oder Zweck.",
    commandHelp: "Zeigt die Hilfe zum ausgewählten Befehl an.",
    runCommand: "Führt den ausgewählten REA-Befehl mit den Argumenten aus.",
    refreshMcp: "Prüft, ob der MCP-Server läuft.",
    loadMcpLog: "Zeigt das letzte MCP-Log an.",
    apkChoose: "Öffnet die Dateiauswahl für eine APK auf diesem Gerät.",
    apkFile: "Wählt eine APK-Datei vom Gerät zum Hochladen aus.",
    apkPath: "Alternativ: ein bereits vorhandener Pfad zu einer APK.",
    useApkPath: "Übernimmt den eingetragenen APK-Pfad.",
    codePath: "Pfad zu einer App, einem Ordner, Archiv oder einer Binärdatei.",
    artifactClose: "Schließt die Dateiansicht.",
    evidenceTreeClose: "Blendet die Skriptliste aus.",
    artifactDownload: "Speichert die geöffnete Datei unverändert.",
    buildBlueprint:
      "Erstellt aus der gewählten Analyse eine herunterladbare Blaupause mit Bauplan und Agentenauftrag.",
    gotoBlueprintSource:
      "Öffnet den Bereich, in dem die gewählte Quelle analysiert wird.",
    copyBlueprintPrompt:
      "Kopiert den fertigen Auftrag für einen Coding-Agenten.",
    viewBlueprint: "Zeigt den erzeugten Bauplan direkt in der Oberfläche.",
  };
  for (const [id, title] of Object.entries(controlTitles)) {
    const element = document.getElementById(id);
    if (element) element.title = title;
  }
  $$("[data-apk-action], [data-code-action]").forEach((button) => {
    const description = button
      .closest(".action")
      ?.querySelector("p")
      ?.textContent?.replace(/\s+/g, " ")
      .trim();
    if (description) button.title = description;
  });
  $$("[data-mcp-action]").forEach((button) => {
    button.title =
      {
        up: "Startet den MCP-Server auf Port 8765.",
        restart: "Startet den MCP-Server neu.",
        down: "Stoppt den MCP-Server.",
      }[button.dataset.mcpAction] || "MCP-Aktion ausführen.";
  });
  $$(
    "[data-apk-action], [data-code-action], [data-mcp-action], #runCommand, #commandHelp",
  ).forEach((button) => {
    button.dataset.defaultTitle = button.title;
  });
  $$(".tab[data-tab]").forEach((button) => {
    button.title = `Bereich „${button.textContent.trim()}“ öffnen.`;
  });
  $("#closeResult").addEventListener("click", () =>
    $("#resultCard").classList.add("hidden"),
  );
}

async function init() {
  bindEvents();
  $("#commandSelect").innerHTML = `<option value="">Lade Befehle …</option>`;

  try {
    state.config = await api("/api/config");
  } catch {
    state.config = null;
  }

  refreshStatus();
  refreshApkActions();
  refreshBlueprintPanel();
  scheduleCodeCheck();
  void refreshMcp();

  try {
    const data = await api("/api/commands");
    state.commands = data.commands || [];
    populateCommands();
    renderCommandList("");
  } catch (error) {
    $("#commandList").innerHTML =
      `<p class="empty">${escapeHtml(error.message)}</p>`;
    $("#commandSelect").innerHTML = `<option value="">Nicht verfügbar</option>`;
    refreshCommandActions();
  }
}

document.addEventListener("DOMContentLoaded", init);
