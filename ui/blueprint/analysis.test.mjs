import assert from "node:assert/strict";
import { test } from "vitest";
import { analysisDigest, toAnalysis } from "./analysis.mjs";
import { compile } from "./compile.mjs";
import { sortClaims } from "./claims.mjs";

const builtFixture = () => ({
  target: {
    kind: "web",
    input: "https://shop.test",
    name: "Shop",
    url: "https://shop.test",
    final_url: "https://shop.test/",
    size_bytes: null,
    sha256: null,
    platform: "web",
  },
  coverage: ["DOM und sichtbare Oberfläche"],
  surface: {
    title: "Shop",
    url: "https://shop.test",
    lang: "de",
    headings: [{ level: 1, text: "Shop" }],
    buttons: [],
    links: [],
    inputs: [],
    forms: [],
    images: [],
    scripts: [],
    stylesheets: [],
    landmarks: { main: 1 },
    dom_bytes: 10,
    screenshot: { included: false },
    accessibility_excerpt: null,
    description: null,
  },
  behavior: {
    network: {
      requests: [{ method: "POST", path: "/api/orders", status: 201 }],
    },
  },
  internals: {},
  data: {},
  dependencies: ["fetch"],
  reconstruction: [
    {
      step: 1,
      title: "Gerüst",
      goal: "Eine leere Seite rendert.",
      inputs: ["DOM"],
      outputs: ["Seite"],
      checks: ["Startseite rendert"],
    },
  ],
  acceptance: ["Startseite rendert"],
});

const ctxFixture = () => ({
  kind: "web",
  target: "https://shop.test",
  includeSources: true,
  evidence: [
    {
      role: "network",
      path: "evidence/network.json",
      bytes: 12,
      sha256: "a".repeat(64),
    },
  ],
  warnings: ["Aufnahme ohne Screenshot"],
  limits: ["nur mit authentifizierter Sitzung beobachtet"],
  openQuestions: [
    {
      id: "O1",
      question: "Wie sieht die Seite aus?",
      why: "Es liegt kein Screenshot im Paket.",
      how: "Aufnahme mit Screenshot wiederholen.",
      evidence: [],
    },
  ],
  probes: [{ id: "web.journey", tags: ["journey-executed"] }],
  producedAt: "2026-11-20T12:00:00.000Z",
  requestedCeiling: "executed",
});

/** Reverses the key order of every object, recursively. */
function reverseKeys(value) {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, item]) => [key, reverseKeys(item)]),
  );
}

test("toAnalysis keeps every fact reachable at its original path", () => {
  const analysis = toAnalysis(builtFixture(), ctxFixture());
  assert.deepEqual(analysis.facts.surface, builtFixture().surface);
  assert.equal(analysis.facts.behavior.network.requests[0].path, "/api/orders");
  assert.equal(analysis.facts.reconstruction[0].title, "Gerüst");
  assert.equal(analysis.facts.acceptance[0], "Startseite rendert");
  assert.deepEqual(analysis.facts.coverage, ["DOM und sichtbare Oberfläche"]);
  assert.equal(analysis.target.name, "Shop");
  assert.deepEqual(analysis.evidence, ctxFixture().evidence);
  assert.deepEqual(analysis.limits, ctxFixture().limits);
  assert.deepEqual(analysis.warnings, ctxFixture().warnings);
  assert.deepEqual(analysis.sources, []);
  assert.equal(analysis.produced_at, ctxFixture().producedAt);
});

test("toAnalysis records the run ceiling and the probe that supported it", () => {
  const supported = toAnalysis(builtFixture(), ctxFixture());
  assert.deepEqual(supported.ceiling, {
    requested: "executed",
    ceiling: "executed",
    downgraded_by: [],
  });
  const downgraded = toAnalysis(builtFixture(), {
    ...ctxFixture(),
    probes: [],
  });
  assert.equal(downgraded.ceiling.ceiling, "statically-evidenced");
  assert.deepEqual(downgraded.ceiling.downgraded_by, [
    "web:no-journey-executed",
  ]);
});

test("the analysis digest ignores key order and produced_at", () => {
  const first = toAnalysis(builtFixture(), ctxFixture());
  const reordered = toAnalysis(reverseKeys(builtFixture()), {
    ...ctxFixture(),
    producedAt: "2027-01-01T00:00:00.000Z",
  });
  assert.equal(analysisDigest(first), analysisDigest(reordered));
  assert.match(analysisDigest(first), /^[0-9a-f]{64}$/);
  assert.equal(first.id, `an-${analysisDigest(first).slice(0, 16)}`);
});

test("a changed fact changes the digest", () => {
  const first = toAnalysis(builtFixture(), ctxFixture());
  const changed = builtFixture();
  changed.surface.headings[0].text = "Anderer Titel";
  const second = toAnalysis(changed, ctxFixture());
  assert.notEqual(analysisDigest(second), analysisDigest(first));

  const otherEvidence = toAnalysis(builtFixture(), {
    ...ctxFixture(),
    evidence: [{ ...ctxFixture().evidence[0], sha256: "b".repeat(64) }],
  });
  assert.notEqual(analysisDigest(otherEvidence), analysisDigest(first));
});

test("claims separate what was observed, derived and assumed", () => {
  const analysis = toAnalysis(builtFixture(), ctxFixture());
  const observed = analysis.claims.find((claim) => claim.kind === "observed");
  const derived = analysis.claims.find((claim) => claim.kind === "derived");
  const assumed = analysis.claims.find((claim) => claim.kind === "assumed");

  assert.equal(observed.evidence[0].path, "evidence/network.json");
  assert.equal(observed.ceiling, "statically-evidenced");
  assert.equal(observed.falsifier, "gap:evidence:evidence/network.json");

  assert.equal(derived.derivation.rule, "reconstruction.step");
  assert.equal(derived.ceiling, "executed");

  assert.equal(assumed.ceiling, "inferred-only");
  assert.equal(
    assumed.assumption.resolution,
    "Aufnahme mit Screenshot wiederholen.",
  );
  assert.equal(assumed.evidence.length, 0);

  assert.deepEqual(
    analysis.claims.map((claim) => claim.id),
    sortClaims(analysis.claims).map((claim) => claim.id),
  );
});

test("every claim stays within the run ceiling and the ledger accounts for it", () => {
  const analysis = toAnalysis(builtFixture(), { ...ctxFixture(), probes: [] });
  assert.equal(analysis.ceiling.ceiling, "statically-evidenced");
  for (const claim of analysis.claims) {
    assert.notEqual(claim.ceiling, "executed", claim.id);
  }
  const accounted = new Set(
    analysis.ledger.flatMap((entry) => entry.claims || []),
  );
  for (const claim of analysis.claims) {
    assert.equal(accounted.has(claim.id), true, claim.id);
  }
});

const interactionFixture = () => {
  const built = builtFixture();
  built.surface.buttons = [{ id: "buy", label: "Kaufen" }];
  built.surface.links = [{ href: "/orders" }];
  built.behavior = {
    ...built.behavior,
    steps: [],
    navigation: [],
    events: { retained: 2, dropped: 0, bindings: [], by_kind: [] },
    console: [],
    page_errors: [],
    network: {
      transactions: 1,
      failed: 0,
      by_origin: [],
      by_resource_type: [],
      endpoints: [{ name: "POST https://shop.test/api/orders", count: 1 }],
      contracts: [],
      requests: built.behavior.network.requests,
    },
  };
  built.internals = {
    statistics: null,
    semantic_graph: {
      nodes: 0,
      relations: 0,
      by_kind: [],
      functions: [],
      call_sites: [],
      modules: [],
      requests: [],
      relations_by_kind: [],
    },
    application_graph: { nodes: 0, edges: 0, by_kind: [], modules: [] },
    routes: [],
  };
  return built;
};

const interactionCtx = () => ({
  ...ctxFixture(),
  evidence: [
    ...ctxFixture().evidence,
    {
      role: "surface",
      path: "surface/dom.html",
      bytes: 20,
      sha256: "b".repeat(64),
    },
  ],
});

test("toAnalysis observes each captured request and interactive DOM node", () => {
  const analysis = toAnalysis(interactionFixture(), interactionCtx());
  const request = analysis.claims.find(
    (claim) => claim.subject === "/behavior/network/requests/0",
  );
  assert.equal(request.kind, "observed");
  assert.deepEqual(request.evidence, [
    {
      path: "evidence/web-capture.json",
      selector: { type: "request", index: 0 },
    },
  ]);
  const button = analysis.claims.find(
    (claim) => claim.subject === "/surface/buttons/0",
  );
  assert.deepEqual(button.evidence, [
    { path: "surface/dom.html", selector: { type: "dom", path: "#buy" } },
  ]);
  const link = analysis.claims.find(
    (claim) => claim.subject === "/surface/links/0",
  );
  assert.deepEqual(link.evidence[0].selector, {
    type: "dom",
    path: 'a[href="/orders"]',
  });
});

test("the compiled package emits http and dom checks from those observations", () => {
  const analysis = toAnalysis(interactionFixture(), interactionCtx());
  const compiled = compile(analysis);
  const kinds = [
    ...new Set(compiled.acceptance.checks.map((c) => c.kind)),
  ].sort();
  assert.deepEqual(kinds, ["dom", "http", "structure"]);
  assert.deepEqual(
    compiled.acceptance.checks
      .filter((check) => check.kind === "http")
      .map((check) => check.request.selector.index),
    [0],
  );
});

test("an evidence-file claim never claims more than a static ceiling", () => {
  const analysis = toAnalysis(builtFixture(), ctxFixture());
  assert.equal(analysis.ceiling.ceiling, "executed");
  const file = analysis.claims.find(
    (claim) => claim.subject === "/evidence/evidence/network.json",
  );
  assert.equal(file.ceiling, "statically-evidenced");
  const request = analysis.claims.find(
    (claim) => claim.subject === "/behavior/network/requests/0",
  );
  assert.equal(request.ceiling, "executed");
});
