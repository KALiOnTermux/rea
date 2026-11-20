# Blueprint Claim Compiler — Tasks

**Plan:** [`plan.md`](plan.md) · **Spec:** [`spec.md`](spec.md)

Work top to bottom. Each task ends with a green focused test and a commit. Stage
gates (`npx vitest run --project ui-evidence`, `npm run check:fast`) run at the
end of every stage; a red stage gate is fixed before the next stage starts.

Prefix every shell session with:

```bash
export PATH="$HOME/.local/node-v24.22.1-linux-x64/bin:$PATH"
```

## Stage 1 — Contracts and the hash chain

### Task 1: Claim record

**Files:** create `ui/blueprint/claims.mjs`, `ui/blueprint/claims.test.mjs`

**Interfaces:** produces `CLAIM_KINDS`, `CEILINGS`, `claimId`, `makeClaim`, `validateClaim`, `sortClaims`, `ClaimShapeError`.

- [x] **Step 1: Write the failing test** — `ui/blueprint/claims.test.mjs`

```js
import assert from "node:assert/strict";
import { test } from "vitest";
import { claimId, makeClaim, sortClaims, validateClaim } from "./claims.mjs";

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
```

- [x] **Step 2: Run it and confirm it fails**

`npx vitest run --project ui-evidence ui/blueprint/claims.test.mjs` → FAIL, `Cannot find module './claims.mjs'`.

- [x] **Step 3: Implement `ui/blueprint/claims.mjs`** — `claimId` lowercases, replaces every run of non-`[a-z0-9./-]` with `-`, trims `-`; `makeClaim` validates shape and throws `ClaimShapeError` with the field name in the message; `validateClaim` returns violation objects `{ code, subject, detail }` with the codes from `gate.mjs` (`claim.observed.without_evidence`, `claim.derived.without_derivation`, `claim.assumed.without_resolution`, `claim.ceiling.invalid`, `claim.id.duplicate` is checked by the caller).

- [x] **Step 4: Run it green** — `npx vitest run --project ui-evidence ui/blueprint/claims.test.mjs` → 6 passed.

- [x] **Step 5: Commit** — `feat(blueprint): add typed claim records`

### Task 2: Ceiling matrix

**Files:** create `ui/blueprint/ceiling.mjs`, `ui/blueprint/ceiling.test.mjs`

**Interfaces:** produces `CLASS_CEILINGS`, `resolveCeiling`, `assertCeilingAllowed`, `CeilingError`.

- [x] **Step 1: Failing test** — under `apk` with `requested: "executed"` and no probe tagged `execution-grant`, `resolveCeiling` returns `{ ceiling: "statically-evidenced", downgraded_by: ["apk:no-execution-grant"] }`; under `document` with `requested: "executed"`, `assertCeilingAllowed` throws `/not permitted/`; under `web` with a probe tagged `journey-executed`, `requested: "executed"` stays `executed` with `downgraded_by: []`.
- [x] **Step 2: Run and confirm red.**
- [x] **Step 3: Implement** — the matrix is exactly spec §4; `downgraded_by` entries are `<class>:<reason>` in fixed order.
- [x] **Step 4: Green.**
- [x] **Step 5: Commit** — `feat(blueprint): bound assertions by a per-class proof ceiling`

### Task 3: Manifest hash chain

**Files:** create `ui/blueprint/manifest.mjs`, `ui/blueprint/manifest.test.mjs`

**Interfaces:** produces `buildManifest`, `verifyManifest`.

- [x] **Step 1: Failing test** — build a manifest over `{ "a.txt": Buffer.from("a"), "BLUEPRINT.md": Buffer.from("# x") }`; assert `files` sorted by path, `digests.blueprint` equals the sha256 of the markdown, and `produced_at` is present but excluded from `digests`. Then `verifyManifest(manifest, read)` with a reader that returns `Buffer.from("b")` for `a.txt` yields `{ ok: false }` and one violation `manifest.hash_mismatch` naming `a.txt`. A manifest with the file list reordered still verifies.
- [x] **Step 2: Run and confirm red.**
- [x] **Step 3: Implement** — sha256 over the raw bytes, hex lowercase, `files: [{ path, sha256, bytes }]`.
- [x] **Step 4: Green.**
- [x] **Step 5: Commit** — `feat(blueprint): add a tamper-evident package manifest`

### Task 4: Schemas

**Files:** create `ui/blueprint/schemas/{claims,ledger,manifest}.schema.json`, `ui/blueprint/schemas.test.mjs`

- [x] **Step 1: Failing test** — load each schema with `Ajv2020` from `ajv/dist/2020.js` (already a dependency, version pinned in `package.json`; `strict: true`, `allErrors: true`), assert `$schema` is `https://json-schema.org/draft/2020-12/schema`, that every required property in the spec table (R2/R5/R10) appears in `required`, and that a `makeClaim` output and a `buildManifest` output validate. Additional cases: a claim with `additionalProperties` is rejected; a manifest digest computed over bytes containing `0x00` and `0xff` validates; a path entry written with `\\` instead of `/` is rejected.
- [x] **Step 2: Run and confirm red.**
- [x] **Step 3: Write the three schemas** with `$id` `https://rea.local/schema/blueprint/<name>.schema.json`, `additionalProperties: false` on claim and ledger entry, and the enum values from `claims.mjs`/`ceiling.mjs` imported by the test rather than duplicated.
- [x] **Step 4: Green.**
- [x] **Step 5: Commit** — `feat(blueprint): publish claim, ledger and manifest schemas`

### Stage 1 gate

- [x] `npx vitest run --project ui-evidence` → all pass, including the untouched `ui/blueprint-evidence.test.mjs`.
- [x] `npm run check:fast` → exit 0.

## Stage 2 — Render from claims, deterministically

### Task 5: Analysis record and adapter

**Files:** create `ui/blueprint/analysis.mjs`, `ui/blueprint/analysis.test.mjs`

**Interfaces:** produces `analysisDigest`, `toAnalysis`; consumes nothing from earlier stages except constants.

- [x] **Step 1: Failing test** — `toAnalysis(built, ctx)` over a hand-built `built` object (`{ target: { name, kind, input }, surface: { headings: [..] }, behavior: { network: { requests: [..] } }, internals: {}, evidence: [{ path, sha256 }] }`) keeps all facts reachable at their original paths, sets `ceiling` from `resolveCeiling`, and produces an `analysisDigest` that is unchanged when object keys are reordered and changes when one fact changes.
- [x] **Step 2: Run and confirm red.**
- [x] **Step 3: Implement** — canonical JSON (sorted keys, no whitespace) then sha256.
- [x] **Step 4: Green.**
- [x] **Step 5: Commit** — `feat(blueprint): record the analysis as plain data`

### Task 6: Markdown from claims

**Files:** create `ui/blueprint/render.mjs`, `ui/blueprint/render.test.mjs`

**Interfaces:** produces `renderMarkdown(compiled)`, `renderPrompt(compiled)`, `renderClaimsSection(claims)`; consumes `sortClaims`.

- [x] **Step 1: Failing test** — with one claim of each kind, `renderMarkdown` contains the three headings `## 5. Beobachtet (observed)`, `## 6. Abgeleitet (derived)`, `## 7. Angenommen (assumed)`; each claim id appears exactly once; every id outside its own kind's section is absent; `## 10. Beweise im Paket` lists `evidence path` and `falsifier` per claim. A claim of kind `derived` must not appear under `## 5.`.
- [x] **Step 2: Run and confirm red.**
- [x] **Step 3: Implement** — the existing German section order from today's `renderMarkdown` is preserved (1 Auftrag, 2 Ziel, 3 Oberfläche, 4 Verhalten, 5–7 claim kinds, 8 Abnahmekriterien, 9 Offene Punkte, 10 Beweise); prose is copied from the current function, only the claim sections are new.
- [x] **Step 4: Green.**
- [x] **Step 5: Commit** — `feat(blueprint): render sections from typed claims`

### Task 7: Purity

**Files:** create `ui/blueprint/compile.mjs`, `ui/blueprint/purity.test.mjs`

**Interfaces:** produces `compile(analysis)` returning `{ blueprint, claims, ledger, acceptance, manifest, markdown, prompt, outputDigest }`.

- [x] **Step 1: Failing test** — call `compile` twice on the same `Analysis`; assert `JSON.stringify` of every field is equal and `outputDigest` matches. Then stub the impure globals and assert `compile` does not touch them:

```js
const realNow = Date.now;
const realRandom = globalThis.crypto.randomUUID;
Date.now = () => {
  throw new Error("compile must not read the clock");
};
globalThis.crypto.randomUUID = () => {
  throw new Error("compile must not be random");
};
try {
  compile(analysis);
} finally {
  Date.now = realNow;
  globalThis.crypto.randomUUID = realRandom;
}
```

- [x] **Step 2: Run and confirm red.**
- [x] **Step 3: Implement** `compile` — it assembles `blueprint` with `schema_version: 2`, `id: "bp-" + analysisDigest.slice(0, 16)`, no `generated_at`, and calls `renderMarkdown`, `buildAcceptance`, `buildLedger`, `buildManifest` in that order.
- [x] **Step 4: Green.**
- [x] **Step 5: Commit** — `feat(blueprint): compile a package purely from the analysis`

### Task 8: Wire `buildBlueprint` to the compiler

**Files:** modify `ui/blueprint.mjs` (`buildBlueprint`, delete the old `renderMarkdown`/`renderAgentPrompt` bodies), `ui/app.js` (coverage/violations read), `ui/blueprint-build.test.mjs` (new)

- [x] **Step 1: Failing test** — `buildBlueprint` over the existing web fixture writes `blueprint.json` with `schema_version: 2`, an `id` matching `/^bp-[0-9a-f]{16}$/`, no `generated_at`, and a `MANIFEST.json` whose `produced_at` is an ISO string; two runs into different `artifactsDir`s produce byte-identical `blueprint.json` and `BLUEPRINT.md`. A fixture whose `Bundle#omitted` list is non-empty yields one `bundle.entry.omitted` violation naming the omitted path.
- [x] **Step 2: Run and confirm red.**
- [x] **Step 3: Implement** — `buildBlueprint` = `createContext` → existing builder → `toAnalysis` → `compile` → `gate` (task 11) or, until task 11 lands, `compile` only; keep writing the same file names.
- [x] **Step 4: Green**, and `ui/blueprint-evidence.test.mjs` still passes.
- [x] **Step 5: Commit** — `refactor(blueprint): build the package through the pure compiler`

### Stage 2 gate

- [x] `npx vitest run --project ui-evidence` green; `npm run check:fast` exit 0.

## Stage 3 — Closure ledger and the fail-closed gate

### Task 9: Ledger core

**Files:** create `ui/blueprint/ledger.mjs`, `ui/blueprint/ledger.test.mjs`

**Interfaces:** produces `denominator`, `buildLedger`, `closure`, `ledgerFromAnalysis`, `LedgerError`.

- [x] **Step 1: Failing test** — a denominator of 3 routes with 2 covered and 1 gap yields `closure` `{ covered: 2, gap: 1, out_of_scope: 0, ratio: 0.6667 }`; a fourth entry not in the denominator throws `LedgerError /denominator/`; a missing entry throws `/unaccounted/`; 2 `out_of_scope` entries over a denominator of 3 throw `/out_of_scope/`; duplicate `class+subject` entries merge their `claims` arrays; every denominator with `items: 0` produces the violation `ledger.denominator.empty` and `closure.ratio` stays `0` (no `NaN`).
- [x] **Step 2: Run and confirm red.**
- [x] **Step 3: Implement** — ids are `${class}:${subject}`; ratio rounded to 4 decimals; `blind_spots` copied to the ledger verbatim.
- [x] **Step 4: Green.**
- [x] **Step 5: Commit** — `feat(blueprint): add the closure ledger with a fixed denominator`

### Task 10: Web denominators

**Files:** create `ui/blueprint/denominators/web.mjs`, `ui/blueprint/denominators/web.test.mjs`

**Interfaces:** produces `webDenominators(analysis)` returning `Denominator[]` for `route`, `dom-node` (interactive elements only), `request`, `asset`.

- [x] **Step 1: Failing test** — over the web fixture, `webDenominators` returns exactly the counts the fixture asserts (routes 4, interactive DOM 9, requests 6, assets 3), every `blind_spots` array is non-empty, and every denominator's `probe` starts with `web.`.
- [x] **Step 2: Run and confirm red.**
- [x] **Step 3: Implement** — counts come from the analysis facts, never from `built.completeness`.
- [x] **Step 4: Green.**
- [x] **Step 5: Commit** — `feat(blueprint): enumerate the web coverage denominator`

### Task 11: Gate

**Files:** create `ui/blueprint/gate.mjs`, `ui/blueprint/gate.test.mjs`

**Interfaces:** produces `gate`, `BlueprintGateError`, `VIOLATION_CODES`.

- [x] **Step 1: Failing test** — a table-driven case per code in spec §8: mutate one compiled package per row (drop an evidence file, drop `derivation`, drop `resolution`, set `ceiling: "executed"` on a `statically-evidenced` run, remove a `falsifier`, point a `falsifier` at a `structure` check for an `executed` claim, remove one ledger entry, mark one entry `status: "unknown"`, exceed the `out_of_scope` cap, drop one acceptance check, add an unexecutable check, break a manifest hash) and assert exactly that one code appears and `status !== "complete"`.
- [x] **Step 2: Run and confirm red.**
- [x] **Step 3: Implement** — `ok` is `violations.length === 0`; `status` is `complete` only when `ok && closure.ratio === 1`; violations sorted by `code` then `subject`.
- [x] **Step 4: Green.**
- [x] **Step 5: Commit** — `feat(blueprint): fail the export closed on any unsupported claim`

### Task 12: Coverage and completeness derive from the ledger

**Files:** modify `ui/blueprint.mjs` (`evaluateCompleteness`, `buildBlueprint`), `ui/app.js` (violation banner), `ui/blueprint-gate-integration.test.mjs` (new)

- [x] **Step 1: Failing test** — with three acceptance criteria that carry no check, `buildBlueprint` throws `BlueprintGateError` listing `acceptance.criterion.missing`, and with `allowIncomplete: true` it writes the package plus `GATE-REPORT.json` and the returned object carries `violations`; `coverage.status` equals `"belegt"` only when `closure.ratio === 1` and `violations` is empty.
- [x] **Step 2: Run and confirm red.**
- [x] **Step 3: Implement** — delete the `openQuestions.length < 4` threshold; `completeness.status`/`gaps` are projections of gate violations; `ui/app.js` shows the violation list instead of offering the download when `ok === false`.
- [x] **Step 4: Green**, `ui/blueprint-evidence.test.mjs` still green.
- [x] **Step 5: Commit** — `feat(blueprint): derive coverage from the closure ledger`

### Stage 3 gate

- [x] `npx vitest run --project ui-evidence` green; `npm run check:fast` exit 0.

## Stage 4 — Executable acceptance criteria

### Task 13: Acceptance file

**Files:** create `ui/blueprint/acceptance.mjs`, `ui/blueprint/acceptance.test.mjs`

**Interfaces:** produces `buildAcceptance({ checks })`, `renderAcceptanceReport(verdicts)`; consumes claim `falsifier` ids.

- [x] **Step 1: Failing test** — `buildAcceptance` rejects a duplicate check id, accepts all six kinds from spec §9, and `renderAcceptanceReport` prints one line per criterion with `passed`/`failed`/`skipped`/`unexecutable`.
- [x] **Step 2: Run and confirm red.**
- [x] **Step 3: Implement.**
- [x] **Step 4: Green.**
- [x] **Step 5: Commit** — `feat(blueprint): emit an executable acceptance file`

### Task 14: Checks from claims

**Files:** create `ui/blueprint/acceptance-emit.mjs`, `ui/blueprint/acceptance-emit.test.mjs`

- [x] **Step 1: Failing test** — an `observed`/`executed` claim over a network transcript emits an `http` check whose `request.selector.index` equals the claim's `request` selector; a DOM claim emits `dom`; an `assumed` claim emits no check and must carry `falsifier: "gap:<entry>"`; a claim whose falsifier names a missing check yields `claim.falsifier.missing`.
- [x] **Step 2: Red → Step 3: Implement → Step 4: Green.**
- [x] **Step 5: Commit** — `feat(blueprint): derive acceptance checks from claims`

### Task 15: Acceptance runner

**Files:** create `ui/blueprint/run-acceptance.mjs`, `ui/blueprint/run-acceptance.test.mjs`

- [x] **Step 1: Failing test** — over a fixture rebuild directory containing `index.html` and a recorded transcript, `runAcceptance({ file, root })` returns `{ passed: 2, failed: 1, skipped: 1, unexecutable: 0 }` for a file with one matching, one mismatching, one skipped-`function` and one `dom` check, and never throws for a failing criterion.
- [x] **Step 2: Red → Step 3: Implement** (`http` compares status + JSON body shape; `dom` compares selector presence; `structure` compares file existence; `function`/`process` return `skipped` with `reason: "requires:<kind>"` outside the harness) **→ Step 4: Green.**
- [x] **Step 5: Commit** — `feat(blueprint): execute acceptance checks against a rebuild`

### Task 16: Sections 8 and 10

**Files:** modify `ui/blueprint/render.mjs`, `ui/blueprint/render.test.mjs`

- [x] **Step 1: Failing test** — `## 8. Abnahmekriterien` renders a table with `Kriterium | Prüfung | Art | Fixture` and one row per acceptance check; a criterion without a check renders its row with `fehlt` and the package cannot be `complete`; `## 10. Beweise im Paket` lists per claim `kind`, `ceiling`, evidence path, falsifier.
- [x] **Step 2: Red → Step 3: Implement → Step 4: Green.**
- [x] **Step 5: Commit** — `feat(blueprint): render acceptance and evidence tables`

### Stage 4 gate

- [x] `npx vitest run --project ui-evidence` green; `npm run check:fast` exit 0.

## Stage 5 — Fidelity harness

### Task 17: Harness CLI

**Files:** create `scripts/blueprint-fidelity.mjs` (argument parsing and output only), `ui/blueprint/fidelity.mjs` (`runFidelity`), `ui/blueprint/fidelity.test.mjs`, modify `package.json` (`"blueprint:fidelity"`). Tests live under `ui/` because the `ui-evidence` project only collects `ui/**/*.test.mjs`.

- [x] **Step 1: Failing test** — `runFidelity` rejects a package directory without `MANIFEST.json` (`/manifest/`), rejects a manifest whose hash does not match (`manifest.hash_mismatch`), and for a valid package returns a report with `{ schema: "rea.blueprint.rebuild-report", schema_version: 1, package: { id, ceiling }, criteria: [...], summary: { passed, failed, skipped, unexecutable }, verdict: "pass" | "fail" }`.
- [x] **Step 2: Red → Step 3: Implement** — it never builds the rebuild; `--out` defaults to `<rebuild>/rebuild-report.json`. **→ Step 4: Green.**
- [x] **Step 5: Commit** — `feat(blueprint): add the fidelity harness`

### Task 18: Corpus

**Files:** create `ui/blueprint/corpus/web-fixture/{blueprint/, rebuild/, expected.json}`, `ui/blueprint/corpus.test.mjs`

- [x] **Step 1: Failing test** — the case produces its package at test time by calling `buildBlueprint` over `blueprint/` inputs into a temporary `artifactsDir` (no ZIP is committed), then runs `runFidelity` against `rebuild/`; the report's verdict equals `expected.json#verdict`, each failing criterion carries `classification: "blueprint-defect" | "rebuild-defect"` from `expected.json`, and deleting one file from `rebuild/` flips the verdict to `fail` while the classification stays `rebuild-defect`.
- [x] **Step 2: Red → Step 3: Implement → Step 4: Green.**
- [x] **Step 5: Commit** — `test(blueprint): pin one fidelity corpus case`

### Stage 5 gate

- [x] `npx vitest run --project ui-evidence ui/blueprint/corpus.test.mjs` green; `npm run check:fast` exit 0.

## Stage 6 — Other target classes

### Task 19: Source class

**Files:** create `ui/blueprint/denominators/source.mjs`, `ui/blueprint/denominators/source.test.mjs`

- [x] **Step 1: Failing test** — a source analysis yields denominators `exported-symbol`, `route`, `exit-path` with exact counts from the fixture and a blind spot naming dynamic imports; with a captured deterministic run the ceiling resolves to `executed`, without it `statically-evidenced`.
- [x] **Step 2: Red → Step 3: Implement → Step 4: Green.**
- [x] **Step 5: Commit** — `feat(blueprint): enumerate the source coverage denominator`

### Task 20: Static-only classes

**Files:** create `ui/blueprint/denominators/native.mjs`, `ui/blueprint/denominators/native.test.mjs`, modify `ui/blueprint.mjs` (`buildApk`/`buildCode` ceiling wiring)

- [x] **Step 1: Failing test** — an APK analysis yields `screen`, `exported-symbol`, `asset` denominators, `ceiling: "statically-evidenced"`, and `resolveCeiling({ targetClass: "apk", requested: "executed" })` downgrades with `apk:no-execution-grant`; a native binary without a trace probe yields `inferred-only` and every behavioural claim must be `assumed` or `derived`, never `observed`.
- [x] **Step 2: Red → Step 3: Implement → Step 4: Green.**
- [x] **Step 5: Commit** — `feat(blueprint): bound apk and native packages to static ceilings`

### Task 21: Documentation and final gate

**Files:** modify `docs/specs/blueprint/claim-compiler/spec.md` (status → `implemented`), `docs/development/reconstruction-readiness.md` (link the package contract), `docs/adr/blueprint/claim-compiler-and-proof-ceilings.md` (Status → `accepted`)

- [x] **Step 1:** Update the three documents; no new guide, no new navigation entry.
- [x] **Step 2:** `npm run docs:check` → exit 0.
- [x] **Step 3:** `npm run check:fast` → exit 0.
- [x] **Step 4: Commit** — `docs(blueprint): record the claim compiler contract`

### Stage 6 gate (feature acceptance)

- [x] `npx vitest run --project ui-evidence` green.
- [x] `npm run check:fast` exit 0.
- [x] `npm run docs:check` exit 0.
- [x] `git diff --stat main -- src/artifacts/NodeSeaArtifactReader.ts` is empty.
