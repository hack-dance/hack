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
import { NativeRuntimeRequestError } from "./native-runtime-client.ts";
import {
  NATIVE_START_LEASE_WAIT_SECONDS,
  nativeLeaseHolderPhrase,
  nativeStartLeaseHolder,
} from "./native-start-lease.ts";

/** The runtime's `COMMAND_REQUEST_LEASE_WAIT`, which is its `START_LEASE_WAIT`. */
export const NATIVE_COMMAND_LEASE_WAIT_SECONDS =
  NATIVE_START_LEASE_WAIT_SECONDS;

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
  const holder = nativeStartLeaseHolder(opts.nativeMessage);
  const outcome =
    opts.stage === "exec" ? "the command did not run" : "nothing ran";
  const error = new NativeRuntimeRequestError({
    nativeCode: opts.nativeCode ?? "provider_busy",
    nativeCauseCode: opts.nativeCauseCode,
    nativeMessage: opts.nativeMessage,
    message: [
      `${opts.command} could not acquire the native runtime lock (provider_busy); ${outcome}.`,
      `Holder: ${holder ?? "unavailable"}.`,
      holder
        ? `Retry ${opts.command} once that ${holder} finishes.`
        : `Retry ${opts.command} once the holder finishes.`,
    ].join("\n"),
  });
  notRunRefusals.add(error);
  return error;
}
