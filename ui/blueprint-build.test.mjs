import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { buildBlueprint } from "./blueprint.mjs";

const CAPTURE = {
  url: "https://shop.test/",
  final_url: "https://shop.test/",
  completeness: { status: "complete" },
  steps: [
    {
      action: "goto",
      status: 200,
      after_url: "https://shop.test/",
      elapsed_ms: 12,
      artifacts: {
        dom: {
          state: "captured",
          value: {
            text: [
              '<html lang="de"><head><title>Shop</title></head><body>',
              '<main><h1>Shop</h1><button id="buy" type="button">Kaufen</button>',
              '<a href="/orders">Bestellungen</a></main>',
              "</body></html>",
            ].join(""),
          },
        },
      },
    },
  ],
  events: {
    items: [
      {
        kind: "request",
        transaction_id: "t1",
        sequence: 1,
        method: "POST",
        url: {
          url: "https://shop.test/api/orders",
          origin: "https://shop.test",
        },
        resource_type: "fetch",
      },
      {
        kind: "response",
        transaction_id: "t1",
        sequence: 2,
        status: 201,
        url: {
          url: "https://shop.test/api/orders",
          origin: "https://shop.test",
        },
        resource_type: "fetch",
      },
    ],
  },
};

async function prepareCapture() {
  const root = await mkdtemp(join(tmpdir(), "rea-bp-capture-"));
  const capturePath = join(root, "capture.json");
  await writeFile(capturePath, JSON.stringify(CAPTURE, null, 2), "utf8");
  return capturePath;
}

async function build(capturePath) {
  const artifactsDir = await mkdtemp(join(tmpdir(), "rea-bp-out-"));
  const result = await buildBlueprint({
    kind: "web",
    target: "https://shop.test/",
    input: { web: { capture: capturePath } },
    artifactsDir,
    includeSources: false,
    reaVersion: "rea-test",
    // A capture without routes or assets closes at ratio < 1, so the fail-closed
    // gate only writes it on the explicit allowIncomplete path (stage 3).
    allowIncomplete: true,
    onProgress: () => {},
  });
  return result;
}

test("buildBlueprint writes a version 2 package with a manifest", async () => {
  const capturePath = await prepareCapture();
  const result = await build(capturePath);
  const blueprint = JSON.parse(
    await readFile(join(result.dir, "blueprint.json"), "utf8"),
  );
  assert.equal(blueprint.schema_version, 2);
  assert.match(blueprint.id, /^bp-[0-9a-f]{16}$/);
  assert.equal("generated_at" in blueprint, false);
  assert.equal(blueprint.claims.length > 0, true);
  assert.equal(blueprint.ceiling.ceiling, "executed");

  const manifest = JSON.parse(
    await readFile(join(result.dir, "MANIFEST.json"), "utf8"),
  );
  assert.match(
    manifest.produced_at,
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
  );
  const paths = manifest.files.map((file) => file.path);
  for (const expected of [
    "BLUEPRINT.md",
    "AGENT-PROMPT.md",
    "blueprint.json",
    "schemas/claims.schema.json",
  ]) {
    assert.equal(paths.includes(expected), true, expected);
  }
  assert.equal(paths.includes("MANIFEST.json"), false);
  await readFile(join(result.dir, "schemas/claims.schema.json"), "utf8");
});

test("two runs over the same capture produce identical documents", async () => {
  const capturePath = await prepareCapture();
  const first = await build(capturePath);
  const second = await build(capturePath);
  for (const name of ["blueprint.json", "BLUEPRINT.md", "AGENT-PROMPT.md"]) {
    assert.equal(
      await readFile(join(first.dir, name), "utf8"),
      await readFile(join(second.dir, name), "utf8"),
      name,
    );
  }
});

test("the document keeps the three claim kinds apart", async () => {
  const capturePath = await prepareCapture();
  const result = await build(capturePath);
  const markdown = await readFile(join(result.dir, "BLUEPRINT.md"), "utf8");
  assert.match(markdown, /## 5\. Beobachtet \(observed\)/);
  assert.match(markdown, /## 6\. Abgeleitet \(derived\)/);
  assert.match(markdown, /## 7\. Angenommen \(assumed\)/);
  assert.match(markdown, /\*\*Ceiling:\*\* executed/);
  assert.match(markdown, /## 10\. Beweise im Paket/);
});
