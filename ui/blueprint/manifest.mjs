/**
 * The tamper-evident manifest of a blueprint package (spec §6, R10).
 *
 * `MANIFEST.json` lists every packaged file with its size and digest, plus the
 * named digests a reviewer needs without unpacking the archive. `produced_at` is
 * the only non-reproducible field: it is recorded here, never hashed, so the
 * same analysis produces the same digests on every run.
 *
 * Paths are normalised to `/` because they become ZIP names and selector
 * references; a backslash or a `..` segment would silently break a resolving
 * reference off-host.
 */

import { createHash } from "node:crypto";
import { CEILING_ORDER } from "./ceiling.mjs";

export const MANIFEST_SCHEMA = "rea.blueprint.manifest";
export const MANIFEST_SCHEMA_VERSION = 1;

/**
 * The determinism rule the archive claims, stated in the manifest itself.
 *
 * Every sentence has to match what the build does: paths are sorted by code
 * point, `produced_at` is supplied by the caller and hashed nowhere, and the ZIP
 * headers are derived from it in UTC. If the build changes, this text changes
 * with it.
 */
export const DETERMINISM_RULE = Object.freeze({
  sort: "files[] und die Schlüssel von digests sind nach Pfad in Unicode-Codepunkt-Reihenfolge sortiert; Pfade sind eindeutig, Gleichstände gibt es nicht.",
  produced_at:
    "produced_at wird vom Aufrufer gepinnt und geht in keinen Digest ein (weder digests.package noch digests.blueprint).",
  zip_timestamps:
    "DOS-Datum und -Zeit jedes ZIP-Eintrags werden aus produced_at in UTC abgeleitet; die Uhr des Build-Hosts geht nicht ein.",
  clock:
    "Der Compiler liest weder Uhrzeit noch Umgebung; alle Eingaben kommen als Daten. Der ausgelieferte Build pinnt produced_at, deshalb ergeben zwei Builds aus identischem Quellzustand byte-identische Archive.",
});

const HASH_MISMATCH = "manifest.hash_mismatch";
const SHA256_HEX = /^[0-9a-f]{64}$/;
/** A downgrade is `<target class>:<forcing probe>`, e.g. `apk:no-execution-grant`. */
const DOWNGRADE = /^[a-z][a-z0-9]*:[a-z0-9-]+$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export class ManifestError extends Error {
  constructor(message, { code = "blueprint.manifest" } = {}) {
    super(message);
    this.name = "ManifestError";
    this.code = code;
  }
}

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function compareStrings(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function toBuffer(value, label) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string") return Buffer.from(value, "utf8");
  throw new ManifestError(`${label} must be bytes or a string`);
}

/**
 * The fixed denominator, declared per class with its total.
 *
 * This is the number a package promises to account for; `blueprint:verify`
 * compares it against the ledger it unpacks, so a removed, added or reclassified
 * unit is a violation instead of a quietly lowered denominator.
 */
function normaliseDenominators(denominators) {
  if (!Array.isArray(denominators)) {
    throw new ManifestError("denominators must be an array of class entries");
  }
  const seen = new Set();
  const classes = denominators
    .map((item) => {
      const cls = item?.class;
      if (typeof cls !== "string" || cls.trim() === "") {
        throw new ManifestError(
          `denominator class must be a non-empty string, got ${JSON.stringify(cls)}`,
        );
      }
      if (seen.has(cls)) {
        throw new ManifestError(`denominator class ${cls} is declared twice`);
      }
      seen.add(cls);
      if (!Number.isInteger(item.items) || item.items < 0) {
        throw new ManifestError(
          `denominator ${cls} needs a non-negative integer items, got ${JSON.stringify(item.items)}`,
        );
      }
      if (typeof item.probe !== "string" || item.probe.trim() === "") {
        throw new ManifestError(`denominator ${cls} needs a probe name`);
      }
      return { class: cls, items: item.items, probe: item.probe };
    })
    .sort((left, right) => compareStrings(left.class, right.class));
  const total = classes.reduce((sum, item) => sum + item.items, 0);
  return { total, classes };
}

/** Normalises a packaged path and refuses one that could leave the package. */
function normalisePath(raw) {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new ManifestError("manifest path must be a non-empty string");
  }
  const path = raw.replace(/\\/g, "/").replace(/^\.\//, "");
  if (path.startsWith("/")) {
    throw new ManifestError(
      `manifest path must be relative, got the absolute path ${JSON.stringify(raw)}`,
    );
  }
  const segments = path.split("/");
  if (segments.some((part) => part === "" || part === "." || part === "..")) {
    throw new ManifestError(
      `manifest path must not contain empty, "." or ".." segments, got ${JSON.stringify(raw)}`,
    );
  }
  return path;
}

function normaliseFiles(files) {
  if (files === null || typeof files !== "object" || Array.isArray(files)) {
    throw new ManifestError("files must be a map from path to bytes");
  }
  const byPath = new Map();
  for (const [rawPath, value] of Object.entries(files)) {
    const path = normalisePath(rawPath);
    if (byPath.has(path)) {
      throw new ManifestError(
        `duplicate manifest path ${JSON.stringify(path)} (from ${JSON.stringify(rawPath)})`,
      );
    }
    const bytes = toBuffer(value, `files[${JSON.stringify(rawPath)}]`);
    byPath.set(path, bytes);
  }
  return [...byPath]
    .map(([path, bytes]) => ({
      path,
      sha256: sha256Hex(bytes),
      bytes: bytes.length,
    }))
    .sort((left, right) => compareStrings(left.path, right.path));
}

/** Digest over the file list, independent of its order. */
function packageDigest(entries) {
  const canonical = [...entries]
    .map(({ path, sha256, bytes }) => ({ path, sha256, bytes }))
    .sort((left, right) => compareStrings(left.path, right.path));
  return sha256Hex(Buffer.from(JSON.stringify(canonical), "utf8"));
}

/**
 * Builds the manifest body. The caller supplies `produced_at`, because a pure
 * compiler may not read the clock.
 */
export function buildManifest({
  files,
  digests,
  ceiling,
  ceiling_requested = ceiling,
  downgraded_by = [],
  denominators = [],
  compiler,
  analysis_digest,
  produced_at,
} = {}) {
  if (typeof produced_at !== "string" || !ISO_UTC.test(produced_at)) {
    throw new ManifestError(
      `produced_at must be an ISO-8601 UTC timestamp, got ${JSON.stringify(produced_at)}`,
    );
  }
  if (!CEILING_ORDER.includes(ceiling)) {
    throw new ManifestError(
      `ceiling must be one of ${CEILING_ORDER.join(", ")}, got ${JSON.stringify(ceiling)}`,
    );
  }
  if (!CEILING_ORDER.includes(ceiling_requested)) {
    throw new ManifestError(
      `ceiling_requested must be one of ${CEILING_ORDER.join(", ")}, got ${JSON.stringify(ceiling_requested)}`,
    );
  }
  if (!Array.isArray(downgraded_by)) {
    throw new ManifestError(
      `downgraded_by must be an array of <class>:<probe>, got ${JSON.stringify(downgraded_by)}`,
    );
  }
  for (const reason of downgraded_by) {
    if (typeof reason !== "string" || !DOWNGRADE.test(reason)) {
      throw new ManifestError(
        `downgraded_by entries must look like apk:no-execution-grant, got ${JSON.stringify(reason)}`,
      );
    }
  }
  if (typeof compiler !== "string" || compiler.trim() === "") {
    throw new ManifestError("compiler must be a non-empty string");
  }
  const declaredDenominators = normaliseDenominators(denominators);
  if (analysis_digest !== undefined && !SHA256_HEX.test(analysis_digest)) {
    throw new ManifestError(
      "analysis_digest must be a lowercase sha256 hex digest",
    );
  }

  const entries = normaliseFiles(files);
  const named = {};
  for (const [name, value] of Object.entries(digests ?? {})) {
    if (name === "package" || name === "blueprint") {
      throw new ManifestError(
        `digests.${name} is computed from the packaged files and cannot be supplied`,
      );
    }
    if (typeof value !== "string" || !SHA256_HEX.test(value)) {
      throw new ManifestError(
        `digests.${name} must be a lowercase sha256 hex digest`,
      );
    }
    named[name] = value;
  }
  const blueprint = entries.find((entry) => entry.path === "BLUEPRINT.md");
  if (blueprint) named.blueprint = blueprint.sha256;
  named.package = packageDigest(entries);
  const sortedDigests = Object.fromEntries(
    Object.entries(named).sort(([left], [right]) =>
      compareStrings(left, right),
    ),
  );

  const manifest = {
    schema: MANIFEST_SCHEMA,
    schema_version: MANIFEST_SCHEMA_VERSION,
    ceiling,
    // §4: a downgrade is recorded with the probe that forced it, so a reader can
    // see what the run asked for and what it was allowed to prove.
    ceiling_requested,
    downgraded_by: [...downgraded_by],
    // The fixed denominator and the determinism rule travel with the archive, so
    // an unpacked package can be audited without the build that produced it.
    denominators: declaredDenominators,
    determinism: {
      ...DETERMINISM_RULE,
      scope: { ceiling, downgraded_by: [...downgraded_by] },
    },
    compiler,
  };
  if (analysis_digest !== undefined) manifest.analysis_digest = analysis_digest;
  manifest.produced_at = produced_at;
  manifest.digests = sortedDigests;
  manifest.files = entries;
  return manifest;
}

/** Returns the violation for one file entry, or null when it matches. */
function verifyFileEntry(entry, readFile) {
  const path = typeof entry?.path === "string" ? entry.path : "";
  if (path === "") {
    return {
      code: HASH_MISMATCH,
      subject: "(missing path)",
      detail: "manifest entry has no path",
    };
  }
  let bytes;
  try {
    bytes = readFile(path);
  } catch (error) {
    return {
      code: HASH_MISMATCH,
      subject: path,
      detail: `cannot read ${path}: ${error?.message ?? String(error)}`,
    };
  }
  if (bytes === undefined || bytes === null) {
    return {
      code: HASH_MISMATCH,
      subject: path,
      detail: `missing from the package: ${path}`,
    };
  }
  const buffer = toBuffer(bytes, `read(${path})`);
  const actual = sha256Hex(buffer);
  if (actual === entry.sha256 && buffer.length === entry.bytes) return null;
  return {
    code: HASH_MISMATCH,
    subject: path,
    detail: `${path} declares ${String(entry.sha256)} (${String(entry.bytes)} bytes) but holds ${actual} (${buffer.length} bytes)`,
  };
}

/**
 * Verifies a manifest against the bytes a reader returns.
 *
 * The file list may arrive in any order: entries are compared by path, and the
 * package digest is recomputed over the declared entries, so an edited manifest
 * body fails without being confused with edited file contents.
 */
export function verifyManifest(manifest, readFile) {
  if (manifest === null || typeof manifest !== "object") {
    throw new ManifestError("manifest must be an object");
  }
  if (typeof readFile !== "function") {
    throw new ManifestError("verifyManifest needs a reader function");
  }

  const violations = [];
  const push = (subject, detail) =>
    violations.push({ code: HASH_MISMATCH, subject, detail });

  const declared = Array.isArray(manifest.files) ? manifest.files : [];
  if (!Array.isArray(manifest.files)) {
    push("files", "manifest.files must be an array of file entries");
  }
  const entries = [...declared].sort((left, right) =>
    compareStrings(left?.path ?? "", right?.path ?? ""),
  );
  const seen = new Set();
  for (const entry of entries) {
    const path = typeof entry?.path === "string" ? entry.path : "";
    if (path !== "" && seen.has(path)) {
      push(path, `path appears more than once in the manifest: ${path}`);
      continue;
    }
    if (path !== "") seen.add(path);
    const violation = verifyFileEntry(entry, readFile);
    if (violation) push(violation.subject, violation.detail);
  }

  const usable = entries.filter(
    (entry) =>
      entry &&
      typeof entry.path === "string" &&
      typeof entry.sha256 === "string" &&
      Number.isInteger(entry.bytes),
  );
  if (manifest.digests?.package !== packageDigest(usable)) {
    push(
      "digests.package",
      "the package digest does not match the declared file list",
    );
  }
  const blueprint = usable.find((entry) => entry.path === "BLUEPRINT.md");
  if (blueprint && manifest.digests?.blueprint !== blueprint.sha256) {
    push(
      "digests.blueprint",
      "digests.blueprint does not match the BLUEPRINT.md entry",
    );
  }

  violations.sort(
    (left, right) =>
      compareStrings(left.subject, right.subject) ||
      compareStrings(left.code, right.code),
  );
  return { ok: violations.length === 0, violations };
}
