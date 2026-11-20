import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "vitest";
import { ManifestError, buildManifest, verifyManifest } from "./manifest.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const produced = "2026-11-20T12:00:00.000Z";

const packageFiles = () => ({
  "a.txt": Buffer.from("a"),
  "BLUEPRINT.md": Buffer.from("# x"),
});

const build = (overrides = {}) =>
  buildManifest({
    files: packageFiles(),
    ceiling: "executed",
    compiler: "blueprint-claim-compiler@1",
    produced_at: produced,
    ...overrides,
  });

const readFrom = (map) => (path) => map[path];

test("buildManifest sorts files and digests the blueprint", () => {
  const manifest = build();
  assert.equal(manifest.schema, "rea.blueprint.manifest");
  assert.equal(manifest.schema_version, 1);
  assert.deepEqual(
    manifest.files.map((file) => file.path),
    ["BLUEPRINT.md", "a.txt"],
  );
  const blueprint = manifest.files[0];
  assert.equal(blueprint.sha256, sha256(Buffer.from("# x")));
  assert.equal(blueprint.bytes, 3);
  assert.equal(manifest.digests.blueprint, sha256(Buffer.from("# x")));
  assert.equal(manifest.digests.produced_at, undefined);
  assert.deepEqual(Object.keys(manifest.digests).sort(), [
    "blueprint",
    "package",
  ]);
  assert.equal(manifest.produced_at, produced);
  assert.equal(manifest.ceiling, "executed");
  assert.equal(manifest.compiler, "blueprint-claim-compiler@1");
  assert.equal(manifest.produced_at in manifest.digests, false);
});

test("a manifest verifies when the bytes match and keeps verifying when reordered", () => {
  const manifest = build();
  const read = readFrom(packageFiles());
  assert.deepEqual(verifyManifest(manifest, read), {
    ok: true,
    violations: [],
  });
  assert.deepEqual(
    verifyManifest({ ...manifest, files: [...manifest.files].reverse() }, read),
    { ok: true, violations: [] },
  );
});

test("verifyManifest names the file whose bytes changed", () => {
  const manifest = build();
  const result = verifyManifest(
    manifest,
    readFrom({ "a.txt": Buffer.from("b"), "BLUEPRINT.md": Buffer.from("# x") }),
  );
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.violations.map((violation) => violation.code),
    ["manifest.hash_mismatch"],
  );
  assert.equal(result.violations[0].subject, "a.txt");
  assert.match(result.violations[0].detail, /a\.txt/);
});

test("hashes cover raw bytes and paths normalise to forward slashes", () => {
  const binary = Buffer.from([0x00, 0xff, 0x10, 0x00]);
  const manifest = build({
    files: {
      "evidence\\blob.bin": binary,
      "evidence/net.json": Buffer.from("{}"),
      "BLUEPRINT.md": Buffer.from("# x"),
    },
    digests: { ledger: "a".repeat(64) },
  });
  assert.deepEqual(
    manifest.files.map((file) => file.path),
    ["BLUEPRINT.md", "evidence/blob.bin", "evidence/net.json"],
  );
  const blob = manifest.files[1];
  assert.equal(blob.sha256, sha256(binary));
  assert.equal(blob.bytes, 4);
  assert.equal(manifest.digests.ledger, "a".repeat(64));
  assert.equal(
    verifyManifest(
      manifest,
      readFrom({
        "BLUEPRINT.md": Buffer.from("# x"),
        "evidence/blob.bin": binary,
        "evidence/net.json": Buffer.from("{}"),
      }),
    ).ok,
    true,
  );
});

test("buildManifest refuses paths that leave the package or repeat", () => {
  assert.throws(
    () => build({ files: { "../escape.txt": Buffer.from("x") } }),
    ManifestError,
  );
  assert.throws(
    () => build({ files: { "/absolute.txt": Buffer.from("x") } }),
    /absolute/,
  );
  assert.throws(
    () =>
      build({
        files: {
          "evidence\\x.json": Buffer.from("{}"),
          "evidence/x.json": Buffer.from("{}"),
        },
      }),
    /duplicate/,
  );
  assert.throws(() => build({ produced_at: "yesterday" }), /produced_at/);
  assert.throws(() => build({ ceiling: "certain" }), /ceiling/);
});

test("verifyManifest reports missing files and edited digests", () => {
  const manifest = build();
  const missing = verifyManifest(manifest, () => undefined);
  assert.equal(missing.ok, false);
  assert.deepEqual(
    missing.violations.map((violation) => violation.subject),
    ["BLUEPRINT.md", "a.txt"],
  );
  assert.match(missing.violations[0].detail, /missing/);

  const read = readFrom(packageFiles());
  const editedPackage = verifyManifest(
    { ...manifest, digests: { ...manifest.digests, package: "0".repeat(64) } },
    read,
  );
  assert.deepEqual(
    editedPackage.violations.map((violation) => violation.subject),
    ["digests.package"],
  );
  const editedBlueprint = verifyManifest(
    {
      ...manifest,
      digests: { ...manifest.digests, blueprint: "0".repeat(64) },
    },
    read,
  );
  assert.deepEqual(
    editedBlueprint.violations.map((violation) => violation.code),
    ["manifest.hash_mismatch"],
  );
  assert.deepEqual(
    editedBlueprint.violations.map((violation) => violation.subject),
    ["digests.blueprint"],
  );
});
