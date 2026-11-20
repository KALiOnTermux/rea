/**
 * Package parts a rebuild needs beyond the three main documents: the flows the
 * capture recorded and the two specs (UI shell, core logic).
 *
 * Everything here is derived from the packaged blueprint facts, never from the
 * clock, the environment or the source tree, so two runs over the same analysis
 * produce identical bytes. Where a fact is missing the document says so instead
 * of inventing one.
 */

const asArray = (value) => (Array.isArray(value) ? value : []);

const text = (value) => (typeof value === "string" ? value : "");

function cell(value) {
  return String(value ?? "")
    .replaceAll("|", "\\|")
    .replaceAll("\n", " ");
}

function pointer(path, pointerPath) {
  return { path, selector: { type: "pointer", pointer: pointerPath } };
}

/**
 * The recorded flows: one per captured step, plus a navigation flow when the
 * capture only carries start and landing URL. Each flow names the evidence
 * pointer it comes from, so a rebuild can re-check it.
 */
export function flowsDocument(blueprint) {
  const surface = blueprint?.surface ?? {};
  const steps = asArray(blueprint?.behavior?.steps);
  const flows = [];
  if (steps.length > 0) {
    for (const [index, step] of steps.entries()) {
      flows.push({
        id: `flow-${index + 1}`,
        action: text(step.action) || "step",
        from_url: text(step.url) || text(surface.url),
        to_url: text(step.after_url) || text(step.url),
        status: Number.isFinite(step.status) ? step.status : null,
        elapsed_ms: Number.isFinite(step.elapsed_ms) ? step.elapsed_ms : null,
        evidence: pointer("evidence/web-capture.json", `/steps/${index}`),
      });
    }
  } else if (surface.url) {
    flows.push({
      id: "flow-1",
      action: "goto",
      from_url: text(surface.url),
      to_url: text(surface.final_url) || text(surface.url),
      status: null,
      elapsed_ms: null,
      evidence: pointer("evidence/web-capture.json", "/url"),
    });
  }
  for (const [index, item] of asArray(blueprint?.reconstruction).entries()) {
    flows.push({
      id: `rebuild-${index + 1}`,
      action: "rebuild",
      from_url: "",
      to_url: "",
      status: null,
      elapsed_ms: null,
      step: text(item?.step ?? item?.title ?? item),
      evidence: pointer("BLUEPRINT.md", "/reconstruction"),
    });
  }
  return {
    schema: "rea.blueprint.flows",
    schema_version: 1,
    blueprint_id: text(blueprint?.id),
    target: blueprint?.target ?? {},
    ceiling: blueprint?.ceiling ?? {},
    flows,
  };
}

/** The UI shell spec: what the rebuild must show, with its evidence. */
export function uiSpec(blueprint) {
  const surface = blueprint?.surface ?? {};
  const lines = [
    `# UI-Spec — ${text(surface.title) || text(blueprint?.target?.name) || "Ziel"}`,
    "",
    "Diese Datei beschreibt die sichtbare Schale so, wie sie beobachtet wurde. Sie ersetzt keine Behauptung aus `BLUEPRINT.md`, sondern ordnet dieselben Fakten für den Nachbau.",
    "",
    "## Rahmen",
    "",
    `- **Titel:** ${text(surface.title) || "unbekannt"}`,
    `- **Start-URL:** ${text(surface.url) || "unbekannt"}`,
    `- **End-URL:** ${text(surface.final_url) || "unbekannt"}`,
    `- **Sprache:** ${text(surface.lang) || "nicht beobachtet"}`,
    `- **Ceiling:** ${text(blueprint?.ceiling?.ceiling) || "nicht deklariert"}`,
    `- **Beleg:** \`evidence/web-capture.json\`, \`surface/dom.html\``,
    "",
    "## Struktur",
    "",
    "| Element | Anzahl |",
    "| --- | --- |",
  ];
  const landmarks = Object.entries(surface.landmarks ?? {}).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  if (landmarks.length === 0) lines.push("| keine Landmarks beobachtet | 0 |");
  for (const [name, count] of landmarks) {
    lines.push(`| ${cell(name)} | ${cell(count)} |`);
  }

  const table = (title, rows, header) => {
    if (rows.length === 0) return;
    lines.push(
      "",
      `## ${title}`,
      "",
      `| ${header.join(" | ")} |`,
      `| ${header.map(() => "---").join(" | ")} |`,
    );
    for (const row of rows) {
      lines.push(`| ${row.map((value) => cell(value)).join(" | ")} |`);
    }
  };

  table(
    "Überschriften",
    asArray(surface.headings).map((heading) => [
      `${"#".repeat(heading?.level ?? 1)} ${text(heading?.text)}`,
    ]),
    ["Überschrift"],
  );
  table(
    "Bedienelemente",
    asArray(surface.buttons).map((button) => [
      text(button?.label),
      button?.id ? `#${button.id}` : "—",
      text(button?.type) || "—",
      button?.id ? `#${button.id}` : `button[type="${text(button?.type)}"]`,
    ]),
    ["Label", "ID", "Typ", "Selektor"],
  );
  table(
    "Links",
    asArray(surface.links).map((link) => [
      text(link?.label) || "(ohne Text)",
      text(link?.href) || "—",
      link?.href ? `a[href="${link.href}"]` : "a",
    ]),
    ["Label", "Ziel", "Selektor"],
  );
  table(
    "Formulare und Eingaben",
    [
      ...asArray(surface.forms).map((form) => [
        "form",
        text(form?.action) || "(aktuell)",
        text(form?.method) || "GET",
        "form",
      ]),
      ...asArray(surface.inputs).map((input) => [
        text(input?.tag) || "input",
        text(input?.name) || "—",
        text(input?.type) || "—",
        input?.id ? `#${input.id}` : text(input?.tag) || "input",
      ]),
    ],
    ["Element", "Ziel/Name", "Typ", "Selektor"],
  );
  table(
    "Assets",
    [
      ...asArray(surface.images).map((image) => [
        "Bild",
        text(image?.src),
        text(image?.alt) || "—",
      ]),
      ...asArray(surface.scripts).map((script) => [
        "Skript",
        text(script?.src),
        "—",
      ]),
      ...asArray(surface.stylesheets).map((sheet) => [
        "Stylesheet",
        text(sheet?.href),
        "—",
      ]),
    ],
    ["Art", "Pfad", "Alt"],
  );

  const boundaries = asArray(blueprint?.boundaries);
  if (boundaries.length > 0) {
    lines.push("", "## Offene Grenzen", "");
    for (const boundary of boundaries) {
      lines.push(`- ${text(boundary?.criterion)} — ${text(boundary?.why)}`);
    }
  }
  lines.push(
    "",
    "## Abnahme",
    "",
    "Die ausführbaren Prüfungen stehen in `acceptance.json`; die Kriterien und ihre Falsifier in `BLUEPRINT.md`, Abschnitt 8.",
    "",
  );
  return lines.join("\n");
}

/** The logic spec: requests, routes, modules and data the rebuild must honour. */
export function logicSpec(blueprint) {
  const behavior = blueprint?.behavior ?? {};
  const internals = blueprint?.internals ?? {};
  const data = blueprint?.data ?? {};
  const lines = [
    `# Logik-Spec — ${text(blueprint?.target?.name) || text(blueprint?.id) || "Ziel"}`,
    "",
    "Diese Datei ordnet die beobachteten und abgeleiteten Logikfakten für den Nachbau. Belege stehen in `evidence/`, die Behauptungen samt Ceiling in `BLUEPRINT.md`, Abschnitt 5–7.",
    "",
    "## Netzwerk",
    "",
  ];
  const requests = asArray(behavior.network?.requests ?? behavior.requests);
  if (requests.length === 0) {
    lines.push(
      "Keine Anfrage beobachtet; der Nenner `request` bleibt begründet leer.",
    );
  } else {
    lines.push("| Methode | URL | Status | Typ |", "| --- | --- | --- | --- |");
    for (const request of requests) {
      lines.push(
        `| ${cell(request?.method || "GET")} | ${cell(request?.url)} | ${cell(request?.status ?? "—")} | ${cell(request?.resource_type || request?.type || "—")} |`,
      );
    }
  }

  lines.push("", "## Routen", "");
  const routes = asArray(internals.routes);
  const steps = asArray(behavior.steps);
  if (routes.length === 0 && steps.length === 0) {
    lines.push("Keine Route beobachtet.");
  } else {
    for (const route of routes) {
      lines.push(
        `- \`${text(route?.method) || "GET"} ${text(route?.path ?? route?.pattern ?? route?.route)}\``,
      );
    }
    for (const step of steps) {
      if (step?.after_url)
        lines.push(`- \`GET ${step.after_url}\` (aufgenommen)`);
    }
  }

  const modules = asArray(internals.modules ?? internals.files);
  if (modules.length > 0) {
    lines.push("", "## Module", "", "| Modul | Rolle |", "| --- | --- |");
    for (const module of modules) {
      lines.push(
        `| ${cell(module?.path ?? module?.name ?? module)} | ${cell(module?.role ?? "—")} |`,
      );
    }
  }

  const keys = Object.keys(data ?? {}).sort();
  if (keys.length > 0) {
    lines.push("", "## Daten", "");
    for (const key of keys) lines.push(`- \`${key}\``);
  }

  const dependencies = asArray(blueprint?.dependencies);
  if (dependencies.length > 0) {
    lines.push("", "## Abhängigkeiten", "");
    for (const dependency of dependencies) {
      lines.push(
        `- ${cell(dependency?.name ?? dependency)}${dependency?.version ? ` ${cell(dependency.version)}` : ""}`,
      );
    }
  }

  const limits = asArray(blueprint?.limits);
  if (limits.length > 0) {
    lines.push("", "## Grenzen", "");
    for (const limit of limits) lines.push(`- ${text(limit)}`);
  }
  lines.push(
    "",
    "## Abnahme",
    "",
    "Die Prüfungen zu diesen Fakten stehen in `acceptance.json`; die Falsifier nennt `BLUEPRINT.md`, Abschnitt 10.",
    "",
  );
  return lines.join("\n");
}

/** Every package part beyond the three documents, in one place. */
export function packageParts(blueprint) {
  return {
    "flows/flows.json": `${JSON.stringify(flowsDocument(blueprint), null, 2)}\n`,
    "specs/ui.md": uiSpec(blueprint),
    "specs/logic.md": logicSpec(blueprint),
  };
}
