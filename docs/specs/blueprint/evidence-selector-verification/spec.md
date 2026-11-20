# Blueprint evidence selector verification

**Status:** implemented
**Owner:** blueprint generation (`ui/blueprint.mjs`, `ui/blueprint/`)
**Related:** [`claim-compiler/spec.md`](../claim-compiler/spec.md),
[`claim-compiler/plan.md`](../claim-compiler/plan.md),
`docs/adr/blueprint/claim-compiler-and-proof-ceilings.md`

## 1. Problem

The claim compiler shipped (`claim-compiler/tasks.md`, all 100 steps checked,
`spec.md` status `implemented`) and its package verifies end to end: the corpus
fixture produces 19 files, `npm run blueprint:verify` resolves 175/175
references, and `npm run blueprint:fidelity` returns `pass`. One promise of the
parent spec is nevertheless unenforced.

`claim-compiler/spec.md` §5 says every claim carries an **evidence reference**
whose selector is one of `{ type: "pointer" }`, `{ type: "lines", from, to }`,
`{ type: "dom", path }`, `{ type: "request", index }` or
`{ type: "byte-range", from, to }`, and §8 promises a fail-closed gate over those
references. What the code actually does:

- Shipped claims carry `{ "type": "dom", "path": "#buy" }`,
  `{ "type": "request", "index": 0 }` and `{ "type": "whole" }`.
- `gate.mjs#checkEvidence` tests only `files.has(ref.path)`. A claim that cites
  `surface/dom.html` with `#selector-that-does-not-exist` passes the gate.
- `resolveEvidenceRef` (`ui/blueprint.mjs:1811`) understands the legacy
  shorthand fields `pointer`, `contains`, `line`, `offset` and ignores a
  `{ type }` selector object entirely. `lines`, `byte-range` and object-form
  `pointer` do not exist anywhere; `whole` — the most common selector in a real
  package — is not in the spec at all.
- `package-verify.mjs` re-checks each claim's `path` and `sha256`, never its
  selector.

So the package states a machine-checkable pointer per claim and no component
resolves it. The half of the goal that reads "Beleg-Referenzen
(path, sha256, selector)" is met for `path` and `sha256` and open for `selector`.

Two smaller drift findings, both code-verifiable:

- §4 requires "A downgrade is recorded in `MANIFEST.json` and in `BLUEPRINT.md`
  section 1 with the probe that forced it". `renderMarkdown` does
  (`render.mjs:135`); `buildManifest` records only the resolved `ceiling`
  string, so the forcing probe is absent from the manifest.
- §9 and §10 name paths that do not exist (`acceptance/run-acceptance.mjs`,
  `tests/fidelity/corpus/`); §6 lists three schemas while the package ships
  four; the package inventory omits `README.txt`, `ledger.json`,
  `acceptance.json`, `MANIFEST.json`, `GATE-REPORT.json`, `schemas/`, `flows/`
  and `specs/`; `npm run blueprint:verify` is not documented at all; and
  `docs/specs/README.md` has no entry for the feature.

## 2. Goal

Resolve, at build time and in an unpacked package, the selector of every claim
evidence reference, so a citation that names a DOM node, a request, a JSON
pointer, a line range or a byte range that the package does not contain is a
gate violation instead of prose. Record the ceiling downgrade where §4 says it
belongs. Bring the parent spec back in line with what shipped.

## 3. Non-goals

- No new selector kind beyond the parent spec plus `whole`, which the package
  already emits. No CSS engine, no dependency: the existing
  `matchesSelector` grammar is the whole DOM vocabulary.
- No per-claim `sha256`. The manifest already hashes every packaged file; adding
  per-claim digests would duplicate it without adding tamper evidence.
- No change to acceptance semantics, ledger arithmetic, ceilings or rendering.
- No promotion of claim types into `src/`.

## 4. Requirements

| ID  | Requirement                                                                                                                 |
| --- | --------------------------------------------------------------------------------------------------------------------------- |
| R1  | One resolver understands `whole`, `pointer`, `lines`, `dom`, `request`, `byte-range` and the legacy shorthand               |
| R2  | The build gate refuses a claim whose evidence selector resolves nowhere, with a named violation code                        |
| R3  | `blueprint:verify` performs the same selector check on an unpacked package, without the source tree                          |
| R4  | `MANIFEST.json` records the requested ceiling and the probes that forced a downgrade                                        |
| R5  | `claim-compiler/spec.md` names the shipped file paths, package parts, schema set and violation codes; the index lists both features |

## 5. Acceptance

- A claim pointing at `#missing` in `surface/dom.html`, at request index 99, at
  `lines 9-12` of a three-line file, at `byte-range 0-99999` of a 4 KiB file, or
  at a JSON pointer that does not exist each produce exactly one
  `claim.evidence.selector_unresolved` violation and `status !== "complete"`.
- The corpus package still builds with zero violations, `blueprint:verify`
  still resolves every reference and `blueprint:fidelity` still passes.
- `ui/blueprint-evidence.test.mjs` is unchanged and still passes.
- `MANIFEST.json` of every produced package names `ceiling_requested` and
  `downgraded_by`.

## 6. Open questions

- Whether an `assumed` claim's evidence-free record should also carry a
  selector check when a `resolution` probe is later named. Deferred; `assumed`
  claims resolve through `assumption.resolution`, not through evidence.
