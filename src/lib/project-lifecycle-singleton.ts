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
    const state = inspectTcpPortState({ port });
    if (state.kind === "occupied") {
      occupied.push(port);
    }
    if (state.kind === "error") {
      return Promise.reject(
        new Error(`Failed to inspect singleton port :${port}: ${state.message}`)
      );
    }
  }

  return Promise.resolve(occupied.sort((left, right) => left - right));
}

function inspectTcpPortState(input: {
  readonly port: number;
}):
  | { readonly kind: "free" }
  | { readonly kind: "occupied" }
  | { readonly kind: "error"; readonly message: string } {
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
    return { kind: "free" };
  } catch (error: unknown) {
    if (isAddressInUseError({ error })) {
      return { kind: "occupied" };
    }
    return {
      kind: "error",
      message:
        error instanceof Error ? error.message : "Unknown bind probe error",
    };
  }
}

function isAddressInUseError(input: { readonly error: unknown }): boolean {
  const code =
    typeof input.error === "object" &&
    input.error !== null &&
    "code" in input.error
      ? String((input.error as { readonly code?: unknown }).code ?? "")
      : "";
  if (code === "EADDRINUSE") {
    return true;
  }
  const message =
    input.error instanceof Error
      ? input.error.message.toLowerCase()
      : String(input.error).toLowerCase();
  return (
    message.includes("eaddrinuse") || message.includes("address already in use")
  );
}

function formatPortList(input: { readonly ports: readonly number[] }): string {
  return input.ports.map((port) => `:${port}`).join(", ");
}
