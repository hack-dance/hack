import { isRecord } from "../lib/guards.ts";
import type { NativeProjectRun } from "./native-project-run.ts";

/** Require fresh native observations of exact retained data and absent compute.
 * A frontend mapping or completed intent alone cannot establish this authority.
 */
export function confirmedNativeRetainedGraph(
  value: unknown,
  run: NativeProjectRun
): boolean {
  if (
    !isRecord(value) ||
    value.journal_incomplete !== false ||
    !isRecord(value.receipt) ||
    !isRecord(value.observations)
  ) {
    return false;
  }
  const { receipt, observations } = value;
  if (
    receipt.phase !== "stopped-data-retained" ||
    receipt.run !== run.run ||
    receipt.owner !== run.owner ||
    receipt.namespace !== run.namespace ||
    receipt.plan_id !== run.planId ||
    !isRecord(receipt.resources) ||
    Object.keys(receipt.resources).length === 0
  ) {
    return false;
  }
  const expected = new Set<string>();
  for (const resource of Object.values(receipt.resources)) {
    if (
      !isRecord(resource) ||
      typeof resource.key !== "string" ||
      resource.key.length === 0 ||
      typeof resource.kind !== "string" ||
      !["container", "network", "volume"].includes(resource.kind)
    ) {
      return false;
    }
    const key = `${resource.kind}:${resource.key}`;
    if (expected.has(key)) {
      return false;
    }
    expected.add(key);
    if (!observedAsRecorded(resource, observations[key])) {
      return false;
    }
  }
  return (
    Object.keys(observations).length === expected.size &&
    Object.keys(observations).every((key) => expected.has(key))
  );
}

/**
 * Compute must be absent and settled data present. A `reserved` volume never
 * received a create intent: it holds no data and must be absent. A reserved
 * dependency cache is shared and content-addressed: admission adopts an
 * existing one by labels or creates it, so either observation is valid.
 */
function observedAsRecorded(
  resource: Record<string, unknown>,
  observed: unknown
): boolean {
  if (!isRecord(observed)) {
    return false;
  }
  if (resource.kind !== "volume") {
    return observed.state === "absent";
  }
  if (resource.phase !== "reserved") {
    return observed.state === "present";
  }
  return isRecord(resource.cache)
    ? observed.state === "present" || observed.state === "absent"
    : observed.state === "absent";
}

/**
 * HACK-2096 (real VM, row 8): a stopped retained run whose receipt records
 * every container removed, while the engine still shows some of them, stopped
 * (`exited`) and none running. Seen after the provider was killed seconds
 * after a `hack down` removed the run's containers: the guest engine's removal
 * had not reached the storage disk, so the next boot listed the containers
 * again, as exited (137). Nothing is running, but `verify` needs every
 * container absent, so `hack down --recover` refused ("cleanup is
 * unconfirmed") and `hack up` refused the mapping. Only this exact shape is
 * repaired, by the runtime's own `graph cleanup` of the receipt's resources
 * (exact ids; named volumes and data kept, a container's anonymous volumes go
 * with it as in the original down); anything running, uncertain or unrecorded is not.
 * The run's owner retired its publication when that down finished, so the
 * runtime removes them under that retirement's lock, without an owner
 * (HACK-2719). A cleanup also flushes the guest disk before it records the
 * removal now, so a new down no longer leaves this shape behind.
 */
export function lostContainerRemovals(snapshot: unknown): boolean {
  if (
    !(
      isRecord(snapshot) &&
      isRecord(snapshot.receipt) &&
      snapshot.receipt.phase === "stopped-data-retained" &&
      snapshot.journal_incomplete === false &&
      isRecord(snapshot.receipt.resources) &&
      isRecord(snapshot.observations)
    )
  ) {
    return false;
  }
  const observations = snapshot.observations;
  const containers = Object.values(snapshot.receipt.resources).filter(
    (resource) => isRecord(resource) && resource.kind === "container"
  );
  const states = containers.map((resource) => {
    if (!isRecord(resource) || resource.phase !== "absent") {
      return "unrecorded";
    }
    const observation = observations[`container:${String(resource.key)}`];
    return isRecord(observation) ? observation.state : undefined;
  });
  const settled = states.every(
    (state) => state === "absent" || state === "exited"
  );
  // A repair that removed them but ended before its storage barrier confirmed
  // (`lost_removal_pending`): run it again, so the stop becomes durable.
  return settled && (states.includes("exited") || lostRemovalPending(snapshot));
}

/** A lost-removal repair whose storage barrier has not confirmed yet. */
export function lostRemovalPending(snapshot: unknown): boolean {
  return isRecord(snapshot) && snapshot.lost_removal_pending === true;
}
