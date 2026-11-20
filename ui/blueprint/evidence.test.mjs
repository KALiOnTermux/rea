import assert from "node:assert/strict";
import { test } from "vitest";
import { SELECTOR_TYPES, resolveEvidence, resolveSelector } from "./evidence.mjs";

const json = (value) => Buffer.from(JSON.stringify(value), "utf8");
const capture = json({
  events: {
    items: [
      { kind: "request", url: "/api/orders", method: "POST" },
      { kind: "response", url: "/api/orders", status: 201 },
      { kind: "request", url: "/api/cart", method: "GET" },
    ],
  },
});
const html = Buffer.from(
  '<button id="buy">Kaufen</button><a href="/orders">x</a>',
  "utf8",
);

test("the resolver declares its selector vocabulary", () => {
  assert.deepEqual(SELECTOR_TYPES, [
    "whole",
    "pointer",
    "lines",
    "dom",
    "request",
    "byte-range",
  ]);
});

test("whole resolves only a non-empty file", () => {
  assert.deepEqual(resolveSelector(html, { type: "whole" }), { ok: true });
  const empty = resolveSelector(Buffer.alloc(0), { type: "whole" });
  assert.equal(empty.ok, false);
});

test("request indexes the recorded requests", () => {
  assert.deepEqual(resolveSelector(capture, { type: "request", index: 1 }), {
    ok: true,
  });
  assert.equal(resolveSelector(capture, { type: "request", index: 2 }).ok, false);
  assert.match(
    resolveSelector(capture, { type: "request", index: 2 }).reason,
    /Anfrage #2/,
  );
  assert.equal(
    resolveSelector(capture, { type: "request", index: -1 }).ok,
    false,
  );
});

test("dom uses the acceptance matcher and does not match loosely", () => {
  assert.deepEqual(resolveSelector(html, { type: "dom", path: "#buy" }), {
    ok: true,
  });
  assert.deepEqual(
    resolveSelector(html, { type: "dom", path: 'a[href="/orders"]' }),
    { ok: true },
  );
  assert.equal(resolveSelector(html, { type: "dom", path: "#missing" }).ok, false);
  assert.equal(resolveSelector(html, { type: "dom", path: "#buy-now" }).ok, false);
  assert.equal(
    resolveSelector(html, { type: "dom", path: 'a[href="/orders-old"]' }).ok,
    false,
  );
});

test("pointer resolves a JSON pointer and refuses a missing index", () => {
  const doc = json({ requests: [{ id: 1 }, { id: 2 }] });
  assert.deepEqual(
    resolveSelector(doc, { type: "pointer", pointer: "/requests/1" }),
    { ok: true },
  );
  assert.equal(
    resolveSelector(doc, { type: "pointer", pointer: "/requests/3" }).ok,
    false,
  );
  assert.equal(
    resolveSelector(doc, { type: "pointer", pointer: "/requests/0/id" }).ok,
    true,
  );
});

test("lines counts CRLF lines and refuses a range past the end", () => {
  const text = Buffer.from("a\r\nb\r\nc\r\n", "utf8");
  assert.deepEqual(resolveSelector(text, { type: "lines", from: 1, to: 3 }), {
    ok: true,
  });
  assert.equal(resolveSelector(text, { type: "lines", from: 2, to: 4 }).ok, false);
  assert.equal(resolveSelector(text, { type: "lines", from: 3, to: 2 }).ok, false);
  assert.equal(resolveSelector(text, { type: "lines", from: 0, to: 1 }).ok, false);
});

test("byte-range measures raw bytes", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10]);
  assert.deepEqual(resolveSelector(png, { type: "byte-range", from: 0, to: 7 }), {
    ok: true,
  });
  assert.equal(resolveSelector(png, { type: "byte-range", from: 0, to: 8 }).ok, false);
  assert.equal(resolveSelector(png, { type: "byte-range", from: 4, to: 4 }).ok, false);
});

test("an unknown selector type is refused, never silent", () => {
  const result = resolveSelector(html, { type: "css", path: "#buy" });
  assert.equal(result.ok, false);
  assert.match(result.reason, /nicht unterstützt/);
});

test("the legacy shorthand keeps its semantics", () => {
  assert.equal(
    resolveSelector(json({ a: 1 }), { pointer: "/a" }, "e.json").ok,
    true,
  );
  assert.match(
    resolveSelector(json({ a: 1 }), { pointer: "/b" }, "e.json").reason,
    /Pointer nicht auflösbar: e\.json#\/b/,
  );
  assert.equal(
    resolveSelector(html, { contains: "Kaufen" }, "d.html").ok,
    true,
  );
  assert.match(
    resolveSelector(html, { contains: "Verkaufen" }, "d.html").reason,
    /Textmarke fehlt/,
  );
  assert.match(
    resolveSelector(html, { line: 2 }, "d.html").reason,
    /Zeile 2 liegt außerhalb/,
  );
  assert.match(
    resolveSelector(html, { offset: html.length }, "d.html").reason,
    /Offset/,
  );
});

test("resolveEvidence reads the named file and refuses a missing or empty one", () => {
  const files = new Map([
    ["surface/dom.html", html],
    ["evidence/empty.json", Buffer.alloc(0)],
  ]);
  const read = (path) => files.get(path);
  assert.equal(
    resolveEvidence(
      { path: "surface/dom.html", selector: { type: "dom", path: "#buy" } },
      read,
    ).ok,
    true,
  );
  assert.equal(
    resolveEvidence(
      { path: "surface/dom.html", selector: { type: "dom", path: "#no" } },
      read,
    ).ok,
    false,
  );
  assert.match(
    resolveEvidence({ path: "evidence/missing.json" }, read).reason,
    /Datei fehlt oder ist leer/,
  );
  assert.match(
    resolveEvidence({ path: "evidence/empty.json" }, read).reason,
    /leer/,
  );
});
