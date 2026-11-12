import { ClosedCliError } from "../lib/cli-result.ts";
import { isRecord } from "../lib/guards.ts";

export type NativePublishedPort = {
  readonly service: string;
  readonly port: number;
  readonly target: number;
  readonly state: "observed" | "down" | "unconfirmed";
};
function port(value: unknown): value is number {
  return (
    Number.isInteger(value) &&
    typeof value === "number" &&
    value > 0 &&
    value <= 65_535
  );
}

/** Only a bounded identity-matching runtime event can become a public notice. */
export function nativePublisherExitNotice(
  line: string,
  run: string
): string | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (
    !isRecord(value) ||
    value.kind !== "graph_publisher_exit" ||
    value.run !== run ||
    !(value.port === null || port(value.port))
  ) {
    return null;
  }
  return `Native publisher exited; ${value.port === null ? "route publication is down" : `127.0.0.1:${value.port} is down`}. Services remain running. Run hack down to stop this project with data retained.`;
}

/** Receipt intent is never evidence that its host port is currently published. */
export function nativeDeclaredPorts(
  resources: Record<string, unknown>
): NativePublishedPort[] {
  const result: NativePublishedPort[] = [];
  for (const resource of Object.values(resources)) {
    if (
      !isRecord(resource) ||
      resource.kind !== "container" ||
      typeof resource.key !== "string" ||
      resource.loopback_ports === undefined
    ) {
      continue;
    }
    if (!Array.isArray(resource.loopback_ports)) {
      throw new ClosedCliError(
        "Native publication intent is invalid; values omitted."
      );
    }
    for (const binding of resource.loopback_ports) {
      if (
        !(
          isRecord(binding) &&
          port(binding.host_port) &&
          port(binding.target)
        ) ||
        result.length >= 32 ||
        result.some((p) => p.port === binding.host_port)
      ) {
        throw new ClosedCliError(
          "Native publication intent is invalid; values omitted."
        );
      }
      result.push({
        service: resource.key,
        port: binding.host_port,
        target: binding.target,
        state: "unconfirmed",
      });
    }
  }
  return result;
}

/** Called only after the live owner's run, plan and phase have been checked. */
export function nativeObservedPorts(
  ports: NativePublishedPort[],
  value: unknown
): NativePublishedPort[] {
  if (
    !Array.isArray(value) ||
    value.length !== ports.length ||
    value.length > 32
  ) {
    return ports;
  }
  const states = new Map<number, "observed" | "down">();
  for (const item of value) {
    if (
      !(
        isRecord(item) &&
        port(item.port) &&
        ports.some((p) => p.port === item.port)
      ) ||
      states.has(item.port) ||
      !(item.state === "observed" || item.state === "down")
    ) {
      return ports;
    }
    states.set(item.port, item.state);
  }
  return ports.map((p) => ({
    ...p,
    state: states.get(p.port) ?? "unconfirmed",
  }));
}
