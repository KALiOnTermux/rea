/**
 * Coverage denominators for an APK and the ceiling rule for native binaries
 * (spec §4 and §6, Task 20).
 *
 * An APK run enumerates screens, exported components and assets from the facts
 * themselves; a native binary is different in kind, not degree: without a trace
 * probe nothing about its behaviour was observed, so the run may claim at most
 * `inferred-only` and every behavioural claim must be `derived` or `assumed`.
 *
 * `behaviourClaimViolations` is the check that keeps the second half honest — a
 * native package that types a behaviour claim `observed` is rejected by name
 * instead of being read as evidence.
 */

import { resolveCeiling } from "../ceiling.mjs";

const MANIFEST_SOURCE = "evidence/apk-package.json";
const COMPONENT_SOURCE = "surface/AndroidManifest.xml";
const ASSET_SOURCE = "evidence/apk-assets.json";

const BEHAVIOUR_SUBJECT = "/behavior";

function compareStrings(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function item(path, pointer, subject) {
  return {
    subject,
    source: { path, selector: { type: "pointer", pointer } },
  };
}

function screenItems(facts) {
  const screens = facts?.behavior?.screens ?? {};
  const activities = asArray(facts?.behavior?.activities).map((activity, i) =>
    item(
      MANIFEST_SOURCE,
      `/behavior/activities/${i}`,
      `screen:activity:${activity.name || i}`,
    ),
  );
  const layouts = asArray(screens.layouts).map((layout, i) =>
    item(
      MANIFEST_SOURCE,
      `/behavior/screens/layouts/${i}`,
      `screen:layout:${layout}`,
    ),
  );
  const fragments = asArray(screens.fragments).map((fragment, i) =>
    item(
      MANIFEST_SOURCE,
      `/behavior/screens/fragments/${i}`,
      `screen:fragment:${fragment.name || fragment || i}`,
    ),
  );
  return [...activities, ...layouts, ...fragments];
}

function exportedItems(facts) {
  return asArray(facts?.behavior?.exported).map((entry, i) =>
    item(
      COMPONENT_SOURCE,
      `/behavior/exported/${i}`,
      `symbol:${entry.kind || "component"}:${entry.name || i}`,
    ),
  );
}

function assetItems(facts) {
  return asArray(facts?.internals?.assets).map((path, i) =>
    item(ASSET_SOURCE, `/assets/${i}`, path),
  );
}

const BLIND_SPOTS = {
  asset: [
    "Nur im APK enthaltene Assets; zur Laufzeit heruntergeladene oder erzeugte Dateien fehlen.",
  ],
  "exported-symbol": [
    "Nur im Manifest deklarierte und exportierte Komponenten; dynamisch registrierte Receiver und per Reflection gestartete Activities fehlen.",
  ],
  screen: [
    "Nur Activities, Fragments und Layouts, die die statische Analyse auflöst; per Compose oder Code erzeugte Oberflächen fehlen.",
  ],
};

const ENUMERATORS = {
  asset: assetItems,
  "exported-symbol": exportedItems,
  screen: screenItems,
};

function enumerate(facts, cls) {
  return ENUMERATORS[cls](facts ?? {});
}

/** Denominators per class, sorted, with the probe that enumerated them. */
export function nativeDenominators(analysis) {
  const facts = analysis?.facts ?? {};
  return Object.keys(ENUMERATORS)
    .sort(compareStrings)
    .map((cls) => ({
      class: cls,
      probe: `apk.${cls}-scan`,
      items: enumerate(facts, cls).length,
      blind_spots: [...BLIND_SPOTS[cls]],
    }));
}

/**
 * The ceiling an APK or native run can support.
 *
 * A trace grant is the only probe that supports `executed` for a native binary;
 * without it the run is lowered to `inferred-only` and the package names
 * `native:no-trace-grant`, so the missing observation stays visible.
 */
export function nativeCeiling(analysis) {
  const probes = asArray(analysis?.probes);
  const traced = probes.some((probe) =>
    asArray(probe?.tags ?? [probe?.id]).includes("trace-grant"),
  );
  if (traced) {
    return resolveCeiling({
      targetClass: "native",
      requested: "executed",
      probes,
    });
  }
  // `requested` names what the native class may ask for at all, not what the
  // analysis recorded: a code run inherits the source matrix and would otherwise
  // report `executed` as its request, which no native run can ever make.
  return {
    requested: "statically-evidenced",
    ceiling: "inferred-only",
    downgraded_by: ["native:no-trace-grant"],
  };
}

/**
 * Behavioural claims that are typed `observed`.
 *
 * Nothing observed a native binary's behaviour without a trace, so such a claim
 * is a mislabelled inference; returning its id lets the gate name it.
 */
export function behaviourClaimViolations(claims = []) {
  return asArray(claims)
    .filter(
      (claim) =>
        claim?.kind === "observed" &&
        String(claim.subject ?? "").startsWith(BEHAVIOUR_SUBJECT),
    )
    .map((claim) => claim.id)
    .sort(compareStrings);
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

/** One ledger entry per enumerated item, exactly like the web denominator. */
export function nativeEntries(analysis, claims = []) {
  const facts = analysis?.facts ?? {};
  const entries = [];
  for (const cls of Object.keys(ENUMERATORS).sort(compareStrings)) {
    for (const entry of enumerate(facts, cls)) {
      const matches = coveredBy(entry, claims);
      const id = `${cls}:${entry.subject}`;
      if (matches.length > 0) {
        entries.push({
          id,
          class: cls,
          subject: entry.subject,
          source: entry.source,
          status: "covered",
          claims: matches.map((claim) => claim.id).sort(compareStrings),
        });
        continue;
      }
      entries.push({
        id,
        class: cls,
        subject: entry.subject,
        source: entry.source,
        status: "gap",
        claims: [],
        gap: {
          id,
          why: `Für ${cls} "${entry.subject}" gibt es keine Behauptung mit Beleg an genau dieser Stelle.`,
          action: `Behauptung für ${cls} "${entry.subject}" aus dem Beleg ableiten und mit Selektor belegen.`,
          blocking: false,
        },
      });
    }
  }
  return entries.sort((left, right) => compareStrings(left.id, right.id));
}
