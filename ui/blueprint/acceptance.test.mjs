import assert from "node:assert/strict";
import { test } from "vitest";
import {
  AcceptanceError,
  CHECK_KINDS,
  buildAcceptance,
  renderAcceptanceReport,
} from "./acceptance.mjs";

const CHECK = {
  id: "acceptance.http.orders",
  kind: "http",
  criterion: "Bestellungen werden mit 200 beantwortet",
  fixture: "evidence/web-capture.json",
  request: {
    method: "GET",
    path: "/api/orders",
    selector: { type: "request", index: 2 },
  },
  expect: { status: 200 },
};

test("all six check kinds from spec §9 are accepted", () => {
  const checks = [
    CHECK,
    {
      id: "acceptance.dom.buy",
      kind: "dom",
      criterion: "Der Kaufen-Knopf ist vorhanden",
      fixture: "index.html",
      selector: { type: "dom", path: "#buy" },
    },
    {
      id: "acceptance.function.total",
      kind: "function",
      criterion: "total() summiert",
      fixture: "src/cart.mjs",
      module: "src/cart.mjs",
      export: "total",
      expect: { value: 6 },
    },
    {
      id: "acceptance.state.order",
      kind: "state",
      criterion: "offen → bezahlt ist erlaubt",
      fixture: "evidence/state.json",
      trace: ["offen", "bezahlt"],
      allowed: [["offen", "bezahlt"]],
    },
    {
      id: "acceptance.process.cli",
      kind: "process",
      criterion: "CLI endet mit 0",
      fixture: "src/cli.mjs",
      argv: ["node", "src/cli.mjs"],
      expect: { exitCode: 0 },
    },
    {
      id: "acceptance.structure.package",
      kind: "structure",
      criterion: "package.json liegt im Paket",
      fixture: "package.json",
      paths: ["package.json", "src/cart.mjs"],
    },
  ];
  const acceptance = buildAcceptance({ checks });
  assert.deepEqual(
    acceptance.checks.map((check) => check.kind),
    ["dom", "function", "http", "process", "state", "structure"],
  );
  assert.deepEqual(CHECK_KINDS, [
    "http",
    "dom",
    "function",
    "state",
    "process",
    "structure",
  ]);
  assert.equal(acceptance.schema, "rea.blueprint.acceptance");
  assert.equal(acceptance.schema_version, 1);
});

test("a duplicate check id is refused", () => {
  assert.throws(
    () => buildAcceptance({ checks: [CHECK, { ...CHECK }] }),
    (error) => {
      assert.equal(error instanceof AcceptanceError, true);
      assert.match(error.message, /duplicate/);
      return true;
    },
  );
});

test("an unknown kind is refused instead of being guessed", () => {
  assert.throws(
    () => buildAcceptance({ checks: [{ ...CHECK, kind: "screenshot" }] }),
    /kind/,
  );
  assert.throws(
    () => buildAcceptance({ checks: [{ ...CHECK, criterion: "" }] }),
    /criterion/,
  );
  assert.throws(() => buildAcceptance({ checks: "nein" }), /checks/);
});

test("the report prints one line per criterion with its status", () => {
  const report = renderAcceptanceReport([
    {
      id: "acceptance.http.orders",
      criterion: "Bestellungen",
      kind: "http",
      status: "passed",
      detail: "Status 200 wie erwartet",
    },
    {
      id: "acceptance.dom.buy",
      criterion: "Kaufen-Knopf",
      kind: "dom",
      status: "failed",
      detail: "Selektor #buy fehlt",
    },
    {
      id: "acceptance.function.total",
      criterion: "total()",
      kind: "function",
      status: "skipped",
      detail: "kein Harness",
      reason: "requires:function",
    },
    {
      id: "acceptance.process.cli",
      criterion: "CLI",
      kind: "process",
      status: "unexecutable",
      detail: "argv fehlt",
    },
  ]);
  const lines = report.split("\n").filter((line) => line.startsWith("- "));
  assert.equal(lines.length, 4);
  for (const status of ["passed", "failed", "skipped", "unexecutable"]) {
    assert.equal(report.includes(status), true, status);
  }
  assert.match(report, /passed.*acceptance\.http\.orders/);
  assert.match(report, /requires:function/);
  assert.match(report, /1 passed, 1 failed, 1 skipped, 1 unexecutable/);
});
