import { dirname, join, resolve } from "node:path";
import ts from "typescript";

/**
 * Syntax scan behind tests/cli-spawn-env-isolation.test.ts: finds tests that
 * hand the source CLI the test runner's environment or HOME.
 *
 * Scope. A file is in scope when it names the source CLI (a string that ends
 * in `index.ts`, `CLI_ENTRYPOINT` or `resolveCliSpawnArgs`). Every test-local
 * module that such a file imports, directly or transitively, is in scope too,
 * so an env object that a fixture helper builds for the CLI is checked where
 * it is built.
 *
 * Rules, checked on the TypeScript syntax tree of each in-scope file:
 * - `runner-env`: no copy of the whole runner environment. A use of
 *   `process.env`, `Bun.env`, `import.meta.env` or a `node:process` `env`
 *   import is a copy unless it reads, deletes or tests one key, or replaces
 *   the whole object. Spreads, `env: process.env`, `Object.assign(x,
 *   process.env)`, `const saved = process.env` and rest destructuring are
 *   all copies.
 * - `runner-home`: no `HOME` property whose value derives from the runner's
 *   home: `process.env.HOME`, `homedir()` in any form, `userInfo().homedir`,
 *   or a binding in the same file that holds one of these.
 * - `cli-without-env`: a spawn call (`spawn`, `spawnSync`, `execFile`,
 *   `exec`, `fork` and their `Bun.`/`child_process.` forms) whose arguments
 *   reach the CLI must pass an `env` option. Without it the child inherits the
 *   whole runner environment, including HOME. A wrapper such as `python3
 *   probe.py bun index.ts` counts, because its argv names the CLI.
 * - `env-without-home`: when that `env` is an object literal, it must set
 *   HOME or spread another object. Without HOME the child resolves its home
 *   from the account database, which is the runner's real home.
 *
 * Limits. This is a syntax check within one file, not data flow. It trusts an
 * env, HOME or argv value that comes from another module or a parameter: for
 * example `HOME: opts.home`, `env: options.env` in a shared runner, or a local
 * `run(argv)` wrapper whose spawn never names the CLI itself. A spawn of a CLI
 * path built at runtime without naming `index.ts` (for example a compiled
 * binary) is not seen either. Those spawns still need a private env by
 * convention; prefer one shared runner that calls `privateCliEnv`.
 */

export type Rule =
  | "runner-env"
  | "runner-home"
  | "cli-without-env"
  | "env-without-home";

export type Finding = { readonly line: number; readonly rule: Rule };

const SOURCE_CLI_PATH = /(?:^|\/)index\.ts$/;
const SOURCE_CLI_NAMES = new Set(["CLI_ENTRYPOINT", "resolveCliSpawnArgs"]);
/** Process-spawning exports, by module. `Bun.spawn`/`Bun.spawnSync` are global. */
const SPAWN_MODULES: Readonly<Record<string, ReadonlySet<string>>> = {
  child_process: new Set([
    "spawn",
    "spawnSync",
    "execFile",
    "execFileSync",
    "exec",
    "execSync",
    "fork",
  ]),
  execa: new Set(["execa", "execaSync"]),
};
const ENV_OWNERS = new Set([
  "process",
  "Bun",
  "import.meta",
  "globalThis.process",
  "globalThis.Bun",
]);
const KEY_ACCESSORS = new Set([
  "Reflect.deleteProperty",
  "Reflect.has",
  "Object.hasOwn",
]);

function parse(path: string, source: string): ts.SourceFile {
  return ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
}

/** Visits `node` and its descendants; `visit` returning false skips a subtree. */
function walk(node: ts.Node, visit: (node: ts.Node) => unknown): void {
  if (visit(node) === false) {
    return;
  }
  ts.forEachChild(node, (child) => walk(child, visit));
}

function moduleName(specifier: string): string {
  return specifier.replace(/^node:/, "");
}

/** How this file can spawn a process: imported functions and namespaces. */
type SpawnNames = {
  readonly functions: ReadonlySet<string>;
  readonly namespaces: ReadonlyMap<string, ReadonlySet<string>>;
};

/** Local names that one import declaration binds. */
type ImportNames = {
  /** Module specifier without a `node:` prefix. */
  readonly module: string;
  /** Default and namespace import names. */
  readonly whole: readonly string[];
  /** Named imports: the exported name and its local name. */
  readonly named: readonly {
    readonly imported: string;
    readonly local: string;
  }[];
};

function importNames(file: ts.SourceFile): ImportNames[] {
  const imports: ImportNames[] = [];
  for (const statement of file.statements) {
    if (
      !(
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.importClause
      )
    ) {
      continue;
    }
    const clause = statement.importClause;
    const whole = clause.name ? [clause.name.text] : [];
    const named: { imported: string; local: string }[] = [];
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) {
      whole.push(bindings.name.text);
    } else if (bindings) {
      for (const element of bindings.elements) {
        named.push({
          imported: (element.propertyName ?? element.name).text,
          local: element.name.text,
        });
      }
    }
    imports.push({
      module: moduleName(statement.moduleSpecifier.text),
      whole,
      named,
    });
  }
  return imports;
}

function spawnImports(file: ts.SourceFile): SpawnNames {
  const functions = new Set<string>();
  const namespaces = new Map<string, ReadonlySet<string>>([
    ["Bun", new Set(["spawn", "spawnSync"])],
  ]);
  for (const entry of importNames(file)) {
    const exports = SPAWN_MODULES[entry.module];
    if (!exports) {
      continue;
    }
    for (const name of entry.whole) {
      namespaces.set(name, exports);
    }
    for (const { imported, local } of entry.named) {
      if (exports.has(imported)) {
        functions.add(local);
      }
    }
  }
  return { functions, namespaces };
}

function isSpawnCall(
  node: ts.Node,
  spawn: SpawnNames
): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) {
    return false;
  }
  const callee = unwrap(node.expression);
  if (ts.isIdentifier(callee)) {
    return spawn.functions.has(callee.text);
  }
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    (spawn.namespaces.get(callee.expression.text)?.has(callee.name.text) ??
      false)
  );
}

/** The called name: `f` for `f()` and `x.f()`. */
function calleeName(call: ts.CallExpression): string | null {
  const callee = unwrap(call.expression);
  if (ts.isIdentifier(callee)) {
    return callee.text;
  }
  return ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
}

function isFunctionLike(node: ts.Node): boolean {
  return (
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node)
  );
}

function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function propertyName(name: ts.PropertyName | undefined): string | null {
  if (!name) {
    return null;
  }
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) {
    return name.text;
  }
  return null;
}

/** Local names that `node:process` binds: the module itself and its `env`. */
function processImports(file: ts.SourceFile): {
  readonly owners: Set<string>;
  readonly envs: Set<string>;
} {
  const owners = new Set(ENV_OWNERS);
  const envs = new Set<string>();
  for (const entry of importNames(file)) {
    if (entry.module !== "process") {
      continue;
    }
    for (const name of entry.whole) {
      owners.add(name);
    }
    for (const { imported, local } of entry.named) {
      if (imported === "env") {
        envs.add(local);
      }
    }
  }
  return { owners, envs };
}

/** Initializers of same-file `const`/`let`/`var` bindings. */
function bindings(file: ts.SourceFile): Map<string, ts.Expression> {
  const values = new Map<string, ts.Expression>();
  walk(file, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      values.set(node.name.text, node.initializer);
    }
  });
  return values;
}

/** Names whose same-file value satisfies `matches`, closed over aliases. */
function taintedNames(
  values: ReadonlyMap<string, ts.Expression>,
  matches: (node: ts.Node, names: ReadonlySet<string>) => boolean
): Set<string> {
  const names = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const [name, value] of values) {
      if (!names.has(name) && matches(value, names)) {
        names.add(name);
        grew = true;
      }
    }
  }
  return names;
}

function isReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  return !(
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isPropertyAssignment(parent) && parent.name === node) ||
    ts.isImportSpecifier(parent) ||
    (ts.isVariableDeclaration(parent) && parent.name === node) ||
    (ts.isBindingElement(parent) && parent.name === node)
  );
}

/**
 * Whether a subtree names the source CLI, directly or through `names`.
 * `prune` skips subtrees, such as function bodies and spawn calls, whose CLI
 * reference does not make the enclosing value a CLI path.
 */
function namesCli(
  node: ts.Node,
  names: ReadonlySet<string>,
  prune: (node: ts.Node) => boolean = () => false
): boolean {
  let found = false;
  walk(node, (child) => {
    if (found || prune(child)) {
      return false;
    }
    if (
      (ts.isStringLiteralLike(child) ||
        ts.isTemplateHead(child) ||
        ts.isTemplateMiddle(child) ||
        ts.isTemplateTail(child)) &&
      SOURCE_CLI_PATH.test(child.text)
    ) {
      found = true;
    } else if (
      ts.isIdentifier(child) &&
      (SOURCE_CLI_NAMES.has(child.text) || names.has(child.text)) &&
      isReference(child)
    ) {
      found = true;
    }
  });
  return found;
}

type EnvNames = ReturnType<typeof processImports>;

/** `process.env` or an alias of it, as a whole object. */
function isWholeEnv(node: ts.Node, env: EnvNames): boolean {
  if (ts.isPropertyAccessExpression(node) && node.name.text === "env") {
    return env.owners.has(node.expression.getText());
  }
  return ts.isIdentifier(node) && env.envs.has(node.text) && isReference(node);
}

/** Whether this use of the whole environment only touches one key or replaces it. */
function isKeyUse(node: ts.Node): boolean {
  const parent = node.parent;
  if (
    (ts.isPropertyAccessExpression(parent) ||
      ts.isElementAccessExpression(parent)) &&
    parent.expression === node
  ) {
    return true;
  }
  if (
    ts.isCallExpression(parent) &&
    parent.arguments[0] === node &&
    KEY_ACCESSORS.has(parent.expression.getText())
  ) {
    return true;
  }
  if (ts.isBinaryExpression(parent)) {
    const operator = parent.operatorToken.kind;
    return (
      (operator === ts.SyntaxKind.InKeyword && parent.right === node) ||
      (operator === ts.SyntaxKind.EqualsToken && parent.left === node)
    );
  }
  return (
    ts.isVariableDeclaration(parent) &&
    ts.isObjectBindingPattern(parent.name) &&
    parent.name.elements.every((element) => !element.dotDotDotToken)
  );
}

/** Whether a subtree reads the runner's home, directly or through `names`. */
function readsRunnerHome(
  node: ts.Node,
  env: EnvNames,
  names: ReadonlySet<string>
): boolean {
  let found = false;
  walk(node, (child) => {
    if (found) {
      return false;
    }
    if (ts.isPropertyAccessExpression(child)) {
      // `process.env.HOME`, or `userInfo().homedir` in any import form.
      found =
        (child.name.text === "HOME" && isWholeEnv(child.expression, env)) ||
        (child.name.text === "homedir" &&
          ts.isCallExpression(child.expression) &&
          calleeName(child.expression) === "userInfo");
    } else if (ts.isElementAccessExpression(child)) {
      found =
        ts.isStringLiteralLike(child.argumentExpression) &&
        child.argumentExpression.text === "HOME" &&
        isWholeEnv(child.expression, env);
    } else if (ts.isCallExpression(child)) {
      // `homedir()`, `os.homedir()` or `node_os.homedir()`.
      found = calleeName(child) === "homedir";
    } else if (ts.isIdentifier(child)) {
      found = names.has(child.text) && isReference(child);
    }
  });
  return found;
}

/** An expression, or the same-file value it is bound to. */
function resolveLocal(
  node: ts.Expression,
  values: ReadonlyMap<string, ts.Expression>
): ts.Node {
  let current: ts.Node = unwrap(node);
  const seen = new Set<string>();
  while (ts.isIdentifier(current) && !seen.has(current.text)) {
    seen.add(current.text);
    const value = values.get(current.text);
    if (!value) {
      break;
    }
    current = unwrap(value);
  }
  return current;
}

type NamedProperty = ts.PropertyAssignment | ts.ShorthandPropertyAssignment;

function isNamedProperty(
  property: ts.ObjectLiteralElementLike,
  name: string
): property is NamedProperty {
  return (
    (ts.isPropertyAssignment(property) ||
      ts.isShorthandPropertyAssignment(property)) &&
    propertyName(property.name) === name
  );
}

function envProperty(object: ts.ObjectLiteralExpression): NamedProperty | null {
  return (
    object.properties.find((property) => isNamedProperty(property, "env")) ??
    null
  );
}

function setsHome(object: ts.ObjectLiteralExpression): boolean {
  return object.properties.some(
    (property) =>
      ts.isSpreadAssignment(property) || isNamedProperty(property, "HOME")
  );
}

/** Findings for one spawn call that reaches the source CLI. */
function cliSpawnFindings(
  call: ts.CallExpression,
  values: ReadonlyMap<string, ts.Expression>,
  cliNames: ReadonlySet<string>
): Rule[] {
  const options = call.arguments.map((argument) =>
    resolveLocal(argument, values)
  );
  for (const option of options) {
    if (!ts.isObjectLiteralExpression(option)) {
      continue;
    }
    const property = envProperty(option);
    if (!property) {
      continue;
    }
    const value = resolveLocal(
      ts.isPropertyAssignment(property) ? property.initializer : property.name,
      values
    );
    return ts.isObjectLiteralExpression(value) && !setsHome(value)
      ? ["env-without-home"]
      : [];
  }
  // An options value from a parameter, another module or a spread is opaque:
  // it may carry an env, which is checked where it is built.
  const opaque = options
    .slice(1)
    .some((option) =>
      ts.isObjectLiteralExpression(option)
        ? option.properties.some(ts.isSpreadAssignment)
        : (ts.isIdentifier(option) || ts.isPropertyAccessExpression(option)) &&
          !namesCli(option, cliNames)
    );
  return opaque ? [] : ["cli-without-env"];
}

/** Rule findings for one in-scope source file. */
export function scanSource(path: string, source: string): Finding[] {
  const file = parse(path, source);
  const env = processImports(file);
  const values = bindings(file);
  const spawn = spawnImports(file);
  // A binding is a CLI path when its value names the CLI outside a function
  // or a spawn call: `const proc = Bun.spawn([.., "index.ts"])` is not one.
  const cliNames = taintedNames(values, (node, names) =>
    namesCli(
      node,
      names,
      (child) => isFunctionLike(child) || isSpawnCall(child, spawn)
    )
  );
  const homeNames = taintedNames(values, (node, names) =>
    readsRunnerHome(node, env, names)
  );
  const findings: Finding[] = [];
  const add = (node: ts.Node, rule: Rule) => {
    findings.push({
      line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
      rule,
    });
  };
  walk(file, (node) => {
    if (isWholeEnv(node, env) && !isKeyUse(node)) {
      add(node, "runner-env");
    }
    if (
      (ts.isPropertyAssignment(node) &&
        propertyName(node.name) === "HOME" &&
        readsRunnerHome(node.initializer, env, homeNames)) ||
      (ts.isShorthandPropertyAssignment(node) &&
        node.name.text === "HOME" &&
        homeNames.has("HOME"))
    ) {
      add(node, "runner-home");
    }
    if (
      isSpawnCall(node, spawn) &&
      node.arguments.some((argument) => namesCli(argument, cliNames))
    ) {
      for (const rule of cliSpawnFindings(node, values, cliNames)) {
        add(node, rule);
      }
    }
  });
  return findings.sort((a, b) => a.line - b.line);
}

/** Test-local modules that `path` imports. */
function localImports(
  path: string,
  source: string,
  known: ReadonlySet<string>,
  testsRoot: string
): string[] {
  const file = parse(path, source);
  const specifiers: string[] = [];
  walk(file, (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
  });
  const found: string[] = [];
  for (const specifier of specifiers) {
    let base: string | null = null;
    if (specifier.startsWith(".")) {
      base = resolve(dirname(path), specifier);
    } else if (specifier.startsWith("@tests/")) {
      base = join(testsRoot, specifier.slice("@tests/".length));
    }
    if (base === null) {
      continue;
    }
    const target = [base, `${base}.ts`, join(base, "index.ts")].find((item) =>
      known.has(item)
    );
    if (target) {
      found.push(target);
    }
  }
  return found;
}

/**
 * Files that name the source CLI, plus the test-local modules they import,
 * transitively. `sources` maps absolute paths under `testsRoot` to text.
 */
function cliScope(
  sources: ReadonlyMap<string, string>,
  testsRoot: string
): Set<string> {
  const known = new Set(sources.keys());
  const scope = new Set<string>();
  const queue: string[] = [];
  for (const [path, source] of sources) {
    if (namesCli(parse(path, source), new Set())) {
      queue.push(path);
    }
  }
  while (queue.length > 0) {
    const path = queue.pop() as string;
    if (scope.has(path)) {
      continue;
    }
    scope.add(path);
    queue.push(
      ...localImports(path, sources.get(path) ?? "", known, testsRoot)
    );
  }
  return scope;
}

/** Findings for every in-scope file in `sources`, by absolute path. */
export function scanSources(
  sources: ReadonlyMap<string, string>,
  testsRoot: string
): Map<string, Finding[]> {
  const results = new Map<string, Finding[]>();
  for (const path of [...cliScope(sources, testsRoot)].sort()) {
    const findings = scanSource(path, sources.get(path) ?? "");
    if (findings.length > 0) {
      results.set(path, findings);
    }
  }
  return results;
}

/** `line rule` pairs, comma separated. */
export function describeFindings(findings: readonly Finding[]): string {
  return findings.map(({ line, rule }) => `${line} ${rule}`).join(", ");
}
