import { type ExecOptions, type ExecResult, exec } from "../lib/shell.ts";

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
 * tmux or zellij must not hold that lock indefinitely. A command that exceeds
 * it is killed (the call settles; nothing keeps running after the caller
 * moves on) and reported as {@link MuxCommandTimeoutError}: its outcome is
 * unknown, never an empty or absent result. `HACK_MUX_COMMAND_TIMEOUT_MS`
 * overrides it (tests).
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
 * call always settles; a timeout throws {@link MuxCommandTimeoutError}.
 */
export async function runMuxCommand(
  command: readonly string[],
  opts: Omit<ExecOptions, "timeoutMs"> & {
    readonly timeoutMs?: number;
  } = {}
): Promise<ExecResult> {
  const result = await exec(command, {
    ...opts,
    stdin: "ignore",
    timeoutMs: opts.timeoutMs ?? muxCommandTimeoutMs(),
  });
  if (result.exitCode === 124) {
    throw new MuxCommandTimeoutError(command);
  }
  return result;
}

export interface MuxBackend {
  readonly name: MuxBackendName;
  readonly available: boolean;

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
