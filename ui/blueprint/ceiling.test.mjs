import assert from "node:assert/strict";
import { test } from "vitest";
import {
  CLASS_CEILINGS,
  CeilingError,
  assertCeilingAllowed,
  resolveCeiling,
} from "./ceiling.mjs";

test("apk downgrades a request for executed without an execution grant", () => {
  const resolved = resolveCeiling({
    targetClass: "apk",
    requested: "executed",
    probes: [{ id: "apk.manifest", tags: ["static-scan"] }],
  });
  assert.deepEqual(resolved, {
    requested: "executed",
    ceiling: "statically-evidenced",
    downgraded_by: ["apk:no-execution-grant"],
  });
});

test("document cannot assert executed at all", () => {
  assert.throws(
    () => assertCeilingAllowed("document", "executed"),
    /not permitted/,
  );
  assert.deepEqual(CLASS_CEILINGS.document, ["inferred-only"]);
  assert.deepEqual(
    resolveCeiling({ targetClass: "document", requested: "executed" }),
    {
      requested: "executed",
      ceiling: "inferred-only",
      downgraded_by: ["document:ceiling-not-permitted"],
    },
  );
});

test("web keeps executed when a journey probe ran", () => {
  assert.deepEqual(
    resolveCeiling({
      targetClass: "web",
      requested: "executed",
      probes: [{ id: "web.journey", tags: ["journey-executed"] }],
    }),
    { requested: "executed", ceiling: "executed", downgraded_by: [] },
  );
});

test("web downgrades executed when no journey probe ran", () => {
  const resolved = resolveCeiling({
    targetClass: "web",
    requested: "executed",
    probes: [{ id: "web.dom", tags: ["static-scan"] }],
  });
  assert.equal(resolved.ceiling, "statically-evidenced");
  assert.deepEqual(resolved.downgraded_by, ["web:no-journey-executed"]);
});

test("a request below the supported ceiling is kept, never upgraded", () => {
  assert.deepEqual(
    resolveCeiling({
      targetClass: "apk",
      requested: "inferred-only",
      probes: [{ id: "apk.trace", tags: ["execution-grant"] }],
    }),
    {
      requested: "inferred-only",
      ceiling: "inferred-only",
      downgraded_by: [],
    },
  );
});

test("the downgrade names the probe tag that would have supported the request", () => {
  const resolved = resolveCeiling({
    targetClass: "native",
    requested: "executed",
  });
  assert.equal(resolved.ceiling, "statically-evidenced");
  assert.deepEqual(resolved.downgraded_by, ["native:no-trace-grant"]);
});

test("an apk run with an execution grant keeps executed", () => {
  const resolved = resolveCeiling({
    targetClass: "apk",
    requested: "executed",
    probes: ["execution-grant"],
  });
  assert.equal(resolved.ceiling, "executed");
  assert.deepEqual(resolved.downgraded_by, []);
  assert.doesNotThrow(() =>
    assertCeilingAllowed("web", "statically-evidenced"),
  );
});

test("unknown classes and ceilings are refused", () => {
  assert.throws(
    () => resolveCeiling({ targetClass: "web", requested: "certain" }),
    CeilingError,
  );
  assert.throws(
    () => resolveCeiling({ targetClass: "firmware", requested: "executed" }),
    /unknown target class/,
  );
  assert.throws(
    () => assertCeilingAllowed("firmware", "executed"),
    /unknown target class/,
  );
  assert.throws(
    () =>
      resolveCeiling({ targetClass: "web", requested: "executed", probes: 7 }),
    /probes/,
  );
});
