# Blueprint Claim Compiler

**Status:** implemented
**Owner:** blueprint generation (`ui/blueprint.mjs`)
**Related:** [`docs/development/reconstruction-readiness.md`](../../../development/reconstruction-readiness.md),
`docs/adr/blueprint/claim-compiler-and-proof-ceilings.md`

## 1. Problem

`ui/blueprint.mjs` already turns a capture into `BLUEPRINT.md`, `blueprint.json`,
`AGENT-PROMPT.md`, `evidence/`, `source/` and `surface/`, and
`evaluateCompleteness` gates the export. Two gaps make the package unfit as a
[Single Source of Truth](../../../README.md) for a question-free rebuild:

1. **The gate measures shape, not substance.** Checks such as
   `contains: "## 7. Rekonstruktionsplan"`, `reconstruction.length >= 3` and
   `acceptance.length >= 3` pass for three unusable acceptance criteria. A
   section that exists without support is indistinguishable from one that is
   backed by evidence.
2. **Completeness has no denominator.** `coverage.status` currently derives from
   the count of open questions (`0 → belegt`, `< 4 → teilweise`). Nothing states
   which routes, screens, exported symbols or requests the run _should_ have
   covered, so an unobserved feature is silently absent instead of recorded as a
   gap.

A third property is missing for any acceptance test to be meaningful: the
generator is not deterministic. `bp.id` embeds `new Date()` and a random UUID,
and `generated_at` is part of the IR, so two runs over the same input produce
different bytes.

## 2. Goal

The package becomes a compiled artifact: every statement is a typed **claim**
carrying an evidence reference and a falsifier; a **closure ledger** with a
fixed, declared denominator states exactly what was and was not covered; a
**ceiling** per target class limits what the package may assert; a **fail-closed
gate** refuses `complete` on any unresolved claim, unknown ledger item or
unexecutable acceptance criterion; and rendering is a pure function so the
package is reproducible byte for byte.

## 3. Non-goals

- No new analysis provider, and no new target-execution, injection or mutation
  authority. The compiler only reorganises what probes already observe.
- No move of blueprint generation into `src/`. The compiler stays in `ui/` and
  is not part of the compiled CLI/MCP runtime.
- No LLM-authored claims. Claims are extracted from probe output by rules; the
  module that would generate prose is out of scope.
- No change to `NodeSeaArtifactReader` or to the carrier-identity tests. Those
  are unrelated work in progress and stay untouched.
- No automatic rebuild. The fidelity harness (stage 5) executes a rebuild that
  the user supplies; it does not generate one.

## 4. The ceiling rule (SSOT)

A run declares exactly one proof ceiling before analysis. Every claim inherits
`ceiling ≤ run.ceiling`; anything the evidence cannot support is not asserted
but recorded as a gap.

| Target class                       | Permitted ceilings                      | Meaning of `executed`                                             |
| ---------------------------------- | --------------------------------------- | ----------------------------------------------------------------- |
| `web` (captured session)           | `executed`, `statically-evidenced`      | Journeys were driven, transcripts and DOM recorded under a run id |
| `source` (script, source tree)     | `executed`, `statically-evidenced`      | Deterministic run with hermetic fixtures; exit/stdout captured    |
| `apk`                              | `statically-evidenced`, `inferred-only` | Only under an explicit instrumentation grant (not default)        |
| `native` (ELF, Mach-O, PE)         | `statically-evidenced`, `inferred-only` | Only under an explicit debugger/trace grant                       |
| `document` (screenshot, spec only) | `inferred-only`                         | Not permitted                                                     |

`ceiling_run = min(ceiling requested by the operator, ceiling supported by the
probes that actually produced evidence)`. A downgrade is recorded in
`MANIFEST.json` and in `BLUEPRINT.md` section 1 with the probe that forced it.
A claim whose ceiling exceeds `ceiling_run` is a gate violation; it is never
silently clamped, because clamping would hide that the assertion was not
earned.

`statically-evidenced` means: the statement is derived from bytes, code or
recorded observations and can be re-derived from the package. It never implies
runtime behaviour.

## 5. Claim record

```jsonc
{
  "id": "web.route.POST./api/orders",
  "statement": "POST /api/orders accepts {sku, qty} and answers 201 with {id}",
  "kind": "observed",
  "ceiling": "executed",
  "subject": "/behavior/network/requests/3",
  "evidence": [
    {
      "path": "evidence/network.json",
      "sha256": "…",
      "selector": { "type": "pointer", "pointer": "/requests/3" },
    },
  ],
  "falsifier": "acceptance.http.orders.create",
  "limits": ["observed with an authenticated session only"],
}
```

For a web capture, the denominator classes beyond `request` and `dom-node` are
claims too: each referenced asset (`img[src=…]`, `script[src=…]`,
`link[href=…]` in the packaged DOM) and each route the capture names becomes an
`observed` claim whose selector is exactly the one the ledger enumerates. A
route cites the capture's own keys (`/url`, `/final_url`,
`/steps/<i>/after_url`), never a derived path that exists only in the IR. A
separately recorded history is not enumerated as its own route; the route blind
spot states that, because a denominator item no packaged evidence can name would
be a permanent gap. Assets and routes carry the static ceiling: their presence is
re-derivable from the package, while `executed` stays with the acceptance check
that replays the page.

`kind` and its companion field:

- `observed` — a probe recorded it. Requires ≥ 1 resolving `evidence` entry.
- `derived` — reconstructed by a named rule from other claims or evidence.
  Requires `derivation: { rule, inputs: [claim-id | evidence-ref] }`; every input
  must already exist and at least one must be `observed` or `derived`.
- `assumed` — neither. Requires
  `assumption: { statement, impact, resolution }`, where `resolution` names the
  concrete probe or check that would turn it into `observed`, and its ceiling is
  `inferred-only`.

`falsifier` is an acceptance check id (`acceptance.<scope>.<name>`) or
`gap:<ledger-entry-id>`. Claims of kind `observed` at ceiling `executed` need an
`executed` falsifier; a `structure` or `state` falsifier is not sufficient there.

Selectors extend the existing resolver (`resolveEvidenceRef`) with
`{ type: "whole" }`, `{ type: "pointer", pointer }`,
`{ type: "lines", from, to }`, `{ type: "dom", path }`,
`{ type: "request", index }` and `{ type: "byte-range", from, to }`. The legacy
shorthand (`pointer`, `contains`, `line`, `offset`) stays valid so existing
evidence and `blueprint-evidence.test.mjs` keep working. `whole` names the file
itself and is the most common selector in a real package; an unknown `type` is
unresolved, never a silent pass.

The single resolver is `ui/blueprint/evidence.mjs` (`SELECTOR_TYPES`,
`resolveSelector`, `resolveEvidence`). The build gate resolves every selector
against the packaged bytes in both of its passes, and
`npm run blueprint:verify` resolves it again inside an unpacked package; DOM
selectors use the acceptance runner's `matchesSelector` grammar, so evidence and
acceptance cannot disagree about which node exists.

Rendering puts the three kinds in three separate sections with no shared table,
so a derived statement cannot appear as an observation. Section 10 of
`BLUEPRINT.md` lists, per claim, `kind`, `ceiling`, its support and
`falsifier`; a derived claim names its derivation (`abgeleitet aus N Eingabe(n)`)
and an assumed one names the assumption, so neither reads as a claim without a
reference. `AGENT-PROMPT.md` states the evidence ceiling and the closure ratio of
the package it hands to the agent.

## 6. Closure ledger

```jsonc
{
  "schema": "rea.blueprint.ledger",
  "schema_version": 1,
  "ceiling": "executed",
  "denominators": [
    {
      "class": "route",
      "probe": "source.route-scan",
      "items": 12,
      "blind_spots": ["routes built from a runtime string"],
    },
  ],
  "entries": [
    {
      "id": "route:POST /api/orders",
      "class": "route",
      "source": {
        "path": "source/server.mjs",
        "selector": { "type": "line", "line": 214 },
      },
      "status": "covered",
      "claims": ["web.route.POST./api/orders"],
    },
  ],
  "closure": { "covered": 11, "gap": 1, "out_of_scope": 0, "ratio": 0.9167 },
}
```

Rules:

- The denominator is enumerated per class by a named probe. Every enumerated item
  gets exactly one entry; set equality between probe output and entries is a gate
  condition.
- `ratio = covered / (covered + gap)`. `out_of_scope` entries require a reason and
  are capped at 10 % of the denominator, otherwise the gate refuses `complete`.
- `status: "gap"` requires `gap: { id, why, action, blocking }`; `blocking: true`
  always prevents `complete`.
- Every `source` and every `claims[]` reference must resolve, so an entry cannot
  claim coverage by a claim that does not exist.

An empty denominator is never "complete": it yields
`ledger.denominator.empty`. Bundle omissions caused by the `Bundle` byte or file
caps (`Bundle#omitted`) become blocking ledger gaps with the omitted path, so a
package cannot look closed while a source tree or evidence tree was truncated.

Coverage reported anywhere in the package derives from `closure`, never from a
threshold count.

`MANIFEST.json` declares the same denominator (`denominators.classes[]` with
`class`, `items` and the enumerating `probe`, plus `denominators.total`), so an
unpacked package can be audited against the number it promised. That declaration
is the reference `blueprint:verify` compares the unpacked ledger to; the
ledger's own `denominators` block is not trusted to agree with itself.

## 7. Two-pass analyze → render

```ts
// pass 1 — impure, cacheable by input digest
export async function analyze(config: AnalyzeConfig): Promise<Analysis>;
// pass 2 — pure
export function compile(analysis: Analysis): Compiled;
```

`Analysis` is plain data: probes, facts, evidence files with digests, ledger
candidates, declared ceiling, probe versions. `compile` performs no I/O, no
`Date.now()`, no `randomUUID()`; it is the only producer of claims, ledger, IR,
Markdown, prompt, acceptance file and manifest body.

Consequences, all breaking for `blueprint.json` consumers:

- `schema_version` becomes `2`.
- `id` becomes `bp-<first 16 hex of sha256(analysisDigest + compilerVersion)>`.
- `generated_at` leaves the IR and becomes `MANIFEST.json#produced_at`
  (non-normative, excluded from the digest).
- Every array in the IR is sorted by a stable key before rendering.

`compile(compileInput)` twice returns byte-identical output; `analyze` on the
same inputs returns the same `analysisDigest`.

A reproducible build pins `generatedAt`: `MANIFEST.json#produced_at` and the ZIP
DOS timestamps are derived from it instead of the clock, so two builds from the
same input produce byte-identical archives. Source locations are recorded as the
package-relative path (`source/web/project`) or the folder name, never as a host
path: the package has to make sense on the machine that unpacks it.

## 8. Fail-closed gate

```ts
export type GateStatus = "complete" | "partial" | "open";
export type Violation = { code: string; subject: string; detail: string };
export function gate(
  bp: BlueprintIR,
  ledger: Ledger,
  acceptance: AcceptanceFile,
  ctx: GateContext,
): { ok: boolean; status: GateStatus; violations: Violation[] };
```

Violation codes: `claim.evidence.unresolved`,
`claim.evidence.selector_unresolved` (the path is packaged but its selector
resolves nowhere), `claim.observed.without_evidence`, `claim.derived.without_derivation`,
`claim.derived.forward_reference`, `claim.assumed.without_resolution`,
`claim.ceiling.exceeds_run`, `claim.falsifier.missing`,
`claim.falsifier.not_executable`, `ledger.denominator.mismatch`,
`ledger.denominator.empty`, `ledger.item.unknown`,
`ledger.out_of_scope.exceeded`, `bundle.entry.omitted`,
`acceptance.criterion.missing`, `acceptance.criterion.unexecutable`,
`render.not_deterministic`, `manifest.hash_mismatch`.

`ok` is true only when `violations.length === 0`; `status` is `complete` only
when `ok` and `ledger.closure.ratio === 1`. `buildBlueprint` throws
`BlueprintGateError` (carrying `violations`) unless the caller passes
`allowIncomplete: true`, in which case the package is written and the UI shows
the violations instead of offering the download.

Any code path that cannot decide a claim's support produces `unknown`, which is
a violation. Absence of evidence is never treated as absence of the fact.

## 9. Acceptance criteria are executable

`acceptance.json` lists checks; section 8 of `BLUEPRINT.md` renders one row per
criterion with its check id, kind and the fixture it needs.

| `kind`      | Executes                                                           |
| ----------- | ------------------------------------------------------------------ |
| `http`      | Replays a recorded request against the rebuild, diffs status/body  |
| `dom`       | Compares rendered DOM against the recorded snapshot selectors      |
| `function`  | Calls a named pure function or an I/O-fixture wrapper, diffs value |
| `state`     | Walks a state-machine trace, asserts allowed/forbidden transitions |
| `process`   | Runs `argv`, asserts exit code, stdout/stderr ordering             |
| `structure` | Asserts presence and shape of files, exports, manifest entries     |

`ui/blueprint/run-acceptance.mjs` executes a subset for a given rebuild directory
and prints `{passed, failed, skipped, unexecutable}`. A check that cannot run for
the target class is `skipped` with a reason and blocks `complete`; a criterion
without a check is `acceptance.criterion.missing`.

## 10. Fidelity harness

`npm run blueprint:fidelity -- --package <zip> --rebuild <dir>` runs the
acceptance subset against a user-supplied rebuild and writes
`rebuild-report.json` with per-criterion verdicts. The corpus lives in
`ui/blueprint/corpus/`; a corpus case is a package plus a rebuild plus the
expected verdict set.

`npm run blueprint:verify -- <paketverzeichnis>` checks an unpacked package
without the repository: it re-runs the gate, the manifest hashes, every claim's
evidence digest and selector, every path the package references, and the ledger
against the denominator the manifest declares. The checker itself ships with the
archive: `audit/scripts/blueprint-verify.mjs` and its import closure under
`audit/ui/blueprint/` are byte-identical copies of `scripts/blueprint-verify.mjs`
and `ui/blueprint/`, and a test compares their SHA-256, so the packaged checker
cannot drift from the tested one. `node audit/scripts/blueprint-verify.mjs .`
inside the unpacked download therefore runs the same check with `node` alone — no
repository module, no installed package, no network. Each defect keeps one code: a
missing evidence file is `claim.evidence.unresolved` (from the gate), while
`claim.evidence.selector_unresolved` is reserved for a selector that fails inside
bytes the package does contain. The denominator comparison distinguishes a
removed unit (`ledger.unit.missing`), an added one
(`ledger.unit.unexpected`) and a reclassified one with the same total
(`ledger.unit.reclassified`); a manifest that declares neither denominator nor
determinism rule is `manifest.denominator.undeclared` /
`manifest.determinism.undeclared`. No claim may stand above the ceiling the
manifest promises: such a claim is `claim.ceiling.exceeds_manifest`. A claim
that also exceeds the blueprint's run ceiling keeps the gate's
`claim.ceiling.exceeds_run`, so one defect is reported once.

Both documents carry the same declarations and are checked against them, so the
readable ceiling cannot drift from the declared one. `BLUEPRINT.md` prints
`**Evidenz-Decke:**`, `**Herabstufungen:**` and `**Behauptungen:** <n> gesamt ·
<n> observed · <n> derived · <n> assumed`; `AGENT-PROMPT.md` prints the three as
plain lines plus a `## Evidenzlage (verbindlich)` block naming all four
categories. A differing ceiling or downgrade list is `docs.ceiling.mismatch` /
`docs.downgrade.mismatch`, differing counts are `docs.claim_count.mismatch`, a
dropped section is `docs.section.missing`, and an empty category that is not
marked as empty is `docs.section.empty_unmarked`.

`MANIFEST.json#determinism` states the rule the build actually follows: entry
sort order, pinned `produced_at` outside every digest, ZIP timestamps derived from
`produced_at` in UTC, no clock or environment read in `compile`, and the scope
(evidence ceiling plus `downgraded_by`) the rule holds for. Two builds that
differ only in `produced_at` therefore produce identical bytes everywhere except
`MANIFEST.json` and the ZIP time fields; `ui/blueprint/package-verify.test.mjs`
holds the build to that. An unpacked
package contains `BLUEPRINT.md`, `AGENT-PROMPT.md`, `blueprint.json`,
`README.txt`, `ledger.json`, `acceptance.json`, `MANIFEST.json`,
`GATE-REPORT.json` (only when the gate found violations), `schemas/`
(`claims`, `ledger`, `manifest`, `flows`), `flows/flows.json`, `specs/ui.md`,
`specs/logic.md`, `audit/`, `evidence/` and `surface/` (DOM, screenshot,
manifest, resources, plus `accessibility.txt` and `storage.json` when the capture
has them). `audit/proofs.json` names the negative proofs the archive carries,
`audit/mutate.mjs` reproduces each one as a copy with exactly one defect,
`audit/scripts/blueprint-verify.mjs` is the packaged checker, and
`audit/README.md` states the commands and the expected codes: every proof ends
with exit 1 and exactly the codes it names. A failed criterion is reported as a _blueprint_ defect
(ambiguity or missing evidence) unless the corpus marks it `rebuild-defect`.

The archive itself is reproducible and committed. `npm run blueprint:build`
(`node scripts/blueprint-build.mjs`) rebuilds
`dist/blueprint-1.0.0-corpus.zip` from
`ui/blueprint/corpus/web-fixture/blueprint/capture.json` at the pinned
`produced_at` `2026-11-21T00:30:00.000Z`. The build imports only
`ui/blueprint*` and `node:` modules, so a fresh clone without `node_modules`
and without network access yields the same bytes; `--check` rebuilds into a
temporary directory and compares the SHA-256 with the committed archive. Entry
order comes from a code-unit comparison, never from locale collation, so the ICU
locale of the build host cannot change the archive. The committed artifact is
`sha256 4fa79580e2e73c5e8e5600c1306174960ce36ca418e4f06103637ecbb5f8f533`.

The harness never builds the rebuild itself and never executes the original
target.

## 11. Requirements

| ID  | Requirement                                                                                                                |
| --- | -------------------------------------------------------------------------------------------------------------------------- |
| R1  | `claims.schema.json`, `ledger.schema.json`, `manifest.schema.json` and `flows.schema.json` validate every produced package |
| R2  | Every claim has `id`, `statement`, `kind`, `ceiling`, `evidence`, `falsifier`                                              |
| R3  | `observed` has evidence, `derived` has derivation, `assumed` has resolution + `inferred-only`                              |
| R4  | The run ceiling follows the class matrix and is recorded with its forcing probe                                            |
| R5  | The ledger denominator comes from named probes; set equality is enforced                                                   |
| R6  | `coverage` and `completeness.status` derive from the ledger and the gate only                                              |
| R7  | `compile` is pure; two invocations produce identical bytes                                                                 |
| R8  | The gate is fail-closed and names a violation code per failure                                                             |
| R9  | Acceptance criteria reference checks; unexecutable checks block `complete`                                                 |
| R10 | `MANIFEST.json` hashes every packaged file and verifies offline                                                            |
| R11 | The three-kind separation appears in `BLUEPRINT.md` and in `blueprint.json`                                                |
| R12 | Existing evidence resolution semantics and `blueprint-evidence.test.mjs` keep passing                                      |

## 12. Acceptance of this feature

- A package produced from the web fixture contains ≥ 1 claim of each kind,
  a ledger whose entries equal the denominator, and a gate report with zero
  violations.
- Removing one evidence file, one `falsifier` and one ledger entry each produces
  exactly one named violation and `status !== "complete"`.
- `compile` on the same `Analysis` twice is byte-identical, including the ZIP
  when `produced_at` is excluded.
- `NodeSeaArtifactReader` and its tests are unchanged.

## 13. Open questions

- Whether `src/` should later consume the same claim types instead of the studio
  owning them. Deferred; the compiler stays in `ui/` until the studio artifact is
  stable.
- Whether the ceiling for `apk` may ever be `executed` under the contribution
  scope rules. Deferred to the maintainer scope decision; this spec assumes no.
