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

/**
 * One notice per active service that declares an automatic restart policy and
 * receives private values (managed environment, privately resolved shell
 * values or file members): native starts it without the engine policy,
 * because private delivery is single-incarnation and values are never kept at
 * rest in the container (HACK-2324). Only the service name and the
 * closed-grammar policy are printed.
 */
export function nativeManagedRestartNotices(opts: {
  readonly compose: unknown;
  readonly plan: unknown;
  /** Services that receive private values. */
  readonly delivered: ReadonlySet<string>;
}): { readonly service: string; readonly line: string }[] {
  const services =
    isRecord(opts.compose) && isRecord(opts.compose.services)
      ? opts.compose.services
      : {};
  const reviewed =
    isRecord(opts.plan) && isRecord(opts.plan.services)
      ? opts.plan.services
      : {};
  const notices: { service: string; line: string }[] = [];
  for (const [service, spec] of Object.entries(services).sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    const policy = isRecord(spec) ? spec.restart : undefined;
    const active = reviewed[service];
    if (
      SERVICE.test(service) &&
      typeof policy === "string" &&
      POLICY.test(policy) &&
      isRecord(active) &&
      active.active === true &&
      opts.delivered.has(service)
    ) {
      notices.push({
        service,
        line: `Service ${service}: restart: ${policy} is not applied, because the service receives private values that native delivers once per container start. If it crashes it stays stopped until Hack restarts it (hack restart ${service}).`,
      });
    }
  }
  return notices;
}

/** Services the private envelope delivers to: values, shell values or files. */
export function nativePrivatelyDeliveredServices(input: {
  readonly managedEnvironment: Readonly<
    Record<string, Readonly<Record<string, string>>>
  >;
  readonly shellEnvironment?: Readonly<Record<string, unknown>>;
  readonly managedFiles?: Readonly<Record<string, readonly unknown[]>>;
}): Set<string> {
  return new Set([
    ...Object.entries(input.managedEnvironment)
      .filter(([, values]) => Object.keys(values).length > 0)
      .map(([name]) => name),
    ...Object.keys(input.shellEnvironment ?? {}),
    ...Object.entries(input.managedFiles ?? {})
      .filter(([, files]) => files.length > 0)
      .map(([name]) => name),
  ]);
}

/** Warn once per privately delivered service whose restart policy is dropped. */
export function reportNativeManagedRestartNotices(opts: {
  readonly input: Parameters<typeof nativePrivatelyDeliveredServices>[0] & {
    readonly normalizedComposeJson: string;
  };
  readonly plan: unknown;
  readonly warn: (line: string) => void;
}): void {
  for (const notice of nativeManagedRestartNotices({
    compose: JSON.parse(opts.input.normalizedComposeJson),
    plan: opts.plan,
    delivered: nativePrivatelyDeliveredServices(opts.input),
  })) {
    opts.warn(notice.line);
  }
}
