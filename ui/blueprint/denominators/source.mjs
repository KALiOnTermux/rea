/**
 * Coverage denominator for a source tree (spec §6, Task 19).
 *
 * The denominator answers "what should this run have looked at?" from the facts
 * themselves — resolved functions, statically found routes and the exit paths the
 * analysis reached — never from a completeness report, which only says what
 * someone thought to check.
 *
 * Every enumerated item becomes one ledger entry. An item is `covered` only when
 * a claim carries an evidence selector that names exactly that item; otherwise it
 * is a gap with the action that would close it.
 *
 * The ceiling of a source run follows the same rule: a captured deterministic run
 * is the only probe that supports `executed`, so a run without one is lowered to
 * `statically-evidenced` and the package names `source:no-deterministic-run`
 * instead of silently claiming more.
 */

import { resolveCeiling } from "../ceiling.mjs";

const ANALYSIS_SOURCE = "evidence/code-analysis.json";

function compareStrings(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function pointerItem(pointer, subject) {
  return {
    subject,
    source: { path: ANALYSIS_SOURCE, selector: { type: "pointer", pointer } },
  };
}

/**
 * Every function the semantic graph resolved.
 *
 * The graph carries no export metadata, so the denominator counts each named
 * function once and the blind spot says so; the class name follows the plan.
 */
function symbolItems(facts) {
  return asArray(facts?.internals?.semantic_graph?.functions).map((fn, index) =>
    pointerItem(
      `/internals/semantic_graph/functions/${index}`,
      `fn:${fn.module ? `${fn.module}#` : ""}${fn.name}`,
    ),
  );
}

function routeItems(facts) {
  const routes = asArray(facts?.surface?.routes ?? facts?.internals?.routes);
  return routes.map((route, index) =>
    pointerItem(
      `/surface/routes/${index}`,
      `${route.method || "GET"} ${route.path || route.pattern || route.route || index}`,
    ),
  );
}

function exitItems(facts) {
  return asArray(facts?.behavior?.exit_paths).map((exit, index) =>
    pointerItem(
      `/behavior/exit_paths/${index}`,
      `exit:${exit.kind || exit.type || "unknown"}:${exit.value ?? exit.name ?? exit.path ?? ""}`,
    ),
  );
}

const BLIND_SPOTS = {
  "exported-symbol": [
    "Der semantische Graph nennt nur Funktionen mit auflösbarem Namen; Exporte, die erst durch dynamisches `import()` oder `eval` entstehen, fehlen im Nenner.",
  ],
  route: [
    "Nur statisch erkannte Routen; ein dynamisch registrierter Handler aus einer Zeichenkette fehlt im Nenner.",
  ],
  "exit-path": [
    "Nur statisch erreichbare Ausstiege; Ausnahmen, die erst aus einer Bibliothek oder einem dynamischen Aufruf entstehen, fehlen.",
  ],
};

const ENUMERATORS = {
  "exported-symbol": symbolItems,
  route: routeItems,
  "exit-path": exitItems,
};

function enumerate(facts, cls) {
  return ENUMERATORS[cls](facts ?? {});
}

/** Denominators per class, sorted, with the probe that enumerated them. */
export function sourceDenominators(analysis) {
  const facts = analysis?.facts ?? {};
  return Object.keys(ENUMERATORS)
    .sort(compareStrings)
    .map((cls) => ({
      class: cls,
      probe: `source.${cls}-scan`,
      items: enumerate(facts, cls).length,
      blind_spots: [...BLIND_SPOTS[cls]],
    }));
}

/** The ceiling a source run can support with the probes it actually ran. */
export function sourceCeiling(analysis) {
  return resolveCeiling({
    targetClass: "source",
    requested: analysis?.ceiling?.requested ?? "executed",
    probes: asArray(analysis?.probes),
  });
}

function coveredBy(item, claims) {
  return claims.filter((claim) =>
    asArray(claim.evidence).some(
      (ref) =>
        ref.path === item.source.path &&
        JSON.stringify(ref.selector ?? {}) ===
          JSON.stringify(item.source.selector),
    ),
  );
}

/**
 * One ledger entry per enumerated item.
 *
 * An item stays a gap unless a claim names it by evidence selector, so the
 * coverage number cannot rise because of unrelated observations.
 */
export function sourceEntries(analysis, claims = []) {
  const facts = analysis?.facts ?? {};
  const entries = [];
  for (const cls of Object.keys(ENUMERATORS).sort(compareStrings)) {
    for (const item of enumerate(facts, cls)) {
      const matches = coveredBy(item, claims);
      const id = `${cls}:${item.subject}`;
      if (matches.length > 0) {
        entries.push({
          id,
          class: cls,
          subject: item.subject,
          source: item.source,
          status: "covered",
          claims: matches.map((claim) => claim.id).sort(compareStrings),
        });
        continue;
      }
      entries.push({
        id,
        class: cls,
        subject: item.subject,
        source: item.source,
        status: "gap",
        claims: [],
        gap: {
          id,
          why: `Für ${cls} "${item.subject}" gibt es keine Behauptung mit Beleg an genau dieser Stelle.`,
          action: `Behauptung für ${cls} "${item.subject}" aus dem Beleg ableiten und mit Selektor belegen.`,
          blocking: false,
        },
      });
    }
  }
  return entries.sort((left, right) => compareStrings(left.id, right.id));
}
