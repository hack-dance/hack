import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  type ComposeEnvFingerprintRecord,
  type ComposeServiceEnvFreshness,
  evaluateComposeServiceEnvFreshness,
  parseComposeEnvFingerprintRecord,
} from "./compose-env-fingerprint.ts";
import { isRecord } from "./guards.ts";

/**
 * Value-free record of the env selection a native foreground run delivered to
 * its services (HACK-1140), so `hack exec` can warn when the env resolved now
 * differs from the env a running service started with.
 *
 * Ownership: the foreground `hack up`/`hack restart` that delivered the env
 * owns its record. It writes the record once the run is ready and removes it
 * (only if the record is still its own) when the foreground ends. A restart
 * drops the scope's record once the previous run is being stopped, so a failed
 * restart leaves no record and exec stays silent rather than guessing.
 *
 * Invariants:
 * - The record holds the salted HMAC digests from `compose-env-fingerprint.ts`,
 *   the run id it belongs to and, for authored projects, the public env and
 *   profile selectors needed to resolve the same selection again. It never
 *   holds a key name or value.
 * - Comparison is bound to the run id: a record from another run is `unknown`.
 * - Everything is advisory. Read failures, malformed or foreign records yield
 *   no record; write failures never fail startup or exec.
 * - Each scope (owner kind plus branch) has its own file, written atomically
 *   (temporary file plus rename, mode 0600), so concurrent instances of one
 *   project never overwrite each other's record.
 */

export type NativeEnvFingerprintOwner = "image" | "authored";

export type NativeEnvFingerprintScope = {
  /** The project's `.hack` directory. */
  readonly projectDir: string;
  readonly owner: NativeEnvFingerprintOwner;
  readonly branch: string | null;
};

/** Public selectors an authored run was started with; never values. */
export type NativeEnvSelection = {
  /** Absent: the default selection; null: explicit base. */
  readonly overlay?: string | null;
  readonly profiles?: readonly string[];
};

export type NativeEnvFingerprintEntry = {
  readonly version: typeof NATIVE_ENV_FINGERPRINT_VERSION;
  readonly owner: NativeEnvFingerprintOwner;
  readonly run: string;
  readonly selection: NativeEnvSelection;
  readonly fingerprint: ComposeEnvFingerprintRecord;
};

export const NATIVE_ENV_FINGERPRINT_VERSION = 1 as const;

const RUN_PATTERN = /^[a-f0-9]{32}$/;
// Equivalent to normalizeEnvConfigName(value) === value, bounded.
const ENV_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CONTROL = /\p{Cc}/u;
const MAX_PROFILES = 64;
const MAX_PROFILE_BYTES = 256;
const MAX_RECORD_BYTES = 256 * 1024;
const DIRECTORY = "native-env-fingerprints";

/** Absolute path of a scope's record; the file name never carries the branch. */
export function resolveNativeEnvFingerprintPath(
  scope: NativeEnvFingerprintScope
): string {
  const key = createHash("sha256")
    .update(JSON.stringify({ owner: scope.owner, branch: scope.branch }))
    .digest("hex");
  return join(scope.projectDir, ".internal", DIRECTORY, `${key}.json`);
}

/** Pure, value-free entry for `run`; throws on an invalid run id or selection. */
export function createNativeEnvFingerprintEntry(opts: {
  readonly owner: NativeEnvFingerprintOwner;
  readonly run: string;
  readonly fingerprint: ComposeEnvFingerprintRecord;
  readonly selection?: NativeEnvSelection;
}): NativeEnvFingerprintEntry {
  const selection = opts.selection ?? {};
  if (!(RUN_PATTERN.test(opts.run) && validSelection(selection))) {
    throw new Error("Invalid native env fingerprint entry; values omitted.");
  }
  return {
    version: NATIVE_ENV_FINGERPRINT_VERSION,
    owner: opts.owner,
    run: opts.run,
    selection: {
      ...(selection.overlay === undefined
        ? {}
        : { overlay: selection.overlay }),
      ...(selection.profiles === undefined
        ? {}
        : { profiles: [...selection.profiles] }),
    },
    fingerprint: opts.fingerprint,
  };
}

/** Atomically replace the scope's record. Throws on I/O failure. */
export async function saveNativeEnvFingerprint(
  scope: NativeEnvFingerprintScope,
  entry: NativeEnvFingerprintEntry
): Promise<void> {
  if (entry.owner !== scope.owner) {
    throw new Error("Native env fingerprint owner mismatch; values omitted.");
  }
  const path = resolveNativeEnvFingerprintPath(scope);
  const directory = join(scope.projectDir, ".internal", DIRECTORY);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${randomBytes(8).toString("hex")}.tmp`);
  const handle = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600
  );
  try {
    await handle.writeFile(`${JSON.stringify(entry)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

/** The scope's record, or null when absent, unreadable, malformed or foreign. */
export async function loadNativeEnvFingerprint(
  scope: NativeEnvFingerprintScope
): Promise<NativeEnvFingerprintEntry | null> {
  let text: string;
  try {
    const handle = await open(
      resolveNativeEnvFingerprintPath(scope),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || stats.size > MAX_RECORD_BYTES) {
        return null;
      }
      text = await handle.readFile({ encoding: "utf8" });
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
  try {
    return parseNativeEnvFingerprintEntry(JSON.parse(text), scope.owner);
  } catch {
    return null;
  }
}

/**
 * Remove the scope's record. With `salt`, only a record that still carries
 * that salt (the caller's own record) is removed. Never throws.
 */
export async function forgetNativeEnvFingerprint(
  scope: NativeEnvFingerprintScope,
  opts: { readonly salt?: string } = {}
): Promise<void> {
  try {
    if (opts.salt !== undefined) {
      const current = await loadNativeEnvFingerprint(scope);
      if (current?.fingerprint.salt !== opts.salt) {
        return;
      }
    }
    await unlink(resolveNativeEnvFingerprintPath(scope));
  } catch {
    // Absent or unremovable: exec still compares only within the same run.
  }
}

/** Compare a record for the current `run` with the env resolved now. */
export function evaluateNativeServiceEnvFreshness(opts: {
  readonly entry: NativeEnvFingerprintEntry | null;
  readonly run: string;
  readonly service: string;
  readonly currentEnv: Readonly<Record<string, string>>;
}): ComposeServiceEnvFreshness {
  if (!opts.entry || opts.entry.run !== opts.run) {
    return "unknown";
  }
  return evaluateComposeServiceEnvFreshness({
    record: opts.entry.fingerprint,
    service: opts.service,
    currentEnv: opts.currentEnv,
  });
}

/**
 * Bookkeeping for one foreground lifetime. Writes are queued in call order and
 * every failure is swallowed: the record is advisory.
 */
export type NativeEnvFingerprintSession = {
  /** Remember a value-free entry to commit later (for synchronous observers). */
  readonly capture: (entry: NativeEnvFingerprintEntry) => void;
  /** Queue the write of the captured entry, if any. */
  readonly commit: () => void;
  /** Queue removal of the scope's record, whoever wrote it. */
  readonly drop: () => void;
  /** Capture, commit and wait for the write. */
  readonly record: (entry: NativeEnvFingerprintEntry) => Promise<void>;
  /** Wait for queued writes, then remove the record if it is still ours. */
  readonly release: () => Promise<void>;
};

export function createNativeEnvFingerprintSession(
  scope: NativeEnvFingerprintScope
): NativeEnvFingerprintSession {
  let captured: NativeEnvFingerprintEntry | undefined;
  let written: string | undefined;
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (step: () => Promise<void>) => {
    queue = queue.then(step).catch(() => undefined);
  };
  const capture = (entry: NativeEnvFingerprintEntry) => {
    captured = entry;
  };
  const commit = () => {
    const entry = captured;
    captured = undefined;
    if (!entry) {
      return;
    }
    enqueue(async () => {
      await saveNativeEnvFingerprint(scope, entry);
      written = entry.fingerprint.salt;
    });
  };
  return {
    capture,
    commit,
    drop: () => {
      enqueue(async () => {
        await forgetNativeEnvFingerprint(scope);
      });
    },
    record: async (entry) => {
      capture(entry);
      commit();
      await queue;
    },
    release: async () => {
      await queue;
      const salt = written;
      written = undefined;
      if (salt !== undefined) {
        await forgetNativeEnvFingerprint(scope, { salt });
      }
    },
  };
}

function validSelection(value: {
  readonly overlay?: unknown;
  readonly profiles?: unknown;
}): value is NativeEnvSelection {
  const overlay = value.overlay;
  if (
    overlay !== undefined &&
    overlay !== null &&
    !(
      typeof overlay === "string" &&
      overlay.length <= 128 &&
      ENV_NAME_PATTERN.test(overlay)
    )
  ) {
    return false;
  }
  const profiles = value.profiles;
  return (
    profiles === undefined ||
    (Array.isArray(profiles) &&
      profiles.length <= MAX_PROFILES &&
      profiles.every(
        (profile: unknown) =>
          typeof profile === "string" &&
          profile.length > 0 &&
          Buffer.byteLength(profile) <= MAX_PROFILE_BYTES &&
          !CONTROL.test(profile)
      ))
  );
}

function parseNativeEnvFingerprintEntry(
  value: unknown,
  owner: NativeEnvFingerprintOwner
): NativeEnvFingerprintEntry | null {
  if (
    !isRecord(value) ||
    value.version !== NATIVE_ENV_FINGERPRINT_VERSION ||
    value.owner !== owner ||
    typeof value.run !== "string" ||
    !RUN_PATTERN.test(value.run) ||
    !isRecord(value.selection)
  ) {
    return null;
  }
  const rawSelection = value.selection;
  const keys = Object.keys(rawSelection);
  if (keys.some((key) => key !== "overlay" && key !== "profiles")) {
    return null;
  }
  const selection: { overlay?: unknown; profiles?: unknown } = {
    ...(Object.hasOwn(rawSelection, "overlay")
      ? { overlay: rawSelection.overlay }
      : {}),
    ...(Object.hasOwn(rawSelection, "profiles")
      ? { profiles: rawSelection.profiles }
      : {}),
  };
  if (!validSelection(selection)) {
    return null;
  }
  const fingerprint = parseComposeEnvFingerprintRecord(value.fingerprint);
  if (!fingerprint) {
    return null;
  }
  return createNativeEnvFingerprintEntry({
    owner,
    run: value.run,
    fingerprint,
    selection,
  });
}
