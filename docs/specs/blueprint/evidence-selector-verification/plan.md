# Evidence Selector Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every claim's evidence selector resolvable, checked at build time and in an unpacked package, and record the ceiling downgrade in the manifest.

**Architecture:** One pure resolver in `ui/blueprint/evidence.mjs` turns `(bytes, selector)` into `ok` or a German reason. The build gate and the standalone package verifier both call it, so a claim that cites a DOM node, request, pointer, line range or byte range the package does not contain becomes a violation instead of prose. Legacy shorthand refs keep resolving through the same function, so nothing that already passes changes behaviour.

**Tech Stack:** Node.js ESM `.mjs`, Vitest project `ui-evidence` (`ui/**/*.test.mjs`), no dependencies, `Buffer` over raw bytes.

**Spec:** [`spec.md`](spec.md) (delta) · [`claim-compiler/spec.md`](../claim-compiler/spec.md) §4, §5, §8 (parent contract)

## Global Constraints

- No runtime dependencies. Selectors are resolved with `Buffer`, `JSON.parse` and the existing `matchesSelector` grammar — no CSS engine, no `ajv` in production code.
- `ui/` stays outside the compiled runtime; nothing here may be imported from `src/`.
- `src/artifacts/NodeSeaArtifactReader.ts` and the three carrier-identity tests (`NodeSeaArtifactReader.test.ts`, `Uf2ArtifactReader.test.ts`, `pyinstaller/PyInstallerBoundaries.test.ts`) stay untouched.
- Reason strings are German like the existing resolver (`Datei fehlt oder ist leer: …`, `Pointer nicht auflösbar: …`); violation codes and JSON keys stay English.
- Resolve over **bytes**, not decoded text: `lines` splits on `\r?\n`, `byte-range` indexes the `Buffer`.
- Legacy shorthand (`pointer`, `contains`, `line`, `offset`) must behave exactly as `resolveEvidenceRef` does today; `ui/blueprint-evidence.test.mjs` (12 tests) must pass unchanged at every task.
- Conventional Commit subjects. No push.

## Environment

Verified on this Linux box on 2026-11-20 (Ubuntu-family, 2 vCPU, 3.9 GB RAM, no swap):

| Check | Result |
| --- | --- |
| `npx vitest run --project ui-evidence` | 145/145 pass |
| `npm run typecheck` | exit 0 |
| `npm run docs:check` | exit 0 — **only** under the pinned Node 24.22.1 |
| `npx oxlint .` | **SIGABRT**, oxc#20331 |

Two facts an implementer will otherwise hit:

1. The image ships Node 26.13.0 only. `scripts/lib/verifier-source-loader.mjs:187`
   refuses to run when the version differs from `.nvmrc`, so `docs:check` fails
   with "requires the Node.js version pinned in .nvmrc". Install the pin into the
   home directory and put it first on `PATH`:
   `curl -fsSL https://nodejs.org/dist/v24.22.1/node-v24.22.1-linux-x64.tar.xz | tar -xJ -C "$HOME/.local"`.
2. `check:fast` cannot pass here. `.oxlintrc.json` loads `jsPlugins`
   (`./scripts/lint/index.mjs`), which makes oxlint reserve ~4 GiB per thread; with
   `vm.overcommit_memory=0` and no swap the kernel refuses the mapping and the
   binary aborts. The host has no root, so swap cannot be added. This is an
   environment limit, not a defect in this change: run `npm run typecheck`,
   `npm run verify:architecture-guards` and the `ui-evidence` project locally and
   let CI run `lint`. Do not weaken `.oxlintrc.json` to make it pass.

## Review Focus

1. **Empty evidence file with `whole`** — a zero-byte file proves nothing; a
   `whole` selector over it must be unresolved, not "the path exists". Pinned in
   Task 1.
2. **Off-by-one JSON pointers and request indexes** — `#/requests/3` in a
   two-request transcript and `{type:"request",index:2}` in the same file must
   both be unresolved rather than silently pointing at nothing. Pinned in Task 1.
3. **Binary and non-UTF-8 evidence** — `byte-range` must measure the `Buffer`, so
   a range inside a PNG is valid and a range one byte past the end is not. Pinned
   in Task 1.
4. **Loose DOM matching** — `a[href="/orders"]` must not match
   `href="/orders-old"`, and `#buy` must not match `id="buy-now"`. Pinned in
   Task 1.
5. **Gate convergence across its two passes** — the first pass reads bundle
   bytes, the second the packaged bytes; if only one pass can resolve selectors,
   a bad selector surfaces as "the gate did not converge" instead of the
   violation that caused it. Pinned in Task 2.

---

## File Structure

```
ui/blueprint/evidence.mjs            resolver: SELECTOR_TYPES, resolveSelector, resolveEvidence
ui/blueprint/evidence.test.mjs       table per selector kind, pass and fail
ui/blueprint/gate.mjs                checkEvidence resolves the selector (R2)
ui/blueprint/package-verify.mjs      same check on an unpacked package (R3)
ui/blueprint/manifest.mjs            ceiling_requested + downgraded_by (R4)
ui/blueprint/schemas/manifest.schema.json   the two new properties
ui/blueprint.mjs                     pass readFile to both gate passes; pass the downgrade to buildManifest
docs/specs/blueprint/claim-compiler/spec.md  paths, package parts, codes (R5)
```

`matchesSelector` stays in `ui/blueprint/run-acceptance.mjs` and is imported by
`evidence.mjs`; it is the single DOM vocabulary for both acceptance and evidence.

## Contracts

```js
// ui/blueprint/evidence.mjs
export const SELECTOR_TYPES = ["whole", "pointer", "lines", "dom", "request", "byte-range"];

/** @returns {{ ok: true } | { ok: false, reason: string }} */
export function resolveSelector(bytes, selector): { ok: boolean, reason?: string }

/** Reads `reference.path` through `readFile` and resolves its selector.
 *  `readFile` returns Buffer | Uint8Array | undefined. Legacy shorthand is
 *  handled here, so callers pass the reference object unchanged. */
export function resolveEvidence(reference, readFile): { ok: boolean, reason?: string }

// ui/blueprint/manifest.mjs — additive fields, existing callers unaffected
export function buildManifest({
  files, digests, ceiling,
  ceiling_requested = ceiling,   // defaults to the resolved ceiling
  downgraded_by = [],            // defaults to [] so old call sites stay valid
  compiler, analysis_digest, produced_at,
}): Manifest
```

`selector` shapes resolved: `{type:"whole"}`, `{type:"pointer",pointer}`,
`{type:"lines",from,to}`, `{type:"dom",path}`, `{type:"request",index}`,
`{type:"byte-range",from,to}`, plus the legacy `{pointer}` / `{contains}` /
`{line}` / `{offset}` fields. An unknown `type` is `{ok:false}` with
`Selektor nicht unterstützt: <type>` — never a silent pass.

Violation code (R2, R3): `claim.evidence.selector_unresolved`, added to
`VIOLATION_CODES` in `gate.mjs` and to §8 of the parent spec.

---

### Task 1: The selector resolver

**Files:**
- Create: `ui/blueprint/evidence.mjs`, `ui/blueprint/evidence.test.mjs`
- Modify: `ui/blueprint.mjs` (`resolveEvidenceRef` delegates the new selector shapes; keep its exported behaviour)

**Interfaces:**
- Consumes: `matchesSelector(html, {type:"dom", path})` from `./run-acceptance.mjs`; `jsonPointerValue` logic already in `ui/blueprint.mjs` (move it into `evidence.mjs` and import it back if that is simpler than duplicating it).
- Produces: `SELECTOR_TYPES`, `resolveSelector`, `resolveEvidence` for Tasks 2–3.

- [x] **Step 1: Write the failing test**

```js
import assert from "node:assert/strict";
import { test } from "vitest";
import { resolveSelector } from "./evidence.mjs";

const json = (value) => Buffer.from(JSON.stringify(value), "utf8");
const capture = json({
  events: { items: [
    { kind: "request", url: "/api/orders", method: "POST" },
    { kind: "request", url: "/api/cart", method: "GET" },
  ] },
});
const html = Buffer.from('<button id="buy">Kaufen</button><a href="/orders">x</a>', "utf8");

test("whole resolves only a non-empty file", () => {
  assert.deepEqual(resolveSelector(html, { type: "whole" }), { ok: true });
  const empty = resolveSelector(Buffer.alloc(0), { type: "whole" });
  assert.equal(empty.ok, false);
});

test("request indexes the recorded requests", () => {
  assert.deepEqual(resolveSelector(capture, { type: "request", index: 1 }), { ok: true });
  assert.equal(resolveSelector(capture, { type: "request", index: 2 }).ok, false);
  assert.match(
    resolveSelector(capture, { type: "request", index: 2 }).reason,
    /Anfrage #2/,
  );
});

test("dom uses the acceptance matcher and does not match loosely", () => {
  assert.deepEqual(resolveSelector(html, { type: "dom", path: "#buy" }), { ok: true });
  assert.deepEqual(resolveSelector(html, { type: "dom", path: 'a[href="/orders"]' }), { ok: true });
  assert.equal(resolveSelector(html, { type: "dom", path: "#missing" }).ok, false);
  assert.equal(resolveSelector(html, { type: "dom", path: "#buy-now" }).ok, false);
  assert.equal(resolveSelector(html, { type: "dom", path: 'a[href="/orders-old"]' }).ok, false);
});

test("pointer resolves a JSON pointer and refuses a missing index", () => {
  const doc = json({ requests: [{ id: 1 }, { id: 2 }] });
  assert.deepEqual(resolveSelector(doc, { type: "pointer", pointer: "/requests/1" }), { ok: true });
  assert.equal(resolveSelector(doc, { type: "pointer", pointer: "/requests/3" }).ok, false);
});

test("lines counts CRLF lines and refuses a range past the end", () => {
  const text = Buffer.from("a\r\nb\r\nc\r\n", "utf8");
  assert.deepEqual(resolveSelector(text, { type: "lines", from: 1, to: 3 }), { ok: true });
  assert.equal(resolveSelector(text, { type: "lines", from: 2, to: 4 }).ok, false);
  assert.equal(resolveSelector(text, { type: "lines", from: 3, to: 2 }).ok, false);
});

test("byte-range measures raw bytes", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10]);
  assert.deepEqual(resolveSelector(png, { type: "byte-range", from: 0, to: 7 }), { ok: true });
  assert.equal(resolveSelector(png, { type: "byte-range", from: 0, to: 8 }).ok, false);
});

test("an unknown selector type is refused, never silent", () => {
  const result = resolveSelector(html, { type: "css", path: "#buy" });
  assert.equal(result.ok, false);
  assert.match(result.reason, /nicht unterstützt/);
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project ui-evidence ui/blueprint/evidence.test.mjs`
Expected: FAIL, `Cannot find module './evidence.mjs'`.

- [x] **Step 3: Implement `ui/blueprint/evidence.mjs`**

`resolveSelector` switches on `selector.type`; `resolveEvidence` reads the file through `readFile`, returns `{ok:false, reason:`Datei fehlt oder ist leer: ${path}`}` when the bytes are missing or empty, then delegates. Without a `type`, apply the legacy fields in the same order and with the same reasons as today's `resolveEvidenceRef`. `request` filters `events.items` to `kind === "request"` before indexing, matching `transcript-client.mjs`.

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project ui-evidence ui/blueprint/evidence.test.mjs ui/blueprint-evidence.test.mjs`
Expected: PASS, 12 legacy tests still green.

- [x] **Step 5: Commit**

```bash
git add ui/blueprint/evidence.mjs ui/blueprint/evidence.test.mjs ui/blueprint.mjs
git commit -m "feat(blueprint): resolve evidence selectors by type"
```

### Task 2: The gate refuses unresolvable selectors

**Files:**
- Modify: `ui/blueprint/gate.mjs` (`VIOLATION_CODES`, `checkEvidence`), `ui/blueprint.mjs` (both `gate(...)` calls), `ui/blueprint/gate.test.mjs`

**Interfaces:**
- Consumes: `resolveEvidence` from Task 1.
- Produces: `checkEvidence(claim, files, violations, readFile)`; the code `claim.evidence.selector_unresolved`.

- [x] **Step 1: Write the failing test**

Add to `gate.test.mjs`: clone the passing fixture, replace one observed claim's evidence with `{ path: "surface/dom.html", selector: { type: "dom", path: "#missing" } }`, call `gate(bp, ledger, acceptance, { ...ctx, readFile: (path) => path === "surface/dom.html" ? Buffer.from('<button id="buy">') : Buffer.alloc(0) })`, and assert the violation list is exactly one entry with `code === "claim.evidence.selector_unresolved"`, `subject` equal to the claim id, and `status !== "complete"`. Add a second case: the same claim with `#buy` yields no violation.

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project ui-evidence ui/blueprint/gate.test.mjs`
Expected: FAIL, the violation list is empty for `#missing`.

- [x] **Step 3: Implement**

In `checkEvidence`, after the `files.has(ref.path)` check and only when `ref.selector` is present, call `resolveEvidence(ref, ctx.readFile)` and push `claim.evidence.selector_unresolved` with detail `${ref.path}: ${reason}`. In `buildBlueprint`, pass a `readFile` to **both** gate calls — the first reads `bundleEntryBuffer(ctx, path)`, the second already reads packaged bytes — so the two passes see identical evidence and cannot disagree about a selector.

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project ui-evidence`
Expected: PASS; the existing 419-line gate suite is unchanged.

- [x] **Step 5: Commit**

```bash
git add ui/blueprint/gate.mjs ui/blueprint/gate.test.mjs ui/blueprint.mjs
git commit -m "feat(blueprint): refuse claims whose selector resolves nowhere"
```

### Task 3: The unpacked package check

**Files:**
- Modify: `ui/blueprint/package-verify.mjs`, `ui/blueprint/package-verify.test.mjs`

**Interfaces:**
- Consumes: `resolveEvidence` from Task 1.
- Produces: `claims.selectors: { checked, unresolved }` in the `verifyPackageDir` report; the same violation code as Task 2.

- [x] **Step 1: Write the failing test**

In `package-verify.test.mjs`, extend the existing package fixture with a claim whose evidence is `surface/dom.html` + `{ type: "dom", path: "#missing" }`, include that file in the manifest with a correct hash, and assert `report.ok === false` with exactly one `claim.evidence.selector_unresolved` and `report.claims.selectors.unresolved === 1`. The unmodified fixture must still report `ok: true`.

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project ui-evidence ui/blueprint/package-verify.test.mjs`
Expected: FAIL, `report.ok` is `true`.

- [x] **Step 3: Implement**

Reuse the `read` helper the module already builds from the unpacked files, resolve each claim's selector next to the existing sha256 loop, count into `claims.selectors`, and add the violation. Do not consult the source tree.

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project ui-evidence ui/blueprint/package-verify.test.mjs`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add ui/blueprint/package-verify.mjs ui/blueprint/package-verify.test.mjs
git commit -m "feat(blueprint): check claim selectors in an unpacked package"
```

### Task 4: The manifest records the downgrade

**Files:**
- Modify: `ui/blueprint/manifest.mjs`, `ui/blueprint/manifest.test.mjs`, `ui/blueprint/schemas/manifest.schema.json`, `ui/blueprint/schemas.test.mjs`, `ui/blueprint.mjs` (the `buildManifest` call)

**Interfaces:**
- Consumes: `bp.ceiling` = `{ requested, ceiling, downgraded_by }`, already produced by `analysis.mjs`.
- Produces: `manifest.ceiling_requested` and `manifest.downgraded_by` (array of `<class>:<reason>`).

- [x] **Step 1: Write the failing test**

In `manifest.test.mjs`: `buildManifest({ files, ceiling: "statically-evidenced", ceiling_requested: "executed", downgraded_by: ["apk:no-execution-grant"], compiler, produced_at })` yields those two fields, and `downgraded_by` is `[]` when omitted. In `schemas.test.mjs`: the same manifest validates, and one with `downgraded_by: "apk"` (not an array) is rejected.

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project ui-evidence ui/blueprint/manifest.test.mjs ui/blueprint/schemas.test.mjs`
Expected: FAIL, `ceiling_requested` is `undefined`.

- [x] **Step 3: Implement**

Add both parameters with defaults (`ceiling_requested = ceiling`, `downgraded_by = []`), validate that each entry matches `^[a-z]+:[a-z0-9-]+$`, and place them after `ceiling` in the manifest body. Add both to `properties` and `required` in `manifest.schema.json`, keeping `additionalProperties: false`. In `buildBlueprint`, pass `conditional` values from `bp.ceiling`.

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project ui-evidence`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add ui/blueprint/manifest.mjs ui/blueprint/manifest.test.mjs ui/blueprint/schemas ui/blueprint.mjs
git commit -m "feat(blueprint): record the ceiling downgrade in the manifest"
```

### Task 5: Bring the parent spec in line with the shipped package

**Files:**
- Modify: `docs/specs/blueprint/claim-compiler/spec.md` (lines ~248, ~255–258, §5, §6, §8, §10), `docs/specs/README.md`

**Interfaces:** none; documentation only.

- [x] **Step 1: Correct the spec**

`§5`: list `whole` and the resolver's actual vocabulary. `§8`: add `claim.evidence.selector_unresolved`. `§9`: `acceptance/run-acceptance.mjs` → `ui/blueprint/run-acceptance.mjs`. `§10`: `tests/fidelity/corpus/` → `ui/blueprint/corpus/`, and document `npm run blueprint:verify -- <paketverzeichnis>`. `§6`: four schemas, not three. Package inventory: add `README.txt`, `ledger.json`, `acceptance.json`, `MANIFEST.json`, `GATE-REPORT.json`, `schemas/`, `flows/`, `specs/`, and `surface/accessibility.txt` + `surface/storage.json`. Confirm `docs/specs/README.md` lists both blueprint features with resolvable relative links.

- [x] **Step 2: Run the documentation gate**

Run: `npm run docs:check`
Expected: exit 0 (requires the pinned Node from `## Environment`).

- [x] **Step 3: Run the full feature gate**

Run: `npx vitest run --project ui-evidence`
Expected: PASS.

- [x] **Step 4: Commit**

```bash
git add docs/specs/blueprint/claim-compiler/spec.md docs/specs/README.md
git commit -m "docs(blueprint): describe the selectors and parts the package ships"
```

## Self-review

- **Spec coverage:** R1 → Task 1. R2 → Task 2. R3 → Task 3. R4 → Task 4. R5 → Task 5.
- **Step scan:** each step names one file, one test or one command; no step says "handle edge cases".
- **Type consistency:** `resolveSelector`/`resolveEvidence` are spelled identically in Tasks 1–3; `claim.evidence.selector_unresolved` is the single code in Tasks 2 and 3 and in Task 5's §8; `ceiling_requested`/`downgraded_by` match between Task 4's test, implementation and schema.
- **Review Focus:** empty `whole` → Task 1; off-by-one pointer/request → Task 1; binary byte-range → Task 1; loose DOM match → Task 1; gate convergence → Task 2.
- **Proportion:** five tasks over roughly 120 lines of source, against a parent feature of 63 files and ~11 600 insertions. This closes one contract and its drift, not a second feature.

## Risks

| Risk | Mitigation |
| --- | --- |
| Legacy refs regress and `blueprint-evidence.test.mjs` breaks | `resolveEvidence` keeps the shorthand path; that file runs in every task's Step 4 |
| Gate passes disagree and report convergence instead of the violation | Task 2 passes `readFile` to both passes |
| A real package now fails because a selector was never checked | Corpus + e2e run before merging: `blueprint:verify` (175/175) and `blueprint:fidelity` (`pass`) must stay green |
