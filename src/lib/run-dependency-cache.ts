import { isRecord } from "./guards.ts";
import { exec } from "./shell.ts";

const CONTAINER_ID = /^[a-f0-9]{12,64}$/;
const INSPECT_FORMAT =
  '{"id":{{json .Id}},"running":{{json .State.Running}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"mounts":{{json .Mounts}}}';

/**
 * A running service is not evidence that a newly selected dependency cache is
 * ready. Check its immutable mounts before skipping dependency reconciliation.
 * When a declared cache is only mounted by another service, defer to Compose.
 */
export async function canReuseRunningDependencyCache(opts: {
  readonly containerId: string | undefined;
  readonly composeProject: string;
  readonly service: string;
  readonly volumeNames: readonly string[];
  readonly cwd: string;
  readonly env?: Record<string, string>;
}): Promise<boolean> {
  if (opts.volumeNames.length === 0) {
    return true;
  }
  if (!(opts.containerId && CONTAINER_ID.test(opts.containerId))) {
    return false;
  }
  try {
    const result = await exec(
      ["docker", "inspect", "--format", INSPECT_FORMAT, opts.containerId],
      { stdin: "ignore", timeoutMs: 15_000, cwd: opts.cwd, env: opts.env }
    );
    if (result.exitCode !== 0) {
      return false;
    }
    const inspected: unknown = JSON.parse(result.stdout);
    if (
      !isRecord(inspected) ||
      typeof inspected.id !== "string" ||
      inspected.id.length !== 64 ||
      !CONTAINER_ID.test(inspected.id) ||
      !inspected.id.startsWith(opts.containerId) ||
      inspected.running !== true ||
      inspected.project !== opts.composeProject ||
      inspected.service !== opts.service ||
      !Array.isArray(inspected.mounts)
    ) {
      return false;
    }
    const names = new Set(
      inspected.mounts.flatMap((mount: unknown) =>
        isRecord(mount) &&
        mount.Type === "volume" &&
        typeof mount.Name === "string"
          ? [mount.Name]
          : []
      )
    );
    return opts.volumeNames.every((name) => names.has(name));
  } catch {
    return false;
  }
}
