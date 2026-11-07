import { isRecord } from "../lib/guards.ts";

/**
 * Where a Compose edit that a retained native run cannot apply in place was
 * made. The service is an admitted Compose identifier and the field a closed
 * vocabulary, so both are safe to print; native messages never are.
 */
export interface NativePlanChange {
  readonly service: string;
  readonly field: NativePlanChangeField;
}

const FIELDS = {
  dependency_cache_volume: "`hack.dependencies.cache-volume`",
  hostnames: "routed hostnames",
} as const;
type NativePlanChangeField = keyof typeof FIELDS;

const SERVICE = /^[A-Za-z0-9_.-]{1,128}$/;

/** Accept only the exact versioned diagnostic; anything else is dropped. */
export function readNativePlanChange(
  value: unknown
): NativePlanChange | undefined {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !== "field,service,version" ||
    value.version !== 1 ||
    typeof value.service !== "string" ||
    !SERVICE.test(value.service) ||
    typeof value.field !== "string" ||
    !Object.hasOwn(FIELDS, value.field)
  ) {
    return;
  }
  return {
    service: value.service,
    field: value.field as NativePlanChangeField,
  };
}

const APPLY =
  "Revert the edit to keep the retained run as admitted, or run `hack down --remove-data` and then `hack up` to apply it with fresh data.";

/**
 * Closed guidance for native refusals of a Compose edit to a retained run.
 * Returns undefined for every other code, which keeps the generic text.
 */
export function nativePlanChangeGuidance(
  code: string,
  change: NativePlanChange | undefined
): string | undefined {
  const where = change
    ? ` (service \`${change.service}\`, ${FIELDS[change.field]})`
    : "";
  switch (code) {
    case "graph_plan_reconcile":
      return `this Compose edit${where} cannot be applied to the retained run. ${
        change?.field === "dependency_cache_volume"
          ? "A retained named volume holds run data and is never reused as a shared dependency cache. "
          : ""
      }${APPLY}`;
    case "graph_plan_change_unsupported":
      return `this Compose edit cannot be applied in place: the retained run uses live source, a carried cache scope, a pending source-device rebind or a pending initializer cache release, so only routed hostname changes apply to it. ${APPLY}`;
    case "graph_hostname_change":
      return `the hostname change${where} cannot be applied to the retained run together with the other changes. Apply the hostname change on its own, or ${APPLY.charAt(0).toLowerCase()}${APPLY.slice(1)}`;
    default:
      return;
  }
}
