import { isRecord } from "./guards.ts";

export type ComposeServiceActivation = {
  readonly profiles: Readonly<Record<string, readonly string[]>>;
  readonly requiredDependencies: Readonly<Record<string, readonly string[]>>;
};

/** Definition metadata only; a listing's environment does not prove which profiles ran. */
export function composeServiceActivation(
  document: unknown
): ComposeServiceActivation {
  const profiles: Record<string, readonly string[]> = {};
  const requiredDependencies: Record<string, readonly string[]> = {};
  if (!(isRecord(document) && isRecord(document.services))) {
    return { profiles, requiredDependencies };
  }
  for (const [name, service] of Object.entries(document.services)) {
    if (!isRecord(service)) {
      continue;
    }
    profiles[name] = Array.isArray(service.profiles)
      ? service.profiles.filter(
          (profile): profile is string =>
            typeof profile === "string" && profile.length > 0
        )
      : [];
    requiredDependencies[name] = dependencies(service.depends_on);
  }
  return { profiles, requiredDependencies };
}

function dependencies(value: unknown): readonly string[] {
  if (Array.isArray(value)) {
    return value.filter((name): name is string => typeof name === "string");
  }
  if (!isRecord(value)) {
    return [];
  }
  return Object.entries(value)
    .filter(
      ([, dependency]) =>
        !(isRecord(dependency) && dependency.required === false)
    )
    .map(([name]) => name);
}

/** Unprofiled, observed, and transitively required services contribute to project state. */
export function requiredObservedServices(opts: {
  readonly names: readonly string[];
  readonly observed: readonly string[];
  readonly activation?: ComposeServiceActivation;
}): ReadonlySet<string> {
  const required = new Set(
    opts.names.filter((name) => !opts.activation?.profiles[name]?.length)
  );
  for (const name of opts.observed) {
    required.add(name);
  }
  // Set iteration visits newly inserted dependencies, including transitive ones.
  for (const name of required) {
    for (const dependency of opts.activation?.requiredDependencies[name] ??
      []) {
      required.add(dependency);
    }
  }
  return required;
}
