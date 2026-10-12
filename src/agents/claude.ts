import { dirname, resolve } from "node:path";

import {
  ensureDir,
  pathExists,
  readTextFile,
  writeTextFileIfChanged,
} from "../lib/fs.ts";
import { isRecord } from "../lib/guards.ts";
import {
  checkHackInitSkill,
  installHackInitSkill,
  removeHackInitSkill,
} from "./hack-init-skill.ts";
import type { IntegrationPreservedReason } from "./integration-ownership.ts";

export type ClaudeScope = "project" | "user";

export type ClaudeHookResult = {
  readonly scope: ClaudeScope;
  readonly status:
    | "updated"
    | "noop"
    | "stale"
    | "removed"
    | "missing"
    | "preserved"
    | "error";
  readonly path: string;
  readonly message?: string;
  /** Set with `preserved`: why an existing file was left unchanged. */
  readonly reason?: IntegrationPreservedReason;
};

const HOOK_COMMAND = "hack agent prime";
const HOOK_EVENTS = ["SessionStart", "PreCompact"] as const;

/**
 * Install the Claude Code integration: primer hooks in settings plus the
 * `/hack-init` onboarding skill (`.claude/skills/hack-init/SKILL.md`).
 *
 * The returned path points at the settings file; the status reflects both
 * artifacts (any change reports as updated).
 *
 * Settings are merged: only the Hack primer hook entries are added, and other
 * settings and hooks are kept. An edited or foreign `/hack-init` SKILL.md is
 * left unchanged and reported as `preserved` with that file's path.
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

  const initResult = await installHackInitSkill({
    client: "claude",
    scope: opts.scope,
    projectRoot: opts.projectRoot,
  });
  if (initResult.status === "error") {
    return {
      scope: opts.scope,
      status: "error",
      path: initResult.path,
      message: initResult.message,
    };
  }
  if (initResult.status === "preserved") {
    return {
      scope: opts.scope,
      status: "preserved",
      path: initResult.path,
      reason: initResult.reason,
      message: initResult.message,
    };
  }
  const initChanged =
    initResult.status === "created" || initResult.status === "updated";

  return {
    scope: opts.scope,
    status: updated || result.changed || initChanged ? "updated" : "noop",
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
  if (!hasAll) {
    return { scope: opts.scope, status: "missing", path };
  }

  const initResult = await checkHackInitSkill({
    client: "claude",
    scope: opts.scope,
    projectRoot: opts.projectRoot,
  });
  if (initResult.status !== "noop") {
    return {
      scope: opts.scope,
      status: initResult.status === "error" ? "error" : "stale",
      path: initResult.path,
      message:
        initResult.message ??
        "hack-init skill is missing or out of date. Run: hack setup claude",
    };
  }

  return { scope: opts.scope, status: "noop", path };
}

/**
 * Remove Claude Code hooks for the hack agent primer.
 *
 * Removes only the Hack primer hook entries; other commands that share a hook
 * group are kept. The `/hack-init` skill is removed only when Hack owns it;
 * otherwise the result is `preserved` with that file's path.
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
  const initResult = await removeHackInitSkill({
    client: "claude",
    scope: opts.scope,
    projectRoot: opts.projectRoot,
  });
  const initRemoved = initResult.status === "removed";
  const preserved: ClaudeHookResult | null =
    initResult.status === "preserved"
      ? {
          scope: opts.scope,
          status: "preserved",
          path: initResult.path,
          reason: initResult.reason,
          message: initResult.message,
        }
      : null;

  if (!(await pathExists(path))) {
    const status = initRemoved ? "removed" : "missing";
    return preserved ?? { scope: opts.scope, status, path };
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
    return (
      preserved ?? {
        scope: opts.scope,
        status: initRemoved ? "removed" : "noop",
        path,
      }
    );
  }

  const nextText = `${JSON.stringify(settings.value, null, 2)}\n`;
  await writeTextFileIfChanged(path, nextText);
  return preserved ?? { scope: opts.scope, status: "removed", path };
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
    const next: unknown[] = [];
    let eventChanged = false;
    for (const hook of eventHooks) {
      const stripped = stripHookCommand({ hook, command: opts.command });
      if (stripped === hook) {
        next.push(hook);
        continue;
      }
      eventChanged = true;
      if (stripped !== null) {
        next.push(stripped);
      }
    }
    if (eventChanged) {
      hooks[event] = next;
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

/**
 * Remove only the Hack command entries from one hook group. Returns the same
 * group when it has no Hack entry, `null` when nothing else remains, and a
 * copy holding the other entries otherwise.
 */
function stripHookCommand(opts: {
  readonly hook: unknown;
  readonly command: string;
}): unknown {
  if (!(isRecord(opts.hook) && Array.isArray(opts.hook.hooks))) {
    return opts.hook;
  }
  const entries: readonly unknown[] = opts.hook.hooks;
  const kept = entries.filter(
    (entry) => !(isRecord(entry) && entry.command === opts.command)
  );
  if (kept.length === entries.length) {
    return opts.hook;
  }
  if (kept.length === 0) {
    return null;
  }
  return { ...opts.hook, hooks: kept };
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
