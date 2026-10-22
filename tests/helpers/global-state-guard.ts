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
    if (
      !sameListeners(
        before.listeners.get(event) ?? [],
        current.listeners.get(event) ?? []
      )
    ) {
      changes.push(`process '${event}' listeners changed`);
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

function restoreEnvObject(snapshot: GlobalStateSnapshot): void {
  if (process.env !== snapshot.envObject) {
    process.env = snapshot.envObject;
  }
  const env = process.env;
  for (const key of Object.keys(env)) {
    if (!Object.hasOwn(snapshot.env, key)) {
      Reflect.deleteProperty(env, key);
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
