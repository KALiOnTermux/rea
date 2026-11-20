/**
 * Coverage denominator for a captured web session (spec §6, Task 10).
 *
 * The denominator answers "what should this run have looked at?" from the facts
 * themselves — routes the static analysis found, interactive DOM nodes, observed
 * requests and referenced assets — never from a completeness report, which only
 * says what someone thought to check.
 *
 * Every enumerated item becomes one ledger entry. An item is `covered` only when
 * a claim carries an evidence selector that names exactly that item; otherwise it
 * is a gap with the action that would close it. That keeps a package from looking
 * closed because it happened to observe something else.
 */

const ROUTE_SOURCE = "evidence/web-analysis.json";
const CAPTURE_SOURCE = "evidence/web-capture.json";
const DOM_SOURCE = "surface/dom.html";

function compareStrings(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function routeItems(facts) {
  return asArray(facts?.internals?.routes).map((route, index) => ({
    subject: `${route.method || "GET"} ${route.path || route.pattern || route.route || index}`,
    source: {
      path: ROUTE_SOURCE,
      selector: { type: "pointer", pointer: `/routes/${index}` },
    },
  }));
}

function domItem(subject, selector) {
  return {
    subject,
    source: { path: DOM_SOURCE, selector: { type: "dom", path: selector } },
  };
}

function buttonItems(surface) {
  return asArray(surface.buttons).map((button) =>
    domItem(
      button.id
        ? `button#${button.id}`
        : `button:${button.label || button.text || "ohne Text"}`,
      button.id ? `#${button.id}` : `button:${button.label || ""}`,
    ),
  );
}

function inputItems(surface) {
  return asArray(surface.inputs).map((input) => {
    const selector = `${input.tag || "input"}${input.name ? `[name=${input.name}]` : ""}`;
    return domItem(
      `<${input.tag || "input"}>${input.name ? `[name=${input.name}]` : ""}`,
      selector,
    );
  });
}

function formItems(surface) {
  return asArray(surface.forms).map((form) =>
    domItem(
      `form:${String(form.method || "get").toLowerCase()} ${form.action || "current"}`,
      `form[action="${form.action || ""}"]`,
    ),
  );
}

function linkItems(surface) {
  return asArray(surface.links).map((link) =>
    domItem(`link:${link.href || ""}`, `a[href="${link.href || ""}"]`),
  );
}

function domItems(facts) {
  const surface = facts?.surface ?? {};
  return [
    ...buttonItems(surface),
    ...inputItems(surface),
    ...formItems(surface),
    ...linkItems(surface),
  ];
}

function requestItems(facts) {
  return asArray(facts?.behavior?.network?.requests).map((request, index) => ({
    subject: `${request.method || "GET"} ${request.url || request.path || index}`,
    source: {
      path: CAPTURE_SOURCE,
      selector: { type: "request", index },
    },
  }));
}

function assetItems(facts) {
  const surface = facts?.surface ?? {};
  const items = [];
  for (const image of asArray(surface.images)) {
    items.push({
      subject: `image:${image.src || ""}`,
      source: {
        path: DOM_SOURCE,
        selector: { type: "dom", path: `img[src="${image.src || ""}"]` },
      },
    });
  }
  for (const script of asArray(surface.scripts)) {
    items.push({
      subject: `script:${script.src || ""}`,
      source: {
        path: DOM_SOURCE,
        selector: { type: "dom", path: `script[src="${script.src || ""}"]` },
      },
    });
  }
  for (const stylesheet of asArray(surface.stylesheets)) {
    items.push({
      subject: `stylesheet:${stylesheet.href || stylesheet.src || ""}`,
      source: {
        path: DOM_SOURCE,
        selector: {
          type: "dom",
          path: `link[href="${stylesheet.href || stylesheet.src || ""}"]`,
        },
      },
    });
  }
  return items;
}

const BLIND_SPOTS = {
  asset: [
    "Nur im DOM referenzierte Assets; per CSS oder JavaScript nachgeladene Dateien fehlen.",
  ],
  "dom-node": [
    "Nur beim Aufnehmen sichtbare interaktive Knoten; nachgeladene Dialoge und Menüs fehlen.",
  ],
  request: [
    "Nur während der Aufnahme ausgelöste Requests; periodische Aufrufe und Fehlerpfade fehlen.",
  ],
  route: [
    "Routen, die erst zur Laufzeit aus einer Zeichenkette entstehen, lassen sich statisch nicht enumerieren.",
  ],
};

const ENUMERATORS = {
  asset: assetItems,
  "dom-node": domItems,
  request: requestItems,
  route: routeItems,
};

function enumerate(analysis, cls) {
  return ENUMERATORS[cls](analysis?.facts ?? {});
}

/** Denominators per class, sorted, with the probe that enumerated them. */
export function webDenominators(analysis) {
  return Object.keys(ENUMERATORS)
    .sort(compareStrings)
    .map((cls) => ({
      class: cls,
      probe: `web.${cls}-scan`,
      items: enumerate(analysis, cls).length,
      blind_spots: [...BLIND_SPOTS[cls]],
    }));
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
export function webEntries(analysis, claims = []) {
  const entries = [];
  for (const cls of Object.keys(ENUMERATORS).sort(compareStrings)) {
    for (const item of enumerate(analysis, cls)) {
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
