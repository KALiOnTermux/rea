/**
 * Resolves the selector of a claim's evidence reference (spec §5, R1).
 *
 * The compiler records *what* inside a file proves a claim — a JSON pointer, a
 * line range, a DOM node, a recorded request, a byte range or the whole file.
 * Until now only the path and the digest were checked, so a claim could cite a
 * selector that resolves nowhere and still pass. This module is the single
 * resolver the build gate and the package verifier share.
 *
 * Everything is measured over bytes: `lines` splits on `\r?\n` and `byte-range`
 * indexes the `Buffer`, so binary evidence (screenshots, recordings) is not
 * silently decoded as text. DOM selectors use the acceptance runner's grammar,
 * so evidence and acceptance cannot drift apart.
 */

import { matchesSelector } from "./run-acceptance.mjs";

/** Selector shapes this resolver understands. */
export const SELECTOR_TYPES = [
  "whole",
  "pointer",
  "lines",
  "dom",
  "request",
  "byte-range",
];

const LEGACY_FIELDS = ["pointer", "contains", "line", "offset"];

function asBuffer(bytes) {
  if (Buffer.isBuffer(bytes)) return bytes;
  if (bytes instanceof Uint8Array) return Buffer.from(bytes);
  if (typeof bytes === "string") return Buffer.from(bytes, "utf8");
  return null;
}

/** JSON pointer lookup; `~1` is `/` and `~0` is `~` (RFC 6901). */
export function jsonPointerValue(value, pointer) {
  if (!pointer || pointer === "/") return value;
  let current = value;
  for (const raw of pointer.split("/").slice(1)) {
    const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (current == null || typeof current !== "object") return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, key)) return undefined;
    current = current[key];
  }
  return current;
}

/** Lines of a text, without the trailing empty line a final newline creates. */
function linesOf(text) {
  const lines = text.split(/\r?\n/);
  if (text.endsWith("\n")) lines.pop();
  return lines;
}

function parseJson(buffer, label) {
  try {
    return { ok: true, value: JSON.parse(buffer.toString("utf8")) };
  } catch {
    return { ok: false, reason: `kein JSON: ${label}` };
  }
}

/** The recorded requests of a capture, in recording order. */
function recordedRequests(capture) {
  const items = Array.isArray(capture?.events?.items)
    ? capture.events.items
    : [];
  return items.filter((item) => item?.kind === "request");
}

function resolvePointer(buffer, pointer, label) {
  if (typeof pointer !== "string" || pointer === "") {
    return { ok: false, reason: `Pointer fehlt: ${label}` };
  }
  const parsed = parseJson(buffer, label);
  if (!parsed.ok) return parsed;
  const value = jsonPointerValue(parsed.value, pointer);
  if (value === undefined || value === null) {
    return {
      ok: false,
      reason: `Pointer nicht auflösbar: ${label}#${pointer}`,
    };
  }
  return { ok: true };
}

function resolveLineRange(buffer, from, to, label) {
  if (!Number.isInteger(from) || !Number.isInteger(to)) {
    return { ok: false, reason: `Zeilenbereich ungültig: ${label}` };
  }
  const count = linesOf(buffer.toString("utf8")).length;
  if (from < 1 || to < from || to > count) {
    return {
      ok: false,
      reason: `Zeilen ${from}-${to} liegen außerhalb von ${count} Zeilen: ${label}`,
    };
  }
  return { ok: true };
}

function resolveByteRange(buffer, from, to, label) {
  if (!Number.isInteger(from) || !Number.isInteger(to)) {
    return { ok: false, reason: `Byte-Bereich ungültig: ${label}` };
  }
  if (from < 0 || to <= from || to > buffer.length) {
    return {
      ok: false,
      reason: `Byte-Bereich ${from}-${to} liegt außerhalb von ${buffer.length} Bytes: ${label}`,
    };
  }
  return { ok: true };
}

/**
 * The legacy shorthand the studio shipped before typed selectors existed.
 *
 * Order and reasons match `resolveEvidenceRef` exactly, so existing evidence and
 * `blueprint-evidence.test.mjs` keep their behaviour.
 */
function resolveLegacy(buffer, reference, label) {
  if (reference.pointer) {
    const result = resolvePointer(buffer, reference.pointer, label);
    if (!result.ok) return result;
  }
  if (reference.contains) {
    if (!buffer.toString("utf8").includes(reference.contains)) {
      return { ok: false, reason: `Textmarke fehlt: ${reference.contains}` };
    }
  }
  if (reference.line != null) {
    const count = linesOf(buffer.toString("utf8")).length;
    if (reference.line < 1 || reference.line > count) {
      return {
        ok: false,
        reason: `Zeile ${reference.line} liegt außerhalb von ${label}`,
      };
    }
  }
  if (
    reference.offset != null &&
    (reference.offset < 0 || reference.offset >= buffer.length)
  ) {
    return {
      ok: false,
      reason: `Offset ${reference.offset} liegt außerhalb von ${label}`,
    };
  }
  return { ok: true };
}

/**
 * Resolves one selector against the bytes of its evidence file.
 *
 * `path` is only used for the reason string, so a violation names the file the
 * selector was meant to resolve in.
 *
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function resolveSelector(bytes, selector = {}, path = "") {
  const buffer = asBuffer(bytes);
  if (!buffer) {
    return { ok: false, reason: `keine Bytes: ${path || "Beleg"}` };
  }
  const label = path || "Beleg";
  if (selector === null || typeof selector !== "object") {
    return { ok: false, reason: `Selektor fehlt: ${label}` };
  }
  const legacy =
    selector.type === undefined &&
    LEGACY_FIELDS.some((field) => selector[field] !== undefined);

  switch (selector.type) {
    case undefined:
      if (legacy) return resolveLegacy(buffer, selector, label);
      // A reference without a selector stands for the file as a whole.
      return buffer.length > 0
        ? { ok: true }
        : { ok: false, reason: `Datei ist leer: ${label}` };
    case "whole":
      return buffer.length > 0
        ? { ok: true }
        : { ok: false, reason: `Datei ist leer: ${label}` };
    case "pointer":
      return resolvePointer(buffer, selector.pointer, label);
    case "lines":
      return resolveLineRange(buffer, selector.from, selector.to, label);
    case "dom": {
      if (typeof selector.path !== "string" || selector.path === "") {
        return { ok: false, reason: `DOM-Selektor fehlt: ${label}` };
      }
      return matchesSelector(buffer.toString("utf8"), selector)
        ? { ok: true }
        : {
            ok: false,
            reason: `DOM-Knoten fehlt: ${selector.path} in ${label}`,
          };
    }
    case "request": {
      const index = selector.index;
      if (!Number.isInteger(index) || index < 0) {
        return {
          ok: false,
          reason: `Anfrage-Index ungültig: ${String(index)} in ${label}`,
        };
      }
      const parsed = parseJson(buffer, label);
      if (!parsed.ok) return parsed;
      const requests = recordedRequests(parsed.value);
      if (index >= requests.length) {
        return {
          ok: false,
          reason: `Anfrage #${index} fehlt in ${requests.length} aufgezeichneten Anfragen: ${label}`,
        };
      }
      return { ok: true };
    }
    case "byte-range":
      return resolveByteRange(buffer, selector.from, selector.to, label);
    default:
      return {
        ok: false,
        reason: `Selektor nicht unterstützt: ${String(selector.type)}`,
      };
  }
}

/**
 * Reads `reference.path` through `readFile` and resolves its selector.
 *
 * `readFile` returns bytes (Buffer, Uint8Array or string) or nothing when the
 * file is absent. A missing or empty file proves nothing, whatever the selector
 * says, so it is unresolved rather than "present".
 */
export function resolveEvidence(reference, readFile) {
  const path = reference?.path;
  if (typeof path !== "string" || path === "") {
    return { ok: false, reason: "Beleg ohne Pfad" };
  }
  let bytes;
  try {
    bytes = typeof readFile === "function" ? readFile(path) : undefined;
  } catch (error) {
    return {
      ok: false,
      reason: `Datei nicht lesbar: ${path} (${error?.message ?? String(error)})`,
    };
  }
  const buffer = asBuffer(bytes);
  if (!buffer || buffer.length === 0) {
    return { ok: false, reason: `Datei fehlt oder ist leer: ${path}` };
  }
  // The legacy shorthand lives on the reference itself (spec §5), while a typed
  // selector is a nested object. Both go through the same resolver.
  const selector =
    reference.selector !== null && typeof reference.selector === "object"
      ? reference.selector
      : reference;
  return resolveSelector(buffer, selector, path);
}
