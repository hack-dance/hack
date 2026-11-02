import { expect, test } from "bun:test";

import {
  buildLogSelector,
  resolveShouldTryLoki,
  resolveUseLoki,
} from "../src/lib/logs.ts";
import { unquoteGoDoubleQuoted } from "./helpers/go-unquote.ts";

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

// HACK-1364: LogQL string literals are decoded once by Loki (Go
// `strconv.Unquote` rules) and the result is then compiled as RE2 for `=~`.
// Each layer must be escaped exactly once.

/** Read the double-quoted literal that follows `prefix` in a selector. */
function literalAfter(selector: string, prefix: string): string {
  const start = selector.indexOf(prefix);
  if (start < 0) {
    throw new Error(`missing ${prefix} in ${selector}`);
  }
  const open = start + prefix.length;
  if (selector[open] !== '"') {
    throw new Error(`no string literal after ${prefix} in ${selector}`);
  }
  let i = open + 1;
  while (i < selector.length) {
    const ch = selector[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === '"') {
      return selector.slice(open, i + 1);
    }
    i += 1;
  }
  throw new Error(`unterminated literal in ${selector}`);
}

/** The label value or regex Loki sees for `prefix` in `selector`. */
function decodedAfter(selector: string, prefix: string): string {
  return unquoteGoDoubleQuoted(literalAfter(selector, prefix));
}

const AWKWARD_NAMES = [
  "api.v2",
  'say "hi"',
  "back\\slash",
  "a|b",
  "trailing\\",
  "tab\tand\nnewline",
] as const;

test("buildLogSelector renders the dotted multi-service repro with one regex escape", () => {
  // `hack logs --services api.v2,web --no-follow`: Loki must receive the
  // regex ^(api\.v2|web)$, so the literal holds exactly two backslashes.
  const selector = buildLogSelector({
    project: null,
    services: ["api.v2", "web"],
  });
  expect(selector).toBe(String.raw`{service=~"^(api\\.v2|web)$"}`);
  expect(decodedAfter(selector, "service=~")).toBe(String.raw`^(api\.v2|web)$`);
});

test("buildLogSelector single-service and project values survive Loki's unquote exactly", () => {
  for (const name of AWKWARD_NAMES) {
    const selector = buildLogSelector({ project: name, services: [name] });
    expect(selector).not.toContain("\n");
    expect(decodedAfter(selector, "project=")).toBe(name);
    expect(decodedAfter(selector, "service=")).toBe(name);
  }
});

test("buildLogSelector multi-service regex matches each name exactly after Loki's unquote", () => {
  const selector = buildLogSelector({
    project: "demo",
    services: [...AWKWARD_NAMES, "web*"],
  });
  expect(decodedAfter(selector, "project=")).toBe("demo");
  // The `u` flag rejects identity escapes of non-syntax characters, as RE2
  // rejects escaped letters, so a stray backslash fails to compile here.
  const regex = new RegExp(decodedAfter(selector, "service=~"), "u");
  for (const name of [...AWKWARD_NAMES, "web*"]) {
    expect(regex.test(name)).toBe(true);
  }
  for (const other of [
    "apiXv2",
    "api\\.v2",
    "a",
    "b",
    "say hi",
    "backslash",
    "back\\\\slash",
    "web",
    "webbb",
    "web*x",
  ]) {
    expect(regex.test(other)).toBe(false);
  }
});

test("the pre-fix doubly escaped literal does not match the dotted name", () => {
  // Shape of the old output: four backslashes decode to `\\.`, a literal
  // backslash followed by any character.
  const old = String.raw`"^(api\\\\.v2|web)$"`;
  const regex = new RegExp(unquoteGoDoubleQuoted(old), "u");
  expect(regex.test("api.v2")).toBe(false);
  expect(regex.test("api\\Xv2")).toBe(true);
});

test("unquoteGoDoubleQuoted follows Go's double-quoted string rules", () => {
  expect(unquoteGoDoubleQuoted(String.raw`"a\"b\\c\n\x41\101é"`)).toBe(
    'a"b\\c\nAAé'
  );
  for (const bad of [
    '"a"b"',
    '"a\nb"',
    String.raw`"\'"`,
    String.raw`"\q"`,
    String.raw`"\x4"`,
    String.raw`"\"`,
    "unquoted",
  ]) {
    expect(() => unquoteGoDoubleQuoted(bad)).toThrow();
  }
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
