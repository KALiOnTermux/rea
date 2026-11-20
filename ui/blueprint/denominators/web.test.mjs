import assert from "node:assert/strict";
import { test } from "vitest";
import { makeClaim } from "../claims.mjs";
import { webDenominators, webEntries } from "./web.mjs";

const facts = () => ({
  surface: {
    buttons: [
      { label: "Kaufen", id: "buy", type: "button" },
      { label: "Zurück", id: "back" },
      { label: "Filter" },
    ],
    inputs: [
      { tag: "input", type: "text", name: "q" },
      { tag: "input", type: "number", name: "qty" },
    ],
    forms: [{ action: "/search", method: "get" }],
    links: [
      { label: "Start", href: "/" },
      { label: "Bestellungen", href: "/orders" },
      { label: "Impressum", href: "/legal" },
    ],
    images: [{ src: "/logo.png", alt: "Logo" }, { src: "/hero.png" }],
    scripts: [{ src: "/app.js" }],
    stylesheets: [],
    headings: [{ level: 1, text: "Shop" }],
  },
  behavior: {
    network: {
      requests: [
        { method: "GET", url: "https://shop.test/", status: 200 },
        { method: "GET", url: "https://shop.test/app.js", status: 200 },
        { method: "POST", url: "https://shop.test/api/orders", status: 201 },
        { method: "GET", url: "https://shop.test/api/orders", status: 200 },
        {
          method: "DELETE",
          url: "https://shop.test/api/orders/1",
          status: 204,
        },
        { method: "GET", url: "https://shop.test/api/health", status: 200 },
      ],
    },
  },
  internals: {
    routes: [
      { method: "GET", path: "/api/orders" },
      { method: "POST", path: "/api/orders" },
      { method: "GET", path: "/api/health" },
      { method: "DELETE", path: "/api/orders/:id" },
    ],
  },
});

const analysis = (overrides = {}) => ({
  target: { kind: "web", name: "Shop" },
  facts: facts(),
  claims: [],
  ...overrides,
});

test("the web denominator counts routes, interactive nodes, requests and assets", () => {
  const denominators = webDenominators(analysis());
  assert.deepEqual(
    denominators.map((item) => [item.class, item.items]),
    [
      ["asset", 3],
      ["dom-node", 9],
      ["request", 6],
      ["route", 4],
    ],
  );
  for (const item of denominators) {
    assert.equal(item.blind_spots.length > 0, true, item.class);
    assert.equal(item.probe.startsWith("web."), true, item.probe);
  }
});

test("counts come from the analysis facts, never from a completeness report", () => {
  const withReport = analysis({
    facts: { ...facts(), completeness: { status: "complete", checks: [] } },
  });
  assert.deepEqual(
    webDenominators(withReport).map((item) => item.items),
    [3, 9, 6, 4],
  );
  const empty = analysis({
    facts: { surface: {}, behavior: {}, internals: {} },
  });
  // A class the capture cannot enumerate keeps a measurable denominator of one
  // and names the reason, so no type ever divides by zero.
  assert.deepEqual(
    webDenominators(empty).map((item) => item.items),
    [1, 1, 1, 1],
  );
  assert.equal(webDenominators(empty)[0].blind_spots.length > 0, true);
  const placeholders = webEntries(empty, []);
  assert.equal(placeholders.length, 4);
  for (const entry of placeholders) {
    assert.equal(entry.status, "gap");
    assert.equal(entry.subject, "keine Beobachtung");
    assert.equal(entry.gap.blocking, false);
    assert.equal(entry.gap.why.length > 0, true);
  }
});

test("routes come from the capture's navigation when no static route exists", () => {
  const facts = {
    surface: { url: "https://shop.test/" },
    behavior: {
      steps: [
        { after_url: "https://shop.test/" },
        { after_url: "https://shop.test/orders" },
      ],
    },
    internals: {},
  };
  const routes = webEntries(analysis({ facts }), []).filter(
    (entry) => entry.class === "route",
  );
  assert.deepEqual(routes.map((entry) => entry.subject).sort(), [
    "GET https://shop.test/",
    "GET https://shop.test/orders",
  ]);
});

test("every enumerated item becomes one ledger entry that is a gap by default", () => {
  const entries = webEntries(analysis(), []);
  assert.equal(entries.length, 22);
  const ids = new Set(entries.map((entry) => entry.id));
  assert.equal(ids.size, 22);
  for (const entry of entries) {
    assert.equal(entry.id, `${entry.class}:${entry.subject}`);
    assert.equal(entry.status, "gap");
    assert.equal(entry.gap.blocking, false);
    assert.equal(entry.claims.length, 0);
  }
});

test("a claim whose evidence pointer names an item covers exactly that item", () => {
  const entries = webEntries(analysis(), []);
  const target = entries.find((entry) => entry.class === "request");
  const claim = makeClaim({
    id: "web.request.get-/",
    statement: "GET / antwortet 200",
    kind: "observed",
    ceiling: "executed",
    subject: "/behavior/network/requests/0",
    evidence: [
      {
        path: target.source.path,
        selector: target.source.selector,
      },
    ],
    falsifier: "gap:request:GET https://shop.test/",
  });
  const entriesWithClaim = webEntries(analysis(), [claim]);
  const covered = entriesWithClaim.filter(
    (entry) => entry.status === "covered",
  );
  assert.equal(covered.length, 1);
  assert.equal(covered[0].id, target.id);
  assert.deepEqual(covered[0].claims, [claim.id]);
  assert.equal(
    entriesWithClaim.filter((entry) => entry.status === "gap").length,
    21,
  );
});
