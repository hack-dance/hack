import { HackCliError } from "./cli-result.ts";
import { isRecord } from "./guards.ts";
import type { NativeComposeOwnershipObservation } from "./native-compose-ownership.ts";

type PrivateDocument = Readonly<Record<string, unknown>>;
type ProposedGeneration = {
  readonly generationId: string;
  readonly identity: { readonly composeProject: string };
};
const ON_FAILURE_RESTART = /^on-failure(?::[1-9][0-9]*)?$/;
function invalid(): never {
  throw new HackCliError({
    code: "E_CONFIG_INVALID",
    message:
      "The saved native Compose workload state is invalid; values omitted.",
  });
}
function serviceMap(document: PrivateDocument): Record<string, unknown> {
  return isRecord(document.services) ? document.services : invalid();
}

/** Only saved services with a finite or unspecified on-failure policy may have the observed transient restart gap. */
export function nativeComposeOnFailureServices(
  document: PrivateDocument
): readonly string[] {
  return Object.entries(serviceMap(document))
    .filter(
      ([, value]) =>
        isRecord(value) &&
        isRecord(value.labels) &&
        value.labels["io.hack.native-config.workload"] === "service" &&
        typeof value.restart === "string" &&
        ON_FAILURE_RESTART.test(value.restart)
    )
    .map(([name]) => name);
}

function proposedContainer(
  observed: NativeComposeOwnershipObservation,
  generation: ProposedGeneration,
  name: string
) {
  const matches = observed.containers.filter(
    (container) => !container.oneoff && container.service === name
  );
  const current = matches[0];
  return matches.length === 1 &&
    current?.generationId === generation.generationId &&
    current.name === `${generation.identity.composeProject}-${name}-1`
    ? current
    : undefined;
}

/** A non-restarting initializer has a terminal failure in the proposed generation. */
export function nativeComposeStartupJobFailed(
  document: PrivateDocument,
  observed: NativeComposeOwnershipObservation,
  generation: ProposedGeneration
): boolean {
  return Object.entries(serviceMap(document)).some(([name, value]) => {
    if (
      !(
        isRecord(value) &&
        isRecord(value.labels) &&
        value.labels["io.hack.native-config.workload"] === "job" &&
        (value.restart === undefined || value.restart === "no")
      )
    ) {
      return false;
    }
    const current = proposedContainer(observed, generation, name);
    return current?.state === "exited" && current.exitCode !== 0;
  });
}

/** Readiness belongs to the exact proposed generation, not an older healthy graph. */
export function nativeComposeWorkloadsReady(
  document: PrivateDocument,
  observed: NativeComposeOwnershipObservation,
  generation: ProposedGeneration,
  required = Object.keys(serviceMap(document))
): boolean {
  return required.every((name) => {
    const value = serviceMap(document)[name];
    if (!(isRecord(value) && isRecord(value.labels))) {
      return invalid();
    }
    const current = proposedContainer(observed, generation, name);
    if (!current) {
      return false;
    }
    if (value.labels["io.hack.native-config.workload"] === "job") {
      return current.state === "exited" && current.exitCode === 0;
    }
    return (
      current.state === "running" &&
      (!Object.hasOwn(value, "healthcheck") || current.health === "healthy")
    );
  });
}

/** Compose owns dependency startup. Confirm each requested direct edge faithfully. */
export function nativeComposeRunDependenciesReady(
  document: PrivateDocument,
  observed: NativeComposeOwnershipObservation,
  generation: {
    readonly generationId: string;
    readonly identity: { readonly composeProject: string };
  },
  target: string
): boolean {
  const workload = serviceMap(document)[target];
  if (!isRecord(workload)) {
    return invalid();
  }
  if (workload.depends_on === undefined) {
    return true;
  }
  if (!isRecord(workload.depends_on)) {
    return invalid();
  }
  return Object.entries(workload.depends_on).every(([name, dependency]) => {
    if (!isRecord(dependency)) {
      return invalid();
    }
    const matches = observed.containers.filter(
      (container) => !container.oneoff && container.service === name
    );
    const current = matches[0];
    if (
      matches.length !== 1 ||
      current?.generationId !== generation.generationId ||
      current.name !== `${generation.identity.composeProject}-${name}-1`
    ) {
      return false;
    }
    switch (dependency.condition) {
      case "service_started":
        return current.state === "running";
      case "service_healthy":
        return current.state === "running" && current.health === "healthy";
      case "service_completed_successfully":
        return current.state === "exited" && current.exitCode === 0;
      default:
        return invalid();
    }
  });
}

/** Absence, an unrelated completed command or duplicate one-offs prove no completion. */
export function nativeComposeCompletedOneoff(opts: {
  readonly observed: NativeComposeOwnershipObservation;
  readonly name: string;
  readonly generationId: string;
  readonly service: string;
  readonly exitCode: number;
}) {
  const oneoffs = opts.observed.containers.filter(
    (container) => container.oneoff
  );
  const current = oneoffs[0];
  return oneoffs.length === 1 &&
    current?.name === opts.name &&
    current.generationId === opts.generationId &&
    current.service === opts.service &&
    current.state === "exited" &&
    current.exitCode === opts.exitCode
    ? current
    : null;
}
