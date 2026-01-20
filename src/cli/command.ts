import { parseArgs as bunParseArgs } from "util"

import { isRecord, isStringArray } from "../lib/guards.ts"

export type CliGroup =
  | "Global"
  | "Project"
  | "Extensions"
  | "Agents"
  | "Diagnostics"
  | "Secrets"
  | "Fun"
  | "Internal"

export type OptionType = "boolean" | "string" | "number"

export interface OptionSpec<Name extends string = string> {
  readonly name: Name
  readonly type: OptionType
  readonly long: `--${string}`
  readonly short?: `-${string}`
  readonly valueHint?: string // e.g. "<dir>", "<n>"
  readonly description: string
  readonly defaultValue?: string
}

export interface PositionalSpec<Name extends string = string> {
  readonly name: Name
  readonly required?: boolean
  readonly multiple?: boolean
  readonly description?: string
}

export interface CliContext {
  readonly cwd: string
  readonly cli: CliSpec
}

export type OptionValue<T extends OptionType> =
  T extends "boolean" ? boolean
  : T extends "number" ? number | undefined
  : string | undefined

export type OptionsValues<Opts extends readonly OptionSpec[]> = Prettify<
  {
    readonly [O in Opts[number] as O["name"]]: OptionValue<O["type"]>
  } & {}
>

type PosValueFromSpec<S extends PositionalSpec> =
  S extends { multiple: true } ? { readonly [K in S["name"]]: string[] }
  : S extends { required: true } ? { readonly [K in S["name"]]: string }
  : { readonly [K in S["name"]]: string | undefined }

type UnionToIntersection<U> =
  (U extends unknown ? (k: U) => void : never) extends (k: infer I) => void ? I : never

export type PositionalsValues<Pos extends readonly PositionalSpec[]> = Prettify<
  (Pos[number] extends never ? {} : UnionToIntersection<PosValueFromSpec<Pos[number]>>) & {}
>

export type CommandArgs<
  Opts extends readonly OptionSpec[],
  Pos extends readonly PositionalSpec[]
> = {
  readonly options: OptionsValues<Opts>
  readonly positionals: PositionalsValues<Pos>
  readonly raw: {
    readonly argv: readonly string[]
    readonly positionals: readonly string[]
  }
}

export interface CommandSpec<
  Name extends string = string,
  Opts extends readonly OptionSpec[] = readonly [],
  Pos extends readonly PositionalSpec[] = readonly [],
  Subs extends readonly AnyCommandSpec[] = readonly []
> {
  readonly name: Name
  readonly summary: string
  readonly group: CliGroup
  readonly description?: string
  readonly options: Opts
  readonly positionals: Pos
  readonly subcommands: Subs
  readonly expandInRootHelp?: boolean
}

export type AnyCommandSpec = CommandSpec<
  string,
  readonly OptionSpec[],
  readonly PositionalSpec[],
  readonly AnyCommandSpec[]
>

export interface CliSpec {
  readonly name: string
  readonly version: string
  readonly summary: string
  readonly commands: readonly AnyCommandSpec[]
  readonly globalOptions: readonly OptionSpec[]
}

export function defineOption<const O extends OptionSpec>(opt: O): O {
  return opt
}

export function defineCommand<const C extends AnyCommandSpec>(cmd: C): C {
  return cmd
}

export function defineCli<const C extends CliSpec>(cli: C): C {
  return cli
}

export type CommandHandlerFor<C extends AnyCommandSpec> = (input: {
  readonly ctx: CliContext
  readonly args: CommandArgs<C["options"], C["positionals"]>
}) => Promise<number>

export type CommandWithHandler<C extends AnyCommandSpec> = C & {
  readonly handler: CommandHandlerFor<C>
}

export function withHandler<const C extends AnyCommandSpec>(
  cmd: C,
  handler: CommandHandlerFor<C>
): CommandWithHandler<C> {
  return { ...cmd, handler }
}

export function hasHandler(cmd: AnyCommandSpec): cmd is AnyCommandSpec & {
  readonly handler: (input: {
    readonly ctx: CliContext
    readonly args: CommandArgs<readonly OptionSpec[], readonly PositionalSpec[]>
  }) => Promise<number>
} {
  const maybe = cmd as unknown as { handler?: unknown }
  return typeof maybe.handler === "function"
}

const BUILTIN_HELP_OPTION = defineOption({
  name: "help",
  type: "boolean",
  long: "--help",
  short: "-h",
  description: "Show help"
} as const)

const BUILTIN_VERSION_OPTION = defineOption({
  name: "version",
  type: "boolean",
  long: "--version",
  short: "-v",
  description: "Show version"
} as const)

export function builtinOptions(): readonly OptionSpec[] {
  return [BUILTIN_HELP_OPTION, BUILTIN_VERSION_OPTION]
}

export interface ResolvedCommand {
  readonly command: AnyCommandSpec | null
  readonly path: readonly AnyCommandSpec[]
  readonly remainingPositionals: readonly string[]
}

export function resolveCommand(cli: CliSpec, positionals: readonly string[]): ResolvedCommand {
  const path: AnyCommandSpec[] = []
  let subcommands: readonly AnyCommandSpec[] = cli.commands
  let idx = 0

  while (idx < positionals.length) {
    const token = positionals[idx] ?? ""
    const next = subcommands.find(c => c.name === token)
    if (!next) break
    path.push(next)
    subcommands = next.subcommands
    idx += 1
  }

  return {
    command: path.length > 0 ? (path[path.length - 1] ?? null) : null,
    path,
    remainingPositionals: positionals.slice(idx)
  }
}

export interface ParsedCliInvocation {
  readonly values: Record<string, unknown>
  readonly positionals: readonly string[]
}

export function parseCliArgv(
  cli: CliSpec,
  argv: readonly string[],
  opts?: { readonly allowUnknownOptions?: boolean }
): ParsedCliInvocation {
  const normalizedArgv = normalizeArgvForDefaults(cli, argv)
  const options = buildUnionParseOptions(cli)

  let parsed: unknown
  try {
    parsed = bunParseArgs({
      args: [...normalizedArgv],
      options,
      strict: opts?.allowUnknownOptions !== true,
      allowPositionals: true
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Invalid arguments"
    throw new CliUsageError(message)
  }

  const valuesUnknown: unknown = (parsed as unknown as { values: unknown }).values
  const posUnknown: unknown = (parsed as unknown as { positionals: unknown }).positionals

  if (!isRecord(valuesUnknown)) {
    return { values: {}, positionals: [] }
  }
  if (!isStringArray(posUnknown)) {
    return { values: valuesUnknown, positionals: [] }
  }

  return { values: valuesUnknown, positionals: posUnknown }
}

function normalizeArgvForDefaults(cli: CliSpec, argv: readonly string[]): string[] {
  const defaultable = new Map<string, OptionSpec>()
  for (const opt of [...builtinOptions(), ...collectAllOptions(cli)]) {
    if (opt.type === "boolean") continue
    if (!opt.defaultValue) continue
    defaultable.set(opt.long, opt)
  }

  const out: string[] = []
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] ?? ""
    if (!token.startsWith("--")) {
      out.push(token)
      continue
    }

    const eqIdx = token.indexOf("=")
    if (eqIdx !== -1) {
      out.push(token)
      continue
    }

    const opt = defaultable.get(token)
    if (!opt) {
      out.push(token)
      continue
    }

    const next = argv[i + 1]
    if (next === undefined || next.startsWith("-")) {
      out.push(`${token}=${opt.defaultValue}`)
      continue
    }

    if (opt.type === "number") {
      const n = Number(next)
      if (!Number.isFinite(n)) {
        out.push(`${token}=${opt.defaultValue}`)
        continue
      }
    }

    out.push(token)
  }

  return out
}

function buildUnionParseOptions(
  cli: CliSpec
): Record<string, { type: "string" | "boolean"; short?: string }> {
  const out: Record<string, { type: "string" | "boolean"; short?: string }> = {}
  for (const opt of [...builtinOptions(), ...collectAllOptions(cli)]) {
    const longName = opt.long.replace(/^--/, "")
    const short = opt.short ? opt.short.replace(/^-/, "") : null
    out[longName] =
      short === null ?
        { type: opt.type === "boolean" ? "boolean" : "string" }
      : { type: opt.type === "boolean" ? "boolean" : "string", short }
  }
  return out
}

function collectAllOptions(cli: CliSpec): readonly OptionSpec[] {
  const out: OptionSpec[] = [...cli.globalOptions]
  walkCommands(cli.commands, cmd => {
    out.push(...cmd.options)
  })
  return out
}

export function collectUnionOptionNames(cli: CliSpec): ReadonlySet<string> {
  const set = new Set<string>()
  for (const opt of [...builtinOptions(), ...collectAllOptions(cli)]) {
    set.add(opt.long.replace(/^--/, ""))
  }
  return set
}

function walkCommands(cmds: readonly AnyCommandSpec[], visit: (cmd: AnyCommandSpec) => void): void {
  for (const c of cmds) {
    visit(c)
    if (c.subcommands.length > 0) walkCommands(c.subcommands, visit)
  }
}

export function collectAllowedOptionNames(
  cli: CliSpec,
  command: AnyCommandSpec | null
): ReadonlySet<string> {
  const allowed = new Set<string>()
  for (const opt of builtinOptions()) allowed.add(opt.long.replace(/^--/, ""))
  for (const opt of cli.globalOptions) allowed.add(opt.long.replace(/^--/, ""))
  if (command) for (const opt of command.options) allowed.add(opt.long.replace(/^--/, ""))
  return allowed
}

export function parseOptionsForCommand<Opts extends readonly OptionSpec[]>(
  opts: Opts,
  values: Record<string, unknown>
): OptionsValues<Opts> {
  const out: Record<string, unknown> = {}

  for (const opt of opts) {
    const key = opt.long.replace(/^--/, "")
    const raw = values[key]

    if (opt.type === "boolean") {
      out[opt.name] = raw === true
      continue
    }

    if (opt.type === "string") {
      out[opt.name] = typeof raw === "string" ? raw : undefined
      continue
    }

    // number
    if (typeof raw !== "string") {
      out[opt.name] = undefined
      continue
    }

    const n = Number(raw)
    out[opt.name] = Number.isFinite(n) ? n : undefined
  }

  return out as OptionsValues<Opts>
}

export class CliUsageError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = "CliUsageError"
  }
}

export function parsePositionalsForCommand<Pos extends readonly PositionalSpec[]>(
  posSpecs: Pos,
  remaining: readonly string[]
): PositionalsValues<Pos> {
  const out: Record<string, unknown> = {}
  let idx = 0

  for (const spec of posSpecs) {
    if (spec.multiple) {
      out[spec.name] = remaining.slice(idx)
      idx = remaining.length
      continue
    }

    const value = remaining[idx]
    if (value === undefined) {
      if (spec.required) {
        throw new CliUsageError(`Missing required argument: ${spec.name}`)
      }
      out[spec.name] = undefined
      continue
    }

    out[spec.name] = value
    idx += 1
  }

  if (idx < remaining.length) {
    const extra = remaining.slice(idx).join(" ")
    throw new CliUsageError(`Unexpected arguments: ${extra}`)
  }

  return out as PositionalsValues<Pos>
}

export function renderArgsFromPositionals(
  pos: readonly PositionalSpec[] | undefined
): string | undefined {
  if (!pos || pos.length === 0) return undefined
  const parts: string[] = []

  for (const p of pos) {
    const name = p.multiple ? `${p.name}...` : p.name
    parts.push(p.required ? `<${name}>` : `[${name}]`)
  }

  return parts.join(" ")
}

export type Prettify<T> = { [K in keyof T]: T[K] } & {}
