import assert from "node:assert/strict";
import { test } from "vitest";
import { makeClaim } from "./claims.mjs";
import { BlueprintGateError, VIOLATION_CODES, gate } from "./gate.mjs";
import { buildManifest } from "./manifest.mjs";

const CAPTURE = JSON.stringify({
  events: {
    items: [{ kind: "request", method: "GET", url: "/api/orders" }],
  },
});
const DOCS = {
  "BLUEPRINT.md": "# x",
  "blueprint.json": "{}",
  // The reader must return real bytes: the gate now resolves each claim's
  // selector, and a claim whose evidence holds no bytes proves nothing.
  "evidence/web-capture.json": CAPTURE,
};

const observedClaim = () =>
  makeClaim({
    id: "web.request.get-/api/orders",
    statement: "GET /api/orders antwortet 200",
    kind: "observed",
    ceiling: "executed",
    subject: "/facts/behavior/network/requests/0",
    evidence: [
      {
        path: "evidence/web-capture.json",
        sha256: "a".repeat(64),
        selector: { type: "request", index: 0 },
      },
    ],
    falsifier: "acceptance.http.orders.list",
  });

const derivedClaim = () =>
  makeClaim({
    id: "web.reconstruction.1.geruest",
    statement: "Schritt 1 (Gerüst): Die Seite rendert.",
    kind: "derived",
    ceiling: "executed",
    subject: "/facts/reconstruction/0",
    evidence: [],
    derivation: {
      rule: "reconstruction.step",
      inputs: ["web.request.get-/api/orders"],
    },
    falsifier: "gap:step:1",
  });

function base() {
  const claims = [observedClaim(), derivedClaim()];
  const ledger = {
    schema: "rea.blueprint.ledger",
    schema_version: 1,
    ceiling: "executed",
    denominators: [
      {
        class: "request",
        probe: "web.request-scan",
        items: 1,
        blind_spots: ["nur während der Aufnahme"],
      },
      {
        class: "step",
        probe: "web.step-scan",
        items: 1,
        blind_spots: ["aus der Erhebung abgeleitet"],
      },
    ],
    entries: [
      {
        id: "request:GET /api/orders",
        class: "request",
        subject: "GET /api/orders",
        status: "covered",
        claims: ["web.request.get-/api/orders"],
      },
      {
        id: "step:1",
        class: "step",
        subject: "1",
        status: "covered",
        claims: ["web.reconstruction.1.geruest"],
      },
    ],
    closure: { covered: 2, gap: 0, out_of_scope: 0, ratio: 1 },
  };
  const acceptance = {
    schema: "rea.blueprint.acceptance",
    schema_version: 1,
    checks: [
      {
        id: "acceptance.http.orders.list",
        kind: "http",
        criterion: "Kriterium A",
        fixture: "evidence/web-capture.json",
      },
    ],
  };
  const blueprint = {
    schema: "rea.blueprint",
    schema_version: 2,
    id: "bp-0123456789abcdef",
    target: { kind: "web", name: "Shop", input: "https://shop.test" },
    ceiling: {
      requested: "executed",
      ceiling: "executed",
      downgraded_by: [],
    },
    acceptance: ["Kriterium A"],
    claims,
    evidence: [
      {
        role: "network",
        path: "evidence/web-capture.json",
        bytes: 12,
        sha256: "a".repeat(64),
      },
    ],
  };
  const manifest = buildManifest({
    files: DOCS,
    ceiling: "executed",
    compiler: "blueprint-claim-compiler@1",
    produced_at: "2026-11-20T12:00:00.000Z",
  });
  return {
    blueprint,
    claims,
    ledger,
    acceptance,
    manifest,
    ctx: {
      targetClass: "web",
      files: ["BLUEPRINT.md", "blueprint.json", "evidence/web-capture.json"],
      omitted: [],
      markdown: "# x",
      renderMarkdown: () => "# x",
      readFile: (path) => DOCS[path],
    },
  };
}

const run = (pkg) =>
  gate(pkg.blueprint, pkg.ledger, pkg.acceptance, {
    ...pkg.ctx,
    manifest: pkg.manifest,
  });

/** Adds a claim and books it on the given ledger entry, so only its defect shows. */
function addClaim(pkg, claim, entryId = pkg.ledger.entries[0].id) {
  pkg.claims.push(claim);
  pkg.blueprint.claims.push(claim);
  const entry = pkg.ledger.entries.find((item) => item.id === entryId);
  entry.claims.push(claim.id);
  return pkg;
}

const rawClaim = (overrides) => ({
  ...observedClaim(),
  ...overrides,
});

const ROWS = [
  {
    code: "claim.evidence.unresolved",
    mutate: (pkg) =>
      addClaim(
        pkg,
        rawClaim({
          id: "web.request.ghost",
          evidence: [
            {
              path: "evidence/missing.json",
              selector: { type: "request", index: 9 },
            },
          ],
          falsifier: "acceptance.http.orders.list",
        }),
      ),
  },
  {
    code: "claim.observed.without_evidence",
    mutate: (pkg) =>
      addClaim(pkg, rawClaim({ id: "web.request.bare", evidence: [] })),
  },
  {
    code: "claim.derived.without_derivation",
    mutate: (pkg) =>
      addClaim(
        pkg,
        rawClaim({
          id: "web.reconstruction.2.ohne",
          kind: "derived",
          evidence: [],
        }),
      ),
  },
  {
    code: "claim.derived.forward_reference",
    mutate: (pkg) =>
      addClaim(
        pkg,
        rawClaim({
          id: "web.reconstruction.3.spaeter",
          kind: "derived",
          evidence: [],
          derivation: {
            rule: "reconstruction.step",
            inputs: ["web.request.zzz"],
          },
          falsifier: "gap:step:1",
        }),
      ),
  },
  {
    code: "claim.assumed.without_resolution",
    mutate: (pkg) =>
      addClaim(
        pkg,
        rawClaim({
          id: "web.open-question.o9",
          kind: "assumed",
          ceiling: "inferred-only",
          evidence: [],
          assumption: { statement: "Persistenz", impact: "Speicher" },
          falsifier: "gap:step:1",
        }),
      ),
  },
  {
    code: "claim.ceiling.exceeds_run",
    mutate: (pkg) => {
      pkg.blueprint.ceiling.ceiling = "statically-evidenced";
      return pkg;
    },
  },
  {
    code: "claim.falsifier.missing",
    mutate: (pkg) => {
      pkg.claims[0].falsifier = "acceptance.http.ghost";
      pkg.blueprint.claims[0].falsifier = "acceptance.http.ghost";
      return pkg;
    },
  },
  {
    code: "claim.falsifier.not_executable",
    mutate: (pkg) => {
      pkg.claims[0].falsifier = "gap:step:1";
      pkg.blueprint.claims[0].falsifier = "gap:step:1";
      return pkg;
    },
  },
  {
    code: "ledger.denominator.mismatch",
    mutate: (pkg) => {
      pkg.ledger.denominators[0].items = 2;
      return pkg;
    },
  },
  {
    code: "ledger.denominator.empty",
    mutate: (pkg) => {
      pkg.ledger.denominators[0].items = 0;
      pkg.ledger.entries = pkg.ledger.entries.filter(
        (entry) => entry.class !== "request",
      );
      return pkg;
    },
  },
  {
    code: "ledger.item.unknown",
    mutate: (pkg) => {
      pkg.ledger.entries[0].claims = ["ghost.claim"];
      return pkg;
    },
  },
  {
    code: "ledger.out_of_scope.exceeded",
    mutate: (pkg) => {
      const denominator = pkg.ledger.denominators[0];
      denominator.items = 20;
      const covered = Array.from({ length: 17 }, (_, index) => ({
        id: `request:GET /r${index}`,
        class: "request",
        subject: `GET /r${index}`,
        status: "covered",
        claims: [],
      }));
      const outside = Array.from({ length: 3 }, (_, index) => ({
        id: `request:GET /x${index}`,
        class: "request",
        subject: `GET /x${index}`,
        status: "out_of_scope",
        claims: [],
        reason: "anderer Mandant",
      }));
      pkg.ledger.entries = [
        ...pkg.ledger.entries.filter((entry) => entry.class !== "request"),
        ...covered,
        ...outside,
      ];
      return pkg;
    },
  },
  {
    code: "bundle.entry.omitted",
    mutate: (pkg) => {
      pkg.ctx.omitted = ["source/web/app.js"];
      return pkg;
    },
  },
  {
    code: "acceptance.criterion.missing",
    mutate: (pkg) => {
      pkg.blueprint.acceptance = ["Kriterium A", "Kriterium B"];
      return pkg;
    },
  },
  {
    code: "acceptance.criterion.unexecutable",
    mutate: (pkg) => {
      pkg.blueprint.acceptance = ["Kriterium A", "Kriterium C"];
      pkg.acceptance.checks.push({
        id: "acceptance.function.orders",
        kind: "function",
        criterion: "Kriterium C",
        fixture: "src/orders.mjs",
      });
      return pkg;
    },
  },
  {
    code: "render.not_deterministic",
    mutate: (pkg) => {
      pkg.ctx.renderMarkdown = () => "# anders";
      return pkg;
    },
  },
  {
    code: "manifest.hash_mismatch",
    mutate: (pkg) => {
      pkg.ctx.readFile = (path) =>
        path === "BLUEPRINT.md" ? Buffer.from("# manipuliert") : DOCS[path];
      return pkg;
    },
  },
];

test("a closed package passes the gate", () => {
  const result = run(base());
  assert.deepEqual(result.violations, []);
  assert.equal(result.ok, true);
  assert.equal(result.status, "complete");
});

test("every violation code is declared", () => {
  assert.equal(VIOLATION_CODES.length, 18);
  for (const row of ROWS) {
    assert.equal(VIOLATION_CODES.includes(row.code), true, row.code);
  }
  assert.equal(
    VIOLATION_CODES.includes("claim.evidence.selector_unresolved"),
    true,
  );
});

for (const row of ROWS) {
  test(`the gate reports ${row.code}`, () => {
    const pkg = row.mutate(base());
    const result = run(pkg);
    assert.equal(result.ok, false);
    assert.notEqual(result.status, "complete");
    assert.deepEqual(
      [...new Set(result.violations.map((violation) => violation.code))],
      [row.code],
    );
    for (const violation of result.violations) {
      assert.equal(typeof violation.subject, "string");
      assert.equal(typeof violation.detail, "string");
    }
  });
}

test("a ledger entry whose source is not packaged is unknown", () => {
  const pkg = base();
  pkg.ledger.entries[0].source = {
    path: "source/missing.mjs",
    selector: { type: "line", line: 3 },
  };
  const result = run(pkg);
  assert.deepEqual(
    [...new Set(result.violations.map((violation) => violation.code))],
    ["ledger.item.unknown"],
  );
});

const DOM = '<button id="buy">Kaufen</button>';

/** Adds a claim whose only evidence is `surface/dom.html` and resolves it. */
function withDomClaim(pkg, selector) {
  pkg.ctx.files.push("surface/dom.html");
  pkg.ctx.readFile = (path) => (path === "surface/dom.html" ? DOM : DOCS[path]);
  return addClaim(
    pkg,
    rawClaim({
      id: "web.dom.buy",
      subject: "/facts/behavior/dom/0",
      evidence: [{ path: "surface/dom.html", selector }],
    }),
  );
}

test("a claim whose DOM selector resolves nowhere is refused", () => {
  const pkg = withDomClaim(base(), { type: "dom", path: "#missing" });
  const result = run(pkg);
  assert.notEqual(result.status, "complete");
  assert.deepEqual(
    [...new Set(result.violations.map((violation) => violation.code))],
    ["claim.evidence.selector_unresolved"],
  );
  assert.equal(result.violations[0].subject, "web.dom.buy");
});

test("the same claim passes when the DOM node is present", () => {
  const pkg = withDomClaim(base(), { type: "dom", path: "#buy" });
  assert.deepEqual(run(pkg).violations, []);
});

test("a stale closure block cannot claim completeness", () => {
  const pkg = base();
  pkg.ledger.entries[1].status = "gap";
  pkg.ledger.entries[1].gap = {
    id: "step:1",
    why: "nicht belegt",
    action: "Beleg ergänzen",
    blocking: false,
  };
  const result = run(pkg);
  assert.equal(result.ok, true);
  assert.equal(result.coverage, 0.5);
  assert.equal(result.status, "partial");
});

test("an incomplete package without allowIncomplete throws a gate error", () => {
  const pkg = base();
  pkg.blueprint.acceptance = ["Kriterium A", "Kriterium B"];
  assert.throws(
    () => {
      const result = run(pkg);
      if (!result.ok) throw new BlueprintGateError(result);
    },
    (error) => {
      assert.equal(error.code, "blueprint.gate");
      assert.equal(
        error.violations.some(
          (violation) => violation.code === "acceptance.criterion.missing",
        ),
        true,
      );
      return true;
    },
  );
});
