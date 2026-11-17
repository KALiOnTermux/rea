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
  toastTimer: null,
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

function showTab(name) {
  $$(".tab").forEach((button) =>
    button.classList.toggle("active", button.dataset.tab === name),
  );
  $$("[data-panel]").forEach((panel) =>
    panel.classList.toggle("active", panel.dataset.panel === name),
  );
  window.scrollTo({ top: 0, behavior: "smooth" });
  if (name === "mcp") refreshMcp();
}

function renderStatus(data) {
  state.status = data;
  const checks = Array.isArray(data.checks) ? data.checks : [];
  const wanted = ["node", "host", "jadx", "apktool", "adb", "java"];
  const important = checks.filter((check) => wanted.includes(check.name));
  const shown = important.length > 0 ? important : checks.slice(0, 6);

  const optionalMissing = checks.filter(
    (check) =>
      !check.ok && ["jadx", "apktool", "adb", "java"].includes(check.name),
  ).length;
  const summary = [
    `<span class="pill ${data.version && data.version !== "unbekannt" ? "good" : "warn"}">REA ${escapeHtml(data.version)}</span>`,
    `<span class="pill good">Basis bereit</span>`,
    data.termux
      ? `<span class="pill good">Termux erkannt</span>`
      : `<span class="pill">Desktop</span>`,
    optionalMissing
      ? `<span class="pill warn">${optionalMissing} optionale Werkzeuge fehlen</span>`
      : `<span class="pill good">Alle Standardwerkzeuge da</span>`,
  ].join("");

  const lines = shown
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

  $("#statusBox").innerHTML = `
    <div class="status-summary">${summary}</div>
    ${lines || `<p class="muted">Keine Detailprüfungen gemeldet.</p>`}
    ${data.doctorError ? `<div class="status-line bad"><span class="mark">!</span><div><strong>Doctor</strong><span> ${escapeHtml(data.doctorError)}</span></div></div>` : ""}
  `;
}

async function refreshStatus() {
  setConnection("checking", "Prüfe …");
  try {
    const data = await api("/api/status?refresh=1");
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

function populateCommands() {
  const select = $("#commandSelect");
  select.innerHTML = "";
  for (const command of state.commands) {
    const option = document.createElement("option");
    option.value = command.name;
    option.textContent = command.name;
    select.append(option);
  }
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
    "Die Ausgabe ist technische Evidenz. „subject“ ist die Datei, „coverage“ sagt, wie vollständig geprüft wurde, „limitations“ nennt Grenzen und „next_probes“ sind Vorschläge für den nächsten Schritt.",
  ],
  [
    /^APK-Signatur/,
    "Achte besonders auf „matches_apk“ und die Zertifikat-Fingerabdrücke. Eine gültige Signatur bedeutet nicht automatisch, dass die App vertrauenswürdig ist.",
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
    "„coverage“ und „limitations“ zeigen, wie weit die Analyse trägt. Die App wurde dabei nicht ausgeführt.",
  ],
  [
    /^Technische Übersicht/,
    "Die Übersicht beschreibt Struktur und Metadaten. Für Code und Verhalten sind weitere, gezielte Schritte nötig.",
  ],
];

function helpForLabel(label) {
  const match = RESULT_HELP.find(([pattern]) => pattern.test(label));
  return (
    match?.[1] ||
    "Die Ausgabe ist technische Evidenz. In der Hilfe stehen die wichtigsten Begriffe; für den Alltag reicht meist der erste Überblick."
  );
}

function showResult(label, args) {
  state.lastResult = null;
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
  $("#resultCard").scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderResult(result, label, args) {
  state.lastResult = { ...result, label, args };
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

  $("#resultOutput").textContent = result.stdout?.trim()
    ? result.stdout
    : result.stderr?.trim()
      ? ""
      : "(keine Ausgabe)";

  const error = $("#resultError");
  if (result.stderr?.trim()) {
    error.textContent = result.stderr;
    error.classList.remove("hidden");
  } else {
    error.textContent = "";
    error.classList.add("hidden");
  }

  $("#resultCard").scrollIntoView({ behavior: "smooth", block: "start" });
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
}

function uploadFile(file) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", `/api/upload?name=${encodeURIComponent(file.name)}`);
    xhr.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable) return;
      const percent = Math.max(
        1,
        Math.min(100, Math.round((event.loaded / event.total) * 100)),
      );
      $("#uploadProgress").classList.remove("hidden");
      $("#uploadBar").style.width = `${percent}%`;
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
  if (!file) return;
  const progress = $("#uploadProgress");
  const bar = $("#uploadBar");
  progress.classList.remove("hidden");
  bar.style.width = "2%";
  try {
    const data = await uploadFile(file);
    setApkPath(data.path, "Hochgeladen");
    toast(`${file.name} wurde lokal übernommen (${formatBytes(data.size)}).`);
    bar.style.width = "100%";
  } catch (error) {
    toast(error.message, true);
  } finally {
    setTimeout(() => progress.classList.add("hidden"), 900);
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

function requireCodePath() {
  const path = expandHome($("#codePath").value);
  if (!path) {
    toast("Bitte einen Pfad eingeben.", true);
    $("#codePath").focus();
    return null;
  }
  return path;
}

async function codeAction(action) {
  const path = requireCodePath();
  if (!path) return;

  switch (action) {
    case "analyze":
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

function renderMcp(data) {
  const box = $("#mcpStatus");
  const running = Boolean(data.running);
  box.innerHTML = `
    <div class="status-summary">
      <span class="pill ${running ? "good" : "warn"}">${running ? "läuft" : "gestoppt"}</span>
      <span class="pill">Port 8765</span>
    </div>
    <div class="status-line ${running ? "ok" : "bad"}">
      <span class="mark">${running ? "✓" : "!"}</span>
      <div><strong>rea-mcp</strong><span> ${escapeHtml(data.raw || "")}</span></div>
    </div>
  `;
}

async function refreshMcp() {
  $("#mcpStatus").innerHTML = `<p class="muted">Prüfe …</p>`;
  try {
    renderMcp(await api("/api/mcp/status"));
  } catch (error) {
    $("#mcpStatus").innerHTML =
      `<div class="status-line bad"><span class="mark">!</span><div><strong>MCP</strong><span> ${escapeHtml(
        error.message,
      )}</span></div></div>`;
  }
}

async function mcpAction(action) {
  try {
    const result = await api("/api/mcp/action", {
      method: "POST",
      body: JSON.stringify({ action }),
    });
    toast(result.output || `MCP: ${action}`);
    await refreshMcp();
  } catch (error) {
    toast(error.message, true);
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
  const { stdout, stderr } = state.lastResult;
  return [stdout, stderr].filter(Boolean).join("\n\n--- stderr ---\n\n");
}

async function copyResult() {
  const text = currentResultText();
  if (!text) {
    toast("Es gibt noch keine Ausgabe.", true);
    return;
  }
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const area = document.createElement("textarea");
      area.value = text;
      document.body.append(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    toast("Ausgabe kopiert.");
  } catch {
    toast("Kopieren nicht möglich. Markiere den Text manuell.", true);
  }
}

function downloadResult() {
  const text = currentResultText();
  if (!text) {
    toast("Es gibt noch keine Ausgabe.", true);
    return;
  }
  const label = (state.lastResult?.label || "rea-ergebnis")
    .replace(/[^\w\-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${label || "rea-ergebnis"}-${new Date().toISOString().slice(0, 10)}.txt`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast("Ausgabe gespeichert.");
}

function bindEvents() {
  $$(".tab").forEach((button) => {
    button.addEventListener("click", () => showTab(button.dataset.tab));
  });

  $$("[data-go]").forEach((button) => {
    button.addEventListener("click", () => showTab(button.dataset.go));
  });

  $("#refreshStatus").addEventListener("click", refreshStatus);
  $("#apkFile").addEventListener("change", (event) =>
    handleApkFile(event.target.files?.[0]),
  );
  $("#useApkPath").addEventListener("click", () =>
    setApkPath($("#apkPath").value, "Pfad"),
  );
  $$("[data-apk-action]").forEach((button) => {
    button.addEventListener("click", () => apkAction(button.dataset.apkAction));
  });
  $$("[data-code-action]").forEach((button) => {
    button.addEventListener("click", () =>
      codeAction(button.dataset.codeAction),
    );
  });

  $("#commandSearch").addEventListener("input", (event) =>
    renderCommandList(event.target.value),
  );
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
    if (!command) return;
    await run([command, "--help"], `${command} --help`);
  });

  $("#refreshMcp").addEventListener("click", refreshMcp);
  $("#loadMcpLog").addEventListener("click", loadMcpLog);
  $$("[data-mcp-action]").forEach((button) => {
    button.addEventListener("click", () => mcpAction(button.dataset.mcpAction));
  });

  $("#copyResult").addEventListener("click", copyResult);
  $("#downloadResult").addEventListener("click", downloadResult);
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

  try {
    const data = await api("/api/commands");
    state.commands = data.commands || [];
    populateCommands();
    renderCommandList("");
  } catch (error) {
    $("#commandList").innerHTML =
      `<p class="empty">${escapeHtml(error.message)}</p>`;
    $("#commandSelect").innerHTML = `<option value="">Nicht verfügbar</option>`;
  }
}

document.addEventListener("DOMContentLoaded", init);
