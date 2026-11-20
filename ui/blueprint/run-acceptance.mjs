/**
 * Executes acceptance checks against a rebuild directory (spec §9, Task 15).
 *
 * The runner never throws for a criterion that fails: a failed check is a
 * result, not an exception, because the package has to report what it could not
 * confirm. A kind this run cannot execute becomes `skipped` with
 * `reason: "requires:<kind>"` and blocks `complete`; an unknown kind is
 * `unexecutable`.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const STATUSES = ["passed", "failed", "skipped", "unexecutable"];
const HARNESS_KINDS = ["function", "process", "state"];

function escapePattern(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Minimal DOM matcher over the rendered HTML: id, class, attribute or tag. */
export function matchesSelector(html, selector) {
  const path = selector?.path;
  if (typeof path !== "string" || path === "") return false;
  const source = String(html ?? "");
  if (path.startsWith("#")) {
    return new RegExp(`id=["']${escapePattern(path.slice(1))}["']`).test(
      source,
    );
  }
  if (path.startsWith(".")) {
    return new RegExp(
      `class=["'][^"']*\\b${escapePattern(path.slice(1))}\\b`,
    ).test(source);
  }
  // `tag[attr="value"]` is what the DOM denominator emits for links, inputs and
  // forms; without the tag form those checks failed on a node that is present.
  const tagAttribute = path.match(
    /^([a-z][\w-]*)?\[([\w-]+)=["']?([^\]"']+)["']?\]$/i,
  );
  if (tagAttribute) {
    const [, tag, attribute, value] = tagAttribute;
    const pair = `${attribute}=["']${escapePattern(value)}["']`;
    return tag
      ? new RegExp(`<${escapePattern(tag)}\\b[^>]*${pair}`).test(source)
      : new RegExp(pair).test(source);
  }
  return new RegExp(`<${escapePattern(path)}\\b`).test(source);
}

function verdict(check, status, detail, reason) {
  const result = {
    id: check.id,
    criterion: check.criterion,
    kind: check.kind,
    status,
    detail: String(detail ?? ""),
  };
  if (reason) result.reason = reason;
  return result;
}

/** `{status}` or `{statusClass}`; a class of 2 means any 2xx answer. */
function statusMismatch(actual, expect) {
  if (Number.isInteger(expect?.status)) {
    return actual?.status === expect.status
      ? null
      : `Status ${actual?.status ?? "keine Antwort"} statt ${expect.status}`;
  }
  if (Number.isInteger(expect?.statusClass)) {
    const actualClass = Number.isInteger(actual?.status)
      ? Math.floor(actual.status / 100)
      : null;
    return actualClass === expect.statusClass
      ? null
      : `Statusklasse ${actualClass ?? "keine Antwort"} statt ${expect.statusClass}xx`;
  }
  return null;
}

async function runHttp(check, request) {
  if (typeof request !== "function") {
    return verdict(
      check,
      "skipped",
      "kein HTTP-Client",
      "requires:http-client",
    );
  }
  const targets = Array.isArray(check.requests)
    ? check.requests
    : [{ ...check.request, expect: check.expect }];
  const failures = [];
  for (const [index, target] of targets.entries()) {
    try {
      const actual = await request({ ...target, fixture: check.fixture });
      const mismatch = statusMismatch(actual, target.expect);
      if (mismatch) {
        failures.push(
          `${target.url ?? target.selector?.index ?? index}: ${mismatch}`,
        );
      }
    } catch (error) {
      failures.push(
        `${target.url ?? target.selector?.index ?? index}: ${error?.message ?? error}`,
      );
    }
  }
  return verdict(
    check,
    failures.length === 0 ? "passed" : "failed",
    failures.length === 0
      ? `${targets.length} Anfrage(n) bestätigt`
      : failures.join("; "),
  );
}

async function runDom(check, root) {
  const fixture = check.fixture ?? "index.html";
  let html;
  try {
    html = await readFile(join(root, fixture), "utf8");
  } catch {
    return verdict(check, "failed", `${fixture} fehlt im Rebuild`);
  }
  const paths = Array.isArray(check.selectors)
    ? check.selectors
    : [check.selector?.path];
  const missing = paths.filter(
    (path) => !matchesSelector(html, { type: "dom", path }),
  );
  return verdict(
    check,
    missing.length === 0 ? "passed" : "failed",
    missing.length === 0
      ? `${paths.length} Selektor(en) gefunden`
      : `fehlt in ${fixture}: ${missing.join(", ")}`,
  );
}

async function runStructure(check, root) {
  const paths = Array.isArray(check.paths) ? check.paths : [];
  if (paths.length === 0) {
    return verdict(check, "unexecutable", "structure braucht paths");
  }
  const missing = paths.filter((path) => !existsSync(join(root, path)));
  return verdict(
    check,
    missing.length === 0 ? "passed" : "failed",
    missing.length === 0
      ? `${paths.length} Pfad(e) vorhanden`
      : `fehlt: ${missing.join(", ")}`,
  );
}

async function runHarnessKind(check, harness) {
  const runner = harness?.[check.kind];
  if (typeof runner !== "function") {
    return verdict(check, "skipped", "kein Harness", `requires:${check.kind}`);
  }
  try {
    const outcome = await runner(check);
    const ok = outcome === true || outcome?.ok === true;
    return verdict(
      check,
      ok ? "passed" : "failed",
      outcome?.detail ?? (ok ? "Harness bestätigt" : "Harness widerlegt"),
    );
  } catch (error) {
    return verdict(
      check,
      "failed",
      `Harness-Fehler: ${error?.message ?? error}`,
    );
  }
}

/**
 * Runs every check and returns the four counts plus one verdict per check.
 * `request` is the injected HTTP client; `harness` may implement
 * `function`/`process`/`state`.
 */
export async function runAcceptance({ file, root, request, harness } = {}) {
  const checks = Array.isArray(file?.checks) ? file.checks : [];
  const verdicts = [];
  for (const check of checks) {
    if (check.kind === "http") {
      verdicts.push(await runHttp(check, request));
      continue;
    }
    if (check.kind === "dom") {
      verdicts.push(await runDom(check, root));
      continue;
    }
    if (check.kind === "structure") {
      verdicts.push(await runStructure(check, root));
      continue;
    }
    if (HARNESS_KINDS.includes(check.kind)) {
      verdicts.push(await runHarnessKind(check, harness));
      continue;
    }
    verdicts.push(
      verdict(check, "unexecutable", `unbekannte Art ${check.kind}`),
    );
  }
  const counts = Object.fromEntries(STATUSES.map((status) => [status, 0]));
  for (const item of verdicts) counts[item.status] += 1;
  return {
    passed: counts.passed,
    failed: counts.failed,
    skipped: counts.skipped,
    unexecutable: counts.unexecutable,
    verdicts,
  };
}
