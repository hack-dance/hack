/** Derive real-engine inputs from workflow commands, package scripts and module imports. */
import { readFileSync, statSync } from "node:fs";
import { posix, resolve } from "node:path";
import ts from "typescript";
import { isRecord } from "../src/lib/guards.ts";
import {
  buildSelectionGraph,
  selectionModuleInputs,
} from "./ci-test-selection.ts";

type InputOptions = {
  readonly repoRoot: string;
  readonly sources?: Readonly<Record<string, string>>;
};
const JOBS = ["docker-e2e-shard", "runtime-images", "linux-process-lifetime"];
const cache = new Map<string, ReadonlySet<string> | null>();

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
  source: string | undefined
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
  for (const name of JOBS) {
    const job = workflow.jobs[name];
    if (!(isRecord(job) && Array.isArray(job.steps))) {
      continue;
    }
    for (const step of job.steps) {
      if (isRecord(step) && typeof step.run === "string") {
        commands.push(step.run);
      }
    }
  }
  return commands.length ? commands : null;
}

function inputCollector(reader: ReturnType<typeof inputReader>) {
  const inputs = new Set<string>();
  const queue: string[] = [];
  const add = (file: string): void => {
    const normalized = posix.normalize(file).replace(/^\.\//, "");
    if (
      !normalized ||
      normalized === "." ||
      normalized.startsWith("../") ||
      posix.isAbsolute(normalized) ||
      inputs.has(normalized)
    ) {
      return;
    }
    const kind = reader.kind(normalized);
    if (kind === "file") {
      inputs.add(normalized);
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
  const literal = (value: string, cwd: string): void => {
    // Bare labels and generated fixture names are not repository path witnesses.
    if (
      !/[/.]/.test(value) ||
      /\s|[\n\r$]/.test(value) ||
      /^\.{1,2}\/?$/.test(value)
    ) {
      return;
    }
    add(posix.join(cwd, value));
    add(value);
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

function collectCommands(opts: {
  readonly commands: readonly string[];
  readonly reader: ReturnType<typeof inputReader>;
  readonly collector: ReturnType<typeof inputCollector>;
}): void {
  const scripts = new Set<string>();
  const queue = opts.commands.map((text) => ({ text, cwd: "." }));
  while (queue.length) {
    const { text, cwd } = queue.pop() as { text: string; cwd: string };
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
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node)) {
      opts.collector.literal(node.text, cwd);
    }
    if (ts.isCallExpression(node)) {
      const name = ts.isIdentifier(node.expression)
        ? node.expression.text
        : ts.isPropertyAccessExpression(node.expression)
          ? node.expression.name.text
          : "";
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

/**
 * Directory entries end in `/`; local imports and literal execution/data paths
 * retain exact paths. Only source/configuration is parsed; repository code never runs.
 * Missing workflow evidence returns null so the caller selects every job.
 */
export function dockerJobInputs(
  opts: InputOptions
): ReadonlySet<string> | null {
  if (!opts.sources && cache.has(opts.repoRoot)) {
    return cache.get(opts.repoRoot) ?? null;
  }
  const reader = inputReader(opts);
  const commands = workflowCommands(reader.read(".github/workflows/ci.yml"));
  if (!commands) {
    return null;
  }
  const collector = inputCollector(reader);
  collectCommands({ commands, reader, collector });
  const graph = buildSelectionGraph({
    ...opts,
    ...(opts.sources ? { tests: [] } : {}),
  });
  const seen = new Set<string>();
  while (collector.queue.length) {
    const file = collector.queue.pop() as string;
    if (seen.has(file)) {
      continue;
    }
    seen.add(file);
    if (!/\.[cm]?[jt]sx?$/.test(file)) {
      continue;
    }
    const module = selectionModuleInputs({ graph, file });
    for (const dependency of module.dependencies) {
      collector.add(dependency);
    }
    if (module.source) {
      collectLiteralPaths({ file, source: module.source, collector });
    }
  }
  if (!opts.sources) {
    cache.set(opts.repoRoot, collector.inputs);
  }
  return collector.inputs;
}

export function matchesDockerJobInput(opts: {
  readonly path: string;
  readonly inputs: ReadonlySet<string>;
}): boolean {
  return (
    opts.inputs.has(opts.path) ||
    [...opts.inputs].some(
      (input) => input.endsWith("/") && opts.path.startsWith(input)
    )
  );
}
