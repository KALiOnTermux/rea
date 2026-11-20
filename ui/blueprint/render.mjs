/**
 * Rendering pass of the claim compiler (spec §5, §7).
 *
 * Sections 1-4 and 8-9 carry the prose the studio always rendered; sections 5-7
 * are generated from the claim records, one section per kind, so an observation
 * cannot appear as a derivation. Section 10 lists the evidence reference and the
 * falsifier of every claim.
 *
 * The module is pure: it reads only the compiled object it is given.
 */

/** Renders sections 5-7, the three claim kinds, as Markdown lines. */
export function renderClaimsSection(claims) {
  const lines = [];
  const groups = [
    [
      "5. Beobachtet (observed)",
      "observed",
      "Vom Lauf aufgezeichnete Fakten. Jede Aussage nennt die Belegdatei, ihre Position und den Test, der sie widerlegen würde.",
    ],
    [
      "6. Abgeleitet (derived)",
      "derived",
      "Aus den Beobachtungen rekonstruierte Zusammenhänge. Die Regel und die Zahl der Eingaben stehen dabei; eine Ableitung ist keine Beobachtung.",
    ],
    [
      "7. Angenommen (assumed)",
      "assumed",
      "Weder beobachtet noch abgeleitet. Jede Annahme nennt ihre Wirkung und den Schritt, der sie in eine Beobachtung überführen würde.",
    ],
  ];
  for (const [title, kind, intro] of groups) {
    lines.push("", `## ${title}`, "", intro, "");
    const group = claims.filter((claim) => claim.kind === kind);
    if (group.length === 0) {
      lines.push("Keine Behauptungen dieser Art im Paket.");
      continue;
    }
    for (const claim of group) {
      lines.push(`### \`${claim.id}\``, "");
      lines.push(claim.statement, "");
      lines.push(`- **Ceiling:** ${claim.ceiling}`);
      if (claim.subject) lines.push(`- **Subjekt:** \`${claim.subject}\``);
      const refs = claim.evidence.map((entry) => `\`${entry.path}\``);
      lines.push(
        `- **Beleg:** ${refs.length > 0 ? refs.join(", ") : "kein Beleg"}`,
      );
      if (claim.derivation) {
        lines.push(
          `- **Ableitung:** Regel \`${claim.derivation.rule}\` aus ${claim.derivation.inputs.length} Eingabe(n)`,
        );
      }
      if (claim.assumption) {
        lines.push(`- **Wirkung:** ${claim.assumption.impact}`);
        lines.push(`- **Auflösung:** ${claim.assumption.resolution}`);
      }
      lines.push(`- **Falsifier:** \`${claim.falsifier}\``);
      for (const limit of claim.limits || [])
        lines.push(`- **Grenze:** ${limit}`);
      lines.push("");
    }
  }
  return lines;
}

/** Escapes a table cell, so a pipe or newline in a criterion cannot break the table. */
function cell(value) {
  return String(value ?? "—")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ");
}

export function renderMarkdown(compiled) {
  const bp = compiled.blueprint;
  const lines = [];
  const add = (...values) => lines.push(...values);
  const bullet = (value) => add(`- ${value}`);
  const section = (title, body) => {
    add("", `## ${title}`, "");
    body();
  };

  const part = (title, body) => {
    add("", `### ${title}`, "");
    body();
  };
  add(`# Blaupause: ${bp.target.name}`);
  add("");
  add(
    `> Erstellt mit REA Studio aus dem ausgelieferten Ziel. ` +
      "Diese Blaupause trennt belegte Beobachtungen, abgeleitete Zusammenhänge und offene Punkte. " +
      "Sie ist als Bauauftrag von Anfang bis Ende geschrieben.",
  );
  add("");
  add("## Kurzfassung");
  add("");
  add(`- **Ziel:** ${bp.target.kind} · ${bp.target.input}`);
  if (bp.target.sha256) add(`- **SHA-256:** \`${bp.target.sha256}\``);
  if (bp.target.size_bytes) add(`- **Größe:** ${bp.target.size_bytes} Bytes`);
  add(`- **Belegt:** ${bp.coverage.available.join(", ") || "keine Kerndaten"}`);
  add(
    `- **Offene Punkte:** ${bp.open_questions.length === 0 ? "keine im Rahmen dieser Erhebung" : bp.open_questions.length}`,
  );
  add(
    `- **Enthaltene Beweise:** ${bp.evidence.length} Datei(en), ${bp.bundle.bytes_raw} Bytes vor Kompression`,
  );

  section("1. Auftrag und Zielbild", () => {
    add(
      "Baue das Ziel von Anfang bis Ende neu auf: zuerst die äußere Form, dann das Verhalten, dann das Innenleben. " +
        "Die Reihenfolge ist bewusst positiv herum. Beginne nicht mit dem Dekompilat, sondern mit einem lauffähigen Gerüst, " +
        "das anschließend Schicht für Schicht mit den belegten Fakten gefüllt wird.",
    );
    add("");
    add(
      "Die Blaupause beschreibt keine Vermutungen als Tatsachen. Wo etwas nur statisch abgeleitet oder gar nicht beobachtet wurde, " +
        "steht das ausdrücklich in Abschnitt 9. Ein Coding-Agent soll diese Punkte zuerst prüfen, nicht stillschweigend erfinden.",
    );
    add("");
    part("Reihenfolge des Aufbaus (verbindlich)", () => {
      renderReconstruction(add, bp);
    });
  });

  section("2. Ziel", () => {
    add(
      `- **Zieltyp:** ${bp.target.kind}${bp.target.platform ? ` · ${bp.target.platform}` : ""}`,
    );
    add(`- **Quelle:** ${bp.target.input}`);
    if (bp.target.sha256) add(`- **SHA-256:** \`${bp.target.sha256}\``);
    if (bp.target.size_bytes) add(`- **Größe:** ${bp.target.size_bytes} Bytes`);
    add(
      `- **Ceiling:** ${bp.ceiling?.ceiling ?? "nicht deklariert"}${bp.ceiling?.requested && bp.ceiling.requested !== bp.ceiling.ceiling ? ` (angefragt: ${bp.ceiling.requested})` : ""}`,
    );
    for (const reason of bp.ceiling?.downgraded_by ?? [])
      add(`- **Herabgesetzt:** \`${reason}\``);
    if (bp.gate) {
      add(
        `- **Gate:** ${bp.gate.ok ? "pass" : "fail"} · ${bp.gate.status} · ${bp.gate.violations} Verletzung(en) · Coverage ${bp.gate.coverage}`,
      );
    }
    if (bp.closure) {
      add(
        `- **Closure:** ${bp.closure.covered} covered, ${bp.closure.gap} gap, ${bp.closure.out_of_scope} out_of_scope · Nenner ${bp.closure.covered + bp.closure.gap + bp.closure.out_of_scope} · Ratio ${bp.closure.ratio}`,
      );
    }
    add(
      `- **Belegt:** ${bp.coverage.available.join(", ") || "keine Kerndaten"}`,
    );
    add(`- **Belege im Paket:** ${bp.evidence.length} Datei(en)`);
  });

  if (bp.target.kind === "web") {
    const s = bp.surface;
    const b = bp.behavior;
    const i = bp.internals;
    section("3. Oberfläche (äußere Schale)", () => {
      add(`- **Titel:** ${s.title || "unbekannt"}`);
      add(`- **Start-URL:** ${s.url}`);
      add(`- **End-URL:** ${s.final_url}`);
      if (s.lang) add(`- **Sprache:** ${s.lang}`);
      if (s.description) add(`- **Beschreibung:** ${s.description}`);
      add(
        `- **DOM:** ${s.dom_bytes} Bytes${s.screenshot.included ? ", Screenshot beigelegt" : ", kein Screenshot"}`,
      );
      add(
        `- **Accessibility:** ${s.accessibility_excerpt ? "Baum beigelegt" : "nicht beigelegt"}`,
      );
      add("");
      add("### Struktur");
      add("");
      for (const [name, count] of Object.entries(s.landmarks).filter(
        ([, count]) => count > 0,
      )) {
        bullet(`${name}: ${count}`);
      }
      if (s.headings.length > 0) {
        add("");
        add("### Überschriften");
        add("");
        for (const heading of s.headings.slice(0, 40)) {
          bullet(`${"#".repeat(heading.level)} ${heading.text}`);
        }
      }
      if (s.buttons.length > 0) {
        add("");
        add("### Bedienelemente");
        add("");
        for (const button of s.buttons.slice(0, 40)) {
          bullet(
            `${button.label}${button.id ? ` (#${button.id})` : ""}${button.type ? ` [${button.type}]` : ""}`,
          );
        }
      }
      if (s.links.length > 0) {
        add("");
        add("### Links");
        add("");
        for (const link of s.links.slice(0, 40)) {
          bullet(`${link.label || "(ohne Text)"} → \`${link.href}\``);
        }
      }
      if (s.inputs.length + s.forms.length > 0) {
        add("");
        add("### Formulare und Eingaben");
        add("");
        for (const form of s.forms) {
          bullet(
            `Formular → \`${form.action || "(aktuell)"}\` [${form.method}]`,
          );
        }
        for (const input of s.inputs.slice(0, 40)) {
          bullet(
            `<${input.tag}>${input.type ? ` type=${input.type}` : ""}${input.name ? ` name=${input.name}` : ""}${input.placeholder ? ` „${input.placeholder}“` : ""}`,
          );
        }
      }
      if (s.images.length + s.scripts.length + s.stylesheets.length > 0) {
        add("");
        add("### Assets");
        add("");
        for (const image of s.images.slice(0, 30)) {
          bullet(`Bild: \`${image.src}\`${image.alt ? ` (${image.alt})` : ""}`);
        }
        for (const script of s.scripts.slice(0, 30))
          bullet(`Skript: \`${script.src}\``);
        for (const sheet of s.stylesheets.slice(0, 30))
          bullet(`Stylesheet: \`${sheet.href}\``);
      }
      if (s.text_excerpt) {
        add("");
        add("### Sichtbarer Text (Auszug)");
        add("");
        add("> " + s.text_excerpt.replaceAll("\n", "\n> "));
      }
    });

    section("4. Verhalten", () => {
      add(`- **Aufgenommene Schritte:** ${b.steps.length}`);
      add(
        `- **Netzwerk-Transaktionen:** ${b.network.transactions}, fehlgeschlagen: ${b.network.failed}`,
      );
      add(
        `- **Events:** ${b.events.retained} behalten, ${b.events.dropped} verworfen`,
      );
      add("");
      add("### Ablauf");
      add("");
      for (const step of b.steps) {
        bullet(
          `${step.action} → ${step.after_url || "?"} (${step.status || "?"}, ${step.elapsed_ms ?? "?"} ms)`,
        );
      }
      if (b.navigation.length > 0) {
        add("");
        add("### Navigationsziele");
        add("");
        for (const entry of b.navigation) bullet(`\`${entry.url}\``);
      }
      add("");
      add("### Beobachtete Endpunkte");
      add("");
      for (const endpoint of b.network.endpoints)
        bullet(`${endpoint.name} (${endpoint.count}×)`);
      if (b.network.requests.length > 0) {
        add("");
        add("### Requests in Reihenfolge");
        add("");
        for (const request of b.network.requests.slice(0, 200)) {
          bullet(
            `\`${request.method}\` \`${request.url}\` → ${request.status ?? "?"}${request.failed ? " (fehlgeschlagen)" : ""} [${request.resource_type || "?"}]`,
          );
        }
      }
      if ((b.events?.bindings || []).length > 0) {
        add("");
        add("### Statische Event-Bindings");
        add("");
        for (const binding of b.events.bindings.slice(0, 80)) {
          bullet(
            `${binding.event} → ${binding.selector} (${binding.handler})${binding.file ? ` — \`${binding.file}:${binding.line}\`` : ""}`,
          );
        }
      }
      if (b.server?.routes?.length > 0) {
        add("");
        add("### Serverfunktionen und Routen");
        add("");
        for (const route of b.server.routes.slice(0, 120)) {
          add(
            `#### ${route.method} ${route.path}${route.kind ? ` [${route.kind}]` : ""}`,
          );
          add("");
          add(
            `- **Handler:** ${route.handler || "nicht benannt"}${route.signature ? ` — \`${route.signature}\`` : ""}`,
          );
          add(`- **Quelle:** \`${route.file}:${route.line}\``);
          if (route.errors?.length) {
            add(
              `- **Fehlerpfade:** ${route.errors.map((error) => `${error.status || "throw"} ${error.message}`).join("; ")}`,
            );
          }
          add("");
        }
      }
      if (b.network.contracts?.length > 0) {
        add("");
        add("### Datenverträge");
        add("");
        for (const contract of b.network.contracts.slice(0, 20)) {
          add(
            `#### ${contract.method} ${contract.url} → ${contract.status ?? "?"}`,
          );
          add("");
          if (contract.content_type)
            add(`Content-Type: \`${contract.content_type}\``);
          if (contract.source_route) {
            add(
              `Serverquelle: \`${contract.source_file}:${contract.source_line}\` — ${contract.source_handler || "Handler unbekannt"}${contract.source_signature ? ` \`${contract.source_signature}\`` : ""}`,
            );
          }
          if (contract.source_errors?.length) {
            add(
              `Fehler im Quellcode: ${contract.source_errors.map((error) => `${error.status || "throw"} ${error.message}`).join("; ")}`,
            );
          }
          if (contract.request_shape) {
            add("");
            add("Request-Form:");
            add("");
            add("```json");
            add(JSON.stringify(contract.request_shape, null, 2));
            add("```");
          }
          if (contract.request_sample) {
            add("");
            add(
              `Request-Beispiel: \`${contract.request_sample.replaceAll("`", "'")}\``,
            );
          }
          if (contract.response_shape) {
            add("");
            add("Response-Form:");
            add("");
            add("```json");
            add(JSON.stringify(contract.response_shape, null, 2));
            add("```");
          }
          if (contract.response_sample) {
            add("");
            add(
              `Response-Beispiel: \`${contract.response_sample.replaceAll("`", "'")}\``,
            );
          }
          add("");
        }
      }
      add("");
      add("### Events nach Art");
      add("");
      for (const kind of b.events.by_kind)
        bullet(`${kind.name}: ${kind.count}`);
      if (b.console.length + b.page_errors.length > 0) {
        add("");
        add("### Meldungen");
        add("");
        for (const entry of b.console.slice(0, 20)) {
          bullet(`${entry.level || "console"}: ${entry.text}`);
        }
        for (const entry of b.page_errors.slice(0, 20))
          bullet(`Fehler: ${entry}`);
      }
    });

    part("Innenleben", () => {
      add(
        `- **JavaScript-Dateien:** ${i.statistics?.parsed_javascript_files ?? "unbekannt"}` +
          `, relevante Dateien: ${i.statistics?.relevant_files ?? "unbekannt"}` +
          `, AST-Knoten: ${i.statistics?.visited_ast_nodes ?? "unbekannt"}`,
      );
      add(
        `- **Semantischer Graph:** ${i.semantic_graph.nodes} Knoten, ${i.semantic_graph.relations} Beziehungen`,
      );
      add(
        `- **Anwendungsgraph:** ${i.application_graph.nodes} Knoten, ${i.application_graph.edges} Kanten`,
      );
      add(`- **Routen-Kandidaten:** ${i.routes.length}`);
      add("");
      add("### Knotenarten");
      add("");
      for (const kind of i.semantic_graph.by_kind)
        bullet(`${kind.name}: ${kind.count}`);
      if (i.semantic_graph.functions.length > 0) {
        add("");
        add("### Funktionen");
        add("");
        for (const fn of i.semantic_graph.functions.slice(0, 60)) {
          bullet(
            `${fn.name}${fn.module ? ` — \`${fn.module}\`` : ""}${fn.line ? `:${fn.line}` : ""}`,
          );
        }
      }
      if (i.semantic_graph.call_sites.length > 0) {
        add("");
        add("### Aufrufstellen");
        add("");
        for (const call of i.semantic_graph.call_sites.slice(0, 60)) {
          bullet(
            `${call.name}${call.module ? ` — \`${call.module}\`` : ""}${call.line ? `:${call.line}` : ""}`,
          );
        }
      }
      if ((b.server?.calls || []).length > 0) {
        add("");
        add("### Server-Aufrufstellen");
        add("");
        for (const call of b.server.calls.slice(0, 80)) {
          bullet(
            `${call.name}${call.function ? ` in ${call.function}` : ""} — \`${call.file}:${call.line}\``,
          );
        }
      }
      if ((b.server?.errors || []).length > 0) {
        add("");
        add("### Server-Fehlerpfade");
        add("");
        for (const error of b.server.errors.slice(0, 80)) {
          bullet(
            `${error.status || error.kind} ${error.message} — \`${error.file}:${error.line}\`${error.function ? ` (${error.function})` : ""}`,
          );
        }
      }
      if (i.semantic_graph.requests.length > 0) {
        add("");
        add("### Statisch erkannte Anfragen");
        add("");
        for (const request of i.semantic_graph.requests.slice(0, 60))
          bullet(request.name);
      }
      if (i.application_graph.modules.length > 0) {
        add("");
        add("### Module");
        add("");
        for (const module of i.application_graph.modules.slice(0, 80))
          bullet(module.name);
      }
      if (i.routes.length > 0) {
        add("");
        add("### Routen");
        add("");
        for (const route of i.routes.slice(0, 80)) {
          bullet(
            `${route.path || route}${route.kind ? ` [${route.kind}]` : ""}`,
          );
        }
      }
    });

    part("Daten und Speicher", () => {
      if (!bp.data.storage_keys) {
        add("Es wurde kein Speicherzustand aufgenommen.");
        return;
      }
      const data = bp.data.storage_keys;
      add(`- **Cookies:** ${data.cookies.length}`);
      for (const cookie of data.cookies)
        bullet(
          `${cookie.name || "?"}${cookie.domain ? ` (${cookie.domain})` : ""}`,
        );
      add(`- **Local-Storage-Origins:** ${data.local_storage.length}`);
      for (const origin of data.local_storage) {
        bullet(
          `${origin.origin || "?"}: ${origin.keys.map((entry) => entry.key || "?").join(", ") || "(keine Schlüssel)"}`,
        );
      }
      add(`- **Session-Storage-Origins:** ${data.session_storage.length}`);
      for (const origin of data.session_storage) {
        bullet(
          `${origin.origin || "?"}: ${origin.keys.map((entry) => entry.key || "?").join(", ") || "(keine Schlüssel)"}`,
        );
      }
    });
  } else if (bp.target.kind === "apk") {
    const s = bp.surface;
    const b = bp.behavior;
    const i = bp.internals;
    section("3. Oberfläche (APK-Schale)", () => {
      add(`- **Paket:** \`${s.package_name}\``);
      add(`- **Version:** ${s.version_name} (Code ${s.version_code})`);
      add(`- **SDK:** min ${s.min_sdk}, target ${s.target_sdk}`);
      add(`- **Launcher:** \`${s.launcher_activity || "nicht erkannt"}\``);
      add(
        `- **Klassen:** ${s.class_count} gesamt, davon ${s.app_class_count} im App-Paket`,
      );
      add(
        `- **Ressourcen:** ${s.resource_count} deklariert, ${s.layout_files.length} Layout-Dateien`,
      );
      add(
        `- **Screens/Ressourcen im Paket:** ${s.resource_tree_files} Dateien, ${s.resource_tree_bytes} Bytes`,
      );
      add("");
      add("### Komponenten");
      add("");
      for (const group of ["activity", "service", "receiver", "provider"]) {
        const items = s.components[group] || [];
        if (items.length === 0) continue;
        add(`**${group}**: ${items.length}`);
        for (const component of items.slice(0, 60)) {
          bullet(
            `${component.name}${component.exported ? " [exportiert]" : ""}${component.permission ? ` [${component.permission}]` : ""}`,
          );
        }
      }
      add("");
      add("### Berechtigungen");
      add("");
      for (const permission of s.permissions) bullet(`\`${permission}\``);
      add("");
      add("### Deklarierte Intents");
      add("");
      for (const intent of b.intents.slice(0, 80)) {
        bullet(
          `${intent.component}: ${intent.actions.join(", ") || "ohne Action"}${intent.categories.length ? ` / ${intent.categories.join(", ")}` : ""}`,
        );
      }
    });

    section("4. Verhalten und Einstiegspunkte", () => {
      add(
        "Das Verhalten ist aus Manifest, Komponenten und dekompiliertem Code abgeleitet. " +
          "Es wurde kein Laufzeitmitschnitt der App erstellt.",
      );
      add("");
      add(`- **Exportierte Komponenten:** ${b.exported.length}`);
      for (const component of b.exported)
        bullet(`${component.kind}: ${component.name}`);
      add("");
      add("### Activities als sichtbare Screens");
      add("");
      for (const activity of b.activities.slice(0, 80)) bullet(activity.name);
      add("");
      add(`- **Layouts im Code:** ${(b.screens?.layouts || []).length}`);
      add(`- **Navigationsaufrufe:** ${b.screens?.navigation_calls || 0}`);
      add(`- **Fragment-Übergänge:** ${b.screens?.fragments || 0}`);
      add("");
      add("### Fehler-, Status- und Berechtigungspfade");
      add("");
      if ((b.error_paths || []).length === 0) {
        add("Im App-Paket wurden keine Fehlerpfade gefunden.");
      } else {
        for (const error of b.error_paths.slice(0, 60)) {
          const message =
            (error.messages || []).join(" / ") ||
            error.exception ||
            error.status ||
            error.kind;
          bullet(
            `${error.kind}: ${message} — \`${error.source}\`${error.exception ? ` [${error.exception}]` : ""}`,
          );
        }
      }
      add("");
      add("### Server- und Datenzugriffe (statisch)");
      add("");
      add(`- **URLs:** ${(b.data_flow?.urls || []).length}`);
      add(`- **HTTP-Clients:** ${(b.data_flow?.servers || []).length}`);
      add(`- **Datenbankzugriffe:** ${(b.data_flow?.databases || []).length}`);
      add(`- **Speicherzugriffe:** ${(b.data_flow?.storage || []).length}`);
    });

    part("Innenleben", () => {
      add(`- **App-Klassen:** ${i.app_class_count}`);
      add(`- **Klassengruppen:** ${i.class_groups.length}`);
      add(
        `- **Dekompilierte Java-Dateien:** ${i.source.files} (${i.source.bytes} Bytes)`,
      );
      if (i.source.omitted)
        add(`- **Nicht aufgenommen:** ${i.source.omitted} Datei(en)`);
      add(`- **JADX-Meldungen:** ${i.jadx_errors}`);
      add(
        `- **Smali-Dateien:** ${i.smali?.files || 0} (${i.smali?.classes || 0} Klassen)`,
      );
      add(
        `- **JADX-Dateien mit Fehlern:** ${i.decompile?.error_files?.length || 0}, davon mit Smali-Alternative: ${(i.decompile?.error_files?.length || 0) - (i.decompile?.missing_smali?.length || 0)}`,
      );
      add(
        `- **Fehlerdateien im App-Paket:** ${i.decompile?.app_error_files || 0}`,
      );
      add("");
      if ((i.decompile?.missing_smali || []).length > 0) {
        add("### Einzeln fehlende Dekompilierungsbelege");
        add("");
        for (const source of i.decompile.missing_smali.slice(0, 80))
          bullet(`\`${source}\``);
        add("");
      }
      add("### Klassengruppen");
      add("");
      for (const group of i.class_groups)
        bullet(`${group.name}: ${group.count}`);
      add("");
      add("### Wichtige Klassen");
      add("");
      for (const name of i.notable_classes.slice(0, 80)) bullet(`\`${name}\``);
      if (i.native_libs.length > 0) {
        add("");
        add("### Native Bibliotheken");
        add("");
        for (const name of i.native_libs) bullet(`\`${name}\``);
      }
      if (i.assets.length > 0) {
        add("");
        add("### Assets");
        add("");
        for (const name of i.assets.slice(0, 60)) bullet(`\`${name}\``);
      }
    });

    part("Daten und Ressourcen", () => {
      add(
        `Die vollständigen Ressourcen liegen unter \`surface/android/\` (Manifest, \`res/\`, ` +
          `String-Tabellen). Datenbank- und Speicherzugriffe sind aus dem App-Paket statisch belegt; ` +
          `Laufzeitwerte wurden nicht ausgelesen.`,
      );
      add("");
      add(
        `- **String-Ressourcen:** ${s.string_count} (${s.locales.length} Locales)`,
      );
      add(`- **Layouts:** ${s.layout_files.length}`);
      add(`- **Drawables:** ${s.drawable_files.length}`);
      add(`- **URLs:** ${(b.data_flow?.urls || []).length}`);
      add(`- **HTTP-Clients:** ${(b.data_flow?.servers || []).length}`);
      add(`- **Datenbankzugriffe:** ${(b.data_flow?.databases || []).length}`);
      add(`- **Speicherzugriffe:** ${(b.data_flow?.storage || []).length}`);
      if (s.strings_sample.length > 0) {
        add("");
        add("### String-Beispiele");
        add("");
        for (const item of s.strings_sample)
          bullet(`${item.name} = „${item.value}“`);
      }
    });
  } else if (bp.internals?.semantic_graph) {
    const s = bp.surface;
    const b = bp.behavior;
    const i = bp.internals;
    section("3. Oberfläche und Ziel", () => {
      add(`- **Format:** ${s.format || "unbekannt"}`);
      add(`- **Fenster:** ${s.windows ?? "nicht belegt"}`);
      add(
        `- **Preload-Einstiegspunkte:** ${s.preload_entrypoints ?? "nicht belegt"}`,
      );
      add(`- **Utility-Prozesse:** ${s.utility_processes ?? "nicht belegt"}`);
      add(
        `- **Protokoll-Registrierungen:** ${s.protocol_registrations ?? "nicht belegt"}`,
      );
      if ((s.routes || []).length > 0) {
        add("");
        add("### Routen");
        add("");
        for (const route of s.routes.slice(0, 120)) {
          bullet(
            `${route.path || route}${route.kind ? ` [${route.kind}]` : ""}`,
          );
        }
      }
      if (s.exposed_api_members?.length || s.context_bridge_apis?.length) {
        add("");
        add("### Exponierte APIs");
        add("");
        for (const name of (s.exposed_api_members || []).slice(0, 120))
          bullet(name);
        for (const name of (s.context_bridge_apis || []).slice(0, 120))
          bullet(name);
      }
    });
    section("4. Verhalten", () => {
      add(
        "Module, Funktionen, Aufrufe und IPC sind statisch aus dem Anwendungsgraph abgeleitet. Ein Laufzeitmitschnitt wurde nicht erstellt.",
      );
      add("");
      add("### IPC");
      add("");
      for (const [key, value] of Object.entries(b.ipc || {})) {
        if (typeof value === "number") bullet(`${key}: ${value}`);
        else if (Array.isArray(value) && value.length > 0) {
          bullet(`${key}: ${value.slice(0, 30).join(", ")}`);
        }
      }
      if ((b.endpoints || []).length > 0) {
        add("");
        add("### Statisch erkannte Endpunkte");
        add("");
        for (const endpoint of b.endpoints.slice(0, 120)) {
          bullet(
            `${endpoint.name}${endpoint.module ? ` — \`${endpoint.module}\`` : ""}${endpoint.line ? `:${endpoint.line}` : ""}`,
          );
        }
      }
      if ((b.storage || []).length > 0) {
        add("");
        add("### Speicherzugriffe");
        add("");
        for (const entry of b.storage.slice(0, 80)) {
          bullet(
            `${entry.name}${entry.module ? ` — \`${entry.module}\`` : ""}`,
          );
        }
      }
    });
    part("Innenleben", () => {
      add(
        `- **AST-Knoten:** ${i.statistics?.visited_ast_nodes ?? "unbekannt"}`,
      );
      add(
        `- **Relevante Dateien:** ${i.statistics?.relevant_files ?? "unbekannt"}`,
      );
      add(
        `- **Semantischer Graph:** ${i.semantic_graph?.nodes ?? 0} Knoten, ${i.semantic_graph?.relations ?? 0} Beziehungen`,
      );
      add(
        `- **Anwendungsgraph:** ${i.application_graph?.nodes ?? 0} Knoten, ${i.application_graph?.edges ?? 0} Kanten`,
      );
      add("");
      add("### Knotenarten");
      add("");
      for (const kind of i.semantic_graph?.by_kind || [])
        bullet(`${kind.name}: ${kind.count}`);
      if ((i.semantic_graph?.functions || []).length > 0) {
        add("");
        add("### Funktionen");
        add("");
        for (const fn of i.semantic_graph.functions.slice(0, 120)) {
          bullet(
            `${fn.name}${fn.module ? ` — \`${fn.module}\`` : ""}${fn.line ? `:${fn.line}` : ""}`,
          );
        }
      }
      if ((i.semantic_graph?.call_sites || []).length > 0) {
        add("");
        add("### Aufrufstellen");
        add("");
        for (const call of i.semantic_graph.call_sites.slice(0, 120)) {
          bullet(
            `${call.name}${call.module ? ` — \`${call.module}\`` : ""}${call.line ? `:${call.line}` : ""}`,
          );
        }
      }
      if ((i.application_graph?.modules || []).length > 0) {
        add("");
        add("### Module");
        add("");
        for (const module of i.application_graph.modules.slice(0, 120)) {
          bullet(`${module.name}${module.path ? ` — \`${module.path}\`` : ""}`);
        }
      }
      if ((i.semantic_graph?.relations_by_kind || []).length > 0) {
        add("");
        add("### Beziehungsarten");
        add("");
        for (const relation of i.semantic_graph.relations_by_kind) {
          bullet(`${relation.name}: ${relation.count}`);
        }
      }
    });
    part("Daten und Abhängigkeiten", () => {
      add(
        "Die statisch belegten Speicherzugriffe stehen unter `behavior.storage`; Laufzeitwerte wurden nicht ausgelesen.",
      );
      if (bp.dependencies?.length > 0) {
        add("");
        add("### Erkannte Abhängigkeiten");
        add("");
        for (const item of bp.dependencies) bullet(item);
      }
    });
  } else {
    // A source tree shares this branch with a native binary. Its facts carry no
    // native-only fields, so every list is read through `list()` and a missing
    // value prints as "nicht belegt" instead of crashing the renderer.
    const s = bp.surface ?? {};
    const i = bp.internals ?? {};
    const behavior = bp.behavior ?? {};
    const pseudocode = i.pseudocode ?? {};
    const list = (value) => (Array.isArray(value) ? value : []);
    section("3. Oberfläche und Ziel", () => {
      add(`- **Format:** ${s.format || "unbekannt"}`);
      add(`- **Architektur:** ${s.architecture || "unbekannt"}`);
      add(`- **Bits:** ${s.bits ?? "unbekannt"}`);
      add(`- **Byte-Reihenfolge:** ${s.byte_order || "unbekannt"}`);
      add(`- **Segmente:** ${s.segments ?? "nicht belegt"}`);
      add(`- **Prozeduren:** ${s.procedures ?? "nicht belegt"}`);
      add(`- **Strings:** ${s.strings ?? "nicht belegt"}`);
    });
    section("4. Verhalten", () => {
      add(
        "Das Verhalten ist aus Einstiegspunkten, Exporten, .rodata-Strings, Disassembly und den " +
          "aufgerufenen Fehler-/Exit-Funktionen statisch abgeleitet. Ein Laufzeitmitschnitt wurde " +
          "nicht erstellt; die belegten Pfade tragen Datei- bzw. Offset-Adressen.",
      );
      add("");
      if (list(behavior.exports).length > 0) {
        add("### Exporte");
        add("");
        for (const name of list(behavior.exports).slice(0, 80))
          bullet(`\`${name}\``);
      }
      if (list(behavior.hardening).length > 0) {
        add("");
        add("### Schutzmerkmale");
        add("");
        for (const row of list(behavior.hardening)) {
          bullet(
            `${row.property}: ${row.state}${row.basis ? ` (${row.basis})` : ""}`,
          );
        }
      }
      add("");
      add("### Ein-/Ausgaben und Exit-Codes");
      add("");
      add(`- **Usage:** ${behavior.cli?.usage || "nicht belegt"}`);
      add(`- **Hilfe:** ${behavior.cli?.help || "nicht belegt"}`);
      for (const row of list(behavior.exit_contract).slice(0, 20)) {
        bullet(`${row.message} — \`${row.source}\``);
      }
      add("");
      add("### Fehler- und Exit-Pfade");
      add("");
      for (const error of list(behavior.error_paths).slice(0, 80)) {
        bullet(
          error.kind === "call"
            ? `${error.call} in ${error.function || "?"} — \`${error.source}\``
            : `${error.message} — \`${error.source}\``,
        );
      }
    });
    part("Innenleben", () => {
      add(
        `- **Pseudocode:** ${pseudocode.files ?? 0} Datei(en), ${pseudocode.bytes ?? 0} Bytes`,
      );
      add(
        `- **Pseudocode:** ${pseudocode.written ?? 0} interne Funktionen` +
          `${pseudocode.external ? ` + ${pseudocode.external} externe Importe ohne Body` : ""}` +
          ` von ${pseudocode.selected ?? 0} ausgewählten` +
          `${pseudocode.remaining ? `, ${pseudocode.remaining} offen` : ""}`,
      );
      add(
        `- **Disassembly:** ${i.disassembly?.calls || 0} Fehler-/Exit-Aufrufe, ${i.disassembly?.messages || 0} .rodata-Meldungen, ${i.disassembly?.error_paths || 0} belegte Pfade`,
      );
      add("");
      if (list(pseudocode.sample).length > 0) {
        add("### Funktionsauszug");
        add("");
        for (const name of list(pseudocode.sample)) bullet(`\`${name}\``);
      }
      if (list(i.observations).length > 0) {
        add("");
        add("### Beobachtungen");
        add("");
        for (const observation of list(i.observations).slice(0, 40))
          bullet(observation);
      }
    });
    part("Abhängigkeiten", () => {
      add(
        "Die statisch belegten Abhängigkeiten stehen in `evidence/` und in den Exporten.",
      );
      if (list(bp.dependencies).length > 0) {
        add("");
        for (const item of list(bp.dependencies)) bullet(item);
      } else {
        add("Es wurden keine zusätzlichen Laufzeitabhängigkeiten erkannt.");
      }
    });
  }

  function renderCompleteness(add, bullet) {
    const completeness = bp.completeness || {};
    const statusLabel =
      {
        complete: "vollständig belegt",
        partial: "teilweise belegt",
        insufficient: "unvollständig",
      }[completeness.status] || "nicht geprüft";
    add(`- **Status:** ${statusLabel}`);
    add(
      `- **Pflichtprüfungen:** ${completeness.passed || 0} von ${completeness.checks?.length || 0} erfüllt`,
    );
    add(
      `- **Belegauflösung:** ${completeness.evidence_audit?.resolved || 0} von ${completeness.evidence_audit?.total || 0} Prüfpunkten mit auflösbarem Beleg`,
    );
    add(`- **Lücken und offene Punkte:** ${completeness.gaps?.length || 0}`);
    add(`- **Punktzahl:** ${completeness.score ?? 0} %`);
    add("");
    add("### Prüfpunkte");
    add("");
    for (const check of completeness.checks || []) {
      const refs = (check.evidence || [])
        .map((entry) =>
          entry.path
            ? `\`${entry.path}${entry.pointer ? `#${entry.pointer}` : entry.line ? `:${entry.line}` : ""}\``
            : `Grenze: ${entry.limit}`,
        )
        .join(", ");
      bullet(
        `${check.ok ? "✓" : "✗"} **${check.label}:** ${check.detail}${refs ? ` — Beleg: ${refs}` : " — kein Beleg"}`,
      );
    }
    add("");
    add("### Lücken");
    add("");
    if ((completeness.gaps || []).length === 0) {
      add("Keine Lücken im Rahmen dieser Prüfung.");
      return;
    }
    for (const gap of completeness.gaps) {
      add(`#### ${gap.id}: ${gap.label}`);
      add("");
      add(`**Warum:** ${gap.why}`);
      add("");
      add(`**Aufgabe für den Coding-Agenten:** ${gap.action}`);
      add("");
    }
  }

  function renderReconstruction(add, bp) {
    for (const step of bp.reconstruction) {
      add(`### Schritt ${step.step}: ${step.title}`);
      add("");
      add(step.goal);
      add("");
      add(`- **Eingaben:** ${step.inputs.join(", ")}`);
      add(`- **Ergebnis:** ${step.outputs.join(", ")}`);
      add(`- **Prüfung:** ${step.checks.join("; ")}`);
      add("");
    }
  }

  add(...renderClaimsSection(compiled.claims));

  section("8. Abnahmekriterien", () => {
    const checks = Array.isArray(compiled.acceptance?.checks)
      ? compiled.acceptance.checks
      : [];
    const byCriterion = new Map();
    for (const check of checks) {
      const list = byCriterion.get(check.criterion) ?? [];
      list.push(check);
      byCriterion.set(check.criterion, list);
    }
    const criteria = [...bp.acceptance];
    for (const check of checks) {
      if (!criteria.includes(check.criterion)) criteria.push(check.criterion);
    }
    add("| Kriterium | Prüfung | Art | Fixture |");
    add("| --- | --- | --- | --- |");
    let missing = 0;
    for (const criterion of criteria) {
      const matched = byCriterion.get(criterion) ?? [];
      if (matched.length === 0) {
        missing += 1;
        add(`| ${cell(criterion)} | fehlt | — | — |`);
        continue;
      }
      for (const check of matched) {
        add(
          `| ${cell(criterion)} | ${cell(check.id)} | ${cell(check.kind)} | ${cell(check.fixture ?? "—")} |`,
        );
      }
    }
    for (const gap of bp.criterion_gaps ?? []) {
      add(`| ${cell(gap.criterion)} | ohne Beleg (Gap im Ledger) | — | — |`);
    }
    for (const boundary of bp.boundaries ?? []) {
      add(`| ${cell(boundary.criterion)} | offene Grenze | — | — |`);
    }
    add("");
    add(
      missing > 0
        ? `${missing} Kriterium/Kriterien ohne Prüfung; das blockiert \`complete\`.`
        : "Jedes Kriterium hat eine ausführbare Prüfung.",
    );
    for (const gap of bp.criterion_gaps ?? []) {
      add("");
      add(
        `- **Nicht belegt:** ${gap.criterion} — ${gap.why} (Gap \`criterion:${gap.criterion}\` im Ledger)`,
      );
    }
    for (const boundary of bp.boundaries ?? []) {
      add("");
      add(`- **Offene Grenze:** ${boundary.criterion} — ${boundary.why}`);
    }
  });

  section("9. Offene Punkte", () => {
    part("Vollständigkeitsprüfung", () => {
      renderCompleteness(add, bullet);
    });
    add("");
    if (bp.open_questions.length === 0) {
      add("Im Rahmen dieser Erhebung sind keine offenen Punkte dokumentiert.");
      return;
    }
    for (const item of bp.open_questions) {
      add(`### ${item.id}: ${item.question}`);
      add("");
      add(`**Warum offen:** ${item.why}`);
      add("");
      add(`**So schließen:** ${item.how}`);
      if (item.evidence.length > 0) {
        add("");
        add(
          `**Bezug:** ${item.evidence.map((value) => `\`${value}\``).join(", ")}`,
        );
      }
      add("");
    }
  });

  section("10. Beweise im Paket", () => {
    part("Paketbestandteile", () => {
      add("| Datei | Inhalt |");
      add("| --- | --- |");
      add("| `BLUEPRINT.md` | Bauplan und Behauptungen (diese Datei) |");
      add("| `blueprint.json` | Dieselben Fakten maschinenlesbar |");
      add("| `AGENT-PROMPT.md` | Fertiger Auftrag für einen Coding-Agenten |");
      add("| `ledger.json` | Closure-Ledger mit Nennern und Einträgen |");
      add("| `acceptance.json` | Ausführbare Prüfungen samt Falsifier |");
      add("| `flows/flows.json` | Aufgenommene Abläufe |");
      add("| `specs/ui.md` | UI-Spec der sichtbaren Schale |");
      add("| `specs/logic.md` | Logik-Spec von Netzwerk, Routen und Modulen |");
      add("| `schemas/` | JSON-Schemas für Claims, Ledger, Manifest, Flows |");
      add("| `evidence/` | Paketinterne Belege (Aufnahme, Analyse) |");
      add("| `surface/` | DOM und weitere Oberflächenbelege |");
      add("| `MANIFEST.json` | Jede Datei mit Größe und SHA-256 |");
      add("| `README.txt` | Kurzüberblick über das Paket |");
    });
    add("");
    for (const item of bp.evidence) {
      bullet(
        `${item.role}: \`${item.path}\`${item.bytes ? ` (${item.bytes} Bytes)` : ""}${item.sha256 ? `, SHA-256 \`${item.sha256}\`` : ""}`,
      );
    }
    if (bp.limits.length > 0) {
      add("");
      add("### Paketgrenzen");
      add("");
      for (const limit of bp.limits) bullet(limit);
    }
    add("");
    part("Behauptungen und ihre Belege", () => {
      add("| Behauptung | Art | Ceiling | Beleg | Falsifier |");
      add("| --- | --- | --- | --- | --- |");
      for (const claim of compiled.claims) {
        const refs = claim.evidence
          .map((entry) => `\`${entry.path}\``)
          .join("<br>");
        add(
          `| \`${claim.id}\` | ${claim.kind} | ${claim.ceiling} | ${refs || "kein Beleg"} | \`${claim.falsifier}\` |`,
        );
      }
    });
  });

  return `${lines.join("\n")}\n`;
}

export function blueprintKind(bp) {
  if (bp.target?.kind !== "code") return bp.target?.kind || "generic";
  if (bp.internals?.semantic_graph) return "javascript";
  if (bp.internals?.pseudocode) return "native";
  return "generic";
}

function agentKindGuide(kind, sourceIncluded = true) {
  if (kind === "web") {
    return {
      paths:
        "`BLUEPRINT.md`, `blueprint.json`, `surface/`, `source/` und `evidence/`",
      order:
        "Gerüst, Oberfläche, Routen, Verhalten, Daten, Innenleben, Abgleich",
      rules: [
        "Übernimm DOM-Struktur, sichtbare Texte, ARIA-Rollen, Routen und Speicher-Schlüssel unverändert, sofern die Blaupause sie nennt.",
        "Übernimm jeden belegten Netzwerkaufruf mit Methode, Pfad, Statusklasse und beobachteter Antwortform.",
        sourceIncluded
          ? "Baue die JavaScript-Funktionen und ihren Aufrufgraph aus `source/` nach; erfinde keine Serverfunktion, die nicht belegt ist."
          : "Ein Quelltext-Export liegt diesem Paket nicht bei; leite Funktionen nur aus den belegten DOM-, Netzwerk- und Beleg-Fakten ab und markiere jede Ergänzung als Annahme.",
      ],
    };
  }
  if (kind === "apk") {
    return {
      paths:
        "`BLUEPRINT.md`, `blueprint.json`, `surface/AndroidManifest.xml`, `surface/android/`, `source/java/`, `source/smali-app/` und `evidence/`",
      order:
        "Projektgerüst, Manifest und Komponenten, Ressourcen und Layouts, Navigation, Verhalten, Daten, Innenleben, Abgleich",
      rules: [
        "Übernimm Paketname, Version, SDK-Grenzen, Berechtigungen und alle Manifest-Komponenten unverändert.",
        "Übernimm Layouts, Strings, Themes und Drawables aus `surface/android/`; sie sind die belegte Oberfläche.",
        "Baue die Java-Klassen aus `source/java/` nach; für JADX-Fehlerdateien liegt die Smali-Alternative in `source/smali-fallback/`, für App-Klassen zusätzlich in `source/smali-app/`. Nur `decompile.missing_smali` ist ein offener Einzelpfad.",
      ],
    };
  }
  if (kind === "native" || kind === "generic") {
    return {
      paths:
        "`BLUEPRINT.md`, `blueprint.json`, `internals/pseudocode/` und `evidence/`",
      order: "Gerüst, Schnittstellen, Verhalten, Innenleben, Abgleich",
      rules: [
        "Übernimm Format, Architektur, Exporte und belegte Schnittstellen aus der Analyse.",
        "Baue die internen Funktionen aus dem C-Pseudocode nach; externe Importe ohne Body sind in `pseudocode.external_names` einzeln benannt und werden nicht als fehlender Funktionsrumpf behandelt.",
        "Erfinde keine Ein- und Ausgaben, die nicht durch Exporte, Strings oder einen Lauf belegt sind.",
      ],
    };
  }
  return {
    paths:
      "`BLUEPRINT.md`, `blueprint.json`, `source/`, `surface/` und `evidence/`",
    order: "Gerüst, Oberfläche, Routen, Verhalten, Daten, Innenleben, Abgleich",
    rules: [
      "Übernimm sichtbare Texte, Rollen, Routen und Speicher-Schlüssel unverändert, sofern die Blaupause sie nennt.",
      "Übernimm API-Aufrufe und Funktionen mit den belegten Namen, Pfaden und Aufrufbeziehungen.",
      "Erfinde keine fehlenden Fakten; dokumentiere jede Ergänzung als Abweichung.",
    ],
  };
}

export function renderPrompt(compiled) {
  const bp = compiled.blueprint;
  const kind = blueprintKind(bp);
  const guide = agentKindGuide(kind, bp.source_included !== false);
  const counted = `${bp.bundle.files} Dateien, davon ${bp.evidence.length} Beweise`;
  const paths = bp.source_included
    ? guide.paths
    : "`BLUEPRINT.md`, `blueprint.json`, `surface/` und `evidence/`";
  const cliTarget =
    kind === "javascript" &&
    !(bp.surface?.routes || []).length &&
    !bp.surface?.windows &&
    (bp.internals?.semantic_graph?.functions || []).some((item) =>
      /^(main|run|cli)$/i.test(String(item.name || "")),
    );
  return [
    `Du bist ein Coding-Agent und sollst „${bp.target.name}“ anhand einer REA-Blaupause von Anfang bis Ende neu bauen.`,
    "",
    `Lies zuerst \`BLUEPRINT.md\` vollständig und danach \`blueprint.json\` für die maschinenlesbaren Details. Das Paket enthält ${counted} und ${compiled.claims.length} typisierte Behauptungen.`,
    `Arbeite in der Reihenfolge aus Abschnitt 1: ${cliTarget ? "Gerüst, CLI-Einstieg, Funktionen, Datenverträge, Fehlerfälle, Abgleich" : guide.order}.`,
    `Öffne die Dateien unter ${paths}, wenn du eine Aussage prüfen willst.`,
    `Quellcode im Paket: ${bp.source_included ? "ja" : "nein"}.`,
    "Behandle die Lückenliste unten und Abschnitt 9 als Arbeitsliste: Prüfe jeden offenen Punkt, bevor du ihn als erledigt markierst.",
    "",
    "Verbindliche Regeln:",
    "1. Baue positiv herum: erst ein lauffähiges Gerüst, dann die belegten Details.",
    ...[
      ...guide.rules,
      ...(cliTarget
        ? [
            "Dieses Ziel ist ein CLI-Programm: Einstiegspunkt, Befehle, Ausgabeformat und Exit-Codes sind die zu prüfende Oberfläche.",
          ]
        : []),
      "Trenne belegte Beobachtungen von deinen Ergänzungen und dokumentiere jede Abweichung.",
      "Wenn eine Angabe fehlt, triff eine begründete Annahme, dokumentiere sie und prüfe sie; frage nicht nach, solange die Blaupause oder ein Test die Antwort liefern kann.",
      "Prüfe am Ende die Abnahmekriterien aus Abschnitt 8 und berichte ehrlich, was nicht verifiziert werden konnte.",
    ].map((rule, index) => `${index + 2}. ${rule}`),
    "",
    "## Vollständigkeitsprüfung und Lücken",
    `Status: ${bp.completeness?.status || "nicht geprüft"} (${bp.completeness?.score ?? 0} %; ${bp.completeness?.passed ?? 0} von ${bp.completeness?.checks?.length ?? 0} Pflichtprüfungen erfüllt).`,
    "Jede Lücke ist eine auszuführende Aufgabe, keine Rückfrage. Schließe sie mit einem Test, einer Beobachtung oder einer ausdrücklich dokumentierten Annahme und lege den Beleg im Ergebnis ab.",
    ...(bp.completeness?.gaps?.length
      ? bp.completeness.gaps.map(
          (gap) => `- **${gap.id} ${gap.label}:** ${gap.why} → ${gap.action}`,
        )
      : ["- Keine Lücken im Rahmen der automatischen Prüfung."]),
    "",
    `Zieltyp: ${kind}${kind !== bp.target.kind ? ` (${bp.target.kind})` : ""}`,
    `Quelle: ${bp.target.input}`,
    `Offene Punkte: ${bp.open_questions.length}`,
  ].join("\n");
}
