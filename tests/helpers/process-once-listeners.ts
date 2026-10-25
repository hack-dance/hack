/**
 * Remembers which process listeners were added with `once`, so test helpers
 * that take listeners off `process` and put them back can keep a `once`
 * listener a `once` listener.
 *
 * Bun does not expose this: `process.listeners()` and `process.rawListeners()`
 * both return the original function, with no `once` wrapper. The registry
 * wraps the registration methods of `process` instead. `once` and
 * `prependOnceListener` mark the function for that event; `on`,
 * `addListener` and `prependListener` clear the mark, so the most recent
 * registration kind wins. A function registered for one event both ways at
 * once is read as the kind it was registered with last.
 *
 * `tests/helpers/global-state-guard-preload.ts` installs the registry before
 * any test file loads. Without that preload (for example `packages/db`), it
 * installs when a helper first needs it and does not know about `once`
 * listeners added before then; those come back as persistent listeners.
 */

type ProcessEvent = string | symbol;
type Listener = (...args: unknown[]) => void;
type Registration = (event: ProcessEvent, listener: Listener) => unknown;

const INSTALLED = Symbol.for("hack.tests.processOnceListeners");
const marks = new Map<ProcessEvent, WeakSet<Listener>>();

function mark(event: ProcessEvent, listener: Listener): void {
  let listeners = marks.get(event);
  if (!listeners) {
    listeners = new WeakSet();
    marks.set(event, listeners);
  }
  listeners.add(listener);
}

function wrap(name: string, once: boolean): void {
  const target = process as unknown as Record<string, Registration>;
  const original = target[name];
  if (typeof original !== "function") {
    return;
  }
  target[name] = function register(
    this: unknown,
    event: ProcessEvent,
    listener: Listener
  ) {
    if (!once) {
      marks.get(event)?.delete(listener);
    }
    const result = Reflect.apply(original, this, [event, listener]);
    if (once) {
      mark(event, listener);
    }
    return result;
  };
}

/** Wraps the registration methods of `process` once per process. */
export function installProcessOnceListeners(): void {
  const host = process as unknown as Record<symbol, boolean>;
  if (host[INSTALLED]) {
    return;
  }
  host[INSTALLED] = true;
  wrap("once", true);
  wrap("prependOnceListener", true);
  wrap("on", false);
  wrap("addListener", false);
  wrap("prependListener", false);
}

/** Whether `listener` was last registered for `event` with `once`. */
export function isProcessOnceListener(
  event: ProcessEvent,
  listener: Listener
): boolean {
  return marks.get(event)?.has(listener) ?? false;
}

/** Adds `listener` back for `event` with the registration kind it had. */
export function addProcessListener(
  event: ProcessEvent,
  listener: Listener,
  once: boolean
): void {
  if (once) {
    process.once(event as NodeJS.Signals, listener);
  } else {
    process.on(event as NodeJS.Signals, listener);
  }
}

installProcessOnceListeners();
