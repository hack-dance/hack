import { dirname, resolve } from "node:path"
import { rm } from "node:fs/promises"

import { ensureDir, pathExists, readTextFile, writeTextFileIfChanged } from "../lib/fs.ts"

export type CodexSkillScope = "project" | "user"

export type CodexSkillResult = {
  readonly scope: CodexSkillScope
  readonly status: "created" | "updated" | "noop" | "removed" | "missing" | "error"
  readonly path: string
  readonly message?: string
}

const SKILL_NAME = "hack-cli"
const SKILL_FILENAME = "SKILL.md"
const SKILL_DIR = ".codex/skills"

/**
 * Install or update the Codex skill for hack CLI usage.
 */
export async function installCodexSkill(opts: {
  readonly scope: CodexSkillScope
  readonly projectRoot?: string
}): Promise<CodexSkillResult> {
  const resolved = resolveCodexSkillPath(opts)
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
  const result = await writeTextFileIfChanged(path, renderCodexSkill())

  return {
    scope: opts.scope,
    status: result.changed ? (existed ? "updated" : "created") : "noop",
    path
  }
}

/**
 * Check whether the Codex skill is installed.
 */
export async function checkCodexSkill(opts: {
  readonly scope: CodexSkillScope
  readonly projectRoot?: string
}): Promise<CodexSkillResult> {
  const resolved = resolveCodexSkillPath(opts)
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

  const hasMarker = /name:\s*hack-cli\b/i.test(content)
  return { scope: opts.scope, status: hasMarker ? "noop" : "error", path }
}

/**
 * Remove the Codex skill for hack CLI usage.
 */
export async function removeCodexSkill(opts: {
  readonly scope: CodexSkillScope
  readonly projectRoot?: string
}): Promise<CodexSkillResult> {
  const resolved = resolveCodexSkillPath(opts)
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

/**
 * Render the Codex skill template for hack CLI usage.
 */
export function renderCodexSkill(): string {
  const lines = [
    "---",
    "name: hack-cli",
    "description: >",
    "  Use the hack CLI for local dev environments (docker compose, logs, run commands) and agent integration setup.",
    "  Trigger when asked to start/stop services, open project URLs, inspect logs, run commands in services, manage",
    "  branch instances, or configure agent integrations (Cursor/Claude/Codex/MCP). Prefer CLI over MCP when shell",
    "  access is available.",
    "---",
    "",
    "# hack CLI",
    "",
    "Use hack CLI as the primary interface for local dev.",
    "",
    "## Quick Start",
    "",
    "- Start services: `hack up --detach`",
    "- Open app: `hack open --json`",
    "- Tail logs: `hack logs --pretty`",
    "- Snapshot logs: `hack logs --json --no-follow`",
    "- Run commands: `hack run <service> <cmd...>`",
    "- Stop services: `hack down`",
    "",
    "## Branch Instances",
    "",
    "Use branch instances to run parallel environments:",
    "",
    "- `hack up --branch <name> --detach`",
    "- `hack open --branch <name>`",
    "- `hack logs --branch <name>`",
    "- `hack down --branch <name>`",
    "",
    "## Logs",
    "",
    "- Loki history: `hack logs --loki --since 2h --pretty`",
    "- Filter services: `hack logs --loki --services api,web`",
    "- Force compose logs: `hack logs --compose`",
    "",
    "## Project Targeting",
    "",
    "- Run from repo root when possible.",
    "- Otherwise use `--project <name>` or `--path <repo-root>`.",
    "- List projects: `hack projects --json`.",
    "",
    "## Daemon (optional)",
    "",
    "- Start for faster JSON status/ps: `hack daemon start`",
    "- Check status: `hack daemon status`",
    "",
    "## Agent Setup",
    "",
    "- Cursor rules: `hack setup cursor`",
    "- Claude hooks: `hack setup claude`",
    "- Codex skill: `hack setup codex`",
    "- Init prompt: `hack agent init` (use --client cursor|claude|codex to open)",
    "- Init patterns: `hack agent patterns`",
    "- MCP (no shell only): `hack setup mcp`",
    ""
  ]

  return lines.join("\n")
}

function resolveCodexSkillPath(opts: {
  readonly scope: CodexSkillScope
  readonly projectRoot?: string
}): { readonly ok: true; readonly path: string } | { readonly ok: false; readonly message: string; readonly path?: string } {
  if (opts.scope === "project" && !opts.projectRoot) {
    return { ok: false, message: "Missing project root for project-scoped Codex skill." }
  }

  const root = opts.scope === "user" ? resolveHomeDir() : opts.projectRoot
  if (!root) {
    return { ok: false, message: "HOME is not set; cannot resolve Codex skill path." }
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
