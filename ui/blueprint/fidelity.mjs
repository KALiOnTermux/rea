/**
 * The fidelity harness (spec §10, Task 17).
 *
 * It answers one question: does a user-supplied rebuild satisfy the package's
 * acceptance checks? It never builds the rebuild and never executes the original
 * target, so the answer stays a comparison of evidence, not a new observation.
 *
 * A failed criterion is reported as a blueprint defect by default — ambiguity or
 * missing evidence in the package — unless the corpus marks it `rebuild-defect`.
 * That default keeps the harness honest: the rebuild is only excused when someone
 * wrote down why.
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { verifyManifest } from "./manifest.mjs";
import { runAcceptance } from "./run-acceptance.mjs";
import { transcriptClientFromPackage } from "./transcript-client.mjs";

export const REPORT_SCHEMA = "rea.blueprint.rebuild-report";
export const REPORT_SCHEMA_VERSION = 1;
export const CLASSIFICATIONS = ["blueprint-defect", "rebuild-defect"];

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

export class FidelityError extends Error {
  constructor(message, { code = "blueprint.fidelity" } = {}) {
    super(message);
    this.name = "FidelityError";
    this.code = code;
  }
}

/** Reads a ZIP into `{ name, bytes }` entries; no dependencies, no zip64. */
export function readZipEntries(buffer) {
  let eocd = -1;
  const stop = Math.max(0, buffer.length - 66_000);
  for (let index = buffer.length - 22; index >= stop; index -= 1) {
    if (buffer.readUInt32LE(index) === EOCD_SIGNATURE) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0) {
    throw new FidelityError("package is not a readable zip archive");
  }
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new FidelityError("package has a damaged central directory");
    }
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
    if (buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      throw new FidelityError(`package entry ${name} has a damaged header`);
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(start, start + compressedSize);
    entries.push({
      name,
      bytes: method === 8 ? inflateRawSync(raw) : Buffer.from(raw),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function unpackToTemp(zipPath) {
  const dir = await mkdtemp(join(tmpdir(), "rea-fidelity-unpacked-"));
  for (const entry of readZipEntries(await readFile(zipPath))) {
    const full = join(dir, entry.name);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, entry.bytes);
  }
  return dir;
}

async function packageRoot(path) {
  const info = await stat(path).catch(() => null);
  if (!info) throw new FidelityError(`package ${path} does not exist`);
  return info.isDirectory() ? path : unpackToTemp(path);
}

function readJson(root, name) {
  const full = join(root, name);
  if (!existsSync(full)) return null;
  return readFile(full, "utf8").then((text) => JSON.parse(text));
}

/**
 * Verifies the package and returns its IR and acceptance file.
 *
 * `verifyManifest` reads synchronously, so the declared files are read first; a
 * missing or edited file then shows up as a hash mismatch instead of an exception
 * somewhere in the middle of the comparison.
 */
async function loadVerifiedPackage(packagePath) {
  const root = await packageRoot(packagePath);
  const manifest = await readJson(root, "MANIFEST.json");
  if (!manifest) {
    throw new FidelityError(`package ${root} has no manifest (MANIFEST.json)`);
  }
  const contents = new Map();
  for (const entry of Array.isArray(manifest.files) ? manifest.files : []) {
    const full = join(root, String(entry?.path ?? ""));
    contents.set(
      entry?.path,
      existsSync(full) ? await readFile(full) : Buffer.alloc(0),
    );
  }
  const verified = verifyManifest(
    manifest,
    (path) => contents.get(path) ?? Buffer.alloc(0),
  );
  if (!verified.ok) {
    const [first] = verified.violations;
    throw new FidelityError(
      `package manifest does not match its files: ${first.subject} — ${first.detail}`,
      { code: "manifest.hash_mismatch" },
    );
  }
  const blueprint = await readJson(root, "blueprint.json");
  if (!blueprint) {
    throw new FidelityError(`package ${root} has no blueprint.json`);
  }
  const acceptance = await readJson(root, "acceptance.json");
  if (!acceptance) {
    throw new FidelityError(`package ${root} has no acceptance.json`);
  }
  return { blueprint, acceptance };
}

/** Only a failed criterion carries a classification; a pass needs no excuse. */
function classify(verdicts, expectations) {
  const declared = expectations?.classification ?? {};
  return verdicts.map((item) => {
    if (item.status !== "failed") return item;
    const marked = CLASSIFICATIONS.find((value) => value === declared[item.id]);
    return { ...item, classification: marked ?? "blueprint-defect" };
  });
}

function buildReport(blueprint, result, expectations) {
  return {
    schema: REPORT_SCHEMA,
    schema_version: REPORT_SCHEMA_VERSION,
    package: { id: blueprint.id, ceiling: blueprint.ceiling?.ceiling ?? null },
    criteria: classify(result.verdicts, expectations),
    summary: {
      passed: result.passed,
      failed: result.failed,
      skipped: result.skipped,
      unexecutable: result.unexecutable,
    },
    verdict: result.failed === 0 && result.unexecutable === 0 ? "pass" : "fail",
  };
}

/**
 * Verifies the package, runs its acceptance checks against `rebuild`, and
 * returns the rebuild report. Nothing here writes the report; the CLI does.
 */
export async function runFidelity({
  package: packagePath,
  rebuild,
  expectations = {},
  request,
  harness,
} = {}) {
  if (typeof rebuild !== "string" || rebuild === "") {
    throw new FidelityError("runFidelity needs a rebuild directory");
  }
  const { blueprint, acceptance } = await loadVerifiedPackage(packagePath);
  // HTTP checks describe requests the capture really made; answering them from
  // the package's transcript is what makes those checks executable instead of
  // skipped.
  const client =
    request ??
    (await transcriptClientFromPackage(
      typeof packagePath === "string" ? packagePath : "",
    ));
  const result = await runAcceptance({
    file: acceptance,
    root: rebuild,
    request: client,
    harness,
  });
  return buildReport(blueprint, result, expectations);
}
