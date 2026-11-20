/**
 * Acceptance checks derived from claims (spec §9, Task 14).
 *
 * The direction matters: a check is not written next to a claim by hand, it is
 * derived from what the claim already observed, so the criterion and its test
 * cannot drift apart. An observed claim over a network transcript yields an
 * `http` check over the same `request` selector, a DOM observation yields a `dom`
 * check over the same selector, an evidence-file observation yields a `structure`
 * check for that path.
 *
 * A derived claim rests on its inputs and keeps its `gap:` falsifier. An assumed
 * claim gets no check at all: it must stay a recorded gap, which is what
 * `falsifier: "gap:<entry>"` says. A falsifier that names an acceptance check the
 * emission did not produce is reported as `claim.falsifier.missing` instead of
 * being quietly dropped.
 */

import { buildAcceptance } from "./acceptance.mjs";

function compareStrings(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function checkForClaim(claim) {
  if (claim?.kind !== "observed") return null;
  const evidence = Array.isArray(claim.evidence) ? claim.evidence[0] : null;
  const selector = evidence?.selector;
  if (!selector || typeof selector.type !== "string") return null;
  const base = {
    id: `acceptance.${claim.id}`,
    criterion: claim.statement,
    fixture: evidence.path,
  };
  if (selector.type === "request") {
    return { ...base, kind: "http", request: { selector: { ...selector } } };
  }
  if (selector.type === "dom") {
    return { ...base, kind: "dom", selector: { ...selector } };
  }
  if (selector.type === "whole") {
    return { ...base, kind: "structure", paths: [evidence.path] };
  }
  return null;
}

function entryForClaim(entries, claimId) {
  return (
    entries.find((entry) => (entry.claims ?? []).includes(claimId)) ?? null
  );
}

/**
 * Emits the acceptance file and rewrites each claim's falsifier to the check that
 * now falsifies it, so a claim and its test always name each other.
 */
export function emitAcceptance({ claims, ledger } = {}) {
  const list = Array.isArray(claims) ? claims : [];
  const entries = Array.isArray(ledger?.entries) ? ledger.entries : [];
  const checks = [];
  const rewritten = [];

  for (const claim of list) {
    const check = checkForClaim(claim);
    if (check) {
      checks.push(check);
      rewritten.push({ ...claim, falsifier: check.id });
      continue;
    }
    if (claim.kind === "assumed") {
      const entry = entryForClaim(entries, claim.id);
      rewritten.push(
        entry ? { ...claim, falsifier: `gap:${entry.id}` } : { ...claim },
      );
      continue;
    }
    rewritten.push({ ...claim });
  }

  const acceptance = buildAcceptance({ checks });
  const ids = new Set(acceptance.checks.map((check) => check.id));
  const missing = [];
  for (const claim of rewritten) {
    const falsifier = claim.falsifier;
    if (
      typeof falsifier === "string" &&
      falsifier.startsWith("acceptance.") &&
      !ids.has(falsifier)
    ) {
      missing.push({
        claim: claim.id,
        code: "claim.falsifier.missing",
        detail: `falsifier ${falsifier} names a check the emission does not produce`,
      });
    }
  }
  missing.sort((left, right) => compareStrings(left.claim, right.claim));
  return { acceptance, claims: rewritten, missing };
}
