import { nativeAuthoredProjectPs } from "../backends/native-authored-project-observe.ts";
import { nativeProjectPs } from "../backends/native-project-observe.ts";
import { resolveNativeRuntimeSelection } from "../backends/native-runtime-client.ts";
import type { ProjectObservation } from "./project-observation.ts";
import {
  earliestStart,
  observedProjectState,
  observeService,
} from "./project-state.ts";
import type { ProjectView } from "./project-views.ts";

type ObserveOptions = {
  readonly view: ProjectView;
  readonly ps?: typeof nativeProjectPs;
  readonly authoredPs?: typeof nativeAuthoredProjectPs;
};

/**
 * Native status reads own subprocesses. The limit is process-wide, not per
 * request, so parallel `/v1/projects` callers cannot multiply the fan-out.
 */
export const NATIVE_OBSERVATION_LIMIT = 4;
let active = 0;
const waiting: (() => void)[] = [];
/** Concurrent reads of the same project share one subprocess and result. */
const inFlight = new WeakMap<
  object,
  Map<string, Promise<ProjectObservation>>
>();

async function withObservationSlot<T>(run: () => Promise<T>): Promise<T> {
  if (active >= NATIVE_OBSERVATION_LIMIT) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  } else {
    active++;
  }
  try {
    return await run();
  } finally {
    const next = waiting.shift();
    if (next) {
      // Hand the slot over directly; `active` is unchanged.
      next();
    } else {
      active--;
    }
  }
}

/** Optional live native reads. The default observe-only CLI never calls this boundary. */
export function observeNativeProject(
  opts: ObserveOptions
): Promise<ProjectObservation> {
  // Share only reads that would run the same reader for the same project.
  const reader: object =
    opts.view.inputDiagnostic?.code === "E_NATIVE_PROJECT_UNSUPPORTED"
      ? (opts.authoredPs ?? nativeAuthoredProjectPs)
      : (opts.ps ?? nativeProjectPs);
  let shared = inFlight.get(reader);
  if (!shared) {
    shared = new Map();
    inFlight.set(reader, shared);
  }
  const key = JSON.stringify([
    opts.view.repoRoot,
    opts.view.projectDir,
    opts.view.inputDiagnostic?.code ?? null,
  ]);
  const existing = shared.get(key);
  if (existing) {
    return existing;
  }
  const pending = withObservationSlot(() => observeOnce(opts)).finally(() =>
    shared.delete(key)
  );
  shared.set(key, pending);
  return pending;
}

async function observeOnce(opts: ObserveOptions): Promise<ProjectObservation> {
  const unknown: ProjectObservation = {
    backend: "native",
    state: "unknown",
    state_reason: "observation-unavailable",
    started_at: null,
    services: [],
  };
  const { view } = opts;
  if (!(view.repoRoot && view.projectDir)) {
    return unknown;
  }
  try {
    const runtime = resolveNativeRuntimeSelection();
    if (!runtime) {
      return unknown;
    }
    const scope = {
      projectRoot: view.repoRoot,
      projectDir: view.projectDir,
      nativeHome: runtime.home,
      branch: null,
    };
    const result =
      view.inputDiagnostic?.code === "E_NATIVE_PROJECT_UNSUPPORTED"
        ? await (opts.authoredPs ?? nativeAuthoredProjectPs)({
            runtime,
            scope,
            includeReadiness: true,
          })
        : await (opts.ps ?? nativeProjectPs)({
            runtime,
            scope,
            includeReadiness: true,
          });
    if (result.status === "not_started" || result.status === "pending") {
      return {
        ...unknown,
        state: result.status === "pending" ? "starting" : "stopped",
        state_reason: null,
      };
    }
    if (result.status === "runtime_degraded") {
      return {
        ...unknown,
        state: "degraded",
        state_reason: "native-runtime-degraded",
      };
    }
    if (result.status !== "observed") {
      return unknown;
    }
    const services = result.items.map((item) =>
      observeService({
        name: item.service,
        available: true,
        readiness: item.readiness ?? null,
        members: [
          {
            state: item.state,
            health: item.health,
            exitCode: item.exitCode,
            startedAt: null,
          },
        ],
      })
    );
    return {
      backend: "native",
      state: observedProjectState(services),
      state_reason: null,
      started_at: earliestStart(services.map((service) => service.started_at)),
      services,
    };
  } catch {
    // Status refusals are missing evidence, never raw provider diagnostics.
    return unknown;
  }
}
