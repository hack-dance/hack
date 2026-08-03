import type { ExecResult } from "../lib/shell.ts";

export type AgentPluginStatus =
  | "noop"
  | "missing"
  | "stale"
  | "deprecated"
  | "removed"
  | "preserved"
  | "absent"
  | "error";

export type AgentPluginResult<TScope extends string> = {
  readonly scope: TScope;
  readonly status: AgentPluginStatus;
  readonly path: string;
  readonly message?: string;
  readonly cleanupStatus?: AgentPluginStatus;
};

export type AgentPluginCommand = (
  command: readonly string[]
) => Promise<ExecResult>;

export type ParsedAgentPluginState =
  | {
      readonly ok: true;
      readonly installed: boolean;
      readonly enabled: boolean;
    }
  | { readonly ok: false; readonly message: string };

export type AgentPluginInstallOutcome =
  | "error"
  | "warning"
  | "unchanged"
  | "updated";

/** Map lifecycle states to honest setup/onboarding presentation semantics. */
export function resolveAgentPluginInstallOutcome({
  status,
}: {
  readonly status: string;
}): AgentPluginInstallOutcome {
  if (status === "error") {
    return "error";
  }
  if (["missing", "stale", "deprecated"].includes(status)) {
    return "warning";
  }
  if (["noop", "preserved", "absent"].includes(status)) {
    return "unchanged";
  }
  return "updated";
}

/** Apply the common native-plugin state machine to client-specific CLI output. */
export async function checkNativeAgentPlugin<TScope extends string>({
  scope,
  pluginId,
  runCommand,
  missingExecutableMessage,
  inspectErrorMessage,
  missingPluginMessage,
  disabledPluginMessage,
  parseState,
}: {
  readonly scope: TScope;
  readonly pluginId: string;
  readonly runCommand: AgentPluginCommand | null;
  readonly missingExecutableMessage: string;
  readonly inspectErrorMessage: string;
  readonly missingPluginMessage: string;
  readonly disabledPluginMessage: string;
  readonly parseState: (opts: {
    readonly json: string;
  }) => ParsedAgentPluginState;
}): Promise<AgentPluginResult<TScope>> {
  if (!runCommand) {
    return {
      scope,
      status: "missing",
      path: pluginId,
      message: missingExecutableMessage,
    };
  }

  const commandResult = await runCommand(["plugin", "list", "--json"]);
  if (commandResult.exitCode !== 0) {
    return {
      scope,
      status: "error",
      path: pluginId,
      message: commandResult.stderr.trim() || inspectErrorMessage,
    };
  }

  const parsed = parseState({ json: commandResult.stdout });
  if (!parsed.ok) {
    return {
      scope,
      status: "error",
      path: pluginId,
      message: parsed.message,
    };
  }
  if (!parsed.installed) {
    return {
      scope,
      status: "missing",
      path: pluginId,
      message: missingPluginMessage,
    };
  }
  if (!parsed.enabled) {
    return {
      scope,
      status: "stale",
      path: pluginId,
      message: disabledPluginMessage,
    };
  }
  return { scope, status: "noop", path: pluginId };
}

/** Remove superseded artifacts before reporting the current plugin state. */
export async function prepareNativeAgentPlugin<TScope extends string>({
  cleanup,
  check,
}: {
  readonly cleanup: () => Promise<AgentPluginResult<TScope>>;
  readonly check: () => Promise<AgentPluginResult<TScope>>;
}): Promise<AgentPluginResult<TScope>> {
  const pluginResult = await check();
  if (pluginResult.status !== "noop") {
    return pluginResult;
  }
  const cleanupResult = await cleanup();
  if (cleanupResult.status === "error") {
    return cleanupResult;
  }
  return mergePluginPreparation({
    cleanup: cleanupResult,
    plugin: pluginResult,
  });
}

/** Report plugin readiness first, then any legacy artifacts blocking cutover. */
export async function checkNativeAgentPluginCutover<TScope extends string>({
  check,
  checkLegacy,
}: {
  readonly check: () => Promise<AgentPluginResult<TScope>>;
  readonly checkLegacy: () => Promise<AgentPluginResult<TScope>>;
}): Promise<AgentPluginResult<TScope>> {
  const pluginResult = await check();
  if (pluginResult.status !== "noop") {
    return pluginResult;
  }
  return await checkLegacy();
}

/** Collapse independent legacy cleanup outcomes using consistent precedence. */
export function mergeLegacyCleanupResults<TScope extends string>({
  scope,
  fallbackPath,
  results,
}: {
  readonly scope: TScope;
  readonly fallbackPath: string;
  readonly results: readonly {
    readonly status: AgentPluginStatus | "updated";
    readonly path?: string;
    readonly message?: string;
  }[];
}): AgentPluginResult<TScope> {
  const error = results.find((result) => result.status === "error");
  const messages = results.flatMap((result) =>
    typeof result.message === "string" ? [result.message] : []
  );
  const path =
    error?.path ??
    results.find((result) => result.status !== "absent")?.path ??
    results.find((result) => result.path)?.path ??
    fallbackPath;

  let status: AgentPluginResult<TScope>["status"] = "absent";
  if (error) {
    status = "error";
  } else if (results.some((result) => result.status === "removed")) {
    status = "removed";
  } else if (results.some((result) => result.status === "preserved")) {
    status = "preserved";
  }

  return {
    scope,
    status,
    path,
    message: messages.length > 0 ? messages.join(" ") : undefined,
  };
}

/**
 * Preserve plugin readiness as the primary outcome while retaining the
 * independent legacy-cleanup result for callers that need both facts.
 */
export function mergePluginPreparation<TScope extends string>({
  cleanup,
  plugin,
}: {
  readonly cleanup: AgentPluginResult<TScope>;
  readonly plugin: AgentPluginResult<TScope>;
}): AgentPluginResult<TScope> {
  const cleanupMessage =
    cleanup.message ??
    (cleanup.status === "removed"
      ? "Removed deprecated standalone integration artifacts."
      : undefined);
  const messages = [cleanupMessage, plugin.message].filter(
    (message): message is string => typeof message === "string"
  );

  return {
    scope: plugin.scope,
    status: plugin.status,
    cleanupStatus: cleanup.status,
    path: plugin.path,
    message: messages.length > 0 ? messages.join(" ") : undefined,
  };
}
