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
