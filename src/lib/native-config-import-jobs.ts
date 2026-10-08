import { isRecord } from "./guards.ts";
import { legacyComposeCompletedJobTargets } from "./native-config-import-readiness.ts";

const ONE_SHOT = "hack.service.one-shot";

/** Only this existing authored role marker is consumed; arbitrary labels are not discarded. */
export function legacyComposeOneShotMarker(value: unknown): boolean {
  return (
    (isRecord(value) &&
      Object.keys(value).length === 1 &&
      Object.hasOwn(value, ONE_SHOT) &&
      value[ONE_SHOT] === "true") ||
    (Array.isArray(value) &&
      value.length === 1 &&
      value[0] === `${ONE_SHOT}=true`)
  );
}

/** Pure first pass: names, command heuristics, restart policy and observed exits grant no role. */
export function legacyComposeJobNames(
  services: Readonly<Record<string, unknown>>
): ReadonlySet<string> {
  const jobs = new Set<string>();
  for (const [name, value] of Object.entries(services)) {
    if (!isRecord(value)) {
      continue;
    }
    if (
      Object.hasOwn(value, "labels") &&
      legacyComposeOneShotMarker(value.labels)
    ) {
      jobs.add(name);
    }
    if (Object.hasOwn(value, "depends_on")) {
      for (const target of legacyComposeCompletedJobTargets(value.depends_on)) {
        jobs.add(target);
      }
    }
  }
  return jobs;
}
