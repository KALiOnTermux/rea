#!/usr/bin/env node
/**
 * The negative proofs that travel with the package (spec §10).
 *
 * A package that claims to be fail-closed has to show that it actually refuses
 * defects. Each proof copies the package, changes exactly one place, reseals the
 * manifest (so the change is the only defect) and names the codes the check must
 * report with exit 1. The recipes and expectations ship inside the archive; the
 * checker itself is `npm run blueprint:verify` from the source tree.
 *
 * This module is both the library the tests use and the file the build copies to
 * `audit/mutate.mjs`, so there is one implementation and no drifting copy. It
 * imports only Node built-ins and never reads the clock.
 */

import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const MANIFEST = "MANIFEST.json";
const BLUEPRINT = "blueprint.json";
const LEDGER = "ledger.json";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

const writeJson = async (path, value) =>
  writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");

/** Every regular file below root, sorted by code point like the manifest. */
async function walk(root, prefix = "") {
  const names = [];
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  for (const entry of entries.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  )) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) names.push(...(await walk(root, relative)));
    else if (entry.isFile()) names.push(relative);
  }
  return names;
}

/**
 * Recomputes the manifest's file list and its two derived digests, keeping every
 * declaration. Without this step a mutation would also break the sealed hashes,
 * and the proof would no longer show that the intended check is the one that
 * fires.
 */
async function reseal(root) {
  const manifest = await readJson(join(root, MANIFEST));
  const files = [];
  for (const path of await walk(root)) {
    if (path === MANIFEST) continue;
    const bytes = await readFile(join(root, path));
    files.push({ path, sha256: sha256(bytes), bytes: bytes.length });
  }
  const canonical = files.map(({ path, sha256: hash, bytes }) => ({
    path,
    sha256: hash,
    bytes,
  }));
  manifest.files = files;
  manifest.digests = {
    ...manifest.digests,
    blueprint: files.find((file) => file.path === "BLUEPRINT.md")?.sha256,
    package: sha256(Buffer.from(JSON.stringify(canonical), "utf8")),
  };
  await writeJson(join(root, MANIFEST), manifest);
}

/** Picks the first claim that carries the requested kind of evidence selector. */
function claimWithSelector(blueprint, type) {
  for (const claim of blueprint.claims ?? []) {
    for (const ref of claim.evidence ?? []) {
      if (ref.selector?.type === type) return { claim, ref };
    }
  }
  throw new Error(`the package has no claim with a ${type} selector`);
}

const APPLY = {
  /** A DOM selector that resolves to no node in the packaged DOM. */
  "selector-unresolved": async (root) => {
    const path = join(root, BLUEPRINT);
    const blueprint = await readJson(path);
    const { ref } = claimWithSelector(blueprint, "dom");
    ref.selector = { type: "dom", path: "#audit-missing-node" };
    await writeJson(path, blueprint);
  },

  /** A covered ledger unit disappears; the denominator must not follow it down. */
  "ledger-missing": async (root) => {
    const path = join(root, LEDGER);
    const ledger = await readJson(path);
    const index = ledger.entries.findIndex(
      (entry) => entry.status === "covered",
    );
    if (index < 0) throw new Error("the ledger has no covered entry");
    ledger.entries.splice(index, 1);
    await writeJson(path, ledger);
  },

  /** An extra unit appears; it must be refused instead of growing the ledger. */
  "ledger-extra": async (root) => {
    const path = join(root, LEDGER);
    const ledger = await readJson(path);
    const entry = ledger.entries.find((item) => item.status === "covered");
    if (!entry) throw new Error("the ledger has no covered entry");
    ledger.entries.push({
      ...structuredClone(entry),
      id: `${entry.id}#audit-extra`,
    });
    await writeJson(path, ledger);
  },

  /** A unit moves to another class; the total stays, the distribution does not. */
  "ledger-reclassify": async (root) => {
    const path = join(root, LEDGER);
    const ledger = await readJson(path);
    const classes = (ledger.denominators ?? []).map((item) => item.class);
    const from = classes[0];
    const to = classes.at(-1);
    if (!from || !to || from === to) {
      throw new Error("the ledger needs at least two denominator classes");
    }
    const index = ledger.entries.findIndex((entry) => entry.class === from);
    if (index < 0) throw new Error(`the ledger has no ${from} entry`);
    ledger.entries[index] = {
      ...ledger.entries[index],
      class: to,
      id: `${to}:audit-moved-unit`,
    };
    await writeJson(path, ledger);
  },

  /** The document claims a different ceiling than the manifest declares. */
  "docs-ceiling": async (root) => {
    const path = join(root, "BLUEPRINT.md");
    const text = await readFile(path, "utf8");
    const changed = text.replace(
      /^- \*\*Evidenz-Decke:\*\* (\S+)$/m,
      "- **Evidenz-Decke:** inferred-only",
    );
    if (changed === text) throw new Error("BLUEPRINT.md names no ceiling line");
    await writeFile(path, changed, "utf8");
  },

  /** The document counts one claim more than the package carries. */
  "docs-claim-count": async (root) => {
    const path = join(root, "BLUEPRINT.md");
    const text = await readFile(path, "utf8");
    const changed = text.replace(
      /^- \*\*Behauptungen:\*\* (\d+) gesamt/m,
      (_, total) => `- **Behauptungen:** ${Number(total) + 1} gesamt`,
    );
    if (changed === text) throw new Error("BLUEPRINT.md names no claim count");
    await writeFile(path, changed, "utf8");
  },

  /** One sealed hash no longer matches its file; the seal itself is broken. */
  "manifest-entry-digest": async (root) => {
    const path = join(root, MANIFEST);
    const manifest = await readJson(path);
    const entry = manifest.files.find((file) => file.path === "BLUEPRINT.md");
    if (!entry) throw new Error("the manifest lists no BLUEPRINT.md");
    entry.sha256 = "0".repeat(64);
    await writeJson(path, manifest);
  },
};

/**
 * Every proof: the single defect, the codes it must provoke, and whether the
 * manifest is resealed afterwards (`false` only for the seal-breaking proof).
 */
export const PROOFS = Object.freeze([
  {
    id: "selector-unresolved",
    defect:
      "Ein Claim belegt sich mit einem DOM-Selektor, der im Paket auf keinen Knoten zeigt.",
    codes: ["claim.evidence.selector_unresolved"],
    reseal: true,
  },
  {
    id: "ledger-missing",
    defect:
      "Eine gedeckte Ledger-Einheit fehlt; der Nenner bleibt unverändert.",
    codes: ["ledger.denominator.mismatch", "ledger.unit.missing"],
    reseal: true,
  },
  {
    id: "ledger-extra",
    defect:
      "Eine zusätzliche Ledger-Einheit taucht auf, ohne den Nenner zu erhöhen.",
    codes: ["ledger.denominator.mismatch", "ledger.unit.unexpected"],
    reseal: true,
  },
  {
    id: "ledger-reclassify",
    defect:
      "Die Gesamtzahl bleibt, aber eine Einheit wechselt die Nenner-Kategorie.",
    codes: ["ledger.denominator.mismatch", "ledger.unit.reclassified"],
    reseal: true,
  },
  {
    id: "docs-ceiling",
    defect: "BLUEPRINT.md nennt eine andere Evidenz-Decke als das Manifest.",
    codes: ["docs.ceiling.mismatch", "render.not_deterministic"],
    reseal: true,
  },
  {
    id: "docs-claim-count",
    defect: "BLUEPRINT.md zählt einen Claim mehr, als das Paket führt.",
    codes: ["docs.claim_count.mismatch", "render.not_deterministic"],
    reseal: true,
  },
  {
    id: "manifest-entry-digest",
    defect:
      "Ein Datei-Hash im Manifest passt nicht mehr zu den gepackten Bytes.",
    codes: ["manifest.hash_mismatch"],
    reseal: false,
  },
]);

/** The short table of proofs the package ships next to the mutator. */
export function auditReadme() {
  const rows = PROOFS.map(
    (proof) =>
      `| \`${proof.id}\` | ${proof.defect} | ${proof.codes.map((code) => `\`${code}\``).join(", ")} |`,
  );
  return [
    "# Negativbeweise",
    "",
    "Dieses Verzeichnis zeigt, dass das Paket sich selbst widerlegen kann. Jeder",
    "Fall ist genau ein Defekt; die Prüfung muss ihn mit den genannten Codes und",
    "Exit 1 ablehnen. Die Rezepte und Erwartungen reisen mit dem Archiv, die",
    "Prüfung selbst liegt im Quell-Repo.",
    "",
    "## Selbst prüfen (ohne Repo)",
    "",
    "Der Prüfer reist mit: `audit/scripts/blueprint-verify.mjs` und sein Import-",
    "Abschluss unter `audit/ui/blueprint/` sind byte-identisch zu den Repo-Modulen.",
    "",
    "```sh",
    "node audit/scripts/blueprint-verify.mjs .",
    "```",
    "",
    "## Einen Defekt nachstellen",
    "",
    "```sh",
    "node audit/mutate.mjs . selector-unresolved ../defekt-kopie",
    "node audit/scripts/blueprint-verify.mjs ../defekt-kopie",
    "```",
    "",
    "Der Mutator kopiert das Paket, ändert eine Stelle und siegelt",
    "`MANIFEST.json` neu — außer beim Fall `manifest-entry-digest`, der genau",
    "diese Siegelung bricht. Exit 0 der Prüfung heißt: das Paket ist unverändert",
    "gültig; jede Mutation endet mit Exit 1.",
    "",
    "## Fälle",
    "",
    "| Fall | Defekt | Erwartete Codes |",
    "| --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}

/** The declarative list that ships as `audit/proofs.json`. */
export function proofsDocument() {
  return {
    schema: "rea.blueprint.proofs",
    schema_version: 1,
    proofs: PROOFS.map((proof) => ({
      id: proof.id,
      defect: proof.defect,
      expect: { exit: 1, codes: [...proof.codes] },
    })),
  };
}

/**
 * Copies `root` to `out`, applies one proof and reseals the copy. The target may
 * not sit inside the source, because the copy would then contain itself.
 */
export async function mutatePackage({ root, out, proof: id }) {
  const proof = PROOFS.find((item) => item.id === id);
  if (!proof) {
    throw new Error(
      `unknown proof ${JSON.stringify(id)}; expected one of ${PROOFS.map((item) => item.id).join(", ")}`,
    );
  }
  const source = resolve(root);
  const target = resolve(out);
  if (target === source || target.startsWith(`${source}${sep}`)) {
    throw new Error(
      "the mutated copy must be written outside the source package",
    );
  }
  await rm(target, { recursive: true, force: true });
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, { recursive: true });
  await APPLY[id](target);
  if (proof.reseal) await reseal(target);
  return { out: target, proof };
}

const USAGE = `Usage: node audit/mutate.mjs <paket> <fall> <ziel>

Schreibt eine Kopie des Pakets mit genau einem Defekt und nennt den Code, den
die Prüfung dafür melden muss. Fälle: ${PROOFS.map((proof) => proof.id).join(", ")}`;

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [root, id, out] = process.argv.slice(2);
  if (!root || !id || !out) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(2);
  }
  const result = await mutatePackage({ root, out, proof: id });
  process.stdout.write(
    `Mutation ${result.proof.id} nach ${result.out} geschrieben.\nErwartet: Exit 1 · ${result.proof.codes.join(", ")}\n`,
  );
}
