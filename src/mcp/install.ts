import { dirname, resolve } from "node:path";

import { ensureDir, readTextFile, writeTextFileIfChanged } from "../lib/fs.ts";
import { isRecord } from "../lib/guards.ts";

const CODEX_SERVER_BLOCK_PATTERN =
  /^\s*\[mcp_servers\.hack\][\s\S]*?(?=^\s*\[|\s*$)/m;
const CODEX_SERVER_HEADER_PATTERN = /^\s*\[mcp_servers\.hack\]\s*$/m;

export type McpTarget = "claude" | "codex" | "cursor";
export type McpInstallScope = "project" | "user";

export type McpInstallResult = {
  readonly target: McpTarget;
  readonly scope: McpInstallScope;
  readonly status: "updated" | "noop" | "error";
  readonly path?: string;
  readonly message?: string;
};

export type McpCheckResult = {
  readonly target: McpTarget;
  readonly scope: McpInstallScope;
  readonly status: "present" | "missing" | "error";
  readonly path?: string;
  readonly message?: string;
};

export type McpRemoveResult = {
  readonly target: McpTarget;
  readonly scope: McpInstallScope;
  readonly status: "removed" | "noop" | "error";
  readonly path?: string;
  readonly message?: string;
};

export type McpConfigSnippet =
  | {
      readonly ok: true;
      readonly target: McpTarget;
      readonly scope: McpInstallScope;
      readonly path: string;
      readonly format: "json" | "toml";
      readonly content: string;
    }
  | {
      readonly ok: false;
      readonly target: McpTarget;
      readonly scope: McpInstallScope;
      readonly message: string;
    };

type McpJsonEntry = {
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Record<string, string>;
  readonly type?: "stdio";
};

const SERVER_NAME = "hack" as const;
const SERVER_COMMAND = "hack" as const;
const SERVER_ARGS = ["mcp", "serve"] as const;

export async function installMcpConfig(opts: {
  readonly targets: readonly McpTarget[];
  readonly scope: McpInstallScope;
  readonly projectRoot?: string;
}): Promise<McpInstallResult[]> {
  const results: McpInstallResult[] = [];

  for (const target of opts.targets) {
    const resolved = resolveConfigPath({
      target,
      scope: opts.scope,
      projectRoot: opts.projectRoot,
    });
    if (!resolved.ok) {
      results.push({
        target,
        scope: opts.scope,
        status: "error",
        message: resolved.message,
      });
      continue;
    }

    const path = resolved.path;
    await ensureDir(dirname(path));

    if (target === "codex") {
      const result = await installCodexConfig({ path });
      results.push({ target, scope: opts.scope, path, ...result });
      continue;
    }

    const entry = target === "claude" ? buildClaudeEntry() : buildCursorEntry();
    const result = await installJsonConfig({ path, entry });
    results.push({ target, scope: opts.scope, path, ...result });
  }

  return results;
}

export async function checkMcpConfig(opts: {
  readonly targets: readonly McpTarget[];
  readonly scope: McpInstallScope;
  readonly projectRoot?: string;
}): Promise<McpCheckResult[]> {
  const results: McpCheckResult[] = [];

  for (const target of opts.targets) {
    const resolved = resolveConfigPath({
      target,
      scope: opts.scope,
      projectRoot: opts.projectRoot,
    });
    if (!resolved.ok) {
      results.push({
        target,
        scope: opts.scope,
        status: "error",
        message: resolved.message,
      });
      continue;
    }

    const path = resolved.path;
    const text = await readTextFile(path);
    if (!text) {
      results.push({ target, scope: opts.scope, status: "missing", path });
      continue;
    }

    if (target === "codex") {
      const present = hasCodexServerBlock(text);
      results.push({
        target,
        scope: opts.scope,
        status: present ? "present" : "missing",
        path,
      });
      continue;
    }

    const parsed = parseJsonObject(text);
    if (!parsed.ok) {
      results.push({
        target,
        scope: opts.scope,
        status: "error",
        message: parsed.message,
        path,
      });
      continue;
    }

    const mcpServersRaw = parsed.value.mcpServers;
    const mcpServers = isRecord(mcpServersRaw) ? mcpServersRaw : {};
    const present = Boolean(mcpServers[SERVER_NAME]);
    results.push({
      target,
      scope: opts.scope,
      status: present ? "present" : "missing",
      path,
    });
  }

  return results;
}

export async function removeMcpConfig(opts: {
  readonly targets: readonly McpTarget[];
  readonly scope: McpInstallScope;
  readonly projectRoot?: string;
}): Promise<McpRemoveResult[]> {
  const results: McpRemoveResult[] = [];

  for (const target of opts.targets) {
    const resolved = resolveConfigPath({
      target,
      scope: opts.scope,
      projectRoot: opts.projectRoot,
    });
    if (!resolved.ok) {
      results.push({
        target,
        scope: opts.scope,
        status: "error",
        message: resolved.message,
      });
      continue;
    }

    const path = resolved.path;
    if (target === "codex") {
      const outcome = await removeCodexConfig({ path });
      results.push({ target, scope: opts.scope, path, ...outcome });
      continue;
    }

    const outcome = await removeJsonConfig({ path });
    results.push({ target, scope: opts.scope, path, ...outcome });
  }

  return results;
}

export function renderMcpConfigSnippet(opts: {
  readonly target: McpTarget;
  readonly scope: McpInstallScope;
  readonly projectRoot?: string;
}): McpConfigSnippet {
  const resolved = resolveConfigPath(opts);
  if (!resolved.ok) {
    return {
      ok: false,
      target: opts.target,
      scope: opts.scope,
      message: resolved.message,
    };
  }

  if (opts.target === "codex") {
    return {
      ok: true,
      target: opts.target,
      scope: opts.scope,
      path: resolved.path,
      format: "toml",
      content: renderCodexTomlBlock().trimEnd(),
    };
  }

  const entry =
    opts.target === "claude" ? buildClaudeEntry() : buildCursorEntry();
  return {
    ok: true,
    target: opts.target,
    scope: opts.scope,
    path: resolved.path,
    format: "json",
    content: `${JSON.stringify({ mcpServers: { [SERVER_NAME]: entry } }, null, 2)}`,
  };
}

function buildCursorEntry(): McpJsonEntry {
  return {
    command: SERVER_COMMAND,
    args: [...SERVER_ARGS],
  };
}

function buildClaudeEntry(): McpJsonEntry {
  return {
    type: "stdio",
    command: SERVER_COMMAND,
    args: [...SERVER_ARGS],
  };
}

async function installJsonConfig(opts: {
  readonly path: string;
  readonly entry: McpJsonEntry;
}): Promise<{
  readonly status: "updated" | "noop" | "error";
  readonly message?: string;
}> {
  const text = await readTextFile(opts.path);
  const parsed = text
    ? parseJsonObject(text)
    : createOkParseResult({ value: {} });
  if (!parsed.ok) {
    return { status: "error", message: parsed.message };
  }

  const current = parsed.value;
  const mcpServersRaw = current.mcpServers;
  const mcpServers = isRecord(mcpServersRaw) ? { ...mcpServersRaw } : {};
  mcpServers[SERVER_NAME] = opts.entry;

  const next = { ...current, mcpServers };
  const nextText = `${JSON.stringify(next, null, 2)}\n`;
  const result = await writeTextFileIfChanged(opts.path, nextText);
  return { status: result.changed ? "updated" : "noop" };
}

async function installCodexConfig(opts: { readonly path: string }): Promise<{
  readonly status: "updated" | "noop" | "error";
  readonly message?: string;
}> {
  const text = await readTextFile(opts.path);
  const existing = text ?? "";
  if (hasCodexServerBlock(existing)) {
    return { status: "noop" };
  }

  const block = renderCodexTomlBlock();
  const next =
    existing.trim().length === 0
      ? `${block}\n`
      : `${existing.trimEnd()}\n\n${block}\n`;
  const result = await writeTextFileIfChanged(opts.path, next);
  return { status: result.changed ? "updated" : "noop" };
}

async function removeJsonConfig(opts: { readonly path: string }): Promise<{
  readonly status: "removed" | "noop" | "error";
  readonly message?: string;
}> {
  const text = await readTextFile(opts.path);
  if (!text) {
    return { status: "noop" };
  }

  const parsed = parseJsonObject(text);
  if (!parsed.ok) {
    return { status: "error", message: parsed.message };
  }

  const current = parsed.value;
  const mcpServersRaw = current.mcpServers;
  const mcpServers = isRecord(mcpServersRaw) ? { ...mcpServersRaw } : {};
  if (!Object.hasOwn(mcpServers, SERVER_NAME)) {
    return { status: "noop" };
  }

  delete mcpServers[SERVER_NAME];
  const next =
    Object.keys(mcpServers).length === 0
      ? (() => {
          const clone = { ...current };
          clone.mcpServers = undefined;
          return clone;
        })()
      : { ...current, mcpServers };

  const nextText = `${JSON.stringify(next, null, 2)}\n`;
  const result = await writeTextFileIfChanged(opts.path, nextText);
  return { status: result.changed ? "removed" : "noop" };
}

async function removeCodexConfig(opts: { readonly path: string }): Promise<{
  readonly status: "removed" | "noop" | "error";
  readonly message?: string;
}> {
  const text = await readTextFile(opts.path);
  if (!text) {
    return { status: "noop" };
  }
  if (!hasCodexServerBlock(text)) {
    return { status: "noop" };
  }

  const next = text.replace(CODEX_SERVER_BLOCK_PATTERN, "").trimEnd();
  const normalized = next.length === 0 ? "" : `${next}\n`;
  const result = await writeTextFileIfChanged(opts.path, normalized);
  return { status: result.changed ? "removed" : "noop" };
}

function renderCodexTomlBlock(): string {
  return [
    `[mcp_servers.${SERVER_NAME}]`,
    `command = "${SERVER_COMMAND}"`,
    `args = ["${SERVER_ARGS[0]}", "${SERVER_ARGS[1]}"]`,
  ].join("\n");
}

function hasCodexServerBlock(text: string): boolean {
  return CODEX_SERVER_HEADER_PATTERN.test(text);
}

function resolveConfigPath(opts: {
  readonly target: McpTarget;
  readonly scope: McpInstallScope;
  readonly projectRoot?: string;
}):
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly message: string } {
  if (opts.scope === "project" && !opts.projectRoot) {
    return {
      ok: false,
      message: "Missing project root for project-scoped config.",
    };
  }

  const home = resolveHomeDir();
  if (opts.scope === "user" && !home) {
    return {
      ok: false,
      message: "HOME is not set; cannot resolve user config path.",
    };
  }

  const projectRoot = opts.projectRoot ? resolve(opts.projectRoot) : "";

  switch (opts.target) {
    case "cursor":
      return {
        ok: true,
        path:
          opts.scope === "user"
            ? resolve(home ?? "", ".cursor", "mcp.json")
            : resolve(projectRoot, ".cursor", "mcp.json"),
      };
    case "claude":
      return {
        ok: true,
        path:
          opts.scope === "user"
            ? resolve(home ?? "", ".claude", "settings.json")
            : resolve(projectRoot, ".claude", "settings.json"),
      };
    case "codex":
      return {
        ok: true,
        path:
          opts.scope === "user"
            ? resolve(home ?? "", ".codex", "config.toml")
            : resolve(projectRoot, ".codex", "config.toml"),
      };
    default: {
      const _exhaustive: never = opts.target;
      return { ok: false, message: `Unknown target: ${_exhaustive}` };
    }
  }
}

function parseJsonObject(text: string):
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | {
      readonly ok: false;
      readonly message: string;
    } {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) {
      return { ok: false, message: "Expected JSON object at config root." };
    }
    return { ok: true, value: parsed };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Invalid JSON";
    return { ok: false, message: `Failed to parse config JSON: ${message}` };
  }
}

function createOkParseResult(opts: {
  readonly value: Record<string, unknown>;
}): {
  readonly ok: true;
  readonly value: Record<string, unknown>;
} {
  return { ok: true, value: opts.value };
}

function resolveHomeDir(): string | null {
  const home = (process.env.HOME ?? "").trim();
  return home.length > 0 ? home : null;
}
