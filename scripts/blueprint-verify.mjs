#!/usr/bin/env node
/**
 * CLI for the standalone package check (spec §8 + §10).
 *
 * It takes an unpacked package directory — the thing a user has after unzipping
 * the download — and re-runs the gate plus the reference, manifest and evidence
 * digest checks from inside that directory. The source tree is never consulted.
 */

import { verifyPackageDir } from "../ui/blueprint/package-verify.mjs";

const USAGE = `Usage: node scripts/blueprint-verify.mjs <paketverzeichnis>
       node audit/scripts/blueprint-verify.mjs <paketverzeichnis>  (im Paket)

Prüft ein entpacktes Blaupausen-Paket ohne Repo-Kontext: Gate, Manifest-Hashes,
Claim-sha256 und alle im Paket referenzierten Pfade.`;

const target = process.argv[2];
if (!target || target === "--help" || target === "-h") {
  process.stdout.write(`${USAGE}\n`);
  process.exit(target ? 0 : 2);
}

const report = await verifyPackageDir(target);
process.stdout.write(`Paket: ${report.root}\n`);
process.stdout.write(`Dateien: ${report.files.length}\n`);
process.stdout.write(
  `Referenzen: ${report.references.resolved}/${report.references.total} aufgelöst\n`,
);
for (const ref of report.references.unresolved) {
  process.stdout.write(`  offen: ${ref.path} (${ref.where})\n`);
}
process.stdout.write(
  `Claim-sha256: ${report.claims.hashed} geprüft, ${report.claims.mismatched} abweichend\n`,
);
process.stdout.write(
  `Gate: ${report.gate?.ok ? "pass" : "fail"} · ok=${report.gate?.ok ?? false} · ${report.gate?.violations ?? "?"} Violations · Coverage ${report.gate?.coverage ?? "?"}\n`,
);
for (const violation of report.violations) {
  process.stdout.write(
    `  ${violation.code}: ${violation.subject} — ${violation.detail}\n`,
  );
}
process.exit(report.ok ? 0 : 1);
