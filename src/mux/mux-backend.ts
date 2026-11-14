import { AsyncLocalStorage } from "node:async_hooks";
import { type ExecOptions, type ExecResult, exec } from "../lib/shell.ts";

const MUX_OPERATIONS = [
  "list-sessions",
  "has-session",
  "new-session",
  "new-window",
  "kill-session",
  "list-panes",
  "list-windows",
  "show-options",
  "set-option",
  "send-keys",
  "start-server",
] as const;
type MuxCommandOperation = (typeof MUX_OPERATIONS)[number] | "other";

/** Labels are closed even when the command itself is transported over stdin. */
export function muxCommandOperation(
  value: string | undefined
): MuxCommandOperation {
  return MUX_OPERATIONS.find((operation) => operation === value) ?? "other";
}
export type MuxCommandSample = Readonly<{
  backend: "tmux" | "zellij" | "other";
  operation: MuxCommandOperation;
  phase: "started" | "finished";
  elapsedMs: number;
  timedOut: boolean;
  exitCode: number | null;
}>;
const commandObservers = new AsyncLocalStorage<
  (sample: MuxCommandSample) => void
>();

/** Scope value-free mux timings to one asynchronous caller; no global observer or command arguments. */
export function observeMuxCommands<T>(opts: {
  readonly onSample: (sample: MuxCommandSample) => void;
  readonly action: () => T;
}): T {
  return commandObservers.run(opts.onSample, opts.action);
}
function recordCommand(sample: MuxCommandSample): void {
  try {
    const observed: unknown = commandObservers.getStore()?.(
      Object.freeze(sample)
    );
    void Promise.resolve(observed).catch(() => undefined);
  } catch {
    // Diagnostic callbacks are passive, including when their caller has failed.
  }
}

/** Interactive workspaces use tmux; zellij remains a legacy lifecycle-state tag until migration. */
export type MuxBackendName = "tmux" | "zellij";

export type MuxSession = {
  readonly backend: MuxBackendName;
  readonly name: string;
  readonly attached: boolean | null;
  readonly path: string | null;
  readonly windows: number | null;
  readonly createdAt: string | null;
};

export type MuxSessionCreateResult =
  | { readonly ok: true; readonly session: MuxSession | null }
  | { readonly ok: false; readonly error: string; readonly stderr?: string };

/**
 * Bound for every non-interactive mux command. Some run while the shared
 * helper instance lock is held (session decision and creation), so a hung
 * tmux must not hold that lock indefinitely. A command that exceeds
 * it has its client killed and is reported as {@link MuxCommandTimeoutError}:
 * its outcome is unknown, never an empty or absent result.
 *
 * Killing the client bounds the caller's wait, not the command: a tmux server
 * that already received it may still apply it later (commands queue per
 * client).
 * Callers therefore never treat a timeout as "did not happen"; the remaining
 * late-effect residual is described in tests/models/tla/README.md ("Shared
 * helper instance") and tracked in HACK-1849. `HACK_MUX_COMMAND_TIMEOUT_MS` overrides it (tests).
 */
export const MUX_COMMAND_TIMEOUT_MS = 15_000;

export function muxCommandTimeoutMs(): number {
  const override = Number(process.env.HACK_MUX_COMMAND_TIMEOUT_MS);
  return Number.isInteger(override) && override > 0
    ? override
    : MUX_COMMAND_TIMEOUT_MS;
}

/** A mux command timed out and was killed: its outcome is unknown. */
export class MuxCommandTimeoutError extends Error {
  constructor(command: readonly string[]) {
    super(
      `${command.slice(0, 2).join(" ")} did not finish in time and was stopped; its outcome is unknown.`
    );
    this.name = "MuxCommandTimeoutError";
  }
}

/**
 * Run a non-interactive mux command under {@link muxCommandTimeoutMs}. The
 * call always returns within the bound; a timeout throws
 * {@link MuxCommandTimeoutError} (the server may still apply the command).
 * Stdin is never inherited: it is ignored unless the caller supplies a
 * finite Blob (tmux `source-file -` input that must stay off argv).
 */
export async function runMuxCommand(
  command: readonly string[],
  opts: Omit<ExecOptions, "timeoutMs"> & {
    readonly timeoutMs?: number;
    readonly diagnosticOperation?: MuxCommandOperation;
  } = {}
): Promise<ExecResult> {
  const backend =
    command[0] === "tmux" || command[0] === "zellij" ? command[0] : "other";
  const selected = command[1] === "-u" ? command[2] : command[1];
  const operation = muxCommandOperation(opts.diagnosticOperation ?? selected);
  recordCommand({
    backend,
    operation,
    phase: "started",
    elapsedMs: 0,
    timedOut: false,
    exitCode: null,
  });
  const result = await exec(command, {
    ...opts,
    stdin: opts.stdin instanceof Blob ? opts.stdin : "ignore",
    timeoutMs: opts.timeoutMs ?? muxCommandTimeoutMs(),
    onTiming: (sample) => {
      recordCommand({ backend, operation, phase: "finished", ...sample });
      return opts.onTiming?.(sample);
    },
  });
  if (result.exitCode === 124) {
    throw new MuxCommandTimeoutError(command);
  }
  return result;
}

/** Interactive-workspace operations, implemented by tmux; not a lifecycle supervisor contract. */
export interface MuxBackend {
  readonly name: MuxBackendName;
  readonly available: boolean;
  /**
   * The session carries its lifecycle ownership token from the creating
   * command itself (tmux `new-session -e`), so no interrupted create can
   * leave a live session without one. Shared-helper lifecycle sessions
   * require it.
   */
  readonly createsWithOwnerToken?: boolean;

  listSessions(): Promise<readonly MuxSession[]>;
  createSession(opts: {
    readonly name: string;
    readonly cwd?: string;
    readonly env?: Readonly<Record<string, string>>;
    readonly lifecycleOwnerToken?: string;
  }): Promise<MuxSessionCreateResult>;
  killSession(opts: { readonly name: string }): Promise<ExecResult>;

  readLifecycleOwnerToken?(opts: {
    readonly name: string;
  }): Promise<string | null>;
  /** A failed query is unknown, not proof that an owned session exited. */
  readSessionPresence?(opts: {
    readonly name: string;
  }): Promise<"present" | "absent" | "unknown">;
  listSessionWindowNames?(opts: {
    readonly name: string;
  }): Promise<ReadonlySet<string> | null>;

  execInSession(opts: {
    readonly name: string;
    readonly command: string;
    readonly env?: Readonly<Record<string, string>>;
  }): Promise<ExecResult>;
  sendInput(opts: {
    readonly name: string;
    readonly keys: string;
  }): Promise<ExecResult>;
}
