import assert from "node:assert/strict";
import { test } from "vitest";
import { Bundle } from "./blueprint-zip.mjs";
import { auditCheckEvidence, resolveEvidenceRef } from "./blueprint.mjs";

function context(entries = {}) {
  const bundle = new Bundle();
  for (const [name, value] of Object.entries(entries))
    bundle.addData(name, value);
  return { bundle };
}

test("resolves a real JSON pointer in a real bundle entry", () => {
  const ctx = context({
    "evidence/analysis.json": JSON.stringify({
      routes: [{ path: "/api/todos" }],
    }),
  });
  const result = resolveEvidenceRef(
    { path: "evidence/analysis.json", pointer: "/routes/0/path" },
    ctx,
  );
  assert.equal(result.ok, true);
  assert.equal(result.bytes > 0, true);
});

test("resolves a line, text marker and byte offset inside the referenced file", () => {
  const ctx = context({
    "surface/dom.html": "<html>\n<body>Test</body>\n</html>\n",
    "surface/shot.png": Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  });
  assert.equal(
    resolveEvidenceRef({ path: "surface/dom.html", line: 2 }, ctx).ok,
    true,
  );
  assert.equal(
    resolveEvidenceRef({ path: "surface/dom.html", contains: "<body>" }, ctx)
      .ok,
    true,
  );
  assert.equal(
    resolveEvidenceRef({ path: "surface/shot.png", offset: 0 }, ctx).ok,
    true,
  );
});

test("rejects a dangling path", () => {
  const result = resolveEvidenceRef(
    { path: "evidence/missing.json" },
    context(),
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /Datei fehlt/);
});

test("rejects an empty file", () => {
  const result = resolveEvidenceRef(
    { path: "evidence/empty.json" },
    context({ "evidence/empty.json": "" }),
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /leer/);
});

test("rejects a JSON pointer that does not resolve", () => {
  const ctx = context({ "evidence/a.json": JSON.stringify({ routes: [] }) });
  const result = resolveEvidenceRef(
    { path: "evidence/a.json", pointer: "/routes/0" },
    ctx,
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /Pointer nicht auflösbar/);
});

test("rejects a null JSON pointer value", () => {
  const ctx = context({ "evidence/a.json": JSON.stringify({ route: null }) });
  const result = resolveEvidenceRef(
    { path: "evidence/a.json", pointer: "/route" },
    ctx,
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /Pointer nicht auflösbar/);
});

test("rejects a missing text marker", () => {
  const ctx = context({ "BLUEPRINT.md": "# Blaupause\n" });
  const result = resolveEvidenceRef(
    { path: "BLUEPRINT.md", contains: "## 7. Rekonstruktionsplan" },
    ctx,
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /Textmarke/);
});

test("rejects a line outside the file", () => {
  const ctx = context({ "surface/dom.html": "<html />\n" });
  const result = resolveEvidenceRef({ path: "surface/dom.html", line: 2 }, ctx);
  assert.equal(result.ok, false);
  assert.match(result.reason, /Zeile/);
});

test("rejects an offset outside the file", () => {
  const ctx = context({ "surface/shot.png": Buffer.from([1, 2, 3]) });
  const result = resolveEvidenceRef(
    { path: "surface/shot.png", offset: 3 },
    ctx,
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /Offset/);
});

test("a check without evidence becomes open", () => {
  const check = {
    id: "negative.no-evidence",
    ok: true,
    detail: "claimed",
    evidence: [],
  };
  auditCheckEvidence(check, context(), {});
  assert.equal(check.ok, false);
  assert.equal(check.evidence_resolution.ok, false);
  assert.match(check.detail, /kein Beleg/);
});

test("a check with one valid and one dangling reference becomes open", () => {
  const ctx = context({ "evidence/a.json": JSON.stringify({ ok: true }) });
  const check = {
    id: "negative.partial",
    ok: true,
    detail: "claimed",
    evidence: [
      { path: "evidence/a.json", pointer: "/ok" },
      { path: "evidence/missing.json" },
    ],
  };
  auditCheckEvidence(check, ctx, {});
  assert.equal(check.ok, false);
  assert.equal(check.evidence_resolution.resolved, 1);
  assert.equal(check.evidence_resolution.total, 2);
  assert.match(check.detail, /Datei fehlt/);
});

test("virtual output documents are resolved without pretending they are source evidence", () => {
  const ctx = context();
  const result = resolveEvidenceRef(
    { path: "BLUEPRINT.md", contains: "**Ziel:**" },
    ctx,
    { "BLUEPRINT.md": "# Blaupause\n\n- **Ziel:** Test\n" },
  );
  assert.equal(result.ok, true);
});
