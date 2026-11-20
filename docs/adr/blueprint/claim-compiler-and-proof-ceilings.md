# Claim compiler and per-class proof ceilings

**Status:** accepted

## Context

`ui/blueprint.mjs` produces `BLUEPRINT.md`, `blueprint.json` and
`AGENT-PROMPT.md` plus an evidence tree, and `evaluateCompleteness` gates the
export. The gate measures shape (`reconstruction.length >= 3`,
`contains: "## 7. Rekonstruktionsplan"`), coverage derives from the number of
open questions, and `bp.id` embeds `new Date()` and a random UUID. Three
consequences follow: a section can look complete while nothing supports it, an
unobserved route is silently absent instead of recorded as a gap, and two runs
over the same input never produce the same bytes, so no acceptance test over the
package can be meaningful.

A blueprint that claims "100 % behaviour-faithful" for an artifact class whose
behaviour was never executed would hide exactly the system boundary the package
promises not to hide.

## Decision

1. The package is compiled from typed **claims** (`observed`, `derived`,
   `assumed`), each with an evidence reference, a ceiling and a falsifier.
   Sections are rendered from claims; the three kinds never share a section.
2. A run declares one **proof ceiling** per target class
   (`executed`, `statically-evidenced`, `inferred-only`). The matrix is fixed by
   the spec; the run ceiling is `min(requested, supported-by-actual-probes)` and
   a downgrade names the probe that forced it. Claims above the run ceiling are a
   violation, never a silent clamp.
3. Coverage comes from a **closure ledger** with a denominator enumerated by
   named probes; set equality between probe output and ledger entries is
   enforced, and `out_of_scope` entries are capped.
4. `analyze()` stays impure and cacheable; `compile()` is pure. The IR id is a
   digest, and the only wall-clock value (`produced_at`) lives in
   `MANIFEST.json`.
5. The export gate is fail-closed: any unresolved evidence, missing derivation,
   missing assumption resolution, unknown ledger item, unexecutable acceptance
   criterion or broken manifest hash prevents `complete` and throws
   `BlueprintGateError` unless the caller explicitly asks for an incomplete
   package.

## Consequences

- `blueprint.json` moves to `schema_version: 2`: `claims`, `ceiling` and
  `ledger` are added, `generated_at` is removed, `id` becomes a digest. The
  studio is the only consumer and is updated in the same change.
- Partial captures stay usable: `allowIncomplete` writes the package and shows
  the violations instead of offering a download that pretends to be complete.
- Every acceptance criterion must name an executable check; criteria that cannot
  run for the target class are `skipped` with a reason and block `complete`.
  For static-only classes this deliberately lowers the claimable ceiling rather
  than the standard.
- The compiler stays in `ui/` and is not part of the compiled CLI/MCP runtime;
  promoting the claim types into `src/` is a later, separate decision.
- The fidelity harness measures the package against a user-supplied rebuild.
  A failing criterion is reported as a blueprint defect unless the corpus marks
  it a rebuild defect, so the measurement cannot quietly excuse the specification.
