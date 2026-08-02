import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";

import { pathExists, readTextFile } from "../lib/fs.ts";
import { isRecord } from "../lib/guards.ts";
import { type ExecResult, exec, findExecutableInPath } from "../lib/shell.ts";
import {
  checkDeprecatedCodexMcpConfig,
  removeDeprecatedCodexMcpConfig,
} from "../mcp/install.ts";
import { renderCodexSkill } from "./codex-skill.ts";
import { renderHackInitSkill } from "./hack-init-skill.ts";
import { normalizeInstructionText } from "./instruction-source.ts";
import {
  type AgentPluginResult,
  mergePluginPreparation,
} from "./plugin-lifecycle.ts";

export type CodexPluginScope = "project" | "user";

export type CodexPluginResult = AgentPluginResult<CodexPluginScope>;

type CodexCommand = (command: readonly string[]) => Promise<ExecResult>;

const PLUGIN_ID = "hack@hack-dance";
const MARKETPLACE_COMMAND =
  "codex plugin marketplace add hack-dance/hack --sparse .agents/plugins --sparse plugins/hack";
const PLUGIN_GUIDANCE = [
  `Add the Hack marketplace with: ${MARKETPLACE_COMMAND}`,
  "Then open /plugins, install and enable Hack, and start a new Codex session.",
].join(" ");

/** Check whether the official Hack plugin is installed and enabled in Codex. */
export async function checkHackCodexPlugin(opts: {
  readonly scope: CodexPluginScope;
  readonly runCodexCommand?: CodexCommand;
}): Promise<CodexPluginResult> {
  const runCodexCommand = opts.runCodexCommand ?? runCodexPluginList;
  if (!(opts.runCodexCommand || findExecutableInPath("codex"))) {
    return {
      scope: opts.scope,
      status: "missing",
      path: PLUGIN_ID,
      message: `Codex is not installed. After installing Codex, ${PLUGIN_GUIDANCE}`,
    };
  }

  const commandResult = await runCodexCommand(["plugin", "list", "--json"]);
  if (commandResult.exitCode !== 0) {
    return {
      scope: opts.scope,
      status: "error",
      path: PLUGIN_ID,
      message:
        commandResult.stderr.trim() ||
        "Could not inspect installed Codex plugins.",
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

  const plugin = parsed.plugins.find(
    (entry) =>
      entry.name === "hack" &&
      entry.marketplaceName === "hack-dance" &&
      entry.installed
  );
  if (!plugin) {
    return {
      scope: opts.scope,
      status: "missing",
      path: PLUGIN_ID,
      message: `The Hack Codex plugin is not installed. ${PLUGIN_GUIDANCE}`,
    };
  }
  if (!plugin.enabled) {
    return {
      scope: opts.scope,
      status: "stale",
      path: PLUGIN_ID,
      message:
        "The Hack Codex plugin is installed but disabled. Enable it in /plugins, then start a new session.",
    };
  }
  return { scope: opts.scope, status: "noop", path: PLUGIN_ID };
}

/**
 * Prepare Codex integration without mutating Codex's plugin registry.
 *
 * Matching legacy generated skills are removed. User-modified copies are
 * preserved, and missing plugin installation is returned as guidance rather
 * than silently installing external state.
 */
export async function prepareHackCodexPlugin(opts: {
  readonly scope: CodexPluginScope;
  readonly projectRoot?: string;
  readonly runCodexCommand?: CodexCommand;
}): Promise<CodexPluginResult> {
  const cleanup = await removeDeprecatedHackCodexIntegration(opts);
  if (cleanup.status === "error") {
    return cleanup;
  }
  const plugin = await checkHackCodexPlugin(opts);
  if (plugin.status === "error") {
    return plugin;
  }
  return mergePluginPreparation({ cleanup, plugin });
}

/** Report all standalone Codex artifacts superseded by the plugin. */
export async function checkDeprecatedHackCodexIntegration(opts: {
  readonly scope: CodexPluginScope;
  readonly projectRoot?: string;
}): Promise<CodexPluginResult> {
  const [skills, mcp] = await Promise.all([
    checkDeprecatedCodexSkills(opts),
    checkDeprecatedCodexMcpConfig(opts),
  ]);
  if (skills.status === "error") {
    return skills;
  }
  if (mcp.status === "error") {
    return {
      scope: opts.scope,
      status: "error",
      path: mcp.path ?? PLUGIN_ID,
      message: mcp.message,
    };
  }

  const deprecated =
    skills.status === "deprecated" || mcp.status === "deprecated";
  return deprecated
    ? {
        scope: opts.scope,
        status: "deprecated",
        path:
          skills.status === "deprecated"
            ? skills.path
            : (mcp.path ?? PLUGIN_ID),
        message:
          "Standalone Codex skills or MCP config are deprecated; the Hack plugin bundles them.",
      }
    : { scope: opts.scope, status: "absent", path: skills.path };
}

/** Remove safe-to-delete skill and MCP artifacts from the pre-plugin integration. */
export async function removeDeprecatedHackCodexIntegration(opts: {
  readonly scope: CodexPluginScope;
  readonly projectRoot?: string;
}): Promise<CodexPluginResult> {
  const [skills, mcp] = await Promise.all([
    removeDeprecatedCodexSkills(opts),
    removeDeprecatedCodexMcpConfig(opts),
  ]);
  if (skills.status === "error") {
    return skills;
  }
  if (mcp.status === "error") {
    return {
      scope: opts.scope,
      status: "error",
      path: mcp.path ?? "hack@hack-dance",
      message: mcp.message,
    };
  }

  const messages = [skills.message, mcp.message].filter(
    (message): message is string => typeof message === "string"
  );
  const removed = skills.status === "removed" || mcp.status === "removed";
  const preserved = skills.status === "preserved" || mcp.status === "preserved";
  let status: CodexPluginResult["status"] = "absent";
  if (removed) {
    status = "removed";
  } else if (preserved) {
    status = "preserved";
  }
  return {
    scope: opts.scope,
    status,
    path: skills.path || mcp.path || "hack@hack-dance",
    message: messages.length > 0 ? messages.join(" ") : undefined,
  };
}

/** Report project/user Codex skills generated by older Hack releases. */
export async function checkDeprecatedCodexSkills(opts: {
  readonly scope: CodexPluginScope;
  readonly projectRoot?: string;
}): Promise<CodexPluginResult> {
  const resolved = resolveLegacySkills(opts);
  if (!resolved.ok) {
    return {
      scope: opts.scope,
      status: "error",
      path: resolved.path,
      message: resolved.message,
    };
  }
  const existing: string[] = [];
  for (const skill of resolved.skills) {
    if (await pathExists(skill.path)) {
      existing.push(skill.path);
    }
  }
  if (existing.length === 0) {
    return { scope: opts.scope, status: "absent", path: resolved.root };
  }
  return {
    scope: opts.scope,
    status: "deprecated",
    path: existing[0] ?? resolved.root,
    message:
      "Legacy generated Codex skills are installed. Run hack setup sync to remove unmodified copies; edited copies are preserved.",
  };
}

/** Remove only legacy Codex skills whose contents still match Hack's renderer. */
export async function removeDeprecatedCodexSkills(opts: {
  readonly scope: CodexPluginScope;
  readonly projectRoot?: string;
}): Promise<CodexPluginResult> {
  const resolved = resolveLegacySkills(opts);
  if (!resolved.ok) {
    return {
      scope: opts.scope,
      status: "error",
      path: resolved.path,
      message: resolved.message,
    };
  }

  const removed: string[] = [];
  const preserved: string[] = [];
  for (const skill of resolved.skills) {
    const content = await readTextFile(skill.path);
    if (!content) {
      continue;
    }
    const fingerprint = fingerprintSkill({ content });
    const currentFingerprint = fingerprintSkill({ content: skill.expected });
    if (
      fingerprint !== currentFingerprint &&
      !skill.legacyFingerprints.includes(fingerprint)
    ) {
      preserved.push(skill.path);
      continue;
    }
    await rm(resolve(skill.path, ".."), { recursive: true, force: true });
    removed.push(skill.path);
  }

  const message =
    preserved.length > 0
      ? `Preserved user-modified legacy Codex skills: ${preserved.join(", ")}`
      : undefined;
  if (removed.length > 0) {
    return {
      scope: opts.scope,
      status: "removed",
      path: removed[0] ?? resolved.root,
      message,
    };
  }
  if (preserved.length > 0) {
    return {
      scope: opts.scope,
      status: "preserved",
      path: preserved[0] ?? resolved.root,
      message,
    };
  }
  return { scope: opts.scope, status: "absent", path: resolved.root };
}

async function runCodexPluginList(
  command: readonly string[]
): Promise<ExecResult> {
  return await exec(["codex", ...command], {
    stdin: "ignore",
    timeoutMs: 10_000,
  });
}

function parsePluginList(opts: { readonly json: string }):
  | {
      readonly ok: true;
      readonly plugins: readonly {
        readonly name: string;
        readonly marketplaceName: string;
        readonly installed: boolean;
        readonly enabled: boolean;
      }[];
    }
  | { readonly ok: false; readonly message: string } {
  try {
    const value: unknown = JSON.parse(opts.json);
    if (!(isRecord(value) && Array.isArray(value.installed))) {
      return {
        ok: false,
        message: "Codex returned an unexpected plugin list response.",
      };
    }
    const plugins = value.installed.flatMap((entry) => {
      if (
        !isRecord(entry) ||
        typeof entry.name !== "string" ||
        typeof entry.marketplaceName !== "string"
      ) {
        return [];
      }
      return [
        {
          name: entry.name,
          marketplaceName: entry.marketplaceName,
          installed: entry.installed === true,
          enabled: entry.enabled === true,
        },
      ];
    });
    return { ok: true, plugins };
  } catch {
    return {
      ok: false,
      message: "Codex returned invalid JSON while listing plugins.",
    };
  }
}

function resolveLegacySkills(opts: {
  readonly scope: CodexPluginScope;
  readonly projectRoot?: string;
}):
  | {
      readonly ok: true;
      readonly root: string;
      readonly skills: readonly {
        readonly path: string;
        readonly expected: string;
        readonly legacyFingerprints: readonly string[];
      }[];
    }
  | { readonly ok: false; readonly path: string; readonly message: string } {
  const root =
    opts.scope === "user" ? process.env.HOME?.trim() : opts.projectRoot;
  if (!root) {
    return {
      ok: false,
      path: ".codex/skills",
      message:
        opts.scope === "user"
          ? "HOME is not set; cannot resolve legacy Codex skills."
          : "Missing project root for project-scoped Codex skills.",
    };
  }
  const skillsRoot = resolve(root, ".codex", "skills");
  return {
    ok: true,
    root: skillsRoot,
    skills: [
      {
        path: resolve(skillsRoot, "hack-cli", "SKILL.md"),
        expected: renderCodexSkill(),
        legacyFingerprints: [
          "b86781701ccea462513224112ceccc4bebbdc5a0de25c8b651d1a5f2215c4d25",
          "6d90537002bbf64ee15a835bdb3cc458e6342a0fd7dd09a710a2cf2e5374217b",
        ],
      },
      {
        path: resolve(skillsRoot, "hack-init", "SKILL.md"),
        expected: renderHackInitSkill(),
        legacyFingerprints: [
          "cd15fb6d8ed8e25071d05e756570f66b53f3a3bacbaab1ce2357440d0ae0a5d6",
        ],
      },
    ],
  };
}

function fingerprintSkill(opts: { readonly content: string }): string {
  return createHash("sha256")
    .update(normalizeInstructionText({ text: opts.content }))
    .digest("hex");
}
