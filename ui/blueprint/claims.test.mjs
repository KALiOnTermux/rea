import assert from "node:assert/strict";
import { test } from "vitest";
import {
  CEILINGS,
  CLAIM_KINDS,
  assertUniqueClaimIds,
  claimId,
  makeClaim,
  sortClaims,
  validateClaim,
} from "./claims.mjs";

const observed = () => ({
  id: "web.route.POST./api/orders",
  statement: "POST /api/orders answers 201",
  kind: "observed",
  ceiling: "executed",
  subject: "/behavior/network/requests/3",
  evidence: [
    {
      path: "evidence/network.json",
      selector: { type: "pointer", pointer: "/requests/3" },
    },
  ],
  falsifier: "acceptance.http.orders.create",
  limits: ["authenticated session"],
});

test("makeClaim normalises a valid observed claim", () => {
  const claim = makeClaim(observed());
  assert.deepEqual(validateClaim(claim).violations, []);
  assert.deepEqual(claim.limits, ["authenticated session"]);
});

test("makeClaim sorts and deduplicates limits", () => {
  const claim = makeClaim({
    ...observed(),
    limits: ["z", "a", "z"],
  });
  assert.deepEqual(claim.limits, ["a", "z"]);
});

test("observed without evidence is refused", () => {
  assert.throws(
    () => makeClaim({ ...observed(), evidence: [] }),
    /observed.*evidence/,
  );
});

test("derived without derivation is refused", () => {
  assert.throws(
    () => makeClaim({ ...observed(), id: "web.x", kind: "derived" }),
    /derived.*derivation/,
  );
});

test("assumed requires a resolution and an inferred-only ceiling", () => {
  assert.throws(
    () =>
      makeClaim({
        ...observed(),
        kind: "assumed",
        ceiling: "executed",
        assumption: { statement: "s", impact: "i" },
      }),
    /assumed.*resolution/,
  );
  const claim = makeClaim({
    ...observed(),
    kind: "assumed",
    ceiling: "inferred-only",
    evidence: [],
    assumption: {
      statement: "Orders are persisted",
      impact: "storage layer",
      resolution: "probe:db-trace",
    },
  });
  assert.deepEqual(validateClaim(claim).violations, []);
});

test("claim ids are stable slugs and reject empty parts", () => {
  assert.equal(
    claimId("web.route", "POST /api/orders"),
    "web.route.post-/api/orders",
  );
  assert.throws(() => claimId("web.route", ""), /empty/);
});

test("sortClaims orders by id without mutating the input", () => {
  const input = [
    makeClaim({ ...observed(), id: "b" }),
    makeClaim({ ...observed(), id: "a" }),
  ];
  assert.deepEqual(
    sortClaims(input).map((c) => c.id),
    ["a", "b"],
  );
  assert.equal(input[0].id, "b");
});

test("duplicate claim ids across target kinds are refused", () => {
  const web = makeClaim({ ...observed(), id: claimId("web.route", "/orders") });
  const apk = makeClaim({ ...observed(), id: claimId("apk.route", "/orders") });
  assert.doesNotThrow(() => assertUniqueClaimIds([web, apk]));
  assert.throws(
    () => assertUniqueClaimIds([web, { ...web }]),
    /claim\.id\.duplicate.*web\.route/,
  );
});

test("the vocabulary matches the spec tables", () => {
  assert.deepEqual(CLAIM_KINDS, ["observed", "derived", "assumed"]);
  assert.deepEqual(CEILINGS, [
    "executed",
    "statically-evidenced",
    "inferred-only",
  ]);
});
