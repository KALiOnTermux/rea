import assert from "node:assert/strict";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { BlueprintGateError } from "./blueprint/gate.mjs";
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
              '<html lang="de"><head><title>Shop</title>',
              '<link rel="stylesheet" href="/app.css"></head><body>',
              '<main><h1>Shop</h1><img src="/logo.png" alt="Logo">',
              '<button id="buy" type="button">Kaufen</button>',
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
        kind: "request",
        transaction_id: "t1",
        sequence: 1,
        method: "POST",
        url: {
          url: "https://shop.test/api/orders",
          origin: "https://shop.test",
        },
        resource_type: "fetch",
      },
      {
        kind: "response",
        transaction_id: "t1",
        sequence: 2,
        status: 201,
        url: {
          url: "https://shop.test/api/orders",
          origin: "https://shop.test",
        },
        resource_type: "fetch",
      },
    ],
  },
};

/**
 * A capture whose DOM never arrived: no surface, no selectors, no interactive
 * nodes. Nothing about the visible behaviour can be checked from it, so the
 * package must stay refused instead of claiming coverage.
 */
const BLIND_CAPTURE = {
  url: "https://shop.test/",
  final_url: "https://shop.test/",
  completeness: { status: "partial" },
  steps: [{ action: "goto", status: 200, after_url: "https://shop.test/" }],
  events: { items: [] },
};

async function prepareCapture(capture) {
  const root = await mkdtemp(join(tmpdir(), "rea-bp-gate-capture-"));
  const capturePath = join(root, "capture.json");
  await writeFile(capturePath, JSON.stringify(capture, null, 2), "utf8");
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
  const capturePath = await prepareCapture(BLIND_CAPTURE);
  const artifactsDir = await mkdtemp(join(tmpdir(), "rea-bp-gate-blind-"));
  await assert.rejects(
    () =>
      buildBlueprint({
        kind: "web",
        target: "https://shop.test/",
        input: { web: { capture: capturePath } },
        artifactsDir,
        includeSources: false,
        reaVersion: "rea-test",
        onProgress: () => {},
      }),
    (error) => {
      // A capture without DOM, assets, requests or routes leaves more classes
      // empty than the out_of_scope cap allows, so the ledger refuses it before
      // the gate: both are fail-closed refusals of the same package.
      assert.equal(
        error.code === "blueprint.ledger" ||
          error instanceof BlueprintGateError,
        true,
        error.code,
      );
      return true;
    },
  );
  await assert.rejects(() => access(join(artifactsDir, "blueprint.json")));
});

test("a capture with DOM, assets, routes and requests passes the gate on its own", async () => {
  const capturePath = await prepareCapture(CAPTURE);
  const result = await build(capturePath);
  assert.equal(result.ok, true);
  assert.deepEqual(result.violations, []);
  assert.equal(result.blueprint.gate.ok, true);
  assert.equal(result.blueprint.gate.violations, 0);
  assert.equal(result.blueprint.gate.coverage, result.blueprint.coverage.ratio);
  assert.equal(result.blueprint.acceptance.length >= 4, true);

  const acceptance = JSON.parse(
    await readFile(join(result.dir, "acceptance.json"), "utf8"),
  );
  const kinds = new Set(acceptance.checks.map((check) => check.kind));
  assert.equal(kinds.has("http"), true);
  assert.equal(kinds.has("dom"), true);
  const httpChecks = acceptance.checks.filter((check) => check.kind === "http");
  for (const check of httpChecks) {
    const targets = check.requests ?? [check.request];
    assert.equal(targets.length > 0, true, check.id);
    for (const target of targets) {
      assert.equal(Boolean(target?.url || target?.selector), true, check.id);
    }
  }
  const domChecks = acceptance.checks.filter((check) => check.kind === "dom");
  for (const check of domChecks) {
    const targets = check.selectors ?? [check.selector];
    assert.equal(targets.length > 0, true, check.id);
    assert.equal(
      targets.every((target) => Boolean(target?.path ?? target)),
      true,
      check.id,
    );
  }

  const ledger = JSON.parse(
    await readFile(join(result.dir, "ledger.json"), "utf8"),
  );
  for (const denominator of ledger.denominators) {
    assert.equal(denominator.items > 0, true, denominator.class);
  }
  assert.equal(ledger.closure.out_of_scope, 0);
  assert.equal(result.blueprint.closure.covered, ledger.closure.covered);
  assert.equal(result.blueprint.closure.gap, ledger.closure.gap);
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
  const capturePath = await prepareCapture(CAPTURE);
  const result = await build(capturePath);
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
