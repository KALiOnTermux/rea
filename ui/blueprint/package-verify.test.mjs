import assert from "node:assert/strict";
import {
  cp,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { buildBlueprint } from "../blueprint.mjs";
import { buildManifest } from "./manifest.mjs";
import { checkDeclarations, verifyPackageDir } from "./package-verify.mjs";
import { renderMarkdown, renderPrompt } from "./render.mjs";

const FIXTURE = fileURLToPath(
  new URL("./corpus/web-fixture/", import.meta.url),
);

async function buildPackage() {
  const artifactsDir = await mkdtemp(join(tmpdir(), "rea-verify-build-"));
  const result = await buildBlueprint({
    kind: "web",
    target: "https://shop.test/",
    input: { web: { capture: join(FIXTURE, "blueprint", "capture.json") } },
    artifactsDir,
    includeSources: false,
    reaVersion: "verify",
    onProgress: () => {},
  });
  return result;
}

/** Copies the built package to a place outside the repository, as a user would. */
async function unpack(result) {
  const root = await mkdtemp(join(tmpdir(), "rea-verify-unpacked-"));
  const target = join(root, "package");
  await cp(result.dir, target, { recursive: true });
  // The zip is the download, not a package part: an unpacked package has none.
  await rm(join(target, basename(result.zipPath)), { force: true }).catch(
    () => {},
  );
  return target;
}

async function walk(root, prefix = "") {
  const names = [];
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  for (const entry of entries) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) names.push(...(await walk(root, relative)));
    else names.push(relative);
  }
  return names;
}

/**
 * Rewrites one claim in an unpacked package so only its selector is wrong.
 * The blueprint, the rendered document and the manifest are rewritten together,
 * so the selector is the sole defect the verifier can find.
 */
async function withDomSelector(selector) {
  const result = await buildPackage();
  const root = await unpack(result);
  const blueprintPath = join(root, "blueprint.json");
  const blueprint = JSON.parse(await readFile(blueprintPath, "utf8"));
  const template = blueprint.claims.find(
    (claim) =>
      claim.kind === "observed" &&
      claim.evidence.some((ref) => ref.selector?.type === "whole"),
  );
  blueprint.claims.push({
    ...structuredClone(template),
    id: "web.dom.selector-check",
    subject: "/facts/behavior/dom/selector-check",
    evidence: [{ path: "surface/dom.html", selector }],
  });
  await writeFile(
    blueprintPath,
    `${JSON.stringify(blueprint, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(root, "BLUEPRINT.md"),
    renderMarkdown({ blueprint, claims: blueprint.claims }),
    "utf8",
  );
  await writeFile(
    join(root, "AGENT-PROMPT.md"),
    renderPrompt({ blueprint, claims: blueprint.claims }),
    "utf8",
  );
  await rehashManifest(root);
  return root;
}

/** Rebuilds MANIFEST.json over the current bytes, keeping every declaration. */
async function rehashManifest(root) {
  const previous = JSON.parse(
    await readFile(join(root, "MANIFEST.json"), "utf8"),
  );
  const files = {};
  for (const name of await walk(root)) {
    if (name === "MANIFEST.json") continue;
    files[name] = await readFile(join(root, name));
  }
  const manifest = buildManifest({
    files,
    ceiling: previous.ceiling,
    ceiling_requested: previous.ceiling_requested,
    downgraded_by: previous.downgraded_by,
    denominators: previous.denominators?.classes ?? [],
    compiler: previous.compiler,
    analysis_digest: previous.analysis_digest,
    produced_at: previous.produced_at,
  });
  await writeFile(
    join(root, "MANIFEST.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}

/** Unpacks the real package and rewrites one shipped document. */
async function withDocEdit(name, edit) {
  const result = await buildPackage();
  const root = await unpack(result);
  const path = join(root, name);
  const text = await readFile(path, "utf8");
  await writeFile(path, edit(text), "utf8");
  await rehashManifest(root);
  return root;
}

/** Rewrites the ledger of an unpacked package so only that defect remains. */
async function withLedgerMutation(mutate) {
  const result = await buildPackage();
  const root = await unpack(result);
  const ledgerPath = join(root, "ledger.json");
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  mutate(ledger);
  await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
  await rehashManifest(root);
  return root;
}

test("a document that counts claims differently fails", async () => {
  const root = await withDocEdit("BLUEPRINT.md", (text) =>
    text.replace(
      /\*\*Behauptungen:\*\* (\d+) gesamt/,
      (_, total) => `**Behauptungen:** ${Number(total) + 1} gesamt`,
    ),
  );
  const report = await verifyPackageDir(root);
  assert.equal(report.ok, false);
  assert.equal(
    report.violations.some((item) => item.code === "docs.claim_count.mismatch"),
    true,
    JSON.stringify(report.violations),
  );
});

test("a document that claims a different ceiling fails", async () => {
  const root = await withDocEdit("AGENT-PROMPT.md", (text) =>
    text.replace("Evidenz-Decke: executed", "Evidenz-Decke: inferred-only"),
  );
  const report = await verifyPackageDir(root);
  assert.equal(report.ok, false);
  assert.equal(
    report.violations.some((item) => item.code === "docs.ceiling.mismatch"),
    true,
    JSON.stringify(report.violations),
  );
});

test("a missing claim-kind section fails", async () => {
  const root = await withDocEdit("BLUEPRINT.md", (text) =>
    text.replace("## 7. Angenommen (assumed)", "## 7. Sonstiges"),
  );
  const report = await verifyPackageDir(root);
  assert.equal(report.ok, false);
  assert.equal(
    report.violations.some((item) => item.code === "docs.section.missing"),
    true,
    JSON.stringify(report.violations),
  );
});

test("an unmarked empty category is a violation", () => {
  const violations = [];
  const lines = (names) => names.join("\n");
  checkDeclarations({
    manifest: { ceiling: "executed", downgraded_by: [] },
    blueprint: { claims: [{ kind: "observed" }] },
    contents: new Map([
      [
        "BLUEPRINT.md",
        Buffer.from(
          lines([
            "- **Evidenz-Decke:** executed",
            "- **Herabstufungen:** keine",
            "- **Behauptungen:** 1 gesamt · 1 observed · 0 derived · 0 assumed",
            "## 5. Beobachtet (observed)",
            "## 6. Abgeleitet (derived)",
            "## 7. Angenommen (assumed)",
            "## 9. Offene Punkte",
          ]),
        ),
      ],
      [
        "AGENT-PROMPT.md",
        Buffer.from(
          lines([
            "Evidenz-Decke: executed",
            "Herabstufungen: keine",
            "Behauptungen: 1 gesamt · 1 observed · 0 derived · 0 assumed",
            "## Evidenzlage (verbindlich)",
            "Beobachtet (observed): 1 Claims, belegt durch Dateien im Paket.",
            "Abgeleitet (derived): 0 Claims, aus belegten Bytes rekonstruiert.",
            "Angenommen (assumed): keine Annahme im Paket; jede neue Annahme ist zu kennzeichnen und zu prüfen.",
            "Offene Lücken: keine im Rahmen dieser Erhebung.",
          ]),
        ),
      ],
    ]),
    add: (code, subject, detail) => violations.push({ code, subject, detail }),
  });
  assert.deepEqual(
    violations.map((item) => [item.code, item.subject]),
    [["docs.section.empty_unmarked", "BLUEPRINT.md#assumed"]],
  );
});

test("a downgrade the manifest does not declare fails", async () => {
  const root = await withDocEdit("BLUEPRINT.md", (text) =>
    text.replace("**Herabstufungen:** keine", "**Herabstufungen:** `apk:no-grant`"),
  );
  const report = await verifyPackageDir(root);
  assert.equal(report.ok, false);
  assert.equal(
    report.violations.some((item) => item.code === "docs.downgrade.mismatch"),
    true,
    JSON.stringify(report.violations),
  );
});

test("a removed required unit fails with its own code", async () => {
  const root = await withLedgerMutation((ledger) => {
    const index = ledger.entries.findIndex(
      (entry) => entry.status === "covered",
    );
    ledger.entries.splice(index, 1);
  });
  const report = await verifyPackageDir(root);
  assert.equal(report.ok, false);
  assert.equal(
    report.violations.some((item) => item.code === "ledger.unit.missing"),
    true,
    JSON.stringify(report.violations),
  );
});

test("an added unit is reported instead of growing the denominator", async () => {
  const root = await withLedgerMutation((ledger) => {
    const entry = ledger.entries.find((item) => item.status === "covered");
    ledger.entries.push({
      ...entry,
      id: `${entry.class}:extra-unit`,
      subject: "extra-unit",
    });
  });
  const report = await verifyPackageDir(root);
  assert.equal(report.ok, false);
  assert.equal(
    report.violations.some((item) => item.code === "ledger.unit.unexpected"),
    true,
    JSON.stringify(report.violations),
  );
});

test("a reclassified unit is reported as a class mismatch", async () => {
  const root = await withLedgerMutation((ledger) => {
    const index = ledger.entries.findIndex((item) => item.class === "asset");
    const entry = ledger.entries[index];
    ledger.entries[index] = {
      ...entry,
      class: "dom-node",
      id: "dom-node:moved-unit",
      subject: "moved-unit",
    };
  });
  const report = await verifyPackageDir(root);
  assert.equal(report.ok, false);
  assert.equal(
    report.violations.some(
      (item) => item.code === "ledger.unit.reclassified",
    ),
    true,
    JSON.stringify(report.violations),
  );
});

test("a claim whose selector resolves nowhere fails the unpacked check", async () => {
  const root = await withDomSelector({ type: "dom", path: "#missing" });
  const report = await verifyPackageDir(root);
  assert.equal(report.ok, false);
  const found = report.violations.filter(
    (item) => item.code === "claim.evidence.selector_unresolved",
  );
  assert.equal(found.length, 1, JSON.stringify(report.violations));
  assert.equal(found[0].subject, "web.dom.selector-check");
  assert.equal(report.claims.selectors.unresolved, 1);
});

test("the same claim passes when its selector resolves in the package", async () => {
  const root = await withDomSelector({ type: "dom", path: "#buy" });
  const report = await verifyPackageDir(root);
  assert.deepEqual(report.violations, []);
  assert.equal(report.claims.selectors.unresolved, 0);
  assert.equal(report.claims.selectors.checked > 0, true);
});

test("a package verifies outside the repository", async () => {
  const result = await buildPackage();
  const root = await unpack(result);
  const report = await verifyPackageDir(root);
  assert.deepEqual(report.violations, []);
  assert.equal(report.ok, true);
  assert.equal(report.gate.ok, true);
  assert.equal(report.gate.violations, 0);
  assert.equal(report.references.unresolved.length, 0);
  assert.equal(report.references.resolved > 0, true);
  assert.equal(report.claims.hashed > 0, true);
  assert.equal(report.claims.mismatched, 0);
  for (const part of [
    "BLUEPRINT.md",
    "blueprint.json",
    "AGENT-PROMPT.md",
    "ledger.json",
    "acceptance.json",
    "flows/flows.json",
    "specs/ui.md",
    "specs/logic.md",
    "schemas/claims.schema.json",
    "schemas/ledger.schema.json",
    "schemas/manifest.schema.json",
    "schemas/flows.schema.json",
    "evidence/web-capture.json",
    "surface/dom.html",
    "MANIFEST.json",
  ]) {
    assert.equal(report.files.includes(part), true, part);
  }
});

test("a missing package part is a violation, not a silent gap", async () => {
  const result = await buildPackage();
  const root = await unpack(result);
  await rm(join(root, "specs", "logic.md"));
  const report = await verifyPackageDir(root);
  assert.equal(report.ok, false);
  assert.equal(
    report.violations.some((item) => item.code === "manifest.hash_mismatch"),
    true,
    JSON.stringify(report.violations),
  );
});

test("a changed evidence file breaks the claim digest", async () => {
  const result = await buildPackage();
  const root = await unpack(result);
  const path = join(root, "evidence", "web-capture.json");
  const capture = JSON.parse(await readFile(path, "utf8"));
  capture.url = "https://shop.test/anders";
  await writeFile(path, `${JSON.stringify(capture, null, 2)}\n`, "utf8");
  const report = await verifyPackageDir(root);
  assert.equal(report.ok, false);
  assert.equal(report.claims.mismatched > 0, true);
  assert.equal(
    report.violations.some(
      (item) => item.code === "claim.evidence.hash_mismatch",
    ),
    true,
  );
});

test("a dangling reference is reported by path and origin", async () => {
  const result = await buildPackage();
  const root = await unpack(result);
  const path = join(root, "specs", "ui.md");
  const text = await readFile(path, "utf8");
  await writeFile(path, `${text}\nSiehe \`specs/fehlt.md\`.\n`, "utf8");
  const report = await verifyPackageDir(root);
  assert.equal(report.ok, false);
  const dangling = report.violations.find(
    (item) => item.code === "package.reference.unresolved",
  );
  assert.equal(dangling.subject, "specs/fehlt.md");
  assert.equal(dangling.detail.includes("specs/ui.md"), true);
});

test("the package parts are deterministic across two builds", async () => {
  const first = await buildPackage();
  const second = await buildPackage();
  for (const name of ["flows/flows.json", "specs/ui.md", "specs/logic.md"]) {
    const [a, b] = await Promise.all([
      readFile(join(first.dir, name), "utf8"),
      readFile(join(second.dir, name), "utf8"),
    ]);
    assert.equal(a, b, name);
  }
});
