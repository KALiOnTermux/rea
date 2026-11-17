#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, stat, unlink } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { fileURLToPath } from "node:url";
import { randomUUID, timingSafeEqual } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const UI_DIR = HERE;
const REA_SCRIPT = join(ROOT, "scripts", "rea.mjs");
const requestedPort = Number(process.env.REA_UI_PORT || 8787);
const PORT =
  Number.isInteger(requestedPort) && requestedPort > 0 && requestedPort < 65_536
    ? requestedPort
    : 8787;
const HOST = process.env.REA_UI_HOST || "127.0.0.1";
const MAX_UPLOAD = 512 * 1024 * 1024;
const MAX_OUTPUT = 4 * 1024 * 1024;
const UPLOAD_DIR = join(homedir(), "rea-ui", "uploads");
const ARTIFACTS_DIR = join(homedir(), "rea-artifacts");
const TERMUX = Boolean(
  process.env.TERMUX_VERSION || process.env.PREFIX?.includes("com.termux"),
);
const ACCESS_TOKEN = process.env.REA_UI_TOKEN || "";
const LOCAL_MODE = process.env.REA_UI_LOCAL === "1";
const NO_OPEN = process.argv.includes("--no-open");

const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const stripAnsi = (value) => value.replace(ANSI, "");

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
