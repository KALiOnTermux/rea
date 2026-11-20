import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { inflateRawSync } from "node:zlib";
import { analysisDigest, toAnalysis } from "./blueprint/analysis.mjs";
import { COMPILER_ID, compile } from "./blueprint/compile.mjs";
import { BlueprintGateError, gate } from "./blueprint/gate.mjs";
import { buildManifest } from "./blueprint/manifest.mjs";
import {
  blueprintKind,
  renderMarkdown,
  renderPrompt,
} from "./blueprint/render.mjs";
import { Bundle, hashFile, sha256 } from "./blueprint-zip.mjs";

const MAX_TEXT = 4000;

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function normalizeRecord(value) {
  const object = asObject(value);
  if (!object) return null;
  if (object.normalized_result) return asObject(object.normalized_result);
  if (Array.isArray(object.records) && object.records[0]) {
    return asObject(object.records[0].normalized_result);
  }
  if (object.summary?.normalized_result) {
    return asObject(object.summary.normalized_result);
  }
  return object;
}

function parseJson(text) {
  try {
    return JSON.parse(String(text || "").trim());
  } catch {
    return null;
  }
}

async function readJson(path) {
  try {
    return parseJson(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

function countBy(items, select) {
  const counts = new Map();
  for (const item of items) {
    const key = select(item);
    if (key === undefined || key === null || key === "") continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts]
    .sort(
      (left, right) =>
        right[1] - left[1] || String(left[0]).localeCompare(String(right[0])),
    )
    .map(([name, count]) => ({ name, count }));
}

function text(value, limit = MAX_TEXT) {
  const normalized = String(value ?? "")
    .replace(/\u0000/g, "")
    .replace(/\r\n/g, "\n")
    .trim();
  return normalized.length > limit
    ? `${normalized.slice(0, limit)}…`
    : normalized;
}

function slug(value) {
  return (
    String(value || "ziel")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "ziel"
  );
}

function stripTags(value) {
  return String(value || "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function attributes(source) {
  const result = {};
  const pattern =
    /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let match;
  while ((match = pattern.exec(source))) {
    result[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return result;
}

function uniqueItems(items, select, limit = 80) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = select(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
    if (result.length >= limit) break;
  }
  return result;
}

function summarizeHtml(html) {
  const source = String(html || "");
  const title = stripTags(
    /<title[^>]*>([\s\S]*?)<\/title>/i.exec(source)?.[1] || "",
  );
  const lang =
    attributes(/<html\b([^>]*)>/i.exec(source)?.[1] || "").lang || "";
  const description =
    attributes(
      /<meta\b[^>]*name=["']description["'][^>]*>/i.exec(source)?.[0] || "",
    ).content || "";
  const headings = [...source.matchAll(/<h([1-4])\b[^>]*>([\s\S]*?)<\/h\1>/gi)]
    .map((match) => ({ level: Number(match[1]), text: stripTags(match[2]) }))
    .filter((item) => item.text)
    .slice(0, 80);
  const buttons = [
    ...source.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi),
  ]
    .map((match) => {
      const attrs = attributes(match[1]);
      return {
        label: stripTags(match[2]) || attrs["aria-label"] || "",
        id: attrs.id || null,
        type: attrs.type || null,
        className: attrs.class || null,
      };
    })
    .filter((item) => item.label)
    .slice(0, 120);
  const links = [...source.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)]
    .map((match) => {
      const attrs = attributes(match[1]);
      return { href: attrs.href || "", label: stripTags(match[2]) };
    })
    .filter((item) => item.href || item.label)
    .slice(0, 200);
  const inputs = [...source.matchAll(/<(input|select|textarea)\b([^>]*)>/gi)]
    .map((match) => {
      const attrs = attributes(match[2]);
      return {
        tag: match[1].toLowerCase(),
        type: attrs.type || null,
        name: attrs.name || null,
        placeholder: attrs.placeholder || null,
        id: attrs.id || null,
      };
    })
    .slice(0, 120);
  const forms = [...source.matchAll(/<form\b([^>]*)>/gi)].map((match) => {
    const attrs = attributes(match[1]);
    return {
      action: attrs.action || "",
      method: (attrs.method || "get").toUpperCase(),
    };
  });
  const images = [...source.matchAll(/<img\b([^>]*)>/gi)]
    .map((match) => {
      const attrs = attributes(match[1]);
      return { src: attrs.src || "", alt: attrs.alt || "" };
    })
    .filter((item) => item.src)
    .slice(0, 120);
  const scripts = uniqueItems(
    [...source.matchAll(/<script\b([^>]*)>/gi)]
      .map((match) => attributes(match[1]).src)
      .filter(Boolean)
      .map((src) => ({ src })),
    (item) => item.src,
    120,
  );
  const stylesheets = uniqueItems(
    [...source.matchAll(/<link\b([^>]*)>/gi)]
      .map((match) => attributes(match[1]))
      .filter((attrs) => /stylesheet/i.test(attrs.rel || "") && attrs.href)
      .map((attrs) => ({ href: attrs.href })),
    (item) => item.href,
    120,
  );
  const landmarks = {};
  for (const tag of [
    "header",
    "nav",
    "main",
    "footer",
    "aside",
    "section",
    "article",
    "form",
    "dialog",
  ]) {
    landmarks[tag] = (
      source.match(new RegExp(`<${tag}\\b`, "gi")) || []
    ).length;
  }
  const tagCounts = countBy(
    [...source.matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)\b/g)].map((match) =>
      match[1].toLowerCase(),
    ),
    (tag) => tag,
  ).slice(0, 40);
  return {
    title,
    lang,
    description,
    headings,
    buttons,
    links,
    inputs,
    forms,
    images,
    scripts,
    stylesheets,
    landmarks,
    tag_counts: tagCounts,
    text_excerpt: stripTags(
      source.replace(/<head\b[\s\S]*?<\/head>/gi, " ").slice(0, 40000),
    ).slice(0, 2500),
  };
}

function decodeCapturedBody(body) {
  if (!body || body.state !== "captured" || !body.content) return null;
  try {
    return body.encoding === "base64"
      ? Buffer.from(body.content, "base64").toString("utf8")
      : String(body.content);
  } catch {
    return null;
  }
}

function capturedHeaders(event) {
  const items = event?.headers?.items;
  if (!Array.isArray(items)) return {};
  const headers = {};
  for (const item of items) {
    if (!item?.name || item.redacted) continue;
    headers[String(item.name).toLowerCase()] = String(item.value ?? "");
  }
  return headers;
}

function parseBodyJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function jsonShape(value, depth = 0) {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return value.length > 0 && depth < 3
      ? [jsonShape(value[0], depth + 1)]
      : ["unknown"];
  }
  if (typeof value === "object") {
    if (depth >= 4) return "object";
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 30)
        .map(([key, entry]) => [key, jsonShape(entry, depth + 1)]),
    );
  }
  return typeof value;
}

function captureTextAssets(events) {
  const requests = new Map();
  for (const event of events) {
    if (event.kind !== "request") continue;
    requests.set(String(event.transaction_id), {
      url: event.url?.url || null,
      resourceType: event.resource_type || null,
    });
  }
  const assets = [];
  const seen = new Set();
  for (const event of events) {
    if (event.kind !== "network-content" || event.phase !== "response") {
      continue;
    }
    const request = requests.get(String(event.transaction_id));
    if (!request?.url || seen.has(request.url)) continue;
    const headers = capturedHeaders(event);
    const contentType = headers["content-type"] || "";
    if (
      !/(?:text\/css|text\/html|application\/xhtml\+xml)/i.test(contentType)
    ) {
      continue;
    }
    const body = decodeCapturedBody(event.body);
    if (!body || body.length > 2_000_000) continue;
    const extension = /css/i.test(contentType) ? "css" : "html";
    seen.add(request.url);
    assets.push({ url: request.url, contentType, extension, body });
    if (assets.length >= 20) break;
  }
  return assets;
}

function requestContracts(requests) {
  return requests
    .map((request) => {
      const responseJson = parseBodyJson(request.response_body);
      const requestJson = parseBodyJson(request.request_body);
      const contentType =
        request.response_headers?.["content-type"] ||
        request.request_headers?.["content-type"] ||
        null;
      if (!requestJson && !responseJson && !/json/i.test(contentType || "")) {
        return null;
      }
      return {
        method: request.method,
        url: request.url,
        status: request.status,
        content_type: contentType,
        request_shape: requestJson ? jsonShape(requestJson) : null,
        response_shape: responseJson ? jsonShape(responseJson) : null,
        request_sample: requestJson
          ? JSON.stringify(requestJson).slice(0, 1200)
          : null,
        response_sample: responseJson
          ? JSON.stringify(responseJson).slice(0, 1200)
          : null,
        source_pointer:
          request.response_event_index === null
            ? request.capture_pointer
            : `/normalized_result/events/items/${request.response_event_index}`,
      };
    })
    .filter(Boolean)
    .slice(0, 40);
}

function networkFromEvents(events) {
  const transactions = new Map();
  events.forEach((event, index) => {
    if (!event?.transaction_id) return;
    let entry = transactions.get(event.transaction_id);
    if (!entry) {
      entry = {
        method: null,
        url: "",
        status: null,
        failed: false,
        resource_type: null,
        origin: null,
        sequence: null,
        request_body: null,
        response_body: null,
        request_headers: {},
        response_headers: {},
        request_event_index: null,
        response_event_index: null,
      };
      transactions.set(event.transaction_id, entry);
    }
    if (event.kind === "request") {
      if (entry.request_event_index === null) entry.request_event_index = index;
      entry.method = event.method || entry.method;
      entry.url = event.url?.url || entry.url;
      entry.origin = event.url?.origin || entry.origin;
      entry.resource_type = event.resource_type || entry.resource_type;
      entry.sequence = Number.isInteger(event.sequence)
        ? event.sequence
        : entry.sequence;
      entry.request_body = decodeCapturedBody(event.body) || entry.request_body;
      entry.request_headers = capturedHeaders(event);
    }
    if (event.kind === "response") {
      if (entry.response_event_index === null)
        entry.response_event_index = index;
      entry.status = Number.isInteger(event.status)
        ? event.status
        : entry.status;
      entry.url = event.url?.url || entry.url;
      entry.origin = event.url?.origin || entry.origin;
      entry.resource_type = event.resource_type || entry.resource_type;
      entry.response_body =
        decodeCapturedBody(event.body) || entry.response_body;
      entry.response_headers = capturedHeaders(event);
    }
    if (event.kind === "network-content") {
      if (event.phase === "request") {
        entry.request_body =
          decodeCapturedBody(event.body) || entry.request_body;
        entry.request_headers = {
          ...entry.request_headers,
          ...capturedHeaders(event),
        };
      } else if (event.phase === "response") {
        entry.response_body =
          decodeCapturedBody(event.body) || entry.response_body;
        entry.response_headers = {
          ...entry.response_headers,
          ...capturedHeaders(event),
        };
      }
    }
    if (event.kind === "request-failed") entry.failed = true;
  });
  const requests = [...transactions.values()]
    .filter((entry) => entry.url)
    .sort(
      (left, right) =>
        (left.sequence ?? Infinity) - (right.sequence ?? Infinity),
    );
  const endpoints = countBy(
    requests.map((entry) => {
      let path = "/";
      try {
        path = new URL(entry.url).pathname;
      } catch {
        // Keep the fallback path.
      }
      return `${entry.method || "?"} ${entry.origin || ""}${path}`;
    }),
    (item) => item,
  ).slice(0, 120);
  return {
    transactions: requests.length,
    failed: requests.filter((entry) => entry.failed).length,
    by_origin: countBy(
      requests.map((entry) => entry.origin || "unbekannt"),
      (item) => item,
    ),
    by_resource_type: countBy(
      requests.map((entry) => entry.resource_type || "unbekannt"),
      (item) => item,
    ),
    endpoints,
    contracts: requestContracts(requests),
    requests: requests.map((entry) => ({
      method: entry.method || "?",
      url: entry.url,
      status: entry.status,
      failed: entry.failed,
      resource_type: entry.resource_type,
      capture_pointer:
        entry.request_event_index === null
          ? null
          : `/normalized_result/events/items/${entry.request_event_index}`,
    })),
  };
}

const SOURCE_FILE_PATTERN = /\.(?:m?js|cjs|jsx|ts|tsx|mts|cts)$/i;
const SOURCE_KEYWORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "function",
  "return",
  "typeof",
  "new",
  "await",
  "yield",
  "import",
  "export",
  "class",
  "super",
  "throw",
  "else",
  "do",
  "try",
  "finally",
  "with",
]);

function sourceLines(source) {
  return String(source || "").split(/\r?\n/);
}

function lineAtOffset(starts, offset) {
  let low = 0;
  let high = starts.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (starts[middle] <= offset) low = middle + 1;
    else high = middle - 1;
  }
  return Math.max(1, high + 1);
}

function sourceOffsets(source) {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

function functionAt(lines, lineIndex) {
  const start = Math.max(0, lineIndex - 100);
  for (let index = lineIndex; index >= start; index -= 1) {
    const line = lines[index];
    let match = line.match(
      /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/,
    );
    if (match) return { name: match[1], signature: `(${match[2].trim()})` };
    match = line.match(
      /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(([^)]*)\)|([A-Za-z_$][\w$]*))\s*=>/,
    );
    if (match) {
      return {
        name: match[1],
        signature: `(${(match[2] || match[3] || "").trim()})`,
      };
    }
    match = line.match(
      /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?function\s*\(([^)]*)\)/,
    );
    if (match) return { name: match[1], signature: `(${match[2].trim()})` };
    match = line.match(/createServer\s*\(\s*(?:async\s*)?\(([^)]*)\)\s*=>/);
    if (match)
      return {
        name: "createServer handler",
        signature: `(${match[1].trim()})`,
      };
  }
  return null;
}

function methodNear(lines, index) {
  const candidates = [];
  for (
    let cursor = Math.max(0, index - 2);
    cursor <= Math.min(lines.length - 1, index + 6);
    cursor += 1
  ) {
    const line = lines[cursor];
    const match =
      line.match(/\.method\s*===\s*["']([A-Z]+)["']/) ||
      line.match(/method\s*:\s*["']([A-Z]+)["']/);
    if (match) candidates.push(match[1].toUpperCase());
  }
  return candidates[0] || "ANY";
}

function routeFromFile(rel) {
  const normalized = rel.replaceAll("\\", "/");
  const app = normalized.match(
    /(?:^|\/)app\/(.+)\/route\.(?:m?js|cjs|jsx|ts|tsx)$/i,
  );
  if (app) {
    const path = `/${app[1]}`.replace(/\/\([^/]+?\)/g, "/:param");
    return { path, kind: "next-app-route" };
  }
  const pages = normalized.match(
    /(?:^|\/)pages\/(.+)\.(?:m?js|cjs|jsx|ts|tsx)$/i,
  );
  if (pages && !/(?:^|\/)_/.test(pages[1])) {
    const path = `/${pages[1]}`
      .replace(/\/index$/, "")
      .replace(/\/\([^/]+?\)/g, "");
    return { path: path || "/", kind: "next-pages-api" };
  }
  return null;
}

function extractSourceRoutes(rel, source) {
  const lines = sourceLines(source);
  const routes = [];
  const seen = new Set();
  const push = (method, path, kind, line, handler, signature) => {
    if (!path || !path.startsWith("/")) return;
    const key = `${method} ${path} ${rel}`;
    if (seen.has(key)) return;
    seen.add(key);
    routes.push({
      method,
      path,
      kind,
      file: rel,
      line,
      handler: handler || null,
      signature: signature || null,
    });
  };
  const fileRoute = routeFromFile(rel);
  const fileMethods = new Set();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNumber = index + 1;
    if (fileRoute) {
      const methodMatch = line.match(
        /export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/,
      );
      if (methodMatch && !fileMethods.has(methodMatch[1])) {
        fileMethods.add(methodMatch[1]);
        const context = functionAt(lines, index);
        push(
          methodMatch[1],
          fileRoute.path,
          fileRoute.kind,
          lineNumber,
          context?.name || methodMatch[1],
          context?.signature || null,
        );
      }
    }
    const express = line.match(
      /\.\s*(get|post|put|patch|delete|all)\s*\(\s*["'`]([^"'`]+)["'`]/i,
    );
    if (express) {
      const method = express[1].toUpperCase();
      const path = express[2];
      const after = line.slice((express.index || 0) + express[0].length);
      const handlerMatch = after.match(/^\s*,\s*([A-Za-z_$][\w$]*)/);
      const context = functionAt(lines, index);
      push(
        method,
        path,
        "express-route",
        lineNumber,
        handlerMatch?.[1] || context?.name || null,
        context?.signature || null,
      );
    }
    const exact = line.match(
      /(?:path|pathname|url\.pathname|req\.url)\s*===\s*["'`]([^"'`]+)["'`]/,
    );
    if (exact) {
      const context = functionAt(lines, index);
      push(
        methodNear(lines, index),
        exact[1],
        "node-route",
        lineNumber,
        context?.name || null,
        context?.signature || null,
      );
    }
    const regexRoute = line.match(/=\s*(\/\^[^\n]*?\/[a-z]*)\.exec\s*\(/);
    if (regexRoute) {
      const raw = regexRoute[1];
      const bodyStart = raw.indexOf("^");
      const bodyEnd = raw.lastIndexOf("$");
      if (bodyStart >= 0 && bodyEnd > bodyStart) {
        const body = raw.slice(bodyStart, bodyEnd + 1);
        const context = functionAt(lines, index);
        const before = routes.length;
        push(
          methodNear(lines, index),
          body.replace(/^\^/, "").replace(/\$$/, "").replace(/\\\//g, "/"),
          "regex-route",
          lineNumber,
          context?.name || null,
          context?.signature || null,
        );
        if (routes.length > before) routes.at(-1).regex = body;
      }
    }
    const prefix = line.match(
      /(?:path|pathname|url\.pathname)\s*\.startsWith\s*\(\s*["'`]([^"'`]+)["'`]/,
    );
    if (prefix) {
      const context = functionAt(lines, index);
      push(
        "ANY",
        `${prefix[1]}*`,
        "prefix-route",
        lineNumber,
        context?.name || null,
        context?.signature || null,
      );
    }
  }
  return routes;
}

function extractSourceFunctions(rel, source) {
  const lines = sourceLines(source);
  const functions = [];
  const seen = new Set();
  const push = (name, params, line, async = false) => {
    if (!name || seen.has(`${name}:${line}`)) return;
    seen.add(`${name}:${line}`);
    functions.push({
      name,
      signature: `(${String(params || "").trim()})`,
      file: rel,
      line,
      async,
    });
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNumber = index + 1;
    let match = line.match(
      /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/,
    );
    if (match) {
      push(match[1], match[2], lineNumber, /async\s+function/.test(line));
      continue;
    }
    match = line.match(
      /(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(([^)]*)\)|([A-Za-z_$][\w$]*))\s*=>/,
    );
    if (match) {
      push(match[1], match[2] || match[3], lineNumber, /=\s*async/.test(line));
    }
  }
  return functions;
}

function extractSourceCalls(rel, source) {
  const lines = sourceLines(source);
  const calls = [];
  const seen = new Set();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const context = functionAt(lines, index);
    const regex = /(?<!\.)\b([A-Za-z_$][\w$]*)\s*\(/g;
    let match;
    while ((match = regex.exec(line))) {
      const name = match[1];
      if (SOURCE_KEYWORDS.has(name) || name.length < 2) continue;
      const key = `${rel}:${index + 1}:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      calls.push({
        name,
        file: rel,
        line: index + 1,
        function: context?.name || null,
      });
      if (calls.length >= 1200) return calls;
    }
  }
  return calls;
}

function extractSourceErrors(rel, source) {
  const lines = sourceLines(source);
  const starts = sourceOffsets(source);
  const errors = [];
  const seen = new Set();
  const add = (kind, status, message, offset, expression) => {
    const line = lineAtOffset(starts, offset);
    const clean = text(message || expression, 300);
    if (!clean) return;
    const key = `${kind}:${status}:${line}:${clean}`;
    if (seen.has(key)) return;
    seen.add(key);
    errors.push({
      kind,
      status: status || null,
      message: clean,
      file: rel,
      line,
      function: functionAt(lines, line - 1)?.name || null,
    });
  };
  for (const match of source.matchAll(
    /json\s*\(\s*[^,]+,\s*(\d{3})\s*,\s*\{([\s\S]{0,500}?)\}\s*\)/g,
  )) {
    const body = match[2];
    const status = Number(match[1]);
    if (status < 400) continue;
    const message = body.match(/error\s*:\s*["'`]([^"'`]+)["'`]/)?.[1];
    const expression = body.match(/error\s*:\s*([^,}\n]+)/)?.[1];
    add("http", status, message, match.index || 0, expression);
  }
  for (const match of source.matchAll(
    /\.status\s*\(\s*(\d{3})\s*\)\s*\.\s*(?:json|send)\s*\(\s*\{([\s\S]{0,500}?)\}\s*\)/g,
  )) {
    const body = match[2];
    const status = Number(match[1]);
    if (status >= 400) {
      add(
        "http",
        status,
        body.match(/error\s*:\s*["'`]([^"'`]+)["'`]/)?.[1],
        match.index || 0,
        body.match(/error\s*:\s*([^,}\n]+)/)?.[1],
      );
    }
  }
  for (const match of source.matchAll(
    /writeHead\s*\(\s*(\d{3})\s*(?:,\s*\{([\s\S]{0,300}?)\})?/g,
  )) {
    const status = Number(match[1]);
    if (status >= 400)
      add("http", status, `HTTP ${status}`, match.index || 0, "writeHead");
  }
  for (const match of source.matchAll(
    /throw\s+new\s+((?:[A-Za-z_$][\w$]*)?Error)\s*\(\s*["'`]([^"'`]+)["'`]/g,
  )) {
    add("throw", null, match[2], match.index || 0, match[1]);
  }
  for (const match of source.matchAll(
    /throw\s+new\s+(?:[A-Za-z_$][\w$]*)?Error\s*\(\s*`([^`]+)`/g,
  )) {
    add("throw", null, match[1], match.index || 0, "template");
  }
  return errors;
}

function extractSourceExitPaths(rel, source) {
  const lines = sourceLines(source);
  const starts = sourceOffsets(source);
  const exits = [];
  const seen = new Set();
  const add = (kind, value, offset, knownLine = null) => {
    const line = knownLine || lineAtOffset(starts, offset);
    const key = `${kind}:${value}:${line}`;
    if (seen.has(key)) return;
    seen.add(key);
    exits.push({ kind, value, file: rel, line });
  };
  for (const match of source.matchAll(/process\.exitCode\s*=\s*([^;\n]+)/g)) {
    add("process.exitCode", match[1].trim().slice(0, 120), match.index || 0);
  }
  for (const match of source.matchAll(/process\.exit\s*\(\s*([^)\n]+)\)/g)) {
    add("process.exit", match[1].trim().slice(0, 120), match.index || 0);
  }
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/\breturn\s+([1-9]\d*)\s*;/);
    if (match) add("return", Number(match[1]), 0, index + 1);
  }
  return exits;
}

function domEventBindings(html) {
  const events = [];
  const seen = new Set();
  if (!html) return events;
  for (const match of String(html).matchAll(/<([a-z][\w-]*)(\s[^>]*?)?>/gi)) {
    const tag = match[1].toLowerCase();
    const attrs = match[2] || "";
    const id = attrs.match(/\bid\s*=\s*["']([^"']+)["']/i)?.[1];
    for (const binding of attrs.matchAll(
      /\b(on[a-z]+)\s*=\s*["']([^"']*)["']/gi,
    )) {
      const key = `${binding[1]}:${id || tag}:${binding[2]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      events.push({
        event: binding[1].toLowerCase().replace(/^on/, ""),
        selector: id ? `#${id}` : tag,
        handler: text(binding[2], 160),
        source: "dom",
        file: null,
        line: null,
      });
    }
  }
  return events;
}

function extractSourceEvents(rel, source) {
  const lines = sourceLines(source);
  const events = [];
  const seen = new Set();
  const add = (event, selector, handler, line) => {
    if (!event) return;
    const key = `${event}:${selector}:${line}`;
    if (seen.has(key)) return;
    seen.add(key);
    events.push({
      event,
      selector: selector || "unbekannt",
      handler: handler || "inline",
      source: "static",
      file: rel,
      line,
    });
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line.match(
      /([A-Za-z_$][\w$]*(?:\([^;\n]*?\))?)\.addEventListener\s*\(\s*["'`]([^"'`]+)["'`]/,
    );
    if (match) {
      const target = match[1];
      const selector =
        target.match(
          /(?:query|querySelector|\$)\(\s*["'`]([^"'`]+)["'`]/,
        )?.[1] || target;
      const handler =
        line.match(
          /,\s*(?:async\s*)?(?:function\s+)?([A-Za-z_$][\w$]*)/,
        )?.[1] || "inline";
      add(match[2], selector, handler, index + 1);
    }
    for (const binding of line.matchAll(
      /(?:onclick|onsubmit|onchange|oninput)\s*=\s*["']([^"']+)["']/g,
    )) {
      add(
        binding[0].split(/\s*=/)[0],
        "inline-Attribut",
        binding[1].slice(0, 160),
        index + 1,
      );
    }
  }
  return events;
}

async function analyzeProjectSource(root, options = {}) {
  const empty = {
    root,
    files: [],
    functions: [],
    routes: [],
    calls: [],
    errors: [],
    exit_paths: [],
    events: [],
    coverage: {
      files_scanned: 0,
      bytes_scanned: 0,
      files_skipped: 0,
      truncated: false,
    },
  };
  if (!root || !existsSync(root)) return empty;
  const info = await stat(root);
  if (!info.isDirectory() && !info.isFile()) return empty;
  const maxFiles = options.maxFiles ?? 1500;
  const maxFileBytes = options.maxFileBytes ?? 512 * 1024;
  const maxTotalBytes = options.maxTotalBytes ?? 16 * 1024 * 1024;
  const relPaths = info.isDirectory()
    ? await listFiles(root, (path) => SOURCE_FILE_PATTERN.test(path), maxFiles)
    : [basename(root)];
  const files = [];
  const functions = [];
  const routes = [];
  const calls = [];
  const errors = [];
  const exitPaths = [];
  const events = [];
  let bytesScanned = 0;
  let skipped = 0;
  let truncated = false;
  for (const rel of relPaths) {
    if (files.length >= maxFiles || bytesScanned >= maxTotalBytes) {
      truncated = true;
      break;
    }
    const full = info.isDirectory() ? join(root, rel) : root;
    let fileInfo;
    try {
      fileInfo = await stat(full);
    } catch {
      skipped += 1;
      continue;
    }
    if (!fileInfo.isFile() || fileInfo.size > maxFileBytes) {
      skipped += 1;
      continue;
    }
    let source;
    try {
      source = await readFile(full, "utf8");
    } catch {
      skipped += 1;
      continue;
    }
    bytesScanned += Buffer.byteLength(source);
    files.push({ path: rel, bytes: Buffer.byteLength(source) });
    functions.push(...extractSourceFunctions(rel, source));
    routes.push(...extractSourceRoutes(rel, source));
    calls.push(...extractSourceCalls(rel, source));
    errors.push(...extractSourceErrors(rel, source));
    exitPaths.push(...extractSourceExitPaths(rel, source));
    events.push(...extractSourceEvents(rel, source));
  }
  const routesByFile = new Map();
  for (const route of routes) {
    const list = routesByFile.get(route.file) || [];
    list.push(route);
    routesByFile.set(route.file, list);
  }
  for (const list of routesByFile.values())
    list.sort((left, right) => left.line - right.line);
  for (const error of errors) {
    const list = routesByFile.get(error.file) || [];
    let owner = null;
    for (const route of list) {
      if (route.line <= error.line) owner = route;
      else break;
    }
    if (owner) {
      owner.errors = owner.errors || [];
      owner.errors.push(error);
    }
  }
  return {
    root,
    files,
    functions: functions.slice(0, 1200),
    routes: routes.slice(0, 500),
    calls: calls.slice(0, 1200),
    errors: errors.slice(0, 500),
    exit_paths: exitPaths.slice(0, 300),
    events: events.slice(0, 300),
    coverage: {
      files_scanned: files.length,
      bytes_scanned: bytesScanned,
      files_skipped: skipped,
      truncated,
    },
  };
}

function resourceValues(strings) {
  const values = new Map();
  for (const item of Array.isArray(strings) ? strings : []) {
    const name = String(item?.name || "").trim();
    const value = text(item?.value, 500);
    if (name && value && !values.has(name)) values.set(name, value);
  }
  return values;
}

function quotedFragments(value) {
  const fragments = [];
  for (const match of String(value || "").matchAll(/"((?:\\.|[^"\\])*)"/g)) {
    let fragment = match[1];
    try {
      fragment = JSON.parse(`"${fragment}"`);
    } catch {
      fragment = fragment.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
    if (fragment.trim()) fragments.push(text(fragment, 500));
  }
  return [...new Set(fragments)];
}

function androidMessages(value, strings) {
  const messages = quotedFragments(value);
  for (const match of String(value || "").matchAll(
    /R\.string\.([A-Za-z0-9_]+)/g,
  )) {
    const resolved = strings.get(match[1]);
    if (resolved) messages.push(resolved);
  }
  return [...new Set(messages)];
}

function androidContext(lines, index) {
  let className = null;
  let method = null;
  for (let cursor = index; cursor >= Math.max(0, index - 220); cursor -= 1) {
    const line = lines[cursor];
    if (!className) {
      const classMatch = line.match(
        /\b(?:class|interface|enum)\s+([A-Za-z_$][\w$]*)/,
      );
      if (classMatch) className = classMatch[1];
    }
    if (!method) {
      const methodMatch = line.match(
        /\b(?:public|protected|private|static|final|abstract|synchronized|native)\s+[\w.$<>[\], ?]+\s+([A-Za-z_$][\w$]*)\s*\([^;]*\)\s*\{?/,
      );
      if (
        methodMatch &&
        !/^(if|for|while|switch|catch)$/.test(methodMatch[1])
      ) {
        method = methodMatch[1];
      }
    }
    if (className && method) break;
  }
  return { class: className, method };
}

function smaliClassFromPath(value) {
  const parts = String(value || "").split("/");
  const index = parts.findIndex((part) => /^smali(?:_classes\d+)?$/.test(part));
  if (index < 0) return null;
  return parts
    .slice(index + 1)
    .join("/")
    .replace(/\.smali$/i, "");
}

function androidStatus(value) {
  const status = String(value || "").match(
    /HTTP_[A-Z_]+|SC_[A-Z_]+|\b([1-5][0-9]{2})\b/,
  );
  return status ? status[0] : null;
}

async function analyzeAndroidSource(sourceRoot, options = {}) {
  const result = {
    source_root: options.sourcePrefix || sourceRoot,
    package_name: options.packageName || null,
    files: 0,
    app_files: 0,
    bytes: 0,
    error_paths: [],
    screens: { activities: 0, layouts: [], navigation_calls: 0, fragments: 0 },
    data_flow: { urls: [], servers: [], databases: [], storage: [] },
    decompiler: {
      reported_errors: Number(options.jadxErrors) || 0,
      error_files: [],
      missing_smali: [],
      app_error_files: 0,
      smali_files: Number(options.smaliFiles) || 0,
      smali_classes: Number(options.smaliClasses) || 0,
    },
  };
  if (!sourceRoot || !existsSync(sourceRoot)) return result;
  const rootInfo = await stat(sourceRoot);
  if (!rootInfo.isDirectory()) return result;
  const appPrefix = options.packageName
    ? `${String(options.packageName).replaceAll(".", "/")}/`
    : null;
  const paths = await listFiles(
    sourceRoot,
    (path) => path.endsWith(".java"),
    options.maxFiles || 6000,
  );
  const strings = resourceValues(options.strings || []);
  const smali = options.smaliClasses || new Set();
  const seenErrors = new Set();
  const seenScreens = new Set();
  for (const rel of paths) {
    const full = join(sourceRoot, rel);
    let source;
    try {
      const info = await stat(full);
      if (!info.isFile() || info.size > 2 * 1024 * 1024) continue;
      source = await readFile(full, "utf8");
    } catch {
      continue;
    }
    result.files += 1;
    result.bytes += Buffer.byteLength(source);
    const isApp = appPrefix ? rel.startsWith(appPrefix) : true;
    if (isApp) result.app_files += 1;
    if (source.includes("JADX ERROR")) {
      const types = [
        ...new Set(
          [...source.matchAll(/JADX ERROR:\s*([^\n]+)/g)].map((match) =>
            text(match[1], 240),
          ),
        ),
      ];
      const classPath = rel.replace(/\.java$/i, "");
      result.decompiler.error_files.push({
        source: `${options.sourcePrefix || "source/java"}/${rel}`,
        class_path: classPath,
        types,
        smali_evidence: smali.has(classPath) ? `${classPath}.smali` : null,
      });
      if (isApp) result.decompiler.app_error_files += 1;
    }
    if (!isApp) continue;
    const lines = sourceLines(source);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const lineNumber = index + 1;
      const sourceRef = `${options.sourcePrefix || "source/java"}/${rel}:${lineNumber}`;
      const context = androidContext(lines, index);
      let error = null;
      let throwMatch = line.match(/throw\s+new\s+([\w.$<>]+)\s*\(([^;]*)/);
      if (throwMatch) {
        error = {
          kind: "throw",
          exception: throwMatch[1],
          messages: androidMessages(throwMatch[2], strings),
        };
      }
      if (!error) {
        const catchMatch = line.match(/catch\s*\(\s*([\w.$<>]+)/);
        if (catchMatch) {
          error = { kind: "catch", exception: catchMatch[1], messages: [] };
        }
      }
      if (!error) {
        const logMatch = line.match(/Log\.(e|wtf)\s*\(([^;]*)/);
        if (logMatch) {
          error = {
            kind: "log-error",
            exception: null,
            messages: androidMessages(logMatch[2], strings),
          };
        }
      }
      if (!error) {
        const toastMatch = line.match(/Toast\.makeText\s*\(([^;]*)/);
        if (toastMatch) {
          error = {
            kind: "toast",
            exception: null,
            messages: androidMessages(toastMatch[1], strings),
          };
        }
      }
      if (!error) {
        const uiMatch = line.match(/\.(?:setError|setMessage)\s*\(([^;]*)/);
        if (uiMatch) {
          error = {
            kind: "ui-error",
            exception: null,
            messages: androidMessages(uiMatch[1], strings),
          };
        }
      }
      if (
        !error &&
        /getResponseCode\s*\(|setResponseCode\s*\(|isSuccessful\s*\(|HttpURLConnection|OkHttpClient/.test(
          line,
        )
      ) {
        error = {
          kind: "http-status",
          exception: null,
          messages: androidMessages(line, strings),
          status: androidStatus(line),
        };
      }
      if (
        !error &&
        /SecurityException|ActivityNotFoundException|checkPermission\s*\(|PermissionDenied/.test(
          line,
        )
      ) {
        error = {
          kind: "permission-or-intent",
          exception:
            (line.match(/SecurityException|ActivityNotFoundException/) ||
              [])[0] || null,
          messages: androidMessages(line, strings),
        };
      }
      if (error) {
        const key = `${sourceRef}|${error.kind}|${error.exception || ""}|${error.messages.join("|")}`;
        if (!seenErrors.has(key) && result.error_paths.length < 1200) {
          seenErrors.add(key);
          result.error_paths.push({
            ...error,
            source: sourceRef,
            line: lineNumber,
            class: context.class,
            method: context.method,
          });
        }
      }
      const layoutMatch = line.match(/R\.layout\.([A-Za-z0-9_]+)/g) || [];
      for (const layout of layoutMatch) {
        const name = layout.replace("R.layout.", "");
        if (!seenScreens.has(`layout:${name}`)) {
          seenScreens.add(`layout:${name}`);
          result.screens.layouts.push(name);
        }
      }
      if (/startActivity(?:ForResult)?\s*\(/.test(line))
        result.screens.navigation_calls += 1;
      if (
        /FragmentTransaction|beginTransaction\s*\(|add\s*\(\s*R\.id\./.test(
          line,
        )
      ) {
        result.screens.fragments += 1;
      }
      for (const match of line.matchAll(/https?:\/\/([^\s"'<>)]+)/g)) {
        const url = `https://${match[1]}`.replace(/[\\),.;]+$/g, "");
        if (/schemas\.android\.com|apache\.org|w3\.org|xmlpull\.org/i.test(url))
          continue;
        if (
          !result.data_flow.urls.includes(url) &&
          result.data_flow.urls.length < 80
        ) {
          result.data_flow.urls.push(url);
        }
      }
      if (/HttpURLConnection|OkHttpClient|Retrofit|URLConnection/.test(line)) {
        result.data_flow.servers.push({
          source: sourceRef,
          line: text(line, 240),
        });
      }
      if (
        /SQLiteOpenHelper|SQLiteDatabase|openOrCreateDatabase|RoomDatabase|getWritableDatabase|getReadableDatabase/.test(
          line,
        )
      ) {
        result.data_flow.databases.push({
          source: sourceRef,
          line: text(line, 240),
        });
      }
      if (
        /SharedPreferences|FileOutputStream|openFileOutput|getCacheDir|getFilesDir|ContentValues\s*\(|ContentResolver/.test(
          line,
        )
      ) {
        result.data_flow.storage.push({
          source: sourceRef,
          line: text(line, 240),
        });
      }
    }
  }
  result.screens.activities = Number(options.activityCount) || 0;
  result.error_paths = result.error_paths.slice(0, 500);
  result.screens.layouts = result.screens.layouts.slice(0, 200);
  result.data_flow.urls = result.data_flow.urls.slice(0, 80);
  result.data_flow.servers = result.data_flow.servers.slice(0, 80);
  result.data_flow.databases = result.data_flow.databases.slice(0, 120);
  result.data_flow.storage = result.data_flow.storage.slice(0, 120);
  result.decompiler.missing_smali = result.decompiler.error_files
    .filter((item) => !item.smali_evidence)
    .map((item) => item.source);
  result.decompiler.error_files = result.decompiler.error_files.slice(0, 200);
  return result;
}

function nativeStringRows(output) {
  const rows = [];
  for (const line of String(output || "").split(/\r?\n/)) {
    const match = line.match(/^\s*([0-9a-fA-F]+)\s+(.+)$/);
    if (!match) continue;
    const value = text(match[2], 500);
    if (!value) continue;
    rows.push({ offset: `0x${match[1].toLowerCase()}`, value });
  }
  return rows;
}

async function analyzeNativeErrorEvidence(ctx, target) {
  const disassembly = await ctx
    .runProcess("objdump", ["-d", "-M", "intel", target], {
      timeoutMs: 180_000,
      maxBytes: 12 * 1024 * 1024,
    })
    .catch((error) => ({ ok: false, stdout: "", stderr: String(error) }));
  const stringsResult = await ctx
    .runProcess("strings", ["-a", "-t", "x", target], {
      timeoutMs: 120_000,
      maxBytes: 12 * 1024 * 1024,
    })
    .catch((error) => ({ ok: false, stdout: "", stderr: String(error) }));
  const sections = await ctx
    .runProcess("readelf", ["-SW", target], {
      timeoutMs: 120_000,
      maxBytes: 4 * 1024 * 1024,
    })
    .catch((error) => ({ ok: false, stdout: "", stderr: String(error) }));
  const errorPaths = [];
  const messages = [];
  const calls = [];
  let currentFunction = null;
  for (const line of String(disassembly.stdout || "").split(/\r?\n/)) {
    const functionMatch = line.match(/^[0-9a-fA-F]+\s+<([^>]+)>:/);
    if (functionMatch) currentFunction = functionMatch[1];
    const callMatch = line.match(
      /^\s*([0-9a-fA-F]+):.*?\bcall\b[^<]*<([^>]+)>/,
    );
    if (!callMatch) continue;
    const targetCall = callMatch[2];
    if (
      !/(?:error|perror|warn|warnx|assert_fail|abort|exit|fprintf|fputs|write)@plt/i.test(
        targetCall,
      )
    ) {
      continue;
    }
    const finding = {
      kind: "call",
      call: targetCall,
      function: currentFunction,
      address: `0x${callMatch[1].toLowerCase()}`,
      source: `objdump -d ${target} @ 0x${callMatch[1].toLowerCase()}`,
    };
    calls.push(finding);
    errorPaths.push(finding);
  }
  const errorPattern =
    /(?:error|cannot|invalid|unrecognized|missing operand|extra operand|usage|try .*--help|write error|read error|failed|no such|permission denied|not found)/i;
  for (const row of nativeStringRows(stringsResult.stdout)) {
    if (!errorPattern.test(row.value)) continue;
    const finding = {
      kind: "rodata-string",
      message: row.value,
      offset: row.offset,
      source: `strings -a -t x ${target} @ ${row.offset}`,
    };
    messages.push(finding);
    errorPaths.push(finding);
  }
  const rodata = String(sections.stdout || "").match(
    /\]\s+\.rodata\s+[^\n]*?\s([0-9a-fA-F]+)\s+[0-9a-fA-F]+\s*$/m,
  );
  const usage = messages.find((item) => /^Usage:/i.test(item.message)) || null;
  const help = messages.find((item) => /--help/i.test(item.message)) || null;
  const exitContract = messages
    .filter((item) =>
      /exit status|if (?:minor|serious)|status [012]/i.test(item.message),
    )
    .slice(0, 20);
  return {
    commands: {
      disassembly: `objdump -d -M intel ${target}`,
      strings: `strings -a -t x ${target}`,
      sections: `readelf -SW ${target}`,
    },
    exit_codes: {
      objdump: disassembly.exitCode ?? null,
      strings: stringsResult.exitCode ?? null,
      readelf: sections.exitCode ?? null,
    },
    disassembly_available: Boolean(
      disassembly.ok && String(disassembly.stdout || "").length > 0,
    ),
    strings_available: Boolean(
      stringsResult.ok && String(stringsResult.stdout || "").length > 0,
    ),
    functions_seen: new Set(calls.map((item) => item.function).filter(Boolean))
      .size,
    calls: calls.slice(0, 200),
    messages: messages.slice(0, 200),
    error_paths: errorPaths.slice(0, 300),
    usage: usage?.message || null,
    help: help?.message || null,
    exit_contract: exitContract,
    rodata_bytes: rodata ? Number.parseInt(rodata[1], 16) : null,
  };
}

function observedApiRequests(network) {
  return (network?.requests || []).filter((request) => {
    if (!request?.url) return false;
    if (request.resource_type === "fetch" || request.resource_type === "xhr")
      return true;
    try {
      return /^\/api(?:\/|$)/.test(new URL(request.url).pathname);
    } catch {
      return false;
    }
  });
}

function pathOf(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return String(url || "").split("?")[0] || "/";
  }
}

function routeMatches(route, method, path) {
  if (route.method !== "ANY" && route.method !== method) return false;
  if (route.regex) {
    try {
      return new RegExp(route.regex).test(path);
    } catch {
      return false;
    }
  }
  if (route.kind === "prefix-route") {
    return path.startsWith(route.path.replace(/\*$/, ""));
  }
  return route.path === path || route.path === path.replace(/\/$/, "");
}

function attachServerEvidence(network, source) {
  if (!source?.routes?.length) return null;
  const observed = observedApiRequests(network).map((request) => {
    const path = pathOf(request.url);
    const route = source.routes.find((candidate) =>
      routeMatches(candidate, request.method, path),
    );
    return {
      method: request.method,
      path,
      status: request.status,
      matched: Boolean(route),
      route: route?.path || null,
      handler: route?.handler || null,
      signature: route?.signature || null,
      file: route?.file || null,
      line: route?.line || null,
      errors: route?.errors || [],
    };
  });
  const matched = observed.filter((entry) => entry.matched).length;
  const unmatched = observed.filter((entry) => !entry.matched);
  for (const contract of network.contracts || []) {
    const path = pathOf(contract.url);
    const route = source.routes.find((candidate) =>
      routeMatches(candidate, contract.method, path),
    );
    if (!route) continue;
    contract.source_route = route.path;
    contract.source_handler = route.handler;
    contract.source_signature = route.signature;
    contract.source_file = route.file;
    contract.source_line = route.line;
    contract.source_errors = (route.errors || []).map((error) => ({
      status: error.status,
      message: error.message,
      line: error.line,
    }));
  }
  return {
    root: source.root,
    coverage: { ...source.coverage, observed: observed.length, matched },
    routes: source.routes,
    functions: source.functions,
    calls: source.calls,
    errors: source.errors,
    events: source.events,
    observed,
    unmatched: unmatched.map((entry) => `${entry.method} ${entry.path}`),
  };
}

function captureArtifacts(capture) {
  if (!capture) return null;
  const steps = Array.isArray(capture.steps) ? capture.steps : [];
  const merged = {};
  for (const step of steps) {
    const artifacts = step?.artifacts;
    if (!artifacts || typeof artifacts !== "object") continue;
    for (const [name, entry] of Object.entries(artifacts)) {
      if (!entry || typeof entry !== "object") continue;
      if (entry.state === "captured" || !merged[name]) merged[name] = entry;
    }
  }
  return Object.keys(merged).length > 0 ? merged : null;
}

function artifactValue(artifacts, name) {
  const entry = artifacts?.[name];
  if (!entry || entry.state !== "captured") return null;
  return entry.value ?? null;
}

function createContext(config) {
  return {
    kind: config.kind,
    input: config.input || {},
    target: String(config.target || ""),
    includeSources: config.includeSources !== false,
    fullSources: config.fullSources === true,
    artifactsDir: config.artifactsDir,
    projectRoot: config.projectRoot,
    runProcess: config.runProcess,
    runRea: config.runRea,
    onProgress: config.onProgress || (() => {}),
    bundle: new Bundle(),
    evidence: [],
    warnings: [],
    openQuestions: [],
    limits: [],
    dir: "",
    id: "",
    generatedAt: new Date().toISOString(),
  };
}

async function addJson(ctx, role, path, name) {
  if (!path || !existsSync(path)) return null;
  const payload = await readJson(path);
  if (payload === null) return null;
  const serialized = JSON.stringify(payload, null, 2);
  ctx.bundle.addData(`evidence/${name}`, serialized);
  const meta = {
    role,
    path: `evidence/${name}`,
    source: path,
    bytes: Buffer.byteLength(serialized),
    sha256: sha256(serialized),
  };
  ctx.evidence.push(meta);
  return { payload, meta };
}

async function addBuffer(ctx, role, name, buffer) {
  if (!buffer) return null;
  ctx.bundle.addData(name, buffer);
  ctx.evidence.push({
    role,
    path: name,
    source: null,
    bytes: buffer.length,
    sha256: sha256(buffer),
  });
  return true;
}

function progress(ctx, stage, label, detail, percent) {
  ctx.onProgress({ stage, label, detail, percent });
}

function openQuestion(ctx, question, why, how, evidence = []) {
  ctx.openQuestions.push({
    id: `O${ctx.openQuestions.length + 1}`,
    question,
    why,
    how,
    evidence,
  });
}

function completenessCheck(id, label, ok, detail, action) {
  return {
    id,
    label,
    ok: Boolean(ok),
    detail: detail || "",
    action: ok ? "" : action || "Beleg ergänzen und die Prüfung wiederholen.",
    evidence: [],
    evidence_resolution: { resolved: 0, total: 0, ok: false, dangling: [] },
  };
}

function evidenceRef(path, options = {}) {
  return { path, ...options };
}

function bundleEntryBuffer(ctx, name) {
  const entry = (ctx.bundle?.entries || []).find((item) => item.name === name);
  if (!entry) return null;
  try {
    return entry.method === 8 ? inflateRawSync(entry.body) : entry.body;
  } catch {
    return null;
  }
}

function jsonPointerValue(value, pointer) {
  if (!pointer || pointer === "/") return value;
  let current = value;
  for (const raw of pointer.split("/").slice(1)) {
    const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (current == null || typeof current !== "object") return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, key)) return undefined;
    current = current[key];
  }
  return current;
}

function resolveEvidenceRef(ref, ctx, virtualFiles = {}) {
  const virtual = virtualFiles[ref.path];
  const buffer =
    virtual != null ? Buffer.from(virtual) : bundleEntryBuffer(ctx, ref.path);
  if (!buffer || buffer.length === 0) {
    return { ref, ok: false, reason: `Datei fehlt oder ist leer: ${ref.path}` };
  }
  if (ref.pointer) {
    let parsed;
    try {
      parsed = JSON.parse(buffer.toString("utf8"));
    } catch {
      return { ref, ok: false, reason: `kein JSON: ${ref.path}` };
    }
    const value = jsonPointerValue(parsed, ref.pointer);
    if (value === undefined || value === null) {
      return {
        ref,
        ok: false,
        reason: `Pointer nicht auflösbar: ${ref.path}#${ref.pointer}`,
      };
    }
  }
  if (ref.contains) {
    const text = buffer.toString("utf8");
    if (!text.includes(ref.contains)) {
      return { ref, ok: false, reason: `Textmarke fehlt: ${ref.contains}` };
    }
  }
  if (ref.line != null) {
    const text = buffer.toString("utf8");
    const lines = text.split(/\r?\n/);
    if (text.endsWith("\n")) lines.pop();
    if (ref.line < 1 || ref.line > lines.length) {
      return {
        ref,
        ok: false,
        reason: `Zeile ${ref.line} liegt außerhalb von ${ref.path}`,
      };
    }
  }
  if (ref.offset != null && (ref.offset < 0 || ref.offset >= buffer.length)) {
    return {
      ref,
      ok: false,
      reason: `Offset ${ref.offset} liegt außerhalb von ${ref.path}`,
    };
  }
  return { ref, ok: true, bytes: buffer.length };
}

function firstBundleFile(ctx, prefix) {
  return (ctx.bundle?.entries || []).find((entry) =>
    entry.name.startsWith(prefix),
  );
}

function checkEvidenceRefs(id, bp, ctx, sourceFiles) {
  const preferredSource =
    sourceFiles.find((name) => name.startsWith("source/java/")) ||
    sourceFiles.find((name) => name.startsWith("source/app/")) ||
    sourceFiles.find((name) => name.startsWith("source/web/")) ||
    sourceFiles.find((name) => name.startsWith("source/")) ||
    sourceFiles.find((name) =>
      name.startsWith("internals/pseudocode/functions/"),
    ) ||
    sourceFiles[0];
  const source = preferredSource;
  const ref = evidenceRef;
  if (id === "auftrag") return [ref("BLUEPRINT.md", { contains: "**Ziel:**" })];
  if (id === "plan")
    return [ref("BLUEPRINT.md", { contains: "## 7. Rekonstruktionsplan" })];
  if (id === "abnahme")
    return [ref("BLUEPRINT.md", { contains: "## 8. Abnahmekriterien" })];
  if (id === "agent")
    return [
      ref("AGENT-PROMPT.md", {
        contains: "## Vollständigkeitsprüfung und Lücken",
      }),
    ];
  if (id === "beweise")
    return [ref("BLUEPRINT.md", { contains: "## 10. Beweise im Paket" })];
  if (id === "quellen") {
    return source
      ? [ref(source, { line: 1 })]
      : [ref("AGENT-PROMPT.md", { contains: "Quellcode im Paket:" })];
  }
  if (id === "web.dom") return [ref("surface/dom.html", { line: 1 })];
  if (id === "web.elements")
    return [ref("surface/dom.html", { contains: "<body" })];
  if (id === "web.a11y") return [ref("surface/accessibility.txt", { line: 1 })];
  if (id === "web.screenshot")
    return [ref("surface/screenshot.png", { offset: 0 })];
  const webRequests = bp.behavior?.network?.requests || [];
  const webContracts = bp.behavior?.network?.contracts || [];
  const evidenceRequest =
    webRequests.find((request) => /\/api\//i.test(String(request.url))) ||
    webRequests[0];
  if (id === "web.requests") {
    return [
      ref("evidence/web-capture.json", {
        pointer:
          evidenceRequest?.capture_pointer ||
          "/normalized_result/events/items/0",
      }),
    ];
  }
  if (id === "web.events") {
    return [
      ref("evidence/web-capture.json", {
        pointer: "/normalized_result/events/items/0",
      }),
      ref("evidence/source-analysis.json", { pointer: "/events" }),
    ];
  }
  if (id === "web.flow")
    return [
      ref("evidence/web-capture.json", {
        pointer: "/normalized_result/steps/0",
      }),
    ];
  if (id === "web.analysis")
    return [ref("evidence/web-analysis.json", { pointer: "/artifacts/0" })];
  if (id === "web.functions")
    return [ref("evidence/source-analysis.json", { pointer: "/functions/0" })];
  if (id === "web.calls")
    return [ref("evidence/source-analysis.json", { pointer: "/calls/0" })];
  if (id === "web.contracts") {
    return [
      ref("evidence/web-capture.json", {
        pointer:
          webContracts[0]?.source_pointer ||
          "/normalized_result/events/items/0",
      }),
      ref("BLUEPRINT.md", { contains: "### Datenverträge" }),
    ];
  }
  if (id === "web.server")
    return [ref("evidence/source-analysis.json", { pointer: "/routes/0" })];
  if (id === "web.server_functions")
    return [ref("evidence/source-analysis.json", { pointer: "/functions/0" })];
  if (id === "web.server_calls")
    return [ref("evidence/source-analysis.json", { pointer: "/calls/0" })];
  if (id === "web.server_errors")
    return [ref("evidence/source-analysis.json", { pointer: "/errors/0" })];
  if (id === "web.contracts_source") {
    return [
      ref("evidence/source-analysis.json", { pointer: "/routes/0" }),
      ref("evidence/web-capture.json", {
        pointer:
          webContracts[0]?.source_pointer ||
          "/normalized_result/events/items/0",
      }),
    ];
  }
  if (id === "web.events_static")
    return [ref("evidence/source-analysis.json", { pointer: "/events/0" })];
  if (id === "web.storage") return [ref("surface/storage.json", { line: 1 })];
  if (id === "web.errors") {
    const errorRequest =
      webRequests.find(
        (request) => Number(request.status) >= 400 || request.failed,
      ) || webRequests[0];
    return [
      ref("evidence/source-analysis.json", { pointer: "/errors/0" }),
      ref("evidence/web-capture.json", {
        pointer:
          errorRequest?.capture_pointer || "/normalized_result/events/items/0",
      }),
    ];
  }
  if (id === "apk.components")
    return [
      ref("evidence/apk-package.json", {
        pointer: "/normalized_result/components",
      }),
    ];
  if (id === "apk.resources") {
    const layout = firstBundleFile(ctx, "surface/android/res/layout/");
    return [ref(layout?.name || "surface/AndroidManifest.xml", { line: 1 })];
  }
  if (id === "apk.permissions") {
    return [
      ref("evidence/apk-package.json", {
        pointer: "/normalized_result/permissions",
      }),
      ref("evidence/apk-signature.json", { pointer: "/normalized_result" }),
    ];
  }
  if (id === "apk.behavior")
    return [ref("surface/AndroidManifest.xml", { line: 1 })];
  if (id === "apk.classes")
    return [
      ref("evidence/apk-classes.json", {
        pointer: "/normalized_result/total_classes",
      }),
    ];
  if (id === "apk.source")
    return source
      ? [ref(source, { line: 1 })]
      : [
          ref("evidence/apk-package.json", {
            pointer: "/normalized_result/package_name",
          }),
        ];
  if (id === "apk.data") {
    const strings = firstBundleFile(ctx, "surface/strings.json");
    return [ref(strings?.name || "surface/AndroidManifest.xml", { line: 1 })];
  }
  if (id === "apk.screens") {
    return [
      ref("evidence/apk-error-analysis.json", {
        pointer: "/screens/activities",
      }),
      ref("evidence/apk-error-analysis.json", { pointer: "/screens/layouts" }),
    ];
  }
  if (id === "apk.data_flow") {
    return [
      ref("evidence/apk-error-analysis.json", { pointer: "/data_flow/urls" }),
      ref("evidence/apk-error-analysis.json", {
        pointer: "/data_flow/databases",
      }),
      ref("evidence/apk-error-analysis.json", {
        pointer: "/data_flow/storage",
      }),
    ];
  }
  if (id === "apk.error_paths")
    return [
      ref("evidence/apk-error-analysis.json", { pointer: "/error_paths" }),
    ];
  if (id === "apk.decompile_fallbacks")
    return [
      ref("evidence/apk-error-analysis.json", { pointer: "/decompiler" }),
    ];
  if (id === "js.modules")
    return [ref("evidence/js-analysis.json", { pointer: "/artifacts/0" })];
  if (id === "js.functions")
    return [
      ref("evidence/js-source-analysis.json", { pointer: "/functions/0" }),
    ];
  if (id === "js.calls")
    return [ref("evidence/js-source-analysis.json", { pointer: "/calls/0" })];
  if (id === "js.behavior")
    return [
      ref("evidence/js-source-analysis.json", { pointer: "/functions/0" }),
    ];
  if (id === "js.data")
    return [ref("evidence/js-source-analysis.json", { pointer: "/coverage" })];
  if (id === "js.source")
    return source
      ? [ref(source, { line: 1 })]
      : [ref("AGENT-PROMPT.md", { contains: "Quellcode im Paket: nein" })];
  if (id === "js.errors") {
    const errors = bp.behavior?.static_errors || [];
    return [
      ref("evidence/js-source-analysis.json", {
        pointer: errors.length > 0 ? "/errors/0" : "/exit_paths/0",
      }),
    ];
  }
  if (id === "native.surface")
    return [
      ref("evidence/native-analyze.json", {
        pointer: "/normalized_result/segment_count",
      }),
    ];
  if (id === "native.exports")
    return [
      ref("evidence/native-exports.json", { pointer: "/normalized_result" }),
    ];
  if (id === "native.pseudocode") {
    const body = firstBundleFile(ctx, "internals/pseudocode/functions/");
    return [
      ref("internals/pseudocode/decompile-index.json", {
        pointer: "/functions/0",
      }),
      ...(body ? [ref(body.name, { line: 1 })] : []),
    ];
  }
  if (id === "native.strings")
    return [
      ref("evidence/native-analyze.json", {
        pointer: "/normalized_result/string_count",
      }),
    ];
  if (id === "native.hardening")
    return [
      ref("evidence/native-hardening.json", {
        pointer: "/normalized_result/images/0",
      }),
    ];
  if (id === "native.cli") {
    return [
      ref("evidence/native-error-analysis.json", { pointer: "/usage" }),
      ref("evidence/native-error-analysis.json", { pointer: "/help" }),
      ref("evidence/native-error-analysis.json", { pointer: "/exit_contract" }),
    ];
  }
  if (id === "native.error_paths")
    return [
      ref("evidence/native-error-analysis.json", { pointer: "/error_paths/0" }),
    ];
  return [];
}

function auditCheckEvidence(check, ctx, virtualFiles) {
  const resolutions = (check.evidence || []).map((ref) =>
    resolveEvidenceRef(ref, ctx, virtualFiles),
  );
  const dangling = resolutions.filter((entry) => !entry.ok);
  check.evidence_resolution = {
    resolved: resolutions.length - dangling.length,
    total: resolutions.length,
    ok: resolutions.length > 0 && dangling.length === 0,
    dangling: dangling.map((entry) => entry.reason),
  };
  if (!check.evidence_resolution.ok) {
    check.ok = false;
    const reason =
      check.evidence_resolution.dangling[0] || "kein Beleg eingetragen";
    check.detail = `${check.detail}; Beleg nicht auflösbar: ${reason}`;
    check.action =
      "Einen vorhandenen Beleg mit auflösbarem Pfad, Pointer oder Offset eintragen und erneut prüfen.";
  }
}

function evaluateCompleteness(bp, promptDraft, ctx, virtualFiles = {}) {
  const kind = blueprintKind(bp);
  const checks = [];
  const surface = bp.surface || {};
  const behavior = bp.behavior || {};
  const internals = bp.internals || {};
  const evidence = Array.isArray(bp.evidence) ? bp.evidence : [];
  const evidenceWithHashes = evidence.filter(
    (item) => item.path && item.sha256,
  );
  const bundleNames = (ctx.bundle?.entries || []).map((entry) => entry.name);
  const sourceFiles = bundleNames.filter(
    (name) =>
      name.startsWith("source/") || name.startsWith("internals/pseudocode/"),
  );
  const add = (...args) => {
    const check = completenessCheck(...args);
    check.evidence = checkEvidenceRefs(check.id, bp, ctx, sourceFiles);
    auditCheckEvidence(check, ctx, virtualFiles);
    checks.push(check);
  };
  const graph = internals.semantic_graph || {};
  const functions = Array.isArray(graph.functions) ? graph.functions : [];
  const callSites = Array.isArray(graph.call_sites) ? graph.call_sites : [];
  const requests = Array.isArray(behavior.network?.requests)
    ? behavior.network.requests
    : [];
  const elements =
    (surface.headings || []).length +
    (surface.buttons || []).length +
    (surface.links || []).length +
    (surface.inputs || []).length +
    (surface.forms || []).length;

  add(
    "auftrag",
    "Ziel und Bauauftrag",
    Boolean(bp.target?.name && bp.target?.input),
    `Ziel: ${bp.target?.name || "unbekannt"} (${bp.target?.input || "ohne Quelle"})`,
    "Ziel und Quelle benennen, damit der Agent weiß, was nachgebaut wird.",
  );
  add(
    "plan",
    "Rekonstruktionsplan von Anfang bis Ende",
    (bp.reconstruction || []).length >= 3,
    `${(bp.reconstruction || []).length} Schritte im positiven Aufbau`,
    "Mindestens drei geordnete Bauschritte mit Eingaben, Ergebnissen und Prüfungen ergänzen.",
  );
  add(
    "abnahme",
    "Abnahmekriterien",
    (bp.acceptance || []).length >= 3,
    `${(bp.acceptance || []).length} prüfbare Kriterien`,
    "Prüfbare Abnahmekriterien für Oberfläche, Verhalten, Innenleben und Tests ergänzen.",
  );
  add(
    "agent",
    "Agentenauftrag mit Lückenliste",
    /BLUEPRINT\.md/.test(promptDraft) &&
      /blueprint\.json/.test(promptDraft) &&
      /(Lücken|offene Punkte)/i.test(promptDraft),
    "Der Auftrag nennt Bauplan, Maschinenlesbarkeit und Lückenliste.",
    "Agentenauftrag so erzeugen, dass er BLUEPRINT.md, blueprint.json und die Lückenliste verbindlich nennt.",
  );
  add(
    "beweise",
    "Beweise mit Prüfsummen",
    evidence.length > 0 && evidenceWithHashes.length === evidence.length,
    `${evidenceWithHashes.length} von ${evidence.length} Beweisen mit Pfad und SHA-256`,
    "Für jede Beweisdatei Pfad und SHA-256 aufnehmen, damit der Agent die Quelle prüfen kann.",
  );
  add(
    "quellen",
    "Quellcode und Ressourcen im Paket",
    !bp.source_included || sourceFiles.length > 0,
    bp.source_included
      ? `${sourceFiles.length} Quell-/Pseudocode-Dateien im Paket`
      : "Quellcode war für diesen Lauf nicht aktiviert.",
    "Quellcode einschließen oder die fehlende Quelle als Lücke ausweisen.",
  );

  if (kind === "web") {
    add(
      "web.dom",
      "DOM und sichtbare Oberfläche",
      Number(surface.dom_bytes) > 0,
      `${surface.dom_bytes || 0} Bytes DOM`,
      "Seite mit DOM-Aufnahme erneut analysieren; ohne DOM ist die Oberfläche nicht belegt.",
    );
    add(
      "web.elements",
      "Bedienelemente und Struktur",
      elements > 0,
      `${elements} Überschriften, Buttons, Links, Eingaben und Formulare`,
      "DOM mit sichtbaren Bedienelementen aufnehmen; die Struktur fehlt sonst.",
    );
    add(
      "web.a11y",
      "Accessibility-Baum",
      Boolean(surface.accessibility_excerpt),
      surface.accessibility_excerpt
        ? "Accessibility-Baum beigelegt"
        : "kein Accessibility-Baum",
      "Accessibility-Aufnahme aktivieren und erneut ausführen.",
    );
    add(
      "web.screenshot",
      "Screenshot",
      Boolean(surface.screenshot?.included),
      surface.screenshot?.included ? "Screenshot beigelegt" : "kein Screenshot",
      "Web-Aufnahme mit Screenshot wiederholen, damit die visuelle Wirkung belegt ist.",
    );
    add(
      "web.requests",
      "Netzwerkaufrufe",
      Number(behavior.network?.transactions) > 0,
      `${behavior.network?.transactions || 0} Requests, ${behavior.network?.failed || 0} fehlgeschlagen`,
      "Seite mit Netzwerkaufnahme und ausgelösten Interaktionen erneut aufnehmen.",
    );
    add(
      "web.events",
      "Events und Zustände",
      Number(behavior.events?.retained) > 0 ||
        (behavior.events?.bindings || []).length > 0,
      `${behavior.events?.retained || 0} behaltene Events, ${(behavior.events?.bindings || []).length} statische Bindings`,
      "Events aufnehmen und DOM-Handler aus dem Quellcode ergänzen.",
    );
    add(
      "web.flow",
      "Beobachteter Ablauf",
      (behavior.steps || []).length > 0,
      `${(behavior.steps || []).length} aufgezeichnete Schritte`,
      "Mindestens einen Ablauf mit Klick oder Wartezeit aufzeichnen.",
    );
    add(
      "web.analysis",
      "Statische JavaScript-Analyse",
      Number(graph.nodes) > 0,
      `${graph.nodes || 0} Graphknoten`,
      "Skripte exportieren und statisch analysieren; ohne Analyse ist das Innenleben nicht belegt.",
    );
    add(
      "web.functions",
      "Funktionen im Innenleben",
      functions.length > 0,
      `${functions.length} belegte Funktionen`,
      "Funktionsliste aus der JavaScript-Analyse aufnehmen.",
    );
    add(
      "web.calls",
      "Aufrufstellen",
      callSites.length > 0,
      `${callSites.length} belegte Aufrufstellen`,
      "Aufrufstellen aus der JavaScript-Analyse aufnehmen.",
    );
    const contracts = behavior.network?.contracts || [];
    add(
      "web.contracts",
      "Datenverträge der Requests",
      contracts.some(
        (contract) => contract.request_shape || contract.response_shape,
      ),
      `${contracts.length} Verträge, davon ${contracts.filter((contract) => contract.request_shape || contract.response_shape).length} mit JSON-Form`,
      "JSON-Requests und -Antworten aufzeichnen; ohne Datenvertrag kennt der Agent die Feldnamen und Typen nicht.",
    );
    const serverEvidence = behavior.server || null;
    add(
      "web.server",
      "Serverfunktionen aus Quellcode",
      Boolean(
        serverEvidence?.routes?.length &&
        serverEvidence.coverage?.observed > 0 &&
        serverEvidence.unmatched?.length === 0,
      ),
      serverEvidence
        ? `${serverEvidence.routes.length} Routen, ${serverEvidence.coverage?.matched || 0}/${serverEvidence.coverage?.observed || 0} beobachtete API-Aufrufe zugeordnet${serverEvidence.unmatched?.length ? `, offen: ${serverEvidence.unmatched.join(", ")}` : ""}`
        : "kein lokaler Serverquellpfad übergeben",
      "Lokalen Projektquellordner übergeben und jede beobachtete API-Route im Quellcode belegen.",
    );
    add(
      "web.server_functions",
      "Server-Handler und Signaturen",
      Boolean(serverEvidence?.functions?.length),
      `${serverEvidence?.functions?.length || 0} Funktionen mit Signatur aus der Quellanalyse`,
      "Handler-Funktionen und ihre Parameter aus dem Serverquellcode extrahieren.",
    );
    add(
      "web.server_calls",
      "Server-Aufrufstellen",
      Boolean(serverEvidence?.calls?.length),
      `${serverEvidence?.calls?.length || 0} Aufrufstellen in Routen und Helfern`,
      "Aufrufstellen der Serverlogik statisch belegen.",
    );
    add(
      "web.server_errors",
      "Server-Fehlerpfade",
      Boolean(serverEvidence?.errors?.length),
      `${serverEvidence?.errors?.length || 0} Fehler-/Statuspfade im Quellcode`,
      "Fehlerantworten, Statuscodes und Wurfstellen aus dem Serverquellcode extrahieren.",
    );
    add(
      "web.contracts_source",
      "Datenverträge mit Serverquelle",
      contracts.length > 0 &&
        contracts.every((contract) => contract.source_route),
      `${contracts.filter((contract) => contract.source_route).length} von ${contracts.length} Verträgen mit Route und Handler verknüpft`,
      "Jeden beobachteten Datenvertrag einer statisch belegten Serverroute zuordnen.",
    );
    add(
      "web.events_static",
      "Event-Bindings aus Oberfläche und JavaScript",
      (behavior.events?.bindings || []).length > 0,
      `${(behavior.events?.bindings || []).length} statische Event-Bindings${behavior.events?.retained ? `, ${behavior.events.retained} aufgezeichnete Events` : ""}`,
      "DOM-Handler und addEventListener-Bindings aus HTML/JavaScript extrahieren.",
    );
    add(
      "web.storage",
      "Speicherzustand",
      bp.data?.storage_keys != null,
      bp.data?.storage_keys
        ? "Storage-Fingerabdrücke beigelegt"
        : "kein Speicherzustand",
      "Storage-Aufnahme aktivieren oder fehlenden Zustand als Lücke ausweisen.",
    );
    const errorStatus = requests.some(
      (request) => Number(request.status) >= 400,
    );
    const errorEvents =
      (behavior.page_errors || []).length +
      (behavior.console || []).filter((entry) =>
        /error/i.test(entry.level || ""),
      ).length;
    const sourceErrors = behavior.server?.errors || [];
    add(
      "web.errors",
      "Fehler- und Randfälle",
      errorStatus ||
        errorEvents > 0 ||
        Number(behavior.network?.failed) > 0 ||
        sourceErrors.length > 0,
      `${errorStatus ? "Fehlerstatus beobachtet" : "kein Fehlerstatus"}, ${errorEvents} Fehlerereignisse, ${behavior.network?.failed || 0} fehlgeschlagene Requests, ${sourceErrors.length} Quellcode-Fehlerpfade`,
      "Ungültige Eingaben, leere Zustände und Fehlerantworten auslösen und im Bauplan dokumentieren.",
    );
  } else if (kind === "apk") {
    const components = Object.values(surface.components || {}).flat();
    add(
      "apk.components",
      "Manifest und Komponenten",
      components.length > 0,
      `${components.length} Komponenten, Launcher ${surface.launcher_activity || "nicht erkannt"}`,
      "Manifest-Komponenten vollständig auslesen und in den Bauplan übernehmen.",
    );
    add(
      "apk.resources",
      "Layouts und Ressourcen",
      (surface.layout_files || []).length > 0 ||
        Number(surface.resource_count) > 0,
      `${(surface.layout_files || []).length} Layouts, ${surface.resource_count || 0} Ressourcen`,
      "apktool-Ressourcen dekodieren und Layouts/Strings in das Paket aufnehmen.",
    );
    const signatureSchemes = surface.signature?.schemes || [];
    add(
      "apk.permissions",
      "Berechtigungen und Signatur",
      Array.isArray(surface.permissions) && signatureSchemes.length > 0,
      `${(surface.permissions || []).length} Berechtigungen, ${signatureSchemes.length} Signaturschemata`,
      "Berechtigungen und Signatur in den Bauplan übernehmen.",
    );
    add(
      "apk.behavior",
      "Einstiegspunkte und Verhalten",
      (behavior.activities || []).length > 0 ||
        (behavior.exported || []).length > 0,
      `${(behavior.activities || []).length} Activities, ${(behavior.exported || []).length} exportierte Komponenten`,
      "Activities und Intent-Filter aus dem Manifest in den Bauplan übernehmen.",
    );
    add(
      "apk.classes",
      "Klasseninventar",
      Number(surface.class_count) > 0,
      `${surface.class_count || 0} Klassen, ${surface.app_class_count || 0} im App-Paket`,
      "Klasseninventar aus JADX aufnehmen.",
    );
    add(
      "apk.source",
      "Dekompilierter Java-Code",
      Number(internals.source?.files) > 0,
      `${internals.source?.files || 0} Java-Dateien, ${internals.source?.bytes || 0} Bytes`,
      "JADX-Quellen einschließen; ohne sie ist das Innenleben nicht nachbaubar.",
    );
    add(
      "apk.data",
      "Ressourcen, Strings und Assets",
      Number(surface.string_count) > 0 || (internals.assets || []).length > 0,
      `${surface.string_count || 0} Strings, ${(internals.assets || []).length} Assets`,
      "String-Tabellen und Assets ergänzen.",
    );
    const apkScreens = behavior.screens || {};
    const apkData = behavior.data_flow || {};
    const apkErrorPaths = behavior.error_paths || [];
    const apkDecompile = internals.decompile || {};
    const statusPaths = apkErrorPaths.filter((item) => item.status);
    const permissionPaths = apkErrorPaths.filter(
      (item) => item.kind === "permission-or-intent",
    );
    add(
      "apk.screens",
      "Screens und Abläufe (statisch)",
      Number(apkScreens.activities) > 0 &&
        (apkScreens.layouts || []).length > 0,
      `${apkScreens.activities || 0} Activities, ${(surface.layout_files || []).length} Layouts, ${apkScreens.navigation_calls || 0} Navigationsaufrufe, ${apkScreens.fragments || 0} Fragment-Übergänge`,
      "Activities, Layouts und Navigationsaufrufe aus Manifest und dekompiliertem Code ergänzen.",
    );
    add(
      "apk.data_flow",
      "Server- und Datenzugriffe (statisch)",
      Number(internals.error_analysis?.app_files) > 0,
      `${(apkData.urls || []).length} URLs, ${(apkData.servers || []).length} HTTP-Client-Aufrufe, ${(apkData.databases || []).length} Datenbankzugriffe, ${(apkData.storage || []).length} Speicherzugriffe im App-Paket`,
      "App-Quellen vollständig scannen; fehlende URL-, DB- oder Speicherbelege als Einzelpfad ausweisen.",
    );
    add(
      "apk.error_paths",
      "Fehler-, Status- und Berechtigungspfade",
      apkErrorPaths.length > 0,
      `${apkErrorPaths.length} belegte Pfade, ${behavior.messages?.length || 0} Meldungen, ${statusPaths.length} HTTP-Status, ${permissionPaths.length} Berechtigungs-/Intent-Fehler`,
      "throw/catch, Toast-/String-Ressourcen, HTTP-Status und Intent-/Permission-Fehler mit Datei und Zeile belegen.",
    );
    add(
      "apk.decompile_fallbacks",
      "Dekompilierungsbelege je Datei",
      Boolean(internals.source?.included) &&
        (Number(apkDecompile.reported_errors) === 0 ||
          ((apkDecompile.error_files || []).length > 0 &&
            (apkDecompile.missing_smali || []).length === 0)),
      `${apkDecompile.reported_errors || 0} JADX-Meldungen in ${(apkDecompile.error_files || []).length} Dateien, ${(apkDecompile.error_files || []).length - (apkDecompile.missing_smali || []).length}/${(apkDecompile.error_files || []).length} mit Smali-Alternative, ${apkDecompile.app_error_files || 0} im App-Paket`,
      (apkDecompile.missing_smali || [])[0]
        ? `Für ${(apkDecompile.missing_smali || [])[0]} fehlt eine Smali-Alternative; genau diesen Einzelpfad nachziehen.`
        : "JADX-Meldungen mit Dateidetails und Smali-Alternative je betroffener Datei belegen.",
    );
  } else if (kind === "javascript") {
    const modules = internals.application_graph?.modules || [];
    add(
      "js.modules",
      "Module und Anwendungsgraph",
      modules.length > 0 || Number(internals.application_graph?.nodes) > 0,
      `${modules.length} Module, ${internals.application_graph?.nodes || 0} Graphknoten`,
      "Anwendungsgraph mit Modulen aufnehmen.",
    );
    add(
      "js.functions",
      "Funktionen und Signaturen",
      functions.length > 0,
      `${functions.length} belegte Funktionen`,
      "Funktionsliste aus der JavaScript-Analyse aufnehmen.",
    );
    add(
      "js.calls",
      "Aufrufstellen",
      callSites.length > 0,
      `${callSites.length} belegte Aufrufstellen`,
      "Aufrufstellen aus der JavaScript-Analyse aufnehmen.",
    );
    const functionNames = (internals.semantic_graph?.functions || []).map(
      (item) => String(item.name || "").toLowerCase(),
    );
    const cliEntry = functionNames.some((name) =>
      /^(main|run|cli)$/.test(name),
    );
    add(
      "js.behavior",
      "Einstiegspunkte und Verhalten",
      (surface.routes || []).length > 0 ||
        (behavior.endpoints || []).length > 0 ||
        Number(behavior.ipc?.literal_channels) > 0 ||
        cliEntry,
      `${(surface.routes || []).length} Routen, ${(behavior.endpoints || []).length} Endpunkte, ${behavior.ipc?.literal_channels || 0} IPC-Kanäle${cliEntry ? ", CLI-Einstieg erkannt" : ""}`,
      "Routen, IPC-Kanäle, Endpunkte oder einen CLI-Einstieg belegen; sonst ist das Verhalten nicht nachbaubar.",
    );
    const storageAccesses = (behavior.storage || []).length;
    const storageCoverage = internals.source_analysis?.coverage || {};
    const storageScanComplete =
      Number(storageCoverage.files_scanned) > 0 &&
      storageCoverage.truncated === false;
    add(
      "js.data",
      "Daten und Speicherzugriffe",
      storageAccesses > 0 || storageScanComplete,
      `${storageAccesses} Speicherzugriffe, Quellscan ${storageScanComplete ? "vollständig" : "nicht belegt"}`,
      "Speicherzugriffe und Datenverträge ergänzen oder den Quellscan vollständig belegen.",
    );
    add(
      "js.source",
      "Anwendungsquellen",
      Number(internals.statistics?.relevant_files) > 0 &&
        sourceFiles.length > 0,
      `${internals.statistics?.relevant_files || 0} relevante Dateien, ${sourceFiles.length} Quellen im Paket`,
      "Anwendungsquellen einschließen, damit der Agent Funktionen und Importe prüfen kann.",
    );
    const staticErrors = behavior.static_errors || [];
    const exitPaths = behavior.exit_paths || [];
    add(
      "js.errors",
      "Fehler- und Randfälle",
      staticErrors.length > 0 || exitPaths.length > 0,
      `${staticErrors.length} Fehlerstellen, ${exitPaths.length} Exit-Pfade aus Quellcode${staticErrors[0]?.message ? ` (z. B. „${staticErrors[0].message}“)` : ""}`,
      "Fehler-, Wurf- und Exit-Pfade aus Quellcode extrahieren; unbelegte Laufzeitpfade weiter ausweisen.",
    );
  } else if (kind === "native") {
    add(
      "native.surface",
      "Segmente und Funktionsinventar",
      Number(surface.segments) > 0 && Number(surface.procedures) > 0,
      `${surface.segments || 0} Segmente, ${surface.procedures || 0} Prozeduren`,
      "Ghidra-Analyse erneut ausführen; ohne Segmente ist das Programm nicht belegt.",
    );
    add(
      "native.exports",
      "Exporte und Schnittstellen",
      (behavior.exports || []).length > 0,
      `${(behavior.exports || []).length} Exporte`,
      "Exporte und Einstiegspunkte aus der Analyse übernehmen.",
    );
    add(
      "native.pseudocode",
      "Pseudocode je Funktion",
      Number(internals.pseudocode?.written) > 0 &&
        Number(internals.pseudocode?.written) +
          Number(internals.pseudocode?.external) >=
          Number(surface.procedures) &&
        Number(internals.pseudocode?.remaining) === 0 &&
        Number(internals.pseudocode?.failures) === 0,
      `${internals.pseudocode?.written || 0} interne Funktionen + ${internals.pseudocode?.external || 0} externe Importe (ohne Body) von ${surface.procedures || 0}, ${internals.pseudocode?.remaining || 0} offen, ${internals.pseudocode?.failures || 0} Fehler`,
      "Jede Funktion mit `decompile-all` erzeugen; einzelne fehlende Funktionen mit Adresse benennen.",
    );
    add(
      "native.strings",
      "Strings und Daten",
      Number(surface.strings) > 0,
      `${surface.strings || 0} Strings`,
      "Strings und belegte Daten aus der Analyse übernehmen.",
    );
    add(
      "native.hardening",
      "Schutzmerkmale",
      (behavior.hardening || []).length > 0,
      `${(behavior.hardening || []).length} Härtungsmerkmale`,
      "Härtungsprüfung ausführen und Merkmale dokumentieren.",
    );
    add(
      "native.cli",
      "Ein-/Ausgaben und Exit-Codes",
      Boolean(behavior.cli?.usage) &&
        Boolean(behavior.cli?.help) &&
        (behavior.exit_contract || []).length > 0,
      `${behavior.cli?.usage ? "Usage-String" : "kein Usage-String"}, ${behavior.cli?.help ? "Hilfeoption" : "keine Hilfeoption"}, ${(behavior.exit_contract || []).length} Exit-Verträge`,
      "Usage, Hilfeoption und Exit-Codes aus .rodata-Strings und Disassembly belegen.",
    );
    add(
      "native.error_paths",
      "Fehler- und Exit-Pfade",
      (behavior.error_paths || []).length > 0,
      `${(behavior.error_paths || []).length} belegte Pfade, ${(behavior.messages || []).length} Meldungen, ${(behavior.calls || []).length} Fehler-/Exit-Aufrufe`,
      "PLT-Aufrufe und .rodata-Strings mit Offset und Disassembly-Adresse je Einzelpfad belegen.",
    );
  }

  const failed = checks.filter((check) => !check.ok);
  const gaps = [
    ...failed.map((check) => ({
      id: check.id,
      label: check.label,
      why: check.detail,
      action: check.action,
      source: "check",
    })),
    ...(bp.open_questions || []).map((question) => ({
      id: question.id,
      label: question.question,
      why: question.why,
      action: question.how,
      source: "open_question",
    })),
  ];
  const total = checks.length + (bp.open_questions || []).length;
  const passed = checks.length - failed.length;
  const score = total > 0 ? Math.round((passed / total) * 100) : 100;
  const status =
    gaps.length === 0
      ? "complete"
      : failed.length === 0 || score >= 60
        ? "partial"
        : "insufficient";
  return {
    kind,
    status,
    score,
    passed,
    total,
    checks,
    gaps,
    evidence_audit: {
      total: checks.length,
      resolved: checks.filter((check) => check.evidence_resolution?.ok).length,
      unresolved: checks.filter((check) => !check.evidence_resolution?.ok)
        .length,
      dangling: checks.flatMap((check) =>
        (check.evidence_resolution?.dangling || []).map((reason) => ({
          id: check.id,
          reason,
        })),
      ),
    },
  };
}

async function buildWeb(ctx) {
  const { input } = ctx;
  progress(
    ctx,
    "collect",
    "Web-Beweise werden gelesen",
    "Aufnahme, Skripte und statische Analyse werden geprüft.",
    18,
  );
  const capturePath = input.web?.capture || input.capturePath;
  const analysisPath = input.web?.analysis || input.analysisPath;
  if (!capturePath || !existsSync(capturePath)) {
    throw Object.assign(
      new Error(
        "Für diese Web-Blaupause fehlt die Aufnahme. Führe zuerst unter „Web-App“ eine Analyse aus.",
      ),
      { statusCode: 400 },
    );
  }
  const capturePayload = await readJson(capturePath);
  if (!capturePayload) {
    throw Object.assign(
      new Error(
        "Die Web-Aufnahme ist nicht lesbar. Führe die Analyse erneut aus.",
      ),
      { statusCode: 400 },
    );
  }
  const capture = normalizeRecord(capturePayload) || {};
  await addJson(
    ctx,
    "Web-Aufnahme (vollständige Evidenz)",
    capturePath,
    "web-capture.json",
  );

  let analysis = null;
  if (analysisPath && existsSync(analysisPath)) {
    const stored = await addJson(
      ctx,
      "Statische JavaScript-Analyse (vollständige Evidenz)",
      analysisPath,
      "web-analysis.json",
    );
    analysis = stored ? normalizeRecord(stored.payload) : null;
  }

  const events = Array.isArray(capture.events?.items)
    ? capture.events.items
    : Array.isArray(capture.events)
      ? capture.events
      : [];
  const artifacts = captureArtifacts(capture);
  const dom = artifactValue(artifacts, "dom")?.text || null;
  const accessibility = artifactValue(artifacts, "accessibility")?.text || null;
  const storage = artifactValue(artifacts, "storage");
  const history = artifactValue(artifacts, "history");
  const screenshot = artifactValue(artifacts, "screenshot");
  const html = dom ? summarizeHtml(dom) : null;

  if (dom) {
    await addBuffer(
      ctx,
      "DOM der aufgenommenen Seite",
      "surface/dom.html",
      Buffer.from(dom, "utf8"),
    );
  }
  if (accessibility) {
    await addBuffer(
      ctx,
      "Accessibility-Baum der aufgenommenen Seite",
      "surface/accessibility.txt",
      Buffer.from(accessibility, "utf8"),
    );
  }
  if (screenshot?.data_base64) {
    const bytes = Buffer.from(screenshot.data_base64, "base64");
    await addBuffer(
      ctx,
      "Screenshot der aufgenommenen Seite",
      "surface/screenshot.png",
      bytes,
    );
  }
  if (storage) {
    await addBuffer(
      ctx,
      "Speicherzustand der Seite (Schlüssel und Typen)",
      "surface/storage.json",
      Buffer.from(JSON.stringify(storage, null, 2), "utf8"),
    );
  }
  if (history) {
    await addBuffer(
      ctx,
      "Navigationsverlauf der Aufnahme",
      "surface/history.json",
      Buffer.from(JSON.stringify(history, null, 2), "utf8"),
    );
  }

  if (input.web?.scripts && existsSync(input.web.scripts)) {
    progress(
      ctx,
      "collect",
      "Skripte werden übernommen",
      "Der exportierte JavaScript-Bestand wird in das Paket gelegt.",
      28,
    );
    const added = await ctx.bundle.addTree("source/web", input.web.scripts, {
      maxBytes: 40 * 1024 * 1024,
      maxFiles: 4000,
      allow: (path) => /\.(?:m?js|cjs|ts|tsx|jsx|json|map|html?)$/i.test(path),
    });
    if (added.omitted > 0) {
      ctx.limits.push(
        `${added.omitted} Skriptdatei(en) wurden wegen der Paketgrenze nicht aufgenommen.`,
      );
    }
  }

  const textAssets = captureTextAssets(events);
  for (const asset of textAssets) {
    const pathname = new URL(asset.url).pathname;
    const base = basename(pathname) || `asset.${asset.extension}`;
    const name = base.includes(".") ? base : `${base}.${asset.extension}`;
    await addBuffer(
      ctx,
      `Aufgezeichnete ${asset.extension.toUpperCase()}-Antwort (${asset.url})`,
      `source/web/assets/${sha256(asset.url).slice(0, 12)}-${name}`,
      Buffer.from(asset.body, "utf8"),
    );
  }

  const network = networkFromEvents(events);
  const sourceRoot = input.web?.source || input.web?.scripts || null;
  const sourceAnalysis = sourceRoot
    ? await analyzeProjectSource(sourceRoot)
    : null;
  const staticEvents = uniqueItems(
    [...(sourceAnalysis?.events || []), ...domEventBindings(dom)],
    (item) =>
      `${item.event}:${item.selector}:${item.handler}:${item.file || "dom"}`,
    300,
  );
  const server = sourceAnalysis
    ? attachServerEvidence(network, sourceAnalysis)
    : null;
  if (sourceAnalysis) {
    await addBuffer(
      ctx,
      "Statische Quellanalyse (Routen, Funktionen, Aufrufe, Fehler und Events)",
      "evidence/source-analysis.json",
      Buffer.from(
        JSON.stringify(
          {
            root: sourceAnalysis.root,
            coverage: sourceAnalysis.coverage,
            routes: sourceAnalysis.routes,
            functions: sourceAnalysis.functions,
            calls: sourceAnalysis.calls,
            errors: sourceAnalysis.errors,
            events: sourceAnalysis.events,
          },
          null,
          2,
        ),
        "utf8",
      ),
    );
  }
  if (
    ctx.includeSources &&
    input.web?.source &&
    existsSync(input.web.source) &&
    input.web.source !== input.web?.scripts
  ) {
    const added = await ctx.bundle.addTree(
      "source/web/project",
      input.web.source,
      {
        maxBytes: 20 * 1024 * 1024,
        maxFiles: 2500,
        allow: (path) =>
          /\.(?:m?js|cjs|jsx|ts|tsx|mts|cts|json|html?|css)$/i.test(path),
      },
    );
    if (added.omitted > 0) {
      ctx.limits.push(
        `${added.omitted} Projektquelldatei(en) wurden wegen der Paketgrenze nicht aufgenommen.`,
      );
    }
  }
  const kinds = countBy(
    events.map((event) => event.kind || "unbekannt"),
    (item) => item,
  );
  const consoleItems = events
    .filter((event) => event.kind === "console")
    .map((event) => ({
      level: event.level || event.type || null,
      text: text(event.text || event.message || event.value || "", 600),
    }))
    .filter((item) => item.text)
    .slice(0, 80);
  const pageErrors = events
    .filter(
      (event) =>
        /error/i.test(String(event.kind || "")) || event.level === "error",
    )
    .map((event) => text(event.text || event.message || event.value || "", 600))
    .filter(Boolean)
    .slice(0, 80);
  const steps = (Array.isArray(capture.steps) ? capture.steps : []).map(
    (step) => ({
      action: step.action || "?",
      status: step.status || null,
      before_url: step.before_url?.url || step.before_url || null,
      after_url: step.after_url?.url || step.after_url || null,
      elapsed_ms: step.elapsed_ms ?? null,
    }),
  );
  const navigation = uniqueItems(
    [
      ...steps.map((step) => step.after_url),
      ...(Array.isArray(history?.navigation_entries)
        ? history.navigation_entries.map((entry) => entry.name?.url || null)
        : []),
    ]
      .filter(Boolean)
      .map((url) => ({ url })),
    (item) => item.url,
    40,
  );

  const semantic = analysis?.semantic_graph || {};
  const semanticNodes = Array.isArray(semantic.nodes) ? semantic.nodes : [];
  const semanticRelations = Array.isArray(semantic.relations)
    ? semantic.relations
    : [];
  const graph = analysis?.graph || {};
  const graphNodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const graphEdges = Array.isArray(graph.edges) ? graph.edges : [];
  const nodeName = (node) =>
    text(
      node.label ||
        node.properties?.name ||
        node.properties?.path ||
        node.identity?.module_path ||
        node.name ||
        node.node_id ||
        "",
      240,
    );
  const groupNodes = (nodes, kind) =>
    nodes
      .filter((node) => node.kind === kind)
      .map((node) => ({
        name: nodeName(node),
        module: node.identity?.module_path || node.properties?.path || null,
        line: node.identity?.source_range?.start?.line ?? null,
      }))
      .filter((item) => item.name)
      .slice(0, 200);
  const routes = (analysis?.route_inventory?.routes || []).map((route) => ({
    path: route.path || route.pattern || route.route || route.value || null,
    kind: route.kind || route.classification || null,
    source: route.source || route.source_id || null,
  }));
  const statistics = analysis?.statistics || null;

  const surface = {
    title: html?.title || input.url || ctx.target,
    url: input.url || ctx.target,
    final_url: steps.at(-1)?.after_url || input.url || ctx.target,
    lang: html?.lang || null,
    description: html?.description || null,
    headings: html?.headings || [],
    buttons: html?.buttons || [],
    links: html?.links || [],
    inputs: html?.inputs || [],
    forms: html?.forms || [],
    images: html?.images || [],
    scripts: html?.scripts || [],
    stylesheets: html?.stylesheets || [],
    landmarks: html?.landmarks || {},
    tag_counts: html?.tag_counts || [],
    text_excerpt: html?.text_excerpt || null,
    accessibility_excerpt: text(accessibility, 2500) || null,
    dom_bytes: dom ? Buffer.byteLength(dom) : 0,
    source_assets: textAssets.map((asset) => ({
      url: asset.url,
      content_type: asset.contentType,
      bytes: Buffer.byteLength(asset.body),
    })),
    screenshot: screenshot
      ? {
          included: true,
          bytes: screenshot.bytes ?? null,
          sha256: screenshot.sha256 ?? null,
        }
      : { included: false, reason: "nicht angefordert oder nicht aufgenommen" },
    storage: storage
      ? {
          cookies: Array.isArray(storage.cookies) ? storage.cookies.length : 0,
          local_storage_origins: Array.isArray(storage.local_storage)
            ? storage.local_storage.length
            : 0,
          session_storage_origins: Array.isArray(storage.session_storage)
            ? storage.session_storage.length
            : 0,
        }
      : null,
  };
  const behavior = {
    steps,
    navigation,
    events: {
      retained: capture.events?.retained ?? events.length,
      dropped: capture.events?.dropped ?? 0,
      by_kind: kinds,
      bindings: staticEvents,
      static_bindings: staticEvents.length,
    },
    server,
    console: consoleItems,
    page_errors: pageErrors,
    network,
  };
  const internals = {
    scripts: {
      directory: input.web?.scripts || null,
      analysis_input: input.web?.analysisInput || null,
      source_directory: input.web?.source || null,
    },
    source_analysis: sourceAnalysis
      ? {
          root: sourceAnalysis.root,
          coverage: sourceAnalysis.coverage,
          routes: sourceAnalysis.routes.length,
          functions: sourceAnalysis.functions.length,
          calls: sourceAnalysis.calls.length,
          errors: sourceAnalysis.errors.length,
          events: sourceAnalysis.events.length,
        }
      : null,
    statistics,
    semantic_graph: {
      nodes: semanticNodes.length,
      relations: semanticRelations.length,
      by_kind: countBy(
        semanticNodes.map((node) => node.kind || "unbekannt"),
        (item) => item,
      ),
      functions: groupNodes(semanticNodes, "function"),
      call_sites: groupNodes(semanticNodes, "call-site"),
      modules: groupNodes(semanticNodes, "module"),
      requests: groupNodes(semanticNodes, "request"),
      relations_by_kind: countBy(
        semanticRelations.map((relation) => relation.relation || "unbekannt"),
        (item) => item,
      ),
    },
    application_graph: {
      nodes: graphNodes.length,
      edges: graphEdges.length,
      by_kind: countBy(
        graphNodes.map((node) => node.kind || "unbekannt"),
        (item) => item,
      ),
      modules: groupNodes(graphNodes, "javascript-module").slice(0, 200),
    },
    routes,
  };
  const data = {
    storage_keys:
      storage && typeof storage === "object"
        ? {
            local_storage: (storage.local_storage || []).map((origin) => ({
              origin: origin.origin || null,
              keys: (origin.entries || []).map((entry) => ({
                key: entry.key || entry.name || null,
                type: entry.type || typeof entry.value || null,
              })),
            })),
            session_storage: (storage.session_storage || []).map((origin) => ({
              origin: origin.origin || null,
              keys: (origin.entries || []).map((entry) => ({
                key: entry.key || entry.name || null,
                type: entry.type || typeof entry.value || null,
              })),
            })),
            cookies: (storage.cookies || []).map((cookie) => ({
              name: cookie.name || null,
              domain: cookie.domain || null,
            })),
          }
        : null,
  };

  if (!dom) {
    openQuestion(
      ctx,
      "Wie sieht die Oberfläche im Detail aus?",
      "Für diese Aufnahme wurde kein DOM gespeichert; sichtbare Struktur und Texte sind deshalb nicht direkt belegt.",
      "Die Seite mit einer längeren Wartezeit erneut aufnehmen und dabei DOM, Accessibility-Baum und Screenshot einschließen.",
      ["evidence/web-capture.json"],
    );
  }
  if (!screenshot?.data_base64) {
    openQuestion(
      ctx,
      "Welche visuelle Wirkung hat die Seite?",
      "Es liegt kein Screenshot im Paket; Farben, Abstände und Zustände lassen sich daraus nicht ablesen.",
      "Die Web-Aufnahme mit Screenshot wiederholen oder die im DOM genannten Stylesheets übernehmen.",
    );
  }
  if (!analysis) {
    openQuestion(
      ctx,
      "Welche Funktionen und Aufrufe liegen im JavaScript?",
      "Es wurde keine statische JavaScript-Evidenz in das Paket aufgenommen.",
      "Die Web-Analyse mit exportierten Skripten erneut ausführen.",
    );
  }
  if (network.transactions === 0) {
    openQuestion(
      ctx,
      "Welche Schnittstellen ruft die Anwendung auf?",
      "Die Aufnahme enthält keine Netzwerk-Transaktionen.",
      "Die Seite mit mehr Wartezeit und ausgelösten Interaktionen erneut aufnehmen.",
    );
  }
  if (
    network.transactions > 0 &&
    (!server || server.coverage.observed === 0 || server.unmatched.length > 0)
  ) {
    openQuestion(
      ctx,
      "Welche Serverfunktionen stehen hinter den beobachteten Aufrufen?",
      server
        ? `Die Quellanalyse fand ${server.routes.length} Routen, konnte aber ${server.unmatched.length} beobachtete API-Aufrufe keiner Route zuordnen: ${server.unmatched.join(", ")}.`
        : "Die Aufnahme belegt Methode, Pfad, Status und Antwortform der Requests. Ein lokaler Serverquellpfad wurde nicht übergeben; die serverseitigen Funktionen sind deshalb nicht belegt.",
      "Lokalen Projektquellcode als Quellordner übergeben und die nicht zugeordneten Endpunkte mit Testdaten und Fehlerfällen aufrufen.",
      ["evidence/web-capture.json"],
    );
  }
  const missingSections = Array.isArray(capture.completeness?.missing_sections)
    ? capture.completeness.missing_sections.filter(Boolean)
    : [];
  const missingWithoutEvents = missingSections.filter(
    (section) => String(section).toLowerCase() !== "events",
  );
  const eventEvidence = staticEvents.length > 0 || events.length > 0;
  if (
    missingWithoutEvents.length > 0 ||
    (capture.completeness?.status &&
      capture.completeness.status !== "complete" &&
      !eventEvidence)
  ) {
    openQuestion(
      ctx,
      "Welche Teile der Aufnahme fehlen für einen vollständigen Nachbau?",
      `Die Aufnahme meldet ${capture.completeness?.status || "unbekannt"}${missingSections.length ? `; fehlend: ${missingSections.join(", ")}` : ""}. Die vorhandenen Daten bleiben nutzbar, aber diese Abschnitte sind nicht belegt.`,
      "Die Aufnahme mit denselben Schritten und längerer Wartezeit wiederholen; fehlende Events durch gezielte Klicks auslösen.",
      ["evidence/web-capture.json"],
    );
  }

  return {
    target: {
      kind: "web",
      input: ctx.target,
      name: surface.title || ctx.target,
      url: surface.url,
      final_url: surface.final_url,
      size_bytes: null,
      sha256: null,
      platform: "web",
    },
    coverage: [
      dom ? "DOM und sichtbare Oberfläche" : null,
      accessibility ? "Accessibility-Baum" : null,
      screenshot?.data_base64 ? "Screenshot" : null,
      network.transactions > 0 && events.length > 0
        ? "Netzwerk und Events"
        : network.transactions > 0
          ? "Netzwerk"
          : null,
      analysis ? "Skripte und statischer Anwendungsgraph" : null,
      server?.routes?.length
        ? "Serverrouten, Handler und Fehler aus Quellcode"
        : null,
      sourceAnalysis?.events?.length
        ? "Event-Bindings aus DOM/JavaScript"
        : null,
      storage ? "Speicherzustand" : null,
    ].filter(Boolean),
    surface,
    behavior,
    internals,
    data,
    dependencies: detectWebStack(analysis, input),
    reconstruction: webPlan(),
    acceptance: [
      "Die Startseite rendert mit denselben Landmarks, Überschriften und sichtbaren Bedienelementen.",
      "Jede im Blaupausen-Dokument genannte Route ist erreichbar und rendert ohne Konsolenfehler.",
      "Die API-Aufrufe stimmen in Methode, Pfad und Statusklasse mit der Netzwerkliste überein.",
      "Formulare und Buttons lösen dieselben beobachteten Requests aus.",
      "Local Storage, Session Storage und Cookies verwenden dieselben Schlüssel und dieselbe Bedeutung.",
    ],
  };
}

function detectWebStack(analysis, input) {
  const haystack = JSON.stringify({
    statistics: analysis?.statistics,
    routes: analysis?.route_inventory?.routes,
    nodes: (analysis?.graph?.nodes || [])
      .slice(0, 200)
      .map((node) => node.properties),
    scripts: input.web?.scripts,
  }).toLowerCase();
  const found = [];
  for (const [name, pattern] of [
    ["React", /react/],
    ["Vue", /vue/],
    ["Svelte", /svelte/],
    ["Angular", /angular/],
    ["Next.js", /next/],
    ["Nuxt", /nuxt/],
    ["Vite", /vite/],
    ["Webpack", /webpack/],
    ["Electron", /electron/],
    ["Express", /express/],
  ]) {
    if (pattern.test(haystack)) found.push(name);
  }
  return found;
}

function webPlan() {
  return [
    {
      step: 1,
      title: "Projektgerüst und Laufzeit anlegen",
      goal: "Ein lauffähiges Grundprojekt mit derselben Auslieferungsform wie die Vorlage erstellen.",
      inputs: [
        "surface/dom.html",
        "behavior.network",
        "evidence/web-analysis.json",
      ],
      outputs: [
        "Projektdateien",
        "Start- und Build-Skript",
        "lokaler Entwicklungsserver",
      ],
      checks: ["Build läuft fehlerfrei", "Startseite antwortet mit HTTP 200"],
    },
    {
      step: 2,
      title: "Oberfläche und Designsystem nachbauen",
      goal: "Landmarks, Überschriften, Navigation, Buttons, Formulare und Assets aus dem DOM übernehmen.",
      inputs: [
        "surface/dom.html",
        "surface/accessibility.txt",
        "surface/screenshot.png",
      ],
      outputs: ["Layout", "Komponenten", "Stylesheets", "Assets"],
      checks: [
        "Alle im DOM gefundenen Bedienelemente sind vorhanden",
        "Screenshot und Accessibility-Baum wirken gleichwertig",
      ],
    },
    {
      step: 3,
      title: "Routen und Seitenzustände implementieren",
      goal: "Die belegten Navigationsziele und Routen als echte Seiten abbilden.",
      inputs: ["internals.routes", "behavior.navigation"],
      outputs: ["Router", "Seitenkomponenten"],
      checks: [
        "Jede Route rendert",
        "Direkter Aufruf einer Route funktioniert",
      ],
    },
    {
      step: 4,
      title: "API- und Datenzugriff aufbauen",
      goal: "Die beobachteten Endpunkte mit denselben Methoden und Nutzlastformen anbinden.",
      inputs: ["behavior.network.endpoints", "behavior.network.requests"],
      outputs: ["API-Client", "Typen", "Fehlerbehandlung"],
      checks: [
        "Requests stimmen mit der Aufnahme überein",
        "Lade-, Fehler- und Leerzustände sind sichtbar",
      ],
    },
    {
      step: 5,
      title: "Interaktionen, Events und Speicher übernehmen",
      goal: "Klicks, Formulare und Zustandswechsel so verbinden, dass dieselben Folge-Requests und Speicherungen entstehen.",
      inputs: ["behavior.steps", "behavior.events", "surface.storage"],
      outputs: ["Event-Handler", "Zustandsverwaltung", "Storage-Zugriffe"],
      checks: [
        "Klickfolge erzeugt dieselben Requests",
        "Storage-Schlüssel und Wertebereiche stimmen überein",
      ],
    },
    {
      step: 6,
      title: "Statische JavaScript-Funktionen und Aufrufe nachziehen",
      goal: "Die im Analysegraph belegten Funktionen, Module und Aufrufbeziehungen in die neue Struktur übertragen.",
      inputs: ["evidence/web-analysis.json", "source/web/"],
      outputs: ["Module", "Funktionen", "Tests"],
      checks: [
        "Relevante Funktionen sind vorhanden",
        "Keine unaufgelösten Importe",
      ],
    },
    {
      step: 7,
      title: "Abgleich mit der Vorlage",
      goal: "Die rekonstruierte Anwendung gegen DOM, Netzwerk und Speicher der Aufnahme prüfen.",
      inputs: ["alle vorherigen Schritte"],
      outputs: ["Abgleichsbericht", "Restliste"],
      checks: [
        "DOM-Struktur gleichwertig",
        "Netzwerkverhalten gleichwertig",
        "Keine neuen Konsolenfehler",
      ],
    },
  ];
}

function defaultTarget(ctx) {
  return {
    kind: ctx.kind,
    input: ctx.target,
    name: basename(ctx.target) || ctx.target,
    url: null,
    final_url: null,
    size_bytes: null,
    sha256: null,
    platform: unknownPlatform(ctx.kind),
  };
}

function unknownPlatform(kind) {
  return kind === "apk" ? "android" : kind === "web" ? "web" : "unbekannt";
}

async function fileTarget(ctx) {
  const target = defaultTarget(ctx);
  if (ctx.target && existsSync(ctx.target)) {
    const info = await stat(ctx.target);
    target.size_bytes = info.isFile() ? info.size : null;
    target.sha256 = info.isFile() ? await hashFile(ctx.target) : null;
  }
  return target;
}

/**
 * Tags the probes that actually ran.
 *
 * A recorded journey is the only execution the studio can prove today, so a
 * capture with steps supports `executed`; everything else stays statically
 * evidenced and `resolveCeiling` records the missing grant.
 */
/**
 * A native binary without a trace probe may only claim `inferred-only` (spec §4,
 * Task 20): nothing observed its behaviour, so the run does not ask for more and
 * every claim in the package carries that ceiling.
 */
function nativeRequestedCeiling(built) {
  return built?.target?.platform === "native" ? "inferred-only" : undefined;
}

function probesFor(kind, built) {
  const tags = [];
  if (kind === "web" && (built?.behavior?.steps?.length ?? 0) > 0) {
    tags.push("journey-executed");
  }
  return tags.map((tag) => ({ id: tag, tags: [tag] }));
}

/**
 * Coverage is a projection of the gate, never a threshold: a package is only
 * `belegt` when the gate accepted it and the ledger closed at ratio 1.
 */
export function coverageStatus(result) {
  if (!result?.ok || (result.violations ?? []).length > 0) return "offen";
  return result.coverage === 1 ? "belegt" : "teilweise";
}

/**
 * Turns the gate result into the completeness block the document renders.
 *
 * `status` and `gaps` come from the violations; the probe rows stay as
 * informational checks so a reader still sees what was looked at.
 */
function projectCompleteness(probe, result) {
  const status =
    result.ok && result.coverage === 1
      ? "complete"
      : result.ok
        ? "partial"
        : "insufficient";
  return {
    ...probe,
    status,
    score: Math.round((result.coverage ?? 0) * 100),
    passed: (probe.checks ?? []).filter((check) => check.ok).length,
    gaps: result.violations.map((violation) => ({
      id: violation.code,
      label: violation.subject,
      why: violation.detail,
      action:
        "Beleg oder ausführbare Abnahmeprüfung ergänzen und die Blaupause neu erzeugen.",
    })),
  };
}

export async function buildBlueprint(config) {
  const ctx = createContext(config);
  ctx.id = `bp-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  ctx.dir = join(ctx.artifactsDir, "blueprints", ctx.id);
  await mkdir(ctx.dir, { recursive: true });
  progress(
    ctx,
    "prepare",
    "Blaupause wird vorbereitet",
    "Ziel und Beweise werden geprüft.",
    6,
  );

  let built;
  try {
    if (ctx.kind === "web") built = await buildWeb(ctx);
    else if (ctx.kind === "apk") built = await buildApk(ctx);
    else built = await buildCode(ctx);
  } catch (error) {
    await rm(ctx.dir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  const target = built.target || (await fileTarget(ctx));
  const analysis = toAnalysis(built, {
    kind: ctx.kind,
    target: ctx.target,
    probes: probesFor(ctx.kind, built),
    evidence: ctx.evidence,
    warnings: ctx.warnings,
    limits: ctx.limits,
    openQuestions: ctx.openQuestions,
    producedAt: ctx.generatedAt,
    requestedCeiling: config.requestedCeiling ?? nativeRequestedCeiling(built),
    generator: { name: "REA Studio", command: config.reaVersion || "rea" },
  });
  analysis.source_included = ctx.includeSources;
  analysis.target = target;
  analysis.omitted = [...(ctx.bundle.omitted ?? [])];
  analysis.bundle = {
    files: ctx.bundle.entries.length + 8,
    bytes_raw: ctx.bundle.rawBytes,
    bytes_compressed: ctx.bundle.compressedBytes,
  };

  const compiled = compile(analysis);
  const bp = compiled.blueprint;

  const ledger = compiled.ledger;
  progress(
    ctx,
    "verify",
    "Vollständigkeit wird geprüft",
    "Ledger, Behauptungen, Belege und Abnahmekriterien werden gegen den Zieltyp geprüft.",
    86,
  );
  const probe = evaluateCompleteness(bp, compiled.prompt, ctx, {
    "BLUEPRINT.md": compiled.markdown,
    "AGENT-PROMPT.md": compiled.prompt,
  });
  const firstGate = gate(bp, ledger, compiled.acceptance, {
    targetClass: ctx.kind,
    files: [
      ...ctx.bundle.entries.map((entry) => entry.name),
      "BLUEPRINT.md",
      "AGENT-PROMPT.md",
      "blueprint.json",
      "ledger.json",
      "acceptance.json",
      "MANIFEST.json",
      "README.txt",
    ],
    omitted: [...(ctx.bundle.omitted ?? [])],
  });
  bp.completeness = projectCompleteness(probe, firstGate);
  bp.coverage.status = coverageStatus(firstGate);
  bp.coverage.ratio = ledger.closure.ratio;
  bp.coverage.open_points = firstGate.violations.length;

  progress(
    ctx,
    "write",
    "Blaupause wird geschrieben",
    "Die Dokumente und das Agenten-Briefing entstehen.",
    90,
  );
  const markdown = renderMarkdown({ blueprint: bp, claims: compiled.claims });
  const prompt = renderPrompt({ blueprint: bp, claims: compiled.claims });

  ctx.bundle.addData("BLUEPRINT.md", markdown);
  ctx.bundle.addData("AGENT-PROMPT.md", prompt);
  ctx.bundle.addData("blueprint.json", JSON.stringify(bp, null, 2));
  ctx.bundle.addData(
    "README.txt",
    [
      "REA Studio — Blaupause",
      "",
      "BLUEPRINT.md      Der vollständige Bauplan (zuerst lesen).",
      "AGENT-PROMPT.md   Fertiger Auftrag zum Kopieren in einen Coding-Agenten.",
      "blueprint.json    Dieselben Fakten maschinenlesbar.",
      "ledger.json       Abschluss-Ledger: Nenner, Einträge, Coverage.",
      "acceptance.json   Ausführbare Abnahmeprüfungen (http, dom, structure, …).",
      "MANIFEST.json     Jede Datei mit Größe und SHA-256.",
      "schemas/          JSON-Schemas für Behauptungen, Ledger und Manifest.",
      "evidence/         Aufnahmen, Analysen und Werkzeugergebnisse.",
      "source/           Exportierte Skripte oder dekompilierter Code.",
      "surface/          DOM, Screenshot, Manifest, Ressourcen.",
      "",
      "Behauptungen stehen in BLUEPRINT.md, Abschnitt 5-7; Abnahmekriterien in Abschnitt 8, offene Punkte in Abschnitt 9.",
    ].join("\n"),
  );

  for (const schema of ["claims", "ledger", "manifest"]) {
    ctx.bundle.addData(
      `schemas/${schema}.schema.json`,
      await readFile(
        new URL(`./blueprint/schemas/${schema}.schema.json`, import.meta.url),
        "utf8",
      ),
    );
  }

  const ledgerText = `${JSON.stringify(ledger, null, 2)}\n`;
  ctx.bundle.addData("ledger.json", ledgerText);
  const acceptanceText = `${JSON.stringify(compiled.acceptance, null, 2)}\n`;
  ctx.bundle.addData("acceptance.json", acceptanceText);
  const gateReport = firstGate.ok
    ? null
    : {
        schema: "rea.blueprint.gate-report",
        schema_version: 1,
        ok: firstGate.ok,
        status: firstGate.status,
        coverage: firstGate.coverage,
        violations: firstGate.violations,
      };
  const gateReportText = gateReport
    ? `${JSON.stringify(gateReport, null, 2)}\n`
    : null;
  if (gateReportText) ctx.bundle.addData("GATE-REPORT.json", gateReportText);

  const packageFiles = {};
  for (const entry of ctx.bundle.entries) {
    const bytes = bundleEntryBuffer(ctx, entry.name);
    if (bytes) packageFiles[entry.name] = bytes;
  }
  const manifest = buildManifest({
    files: packageFiles,
    ceiling: bp.ceiling.ceiling,
    compiler: COMPILER_ID,
    analysis_digest: analysisDigest(analysis),
    produced_at: ctx.generatedAt,
  });
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  ctx.bundle.addData("MANIFEST.json", manifestText);

  // Second pass over the packaged bytes: the render and manifest checks need
  // the documents that were just assembled. Both are structurally satisfied
  // here, so a difference means the pipeline is inconsistent and the package is
  // refused instead of being written with a contradiction.
  const secondGate = gate(bp, ledger, compiled.acceptance, {
    targetClass: ctx.kind,
    files: [...Object.keys(packageFiles), "MANIFEST.json"],
    omitted: [...(ctx.bundle.omitted ?? [])],
    manifest,
    markdown,
    renderMarkdown: () =>
      renderMarkdown({ blueprint: bp, claims: compiled.claims }),
    readFile: (path) =>
      path === "MANIFEST.json" ? Buffer.from(manifestText) : packageFiles[path],
  });
  if (
    JSON.stringify(secondGate.violations) !==
    JSON.stringify(firstGate.violations)
  ) {
    await rm(ctx.dir, { recursive: true, force: true }).catch(() => {});
    throw new Error(
      "blueprint gate did not converge over the packaged documents; refusing to write an inconsistent package",
    );
  }
  if (!secondGate.ok && config.allowIncomplete !== true) {
    await rm(ctx.dir, { recursive: true, force: true }).catch(() => {});
    throw new BlueprintGateError(secondGate);
  }

  // The directory is the package: every manifest entry is written here too, so a
  // reader that verifies `result.dir` sees the same bytes as the zip. Writing only
  // the documents left README.txt and the evidence files in the archive alone, and
  // a manifest check against the directory then reported a mismatch that was real.
  for (const [name, bytes] of Object.entries(packageFiles)) {
    const full = join(ctx.dir, name);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, bytes);
  }
  await writeFile(join(ctx.dir, "MANIFEST.json"), manifestText, "utf8");

  progress(
    ctx,
    "zip",
    "Paket wird gepackt",
    "Alle Dateien werden zu einer herunterladbaren ZIP-Datei gebündelt.",
    94,
  );
  const zip = ctx.bundle.toBuffer();
  const zipName = `${slug(target.name || ctx.kind)}-blueprint.zip`;
  const zipPath = join(ctx.dir, zipName);
  await writeFile(zipPath, zip);
  progress(
    ctx,
    "done",
    "Blaupause ist fertig",
    "Download und Agentenauftrag stehen bereit.",
    100,
  );

  return {
    ok: true,
    id: ctx.id,
    blueprintId: bp.id,
    analysisId: analysis.id,
    manifest,
    kind: ctx.kind,
    target: target.name,
    createdAt: ctx.generatedAt,
    dir: ctx.dir,
    zipPath,
    zipBytes: zip.length,
    markdown,
    prompt,
    blueprint: bp,
    ledger,
    violations: secondGate.violations,
    gate: {
      ok: secondGate.ok,
      status: secondGate.status,
      coverage: secondGate.coverage,
    },
    counts: {
      surface: Object.keys(bp.surface || {}).length,
      behavior: Object.keys(bp.behavior || {}).length,
      internals: Object.keys(bp.internals || {}).length,
      openQuestions: bp.open_questions.length,
      evidence: bp.evidence.length,
    },
    downloadPath: zipPath,
  };
}

async function collectRea(ctx, args, options) {
  try {
    const result = await ctx.runRea(args, options);
    const payload = parseJson(result.stdout);
    const normalized = normalizeRecord(payload);
    if (!result.ok) {
      ctx.warnings.push({
        operation: args[0],
        message:
          payload?.message ||
          payload?.error?.message ||
          result.stderr?.trim() ||
          `Exit ${result.exitCode}`,
      });
    }
    return { result, payload, normalized };
  } catch (error) {
    ctx.warnings.push({
      operation: args[0],
      message: error instanceof Error ? error.message : String(error),
    });
    return { result: null, payload: null, normalized: null };
  }
}

async function listFiles(root, filter = () => true, limit = 5000) {
  const result = [];
  if (!root || !existsSync(root)) return result;
  const walk = async (directory, depth) => {
    if (result.length >= limit || depth > 24) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (result.length >= limit) return;
      const full = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (["node_modules", ".git", "dist", "build"].includes(entry.name))
          continue;
        await walk(full, depth + 1);
      } else if (entry.isFile() && filter(full)) {
        result.push(full.slice(root.length + 1).replaceAll("\\", "/"));
      }
    }
  };
  await walk(root, 0);
  return result;
}

function intentEntries(components) {
  return components
    .filter(
      (item) =>
        (item.actions || []).length > 0 || (item.categories || []).length > 0,
    )
    .map((item) => ({
      component: item.name,
      actions: item.actions || [],
      categories: item.categories || [],
    }));
}

async function buildApk(ctx) {
  const target = ctx.target;
  if (!target || !existsSync(target)) {
    throw Object.assign(new Error("Die APK wurde nicht gefunden."), {
      statusCode: 400,
    });
  }
  const targetInfo = await stat(target);
  if (!targetInfo.isFile()) {
    throw Object.assign(
      new Error("Bitte eine APK-Datei auswählen, keinen Ordner."),
      {
        statusCode: 400,
      },
    );
  }
  const meta = await fileTarget(ctx);
  meta.platform = "android";

  progress(
    ctx,
    "collect",
    "APK wird gelesen",
    "Manifest, Signatur, Klassen und Ressourcen werden erhoben.",
    18,
  );
  const packageResult = await collectRea(
    ctx,
    ["inspect-android-package", target, "--format", "json"],
    { timeoutMs: 300_000, maxBytes: 24 * 1024 * 1024 },
  );
  if (!packageResult.normalized) {
    throw Object.assign(
      new Error(
        packageResult.payload?.message ||
          "Die APK konnte nicht gelesen werden. Prüfe die Datei und versuche es erneut.",
      ),
      { statusCode: 422 },
    );
  }
  // Store the already parsed result without re-reading the tool output.
  ctx.bundle.addData(
    "evidence/apk-package.json",
    JSON.stringify(packageResult.payload, null, 2),
  );
  ctx.evidence.push({
    role: "APK-Manifest und Komponenten",
    path: "evidence/apk-package.json",
    source: null,
    bytes: Buffer.byteLength(JSON.stringify(packageResult.payload)),
    sha256: sha256(JSON.stringify(packageResult.payload)),
  });

  progress(
    ctx,
    "collect",
    "Signatur und Klassen werden geprüft",
    "Signaturschemata und das vollständige Klasseninventar werden gelesen.",
    34,
  );
  const signatureResult = await collectRea(
    ctx,
    ["inspect-apk-signature", target, "--format", "json"],
    { timeoutMs: 120_000, maxBytes: 8 * 1024 * 1024 },
  );
  const classResult = await collectRea(
    ctx,
    ["search-android-classes", target, "", "--format", "json"],
    { timeoutMs: 300_000, maxBytes: 24 * 1024 * 1024 },
  );
  const resourceResult = await collectRea(
    ctx,
    ["decode-android-resources", target, "--format", "json"],
    { timeoutMs: 300_000, maxBytes: 24 * 1024 * 1024 },
  );

  for (const [role, result, name] of [
    ["APK-Signatur", signatureResult, "apk-signature.json"],
    ["Android-Klasseninventar", classResult, "apk-classes.json"],
    ["Android-Ressourcen und Strings", resourceResult, "apk-resources.json"],
  ]) {
    if (!result?.payload) continue;
    const serialized = JSON.stringify(result.payload, null, 2);
    ctx.bundle.addData(`evidence/${name}`, serialized);
    ctx.evidence.push({
      role,
      path: `evidence/${name}`,
      source: null,
      bytes: Buffer.byteLength(serialized),
      sha256: sha256(serialized),
    });
  }

  const pkg = packageResult.normalized;
  const packageName = pkg.package_name || "";
  const components = Array.isArray(pkg.components?.items)
    ? pkg.components.items
    : [];
  const normalizedComponents = components.map((item) => ({
    kind: item.kind || "component",
    name: item.name || item.declared_name || "?",
    exported: Boolean(item.exported),
    exported_default: Boolean(item.exported_default),
    permission: item.permission || null,
    actions: Array.isArray(item.actions) ? item.actions : [],
    categories: Array.isArray(item.categories) ? item.categories : [],
    intent_filter_count: item.intent_filter_count || 0,
  }));
  const byKind = { activity: [], service: [], receiver: [], provider: [] };
  for (const item of normalizedComponents) {
    (byKind[item.kind] || (byKind[item.kind] = [])).push(item);
  }
  const launcher =
    normalizedComponents.find(
      (item) =>
        item.kind === "activity" &&
        item.actions.includes("android.intent.action.MAIN") &&
        item.categories.includes("android.intent.category.LAUNCHER"),
    ) ||
    normalizedComponents.find(
      (item) =>
        item.kind === "activity" &&
        item.actions.includes("android.intent.action.MAIN"),
    );

  const allClasses = Array.isArray(classResult.normalized?.matches)
    ? classResult.normalized.matches
    : [];
  const appClasses = packageName
    ? allClasses.filter((name) => name.startsWith(`${packageName}.`))
    : allClasses;
  const classGroups = countBy(
    appClasses.map((name) => name.split(".").slice(0, 4).join(".")),
    (item) => item,
  ).slice(0, 40);
  const notableClasses = appClasses
    .filter((name) =>
      /(Activity|Service|Receiver|Provider|Application|Fragment|Adapter|ViewModel|Repository|UseCase)$/i.test(
        name,
      ),
    )
    .slice(0, 200);
  if (allClasses.length > 0) {
    ctx.bundle.addData("internals/classes.txt", `${allClasses.join("\n")}\n`);
  }

  const resources = resourceResult.normalized || {};
  const strings = Array.isArray(resources.strings) ? resources.strings : [];
  const locales = (resources.locales || []).map(
    (locale) => locale.locale || locale.name || String(locale),
  );
  if (strings.length > 0) {
    ctx.bundle.addData(
      "surface/strings.json",
      JSON.stringify(strings, null, 2),
    );
  }
  if (resources.manifest) {
    ctx.bundle.addData("surface/AndroidManifest.xml", resources.manifest);
  } else if (pkg.manifest?.text) {
    ctx.bundle.addData("surface/AndroidManifest.xml", pkg.manifest.text);
  }

  let resourceTreeFiles = 0;
  let resourceTreeBytes = 0;
  let layoutFiles = [];
  let drawableFiles = [];
  let nativeLibs = [];
  let assets = [];
  let sourceFiles = 0;
  let sourceBytes = 0;
  let sourceOmitted = 0;
  let jadxErrors = 0;
  let smaliFallbackFiles = 0;
  let smaliFiles = 0;
  let smaliClassSet = new Set();
  let smaliPathByClass = new Map();
  let androidAnalysis = null;

  if (ctx.includeSources) {
    progress(
      ctx,
      "surface",
      "Ressourcen werden dekodiert",
      "Layouts, Bilder, Themes und Manifest werden für den Nachbau übernommen.",
      52,
    );
    const apkOut = join(ctx.dir, ".apktool");
    {
      const decoded = await ctx.runProcess(
        "apktool",
        ["d", "-f", "-o", apkOut, target],
        { timeoutMs: 300_000, maxBytes: 4 * 1024 * 1024 },
      );
      if (existsSync(apkOut)) {
        const resStats = await ctx.bundle.addTree(
          "surface/android/res",
          join(apkOut, "res"),
          {
            maxBytes: 30 * 1024 * 1024,
            maxFiles: 5000,
          },
        );
        resourceTreeFiles = resStats.files;
        resourceTreeBytes = resStats.bytes;
        sourceOmitted += resStats.omitted;
        layoutFiles = await listFiles(join(apkOut, "res"), (path) =>
          /\/layout[^/]*\/.*\.xml$/i.test(path),
        );
        drawableFiles = await listFiles(join(apkOut, "res"), (path) =>
          /\/drawable[^/]*\//i.test(path),
        );
        nativeLibs = await listFiles(join(apkOut, "lib"), () => true, 200);
        assets = await listFiles(join(apkOut, "assets"), () => true, 200);
        const smaliPaths = await listFiles(
          apkOut,
          (path) => /(?:^|\/)smali(?:_classes\d+)?\/.*\.smali$/i.test(path),
          10000,
        );
        smaliFiles = smaliPaths.length;
        smaliClassSet = new Set(
          smaliPaths.map(smaliClassFromPath).filter(Boolean),
        );
        smaliPathByClass = new Map(
          smaliPaths
            .map((rel) => [smaliClassFromPath(rel), join(apkOut, rel)])
            .filter(([className]) => Boolean(className)),
        );
        const smaliStats = await ctx.bundle.addTree(
          "source/smali-app",
          apkOut,
          {
            maxBytes: 12 * 1024 * 1024,
            maxFiles: 1400,
            allow: (path) =>
              /\/io\/appium\//.test(path) &&
              /(?:^|\/)smali(?:_classes\d+)?\/.*\.smali$/i.test(path),
          },
        );
        sourceOmitted += smaliStats.omitted;
        for (const name of ["AndroidManifest.xml", "apktool.yml"]) {
          if (!existsSync(join(apkOut, name))) continue;
          await ctx.bundle.addFile(
            `surface/android/${name}`,
            join(apkOut, name),
          );
        }
        const assetStats = await ctx.bundle.addTree(
          "surface/android/assets",
          join(apkOut, "assets"),
          {
            maxBytes: 15 * 1024 * 1024,
            maxFiles: 1000,
          },
        );
        resourceTreeFiles += assetStats.files;
        resourceTreeBytes += assetStats.bytes;
        sourceOmitted += assetStats.omitted;
        if (nativeLibs.length > 0) {
          ctx.bundle.addData(
            "surface/android/native-libs.txt",
            `${nativeLibs.join("\n")}\n`,
          );
        }
      } else if (!decoded.ok) {
        ctx.warnings.push({
          operation: "apktool",
          message:
            decoded.stderr?.trim() ||
            "Ressourcen konnten nicht dekodiert werden.",
        });
      }
    }

    progress(
      ctx,
      "internals",
      "Java-Code wird dekompiliert",
      "JADX schreibt die Klassen als lesbare Java-Quellen in das Paket.",
      68,
    );
    const jadxOut = join(ctx.dir, ".jadx");
    try {
      const decoded = await ctx.runProcess(
        "jadx",
        ["-d", jadxOut, "--no-res", "--threads-count", "2", target],
        { timeoutMs: 300_000, maxBytes: 4 * 1024 * 1024 },
      );
      const combined = `${decoded.stdout || ""}\n${decoded.stderr || ""}`;
      const errorMatch = /finished with errors,\s*count:\s*(\d+)/i.exec(
        combined,
      );
      jadxErrors = errorMatch ? Number(errorMatch[1]) : 0;
      if (existsSync(jadxOut)) {
        const stats = await ctx.bundle.addTree("source/java", jadxOut, {
          maxBytes: 40 * 1024 * 1024,
          maxFiles: 6000,
          allow: (path) => path.endsWith(".java"),
        });
        sourceFiles = stats.files;
        sourceBytes = stats.bytes;
        sourceOmitted += stats.omitted;
        androidAnalysis = await analyzeAndroidSource(join(jadxOut, "sources"), {
          packageName,
          strings,
          activityCount: (byKind.activity || []).length,
          jadxErrors,
          smaliFiles,
          smaliClasses: smaliClassSet,
          sourcePrefix: "source/java/sources",
        });
        await addBuffer(
          ctx,
          "Android-Fehler-, Ablauf- und Dekompilierungsanalyse",
          "evidence/apk-error-analysis.json",
          Buffer.from(JSON.stringify(androidAnalysis, null, 2), "utf8"),
        );
        for (const errorFile of androidAnalysis.decompiler.error_files) {
          const smaliPath = smaliPathByClass.get(errorFile.class_path);
          if (!smaliPath || !existsSync(smaliPath)) continue;
          await ctx.bundle.addFile(
            `source/smali-fallback/${errorFile.class_path}.smali`,
            smaliPath,
          );
          smaliFallbackFiles += 1;
        }
        await rm(apkOut, { recursive: true, force: true }).catch(() => {});
      } else if (!decoded.ok) {
        ctx.warnings.push({
          operation: "jadx",
          message:
            decoded.stderr?.trim() ||
            "Java-Code konnte nicht dekompiliert werden.",
        });
      }
    } finally {
      await rm(jadxOut, { recursive: true, force: true }).catch(() => {});
    }
  } else {
    ctx.limits.push(
      "Quellcode und dekodierte Ressourcen waren für dieses Paket abgeschaltet.",
    );
  }

  const signature = signatureResult.normalized || {};
  const schemeNames = Object.entries(signature.schemes || {})
    .filter(([, value]) => value?.present)
    .map(([name]) => name);
  const signer = signature.schemes?.v2?.signers?.[0]?.certificate || null;
  const surface = {
    package_name: packageName,
    version_name: pkg.version_name || null,
    version_code: pkg.version_code || null,
    min_sdk: pkg.min_sdk || resources.metadata?.min_sdk_version || null,
    target_sdk:
      pkg.target_sdk || resources.metadata?.target_sdk_version || null,
    class_count: pkg.class_count ?? allClasses.length,
    app_class_count: appClasses.length,
    resource_count: pkg.resource_count ?? resources.decoded_file_count ?? null,
    launcher_activity: launcher?.name || null,
    components: byKind,
    permissions: Array.isArray(pkg.permissions) ? pkg.permissions : [],
    signature: {
      schemes: schemeNames,
      signer_subject: signer?.subject || null,
      signer_sha256: signer?.sha256_fingerprint || null,
    },
    string_count: strings.length,
    strings_sample: strings.slice(0, 30).map((item) => ({
      name: item.name || "?",
      value: text(item.value || "", 300),
    })),
    locales,
    layout_files: layoutFiles,
    drawable_files: drawableFiles,
    resource_tree_files: resourceTreeFiles,
    resource_tree_bytes: resourceTreeBytes,
  };
  const android = androidAnalysis || {
    error_paths: [],
    screens: {
      activities: (byKind.activity || []).length,
      layouts: [],
      navigation_calls: 0,
      fragments: 0,
    },
    data_flow: { urls: [], servers: [], databases: [], storage: [] },
    files: 0,
    app_files: 0,
    decompiler: {
      reported_errors: jadxErrors,
      error_files: [],
      missing_smali: [],
      app_error_files: 0,
      smali_files: smaliFiles,
      smali_classes: smaliClassSet.size,
    },
  };
  const behavior = {
    activities: (byKind.activity || []).map((item) => ({ name: item.name })),
    exported: normalizedComponents
      .filter((item) => item.exported)
      .map((item) => ({ kind: item.kind, name: item.name })),
    intents: intentEntries(normalizedComponents),
    error_paths: android.error_paths,
    messages: [
      ...new Set(android.error_paths.flatMap((item) => item.messages || [])),
    ].slice(0, 160),
    screens: android.screens,
    data_flow: android.data_flow,
  };
  const internals = {
    app_class_count: appClasses.length,
    class_groups: classGroups,
    notable_classes: notableClasses,
    source: {
      included: sourceFiles > 0,
      files: sourceFiles,
      bytes: sourceBytes,
      omitted: sourceOmitted,
    },
    error_analysis: {
      files: android.files,
      app_files: android.app_files,
      error_paths: android.error_paths.length,
      messages: behavior.messages.length,
      screens: android.screens,
      data_flow: {
        urls: android.data_flow.urls.length,
        servers: android.data_flow.servers.length,
        databases: android.data_flow.databases.length,
        storage: android.data_flow.storage.length,
      },
    },
    decompile: android.decompiler,
    smali: {
      files: smaliFiles,
      classes: smaliClassSet.size,
      fallback_files: smaliFallbackFiles,
    },
    jadx_errors: jadxErrors,
    native_libs: nativeLibs,
    assets,
    manifest_limitations: pkg.components?.limitations || [],
  };

  return {
    target: meta,
    coverage: [
      "Manifest und Komponenten",
      "Berechtigungen und Signatur",
      "Klasseninventar",
      strings.length > 0 ? "Ressourcen und Strings" : null,
      sourceFiles > 0 ? "Dekompilierter Java-Code" : null,
      smaliFiles > 0 ? "Smali-Alternativbeleg" : null,
      layoutFiles.length > 0 ? "Layouts und Drawables" : null,
      android.error_paths.length > 0 ? "Fehler- und Randfälle" : null,
    ].filter(Boolean),
    surface,
    behavior,
    internals,
    data: {
      databases_observed: android.data_flow.databases.length > 0,
      shared_preferences_observed: android.data_flow.storage.length > 0,
      servers_observed:
        android.data_flow.servers.length > 0 ||
        android.data_flow.urls.length > 0,
      assets,
    },
    dependencies: [
      `Android SDK ${surface.min_sdk || "?"}–${surface.target_sdk || "?"}`,
      ...(appClasses.some((name) => name.includes("androidx.compose"))
        ? ["Jetpack Compose"]
        : []),
      ...(nativeLibs.some((name) => /flutter/i.test(name)) ? ["Flutter"] : []),
      ...(nativeLibs.some((name) => /reactnative|hermes/i.test(name))
        ? ["React Native"]
        : []),
    ],
    reconstruction: apkPlan(surface),
    acceptance: [
      "Die neu gebaute APK lässt sich installieren und startet über die Launcher-Activity.",
      "Paketname, Version, minSdk und targetSdk stimmen mit der Vorlage überein.",
      "Alle im Manifest genannten Activities, Services, Receiver und Provider sind vorhanden und auflösbar.",
      "Berechtigungen und exportierte Komponenten entsprechen der Vorlage.",
      "Die im Paket enthaltenen Layouts, Strings und Themes sind vollständig übernommen.",
      "Die Kernabläufe der App funktionieren ohne Absturz.",
      "Die belegten Fehler-, Status- und Berechtigungspfade liefern dieselben Meldungen.",
    ],
  };
}

function apkPlan(surface) {
  return [
    {
      step: 1,
      title: "Android-Projektgerüst anlegen",
      goal: `Ein Gradle-Projekt mit Paketname ${surface.package_name || "(Paketname)"}, minSdk ${surface.min_sdk || "?"} und targetSdk ${surface.target_sdk || "?"} erstellen.`,
      inputs: ["evidence/apk-package.json"],
      outputs: ["settings.gradle", "build.gradle", "AndroidManifest.xml"],
      checks: ["Projekt baut", "Paketname stimmt"],
    },
    {
      step: 2,
      title: "Manifest und Komponenten übernehmen",
      goal: "Activities, Services, Receiver, Provider, Intents und Berechtigungen aus der Vorlage abbilden.",
      inputs: ["surface/AndroidManifest.xml", "evidence/apk-package.json"],
      outputs: ["Manifest", "Komponentenklassen"],
      checks: [
        "Alle Komponenten sind deklariert",
        "Export- und Permission-Flags stimmen",
      ],
    },
    {
      step: 3,
      title: "Ressourcen und Designsystem rekonstruieren",
      goal: "Layouts, Drawables, Farben, Themes und Strings aus dem dekodierten Ressourcenbaum übernehmen.",
      inputs: ["surface/android/res/", "surface/strings.json"],
      outputs: ["res/layout", "res/values", "res/drawable"],
      checks: ["Alle Layouts sind vorhanden", "Strings und Locales stimmen"],
    },
    {
      step: 4,
      title: "Screens und Navigation bauen",
      goal: "Jede Activity als Screen umsetzen und die belegten Übergänge sowie Intents verbinden.",
      inputs: ["source/java/", "surface/AndroidManifest.xml"],
      outputs: ["Activity-Klassen", "Navigation"],
      checks: ["Jeder Screen startet", "Launcher führt zur Startansicht"],
    },
    {
      step: 5,
      title: "Fachlogik und Datenzugriff übertragen",
      goal: "Die dekompilierten Klassen in eine lesbare Architektur überführen und Netzwerk-, Datenbank- und Präferenzzugriffe nachbauen.",
      inputs: ["source/java/", "internals/class_groups"],
      outputs: ["Domain-Modelle", "Repositories", "API-Client"],
      checks: ["Kernabläufe funktionieren", "Fehlerzustände sind behandelt"],
    },
    {
      step: 6,
      title: "Hintergrundkomponenten und native Teile",
      goal: "Services, Receiver, Provider und native Bibliotheken einbinden.",
      inputs: ["source/java/", "surface/android/native-libs.txt"],
      outputs: ["Services", "Receiver", "native Libraries"],
      checks: ["Komponenten starten ohne Absturz"],
    },
    {
      step: 7,
      title: "Signieren und gegen die Vorlage prüfen",
      goal: "Die App mit einem eigenen Schlüssel signieren und die Abnahmekriterien prüfen.",
      inputs: ["alle vorherigen Schritte"],
      outputs: ["signierte APK", "Abgleichsbericht"],
      checks: [
        "Installation gelingt",
        "Manifest-Diff ist leer",
        "Screens entsprechen der Vorlage",
      ],
    },
  ];
}

async function buildCode(ctx) {
  const codeKind = ctx.input.codeKind || "other";
  if (codeKind === "native") return buildNative(ctx);
  if (codeKind === "javascript" || codeKind === "directory") {
    return buildJavascript(ctx);
  }
  return buildGeneric(ctx);
}

async function buildJavascript(ctx) {
  const target = ctx.target;
  if (!target || !existsSync(target)) {
    throw Object.assign(new Error("Der Pfad wurde nicht gefunden."), {
      statusCode: 400,
    });
  }
  const meta = await fileTarget(ctx);
  meta.platform = "javascript";
  const targetInfo = await stat(target);
  progress(
    ctx,
    "collect",
    "JavaScript wird analysiert",
    "Module, Funktionen, Routen, IPC und Endpunkte werden statisch rekonstruiert.",
    24,
  );
  const evidencePath = join(ctx.dir, "js-analysis-evidence.json");
  let analysisTarget = target;
  let analysisTemp = null;
  if (targetInfo.isFile()) {
    analysisTemp = await mkdtemp(join(tmpdir(), "rea-js-file-"));
    await copyFile(target, join(analysisTemp, basename(target)));
    analysisTarget = analysisTemp;
  }
  let result;
  let analysis;
  try {
    result = await collectRea(
      ctx,
      [
        "analyze-javascript-application",
        analysisTarget,
        "--format",
        "json",
        "--detail",
        "summary",
        "--evidence_output",
        evidencePath,
      ],
      { timeoutMs: 600_000, maxBytes: 32 * 1024 * 1024 },
    );
    analysis = result.normalized;
    if (existsSync(evidencePath)) {
      const stored = await addJson(
        ctx,
        "JavaScript-Anwendungsgraph (vollständige Evidenz)",
        evidencePath,
        "js-analysis.json",
      );
      analysis = stored ? normalizeRecord(stored.payload) : analysis;
      await rm(evidencePath, { force: true }).catch(() => {});
    }
  } finally {
    if (analysisTemp) {
      await rm(analysisTemp, { recursive: true, force: true }).catch(() => {});
    }
  }
  if (!analysis) {
    throw Object.assign(
      new Error(
        result.payload?.message ||
          "Die JavaScript-Anwendung konnte nicht analysiert werden. Prüfe den Pfad und die REA-Ausgabe.",
      ),
      { statusCode: 422 },
    );
  }

  if (ctx.includeSources) {
    progress(
      ctx,
      "source",
      "Quellen werden übernommen",
      "Die analysierten Anwendungsdateien kommen in das Paket.",
      54,
    );
    if (targetInfo.isDirectory()) {
      const stats = await ctx.bundle.addTree("source/app", target, {
        maxBytes: 30 * 1024 * 1024,
        maxFiles: 4000,
      });
      if (stats.omitted > 0) {
        ctx.limits.push(
          `${stats.omitted} Anwendungsdatei(en) wurden nicht aufgenommen.`,
        );
      }
    } else {
      await ctx.bundle.addFile(`source/app/${basename(target)}`, target);
    }
  }

  const staticAnalysis = await analyzeProjectSource(target, { maxFiles: 2500 });
  if (staticAnalysis.files.length > 0) {
    await addBuffer(
      ctx,
      "Statische JavaScript-Quellanalyse (Funktionen, Aufrufe, Fehler und Events)",
      "evidence/js-source-analysis.json",
      Buffer.from(JSON.stringify(staticAnalysis, null, 2), "utf8"),
    );
  }

  const summary = analysis.summary || {};
  const ipc = summary.ipc || {};
  const semantic = analysis.semantic_graph || {};
  const graph = analysis.graph || {};
  const nodes = Array.isArray(semantic.nodes) ? semantic.nodes : [];
  const relations = Array.isArray(semantic.relations) ? semantic.relations : [];
  const graphNodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const graphEdges = Array.isArray(graph.edges) ? graph.edges : [];
  const pick = (node) =>
    text(
      node.label ||
        node.properties?.name ||
        node.properties?.path ||
        node.identity?.module_path ||
        node.name ||
        "",
      240,
    );
  const nodesOf = (kind) =>
    nodes
      .filter((node) => node.kind === kind)
      .map((node) => ({
        name: pick(node),
        module: node.identity?.module_path || null,
        line: node.identity?.source_range?.start?.line ?? null,
      }))
      .filter((item) => item.name)
      .slice(0, 200);
  const routes = (analysis.route_inventory?.routes || []).map((route) => ({
    path: route.path || route.pattern || route.route || null,
    kind: route.kind || route.classification || null,
  }));
  const surface = {
    format:
      summary.format ||
      (ctx.input.codeKind === "directory" ? "directory" : "javascript"),
    routes,
    windows: summary.browser_windows ?? null,
    preload_entrypoints: summary.preload_entrypoints ?? null,
    utility_processes: summary.utility_processes ?? null,
    protocol_registrations: summary.protocol_registrations ?? null,
    exposed_api_members: summary.exposed_api_members ?? null,
    context_bridge_apis: summary.context_bridge_apis ?? null,
  };
  const behavior = {
    ipc,
    endpoints: nodesOf("request"),
    storage: nodesOf("storage"),
    static_functions: staticAnalysis.functions,
    static_calls: staticAnalysis.calls,
    static_errors: staticAnalysis.errors,
    exit_paths: staticAnalysis.exit_paths,
    static_events: staticAnalysis.events,
  };
  const internals = {
    statistics: analysis.statistics || null,
    semantic_graph: {
      nodes: nodes.length,
      relations: relations.length,
      by_kind: countBy(
        nodes.map((node) => node.kind || "unbekannt"),
        (item) => item,
      ),
      functions: nodesOf("function"),
      call_sites: nodesOf("call-site"),
      modules: nodesOf("module"),
      requests: nodesOf("request"),
      relations_by_kind: countBy(
        relations.map((relation) => relation.relation || "unbekannt"),
        (item) => item,
      ),
    },
    application_graph: {
      nodes: graphNodes.length,
      edges: graphEdges.length,
      by_kind: countBy(
        graphNodes.map((node) => node.kind || "unbekannt"),
        (item) => item,
      ),
      modules: graphNodes
        .filter((node) => node.kind === "javascript-module")
        .map((node) => ({
          name: pick(node),
          path: node.properties?.path || node.identity?.module_path || null,
        }))
        .filter((item) => item.name)
        .slice(0, 200),
    },
    routes,
    ipc,
    source_analysis: {
      files: staticAnalysis.files.length,
      functions: staticAnalysis.functions.length,
      calls: staticAnalysis.calls.length,
      errors: staticAnalysis.errors.length,
      exit_paths: staticAnalysis.exit_paths.length,
      events: staticAnalysis.events.length,
      coverage: staticAnalysis.coverage,
    },
  };

  const hasStaticRuntime =
    staticAnalysis.functions.length > 0 && staticAnalysis.calls.length > 0;
  if (!hasStaticRuntime) {
    openQuestion(
      ctx,
      "Welches Laufzeitverhalten zeigt die Anwendung?",
      "Module, Aufrufe und IPC sind statisch belegt; Startreihenfolge, Fehlerpfade und echte Nutzlasten wurden nicht ausgeführt.",
      "Die Anwendung in einer isolierten Umgebung starten und die belegten Kanäle und Routen durchspielen.",
      ["evidence/js-analysis.json"],
    );
  }
  if (
    staticAnalysis.errors.length === 0 &&
    staticAnalysis.exit_paths.length === 0
  ) {
    openQuestion(
      ctx,
      "Welche Fehler- und Randfälle sind belegt?",
      "Im Quellcode wurden keine Wurf-, Status- oder Exit-Pfade gefunden; Laufzeitfehler sind damit nicht nachweisbar.",
      "Fehlerpfade im Quellcode suchen oder die Anwendung mit ungültigen Eingaben starten und die Ausgaben dokumentieren.",
      ["evidence/js-source-analysis.json"],
    );
  }
  if (ipc.literal_channels > 0) {
    openQuestion(
      ctx,
      "Welche IPC-Kanäle sind tatsächlich erreichbar?",
      "Kanäle und Handler sind statisch erkannt; Renderer-Berechtigungen und Laufzeitprüfungen sind nicht beobachtet.",
      "Main- und Renderer-Prozess mit denselben Kanälen starten und Berechtigungsprüfungen testen.",
      ["evidence/js-analysis.json"],
    );
  }

  return {
    target: meta,
    coverage: [
      "Module und Anwendungsgraph",
      "Funktionen und Aufrufstellen",
      "Routen",
      ipc.literal_channels > 0 ? "IPC-Kanäle" : null,
      nodesOf("request").length > 0 ? "Statische Endpunkte" : null,
    ].filter(Boolean),
    surface,
    behavior,
    internals,
    data: { storage: nodesOf("storage") },
    dependencies: detectWebStack(analysis, ctx.input),
    reconstruction: jsPlan(),
    acceptance: [
      "Die Anwendung startet ohne fehlende Module.",
      "Die belegten Routen und Fenster sind erreichbar.",
      "Die IPC-Kanäle und ihre Berechtigungsprüfungen entsprechen der Vorlage.",
      "Die statisch erkannten Endpunkte werden mit denselben Methoden angesprochen.",
      "Der Anwendungsgraph enthält keine unaufgelösten Importe.",
    ],
  };
}

function jsPlan() {
  return [
    {
      step: 1,
      title: "Laufzeit und Projektgerüst anlegen",
      goal: "Node.js/Electron bzw. die erkannte Laufzeit mit denselben Einstiegspunkten aufsetzen.",
      inputs: ["evidence/js-analysis.json", "source/app/"],
      outputs: ["package.json", "Einstiegspunkt", "Build-Skript"],
      checks: ["Start gelingt", "Keine fehlenden Abhängigkeiten"],
    },
    {
      step: 2,
      title: "Module und Funktionen übertragen",
      goal: "Die belegten Module, Funktionen und Aufrufbeziehungen in eine lesbare Struktur überführen.",
      inputs: ["internals.semantic_graph", "source/app/"],
      outputs: ["Module", "Funktionen", "Tests"],
      checks: ["Alle belegten Module existieren", "Importe sind aufgelöst"],
    },
    {
      step: 3,
      title: "Oberfläche und Routen bauen",
      goal: "Fenster, Renderer-Einstiegspunkte und Routen aus der Analyse abbilden.",
      inputs: ["surface", "internals.routes"],
      outputs: ["Fenster", "Router", "Renderer"],
      checks: ["Fenster öffnen", "Routen rendern"],
    },
    {
      step: 4,
      title: "IPC und Sicherheitsgrenzen nachbauen",
      goal: "Kanäle, Handler, Preload-Bridges und Berechtigungsprüfungen übernehmen.",
      inputs: ["behavior.ipc", "source/app/"],
      outputs: ["IPC-Handler", "Preload", "Validierung"],
      checks: ["Kanäle funktionieren", "Fremde Renderer werden abgewiesen"],
    },
    {
      step: 5,
      title: "Daten, Endpunkte und Speicher anbinden",
      goal: "Statisch erkannte Endpunkte und Speicherzugriffe mit denselben Formen implementieren.",
      inputs: ["internals.semantic_graph.requests", "data.storage"],
      outputs: ["API-Client", "Persistenz"],
      checks: ["Requests stimmen überein", "Speicher-Schlüssel stimmen"],
    },
    {
      step: 6,
      title: "Gegen die Vorlage prüfen",
      goal: "Start, Routen, IPC und Endpunkte mit der Blaupause abgleichen.",
      inputs: ["alle vorherigen Schritte"],
      outputs: ["Abgleichsbericht"],
      checks: ["Keine fehlenden Kanäle", "Keine unerwarteten Requests"],
    },
  ];
}

async function buildNative(ctx) {
  const target = ctx.target;
  if (!target || !existsSync(target)) {
    throw Object.assign(new Error("Die Binärdatei wurde nicht gefunden."), {
      statusCode: 400,
    });
  }
  const info = await stat(target);
  if (!info.isFile()) {
    throw Object.assign(
      new Error("Bitte eine Binärdatei auswählen, keinen Ordner."),
      { statusCode: 400 },
    );
  }
  const meta = await fileTarget(ctx);
  meta.platform = "native";
  progress(
    ctx,
    "collect",
    "Binärdatei wird analysiert",
    "Ghidra erhebt Segmente, Funktionen und Einstiegspunkte.",
    20,
  );
  const analyze = await collectRea(
    ctx,
    ["analyze", target, "--format", "json"],
    { timeoutMs: 600_000, maxBytes: 24 * 1024 * 1024 },
  );
  const hardening = await collectRea(
    ctx,
    ["inspect-binary-hardening", target, "--format", "json"],
    { timeoutMs: 120_000, maxBytes: 8 * 1024 * 1024 },
  );
  const exportsResult = await collectRea(
    ctx,
    ["inspect-native-exports", target, "--format", "json"],
    { timeoutMs: 180_000, maxBytes: 16 * 1024 * 1024 },
  );
  for (const [role, result, name] of [
    ["Native Analyse", analyze, "native-analyze.json"],
    ["Härtungsmerkmale", hardening, "native-hardening.json"],
    ["Native Exporte", exportsResult, "native-exports.json"],
  ]) {
    if (!result?.payload) continue;
    const serialized = JSON.stringify(result.payload, null, 2);
    ctx.bundle.addData(`evidence/${name}`, serialized);
    ctx.evidence.push({
      role,
      path: `evidence/${name}`,
      source: null,
      bytes: Buffer.byteLength(serialized),
      sha256: sha256(serialized),
    });
  }

  const analysis = analyze.normalized || {};
  const exportData = exportsResult.normalized || {};
  const hardeningData = hardening.normalized || {};
  const procedureCount = Number(analysis.procedure_count) || 0;
  const pseudocode = {
    included: false,
    files: 0,
    bytes: 0,
    written: 0,
    selected: procedureCount,
    remaining: procedureCount,
    failures: 0,
    external: 0,
    external_names: [],
    sample: [],
  };
  if (ctx.includeSources) {
    progress(
      ctx,
      "internals",
      "Pseudocode wird erzeugt",
      "Ghidra schreibt die Funktionen als lesbaren C-Pseudocode.",
      56,
    );
    const outDir = join(ctx.dir, ".pseudocode");
    const limit = Math.max(1, Math.min(procedureCount || 80, 2000));
    const decompiled = await collectRea(
      ctx,
      [
        "decompile-all",
        target,
        "--output",
        outDir,
        "--limit",
        String(limit),
        "--format",
        "json",
      ],
      { timeoutMs: 900_000, maxBytes: 16 * 1024 * 1024 },
    );
    if (decompiled.normalized) {
      const counts = decompiled.normalized.counts || {};
      pseudocode.written = Number(counts.written) || 0;
      pseudocode.selected = Number(counts.selected) || procedureCount;
      pseudocode.remaining = Number(counts.remaining) || 0;
      pseudocode.failures = Number(counts.failed) || 0;
    }
    const decompileIndex = await readJson(join(outDir, "decompile-index.json"));
    if (Array.isArray(decompileIndex?.functions)) {
      const external = decompileIndex.functions.filter(
        (item) => item.status === "external",
      );
      pseudocode.external = external.length;
      pseudocode.external_names = external
        .slice(0, 40)
        .map((item) => item.name || item.address || "external");
    }
    if (existsSync(outDir)) {
      const stats = await ctx.bundle.addTree("internals/pseudocode", outDir, {
        maxBytes: 15 * 1024 * 1024,
        maxFiles: 2500,
      });
      pseudocode.included = stats.files > 0;
      pseudocode.files = stats.files;
      pseudocode.bytes = stats.bytes;
      if (pseudocode.included) {
        const names = await listFiles(
          outDir,
          (path) => path.endsWith(".c"),
          30,
        );
        pseudocode.sample = names;
      }
      if (stats.omitted > 0) {
        ctx.limits.push(
          `${stats.omitted} Pseudocode-Datei(en) wurden nicht aufgenommen.`,
        );
      }
      await rm(outDir, { recursive: true, force: true }).catch(() => {});
    } else if (!decompiled.ok) {
      ctx.warnings.push({
        operation: "decompile-all",
        message:
          decompiled.payload?.message ||
          "Pseudocode konnte nicht erzeugt werden.",
      });
    }
  }

  progress(
    ctx,
    "collect",
    "Fehler- und Exit-Pfade werden belegt",
    "Disassembly, PLT-Aufrufe und .rodata-Strings werden gegen Fehler- und Exit-Pfade geprüft.",
    72,
  );
  const nativeEvidence = await analyzeNativeErrorEvidence(ctx, target);
  await addBuffer(
    ctx,
    "Native Fehler-, Exit- und Stringanalyse",
    "evidence/native-error-analysis.json",
    Buffer.from(JSON.stringify(nativeEvidence, null, 2), "utf8"),
  );

  const exports = Array.isArray(exportData.exports) ? exportData.exports : [];
  const functionExports = exports.filter((item) => item.type === "function");
  const hardeningRows = [];
  for (const image of hardeningData.images || []) {
    for (const row of image.rows || []) {
      if (row.state === "enabled" || row.state === "disabled") {
        hardeningRows.push({
          property: row.property,
          state: row.state,
          basis: row.basis || null,
        });
      }
    }
  }
  const surface = {
    format:
      analysis.format || exportData.format || hardeningData.format || null,
    architecture: analysis.architecture || exportData.architecture || null,
    bits: exportData.bits ?? null,
    byte_order: exportData.byte_order || null,
    segments:
      Number(analysis.segment_count) || (analysis.segments || []).length,
    procedures: procedureCount,
    strings: Number(analysis.string_count) || 0,
    image_base: analysis.image_base || null,
  };
  const behavior = {
    exports: functionExports.slice(0, 200).map((item) => item.name),
    hardening: hardeningRows.slice(0, 40),
    cli: {
      usage: nativeEvidence.usage,
      help: nativeEvidence.help,
      exit_contract: nativeEvidence.exit_contract,
    },
    error_paths: nativeEvidence.error_paths,
    messages: nativeEvidence.messages.map((item) => item.message).slice(0, 120),
    calls: nativeEvidence.calls,
    exit_contract: nativeEvidence.exit_contract,
  };
  const internals = {
    pseudocode,
    disassembly: {
      available: nativeEvidence.disassembly_available,
      strings_available: nativeEvidence.strings_available,
      functions_seen: nativeEvidence.functions_seen,
      calls: nativeEvidence.calls.length,
      messages: nativeEvidence.messages.length,
      error_paths: nativeEvidence.error_paths.length,
      rodata_bytes: nativeEvidence.rodata_bytes,
      commands: nativeEvidence.commands,
      exit_codes: nativeEvidence.exit_codes,
    },
    observations: (exportData.issues || [])
      .slice(0, 40)
      .map((issue) => text(issue, 300)),
  };

  return {
    target: meta,
    coverage: [
      "Segmente und Einstiegspunkte",
      "Funktionsinventar",
      "Exporte",
      "Härtungsmerkmale",
      pseudocode.included ? "Pseudocode" : null,
      nativeEvidence.error_paths.length > 0 ? "Fehler- und Exit-Pfade" : null,
    ].filter(Boolean),
    surface,
    behavior,
    internals,
    data: { rodata_bytes: nativeEvidence.rodata_bytes },
    dependencies: [],
    reconstruction: nativePlan(surface),
    acceptance: [
      "Das neu gebaute Programm startet mit derselben Zielarchitektur.",
      "Die belegten Exporte sind mit denselben Namen und Signaturen vorhanden.",
      "Die Testmatrix aus Hilfe, gültigem Aufruf und Fehlaufruf liefert dieselben Ausgaben und Exit-Codes.",
      "Die Funktionen aus dem Pseudocode sind vollständig übertragen.",
      "Die belegten Fehlermeldungen und Exit-Codes stimmen mit der Vorlage überein.",
      "Das Programm läuft ohne Absturz und ohne unerwartete Datei- oder Netzwerkzugriffe.",
    ],
  };
}

function nativePlan(surface) {
  return [
    {
      step: 1,
      title: "Toolchain und Zielplattform festlegen",
      goal: `Ein Projekt für ${surface.architecture || "die belegte Architektur"} mit denselben Laufzeitannahmen aufsetzen.`,
      inputs: ["evidence/native-analyze.json", "evidence/native-exports.json"],
      outputs: ["Build-Dateien", "leeres Programm"],
      checks: ["Build läuft", "Zielarchitektur stimmt"],
    },
    {
      step: 2,
      title: "Öffentliche Schnittstelle nachbauen",
      goal: "Exporte, Einstiegspunkt und belegte Kommandozeilen-Funktionen mit denselben Namen bereitstellen.",
      inputs: ["behavior.exports", "evidence/native-exports.json"],
      outputs: ["Exporte", "Einstiegspunkt"],
      checks: ["Symbole stimmen", "Programm startet"],
    },
    {
      step: 3,
      title: "Funktionen aus dem Pseudocode übertragen",
      goal: "Die belegten Funktionen in lesbaren Quellcode überführen und dabei Datenstrukturen und Fehlerpfade erhalten.",
      inputs: ["internals/pseudocode/"],
      outputs: ["Quellmodule", "interne APIs"],
      checks: ["Alle vorhandenen Funktionen sind übertragen"],
    },
    {
      step: 4,
      title: "Daten und Zustände rekonstruieren",
      goal: "Globale Zustände, Dateiformate und Speicherlayout aus dem Code ableiten und nachbauen.",
      inputs: ["internals/pseudocode/", "evidence/native-analyze.json"],
      outputs: ["Datenmodelle", "Persistenz"],
      checks: ["Dateien und Zustände sind kompatibel"],
    },
    {
      step: 5,
      title: "Testmatrix und Abgleich",
      goal: "Hilfe, gültige Aufrufe und Fehlaufrufe gegen die Vorlage testen.",
      inputs: ["alle vorherigen Schritte"],
      outputs: ["Tests", "Abgleichsbericht"],
      checks: ["Ausgaben und Exit-Codes stimmen", "Keine Abstürze"],
    },
  ];
}

async function buildGeneric(ctx) {
  const target = ctx.target;
  if (!target || !existsSync(target)) {
    throw Object.assign(new Error("Der Pfad wurde nicht gefunden."), {
      statusCode: 400,
    });
  }
  const meta = await fileTarget(ctx);
  progress(
    ctx,
    "collect",
    "Artefakt wird geprüft",
    "Format, Inhalte und Struktur werden inventarisiert.",
    24,
  );
  const result = await collectRea(
    ctx,
    ["inspect-artifact", target, "--format", "json"],
    { timeoutMs: 300_000, maxBytes: 16 * 1024 * 1024 },
  );
  if (result.payload) {
    const serialized = JSON.stringify(result.payload, null, 2);
    ctx.bundle.addData("evidence/artifact-inspection.json", serialized);
    ctx.evidence.push({
      role: "Artefakt-Inventar",
      path: "evidence/artifact-inspection.json",
      source: null,
      bytes: Buffer.byteLength(serialized),
      sha256: sha256(serialized),
    });
  }
  const data = result.normalized || {};
  const observations = Array.isArray(data.observations)
    ? data.observations.map((item) =>
        text(item.summary || item.detail || item, 300),
      )
    : [];
  openQuestion(
    ctx,
    "Welche Funktion hat dieses Artefakt im Gesamtsystem?",
    "Das Format und der Inhalt sind inventarisiert, aber der beabsichtigte Laufzeitkontext ist nicht beobachtet.",
    "Das Artefakt in seiner Zielumgebung starten oder öffnen und die beobachteten Zustände ergänzen.",
    ["evidence/artifact-inspection.json"],
  );
  return {
    target: meta,
    coverage: ["Artefakt-Inventar"],
    surface: {
      format: data.subject?.root_format || null,
      observations,
    },
    behavior: {},
    internals: { observations },
    data: {},
    dependencies: [],
    reconstruction: [
      {
        step: 1,
        title: "Artefakt und Zielumgebung bestimmen",
        goal: "Format, Inhalt und vorgesehene Laufzeit feststellen.",
        inputs: ["evidence/artifact-inspection.json"],
        outputs: ["Zielbeschreibung"],
        checks: ["Format und Zweck sind belegt"],
      },
      {
        step: 2,
        title: "Inhalt übernehmen und nachbauen",
        goal: "Die inventarisierten Bestandteile in ein neues Projekt überführen.",
        inputs: ["evidence/artifact-inspection.json"],
        outputs: ["Projektdateien"],
        checks: ["Vollständigkeit gegen das Inventar"],
      },
      {
        step: 3,
        title: "Gegen das Original prüfen",
        goal: "Struktur und beobachtetes Verhalten vergleichen.",
        inputs: ["alle vorherigen Schritte"],
        outputs: ["Abgleichsbericht"],
        checks: ["Keine fehlenden Bestandteile"],
      },
    ],
    acceptance: [
      "Das neu gebaute Artefakt erfüllt denselben beobachteten Zweck.",
      "Die inventarisierten Bestandteile sind vollständig vorhanden.",
    ],
  };
}

export { auditCheckEvidence, resolveEvidenceRef };
