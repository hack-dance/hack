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

/** Optional live native reads. The default observe-only CLI never calls this boundary. */
export async function observeNativeProject(opts: {
  readonly view: ProjectView;
  readonly ps?: typeof nativeProjectPs;
  readonly authoredPs?: typeof nativeAuthoredProjectPs;
}): Promise<ProjectObservation> {
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
