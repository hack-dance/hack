import { expect, test } from "bun:test";

import {
  buildLogSelector,
  resolveShouldTryLoki,
  resolveUseLoki,
} from "../src/lib/logs.ts";

test("buildLogSelector renders project-only selector", () => {
  expect(buildLogSelector({ project: "my-project", services: [] })).toBe(
    '{project="my-project"}'
  );
});

test("buildLogSelector renders single service selector", () => {
  expect(buildLogSelector({ project: "my-project", services: ["api"] })).toBe(
    '{project="my-project",service="api"}'
  );
});

test("buildLogSelector renders regex selector for multiple services", () => {
  expect(
    buildLogSelector({ project: "my-project", services: ["api", "worker"] })
  ).toBe('{project="my-project",service=~"^(api|worker)$"}');
});

test("buildLogSelector escapes regex characters in service names", () => {
  // One backslash for the regex escape, doubled once for the LogQL string literal.
  expect(
    buildLogSelector({ project: null, services: ["api.v2", "web*"] })
  ).toBe(String.raw`{service=~"^(api\\.v2|web\\*)$"}`);
});

/**
 * Reference for how Loki reads a LogQL double-quoted string: its lexer calls
 * Go's strconv.Unquote. Only the escapes Go accepts are allowed; unknown
 * escapes, a bare quote, and a raw newline are errors, as in Go.
 */
function goUnquote(literal: string): string {
  if (
    !(literal.length >= 2 && literal.startsWith('"') && literal.endsWith('"'))
  ) {
    throw new Error(`not a double-quoted literal: ${literal}`);
  }
  const simple: Record<string, string> = {
    a: "\x07",
    b: "\b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
    v: "\v",
    "\\": "\\",
    '"': '"',
  };
  const body = literal.slice(1, -1);
  let out = "";
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i] ?? "";
    if (ch === '"' || ch === "\n") {
      throw new Error(`invalid syntax: unescaped ${JSON.stringify(ch)}`);
    }
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    i += 1;
    const next = body[i] ?? "";
    const mapped = simple[next];
    if (mapped === undefined) {
      throw new Error(`invalid syntax: unknown escape \\${next}`);
    }
    out += mapped;
  }
  return out;
}

function parseSelector(selector: string): Map<string, string> {
  const matchers = new Map<string, string>();
  const re = /(\w+)(=~|=)("(?:[^"\\]|\\.)*")/g;
  for (const m of selector.matchAll(re)) {
    matchers.set(`${m[1]}${m[2]}`, goUnquote(m[3] ?? ""));
  }
  return matchers;
}

test("goUnquote follows Go strconv.Unquote rules", () => {
  expect(goUnquote(String.raw`"a\\b\"c\n"`)).toBe('a\\b"c\n');
  expect(() => goUnquote(String.raw`"api\.v2"`)).toThrow("unknown escape");
  expect(() => goUnquote('"a"b"')).toThrow("unescaped");
});

test("buildLogSelector regex matches dotted service names after Loki unquotes it", () => {
  const selector = buildLogSelector({
    project: "my-project",
    services: ["api.v2", "web"],
  });
  const pattern = parseSelector(selector).get("service=~");
  expect(pattern).toBe(String.raw`^(api\.v2|web)$`);

  const regex = new RegExp(pattern ?? "");
  expect(regex.test("api.v2")).toBe(true);
  expect(regex.test("web")).toBe(true);
  expect(regex.test("apiXv2")).toBe(false);
  expect(regex.test(String.raw`api\.v2`)).toBe(false);
});

test("buildLogSelector escapes every regex metacharacter exactly once", () => {
  const services = [
    "a+b",
    "c?d",
    "e(f)",
    "g[h]",
    "i{1}",
    "j|k",
    "l^m$",
    String.raw`n\o`,
  ];
  const pattern = parseSelector(
    buildLogSelector({ project: null, services })
  ).get("service=~");
  const regex = new RegExp(pattern ?? "");
  for (const service of services) {
    expect(regex.test(service)).toBe(true);
  }
  expect(regex.test("aab")).toBe(false);
});

test("buildLogSelector quotes project and service labels for Loki", () => {
  const project = String.raw`we"ird\proj`;
  const service = 'svc"x';
  const matchers = parseSelector(
    buildLogSelector({ project, services: [service] })
  );
  expect(matchers.get("project=")).toBe(project);
  expect(matchers.get("service=")).toBe(service);
});

test("resolveShouldTryLoki respects explicit compose override", () => {
  expect(
    resolveShouldTryLoki({
      forceCompose: true,
      wantsLokiExplicit: true,
      follow: true,
      followBackend: "loki",
      snapshotBackend: "loki",
    })
  ).toBe(false);
});

test("resolveShouldTryLoki prefers explicit Loki request", () => {
  expect(
    resolveShouldTryLoki({
      forceCompose: false,
      wantsLokiExplicit: true,
      follow: true,
      followBackend: "compose",
      snapshotBackend: "compose",
    })
  ).toBe(true);
});

test("resolveShouldTryLoki follows backend preferences", () => {
  expect(
    resolveShouldTryLoki({
      forceCompose: false,
      wantsLokiExplicit: false,
      follow: true,
      followBackend: "loki",
      snapshotBackend: "compose",
    })
  ).toBe(true);
  expect(
    resolveShouldTryLoki({
      forceCompose: false,
      wantsLokiExplicit: false,
      follow: false,
      followBackend: "compose",
      snapshotBackend: "loki",
    })
  ).toBe(true);
});

test("resolveUseLoki honors explicit Loki request and reachability", () => {
  expect(
    resolveUseLoki({
      forceCompose: false,
      wantsLokiExplicit: true,
      shouldTryLoki: true,
      lokiReachable: false,
    })
  ).toBe(true);
  expect(
    resolveUseLoki({
      forceCompose: false,
      wantsLokiExplicit: false,
      shouldTryLoki: true,
      lokiReachable: false,
    })
  ).toBe(false);
});
