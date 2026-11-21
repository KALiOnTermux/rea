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
 * - one `observed` claim per captured request and per interactive DOM node, so
 *   the `http`/`dom` acceptance kinds have something to be derived from,
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
import {
  webAssetItems,
  webDomItems,
  webRequestItems,
  webRouteItems,
} from "./denominators/web.mjs";

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
      // Keep the derived marker: a derived file ships with the package but is
      // not an observation, so it must not become a claim or rebuild check.
      ...(entry.derived === true ? { derived: true } : {}),
    }))
    .sort((left, right) => compareStrings(left.path, right.path));
}

/**
 * The ceiling a packaged-file claim may carry.
 *
 * A file's presence is a static fact: it can be re-derived from the package, but
 * nothing executed it. Claiming `executed` here would demand a runtime check as
 * its falsifier and leave every web package permanently unclosable.
 */
function staticCeiling(ceiling) {
  return CEILING_ORDER.indexOf(ceiling) > 1 ? "statically-evidenced" : ceiling;
}

function observedUnits(targetClass, ceiling, evidence) {
  return evidence
    .filter((entry) => entry.derived !== true)
    .map((entry) => {
      const entryId = `evidence:${entry.path}`;
      return {
        claim: makeClaim({
          id: claimId(`${targetClass}.evidence`, entry.path),
          statement: `Die Belegdatei ${entry.path} (${entry.role}) liegt im Paket und ist gehasht.`,
          kind: "observed",
          ceiling: staticCeiling(ceiling),
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

/** Caps how many capture items become claims; the rest stay ledger gaps. */
const MAX_OBSERVED_NODES = 200;

/**
 * `observed` claims for what the capture actually recorded.
 *
 * Each request, interactive DOM node, referenced asset and named route becomes
 * one claim whose evidence selector names exactly the item the ledger enumerates
 * (spec §5). Without them the `http` and `dom` acceptance kinds could never be
 * emitted, and the `request`, `dom-node`, `asset` and `route` denominators could
 * never be covered — the package would carry check kinds that no run can produce.
 *
 * An asset and a route are facts about the packaged recording (the DOM references
 * the file, the capture names the URL), so they carry the static ceiling: their
 * presence is re-derivable from the package, while the `executed` part — that the
 * page answered — stays with the acceptance criterion that replays it.
 */
function webObservationUnits(targetClass, ceiling, facts) {
  const groups = [
    {
      cls: "request",
      items: webRequestItems(facts),
      statement: (item) =>
        `${item.subject} wurde während der Aufnahme aufgezeichnet.`,
      limit: "nur während der Aufnahme ausgelöste Requests",
    },
    {
      cls: "dom-node",
      items: webDomItems(facts),
      statement: (item) =>
        `${item.subject} ist im aufgenommenen DOM vorhanden.`,
      limit: "nur beim Aufnehmen sichtbare interaktive Knoten",
    },
    {
      cls: "asset",
      items: webAssetItems(facts),
      statement: (item) =>
        `${item.subject} wird vom aufgenommenen DOM referenziert.`,
      limit: "nur im DOM referenzierte Assets",
      ceiling: "statically-evidenced",
    },
    {
      cls: "route",
      items: webRouteItems(facts),
      statement: (item) =>
        `${item.subject} ist in der Aufnahme als geladene Seite belegt.`,
      limit: "nur Ziele aufgezeichneter Schritte und statisch gefundene Routen",
      ceiling: "statically-evidenced",
      // A pointer observation has no acceptance kind of its own; the route
      // criterion replays the URLs, so the ledger entry is the falsifier here.
      falsifier: (item) => `gap:route:${item.subject}`,
    },
  ];
  const units = [];
  for (const group of groups) {
    for (const item of group.items.slice(0, MAX_OBSERVED_NODES)) {
      const id = claimId(`${targetClass}.${group.cls}`, item.subject);
      units.push({
        claim: makeClaim({
          id,
          statement: group.statement(item),
          kind: "observed",
          ceiling: group.ceiling ?? ceiling,
          subject: item.pointer,
          evidence: [
            { path: item.source.path, selector: { ...item.source.selector } },
          ],
          falsifier: group.falsifier
            ? group.falsifier(item)
            : `acceptance.${id}`,
          limits: [group.limit],
        }),
        entry: {
          id: `${group.cls}:${item.subject}`,
          class: group.cls,
          subject: item.subject,
          source: item.source,
          status: "covered",
          claims: [id],
        },
      });
    }
  }
  return units;
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

/** The run ceiling: what the operator asked for, lowered to what probes prove. */
function runCeiling(targetClass, ctx) {
  const permitted = CLASS_CEILINGS[targetClass] ?? CLASS_CEILINGS.document;
  const requested =
    ctx.requestedCeiling ??
    CEILING_ORDER.filter((entry) => permitted.includes(entry)).at(-1);
  return resolveCeiling({
    targetClass,
    requested,
    probes: ctx.probes ?? [],
  });
}

function probesOf(ctx) {
  return (ctx.probes ?? []).map((probe) =>
    typeof probe === "string"
      ? { id: probe, tags: [probe] }
      : { id: probe.id ?? "(anonymous)", tags: [...(probe.tags ?? [])] },
  );
}

function factsOf(built, reconstruction, openQuestions) {
  return {
    surface: built?.surface ?? {},
    behavior: built?.behavior ?? {},
    internals: built?.internals ?? {},
    data: built?.data ?? {},
    dependencies: built?.dependencies ?? [],
    coverage: built?.coverage ?? [],
    reconstruction,
    acceptance: built?.acceptance ?? [],
    open_questions: openQuestions,
  };
}

/** Every claim unit of the run, each paired with the entry that accounts for it. */
function unitsOf({
  targetClass,
  ceiling,
  built,
  evidence,
  reconstruction,
  openQuestions,
}) {
  const evidenceUnits = observedUnits(targetClass, ceiling, evidence);
  const captureUnits =
    targetClass === "web"
      ? webObservationUnits(targetClass, ceiling, built)
      : [];
  const derived = derivedUnits(
    targetClass,
    ceiling,
    reconstruction,
    evidenceUnits.map((unit) => unit.claim.id),
  );
  const assumed = assumedUnits(targetClass, openQuestions);
  return [...evidenceUnits, ...captureUnits, ...derived, ...assumed];
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
  const ceiling = runCeiling(targetClass, ctx);
  const evidence = normaliseEvidence(ctx.evidence);
  const reconstruction = Array.isArray(built?.reconstruction)
    ? built.reconstruction
    : [];
  const openQuestions = Array.isArray(ctx.openQuestions)
    ? ctx.openQuestions
    : [];
  const units = unitsOf({
    targetClass,
    ceiling: ceiling.ceiling,
    built,
    evidence,
    reconstruction,
    openQuestions,
  });
  const claims = sortClaims(units.map((unit) => unit.claim));
  assertUniqueClaimIds(claims);

  const analysis = {
    target: built?.target ?? {
      kind,
      input: ctx.target ?? "",
      name: ctx.target ?? "",
    },
    ceiling,
    probes: probesOf(ctx),
    facts: factsOf(built, reconstruction, openQuestions),
    evidence,
    ledger: units
      .map((unit) => ({ ...unit.entry, claims: [unit.claim.id] }))
      .sort((left, right) => compareStrings(left.id, right.id)),
    claims,
    limits: Array.isArray(ctx.limits) ? [...ctx.limits] : [],
    warnings: Array.isArray(ctx.warnings) ? [...ctx.warnings] : [],
    sources: Array.isArray(ctx.sources) ? [...ctx.sources] : [],
    produced_at: ctx.producedAt ?? null,
  };
  analysis.id = `an-${analysisDigest(analysis).slice(0, 16)}`;
  return analysis;
}
