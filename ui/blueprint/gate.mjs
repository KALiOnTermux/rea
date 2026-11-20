/**
 * The fail-closed gate (spec §8).
 *
 * Every check answers one question about support, and any answer that cannot be
 * decided is a violation: the gate never treats "unknown" as "fine". `status` is
 * `complete` only when the violation list is empty *and* the ledger closes at
 * ratio 1, so coverage can no longer be claimed by a threshold or by prose.
 *
 * The gate is pure: it reads the package and the context it is handed, and it
 * never touches the clock, the environment or the filesystem by itself.
 */

import { CEILING_ORDER } from "./ceiling.mjs";
import { closure, ledgerViolations, OUT_OF_SCOPE_SHARE } from "./ledger.mjs";
import { verifyManifest } from "./manifest.mjs";

export const VIOLATION_CODES = [
  "claim.evidence.unresolved",
  "claim.observed.without_evidence",
  "claim.derived.without_derivation",
  "claim.derived.forward_reference",
  "claim.assumed.without_resolution",
  "claim.ceiling.exceeds_run",
  "claim.falsifier.missing",
  "claim.falsifier.not_executable",
  "ledger.denominator.mismatch",
  "ledger.denominator.empty",
  "ledger.item.unknown",
  "ledger.out_of_scope.exceeded",
  "bundle.entry.omitted",
  "acceptance.criterion.missing",
  "acceptance.criterion.unexecutable",
  "render.not_deterministic",
  "manifest.hash_mismatch",
];

const RUNTIME_CHECK_KINDS = ["http", "dom", "function", "process", "state"];
const HARNESS_CHECK_KINDS = ["function", "process", "state"];

export class BlueprintGateError extends Error {
  constructor(result, message) {
    const count = result?.violations?.length ?? 0;
    super(
      message ??
        `the blueprint package is not acceptable: ${count} violation(s), coverage ${result?.coverage ?? 0}`,
    );
    this.name = "BlueprintGateError";
    this.code = "blueprint.gate";
    this.violations = result?.violations ?? [];
    this.coverage = result?.coverage ?? 0;
  }
}

function compareStrings(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function rank(ceiling) {
  const index = CEILING_ORDER.indexOf(ceiling);
  return index === -1 ? CEILING_ORDER.length : index;
}

function checkIsExecutable(check, ctx) {
  const kind = check?.kind;
  if (kind === "structure") return true;
  if (!RUNTIME_CHECK_KINDS.includes(kind)) return false;
  if (HARNESS_CHECK_KINDS.includes(kind)) return ctx?.harness === true;
  return true;
}

function violation(code, subject, detail) {
  return { code, subject, detail };
}

/** True when following derivation inputs from `start` returns to `start`. */
function reachesItself(start, byId) {
  const seen = new Set();
  const stack = [...asArray(byId.get(start)?.derivation?.inputs)];
  while (stack.length > 0) {
    const next = stack.pop();
    if (next === start) return true;
    if (seen.has(next)) continue;
    seen.add(next);
    stack.push(...asArray(byId.get(next)?.derivation?.inputs));
  }
  return false;
}

function checkEvidence(claim, files, violations) {
  const evidence = asArray(claim.evidence);
  if (claim.kind === "observed" && evidence.length === 0) {
    violations.push(
      violation(
        "claim.observed.without_evidence",
        claim.id,
        "an observed claim without an evidence reference is an assertion",
      ),
    );
  }
  for (const ref of evidence) {
    if (!files.has(ref.path)) {
      violations.push(
        violation(
          "claim.evidence.unresolved",
          claim.id,
          `evidence ${ref.path} is not part of the package`,
        ),
      );
    }
  }
}

function checkDerivation(claim, byId, violations) {
  if (claim.kind !== "derived") return;
  const derivation = claim.derivation;
  if (
    !derivation ||
    !Array.isArray(derivation.inputs) ||
    derivation.inputs.length === 0
  ) {
    violations.push(
      violation(
        "claim.derived.without_derivation",
        claim.id,
        "a derived claim needs a derivation with at least one input",
      ),
    );
    return;
  }
  for (const input of derivation.inputs) {
    if (!byId.has(input)) {
      violations.push(
        violation(
          "claim.derived.forward_reference",
          claim.id,
          `derivation input ${input} does not exist before this claim`,
        ),
      );
    }
  }
  if (reachesItself(claim.id, byId)) {
    violations.push(
      violation(
        "claim.derived.forward_reference",
        claim.id,
        "the derivation chain returns to this claim, so it never reaches an observation",
      ),
    );
  }
}

function checkAssumption(claim, violations) {
  if (claim.kind !== "assumed") return;
  const resolution = claim.assumption?.resolution;
  if (typeof resolution !== "string" || resolution.trim() === "") {
    violations.push(
      violation(
        "claim.assumed.without_resolution",
        claim.id,
        "an assumed claim needs assumption.resolution naming the probing check",
      ),
    );
  }
}

function checkCeiling(claim, runCeiling, violations) {
  if (
    typeof runCeiling !== "string" ||
    rank(claim.ceiling) <= rank(runCeiling)
  ) {
    return;
  }
  violations.push(
    violation(
      "claim.ceiling.exceeds_run",
      claim.id,
      `claim ceiling ${claim.ceiling} exceeds the run ceiling ${runCeiling}`,
    ),
  );
}

function checkFalsifier(claim, { checks, entries, ctx }, violations) {
  const falsifier = claim.falsifier;
  if (typeof falsifier !== "string" || falsifier.trim() === "") {
    violations.push(
      violation("claim.falsifier.missing", claim.id, "claim has no falsifier"),
    );
    return;
  }
  const isGap = falsifier.startsWith("gap:");
  const resolves = isGap
    ? entries.has(falsifier.slice(4))
    : checks.has(falsifier);
  if (!resolves) {
    violations.push(
      violation(
        "claim.falsifier.missing",
        claim.id,
        `falsifier ${falsifier} resolves to nothing in the package`,
      ),
    );
    return;
  }
  if (claim.kind !== "observed" || claim.ceiling !== "executed") return;
  const check = isGap ? null : checks.get(falsifier);
  const executable =
    check !== null &&
    checkIsExecutable(check, ctx) &&
    RUNTIME_CHECK_KINDS.includes(check.kind);
  if (!executable) {
    violations.push(
      violation(
        "claim.falsifier.not_executable",
        claim.id,
        `falsifier ${falsifier} cannot falsify an executed observation`,
      ),
    );
  }
}

function checkClaims({
  claims,
  blueprint,
  ledger,
  acceptance,
  ctx,
  violations,
}) {
  const byId = new Map(claims.map((claim) => [claim.id, claim]));
  const files = new Set(asArray(ctx?.files));
  const checks = new Map(
    asArray(acceptance?.checks).map((check) => [check.id, check]),
  );
  const entries = new Set(asArray(ledger?.entries).map((entry) => entry.id));
  const runCeiling = blueprint?.ceiling?.ceiling;
  for (const claim of claims) {
    checkEvidence(claim, files, violations);
    checkDerivation(claim, byId, violations);
    checkAssumption(claim, violations);
    checkCeiling(claim, runCeiling, violations);
    checkFalsifier(claim, { checks, entries, ctx }, violations);
  }
}

function checkLedger({ ledger, claims, ctx, violations }) {
  if (!ledger || typeof ledger !== "object") {
    violations.push(
      violation(
        "ledger.denominator.empty",
        "ledger",
        "the package carries no closure ledger",
      ),
    );
    return;
  }
  const claimIds = new Set(asArray(claims).map((claim) => claim.id));
  for (const item of ledgerViolations(ledger)) {
    if (item.code === "ledger.item.unknown") {
      violations.push(
        violation("ledger.item.unknown", item.subject, item.detail),
      );
      continue;
    }
    violations.push(violation(item.code, item.subject, item.detail));
  }
  const files = new Set(asArray(ctx?.files));
  for (const entry of asArray(ledger.entries)) {
    // spec §6: every `source` reference must resolve, so an entry cannot point at
    // provenance the package does not contain.
    if (entry.source !== undefined) {
      const path = entry.source?.path;
      if (typeof path !== "string" || !files.has(path)) {
        violations.push(
          violation(
            "ledger.item.unknown",
            entry.id,
            `ledger entry ${entry.id} cites the source ${String(path)}, which the package does not contain`,
          ),
        );
      }
    }
    for (const id of asArray(entry.claims)) {
      if (!claimIds.has(id)) {
        violations.push(
          violation(
            "ledger.item.unknown",
            entry.id,
            `ledger entry ${entry.id} cites the unknown claim ${id}`,
          ),
        );
      }
    }
  }
  const items = asArray(ledger.denominators).reduce(
    (sum, item) => sum + (Number.isInteger(item.items) ? item.items : 0),
    0,
  );
  const outOfScope = asArray(ledger.entries).filter(
    (entry) => entry.status === "out_of_scope",
  );
  const allowed = Math.floor(items * OUT_OF_SCOPE_SHARE);
  if (outOfScope.length > allowed) {
    violations.push(
      violation(
        "ledger.out_of_scope.exceeded",
        "ledger",
        `${outOfScope.length} out_of_scope entries exceed the cap of ${allowed}`,
      ),
    );
  }
}

function checkAcceptance({ blueprint, acceptance, ctx, violations }) {
  const checks = asArray(acceptance?.checks);
  const declared = asArray(blueprint?.acceptance);
  if (declared.length === 0) {
    violations.push(
      violation(
        "acceptance.criterion.missing",
        "package",
        "the package declares no acceptance criterion it can check",
      ),
    );
    return;
  }
  for (const criterion of declared) {
    const matching = checks.filter((check) => check.criterion === criterion);
    if (matching.length === 0) {
      violations.push(
        violation(
          "acceptance.criterion.missing",
          criterion,
          `acceptance criterion ${criterion} has no executable check`,
        ),
      );
      continue;
    }
    if (!matching.some((check) => checkIsExecutable(check, ctx))) {
      violations.push(
        violation(
          "acceptance.criterion.unexecutable",
          criterion,
          `acceptance criterion ${criterion} has no check this run can execute`,
        ),
      );
    }
  }
}

function checkBundle({ ctx, violations }) {
  for (const path of asArray(ctx?.omitted)) {
    violations.push(
      violation(
        "bundle.entry.omitted",
        path,
        `the bundle leaves out ${path}, so its claims cannot be re-checked from the package`,
      ),
    );
  }
}

function checkRender({ ctx, violations }) {
  if (typeof ctx?.renderMarkdown !== "function") return;
  const first = ctx.renderMarkdown();
  const second = ctx.renderMarkdown();
  if (first !== second) {
    violations.push(
      violation(
        "render.not_deterministic",
        "BLUEPRINT.md",
        "two renders of the same input differ",
      ),
    );
    return;
  }
  if (typeof ctx.markdown === "string" && first !== ctx.markdown) {
    violations.push(
      violation(
        "render.not_deterministic",
        "BLUEPRINT.md",
        "the rendered markdown differs from the packaged BLUEPRINT.md",
      ),
    );
  }
}

function checkManifest({ manifest, ctx, violations }) {
  if (!manifest || typeof ctx?.readFile !== "function") return;
  const result = verifyManifest(manifest, ctx.readFile);
  for (const item of result.violations) {
    violations.push(
      violation("manifest.hash_mismatch", item.subject, item.detail),
    );
  }
}

/**
 * Gate over one compiled package (spec §8: `gate(bp, ledger, acceptance, ctx)`).
 *
 * The claims come from the IR itself and the manifest travels in `ctx`, so the
 * signature stays the one the spec declares. Any undecidable support is a
 * violation.
 */
export function gate(bp, ledger = null, acceptance = null, ctx = {}) {
  const blueprint = bp;
  const claims = asArray(bp?.claims);
  const manifest = ctx?.manifest ?? null;
  const violations = [];
  checkClaims({ claims, blueprint, ledger, acceptance, ctx, violations });
  checkLedger({ ledger, claims, ctx, violations });
  checkAcceptance({ blueprint, acceptance, ctx, violations });
  checkBundle({ ctx, violations });
  checkRender({ ctx, violations });
  checkManifest({ manifest, ctx, violations });

  violations.sort(
    (left, right) =>
      compareStrings(left.code, right.code) ||
      compareStrings(left.subject, right.subject),
  );
  const ok = violations.length === 0;
  // Recomputed from the entries, never read from the ledger's own closure block:
  // a stale or edited block must not be able to claim completeness.
  const coverage = closure(ledger).ratio;
  let status = "open";
  if (ok && coverage === 1) status = "complete";
  else if (coverage > 0 || asArray(claims).length > 0) status = "partial";

  return { ok, status, coverage, violations };
}
