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
    const observed = observations[key];
    if (
      !isRecord(observed) ||
      observed.state !== (resource.kind === "volume" ? "present" : "absent")
    ) {
      return false;
    }
  }
  return (
    Object.keys(observations).length === expected.size &&
    Object.keys(observations).every((key) => expected.has(key))
  );
}
