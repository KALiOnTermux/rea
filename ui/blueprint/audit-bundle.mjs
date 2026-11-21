/**
 * The verifier that travels with the package (spec §10).
 *
 * The archive has to answer "is this package still valid?" without the
 * repository: `node audit/scripts/blueprint-verify.mjs .` must work from the
 * unpacked download with nothing but Node. This module collects the verifier's
 * own import closure and the CLI that runs it.
 *
 * Every file is copied byte for byte under `audit/` with its repository-relative
 * path, so the relative imports inside the closure resolve inside the package
 * and no import has to be rewritten. There is no second implementation: the
 * packaged checker is the same file the repository tests, and the build refuses
 * to continue when a relative import cannot be read.
 */

import { readFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ENTRY = fileURLToPath(new URL("./package-verify.mjs", import.meta.url));
const PROJECT = resolve(dirname(ENTRY), "../..");
const CLI = resolve(PROJECT, "scripts/blueprint-verify.mjs");

/** `import … from "./x.mjs"` and `import "./x.mjs"`, across line breaks. */
const IMPORT = /^[ \t]*import\s+(?:[^"']*?\s+from\s+)?["'](\.[^"']+)["']/gm;

/** Every relative module the verifier reaches, resolved and sorted. */
async function closure(entry) {
  const seen = new Set();
  const visit = async (file) => {
    const path = resolve(file);
    if (seen.has(path)) return;
    seen.add(path);
    const text = await readFile(path, "utf8");
    for (const match of text.matchAll(IMPORT)) {
      await visit(resolve(dirname(path), match[1]));
    }
  };
  await visit(entry);
  return [...seen].sort();
}

/**
 * Package parts of the standalone checker, keyed by their packaged path.
 * `audit/ui/blueprint/…` mirrors the repository so the copied imports keep
 * pointing at the copied modules, and `audit/scripts/blueprint-verify.mjs`
 * reaches them through `../ui/blueprint/…` exactly as it does in the repo.
 */
export async function auditParts() {
  const parts = new Map();
  for (const file of await closure(ENTRY)) {
    const name = relative(PROJECT, file).split(sep).join("/");
    parts.set(`audit/${name}`, await readFile(file, "utf8"));
  }
  parts.set("audit/scripts/blueprint-verify.mjs", await readFile(CLI, "utf8"));
  return new Map(
    [...parts].sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  );
}
