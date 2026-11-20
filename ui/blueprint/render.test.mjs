import assert from "node:assert/strict";
import { test } from "vitest";
import { makeClaim } from "./claims.mjs";
import {
  renderClaimsSection,
  renderMarkdown,
  renderPrompt,
} from "./render.mjs";

const blueprint = () => ({
  schema: "rea.blueprint",
  schema_version: 2,
  id: "bp-0123456789abcdef",
  generator: { name: "REA Studio", command: "rea" },
  target: {
    kind: "code",
    input: "./tool",
    name: "tool",
    sha256: "a".repeat(64),
    size_bytes: 128,
    platform: "native",
  },
  source_included: true,
  ceiling: {
    requested: "statically-evidenced",
    ceiling: "statically-evidenced",
    downgraded_by: [],
  },
  coverage: { status: "offen", available: ["Dateien"], open_points: 1 },
  surface: {
    format: "ELF",
    windows: [],
    routes: [],
    context_bridge_apis: [],
    exposed_api_members: [],
    preload_entrypoints: [],
    protocol_registrations: [],
    utility_processes: [],
  },
  behavior: { cli: null, endpoints: [], storage: [], ipc: [], exports: [] },
  internals: {
    statistics: {},
    application_graph: { nodes: [], edges: [], modules: [] },
    semantic_graph: {
      by_kind: [],
      nodes: [],
      relations: [],
      call_sites: [],
      functions: [],
      relations_by_kind: [],
    },
  },
  data: {},
  dependencies: [],
  reconstruction: [
    {
      step: 1,
      title: "Gerüst",
      goal: "Ein leeres Programm startet.",
      inputs: ["CLI"],
      outputs: ["Programm"],
      checks: ["--help läuft"],
    },
  ],
  acceptance: ["`--help` endet mit Exit 0."],
  open_questions: [
    {
      id: "O1",
      question: "Welche Ausgabe erzeugt der Lauf?",
      why: "Es wurde kein Lauf beobachtet.",
      how: "Das Programm mit einem Fixture ausführen.",
      evidence: [],
    },
  ],
  evidence: [
    {
      role: "netzwerk",
      path: "evidence/network.json",
      bytes: 12,
      sha256: "b".repeat(64),
    },
  ],
  warnings: [],
  limits: ["nur statisch belegt"],
  bundle: { files: 4, bytes_raw: 100, bytes_compressed: 40 },
  completeness: {
    status: "partial",
    passed: 1,
    checks: [
      {
        id: "C1",
        label: "Prüfung",
        ok: true,
        detail: "erfüllt",
        evidence: [],
        evidence_resolution: { resolved: 0, total: 0 },
      },
    ],
    gaps: [],
    score: 50,
    evidence_audit: { resolved: 0, total: 0 },
  },
});

const observedClaim = () =>
  makeClaim({
    id: "generic.evidence.evidence/network.json",
    statement: "Die Belegdatei evidence/network.json liegt im Paket.",
    kind: "observed",
    ceiling: "statically-evidenced",
    subject: "/evidence/evidence/network.json",
    evidence: [
      {
        path: "evidence/network.json",
        sha256: "b".repeat(64),
        selector: { type: "whole" },
      },
    ],
    falsifier: "gap:evidence:evidence/network.json",
  });

const derivedClaim = () =>
  makeClaim({
    id: "generic.reconstruction.1.geruest",
    statement: "Schritt 1 (Gerüst): Ein leeres Programm startet.",
    kind: "derived",
    ceiling: "statically-evidenced",
    subject: "/reconstruction/0",
    evidence: [],
    derivation: {
      rule: "reconstruction.step",
      inputs: ["generic.evidence.evidence/network.json"],
    },
    falsifier: "gap:step:1",
  });

const assumedClaim = () =>
  makeClaim({
    id: "generic.open-question.o1",
    statement: "Welche Ausgabe erzeugt der Lauf?",
    kind: "assumed",
    ceiling: "inferred-only",
    subject: "/open_questions/0",
    evidence: [],
    assumption: {
      statement: "Welche Ausgabe erzeugt der Lauf?",
      impact: "Es wurde kein Lauf beobachtet.",
      resolution: "Das Programm mit einem Fixture ausführen.",
    },
    falsifier: "gap:open-question:O1",
  });

const compiled = () => ({
  blueprint: blueprint(),
  claims: [observedClaim(), derivedClaim(), assumedClaim()],
});

/** Splits a rendered document into its level-two sections by title. */
function sections(markdown) {
  const map = new Map();
  for (const part of markdown.split("\n## ").slice(1)) {
    const [title, ...rest] = part.split("\n");
    map.set(title.trim(), rest.join("\n"));
  }
  return map;
}

const countOf = (haystack, needle) => haystack.split(needle).length - 1;

test("the three claim kinds get their own sections in order", () => {
  const markdown = renderMarkdown(compiled());
  const observedAt = markdown.indexOf("## 5. Beobachtet (observed)");
  const derivedAt = markdown.indexOf("## 6. Abgeleitet (derived)");
  const assumedAt = markdown.indexOf("## 7. Angenommen (assumed)");
  const criteriaAt = markdown.indexOf("## 8. Abnahmekriterien");
  assert.ok(observedAt > 0, "observed section missing");
  assert.ok(derivedAt > observedAt, "derived section out of order");
  assert.ok(assumedAt > derivedAt, "assumed section out of order");
  assert.ok(criteriaAt > assumedAt, "criteria section out of order");
});

test("each claim id appears once, inside its own kind's section", () => {
  const markdown = renderMarkdown(compiled());
  const map = sections(markdown);
  const observed = map.get("5. Beobachtet (observed)");
  const derived = map.get("6. Abgeleitet (derived)");
  const assumed = map.get("7. Angenommen (assumed)");

  assert.equal(countOf(observed, observedClaim().id), 1);
  assert.equal(countOf(derived, derivedClaim().id), 1);
  assert.equal(countOf(assumed, assumedClaim().id), 1);

  assert.equal(countOf(derived, observedClaim().id), 0);
  assert.equal(countOf(assumed, observedClaim().id), 0);
  assert.equal(countOf(observed, derivedClaim().id), 0);
  assert.equal(countOf(assumed, derivedClaim().id), 0);
  assert.equal(countOf(observed, assumedClaim().id), 0);
  assert.equal(countOf(derived, assumedClaim().id), 0);
});

test("the claim sections separate observations from derivations and assumptions", () => {
  const markdown = renderMarkdown(compiled());
  const map = sections(markdown);
  assert.match(
    map.get("5. Beobachtet (observed)"),
    /\*\*Beleg:\*\* `evidence\/network\.json`/,
  );
  assert.match(
    map.get("6. Abgeleitet (derived)"),
    /Regel `reconstruction\.step`/,
  );
  assert.match(map.get("7. Angenommen (assumed)"), /\*\*Auflösung:\*\*/);
  assert.match(
    map.get("7. Angenommen (assumed)"),
    /\*\*Ceiling:\*\* inferred-only/,
  );
});

test("section 10 lists the evidence path and falsifier of every claim", () => {
  const map = sections(renderMarkdown(compiled()));
  const evidence = map.get("10. Beweise im Paket");
  assert.ok(evidence, "evidence section missing");
  for (const claim of compiled().claims) {
    assert.match(
      evidence,
      new RegExp(claim.falsifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  }
  assert.match(evidence, /`evidence\/network\.json`/);
  assert.match(evidence, /kein Beleg/);
});

test("the agent prompt points at the criteria and the gaps", () => {
  const prompt = renderPrompt(compiled());
  assert.match(prompt, /tool/);
  assert.match(prompt, /Abschnitt 8/);
  assert.match(prompt, /Abschnitt 9/);
  assert.match(prompt, /BLUEPRINT\.md/);
});

test("renderClaimsSection alone renders the three groups", () => {
  const lines = renderClaimsSection(compiled().claims).join("\n");
  assert.match(lines, /^## 5\. Beobachtet \(observed\)$/m);
  assert.match(lines, /^## 6\. Abgeleitet \(derived\)$/m);
  assert.match(lines, /^## 7\. Angenommen \(assumed\)$/m);
  assert.equal(countOf(lines, derivedClaim().id), 1);
});
