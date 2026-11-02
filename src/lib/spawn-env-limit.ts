import { readFileSync } from "node:fs";
import { HackCliError } from "./cli-result.ts";

/**
 * Preflight for the operating system's limit on a new process's arguments
 * and environment (HACK-1317).
 *
 * `execve`/`posix_spawn` fail with `E2BIG` when the argument and environment
 * strings, with their terminating NULs and pointer arrays, exceed the
 * platform limit (`ARG_MAX`), or on Linux when one `NAME=value` string
 * exceeds `MAX_ARG_STRLEN`. Hack checks the Compose environment before it
 * starts `docker compose`, so an oversized environment fails with the closed
 * `E_ENV_TOO_LARGE` code instead of an unclassified spawn fault.
 *
 * Everything here works on byte counts only; no value is returned, logged or
 * kept.
 */

/** `ARG_MAX` on macOS (`sysctl kern.argmax`). */
export const DARWIN_ARG_MAX_BYTES = 1024 * 1024;
/** Linux floor for the argument area (`ARG_MAX`, 32 pages of 4 KiB). */
export const LINUX_MIN_ARG_BYTES = 128 * 1024;
/** Linux ceiling for the argument area: three quarters of `_STK_LIM` (8 MiB). */
export const LINUX_MAX_ARG_BYTES = 6 * 1024 * 1024;
/** Linux default stack soft limit, assumed when `/proc/self/limits` is unreadable. */
export const LINUX_DEFAULT_STACK_BYTES = 8 * 1024 * 1024;
/** Linux `MAX_ARG_STRLEN`: one `NAME=value` string, NUL included, on 4 KiB pages. */
export const LINUX_MAX_ARG_STRLEN_BYTES = 128 * 1024;
/** Assumed limit on a platform Hack has no documented value for. */
export const OTHER_ARG_MAX_BYTES = 256 * 1024;
/**
 * Room kept for the Compose arguments (subcommand, `-f` files, profiles,
 * service names) and loader strings, which the check does not see.
 */
export const SPAWN_ARGV_RESERVE_BYTES = 64 * 1024;
const POINTER_BYTES = 8;

/** The limit a child process's environment must fit. */
export type SpawnEnvLimit = {
  /** Platform label for messages. */
  readonly platform: "macOS" | "Linux" | "this platform";
  /** Budget for the environment strings and pointers after the argv reserve. */
  readonly envBytes: number;
  /** The platform's whole argument-and-environment limit. */
  readonly argMaxBytes: number;
  /** Largest single `NAME=value` string with its NUL, or null for no such limit. */
  readonly singleStringBytes: number | null;
};

/**
 * Linux argument-area limit for a stack soft limit, as `fs/exec.c` computes
 * it: a quarter of the stack, at most 6 MiB and at least 128 KiB. Null means
 * an unlimited stack.
 */
export function linuxArgMaxBytes(stackSoftLimitBytes: number | null): number {
  const quarter =
    stackSoftLimitBytes === null
      ? LINUX_MAX_ARG_BYTES
      : Math.floor(stackSoftLimitBytes / 4);
  return Math.max(Math.min(quarter, LINUX_MAX_ARG_BYTES), LINUX_MIN_ARG_BYTES);
}

/**
 * Limit for `platform`. On Linux, `linuxStackSoftLimitBytes` is the stack
 * soft limit (null = unlimited); when omitted, the 8 MiB default is assumed.
 * Pure.
 */
export function spawnEnvLimitForPlatform(opts: {
  readonly platform: NodeJS.Platform;
  readonly linuxStackSoftLimitBytes?: number | null;
}): SpawnEnvLimit {
  if (opts.platform === "darwin") {
    return {
      platform: "macOS",
      argMaxBytes: DARWIN_ARG_MAX_BYTES,
      envBytes: DARWIN_ARG_MAX_BYTES - SPAWN_ARGV_RESERVE_BYTES,
      singleStringBytes: null,
    };
  }
  if (opts.platform === "linux") {
    const argMaxBytes = linuxArgMaxBytes(
      opts.linuxStackSoftLimitBytes === undefined
        ? LINUX_DEFAULT_STACK_BYTES
        : opts.linuxStackSoftLimitBytes
    );
    return {
      platform: "Linux",
      argMaxBytes,
      envBytes: Math.max(argMaxBytes - SPAWN_ARGV_RESERVE_BYTES, 0),
      singleStringBytes: LINUX_MAX_ARG_STRLEN_BYTES,
    };
  }
  return {
    platform: "this platform",
    argMaxBytes: OTHER_ARG_MAX_BYTES,
    envBytes: OTHER_ARG_MAX_BYTES - SPAWN_ARGV_RESERVE_BYTES,
    singleStringBytes: null,
  };
}

const STACK_LIMIT_LINE = /^Max stack size\s+(\S+)/m;

/**
 * Stack soft limit from `/proc/self/limits` text: bytes, null for
 * `unlimited`, or undefined when the text has no readable line. Pure.
 */
export function parseLinuxStackSoftLimit(
  text: string
): number | null | undefined {
  const soft = STACK_LIMIT_LINE.exec(text)?.[1];
  if (soft === undefined) {
    return undefined;
  }
  if (soft === "unlimited") {
    return null;
  }
  const bytes = Number(soft);
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : undefined;
}

/** Limit for the running process, reading the Linux stack limit when it can. */
export function currentSpawnEnvLimit(): SpawnEnvLimit {
  if (process.platform !== "linux") {
    return spawnEnvLimitForPlatform({ platform: process.platform });
  }
  let stack: number | null | undefined;
  try {
    stack = parseLinuxStackSoftLimit(readFileSync("/proc/self/limits", "utf8"));
  } catch {
    stack = undefined;
  }
  return spawnEnvLimitForPlatform({
    platform: "linux",
    linuxStackSoftLimitBytes: stack,
  });
}

/** Byte counts of an environment as `execve` lays it out. Counts only. */
export type SpawnEnvSize = {
  /** `NAME=value` strings with NULs, plus one pointer per entry and the terminator. */
  readonly totalBytes: number;
  /** Largest single `NAME=value` string with its NUL. */
  readonly largestStringBytes: number;
};

/** Measures `env` without keeping any of it. Pure. */
export function measureSpawnEnv(
  env: Readonly<Record<string, string>>
): SpawnEnvSize {
  let totalBytes = POINTER_BYTES;
  let largestStringBytes = 0;
  for (const [key, value] of Object.entries(env)) {
    const bytes = Buffer.byteLength(key) + 1 + Buffer.byteLength(value) + 1;
    totalBytes += bytes + POINTER_BYTES;
    largestStringBytes = Math.max(largestStringBytes, bytes);
  }
  return { totalBytes, largestStringBytes };
}

/** Which limit an environment exceeds, by counts only. */
export type SpawnEnvOverflow =
  | {
      readonly limit: "ARG_MAX";
      readonly bytes: number;
      readonly limitBytes: number;
    }
  | {
      readonly limit: "MAX_ARG_STRLEN";
      readonly bytes: number;
      readonly limitBytes: number;
    };

/** The first limit `size` exceeds, or null when it fits. Pure. */
export function spawnEnvOverflow(opts: {
  readonly size: SpawnEnvSize;
  readonly limit: SpawnEnvLimit;
}): SpawnEnvOverflow | null {
  const single = opts.limit.singleStringBytes;
  if (single !== null && opts.size.largestStringBytes > single) {
    return {
      limit: "MAX_ARG_STRLEN",
      bytes: opts.size.largestStringBytes,
      limitBytes: single,
    };
  }
  if (opts.size.totalBytes > opts.limit.envBytes) {
    return {
      limit: "ARG_MAX",
      bytes: opts.size.totalBytes,
      limitBytes: opts.limit.envBytes,
    };
  }
  return null;
}

const REDUCE_HINT =
  "To reduce it, make large env values smaller or remove them (for example, mount a large credential as a file and pass its path), set a value once in the global scope instead of in each service scope, or unset large variables in the shell that runs hack.";

function kib(bytes: number): string {
  return `${Math.ceil(bytes / 1024)} KiB`;
}

/**
 * Closed, value-free `E_ENV_TOO_LARGE` error for an overflow: names the limit
 * and how to reduce the environment, with byte counts only.
 */
export function spawnEnvTooLargeError(opts: {
  readonly overflow: SpawnEnvOverflow;
  readonly limit: SpawnEnvLimit;
}): HackCliError {
  const { overflow, limit } = opts;
  const message =
    overflow.limit === "MAX_ARG_STRLEN"
      ? `One Compose environment variable is ${kib(overflow.bytes)}, over the ${kib(overflow.limitBytes)} ${limit.platform} limit for a single NAME=value string (MAX_ARG_STRLEN), so Hack did not start docker compose. ${REDUCE_HINT}`
      : `The Compose environment needs ${kib(overflow.bytes)}, over the ${kib(overflow.limitBytes)} Hack allows under the ${kib(limit.argMaxBytes)} ${limit.platform} limit for a new process's arguments and environment (ARG_MAX), so Hack did not start docker compose. ${REDUCE_HINT}`;
  return new HackCliError({
    code: "E_ENV_TOO_LARGE",
    message,
    detail: {
      limit: overflow.limit,
      bytes: overflow.bytes,
      limitBytes: overflow.limitBytes,
    },
  });
}

/**
 * Throws `E_ENV_TOO_LARGE` when the environment a `docker compose` child
 * would get (the live `process.env` plus `env`, as the spawn helpers merge
 * them) does not fit `limit`. Call it before writing or spawning anything
 * for the Compose invocation.
 */
export function assertComposeSpawnEnvFits(opts: {
  readonly env: Readonly<Record<string, string>>;
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
  readonly limit?: SpawnEnvLimit;
}): void {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(opts.baseEnv ?? process.env)) {
    if (typeof value === "string") {
      merged[key] = value;
    }
  }
  Object.assign(merged, opts.env);
  const limit = opts.limit ?? currentSpawnEnvLimit();
  const overflow = spawnEnvOverflow({ size: measureSpawnEnv(merged), limit });
  if (overflow) {
    throw spawnEnvTooLargeError({ overflow, limit });
  }
}
