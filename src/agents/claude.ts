import { dirname, resolve } from "node:path";

import {
  ensureDir,
  pathExists,
  readTextFile,
  writeTextFileIfChanged,
} from "../lib/fs.ts";
import { isRecord } from "../lib/guards.ts";

export type ClaudeScope = "project" | "user";

export type ClaudeHookResult = {
  readonly scope: ClaudeScope;
  readonly status: "updated" | "noop" | "removed" | "missing" | "error";
  readonly path: string;
  readonly message?: string;
};

const HOOK_COMMAND = "hack agent prime";
const HOOK_EVENTS = ["SessionStart", "PreCompact"] as const;

/**
 * Install Claude Code hooks to run the hack agent primer.
 */
export async function installClaudeHooks(opts: {
  readonly scope: ClaudeScope;
  readonly projectRoot?: string;
}): Promise<ClaudeHookResult> {
  const resolved = resolveClaudeSettingsPath(opts);
  if (!resolved.ok) {
    return {
      scope: opts.scope,
      status: "error",
      path: resolved.path ?? "settings.json",
      message: resolved.message,
    };
  }

  const path = resolved.path;
  await ensureDir(dirname(path));

  const settings = await readSettingsFile({ path });
  if (!settings.ok) {
    return {
      scope: opts.scope,
      status: "error",
      path,
      message: settings.message,
    };
  }

  const updated = upsertHooks({
    settings: settings.value,
    command: HOOK_COMMAND,
  });
  const nextText = `${JSON.stringify(settings.value, null, 2)}\n`;
  const result = await writeTextFileIfChanged(path, nextText);

  return {
    scope: opts.scope,
    status: updated || result.changed ? "updated" : "noop",
    path,
  };
}

/**
 * Check whether Claude Code hooks are installed.
 */
export async function checkClaudeHooks(opts: {
  readonly scope: ClaudeScope;
  readonly projectRoot?: string;
}): Promise<ClaudeHookResult> {
  const resolved = resolveClaudeSettingsPath(opts);
  if (!resolved.ok) {
    return {
      scope: opts.scope,
      status: "error",
      path: resolved.path ?? "settings.json",
      message: resolved.message,
    };
  }

  const path = resolved.path;
  if (!(await pathExists(path))) {
    return { scope: opts.scope, status: "missing", path };
  }

  const settings = await readSettingsFile({ path });
  if (!settings.ok) {
    return {
      scope: opts.scope,
      status: "error",
      path,
      message: settings.message,
    };
  }

  const hasAll = hasHooks({ settings: settings.value, command: HOOK_COMMAND });
  return { scope: opts.scope, status: hasAll ? "noop" : "missing", path };
}

/**
 * Remove Claude Code hooks for the hack agent primer.
 */
export async function removeClaudeHooks(opts: {
  readonly scope: ClaudeScope;
  readonly projectRoot?: string;
}): Promise<ClaudeHookResult> {
  const resolved = resolveClaudeSettingsPath(opts);
  if (!resolved.ok) {
    return {
      scope: opts.scope,
      status: "error",
      path: resolved.path ?? "settings.json",
      message: resolved.message,
    };
  }

  const path = resolved.path;
  if (!(await pathExists(path))) {
    return { scope: opts.scope, status: "missing", path };
  }

  const settings = await readSettingsFile({ path });
  if (!settings.ok) {
    return {
      scope: opts.scope,
      status: "error",
      path,
      message: settings.message,
    };
  }

  const changed = removeHooks({
    settings: settings.value,
    command: HOOK_COMMAND,
  });
  if (!changed) {
    return { scope: opts.scope, status: "noop", path };
  }

  const nextText = `${JSON.stringify(settings.value, null, 2)}\n`;
  await writeTextFileIfChanged(path, nextText);
  return { scope: opts.scope, status: "removed", path };
}

function resolveClaudeSettingsPath(opts: {
  readonly scope: ClaudeScope;
  readonly projectRoot?: string;
}):
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly message: string; readonly path?: string } {
  if (opts.scope === "project" && !opts.projectRoot) {
    return {
      ok: false,
      message: "Missing project root for project-scoped Claude hooks.",
    };
  }

  const root = opts.scope === "user" ? resolveHomeDir() : opts.projectRoot;
  if (!root) {
    return {
      ok: false,
      message: "HOME is not set; cannot resolve Claude settings path.",
    };
  }

  return {
    ok: true,
    path:
      opts.scope === "user"
        ? resolve(root, ".claude", "settings.json")
        : resolve(root, ".claude", "settings.local.json"),
  };
}

async function readSettingsFile(opts: {
  readonly path: string;
}): Promise<
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly message: string }
> {
  const text = await readTextFile(opts.path);
  if (!text) {
    return { ok: true, value: {} };
  }

  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) {
      return { ok: false, message: "Expected JSON object at config root." };
    }
    return { ok: true, value: parsed };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Invalid JSON";
    return {
      ok: false,
      message: `Failed to parse Claude settings JSON: ${message}`,
    };
  }
}

function upsertHooks(opts: {
  readonly settings: Record<string, unknown>;
  readonly command: string;
}): boolean {
  const hooks = resolveHooksMap(opts.settings);
  let changed = false;

  for (const event of HOOK_EVENTS) {
    const eventHooks = resolveEventHooks({ hooks, event });
    if (eventHasCommand({ eventHooks, command: opts.command })) {
      continue;
    }
    eventHooks.push(createHook({ command: opts.command }));
    hooks[event] = eventHooks;
    changed = true;
  }

  if (changed) {
    opts.settings.hooks = hooks;
  }
  return changed;
}

function hasHooks(opts: {
  readonly settings: Record<string, unknown>;
  readonly command: string;
}): boolean {
  const hooks = resolveHooksMap(opts.settings);
  return HOOK_EVENTS.every((event) => {
    const eventHooks = resolveEventHooks({ hooks, event });
    return eventHasCommand({ eventHooks, command: opts.command });
  });
}

function removeHooks(opts: {
  readonly settings: Record<string, unknown>;
  readonly command: string;
}): boolean {
  const hooks = resolveHooksMap(opts.settings);
  let changed = false;

  for (const event of HOOK_EVENTS) {
    const eventHooks = resolveEventHooks({ hooks, event });
    const filtered = eventHooks.filter(
      (hook) => !hookHasCommand({ hook, command: opts.command })
    );
    if (filtered.length !== eventHooks.length) {
      hooks[event] = filtered;
      changed = true;
    }
  }

  if (changed) {
    opts.settings.hooks = hooks;
  }
  return changed;
}

function resolveHooksMap(
  settings: Record<string, unknown>
): Record<string, unknown> {
  const raw = settings.hooks;
  if (isRecord(raw)) {
    return { ...raw };
  }
  return {};
}

function resolveEventHooks(opts: {
  readonly hooks: Record<string, unknown>;
  readonly event: string;
}): unknown[] {
  const raw = opts.hooks[opts.event];
  return Array.isArray(raw) ? [...raw] : [];
}

function eventHasCommand(opts: {
  readonly eventHooks: readonly unknown[];
  readonly command: string;
}): boolean {
  return opts.eventHooks.some((hook) =>
    hookHasCommand({ hook, command: opts.command })
  );
}

function hookHasCommand(opts: {
  readonly hook: unknown;
  readonly command: string;
}): boolean {
  if (!isRecord(opts.hook)) {
    return false;
  }
  const hooksRaw = opts.hook.hooks;
  if (!Array.isArray(hooksRaw)) {
    return false;
  }

  return hooksRaw.some((entry) => {
    if (!isRecord(entry)) {
      return false;
    }
    return entry.command === opts.command;
  });
}

function createHook(opts: {
  readonly command: string;
}): Record<string, unknown> {
  return {
    matcher: "",
    hooks: [
      {
        type: "command",
        command: opts.command,
      },
    ],
  };
}

function resolveHomeDir(): string | null {
  const home = (process.env.HOME ?? "").trim();
  return home.length > 0 ? home : null;
}
