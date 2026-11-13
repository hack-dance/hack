import { HackCliError } from "../lib/cli-result.ts";
import { isRecord } from "../lib/guards.ts";

const SERVICE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const FIELDS = new Set([
  "port",
  "path",
  "interval_ms",
  "timeout_ms",
  "retries",
  "start_period_ms",
]);
const PATH = /^\/[\x21-\x22\x24-\x7e]*$/;

/**
 * Exact compiler-generated defaults; this policy is never an authored opt-in.
 * These values bind retained route admission; changing them requires migration.
 */
export function isInferredNativeRouteProbe(
  probe: unknown,
  port: unknown
): boolean {
  return (
    isRecord(probe) &&
    bounded(port, 1, 65_535) &&
    Object.keys(probe).length === 7 &&
    probe.policy === "route" &&
    probe.port === port &&
    probe.path === "/" &&
    probe.interval_ms === 1000 &&
    probe.timeout_ms === 1000 &&
    probe.retries === 3 &&
    probe.start_period_ms === 300_000
  );
}
function bounded(value: unknown, min: number, max: number): boolean {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= min &&
    value <= max
  );
}
/** Pure preflight of the runtime HttpProbe contract, before hooks or image effects.
 * Runtime validation remains authoritative at execution and observation boundaries.
 */
export function admitNativeHttpProbe(
  service: string,
  spec: Readonly<Record<string, unknown>>
): void {
  if (
    !(
      isRecord(spec.healthcheck) &&
      Object.hasOwn(spec.healthcheck, "x-hack-http")
    )
  ) {
    return;
  }
  const probe = spec.healthcheck["x-hack-http"];
  let field: string | undefined;
  if (isRecord(probe)) {
    const checks: Readonly<Record<string, boolean>> = {
      port: bounded(probe.port, 1, 65_535),
      path:
        typeof probe.path === "string" &&
        probe.path.length <= 512 &&
        PATH.test(probe.path),
      interval_ms: bounded(probe.interval_ms, 10, 3_600_000),
      timeout_ms: bounded(probe.timeout_ms, 1, 60_000),
      retries: bounded(probe.retries, 1, 100),
      start_period_ms: bounded(probe.start_period_ms, 0, 3_600_000),
    };
    field = Object.keys(checks).find((key) => !checks[key]);
    if (
      field === undefined &&
      Object.keys(probe).some((key) => !FIELDS.has(key))
    ) {
      field = "";
    }
  } else {
    field = "";
  }
  if (field !== undefined) {
    throw new HackCliError({
      code: "E_CONFIG_INVALID",
      message: `Native HTTP probe refused for ${SERVICE.test(service) ? `service ${service}` : "a service"} field healthcheck.x-hack-http${field ? `.${field}` : ""}: invalid configuration; values omitted.`,
    });
  }
}
