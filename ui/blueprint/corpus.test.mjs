import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { buildBlueprint } from "../blueprint.mjs";
import { runFidelity } from "./fidelity.mjs";
import { runAcceptance } from "./run-acceptance.mjs";
import { transcriptClient } from "./transcript-client.mjs";

const FIXTURE = fileURLToPath(
  new URL("./corpus/web-fixture/", import.meta.url),
);

async function buildCase() {
  const artifactsDir = await mkdtemp(join(tmpdir(), "rea-corpus-package-"));
  const result = await buildBlueprint({
    kind: "web",
    target: "https://shop.test/",
    input: { web: { capture: join(FIXTURE, "blueprint", "capture.json") } },
    artifactsDir,
    includeSources: false,
    reaVersion: "corpus",
    onProgress: () => {},
  });
  const rebuild = await mkdtemp(join(tmpdir(), "rea-corpus-rebuild-"));
  await cp(join(FIXTURE, "rebuild"), rebuild, { recursive: true });
  const acceptance = JSON.parse(
    await readFile(join(result.dir, "acceptance.json"), "utf8"),
  );
  const expected = JSON.parse(
    await readFile(join(FIXTURE, "expected.json"), "utf8"),
  );
  return { result, rebuild, acceptance, expected };
}

test("the corpus case reproduces its expected verdict", async () => {
  const { result, rebuild, acceptance, expected } = await buildCase();
  assert.equal(acceptance.checks.length > 0, true);
  const report = await runFidelity({
    package: result.dir,
    rebuild,
    expectations: expected,
  });
  assert.equal(report.verdict, expected.verdict);
  assert.equal(report.package.id, result.blueprintId);
  for (const criterion of report.criteria) {
    if (criterion.status !== "failed") {
      assert.equal(criterion.classification, undefined, criterion.id);
      continue;
    }
    assert.equal(
      expected.classification[criterion.id],
      criterion.classification,
      criterion.id,
    );
  }
});

test("deleting one rebuild file flips the verdict but keeps the classification", async () => {
  const { result, rebuild, acceptance, expected } = await buildCase();
  const domCheck = acceptance.checks.find(
    (check) =>
      check.fixture === "surface/dom.html" && check.kind === "structure",
  );
  assert.equal(Boolean(domCheck), true, "corpus needs a dom.html check");
  assert.equal(
    expected.classification[domCheck.id],
    "rebuild-defect",
    "the corpus must mark this criterion as a rebuild defect",
  );
  await rm(join(rebuild, "surface", "dom.html"));
  const report = await runFidelity({
    package: result.dir,
    rebuild,
    expectations: expected,
  });
  assert.equal(report.verdict, "fail");
  assert.equal(report.summary.failed >= 1, true);
  const failed = report.criteria.find((item) => item.id === domCheck.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.classification, "rebuild-defect");
});

test("the corpus package passes the gate without allowIncomplete", async () => {
  const { result } = await buildCase();
  assert.deepEqual(result.violations, []);
  assert.equal(result.blueprint.gate.ok, true);
  assert.equal(result.blueprint.closure.covered > 0, true);
  assert.equal(result.blueprint.gate.coverage, result.blueprint.closure.ratio);
  for (const denominator of result.ledger.denominators) {
    assert.equal(denominator.items > 0, true, denominator.class);
  }
});

test("an http check goes red when the transcript disagrees", async () => {
  const { rebuild, acceptance } = await buildCase();
  const capture = JSON.parse(
    await readFile(join(FIXTURE, "blueprint", "capture.json"), "utf8"),
  );
  const api = acceptance.checks.find(
    (check) => check.kind === "http" && check.requests?.length > 0,
  );
  assert.equal(Boolean(api), true, "corpus needs a request-level http check");

  const green = await runAcceptance({
    file: acceptance,
    root: rebuild,
    request: transcriptClient(capture),
  });
  assert.equal(
    green.verdicts.find((verdict) => verdict.id === api.id).status,
    "passed",
  );

  const tampered = structuredClone(capture);
  for (const item of tampered.events.items) {
    if (item.kind === "response") item.status = 500;
  }
  const red = await runAcceptance({
    file: acceptance,
    root: rebuild,
    request: transcriptClient(tampered),
  });
  const verdict = red.verdicts.find((item) => item.id === api.id);
  assert.equal(verdict.status, "failed");
  assert.equal(
    verdict.detail.includes("500") || verdict.detail.includes("2"),
    true,
  );

  const blind = await runAcceptance({
    file: acceptance,
    root: rebuild,
    request: transcriptClient({ steps: [], events: { items: [] } }),
  });
  assert.equal(
    blind.verdicts.find((item) => item.id === api.id).status,
    "failed",
  );
});

test("the storage criterion goes red when the rebuild ships no storage record", async () => {
  const { rebuild, acceptance, expected } = await buildCase();
  const storage = acceptance.checks.find(
    (check) =>
      check.kind === "structure" &&
      check.paths?.includes("surface/storage.json"),
  );
  assert.equal(Boolean(storage), true, "corpus needs the storage check");
  await rm(join(rebuild, "surface", "storage.json"));
  const report = await runFidelity({
    package: (await buildCase()).result.dir,
    rebuild,
    expectations: expected,
  });
  assert.equal(report.verdict, "fail");
  const verdict = report.criteria.find((item) => item.id === storage.id);
  assert.equal(verdict.status, "failed");
  assert.equal(verdict.detail.includes("surface/storage.json"), true);
});

test("the package ships the derived accessibility and storage records", async () => {
  const { result, acceptance } = await buildCase();
  const accessibility = await readFile(
    join(result.dir, "surface", "accessibility.txt"),
    "utf8",
  );
  assert.equal(accessibility.includes("derived"), true);
  assert.equal(
    accessibility.includes("# Kaufen") || accessibility.includes("Kaufen"),
    true,
  );
  const storage = JSON.parse(
    await readFile(join(result.dir, "surface", "storage.json"), "utf8"),
  );
  assert.equal(storage.observed, false);
  assert.equal(storage.local_storage.length, 0);
  const derived = result.blueprint.evidence
    .filter((entry) => entry.derived === true)
    .map((entry) => entry.path)
    .sort();
  assert.deepEqual(derived, [
    "surface/accessibility.txt",
    "surface/storage.json",
  ]);
  // All five declared criteria stay criteria; the storage one is a criterion with
  // its own check and a ledger gap, not a boundary that replaced it.
  assert.equal(result.blueprint.acceptance.length, 5);
  assert.deepEqual(result.blueprint.boundaries, []);
  const storageCriterion = result.blueprint.acceptance.find((criterion) =>
    criterion.includes("Local Storage"),
  );
  assert.equal(Boolean(storageCriterion), true);
  assert.equal(
    result.blueprint.criterion_gaps.some(
      (gap) => gap.criterion === storageCriterion,
    ),
    true,
  );
  const storageCheck = acceptance.checks.find(
    (check) =>
      check.kind === "structure" &&
      check.paths?.includes("surface/storage.json") &&
      check.criterion === storageCriterion,
  );
  assert.equal(Boolean(storageCheck), true);
  const kinds = new Set(acceptance.checks.map((check) => check.kind));
  assert.equal(kinds.has("http"), true);
  assert.equal(kinds.has("dom"), true);
});
