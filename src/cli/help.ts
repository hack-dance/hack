import { builtinOptions, renderArgsFromPositionals, resolveCommand } from "./command.ts"
import { renderHackBanner } from "../lib/hack-banner.ts"
import { gumFormat, isGumAvailable } from "../ui/gum.ts"

import type { AnyCommandSpec, CliGroup, CliSpec, OptionSpec } from "./command.ts"

export function renderHelpForPath(cli: CliSpec, positionals: readonly string[]): string {
  const resolved = resolveCommand(cli, positionals)
  const matchedNames = resolved.path.map(c => c.name)
  return resolved.command ?
      renderCommandHelp(cli, resolved.command, matchedNames)
    : renderRootHelp(cli)
}

export function renderHelpMarkdownForPath(cli: CliSpec, positionals: readonly string[]): string {
  const resolved = resolveCommand(cli, positionals)
  const matchedNames = resolved.path.map(c => c.name)
  return resolved.command ?
      renderCommandHelpMarkdown(cli, resolved.command, matchedNames)
    : renderRootHelpMarkdown(cli)
}

export async function printHelpForPath(
  cli: CliSpec,
  positionals: readonly string[]
): Promise<void> {
  const banner = await renderHackBanner({ trimEmpty: true })
  const markdown = renderHelpMarkdownForPath(cli, positionals)
  const markdownWithBanner =
    banner.length > 0 ? `\`\`\`text\n${banner}\n\`\`\`\n\n${markdown}` : markdown
  if (isPrettyHelpEnabled()) {
    const res = await gumFormat({ type: "markdown", input: markdownWithBanner })
    if (res.ok) {
      writeStdout(res.value)
      return
    }
  }

  const plain = renderHelpForPath(cli, positionals)
  const plainWithBanner = banner.length > 0 ? `${banner}\n\n${plain}` : plain
  writeStdout(plainWithBanner)
}

function isPrettyHelpEnabled(): boolean {
  if (!process.stdout.isTTY) return false
  return isGumAvailable()
}

function writeStdout(text: string): void {
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`)
}

function renderRootHelp(cli: CliSpec): string {
  const lines: string[] = []

  lines.push(`${cli.name} v${cli.version} — ${cli.summary}`)
  lines.push("")
  lines.push("Usage:")
  lines.push(`  ${cli.name} <command> [options]`)
  lines.push("")

  const grouped = groupRootEntries(cli)
  for (const group of groupsInOrder()) {
    const entries = grouped.get(group)
    if (!entries || entries.length === 0) continue
    lines.push(`${groupLabel(group)}:`)
    lines.push(...renderEntryLines(entries))
    lines.push("")
  }

  const rootOptions = dedupeOptions([...builtinOptions(), ...cli.globalOptions])
  if (rootOptions.length > 0) {
    lines.push("Global options:")
    lines.push(...renderOptionLines(rootOptions))
    lines.push("")
  }
  lines.push("Tip:")
  lines.push("  Use `--help` after any command to see command-specific help.")
  lines.push("")

  return lines.join("\n")
}

function renderRootHelpMarkdown(cli: CliSpec): string {
  const lines: string[] = []

  lines.push(`## ${cli.name} v${cli.version}`)
  lines.push("")
  lines.push(mdEscape(cli.summary))
  lines.push("")
  lines.push("### Usage")
  lines.push("")
  lines.push("```bash")
  lines.push(`${cli.name} <command> [options]`)
  lines.push("```")
  lines.push("")

  const grouped = groupRootEntries(cli)
  for (const group of groupsInOrder()) {
    const entries = grouped.get(group)
    if (!entries || entries.length === 0) continue
    lines.push(`### ${groupLabel(group)}`)
    lines.push("")
    lines.push(...renderEntriesTableMarkdown(entries))
    lines.push("")
  }

  const rootOptions = dedupeOptions([...builtinOptions(), ...cli.globalOptions])
  if (rootOptions.length > 0) {
    lines.push("### Global options")
    lines.push("")
    lines.push(...renderOptionsTableMarkdown(rootOptions))
    lines.push("")
  }

  lines.push("> Tip: Use `--help` after any command to see command-specific help.")
  lines.push("")

  return lines.join("\n")
}

type RootEntry = {
  readonly group: CliGroup
  readonly invocation: string
  readonly summary: string
}

function groupRootEntries(cli: CliSpec): Map<CliGroup, RootEntry[]> {
  const map = new Map<CliGroup, RootEntry[]>()
  const push = (group: CliGroup, entry: RootEntry) => {
    const arr = map.get(group) ?? []
    arr.push(entry)
    map.set(group, arr)
  }

  for (const cmd of cli.commands) {
    if (cmd.expandInRootHelp && cmd.subcommands.length > 0) {
      for (const sub of cmd.subcommands) {
        const invocation = buildInvocation(cli.name, [cmd.name, sub.name], sub)
        push(cmd.group, { group: cmd.group, invocation, summary: sub.summary })
      }
      continue
    }

    const invocation = buildInvocation(cli.name, [cmd.name], cmd)
    push(cmd.group, { group: cmd.group, invocation, summary: cmd.summary })
  }

  for (const [group, entries] of map.entries()) {
    map.set(
      group,
      [...entries].sort((a, b) => a.invocation.localeCompare(b.invocation))
    )
  }

  return map
}

function renderCommandHelp(
  cli: CliSpec,
  command: AnyCommandSpec,
  matchedPath: readonly string[]
): string {
  const lines: string[] = []

  const invocation = buildInvocation(cli.name, matchedPath, command)
  lines.push(`${invocation} — ${command.summary}`)
  lines.push("")
  lines.push("Usage:")
  lines.push(`  ${invocation} [options]`)
  lines.push("")

  if (command.description) {
    lines.push(command.description)
    lines.push("")
  }

  if (command.subcommands.length > 0) {
    lines.push("Subcommands:")
    const entries = command.subcommands.map(sub => ({
      group: command.group,
      invocation: buildInvocation(cli.name, [...matchedPath, sub.name], sub),
      summary: sub.summary
    }))
    lines.push(...renderEntryLines(entries))
    lines.push("")
  }

  const options = dedupeOptions([...command.options, ...cli.globalOptions, ...builtinOptions()])
  if (options.length > 0) {
    lines.push("Options:")
    lines.push(...renderOptionLines(options))
    lines.push("")
  }

  return lines.join("\n")
}

function renderCommandHelpMarkdown(
  cli: CliSpec,
  command: AnyCommandSpec,
  matchedPath: readonly string[]
): string {
  const lines: string[] = []

  const invocation = buildInvocation(cli.name, matchedPath, command)
  lines.push(`## ${mdCode(invocation)}`)
  lines.push("")
  lines.push(mdEscape(command.summary))
  lines.push("")

  lines.push("### Usage")
  lines.push("")
  lines.push("```bash")
  lines.push(`${invocation} [options]`)
  lines.push("```")
  lines.push("")

  if (command.description) {
    lines.push(mdEscape(command.description))
    lines.push("")
  }

  if (command.positionals.length > 0) {
    lines.push("### Arguments")
    lines.push("")
    lines.push(...renderPositionalsMarkdown(command.positionals))
    lines.push("")
  }

  if (command.subcommands.length > 0) {
    lines.push("### Subcommands")
    lines.push("")
    const entries = command.subcommands.map(sub => ({
      group: command.group,
      invocation: buildInvocation(cli.name, [...matchedPath, sub.name], sub),
      summary: sub.summary
    }))
    lines.push(...renderEntriesTableMarkdown(entries))
    lines.push("")
  }

  const options = dedupeOptions([...command.options, ...cli.globalOptions, ...builtinOptions()])
  if (options.length > 0) {
    lines.push("### Options")
    lines.push("")
    lines.push(...renderOptionsTableMarkdown(options))
    lines.push("")
  }

  return lines.join("\n")
}

function buildInvocation(cliName: string, path: readonly string[], cmd: AnyCommandSpec): string {
  const args = renderArgsFromPositionals(cmd.positionals)
  const base = [cliName, ...path].join(" ")
  return args ? `${base} ${args}` : base
}

function renderEntryLines(entries: readonly RootEntry[]): string[] {
  const width = Math.max(...entries.map(e => e.invocation.length), 0)
  return entries.map(e => `  ${padRight(e.invocation, width + 2)}${e.summary}`)
}

function renderOptionLines(options: readonly OptionSpec[]): string[] {
  const formatted = options.map(formatOption)
  const width = Math.max(...formatted.map(f => f.left.length), 0)
  return formatted.map(({ left, right }) => `  ${padRight(left, width + 2)}${right}`)
}

function renderEntriesTableMarkdown(entries: readonly RootEntry[]): string[] {
  const lines: string[] = []
  lines.push("| Command | Summary |")
  lines.push("| --- | --- |")
  for (const e of entries) {
    lines.push(`| ${mdCode(e.invocation)} | ${mdEscape(e.summary)} |`)
  }
  return lines
}

function renderOptionsTableMarkdown(options: readonly OptionSpec[]): string[] {
  const lines: string[] = []
  lines.push("| Option | Description |")
  lines.push("| --- | --- |")
  for (const o of options) {
    const { left, right } = formatOption(o)
    lines.push(`| ${mdCode(left)} | ${mdEscape(right)} |`)
  }
  return lines
}

function renderPositionalsMarkdown(
  positionals: readonly {
    readonly name: string
    readonly description?: string
  }[]
): string[] {
  const lines: string[] = []
  lines.push("| Arg | Description |")
  lines.push("| --- | --- |")
  for (const p of positionals) {
    lines.push(`| ${mdCode(p.name)} | ${mdEscape(p.description ?? "")} |`)
  }
  return lines
}

function formatOption(o: OptionSpec): {
  readonly left: string
  readonly right: string
} {
  const parts: string[] = []
  parts.push(o.long)
  if (o.short) parts.push(o.short)

  const hint = o.type === "boolean" ? "" : ` ${o.valueHint ?? "<value>"}`
  const left = `${parts.join(", ")}${hint}`
  const right = o.defaultValue ? `${o.description} (default: ${o.defaultValue})` : o.description
  return { left, right }
}

function dedupeOptions(options: readonly OptionSpec[]): OptionSpec[] {
  const seen = new Set<string>()
  const out: OptionSpec[] = []
  for (const o of options) {
    const key = `${o.long}|${o.short ?? ""}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(o)
  }
  return out
}

function padRight(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length)
}

function groupsInOrder(): readonly CliGroup[] {
  return ["Global", "Project", "Extensions", "Agents", "Diagnostics", "Secrets", "Fun"] as const
}

function groupLabel(group: CliGroup): string {
  return (
    {
      Global: "Global commands",
      Project: "Project commands",
      Extensions: "Extensions",
      Agents: "Agent integrations",
      Diagnostics: "Diagnostics",
      Secrets: "Secrets",
      Fun: "Fun",
      Internal: "Internal"
    } satisfies Record<CliGroup, string>
  )[group]
}

function mdCode(text: string): string {
  return `\`${text}\``
}

function mdEscape(text: string): string {
  return text.replaceAll("|", "\\|")
}
