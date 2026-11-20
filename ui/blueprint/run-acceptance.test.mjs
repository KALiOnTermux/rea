import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { buildAcceptance } from "./acceptance.mjs";
import { runAcceptance } from "./run-acceptance.mjs";

const INDEX = [
  "<!doctype html>",
  "<html><body>",
  '<main><h1>Shop</h1><button id="buy" type="button">Kaufen</button></main>',
  "</body></html>",
].join("");

const TRANSCRIPT = {
  events: {
    items: [
      { kind: "request", method: "GET", url: "https://shop.test/api/orders" },
      { kind: "response", status: 500 },
    ],
  },
};

async function prepareRebuild() {
  const root = await mkdtemp(join(tmpdir(), "rea-acceptance-"));
  await writeFile(join(root, "index.html"), INDEX, "utf8");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "src", "cart.mjs"),
    "export const total = () => 6;\n",
    "utf8",
  );
  await mkdir(join(root, "evidence"), { recursive: true });
  await writeFile(
    join(root, "evidence", "web-capture.json"),
    JSON.stringify(TRANSCRIPT, null, 2),
    "utf8",
  );
  return root;
}

const acceptance = buildAcceptance({
  checks: [
    {
      id: "acceptance.http.match",
      kind: "http",
      criterion: "GET /api/orders antwortet 200",
      fixture: "evidence/web-capture.json",
      request: {
        method: "GET",
        path: "/api/orders",
        selector: { type: "request", index: 0 },
      },
      expect: { status: 200 },
    },
    {
      id: "acceptance.http.mismatch",
      kind: "http",
      criterion: "GET /api/orders antwortet 200 (zweite Aufnahme)",
      fixture: "evidence/web-capture.json",
      request: {
        method: "GET",
        path: "/api/orders",
        selector: { type: "request", index: 1 },
      },
      expect: { status: 200 },
    },
    {
      id: "acceptance.function.total",
      kind: "function",
      criterion: "total() liefert 6",
      fixture: "src/cart.mjs",
      module: "src/cart.mjs",
      export: "total",
      expect: { value: 6 },
    },
    {
      id: "acceptance.dom.buy",
      kind: "dom",
      criterion: "Der Kaufen-Knopf ist vorhanden",
      fixture: "index.html",
      selector: { type: "dom", path: "#buy" },
    },
    {
      id: "acceptance.structure.cart",
      kind: "structure",
      criterion: "src/cart.mjs liegt im Rebuild",
      fixture: "src/cart.mjs",
      paths: ["src/cart.mjs"],
    },
  ],
});

const request = async ({ selector }) => {
  const event = TRANSCRIPT.events.items[selector.index];
  return { status: event.kind === "response" ? event.status : 200 };
};

test("the runner reports passed, failed, skipped and unexecutable counts", async () => {
  const root = await prepareRebuild();
  const result = await runAcceptance({ file: acceptance, root, request });
  assert.equal(result.passed, 3);
  assert.equal(result.failed, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.unexecutable, 0);
  const failed = result.verdicts.filter(
    (verdict) => verdict.status === "failed",
  );
  assert.deepEqual(
    failed.map((verdict) => verdict.id),
    ["acceptance.http.mismatch"],
  );
  const skipped = result.verdicts.find(
    (verdict) => verdict.status === "skipped",
  );
  assert.equal(skipped.id, "acceptance.function.total");
  assert.equal(skipped.reason, "requires:function");
});

test("a failing criterion never throws", async () => {
  const root = await prepareRebuild();
  const result = await runAcceptance({ file: acceptance, root, request });
  assert.equal(result.verdicts.length, 5);
  assert.equal(
    result.verdicts.every((verdict) => typeof verdict.detail === "string"),
    true,
  );
});

test("a missing rebuild file fails instead of throwing", async () => {
  const root = await prepareRebuild();
  const broken = buildAcceptance({
    checks: [
      {
        id: "acceptance.structure.missing",
        kind: "structure",
        criterion: "fehlt",
        fixture: "nicht-da.mjs",
        paths: ["nicht-da.mjs"],
      },
      {
        id: "acceptance.dom.missing",
        kind: "dom",
        criterion: "Selektor fehlt",
        fixture: "index.html",
        selector: { type: "dom", path: "#checkout" },
      },
    ],
  });
  const result = await runAcceptance({ file: broken, root, request });
  assert.equal(result.failed, 2);
  assert.equal(result.passed, 0);
});

test("a process check without a harness is skipped with its reason", async () => {
  const root = await prepareRebuild();
  const processOnly = buildAcceptance({
    checks: [
      {
        id: "acceptance.process.cli",
        kind: "process",
        criterion: "CLI endet mit 0",
        fixture: "src/cart.mjs",
        argv: ["node", "src/cart.mjs"],
        expect: { exitCode: 0 },
      },
      {
        id: "acceptance.state.order",
        kind: "state",
        criterion: "offen → bezahlt",
        fixture: "evidence/web-capture.json",
        trace: ["offen", "bezahlt"],
        allowed: [["offen", "bezahlt"]],
      },
    ],
  });
  const result = await runAcceptance({ file: processOnly, root, request });
  assert.equal(result.skipped, 2);
  assert.deepEqual(result.verdicts.map((verdict) => verdict.reason).sort(), [
    "requires:process",
    "requires:state",
  ]);
});
