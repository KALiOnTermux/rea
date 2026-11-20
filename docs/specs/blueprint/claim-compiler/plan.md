# Blueprint Claim Compiler — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `executing-plans` to work this plan task by task. Steps use checkbox (`- [ ]`) syntax. `tasks.md` beside this file is the executable task list; this document holds the contracts and the decisions tasks must not re-open.

**Goal:** Turn `ui/blueprint.mjs` from a document generator into a claim compiler whose package is reproducible, ceiling-bounded, ledger-closed and fail-closed gated, with executable acceptance checks and an external fidelity harness.

**Architecture:** Two passes. `analyze()` stays impure and produces a plain `Analysis` record (facts, evidence files with digests, ledger candidates, ceiling, probe versions). `compile(analysis)` is pure and is the only producer of claims, ledger, IR, Markdown, prompt, acceptance file and manifest. A gate inspects the compiled result and refuses `complete` unless every claim is backed, every denominator item accounted for and every criterion executable. `Bundle` from `ui/blueprint-zip.mjs` writes the ZIP unchanged.

**Tech stack:** Node.js (pinned by `.nvmrc` and `package.json#packageManager`), pure ESM `.mjs`, `node:test`-free Vitest project `ui-evidence` (`ui/**/*.test.mjs`, `isolate: false`), existing `Bundle`, existing `resolveEvidenceRef`/`auditCheckEvidence`.

**Spec:** [`docs/specs/blueprint/claim-compiler/spec.md`](spec.md)
**Decision record:** [`docs/adr/blueprint/claim-compiler-and-proof-ceilings.md`](../../../adr/blueprint/claim-compiler-and-proof-ceilings.md)

## Global Constraints

- Do not add runtime dependencies. No `ajv`, no `zod`, no schema library that is not already a dependency.
- Do not modify `src/artifacts/NodeSeaArtifactReader.ts` or any of the three carrier-identity test files (`NodeSeaArtifactReader.test.ts`, `Uf2ArtifactReader.test.ts`, `pyinstaller/PyInstallerBoundaries.test.ts`). They are unrelated uncommitted work.
- `ui/` stays outside the compiled runtime; nothing here may be imported from `src/`.
- Determinism: `compile()` performs no I/O, no `Date.now()`, no `Math.random()`, no `randomUUID()`, no `process.env` read. Only `analyze()` may.
- All rendered prose stays German like the current `BLUEPRINT.md`; identifiers, violation codes and JSON keys stay English.
- Conventional Commit subjects. No push.
- Toolchain: `export PATH="$HOME/.local/node-v24.22.1-linux-x64/bin:$PATH"` before `node`/`npm` in this workspace.
- Test command per task: `npx vitest run --project ui-evidence <files>`; stage gate: `npm run check:fast`.
- `blueprint.json` moves to `schema_version: 2`. No compatibility shim: the studio is the only consumer, and `ui/app.js` is updated in the same task that changes the shape.

## Review Focus

Conditions the spec implies but no single task's happy-path test exercises. Each
line names the task whose tests must pin it.

1. **Empty or failed capture** — a run that enumerated zero routes, zero DOM
   nodes and zero requests must not report `complete` and must not divide by
   zero. Pinned in Task 9 (`ledger.denominator.empty`).
2. **Truncated bundle** — `Bundle#addTree` silently drops files over its byte or
   file cap; a package must not look closed when a source or evidence tree was
   cut. Pinned in Task 8 (`bundle.entry.omitted`).
3. **Binary and non-UTF-8 evidence** — hashing and offset selectors must work on
   raw bytes, not decoded text. Pinned in Task 3 and Task 4.
4. **Duplicate claim ids across target kinds** — one `web` and one `apk` run in
   the same artifact directory must not collide. Pinned in Task 1
   (`claim.id.duplicate`, prefixed by kind in `claimId`).
5. **Windows-style separators in evidence paths** — ZIP names and selectors must
   normalise to `/` or a resolving reference silently breaks off-host. Pinned in
   Task 3.

## Decisions

| #   | Decision                                                                                                                  | Why                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| D1  | Claims are records, sections are rendered from them                                                                       | The observed/derived/assumed separation becomes a renderer property instead of an authoring discipline              |
| D2  | The ledger denominator is enumerated by named probes and compared by set equality                                         | A count threshold cannot distinguish "covered" from "not looked at"; set equality can                               |
| D3  | Ceilings are declared per target class and only ever downgraded, with the forcing probe named                             | Stops the package from asserting runtime behaviour a black-box class cannot support                                 |
| D4  | `compile()` is pure; `id` is a digest, `produced_at` lives in `MANIFEST.json` only                                        | Without byte stability no acceptance criterion and no blueprint diff is meaningful                                  |
| D5  | The gate throws `BlueprintGateError`; `allowIncomplete` writes the package and surfaces violations instead of hiding them | Fail-closed by default without trapping the operator when they deliberately want a partial artifact                 |
| D6  | Legacy builders are wrapped by `toAnalysis()`, not rewritten                                                              | A big-bang rewrite of `ui/blueprint.mjs` (5 639 lines) would put every existing probe at risk for no design benefit |
| D7  | `falsifier` points at an acceptance check id or a gap id                                                                  | Makes "no criterion without a test" mechanically checkable instead of a review opinion                              |

## File Structure

```
ui/blueprint/
  analysis.mjs        Analysis record, analysisDigest(), toAnalysis(built, ctx)
  claims.mjs          CLAIM_KINDS, CEILINGS, claimId(), makeClaim(), validateClaim(), sortClaims()
  ceiling.mjs         CLASS_CEILINGS, resolveCeiling(), assertCeilingAllowed()
  ledger.mjs          denominator(), buildLedger(), closure(), ledgerFromAnalysis()
  denominators/
    web.mjs           routes, domInteractive, requests, assets enumerators + blind spots
    source.mjs        exported symbols, routes, exit paths
    native.mjs        apk/native static denominators
  compile.mjs         compile(analysis) -> Compiled
  render.mjs          renderMarkdown(), renderPrompt(), renderClaimsSection()
  gate.mjs            gate(), BlueprintGateError, violation codes
  acceptance.mjs      buildAcceptance(), renderAcceptanceReport()
  manifest.mjs        buildManifest(), verifyManifest()
  schemas/
    claims.schema.json
    ledger.schema.json
    manifest.schema.json
  run-acceptance.mjs  CLI: execute an acceptance file against a rebuild directory
scripts/blueprint-fidelity.mjs   thin CLI: args -> runFidelity(), writes rebuild-report.json
ui/blueprint/fidelity.mjs        runFidelity({ packageDir, rebuildDir }) -> report
ui/blueprint/fidelity.test.mjs   report contract and CLI rejection paths
ui/blueprint/corpus/             blueprint inputs + rebuild + expected.json (no committed ZIP)
ui/blueprint/corpus.test.mjs     corpus case runner
```

All tests live under `ui/` so the `ui-evidence` Vitest project (`include: ["ui/**/*.test.mjs"]`) collects them; the corpus ships source inputs and a rebuild tree, never a built ZIP.

`ui/blueprint.mjs` keeps `buildWeb`/`buildApk`/`buildCode`, `createContext`, the evidence resolver and `buildBlueprint(config)`. It loses `renderMarkdown`/`renderAgentPrompt` bodies (moved to `render.mjs`) and the threshold checks in `evaluateCompleteness` (replaced by `gate()`).

## Contracts

```js
// analysis.mjs
/** @typedef {{ id, target, ceiling, probes, facts, evidence, ledger, limits, warnings, sources }} Analysis */
export function analysisDigest(analysis): string           // sha256 of canonical JSON, 64 hex
export function toAnalysis(built, ctx): Analysis           // adapter over today's `built` object

// claims.mjs
export const CLAIM_KINDS = ["observed", "derived", "assumed"];
export const CEILINGS = ["executed", "statically-evidenced", "inferred-only"];
export function claimId(...parts): string                  // lowercase slug, throws on empty part
export function makeClaim(input): Claim                    // validates + sorts `limits`, throws ClaimShapeError
export function validateClaim(claim): { ok: boolean, violations: Violation[] }
export function sortClaims(claims): Claim[]                // ascending by id

// ceiling.mjs
export const CLASS_CEILINGS = { web: [...], source: [...], apk: [...], native: [...], document: [...] };
export function resolveCeiling({ targetClass, requested, probes }): { ceiling, requested, downgraded_by: string[] }
export function assertCeilingAllowed(targetClass, ceiling): void  // throws CeilingError

// ledger.mjs
export function denominator({ class: cls, probe, items, blind_spots }): Denominator
export function buildLedger({ ceiling, denominators, entries }): Ledger   // throws LedgerError
export function closure(ledger): { covered, gap, out_of_scope, ratio }
export function ledgerFromAnalysis(analysis): Ledger

// compile.mjs
export function compile(analysis): Compiled  // { blueprint, claims, ledger, acceptance, manifest, markdown, prompt, outputDigest }

// gate.mjs
export function gate({ blueprint, claims, ledger, acceptance, manifest, ctx }): { ok, status, violations }
export class BlueprintGateError extends Error { violations; code = "blueprint.gate" }

// manifest.mjs
export function buildManifest({ files, digests, ceiling, compiler, produced_at }): Manifest
export function verifyManifest(manifest, readFile): { ok, violations }
```

## Irreversible choices

- `blueprint.json` field removals (`generated_at`) and additions (`claims`, `ceiling`, `ledger`) land in the same commit as the `ui/app.js` read of `coverage`/`violations`. Nothing else consumes the file.
- `completeness` keeps its name and `gaps[]` shape so `AGENT-PROMPT.md` and `ui/app.js` need no rewrite; its `status` and `gaps` are produced by `gate()` only.

## Risks

| Risk                                                        | Mitigation                                                                                            |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Determinism breaks on map iteration or path separators      | `sortClaims`, sorted denominators, `join`→`/` normalisation, and the purity test that stubs the clock |
| Ledger set equality fails on benign duplicates              | Entry ids are `class + subject`; duplicates are merged with the union of their claims                 |
| Gate makes the studio unusable for partial captures         | `allowIncomplete` path ships the package with a violation banner, never a silent downgrade            |
| Refactor of `evaluateCompleteness` changes tested semantics | `ui/blueprint-evidence.test.mjs` stays untouched and must keep passing at every stage                 |

## Stage gates

After each of the six stages in `tasks.md`: `npx vitest run --project ui-evidence` and `npm run check:fast` exit 0. Stage 6 additionally runs `npm run docs:check`.
