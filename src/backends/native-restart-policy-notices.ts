import { isRecord } from "../lib/guards.ts";

/** Review warning for a restart policy that native starts without (HACK-1935). */
export const RESTART_POLICY_NOT_APPLIED = "restart_policy_not_applied";

const SERVICE = /^[A-Za-z0-9_.-]{1,128}$/;
// The reviewed Compose grammar; anything else is never echoed.
const POLICY = /^(?:always|unless-stopped|on-failure(?::[1-9][0-9]{0,9})?)$/;

/**
 * One value-free notice per active service whose declared restart policy is
 * not applied, read from the runtime review: the warning diagnostic names the
 * service by its `services.<name>.restart` pointer, and the policy comes from
 * the reviewed plan, so only a service name and a closed-grammar policy are
 * printed. A malformed plan yields no notice; admission never depends on it.
 */
export function nativeRestartPolicyNotices(plan: unknown): string[] {
  if (
    !(
      isRecord(plan) &&
      Array.isArray(plan.diagnostics) &&
      isRecord(plan.services)
    )
  ) {
    return [];
  }
  const fields = new Set<string>();
  for (const diagnostic of plan.diagnostics) {
    if (
      isRecord(diagnostic) &&
      diagnostic.severity === "warning" &&
      diagnostic.code === RESTART_POLICY_NOT_APPLIED &&
      typeof diagnostic.field === "string"
    ) {
      fields.add(diagnostic.field);
    }
  }
  const notices: string[] = [];
  for (const [service, value] of Object.entries(plan.services).sort(
    ([a], [b]) => a.localeCompare(b)
  )) {
    const policy = isRecord(value) ? value.restart : undefined;
    if (
      SERVICE.test(service) &&
      typeof policy === "string" &&
      POLICY.test(policy) &&
      isRecord(value) &&
      value.active === true &&
      fields.has(`services.${service}.restart`)
    ) {
      notices.push(
        `Service ${service}: restart: ${policy} is not applied. Restart policies are not applied yet to services with published ports or routes (HACK-1935); the service starts without automatic restarts.`
      );
    }
  }
  return notices;
}

/** Write each notice once through the caller's value-free warning channel. */
export function reportNativeRestartPolicyNotices(
  plan: unknown,
  warn: (line: string) => void
): void {
  for (const line of nativeRestartPolicyNotices(plan)) {
    warn(line);
  }
}
