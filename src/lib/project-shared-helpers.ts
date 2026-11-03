import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { resolveGlobalHackDir } from "./config-paths.ts";
import { isRecord } from "./guards.ts";
import { withProjectsRegistryLock } from "./projects-registry-lock.ts";
import {
  ensureSharedHostHelper,
  releaseSharedHostHelper,
  type SharedHostEnsureResult,
  type SharedHostHelperSpec,
  type SharedHostReleaseResult,
  sharedHostFailureMessage,
} from "./shared-host-lifecycle.ts";

/**
 * Project wiring for the shared host helper contract
 * (docs/reference/shared-host-lifecycle.md): `lifecycle.sharedHelpers` in
 * `hack.config.json`, started by `hack up`/`restart` and released by
 * `hack down`.
 *
 * Invariants:
 * - The claim directory is derived from the helper name and port only, under
 *   the global Hack home, so every branch and checkout of every project that
 *   names the same helper and port coordinates through one claim and lock.
 * - The holder is the instance's Compose project (`<project>` or
 *   `<project>--<branch>`), so two branches hold one helper independently and
 *   the last release stops an owned helper.
 * - A failed or signalled `up` releases only the holders that operation
 *   recorded (`holderAdded`), so a retry never drops a holder that an earlier
 *   successful `up` still relies on.
 * - Nothing here signals a process: stopping is the library's birth-verified
 *   release. Messages name the helper and a closed reason, never upstreams,
 *   argv or environment values.
 */

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DEFAULT_IDENTITY_PATH = "/__hack/identity";
const DEFAULT_READY_TIMEOUT_MS = 30_000;
const MAX_READY_TIMEOUT_MS = 600_000;
const DEFAULT_PROBE_TIMEOUT_MS = 2000;
const BACKOFF = { initialMs: 100, maxMs: 2000 } as const;
const ALLOWED_KEYS = new Set([
  "name",
  "enabled",
  "command",
  "cwd",
  "port",
  "identityPath",
  "upstream",
  "upstreamEnv",
  "env",
  "readyTimeoutMs",
]);

export type ProjectSharedHelperConfig = {
  /** Helper kind: the identity `helper` value and the claim name. */
  readonly name: string;
  readonly enabled: boolean;
  /** Argv, executed directly (never through a shell string). */
  readonly command: readonly string[];
  readonly cwd?: string;
  readonly port: number;
  readonly identityPath: string;
  /** Exactly one of `upstream` and `upstreamEnv` is set. */
  readonly upstream?: string;
  readonly upstreamEnv?: string;
  /** Names passed to the helper, besides PATH. */
  readonly env: readonly string[];
  readonly readyTimeoutMs: number;
};

/**
 * Strictly parse `lifecycle.sharedHelpers`. Unlike other lifecycle entries,
 * an invalid entry is a config error, not a silently skipped one: a helper
 * that is quietly not started fails later and further from its cause.
 */
export function parseProjectSharedHelpers(value: unknown): {
  readonly helpers?: readonly ProjectSharedHelperConfig[];
  readonly errors: readonly string[];
} {
  if (value === undefined) {
    return { errors: [] };
  }
  if (!Array.isArray(value)) {
    return { errors: ["lifecycle.sharedHelpers must be an array."] };
  }
  const errors: string[] = [];
  const helpers: ProjectSharedHelperConfig[] = [];
  value.forEach((entry: unknown, index: number) => {
    const parsed = parseHelper(entry, `lifecycle.sharedHelpers[${index}]`);
    if ("error" in parsed) {
      errors.push(parsed.error);
      return;
    }
    if (helpers.some((helper) => helper.name === parsed.helper.name)) {
      errors.push(
        `lifecycle.sharedHelpers[${index}].name duplicates "${parsed.helper.name}".`
      );
      return;
    }
    if (helpers.some((helper) => helper.port === parsed.helper.port)) {
      errors.push(
        `lifecycle.sharedHelpers[${index}].port duplicates ${parsed.helper.port}.`
      );
      return;
    }
    helpers.push(parsed.helper);
  });
  return {
    ...(helpers.length > 0 && errors.length === 0 ? { helpers } : {}),
    errors,
  };
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: One strict field-by-field validator keeps every refusal message next to its rule.
function parseHelper(
  value: unknown,
  at: string
): { readonly helper: ProjectSharedHelperConfig } | { readonly error: string } {
  if (!isRecord(value)) {
    return { error: `${at} must be an object.` };
  }
  const unknownKey = Object.keys(value).find((key) => !ALLOWED_KEYS.has(key));
  if (unknownKey !== undefined) {
    return { error: `${at} has unknown key "${unknownKey}".` };
  }
  const name = value.name;
  if (typeof name !== "string" || !NAME.test(name)) {
    return {
      error: `${at}.name must match [A-Za-z0-9][A-Za-z0-9_.-]{0,127}.`,
    };
  }
  const command = value.command;
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    !command.every((part) => typeof part === "string" && part.length > 0)
  ) {
    return {
      error: `${at}.command must be a non-empty array of non-empty strings (argv, not a shell string).`,
    };
  }
  const port = value.port;
  if (
    typeof port !== "number" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    return { error: `${at}.port must be an integer from 1 to 65535.` };
  }
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    return { error: `${at}.enabled must be a boolean.` };
  }
  if (
    value.cwd !== undefined &&
    (typeof value.cwd !== "string" || value.cwd.trim().length === 0)
  ) {
    return { error: `${at}.cwd must be a non-empty string.` };
  }
  const identityPath = value.identityPath ?? DEFAULT_IDENTITY_PATH;
  if (typeof identityPath !== "string" || !identityPath.startsWith("/")) {
    return { error: `${at}.identityPath must be an absolute path.` };
  }
  const hasUpstream = value.upstream !== undefined;
  const hasUpstreamEnv = value.upstreamEnv !== undefined;
  if (hasUpstream === hasUpstreamEnv) {
    return { error: `${at} needs exactly one of upstream and upstreamEnv.` };
  }
  if (
    hasUpstream &&
    (typeof value.upstream !== "string" || value.upstream.length === 0)
  ) {
    return { error: `${at}.upstream must be a non-empty string.` };
  }
  if (
    hasUpstreamEnv &&
    (typeof value.upstreamEnv !== "string" || !ENV_NAME.test(value.upstreamEnv))
  ) {
    return { error: `${at}.upstreamEnv must be an environment variable name.` };
  }
  const env = value.env ?? [];
  if (
    !(
      Array.isArray(env) &&
      env.every((entry) => typeof entry === "string" && ENV_NAME.test(entry))
    ) ||
    new Set(env).size !== env.length
  ) {
    return {
      error: `${at}.env must be an array of unique environment variable names.`,
    };
  }
  const readyTimeoutMs = value.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  if (
    typeof readyTimeoutMs !== "number" ||
    !Number.isInteger(readyTimeoutMs) ||
    readyTimeoutMs < 1 ||
    readyTimeoutMs > MAX_READY_TIMEOUT_MS
  ) {
    return {
      error: `${at}.readyTimeoutMs must be an integer from 1 to ${MAX_READY_TIMEOUT_MS}.`,
    };
  }
  return {
    helper: {
      name,
      enabled: value.enabled !== false,
      command: command as string[],
      ...(typeof value.cwd === "string" ? { cwd: value.cwd.trim() } : {}),
      port,
      identityPath,
      ...(hasUpstream ? { upstream: value.upstream as string } : {}),
      ...(hasUpstreamEnv ? { upstreamEnv: value.upstreamEnv as string } : {}),
      env: env as string[],
      readyTimeoutMs,
    },
  };
}

/**
 * The claim directory for one helper. It depends on the helper name and port
 * only, never on the project, branch or checkout, so every client of that
 * helper port shares one claim and lock.
 */
export function resolveSharedHelperStateDir(opts: {
  readonly hackDir?: string;
  readonly name: string;
  readonly port: number;
}): string {
  return join(
    opts.hackDir ?? resolveGlobalHackDir(),
    "shared-helpers",
    `${opts.name}-${opts.port}`
  );
}

/** Holder for one project instance; refuses names the claim cannot record. */
export function resolveSharedHelperHolder(composeProject: string): string {
  if (!NAME.test(composeProject)) {
    throw new Error(
      "Shared helpers need a Compose project name of letters, digits, '.', '_' or '-'."
    );
  }
  return composeProject;
}

/**
 * Build the library spec. The helper sees PATH from the CLI plus only the
 * names it lists; each comes from the resolved lifecycle env, then the CLI
 * environment. A listed name that is set in neither is an error.
 */
export function buildSharedHelperSpec(opts: {
  readonly helper: ProjectSharedHelperConfig;
  readonly projectRoot: string;
  readonly env: Readonly<Record<string, string>>;
  readonly processEnv?: Readonly<Record<string, string | undefined>>;
  readonly hackDir?: string;
}): SharedHostHelperSpec {
  const { helper } = opts;
  const processEnv = opts.processEnv ?? process.env;
  const lookup = (name: string): string | undefined =>
    opts.env[name] ?? processEnv[name];
  const childEnv: Record<string, string> = {};
  const path = processEnv.PATH;
  if (path !== undefined) {
    childEnv.PATH = path;
  }
  for (const name of helper.env) {
    const value = lookup(name);
    if (value === undefined) {
      throw new Error(
        `Shared helper "${helper.name}" lists env ${name}, but it is not set.`
      );
    }
    childEnv[name] = value;
  }
  const upstream =
    helper.upstream ??
    (helper.upstreamEnv === undefined ? undefined : lookup(helper.upstreamEnv));
  if (upstream === undefined || upstream.length === 0) {
    throw new Error(
      `Shared helper "${helper.name}" reads its upstream from ${helper.upstreamEnv}, but it is not set.`
    );
  }
  const cwd = helper.cwd
    ? resolve(opts.projectRoot, helper.cwd)
    : opts.projectRoot;
  return {
    name: helper.name,
    enabled: helper.enabled,
    stateDir: resolveSharedHelperStateDir({
      ...(opts.hackDir ? { hackDir: opts.hackDir } : {}),
      name: helper.name,
      port: helper.port,
    }),
    port: helper.port,
    identityPath: helper.identityPath,
    expected: { helper: helper.name, upstream },
    command: helper.command,
    cwd,
    env: childEnv,
    deadlineMs: helper.readyTimeoutMs,
    backoff: BACKOFF,
    probeTimeoutMs: Math.min(DEFAULT_PROBE_TIMEOUT_MS, helper.readyTimeoutMs),
  };
}

export type SharedHelperStartRecord = {
  readonly name: string;
  readonly result: SharedHostEnsureResult;
};

export type SharedHelperRelease = {
  readonly name: string;
  readonly result: SharedHostReleaseResult;
};

/** Raised when a shared helper is not ready; holders added by this run were released first. */
export class SharedHelperStartError extends Error {
  readonly helper: string;
  readonly reason: string;
  constructor(opts: {
    readonly helper: string;
    readonly reason: string;
    readonly message: string;
  }) {
    super(
      `Shared helper "${opts.helper}" failed (${opts.reason}): ${opts.message}`
    );
    this.name = "SharedHelperStartError";
    this.helper = opts.helper;
    this.reason = opts.reason;
  }
}

/** Raised when a concurrent `hack down` superseded this start. */
export class SharedHelperSupersededError extends Error {
  /** Whether services were already launched when the down was observed. */
  readonly servicesStarted: boolean;
  constructor(opts: { readonly servicesStarted?: boolean } = {}) {
    super(
      opts.servicesStarted === true
        ? "A concurrent hack down released this instance's shared helpers while its services started; run hack down to stop them, then hack up again."
        : "A concurrent hack down released this instance's shared helpers; startup stopped before launching services that need them. Run hack up again."
    );
    this.name = "SharedHelperSupersededError";
    this.servicesStarted = opts.servicesStarted === true;
  }
}

/**
 * Ensure every configured helper for one instance, in config order.
 *
 * On the first failure (or a thrown spec error) it releases, in reverse
 * order, the holders this call added, then throws. The returned `rollback`
 * does the same after a later phase of the operation fails.
 *
 * Instance coordination (all under one per-instance lock):
 * - A start whose helpers are all ready records its operation id as the
 *   instance's current operation (a start that fails never does).
 *   A rollback releases only while that is still current, so it never revokes
 *   a newer start of the same instance.
 * - Shutdown is tracked separately, as the instance's shutdown generation.
 *   Only `hack down` advances it: its stopping mark
 *   ({@link markSharedHelperInstanceStopping}) and its release. A start
 *   captures the generation, and `assertCurrent` fails once it changed, so
 *   the caller can refuse to launch services whose helpers a down released.
 *   A later start never restores it, even a successful one: its helpers need
 *   not satisfy this start's (an entry may be disabled or changed since). A
 *   newer start without a down in between does not fail it.
 * - The generation is the one the caller captured before its preparation
 *   hooks ran ({@link captureSharedHelperShutdownGeneration}), so a down
 *   during those hooks also supersedes this start: it fails before ensuring
 *   any helper.
 * - Lifecycle-session cleanup is coordinated separately, by
 *   {@link createSharedHelperSessionOwnership}.
 * - Before each helper is ensured its identity (name and port) is added to
 *   the instance's acquired record, so `hack down` still releases it after the
 *   entry is removed or renamed in config.
 */
export async function startProjectSharedHelpers(opts: {
  readonly helpers: readonly ProjectSharedHelperConfig[] | undefined;
  readonly projectRoot: string;
  readonly composeProject: string;
  readonly env: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly hackDir?: string;
  readonly processEnv?: Readonly<Record<string, string | undefined>>;
  readonly report?: (record: SharedHelperStartRecord) => void | Promise<void>;
  /**
   * The shutdown generation captured when the operation began, before its
   * preparation hooks. Omitted, it is read when helper startup begins.
   */
  readonly shutdownGeneration?: SharedHelperShutdownGeneration;
}): Promise<{
  readonly started: readonly SharedHelperStartRecord[];
  readonly rollback: () => Promise<readonly SharedHelperRelease[]>;
  /** Throws {@link SharedHelperSupersededError} once a down superseded this start. */
  readonly assertCurrent: (opts?: {
    readonly servicesStarted?: boolean;
  }) => Promise<void>;
}> {
  const helpers = opts.helpers ?? [];
  const started: SharedHelperStartRecord[] = [];
  const added: SharedHostHelperSpec[] = [];
  if (helpers.length === 0) {
    return {
      started,
      rollback: () => Promise.resolve([]),
      assertCurrent: () => Promise.resolve(),
    };
  }
  const holder = resolveSharedHelperHolder(opts.composeProject);
  const instance = instancePaths({ hackDir: opts.hackDir, holder });
  const operation = randomUUID();
  // Captured under the lock before the first ensure; see assertCurrent.
  let generation: string | null = null;
  // Each ensure is bounded by its own deadline; the lock wait covers them all.
  const lockTimeoutMs =
    helpers.reduce((sum, helper) => sum + helper.readyTimeoutMs, 0) + 10_000;
  const releaseAdded = (): Promise<readonly SharedHelperRelease[]> =>
    releaseSpecs({ specs: [...added].reverse(), holder });
  let rolledBack: Promise<readonly SharedHelperRelease[]> | null = null;
  const rollback = (): Promise<readonly SharedHelperRelease[]> => {
    rolledBack ??=
      added.length === 0
        ? Promise.resolve([])
        : withInstanceLock({
            instance,
            timeoutMs: INSTANCE_LOCK_TIMEOUT_MS,
            run: async () => {
              // Release only while this start is still the instance's
              // current operation and no down has advanced the shutdown
              // generation since it began. A down publishes the generation
              // and then its operation record as two writes, so a down
              // interrupted between them leaves this start's record in
              // place: the generation check keeps the holders anyway (the
              // down, or the next one, releases them), never stopping a
              // helper underneath containers this start already launched.
              if (
                (await readOperation(instance)) !== operation ||
                (await readGeneration(instance)) !== generation
              ) {
                return [];
              }
              await rm(instance.operationPath, { force: true });
              return await releaseAdded();
            },
          }).catch(
            // The lock was unavailable: whether this start is still current
            // cannot be decided, so keep its holders (hack down releases
            // them) and report it rather than throw from cleanup.
            (): readonly SharedHelperRelease[] =>
              added.map((spec) => ({
                name: spec.name,
                result: {
                  state: "failed",
                  reason: "lock-unavailable",
                  message: sharedHostFailureMessage("lock-unavailable"),
                },
              }))
          );
    return rolledBack;
  };
  const assertCurrent = async (
    check: { readonly servicesStarted?: boolean } = {}
  ): Promise<void> => {
    const current = await withInstanceLock({
      instance,
      timeoutMs: INSTANCE_LOCK_TIMEOUT_MS,
      run: async () => (await readGeneration(instance)) === generation,
    });
    if (!current) {
      throw new SharedHelperSupersededError(check);
    }
  };
  await mkdir(instance.dir, { recursive: true, mode: 0o700 });
  await withInstanceLock({
    instance,
    timeoutMs: lockTimeoutMs,
    ...(opts.signal ? { signal: opts.signal } : {}),
    run: async () => {
      const current = await readGeneration(instance);
      if (
        opts.shutdownGeneration !== undefined &&
        current !== opts.shutdownGeneration.value
      ) {
        // A down ran after this operation began (during its preparation
        // hooks): never start helpers for it.
        throw new SharedHelperSupersededError();
      }
      generation = current;
      try {
        for (const helper of helpers) {
          if (helper.enabled) {
            await recordAcquired(instance, [
              { name: helper.name, port: helper.port },
            ]);
          }
          const result = await ensureOne({ ...opts, helper, holder });
          if (result.state === "ready" && result.holderAdded) {
            added.push(result.spec);
          }
          const record = { name: helper.name, result: result.result };
          started.push(record);
          await opts.report?.(record);
          if (record.result.state === "failed") {
            throw new SharedHelperStartError({
              helper: helper.name,
              reason: record.result.reason,
              message: record.result.message,
            });
          }
        }
        // Only a start whose helpers are all ready becomes the current
        // operation. Recording earlier would let a start that then fails
        // replace a down's shutdown mark, so an older start would launch its
        // services without helpers. A failed write rolls back like any
        // other failure.
        await writeOperation(instance, operation);
      } catch (error: unknown) {
        // Still under the instance lock, and this start never became the
        // current operation: release exactly what it added. The operation
        // record is left as it was, so a shutdown mark stays in force.
        rolledBack = releaseAdded();
        await rolledBack;
        throw error;
      }
    },
  });
  return { started, rollback, assertCurrent };
}

async function ensureOne(opts: {
  readonly helper: ProjectSharedHelperConfig;
  readonly holder: string;
  readonly projectRoot: string;
  readonly env: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly hackDir?: string;
  readonly processEnv?: Readonly<Record<string, string | undefined>>;
}): Promise<
  | {
      readonly state: "ready";
      readonly holderAdded: boolean;
      readonly spec: SharedHostHelperSpec;
      readonly result: SharedHostEnsureResult;
    }
  | { readonly state: "other"; readonly result: SharedHostEnsureResult }
> {
  // A disabled helper needs none of its runtime env: it is never started.
  if (!opts.helper.enabled) {
    return {
      state: "other",
      result: { state: "disabled", ownership: "disabled" },
    };
  }
  const spec = buildSharedHelperSpec({
    helper: opts.helper,
    projectRoot: opts.projectRoot,
    env: opts.env,
    ...(opts.processEnv ? { processEnv: opts.processEnv } : {}),
    ...(opts.hackDir ? { hackDir: opts.hackDir } : {}),
  });
  const result = await ensureSharedHostHelper({
    spec,
    holder: opts.holder,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  return result.state === "ready"
    ? { state: "ready", holderAdded: result.holderAdded, spec, result }
    : { state: "other", result };
}

const INSTANCE_LOCK_TIMEOUT_MS = 10_000;
const STOPPING_PREFIX = "stopping:";
/**
 * Failure name used when this instance's helpers cannot be listed (its
 * acquired record is unreadable or its lock is unavailable) and no helper is
 * configured to name instead: the failure must still reach `hack down`.
 */
const UNLISTED_HELPERS = "recorded-helpers";
const MAX_ACQUIRED = 256;

type HelperIdentity = { readonly name: string; readonly port: number };

type InstancePaths = {
  readonly dir: string;
  readonly lockPath: string;
  readonly operationPath: string;
  readonly generationPath: string;
  readonly sessionEpochPath: string;
  readonly acquiredPath: string;
};

function instancePaths(opts: {
  readonly hackDir?: string;
  readonly holder: string;
}): InstancePaths {
  const dir = join(
    opts.hackDir ?? resolveGlobalHackDir(),
    "shared-helpers",
    ".instances"
  );
  return {
    dir,
    lockPath: join(dir, `${opts.holder}.lock`),
    operationPath: join(dir, `${opts.holder}.operation`),
    generationPath: join(dir, `${opts.holder}.shutdown-generation`),
    sessionEpochPath: join(dir, `${opts.holder}.session-epoch`),
    acquiredPath: join(dir, `${opts.holder}.acquired.json`),
  };
}

async function withInstanceLock<T>(opts: {
  readonly instance: InstancePaths;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly run: () => Promise<T>;
}): Promise<T> {
  return await withProjectsRegistryLock({
    lockPath: opts.instance.lockPath,
    label: "shared helper instance",
    timeoutMs: opts.timeoutMs,
    ...(opts.signal ? { signal: opts.signal } : {}),
    run: opts.run,
  });
}

async function readOperation(instance: InstancePaths): Promise<string | null> {
  try {
    return (await readFile(instance.operationPath, "utf8")).trim();
  } catch {
    return null;
  }
}

/** Outcome of {@link SharedHelperSessionOwnership.runIfOwned}. */
export type ProcessCleanupOutcome =
  /** The cleanup ran. */
  | "ran"
  /** Another operation adopted (or replaced) the session since: kept. */
  | "adopted"
  /** The instance lock was unavailable, so ownership is unknown: kept. */
  | "undecidable";

/**
 * Lifecycle-session ownership for one operation of an instance with shared
 * helpers.
 *
 * The lifecycle session keeps its creator's ownership token when another
 * `hack up` adopts it, so the token alone cannot tell the creator whether the
 * session is still only its own. Each session decision is recorded instead:
 * under the instance lock, adopting writes a fresh session epoch, and
 * creating writes one that the creator remembers. The creator's cleanup kills
 * the session only while the epoch is still the one it wrote, checked under
 * the same lock, so no adoption can slip between the check and the kill and
 * no creation can overwrite an adoption's record. This is independent of the
 * order in which operations ensured their helpers.
 */
export type SharedHelperSessionOwnership = {
  /** Run a session decision or creation under the instance lock. */
  readonly withLock: <T>(run: () => Promise<T>) => Promise<T>;
  /** Record a decision; call inside {@link withLock}. */
  readonly record: (kind: "adopted" | "created") => Promise<void>;
  /** Run this operation's session cleanup only while it still owns the session. */
  readonly runIfOwned: (
    cleanup: () => Promise<void>
  ) => Promise<ProcessCleanupOutcome>;
};

export function createSharedHelperSessionOwnership(opts: {
  readonly composeProject: string;
  readonly hackDir?: string;
  /** Lock wait for a session decision; another start may hold it while ensuring helpers. */
  readonly decisionTimeoutMs: number;
}): SharedHelperSessionOwnership {
  const holder = resolveSharedHelperHolder(opts.composeProject);
  const instance = instancePaths({ hackDir: opts.hackDir, holder });
  let createdEpoch: string | null = null;
  const readEpoch = async (): Promise<string | null> => {
    try {
      return (await readFile(instance.sessionEpochPath, "utf8")).trim();
    } catch {
      return null;
    }
  };
  return {
    withLock: async (run) => {
      await mkdir(instance.dir, { recursive: true, mode: 0o700 });
      return await withInstanceLock({
        instance,
        timeoutMs: opts.decisionTimeoutMs,
        run,
      });
    },
    record: async (kind) => {
      const epoch = randomUUID();
      await writeFileAtomic(instance.sessionEpochPath, `${epoch}\n`);
      if (kind === "created") {
        createdEpoch = epoch;
      }
    },
    runIfOwned: async (cleanup) => {
      // Always under the lock, even when this operation never recorded a
      // created session (creation failed before its record): the cleanup
      // reads the session token and kills by name, and a replacement under
      // the lock must not run between the two.
      let decided = false;
      try {
        return await withInstanceLock({
          instance,
          timeoutMs: INSTANCE_LOCK_TIMEOUT_MS,
          run: async (): Promise<ProcessCleanupOutcome> => {
            decided = true;
            if (createdEpoch !== null && (await readEpoch()) !== createdEpoch) {
              return "adopted";
            }
            await cleanup();
            return "ran";
          },
        });
      } catch (error: unknown) {
        if (decided) {
          throw error;
        }
        // The lock was unavailable: ownership cannot be decided. Keep the
        // session (hack down stops it) rather than risk killing an adopted
        // one with the still-valid creator token.
        return "undecidable";
      }
    },
  };
}

/** An instance's shutdown generation, captured when an operation begins. */
export type SharedHelperShutdownGeneration = {
  readonly value: string | null;
};

/**
 * Capture the instance's shutdown generation when an operation begins, before
 * any preparation hook runs. Pass it to {@link startProjectSharedHelpers}: a
 * down that completes while those hooks run then supersedes the operation.
 * The record is replaced atomically, so it is read without the lock.
 */
export async function captureSharedHelperShutdownGeneration(opts: {
  readonly composeProject: string;
  readonly hackDir?: string;
}): Promise<SharedHelperShutdownGeneration> {
  const holder = resolveSharedHelperHolder(opts.composeProject);
  return {
    value: await readGeneration(
      instancePaths({ hackDir: opts.hackDir, holder })
    ),
  };
}

/** The instance's shutdown generation; null until the first `hack down`. */
async function readGeneration(instance: InstancePaths): Promise<string | null> {
  try {
    return (await readFile(instance.generationPath, "utf8")).trim();
  } catch {
    return null;
  }
}

/** Advance the shutdown generation; only `hack down` calls this. */
async function advanceGeneration(instance: InstancePaths): Promise<void> {
  await writeFileAtomic(instance.generationPath, `${randomUUID()}\n`);
}

async function writeOperation(
  instance: InstancePaths,
  operation: string
): Promise<void> {
  await writeFileAtomic(instance.operationPath, `${operation}\n`);
}

async function writeFileAtomic(path: string, text: string): Promise<void> {
  const staging = `${path}.${randomUUID()}.tmp`;
  await writeFile(staging, text, { mode: 0o600 });
  await rename(staging, path);
}

/**
 * Helper identities this instance may hold. A missing file is empty; an
 * unreadable or malformed one throws, so `hack down` fails closed instead of
 * silently forgetting a holder.
 */
async function readAcquired(
  instance: InstancePaths
): Promise<readonly HelperIdentity[]> {
  let text: string;
  try {
    text = await readFile(instance.acquiredPath, "utf8");
  } catch (error: unknown) {
    if (isRecord(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const value: unknown = JSON.parse(text);
  if (
    !Array.isArray(value) ||
    value.length > MAX_ACQUIRED ||
    !value.every(
      (entry: unknown) =>
        isRecord(entry) &&
        Object.keys(entry).length === 2 &&
        typeof entry.name === "string" &&
        NAME.test(entry.name) &&
        typeof entry.port === "number" &&
        Number.isInteger(entry.port) &&
        entry.port >= 1 &&
        entry.port <= 65_535
    )
  ) {
    throw new Error("Invalid shared helper instance record");
  }
  return value as HelperIdentity[];
}

async function writeAcquired(
  instance: InstancePaths,
  identities: readonly HelperIdentity[]
): Promise<void> {
  if (identities.length === 0) {
    await rm(instance.acquiredPath, { force: true });
    return;
  }
  await writeFileAtomic(
    instance.acquiredPath,
    `${JSON.stringify(identities)}\n`
  );
}

function sameIdentity(left: HelperIdentity, right: HelperIdentity): boolean {
  return left.name === right.name && left.port === right.port;
}

function mergeIdentities(
  ...lists: readonly (readonly HelperIdentity[])[]
): HelperIdentity[] {
  const out: HelperIdentity[] = [];
  for (const entry of lists.flat()) {
    if (!out.some((existing) => sameIdentity(existing, entry))) {
      out.push({ name: entry.name, port: entry.port });
    }
  }
  return out;
}

async function recordAcquired(
  instance: InstancePaths,
  identities: readonly HelperIdentity[]
): Promise<void> {
  const current = await readAcquired(instance);
  const merged = mergeIdentities(current, identities);
  if (merged.length > MAX_ACQUIRED) {
    // Never publish a record readAcquired would reject: that would make
    // every later down fail without releasing anything.
    throw new Error(
      `This instance already records ${MAX_ACQUIRED} shared helpers; run hack down to release them before adding another.`
    );
  }
  if (merged.length !== current.length) {
    await writeAcquired(instance, merged);
  }
}

function holderIfValid(composeProject: string): string | null {
  return NAME.test(composeProject) ? composeProject : null;
}

async function instanceHasState(instance: InstancePaths): Promise<boolean> {
  try {
    await stat(instance.acquiredPath);
    return true;
  } catch {
    return (await readOperation(instance)) !== null;
  }
}

/**
 * Mark the instance as stopping before `hack down` stops anything, so a start
 * still in flight fails its {@link startProjectSharedHelpers} `assertCurrent`
 * check instead of launching services whose helpers this down releases.
 * Returns false when the mark could not be written (the down continues; its
 * release still runs under the instance lock).
 */
export async function markSharedHelperInstanceStopping(opts: {
  readonly helpers: readonly ProjectSharedHelperConfig[] | undefined;
  readonly composeProject: string;
  readonly hackDir?: string;
}): Promise<boolean> {
  const holder = holderIfValid(opts.composeProject);
  if (holder === null) {
    return true;
  }
  const instance = instancePaths({ hackDir: opts.hackDir, holder });
  if (
    (opts.helpers ?? []).length === 0 &&
    !(await instanceHasState(instance))
  ) {
    return true;
  }
  try {
    await mkdir(instance.dir, { recursive: true, mode: 0o700 });
    await withInstanceLock({
      instance,
      timeoutMs: INSTANCE_LOCK_TIMEOUT_MS,
      run: async () => {
        await advanceGeneration(instance);
        await writeOperation(instance, `${STOPPING_PREFIX}${randomUUID()}`);
      },
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Release this instance's holder from every helper it may hold: the ones
 * recorded as acquired (so a removed or renamed config entry is still
 * released) plus every configured one, enabled or not. Every helper is
 * attempted; failures are returned, not thrown, and a failed helper stays in
 * the acquired record so the next down retries it.
 */
/**
 * Names of the helpers this instance may still hold: the configured entries
 * plus those in its acquired record (entries removed from config since they
 * were acquired). Read without the lock, for reporting what a down keeps; an
 * unreadable record yields a placeholder name so the caller still fails.
 * Never throws.
 */
export async function listSharedHelpersHeld(opts: {
  readonly helpers: readonly ProjectSharedHelperConfig[] | undefined;
  readonly composeProject: string;
  readonly hackDir?: string;
}): Promise<readonly string[]> {
  const configured = (opts.helpers ?? []).map((helper) => ({
    name: helper.name,
    port: helper.port,
  }));
  const holder = holderIfValid(opts.composeProject);
  if (holder === null) {
    return configured.map((identity) => identity.name);
  }
  const instance = instancePaths({ hackDir: opts.hackDir, holder });
  let recorded: readonly HelperIdentity[];
  try {
    recorded = await readAcquired(instance);
  } catch {
    recorded = [{ name: UNLISTED_HELPERS, port: 0 }];
  }
  return [
    ...new Set(
      mergeIdentities(configured, recorded).map((identity) => identity.name)
    ),
  ];
}

export async function releaseProjectSharedHelpers(opts: {
  readonly helpers: readonly ProjectSharedHelperConfig[] | undefined;
  readonly composeProject: string;
  readonly hackDir?: string;
}): Promise<readonly SharedHelperRelease[]> {
  const helpers = opts.helpers ?? [];
  const holder = holderIfValid(opts.composeProject);
  if (holder === null) {
    if (helpers.length > 0) {
      // Throws the same explicit refusal start uses.
      resolveSharedHelperHolder(opts.composeProject);
    }
    return [];
  }
  const instance = instancePaths({ hackDir: opts.hackDir, holder });
  if (helpers.length === 0 && !(await instanceHasState(instance))) {
    return [];
  }
  const failedAll = (
    identities: readonly HelperIdentity[],
    reason: "lock-unavailable" | "state-unavailable"
  ): SharedHelperRelease[] =>
    (identities.length > 0
      ? identities
      : [{ name: UNLISTED_HELPERS, port: 0 }]
    ).map((identity) => ({
      name: identity.name,
      result: {
        state: "failed",
        reason,
        message: sharedHostFailureMessage(reason),
      },
    }));
  const configured = helpers.map((helper) => ({
    name: helper.name,
    port: helper.port,
  }));
  // The instance lock serializes this release with a start of the same
  // instance, so up and down can never split the instance's helper set (up
  // holding one helper while down stops another). Clearing the operation
  // record also keeps an earlier start's rollback from acting after this.
  try {
    await mkdir(instance.dir, { recursive: true, mode: 0o700 });
    return await withInstanceLock({
      instance,
      timeoutMs:
        helpers.reduce((sum, helper) => sum + helper.readyTimeoutMs, 0) +
        INSTANCE_LOCK_TIMEOUT_MS,
      run: async () => {
        let recorded: readonly HelperIdentity[];
        try {
          recorded = await readAcquired(instance);
        } catch {
          return failedAll(configured, "state-unavailable");
        }
        await advanceGeneration(instance);
        await rm(instance.operationPath, { force: true });
        const targets = mergeIdentities(configured, recorded).reverse();
        const releases = await releaseSpecs({
          specs: targets.map((identity) => ({
            name: identity.name,
            stateDir: resolveSharedHelperStateDir({
              ...(opts.hackDir ? { hackDir: opts.hackDir } : {}),
              name: identity.name,
              port: identity.port,
            }),
          })),
          holder,
        });
        await writeAcquired(
          instance,
          targets.filter((_, index) => {
            const release = releases[index];
            return (
              release !== undefined && isSharedHelperReleaseProblem(release)
            );
          })
        );
        return releases;
      },
    });
  } catch {
    return failedAll(configured, "lock-unavailable");
  }
}

async function releaseSpecs(opts: {
  readonly specs: readonly Pick<SharedHostHelperSpec, "name" | "stateDir">[];
  readonly holder: string;
}): Promise<readonly SharedHelperRelease[]> {
  const out: SharedHelperRelease[] = [];
  for (const spec of opts.specs) {
    out.push({
      name: spec.name,
      result: await releaseSharedHostHelper({ spec, holder: opts.holder }),
    });
  }
  return out;
}

/** True when a release left a helper or its claim in a state that needs an operator. */
export function isSharedHelperReleaseProblem(
  release: SharedHelperRelease
): boolean {
  return (
    release.result.state === "failed" ||
    release.result.state === "stop-unconfirmed"
  );
}

/** One value-free line for a release outcome. */
export function describeSharedHelperRelease(
  release: SharedHelperRelease
): string {
  const result = release.result;
  if (result.state === "failed") {
    return `Shared helper "${release.name}" was not released (${result.reason}): ${result.message}`;
  }
  switch (result.state) {
    case "absent":
      return `Shared helper "${release.name}": no claim to release.`;
    case "retained":
      return `Shared helper "${release.name}" left running for its other holders.`;
    case "released-adopted":
      return `Shared helper "${release.name}" released; it was adopted, so Hack left it running.`;
    case "stale-cleared":
      return `Shared helper "${release.name}": stale claim cleared; nothing was signalled.`;
    case "stopped":
      return `Shared helper "${release.name}" stopped.`;
    default:
      return `Shared helper "${release.name}" did not confirm its stop; its claim was kept for inspection.`;
  }
}

/** One value-free line for a ready or disabled start. */
export function describeSharedHelperStart(
  record: SharedHelperStartRecord
): string {
  const result = record.result;
  if (result.state === "disabled") {
    return `Shared helper "${record.name}" is disabled; not started.`;
  }
  if (result.state === "failed") {
    return `Shared helper "${record.name}" failed (${result.reason}): ${result.message}`;
  }
  let how = "reused";
  if (result.ownership === "adopted") {
    how = "adopted (identity verified; Hack will not stop it)";
  } else if (result.spawned) {
    how = "started";
  }
  return `Shared helper "${record.name}" ${how} at ${result.endpoint}.`;
}

/**
 * Run `run` with an AbortSignal that SIGINT/SIGTERM trips. The handlers stay
 * installed until `run` settles. If a signal was caught, `onSignalled` then
 * runs (the caller's cleanup for whatever `run` started), the handlers are
 * removed and the signal is re-raised, so the process still ends the way the
 * sender asked.
 */
export async function withTerminationAbort<T>(
  run: (signal: AbortSignal) => Promise<T>,
  opts: { readonly onSignalled?: () => Promise<void> } = {}
): Promise<T> {
  const controller = new AbortController();
  let caught: NodeJS.Signals | null = null;
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const name of ["SIGINT", "SIGTERM"] as const) {
    const handler = (): void => {
      caught ??= name;
      controller.abort();
    };
    handlers.set(name, handler);
    process.on(name, handler);
  }
  try {
    return await run(controller.signal);
  } finally {
    if (caught !== null) {
      await opts.onSignalled?.().catch(() => undefined);
    }
    for (const [name, handler] of handlers) {
      process.off(name, handler);
    }
    if (caught !== null) {
      process.kill(process.pid, caught);
    }
  }
}
