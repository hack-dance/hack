import { HackCliError } from "../lib/cli-result.ts";
import { isRecord } from "../lib/guards.ts";
import { nativeServiceActive } from "./native-project-builds.ts";

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export class NativeUnknownServiceError extends HackCliError {
  constructor(name: string) {
    super({
      code: "E_SERVICE_NOT_FOUND",
      message: NAME.test(name)
        ? `Unknown Compose service: ${name}.`
        : "Unknown Compose service; invalid service name omitted.",
    });
  }
}

type Selection = {
  readonly services: Readonly<Record<string, unknown>>;
  readonly targets: readonly string[];
  readonly profiles: readonly string[];
  readonly existingImages?: ReadonlyMap<string, string>;
};

function declaredService(services: Selection["services"], name: string) {
  return Object.hasOwn(services, name) ? services[name] : undefined;
}

function selectionProfiles(opts: Selection): readonly string[] {
  const profiles = new Set(opts.profiles);
  for (const name of opts.targets) {
    if (!Object.hasOwn(opts.services, name)) {
      throw new NativeUnknownServiceError(name);
    }
    const service = opts.services[name];
    if (isRecord(service) && Array.isArray(service.profiles)) {
      for (const profile of service.profiles) {
        if (typeof profile === "string") {
          profiles.add(profile);
        }
      }
    }
  }
  return [...profiles];
}

function selectDependencies(
  dependencies: unknown,
  include: (name: string) => void,
  optional: (name: string) => boolean
): unknown {
  if (Array.isArray(dependencies)) {
    for (const dependency of dependencies) {
      if (typeof dependency === "string") {
        include(dependency);
      }
    }
  }
  if (!isRecord(dependencies)) {
    return dependencies;
  }
  return Object.fromEntries(
    Object.entries(dependencies).filter(([name, condition]) => {
      if (
        isRecord(condition) &&
        condition.required === false &&
        !optional(name)
      ) {
        return false;
      }
      include(name);
      return true;
    })
  );
}

/** Project a start onto the requested Compose services and their dependency closure. */
export function selectNativeServices(opts: Selection): Record<string, unknown> {
  const profiles = selectionProfiles(opts);
  const projected: Record<string, unknown> = Object.create(null);
  const included = new Set(opts.targets);
  const optional = (name: string) => {
    const declared = declaredService(opts.services, name);
    return (
      opts.targets.includes(name) ||
      opts.existingImages?.has(name) === true ||
      (isRecord(declared) && nativeServiceActive(declared, profiles))
    );
  };
  // Inserting into the set extends this traversal and naturally bounds cycles.
  for (const name of included) {
    const service = declaredService(opts.services, name);
    if (!isRecord(service)) {
      if (service !== undefined) {
        projected[name] = service;
      }
      continue;
    }
    const dependsOn = selectDependencies(
      service.depends_on,
      (dependency) => {
        included.add(dependency);
      },
      optional
    );
    const existing = opts.existingImages?.get(name);
    // The owner verifies existing identities. Keep only fields needed to
    // compile dependency conditions, so an existing service pulls no image
    // and supplies no private input or publication for this attempt.
    projected[name] =
      existing === undefined
        ? { ...service, profiles: undefined, depends_on: dependsOn }
        : {
            image: existing,
            healthcheck: service.healthcheck,
            depends_on: dependsOn,
          };
  }
  return projected;
}
