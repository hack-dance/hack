import type { ProjectLifecycleSingletonConfig } from "./project.ts";
import { exec } from "./shell.ts";

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

export async function inspectListeningTcpPorts(input: {
  readonly ports: readonly number[];
}): Promise<readonly number[]> {
  const occupied: number[] = [];

  for (const port of [...new Set(input.ports)]) {
    const result = await exec(
      ["lsof", "-nP", `-iTCP:${String(port)}`, "-sTCP:LISTEN", "-t"],
      {
        stdin: "ignore",
      }
    );
    if (result.exitCode !== 0) {
      continue;
    }
    if (result.stdout.trim().length > 0) {
      occupied.push(port);
    }
  }

  return occupied.sort((left, right) => left - right);
}

function formatPortList(input: { readonly ports: readonly number[] }): string {
  return input.ports.map((port) => `:${port}`).join(", ");
}
