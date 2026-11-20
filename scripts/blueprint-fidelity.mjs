#!/usr/bin/env node
/**
 * CLI for the fidelity harness (spec §10).
 *
 * Argument parsing and output only: the comparison itself lives in
 * `ui/blueprint/fidelity.mjs`, so the CLI can never grow its own opinion about
 * what counts as a pass.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runFidelity } from "../ui/blueprint/fidelity.mjs";

const USAGE = `Usage: npm run blueprint:fidelity -- --package <zip|dir> --rebuild <dir> [--out <file>] [--expectations <file>]

Prüft ein Blaupausen-Paket gegen einen Rebuild und schreibt rebuild-report.json.
Das Harness baut den Rebuild nie selbst und führt das Original nie aus.`;

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (!arg.startsWith("--")) continue;
    const [flag, inline] = arg.split("=");
    const key = flag.slice(2);
    const value = inline ?? argv[index + 1];
    if (inline === undefined) index += 1;
    options[key] = value;
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}
if (!options.package || !options.rebuild) {
  process.stderr.write(`${USAGE}\n`);
  process.exit(2);
}

const out = options.out ?? join(options.rebuild, "rebuild-report.json");
const expectations = options.expectations
  ? JSON.parse(await readFile(options.expectations, "utf8"))
  : {};

try {
  const report = await runFidelity({
    package: options.package,
    rebuild: options.rebuild,
    expectations,
  });
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const { passed, failed, skipped, unexecutable } = report.summary;
  process.stdout.write(
    `Rebuild-Bericht: ${report.verdict} · ${passed} passed, ${failed} failed, ${skipped} skipped, ${unexecutable} unexecutable\n${out}\n`,
  );
  process.exit(report.verdict === "pass" ? 0 : 1);
} catch (error) {
  process.stderr.write(
    `${error?.code ?? "blueprint.fidelity"}: ${error?.message ?? error}\n`,
  );
  process.exit(1);
}
