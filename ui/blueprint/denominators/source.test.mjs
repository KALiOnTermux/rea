import assert from "node:assert/strict";
import { test } from "vitest";
import { toAnalysis } from "../analysis.mjs";
import { sourceCeiling, sourceDenominators, sourceEntries } from "./source.mjs";

const codeBuilt = () => ({
  target: { kind: "code", input: "/tmp/app", name: "app", platform: "node" },
  surface: {
    format: "directory",
    routes: [
      { path: "/orders", kind: "http" },
      { path: "/health", kind: "http" },
    ],
  },
  behavior: {
    exit_paths: [
      { kind: "throw", value: "Error" },
      { kind: "return", value: "null" },
      { kind: "process.exit", value: "1" },
    ],
  },
  internals: {
    semantic_graph: {
      functions: [
        { name: "createOrder", module: "app/orders.js", line: 12 },
        { name: "loadOrders", module: "app/orders.js", line: 40 },
        { name: "start", module: "app/index.js", line: 3 },
      ],
    },
  },
  reconstruction: [],
  acceptance: [],
});

const codeAnalysis = (probes = []) =>
  toAnalysis(codeBuilt(), {
    kind: "code",
    target: "/tmp/app",
    probes,
    producedAt: "2026-11-20T12:00:00.000Z",
  });

test("source analysis yields exported-symbol, route and exit-path denominators", () => {
  const denominators = sourceDenominators(codeAnalysis());
  assert.deepEqual(
    denominators.map((entry) => [entry.class, entry.items]),
    [
      ["exit-path", 3],
      ["exported-symbol", 3],
      ["route", 2],
    ],
  );
  const byClass = Object.fromEntries(
    denominators.map((entry) => [entry.class, entry]),
  );
  assert.match(byClass["exported-symbol"].blind_spots.join(" "), /dynamisch/);
  assert.match(byClass.route.blind_spots.join(" "), /dynamisch/);
  assert.match(byClass["exit-path"].blind_spots.join(" "), /Ausnahme/);
});

test("a captured deterministic run resolves the ceiling to executed", () => {
  const withoutRun = sourceCeiling(codeAnalysis());
  assert.deepEqual(withoutRun, {
    requested: "executed",
    ceiling: "statically-evidenced",
    downgraded_by: ["source:no-deterministic-run"],
  });
  const withRun = sourceCeiling(
    codeAnalysis([{ id: "code.run", tags: ["deterministic-run"] }]),
  );
  assert.equal(withRun.ceiling, "executed");
});

test("every enumerated source item is a gap until a claim names it", () => {
  const analysis = codeAnalysis();
  const entries = sourceEntries(analysis, []);
  assert.equal(entries.length, 8);
  assert.ok(entries.every((entry) => entry.status === "gap"));
  assert.ok(entries.every((entry) => entry.gap.blocking === false));
  const covered = sourceEntries(analysis, [
    {
      id: "clm-source-route",
      evidence: [
        {
          path: "evidence/code-analysis.json",
          selector: { type: "pointer", pointer: "/surface/routes/0" },
        },
      ],
    },
  ]);
  const route = covered.find((entry) => entry.id === "route:GET /orders");
  assert.equal(route.status, "covered");
  assert.deepEqual(route.claims, ["clm-source-route"]);
});
