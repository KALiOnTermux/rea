/**
 * An HTTP client backed by the package's own capture transcript.
 *
 * The acceptance checks of a web package describe requests the capture really
 * made. Without a client those checks would be `skipped` and prove nothing, so
 * this client answers from the recorded transcript: every navigation step is a
 * document transaction, every request/response pair a recorded call. A target
 * the transcript does not contain throws, which turns the check red instead of
 * silently passing.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

function normalise(url) {
  if (typeof url !== "string" || url === "") return "";
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * Turns a capture (`steps`, `events.items`) into ordered transactions:
 * `{method, url, status}` with the response status joined by transaction id.
 */
export function transcriptOf(capture) {
  const transactions = [];
  for (const step of Array.isArray(capture?.steps) ? capture.steps : []) {
    if (!step?.after_url) continue;
    transactions.push({
      method: "GET",
      url: normalise(step.after_url),
      status: Number.isFinite(step.status) ? step.status : null,
      source: "navigation",
    });
  }
  const pending = new Map();
  for (const item of Array.isArray(capture?.events?.items)
    ? capture.events.items
    : []) {
    const url = normalise(item?.url?.url ?? item?.url);
    const id = item?.transaction_id ?? item?.sequence;
    if (item?.kind === "request") {
      pending.set(id, {
        method: String(item.method ?? "GET").toUpperCase(),
        url,
        status: null,
        source: "network",
      });
      continue;
    }
    if (item?.kind === "response") {
      const request = pending.get(id);
      if (request) {
        request.status = Number.isFinite(item.status) ? item.status : null;
        continue;
      }
      transactions.push({
        method: "GET",
        url,
        status: Number.isFinite(item.status) ? item.status : null,
        source: "network",
      });
    }
  }
  transactions.push(...pending.values());
  return transactions;
}

/**
 * Builds a `request` client from a capture object. It resolves a check target by
 * URL, by recorded index (`selector: {type: "request", index}`) or by method.
 */
export function transcriptClient(capture) {
  const transactions = transcriptOf(capture);
  const network = transactions.filter((item) => item.source === "network");
  return async function request(target = {}) {
    const selector = target.selector ?? null;
    if (selector?.type === "request") {
      const index = Number(selector.index ?? 0);
      const found = network[index];
      if (!found) {
        throw new Error(`Aufnahme enthält keine Anfrage #${index}`);
      }
      return { status: found.status, url: found.url, method: found.method };
    }
    const wanted = normalise(target.url);
    if (wanted === "") {
      throw new Error("Prüfung nennt weder URL noch Aufnahme-Index");
    }
    const matches = transactions.filter((item) => item.url === wanted);
    if (matches.length === 0) {
      throw new Error(`Aufnahme enthält keine Anfrage an ${wanted}`);
    }
    const method = target.method ? String(target.method).toUpperCase() : null;
    const found = method
      ? matches.find((item) => item.method === method)
      : matches[0];
    if (!found) {
      throw new Error(`Aufnahme enthält kein ${method} an ${wanted}`);
    }
    return { status: found.status, url: found.url, method: found.method };
  };
}

/** Reads `evidence/web-capture.json` from a package and returns its client. */
export async function transcriptClientFromPackage(packagePath) {
  const path = join(packagePath, "evidence", "web-capture.json");
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  try {
    return transcriptClient(JSON.parse(raw));
  } catch {
    return null;
  }
}
