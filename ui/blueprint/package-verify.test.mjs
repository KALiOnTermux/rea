import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { buildBlueprint } from "../blueprint.mjs";
import { verifyPackageDir } from "./package-verify.mjs";

const FIXTURE = fileURLToPath(
  new URL("./corpus/web-fixture/", import.meta.url),
);

async function buildPackage() {
  const artifactsDir = await mkdtemp(join(tmpdir(), "rea-verify-build-"));
  const result = await buildBlueprint({
    kind: "web",
    target: "https://shop.test/",
    input: { web: { capture: join(FIXTURE, "blueprint", "capture.json") } },
    artifactsDir,
    includeSources: false,
    reaVersion: "verify",
    onProgress: () => {},
  });
  return result;
}

/** Copies the built package to a place outside the repository, as a user would. */
async function unpack(result) {
  const root = await mkdtemp(join(tmpdir(), "rea-verify-unpacked-"));
  const target = join(root, "package");
  await cp(result.dir, target, { recursive: true });
  // The zip is the download, not a package part: an unpacked package has none.
  await rm(join(target, basename(result.zipPath)), { force: true }).catch(
    () => {},
  );
  return target;
}

test("a package verifies outside the repository", async () => {
  const result = await buildPackage();
  const root = await unpack(result);
  const report = await verifyPackageDir(root);
  assert.deepEqual(report.violations, []);
  assert.equal(report.ok, true);
  assert.equal(report.gate.ok, true);
  assert.equal(report.gate.violations, 0);
  assert.equal(report.references.unresolved.length, 0);
  assert.equal(report.references.resolved > 0, true);
  assert.equal(report.claims.hashed > 0, true);
  assert.equal(report.claims.mismatched, 0);
  for (const part of [
    "BLUEPRINT.md",
    "blueprint.json",
    "AGENT-PROMPT.md",
    "ledger.json",
    "acceptance.json",
    "flows/flows.json",
    "specs/ui.md",
    "specs/logic.md",
    "schemas/claims.schema.json",
    "schemas/ledger.schema.json",
    "schemas/manifest.schema.json",
    "schemas/flows.schema.json",
    "evidence/web-capture.json",
    "surface/dom.html",
    "MANIFEST.json",
  ]) {
    assert.equal(report.files.includes(part), true, part);
  }
});

test("a missing package part is a violation, not a silent gap", async () => {
  const result = await buildPackage();
  const root = await unpack(result);
  await rm(join(root, "specs", "logic.md"));
  const report = await verifyPackageDir(root);
  assert.equal(report.ok, false);
  assert.equal(
    report.violations.some((item) => item.code === "manifest.hash_mismatch"),
    true,
    JSON.stringify(report.violations),
  );
});

test("a changed evidence file breaks the claim digest", async () => {
  const result = await buildPackage();
  const root = await unpack(result);
  const path = join(root, "evidence", "web-capture.json");
  const capture = JSON.parse(await readFile(path, "utf8"));
  capture.url = "https://shop.test/anders";
  await writeFile(path, `${JSON.stringify(capture, null, 2)}\n`, "utf8");
  const report = await verifyPackageDir(root);
  assert.equal(report.ok, false);
  assert.equal(report.claims.mismatched > 0, true);
  assert.equal(
    report.violations.some(
      (item) => item.code === "claim.evidence.hash_mismatch",
    ),
    true,
  );
});

test("a dangling reference is reported by path and origin", async () => {
  const result = await buildPackage();
  const root = await unpack(result);
  const path = join(root, "specs", "ui.md");
  const text = await readFile(path, "utf8");
  await writeFile(path, `${text}\nSiehe \`specs/fehlt.md\`.\n`, "utf8");
  const report = await verifyPackageDir(root);
  assert.equal(report.ok, false);
  const dangling = report.violations.find(
    (item) => item.code === "package.reference.unresolved",
  );
  assert.equal(dangling.subject, "specs/fehlt.md");
  assert.equal(dangling.detail.includes("specs/ui.md"), true);
});

test("the package parts are deterministic across two builds", async () => {
  const first = await buildPackage();
  const second = await buildPackage();
  for (const name of ["flows/flows.json", "specs/ui.md", "specs/logic.md"]) {
    const [a, b] = await Promise.all([
      readFile(join(first.dir, name), "utf8"),
      readFile(join(second.dir, name), "utf8"),
    ]);
    assert.equal(a, b, name);
  }
});
