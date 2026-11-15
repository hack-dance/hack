/**
 * Strict reading of `launchctl print gui/<uid>/<label>` for the job
 * configuration launchd has LOADED (HACK-2216): what a kickstart runs,
 * which can differ from the plist on disk until the job is reloaded.
 *
 * The output is a brace-nested block:
 *
 * ```text
 * gui/501/dance.hack.hackd = {
 * 	program = /usr/local/bin/hack
 * 	arguments = {
 * 		/usr/local/bin/hack
 * 		daemon
 * 	}
 * 	environment = {
 * 		PATH => /usr/bin:/bin
 * 	}
 * }
 * ```
 *
 * Only the service block's own entries are read: `program`, the
 * `arguments` list and the `environment` dict (not the inherited or
 * default environment, which launchd uses only where the plist sets
 * nothing). Anything that does not have that shape, a repeated entry, or
 * an unbalanced block is `unknown`: never evidence of what launchd runs.
 */

export type LaunchdLoadedJob =
  | {
      readonly kind: "job";
      /** `program`, or the first argument when launchd printed none. */
      readonly program: string;
      readonly arguments: readonly string[];
      /** The job's own `PATH` (its `environment` dict); null when unset. */
      readonly path: string | null;
    }
  | { readonly kind: "unknown"; readonly reason: string };

const SERVICE_HEADER = /^\S+ = \{$/;
const BLOCK_OPEN = /^(.+?) = \{$/;
const SCALAR = /^([^=]+?) = (.*)$/;
const ENV_ENTRY = /^([^=\s]+) => (.*)$/;

interface ReadState {
  program: string | null;
  arguments: string[] | null;
  environment: Map<string, string> | null;
}

/** Reads the loaded job from `launchctl print` output (exit 0). */
export function parseLaunchdPrintJob(output: string): LaunchdLoadedJob {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0 || !SERVICE_HEADER.test(lines[0] ?? "")) {
    return unknown("launchctl print did not start with the service block");
  }
  const state: ReadState = {
    program: null,
    arguments: null,
    environment: null,
  };
  const error = readServiceBlock({ lines: lines.slice(1), state });
  if (error !== null) {
    return unknown(error);
  }
  return toJob(state);
}

function unknown(reason: string): LaunchdLoadedJob {
  return { kind: "unknown", reason };
}

function toJob(state: ReadState): LaunchdLoadedJob {
  const args = state.arguments;
  if (args === null || args.length === 0) {
    return unknown("launchd reported no arguments for the job");
  }
  const program = state.program ?? args[0] ?? "";
  if (!program.startsWith("/")) {
    return unknown("launchd reported a program that is not an absolute path");
  }
  return {
    kind: "job",
    program,
    arguments: args,
    path: state.environment?.get("PATH") ?? null,
  };
}

/**
 * The service block's entries, up to its closing brace (which must be the
 * last line). Null, or why the output is refused.
 */
function readServiceBlock(opts: {
  readonly lines: readonly string[];
  readonly state: ReadState;
}): string | null {
  const { lines, state } = opts;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line === "}") {
      return index === lines.length - 1
        ? null
        : "launchctl print had content after the service block";
    }
    const step = readServiceEntry({ lines, index, state });
    if ("error" in step) {
      return step.error;
    }
    index = step.next;
  }
  return "the service block of launchctl print was not closed";
}

/** One entry of the service block at `index`: a nested block or a scalar. */
function readServiceEntry(opts: {
  readonly lines: readonly string[];
  readonly index: number;
  readonly state: ReadState;
}): { readonly next: number } | { readonly error: string } {
  const { lines, index, state } = opts;
  const line = lines[index] ?? "";
  const open = BLOCK_OPEN.exec(line);
  if (open) {
    const block = collectBlock({ lines, start: index + 1 });
    if ("error" in block) {
      return block;
    }
    const error = readNamedBlock({
      name: open[1] ?? "",
      entries: block.entries,
      state,
    });
    return error === null ? { next: block.next } : { error };
  }
  const scalar = SCALAR.exec(line);
  if (scalar && scalar[1] === "program") {
    if (state.program !== null) {
      return { error: "launchd reported more than one program" };
    }
    state.program = scalar[2] ?? "";
  }
  return { next: index + 1 };
}

/**
 * The direct entries of a block that starts at `start`, nested blocks
 * skipped whole (only their braces are counted), and the index after its
 * closing brace.
 */
function collectBlock(opts: {
  readonly lines: readonly string[];
  readonly start: number;
}):
  | { readonly entries: readonly (string | null)[]; readonly next: number }
  | { readonly error: string } {
  const entries: (string | null)[] = [];
  let depth = 0;
  for (let index = opts.start; index < opts.lines.length; index += 1) {
    const line = opts.lines[index] ?? "";
    if (line === "}") {
      if (depth === 0) {
        return { entries, next: index + 1 };
      }
      depth -= 1;
      continue;
    }
    if (line.endsWith("{")) {
      // A nested block: not an entry of this one (null marks it).
      if (depth === 0) {
        entries.push(null);
      }
      depth += 1;
      continue;
    }
    if (depth === 0) {
      entries.push(line);
    }
  }
  return { error: "a block of launchctl print was not closed" };
}

function readNamedBlock(opts: {
  readonly name: string;
  readonly entries: readonly (string | null)[];
  readonly state: ReadState;
}): string | null {
  const { name, entries, state } = opts;
  if (name === "arguments") {
    if (state.arguments !== null) {
      return "launchd reported more than one argument list";
    }
    if (entries.some((entry) => entry === null)) {
      return "the argument list of launchctl print has a nested block";
    }
    state.arguments = entries.filter((entry) => entry !== null);
    return null;
  }
  if (name !== "environment") {
    return null;
  }
  if (state.environment !== null) {
    return "launchd reported more than one environment";
  }
  const environment = readEnvironment(entries);
  if (typeof environment === "string") {
    return environment;
  }
  state.environment = environment;
  return null;
}

/** The `KEY => value` entries of an environment block, or why not. */
function readEnvironment(
  entries: readonly (string | null)[]
): Map<string, string> | string {
  const environment = new Map<string, string>();
  for (const entry of entries) {
    const match = entry === null ? null : ENV_ENTRY.exec(entry);
    if (!match) {
      return "the environment of launchctl print has an entry it cannot read";
    }
    const key = match[1] ?? "";
    if (environment.has(key)) {
      return `launchd reported ${key} more than once`;
    }
    environment.set(key, match[2] ?? "");
  }
  return environment;
}
