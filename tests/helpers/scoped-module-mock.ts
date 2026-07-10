import { mock } from "bun:test";
import { dirname } from "node:path";

type ModuleExports = Record<string, unknown>;

interface OverrideRegistration {
  readonly overrides: ModuleExports;
  active: boolean;
}

interface ModuleMockState {
  /** Snapshot of the real module's export values, captured before any mock is installed. */
  readonly real: ModuleExports;
  /** All override sets registered for this module, in registration order. */
  readonly registrations: OverrideRegistration[];
  /** Cached dispatching wrappers so export identity stays stable across re-installs. */
  readonly wrappers: Map<string, unknown>;
}

const statesByResolvedPath = new Map<string, ModuleMockState>();

export interface ScopedModuleMock {
  /** Enables this file's overrides. Call from beforeAll in the owning test file. */
  readonly activate: () => void;
  /** Disables this file's overrides so other test files see the real module. Call from afterAll. */
  readonly deactivate: () => void;
}

/**
 * Installs a test-scoped module mock that is safe to use when many test files
 * share one process (plain `bun test` evaluates every test file before running
 * any tests, so a bare `mock.module(...)` at file scope leaks into every other
 * file in the run).
 *
 * The module's exports are replaced with dispatching wrappers: while this
 * file's mock is active (between activate/deactivate) overridden exports route
 * to the provided overrides; at all other times, and for exports that are not
 * overridden, calls fall through to the real implementation. Multiple test
 * files may register overrides for the same module; the most recently
 * activated registration wins for the keys it overrides.
 *
 * @param opts.importerPath - Pass `import.meta.path` so relative specifiers resolve like a plain import from the test file.
 * @param opts.specifier - The module specifier exactly as the test file would import it.
 * @param opts.overrides - Export names mapped to their mock implementations (functions or objects).
 * @returns Activation controls; wire them to beforeAll/afterAll in the owning test file.
 */
export async function registerScopedModuleMock(opts: {
  readonly importerPath: string;
  readonly specifier: string;
  readonly overrides: ModuleExports;
}): Promise<ScopedModuleMock> {
  const resolvedPath = opts.specifier.startsWith("node:")
    ? opts.specifier
    : Bun.resolveSync(opts.specifier, dirname(opts.importerPath));

  let state = statesByResolvedPath.get(resolvedPath);
  if (!state) {
    const namespace = (await import(resolvedPath)) as ModuleExports;
    state = {
      real: captureExportValues(namespace),
      registrations: [],
      wrappers: new Map(),
    };
    statesByResolvedPath.set(resolvedPath, state);
  }

  const registration: OverrideRegistration = {
    overrides: opts.overrides,
    active: false,
  };
  state.registrations.push(registration);
  installModuleMock({ resolvedPath, state });

  return {
    activate: () => {
      registration.active = true;
    },
    deactivate: () => {
      registration.active = false;
    },
  };
}

/**
 * Copies the current export values out of a module namespace so later
 * `mock.module` live-binding patches cannot rewrite the captured originals.
 */
function captureExportValues(namespace: ModuleExports): ModuleExports {
  const captured: ModuleExports = {};
  for (const key of Object.keys(namespace)) {
    captured[key] = namespace[key];
  }
  return captured;
}

/**
 * (Re)installs the dispatching module mock covering every export of the real
 * module plus every override key registered so far.
 */
function installModuleMock(opts: {
  readonly resolvedPath: string;
  readonly state: ModuleMockState;
}): void {
  const { resolvedPath, state } = opts;
  const overriddenKeys = new Set<string>();
  for (const registration of state.registrations) {
    for (const key of Object.keys(registration.overrides)) {
      overriddenKeys.add(key);
    }
  }

  const moduleExports: ModuleExports = {};
  for (const key of Object.keys(state.real)) {
    moduleExports[key] = state.real[key];
  }
  for (const key of overriddenKeys) {
    moduleExports[key] = getOrCreateWrapper({ state, key });
  }

  mock.module(resolvedPath, () => moduleExports);
}

/**
 * Resolves the export value that should currently serve `key`: the most
 * recently registered active override that defines it, else the real export.
 */
function resolveExport(opts: {
  readonly state: ModuleMockState;
  readonly key: string;
}): unknown {
  const { state, key } = opts;
  for (let index = state.registrations.length - 1; index >= 0; index -= 1) {
    const registration = state.registrations[index];
    if (registration?.active && key in registration.overrides) {
      return registration.overrides[key];
    }
  }
  return state.real[key];
}

/**
 * Builds (or reuses) a wrapper for an overridden export that re-resolves its
 * target on every call/property access, so activation state applies at use
 * time instead of import time.
 */
function getOrCreateWrapper(opts: {
  readonly state: ModuleMockState;
  readonly key: string;
}): unknown {
  const { state, key } = opts;
  const cached = state.wrappers.get(key);
  if (cached !== undefined) {
    return cached;
  }

  const sample =
    state.real[key] ??
    state.registrations.find((registration) => key in registration.overrides)
      ?.overrides[key];

  let wrapper: unknown;
  if (typeof sample === "function") {
    wrapper = function dispatchingExport(
      this: unknown,
      ...args: unknown[]
    ): unknown {
      const target = resolveExport({ state, key });
      if (typeof target !== "function") {
        throw new TypeError(
          `Scoped module mock: export "${key}" is not callable`
        );
      }
      if (new.target) {
        return Reflect.construct(
          target as unknown as new (
            ...ctorArgs: unknown[]
          ) => unknown,
          args
        );
      }
      return Reflect.apply(
        target as (...fnArgs: unknown[]) => unknown,
        this,
        args
      );
    };
  } else if (typeof sample === "object" && sample !== null) {
    wrapper = new Proxy(sample as object, {
      get: (_target, property) =>
        Reflect.get(resolveExport({ state, key }) as object, property),
      has: (_target, property) =>
        Reflect.has(resolveExport({ state, key }) as object, property),
    });
  } else {
    wrapper = state.real[key];
  }

  state.wrappers.set(key, wrapper);
  return wrapper;
}
