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
  checkNativeAgentPlugin,
  mergeLegacyCleanupResults,
  prepareNativeAgentPlugin,
} from "./plugin-lifecycle.ts";

export type CursorPluginScope = "project" | "user";

export type CursorPluginResult = AgentPluginResult<CursorPluginScope>;

type CursorCommand = (command: readonly string[]) => Promise<ExecResult>;

const PLUGIN_ID = "hack@hack-dance";
const MARKETPLACE_COMMAND =
  "cursor-agent plugin marketplace add hack-dance/hack";
const PLUGIN_GUIDANCE = [
  `Add the Hack marketplace with: ${MARKETPLACE_COMMAND}`,
  "Then open /add-plugin in Cursor and install Hack from the Hack Dance marketplace.",
  "Start a new Cursor session after installation.",
].join(" ");
const LEGACY_RULE_FINGERPRINTS = new Set([
  "1b2d92dbd4ef71c9a4a96d270cf4aaf38059ee907b5ccb38db8457ec031862a4",
  "f5b8078be4d7aec0df32f8334ad5a45acc4632541527dcae4e1f6e5144f05922",
  "c79b88aacda891f9cfe76c7addfce704129dd5bc72415dc3aa5fd262a6e46396",
]);

/** Check whether the official Hack plugin is installed and enabled in Cursor. */
export async function checkHackCursorPlugin(opts: {
  readonly scope: CursorPluginScope;
  readonly runCursorCommand?: CursorCommand;
}): Promise<CursorPluginResult> {
  const executable = findCursorExecutable();
  return await checkNativeAgentPlugin({
    scope: opts.scope,
    pluginId: PLUGIN_ID,
    runCommand:
      opts.runCursorCommand ??
      (executable ? createCursorCommand({ executable }) : null),
    missingExecutableMessage: `Cursor Agent CLI is not installed. ${PLUGIN_GUIDANCE}`,
    inspectErrorMessage: "Could not inspect installed Cursor plugins.",
    missingPluginMessage: `The Hack Cursor plugin is not installed. ${PLUGIN_GUIDANCE}`,
    disabledPluginMessage:
      "The Hack Cursor plugin is installed but disabled. Enable it from Settings > Plugins, then start a new session.",
    parseState: parseCursorPluginState,
  });
}

/** Remove generated standalone Cursor artifacts and report plugin state. */
export async function prepareHackCursorPlugin(opts: {
  readonly scope: CursorPluginScope;
  readonly projectRoot?: string;
  readonly runCursorCommand?: CursorCommand;
}): Promise<CursorPluginResult> {
  return await prepareNativeAgentPlugin({
    cleanup: async () => await removeDeprecatedHackCursorIntegration(opts),
    check: async () => await checkHackCursorPlugin(opts),
  });
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
  return mergeLegacyCleanupResults({
    scope: opts.scope,
    fallbackPath: resolved.path,
    results: [
      { status: ruleStatus, path: resolved.path, message: ruleMessage },
      mcp,
    ],
  });
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

function parseCursorPluginState(opts: { readonly json: string }) {
  const parsed = parsePluginList(opts);
  if (!parsed.ok) {
    return parsed;
  }
  const plugin = parsed.plugins.find((entry) => entry.id === PLUGIN_ID);
  return {
    ok: true as const,
    installed: Boolean(plugin),
    enabled: plugin?.enabled === true,
  };
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
