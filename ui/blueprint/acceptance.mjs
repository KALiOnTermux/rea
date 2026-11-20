/**
 * The acceptance file (spec §9).
 *
 * A criterion without an executable check is a promise, not a test, so the file
 * is a list of checks and every check names the kind that executes it. The gate
 * resolves each claim's `falsifier` against this list, which is what makes "no
 * criterion without a test" mechanical instead of a review opinion.
 *
 * `buildAcceptance` only normalises and refuses; it never invents a check.
 */

export const ACCEPTANCE_SCHEMA = "rea.blueprint.acceptance";
export const ACCEPTANCE_SCHEMA_VERSION = 1;

/** The six kinds from spec §9, in the order the spec lists them. */
export const CHECK_KINDS = [
  "http",
  "dom",
  "function",
  "state",
  "process",
  "structure",
];

const STATUSES = ["passed", "failed", "skipped", "unexecutable"];

export class AcceptanceError extends Error {
  constructor(message, { code = "blueprint.acceptance" } = {}) {
    super(message);
    this.name = "AcceptanceError";
    this.code = code;
  }
}

function compareStrings(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function normaliseCheck(raw, index) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AcceptanceError(`check[${index}] must be an object`);
  }
  if (!isNonEmptyString(raw.id)) {
    throw new AcceptanceError(`check[${index}].id must be a non-empty string`);
  }
  if (!CHECK_KINDS.includes(raw.kind)) {
    throw new AcceptanceError(
      `check ${raw.id} has the kind ${JSON.stringify(raw.kind)}; one of ${CHECK_KINDS.join(", ")} is required`,
    );
  }
  if (!isNonEmptyString(raw.criterion)) {
    throw new AcceptanceError(
      `check ${raw.id} needs a criterion; a check without one proves nothing`,
    );
  }
  const check = {
    id: raw.id,
    kind: raw.kind,
    criterion: raw.criterion,
    fixture: isNonEmptyString(raw.fixture) ? raw.fixture : null,
  };
  for (const field of [
    "request",
    "selector",
    "expect",
    "module",
    "export",
    "trace",
    "allowed",
    "argv",
    "paths",
    "selectors",
    "requests",
  ]) {
    if (raw[field] !== undefined) check[field] = raw[field];
  }
  return check;
}

/** Builds the acceptance file, sorted by id, refusing duplicates and unknown kinds. */
export function buildAcceptance({ checks } = {}) {
  if (!Array.isArray(checks)) {
    throw new AcceptanceError("acceptance.checks must be an array");
  }
  const seen = new Set();
  const normalised = checks.map((raw, index) => {
    const check = normaliseCheck(raw, index);
    if (seen.has(check.id)) {
      throw new AcceptanceError(
        `duplicate check id ${check.id}; a falsifier must resolve to exactly one check`,
      );
    }
    seen.add(check.id);
    return check;
  });
  normalised.sort((left, right) => compareStrings(left.id, right.id));
  return {
    schema: ACCEPTANCE_SCHEMA,
    schema_version: ACCEPTANCE_SCHEMA_VERSION,
    checks: normalised,
  };
}

/** One line per criterion plus the counts a reviewer reads first. */
export function renderAcceptanceReport(verdicts) {
  const list = Array.isArray(verdicts) ? verdicts : [];
  const counts = Object.fromEntries(STATUSES.map((status) => [status, 0]));
  const lines = list.map((verdict) => {
    const status = STATUSES.includes(verdict.status)
      ? verdict.status
      : "unexecutable";
    counts[status] += 1;
    const reason = verdict.reason ? ` (${verdict.reason})` : "";
    return `- ${status} · ${verdict.id} · ${verdict.criterion}${reason}${verdict.detail ? ` — ${verdict.detail}` : ""}`;
  });
  const summary = STATUSES.map((status) => `${counts[status]} ${status}`).join(
    ", ",
  );
  return [`Abnahme: ${summary}`, "", ...lines].join("\n");
}
