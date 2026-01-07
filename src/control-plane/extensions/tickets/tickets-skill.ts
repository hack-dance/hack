import { dirname, resolve } from "node:path"
import { rm } from "node:fs/promises"

import { ensureDir, pathExists, readTextFile, writeTextFileIfChanged } from "../../../lib/fs.ts"

export type TicketsSkillScope = "project" | "user"

export type TicketsSkillResult = {
  readonly scope: TicketsSkillScope
  readonly status: "created" | "updated" | "noop" | "removed" | "missing" | "error"
  readonly path: string
  readonly message?: string
}

const SKILL_NAME = "hack-tickets"
const SKILL_FILENAME = "SKILL.md"
const SKILL_DIR = ".codex/skills"

export async function installTicketsSkill(opts: {
  readonly scope: TicketsSkillScope
  readonly projectRoot?: string
}): Promise<TicketsSkillResult> {
  const resolved = resolveTicketsSkillPath(opts)
  if (!resolved.ok) {
    return {
      scope: opts.scope,
      status: "error",
      path: resolved.path ?? SKILL_FILENAME,
      message: resolved.message
    }
  }

  const path = resolved.path
  await ensureDir(dirname(path))
  const existed = await pathExists(path)
  const result = await writeTextFileIfChanged(path, renderTicketsSkill())

  return {
    scope: opts.scope,
    status: result.changed ? (existed ? "updated" : "created") : "noop",
    path
  }
}

export async function checkTicketsSkill(opts: {
  readonly scope: TicketsSkillScope
  readonly projectRoot?: string
}): Promise<TicketsSkillResult> {
  const resolved = resolveTicketsSkillPath(opts)
  if (!resolved.ok) {
    return {
      scope: opts.scope,
      status: "error",
      path: resolved.path ?? SKILL_FILENAME,
      message: resolved.message
    }
  }

  const path = resolved.path
  const content = await readTextFile(path)
  if (!content) {
    return { scope: opts.scope, status: "missing", path }
  }

  const hasMarker = /name:\s*hack-tickets\b/i.test(content)
  return { scope: opts.scope, status: hasMarker ? "noop" : "error", path }
}

export async function removeTicketsSkill(opts: {
  readonly scope: TicketsSkillScope
  readonly projectRoot?: string
}): Promise<TicketsSkillResult> {
  const resolved = resolveTicketsSkillPath(opts)
  if (!resolved.ok) {
    return {
      scope: opts.scope,
      status: "error",
      path: resolved.path ?? SKILL_FILENAME,
      message: resolved.message
    }
  }

  const path = resolved.path
  const skillDir = resolve(path, "..")

  if (!(await pathExists(path))) {
    return { scope: opts.scope, status: "missing", path }
  }

  await rm(skillDir, { recursive: true, force: true })
  return { scope: opts.scope, status: "removed", path }
}

export function renderTicketsSkill(): string {
  const lines = [
    "---",
    "name: hack-tickets",
    "description: >",
    "  Use the hack tickets extension (git-backed JSONL event log) to create/list/show/sync lightweight tickets.",
    "  Trigger when asked to track work items, decisions, or bugs inside a repo without external issue trackers.",
    "  Prefer `hack x tickets ...` commands; store lives on branch `hack/tickets` by default.",
    "---",
    "",
    "# hack tickets",
    "",
    "This repo uses the hack tickets extension (`dance.hack.tickets`).",
    "",
    "## Enable",
    "",
    "Enable globally:",
    "",
    "- `hack config set --global 'controlPlane.extensions[\"dance.hack.tickets\"].enabled' true`",
    "",
    "Or per-project by adding `.hack/hack.config.json`:",
    "",
    "```json",
    "{",
    "  \"controlPlane\": {",
    "    \"extensions\": {",
    "      \"dance.hack.tickets\": { \"enabled\": true }",
    "    }",
    "  }",
    "}",
    "```",
    "",
    "## Commands",
    "",
    "- Create: `hack x tickets create --title \"...\" [--body \"...\"] [--body-file <path>] [--body-stdin] [--actor \"...\"] [--json]`",
    "- List: `hack x tickets list [--json]`",
    "- Show: `hack x tickets show <ticket-id> [--json]`",
    "- Status: `hack x tickets status <ticket-id> <open|in_progress|blocked|done> [--json]`",
    "- Sync: `hack x tickets sync [--json]`",
    "",
    "## Data model",
    "",
    "- Tickets are derived from an append-only event log (JSONL).",
    "- Local state lives in `.hack/tickets/`.",
    "- Sync writes commits to a dedicated branch (`hack/tickets` by default) and pushes to your remote.",
    "",
    "## Tips",
    "",
    "- Keep ticket titles short; put detail in `--body`.",
    "- Use `--json` for agent workflows and piping.",
    "- Run `hack x tickets sync` before opening PRs if you want tickets to travel with the repo.",
    ""
  ]

  return lines.join("\n")
}

function resolveTicketsSkillPath(opts: {
  readonly scope: TicketsSkillScope
  readonly projectRoot?: string
}):
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly message: string; readonly path?: string } {
  if (opts.scope === "project" && !opts.projectRoot) {
    return { ok: false, message: "Missing project root for project-scoped tickets skill." }
  }

  const root = opts.scope === "user" ? resolveHomeDir() : opts.projectRoot
  if (!root) {
    return { ok: false, message: "HOME is not set; cannot resolve tickets skill path." }
  }

  return {
    ok: true,
    path: resolve(root, SKILL_DIR, SKILL_NAME, SKILL_FILENAME)
  }
}

function resolveHomeDir(): string | null {
  const home = (process.env.HOME ?? "").trim()
  return home.length > 0 ? home : null
}
