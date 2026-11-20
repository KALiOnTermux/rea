/**
 * The analysis record: pass one of the claim compiler (spec §7).
 *
 * `toAnalysis` adapts the facts a legacy builder already produced into plain
 * data. It may read the clock and the environment; everything downstream
 * (`compile`) must not. The record keeps facts at their original paths so a
 * reviewer can follow a claim back to the fact it was derived from, and it
 * already separates the three claim kinds:
 *
 * - one `observed` claim per packaged evidence file,
 * - one `derived` claim per reconstruction step, derived from those observations,
 * - one `assumed` claim per open question, carrying the probe that would resolve it.
 *
 * Each claim is built together with the ledger entry that accounts for it, so an
 * entry id and a `gap:` falsifier cannot drift apart.
 *
 * `analysisDigest` covers the factual content only: `produced_at` stays out of it
 * so two runs over the same input share a blueprint id, and `id` is derived from
 * the digest rather than hashed into it.
 */

import { createHash } from "node:crypto";
import { CEILING_ORDER, CLASS_CEILINGS, resolveCeiling } from "./ceiling.mjs";
import {
  assertUniqueClaimIds,
  claimId,
  makeClaim,
  sortClaims,
} from "./claims.mjs";

const DIGEST_FIELDS = [
  "target",
  "ceiling",
  "probes",
  "facts",
  "evidence",
  "ledger",
  "claims",
  "limits",
  "warnings",
  "sources",
];

/** Maps a legacy target kind onto the ceiling matrix. */
function targetClassOf(kind) {
  if (kind === "web") return "web";
  if (kind === "apk") return "apk";
  if (kind === "code") return "source";
  return "document";
}

function compareStrings(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function stripUndefined(value) {
  if (Array.isArray(value)) {
    return value.map(stripUndefined).filter((item) => item !== undefined);
  }
  if (value === null || typeof value !== "object") return value;
  const result = {};
  for (const key of Object.keys(value).sort()) {
    const item = stripUndefined(value[key]);
    if (item !== undefined) result[key] = item;
  }
  return result;
}

/** Canonical JSON: sorted keys, no whitespace. */
export function canonicalJson(value) {
  return JSON.stringify(stripUndefined(value));
}

/** sha256 over the factual content of an analysis, 64 hex. */
export function analysisDigest(analysis) {
  const content = {};
  for (const field of DIGEST_FIELDS) content[field] = analysis?.[field];
  return createHash("sha256").update(canonicalJson(content)).digest("hex");
}

function normaliseEvidence(evidence) {
  if (!Array.isArray(evidence)) return [];
  return evidence
    .filter((entry) => entry && typeof entry.path === "string" && entry.path)
    .map((entry) => ({
      role: entry.role ?? "evidence",
      path: entry.path,
      bytes: Number.isInteger(entry.bytes) ? entry.bytes : null,
      sha256: entry.sha256 ?? null,
    }))
    .sort((left, right) => compareStrings(left.path, right.path));
}

function observedUnits(targetClass, ceiling, evidence) {
  return evidence.map((entry) => {
    const entryId = `evidence:${entry.path}`;
    return {
      claim: makeClaim({
        id: claimId(`${targetClass}.evidence`, entry.path),
        statement: `Die Belegdatei ${entry.path} (${entry.role}) liegt im Paket und ist gehasht.`,
        kind: "observed",
        ceiling,
        subject: `/evidence/${entry.path}`,
        evidence: [
          {
            path: entry.path,
            ...(entry.sha256 ? { sha256: entry.sha256 } : {}),
            selector: { type: "whole" },
          },
        ],
        falsifier: `gap:${entryId}`,
        limits: [],
      }),
      entry: {
        id: entryId,
        class: "evidence",
        subject: entry.path,
        source: { path: entry.path, selector: { type: "whole" } },
        status: "covered",
      },
    };
  });
}

function derivedUnits(targetClass, ceiling, reconstruction, inputs) {
  if (inputs.length === 0) return [];
  return reconstruction.map((step, index) => {
    const subject = String(step.step ?? index + 1);
    const entryId = `step:${subject}`;
    const title = String(step.title ?? "").trim();
    return {
      claim: makeClaim({
        id: claimId(
          `${targetClass}.reconstruction`,
          subject,
          ...(title ? [title] : []),
        ),
        statement: `Schritt ${subject} (${title || "ohne Titel"}): ${step.goal}`,
        kind: "derived",
        ceiling,
        subject: `/reconstruction/${index}`,
        evidence: [],
        derivation: { rule: "reconstruction.step", inputs: [...inputs] },
        falsifier: `gap:${entryId}`,
        limits: [],
      }),
      entry: {
        id: entryId,
        class: "step",
        subject,
        status: "covered",
      },
    };
  });
}

function assumedUnits(targetClass, openQuestions) {
  return openQuestions.map((item, index) => {
    const subject = String(item.id ?? index + 1);
    const entryId = `open-question:${subject}`;
    return {
      claim: makeClaim({
        id: claimId(`${targetClass}.open-question`, subject),
        statement: item.question,
        kind: "assumed",
        ceiling: "inferred-only",
        subject: `/open_questions/${index}`,
        evidence: [],
        assumption: {
          statement: item.question,
          impact: item.why,
          resolution: item.how,
        },
        falsifier: `gap:${entryId}`,
        limits: [],
      }),
      entry: {
        id: entryId,
        class: "open-question",
        subject,
        status: "gap",
        gap: {
          id: entryId,
          why: item.why,
          action: item.how,
          blocking: true,
        },
      },
    };
  });
}

/**
 * Adapts a legacy `built` record into an `Analysis`.
 *
 * `ctx` is the studio context: kind, target, probes, evidence, warnings, limits,
 * open questions and the time the run was produced.
 */
export function toAnalysis(built, ctx = {}) {
  const kind = ctx.kind ?? built?.target?.kind ?? "generic";
  const targetClass = targetClassOf(kind);
  const permitted = CLASS_CEILINGS[targetClass] ?? CLASS_CEILINGS.document;
  const requested =
    ctx.requestedCeiling ??
    CEILING_ORDER.filter((entry) => permitted.includes(entry)).at(-1);
  const ceiling = resolveCeiling({
    targetClass,
    requested,
    probes: ctx.probes ?? [],
  });

  const evidence = normaliseEvidence(ctx.evidence);
  const reconstruction = Array.isArray(built?.reconstruction)
    ? built.reconstruction
    : [];
  const openQuestions = Array.isArray(ctx.openQuestions)
    ? ctx.openQuestions
    : [];

  const observed = observedUnits(targetClass, ceiling.ceiling, evidence);
  const derived = derivedUnits(
    targetClass,
    ceiling.ceiling,
    reconstruction,
    observed.map((unit) => unit.claim.id),
  );
  const assumed = assumedUnits(targetClass, openQuestions);
  const units = [...observed, ...derived, ...assumed];
  const claims = sortClaims(units.map((unit) => unit.claim));
  assertUniqueClaimIds(claims);

  const ledger = units
    .map((unit) => ({ ...unit.entry, claims: [unit.claim.id] }))
    .sort((left, right) => compareStrings(left.id, right.id));

  const analysis = {
    target: built?.target ?? {
      kind,
      input: ctx.target ?? "",
      name: ctx.target ?? "",
    },
    ceiling,
    probes: (ctx.probes ?? []).map((probe) =>
      typeof probe === "string"
        ? { id: probe, tags: [probe] }
        : { id: probe.id ?? "(anonymous)", tags: [...(probe.tags ?? [])] },
    ),
    facts: {
      surface: built?.surface ?? {},
      behavior: built?.behavior ?? {},
      internals: built?.internals ?? {},
      data: built?.data ?? {},
      dependencies: built?.dependencies ?? [],
      coverage: built?.coverage ?? [],
      reconstruction,
      acceptance: built?.acceptance ?? [],
      open_questions: openQuestions,
    },
    evidence,
    ledger,
    claims,
    limits: Array.isArray(ctx.limits) ? [...ctx.limits] : [],
    warnings: Array.isArray(ctx.warnings) ? [...ctx.warnings] : [],
    sources: Array.isArray(ctx.sources) ? [...ctx.sources] : [],
    produced_at: ctx.producedAt ?? null,
  };
  analysis.id = `an-${analysisDigest(analysis).slice(0, 16)}`;
  return analysis;
}
