/**
 * The proof ceiling rule for the blueprint claim compiler (spec §4).
 *
 * A package may only assert what its target class and the probes that actually
 * ran can support. `CLASS_CEILINGS` is the static matrix of ceilings an operator
 * may request per class; `resolveCeiling` then lowers that request to the
 * highest ceiling the probes prove and names the missing grant, so a downgrade
 * is visible instead of being silently applied.
 *
 * A request is never raised: a run that asks for less than its probes support
 * keeps the smaller ceiling, because a weaker claim set is always honest.
 */

export const CEILING_ORDER = [
  "inferred-only",
  "statically-evidenced",
  "executed",
];

/**
 * Ceilings an operator may request per target class (spec §4).
 *
 * `apk`, `native` and `document` cannot request `executed`. A grant probe can
 * still support `executed` for `apk` and `native`; that is why
 * `resolveCeiling`, and not this table, decides the run ceiling.
 */
export const CLASS_CEILINGS = Object.freeze({
  web: Object.freeze(["executed", "statically-evidenced"]),
  source: Object.freeze(["executed", "statically-evidenced"]),
  apk: Object.freeze(["statically-evidenced", "inferred-only"]),
  native: Object.freeze(["statically-evidenced", "inferred-only"]),
  document: Object.freeze(["inferred-only"]),
});

/**
 * Probe tags a ceiling needs.
 *
 * A missing entry means the class cannot reach that ceiling at all, so the
 * downgrade names the matrix instead of a grant.
 */
const SUPPORT = Object.freeze({
  web: Object.freeze({
    executed: Object.freeze(["journey-executed"]),
    "statically-evidenced": Object.freeze([]),
    "inferred-only": Object.freeze([]),
  }),
  source: Object.freeze({
    executed: Object.freeze(["deterministic-run"]),
    "statically-evidenced": Object.freeze([]),
    "inferred-only": Object.freeze([]),
  }),
  apk: Object.freeze({
    executed: Object.freeze(["execution-grant"]),
    "statically-evidenced": Object.freeze([]),
    "inferred-only": Object.freeze([]),
  }),
  native: Object.freeze({
    executed: Object.freeze(["trace-grant"]),
    "statically-evidenced": Object.freeze([]),
    "inferred-only": Object.freeze([]),
  }),
  document: Object.freeze({
    "inferred-only": Object.freeze([]),
  }),
});

export class CeilingError extends Error {
  constructor(
    message,
    { code = "blueprint.ceiling", targetClass = null } = {},
  ) {
    super(message);
    this.name = "CeilingError";
    this.code = code;
    this.targetClass = targetClass;
  }
}

function compareStrings(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function rank(ceiling) {
  const index = CEILING_ORDER.indexOf(ceiling);
  if (index === -1) {
    throw new CeilingError(
      `unknown ceiling ${JSON.stringify(ceiling)}; expected one of ${CEILING_ORDER.join(", ")}`,
    );
  }
  return index;
}

function permittedRank(targetClass) {
  const permitted = CLASS_CEILINGS[targetClass];
  if (!permitted) {
    throw new CeilingError(
      `unknown target class ${JSON.stringify(targetClass)}; expected one of ${Object.keys(CLASS_CEILINGS).join(", ")}`,
      { targetClass },
    );
  }
  return permitted.reduce(
    (highest, ceiling) => Math.max(highest, rank(ceiling)),
    0,
  );
}

/**
 * Collects the tags of the probes that ran.
 *
 * A probe is either a plain tag string or a record with a `tags` array (or a
 * single `tag`), so the analysis record can pass its probe list unchanged.
 */
function probeTags(probes) {
  if (probes === undefined) return [];
  if (!Array.isArray(probes)) {
    throw new CeilingError("probes must be an array of probe records or tags");
  }
  const tags = new Set();
  for (const probe of probes) {
    if (typeof probe === "string") {
      tags.add(probe);
      continue;
    }
    if (probe === null || typeof probe !== "object") {
      throw new CeilingError(
        `probe must be a tag string or a record, got ${JSON.stringify(probe)}`,
      );
    }
    const label = JSON.stringify(probe.id ?? "(anonymous)");
    if (probe.tags !== undefined) {
      if (!Array.isArray(probe.tags)) {
        throw new CeilingError(
          `probe ${label} has a non-array tags field; probes must declare tags as an array`,
        );
      }
      for (const tag of probe.tags) {
        if (typeof tag !== "string" || tag === "") {
          throw new CeilingError(
            `probe ${label} has a non-string tag; tags must be non-empty strings`,
          );
        }
        tags.add(tag);
      }
    }
    if (typeof probe.tag === "string" && probe.tag !== "") tags.add(probe.tag);
  }
  return [...tags].sort(compareStrings);
}

/**
 * Returns the tags a ceiling needs but the run did not prove.
 *
 * `null` means the target class cannot reach that ceiling at all.
 */
function missingSupport(targetClass, ceiling, tags) {
  const required = SUPPORT[targetClass]?.[ceiling];
  if (!required) return null;
  return required.filter((tag) => !tags.includes(tag));
}

/**
 * Refuses a ceiling a target class may not request at all.
 *
 * Grants are proven by probes and therefore resolved in `resolveCeiling`; this
 * check is the static half of the same rule and fails closed for a class whose
 * matrix tops out below the requested ceiling.
 */
export function assertCeilingAllowed(targetClass, ceiling) {
  const requested = rank(ceiling);
  const allowed = permittedRank(targetClass);
  if (requested > allowed) {
    throw new CeilingError(
      `${ceiling} is not permitted for the ${targetClass} target class; its ceiling is at most ${CEILING_ORDER[allowed]}`,
      { targetClass },
    );
  }
}

/**
 * Resolves the run ceiling from the request and the probes that produced
 * evidence.
 *
 * The result is `min(requested, supported by probes)`. Every lowering names the
 * probe tag that would have supported the request, or states that the class can
 * never reach it, so the forcing probe is visible in the package.
 */
export function resolveCeiling({ targetClass, requested, probes } = {}) {
  const tags = probeTags(probes);
  const requestedRank = rank(requested);
  const allowed = permittedRank(targetClass);

  let supportedRank = -1;
  for (let candidate = requestedRank; candidate >= 0; candidate -= 1) {
    const missing = missingSupport(targetClass, CEILING_ORDER[candidate], tags);
    if (missing !== null && missing.length === 0) {
      supportedRank = candidate;
      break;
    }
  }
  if (supportedRank === -1) {
    throw new CeilingError(
      `${targetClass} supports no ceiling for this evidence; its matrix tops out at ${CEILING_ORDER[allowed]} and the requested ${requested} is not grant-backed`,
      { targetClass },
    );
  }
  if (supportedRank === requestedRank) {
    return { requested, ceiling: requested, downgraded_by: [] };
  }

  const required = SUPPORT[targetClass]?.[requested] ?? [];
  const downgradedBy =
    required.length > 0
      ? required.map((tag) => `${targetClass}:no-${tag}`)
      : [`${targetClass}:ceiling-not-permitted`];
  return {
    requested,
    ceiling: CEILING_ORDER[supportedRank],
    downgraded_by: downgradedBy,
  };
}
