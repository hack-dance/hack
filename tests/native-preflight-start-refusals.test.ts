import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  NATIVE_START_REFUSAL_ENTRIES,
  NATIVE_START_RUNTIME_BOUNDARIES,
} from "../src/backends/native-start-refusal-entries.ts";

/**
 * Start's Compose admission extends beyond project-plan diagnostics. Walk its
 * driver/configuration validators too: a new refusal must have a preflight
 * entry, or an explicit explanation of the acquired runtime authority it needs.
 * The companion review-codes test walks the entire project input compiler.
 */
const ADMISSION_SOURCES = [
  "provider/graph/config.rs",
  "provider/graph/routes.rs",
  "provider/graph/restart_policy.rs",
  "provider/graph/dependency_cache.rs",
  "provider/graph/dependency_hosts.rs",
  "provider/graph/launcher.rs",
  "provider/http_probe.rs",
  "project/execution.rs",
  "project/capabilities.rs",
] as const;
const CLOSED_ERROR =
  /(?<![A-Za-z_])(?<!Diagnostic::)(?:(?:super|crate|self)::)*(?:error|problem|CandidateError::new|failed_service_error)\(\s*"([a-z][a-z0-9_]*)"/g;
const CODE_HELPER = /fn (\w+)\(\s*code: &'static str/g;
const KNOWN_CODE_HELPERS = new Set(["error", "failed_service_error"]);
const ADMISSION_MODULES = new Set(
  ADMISSION_SOURCES.map((path) => path.split("/").at(-1)?.replace(/\.rs$/, ""))
);
/** Imported boundaries outside the file-local graph admission walk. */
const OTHER_MODULES: Readonly<Record<string, string>> = {
  project: "The companion test walks every project/compiler refusal code.",
  publication:
    "Route syntax is reviewed in project; dependency binding normalization needs runtime authority.",
  environment:
    "Private wrapper publication and delivery are runtime operations.",
  iter: "Standard iterator helper.",
  serde_json: "JSON encoding of already-admitted values.",
  fs: "Filesystem acquisition for verified cache bindings.",
  libc: "Host identity for verified cache bindings.",
  u64: "Primitive integer parsing.",
  super: "Parent module's closed error constructor.",
};

function productionSource(text: string): string {
  const tests = /#\[cfg\(test\)\]\s*mod \w+\s*\{/.exec(text);
  if (!tests) {
    return text;
  }
  // A cfg(test) helper may precede more production code; only a test MODULE
  // begins this cut. These files keep their test modules after production.
  expect(
    /^(?:pub(?:\([^)]*\))? )?(?:fn |struct |enum |impl )/m.test(
      text.slice(tests.index).replace(/^#\[test\]\s*fn \w+[^{]*\{/gm, "")
    )
  ).toBe(false);
  return text.slice(0, tests.index);
}

function refusalCodes(source: string): string[] {
  return [...source.matchAll(CLOSED_ERROR)].flatMap((match) =>
    match[1] ? [match[1]] : []
  );
}

function missingEntries(codes: Iterable<string>): string[] {
  return [...new Set(codes)]
    .filter(
      (code) =>
        !(
          Object.hasOwn(NATIVE_START_REFUSAL_ENTRIES, code) ||
          Object.hasOwn(NATIVE_START_RUNTIME_BOUNDARIES, code)
        )
    )
    .sort();
}

test("each Compose start refusal has a preflight entry", async () => {
  const codes = new Set<string>();
  for (const path of ADMISSION_SOURCES) {
    const text = await readFile(`packages/runtime-core/src/${path}`, "utf8");
    const production = productionSource(text);
    // A new admission module cannot silently fall outside this walk.
    for (const call of production.matchAll(/\b([a-z_]\w*)::[a-z_]\w*\s*\(/g)) {
      const module = call[1] ?? "";
      expect(
        ADMISSION_MODULES.has(module) || Object.hasOwn(OTHER_MODULES, module)
      ).toBe(true);
    }
    for (const helper of production.matchAll(CODE_HELPER)) {
      expect(KNOWN_CODE_HELPERS.has(helper[1] ?? "")).toBe(true);
    }
    for (const code of refusalCodes(production)) {
      codes.add(code);
    }
  }
  expect(codes.size).toBeGreaterThan(20);
  expect(codes.has("graph_port_publication")).toBe(true);
  expect(codes.has("graph_budget")).toBe(true);
  expect(codes.has("native_http_mount")).toBe(true);
  expect(missingEntries(codes)).toEqual([]);
  expect(
    Object.keys(NATIVE_START_REFUSAL_ENTRIES).filter((code) =>
      Object.hasOwn(NATIVE_START_RUNTIME_BOUNDARIES, code)
    )
  ).toEqual([]);
});

test("the admission walk detects a new unregistered start refusal", () => {
  expect(
    missingEntries(
      refusalCodes(`
    return Err(super::error("new_compose_refusal", "fixed reason"));
  `)
    )
  ).toEqual(["new_compose_refusal"]);
});
