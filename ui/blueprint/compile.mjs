/**
 * The compile pass of the claim compiler (spec §7).
 *
 * `compile` is pure: it performs no I/O, reads no clock, no random source and no
 * environment. Everything non-reproducible is decided by `toAnalysis` and
 * arrives as data. That is what makes the package diffable and an acceptance
 * criterion meaningful: two runs over the same analysis produce identical bytes.
 *
 * Stages and their slots:
 *
 * - `blueprint` — the IR, `schema_version: 2`, identified by the analysis digest.
 * - `claims` — the typed records the three sections render from.
 * - `markdown` / `prompt` — the two documents an agent reads.
 * - `manifest` — the file list and named digests, `produced_at` excluded.
 * - `ledger` / `acceptance` — filled by the closure ledger (stage 3) and the
 *   acceptance file (stage 4); `null` until those passes exist.
 */

import { createHash } from "node:crypto";
import { analysisDigest, canonicalJson } from "./analysis.mjs";
import { assertUniqueClaimIds, sortClaims } from "./claims.mjs";
import { buildManifest } from "./manifest.mjs";
import { renderMarkdown, renderPrompt } from "./render.mjs";

export const COMPILER_NAME = "blueprint-claim-compiler";
export const COMPILER_VERSION = 1;
export const COMPILER_ID = `${COMPILER_NAME}@${COMPILER_VERSION}`;

function blueprintFrom(analysis, digest, claims) {
  const facts = analysis.facts ?? {};
  return {
    schema: "rea.blueprint",
    schema_version: 2,
    id: `bp-${digest.slice(0, 16)}`,
    generator: analysis.generator ?? { name: "REA Studio", command: "rea" },
    target: analysis.target,
    source_included: analysis.source_included !== false,
    ceiling: analysis.ceiling,
    coverage: {
      status: "offen",
      available: facts.coverage ?? [],
      open_points: (facts.open_questions ?? []).length,
    },
    surface: facts.surface ?? {},
    behavior: facts.behavior ?? {},
    internals: facts.internals ?? {},
    data: facts.data ?? {},
    dependencies: facts.dependencies ?? [],
    reconstruction: facts.reconstruction ?? [],
    acceptance: facts.acceptance ?? [],
    open_questions: facts.open_questions ?? [],
    claims,
    evidence: analysis.evidence ?? [],
    warnings: analysis.warnings ?? [],
    limits: analysis.limits ?? [],
    bundle: analysis.bundle ?? {
      files: 0,
      bytes_raw: 0,
      bytes_compressed: 0,
    },
  };
}

/**
 * Compiles an analysis into the package body.
 *
 * Returns `{ blueprint, claims, ledger, acceptance, manifest, markdown, prompt,
 * outputDigest }`. Nothing here touches disk; the caller writes the files.
 */
export function compile(analysis) {
  const digest = analysisDigest(analysis);
  const claims = sortClaims(analysis.claims ?? []);
  assertUniqueClaimIds(claims);

  const blueprint = blueprintFrom(analysis, digest, claims);
  const compiled = {
    blueprint,
    claims,
    ledger: null,
    acceptance: null,
  };
  compiled.markdown = renderMarkdown(compiled);
  compiled.prompt = renderPrompt(compiled);
  compiled.manifest = buildManifest({
    files: {
      "BLUEPRINT.md": compiled.markdown,
      "AGENT-PROMPT.md": compiled.prompt,
      "blueprint.json": JSON.stringify(blueprint, null, 2),
    },
    ceiling: blueprint.ceiling.ceiling,
    compiler: COMPILER_ID,
    analysis_digest: digest,
    produced_at: analysis.produced_at,
  });
  compiled.outputDigest = createHash("sha256")
    .update(
      canonicalJson({
        blueprint,
        claims,
        markdown: compiled.markdown,
        prompt: compiled.prompt,
      }),
    )
    .digest("hex");
  return compiled;
}
