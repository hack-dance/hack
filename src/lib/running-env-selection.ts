/**
 * Env overlay selection for commands that act on an already-running Compose
 * instance (`exec`, `run`, `down`, `restart`).
 *
 * Selection values follow `resolveRequestedEnvName`: `undefined` means the
 * option was omitted, `null` means base layers only, and a string names an
 * overlay. The running selection is the `envName` recorded in the instance's
 * runtime state by its last full `up`/`restart`; `null` there is an explicit
 * base selection, not "unknown".
 */

/**
 * Pick the overlay a command should use against an instance.
 *
 * An explicit request always wins (a mismatch is the caller's to refuse).
 * With no request, a recorded running selection is reused exactly, including
 * base (`null`), so a stack started with a non-default overlay, or with base
 * while a default overlay is configured, keeps the env it runs with. Without
 * recorded state the result stays `undefined` and callers apply the
 * configured default overlay.
 */
export function selectEnvForRunningInstance(opts: {
  readonly requestedEnvName: string | null | undefined;
  readonly running: { readonly envName: string | null } | null;
}): string | null | undefined {
  if (opts.requestedEnvName !== undefined) {
    return opts.requestedEnvName;
  }
  return opts.running ? opts.running.envName : undefined;
}

/** Display form of a selection: overlay name, or `base` for base layers. */
export function formatEnvSelection(envName: string | null): string {
  return envName ?? "base";
}

/**
 * Value-free refusal for an explicit `--env` that differs from the running
 * overlay. It names both selections and the two ways out: omit `--env` to use
 * the running overlay, or restart the instance with the requested one.
 */
export function buildRunningEnvMismatchMessage(opts: {
  readonly command: "exec";
  readonly runningEnvName: string | null;
  readonly requestedEnvName: string | null;
  /** `--branch <name>` when the caller passed one, so the hint targets it. */
  readonly branchOption?: string | undefined;
}): string {
  const running = formatEnvSelection(opts.runningEnvName);
  const requested = formatEnvSelection(opts.requestedEnvName);
  const branch = opts.branchOption ? ` --branch ${opts.branchOption}` : "";
  return `The running stack uses env ${running}, but this ${opts.command} request asks for env ${requested}. Omit --env to ${opts.command} with the running env ${running}, or restart the stack with \`hack restart${branch} --env ${requested}\` first.`;
}
