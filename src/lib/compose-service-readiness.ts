import { isRecord } from "./guards.ts";
import type { ServiceReadiness } from "./project-state.ts";

/** Current declared readiness roles; exit zero alone never declares a job. */
export function composeServiceReadiness(
  document: unknown
): Readonly<Record<string, ServiceReadiness>> {
  if (!(isRecord(document) && isRecord(document.services))) {
    return {};
  }
  const roles: Record<string, ServiceReadiness> = {};
  for (const [name, service] of Object.entries(document.services)) {
    if (!isRecord(service)) {
      continue;
    }
    const health = service.healthcheck;
    const disabled =
      isRecord(health) &&
      (health.disable === true ||
        (Array.isArray(health.test) &&
          health.test.length === 1 &&
          health.test[0] === "NONE"));
    roles[name] = isRecord(health) && !disabled ? "healthy" : "started";
  }
  applyDependencyRoles(document.services, roles);
  return roles;
}

function applyDependencyRoles(
  services: Readonly<Record<string, unknown>>,
  roles: Record<string, ServiceReadiness>
): void {
  for (const service of Object.values(services)) {
    if (!(isRecord(service) && isRecord(service.depends_on))) {
      continue;
    }
    for (const [name, dependency] of Object.entries(service.depends_on)) {
      if (!(roles[name] && isRecord(dependency))) {
        continue;
      }
      if (dependency.condition === "service_completed_successfully") {
        roles[name] = "completed";
      } else if (
        roles[name] !== "completed" &&
        dependency.condition === "service_healthy"
      ) {
        roles[name] = "healthy";
      }
    }
  }
}
