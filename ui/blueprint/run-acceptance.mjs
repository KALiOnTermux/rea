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
  const attribute = path.match(/^\[([\w-]+)=["']?([^\]"']+)["']?\]$/);
  if (attribute) {
    return new RegExp(
      `${attribute[1]}=["']${escapePattern(attribute[2])}["']`,
    ).test(source);
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

async function runHttp(check, request) {
  if (typeof request !== "function") {
    return verdict(
      check,
      "skipped",
      "kein HTTP-Client",
      "requires:http-client",
    );
  }
  try {
    const actual = await request({ ...check.request, fixture: check.fixture });
    const expected = check.expect?.status;
    if (Number.isInteger(expected) && actual?.status !== expected) {
      return verdict(
        check,
        "failed",
        `Status ${actual?.status ?? "keine Antwort"} statt ${expected}`,
      );
    }
    return verdict(check, "passed", `Status ${actual?.status ?? "unbekannt"}`);
  } catch (error) {
    return verdict(
      check,
      "failed",
      `Anfrage fehlgeschlagen: ${error?.message ?? error}`,
    );
  }
}

async function runDom(check, root) {
  const fixture = check.fixture ?? "index.html";
  let html;
  try {
    html = await readFile(join(root, fixture), "utf8");
  } catch {
    return verdict(check, "failed", `${fixture} fehlt im Rebuild`);
  }
  const found = matchesSelector(html, check.selector);
  return verdict(
    check,
    found ? "passed" : "failed",
    found
      ? `${check.selector?.path} gefunden`
      : `${check.selector?.path} fehlt in ${fixture}`,
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
