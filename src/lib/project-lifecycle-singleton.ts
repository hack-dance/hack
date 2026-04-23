import type { ProjectLifecycleSingletonConfig } from "./project.ts";

export type LifecycleSingletonDecision =
  | {
      readonly kind: "start";
    }
  | {
      readonly kind: "adopt";
      readonly message: string;
    }
  | {
      readonly kind: "fail";
      readonly message: string;
    };

export function resolveLifecycleSingletonDecision(input: {
  readonly singleton: ProjectLifecycleSingletonConfig | undefined;
  readonly occupiedPorts: readonly number[];
  readonly serviceName: string;
}): LifecycleSingletonDecision {
  const singleton = input.singleton;
  if (!singleton) {
    return { kind: "start" };
  }

  const expectedPorts = [...new Set(singleton.ports)].sort(
    (left, right) => left - right
  );
  const occupied = [...new Set(input.occupiedPorts)]
    .filter((port) => expectedPorts.includes(port))
    .sort((left, right) => left - right);
  if (occupied.length === 0) {
    return { kind: "start" };
  }

  const missing = expectedPorts.filter((port) => !occupied.includes(port));
  if (missing.length > 0) {
    return {
      kind: "fail",
      message:
        `Lifecycle process "${input.serviceName}" expected singleton ports ` +
        `${formatPortList({ ports: expectedPorts })}, but only ` +
        `${formatPortList({ ports: occupied })} already ` +
        "have listeners. Resolve the partial conflict before retrying.",
    };
  }

  if (singleton.onConflict === "adopt") {
    return {
      kind: "adopt",
      message:
        `Lifecycle process "${input.serviceName}" adopted existing listeners on ` +
        `${formatPortList({ ports: occupied })}. Hack will leave them running on down.`,
    };
  }

  return {
    kind: "fail",
    message:
      `Lifecycle process "${input.serviceName}" cannot start because singleton ports ` +
      `${formatPortList({ ports: occupied })} already have listeners. ` +
      `Stop the existing process or set lifecycle.singleton.onConflict to "adopt".`,
  };
}

export function inspectListeningTcpPorts(input: {
  readonly ports: readonly number[];
}): Promise<readonly number[]> {
  const occupied: number[] = [];

  for (const port of [...new Set(input.ports)]) {
    if (isTcpPortOccupied({ port })) {
      occupied.push(port);
    }
  }

  return Promise.resolve(occupied.sort((left, right) => left - right));
}

function isTcpPortOccupied(input: { readonly port: number }): boolean {
  try {
    const listener = Bun.listen({
      hostname: "127.0.0.1",
      port: input.port,
      socket: {
        data() {
          // The listener is only a bind probe and should never receive data.
        },
      },
    });
    listener.stop();
    return false;
  } catch {
    return true;
  }
}

function formatPortList(input: { readonly ports: readonly number[] }): string {
  return input.ports.map((port) => `:${port}`).join(", ");
}
