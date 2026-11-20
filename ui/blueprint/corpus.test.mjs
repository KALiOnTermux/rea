import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { buildBlueprint } from "../blueprint.mjs";
import { runFidelity } from "./fidelity.mjs";

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
    allowIncomplete: true,
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
    (check) => check.fixture === "surface/dom.html",
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
