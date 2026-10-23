/**
 * Snapshot, compare and restore the process-global state that Bun shares
 * between every test file in one `bun test` run.
 *
 * Bun runs all files in one process. A test that changes `PATH`, `HOME`,
 * `HACK_HOME`, the working directory or another process global and then fails
 * before its own restore leaks that change into every later file. Those files
 * then fail for unrelated reasons (for example "Executable not found in $PATH:
 * git"), which hides the first, real failure. The preload in
 * `tests/helpers/global-state-guard-preload.ts` uses this module to name the
 * file that leaked and to put the environment and working directory back so
 * later files run clean.
 *
 * Reports name keys and kinds only. They never include environment values,
 * because fixtures may hold secret-shaped values.
 */

/** Process events whose listener lists are compared (reported, not restored). */
export const GUARDED_PROCESS_EVENTS = [
  "SIGINT",
  "SIGTERM",
  "SIGHUP",
  "SIGQUIT",
  "SIGUSR1",
  "SIGUSR2",
  "exit",
  "beforeExit",
  "uncaughtException",
  "unhandledRejection",
] as const;

type GuardedProcessEvent = (typeof GUARDED_PROCESS_EVENTS)[number];
type Listener = (...args: unknown[]) => void;

interface GlobalBinding {
  readonly name: string;
  readonly owner: object;
  readonly key: PropertyKey;
}

/**
 * Globals that tests replace with fakes. Each entry is compared by identity and
 * written back on restore.
 */
const GUARDED_BINDINGS: readonly GlobalBinding[] = [
  { name: "globalThis.fetch", owner: globalThis, key: "fetch" },
  { name: "globalThis.setTimeout", owner: globalThis, key: "setTimeout" },
  { name: "globalThis.clearTimeout", owner: globalThis, key: "clearTimeout" },
  { name: "globalThis.setInterval", owner: globalThis, key: "setInterval" },
  { name: "globalThis.clearInterval", owner: globalThis, key: "clearInterval" },
  { name: "globalThis.Date", owner: globalThis, key: "Date" },
  { name: "Bun.spawn", owner: Bun, key: "spawn" },
  { name: "Bun.spawnSync", owner: Bun, key: "spawnSync" },
  { name: "Bun.which", owner: Bun, key: "which" },
  { name: "process.exit", owner: process, key: "exit" },
  { name: "process.kill", owner: process, key: "kill" },
];

/** The guarded state; {@link restoreGlobalState} puts back its process data. */
export interface GlobalStateSnapshot {
  readonly cwd: string;
  readonly umask: number;
  /** `process.exitCode`, with unset read as 0: Bun ignores assigning `undefined`. */
  readonly exitCode: NonNullable<typeof process.exitCode>;
  readonly envObject: NodeJS.ProcessEnv;
  readonly env: Readonly<Record<string, string>>;
  readonly listeners: ReadonlyMap<GuardedProcessEvent, readonly Listener[]>;
  readonly bindings: ReadonlyMap<string, PropertyDescriptor | undefined>;
  readonly platform: PropertyDescriptor | undefined;
}

function readUmask(): number {
  // process.umask() with no argument reads the mask without changing it.
  return process.umask();
}

function copyEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const copy: Record<string, string> = {};
  for (const key of Object.keys(env)) {
    const value = env[key];
    if (value !== undefined) {
      copy[key] = value;
    }
  }
  return copy;
}

/** Captures the guarded process state. Cheap enough to run around every test. */
export function captureGlobalState(): GlobalStateSnapshot {
  const listeners = new Map<GuardedProcessEvent, readonly Listener[]>();
  for (const event of GUARDED_PROCESS_EVENTS) {
    listeners.set(event, process.listeners(event) as Listener[]);
  }
  const bindings = new Map<string, PropertyDescriptor | undefined>();
  for (const binding of GUARDED_BINDINGS) {
    bindings.set(
      binding.name,
      Object.getOwnPropertyDescriptor(binding.owner, binding.key)
    );
  }
  return {
    cwd: process.cwd(),
    umask: readUmask(),
    exitCode: process.exitCode ?? 0,
    envObject: process.env,
    env: copyEnv(process.env),
    listeners,
    bindings,
    platform: Object.getOwnPropertyDescriptor(process, "platform"),
  };
}

function sameDescriptor(
  left: PropertyDescriptor | undefined,
  right: PropertyDescriptor | undefined
): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  return (
    left.value === right.value &&
    left.get === right.get &&
    left.set === right.set &&
    left.writable === right.writable
  );
}

function sameListeners(
  left: readonly Listener[],
  right: readonly Listener[]
): boolean {
  return (
    left.length === right.length &&
    left.every((listener, index) => listener === right[index])
  );
}

/** Options for {@link diffGlobalState}. */
export interface DiffGlobalStateOptions {
  /** Environment keys that may differ, each with the reason it may. */
  readonly allowedEnvChanges?: ReadonlyMap<string, string>;
}

function diffProcessData(
  before: GlobalStateSnapshot,
  current: GlobalStateSnapshot
): string[] {
  const changes: string[] = [];
  if (current.cwd !== before.cwd) {
    changes.push("cwd changed");
  }
  if (current.umask !== before.umask) {
    changes.push("umask changed");
  }
  if (current.exitCode !== before.exitCode) {
    changes.push("process.exitCode changed");
  }
  if (current.envObject !== before.envObject) {
    changes.push("process.env object replaced");
  }
  return changes;
}

function envChange(
  was: string | undefined,
  now: string | undefined
): string | undefined {
  if (was === now) {
    return;
  }
  if (was === undefined) {
    return "added";
  }
  return now === undefined ? "removed" : "changed";
}

function diffEnv(
  before: GlobalStateSnapshot,
  current: GlobalStateSnapshot,
  allowed: ReadonlyMap<string, string> | undefined
): string[] {
  const keys = new Set([
    ...Object.keys(before.env),
    ...Object.keys(current.env),
  ]);
  const changes: string[] = [];
  for (const key of [...keys].sort()) {
    const change = allowed?.has(key)
      ? undefined
      : envChange(before.env[key], current.env[key]);
    if (change !== undefined) {
      changes.push(`env ${key} ${change}`);
    }
  }
  return changes;
}

function diffProcessHooks(
  before: GlobalStateSnapshot,
  current: GlobalStateSnapshot
): string[] {
  const changes: string[] = [];
  for (const event of GUARDED_PROCESS_EVENTS) {
    const was = before.listeners.get(event) ?? [];
    const now = current.listeners.get(event) ?? [];
    if (!sameListeners(was, now)) {
      // The counts tell a listener left behind (n -> n+1) from one consumed
      // here that an earlier file left behind (n+1 -> n): a `once` listener
      // removes itself when the test emits that signal.
      changes.push(
        `process '${event}' listeners changed (${was.length} -> ${now.length})`
      );
    }
  }
  for (const binding of GUARDED_BINDINGS) {
    if (
      !sameDescriptor(
        before.bindings.get(binding.name),
        current.bindings.get(binding.name)
      )
    ) {
      changes.push(`${binding.name} replaced`);
    }
  }
  if (!sameDescriptor(before.platform, current.platform)) {
    changes.push("process.platform replaced");
  }
  return changes;
}

/**
 * Lists how `current` differs from `before`, as value-free lines such as
 * `env PATH changed` or `cwd changed`. An empty list means no leak.
 */
export function diffGlobalState(
  before: GlobalStateSnapshot,
  current: GlobalStateSnapshot = captureGlobalState(),
  opts: DiffGlobalStateOptions = {}
): string[] {
  return [
    ...diffProcessData(before, current),
    ...diffEnv(before, current, opts.allowedEnvChanges),
    ...diffProcessHooks(before, current),
  ];
}

/**
 * Removes one key. The empty assignment first clears Bun's own copy of a proxy
 * key, which a delete alone never reaches (see {@link captureNativeEnv}).
 */
function deleteEnvKey(env: NodeJS.ProcessEnv, key: string): void {
  env[key] = "";
  Reflect.deleteProperty(env, key);
}

function restoreEnvObject(snapshot: GlobalStateSnapshot): void {
  if (process.env !== snapshot.envObject) {
    process.env = snapshot.envObject;
  }
  const env = process.env;
  for (const key of Object.keys(env)) {
    if (!Object.hasOwn(snapshot.env, key)) {
      deleteEnvKey(env, key);
    }
  }
  for (const [key, value] of Object.entries(snapshot.env)) {
    if (env[key] !== value) {
      env[key] = value;
    }
  }
}

/**
 * Puts the process data back to `snapshot`: the environment, working
 * directory, umask and `process.exitCode`. The original `process.env` object
 * is reinstated and edited in place, so `Bun.env` and child-process defaults
 * keep seeing the same environment.
 *
 * Replaced functions (`Bun.spawn`, `process.kill`, `fetch`, timers), process
 * listeners and `process.platform` are reported by {@link diffGlobalState}
 * but deliberately not restored. A leak there usually comes from a test that
 * timed out while its work is still running, and that fake is what keeps the
 * leftover work away from real processes, signals, the network and the
 * Docker socket. Restoring the real function under that work could let it
 * reach the host.
 */
export function restoreGlobalState(snapshot: GlobalStateSnapshot): void {
  restoreEnvObject(snapshot);
  if (process.cwd() !== snapshot.cwd) {
    process.chdir(snapshot.cwd);
  }
  if (readUmask() !== snapshot.umask) {
    process.umask(snapshot.umask);
  }
  process.exitCode = snapshot.exitCode;
}

/**
 * The environment Bun itself uses for `fetch` proxies and for `Bun.spawn`
 * without an `env` option, as key to value.
 */
export type NativeEnv = ReadonlyMap<string, string>;

// Bound at load so a leaked `Bun.spawnSync` fake can never answer for Bun.
const realSpawnSync = Bun.spawnSync.bind(Bun);

/**
 * Reads Bun's native environment by running `/usr/bin/env -0` without an
 * `env` option, or returns undefined when that is not possible.
 *
 * `process.env` does not show all of it. Bun 1.4 starts this environment
 * from the startup environment and copies later assignments to the proxy
 * keys (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` and their lower-case forms)
 * into it, but a delete never reaches it. A test that sets a proxy and then
 * deletes it leaves `process.env` looking clean while every later `fetch` in
 * the process, loopback included, still goes through that proxy (HACK-1327).
 * `restoreEnv` in `tests/helpers/env.ts` avoids this by assigning "" first.
 * Other keys never change here: Bun does not copy assignments to them.
 * Costs one short child process; the preload runs it once per test file.
 */
export function captureNativeEnv(): NativeEnv | undefined {
  try {
    const child = realSpawnSync(["/usr/bin/env", "-0"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    if (child.exitCode !== 0 || !child.stdout) {
      return;
    }
    const env = new Map<string, string>();
    for (const entry of child.stdout.toString().split("\0")) {
      const separator = entry.indexOf("=");
      if (separator > 0) {
        env.set(entry.slice(0, separator), entry.slice(separator + 1));
      }
    }
    return env;
  } catch {
    return;
  }
}

/** An empty value and an absent key mean the same to Bun: no proxy. */
function nativeValue(env: NativeEnv, key: string): string | undefined {
  const value = env.get(key);
  return value === "" ? undefined : value;
}

/**
 * Lists the keys whose native value differs from `before`, sorted. An empty
 * value and an absent key compare equal. Never includes values.
 */
export function diffNativeEnv(before: NativeEnv, current: NativeEnv): string[] {
  const keys = new Set([...before.keys(), ...current.keys()]);
  return [...keys]
    .filter((key) => nativeValue(before, key) !== nativeValue(current, key))
    .sort();
}

const NO_PROXY_KEYS = ["NO_PROXY", "no_proxy"] as const;

/**
 * Turns proxies off in Bun's native environment for the rest of the process,
 * and leaves `process.env` as `snapshot` had it.
 *
 * A stale native key cannot be put back: once a key is deleted from
 * `process.env`, Bun 1.4 ignores every later assignment to it as well. The
 * only repair left is `NO_PROXY=*`: it is assigned (Bun copies it) and deleted
 * again (Bun keeps the copy), so later `fetch` calls go direct while
 * `process.env` is unchanged. Children spawned without `env` still inherit
 * the stale proxy key next to `NO_PROXY=*`. If a no-proxy key was itself
 * deleted earlier, Bun ignores this too; the next file check then reports it
 * again.
 */
export function disableNativeProxies(snapshot: GlobalStateSnapshot): void {
  const env = process.env;
  for (const key of NO_PROXY_KEYS) {
    env[key] = "*";
    Reflect.deleteProperty(env, key);
    const value = snapshot.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
}
