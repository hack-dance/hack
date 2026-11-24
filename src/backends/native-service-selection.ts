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

/** Project a start onto the requested Compose services and their dependency closure. */
export function selectNativeServices(opts: {
  readonly services: Readonly<Record<string, unknown>>;
  readonly targets: readonly string[];
  readonly profiles: readonly string[];
  readonly existingImages?: ReadonlyMap<string, string>;
}): Record<string, unknown> {
  const profiles = new Set(opts.profiles);
  const included = new Set(opts.targets);
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
  const projected: Record<string, unknown> = Object.create(null);
  // Inserting into the set extends this traversal and naturally bounds cycles.
  for (const name of included) {
    const service = Object.hasOwn(opts.services, name)
      ? opts.services[name]
      : undefined;
    if (!isRecord(service)) {
      if (service !== undefined) {
        projected[name] = service;
      }
      continue;
    }
    const dependencies = service.depends_on;
    if (Array.isArray(dependencies)) {
      for (const dependency of dependencies) {
        if (typeof dependency === "string") {
          included.add(dependency);
        }
      }
    }
    const dependsOn = isRecord(dependencies)
      ? Object.fromEntries(
          Object.entries(dependencies).filter(([dependency, condition]) => {
            const declared = Object.hasOwn(opts.services, dependency)
              ? opts.services[dependency]
              : undefined;
            const selected =
              !(isRecord(condition) && condition.required === false) ||
              opts.targets.includes(dependency) ||
              opts.existingImages?.has(dependency) ||
              (isRecord(declared) &&
                nativeServiceActive(declared, [...profiles]));
            if (selected) {
              included.add(dependency);
            }
            return selected;
          })
        )
      : dependencies;
    const existing = opts.existingImages?.get(name);
    if (existing !== undefined) {
      // The live owner verifies and observes this service. Its authored config,
      // private inputs, image tag and publication settings need no preparation.
      projected[name] = {
        image: existing,
        ...(service.healthcheck !== undefined
          ? { healthcheck: service.healthcheck }
          : {}),
        ...(dependsOn !== undefined ? { depends_on: dependsOn } : {}),
      };
    } else {
      projected[name] = {
        ...service,
        profiles: undefined,
        ...(dependsOn !== undefined ? { depends_on: dependsOn } : {}),
      };
    }
  }
  return projected;
}
