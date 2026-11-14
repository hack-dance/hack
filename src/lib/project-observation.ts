import type { ProjectView } from "./project-views.ts";
import type { RuntimeContainer } from "./runtime-projects.ts";

/** Shared vocabulary for the desktop listing; unknown evidence is never a stopped claim. */
export type ObservedProjectState =
  | "running"
  | "degraded"
  | "starting"
  | "stopping"
  | "stopped"
  | "failed"
  | "unknown";

export type ObservedService = {
  readonly name: string;
  readonly state: ObservedProjectState;
  readonly ready: boolean | null;
  readonly completed: boolean | null;
  readonly health: string | null;
  readonly exit_code: number | null;
  readonly started_at: string | null;
};

export type ProjectObservation = {
  readonly backend: "compose" | "native" | "unknown";
  readonly state: ObservedProjectState;
  readonly state_reason:
    | "native-observer-required"
    | "observation-unavailable"
    | null;
  readonly started_at: string | null;
  readonly services: readonly ObservedService[];
};

/**
 * Read-only listing projection. Docker's listing does not carry authenticated
 * exit codes, readiness roles or start times: retain null until the R2 owner
 * supplies them. Native inputs need their own observer, never Docker inference.
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
  const services: ObservedService[] = [...names].sort().map((name) => ({
    name,
    state: observable
      ? serviceState(view.runtime?.services.get(name)?.containers ?? [])
      : "unknown",
    ready: null,
    completed: null,
    health: null,
    exit_code: null,
    started_at: null,
  }));
  return {
    backend,
    state: observable ? projectState(services) : "unknown",
    state_reason: reason,
    started_at: null,
    services,
  };
}

function serviceState(
  containers: readonly RuntimeContainer[]
): ObservedProjectState {
  if (containers.length === 0) {
    return "stopped";
  }
  if (containers.every((container) => container.state === "running")) {
    return "running";
  }
  if (containers.some((container) => container.state === "running")) {
    return "degraded";
  }
  if (containers.some((container) => container.state === "restarting")) {
    return "starting";
  }
  if (containers.every((container) => container.state === "created")) {
    return "stopped";
  }
  return "unknown";
}

function projectState(
  services: readonly ObservedService[]
): ObservedProjectState {
  if (services.length === 0) {
    return "unknown";
  }
  if (services.every((service) => service.state === "running")) {
    return "running";
  }
  if (services.some((service) => service.state === "unknown")) {
    return "unknown";
  }
  if (services.some((service) => service.state === "running")) {
    return "degraded";
  }
  if (services.some((service) => service.state === "starting")) {
    return "starting";
  }
  return "stopped";
}
