/**
 * What `hack exec` and `hack run` say while their requesting process waits for
 * the native runtime lock, and when it gives up (HACK-2729).
 *
 * Another project's `hack down` holds the provider lease for its whole graph
 * stop, up to the 30 s per-service stop grace. The requesting side of these
 * commands (the dependency refresh both send first, and `hack exec`'s own
 * `graph exec`) waits `COMMAND_REQUEST_LEASE_WAIT` in the runtime's
 * `provider/lifecycle.rs`, which is the start's bound by definition. As for a
 * start (`native-start-lease.ts`, HACK-2724), a wait that lasted about 3 s
 * prints one progress line per command, and an expired wait says that nothing
 * ran, names the holder, and says to retry.
 *
 * An authored project's `hack exec` (HACK-2739) sends one request to its owner.
 * Its requesting process (`graph native exec`) waits the same bound for a free
 * lease before it sends anything, so it reports and refuses the same way. If
 * the lease is taken again before the owner acquires it, the owner's own short
 * wait ends in a pre-effect code that also reads as "nothing ran".
 */
import { noteNativeExitConfirmed } from "../lib/background-command/native-exit.ts";
import { NativeRuntimeRequestError } from "./native-runtime-client.ts";
import {
  NATIVE_START_LEASE_WAIT_SECONDS,
  nativeLeaseHolderPhrase,
  nativeStartLeaseHolder,
} from "./native-start-lease.ts";

/** The runtime's `COMMAND_REQUEST_LEASE_WAIT`, which is its `START_LEASE_WAIT`. */
export const NATIVE_COMMAND_LEASE_WAIT_SECONDS =
  NATIVE_START_LEASE_WAIT_SECONDS;

/**
 * The bound of an authored `graph native exec` or `graph native one-off`
 * request: the requesting process's lease wait (35 s, HACK-2739, HACK-2742),
 * 5 s to send, the fixed 40 s read of the owner's answer, and a 5 s margin.
 */
export const NATIVE_AUTHORED_COMMAND_REQUEST_TIMEOUT_MS =
  (NATIVE_COMMAND_LEASE_WAIT_SECONDS + 5 + 40 + 5) * 1000;

/** The commands whose requesting process waits this bound, as the user ran them. */
export type NativeLeaseCommand = "hack exec" | "hack run";

/** The one progress line for a command still waiting on the lock after about 3 s. */
export function nativeCommandLeaseWaitLine(token: string | undefined): string {
  return `Waiting for the native runtime lock, held by ${nativeLeaseHolderPhrase(token)}. This command continues once it is released (up to ${NATIVE_COMMAND_LEASE_WAIT_SECONDS} s).`;
}

/**
 * The `onLeaseWait` of one command's requests. A command makes up to two
 * requests that may wait (the refresh, then the exec); it prints the line once.
 * A caller that passes its own reporter as `given` (one shared across
 * requests, or a test's) keeps it; `write` is the output seam.
 */
export function nativeCommandLeaseWaitReporter(
  opts: {
    readonly given?: (holder: string) => void;
    readonly write?: (line: string) => void;
  } = {}
): (holder: string) => void {
  if (opts.given) {
    return opts.given;
  }
  const write =
    opts.write ??
    ((line: string) => {
      process.stderr.write(`${line}\n`);
    });
  let reported = false;
  return (holder) => {
    if (reported) {
      return;
    }
    reported = true;
    write(nativeCommandLeaseWaitLine(holder));
  };
}

/**
 * Whether `error` is the requesting process's own expired lease wait: a raw
 * `provider_busy` with no cause. The runtime wraps every refusal from the owner
 * (and from anything after the lease was taken) in its own code, so this one
 * means the lease was never taken and the step it guards never started: for
 * the refresh, nothing was sent; for `graph exec`, the command was not sent.
 */
export function isNativeCommandLeaseRefusal(
  error: unknown
): error is NativeRuntimeRequestError {
  return (
    error instanceof NativeRuntimeRequestError &&
    error.nativeCode === "provider_busy" &&
    error.nativeCauseCode === undefined
  );
}

/**
 * The runtime's owner answer when its own refresh selection could not take the
 * lease (`OWNER_SELECTION_BUSY` in `dependency_refresh.rs`). That wait runs
 * before the rebind, so nothing was refreshed and the command was never sent.
 */
export const NATIVE_OWNER_REFRESH_LEASE_BUSY =
  "graph_dependency_refresh_lease_busy";

/**
 * Whether `error` is the owner's own refresh lease refusal, forwarded as the
 * cause of the requester's `graph_owner_recovery`. Only that exact pair is
 * pre-effect; any other cause keeps its report.
 */
export function isNativeOwnerRefreshLeaseRefusal(
  error: unknown
): error is NativeRuntimeRequestError {
  return (
    error instanceof NativeRuntimeRequestError &&
    error.nativeCode === "graph_owner_recovery" &&
    error.nativeCauseCode === NATIVE_OWNER_REFRESH_LEASE_BUSY
  );
}

/**
 * The authored owner's answer when its own lease wait for an exec expired
 * (`OWNER_EXEC_LEASE_BUSY` in `native/runtime/exec.rs`, HACK-2739). That wait
 * is the first thing the owner does for the exec, so nothing ran.
 */
export const NATIVE_OWNER_AUTHORED_EXEC_LEASE_BUSY =
  "graph_authored_exec_lease_busy";

/**
 * Whether `error` is the authored owner's own exec lease refusal, forwarded as
 * the cause of the requester's `native_graph_foreground`. Only that exact pair
 * is pre-effect; every other authored failure keeps its report.
 */
export function isNativeOwnerAuthoredExecLeaseRefusal(
  error: unknown
): error is NativeRuntimeRequestError {
  return (
    error instanceof NativeRuntimeRequestError &&
    error.nativeCode === "native_graph_foreground" &&
    error.nativeCauseCode === NATIVE_OWNER_AUTHORED_EXEC_LEASE_BUSY
  );
}

/**
 * Which step's lease wait expired: the dependency refresh (nothing ran), the
 * exec after a completed refresh (the command did not run), or an authored
 * exec's only request, refused before its owner did anything (nothing ran).
 */
export type NativeLeaseStage = "refresh" | "exec" | "authored";

const notRunRefusals = new WeakSet<object>();

/**
 * Whether `error` is a refusal {@link nativeCommandLeaseRefusal} built: the
 * command was not sent, so no guest process exists for it.
 */
export function isNativeCommandNotRun(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && notRunRefusals.has(error)
  );
}

/**
 * The refusal of a command whose lease wait expired. The command did not run,
 * so the next step is a plain retry once the holder finishes; it is never
 * "unconfirmed".
 */
export function nativeCommandLeaseRefusal(opts: {
  readonly nativeMessage: string | undefined;
  readonly command: NativeLeaseCommand;
  readonly stage: NativeLeaseStage;
  /**
   * The wire code and cause this refusal came from, when it is not the
   * requester's own raw `provider_busy` (an owner's pre-effect code, carried as
   * the cause of the requester's code). Defaults to `provider_busy`, no cause.
   */
  readonly nativeCode?: string;
  readonly nativeCauseCode?: string;
}): NativeRuntimeRequestError {
  const error = new NativeRuntimeRequestError({
    nativeCode: opts.nativeCode ?? "provider_busy",
    nativeCauseCode: opts.nativeCauseCode,
    nativeMessage: opts.nativeMessage,
    message: nativeCommandLeaseRefusalMessage({
      command: opts.command,
      stage: opts.stage,
      holder: nativeStartLeaseHolder(opts.nativeMessage),
    }),
  });
  notRunRefusals.add(error);
  return error;
}

/**
 * The three lines of a lease refusal; `holder` is the recorded holder's words
 * (`project stop`), or undefined when no holder is known.
 */
export function nativeCommandLeaseRefusalMessage(opts: {
  readonly command: NativeLeaseCommand;
  readonly stage: NativeLeaseStage;
  readonly holder: string | undefined;
}): string {
  const outcome =
    opts.stage === "exec" ? "the command did not run" : "nothing ran";
  return [
    `${opts.command} could not acquire the native runtime lock (provider_busy); ${outcome}.`,
    `Holder: ${opts.holder ?? "unavailable"}.`,
    opts.holder
      ? `Retry ${opts.command} once that ${opts.holder} finishes.`
      : `Retry ${opts.command} once the holder finishes.`,
  ].join("\n");
}

/**
 * The authored owner's answer when its own lease wait for a one-off `hack run`
 * expired (`OWNER_RUN_LEASE_BUSY` in `native/runtime/exec.rs`, HACK-2742).
 */
export const NATIVE_OWNER_AUTHORED_RUN_LEASE_BUSY =
  "graph_authored_run_lease_busy";

/**
 * The authored owner's answer when its own check (a pending signal, its
 * `hack down`, a changed publication or pin) ended an exec or run before it
 * took the lease (`OWNER_COMMAND_NOT_STARTED`, HACK-2742). Nothing ran.
 */
export const NATIVE_OWNER_AUTHORED_COMMAND_NOT_STARTED =
  "graph_authored_command_not_started";

const OWNER_LEASE_CODES: readonly string[] = [
  NATIVE_OWNER_AUTHORED_EXEC_LEASE_BUSY,
  NATIVE_OWNER_AUTHORED_RUN_LEASE_BUSY,
];

/** The two lines of an authored command its owner ended before it started. */
export function nativeCommandNotStartedMessage(
  command: NativeLeaseCommand
): string {
  return [
    `${command} did not start: the project's owner stopped or changed while the command waited for the native runtime lock (${NATIVE_OWNER_AUTHORED_COMMAND_NOT_STARTED}); nothing ran.`,
    `Check hack ps, then retry ${command} once the project is up.`,
  ].join("\n");
}

/**
 * The CLI message for an authored owner's pre-effect code, as an interactive
 * exec's report or a finite request's cause carries it, or undefined for any
 * other code (HACK-2742).
 */
export function nativeOwnerPreEffectMessage(
  code: string,
  command: NativeLeaseCommand
): string | undefined {
  if (code === NATIVE_OWNER_AUTHORED_COMMAND_NOT_STARTED) {
    return nativeCommandNotStartedMessage(command);
  }
  if (OWNER_LEASE_CODES.includes(code)) {
    return nativeCommandLeaseRefusalMessage({
      command,
      stage: "authored",
      holder: undefined,
    });
  }
  return;
}

/**
 * The plain refusal for an authored exec or one-off run that never started
 * (HACK-2739, HACK-2742), or undefined. Three refusals are pre-effect: the
 * requesting process's own lease wait, which ends before anything is sent (a
 * raw `provider_busy` that names the holder), the owner's own lease wait, and
 * the owner's own check ending that wait (each an owner code, forwarded as the
 * cause of `native_graph_foreground`, naming no holder). Every other failure
 * keeps the unconfirmed report. The refusal keeps the wire code and cause as
 * they arrived, and is marked as not run.
 */
export function nativeAuthoredCommandNotRunRefusal(
  error: unknown,
  command: NativeLeaseCommand
): NativeRuntimeRequestError | undefined {
  if (isNativeCommandLeaseRefusal(error)) {
    return nativeCommandLeaseRefusal({
      nativeMessage: error.nativeMessage,
      command,
      stage: "authored",
    });
  }
  if (
    !(
      error instanceof NativeRuntimeRequestError &&
      error.nativeCode === "native_graph_foreground" &&
      error.nativeCauseCode !== undefined
    )
  ) {
    return;
  }
  const message = nativeOwnerPreEffectMessage(error.nativeCauseCode, command);
  if (!message) {
    return;
  }
  const refusal = new NativeRuntimeRequestError({
    nativeCode: error.nativeCode,
    nativeCauseCode: error.nativeCauseCode,
    message,
  });
  notRunRefusals.add(refusal);
  return refusal;
}

/**
 * {@link nativeAuthoredCommandNotRunRefusal}, and for a refusal also release a
 * native background command's admission slot: no guest process exists for a
 * command that never ran, as for the Compose exec.
 */
export async function nativeAuthoredCommandNotRun(
  error: unknown,
  command: NativeLeaseCommand
): Promise<NativeRuntimeRequestError | undefined> {
  const refusal = nativeAuthoredCommandNotRunRefusal(error, command);
  if (refusal) {
    await noteNativeExitConfirmed();
  }
  return refusal;
}
