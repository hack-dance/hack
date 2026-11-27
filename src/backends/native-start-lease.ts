/**
 * What a start says while it waits for the native runtime lock, and when it
 * gives up (HACK-2724).
 *
 * Another project's `hack down` holds the provider lease for its whole graph
 * stop, up to the 30 s per-service stop grace. The start's lease waits that
 * admit nothing (`START_LEASE_WAIT` in the runtime's `provider/lifecycle.rs`)
 * cover that with a margin. The runtime reports a wait that lasted about 3 s
 * as one closed holder token (`hack.lease-wait:begin <token>`); this module
 * turns it into one progress line. On expiry the runtime's closed refusal names
 * the recorded holder, and the start prints the holder and the next step.
 */

/** The runtime's `START_LEASE_WAIT`, for the progress line. */
export const NATIVE_START_LEASE_WAIT_SECONDS = 35;

/**
 * The request bound of a short start read whose runtime side waits up to
 * {@link NATIVE_START_LEASE_WAIT_SECONDS} for the lock (the retained-start
 * preflight, the startup `graph inspect`). It was 30 s, shorter than that wait,
 * so it leaves the read its own 25 s after the wait.
 */
export const NATIVE_START_LEASE_REQUEST_TIMEOUT_MS = 60_000;

/**
 * The closed failure code a detached owner publishes for a start whose raw
 * lease wait expired: exactly the refusals {@link markNativeStartLeaseRefusal}
 * marked. A `provider_busy` that another failure wraps (for example an
 * unconfirmed exit cleanup) keeps its own report and recovery step.
 */
export const NATIVE_START_LEASE_BUSY = "start_lease_busy";

const startLeaseRefusals = new WeakSet<object>();

/** Mark a start's own `provider_busy` refusal (nothing was admitted). */
export function markNativeStartLeaseRefusal(error: object): void {
  startLeaseRefusals.add(error);
}

/** Whether `error` is a start's own lease refusal that {@link markNativeStartLeaseRefusal} marked. */
export function isNativeStartLeaseRefusal(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && startLeaseRefusals.has(error)
  );
}

/** Holder tokens of the runtime's report, and the words its refusal uses. */
const HOLDER_WORDS: Readonly<Record<string, string>> = {
  cleanup: "cleanup",
  "project-stop": "project stop",
  recovery: "recovery",
  start: "start",
  inspection: "inspection",
  "retained-startup-check": "retained startup check",
  "image-acquisition": "image acquisition",
  "project-share-update": "project share update",
  "native-operation": "native operation",
};

/** The holder as the progress line names it, with its article. */
const HOLDER_PHRASE: Readonly<Record<string, string>> = {
  cleanup: "a cleanup",
  "project stop": "a project stop",
  recovery: "a recovery",
  start: "another start",
  inspection: "an inspection",
  "retained startup check": "another start's retained startup check",
  "image acquisition": "an image acquisition",
  "project share update": "a project share update",
};

const START_LOCK_HOLDER =
  /^Provider lease acquisition refused; recorded holder: ([a-z ]+); no operation was admitted\.$/;

/** The recorded holder's words from the runtime's closed refusal, if it names one. */
export function nativeStartLeaseHolder(
  nativeMessage: string | undefined
): string | undefined {
  return START_LOCK_HOLDER.exec(nativeMessage ?? "")?.[1];
}

/**
 * The one progress line for a start still waiting on the lock after about
 * 3 s; `token` is the runtime's closed holder token. An unknown token names
 * no holder.
 */
export function nativeStartLeaseWaitLine(token: string | undefined): string {
  return `Waiting for the native runtime lock, held by ${nativeLeaseHolderPhrase(token)}. This start continues once it is released (up to ${NATIVE_START_LEASE_WAIT_SECONDS} s).`;
}

/**
 * The holder a progress line names, with its article, for the runtime's closed
 * holder token. An unknown token names no holder.
 */
export function nativeLeaseHolderPhrase(token: string | undefined): string {
  const words = token === undefined ? undefined : HOLDER_WORDS[token];
  return (words && HOLDER_PHRASE[words]) ?? "another native runtime operation";
}

/**
 * The refusal of a start whose lease wait expired (`provider_busy`): nothing
 * was admitted, so the next step is a plain retry once the holder finishes.
 * `command` is the command to retry, as the user ran it.
 */
export function nativeStartLeaseRefusal(opts: {
  readonly nativeMessage: string | undefined;
  readonly command: "hack up" | "hack up -d";
}): string {
  const holder = nativeStartLeaseHolder(opts.nativeMessage);
  return [
    "Native startup could not acquire the native runtime lock (provider_busy); nothing was started.",
    `Holder: ${holder ?? "unavailable"}.`,
    holder
      ? `Retry ${opts.command} once that ${holder} finishes.`
      : `Retry ${opts.command} once the holder finishes.`,
  ].join("\n");
}
