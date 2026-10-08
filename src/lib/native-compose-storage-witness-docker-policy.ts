import { isRecord } from "./guards.ts";
import { nativeComposeVolumeCreatedAt } from "./native-compose-retained-storage.ts";
import { NATIVE_STORAGE_DOCKER_ARTIFACT } from "./native-compose-storage-witness-docker-artifact.ts";
import type { NativeComposeStorageXattrInvocation } from "./native-compose-storage-witness-xattr-carrier.ts";
import { refuseNativeComposeStorageXattr as refuse } from "./native-compose-storage-witness-xattr-codec.ts";

const ID = /^[a-f0-9]{64}$/;
export const NATIVE_STORAGE_CARRIER_LABEL = "io.hack.storage-witness.carrier";
export const NATIVE_STORAGE_CARRIER_FORMAT =
  '{"id":{{json .Id}},"createdAt":{{json .Created}},"image":{{json .Image}},"configImage":{{json .Config.Image}},"user":{{json .Config.User}},"entrypoint":{{json .Config.Entrypoint}},"cmd":{{json .Config.Cmd}},"openStdin":{{json .Config.OpenStdin}},"tty":{{json .Config.Tty}},"labels":{{json .Config.Labels}},"host":{{json .HostConfig}},"mounts":{{json .Mounts}},"state":{{json .State}},"execIds":{{json .ExecIDs}}}';
export type NativeComposeStorageDockerCarrier = Record<string, unknown> & {
  readonly id: string;
  readonly createdAt: string;
  readonly state: Record<string, unknown>;
};
export function checkNativeComposeStorageDockerCarrier(opts: {
  readonly value: unknown;
  readonly input: NativeComposeStorageXattrInvocation;
  readonly program: string;
  readonly imageIds: readonly string[];
}): NativeComposeStorageDockerCarrier {
  const { value, input, program, imageIds } = opts;
  if (
    !(
      isRecord(value) &&
      typeof value.id === "string" &&
      ID.test(value.id) &&
      nativeComposeVolumeCreatedAt(value.createdAt) &&
      isRecord(value.host) &&
      isRecord(value.state) &&
      isRecord(value.labels) &&
      Array.isArray(value.mounts) &&
      value.configImage === input.artifact.imageId &&
      typeof value.image === "string" &&
      imageIds.includes(value.image) &&
      value.user === `${input.uid}:${input.gid}` &&
      value.openStdin === true &&
      value.tty === false &&
      JSON.stringify(value.entrypoint) === '["/usr/local/bin/bun"]' &&
      JSON.stringify(value.cmd) ===
        '["--no-env-file","/hack-storage-witness-helper.mjs"]' &&
      value.labels[NATIVE_STORAGE_CARRIER_LABEL] === input.invocationId &&
      value.labels["io.hack.storage-witness.owner"] ===
        input.target.ownerToken &&
      value.labels["io.hack.storage-witness.generation"] ===
        input.scope.generationId &&
      value.labels["io.hack.storage-witness.helper"] ===
        input.artifact.helperHash &&
      !Object.hasOwn(value.labels, "com.docker.compose.project") &&
      Object.hasOwn(value, "execIds") &&
      (value.execIds === null ||
        (Array.isArray(value.execIds) && value.execIds.length === 0))
    )
  ) {
    return refuse();
  }
  const host = value.host;
  if (
    !(
      host.Privileged === false &&
      host.ReadonlyRootfs === true &&
      host.NetworkMode === "none" &&
      host.Memory === 268_435_456 &&
      host.NanoCpus === 1_000_000_000 &&
      host.PidsLimit === 32 &&
      JSON.stringify(host.CapDrop) === '["ALL"]' &&
      (host.CapAdd === null ||
        (Array.isArray(host.CapAdd) && host.CapAdd.length === 0)) &&
      JSON.stringify(host.SecurityOpt) === '["no-new-privileges:true"]' &&
      isRecord(host.LogConfig) &&
      host.LogConfig.Type === "none" &&
      isRecord(host.LogConfig.Config) &&
      Object.keys(host.LogConfig.Config).length === 0 &&
      isRecord(host.RestartPolicy) &&
      host.RestartPolicy.Name === "no" &&
      (host.Binds === null ||
        (Array.isArray(host.Binds) && host.Binds.length === 0)) &&
      (host.Tmpfs === null ||
        (isRecord(host.Tmpfs) && Object.keys(host.Tmpfs).length === 0)) &&
      (host.Devices === null ||
        (Array.isArray(host.Devices) && host.Devices.length === 0)) &&
      (host.DeviceRequests === null ||
        (Array.isArray(host.DeviceRequests) &&
          host.DeviceRequests.length === 0)) &&
      isRecord(host.PortBindings) &&
      Object.keys(host.PortBindings).length === 0 &&
      Array.isArray(host.Mounts) &&
      host.Mounts.length === 2 &&
      value.mounts.length === 2
    )
  ) {
    return refuse();
  }
  for (const [source, target, readonly] of [
    [program, "/hack-storage-witness-helper.mjs", true],
    [input.target.mountpoint, "/hack-storage-witness", input.readonly],
  ] as const) {
    const configured = host.Mounts.filter(
      (mount) => isRecord(mount) && mount.Target === target
    );
    const physical = value.mounts.filter(
      (mount) => isRecord(mount) && mount.Destination === target
    );
    if (
      !(
        typeof source === "string" &&
        configured.length === 1 &&
        physical.length === 1 &&
        isRecord(configured[0]) &&
        configured[0].Type === "bind" &&
        configured[0].Source === source &&
        configured[0].ReadOnly === readonly &&
        isRecord(configured[0].BindOptions) &&
        configured[0].BindOptions.NonRecursive === true &&
        configured[0].BindOptions.Propagation === "rprivate" &&
        configured[0].BindOptions.CreateMountpoint !== true &&
        isRecord(physical[0]) &&
        physical[0].Type === "bind" &&
        physical[0].Source === source &&
        physical[0].RW === !readonly &&
        physical[0].Propagation === "rprivate"
      )
    ) {
      return refuse();
    }
  }
  return value as NativeComposeStorageDockerCarrier;
}
/** Preserve every static field and complete mount row. Only the two observed closed
 * optional defaults are normalized; no value, duplicate or projected field is dropped. */
export function nativeComposeStorageDockerCarrierPolicy(
  value: NativeComposeStorageDockerCarrier
): string {
  if (
    !(
      isRecord(value.host) &&
      Array.isArray(value.mounts) &&
      Object.hasOwn(value.host, "OomKillDisable") &&
      (value.host.OomKillDisable === null ||
        value.host.OomKillDisable === false) &&
      Object.hasOwn(value, "execIds") &&
      (value.execIds === null ||
        (Array.isArray(value.execIds) && value.execIds.length === 0))
    )
  ) {
    return refuse();
  }
  const { state: _, ...fixed } = value;
  const mounts = [...value.mounts].sort((a, b) =>
    JSON.stringify(a).localeCompare(JSON.stringify(b))
  );
  return JSON.stringify({
    ...fixed,
    host: { ...value.host, OomKillDisable: false },
    execIds: [],
    mounts,
  });
}
export function nativeComposeStorageDockerCreateArgs(opts: {
  readonly input: NativeComposeStorageXattrInvocation;
  readonly program: string;
}): readonly string[] {
  const { input, program } = opts;
  if (
    input.artifact.imageId !== NATIVE_STORAGE_DOCKER_ARTIFACT.imageId ||
    !input.target.mountpoint
  ) {
    return refuse();
  }
  return [
    "create",
    "--interactive",
    "--name",
    `hack-storage-witness-${input.invocationId}`,
    "--pull",
    "never",
    "--platform",
    input.artifact.platform,
    "--user",
    `${input.uid}:${input.gid}`,
    "--read-only",
    "--network",
    "none",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--memory",
    "256m",
    "--cpus",
    "1",
    "--pids-limit",
    "32",
    "--restart",
    "no",
    "--log-driver",
    "none",
    "--mount",
    `type=bind,src=${program},dst=/hack-storage-witness-helper.mjs,readonly,bind-recursive=disabled,bind-propagation=rprivate`,
    "--mount",
    `type=bind,src=${input.target.mountpoint},dst=/hack-storage-witness${input.readonly ? ",readonly" : ""},bind-recursive=disabled,bind-propagation=rprivate`,
    "--label",
    `${NATIVE_STORAGE_CARRIER_LABEL}=${input.invocationId}`,
    "--label",
    `io.hack.storage-witness.owner=${input.target.ownerToken}`,
    "--label",
    `io.hack.storage-witness.generation=${input.scope.generationId}`,
    "--label",
    `io.hack.storage-witness.helper=${input.artifact.helperHash}`,
    "--entrypoint",
    "/usr/local/bin/bun",
    input.artifact.imageId,
    "--no-env-file",
    "/hack-storage-witness-helper.mjs",
  ];
}
