import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { test } from "vitest";
import { CEILINGS, CLAIM_KINDS, makeClaim } from "./claims.mjs";
import { CEILING_ORDER } from "./ceiling.mjs";
import { buildManifest } from "./manifest.mjs";

const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";
const SCHEMA_NAMES = ["claims", "ledger", "manifest"];

const load = (name) =>
  JSON.parse(
    readFileSync(
      new URL(`./schemas/${name}.schema.json`, import.meta.url),
      "utf8",
    ),
  );

const variants = (values) => [...values].sort();

const compile = (name) => {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  return ajv.compile(load(name));
};

const observedClaim = () =>
  makeClaim({
    id: "web.route.POST./api/orders",
    statement: "POST /api/orders answers 201",
    kind: "observed",
    ceiling: "executed",
    subject: "/behavior/network/requests/3",
    evidence: [
      {
        path: "evidence/network.json",
        sha256: "a".repeat(64),
        selector: { type: "pointer", pointer: "/requests/3" },
      },
    ],
    falsifier: "acceptance.http.orders.create",
    limits: ["authenticated session"],
  });

const manifest = () =>
  buildManifest({
    files: {
      "evidence/blob.bin": Buffer.from([0x00, 0xff, 0x00]),
      "BLUEPRINT.md": Buffer.from("# x"),
    },
    ceiling: "executed",
    compiler: "blueprint-claim-compiler@1",
    produced_at: "2026-11-20T12:00:00.000Z",
  });

const ledger = () => ({
  schema: "rea.blueprint.ledger",
  schema_version: 1,
  ceiling: "executed",
  denominators: [
    {
      class: "route",
      probe: "web.route-scan",
      items: 2,
      blind_spots: ["routes built from a runtime string"],
    },
  ],
  entries: [
    {
      id: "route:GET /a",
      class: "route",
      source: {
        path: "source/server.mjs",
        selector: { type: "line", line: 214 },
      },
      status: "covered",
      claims: ["web.route.get-/a"],
    },
  ],
  closure: { covered: 1, gap: 0, out_of_scope: 0, ratio: 1 },
});

test("every schema is draft 2020-12 with its own id and compiles strictly", () => {
  for (const name of SCHEMA_NAMES) {
    const schema = load(name);
    assert.equal(schema.$schema, DRAFT_2020_12, name);
    assert.equal(
      schema.$id,
      `https://rea.local/schema/blueprint/${name}.schema.json`,
      name,
    );
    assert.doesNotThrow(() => compile(name), name);
  }
});

test("the claim schema requires every field of R2 and closes the record", () => {
  const schema = load("claims");
  for (const field of [
    "id",
    "statement",
    "kind",
    "ceiling",
    "evidence",
    "falsifier",
  ]) {
    assert.ok(schema.required.includes(field), field);
  }
  assert.deepEqual(
    variants(schema.properties.kind.enum),
    variants(CLAIM_KINDS),
  );
  assert.deepEqual(
    variants(schema.properties.ceiling.enum),
    variants(CEILINGS),
  );
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.properties.evidence.items.required, ["path"]);
  assert.deepEqual(schema.properties.derivation.required, ["rule", "inputs"]);
  assert.deepEqual(schema.properties.assumption.required, [
    "statement",
    "impact",
    "resolution",
  ]);
});

test("the ledger schema requires every field of R5", () => {
  const schema = load("ledger");
  for (const field of [
    "schema",
    "schema_version",
    "ceiling",
    "denominators",
    "entries",
    "closure",
  ]) {
    assert.ok(schema.required.includes(field), field);
  }
  assert.deepEqual(
    variants(schema.properties.ceiling.enum),
    variants(CEILING_ORDER),
  );
  assert.deepEqual(schema.properties.denominators.items.required, [
    "class",
    "probe",
    "items",
    "blind_spots",
  ]);
  assert.deepEqual(schema.properties.entries.items.required, [
    "id",
    "class",
    "status",
    "claims",
  ]);
  assert.deepEqual(
    variants(schema.properties.entries.items.properties.status.enum),
    variants(["covered", "gap", "out_of_scope"]),
  );
  assert.deepEqual(schema.properties.closure.required, [
    "covered",
    "gap",
    "out_of_scope",
    "ratio",
  ]);
  assert.equal(schema.properties.entries.items.additionalProperties, false);
});

test("the manifest schema requires every field of R10", () => {
  const schema = load("manifest");
  for (const field of [
    "schema",
    "schema_version",
    "ceiling",
    "ceiling_requested",
    "downgraded_by",
    "denominators",
    "determinism",
    "compiler",
    "produced_at",
    "digests",
    "files",
  ]) {
    assert.ok(schema.required.includes(field), field);
  }
  assert.deepEqual(
    variants(schema.properties.ceiling.enum),
    variants(CEILING_ORDER),
  );
  assert.deepEqual(schema.properties.digests.required, ["package"]);
  assert.deepEqual(schema.properties.files.items.required, [
    "path",
    "sha256",
    "bytes",
  ]);
  assert.equal(schema.properties.files.items.additionalProperties, false);
});

test("a claim from makeClaim validates and closed records reject extras", () => {
  const validate = compile("claims");
  const claim = observedClaim();
  assert.equal(validate(claim), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...claim, surprise: true }), false);
  assert.equal(validate({ ...claim, kind: "guess" }), false);
});

test("a manifest records the ceiling downgrade and refuses a loose value", () => {
  const validate = compile("manifest");
  const built = manifest();
  built.ceiling_requested = "executed";
  built.downgraded_by = ["apk:no-execution-grant"];
  assert.equal(validate(built), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...built, downgraded_by: "apk" }), false);
  assert.equal(validate({ ...built, downgraded_by: ["apk"] }), false);
  assert.equal(validate({ ...built, ceiling_requested: "certain" }), false);
  assert.equal(validate({ ...built, denominators: "22" }), false);
  assert.equal(
    validate({
      ...built,
      denominators: { total: 1, classes: [{ class: "a", items: 1 }] },
    }),
    false,
  );
  const { determinism, ...withoutDeterminism } = built;
  assert.equal(determinism !== undefined, true);
  assert.equal(validate(withoutDeterminism), false);
});

test("a manifest over binary evidence validates and backslashes are rejected", () => {
  const validate = compile("manifest");
  const built = manifest();
  assert.equal(validate(built), true, JSON.stringify(validate.errors));
  const backslash = {
    ...built,
    files: built.files.map((file) =>
      file.path === "evidence/blob.bin"
        ? { ...file, path: "evidence\\blob.bin" }
        : file,
    ),
  };
  assert.equal(validate(backslash), false);
});

test("a ledger with a denominator validates and a missing closure is rejected", () => {
  const validate = compile("ledger");
  const built = ledger();
  assert.equal(validate(built), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...built, closure: undefined }), false);
  assert.equal(validate({ ...built, entries: [] }), true);
});
