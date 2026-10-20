import { isAbsolute, join } from "node:path";

import { readOptionalTextFile } from "../lib/fs.ts";
import { isRecord } from "../lib/guards.ts";
import type { SetupSyncScope } from "./setup-sync.ts";

/**
 * Replacement verification for `hack setup migrate` (HACK-1132): whether a
 * client's configuration enables the `hack` plugin for a scope.
 *
 * This reads configuration only; it never starts a client. Claude Code must
 * enable `hack@hack-dance` in the nearest settings file that applies to the
 * scope (project `settings.local.json`, project `settings.json`, then user
 * `settings.json`) and list an installed copy carrying the replacement
 * skills. Codex must set `enabled = true` for the plugin in the nearest
 * `config.toml` (project, then user). A global-scope check reads user
 * configuration only. Cursor installs are not inspectable. Results are closed
 * statuses; file content and parser output are never surfaced.
 */

/** Clients whose standalone files the plugin replaces. */
export const MIGRATION_CLIENTS = ["claude", "codex", "cursor"] as const;
export type MigrationClient = (typeof MIGRATION_CLIENTS)[number];

/** Plugin identifier the clients record when the `hack` plugin is installed. */
export const HACK_PLUGIN_ID = "hack@hack-dance";

/** Skills an installed Claude Code copy must carry to replace the targets. */
const REQUIRED_PLUGIN_SKILLS: readonly string[] = ["hack-cli", "hack-init"];

export type PluginCheckStatus =
  | "verified"
  | "skipped"
  | "not-installed"
  | "disabled"
  | "incomplete"
  | "unreadable"
  | "not-inspectable";

/** Check one client's replacement plugin for one scope. */
export async function checkPluginReplacement(opts: {
  readonly client: MigrationClient;
  readonly scope: SetupSyncScope;
  readonly root: string;
  readonly home: string;
}): Promise<PluginCheckStatus> {
  switch (opts.client) {
    case "claude":
      return await checkClaudePlugin(opts);
    case "codex":
      return await checkCodexPlugin(opts);
    default:
      return "not-inspectable";
  }
}

type EnabledLookup =
  | { readonly kind: "unset" }
  | { readonly kind: "unreadable" }
  | { readonly kind: "set"; readonly enabled: boolean };

/**
 * Claude Code: settings precedence is project local, project shared, user.
 * The nearest file that sets the plugin decides. An enabled plugin must also
 * appear in the user's plugin registry with an install that carries every
 * replacement skill.
 */
async function checkClaudePlugin(opts: {
  readonly scope: SetupSyncScope;
  readonly root: string;
  readonly home: string;
}): Promise<PluginCheckStatus> {
  const settingsFiles = [
    ...(opts.scope === "project"
      ? [
          join(opts.root, ".claude", "settings.local.json"),
          join(opts.root, ".claude", "settings.json"),
        ]
      : []),
    join(opts.home, ".claude", "settings.json"),
  ];
  const enabled = await firstSetting({
    paths: settingsFiles,
    read: readClaudeEnabled,
  });
  if (enabled !== "verified") {
    return enabled;
  }
  return await checkClaudeInstalledCopy({ home: opts.home });
}

async function firstSetting(opts: {
  readonly paths: readonly string[];
  readonly read: (path: string) => Promise<EnabledLookup>;
}): Promise<PluginCheckStatus> {
  for (const path of opts.paths) {
    const lookup = await opts.read(path);
    if (lookup.kind === "unreadable") {
      return "unreadable";
    }
    if (lookup.kind === "set") {
      return lookup.enabled ? "verified" : "disabled";
    }
  }
  return "not-installed";
}

async function readJsonRecord(
  path: string
): Promise<
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable" }
  | { readonly kind: "ok"; readonly value: Record<string, unknown> }
> {
  const file = await readOptionalTextFile(path);
  if (file.kind === "absent") {
    return { kind: "absent" };
  }
  if (file.kind === "unreadable") {
    return { kind: "unreadable" };
  }
  try {
    const parsed: unknown = JSON.parse(file.text);
    if (isRecord(parsed)) {
      return { kind: "ok", value: parsed };
    }
  } catch {
    // Closed diagnostic below; parser output is never surfaced.
  }
  return { kind: "unreadable" };
}

async function readClaudeEnabled(path: string): Promise<EnabledLookup> {
  const file = await readJsonRecord(path);
  if (file.kind === "absent") {
    return { kind: "unset" };
  }
  if (file.kind === "unreadable") {
    return { kind: "unreadable" };
  }
  const plugins = file.value.enabledPlugins;
  if (plugins === undefined) {
    return { kind: "unset" };
  }
  if (!isRecord(plugins)) {
    return { kind: "unreadable" };
  }
  const value = plugins[HACK_PLUGIN_ID];
  if (value === undefined) {
    return { kind: "unset" };
  }
  return { kind: "set", enabled: value === true };
}

async function checkClaudeInstalledCopy(opts: {
  readonly home: string;
}): Promise<PluginCheckStatus> {
  const registry = await readJsonRecord(
    join(opts.home, ".claude", "plugins", "installed_plugins.json")
  );
  if (registry.kind === "absent") {
    return "not-installed";
  }
  if (registry.kind === "unreadable") {
    return "unreadable";
  }
  const plugins = registry.value.plugins;
  if (!isRecord(plugins)) {
    return "unreadable";
  }
  const raw = plugins[HACK_PLUGIN_ID];
  if (raw === undefined) {
    return "not-installed";
  }
  const installs = Array.isArray(raw) ? raw : [raw];
  const paths = installs
    .map((install) => (isRecord(install) ? install.installPath : undefined))
    .filter(
      (path): path is string => typeof path === "string" && isAbsolute(path)
    );
  if (paths.length === 0) {
    return "unreadable";
  }
  for (const installPath of paths) {
    if (await carriesReplacementSkills({ installPath })) {
      return "verified";
    }
  }
  return "incomplete";
}

async function carriesReplacementSkills(opts: {
  readonly installPath: string;
}): Promise<boolean> {
  for (const skill of REQUIRED_PLUGIN_SKILLS) {
    const file = await readOptionalTextFile(
      join(opts.installPath, "skills", skill, "SKILL.md")
    );
    if (file.kind !== "text" || !file.text.includes(`name: ${skill}`)) {
      return false;
    }
  }
  return true;
}

/**
 * Codex: a project `.codex/config.toml` overrides the user one. The plugin
 * counts only with `[plugins."hack@hack-dance"] enabled = true`.
 */
async function checkCodexPlugin(opts: {
  readonly scope: SetupSyncScope;
  readonly root: string;
  readonly home: string;
}): Promise<PluginCheckStatus> {
  const configs = [
    ...(opts.scope === "project"
      ? [join(opts.root, ".codex", "config.toml")]
      : []),
    join(opts.home, ".codex", "config.toml"),
  ];
  return await firstSetting({ paths: configs, read: readCodexEnabled });
}

async function readCodexEnabled(path: string): Promise<EnabledLookup> {
  const file = await readOptionalTextFile(path);
  if (file.kind === "absent") {
    return { kind: "unset" };
  }
  if (file.kind === "unreadable") {
    return { kind: "unreadable" };
  }
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(file.text);
  } catch {
    return { kind: "unreadable" };
  }
  if (!isRecord(parsed)) {
    return { kind: "unreadable" };
  }
  const plugins = parsed.plugins;
  if (plugins === undefined) {
    return { kind: "unset" };
  }
  if (!isRecord(plugins)) {
    return { kind: "unreadable" };
  }
  const entry = plugins[HACK_PLUGIN_ID];
  if (entry === undefined) {
    return { kind: "unset" };
  }
  if (!isRecord(entry)) {
    return { kind: "unreadable" };
  }
  return { kind: "set", enabled: entry.enabled === true };
}
