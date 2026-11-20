/**
 * The closure ledger (spec §6, R5).
 *
 * A count threshold cannot tell "covered" from "not looked at", so the ledger
 * declares its denominator per class from the probe that enumerated it and then
 * demands exactly one entry per enumerated item. Set equality is the contract:
 * an extra entry is as wrong as a missing one.
 *
 * `ratio` is `covered / (covered + gap)`. `out_of_scope` items are outside that
 * ratio on purpose, but they are capped at ten percent of the denominator and
 * need a reason, so a package cannot talk its way out of coverage.
 *
 * Entry ids are always `<class>:<subject>`, which is what makes a `gap:` falsifier
 * resolvable: the claim and the ledger entry name the same string.
 */

import { CEILING_ORDER } from "./ceiling.mjs";
import { nativeDenominators, nativeEntries } from "./denominators/native.mjs";
import { sourceDenominators, sourceEntries } from "./denominators/source.mjs";
import { webDenominators, webEntries } from "./denominators/web.mjs";

export const LEDGER_SCHEMA = "rea.blueprint.ledger";
export const LEDGER_SCHEMA_VERSION = 1;
export const OUT_OF_SCOPE_SHARE = 0.1;

const PROBE_NAME = /^[a-z0-9]+(\.[a-z0-9-]+)+$/;
const STATUSES = ["covered", "gap", "out_of_scope"];

export class LedgerError extends Error {
  constructor(message, { code = "blueprint.ledger" } = {}) {
    super(message);
    this.name = "LedgerError";
    this.code = code;
  }
}

function compareStrings(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

/** Declares one denominator: the probe, how many items it enumerated and its blind spots. */
export function denominator({ class: cls, probe, items, blind_spots } = {}) {
  if (!isNonEmptyString(cls)) {
    throw new LedgerError("denominator.class must be a non-empty string");
  }
  if (!isNonEmptyString(probe) || !PROBE_NAME.test(probe)) {
    throw new LedgerError(
      `denominator.probe must look like "web.route-scan", got ${JSON.stringify(probe)}`,
    );
  }
  if (!Number.isInteger(items) || items < 0) {
    throw new LedgerError(
      `denominator.items for ${cls} must be a non-negative integer, got ${JSON.stringify(items)}`,
    );
  }
  if (
    !Array.isArray(blind_spots) ||
    blind_spots.some((spot) => !isNonEmptyString(spot))
  ) {
    throw new LedgerError(
      `denominator.blind_spots for ${cls} must be an array of non-empty strings`,
    );
  }
  return { class: cls, probe, items, blind_spots: [...blind_spots] };
}

function normaliseEntry(raw) {
  if (raw === null || typeof raw !== "object") {
    throw new LedgerError("ledger entry must be an object");
  }
  const { class: cls, subject, status } = raw;
  if (!isNonEmptyString(cls)) {
    throw new LedgerError("ledger entry.class must be a non-empty string");
  }
  if (!isNonEmptyString(subject)) {
    throw new LedgerError(`ledger entry ${cls} needs a non-empty subject`);
  }
  const expectedId = `${cls}:${subject}`;
  if (raw.id !== expectedId) {
    throw new LedgerError(
      `ledger entry id must be class:subject, got ${JSON.stringify(raw.id)} instead of ${JSON.stringify(expectedId)}`,
    );
  }
  if (!STATUSES.includes(status)) {
    throw new LedgerError(
      `ledger entry ${expectedId} has an unknown status ${JSON.stringify(status)}`,
    );
  }
  const claims = Array.isArray(raw.claims) ? raw.claims : [];
  if (claims.some((claim) => !isNonEmptyString(claim))) {
    throw new LedgerError(
      `ledger entry ${expectedId} has a non-string claim id`,
    );
  }
  if (status === "gap") {
    const gap = raw.gap;
    if (
      !gap ||
      !isNonEmptyString(gap.id) ||
      !isNonEmptyString(gap.why) ||
      !isNonEmptyString(gap.action) ||
      typeof gap.blocking !== "boolean"
    ) {
      throw new LedgerError(
        `ledger entry ${expectedId} is a gap and needs gap { id, why, action, blocking }`,
      );
    }
  }
  if (status === "out_of_scope" && !isNonEmptyString(raw.reason)) {
    throw new LedgerError(
      `ledger entry ${expectedId} is out of scope and needs a reason`,
    );
  }
  const entry = {
    ...raw,
    id: expectedId,
    claims: [...claims].sort(compareStrings),
  };
  return entry;
}

/** Merges entries that name the same class and subject, unioning their claims. */
function mergeEntries(entries) {
  const byId = new Map();
  for (const entry of entries.map(normaliseEntry)) {
    const existing = byId.get(entry.id);
    if (!existing) {
      byId.set(entry.id, entry);
      continue;
    }
    if (existing.status !== entry.status) {
      throw new LedgerError(
        `ledger entry ${entry.id} appears with conflicting statuses ${existing.status} and ${entry.status}`,
      );
    }
    existing.claims = [...new Set([...existing.claims, ...entry.claims])].sort(
      compareStrings,
    );
    existing.gap = existing.gap ?? entry.gap;
    existing.reason = existing.reason ?? entry.reason;
    existing.source = existing.source ?? entry.source;
  }
  return [...byId.values()].sort((left, right) =>
    compareStrings(left.id, right.id),
  );
}

/** `covered / (covered + gap)`, rounded to four decimals; 0 instead of NaN. */
export function closure(ledger) {
  const entries = Array.isArray(ledger?.entries) ? ledger.entries : [];
  const count = (status) =>
    entries.filter((entry) => entry.status === status).length;
  const covered = count("covered");
  const gap = count("gap");
  const outOfScope = count("out_of_scope");
  return {
    covered,
    gap,
    out_of_scope: outOfScope,
    ratio: covered + gap === 0 ? 0 : round4(covered / (covered + gap)),
  };
}

/**
 * Builds the ledger and enforces set equality between denominator and entries.
 *
 * Throws `LedgerError` when the denominator cannot be closed; an empty
 * denominator is not an error but a recorded violation, because a run that
 * enumerated nothing must not divide by zero and must not claim completeness.
 */
export function buildLedger({
  ceiling,
  denominators,
  entries,
  blind_spots,
} = {}) {
  if (!CEILING_ORDER.includes(ceiling)) {
    throw new LedgerError(
      `ledger ceiling must be one of ${CEILING_ORDER.join(", ")}, got ${JSON.stringify(ceiling)}`,
    );
  }
  if (!Array.isArray(denominators)) {
    throw new LedgerError("denominators must be an array");
  }
  const seenClasses = new Set();
  for (const item of denominators) {
    if (seenClasses.has(item.class)) {
      throw new LedgerError(
        `denominator class ${item.class} is declared twice; one probe per class`,
      );
    }
    seenClasses.add(item.class);
  }
  const sortedDenominators = [...denominators].sort((left, right) =>
    compareStrings(left.class, right.class),
  );
  const merged = mergeEntries(Array.isArray(entries) ? entries : []);

  const byClass = new Map(sortedDenominators.map((item) => [item.class, []]));
  for (const entry of merged) {
    const bucket = byClass.get(entry.class);
    if (!bucket) {
      throw new LedgerError(
        `ledger entry ${entry.id} belongs to the class ${entry.class}, which has no denominator`,
      );
    }
    bucket.push(entry);
  }
  for (const item of sortedDenominators) {
    const bucket = byClass.get(item.class);
    if (bucket.length < item.items) {
      throw new LedgerError(
        `denominator ${item.class} enumerates ${item.items} item(s) but only ${bucket.length} are accounted for; ${item.items - bucket.length} unaccounted`,
      );
    }
    if (bucket.length > item.items) {
      throw new LedgerError(
        `denominator ${item.class} enumerates ${item.items} item(s) but ${bucket.length} entries are listed; the entry set does not match the denominator`,
      );
    }
  }

  const totalItems = sortedDenominators.reduce(
    (sum, item) => sum + item.items,
    0,
  );
  const outOfScope = merged.filter((entry) => entry.status === "out_of_scope");
  const allowedOutOfScope = Math.floor(totalItems * OUT_OF_SCOPE_SHARE);
  if (outOfScope.length > allowedOutOfScope) {
    throw new LedgerError(
      `${outOfScope.length} out_of_scope entries exceed the cap of ${allowedOutOfScope} (ten percent of ${totalItems})`,
    );
  }

  const ledger = {
    schema: LEDGER_SCHEMA,
    schema_version: LEDGER_SCHEMA_VERSION,
    ceiling,
    denominators: sortedDenominators,
    entries: merged,
  };
  if (Array.isArray(blind_spots) && blind_spots.length > 0) {
    ledger.blind_spots = [...blind_spots];
  }
  ledger.closure = closure(ledger);
  return ledger;
}

/**
 * Ledger violations the gate reports: an empty denominator is a recorded defect,
 * not a crash, because the run still has to produce its package.
 */
export function ledgerViolations(ledger) {
  const violations = [];
  for (const item of ledger?.denominators ?? []) {
    if (item.items === 0) {
      violations.push({
        code: "ledger.denominator.empty",
        subject: item.class,
        detail: `denominator ${item.class} (${item.probe}) enumerated no items; coverage cannot be measured`,
      });
    }
  }
  const byClass = new Map(
    (ledger?.denominators ?? []).map((item) => [item.class, 0]),
  );
  for (const entry of ledger?.entries ?? []) {
    if (!byClass.has(entry.class)) {
      violations.push({
        code: "ledger.item.unknown",
        subject: entry.id,
        detail: `ledger entry ${entry.id} belongs to the unknown class ${entry.class}`,
      });
      continue;
    }
    byClass.set(entry.class, byClass.get(entry.class) + 1);
  }
  for (const item of ledger?.denominators ?? []) {
    if ((byClass.get(item.class) ?? 0) !== item.items) {
      violations.push({
        code: "ledger.denominator.mismatch",
        subject: item.class,
        detail: `denominator ${item.class} enumerates ${item.items} item(s) but ${byClass.get(item.class) ?? 0} entries are listed`,
      });
    }
  }
  return violations;
}

/**
 * Denominators for the classes `toAnalysis` materialised itself.
 *
 * Classes the target class enumerates from its facts are skipped: those get the
 * enumeration's own probe, count and blind spots, and a class may only be
 * declared once.
 */
function ownDenominators(ownEntries, targetClass, enumerated) {
  const classes = [...new Set(ownEntries.map((entry) => entry.class))]
    .filter((cls) => !enumerated.has(cls))
    .sort(compareStrings);
  return classes.map((cls) =>
    denominator({
      class: cls,
      probe: `${targetClass}.${cls}-scan`,
      items: ownEntries.filter((entry) => entry.class === cls).length,
      blind_spots: [
        `${cls} wird aus der Erhebung abgeleitet; eine unabhängige Zählung am Ziel existiert nicht.`,
      ],
    }),
  );
}

/**
 * Denominator classes a target class enumerates from its own facts.
 *
 * A native binary is not a source tree: it has no resolved functions, routes or
 * exit paths, so the source classes would only ever report empty denominators.
 */
function classDenominators(analysis) {
  const kind = analysis?.target?.kind;
  if (kind === "web") return webDenominators(analysis);
  if (kind === "code" && analysis?.target?.platform !== "native") {
    return sourceDenominators(analysis);
  }
  if (kind === "apk") return nativeDenominators(analysis);
  return [];
}

/** The ledger entries matching `classDenominators`, each covered or a gap. */
function classEntries(analysis, claims) {
  const kind = analysis?.target?.kind;
  if (kind === "web") return webEntries(analysis, claims);
  if (kind === "code" && analysis?.target?.platform !== "native") {
    return sourceEntries(analysis, claims);
  }
  if (kind === "apk") return nativeEntries(analysis, claims);
  return [];
}

/** One gap per declared criterion that has no check in this run. */
function boundaryEntries(boundaries) {
  return boundaries.map((boundary) => {
    const id = `criterion:${boundary.criterion}`;
    return {
      id,
      class: "criterion",
      subject: boundary.criterion,
      source: { path: "acceptance.json", selector: { type: "whole" } },
      status: "gap",
      claims: [],
      gap: {
        id,
        why: boundary.why,
        action:
          "Beleg für dieses Kriterium aufnehmen und einen ausführbaren Check daraus ableiten.",
        blocking: false,
      },
    };
  });
}

/**
 * Files the bundle caps dropped (spec §6): a truncated source or evidence tree
 * must not let the package look closed, so each omission is a blocking gap.
 */
function omissionEntries(omitted) {
  return omitted.map((path) => ({
    id: `bundle:${path}`,
    class: "bundle",
    subject: path,
    status: "gap",
    claims: [],
    gap: {
      id: `bundle:${path}`,
      why: `Das Paket lässt ${path} aus, weil ein Bundle-Cap gegriffen hat.`,
      action:
        "Bundle-Cap anheben oder die Quelle verkleinern und die Blaupause neu erzeugen.",
      blocking: true,
    },
  }));
}

/**
 * Ledger over everything an analysis makes assertable.
 *
 * The entries `toAnalysis` already materialised (`evidence:<path>`, `step:<n>`,
 * `open-question:<id>`) keep their ids unchanged, so every `gap:` falsifier a
 * stage-2 claim carries resolves here. Each target class then adds the items it
 * enumerates itself: routes and DOM for web, symbols and exit paths for source,
 * screens and assets for an APK.
 */
export function ledgerFromAnalysis(analysis, { boundaries = [] } = {}) {
  const ownEntries = Array.isArray(analysis?.ledger) ? analysis.ledger : [];
  const claims = Array.isArray(analysis?.claims) ? analysis.claims : [];
  const targetClass = String(analysis?.target?.kind ?? "target")
    .replace(/[^a-z0-9]+/gi, "-")
    .toLowerCase();
  const omitted = Array.isArray(analysis?.omitted) ? analysis.omitted : [];
  const enumerated = classDenominators(analysis);
  const denominators = [
    ...ownDenominators(
      ownEntries,
      targetClass,
      new Set(enumerated.map((item) => item.class)),
    ),
    ...enumerated,
  ];
  // A declared criterion without a check is an open boundary, not a missing
  // line: it stays in the ledger as a gap that names why it cannot be tested.
  const boundaryList = Array.isArray(boundaries) ? boundaries : [];
  if (boundaryList.length > 0) {
    denominators.push(
      denominator({
        class: "criterion",
        probe: `${targetClass}.criterion-boundaries`,
        items: boundaryList.length,
        blind_spots: [
          "Diese Kriterien haben in diesem Lauf keinen ausführbaren Check; sie bleiben als offene Grenze stehen.",
        ],
      }),
    );
  }
  if (omitted.length > 0) {
    denominators.push(
      denominator({
        class: "bundle",
        probe: `${targetClass}.bundle-omissions`,
        items: omitted.length,
        blind_spots: [
          "Vom Bundle-Cap verworfene Dateien sind nicht prüfbar; sie bleiben als blockierende Lücke stehen.",
        ],
      }),
    );
  }
  return buildLedger({
    ceiling: analysis?.ceiling?.ceiling ?? "inferred-only",
    denominators,
    entries: [
      ...ownEntries,
      ...classEntries(analysis, claims),
      ...boundaryEntries(boundaryList),
      ...omissionEntries(omitted),
    ],
  });
}
