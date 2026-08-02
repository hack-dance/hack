import { createHash } from "node:crypto";
import { unlink } from "node:fs/promises";
import { resolve } from "node:path";

import { readTextFile } from "../lib/fs.ts";
import { isRecord } from "../lib/guards.ts";
import { type ExecResult, exec, findExecutableInPath } from "../lib/shell.ts";
import {
  checkDeprecatedPluginMcpConfig,
  removeDeprecatedPluginMcpConfig,
} from "../mcp/install.ts";
import { renderCursorRules } from "./cursor.ts";
import { normalizeInstructionText } from "./instruction-source.ts";
import {
  type AgentPluginResult,
  mergePluginPreparation,
} from "./plugin-lifecycle.ts";

export type CursorPluginScope = "project" | "user";

export type CursorPluginResult = AgentPluginResult<CursorPluginScope>;

type CursorCommand = (command: readonly string[]) => Promise<ExecResult>;

const PLUGIN_ID = "hack@hack-dance";
const MARKETPLACE_COMMAND =
  "cursor-agent plugin marketplace add hack-dance/hack";
const PLUGIN_GUIDANCE = [
  `Add the Hack marketplace with: ${MARKETPLACE_COMMAND}`,
  "Then open /plugin in Cursor, choose the Hack Dance marketplace, and install Hack.",
  "Start a new Cursor session after installation.",
].join(" ");
const LEGACY_RULE_FINGERPRINTS = new Set([
  "f5b8078be4d7aec0df32f8334ad5a45acc4632541527dcae4e1f6e5144f05922",
  "c79b88aacda891f9cfe76c7addfce704129dd5bc72415dc3aa5fd262a6e46396",
]);

/** Check whether the official Hack plugin is installed and enabled in Cursor. */
export async function checkHackCursorPlugin(opts: {
  readonly scope: CursorPluginScope;
  readonly runCursorCommand?: CursorCommand;
}): Promise<CursorPluginResult> {
  const executable = findCursorExecutable();
  if (!(opts.runCursorCommand || executable)) {
    return {
      scope: opts.scope,
      status: "missing",
      path: PLUGIN_ID,
      message: `Cursor Agent CLI is not installed. ${PLUGIN_GUIDANCE}`,
    };
  }
  const runCursorCommand =
    opts.runCursorCommand ??
    createCursorCommand({ executable: executable ?? "cursor-agent" });
  const commandResult = await runCursorCommand(["plugin", "list", "--json"]);
  if (commandResult.exitCode !== 0) {
    return {
      scope: opts.scope,
      status: "error",
      path: PLUGIN_ID,
      message:
        commandResult.stderr.trim() ||
        "Could not inspect installed Cursor plugins.",
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
      message: `The Hack Cursor plugin is not installed. ${PLUGIN_GUIDANCE}`,
    };
  }
  if (!plugin.enabled) {
    return {
      scope: opts.scope,
      status: "stale",
      path: PLUGIN_ID,
      message:
        "The Hack Cursor plugin is installed but disabled. Enable it from /plugin, then start a new session.",
    };
  }
  return { scope: opts.scope, status: "noop", path: PLUGIN_ID };
}

/** Remove generated standalone Cursor artifacts and report plugin state. */
export async function prepareHackCursorPlugin(opts: {
  readonly scope: CursorPluginScope;
  readonly projectRoot?: string;
  readonly runCursorCommand?: CursorCommand;
}): Promise<CursorPluginResult> {
  const cleanup = await removeDeprecatedHackCursorIntegration(opts);
  if (cleanup.status === "error") {
    return cleanup;
  }
  const plugin = await checkHackCursorPlugin(opts);
  if (plugin.status === "error") {
    return plugin;
  }
  return mergePluginPreparation({ cleanup, plugin });
}

/** Report generated standalone Cursor rules or MCP config superseded by the plugin. */
export async function checkDeprecatedHackCursorIntegration(opts: {
  readonly scope: CursorPluginScope;
  readonly projectRoot?: string;
}): Promise<CursorPluginResult> {
  const resolved = resolveLegacyRule(opts);
  if (!resolved.ok) {
    return {
      scope: opts.scope,
      status: "error",
      path: resolved.path,
      message: resolved.message,
    };
  }
  const [rule, mcp] = await Promise.all([
    readTextFile(resolved.path),
    checkDeprecatedPluginMcpConfig({ target: "cursor", ...opts }),
  ]);
  if (mcp.status === "error") {
    return {
      scope: opts.scope,
      status: "error",
      path: mcp.path ?? resolved.path,
      message: mcp.message,
    };
  }
  return rule || mcp.status === "deprecated"
    ? {
        scope: opts.scope,
        status: "deprecated",
        path: rule ? resolved.path : (mcp.path ?? resolved.path),
        message:
          "Standalone Cursor rules or MCP config are deprecated; the Hack plugin bundles them.",
      }
    : { scope: opts.scope, status: "absent", path: resolved.path };
}

/** Safely remove generated standalone Cursor artifacts, preserving edited content. */
export async function removeDeprecatedHackCursorIntegration(opts: {
  readonly scope: CursorPluginScope;
  readonly projectRoot?: string;
}): Promise<CursorPluginResult> {
  const resolved = resolveLegacyRule(opts);
  if (!resolved.ok) {
    return {
      scope: opts.scope,
      status: "error",
      path: resolved.path,
      message: resolved.message,
    };
  }
  const content = await readTextFile(resolved.path);
  let ruleStatus: "absent" | "removed" | "preserved" = "absent";
  let ruleMessage: string | undefined;
  if (content) {
    const actual = normalizeInstructionText({ text: content });
    const expected = normalizeInstructionText({ text: renderCursorRules() });
    const fingerprint = createHash("sha256").update(actual).digest("hex");
    if (actual === expected || LEGACY_RULE_FINGERPRINTS.has(fingerprint)) {
      await unlink(resolved.path);
      ruleStatus = "removed";
    } else {
      ruleStatus = "preserved";
      ruleMessage = `Preserved user-modified legacy Cursor rules: ${resolved.path}`;
    }
  }
  const mcp = await removeDeprecatedPluginMcpConfig({
    target: "cursor",
    ...opts,
  });
  if (mcp.status === "error") {
    return {
      scope: opts.scope,
      status: "error",
      path: mcp.path ?? resolved.path,
      message: mcp.message,
    };
  }
  const messages = [ruleMessage, mcp.message].filter(
    (message): message is string => typeof message === "string"
  );
  const removed = ruleStatus === "removed" || mcp.status === "removed";
  const preserved = ruleStatus === "preserved" || mcp.status === "preserved";
  let status: CursorPluginResult["status"] = "absent";
  if (removed) {
    status = "removed";
  } else if (preserved) {
    status = "preserved";
  }
  return {
    scope: opts.scope,
    status,
    path: resolved.path,
    message: messages.length > 0 ? messages.join(" ") : undefined,
  };
}

function findCursorExecutable(): string | null {
  for (const name of ["cursor-agent", "agent", "cursor"] as const) {
    const executable = findExecutableInPath(name);
    if (executable) {
      return executable;
    }
  }
  return null;
}

function createCursorCommand(opts: {
  readonly executable: string;
}): CursorCommand {
  return async (command) =>
    await exec([opts.executable, ...command], {
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
    let entries: unknown[] | null = null;
    if (Array.isArray(value)) {
      entries = value;
    } else if (isRecord(value) && Array.isArray(value.installed)) {
      entries = value.installed;
    }
    if (!entries) {
      return {
        ok: false,
        message: "Cursor returned an unexpected plugin list response.",
      };
    }
    const plugins = entries.flatMap((entry) => {
      if (!isRecord(entry)) {
        return [];
      }
      const id = typeof entry.id === "string" ? entry.id : null;
      if (!id) {
        return [];
      }
      return [{ id, enabled: entry.enabled !== false }];
    });
    return { ok: true, plugins };
  } catch {
    return {
      ok: false,
      message: "Cursor returned invalid JSON while listing plugins.",
    };
  }
}

function resolveLegacyRule(opts: {
  readonly scope: CursorPluginScope;
  readonly projectRoot?: string;
}):
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly path: string; readonly message: string } {
  const root =
    opts.scope === "user" ? process.env.HOME?.trim() : opts.projectRoot;
  if (!root) {
    return {
      ok: false,
      path: ".cursor/rules/hack.mdc",
      message:
        opts.scope === "user"
          ? "HOME is not set; cannot resolve legacy Cursor rules."
          : "Missing project root for project-scoped Cursor rules.",
    };
  }
  return { ok: true, path: resolve(root, ".cursor", "rules", "hack.mdc") };
}
