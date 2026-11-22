/** Derive CI tier inputs from workflow commands, file references and module imports. */
import { readFileSync, statSync } from "node:fs";
import { posix, resolve } from "node:path";
import ts from "typescript";
import { isRecord } from "../src/lib/guards.ts";
import { composeBuilds, dockerContextInputs } from "./ci-docker-context.ts";
import {
  buildSelectionGraph,
  selectionModuleInputs,
} from "./ci-test-selection.ts";

type InputOptions = {
  readonly repoRoot: string;
  readonly sources?: Readonly<Record<string, string>>;
};
const JOBS = ["docker-e2e-shard", "runtime-images", "linux-process-lifetime"];
type Tier = "docker" | "models" | "build";
type JobInputs = Pick<ReadonlySet<string>, "has">;
const cache = new Map<string, JobInputs>();

function inputReader(opts: InputOptions) {
  return {
    read(file: string): string | undefined {
      if (opts.sources) {
        return opts.sources[file];
      }
      try {
        return readFileSync(resolve(opts.repoRoot, file), "utf8");
      } catch {
        return;
      }
    },
    glob(pattern: string): string[] {
      const glob = new Bun.Glob(pattern);
      return opts.sources
        ? Object.keys(opts.sources).filter((path) => glob.match(path))
        : [
            ...glob.scanSync({
              cwd: opts.repoRoot,
              dot: true,
              onlyFiles: true,
            }),
          ];
    },
    kind(file: string): "file" | "directory" | undefined {
      if (opts.sources) {
        if (Object.hasOwn(opts.sources, file)) {
          return "file";
        }
        return Object.keys(opts.sources).some((path) =>
          path.startsWith(`${file}/`)
        )
          ? "directory"
          : undefined;
      }
      try {
        const stat = statSync(resolve(opts.repoRoot, file));
        return stat.isDirectory()
          ? "directory"
          : stat.isFile()
            ? "file"
            : undefined;
      } catch {
        return;
      }
    },
  };
}

function workflowCommands(
  source: string | undefined,
  tier: Tier
): readonly string[] | null {
  if (!source) {
    return null;
  }
  let workflow: unknown;
  try {
    workflow = Bun.YAML.parse(source);
  } catch {
    return null;
  }
  if (!(isRecord(workflow) && isRecord(workflow.jobs))) {
    return null;
  }
  const commands: string[] = [];
  const jobs =
    tier === "docker"
      ? JOBS
      : tier === "models"
        ? ["state-models"]
        : ["test-shard"];
  for (const name of jobs) {
    const job = workflow.jobs[name];
    if (!(isRecord(job) && Array.isArray(job.steps))) {
      continue;
    }
    for (const step of job.steps) {
      if (
        isRecord(step) &&
        typeof step.run === "string" &&
        (tier !== "build" ||
          (typeof step.if === "string" &&
            step.if.includes("outputs.build_smoke")))
      ) {
        commands.push(step.run);
      }
    }
  }
  return commands.length ? commands : null;
}

function inputCollector(reader: ReturnType<typeof inputReader>) {
  const inputs = new Set<string>();
  const queue: string[] = [];
  const queued = new Set<string>();
  const add = (file: string, follow = true): void => {
    const normalized = posix.normalize(file).replace(/^\.\//, "");
    if (
      !normalized ||
      normalized === "." ||
      normalized.startsWith("../") ||
      posix.isAbsolute(normalized)
    ) {
      return;
    }
    const kind = reader.kind(normalized);
    if (kind === "file") {
      inputs.add(normalized);
      if (!follow || queued.has(normalized)) {
        return;
      }
      queued.add(normalized);
      queue.push(normalized);
      // Cargo compiles the crate, not just the manifest named by the build script.
      if (posix.basename(normalized) === "Cargo.toml") {
        inputs.add(`${posix.dirname(normalized)}/`);
      }
    }
    // A directory name alone is often a user-project path, not a checkout
    // dependency. Compile manifests supply explicit crate-wide inputs above;
    // shared template/fixture families remain conservatively covered by policy.
  };
  const literal = (value: string, cwd: string, follow = true): void => {
    // Bare labels and generated fixture names are not repository path witnesses.
    if (
      !/[/.]/.test(value) ||
      /\s|[\n\r$]/.test(value) ||
      /^\.{1,2}\/?$/.test(value)
    ) {
      return;
    }
    add(posix.join(cwd, value), follow);
    add(value, follow);
  };
  return { inputs, queue, add, literal };
}

function packageScript(opts: {
  readonly read: ReturnType<typeof inputReader>["read"];
  readonly cwd: string;
  readonly name: string;
}): string | undefined {
  const manifest: unknown = JSON.parse(
    opts.read(posix.join(opts.cwd, "package.json")) ?? "{}"
  );
  if (!(isRecord(manifest) && isRecord(manifest.scripts))) {
    return;
  }
  const script = manifest.scripts[opts.name];
  return typeof script === "string" ? script : undefined;
}

function commandDirectory(command: { text: string; cwd: string }) {
  const changeDirectory = /^cd\s+([.\w/-]+)\s+&&\s*/.exec(command.text);
  const text = changeDirectory
    ? command.text.slice(changeDirectory[0].length)
    : command.text;
  const cwd = changeDirectory?.[1]
    ? posix.join(command.cwd, changeDirectory[1])
    : command.cwd;
  return { text, cwd };
}

function collectPythonUnittests(opts: {
  readonly text: string;
  readonly cwd: string;
  readonly reader: ReturnType<typeof inputReader>;
  readonly collector: ReturnType<typeof inputCollector>;
}): void {
  for (const [, directory, pattern] of opts.text.matchAll(
    /\bpython3?\s+-m\s+unittest\s+discover\s+-s\s+([.\w/-]+)(?:[ \t]+-p[ \t]+['"]?([\w.*?-]+))?/g
  )) {
    if (!directory) {
      continue;
    }
    const root = posix.join(opts.cwd, directory);
    for (const test of opts.reader.glob(
      posix.join(root, "**", pattern ?? "test*.py")
    )) {
      opts.collector.add(test);
    }
  }
}

function collectCommands(opts: {
  readonly commands: readonly string[];
  readonly cwd?: string;
  readonly reader: ReturnType<typeof inputReader>;
  readonly collector: ReturnType<typeof inputCollector>;
}): void {
  const scripts = new Set<string>();
  const queue = opts.commands.map((text) => ({ text, cwd: opts.cwd ?? "." }));
  while (queue.length) {
    const command = queue.pop();
    if (!command) {
      break;
    }
    const { text, cwd } = commandDirectory(command);
    collectPythonUnittests({
      text,
      cwd,
      reader: opts.reader,
      collector: opts.collector,
    });
    for (const match of text.matchAll(
      /(?:^|[\s"'=])([.\w/-]+\.(?:[cm]?[jt]sx?|sh|py|json|toml|lock|ya?ml))\b/g
    )) {
      if (match[1]) {
        opts.collector.literal(match[1], cwd);
      }
    }
    for (const match of text.matchAll(
      /\bbun\s+run\s+(?:--cwd\s+([\w./-]+)\s+)?([\w:-]+)/g
    )) {
      const directory = match[1] ? posix.join(cwd, match[1]) : cwd;
      const key = `${directory}:${match[2]}`;
      if (scripts.has(key)) {
        continue;
      }
      scripts.add(key);
      const script = packageScript({
        read: opts.reader.read,
        cwd: directory,
        name: match[2] ?? "",
      });
      if (script) {
        queue.push({ text: script, cwd: directory });
      }
    }
  }
}

function callName(node: ts.CallExpression): string {
  if (ts.isIdentifier(node.expression)) {
    return node.expression.text;
  }
  return ts.isPropertyAccessExpression(node.expression)
    ? node.expression.name.text
    : "";
}

function collectLiteralPaths(opts: {
  readonly file: string;
  readonly source: string;
  readonly collector: ReturnType<typeof inputCollector>;
}): void {
  const ast = ts.createSourceFile(
    opts.file,
    opts.source,
    ts.ScriptTarget.Latest,
    false
  );
  const cwd = posix.dirname(opts.file);
  const dataKeys = new Set<ts.Node>();
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && ts.isStringLiteralLike(node.name)) {
      dataKeys.add(node.name);
    }
    if (ts.isStringLiteralLike(node)) {
      // Inventory keys name data; spelling a test path does not execute its
      // module. Explicit imports and workflow commands still traverse it.
      opts.collector.literal(node.text, cwd, !dataKeys.has(node));
    }
    if (ts.isCallExpression(node)) {
      const name = callName(node);
      if (name === "join" || name === "resolve") {
        const pieces = node.arguments
          .filter(ts.isStringLiteralLike)
          .map((arg) => arg.text);
        if (pieces.length) {
          opts.collector.literal(posix.join(...pieces), cwd);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
}

function collectTextReferences(opts: {
  readonly file: string;
  readonly source: string;
  readonly collector: ReturnType<typeof inputCollector>;
  readonly reader: ReturnType<typeof inputReader>;
}): void {
  const { file, source, reader, collector } = opts;
  const cwd = posix.dirname(file);
  switch (posix.extname(file)) {
    case ".sh":
      collectCommands({
        commands: [source.replace(/\$\{(?:SCRIPT_DIR|script_dir)\}\//g, "./")],
        cwd,
        reader,
        collector,
      });
      break;
    case ".py":
      // Benchmark controls load checkout modules and reference files via pathlib.
      // Literal references can be resolved without importing untrusted Python.
      for (const match of source.matchAll(/(['"])([.\w/-]+)\1/g)) {
        if (match[2]) {
          collector.literal(match[2], cwd);
        }
      }
      break;
    default:
      break;
  }
}

function collectFiles(opts: {
  readonly tier: Tier;
  readonly collector: ReturnType<typeof inputCollector>;
  readonly reader: ReturnType<typeof inputReader>;
  readonly graph: ReturnType<typeof buildSelectionGraph>;
}) {
  const { tier, collector, reader, graph } = opts;
  if (tier === "build") {
    // Release packaging enumerates these directories rather than naming each file.
    collector.inputs.add("binaries/gum/");
    collector.inputs.add("packages/config-compiler/generated/");
  }
  const contexts: ReturnType<typeof dockerContextInputs>[] = [];
  for (let index = 0; index < collector.queue.length; index += 1) {
    const file = collector.queue[index];
    if (!file) {
      continue;
    }
    if (/\.[cm]?[jt]sx?$/.test(file)) {
      const module = selectionModuleInputs({ graph, file });
      for (const dependency of module.dependencies) {
        collector.add(dependency);
      }
      if (module.source) {
        collectLiteralPaths({ file, source: module.source, collector });
      }
      continue;
    }
    const source = reader.read(file);
    if (!source) {
      continue;
    }
    collectTextReferences({ file, source, reader, collector });
    const builds = tier === "docker" ? dockerBuilds(file, source) : [];
    for (const build of builds) {
      contexts.push(dockerContextInputs({ ...build, read: reader.read }));
    }
  }
  return contexts;
}

function dockerBuilds(file: string, source: string) {
  if (
    /(?:^|\/)Dockerfile(?:[.-][^/]*)?$/.test(file) &&
    !file.endsWith(".dockerignore")
  ) {
    // The runtime image builder passes the checkout root as its build context.
    return [{ context: ".", dockerfile: file }];
  }
  return /\.ya?ml$/.test(file) ? composeBuilds(file, source) : [];
}

/**
 * Directory entries end in `/`; local imports and literal execution/data paths
 * retain exact paths. Only source/configuration is parsed; repository code never runs.
 * Missing workflow evidence returns null so the caller selects every job.
 */
export function deriveJobInputs(
  opts: InputOptions & { readonly tier: Tier }
): JobInputs | null {
  const key = `${opts.tier}:${opts.repoRoot}`;
  const saved = opts.sources ? undefined : cache.get(key);
  if (saved) {
    return saved;
  }
  const reader = inputReader(opts);
  const commands = workflowCommands(
    reader.read(".github/workflows/ci.yml"),
    opts.tier
  );
  if (!commands) {
    return null;
  }
  const collector = inputCollector(reader);
  collectCommands({ commands, reader, collector });
  const graph = buildSelectionGraph({
    ...opts,
    ...(opts.sources ? { tests: [] } : {}),
  });
  const contexts = collectFiles({ tier: opts.tier, collector, reader, graph });
  for (const context of contexts) {
    for (const definition of context.definitions) {
      collector.inputs.add(definition);
    }
  }
  const prefixes = [...collector.inputs].filter((path) => path.endsWith("/"));
  const result = {
    has(path: string): boolean {
      return (
        collector.inputs.has(path) ||
        prefixes.some((prefix) => path.startsWith(prefix)) ||
        contexts.some((context) => context.includes(path))
      );
    },
  };
  if (!opts.sources) {
    cache.set(key, result);
  }
  return result;
}

export function dockerJobInputs(opts: InputOptions): JobInputs | null {
  return deriveJobInputs({ ...opts, tier: "docker" });
}

export function matchesDockerJobInput(opts: {
  readonly path: string;
  readonly inputs: JobInputs;
}): boolean {
  return opts.inputs.has(opts.path);
}
