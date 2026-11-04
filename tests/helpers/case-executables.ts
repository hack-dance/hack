/**
 * Pins executable names to absolute paths for one test case, so a body that
 * outlives its case cannot find the host's `docker` through `PATH`
 * (HACK-1792).
 *
 * A test that puts a stub `docker` on `PATH` and then times out keeps running
 * after Bun's `afterEach`. The global-state guard (or the file's own
 * `afterEach`) puts the pre-test `PATH` back while that body still runs, so a
 * later `findExecutableInPath("docker")` in the body would resolve the host's
 * real Docker client. A pin is resolved when the case starts and lives in the
 * case's `AsyncLocalStorage` context, which a late body keeps: its
 * `Bun.which("docker")` keeps answering the stub whatever `PATH` says by then.
 * Code outside the case (later cases, later files) never sees the pin.
 *
 * Only `Bun.which` consults pins. That covers `findExecutableInPath` in
 * `src/lib/shell.ts` and so the native Compose probes. A bare
 * `Bun.spawn(["docker", ...])` resolves through `PATH` in native code and is
 * not covered; a case that uses one still needs its own containment.
 *
 * `tests/helpers/global-state-guard-preload.ts` installs the wrapper before
 * the guard takes its first baseline, so the wrapper is part of the baseline
 * and never reported as a replaced `Bun.which`. Without that preload, the
 * first {@link withCaseExecutables} installs it.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { isAbsolute } from "node:path";

/** A `null` pin answers "not found" without consulting PATH. */
type Pins = ReadonlyMap<string, string | null>;

const STATE = Symbol.for("hack.tests.caseExecutables");

/** One wrapper and one context store per process, even across module copies. */
function state(): { pins: AsyncLocalStorage<Pins>; installed: boolean } {
  const host = globalThis as unknown as Record<
    symbol,
    { pins: AsyncLocalStorage<Pins>; installed: boolean } | undefined
  >;
  let value = host[STATE];
  if (value === undefined) {
    value = { pins: new AsyncLocalStorage<Pins>(), installed: false };
    host[STATE] = value;
  }
  return value;
}

/**
 * The name `Bun.which` looks up, as a string. Bun 1.4.4 also accepts a
 * `String` object and a `Buffer`, so a pin must match those forms too, or a
 * pinned case could still reach the host binary through them. Any other
 * argument inside a pinned scope is refused rather than passed through.
 */
function lookupName(command: unknown): string {
  if (typeof command === "string") {
    return command;
  }
  if (command instanceof String) {
    return command.valueOf();
  }
  if (ArrayBuffer.isView(command)) {
    return new TextDecoder().decode(command);
  }
  throw new TypeError(
    "Bun.which inside a pinned case needs a string, String or byte name."
  );
}

/** Wraps `Bun.which` once per process so it answers the current case's pins. */
export function installCaseExecutables(): void {
  const current = state();
  if (current.installed) {
    return;
  }
  const original = Bun.which;
  const pins = current.pins;
  Bun.which = function which(
    this: unknown,
    ...args: Parameters<typeof Bun.which>
  ) {
    const store = pins.getStore();
    if (store !== undefined) {
      const name = lookupName(args[0]);
      if (store.has(name)) {
        return store.get(name) ?? null;
      }
    }
    return Reflect.apply(original, this, args);
  } as typeof Bun.which;
  current.installed = true;
}

/**
 * Runs `body` with `executables` (bare name to absolute path) pinned for
 * `Bun.which`. A `null` path pins the name as missing, so a case can exercise
 * a failed lookup without a late body finding the host's binary on PATH. Call it at the start of the case body, with paths resolved
 * then. The pins stay with every async continuation of `body`, including one
 * that outlives the case, and with nothing else. A nested call keeps the
 * outer pins and overrides only the names it gives.
 */
export function withCaseExecutables<T>(
  executables: Readonly<Record<string, string | null>>,
  body: () => T
): T {
  const pins = new Map<string, string | null>(state().pins.getStore());
  for (const [name, path] of Object.entries(executables)) {
    if (
      name.length === 0 ||
      name.includes("/") ||
      !(path === null || isAbsolute(path))
    ) {
      throw new Error(
        "withCaseExecutables needs bare executable names and absolute paths or null."
      );
    }
    pins.set(name, path);
  }
  installCaseExecutables();
  return state().pins.run(pins, body);
}
