/**
 * Typed claim records for the blueprint claim compiler.
 *
 * A claim is the smallest assertable statement a package may make. Its `kind`
 * decides what support it needs: an `observed` claim needs evidence a probe
 * recorded, a `derived` claim needs a named rule and its inputs, and an
 * `assumed` claim needs the probe or check that would resolve it together with
 * the `inferred-only` ceiling. Rendering keeps the three kinds in separate
 * sections, so the separation is a property of the record, not of an author's
 * care.
 *
 * `makeClaim` enforces the shape and throws `ClaimShapeError`; the returned
 * violations of `validateClaim` use the gate codes from the spec so the gate can
 * reuse them verbatim. Structural defects (a missing field, a malformed evidence
 * entry) throw instead of becoming violations, because they are producer bugs
 * rather than unsupported assertions.
 */

export const CLAIM_KINDS = ["observed", "derived", "assumed"];

export const CEILINGS = ["executed", "statically-evidenced", "inferred-only"];

const SLUG_DISALLOWED = /[^a-z0-9./-]+/g;
const EDGE_DASHES = /^-+|-+$/g;

export class ClaimShapeError extends Error {
  constructor(message, { code = "claim.shape", field = null } = {}) {
    super(message);
    this.name = "ClaimShapeError";
    this.code = code;
    this.field = field;
  }
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function compareStrings(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * Builds a stable slug from the given parts, joined with `.`.
 *
 * The parts name the target kind and the subject (`claimId("web.route", "POST
 * /api/orders")`), so two runs over different target classes cannot collide on
 * the same id. The result only contains `[a-z0-9./-]`.
 */
export function claimId(...parts) {
  if (parts.length === 0) {
    throw new ClaimShapeError("claimId requires at least one part", {
      field: "id",
    });
  }
  for (const part of parts) {
    if (!isNonEmptyString(part)) {
      throw new ClaimShapeError("claimId part must be a non-empty string", {
        field: "id",
      });
    }
  }
  const slug = parts
    .join(".")
    .toLowerCase()
    .replace(SLUG_DISALLOWED, "-")
    .replace(EDGE_DASHES, "");
  if (!/[a-z0-9]/.test(slug)) {
    throw new ClaimShapeError(
      `claimId part is empty after normalisation: ${parts.join(" ")}`,
      { field: "id" },
    );
  }
  return slug;
}

function requiredString(input, field) {
  const value = input[field];
  if (!isNonEmptyString(value)) {
    throw new ClaimShapeError(`claim.${field} must be a non-empty string`, {
      field,
    });
  }
  return value;
}

function normaliseEvidence(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new ClaimShapeError("claim.evidence must be an array", {
      field: "evidence",
    });
  }
  return value.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ClaimShapeError(`claim.evidence[${index}] must be an object`, {
        field: "evidence",
      });
    }
    if (!isNonEmptyString(entry.path)) {
      throw new ClaimShapeError(
        `claim.evidence[${index}].path must be a non-empty string`,
        { field: "evidence" },
      );
    }
    return { ...entry };
  });
}

function normaliseLimits(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new ClaimShapeError("claim.limits must be an array", {
      field: "limits",
    });
  }
  const limits = value.map((limit, index) => {
    if (!isNonEmptyString(limit)) {
      throw new ClaimShapeError(
        `claim.limits[${index}] must be a non-empty string`,
        { field: "limits" },
      );
    }
    return limit;
  });
  return [...new Set(limits)].sort(compareStrings);
}

function normaliseDerivation(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ClaimShapeError("claim.derivation must be an object", {
      field: "derivation",
    });
  }
  const derivation = { rule: requiredString(value, "rule") };
  if (value.inputs !== undefined) {
    if (!Array.isArray(value.inputs)) {
      throw new ClaimShapeError("claim.derivation.inputs must be an array", {
        field: "derivation",
      });
    }
    derivation.inputs = value.inputs.map((input, index) => {
      if (!isNonEmptyString(input)) {
        throw new ClaimShapeError(
          `claim.derivation.inputs[${index}] must be a non-empty string`,
          { field: "derivation" },
        );
      }
      return input;
    });
  }
  return derivation;
}

function normaliseAssumption(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ClaimShapeError("claim.assumption must be an object", {
      field: "assumption",
    });
  }
  const assumption = {
    statement: requiredString(value, "statement"),
    impact: requiredString(value, "impact"),
  };
  if (value.resolution !== undefined) {
    assumption.resolution = requiredString(value, "resolution");
  }
  return assumption;
}

/**
 * Validates a claim's support rules and returns violations with gate codes.
 *
 * Duplicate ids are a package-level property and are checked by
 * `assertUniqueClaimIds`; a falsifier is resolved against the acceptance file by
 * the gate.
 */
export function validateClaim(claim) {
  if (claim === null || typeof claim !== "object") {
    throw new ClaimShapeError("claim must be an object", { field: "claim" });
  }
  if (!CLAIM_KINDS.includes(claim.kind)) {
    throw new ClaimShapeError(
      `claim.kind must be one of ${CLAIM_KINDS.join(", ")}`,
      { field: "kind" },
    );
  }
  const subject = isNonEmptyString(claim.id) ? claim.id : "(unknown claim)";
  const violations = [];
  const push = (code, detail) => violations.push({ code, subject, detail });

  if (!CEILINGS.includes(claim.ceiling)) {
    push(
      "claim.ceiling.invalid",
      `ceiling ${JSON.stringify(claim.ceiling)} is not one of ${CEILINGS.join(", ")}`,
    );
  }

  if (claim.kind === "observed" && (claim.evidence ?? []).length === 0) {
    push(
      "claim.observed.without_evidence",
      "observed claim requires at least one evidence entry",
    );
  }

  if (claim.kind === "derived") {
    const derivation = claim.derivation;
    if (
      !derivation ||
      !isNonEmptyString(derivation.rule) ||
      !Array.isArray(derivation.inputs) ||
      derivation.inputs.length === 0
    ) {
      push(
        "claim.derived.without_derivation",
        "derived claim requires a derivation { rule, inputs } with at least one input",
      );
    }
  }

  if (claim.kind === "assumed") {
    const assumption = claim.assumption;
    if (!assumption || !isNonEmptyString(assumption.resolution)) {
      push(
        "claim.assumed.without_resolution",
        "assumed claim requires assumption.resolution naming the probe or check that would resolve it",
      );
    }
    if (claim.ceiling !== "inferred-only") {
      push(
        "claim.ceiling.invalid",
        "assumed claims are limited to the inferred-only ceiling",
      );
    }
  }

  return { ok: violations.length === 0, violations };
}

/**
 * Normalises a claim record, then refuses it unless its support rules hold.
 */
export function makeClaim(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ClaimShapeError("claim must be an object", { field: "claim" });
  }

  const claim = {
    id: requiredString(input, "id"),
    statement: requiredString(input, "statement"),
    kind: requiredString(input, "kind"),
    ceiling: requiredString(input, "ceiling"),
    evidence: normaliseEvidence(input.evidence),
    falsifier: requiredString(input, "falsifier"),
    limits: normaliseLimits(input.limits),
  };
  if (input.subject !== undefined) {
    claim.subject = requiredString(input, "subject");
  }
  if (input.derivation !== undefined) {
    claim.derivation = normaliseDerivation(input.derivation);
  }
  if (input.assumption !== undefined) {
    claim.assumption = normaliseAssumption(input.assumption);
  }

  const result = validateClaim(claim);
  if (!result.ok) {
    const [first] = result.violations;
    throw new ClaimShapeError(
      result.violations.map((violation) => violation.detail).join("; "),
      { code: first.code, field: first.subject },
    );
  }
  return claim;
}

/** Sorts claims by id without touching the caller's array. */
export function sortClaims(claims) {
  if (!Array.isArray(claims)) {
    throw new ClaimShapeError("claims must be an array", { field: "claims" });
  }
  return [...claims].sort((left, right) => compareStrings(left.id, right.id));
}

/**
 * Refuses a package whose claim ids repeat.
 *
 * Ids are prefixed by target kind in `claimId`, so a web and an apk run sharing
 * an artifact directory stay distinguishable.
 */
export function assertUniqueClaimIds(claims) {
  if (!Array.isArray(claims)) {
    throw new ClaimShapeError("claims must be an array", { field: "claims" });
  }
  const seen = new Set();
  for (const claim of claims) {
    const id = claim?.id;
    if (!isNonEmptyString(id)) {
      throw new ClaimShapeError("claim.id must be a non-empty string", {
        field: "id",
      });
    }
    if (seen.has(id)) {
      throw new ClaimShapeError(
        `claim.id.duplicate: ${id} appears more than once in the package`,
        { code: "claim.id.duplicate", field: "id" },
      );
    }
    seen.add(id);
  }
  return claims;
}
