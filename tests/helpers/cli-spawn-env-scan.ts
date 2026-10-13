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
 * Spawn calls are `spawn`, `spawnSync`, `execFile`, `exec`, `fork` and their
 * `Bun.`/`child_process.`/`execa` forms; `run` and `exec` imported from
 * src/lib/shell.ts, named or through a namespace import; and calls to a
 * same-file function (a declaration, or a `const` arrow or function
 * expression) whose body calls one of those shell functions or another such
 * wrapper.
 *
 * Rules, checked on the TypeScript syntax tree of each in-scope file:
 * - `runner-env`: no copy of the whole runner environment. A use of
 *   `process.env`, `Bun.env`, `import.meta.env` or a `node:process` `env`
 *   import is a copy unless it reads, deletes or tests one key, lists only
 *   the key names with `Object.keys`, or replaces the whole object. Spreads,
 *   `env: process.env`, `Object.assign(x, process.env)`, `const saved =
 *   process.env` and rest destructuring are all copies.
 * - `runner-home`: no `HOME` property whose value derives from the runner's
 *   home: `process.env.HOME`, `homedir()` in any form, `userInfo().homedir`,
 *   or a binding in the same file that holds one of these.
 * - `cli-without-env`: a spawn call whose arguments reach the CLI must pass an
 *   `env` option. Without it the child inherits the whole runner environment,
 *   including HOME. Arguments reach the CLI when they name it directly,
 *   through a same-file binding, or through a call to a same-file function
 *   that returns it. A wrapper such as `python3 probe.py bun index.ts` counts,
 *   because its argv names the CLI.
 * - `env-without-home`: when that `env` is an object literal, it must set
 *   HOME or spread another object. Without HOME the child resolves its home
 *   from the account database, which is the runner's real home. An `env`
 *   that calls a same-file function, directly or through a binding, is
 *   checked through the values that function returns.
 * - `shell-runner-env`: a CLI spawn through src/lib/shell.ts must also pass
 *   `unsetEnvKeys`, or spread an options object such as
 *   `privateCliRunEnv(...)`, because shell `run` and `exec` lay `env` over the
 *   runner's whole `process.env`. Shell `exec` cannot unset keys, so it cannot
 *   run the CLI privately.
 *
 * Shell wrappers. At a wrapper call that names the CLI, each shell call inside
 * the wrapper is checked: against the wrapper call's own arguments when the
 * inner options use a wrapper parameter, through the inner wrapper when it is
 * one (at most four deep), and against the inner options otherwise.
 *
 * Limits. This is a syntax check within one file, not data flow. It trusts an
 * env, HOME or argv value that comes from another module or a parameter: for
 * example `HOME: opts.home`, `env: options.env` in a shared runner, or a local
 * `run(argv)` wrapper around `Bun.spawn` whose spawn never names the CLI
 * itself. A same-file function is followed only for an `env` value (at most
 * four calls deep) and an argv, and only through its `return` expressions,
 * not the branches of a conditional; a function that returns options is not
 * followed, so such a call counts as options without `env`. Inner options
 * that only partly use a wrapper parameter are checked as the call site's
 * arguments. An options object that spreads another object is trusted, and
 * so is the `unsetEnvKeys` value. A
 * dynamic key read such as `process.env[key]` counts as a one-key use, so a
 * loop that copies values key by key is not seen. A spawn of a CLI path built
 * at runtime without naming `index.ts` (for example a compiled binary) is not
 * seen either. Those spawns still need a private env by convention; prefer one
 * shared runner that calls `privateCliEnv` or `privateCliRunEnv`.
 */

export type Rule =
  | "runner-env"
  | "runner-home"
  | "cli-without-env"
  | "env-without-home"
  | "shell-runner-env";

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
/** src/lib/shell.ts, by relative path or through a `@lib`/`@` alias. */
const SHELL_MODULE = /(?:^|[/@])lib\/shell(?:\.ts)?$/;
const SHELL_SPAWNS: ReadonlySet<string> = new Set(["run", "exec"]);
/** How many same-file calls an `env` value is followed through. */
const MAX_RETURN_DEPTH = 4;
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

type FunctionNode =
  | ts.FunctionDeclaration
  | ts.ArrowFunction
  | ts.FunctionExpression;

/** How this file can spawn a process. */
type SpawnNames = {
  /** Imported process-spawning functions, by local name. */
  readonly functions: ReadonlySet<string>;
  /** Namespace imports (and `Bun`), with the spawn exports they hold. */
  readonly namespaces: ReadonlyMap<string, ReadonlySet<string>>;
  /** Local names of src/lib/shell.ts `run` and `exec`. */
  readonly shellFunctions: ReadonlySet<string>;
  /** Namespace imports of src/lib/shell.ts. */
  readonly shellNamespaces: ReadonlySet<string>;
  /** Same-file functions that call a shell spawn, by name. */
  readonly wrappers: ReadonlyMap<string, FunctionNode>;
};

/** A process API, src/lib/shell.ts, or a same-file wrapper of the shell. */
type SpawnKind = "process" | "shell" | "wrapper";

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

/** Same-file named functions: declarations and `const` function values. */
function localFunctions(file: ts.SourceFile): Map<string, FunctionNode> {
  const functions = new Map<string, FunctionNode>();
  walk(file, (node) => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      functions.set(node.name.text, node);
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      const value = unwrap(node.initializer);
      if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) {
        functions.set(node.name.text, value);
      }
    }
  });
  return functions;
}

/** Calls in a function body, nested functions included, that `matches`. */
function callsIn(
  fn: FunctionNode,
  matches: (call: ts.CallExpression) => boolean
): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  if (!fn.body) {
    return calls;
  }
  walk(fn.body, (node) => {
    if (ts.isCallExpression(node) && matches(node)) {
      calls.push(node);
    }
  });
  return calls;
}

function isShellCall(node: ts.CallExpression, spawn: SpawnNames): boolean {
  const kind = spawnKind(node, spawn);
  return kind === "shell" || kind === "wrapper";
}

/** Records the spawn exports that one import binds, by local name. */
function addSpawnImport(
  entry: ImportNames,
  exports: ReadonlySet<string>,
  functions: Set<string>,
  namespaces: Map<string, ReadonlySet<string>>
): void {
  for (const name of entry.whole) {
    namespaces.set(name, exports);
  }
  for (const { imported, local } of entry.named) {
    if (exports.has(imported)) {
      functions.add(local);
    }
  }
}

function spawnImports(
  file: ts.SourceFile,
  localFunctionsByName: ReadonlyMap<string, FunctionNode>
): SpawnNames {
  const functions = new Set<string>();
  const namespaces = new Map<string, ReadonlySet<string>>([
    ["Bun", new Set(["spawn", "spawnSync"])],
  ]);
  const shellFunctions = new Set<string>();
  const shellNamespaces = new Set<string>();
  for (const entry of importNames(file)) {
    if (SHELL_MODULE.test(entry.module)) {
      addSpawnImport(entry, SHELL_SPAWNS, shellFunctions, namespaces);
      for (const name of entry.whole) {
        shellNamespaces.add(name);
      }
    } else {
      const exports = SPAWN_MODULES[entry.module];
      if (exports) {
        addSpawnImport(entry, exports, functions, namespaces);
      }
    }
  }
  const wrappers = new Map<string, FunctionNode>();
  const names: SpawnNames = {
    functions,
    namespaces,
    shellFunctions,
    shellNamespaces,
    wrappers,
  };
  addShellWrappers(names, wrappers, localFunctionsByName);
  return names;
}

/** Adds same-file shell wrappers to `wrappers`, closed over wrappers of wrappers. */
function addShellWrappers(
  names: SpawnNames,
  wrappers: Map<string, FunctionNode>,
  localFunctionsByName: ReadonlyMap<string, FunctionNode>
): void {
  let grew = true;
  while (grew) {
    grew = false;
    for (const [name, fn] of localFunctionsByName) {
      if (
        !wrappers.has(name) &&
        callsIn(fn, (call) => isShellCall(call, names)).length > 0
      ) {
        wrappers.set(name, fn);
        grew = true;
      }
    }
  }
}

function spawnKind(node: ts.Node, spawn: SpawnNames): SpawnKind | null {
  if (!ts.isCallExpression(node)) {
    return null;
  }
  const callee = unwrap(node.expression);
  if (ts.isIdentifier(callee)) {
    if (spawn.functions.has(callee.text)) {
      return "process";
    }
    if (spawn.shellFunctions.has(callee.text)) {
      return "shell";
    }
    return spawn.wrappers.has(callee.text) ? "wrapper" : null;
  }
  if (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    spawn.namespaces.get(callee.expression.text)?.has(callee.name.text)
  ) {
    return spawn.shellNamespaces.has(callee.expression.text)
      ? "shell"
      : "process";
  }
  return null;
}

function isSpawnCall(
  node: ts.Node,
  spawn: SpawnNames
): node is ts.CallExpression {
  return spawnKind(node, spawn) !== null;
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
    (KEY_ACCESSORS.has(parent.expression.getText()) ||
      (parent.arguments.length === 1 &&
        parent.expression.getText() === "Object.keys"))
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

/** The `return` expressions of a function, outside nested functions. */
function returnedValues(fn: FunctionNode): ts.Expression[] {
  if (!fn.body) {
    return [];
  }
  if (!ts.isBlock(fn.body)) {
    return [fn.body];
  }
  const returned: ts.Expression[] = [];
  walk(fn.body, (node) => {
    if (isFunctionLike(node)) {
      return false;
    }
    if (ts.isReturnStatement(node) && node.expression) {
      returned.push(node.expression);
    }
  });
  return returned;
}

/** Same-file facts that a spawn check reads. */
type ScanContext = {
  readonly values: ReadonlyMap<string, ts.Expression>;
  readonly functions: ReadonlyMap<string, FunctionNode>;
  readonly cliNames: ReadonlySet<string>;
  readonly spawn: SpawnNames;
};

/**
 * Whether an `env` value is an object literal without HOME: directly, through
 * a same-file binding, or as a value that a same-file function it calls
 * returns.
 */
function envLacksHome(
  node: ts.Expression,
  ctx: ScanContext,
  depth = 0
): boolean {
  const value = resolveLocal(node, ctx.values);
  if (ts.isObjectLiteralExpression(value)) {
    return !setsHome(value);
  }
  if (!ts.isCallExpression(value) || depth >= MAX_RETURN_DEPTH) {
    return false;
  }
  const callee = unwrap(value.expression);
  const fn = ts.isIdentifier(callee)
    ? ctx.functions.get(callee.text)
    : undefined;
  return (
    fn !== undefined &&
    returnedValues(fn).some((returned) =>
      envLacksHome(returned, ctx, depth + 1)
    )
  );
}

/**
 * Findings for one spawn call that reaches the source CLI. `shell` marks a
 * src/lib/shell.ts call, which lays `env` over the runner's environment.
 */
function cliSpawnFindings(
  call: ts.CallExpression,
  ctx: ScanContext,
  shell: boolean
): Rule[] {
  const { values, cliNames } = ctx;
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
    if (
      envLacksHome(
        ts.isPropertyAssignment(property)
          ? property.initializer
          : property.name,
        ctx
      )
    ) {
      return ["env-without-home"];
    }
    const unsets = option.properties.some(
      (item) =>
        ts.isSpreadAssignment(item) || isNamedProperty(item, "unsetEnvKeys")
    );
    return shell && !unsets ? ["shell-runner-env"] : [];
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

function parameterNames(fn: FunctionNode): Set<string> {
  const names = new Set<string>();
  for (const parameter of fn.parameters) {
    walk(parameter.name, (node) => {
      if (ts.isIdentifier(node)) {
        names.add(node.text);
      }
    });
  }
  return names;
}

/** Whether any of `nodes` references one of `names`. */
function referencesAny(
  nodes: readonly ts.Node[],
  names: ReadonlySet<string>
): boolean {
  let found = false;
  for (const node of nodes) {
    walk(node, (child) => {
      if (found) {
        return false;
      }
      found =
        ts.isIdentifier(child) && names.has(child.text) && isReference(child);
    });
  }
  return found;
}

/** Findings for a CLI spawn call of any kind. */
function spawnCallFindings(
  call: ts.CallExpression,
  kind: SpawnKind,
  ctx: ScanContext,
  depth = 0
): Rule[] {
  if (kind !== "wrapper") {
    return cliSpawnFindings(call, ctx, kind === "shell");
  }
  const callee = unwrap(call.expression);
  const fn = ts.isIdentifier(callee)
    ? ctx.spawn.wrappers.get(callee.text)
    : undefined;
  if (!fn || depth >= MAX_RETURN_DEPTH) {
    return [];
  }
  const parameters = parameterNames(fn);
  const rules = new Set<Rule>();
  for (const inner of callsIn(fn, (node) => isShellCall(node, ctx.spawn))) {
    let found: Rule[];
    if (referencesAny(inner.arguments.slice(1), parameters)) {
      // Options built from the wrapper's parameters come from this call site.
      found = cliSpawnFindings(call, ctx, true);
    } else if (spawnKind(inner, ctx.spawn) === "wrapper") {
      found = spawnCallFindings(inner, "wrapper", ctx, depth + 1);
    } else {
      found = cliSpawnFindings(inner, ctx, true);
    }
    for (const rule of found) {
      rules.add(rule);
    }
  }
  return [...rules];
}

/**
 * Names that hold a CLI path. A binding is one when its value names the CLI
 * outside a function or a spawn call: `const proc = Bun.spawn([..,
 * "index.ts"])` is not one. A same-file function is one when a value it
 * returns names the CLI the same way, so `hostCommand(...)` in an argv counts.
 */
function cliPathNames(
  values: ReadonlyMap<string, ts.Expression>,
  functions: ReadonlyMap<string, FunctionNode>,
  spawn: SpawnNames
): Set<string> {
  const names = new Set<string>();
  const notPath = (child: ts.Node) =>
    isFunctionLike(child) || isSpawnCall(child, spawn);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [name, value] of values) {
      if (!names.has(name) && namesCli(value, names, notPath)) {
        names.add(name);
        grew = true;
      }
    }
    for (const [name, fn] of functions) {
      if (
        !names.has(name) &&
        returnedValues(fn).some((value) => namesCli(value, names, notPath))
      ) {
        names.add(name);
        grew = true;
      }
    }
  }
  return names;
}

/** Rule findings for one in-scope source file. */
export function scanSource(path: string, source: string): Finding[] {
  const file = parse(path, source);
  const env = processImports(file);
  const values = bindings(file);
  const functions = localFunctions(file);
  const spawn = spawnImports(file, functions);
  const cliNames = cliPathNames(values, functions, spawn);
  const homeNames = taintedNames(values, (node, names) =>
    readsRunnerHome(node, env, names)
  );
  const ctx: ScanContext = { values, functions, cliNames, spawn };
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
    const kind = spawnKind(node, spawn);
    if (
      kind !== null &&
      ts.isCallExpression(node) &&
      node.arguments.some((argument) => namesCli(argument, cliNames))
    ) {
      for (const rule of spawnCallFindings(node, kind, ctx)) {
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
