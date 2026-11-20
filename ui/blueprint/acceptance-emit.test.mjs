import assert from "node:assert/strict";
import { test } from "vitest";
import { emitAcceptance } from "./acceptance-emit.mjs";
import { makeClaim } from "./claims.mjs";

const requestClaim = makeClaim({
  id: "web.request.get-/api/orders",
  statement: "GET /api/orders antwortet",
  kind: "observed",
  ceiling: "executed",
  subject: "/facts/behavior/network/requests/3",
  evidence: [
    {
      path: "evidence/web-capture.json",
      sha256: "a".repeat(64),
      selector: { type: "request", index: 3 },
    },
  ],
  falsifier: "gap:evidence:evidence/web-capture.json",
});

const domClaim = makeClaim({
  id: "web.dom.button-buy",
  statement: "Der Kaufen-Knopf ist sichtbar",
  kind: "observed",
  ceiling: "executed",
  subject: "/facts/surface/buttons/0",
  evidence: [
    {
      path: "surface/dom.html",
      sha256: "b".repeat(64),
      selector: { type: "dom", path: "#buy" },
    },
  ],
  falsifier: "gap:evidence:surface/dom.html",
});

const assumedClaim = makeClaim({
  id: "web.open-question.o1",
  statement: "Die Bestellung wird persistiert",
  kind: "assumed",
  ceiling: "inferred-only",
  subject: "/facts/open_questions/0",
  evidence: [],
  assumption: {
    statement: "Bestellungen landen in einer Datenbank",
    impact: "Der Nachbau braucht eine Persistenzschicht",
    resolution: "acceptance.process.db-write",
  },
  falsifier: "gap:open-question:O1",
});

const ghostClaim = makeClaim({
  id: "web.reconstruction.4.ghost",
  statement: "Schritt 4",
  kind: "derived",
  ceiling: "executed",
  subject: "/facts/reconstruction/3",
  evidence: [],
  derivation: {
    rule: "reconstruction.step",
    inputs: ["web.request.get-/api/orders"],
  },
  falsifier: "acceptance.http.ghost",
});

const ledger = {
  entries: [
    {
      id: "evidence:evidence/web-capture.json",
      class: "evidence",
      subject: "evidence/web-capture.json",
      status: "covered",
      claims: ["web.request.get-/api/orders"],
    },
    {
      id: "evidence:surface/dom.html",
      class: "evidence",
      subject: "surface/dom.html",
      status: "covered",
      claims: ["web.dom.button-buy"],
    },
    {
      id: "open-question:O1",
      class: "open-question",
      subject: "O1",
      status: "covered",
      claims: ["web.open-question.o1"],
    },
    {
      id: "step:4",
      class: "step",
      subject: "4",
      status: "covered",
      claims: ["web.reconstruction.4.ghost"],
    },
  ],
};

const claims = [requestClaim, domClaim, assumedClaim, ghostClaim];

test("an executed observation over a transcript emits an http check", () => {
  const result = emitAcceptance({ claims, ledger });
  const check = result.acceptance.checks.find((item) => item.kind === "http");
  assert.equal(check.request.selector.type, "request");
  assert.equal(check.request.selector.index, 3);
  assert.equal(check.fixture, "evidence/web-capture.json");
  assert.equal(check.criterion, requestClaim.statement);
  const rewritten = result.claims.find((claim) => claim.id === requestClaim.id);
  assert.equal(rewritten.falsifier, check.id);
});

test("a DOM observation emits a dom check", () => {
  const result = emitAcceptance({ claims, ledger });
  const check = result.acceptance.checks.find((item) => item.kind === "dom");
  assert.equal(check.selector.path, "#buy");
  assert.equal(check.fixture, "surface/dom.html");
  assert.equal(check.id, `acceptance.${domClaim.id}`);
});

test("an assumed claim emits no check and keeps a gap falsifier", () => {
  const result = emitAcceptance({ claims, ledger });
  assert.equal(
    result.acceptance.checks.some((check) => check.id.includes("o1")),
    false,
  );
  const assumed = result.claims.find((claim) => claim.id === assumedClaim.id);
  assert.equal(assumed.falsifier, "gap:open-question:O1");
  assert.equal(assumed.falsifier.startsWith("gap:"), true);
});

test("a falsifier naming a missing check is reported", () => {
  const result = emitAcceptance({ claims, ledger });
  assert.deepEqual(
    result.missing.map((item) => [item.claim, item.code]),
    [[ghostClaim.id, "claim.falsifier.missing"]],
  );
});

test("every emitted check is one of the six kinds and ids are unique", () => {
  const result = emitAcceptance({ claims, ledger });
  const ids = result.acceptance.checks.map((check) => check.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const check of result.acceptance.checks) {
    assert.equal(
      ["http", "dom", "function", "state", "process", "structure"].includes(
        check.kind,
      ),
      true,
      check.kind,
    );
  }
});
