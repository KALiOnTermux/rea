#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  resolve,
} from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { fileURLToPath } from "node:url";
import { randomUUID, timingSafeEqual } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const UI_DIR = HERE;
const REA_SCRIPT = join(ROOT, "scripts", "rea.mjs");
const REA_RUNTIME = join(ROOT, "dist", "cli-runtime", "cli.js");
const requestedPort = Number(process.env.REA_UI_PORT || 8787);
const PORT =
  Number.isInteger(requestedPort) && requestedPort > 0 && requestedPort < 65_536
    ? requestedPort
    : 8787;
const HOST = process.env.REA_UI_HOST || "127.0.0.1";
const MAX_UPLOAD = 512 * 1024 * 1024;
const MAX_OUTPUT = 4 * 1024 * 1024;
const UPLOAD_DIR = join(homedir(), "rea-ui", "uploads");
const WEB_DIR = join(homedir(), "rea-ui", "web");
const ARTIFACTS_DIR = join(homedir(), "rea-artifacts");
const TERMUX = Boolean(
  process.env.TERMUX_VERSION || process.env.PREFIX?.includes("com.termux"),
);
const ACCESS_TOKEN = process.env.REA_UI_TOKEN || "";
const LOCAL_MODE = process.env.REA_UI_LOCAL === "1";
const NO_OPEN = process.argv.includes("--no-open");

const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const stripAnsi = (value) => value.replace(ANSI, "");
const BROWSER_COMMANDS = [
  "chromium",
  "chromium-browser",
  "google-chrome",
  "google-chrome-stable",
  "brave-browser",
  "microsoft-edge",
  "msedge",
];

let commandCache = null;
let statusCache = null;
let statusCacheAt = 0;

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function text(res, status, value, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(value);
}

function sameSecret(left, right) {
  if (!left || !right || left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

function cookieValue(req, name) {
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return "";
}

function sanitizeName(value, fallback = "upload.bin") {
  const cleaned = basename(String(value || ""))
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w.\-]+/g, "_")
    .replace(/^\.+/, "")
    .slice(-120);
  return cleaned || fallback;
}

function runProcess(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const timeoutMs = options.timeoutMs ?? 600_000;
    const maxBytes = options.maxBytes ?? MAX_OUTPUT;
    const child = spawn(command, args, {
      cwd: options.cwd ?? ROOT,
      env: {
        ...process.env,
        NO_COLOR: "1",
        FORCE_COLOR: "0",
        TERM: "dumb",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let outBytes = 0;
    let errBytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    let timer = null;
    let killTimer = null;

    const append = (current, chunk, budget, used) => {
      if (used >= budget) {
        truncated = true;
        return { value: current, used };
      }
      const remaining = budget - used;
      const slice =
        chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      if (slice.length < chunk.length) truncated = true;
      return {
        value: current + slice.toString("utf8"),
        used: used + slice.length,
      };
    };

    child.stdout.on("data", (chunk) => {
      const next = append(stdout, chunk, maxBytes, outBytes);
      stdout = next.value;
      outBytes = next.used;
    });
    child.stderr.on("data", (chunk) => {
      const next = append(stderr, chunk, maxBytes, errBytes);
      stderr = next.value;
      errBytes = next.used;
    });

    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      killTimer.unref?.();
    }, timeoutMs);
    timer.unref?.();

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolvePromise({
        ...result,
        stdout: stripAnsi(result.stdout),
        stderr: stripAnsi(result.stderr),
        truncated: truncated || result.truncated,
        timedOut: timedOut || result.timedOut,
      });
    };

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      reject(error);
    });

    child.on("close", (code, signal) => {
      finish({
        ok: code === 0,
        exitCode: code,
        signal,
        stdout,
        stderr,
        truncated,
        timedOut,
      });
    });
  });
}

let launcher = null;
async function getLauncher() {
  if (launcher) return launcher;
  if (LOCAL_MODE) {
    launcher = { command: process.execPath, prefix: [REA_SCRIPT] };
    return launcher;
  }
  const configured = process.env.REA_BIN;
  if (configured) {
    launcher = { command: configured, prefix: [] };
    return launcher;
  }
  if (existsSync(REA_RUNTIME)) {
    launcher = { command: process.execPath, prefix: [REA_SCRIPT] };
    return launcher;
  }
  try {
    const probe = await runProcess("rea", ["--version"], {
      timeoutMs: 15_000,
      maxBytes: 64 * 1024,
    });
    if (probe.ok) {
      launcher = { command: "rea", prefix: [] };
      return launcher;
    }
  } catch {
    // Fall through to the repository entry point.
  }
  launcher = { command: process.execPath, prefix: [REA_SCRIPT] };
  return launcher;
}

async function runRea(args, options = {}) {
  const { command, prefix } = await getLauncher();
  const started = Date.now();
  const result = await runProcess(command, [...prefix, ...args], options);
  return { ...result, args, durationMs: Date.now() - started };
}

function parseCommands(helpText) {
  const commands = [];
  const seen = new Set();
  for (const line of helpText.split("\n")) {
    const match = /^  ([a-z0-9][a-z0-9-]*)\s{2,}(.+)$/.exec(line);
    if (!match) continue;
    const name = match[1];
    if (name === "mcp") continue;
    if (seen.has(name)) continue;
    seen.add(name);
    commands.push({ name, description: match[2].trim() });
  }
  commands.push({
    name: "mcp",
    description:
      "MCP-Server registrieren und prüfen (Unterbefehle: add, doctor).",
  });
  commands.sort((left, right) => left.name.localeCompare(right.name));
  return commands;
}

async function getCommands() {
  if (commandCache) return commandCache;
  const result = await runRea(["--help"], { timeoutMs: 30_000 });
  if (!result.stdout.trim()) {
    throw new Error(result.stderr || "REA-Hilfe konnte nicht gelesen werden.");
  }
  commandCache = parseCommands(result.stdout);
  return commandCache;
}

async function getStatus(force = false) {
  const now = Date.now();
  if (!force && statusCache && now - statusCacheAt < 20_000) return statusCache;

  const versionResult = await runRea(["--version"], {
    timeoutMs: 15_000,
    maxBytes: 64 * 1024,
  });
  let doctor = null;
  let doctorError = null;
  try {
    const result = await runRea(["doctor", "--format", "json"], {
      timeoutMs: 60_000,
      maxBytes: 2 * 1024 * 1024,
    });
    if (result.stdout.trim()) doctor = JSON.parse(result.stdout);
    else doctorError = result.stderr.trim() || "Doctor lieferte keine Ausgabe.";
  } catch (error) {
    doctorError = error instanceof Error ? error.message : String(error);
  }

  const checks = Array.isArray(doctor?.scope_checks)
    ? doctor.scope_checks
        .filter(
          (check) => !String(check.name || "").startsWith("registration:"),
        )
        .slice(0, 14)
        .map((check) => ({
          name: String(check.name || "check"),
          ok: Boolean(check.ok),
          classification: check.classification ?? null,
          detail: check.detail ?? null,
          remediation: check.remediation ?? null,
        }))
    : [];

  statusCache = {
    version:
      versionResult.stdout.trim() || versionResult.stderr.trim() || "unbekannt",
    healthy: Boolean(doctor?.healthy),
    environmentHealthy: Boolean(doctor?.environment_healthy),
    checks,
    doctorError,
    termux: TERMUX,
    host: HOST,
    port: PORT,
    home: homedir(),
    uploadDir: UPLOAD_DIR,
    artifactsDir: ARTIFACTS_DIR,
  };
  statusCacheAt = now;
  return statusCache;
}

async function getPreflight(force = false) {
  const status = await getStatus(force);
  const jadx = status.checks.find((check) => check.name === "jadx");
  let apktool = {
    ok: false,
    detail: "apktool wurde noch nicht geprüft.",
    remediation: "",
  };

  try {
    const result = await runRea(
      ["inspect-apktool-client", "--format", "json"],
      {
        timeoutMs: 30_000,
        maxBytes: 512 * 1024,
      },
    );
    const parsed = result.stdout.trim() ? JSON.parse(result.stdout) : null;
    if (parsed && !parsed.code) {
      const normalized =
        parsed.normalized_result ?? parsed.summary?.normalized_result ?? parsed;
      const version = normalized?.client?.apktool_version;
      apktool = version
        ? { ok: true, detail: `apktool ${version}`, remediation: "" }
        : {
            ok: false,
            detail: "apktool antwortet, nennt aber keine Version.",
            remediation:
              "Prüfe den apktool-Launcher mit `rea inspect-apktool-client`.",
          };
    } else {
      apktool = {
        ok: false,
        detail: parsed?.message || result.stderr || "apktool ist nicht bereit.",
        remediation: parsed?.remediation?.action || "",
      };
    }
  } catch (error) {
    apktool = {
      ok: false,
      detail:
        error instanceof Error
          ? error.message
          : "apktool konnte nicht geprüft werden.",
      remediation: "",
    };
  }

  return {
    jadx: {
      ok: Boolean(jadx?.ok),
      detail: jadx?.detail || "JADX ist nicht eingerichtet.",
      remediation: jadx?.remediation || "",
    },
    apktool,
  };
}

async function readJsonBody(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit)
      throw Object.assign(new Error("Anfrage ist zu groß."), {
        statusCode: 413,
      });
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function handleUpload(req, res, url) {
  const name = sanitizeName(url.searchParams.get("name") || "upload.bin");
  const declared = Number(req.headers["content-length"] || 0);
  if (declared > MAX_UPLOAD) {
    json(res, 413, {
      error: `Datei ist zu groß. Maximal ${Math.round(MAX_UPLOAD / 1024 / 1024)} MB.`,
    });
    return;
  }

  await mkdir(UPLOAD_DIR, { recursive: true });
  const destination = join(
    UPLOAD_DIR,
    `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}-${name}`,
  );

  let received = 0;
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (received > MAX_UPLOAD) {
        callback(new Error("Datei ist zu groß."));
        return;
      }
      callback(null, chunk);
    },
  });

  try {
    await pipeline(
      req,
      limiter,
      createWriteStream(destination, { flags: "wx" }),
    );
    const info = await stat(destination);
    json(res, 200, {
      path: destination,
      name,
      size: info.size,
      message: "Datei lokal übernommen.",
    });
  } catch (error) {
    await unlink(destination).catch(() => {});
    const message = error instanceof Error ? error.message : String(error);
    json(res, message.includes("zu groß") ? 413 : 500, { error: message });
  }
}

async function isExecutableFile(path) {
  try {
    const info = await stat(path);
    return (
      info.isFile() &&
      (process.platform === "win32" || (info.mode & 0o111) !== 0)
    );
  } catch {
    return false;
  }
}

async function findOnPath(name) {
  for (const directory of (process.env.PATH || "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    if (await isExecutableFile(candidate)) return resolve(candidate);
  }
  return null;
}

async function findPlaywrightChrome() {
  const base = join(homedir(), ".cache", "ms-playwright");
  let entries;
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch {
    return null;
  }
  const versions = entries
    .filter((entry) => entry.isDirectory() && /^chromium-\d+$/.test(entry.name))
    .sort((left, right) => right.name.localeCompare(left.name));
  for (const version of versions) {
    for (const relative of ["chrome-linux64/chrome", "chrome-linux/chrome"]) {
      const candidate = join(base, version.name, relative);
      if (await isExecutableFile(candidate)) return resolve(candidate);
    }
  }
  return null;
}

async function probeBrowser(path) {
  try {
    const result = await runProcess(path, ["--version"], {
      timeoutMs: 5000,
      maxBytes: 64 * 1024,
    });
    const text = `${result.stdout}${result.stderr}`.trim();
    if (result.ok && /chrom(e|ium)/i.test(text)) {
      return { ok: true, version: text.slice(0, 200) };
    }
    return {
      ok: false,
      detail: text || `Browser beendet sich mit Exit ${result.exitCode}.`,
    };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function resolveBrowser(explicitPath = "") {
  const requested = String(explicitPath || "").trim();
  if (requested) {
    if (!isAbsolute(requested)) {
      return {
        ok: false,
        path: null,
        detail: "Der Browser-Pfad muss absolut sein.",
        remediation:
          "Beispiel: /data/data/com.termux/files/usr/bin/chromium-browser",
      };
    }
    if (!(await isExecutableFile(requested))) {
      return {
        ok: false,
        path: null,
        detail: `Der angegebene Browser ist nicht ausführbar: ${requested}`,
        remediation:
          "Prüfe den Pfad oder lasse das Feld leer, damit REA automatisch sucht.",
      };
    }
    const probe = await probeBrowser(resolve(requested));
    if (!probe.ok) {
      return {
        ok: false,
        path: null,
        detail: `Der Browser lässt sich nicht starten: ${probe.detail}`,
        remediation:
          "Installiere die fehlenden Browser-Abhängigkeiten oder wähle ein anderes Chromium/Chrome.",
      };
    }
    return {
      ok: true,
      path: resolve(requested),
      source: "Eigener Pfad",
      version: probe.version,
    };
  }

  const configured = String(process.env.REA_BROWSER_EXECUTABLE || "").trim();
  if (configured && (await isExecutableFile(configured))) {
    const probe = await probeBrowser(resolve(configured));
    if (probe.ok) {
      return {
        ok: true,
        path: resolve(configured),
        source: "REA_BROWSER_EXECUTABLE",
        version: probe.version,
      };
    }
  }

  let firstFailure = null;
  for (const name of BROWSER_COMMANDS) {
    for (const prefix of [process.env.PREFIX, process.env.TERMUX_PREFIX]) {
      if (!prefix) continue;
      const candidate = join(prefix, "bin", name);
      if (await isExecutableFile(candidate)) {
        const probe = await probeBrowser(resolve(candidate));
        if (probe.ok) {
          return {
            ok: true,
            path: resolve(candidate),
            source: "Termux/PATH",
            version: probe.version,
          };
        }
        firstFailure ??= `${candidate}: ${probe.detail}`;
      }
    }
    const found = await findOnPath(name);
    if (found) {
      const probe = await probeBrowser(found);
      if (probe.ok) {
        return {
          ok: true,
          path: found,
          source: "PATH",
          version: probe.version,
        };
      }
      firstFailure ??= `${found}: ${probe.detail}`;
    }
  }

  const playwrightChrome = await findPlaywrightChrome();
  if (playwrightChrome) {
    const probe = await probeBrowser(playwrightChrome);
    if (probe.ok) {
      return {
        ok: true,
        path: playwrightChrome,
        source: "Playwright-Cache",
        version: probe.version,
      };
    }
    firstFailure ??= `${playwrightChrome}: ${probe.detail}`;
  }

  const missingLibrary = firstFailure
    ? /error while loading shared libraries: ([^:]+):/.exec(firstFailure)?.[1]
    : null;
  return {
    ok: false,
    path: null,
    detail: firstFailure
      ? missingLibrary
        ? `Ein gefundener Browser startet nicht, weil ${missingLibrary} fehlt.`
        : "Ein gefundener Browser startet nicht. Prüfe die Browser-Installation."
      : configured
        ? `REA_BROWSER_EXECUTABLE ist nicht ausführbar: ${configured}`
        : "Kein Chromium/Chrome gefunden.",
    technical: firstFailure,
    remediation:
      "Installiere Chromium oder Chrome und trage den absoluten Pfad ein; alternativ REA_BROWSER_EXECUTABLE setzen.",
  };
}

async function getWebPreflight(explicitPath = "") {
  return { browser: await resolveBrowser(explicitPath) };
}

function normalizeWebUrl(raw) {
  const value = String(raw ?? "").trim();
  if (!value) {
    throw Object.assign(new Error("Bitte eine URL eingeben."), {
      statusCode: 400,
    });
  }
  if (value.length > 8192) {
    throw Object.assign(new Error("Die URL ist zu lang."), { statusCode: 400 });
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw Object.assign(
      new Error("Die URL ist ungültig. Beispiel: https://example.com"),
      { statusCode: 400 },
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw Object.assign(
      new Error("Nur http:// und https:// werden unterstützt."),
      { statusCode: 400 },
    );
  }
  if (parsed.username || parsed.password) {
    throw Object.assign(
      new Error(
        "URLs mit Benutzername oder Passwort werden nicht unterstützt.",
      ),
      { statusCode: 400 },
    );
  }
  return parsed.toString();
}

function parseClickSelectors(input) {
  const values = Array.isArray(input)
    ? input
    : String(input ?? "").split(/\r?\n/);
  const selectors = values
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);
  if (selectors.length > 20) {
    throw Object.assign(new Error("Maximal 20 Klick-Schritte."), {
      statusCode: 400,
    });
  }
  for (const selector of selectors) {
    if (selector.length > 500 || selector.includes("\0")) {
      throw Object.assign(new Error("Ein CSS-Selektor ist ungültig."), {
        statusCode: 400,
      });
    }
  }
  return selectors;
}

function buildWebScenario({
  url,
  browserPath,
  waitMs,
  selectors,
  captureBodies,
  captureHeaders,
  allowServiceWorkers,
}) {
  const actions = [
    { step_id: "settle", action: "wait_for_timeout", duration_ms: waitMs },
  ];
  selectors.forEach((selector, index) => {
    actions.push({
      step_id: `click_${index + 1}`,
      action: "click",
      locator: { kind: "css", selector },
      timeout_ms: 5000,
    });
    actions.push({
      step_id: `after_click_${index + 1}`,
      action: "wait_for_timeout",
      duration_ms: 800,
    });
  });

  return {
    browser: {
      mode: "launch",
      executable_path: browserPath,
      headless: true,
    },
    start_url: { url },
    environment: {
      viewport: { width: 1280, height: 720, device_scale_factor: 1 },
      locale: "de-DE",
      timezone: "Europe/Berlin",
      service_workers: allowServiceWorkers ? "allow" : "block",
    },
    actions,
    capture: {
      after_each_step:
        selectors.length > 0 ? ["url", "dom", "accessibility"] : [],
      at_end: ["url", "dom", "accessibility", "history", "storage"],
      events: [
        "console",
        "page-errors",
        "network",
        "websockets",
        "frames",
        "workers",
        "popups",
        "downloads",
      ],
      network: {
        request_body: captureBodies,
        response_body: captureBodies,
        header_values: captureHeaders,
      },
    },
    command_timeout_ms: 30000,
  };
}

function parseJsonOutput(result) {
  const text = String(result?.stdout || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function countFiles(directory) {
  let count = 0;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return count;
  }
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) count += await countFiles(full);
    else if (entry.isFile()) count += 1;
  }
  return count;
}

function browserUrl(value) {
  if (value && typeof value === "object") return value.url || null;
  return typeof value === "string" ? value : null;
}

function summarizeCapture(capture) {
  if (!capture || typeof capture !== "object") return null;
  const events = Array.isArray(capture.events?.items)
    ? capture.events.items
    : [];
  const kinds = new Map();
  const transactions = new Map();
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    if (event.kind) kinds.set(event.kind, (kinds.get(event.kind) || 0) + 1);
    if (!event.transaction_id) continue;
    let transaction = transactions.get(event.transaction_id);
    if (!transaction) {
      transaction = {
        origins: new Set(),
        types: new Set(),
        statuses: new Set(),
        failed: false,
        method: null,
        url: null,
        status: null,
        sequence: null,
      };
      transactions.set(event.transaction_id, transaction);
    }
    if (event.url?.origin) transaction.origins.add(event.url.origin);
    if (event.resource_type) transaction.types.add(event.resource_type);
    if (event.kind === "request") {
      transaction.method = event.method || transaction.method;
      transaction.sequence ??= Number.isInteger(event.sequence)
        ? event.sequence
        : null;
    }
    if (event.kind === "response" && Number.isInteger(event.status)) {
      transaction.statuses.add(event.status);
      transaction.status = event.status;
    }
    if (event.kind === "request-failed") transaction.failed = true;
    transaction.url = browserUrl(event.url) || transaction.url;
  }

  const origins = new Map();
  const types = new Map();
  const statuses = new Map();
  for (const transaction of transactions.values()) {
    const origin =
      transaction.origins.size === 1
        ? transaction.origins.values().next().value
        : null;
    origins.set(origin, (origins.get(origin) || 0) + 1);
    const type =
      transaction.types.size === 1
        ? transaction.types.values().next().value
        : null;
    types.set(type, (types.get(type) || 0) + 1);
    const status =
      transaction.statuses.size === 1
        ? transaction.statuses.values().next().value
        : null;
    const statusClass =
      status === null
        ? transaction.failed
          ? "failed"
          : "unknown"
        : `${Math.floor(status / 100)}xx`;
    statuses.set(statusClass, (statuses.get(statusClass) || 0) + 1);
  }

  const steps = Array.isArray(capture.steps)
    ? capture.steps.map((step) => ({
        step_index: step.step_index,
        step_id: step.step_id,
        action: step.action,
        status: step.status,
        error: step.error,
        elapsed_ms: step.elapsed_ms,
        before_url: step.before_url,
        after_url: step.after_url,
        events: step.events,
        completeness: step.completeness,
      }))
    : [];
  const networkContent = capture.scenario?.network_content;
  const selectedNetwork =
    Boolean(networkContent) && Object.values(networkContent).some(Boolean);

  const requests = [...transactions.values()]
    .filter((transaction) => transaction.url)
    .sort(
      (left, right) =>
        (left.sequence ?? Infinity) - (right.sequence ?? Infinity),
    )
    .slice(0, 50)
    .map((transaction) => ({
      method: transaction.method || "?",
      url: transaction.url,
      status: transaction.status,
      failed: transaction.failed,
      resource_type:
        transaction.types.size === 1
          ? transaction.types.values().next().value
          : null,
    }));

  return {
    browser: capture.browser,
    scenario: capture.scenario,
    duration_ms: capture.duration_ms,
    completeness: capture.completeness,
    steps,
    events: {
      retained: capture.events?.retained ?? events.length,
      dropped: capture.events?.dropped ?? 0,
      by_kind: [...kinds].map(([kind, count]) => ({ kind, count })),
      omissions: capture.events?.omissions ?? {
        by_kind: [],
        network_transactions: 0,
        network_transaction_range: null,
      },
    },
    network: {
      selected: selectedNetwork,
      transactions: transactions.size,
      without_request: 0,
      ambiguous_transactions: 0,
      failed_transactions: [...transactions.values()].filter(
        (transaction) => transaction.failed,
      ).length,
      by_origin: [...origins].map(([origin, count]) => ({
        origin,
        transactions: count,
      })),
      by_resource_type: [...types].map(([resource_type, count]) => ({
        resource_type,
        transactions: count,
      })),
      by_status_class: [...statuses].map(([status_class, count]) => ({
        status_class,
        transactions: count,
      })),
      requests,
    },
    limitation_count: Array.isArray(capture.limitations)
      ? capture.limitations.length
      : 0,
  };
}

function listCounts(items, render) {
  if (!Array.isArray(items) || items.length === 0) return "keine";
  return items.map(render).join(", ");
}

function buildWebReport({
  url,
  captureSummary,
  captureResult,
  capturePath,
  exportResult,
  scriptsDir,
  analysisInput,
  fileCount,
  analysisResult,
  analysisSummary,
  analysisEvidence,
}) {
  const steps = Array.isArray(captureSummary?.steps)
    ? captureSummary.steps
    : [];
  const finalStep = steps.at(-1);
  const finalUrl =
    browserUrl(finalStep?.after_url) ||
    browserUrl(captureSummary?.scenario?.start_url) ||
    url;
  const network = captureSummary?.network;
  const events = captureSummary?.events;
  const durationMs = captureSummary?.duration_ms ?? captureResult?.durationMs;
  const lines = ["# Web-App-Aufnahme", ""];
  lines.push(`- Start-URL: ${url}`);
  lines.push(`- End-URL: ${finalUrl}`);
  lines.push(`- Aufnahme: ${Math.round(Number(durationMs) || 0)} ms`);
  const missingSections = Array.isArray(
    captureSummary?.completeness?.missing_sections,
  )
    ? captureSummary.completeness.missing_sections
    : [];
  lines.push(
    `- Vollständigkeit: ${captureSummary?.completeness?.status || "unbekannt"}${missingSections.length > 0 ? ` (fehlende Abschnitte: ${missingSections.join(", ")})` : ""}`,
  );
  lines.push(`- Schritte: ${steps.length > 0 ? steps.length : "keine"}`);

  if (network) {
    lines.push("", "## Netzwerk");
    lines.push(`- Transaktionen: ${network.transactions ?? "unbekannt"}`);
    lines.push(`- Fehlgeschlagen: ${network.failed_transactions ?? 0}`);
    lines.push(
      `- Statusklassen: ${listCounts(network.by_status_class, (item) => `${item.status_class}: ${item.transactions}`)}`,
    );
    lines.push(
      `- Typen: ${listCounts(network.by_resource_type, (item) => `${item.resource_type || "unbekannt"}: ${item.transactions}`)}`,
    );
    lines.push(
      `- Origins: ${listCounts(network.by_origin, (item) => `${item.origin || "unbekannt"}: ${item.transactions}`)}`,
    );
    if (Array.isArray(network.requests) && network.requests.length > 0) {
      lines.push("", "## Kommunikation");
      for (const request of network.requests.slice(0, 25)) {
        const status =
          request.status ?? (request.failed ? "Netzwerkfehler" : "offen");
        const url = String(request.url);
        lines.push(
          `- ${request.method} ${url.length > 180 ? `${url.slice(0, 177)}...` : url} → ${status}${request.resource_type ? ` (${request.resource_type})` : ""}`,
        );
      }
      if (network.requests.length > 25) {
        lines.push(
          `- ... ${network.requests.length - 25} weitere Transaktionen in der Aufnahme-Evidenz.`,
        );
      }
    }
  }

  if (events) {
    lines.push("", "## Ereignisse");
    lines.push(`- Behalten: ${events.retained ?? 0}`);
    lines.push(`- Verworfen: ${events.dropped ?? 0}`);
    lines.push(
      `- Arten: ${listCounts(events.by_kind, (item) => `${item.kind}: ${item.count}`)}`,
    );
  }

  if (steps.length > 0) {
    lines.push("", "## Schritte");
    for (const step of steps) {
      lines.push(
        `- ${step.action}: ${step.status} → ${browserUrl(step.after_url) || "?"} (${step.elapsed_ms ?? "?"} ms)`,
      );
    }
  }

  lines.push("", "## Skripte und Code");
  if (!exportResult) {
    lines.push(
      "- Kein Skript-Export, weil die Aufnahme nicht abgeschlossen wurde.",
    );
  } else {
    lines.push(
      `- Export: ${exportResult.ok ? "erfolgreich" : "mit Hinweisen"}`,
    );
    lines.push(`- JavaScript-Dateien: ${fileCount}`);
    lines.push(`- Ordner: ${analysisInput || scriptsDir}`);
  }

  if (analysisResult) {
    lines.push("", "## JavaScript-Analyse");
    const statistics = analysisSummary?.statistics;
    if (!analysisResult.ok) {
      lines.push("- Status: mit Hinweisen; Details stehen in der Evidenz.");
    }
    if (statistics) {
      lines.push(
        `- Geparste JavaScript-Dateien: ${statistics.parsed_javascript_files ?? 0}`,
      );
      lines.push(`- Relevante Dateien: ${statistics.relevant_files ?? 0}`);
      lines.push(`- AST-Knoten: ${statistics.visited_ast_nodes ?? 0}`);
      lines.push(`- Findings: ${statistics.findings ?? 0}`);
      lines.push(`- Module: ${statistics.modules ?? 0}`);
      lines.push(`- Parse-Fehler: ${statistics.parse_failures ?? 0}`);
      lines.push(
        `- Anwendungsabdeckung: ${analysisSummary?.coverage?.application?.status ?? "unbekannt"}`,
      );
      lines.push(
        `- Analyse-Einschränkungen: ${analysisSummary?.limitation_count ?? 0}`,
      );
    } else {
      lines.push(
        "- Die Analyse ist gespeichert, aber die Zusammenfassung konnte nicht gelesen werden.",
      );
    }
  }

  lines.push("", "## Beweise");
  lines.push(`- Aufnahme: ${capturePath}`);
  lines.push(`- Skripte: ${scriptsDir}`);
  if (analysisEvidence) lines.push(`- Analyse: ${analysisEvidence}`);

  lines.push("", "## Grenzen");
  lines.push(
    "- Die Aufnahme zeigt, was der Browser in diesem Lauf gesehen hat. Sie ist kein Beweis für die komplette Anwendung.",
  );
  lines.push(
    "- Login, Captcha, serverseitige Logik, nicht ausgelöste Interaktionen und fremde Origins können fehlen.",
  );
  lines.push(
    `- REA meldet ${captureSummary?.limitation_count ?? "unbekannt"} Einschränkung(en); die vollständige Evidenz enthält die Details.`,
  );
  lines.push(
    "- Die statische JavaScript-Analyse zeigt Code und Kandidaten, keine garantierte Laufzeitidentität.",
  );

  return lines.join("\n");
}

async function handleWebAnalyze(req, res) {
  const started = Date.now();
  const body = await readJsonBody(req, 1_000_000);
  const url = normalizeWebUrl(body?.url);
  const browser = await resolveBrowser(body?.browserPath || "");
  if (!browser.ok) {
    json(res, 503, {
      error: browser.detail,
      preflight: { browser },
    });
    return;
  }

  const requestedWait = Number(body?.waitMs);
  const waitMs = Math.min(
    Math.max(Number.isFinite(requestedWait) ? requestedWait : 3000, 500),
    30000,
  );
  const selectors = parseClickSelectors(body?.clickSelectors);
  const captureBodies = body?.captureBodies !== false;
  const captureHeaders = body?.captureHeaders !== false;
  const allowServiceWorkers = body?.allowServiceWorkers !== false;

  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const runDir = join(WEB_DIR, runId);
  const scenarioPath = join(runDir, "scenario.json");
  const capturePath = join(runDir, "capture-evidence.json");
  const scriptsDir = join(runDir, "scripts");
  const scenario = buildWebScenario({
    url,
    browserPath: browser.path,
    waitMs,
    selectors,
    captureBodies,
    captureHeaders,
    allowServiceWorkers,
  });

  await mkdir(runDir, { recursive: true });
  await writeFile(scenarioPath, JSON.stringify(scenario, null, 2), {
    encoding: "utf8",
    flag: "wx",
  });

  const captureResult = await runRea(
    [
      "capture-browser-scenario",
      scenarioPath,
      "--detail",
      "complete",
      "--format",
      "json",
    ],
    { timeoutMs: 120_000, maxBytes: 32 * 1024 * 1024 },
  );
  const capturePayload = parseJsonOutput(captureResult);
  const captureData =
    capturePayload?.normalized_result ?? capturePayload?.capture ?? null;
  const captureSummary = summarizeCapture(captureData);
  const errors = [];
  let captureWritten = false;

  if (!captureResult.ok) {
    errors.push(
      capturePayload?.message ||
        capturePayload?.error ||
        captureResult.stderr.trim() ||
        "Die Browser-Aufnahme ist fehlgeschlagen.",
    );
  } else if (captureResult.truncated) {
    errors.push(
      "Die Aufnahme war zu groß für die Oberfläche. Erhöhe nicht das Limit, sondern analysiere eine kleinere Seite oder nutze die CLI direkt.",
    );
  } else if (!capturePayload) {
    errors.push("Die Aufnahme lieferte keine lesbare JSON-Evidenz.");
  } else {
    try {
      await writeFile(capturePath, captureResult.stdout, {
        encoding: "utf8",
        flag: "wx",
      });
      captureWritten = true;
    } catch (error) {
      errors.push(
        `Die Aufnahme konnte nicht gespeichert werden: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  let exportResult = null;
  let exportPayload = null;
  let analysisInput = null;
  let fileCount = 0;
  let analysisResult = null;
  let analysisSummary = null;
  let analysisEvidence = null;

  if (captureWritten) {
    exportResult = await runRea(
      ["export-web-scripts", capturePath, scriptsDir, "--format", "json"],
      { timeoutMs: 120_000, maxBytes: 16 * 1024 * 1024 },
    );
    exportPayload = parseJsonOutput(exportResult);
    const declaredInput =
      exportPayload?.normalized_result?.analysis_input?.input_path ??
      exportPayload?.summary?.normalized_result?.analysis_input?.input_path ??
      exportPayload?.analysis_input?.input_path ??
      exportPayload?.analysis_input?.path ??
      null;
    analysisInput =
      declaredInput && existsSync(declaredInput)
        ? declaredInput
        : join(scriptsDir, "files");
    if (existsSync(analysisInput)) {
      fileCount = await countFiles(analysisInput);
    }
    if (!exportResult.ok) {
      errors.push(
        exportPayload?.message ||
          exportPayload?.error ||
          exportResult.stderr.trim() ||
          "Der Skript-Export ist fehlgeschlagen.",
      );
    } else if (fileCount > 0) {
      analysisEvidence = join(runDir, "analysis-evidence.json");
      analysisResult = await runRea(
        [
          "analyze-javascript-application",
          analysisInput,
          "--format",
          "json",
          "--detail",
          "summary",
          "--evidence_output",
          analysisEvidence,
        ],
        { timeoutMs: 300_000, maxBytes: 16 * 1024 * 1024 },
      );
      const analysisPayload = parseJsonOutput(analysisResult);
      analysisSummary =
        analysisPayload?.summary?.normalized_result?.summary ??
        analysisPayload?.normalized_result?.summary ??
        null;
      if (!analysisResult.ok) {
        errors.push(
          analysisPayload?.message ||
            analysisPayload?.error ||
            analysisResult.stderr.trim() ||
            "Die JavaScript-Analyse ist fehlgeschlagen.",
        );
      }
    }
  }

  const ok =
    captureWritten &&
    (!exportResult || exportResult.ok) &&
    (!analysisResult || analysisResult.ok);
  const report = buildWebReport({
    url,
    captureSummary,
    captureResult,
    capturePath,
    exportResult,
    scriptsDir,
    analysisInput,
    fileCount,
    analysisResult,
    analysisSummary,
    analysisEvidence,
  });

  json(res, 200, {
    ok,
    exitCode:
      captureResult.exitCode ??
      exportResult?.exitCode ??
      analysisResult?.exitCode ??
      null,
    stdout: report,
    stderr: errors.join("\n\n"),
    durationMs: Date.now() - started,
    timedOut: Boolean(
      captureResult.timedOut ||
      exportResult?.timedOut ||
      analysisResult?.timedOut,
    ),
    truncated: Boolean(
      captureResult.truncated ||
      exportResult?.truncated ||
      analysisResult?.truncated,
    ),
    command: `web-app ${url}`,
    artifacts: {
      scenario: scenarioPath,
      capture: capturePath,
      scripts: scriptsDir,
      analysisInput,
      analysisEvidence,
    },
  });
}

async function handleMcpStatus() {
  try {
    const result = await runProcess("sv", ["status", "rea-mcp"], {
      cwd: ROOT,
      timeoutMs: 10_000,
      maxBytes: 128 * 1024,
    });
    const raw = `${result.stdout}${result.stderr}`.trim();
    return {
      available: true,
      running: /^run:/m.test(raw),
      raw:
        raw || (result.ok ? "rea-mcp ist aktiv." : "rea-mcp ist nicht aktiv."),
    };
  } catch (error) {
    return {
      available: false,
      running: false,
      raw:
        error?.code === "ENOENT"
          ? "termux-services/sv wurde nicht gefunden. Installiere termux-services und starte den Dienst einmal."
          : error instanceof Error
            ? error.message
            : String(error),
    };
  }
}

async function handleMcpAction(action) {
  if (!["up", "down", "restart", "status"].includes(action)) {
    throw Object.assign(new Error("Unbekannte MCP-Aktion."), {
      statusCode: 400,
    });
  }
  try {
    const result = await runProcess("sv", [action, "rea-mcp"], {
      cwd: ROOT,
      timeoutMs: 20_000,
      maxBytes: 256 * 1024,
    });
    return {
      ok: result.ok,
      action,
      output: `${result.stdout}${result.stderr}`.trim(),
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw Object.assign(
        new Error(
          "termux-services/sv wurde nicht gefunden. Installiere termux-services zuerst.",
        ),
        { statusCode: 503 },
      );
    }
    throw error;
  }
}

async function handleMcpLog() {
  const prefix = process.env.PREFIX || "";
  const candidates = [
    prefix ? join(prefix, "var", "log", "rea-mcp", "current") : null,
    join(homedir(), ".termux", "var", "log", "rea-mcp", "current"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const value = await readFile(candidate, "utf8");
    const lines = value.split("\n");
    const tail = lines.slice(-250).join("\n");
    return {
      available: true,
      path: candidate,
      text: tail.length > 200_000 ? tail.slice(-200_000) : tail,
    };
  }

  return {
    available: false,
    path: candidates[0] ?? null,
    text: "Noch keine Logdatei gefunden. Starte den Dienst und prüfe danach erneut.",
  };
}

async function handleRun(req, res) {
  const body = await readJsonBody(req);
  const args = body?.args;
  if (!Array.isArray(args) || args.length === 0 || args.length > 100) {
    json(res, 400, { error: "args muss ein nicht-leeres Array sein." });
    return;
  }
  if (
    !args.every(
      (arg) =>
        typeof arg === "string" && arg.length <= 16_384 && !arg.includes("\0"),
    )
  ) {
    json(res, 400, { error: "Ungültige Argumente." });
    return;
  }

  const command = args[0];
  const commands = await getCommands();
  const allowed = new Set(commands.map((entry) => entry.name));
  if (
    !allowed.has(command) &&
    command !== "--version" &&
    command !== "--help"
  ) {
    json(res, 400, { error: `Unbekannter REA-Befehl: ${command}` });
    return;
  }

  const timeoutMs = Math.min(
    Math.max(Number(body.timeoutMs) || 600_000, 5_000),
    900_000,
  );
  const result = await runRea(args, { timeoutMs });
  const launcherInfo = await getLauncher();
  json(res, 200, {
    ...result,
    command: [launcherInfo.command, ...launcherInfo.prefix, ...args].join(" "),
  });
}

async function serveStatic(res, pathname) {
  const files = new Map([
    ["/", "index.html"],
    ["/index.html", "index.html"],
    ["/app.js", "app.js"],
    ["/styles.css", "styles.css"],
  ]);
  const name = files.get(pathname);
  if (!name) return false;

  const types = {
    "index.html": "text/html; charset=utf-8",
    "app.js": "text/javascript; charset=utf-8",
    "styles.css": "text/css; charset=utf-8",
  };
  const body = await readFile(join(UI_DIR, name));
  res.writeHead(200, {
    "content-type": types[name],
    "cache-control": "no-store",
    "content-length": body.length,
  });
  res.end(body);
  return true;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(
      req.url || "/",
      `http://${req.headers.host || "localhost"}`,
    );

    if (ACCESS_TOKEN && url.pathname !== "/favicon.ico") {
      const supplied =
        url.searchParams.get("token") || cookieValue(req, "rea_ui_token");
      if (sameSecret(supplied, ACCESS_TOKEN)) {
        if (url.searchParams.has("token")) {
          res.writeHead(302, {
            location: "/",
            "set-cookie": `rea_ui_token=${encodeURIComponent(ACCESS_TOKEN)}; HttpOnly; SameSite=Strict; Path=/`,
          });
          res.end();
          return;
        }
      } else {
        text(
          res,
          401,
          "Zugriff nur mit gültigem Token. Öffne die Oberfläche mit ?token=…",
        );
        return;
      }
    }

    if (req.method === "GET" && url.pathname === "/api/health") {
      json(res, 200, { ok: true, service: "rea-ui", version: "1.0.0" });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/status") {
      json(res, 200, await getStatus(url.searchParams.get("refresh") === "1"));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/preflight") {
      json(
        res,
        200,
        await getPreflight(url.searchParams.get("refresh") === "1"),
      );
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/commands") {
      json(res, 200, { commands: await getCommands() });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/config") {
      json(res, 200, {
        home: homedir(),
        uploadDir: UPLOAD_DIR,
        artifactsDir: ARTIFACTS_DIR,
        termux: TERMUX,
        host: HOST,
        port: PORT,
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/evidence-path") {
      await mkdir(ARTIFACTS_DIR, { recursive: true });
      const label = sanitizeName(
        url.searchParams.get("label") || "evidence",
        "evidence",
      )
        .replace(/\.json$/i, "")
        .slice(0, 60);
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      json(res, 200, {
        path: join(ARTIFACTS_DIR, `${label}-${stamp}.json`),
        directory: ARTIFACTS_DIR,
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/web/preflight") {
      json(res, 200, await getWebPreflight(url.searchParams.get("path") || ""));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/web/analyze") {
      await handleWebAnalyze(req, res);
      return;
    }

    if (req.method === "PUT" && url.pathname === "/api/upload") {
      await handleUpload(req, res, url);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/run") {
      await handleRun(req, res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/mcp/status") {
      json(res, 200, await handleMcpStatus());
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/mcp/log") {
      json(res, 200, await handleMcpLog());
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/mcp/action") {
      const body = await readJsonBody(req);
      json(res, 200, await handleMcpAction(String(body?.action || "")));
      return;
    }

    if (req.method === "GET" && url.pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "GET" && (await serveStatic(res, url.pathname))) return;

    json(res, 404, { error: "Nicht gefunden." });
  } catch (error) {
    const statusCode = error?.statusCode ?? 500;
    json(res, statusCode, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

server.on("error", (error) => {
  if (error?.code === "EADDRINUSE") {
    console.error(
      `Port ${PORT} ist bereits belegt. Starte mit einem anderen Port, z. B. REA_UI_PORT=8788 npm run ui.`,
    );
    process.exit(1);
  }
  console.error(
    `Der UI-Server konnte nicht starten: ${error?.message || error}`,
  );
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const displayHost = HOST === "0.0.0.0" ? "127.0.0.1" : HOST;
  const url = `http://${displayHost}:${PORT}`;
  console.log("");
  console.log("  REA Studio");
  console.log(`  ${url}`);
  console.log("");
  console.log("  Lokal im Browser öffnen. Beenden mit Ctrl+C.");
  console.log("");

  if (TERMUX && !NO_OPEN) {
    const opener = spawn("termux-open-url", [url], {
      detached: true,
      stdio: "ignore",
    });
    opener.on("error", () => {});
    opener.unref();
  }
});

const shutdown = () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2_000).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
