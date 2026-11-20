import assert from "node:assert/strict";
import { test } from "vitest";
import { toAnalysis } from "./analysis.mjs";
import {
  LedgerError,
  buildLedger,
  closure,
  denominator,
  ledgerFromAnalysis,
  ledgerViolations,
} from "./ledger.mjs";
import { webBuilt, webCtx } from "./test-fixtures.mjs";

const denominatorOf = (cls, items, probe = `web.${cls}-scan`) =>
  denominator({
    class: cls,
    probe,
    items,
    blind_spots: ["statisch nicht sichtbare Einträge"],
  });

const entryOf = (cls, subject, status = "covered", extra = {}) => ({
  id: `${cls}:${subject}`,
  class: cls,
  subject,
  status,
  claims: [`claim.${subject}`],
  ...extra,
});

const gapOf = (id) => ({
  id,
  why: "nicht beobachtet",
  action: "mit einem Fixture aufrufen",
  blocking: false,
});

test("a fixed denominator closes over covered and gap only", () => {
  const ledger = buildLedger({
    ceiling: "executed",
    denominators: [denominatorOf("route", 3)],
    entries: [
      entryOf("route", "/a"),
      entryOf("route", "/b"),
      {
        ...entryOf("route", "/c", "gap"),
        gap: gapOf("route:/c"),
      },
    ],
  });
  assert.deepEqual(closure(ledger), {
    covered: 2,
    gap: 1,
    out_of_scope: 0,
    ratio: 0.6667,
  });
  assert.equal(ledger.schema, "rea.blueprint.ledger");
  assert.equal(ledger.schema_version, 1);
});

test("an entry outside the denominator is refused", () => {
  assert.throws(
    () =>
      buildLedger({
        ceiling: "executed",
        denominators: [denominatorOf("route", 1)],
        entries: [entryOf("route", "/a"), entryOf("route", "/b")],
      }),
    /denominator/,
  );
});

test("a missing entry is refused as unaccounted", () => {
  assert.throws(
    () =>
      buildLedger({
        ceiling: "executed",
        denominators: [denominatorOf("route", 3)],
        entries: [entryOf("route", "/a"), entryOf("route", "/b")],
      }),
    /unaccounted/,
  );
});

test("out_of_scope stays under ten percent of the denominator", () => {
  assert.throws(
    () =>
      buildLedger({
        ceiling: "executed",
        denominators: [denominatorOf("route", 3)],
        entries: [
          entryOf("route", "/a"),
          {
            ...entryOf("route", "/b", "out_of_scope"),
            reason: "gehört zu einer anderen Anwendung",
          },
          {
            ...entryOf("route", "/c", "out_of_scope"),
            reason: "gehört zu einer anderen Anwendung",
          },
        ],
      }),
    /out_of_scope/,
  );
  const allowed = buildLedger({
    ceiling: "executed",
    denominators: [denominatorOf("route", 20)],
    entries: [
      ...Array.from({ length: 18 }, (_, index) =>
        entryOf("route", `/r${index}`),
      ),
      {
        ...entryOf("route", "/x", "out_of_scope"),
        reason: "anderer Mandant",
      },
      {
        ...entryOf("route", "/y", "out_of_scope"),
        reason: "anderer Mandant",
      },
    ],
  });
  assert.equal(closure(allowed).out_of_scope, 2);
});

test("duplicate class and subject entries merge their claims", () => {
  const ledger = buildLedger({
    ceiling: "executed",
    denominators: [denominatorOf("route", 2)],
    entries: [
      entryOf("route", "/a"),
      { ...entryOf("route", "/a"), claims: ["another.claim"] },
      entryOf("route", "/b"),
    ],
  });
  const merged = ledger.entries.find((entry) => entry.id === "route:/a");
  assert.deepEqual(merged.claims, ["another.claim", "claim./a"]);
  assert.equal(ledger.entries.length, 2);
});

test("an empty denominator is a violation and never divides by zero", () => {
  const ledger = buildLedger({
    ceiling: "executed",
    denominators: [denominatorOf("route", 0)],
    entries: [],
  });
  assert.deepEqual(closure(ledger), {
    covered: 0,
    gap: 0,
    out_of_scope: 0,
    ratio: 0,
  });
  assert.deepEqual(
    ledgerViolations(ledger).map((violation) => violation.code),
    ["ledger.denominator.empty"],
  );
});

test("entry ids must be class:subject", () => {
  assert.throws(
    () =>
      buildLedger({
        ceiling: "executed",
        denominators: [denominatorOf("route", 1)],
        entries: [{ ...entryOf("route", "/a"), id: "route-a" }],
      }),
    /class:subject/,
  );
});

test("ledgerFromAnalysis materialises exactly the stage-2 entry ids", () => {
  const analysis = toAnalysis(webBuilt(), webCtx());
  const ledger = ledgerFromAnalysis(analysis);
  const ids = new Set(ledger.entries.map((entry) => entry.id));
  for (const claim of analysis.claims) {
    if (!claim.falsifier.startsWith("gap:")) continue;
    assert.equal(ids.has(claim.falsifier.slice(4)), true, claim.falsifier);
  }
  for (const entry of analysis.ledger) {
    assert.equal(ids.has(entry.id), true, entry.id);
  }
  assert.equal(ledger.entries.length >= analysis.ledger.length, true);
  assert.equal(ledger.ceiling, analysis.ceiling.ceiling);
});
