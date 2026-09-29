import { CliUsageError } from "../cli/command.ts";
import { isRecord } from "./guards.ts";

/** Refuse unsupported reader/writer layouts before generating a protocol override. */
export function validateDependencyCacheLayout(opts: {
  readonly compose: unknown;
  readonly producer: string;
  readonly volume: string;
}): void {
  const compose = opts.compose;
  if (!(isRecord(compose) && isRecord(compose.services))) {
    throw new CliUsageError(
      "Dependency cache protocol requires Compose services"
    );
  }
  if (compose.include !== undefined) {
    throw new CliUsageError(
      "Dependency cache protocol does not support Compose include"
    );
  }
  const volume = isRecord(compose.volumes)
    ? compose.volumes[opts.volume]
    : undefined;
  if (
    volume === undefined ||
    (isRecord(volume) && (volume.external || volume.name))
  ) {
    throw new CliUsageError(
      "Dependency cache protocol requires a managed, unnamed top-level volume"
    );
  }
  for (const [name, service] of Object.entries(compose.services)) {
    if (
      isRecord(service) &&
      (service.extends !== undefined || service.volumes_from !== undefined)
    ) {
      throw new CliUsageError(
        "Dependency cache protocol does not support extends or volumes_from"
      );
    }
    if (
      name === opts.producer ||
      !isRecord(service) ||
      !Array.isArray(service.volumes)
    ) {
      continue;
    }
    validateConsumer({
      name,
      service,
      mounts: service.volumes,
      producer: opts.producer,
      volume: opts.volume,
    });
  }
}

function mountInfo(mount: unknown): { source: unknown; readOnly: boolean } {
  if (typeof mount === "string") {
    const parts = mount.split(":");
    return {
      source: parts[0],
      readOnly: parts.length === 3 && parts[2] === "ro",
    };
  }
  if (isRecord(mount)) {
    return {
      source: mount.source,
      readOnly: mount.type === "volume" && mount.read_only === true,
    };
  }
  return { source: undefined, readOnly: false };
}

function validateConsumer(opts: {
  readonly name: string;
  readonly service: Record<string, unknown>;
  readonly mounts: readonly unknown[];
  readonly producer: string;
  readonly volume: string;
}): void {
  const gate = isRecord(opts.service.depends_on)
    ? opts.service.depends_on[opts.producer]
    : undefined;
  const completed =
    isRecord(gate) &&
    gate.condition === "service_completed_successfully" &&
    gate.required !== false;
  for (const mount of opts.mounts) {
    const info = mountInfo(mount);
    if (info.source === opts.volume && !(info.readOnly && completed)) {
      throw new CliUsageError(
        `Dependency cache consumer ${opts.name} must mount ${opts.volume} read-only and require successful completion of ${opts.producer}`
      );
    }
  }
}
