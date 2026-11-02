import { secrets } from "bun";
import { ClosedCliError } from "./cli-result.ts";
import { resolveTimeoutOverrideMs } from "./duration.ts";

/**
 * Deadline-bounded access to the OS keychain (`Bun.secrets`).
 *
 * `Bun.secrets` calls the platform keychain (macOS Security framework,
 * libsecret over the D-Bus session bus on Linux). Those calls have no timeout
 * of their own: with no GUI session, a locked keychain, or a session bus that
 * accepts a connection but never answers, they can block indefinitely.
 *
 * Contract:
 * - Every call is bounded by {@link NATIVE_KEYCHAIN_TIMEOUT_MS}, overridable
 *   with {@link NATIVE_KEYCHAIN_TIMEOUT_ENV}.
 * - On timeout the caller gets a closed {@link NativeKeychainTimeoutError}
 *   whose message names only the operation; it never carries a service,
 *   name, value, or platform error text.
 * - A timed-out native call cannot be canceled and keeps the process alive.
 *   It is recorded so the CLI entrypoint can exit explicitly
 *   ({@link hasAbandonedNativeKeychainCall}) instead of hanging after the
 *   refusal has been reported.
 * - The outcome of a timed-out `set` or `delete` is unknown: the keychain may
 *   still apply it later. The message says so instead of claiming nothing
 *   changed.
 */

/**
 * Default per-call keychain deadline. Long enough for a human to answer a
 * keychain access dialog, short enough that an unattended run fails visibly.
 */
export const NATIVE_KEYCHAIN_TIMEOUT_MS = 60_000;

/** Upper bound accepted from {@link NATIVE_KEYCHAIN_TIMEOUT_ENV}. */
export const NATIVE_KEYCHAIN_TIMEOUT_MAX_MS = 10 * 60_000;

/** Positive integer milliseconds overriding {@link NATIVE_KEYCHAIN_TIMEOUT_MS}. */
export const NATIVE_KEYCHAIN_TIMEOUT_ENV = "HACK_KEYCHAIN_TIMEOUT_MS";

export type NativeKeychainOperation = "get" | "set" | "delete";

const OUTCOME: Readonly<Record<NativeKeychainOperation, string>> = {
  get: "No value was read.",
  set: "The write may or may not have been applied; check it once the keychain responds.",
  delete:
    "The delete may or may not have been applied; check it once the keychain responds.",
};

/** Closed refusal for a keychain call that missed its deadline. */
export class NativeKeychainTimeoutError extends ClosedCliError {
  readonly operation: NativeKeychainOperation;

  constructor(operation: NativeKeychainOperation) {
    super(
      `The OS keychain did not answer a ${operation} request before the deadline (${NATIVE_KEYCHAIN_TIMEOUT_ENV}, default ${NATIVE_KEYCHAIN_TIMEOUT_MS / 1000}s). ${OUTCOME[operation]} Unlock the keychain in a desktop session, or configure the encrypted_file secrets backend for headless use.`
    );
    this.name = "NativeKeychainTimeoutError";
    this.operation = operation;
  }
}

let abandonedCalls = 0;

/**
 * Whether a keychain call timed out and may still be pending. The CLI
 * entrypoint uses this to exit explicitly once the command has finished.
 */
export function hasAbandonedNativeKeychainCall(): boolean {
  return abandonedCalls > 0;
}

/**
 * Resolve the keychain deadline from {@link NATIVE_KEYCHAIN_TIMEOUT_ENV}.
 * A set value must be an integer from 1000 to {@link NATIVE_KEYCHAIN_TIMEOUT_MAX_MS};
 * anything else is refused with a fixed usage error.
 */
export function resolveNativeKeychainTimeoutMs(
  env: Readonly<Record<string, string | undefined>> = process.env
): number {
  return resolveTimeoutOverrideMs({
    name: NATIVE_KEYCHAIN_TIMEOUT_ENV,
    fallback: NATIVE_KEYCHAIN_TIMEOUT_MS,
    max: NATIVE_KEYCHAIN_TIMEOUT_MAX_MS,
    env,
  });
}

/**
 * Run one keychain call under a deadline.
 *
 * @param input.operation - Operation name used in the closed refusal.
 * @param input.run - The native call.
 * @param input.timeoutMs - Deadline; defaults to {@link resolveNativeKeychainTimeoutMs}.
 * @throws NativeKeychainTimeoutError when the deadline passes first. Errors
 *   from `run` propagate unchanged.
 */
export async function withNativeKeychainDeadline<T>(input: {
  readonly operation: NativeKeychainOperation;
  readonly run: () => Promise<T>;
  readonly timeoutMs?: number;
}): Promise<T> {
  const timeoutMs = input.timeoutMs ?? resolveNativeKeychainTimeoutMs();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abandonedCalls += 1;
      reject(new NativeKeychainTimeoutError(input.operation));
    }, timeoutMs);
  });
  try {
    return await Promise.race([input.run(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Deadline-bounded `Bun.secrets` facade with the same call shapes. */
export const nativeKeychain = {
  get: (options: {
    readonly service: string;
    readonly name: string;
  }): Promise<string | null> =>
    withNativeKeychainDeadline({
      operation: "get",
      run: () => secrets.get(options),
    }),
  set: (options: {
    readonly service: string;
    readonly name: string;
    readonly value: string;
  }): Promise<void> =>
    withNativeKeychainDeadline({
      operation: "set",
      run: () => secrets.set(options),
    }),
  delete: (options: {
    readonly service: string;
    readonly name: string;
  }): Promise<boolean> =>
    withNativeKeychainDeadline({
      operation: "delete",
      run: () => secrets.delete(options),
    }),
} as const;
