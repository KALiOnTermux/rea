import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { buildManifest } from "./manifest.mjs";
import { runFidelity } from "./fidelity.mjs";

const BLUEPRINT = {
  schema: "rea.blueprint",
  schema_version: 2,
  id: "bp-0123456789abcdef",
  target: { kind: "web", name: "Shop", input: "https://shop.test/" },
  ceiling: { requested: "executed", ceiling: "executed", downgraded_by: [] },
  acceptance: ["Die Startseite rendert."],
  claims: [],
  evidence: [],
};

const ACCEPTANCE = {
  schema: "rea.blueprint.acceptance",
  schema_version: 1,
  checks: [
    {
      id: "acceptance.structure.index",
      kind: "structure",
      criterion: "Die Startseite rendert.",
      fixture: "index.html",
      paths: ["index.html"],
    },
    {
      id: "acceptance.structure.orders",
      kind: "structure",
      criterion: "Die Bestellseite liegt im Rebuild.",
      fixture: "orders.html",
      paths: ["orders.html"],
    },
  ],
};

async function writePackage({ tamper = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "rea-fidelity-package-"));
  const files = {
    "blueprint.json": `${JSON.stringify(BLUEPRINT, null, 2)}\n`,
    "acceptance.json": `${JSON.stringify(ACCEPTANCE, null, 2)}\n`,
  };
  const manifest = buildManifest({
    files,
    ceiling: "executed",
    compiler: "blueprint-claim-compiler@1",
    produced_at: "2026-11-20T12:00:00.000Z",
  });
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(dir, name), body, "utf8");
  }
  await writeFile(
    join(dir, "MANIFEST.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  if (tamper) {
    await writeFile(join(dir, "blueprint.json"), "{}\n", "utf8");
  }
  return dir;
}

async function writeRebuild({ withOrders = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "rea-fidelity-rebuild-"));
  await writeFile(join(dir, "index.html"), "<html><body>Shop</body></html>\n");
  if (withOrders) {
    await writeFile(
      join(dir, "orders.html"),
      "<html><body>Orders</body></html>\n",
    );
  }
  return dir;
}

test("a package without a manifest is rejected", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rea-fidelity-empty-"));
  const rebuild = await writeRebuild();
  await assert.rejects(
    () => runFidelity({ package: dir, rebuild }),
    /manifest/,
  );
});

test("a manifest whose hash does not match is rejected", async () => {
  const dir = await writePackage({ tamper: true });
  const rebuild = await writeRebuild();
  await assert.rejects(
    () => runFidelity({ package: dir, rebuild }),
    (error) => {
      assert.equal(error.code, "manifest.hash_mismatch");
      return true;
    },
  );
});

test("a valid package yields a rebuild report with per-criterion verdicts", async () => {
  const dir = await writePackage();
  const rebuild = await writeRebuild();
  const report = await runFidelity({ package: dir, rebuild });
  assert.equal(report.schema, "rea.blueprint.rebuild-report");
  assert.equal(report.schema_version, 1);
  assert.deepEqual(report.package, {
    id: "bp-0123456789abcdef",
    ceiling: "executed",
  });
  assert.deepEqual(
    report.criteria.map((criterion) => [criterion.id, criterion.status]),
    [
      ["acceptance.structure.index", "passed"],
      ["acceptance.structure.orders", "passed"],
    ],
  );
  assert.deepEqual(report.summary, {
    passed: 2,
    failed: 0,
    skipped: 0,
    unexecutable: 0,
  });
  assert.equal(report.verdict, "pass");
});

test("a missing rebuild file fails the criterion and the verdict", async () => {
  const dir = await writePackage();
  const rebuild = await writeRebuild({ withOrders: false });
  const report = await runFidelity({
    package: dir,
    rebuild,
    expectations: {
      classification: { "acceptance.structure.orders": "rebuild-defect" },
    },
  });
  assert.equal(report.verdict, "fail");
  assert.equal(report.summary.failed, 1);
  const failed = report.criteria.find((item) => item.status === "failed");
  assert.equal(failed.classification, "rebuild-defect");
  const passed = report.criteria.find((item) => item.status === "passed");
  assert.equal(passed.classification, undefined);
});

test("a failed criterion defaults to a blueprint defect", async () => {
  const dir = await writePackage();
  const rebuild = await writeRebuild({ withOrders: false });
  const report = await runFidelity({ package: dir, rebuild });
  const failed = report.criteria.find((item) => item.status === "failed");
  assert.equal(failed.classification, "blueprint-defect");
});
