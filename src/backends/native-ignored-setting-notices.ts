import { isRecord } from "../lib/guards.ts";

/**
 * Review warnings for Compose settings that native accepts and does not apply.
 * Each maps the diagnostic's field suffix to the fixed sentence shown for it.
 */
const IGNORED_SETTINGS: Readonly<
  Record<string, { readonly suffix: string; readonly notice: string }>
> = {
  labels_not_applied: {
    suffix: "labels",
    notice: "labels are not applied to native containers.",
  },
  logging_not_applied: {
    suffix: "logging",
    notice:
      "logging configuration is not applied; read container logs with hack logs.",
  },
  mount_host_hint_ignored: {
    suffix: "volumes",
    notice:
      "host-only mount hints (cached, delegated, consistent, z, Z) are ignored on the native backend.",
  },
};

const SERVICE = /^[A-Za-z0-9_.-]{1,128}$/;

/**
 * One value-free notice per active service and ignored setting, read from the
 * runtime review. Without it a user's `logging:` block, metadata labels or
 * `:cached` mount would be dropped silently. Only a service name and a fixed
 * sentence are printed: the runtime's own message and the authored values are
 * never echoed. A malformed plan yields no notice; admission never depends on
 * it.
 */
export function nativeIgnoredSettingNotices(plan: unknown): string[] {
  if (
    !(
      isRecord(plan) &&
      Array.isArray(plan.diagnostics) &&
      isRecord(plan.services)
    )
  ) {
    return [];
  }
  const notices = new Set<string>();
  for (const diagnostic of plan.diagnostics) {
    if (
      !(
        isRecord(diagnostic) &&
        diagnostic.severity === "warning" &&
        typeof diagnostic.code === "string" &&
        typeof diagnostic.field === "string" &&
        Object.hasOwn(IGNORED_SETTINGS, diagnostic.code)
      )
    ) {
      continue;
    }
    const setting = IGNORED_SETTINGS[diagnostic.code];
    if (!setting) {
      continue;
    }
    const prefix = "services.";
    const tail = `.${setting.suffix}`;
    if (
      !(diagnostic.field.startsWith(prefix) && diagnostic.field.endsWith(tail))
    ) {
      continue;
    }
    const service = diagnostic.field.slice(prefix.length, -tail.length);
    const reviewed = Object.hasOwn(plan.services, service)
      ? plan.services[service]
      : undefined;
    if (
      SERVICE.test(service) &&
      isRecord(reviewed) &&
      reviewed.active === true
    ) {
      notices.add(`Service ${service}: ${setting.notice}`);
    }
  }
  return [...notices].sort((a, b) => a.localeCompare(b));
}

/** Write each notice once through the caller's value-free warning channel. */
export function reportNativeIgnoredSettingNotices(
  plan: unknown,
  warn: (line: string) => void
): void {
  for (const line of nativeIgnoredSettingNotices(plan)) {
    warn(line);
  }
}
