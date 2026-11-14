import { requiredObservedServices } from "./compose-service-activation.ts";
import {
  earliestStart,
  observedProjectState,
  observeService,
  type ProjectState,
  type ServiceObservation,
} from "./project-state.ts";
import type { ProjectView } from "./project-views.ts";
export type ObservedProjectState = ProjectState;
export type ObservedService = ServiceObservation;

export type ProjectObservation = {
  readonly backend: "compose" | "native" | "unknown";
  readonly state: ObservedProjectState;
  readonly state_reason:
    | "native-observer-required"
    | "observation-unavailable"
    | "native-runtime-degraded"
    | null;
  readonly started_at: string | null;
  readonly services: readonly ObservedService[];
};

/**
 * Shared listing projection. Fresh inspect data supplies state details; static
 * cached metadata never supplies current health, exit codes or start time.
 */
export function projectObservation(input: {
  readonly view: ProjectView;
  readonly runtimeOk: boolean;
  readonly nativeSelected: boolean;
}): ProjectObservation {
  const { view } = input;
  const native =
    (input.nativeSelected &&
      view.kind === "registered" &&
      !view.inputDiagnostic) ||
    view.inputDiagnostic?.code === "E_NATIVE_PROJECT_UNSUPPORTED";
  let backend: ProjectObservation["backend"] = "compose";
  if (view.inputDiagnostic || view.status === "missing") {
    backend = "unknown";
  }
  if (native) {
    backend = "native";
  }
  const observable = backend === "compose" && input.runtimeOk;
  let reason: ProjectObservation["state_reason"] = observable
    ? null
    : "observation-unavailable";
  if (native) {
    reason = "native-observer-required";
  }
  const names = new Set([
    ...(view.definedServices ?? []),
    ...(observable ? (view.runtime?.services.keys() ?? []) : []),
  ]);
  const services: ObservedService[] = [...names].sort().map((name) => {
    const containers = view.runtime?.services.get(name)?.containers ?? [];
    return observeService({
      name,
      available: observable,
      readiness: view.serviceReadiness?.[name] ?? null,
      members: containers.map(
        (container) =>
          container.observation ?? {
            state: container.state,
            health: null,
            exitCode: null,
            startedAt: null,
          }
      ),
    });
  });
  const required = requiredObservedServices({
    names: [...names],
    observed: observable ? [...(view.runtime?.services.keys() ?? [])] : [],
    activation: view.serviceActivation,
  });
  const requiredServices = services.filter((service) =>
    required.has(service.name)
  );
  const state =
    requiredServices.length === 0 && services.length > 0
      ? "stopped"
      : observedProjectState(requiredServices);
  return {
    backend,
    state: observable ? state : "unknown",
    state_reason: reason,
    started_at: earliestStart(services.map((service) => service.started_at)),
    services,
  };
}
