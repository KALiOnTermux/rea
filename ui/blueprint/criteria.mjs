/**
 * Checks for the criteria a builder declares (spec §9).
 *
 * A builder states its acceptance criteria as prose. The gate refuses a package
 * whose declared criterion has no executable check, so every criterion has to be
 * turned into one here — or, when the run has no evidence to test it against, be
 * moved to an explicit open boundary that names the ledger entry accounting for
 * it. Neither path is allowed to drop a criterion silently.
 *
 * The web table is keyed by a distinctive phrase of each declared criterion; a
 * test pins that every criterion `buildWeb` declares is either built or
 * explicitly classified as a boundary, so a reworded criterion fails loudly
 * instead of quietly losing its test.
 */

function compareStrings(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function unique(values) {
  return [
    ...new Set(values.filter((value) => typeof value === "string" && value)),
  ];
}

function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}

/** Selectors for the visible surface the capture recorded. */
function surfaceSelectors(facts) {
  const surface = facts?.surface ?? {};
  const selectors = [];
  if (surface.landmarks?.main) selectors.push("main");
  for (const heading of asArray(surface.headings)) {
    if (Number.isInteger(heading.level)) selectors.push(`h${heading.level}`);
  }
  for (const button of asArray(surface.buttons)) {
    selectors.push(
      button.id ? `#${button.id}` : `button:${button.label || ""}`,
    );
  }
  for (const link of asArray(surface.links)) {
    if (link.href) selectors.push(`a[href="${link.href}"]`);
  }
  for (const input of asArray(surface.inputs)) {
    selectors.push(
      `${input.tag || "input"}${input.name ? `[name=${input.name}]` : ""}`,
    );
  }
  for (const form of asArray(surface.forms)) {
    selectors.push(`form[action="${form.action || ""}"]`);
  }
  return unique(selectors).sort(compareStrings);
}

/** Routes the capture visited: navigation targets and the steps' landing URLs. */
function visitedRoutes(facts) {
  const routes = [];
  for (const entry of asArray(facts?.behavior?.navigation)) {
    if (entry?.url)
      routes.push({ url: entry.url, status: entry.status ?? null });
  }
  for (const step of asArray(facts?.behavior?.steps)) {
    if (step?.after_url) {
      routes.push({ url: step.after_url, status: step.status ?? null });
    }
  }
  for (const route of asArray(facts?.internals?.routes)) {
    const url = route?.path || route?.pattern || route?.route;
    if (url) routes.push({ url, status: null });
  }
  const seen = new Map();
  for (const route of routes) {
    const key = String(route.url);
    if (!seen.has(key)) seen.set(key, route);
  }
  return [...seen.values()].sort((left, right) =>
    compareStrings(String(left.url), String(right.url)),
  );
}

function statusExpect(status) {
  return Number.isInteger(status) ? { status } : { statusClass: 2 };
}

function surfaceCheck(criterion, facts) {
  const selectors = surfaceSelectors(facts);
  if (selectors.length === 0) return null;
  return {
    id: `acceptance.criterion.${slug(criterion)}`,
    kind: "dom",
    criterion,
    fixture: "surface/dom.html",
    selectors,
  };
}

function routeCheck(criterion, facts) {
  const routes = visitedRoutes(facts);
  if (routes.length === 0) return null;
  return {
    id: `acceptance.criterion.${slug(criterion)}`,
    kind: "http",
    criterion,
    fixture: "evidence/web-capture.json",
    requests: routes.map((route) => ({
      url: route.url,
      expect: statusExpect(route.status),
    })),
  };
}

function apiCheck(criterion, facts) {
  const requests = asArray(facts?.behavior?.network?.requests);
  if (requests.length === 0) return null;
  return {
    id: `acceptance.criterion.${slug(criterion)}`,
    kind: "http",
    criterion,
    fixture: "evidence/web-capture.json",
    requests: requests.map((request, index) => ({
      selector: { type: "request", index },
      expect: statusExpect(request.status),
    })),
  };
}

function formCheck(criterion, facts) {
  const surface = facts?.surface ?? {};
  const selectors = unique([
    ...asArray(surface.forms).map(
      (form) => `form[action="${form.action || ""}"]`,
    ),
    ...asArray(surface.buttons).map((button) =>
      button.id ? `#${button.id}` : `button:${button.label || ""}`,
    ),
  ]).sort(compareStrings);
  if (selectors.length === 0) return null;
  return {
    id: `acceptance.criterion.${slug(criterion)}`,
    kind: "dom",
    criterion,
    fixture: "surface/dom.html",
    selectors,
  };
}

/** Web criteria with a builder, keyed by a distinctive phrase. */
const WEB_BUILDERS = [
  { match: "Startseite rendert", build: surfaceCheck },
  { match: "Route ist erreichbar", build: routeCheck },
  { match: "API-Aufrufe stimmen", build: apiCheck },
  { match: "Formulare und Buttons", build: formCheck },
];

/**
 * Boundaries that are known to have no evidence in a capture-only run.
 *
 * The reason is rendered in the package and recorded in the ledger, so a reader
 * sees why the criterion has no check instead of finding it gone.
 */
const WEB_BOUNDARIES = [
  {
    match: "Local Storage",
    why: "Die Aufnahme enthält keinen Storage-Beleg (Cookies, Local oder Session Storage); ohne ihn ist die Anforderung nicht prüfbar.",
  },
];

/**
 * Turns declared criteria into checks and explicit boundaries.
 *
 * Returns `{ checks, boundaries }`; a criterion that is neither built nor named
 * by a known boundary is reported in `unmapped`, which the caller must treat as
 * a defect instead of dropping.
 */
export function criteriaChecks(criteria, facts, { targetClass = "web" } = {}) {
  const checks = [];
  const boundaries = [];
  const unmapped = [];
  for (const criterion of asArray(criteria)) {
    if (typeof criterion !== "string" || criterion === "") continue;
    const builder = WEB_BUILDERS.find((entry) =>
      criterion.includes(entry.match),
    );
    const built =
      builder && targetClass === "web" ? builder.build(criterion, facts) : null;
    if (built) {
      checks.push(built);
      continue;
    }
    const boundary = WEB_BOUNDARIES.find((entry) =>
      criterion.includes(entry.match),
    );
    if (boundary) {
      boundaries.push({ criterion, why: boundary.why });
      continue;
    }
    unmapped.push(criterion);
  }
  return { checks, boundaries, unmapped };
}
