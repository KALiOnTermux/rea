#!/usr/bin/env node
/**
 * Reproducible build of the shipped corpus package (spec §10).
 *
 * The archive is the deliverable, so the build must not read the clock:
 * `PRODUCED_AT` is pinned and travels into `MANIFEST.json` and into every ZIP
 * timestamp, which is what makes two runs over the same tree byte-identical.
 * The build reads only `ui/blueprint*` and `node:` modules, so it runs in a
 * fresh clone without `node_modules` and without network access.
 *
 *   node scripts/blueprint-build.mjs            # writes dist/blueprint-1.0.0-corpus.zip
 *   node scripts/blueprint-build.mjs --check    # rebuilds and compares the committed archive
 *   node scripts/blueprint-build.mjs --out DIR  # writes the archive somewhere else
 */

import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildBlueprint } from "../ui/blueprint.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Pinned `produced_at`; part of the archive bytes, so it is part of its identity. */
const PRODUCED_AT = "2026-11-21T00:30:00.000Z";
const ARCHIVE_NAME = "blueprint-1.0.0-corpus.zip";
const CAPTURE = join(
  ROOT,
  "ui/blueprint/corpus/web-fixture/blueprint/capture.json",
);

function flag(name) {
  return process.argv.includes(name);
}

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value ? resolve(ROOT, value) : fallback;
}

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

const work = await mkdtemp(join(tmpdir(), "rea-blueprint-build-"));
try {
  const result = await buildBlueprint({
    kind: "web",
    target: "https://shop.test/",
    input: { web: { capture: CAPTURE } },
    artifactsDir: work,
    includeSources: false,
    reaVersion: "build",
    generatedAt: PRODUCED_AT,
    onProgress: () => {},
  });

  const built = await readFile(result.zipPath);
  const digest = sha256(built);

  if (flag("--check")) {
    const committedPath = join(ROOT, "dist", ARCHIVE_NAME);
    let committed;
    try {
      committed = await readFile(committedPath);
    } catch {
      process.stderr.write(`Fehlt: ${committedPath}\n`);
      process.exit(1);
    }
    const expected = sha256(committed);
    process.stdout.write(`Reproduziert: ${digest}\n`);
    process.stdout.write(`Eingecheckt:  ${expected}\n`);
    if (digest !== expected) {
      process.stderr.write(
        "Abweichung: der Build reproduziert das eingecheckte Archiv nicht.\n",
      );
      process.exit(1);
    }
    process.stdout.write("Identisch.\n");
  } else {
    const outDir = option("--out", join(ROOT, "dist"));
    await mkdir(outDir, { recursive: true });
    const target = join(outDir, ARCHIVE_NAME);
    await copyFile(result.zipPath, target);
    process.stdout.write(`Archiv: ${target}\n`);
    process.stdout.write(`sha256: ${digest}\n`);
  }
} finally {
  await rm(work, { recursive: true, force: true }).catch(() => {});
}
