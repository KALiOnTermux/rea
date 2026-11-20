import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { BlueprintGateError, VIOLATION_CODES } from "./blueprint/gate.mjs";
import { buildBlueprint, coverageStatus } from "./blueprint.mjs";

const CAPTURE = {
  url: "https://shop.test/",
  final_url: "https://shop.test/",
  completeness: { status: "complete" },
  steps: [
    {
      action: "goto",
      status: 200,
      after_url: "https://shop.test/",
      elapsed_ms: 12,
      artifacts: {
        dom: {
          state: "captured",
          value: {
            text: [
              '<html lang="de"><head><title>Shop</title></head><body>',
              '<main><h1>Shop</h1><button id="buy" type="button">Kaufen</button>',
              '<a href="/orders">Bestellungen</a></main>',
              "</body></html>",
            ].join(""),
          },
        },
      },
    },
  ],
  events: {
    items: [
      {
        kind: "network",
        method: "POST",
        url: "https://shop.test/api/orders",
        status: 201,
        resource_type: "fetch",
      },
    ],
  },
};

async function prepareCapture() {
  const root = await mkdtemp(join(tmpdir(), "rea-bp-gate-capture-"));
  const capturePath = join(root, "capture.json");
  await writeFile(capturePath, JSON.stringify(CAPTURE, null, 2), "utf8");
  return capturePath;
}

async function build(capturePath, extra = {}) {
  const artifactsDir = await mkdtemp(join(tmpdir(), "rea-bp-gate-out-"));
  return buildBlueprint({
    kind: "web",
    target: "https://shop.test/",
    input: { web: { capture: capturePath } },
    artifactsDir,
    includeSources: false,
    reaVersion: "rea-test",
    onProgress: () => {},
    ...extra,
  });
}

test("an incomplete package is refused without allowIncomplete", async () => {
  const capturePath = await prepareCapture();
  await assert.rejects(
    () => build(capturePath),
    (error) => {
      assert.equal(error instanceof BlueprintGateError, true);
      assert.equal(error.code, "blueprint.gate");
      assert.equal(error.violations.length > 0, true);
      assert.equal(
        error.violations.some(
          (violation) => violation.code === "ledger.denominator.empty",
        ),
        true,
      );
      for (const violation of error.violations) {
        assert.equal(
          VIOLATION_CODES.includes(violation.code),
          true,
          violation.code,
        );
      }
      return true;
    },
  );
});

test("allowIncomplete writes the package and its gate report", async () => {
  const capturePath = await prepareCapture();
  const result = await build(capturePath, { allowIncomplete: true });
  assert.equal(result.ok, true);
  assert.equal(result.violations.length > 0, true);
  const report = JSON.parse(
    await readFile(join(result.dir, "GATE-REPORT.json"), "utf8"),
  );
  assert.equal(report.ok, false);
  assert.deepEqual(report.violations, result.violations);
  assert.equal(report.coverage, result.blueprint.coverage.ratio);
  assert.notEqual(result.blueprint.coverage.status, "belegt");
  assert.equal(result.blueprint.completeness.status, "insufficient");
  assert.equal(
    result.blueprint.completeness.gaps.length,
    result.violations.length,
  );
  const paths = result.manifest.files.map((file) => file.path);
  assert.equal(paths.includes("GATE-REPORT.json"), true);
  assert.equal(paths.includes("ledger.json"), true);
});

test("coverage status is a projection of the ledger and the gate", () => {
  assert.equal(
    coverageStatus({ ok: true, coverage: 1, violations: [] }),
    "belegt",
  );
  assert.equal(
    coverageStatus({ ok: true, coverage: 0.5, violations: [] }),
    "teilweise",
  );
  assert.equal(
    coverageStatus({
      ok: false,
      coverage: 1,
      violations: [{ code: "render.not_deterministic" }],
    }),
    "offen",
  );
});

test("every claim has a ledger entry and every gap falsifier resolves", async () => {
  const capturePath = await prepareCapture();
  const result = await build(capturePath, { allowIncomplete: true });
  const ledger = JSON.parse(
    await readFile(join(result.dir, "ledger.json"), "utf8"),
  );
  const ids = new Set(ledger.entries.map((entry) => entry.id));
  for (const entry of ledger.entries) {
    assert.equal(entry.id, `${entry.class}:${entry.subject}`);
  }
  for (const claim of result.blueprint.claims) {
    if (claim.falsifier.startsWith("gap:")) {
      assert.equal(ids.has(claim.falsifier.slice(4)), true, claim.falsifier);
    }
  }
  const covered = ledger.entries.filter(
    (entry) => entry.status === "covered",
  ).length;
  assert.equal(ledger.closure.covered, covered);
  assert.equal(
    ledger.closure.ratio,
    covered === 0
      ? 0
      : Math.round(
          (covered /
            ledger.entries.filter((e) => e.status !== "out_of_scope").length) *
            10000,
        ) / 10000,
  );
});
