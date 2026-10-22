import { parseArgs as bunParseArgs } from "node:util";

import { isRecord, isStringArray } from "../lib/guards.ts";

const LONG_OPTION_PREFIX_REGEX = /^--/;
const SHORT_OPTION_PREFIX_REGEX = /^-/;

export type CliGroup =
  | "Global"
  | "Project"
  | "Integrations"
  | "Beta"
  | "Extensions"
  | "Agents"
  | "Diagnostics"
  | "Secrets"
  | "Fun"
  | "Internal";

export type OptionType = "boolean" | "string" | "number";

export interface OptionSpec<Name extends string = string> {
  readonly name: Name;
  readonly type: OptionType;
  readonly long: `--${string}`;
  readonly short?: `-${string}`;
  readonly valueHint?: string; // e.g. "<dir>", "<n>"
  readonly description: string;
  readonly defaultValue?: string;
}

export interface PositionalSpec<Name extends string = string> {
  readonly name: Name;
  readonly required?: boolean;
  readonly multiple?: boolean;
  readonly description?: string;
  /**
   * A child command's argv starts at this positional. From its first token on,
   * every token belongs to the child, including flags such as `--version`,
   * `--help` or `--json`; Hack's own options must come before it. A `--` before
   * the child argv is still accepted and is not passed on, while a `--` inside
   * the child argv is passed through unchanged. Only the last positional of a
   * command may set this. Without `multiple`, the child command is one quoted
   * argument, and any further token is refused with a hint to quote it.
   */
  readonly passthrough?: boolean;
}

export interface CliContext {
  readonly cwd: string;
  readonly cli: CliSpec;
}

export type OptionValue<T extends OptionType> = T extends "boolean"
  ? boolean
  : T extends "number"
    ? number | undefined
    : string | undefined;

export type OptionsValues<Opts extends readonly OptionSpec[]> = Prettify<
  {
    readonly [O in Opts[number] as O["name"]]: OptionValue<O["type"]>;
  } & {}
>;

type PosValueFromSpec<S extends PositionalSpec> = S extends { multiple: true }
  ? { readonly [K in S["name"]]: string[] }
  : S extends { required: true }
    ? { readonly [K in S["name"]]: string }
    : { readonly [K in S["name"]]: string | undefined };

type UnionToIntersection<U> = (
  U extends unknown
    ? (k: U) => void
    : never
) extends (k: infer I) => void
  ? I
  : never;

export type PositionalsValues<Pos extends readonly PositionalSpec[]> = Prettify<
  (Pos[number] extends never
    ? Record<string, never>
    : UnionToIntersection<PosValueFromSpec<Pos[number]>>) &
    Record<string, never>
>;

export type CommandArgs<
  Opts extends readonly OptionSpec[],
  Pos extends readonly PositionalSpec[],
> = {
  readonly options: OptionsValues<Opts>;
  readonly positionals: PositionalsValues<Pos>;
  readonly raw: {
    readonly argv: readonly string[];
    readonly positionals: readonly string[];
  };
};

export interface CommandSpec<
  Name extends string = string,
  Opts extends readonly OptionSpec[] = readonly [],
  Pos extends readonly PositionalSpec[] = readonly [],
  Subs extends readonly AnyCommandSpec[] = readonly [],
> {
  readonly name: Name;
  readonly summary: string;
  readonly group: CliGroup;
  readonly description?: string;
  readonly options: Opts;
  readonly positionals: Pos;
  readonly subcommands: Subs;
  readonly expandInRootHelp?: boolean;
  readonly allowUnknownOptions?: boolean;
  /** Fixed stderr-only failure text for commands whose stdout contains sensitive raw data. */
  readonly sensitiveOutputError?: string;
}

export type AnyCommandSpec = CommandSpec<
  string,
  readonly OptionSpec[],
  readonly PositionalSpec[],
  readonly AnyCommandSpec[]
>;

export interface CliSpec {
  readonly name: string;
  readonly version: string;
  readonly summary: string;
  readonly highlights?: readonly string[];
  readonly commands: readonly AnyCommandSpec[];
  readonly globalOptions: readonly OptionSpec[];
}

export function defineOption<const O extends OptionSpec>(opt: O): O {
  return opt;
}

export function defineCommand<const C extends AnyCommandSpec>(cmd: C): C {
  return cmd;
}

export function defineCli<const C extends CliSpec>(cli: C): C {
  return cli;
}

export type CommandHandlerFor<C extends AnyCommandSpec> = (input: {
  readonly ctx: CliContext;
  readonly args: CommandArgs<C["options"], C["positionals"]>;
}) => Promise<number>;

export type CommandWithHandler<C extends AnyCommandSpec> = C & {
  readonly handler: CommandHandlerFor<C>;
};

export function withHandler<const C extends AnyCommandSpec>(
  cmd: C,
  handler: CommandHandlerFor<C>
): CommandWithHandler<C> {
  return { ...cmd, handler };
}

export function hasHandler(cmd: AnyCommandSpec): cmd is AnyCommandSpec & {
  readonly handler: (input: {
    readonly ctx: CliContext;
    readonly args: CommandArgs<
      readonly OptionSpec[],
      readonly PositionalSpec[]
    >;
  }) => Promise<number>;
} {
  const maybe = cmd as unknown as { handler?: unknown };
  return typeof maybe.handler === "function";
}

const BUILTIN_HELP_OPTION = defineOption({
  name: "help",
  type: "boolean",
  long: "--help",
  short: "-h",
  description: "Show help",
} as const);

const BUILTIN_VERSION_OPTION = defineOption({
  name: "version",
  type: "boolean",
  long: "--version",
  short: "-v",
  description: "Show version",
} as const);

export function builtinOptions(): readonly OptionSpec[] {
  return [BUILTIN_HELP_OPTION, BUILTIN_VERSION_OPTION];
}

export interface ResolvedCommand {
  readonly command: AnyCommandSpec | null;
  readonly path: readonly AnyCommandSpec[];
  readonly remainingPositionals: readonly string[];
}

export function resolveCommand(
  cli: CliSpec,
  positionals: readonly string[]
): ResolvedCommand {
  const path: AnyCommandSpec[] = [];
  let subcommands: readonly AnyCommandSpec[] = cli.commands;
  let idx = 0;

  while (idx < positionals.length) {
    const token = positionals[idx] ?? "";
    const next = subcommands.find((c) => c.name === token);
    if (!next) {
      break;
    }
    path.push(next);
    subcommands = next.subcommands;
    idx += 1;
  }

  return {
    command: path.length > 0 ? (path.at(-1) ?? null) : null,
    path,
    remainingPositionals: positionals.slice(idx),
  };
}

export interface ParsedCliInvocation {
  readonly values: Record<string, unknown>;
  readonly positionals: readonly string[];
}

/**
 * Parses argv in two passes. The first resolves the command path from the
 * leading positionals ({@link scanInvocation}); the second parses with that
 * command's own options plus the global and built-in ones, so each command
 * keeps its own short flags and option types: `-p` is `--path` for project
 * commands and `--port` for `ssh`, and one long name may be a flag in one
 * command and take a value in another.
 *
 * An option only other commands declare is still parsed by its long name
 * (never by its short flag), so the caller can refuse it as not valid for the
 * resolved command rather than as unknown.
 */
export function parseCliArgv(
  cli: CliSpec,
  argv: readonly string[],
  opts?: { readonly allowUnknownOptions?: boolean }
): ParsedCliInvocation {
  const { command, childStart } = scanInvocation(cli, argv);
  const table = optionTableFor(cli, command);
  const normalizedArgv =
    childStart === null
      ? normalizeArgvForDefaults(table, argv)
      : [
          ...normalizeArgvForDefaults(table, argv.slice(0, childStart)),
          // End Hack's option parsing: the child argv is passed on verbatim.
          "--",
          ...argv.slice(childStart),
        ];

  let parsed: unknown;
  try {
    parsed = bunParseArgs({
      args: [...normalizedArgv],
      options: parseArgsOptions(table),
      strict: opts?.allowUnknownOptions !== true,
      allowPositionals: true,
    });
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Invalid arguments";
    throw new CliUsageError(message);
  }

  const valuesUnknown: unknown = (parsed as unknown as { values: unknown })
    .values;
  const posUnknown: unknown = (parsed as unknown as { positionals: unknown })
    .positionals;

  if (!isRecord(valuesUnknown)) {
    return { values: {}, positionals: [] };
  }
  if (!isStringArray(posUnknown)) {
    return { values: valuesUnknown, positionals: [] };
  }

  return { values: valuesUnknown, positionals: posUnknown };
}

function normalizeArgvForDefaults(
  table: OptionTable,
  argv: readonly string[]
): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] ?? "";
    if (!token.startsWith("--")) {
      out.push(token);
      continue;
    }

    const eqIdx = token.indexOf("=");
    if (eqIdx !== -1) {
      out.push(token);
      continue;
    }

    const opt = table.byLong.get(token);
    if (!(opt && isDefaultableOption(opt))) {
      out.push(token);
      continue;
    }

    if (shouldApplyDefault({ opt, nextToken: argv[i + 1] })) {
      out.push(`${token}=${opt.defaultValue}`);
      continue;
    }

    out.push(token);
  }

  return out;
}

/**
 * Index of the first child-command token for a command whose positional is
 * marked {@link PositionalSpec.passthrough}, or null when there is none or an
 * explicit `--` already ends Hack's options before it.
 *
 * Without this boundary, `hack run web bun --version` would let Hack's own
 * `--version` (or `--help`, `--json`, `--path`...) consume a flag meant for
 * the child. See {@link scanInvocation} for how option values are skipped.
 */
export function findPassthroughStart(
  cli: CliSpec,
  argv: readonly string[]
): number | null {
  return scanInvocation(cli, argv).childStart;
}

/** The command an argv resolves to, and where its child argv starts. */
interface ScannedInvocation {
  readonly command: AnyCommandSpec | null;
  readonly childStart: number | null;
}

/**
 * First parse pass: resolves the command path from the leading positionals
 * and finds the child-command boundary, as the second pass will read them.
 *
 * Each option token is read with the options of the command resolved so far
 * (plus the global and built-in ones), and its value token is skipped,
 * including the omitted-value form of options with a default. An option that
 * command does not declare, such as one placed before the command name, is
 * read as the other declarations of that spelling read it; when they disagree
 * on taking a value, it is read as a flag. After an explicit `--` every token
 * is a positional and there is no child boundary.
 */
function scanInvocation(
  cli: CliSpec,
  argv: readonly string[]
): ScannedInvocation {
  const state: ScanState = {
    command: null,
    subcommands: cli.commands,
    separated: false,
    positionalIndex: 0,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] ?? "";
    if (state.separated || token === "-" || !token.startsWith("-")) {
      const step = scanPositional(state, token);
      if (step !== "next") {
        return {
          command: state.command,
          childStart: step === "child" ? i : null,
        };
      }
    } else if (token === "--") {
      state.separated = true;
    } else if (
      consumesNextToken({
        opt: scanOption({ cli, command: state.command, token }),
        token,
        nextToken: argv[i + 1],
      })
    ) {
      i += 1;
    }
  }
  return { command: state.command, childStart: null };
}

interface ScanState {
  command: AnyCommandSpec | null;
  subcommands: readonly AnyCommandSpec[];
  /** An explicit `--` was seen: every later token is a positional. */
  separated: boolean;
  /** Index among the resolved command's own positionals. */
  positionalIndex: number;
}

/**
 * Reads one positional token: a subcommand name extends the path; otherwise
 * it is the command's own positional, which may be where the child argv
 * starts ("child") or show there is no child boundary ("done").
 */
function scanPositional(
  state: ScanState,
  token: string
): "next" | "child" | "done" {
  const next = state.subcommands.find((c) => c.name === token);
  if (next) {
    state.command = next;
    state.subcommands = next.subcommands;
    return "next";
  }
  const start = state.separated
    ? null
    : passthroughPositionalIndex(state.command);
  if (start === null) {
    return "done";
  }
  if (state.positionalIndex === start) {
    return "child";
  }
  state.subcommands = [];
  state.positionalIndex += 1;
  return "next";
}

/**
 * The leading argv tokens that belong to Hack: everything before the child
 * command of a passthrough positional and before the first `--`. Raw-argv
 * checks (for example whether `--json` selects Hack's error envelope) must
 * read only these, so a child's own `--json` never changes Hack's output.
 */
export function hackOwnedArgv(
  cli: CliSpec,
  argv: readonly string[]
): readonly string[] {
  const separator = argv.indexOf("--");
  const childStart = findPassthroughStart(cli, argv);
  const end = Math.min(
    separator === -1 ? argv.length : separator,
    childStart ?? argv.length
  );
  return argv.slice(0, end);
}

/** The option an option token names while `command` is resolved so far. */
function scanOption(opts: {
  readonly cli: CliSpec;
  readonly command: AnyCommandSpec | null;
  readonly token: string;
}): OptionSpec | undefined {
  if (opts.token.includes("=")) {
    return;
  }
  const table = optionTableFor(opts.cli, opts.command);
  if (opts.token.startsWith("--")) {
    return table.byLong.get(opts.token);
  }
  return (
    table.byShort.get(opts.token) ??
    declarationsBySpelling(opts.cli).byShort.get(opts.token)
  );
}

/** True when an option token takes the following token as its value. */
function consumesNextToken(opts: {
  readonly opt: OptionSpec | undefined;
  readonly token: string;
  readonly nextToken: string | undefined;
}): boolean {
  const { opt } = opts;
  return (
    opt !== undefined &&
    opt.type !== "boolean" &&
    !omitsOptionValue({ token: opts.token, opt, nextToken: opts.nextToken })
  );
}

/** A long option with a default takes no value token when none follows. */
function omitsOptionValue(opts: {
  readonly token: string;
  readonly opt: OptionSpec;
  readonly nextToken: string | undefined;
}): boolean {
  return (
    opts.token.startsWith("--") &&
    isDefaultableOption(opts.opt) &&
    shouldApplyDefault({ opt: opts.opt, nextToken: opts.nextToken })
  );
}

function passthroughPositionalIndex(
  command: AnyCommandSpec | null
): number | null {
  if (!command) {
    return null;
  }
  const index = command.positionals.findIndex((p) => p.passthrough === true);
  return index === -1 ? null : index;
}

function isDefaultableOption(opt: OptionSpec): boolean {
  return opt.type !== "boolean" && Boolean(opt.defaultValue);
}

function shouldApplyDefault(opts: {
  readonly opt: OptionSpec;
  readonly nextToken: string | undefined;
}): boolean {
  const next = opts.nextToken;
  if (next === undefined || next.startsWith("-")) {
    return true;
  }
  if (opts.opt.type === "number") {
    return !Number.isFinite(Number(next));
  }
  return false;
}

/** The options one command parses with, by long and by short spelling. */
interface OptionTable {
  readonly byLong: ReadonlyMap<string, OptionSpec>;
  readonly byShort: ReadonlyMap<string, OptionSpec>;
}

const commandOptionTables = new WeakMap<
  CliSpec,
  Map<AnyCommandSpec | null, OptionTable>
>();

/**
 * The parse table for `command` (null before a command resolves): its own
 * options plus the global and built-in ones, by long and short spelling, then
 * each option only other commands declare, by long spelling alone. A short
 * flag never carries over from another command.
 */
function optionTableFor(
  cli: CliSpec,
  command: AnyCommandSpec | null
): OptionTable {
  const cached = commandOptionTables.get(cli)?.get(command);
  if (cached) {
    return cached;
  }
  const byLong = new Map<string, OptionSpec>();
  const byShort = new Map<string, OptionSpec>();
  const scope = [
    ...builtinOptions(),
    ...cli.globalOptions,
    ...(command?.options ?? []),
  ];
  for (const opt of scope) {
    byLong.set(opt.long, opt);
    if (opt.short) {
      byShort.set(opt.short, opt);
    }
  }
  for (const [long, opt] of declarationsBySpelling(cli).byLong) {
    if (!byLong.has(long)) {
      byLong.set(long, opt);
    }
  }
  const table: OptionTable = { byLong, byShort };
  const tables =
    commandOptionTables.get(cli) ??
    new Map<AnyCommandSpec | null, OptionTable>();
  tables.set(command, table);
  commandOptionTables.set(cli, tables);
  return table;
}

const declarationTables = new WeakMap<CliSpec, OptionTable>();

/**
 * One representative per option spelling across the whole command tree, for
 * reading an option outside a scope that declares it. When the declarations
 * disagree on taking a value, the representative is a flag, so it never
 * consumes a token that may be a command name or a positional.
 */
function declarationsBySpelling(cli: CliSpec): OptionTable {
  const cached = declarationTables.get(cli);
  if (cached) {
    return cached;
  }
  const longs = new Map<string, OptionSpec[]>();
  const shorts = new Map<string, OptionSpec[]>();
  for (const opt of [...builtinOptions(), ...collectAllOptions(cli)]) {
    longs.set(opt.long, [...(longs.get(opt.long) ?? []), opt]);
    if (opt.short) {
      shorts.set(opt.short, [...(shorts.get(opt.short) ?? []), opt]);
    }
  }
  const table: OptionTable = {
    byLong: representativeDeclarations(longs),
    byShort: representativeDeclarations(shorts),
  };
  declarationTables.set(cli, table);
  return table;
}

function representativeDeclarations(
  declarations: ReadonlyMap<string, readonly OptionSpec[]>
): ReadonlyMap<string, OptionSpec> {
  const out = new Map<string, OptionSpec>();
  for (const [spelling, opts] of declarations) {
    const last = opts.at(-1);
    if (!last) {
      continue;
    }
    const kinds = new Set(opts.map((opt) => opt.type === "boolean"));
    out.set(
      spelling,
      kinds.size === 1
        ? last
        : { ...last, type: "boolean", defaultValue: undefined }
    );
  }
  return out;
}

function parseArgsOptions(
  table: OptionTable
): Record<string, { type: "string" | "boolean"; short?: string }> {
  const out: Record<string, { type: "string" | "boolean"; short?: string }> =
    {};
  for (const [long, opt] of table.byLong) {
    out[long.replace(LONG_OPTION_PREFIX_REGEX, "")] = {
      type: opt.type === "boolean" ? "boolean" : "string",
    };
  }
  for (const [short, opt] of table.byShort) {
    const entry = out[opt.long.replace(LONG_OPTION_PREFIX_REGEX, "")];
    if (entry) {
      entry.short = short.replace(SHORT_OPTION_PREFIX_REGEX, "");
    }
  }
  return out;
}

function collectAllOptions(cli: CliSpec): readonly OptionSpec[] {
  const out: OptionSpec[] = [...cli.globalOptions];
  walkCommands(cli.commands, (cmd) => {
    out.push(...cmd.options);
  });
  return out;
}

export function collectUnionOptionNames(cli: CliSpec): ReadonlySet<string> {
  const set = new Set<string>();
  for (const opt of [...builtinOptions(), ...collectAllOptions(cli)]) {
    set.add(opt.long.replace(LONG_OPTION_PREFIX_REGEX, ""));
  }
  return set;
}

function walkCommands(
  cmds: readonly AnyCommandSpec[],
  visit: (cmd: AnyCommandSpec) => void
): void {
  for (const c of cmds) {
    visit(c);
    if (c.subcommands.length > 0) {
      walkCommands(c.subcommands, visit);
    }
  }
}

export function collectAllowedOptionNames(
  cli: CliSpec,
  command: AnyCommandSpec | null
): ReadonlySet<string> {
  const allowed = new Set<string>();
  for (const opt of builtinOptions()) {
    allowed.add(opt.long.replace(LONG_OPTION_PREFIX_REGEX, ""));
  }
  for (const opt of cli.globalOptions) {
    allowed.add(opt.long.replace(LONG_OPTION_PREFIX_REGEX, ""));
  }
  if (command) {
    for (const opt of command.options) {
      allowed.add(opt.long.replace(LONG_OPTION_PREFIX_REGEX, ""));
    }
  }
  return allowed;
}

export function parseOptionsForCommand<Opts extends readonly OptionSpec[]>(
  opts: Opts,
  values: Record<string, unknown>
): OptionsValues<Opts> {
  const out: Record<string, unknown> = {};

  for (const opt of opts) {
    const key = opt.long.replace(LONG_OPTION_PREFIX_REGEX, "");
    const raw = values[key];

    if (opt.type === "boolean") {
      out[opt.name] = raw === true;
      continue;
    }

    if (opt.type === "string") {
      out[opt.name] = typeof raw === "string" ? raw : undefined;
      continue;
    }

    // number
    if (typeof raw !== "string") {
      out[opt.name] = undefined;
      continue;
    }

    const n = Number(raw);
    out[opt.name] = Number.isFinite(n) ? n : undefined;
  }

  return out as OptionsValues<Opts>;
}

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

export function parsePositionalsForCommand<
  Pos extends readonly PositionalSpec[],
>(posSpecs: Pos, remaining: readonly string[]): PositionalsValues<Pos> {
  const out: Record<string, unknown> = {};
  let idx = 0;

  for (const spec of posSpecs) {
    if (spec.multiple) {
      out[spec.name] = remaining.slice(idx);
      idx = remaining.length;
      continue;
    }

    const value = remaining[idx];
    if (value === undefined) {
      if (spec.required) {
        throw new CliUsageError(`Missing required argument: ${spec.name}`);
      }
      out[spec.name] = undefined;
      continue;
    }

    out[spec.name] = value;
    idx += 1;
  }

  if (idx < remaining.length) {
    const single = posSpecs.at(-1);
    if (single?.passthrough === true && single.multiple !== true) {
      // A single-valued child command (such as `session exec`'s <command>)
      // takes the whole command line as one quoted argument.
      const extra = remaining.slice(idx).join(" ");
      const whole = [out[single.name], ...remaining.slice(idx)].join(" ");
      throw new CliUsageError(
        `Unexpected arguments: ${extra}. <${single.name}> is one argument; quote the whole command, as in ${JSON.stringify(whole)}.`
      );
    }
    // Count only: an extra argument is often a pasted `KEY=value` or secret.
    const extra = remaining.length - idx;
    throw new CliUsageError(
      `Unexpected arguments: ${extra} more than this command accepts. They are not shown because they may contain values.`
    );
  }

  return out as PositionalsValues<Pos>;
}

export function renderArgsFromPositionals(
  pos: readonly PositionalSpec[] | undefined
): string | undefined {
  if (!pos || pos.length === 0) {
    return undefined;
  }
  const parts: string[] = [];

  for (const p of pos) {
    const name = p.multiple ? `${p.name}...` : p.name;
    parts.push(p.required ? `<${name}>` : `[${name}]`);
  }

  return parts.join(" ");
}

export type Prettify<T> = { [K in keyof T]: T[K] } & {};
