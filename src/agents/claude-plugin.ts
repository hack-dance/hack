import { rm } from "node:fs/promises";
import { resolve } from "node:path";

import { pathExists, readTextFile } from "../lib/fs.ts";
import { isRecord } from "../lib/guards.ts";
import { type ExecResult, exec, findExecutableInPath } from "../lib/shell.ts";
import {
  checkDeprecatedPluginMcpConfig,
  removeDeprecatedPluginMcpConfig,
} from "../mcp/install.ts";
import { checkClaudeHooks, removeClaudeHooks } from "./claude.ts";
import { renderHackInitSkill } from "./hack-init-skill.ts";
import { normalizeInstructionText } from "./instruction-source.ts";
import {
  type AgentPluginResult,
  mergePluginPreparation,
} from "./plugin-lifecycle.ts";

export type ClaudePluginScope = "project" | "user";

export type ClaudePluginResult = AgentPluginResult<ClaudePluginScope>;

type ClaudeCommand = (command: readonly string[]) => Promise<ExecResult>;

const PLUGIN_ID = "hack@hack-dance";
const MARKETPLACE_COMMAND =
  "claude plugin marketplace add hack-dance/hack --sparse .claude-plugin plugins/hack";
const PLUGIN_GUIDANCE = [
  `Add the Hack marketplace with: ${MARKETPLACE_COMMAND}`,
  `Then install it with: claude plugin install ${PLUGIN_ID}`,
  "Start a new Claude Code session after installation.",
].join(" ");

/** Check whether the official Hack plugin is installed and enabled in Claude Code. */
export async function checkHackClaudePlugin(opts: {
  readonly scope: ClaudePluginScope;
  readonly runClaudeCommand?: ClaudeCommand;
}): Promise<ClaudePluginResult> {
  const runClaudeCommand = opts.runClaudeCommand ?? runClaudePluginList;
  if (!(opts.runClaudeCommand || findExecutableInPath("claude"))) {
    return {
      scope: opts.scope,
      status: "missing",
      path: PLUGIN_ID,
      message: `Claude Code is not installed. After installing it, ${PLUGIN_GUIDANCE}`,
    };
  }

  const commandResult = await runClaudeCommand(["plugin", "list", "--json"]);
  if (commandResult.exitCode !== 0) {
    return {
      scope: opts.scope,
      status: "error",
      path: PLUGIN_ID,
      message:
        commandResult.stderr.trim() ||
        "Could not inspect installed Claude Code plugins.",
    };
  }
  const parsed = parsePluginList({ json: commandResult.stdout });
  if (!parsed.ok) {
    return {
      scope: opts.scope,
      status: "error",
      path: PLUGIN_ID,
      message: parsed.message,
    };
  }
  const plugin = parsed.plugins.find((entry) => entry.id === PLUGIN_ID);
  if (!plugin) {
    return {
      scope: opts.scope,
      status: "missing",
      path: PLUGIN_ID,
      message: `The Hack Claude Code plugin is not installed. ${PLUGIN_GUIDANCE}`,
    };
  }
  if (!plugin.enabled) {
    return {
      scope: opts.scope,
      status: "stale",
      path: PLUGIN_ID,
      message:
        "The Hack Claude Code plugin is installed but disabled. Enable it with claude plugin enable hack@hack-dance, then start a new session.",
    };
  }
  return { scope: opts.scope, status: "noop", path: PLUGIN_ID };
}

/** Remove generated standalone Claude integration artifacts and report plugin state. */
export async function prepareHackClaudePlugin(opts: {
  readonly scope: ClaudePluginScope;
  readonly projectRoot?: string;
  readonly runClaudeCommand?: ClaudeCommand;
}): Promise<ClaudePluginResult> {
  const cleanup = await removeDeprecatedHackClaudeIntegration(opts);
  if (cleanup.status === "error") {
    return cleanup;
  }
  const plugin = await checkHackClaudePlugin(opts);
  if (plugin.status === "error") {
    return plugin;
  }
  return mergePluginPreparation({ cleanup, plugin });
}

/** Report generated standalone Claude artifacts superseded by the plugin. */
export async function checkDeprecatedHackClaudeIntegration(opts: {
  readonly scope: ClaudePluginScope;
  readonly projectRoot?: string;
}): Promise<ClaudePluginResult> {
  const resolvedSkill = resolveLegacySkill(opts);
  if (!resolvedSkill.ok) {
    return {
      scope: opts.scope,
      status: "error",
      path: resolvedSkill.path,
      message: resolvedSkill.message,
    };
  }
  const [hooks, skillExists, mcp] = await Promise.all([
    checkClaudeHooks({ ...opts, checkSkill: false }),
    pathExists(resolvedSkill.path),
    checkDeprecatedPluginMcpConfig({ target: "claude", ...opts }),
  ]);
  if (hooks.status === "error" || mcp.status === "error") {
    return {
      scope: opts.scope,
      status: "error",
      path: hooks.status === "error" ? hooks.path : (mcp.path ?? PLUGIN_ID),
      message: hooks.status === "error" ? hooks.message : mcp.message,
    };
  }
  const hasDeprecatedHooks =
    hooks.status === "noop" || hooks.status === "stale";
  const deprecated =
    hasDeprecatedHooks || skillExists || mcp.status === "deprecated";
  return deprecated
    ? {
        scope: opts.scope,
        status: "deprecated",
        path: hasDeprecatedHooks ? hooks.path : resolvedSkill.path,
        message:
          "Standalone Claude Code hooks, skill, or MCP config are deprecated; the Hack plugin bundles them.",
      }
    : { scope: opts.scope, status: "absent", path: resolvedSkill.path };
}

/** Safely remove generated standalone Claude artifacts, preserving edited skill/MCP content. */
export async function removeDeprecatedHackClaudeIntegration(opts: {
  readonly scope: ClaudePluginScope;
  readonly projectRoot?: string;
}): Promise<ClaudePluginResult> {
  const resolvedSkill = resolveLegacySkill(opts);
  if (!resolvedSkill.ok) {
    return {
      scope: opts.scope,
      status: "error",
      path: resolvedSkill.path,
      message: resolvedSkill.message,
    };
  }
  const hooks = await removeClaudeHooks({ ...opts, removeSkill: false });
  if (hooks.status === "error") {
    return {
      scope: hooks.scope,
      status: "error",
      path: hooks.path,
      message: hooks.message,
    };
  }
  const skill = await removeGeneratedSkill({ path: resolvedSkill.path });
  const mcp = await removeDeprecatedPluginMcpConfig({
    target: "claude",
    ...opts,
  });
  if (mcp.status === "error") {
    return {
      scope: opts.scope,
      status: "error",
      path: mcp.path ?? PLUGIN_ID,
      message: mcp.message,
    };
  }

  const messages = [skill.message, mcp.message].filter(
    (message): message is string => typeof message === "string"
  );
  const removed =
    hooks.status === "removed" || skill.removed || mcp.status === "removed";
  const preserved = skill.preserved || mcp.status === "preserved";
  let status: ClaudePluginResult["status"] = "absent";
  if (removed) {
    status = "removed";
  } else if (preserved) {
    status = "preserved";
  }
  return {
    scope: opts.scope,
    status,
    path: skill.path,
    message: messages.length > 0 ? messages.join(" ") : undefined,
  };
}

async function runClaudePluginList(
  command: readonly string[]
): Promise<ExecResult> {
  return await exec(["claude", ...command], {
    stdin: "ignore",
    timeoutMs: 10_000,
  });
}

function parsePluginList(opts: { readonly json: string }):
  | {
      readonly ok: true;
      readonly plugins: readonly {
        readonly id: string;
        readonly enabled: boolean;
      }[];
    }
  | { readonly ok: false; readonly message: string } {
  try {
    const value: unknown = JSON.parse(opts.json);
    if (!Array.isArray(value)) {
      return {
        ok: false,
        message: "Claude Code returned an unexpected plugin list response.",
      };
    }
    const plugins = value.flatMap((entry) => {
      if (!(isRecord(entry) && typeof entry.id === "string")) {
        return [];
      }
      return [{ id: entry.id, enabled: entry.enabled === true }];
    });
    return { ok: true, plugins };
  } catch {
    return {
      ok: false,
      message: "Claude Code returned invalid JSON while listing plugins.",
    };
  }
}

function resolveLegacySkill(opts: {
  readonly scope: ClaudePluginScope;
  readonly projectRoot?: string;
}):
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly path: string; readonly message: string } {
  const root =
    opts.scope === "user" ? process.env.HOME?.trim() : opts.projectRoot;
  if (!root) {
    return {
      ok: false,
      path: ".claude/skills/hack-init/SKILL.md",
      message:
        opts.scope === "user"
          ? "HOME is not set; cannot resolve legacy Claude Code skill."
          : "Missing project root for project-scoped Claude Code skill.",
    };
  }
  return {
    ok: true,
    path: resolve(root, ".claude", "skills", "hack-init", "SKILL.md"),
  };
}

async function removeGeneratedSkill(opts: { readonly path: string }): Promise<{
  readonly path: string;
  readonly removed: boolean;
  readonly preserved: boolean;
  readonly message?: string;
}> {
  const content = await readTextFile(opts.path);
  if (!content) {
    return { path: opts.path, removed: false, preserved: false };
  }
  const actual = normalizeInstructionText({ text: content });
  const expected = normalizeInstructionText({ text: renderHackInitSkill() });
  if (actual !== expected) {
    return {
      path: opts.path,
      removed: false,
      preserved: true,
      message: `Preserved user-modified legacy Claude Code skill: ${opts.path}`,
    };
  }
  await rm(resolve(opts.path, ".."), { recursive: true, force: true });
  return { path: opts.path, removed: true, preserved: false };
}
