/**
 * Shared fixtures for the claim compiler tests.
 *
 * The renderers read the whole IR, so a fixture has to carry every field a
 * target kind touches. Keeping them in one module means a new renderer field is
 * added here once instead of in each test.
 */

export function webBuilt(overrides = {}) {
  return {
    target: {
      kind: "web",
      input: "https://shop.test",
      name: "Shop",
      url: "https://shop.test",
      final_url: "https://shop.test/",
      size_bytes: null,
      sha256: null,
      platform: "web",
    },
    coverage: ["DOM und sichtbare Oberfläche"],
    surface: {
      title: "Shop",
      url: "https://shop.test",
      final_url: "https://shop.test/",
      lang: "de",
      description: null,
      dom_bytes: 10,
      text_excerpt: "Shop",
      screenshot: { included: false },
      accessibility_excerpt: null,
      landmarks: { main: 1 },
      headings: [{ level: 1, text: "Shop" }],
      buttons: [],
      links: [],
      inputs: [],
      forms: [],
      images: [],
      scripts: [],
      stylesheets: [],
    },
    behavior: {
      steps: [],
      navigation: [],
      network: {
        transactions: 1,
        failed: 0,
        endpoints: [],
        requests: [{ method: "POST", path: "/api/orders", status: 201 }],
        contracts: [],
      },
      events: { retained: 0, dropped: 0, by_kind: [], bindings: [] },
      server: { routes: [], calls: [], errors: [] },
      console: [],
      page_errors: [],
    },
    internals: {
      statistics: {
        parsed_javascript_files: 0,
        relevant_files: 0,
        visited_ast_nodes: 0,
      },
      semantic_graph: {
        nodes: 0,
        relations: 0,
        by_kind: [],
        functions: [],
        call_sites: [],
        requests: [],
      },
      application_graph: { nodes: 0, edges: 0, modules: [] },
      routes: [],
    },
    data: { storage_keys: null },
    dependencies: ["fetch"],
    reconstruction: [
      {
        step: 1,
        title: "Gerüst",
        goal: "Eine leere Seite rendert.",
        inputs: ["DOM"],
        outputs: ["Seite"],
        checks: ["Startseite rendert"],
      },
    ],
    acceptance: ["Startseite rendert"],
    ...overrides,
  };
}

export function webCtx(overrides = {}) {
  return {
    kind: "web",
    target: "https://shop.test",
    includeSources: true,
    evidence: [
      {
        role: "network",
        path: "evidence/network.json",
        bytes: 12,
        sha256: "a".repeat(64),
      },
    ],
    warnings: [],
    limits: ["nur mit authentifizierter Sitzung beobachtet"],
    openQuestions: [],
    probes: [{ id: "web.journey", tags: ["journey-executed"] }],
    producedAt: "2026-11-20T12:00:00.000Z",
    requestedCeiling: "executed",
    ...overrides,
  };
}
