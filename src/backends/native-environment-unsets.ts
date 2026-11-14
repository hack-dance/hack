import { isRecord } from "../lib/guards.ts";

/**
 * Old runtimes ignore extension metadata. Require the reviewed plan to echo
 * every names-only removal before any effect, so a new CLI cannot silently
 * retain an image default when paired with an older runtime binary.
 */
export function nativeEnvironmentUnsetsReviewed(opts: {
  readonly compose: unknown;
  readonly plan: unknown;
}): boolean {
  if (!(isRecord(opts.compose) && isRecord(opts.compose.services))) {
    return false;
  }
  for (const [name, service] of Object.entries(opts.compose.services)) {
    if (
      !(
        isRecord(service) && Array.isArray(service["x-hack-unset-environment"])
      ) ||
      service["x-hack-unset-environment"].length === 0
    ) {
      continue;
    }
    if (!(isRecord(opts.plan) && isRecord(opts.plan.services))) {
      return false;
    }
    const reviewed = opts.plan.services[name];
    if (
      !isRecord(reviewed) ||
      JSON.stringify(reviewed.environment_unsets) !==
        JSON.stringify(service["x-hack-unset-environment"])
    ) {
      return false;
    }
  }
  return true;
}
