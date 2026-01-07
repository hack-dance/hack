import { resolve } from "node:path"

import { pathExists, readTextFile, writeTextFileIfChanged } from "../../../lib/fs.ts"

export type TicketsAgentDocTarget = "agents" | "claude"

export type TicketsAgentDocUpdateResult = {
  readonly target: TicketsAgentDocTarget
  readonly status: "created" | "updated" | "noop" | "error"
  readonly path: string
  readonly message?: string
}

export type TicketsAgentDocCheckResult = {
  readonly target: TicketsAgentDocTarget
  readonly status: "present" | "missing" | "error"
  readonly path: string
  readonly message?: string
}

export type TicketsAgentDocRemoveResult = {
  readonly target: TicketsAgentDocTarget
  readonly status: "removed" | "noop" | "error"
  readonly path: string
  readonly message?: string
}

const DOC_MARKER_START = "<!-- hack:tickets:start -->"
const DOC_MARKER_END = "<!-- hack:tickets:end -->"

export async function upsertTicketsAgentDocs(opts: {
  readonly projectRoot: string
  readonly targets: readonly TicketsAgentDocTarget[]
}): Promise<TicketsAgentDocUpdateResult[]> {
  const results: TicketsAgentDocUpdateResult[] = []
  const snippet = renderTicketsAgentDocsSnippet()

  for (const target of opts.targets) {
    const path = resolveTicketsAgentDocPath({ projectRoot: opts.projectRoot, target })
    try {
      const existed = await pathExists(path)
      const existing = (await readTextFile(path)) ?? ""
      const next = upsertSnippet({ existing, snippet })
      const result = await writeTextFileIfChanged(path, next)
      const status = result.changed ? (existed ? "updated" : "created") : "noop"
      results.push({ target, status, path })
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Failed to update file"
      results.push({ target, status: "error", path, message })
    }
  }

  return results
}

export async function checkTicketsAgentDocs(opts: {
  readonly projectRoot: string
  readonly targets: readonly TicketsAgentDocTarget[]
}): Promise<TicketsAgentDocCheckResult[]> {
  const results: TicketsAgentDocCheckResult[] = []

  for (const target of opts.targets) {
    const path = resolveTicketsAgentDocPath({ projectRoot: opts.projectRoot, target })
    try {
      const existing = await readTextFile(path)
      if (!existing) {
        results.push({ target, status: "missing", path })
        continue
      }

      if (!hasTicketsAgentDocSnippet({ content: existing })) {
        results.push({ target, status: "error", path, message: "Missing hack tickets markers." })
        continue
      }

      results.push({ target, status: "present", path })
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Failed to read file"
      results.push({ target, status: "error", path, message })
    }
  }

  return results
}

export async function removeTicketsAgentDocs(opts: {
  readonly projectRoot: string
  readonly targets: readonly TicketsAgentDocTarget[]
}): Promise<TicketsAgentDocRemoveResult[]> {
  const results: TicketsAgentDocRemoveResult[] = []

  for (const target of opts.targets) {
    const path = resolveTicketsAgentDocPath({ projectRoot: opts.projectRoot, target })
    try {
      const existing = await readTextFile(path)
      if (!existing) {
        results.push({ target, status: "noop", path })
        continue
      }

      const next = removeSnippet({ existing })
      if (next === existing) {
        results.push({ target, status: "noop", path })
        continue
      }

      await writeTextFileIfChanged(path, next)
      results.push({ target, status: "removed", path })
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Failed to update file"
      results.push({ target, status: "error", path, message })
    }
  }

  return results
}

export function renderTicketsAgentDocsSnippet(): string {
  const lines = [
    DOC_MARKER_START,
    "## Tickets (git-backed)",
    "",
    "This project uses `hack` tickets (extension: `dance.hack.tickets`).",
    "",
    "Common commands:",
    "- Create: `hack x tickets create --title \"...\" --body-stdin` (pipe long context)",
    "- List: `hack x tickets list`",
    "- Show: `hack x tickets show T-00001`",
    "- Status: `hack x tickets status T-00001 in_progress`",
    "- Sync: `hack x tickets sync`",
    "",
    "Data lives in `.hack/tickets/` and syncs to branch `hack/tickets` by default.",
    DOC_MARKER_END,
    ""
  ]

  return lines.join("\n")
}

function resolveTicketsAgentDocPath(opts: {
  readonly projectRoot: string
  readonly target: TicketsAgentDocTarget
}): string {
  return resolve(opts.projectRoot, opts.target === "agents" ? "AGENTS.md" : "CLAUDE.md")
}

function hasTicketsAgentDocSnippet(opts: { readonly content: string }): boolean {
  return opts.content.includes(DOC_MARKER_START) && opts.content.includes(DOC_MARKER_END)
}

function upsertSnippet(opts: { readonly existing: string; readonly snippet: string }): string {
  const existing = opts.existing
  const start = existing.indexOf(DOC_MARKER_START)
  const end = existing.indexOf(DOC_MARKER_END)

  if (start !== -1 && end !== -1 && end > start) {
    const afterEnd = end + DOC_MARKER_END.length
    const prefix = existing.slice(0, start).trimEnd()
    const suffix = existing.slice(afterEnd).trimStart()
    const glued = [prefix, opts.snippet.trim(), suffix].filter(Boolean).join("\n\n")
    return `${glued.trimEnd()}\n`
  }

  const trimmed = existing.trimEnd()
  if (!trimmed) return `${opts.snippet.trim()}\n`

  return `${trimmed}\n\n${opts.snippet.trim()}\n`
}

function removeSnippet(opts: { readonly existing: string }): string {
  const existing = opts.existing
  const start = existing.indexOf(DOC_MARKER_START)
  const end = existing.indexOf(DOC_MARKER_END)

  if (start === -1 || end === -1 || end < start) return existing

  const afterEnd = end + DOC_MARKER_END.length
  const prefix = existing.slice(0, start).trimEnd()
  const suffix = existing.slice(afterEnd).trimStart()

  const next = [prefix, suffix].filter(Boolean).join("\n\n")
  return next ? `${next.trimEnd()}\n` : ""
}
