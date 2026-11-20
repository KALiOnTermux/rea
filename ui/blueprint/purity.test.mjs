import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "vitest";
import { analysisDigest, toAnalysis } from "./analysis.mjs";
import { compile } from "./compile.mjs";
import { webBuilt, webCtx } from "./test-fixtures.mjs";

const analysis = () => toAnalysis(webBuilt(), webCtx());
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

test("compile is deterministic for the same analysis", () => {
  const first = compile(analysis());
  const second = compile(analysis());
  for (const field of [
    "blueprint",
    "claims",
    "manifest",
    "markdown",
    "prompt",
    "outputDigest",
  ]) {
    assert.equal(
      JSON.stringify(first[field]),
      JSON.stringify(second[field]),
      field,
    );
  }
});

test("the blueprint is version 2 without a timestamp and with a digest id", () => {
  const input = analysis();
  const { blueprint } = compile(input);
  assert.equal(blueprint.schema, "rea.blueprint");
  assert.equal(blueprint.schema_version, 2);
  assert.equal("generated_at" in blueprint, false);
  assert.equal(blueprint.id, `bp-${analysisDigest(input).slice(0, 16)}`);
  assert.match(blueprint.id, /^bp-[0-9a-f]{16}$/);
  assert.deepEqual(blueprint.ceiling, input.ceiling);
  assert.equal(blueprint.target.name, "Shop");
  assert.deepEqual(blueprint.open_questions, []);
});

test("compile does not read the clock or any random source", () => {
  const realNow = Date.now;
  const realRandom = globalThis.crypto.randomUUID;
  Date.now = () => {
    throw new Error("compile must not read the clock");
  };
  globalThis.crypto.randomUUID = () => {
    throw new Error("compile must not be random");
  };
  try {
    compile(analysis());
  } finally {
    Date.now = realNow;
    globalThis.crypto.randomUUID = realRandom;
  }
});

test("the manifest keeps produced_at out of the digests", () => {
  const input = analysis();
  const compiled = compile(input);
  assert.equal(compiled.manifest.produced_at, input.produced_at);
  assert.equal(
    compiled.manifest.produced_at in compiled.manifest.digests,
    false,
  );
  assert.equal(compiled.manifest.digests.blueprint, sha256(compiled.markdown));
  assert.match(compiled.outputDigest, /^[0-9a-f]{64}$/);
});

test("claims are sorted and every claim reaches the render", () => {
  const compiled = compile(analysis());
  assert.deepEqual(
    compiled.claims.map((claim) => claim.id),
    compiled.claims.map((claim) => claim.id).sort(),
  );
  for (const claim of compiled.claims) {
    assert.equal(compiled.markdown.includes(`\`${claim.id}\``), true, claim.id);
  }
});

test("a changed fact changes the blueprint id and the output digest", () => {
  const first = compile(analysis());
  const changed = webBuilt();
  changed.surface.title = "Anderer Shop";
  const second = compile(toAnalysis(changed, webCtx()));
  assert.notEqual(second.blueprint.id, first.blueprint.id);
  assert.notEqual(second.outputDigest, first.outputDigest);
});
