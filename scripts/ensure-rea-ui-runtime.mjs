import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtime = join(root, "dist", "cli-runtime", "cli.js");

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function commandWorks(command, args) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd: root, stdio: "ignore" });
    child.on("error", () => resolvePromise(false));
    child.on("exit", (code) => resolvePromise(code === 0));
  });
}

function run(command, args) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd: root,
      env: {
        ...process.env,
        HUSKY: "0",
        TURBO_CACHE_DIR: join(root, ".turbo", "cache"),
      },
      stdio: "inherit",
    });
    child.on("error", (error) => {
      console.error(`Konnte ${command} nicht starten: ${error.message}`);
      resolvePromise(1);
    });
    child.on("exit", (code, signal) => {
      resolvePromise(code ?? (signal ? 1 : 0));
    });
  });
}

if (await exists(runtime)) process.exit(0);

if (
  process.env.REA_UI_LOCAL !== "1" &&
  (await commandWorks("rea", ["--version"]))
) {
  process.exit(0);
}

console.log("");
console.log("REA-Laufzeit fehlt; baue sie einmalig für die Oberfläche …");
console.log("Das kann beim ersten Start einige Minuten dauern.");
console.log("");

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const termux = Boolean(
  process.env.TERMUX_VERSION || process.env.PREFIX?.includes("com.termux"),
);
const buildScript = termux ? "build:termux" : "compile";
const status = await run(npm, ["run", buildScript]);
if (status !== 0) {
  console.error("");
  console.error(
    "Der Build ist fehlgeschlagen. Die Oberfläche kann ohne REA-Laufzeit nicht starten.",
  );
  console.error(
    `Führe \`npm ci && npm run ${buildScript}\` im Repository aus und versuche es erneut.`,
  );
  process.exit(status);
}
