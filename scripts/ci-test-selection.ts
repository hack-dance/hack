/** Conservative PR test selection. This module never executes test or product code. */
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";
import { isRecord } from "../src/lib/guards.ts";
import { discoverTestFiles } from "./test-shard-plan.ts";

export type TestSelection = {
  readonly mode: "full" | "selected";
  readonly reason: string;
  readonly files: readonly string[];
};

/** Add exceptional tests here with a reason; contracts and source readers run automatically. */
export const ALWAYS_RUN_TESTS: Readonly<Record<string, string>> = {
  "tests/ci-change-scope.test.ts": "CI policy and required-check wiring",
  "tests/ci-test-selection.test.ts": "Selection must verify itself on every PR",
};

const MODULE_PATH = /^(?:src\/|tests\/|packages\/db\/).+\.[cm]?[jt]sx?$/;
const NON_GRAPH_PATH = /(?:^|\/)(?:fixtures?|__fixtures__|e2e|models)(?:\/|$)/;
const DOC_PATH =
  /^(?:docs\/.+\.md|(?:README|CHANGELOG|SECURITY|PACKAGING)\.md|LICENSE)$/;
const CONTRACT_PATH =
  /(?:contract|protocol|transport|schema|dto|compatib|source|wiring|reference|generated|env-matrix)/i;
/** Reads/subprocesses in test support can observe arbitrary repository files. */
const OPAQUE_TEST_SOURCE =
  /\b(?:readFile(?:Sync)?|readdir(?:Sync)?|Bun\s*\.\s*file|Bun\s*\.\s*Glob|spawn(?:Sync)?|execFile(?:Sync)?|execSync|require)\b|\bBun\s*\[|=\s*Bun\b/;
const EXTENSIONS = [
  "",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mts",
  ".cts",
  "/index.ts",
  "/index.js",
];

export type SelectionInputs = {
  readonly repoRoot: string;
  readonly changed: readonly string[] | null;
  readonly full?: boolean;
  /** Pure fixture seam: relative file names and contents, no host filesystem reads. */
  readonly sources?: Readonly<Record<string, string>>;
  readonly tests?: readonly string[];
};

type Module = {
  readonly dependencies: readonly string[];
  readonly opaque: boolean;
  readonly sourceCheck: boolean;
};

function readsFsImport(node: ts.Node): boolean {
  if (
    !(
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      /^(?:node:)?fs(?:\/promises)?$/.test(node.moduleSpecifier.text)
    )
  ) {
    return false;
  }
  const bindings = node.importClause?.namedBindings;
  return (
    !(bindings && ts.isNamedImports(bindings)) ||
    bindings.elements.some((element) =>
      /^(?:read|open)/.test((element.propertyName ?? element.name).text)
    )
  );
}

function externalDependencies(
  read: (file: string) => string | undefined
): ReadonlySet<string> {
  const external = new Set<string>();
  try {
    const manifest: unknown = JSON.parse(read("package.json") ?? "{}");
    if (isRecord(manifest)) {
      for (const key of [
        "dependencies",
        "devDependencies",
        "peerDependencies",
      ] as const) {
        const values = manifest[key];
        if (isRecord(values)) {
          for (const name of Object.keys(values)) {
            external.add(name);
          }
        }
      }
    }
  } catch {
    /* Unreadable metadata leaves imports opaque. */
  }
  return external;
}

/**
 * Graph scope is intentionally small: config, fixtures, scripts, assets and native
 * inputs force all tests. Deleted modules do too, rather than losing their old edges.
 * Unknown resolution or computed imports make every dependent test always-run.
 */
export function selectTests(opts: SelectionInputs): TestSelection {
  const files = [
    ...(opts.tests ?? discoverTestFiles({ repoRoot: opts.repoRoot })),
  ].sort();
  const readCache = new Map<string, string | undefined>();
  const read = (file: string): string | undefined => {
    if (readCache.has(file)) {
      return readCache.get(file);
    }
    if (opts.sources) {
      return opts.sources[file];
    }
    try {
      const source = readFileSync(resolve(opts.repoRoot, file), "utf8");
      readCache.set(file, source);
      return source;
    } catch {
      readCache.set(file, undefined);
      return undefined;
    }
  };
  const full = (reason: string): TestSelection => ({
    mode: "full",
    reason,
    files,
  });
  if (opts.full) {
    return full("full CI requested");
  }
  if (!opts.changed?.length) {
    return full("changed paths unavailable or empty");
  }
  for (const path of opts.changed) {
    if (DOC_PATH.test(path)) {
      continue;
    }
    if (
      !MODULE_PATH.test(path) ||
      NON_GRAPH_PATH.test(path) ||
      read(path) === undefined
    ) {
      return full(`non-graph or deleted input: ${path}`);
    }
  }
  const modules = new Map<string, Module>();
  const external = externalDependencies(read);
  const root = resolve(opts.repoRoot);
  const aliases: Readonly<Record<string, string>> = {
    "@/": "src/",
    "@commands/": "src/commands/",
    "@control-plane/": "src/control-plane/",
    "@daemon/": "src/daemon/",
    "@lib/": "src/lib/",
    "@scripts/": "scripts/",
    "@tests/": "tests/",
    "@ui/": "src/ui/",
  };
  function moduleBase(from: string, name: string): string | null | undefined {
    let base: string;
    if (name.startsWith(".")) {
      base = relative(root, resolve(root, dirname(from), name));
    } else {
      const alias = Object.entries(aliases).find(([prefix]) =>
        name.startsWith(prefix)
      );
      if (!alias) {
        if (
          [...external].some(
            (namePart) => name === namePart || name.startsWith(`${namePart}/`)
          )
        ) {
          return null;
        }
        return name.startsWith("@") ||
          name.startsWith("src/") ||
          name.startsWith("tests/")
          ? undefined
          : null;
      }
      const prefix =
        from.startsWith("packages/db/") &&
        (alias[0] === "@/" || alias[0] === "@tests/")
          ? `packages/db/${alias[1]}`
          : alias[1];
      base = `${prefix}${name.slice(alias[0].length)}`;
    }
    return base;
  }
  function localTarget(from: string, name: string): string | null | undefined {
    const base = moduleBase(from, name);
    if (base === null || base === undefined) {
      return base;
    }
    if (base.startsWith("../") || base.startsWith("/")) {
      return undefined;
    }
    for (const candidate of [base, base.replace(/\.js$/, ".ts")]) {
      for (const extension of EXTENSIONS) {
        const file = `${candidate}${extension}`;
        if (read(file) !== undefined) {
          return file;
        }
      }
    }
    return undefined;
  }
  function module(file: string): Module {
    const cached = modules.get(file);
    if (cached) {
      return cached;
    }
    const source = read(file);
    if (source === undefined) {
      return { dependencies: [], opaque: true, sourceCheck: false };
    }
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const dependencies = new Set<string>();
    let opaque = false;
    let aliasedReader = false;
    function add(expression: ts.Node | undefined): void {
      if (!(expression && ts.isStringLiteralLike(expression))) {
        opaque = true;
        return;
      }
      const target = localTarget(file, expression.text);
      if (target === undefined) {
        opaque = true;
      } else if (target !== null) {
        dependencies.add(target);
      }
    }
    function visit(node: ts.Node): void {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        aliasedReader ||= readsFsImport(node);
        if (node.moduleSpecifier) {
          add(node.moduleSpecifier);
        }
      } else if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference)
      ) {
        add(node.moduleReference.expression);
      } else if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) &&
            node.expression.text === "require"))
      ) {
        add(node.arguments[0]);
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
    const result = {
      dependencies: [...dependencies],
      opaque,
      sourceCheck:
        (file.startsWith("tests/") ||
          file.startsWith("scripts/") ||
          file.startsWith("packages/db/tests/")) &&
        (OPAQUE_TEST_SOURCE.test(source) || aliasedReader),
    };
    modules.set(file, result);
    return result;
  }
  const changed = new Set(opts.changed);
  const selected = files.filter((test) => {
    if (Object.hasOwn(ALWAYS_RUN_TESTS, test) || CONTRACT_PATH.test(test)) {
      return true;
    }
    const seen = new Set<string>();
    const queue = [test];
    while (queue.length) {
      const file = queue.pop() as string;
      if (seen.has(file)) {
        continue;
      }
      seen.add(file);
      if (changed.has(file)) {
        return true;
      }
      const input = module(file);
      if (input.opaque || input.sourceCheck) {
        return true;
      }
      queue.push(...input.dependencies);
    }
    return false;
  });
  return {
    mode: "selected",
    reason:
      "transitive imports plus contracts, source readers and opaque tests",
    files: selected,
  };
}
