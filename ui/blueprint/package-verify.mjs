/**
 * Verifies a package that was unpacked somewhere else (spec §8 + §10).
 *
 * The build already gates its package in memory; this module answers the other
 * question a user has: does the downloaded artifact still stand on its own once
 * it leaves the repository? It therefore reads only the unpacked directory and
 * never the source tree, so no compiler state can leak into the check.
 *
 * It re-runs the same `gate` over the packaged JSON, re-verifies the manifest
 * hashes, re-computes every claim's evidence digest, resolves every claim's
 * evidence selector against the packaged bytes and resolves every path the
 * package references to a file inside the package.
 */

import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, posix } from "node:path";
import { CEILING_ORDER } from "./ceiling.mjs";
import { resolveEvidence } from "./evidence.mjs";
import { gate } from "./gate.mjs";
import { verifyManifest } from "./manifest.mjs";
import { renderMarkdown } from "./render.mjs";

const DOCUMENTS = ["BLUEPRINT.md", "blueprint.json", "AGENT-PROMPT.md"];
const MANIFEST = "MANIFEST.json";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** The declarations the documents print, in the exact wording the renderer uses. */
const DOC_DECLARATION = {
  "BLUEPRINT.md": {
    ceiling: /^- \*\*Evidenz-Decke:\*\* (\S+)$/m,
    downgrades: /^- \*\*Herabstufungen:\*\* (.+)$/m,
    counts:
      /^- \*\*Behauptungen:\*\* (\d+) gesamt · (\d+) observed · (\d+) derived · (\d+) assumed$/m,
    sections: [
      "## 5. Beobachtet (observed)",
      "## 6. Abgeleitet (derived)",
      "## 7. Angenommen (assumed)",
      "## 9. Offene Punkte",
    ],
    emptyAssumed: /Keine Behauptungen dieser Art im Paket\./,
  },
  "AGENT-PROMPT.md": {
    ceiling: /^Evidenz-Decke: (\S+)$/m,
    downgrades: /^Herabstufungen: (.+)$/m,
    counts:
      /^Behauptungen: (\d+) gesamt · (\d+) observed · (\d+) derived · (\d+) assumed$/m,
    sections: [
      "## Evidenzlage (verbindlich)",
      "Beobachtet (observed): ",
      "Abgeleitet (derived): ",
      "Angenommen (assumed): ",
      "Offene Lücken: ",
    ],
    emptyAssumed: /Angenommen \(assumed\): keine Annahme/,
  },
};

/**
 * Compares each claim's ceiling with the ceiling the manifest declares.
 *
 * The gate compares claims with the blueprint's run ceiling, but the manifest is
 * the promise a reader takes from the archive. A package whose manifest says
 * `statically-evidenced` may not ship an `executed` claim, even when the
 * blueprint still says `executed`: the rebuild would trust a proof the archive
 * does not claim to hold. A claim that also exceeds the run ceiling is left to
 * `claim.ceiling.exceeds_run`, so one defect keeps one code.
 */
export function checkClaimCeilings({ manifest, blueprint, add }) {
  const declared = CEILING_ORDER.indexOf(manifest?.ceiling);
  if (declared < 0) return;
  const run = CEILING_ORDER.indexOf(blueprint?.ceiling?.ceiling);
  for (const claim of Array.isArray(blueprint?.claims)
    ? blueprint.claims
    : []) {
    const ceiling = CEILING_ORDER.indexOf(claim?.ceiling);
    if (ceiling < 0 || ceiling <= declared) continue;
    if (run >= 0 && ceiling > run) continue;
    add(
      "claim.ceiling.exceeds_manifest",
      claim.id,
      `claim ceiling ${claim.ceiling} exceeds the manifest ceiling ${manifest.ceiling}`,
    );
  }
}

/**
 * Compares the documents' own declarations with the manifest and the claims.
 * A document that names a higher ceiling than the manifest is the case this
 * exists for: the rebuild would trust a proof the package does not hold.
 */
export function checkDeclarations({ manifest, blueprint, contents, add }) {
  const claims = Array.isArray(blueprint?.claims) ? blueprint.claims : [];
  const counts = { observed: 0, derived: 0, assumed: 0 };
  for (const claim of claims) {
    if (claim.kind in counts) counts[claim.kind] += 1;
  }
  const declaredCeiling = manifest?.ceiling ?? null;
  const declaredDowngrades = Array.isArray(manifest?.downgraded_by)
    ? manifest.downgraded_by
    : [];

  for (const [name, declaration] of Object.entries(DOC_DECLARATION)) {
    const text = contents.get(name)?.toString("utf8");
    if (!text) {
      add("docs.section.missing", name, "das Dokument fehlt im Paket");
      continue;
    }

    const ceiling = declaration.ceiling.exec(text);
    if (!ceiling) {
      add(
        "docs.ceiling.mismatch",
        name,
        "das Dokument nennt die Evidenz-Decke nicht in der Form, die das Manifest deklariert",
      );
    } else if (ceiling[1] !== declaredCeiling) {
      add(
        "docs.ceiling.mismatch",
        name,
        `das Dokument behauptet \`${ceiling[1]}\`, das Manifest deklariert \`${declaredCeiling}\``,
      );
    }

    const downgrades = declaration.downgrades.exec(text);
    if (!downgrades) {
      add(
        "docs.downgrade.mismatch",
        name,
        "das Dokument nennt die Herabstufungen nicht",
      );
    } else {
      const listed = declaredDowngrades.every((reason) =>
        downgrades[1].includes(reason),
      );
      const empty = declaredDowngrades.length === 0;
      const saysNone = downgrades[1].trim() === "keine";
      if (empty ? !saysNone : !listed) {
        add(
          "docs.downgrade.mismatch",
          name,
          `das Manifest deklariert ${empty ? "keine Herabstufung" : declaredDowngrades.join(", ")}, das Dokument sagt \`${downgrades[1].trim()}\``,
        );
      }
    }

    const countLine = declaration.counts.exec(text);
    if (!countLine) {
      add(
        "docs.claim_count.mismatch",
        name,
        "das Dokument nennt die Claim-Zählung nicht",
      );
    } else {
      const expected = [
        claims.length,
        counts.observed,
        counts.derived,
        counts.assumed,
      ];
      const parsed = countLine.slice(1).map(Number);
      if (parsed.join() !== expected.join()) {
        add(
          "docs.claim_count.mismatch",
          name,
          `das Dokument zählt ${parsed[0]} gesamt · ${parsed.slice(1).join("/")}, Blueprint führt ${claims.length} gesamt · ${[counts.observed, counts.derived, counts.assumed].join("/")}`,
        );
      }
    }

    for (const heading of declaration.sections) {
      if (!text.includes(heading)) {
        add(
          "docs.section.missing",
          `${name}#${heading}`,
          "der Abschnitt fehlt",
        );
      }
    }

    // An empty category has to say that it is empty: silence reads like an
    // unmarked assumption.
    if (counts.assumed === 0 && !declaration.emptyAssumed.test(text)) {
      add(
        "docs.section.empty_unmarked",
        `${name}#assumed`,
        "die Kategorie assumed ist leer, wird aber nicht ausdrücklich als leer ausgewiesen",
      );
    }
  }
}

async function listFiles(root, prefix = "") {
  const names = [];
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) names.push(...(await listFiles(root, relative)));
    else if (entry.isFile()) names.push(relative);
  }
  return names;
}

/**
 * A reference is a file (`evidence/x.json#/pointer`, `surface/dom.html:1`) or a
 * directory (`schemas/`). Ids and prose spans that merely contain a dot are not
 * references, so a token needs a file extension or a trailing slash.
 */
function normaliseReference(value) {
  if (typeof value !== "string") return null;
  let path = value.trim();
  if (path === "" || path.includes("://") || path.startsWith("#")) return null;
  path = path
    .replace(/#.*$/, "")
    .replace(/:\d+$/, "")
    .replace(/^\.\//, "")
    .replace(/[),.;:]+$/, "");
  if (path.startsWith("/")) return null;
  // Check ids also read like `acceptance.web.evidence.evidence/web-capture.json`;
  // a real path never has a dot in its first segment.
  if ((path.split("/")[0] ?? "").includes(".")) return null;
  const directory = path.endsWith("/");
  if (!directory && !FILE_EXTENSION.test(path)) return null;
  return { path: posix.normalize(path), directory };
}

const FILE_EXTENSION =
  /\.(md|json|txt|html|css|js|mjs|cjs|zip|png|jpe?g|svg|ya?ml|xml)$/i;

/**
 * Evidence references in the blueprint JSON.
 *
 * Only objects that carry a `path` *and* an evidence marker count: a DOM
 * selector also has a `path` (`#buy`, `a[href="/orders"]`), and treating that as
 * a file would invent dangling references that do not exist.
 */
function blueprintReferences(blueprint) {
  const refs = [];
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    const marked =
      typeof value.path === "string" &&
      value.type === undefined &&
      ("selector" in value ||
        "sha256" in value ||
        "role" in value ||
        "bytes" in value ||
        "included" in value ||
        "pointer" in value ||
        "line" in value);
    if (marked) {
      refs.push({ path: value.path, where: "blueprint.json" });
      return;
    }
    for (const item of Object.values(value)) visit(item);
  };
  visit(blueprint);
  return refs;
}

/** Links and inline code spans that name a file inside the package. */
function markdownReferences(text, where) {
  const refs = [];
  for (const match of String(text).matchAll(/\]\(([^)\s]+)\)/g)) {
    refs.push({ path: match[1], where });
  }
  for (const match of String(text).matchAll(/`([^`\n]+)`/g)) {
    refs.push({ path: match[1], where });
  }
  return refs;
}

function flowsReferences(flows) {
  const refs = [];
  for (const flow of Array.isArray(flows?.flows) ? flows.flows : []) {
    if (typeof flow?.evidence?.path === "string") {
      refs.push({ path: flow.evidence.path, where: "flows/flows.json" });
    }
  }
  return refs;
}

/**
 * Verifies an unpacked package directory. Returns every finding; `ok` is true
 * only when the gate is silent, the manifest matches, the claim digests match
 * and every referenced path resolves inside the package.
 */
export async function verifyPackageDir(root) {
  const violations = [];
  const add = (code, subject, detail) =>
    violations.push({ code, subject, detail });

  const info = await stat(root).catch(() => null);
  if (!info?.isDirectory()) {
    return {
      ok: false,
      root,
      files: [],
      references: { total: 0, resolved: 0, unresolved: [] },
      claims: {
        total: 0,
        hashed: 0,
        mismatched: 0,
        selectors: { checked: 0, unresolved: 0 },
      },
      gate: null,
      violations: [
        {
          code: "package.part.missing",
          subject: root,
          detail: "the package path is not a directory",
        },
      ],
    };
  }

  const files = await listFiles(root);
  const fileSet = new Set(files);
  const contents = new Map();
  for (const name of files) {
    contents.set(name, await readFile(join(root, name)));
  }
  const read = (path) => contents.get(path) ?? Buffer.alloc(0);

  for (const name of DOCUMENTS) {
    if (!fileSet.has(name)) {
      add(
        "package.part.missing",
        name,
        "the package does not ship this document",
      );
    }
  }

  const parse = (name) => {
    const bytes = contents.get(name);
    if (!bytes) {
      add("package.part.missing", name, "the package does not ship this file");
      return null;
    }
    try {
      return JSON.parse(bytes.toString("utf8"));
    } catch {
      add("package.part.missing", name, "the file is not valid JSON");
      return null;
    }
  };

  const manifestBytes = contents.get(MANIFEST);
  let manifest = null;
  if (!manifestBytes) {
    add("package.part.missing", MANIFEST, "the package has no manifest");
  } else {
    try {
      manifest = JSON.parse(manifestBytes.toString("utf8"));
    } catch {
      add("package.part.missing", MANIFEST, "the manifest is not valid JSON");
    }
  }

  const blueprint = parse("blueprint.json");
  const ledger = parse("ledger.json");
  const acceptance = parse("acceptance.json");
  const markdownBytes = contents.get("BLUEPRINT.md");
  const markdown = markdownBytes ? markdownBytes.toString("utf8") : null;

  if (manifest) {
    const checked = verifyManifest(manifest, read);
    for (const item of checked.violations ?? []) {
      add("manifest.hash_mismatch", item.subject, item.detail);
    }
  }

  const claims = Array.isArray(blueprint?.claims) ? blueprint.claims : [];
  let hashed = 0;
  let mismatched = 0;
  const selectors = { checked: 0, unresolved: 0 };
  for (const claim of claims) {
    for (const ref of Array.isArray(claim?.evidence) ? claim.evidence : []) {
      const target = normaliseReference(ref?.path);
      const path = target?.path;
      const present = Boolean(path && fileSet.has(path));
      if (typeof ref?.sha256 === "string" && ref.sha256 !== "") {
        hashed += 1;
        const actual = present ? digest(read(path)) : null;
        if (actual !== ref.sha256) {
          mismatched += 1;
          add(
            "claim.evidence.hash_mismatch",
            claim.id,
            `evidence ${ref.path} has ${actual ?? "no bytes"}, the claim records ${ref.sha256}`,
          );
        }
      }
      // The digest proves the bytes; the selector proves the claim points at
      // something inside them. A package that hashes correctly can still cite a
      // node, request or pointer it does not contain.
      selectors.checked += 1;
      if (!target || target.directory || !present) {
        // A missing file is `claim.evidence.unresolved`, which the gate reports:
        // one defect keeps one code, so the two checks never double-report.
        selectors.unresolved += 1;
        continue;
      }
      const resolved = resolveEvidence(ref, read);
      if (!resolved.ok) {
        selectors.unresolved += 1;
        add(
          "claim.evidence.selector_unresolved",
          claim.id,
          `${ref.path}: ${resolved.reason}`,
        );
      }
    }
  }

  // The manifest declares the fixed denominator, so the unpacked package can be
  // audited against it: a removed, added or reclassified unit must not lower the
  // denominator quietly. Totals and per-class counts are compared separately,
  // because they mean different defects.
  const declared = manifest?.denominators ?? null;
  if (!manifest?.determinism) {
    add(
      "manifest.determinism.undeclared",
      MANIFEST,
      "the manifest does not declare its determinism rule",
    );
  }
  if (!declared || !Array.isArray(declared.classes)) {
    add(
      "manifest.denominator.undeclared",
      MANIFEST,
      "the manifest does not declare the fixed denominator",
    );
  } else {
    const ledgerEntries = Array.isArray(ledger?.entries) ? ledger.entries : [];
    const actualByClass = new Map();
    for (const entry of ledgerEntries) {
      actualByClass.set(entry.class, (actualByClass.get(entry.class) ?? 0) + 1);
    }
    const declaredByClass = new Map(
      declared.classes.map((item) => [item.class, item.items]),
    );
    const missing = [];
    const extra = [];
    for (const [cls, items] of declaredByClass) {
      const actual = actualByClass.get(cls) ?? 0;
      if (actual < items) missing.push(`${cls}: ${items - actual} fehlt`);
      if (actual > items) extra.push(`${cls}: ${actual - items} zu viel`);
    }
    for (const [cls, actual] of actualByClass) {
      if (!declaredByClass.has(cls))
        extra.push(`${cls}: ${actual} nicht deklariert`);
    }
    const declaredTotal = Number.isInteger(declared.total)
      ? declared.total
      : [...declaredByClass.values()].reduce((sum, item) => sum + item, 0);
    const actualTotal = ledgerEntries.length;
    if (actualTotal < declaredTotal) {
      add(
        "ledger.unit.missing",
        missing.length > 0 ? missing.join(", ") : "ledger",
        `der Nenner deklariert ${declaredTotal} Einheit(en), das Ledger führt ${actualTotal}; ${declaredTotal - actualTotal} geforderte Einheit(en) fehlen`,
      );
    } else if (actualTotal > declaredTotal) {
      add(
        "ledger.unit.unexpected",
        extra.length > 0 ? extra.join(", ") : "ledger",
        `der Nenner deklariert ${declaredTotal} Einheit(en), das Ledger führt ${actualTotal}; ${actualTotal - declaredTotal} nicht gedeckte Einheit(en)`,
      );
    } else if (missing.length > 0 || extra.length > 0) {
      add(
        "ledger.unit.reclassified",
        [...missing, ...extra].join(", "),
        "die Gesamtzahl stimmt, aber die Verteilung auf die Kategorien weicht von der deklarierten Zählung ab",
      );
    }
  }

  // The manifest is the archive's promise about what it proves, so no claim may
  // stand above it.
  checkClaimCeilings({ manifest, blueprint, add });

  // The documents declare what the package can prove, so the check reads those
  // declarations back instead of trusting the prose: ceiling, every downgrade
  // reason and the claim count per kind must match the manifest and blueprint,
  // and each claim kind keeps its own readable section even when it is empty.
  checkDeclarations({ manifest, blueprint, contents, add });

  // Every document the package ships is scanned, not just the two main ones: a
  // spec that points at a missing file is exactly the dangling reference this
  // check exists for.
  const documents = files.filter((name) => name.endsWith(".md"));
  const references = [
    ...blueprintReferences(blueprint),
    ...documents.flatMap((name) =>
      markdownReferences(contents.get(name).toString("utf8"), name),
    ),
    ...flowsReferences(parse("flows/flows.json")),
  ];
  const unresolved = [];
  const seen = new Set();
  for (const ref of references) {
    const target = normaliseReference(ref.path);
    if (!target) continue;
    const key = `${ref.where}:${target.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const exists = target.directory
      ? files.some((name) => name.startsWith(target.path))
      : fileSet.has(target.path);
    if (!exists) unresolved.push({ path: target.path, where: ref.where });
  }
  for (const ref of unresolved) {
    add(
      "package.reference.unresolved",
      ref.path,
      `${ref.where} references ${ref.path}, which the package does not contain`,
    );
  }

  let gateResult = null;
  if (blueprint && ledger && acceptance) {
    gateResult = gate(blueprint, ledger, acceptance, {
      targetClass: blueprint?.target?.kind ?? "web",
      files,
      manifest,
      markdown,
      omitted: [],
      readFile: read,
      renderMarkdown: () =>
        renderMarkdown({ blueprint, claims: blueprint.claims ?? [] }),
    });
    // Selector findings were already collected above from the same bytes; the
    // gate would repeat them. Merge only its other verdicts so each defect has
    // exactly one report.
    for (const item of gateResult.violations) {
      if (item.code === "claim.evidence.selector_unresolved") continue;
      violations.push(item);
    }
  }

  return {
    ok: violations.length === 0,
    root,
    files,
    references: {
      total: references.length,
      resolved: references.length - unresolved.length,
      unresolved,
    },
    claims: { total: claims.length, hashed, mismatched, selectors },
    gate: gateResult
      ? {
          ok: gateResult.ok,
          status: gateResult.status,
          coverage: gateResult.coverage,
          violations: gateResult.violations.length,
        }
      : null,
    violations,
  };
}
