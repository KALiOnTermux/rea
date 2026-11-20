import assert from "node:assert/strict";
import { test } from "vitest";
import { toAnalysis } from "../analysis.mjs";
import { resolveCeiling } from "../ceiling.mjs";
import {
  behaviourClaimViolations,
  nativeCeiling,
  nativeDenominators,
  nativeEntries,
} from "./native.mjs";

const apkBuilt = () => ({
  target: {
    kind: "apk",
    input: "/tmp/app.apk",
    name: "app.apk",
    platform: "android",
  },
  surface: {
    package_name: "test.app",
    components: { activity: [{ name: ".Main" }], service: [] },
  },
  behavior: {
    activities: [{ name: ".Main" }],
    exported: [
      { kind: "activity", name: ".Main" },
      { kind: "receiver", name: ".Boot" },
    ],
    screens: {
      activities: 1,
      layouts: ["res/layout/main.xml"],
      fragments: 0,
      navigation_calls: 0,
    },
  },
  internals: {
    assets: ["assets/config.json", "assets/i18n.json", "assets/logo.png"],
  },
  reconstruction: [],
  acceptance: [],
});

const nativeBuilt = () => ({
  target: {
    kind: "code",
    input: "/tmp/app.bin",
    name: "app.bin",
    platform: "native",
  },
  surface: { format: "elf" },
  behavior: { exit_paths: [{ kind: "abort", value: "SIGABRT" }] },
  internals: { native_libs: [] },
  reconstruction: [],
  acceptance: [],
});

test("APK analysis yields screen, exported-symbol and asset denominators", () => {
  const analysis = toAnalysis(apkBuilt(), { kind: "apk", probes: [] });
  assert.deepEqual(
    nativeDenominators(analysis).map((entry) => [entry.class, entry.items]),
    [
      ["asset", 3],
      ["exported-symbol", 2],
      ["screen", 2],
    ],
  );
  assert.equal(analysis.ceiling.ceiling, "statically-evidenced");
});

test("an APK may not request executed without an execution grant", () => {
  assert.deepEqual(
    resolveCeiling({ targetClass: "apk", requested: "executed" }),
    {
      requested: "executed",
      ceiling: "statically-evidenced",
      downgraded_by: ["apk:no-execution-grant"],
    },
  );
});

test("a native binary without a trace probe stays inferred-only", () => {
  const analysis = toAnalysis(nativeBuilt(), { kind: "code", probes: [] });
  assert.deepEqual(nativeCeiling(analysis), {
    requested: "statically-evidenced",
    ceiling: "inferred-only",
    downgraded_by: ["native:no-trace-grant"],
  });
});

test("native behaviour is never typed observed", () => {
  const analysis = toAnalysis(nativeBuilt(), { kind: "code", probes: [] });
  assert.deepEqual(behaviourClaimViolations(analysis.claims), []);
  assert.deepEqual(
    behaviourClaimViolations([
      { id: "clm-x", kind: "observed", subject: "/behavior/routes/0" },
      { id: "clm-y", kind: "derived", subject: "/behavior/routes/1" },
    ]),
    ["clm-x"],
  );
});

test("every enumerated APK item is a gap until a claim names it", () => {
  const entries = nativeEntries(toAnalysis(apkBuilt(), { kind: "apk" }), []);
  assert.equal(entries.length, 7);
  assert.ok(entries.every((entry) => entry.status === "gap"));
  assert.deepEqual(entries.map((entry) => entry.id).slice(0, 3), [
    "asset:assets/config.json",
    "asset:assets/i18n.json",
    "asset:assets/logo.png",
  ]);
});
