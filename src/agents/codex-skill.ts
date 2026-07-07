import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  ensureDir,
  pathExists,
  readTextFile,
  writeTextFileIfChanged,
} from "../lib/fs.ts";
import {
  normalizeInstructionText,
  renderInstructionSections,
} from "./instruction-source.ts";

export type CodexSkillScope = "project" | "user";

export type CodexSkillResult = {
  readonly scope: CodexSkillScope;
  readonly status:
    | "created"
    | "updated"
    | "noop"
    | "stale"
    | "removed"
    | "missing"
    | "error";
  readonly path: string;
  readonly message?: string;
};

const SKILL_NAME = "hack-cli";
const SKILL_FILENAME = "SKILL.md";
const SKILL_DIR = ".codex/skills";
const HACK_CLI_MARKER_REGEX = /name:\s*hack-cli\b/i;

/**
 * Install or update the Codex skill for hack CLI usage.
 */
export async function installCodexSkill(opts: {
  readonly scope: CodexSkillScope;
  readonly projectRoot?: string;
}): Promise<CodexSkillResult> {
  const resolved = resolveCodexSkillPath(opts);
  if (!resolved.ok) {
    return {
      scope: opts.scope,
      status: "error",
      path: resolved.path ?? SKILL_FILENAME,
      message: resolved.message,
    };
  }

  const path = resolved.path;
  await ensureDir(dirname(path));
  const existed = await pathExists(path);
  const result = await writeTextFileIfChanged(path, renderCodexSkill());

  const status = resolveInstallStatus({ changed: result.changed, existed });
  return { scope: opts.scope, status, path };
}

/**
 * Check whether the Codex skill is installed and current.
 *
 * Reports `stale` when the skill file exists but its content no longer
 * matches the current render (normalized comparison).
 */
export async function checkCodexSkill(opts: {
  readonly scope: CodexSkillScope;
  readonly projectRoot?: string;
}): Promise<CodexSkillResult> {
  const resolved = resolveCodexSkillPath(opts);
  if (!resolved.ok) {
    return {
      scope: opts.scope,
      status: "error",
      path: resolved.path ?? SKILL_FILENAME,
      message: resolved.message,
    };
  }

  const path = resolved.path;
  const content = await readTextFile(path);
  if (!content) {
    return { scope: opts.scope, status: "missing", path };
  }

  if (!HACK_CLI_MARKER_REGEX.test(content)) {
    return { scope: opts.scope, status: "error", path };
  }

  const current = normalizeInstructionText({ text: renderCodexSkill() });
  if (normalizeInstructionText({ text: content }) !== current) {
    return {
      scope: opts.scope,
      status: "stale",
      path,
      message: "Codex skill content is out of date. Run: hack setup codex",
    };
  }

  return { scope: opts.scope, status: "noop", path };
}

/**
 * Remove the Codex skill for hack CLI usage.
 */
export async function removeCodexSkill(opts: {
  readonly scope: CodexSkillScope;
  readonly projectRoot?: string;
}): Promise<CodexSkillResult> {
  const resolved = resolveCodexSkillPath(opts);
  if (!resolved.ok) {
    return {
      scope: opts.scope,
      status: "error",
      path: resolved.path ?? SKILL_FILENAME,
      message: resolved.message,
    };
  }

  const path = resolved.path;
  const skillDir = resolve(path, "..");

  if (!(await pathExists(path))) {
    return { scope: opts.scope, status: "missing", path };
  }

  await rm(skillDir, { recursive: true, force: true });
  return { scope: opts.scope, status: "removed", path };
}

/**
 * Render the Codex skill template for hack CLI usage.
 *
 * Frontmatter and top-level framing live here; the instructional content is
 * the `skill`-tagged sections from the shared instruction source.
 */
export function renderCodexSkill(): string {
  const lines = [
    "---",
    "name: hack-cli",
    "description: >",
    "  Use the hack CLI for local runtime orchestration (compose, DNS/TLS, logs, env, persistent project workspaces) and agent setup.",
    "  Trigger when asked to run/start/stop services, inspect logs, manage lifecycle/workspace workflows, or update",
    "  agent integrations. Prefer CLI over MCP when shell access is available.",
    "---",
    "",
    "# hack CLI",
    "",
    "Use `hack` as the primary interface for local-first development.",
    "",
    renderInstructionSections({ surface: "skill", headingStyle: "markdown" }),
    "",
  ];

  return lines.join("\n");
}

function resolveCodexSkillPath(opts: {
  readonly scope: CodexSkillScope;
  readonly projectRoot?: string;
}):
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly message: string; readonly path?: string } {
  if (opts.scope === "project" && !opts.projectRoot) {
    return {
      ok: false,
      message: "Missing project root for project-scoped Codex skill.",
    };
  }

  const root = opts.scope === "user" ? resolveHomeDir() : opts.projectRoot;
  if (!root) {
    return {
      ok: false,
      message: "HOME is not set; cannot resolve Codex skill path.",
    };
  }

  return {
    ok: true,
    path: resolve(root, SKILL_DIR, SKILL_NAME, SKILL_FILENAME),
  };
}

function resolveHomeDir(): string | null {
  const home = (process.env.HOME ?? "").trim();
  return home.length > 0 ? home : null;
}

function resolveInstallStatus(opts: {
  readonly changed: boolean;
  readonly existed: boolean;
}): "created" | "updated" | "noop" {
  if (!opts.changed) {
    return "noop";
  }
  return opts.existed ? "updated" : "created";
}
