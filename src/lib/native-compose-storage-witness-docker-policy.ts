import { isRecord } from "./guards.ts";
import {
  type NativeComposeEffectRefusal,
  retainNativeComposeEffectRefusal,
} from "./native-compose-effect-diagnostics.ts";
import { nativeComposeVolumeCreatedAt } from "./native-compose-retained-storage.ts";
import {
  NATIVE_STORAGE_DOCKER_ARTIFACT,
  nativeComposeStorageDockerImageReference,
} from "./native-compose-storage-witness-docker-artifact.ts";
import type { NativeComposeStorageXattrInvocation } from "./native-compose-storage-witness-xattr-carrier.ts";
import { refuseNativeComposeStorageXattr as refuse } from "./native-compose-storage-witness-xattr-codec.ts";

const ID = /^[a-f0-9]{64}$/;
function policyRefusal(reason: NativeComposeEffectRefusal["reason"]): never {
  try {
    return refuse();
  } catch (error) {
    retainNativeComposeEffectRefusal(error, {
      stage: "storage-helper-policy",
      reason,
    });
    throw error;
  }
}
function configuredReadOnly(
  mount: Record<string, unknown>,
  expected: boolean
): boolean {
  // The Engine API omits the false default. A present value must stay exact.
  return Object.hasOwn(mount, "ReadOnly")
    ? mount.ReadOnly === expected
    : expected === false;
}
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
  readonly input: Omit<NativeComposeStorageXattrInvocation, "recordCreated">;
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
      Array.isArray(value.mounts)
    )
  ) {
    return policyRefusal("helper-shape");
  }
  if (
    !(
      value.configImage ===
        nativeComposeStorageDockerImageReference(input.artifact) &&
      typeof value.image === "string" &&
      imageIds.includes(value.image) &&
      value.user === `${input.uid}:${input.gid}` &&
      value.openStdin === true &&
      value.tty === false &&
      JSON.stringify(value.entrypoint) === '["/usr/local/bin/bun"]' &&
      JSON.stringify(value.cmd) ===
        '["--no-env-file","/hack-storage-witness-helper.mjs"]'
    )
  ) {
    return policyRefusal("helper-command");
  }
  if (
    !(
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
    return policyRefusal("helper-labels");
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
      (!Object.hasOwn(host, "Tmpfs") ||
        host.Tmpfs === null ||
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
    return policyRefusal("helper-host-policy");
  }
  for (const target of [
    "/hack-storage-witness-helper.mjs",
    "/hack-storage-witness",
  ] as const) {
    const configured = host.Mounts.filter(
      (mount) => isRecord(mount) && mount.Target === target
    );
    const physical = value.mounts.filter(
      (mount) => isRecord(mount) && mount.Destination === target
    );
    if (
      !(
        configured.length === 1 &&
        physical.length === 1 &&
        isRecord(configured[0]) &&
        isRecord(physical[0])
      )
    ) {
      return policyRefusal("helper-mount-cardinality");
    }
    const requested = configured[0],
      observed = physical[0];
    if (target === "/hack-storage-witness-helper.mjs") {
      if (
        !(
          requested.Type === "bind" &&
          requested.Source === program &&
          configuredReadOnly(requested, true) &&
          isRecord(requested.BindOptions) &&
          requested.BindOptions.NonRecursive === true &&
          requested.BindOptions.Propagation === "rprivate" &&
          requested.BindOptions.CreateMountpoint !== true &&
          observed.Type === "bind" &&
          observed.Source === program &&
          observed.RW === false &&
          observed.Propagation === "rprivate"
        )
      ) {
        return policyRefusal("helper-program-mount");
      }
    } else if (
      !(
        requested.Type === "volume" &&
        requested.Source === input.target.name &&
        configuredReadOnly(requested, input.readonly) &&
        !Object.hasOwn(requested, "BindOptions") &&
        volumeOptionsRequestNoCopyOnly(requested.VolumeOptions)
      )
    ) {
      // Closed predicate groups keep the refusal value-free while identifying
      // whether the request, the observed identity or the observed mode differed.
      return policyRefusal("helper-storage-request");
    } else if (
      !(
        observed.Type === "volume" &&
        observed.Name === input.target.name &&
        observed.Source === input.target.mountpoint &&
        observed.Driver === "local"
      )
    ) {
      return policyRefusal("helper-storage-identity");
    } else if (
      !(observed.RW === !input.readonly && observed.Propagation === "")
    ) {
      return policyRefusal("helper-storage-mount");
    }
  }
  return value as NativeComposeStorageDockerCarrier;
}
/** Docker 28 engines echo an empty `DriverConfig` default beside `NoCopy`; Docker 29
 * omits it. Both describe the same no-copy request. Any other option, a named driver
 * or driver options refuse. */
function volumeOptionsRequestNoCopyOnly(options: unknown): boolean {
  if (!(isRecord(options) && options.NoCopy === true)) {
    return false;
  }
  for (const key of Object.keys(options)) {
    if (key === "NoCopy") {
      continue;
    }
    if (
      !(
        key === "DriverConfig" &&
        isRecord(options.DriverConfig) &&
        Object.keys(options.DriverConfig).length === 0
      )
    ) {
      return false;
    }
  }
  return true;
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
    return policyRefusal("helper-policy-stability");
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

/** A readonly stopped/created helper observation, never a command-settlement,
 * retirement or successful kernel-verification proof. */
export function checkNativeComposeStorageReadonlyCarrierRecovery(
  opts: Parameters<typeof checkNativeComposeStorageDockerCarrier>[0] & {
    readonly created: { readonly id: string; readonly createdAt: string };
  }
): NativeComposeStorageDockerCarrier {
  const carrier = checkNativeComposeStorageDockerCarrier(opts);
  const state = carrier.state;
  if (
    opts.input.readonly !== true ||
    opts.input.request.operation !== "verify" ||
    carrier.id !== opts.created.id ||
    carrier.createdAt !== opts.created.createdAt ||
    state.Running !== false ||
    state.Pid !== 0 ||
    (state.Status !== "created" && state.Status !== "exited") ||
    state.Paused !== false ||
    state.Restarting !== false ||
    state.OOMKilled !== false ||
    state.Dead !== false ||
    state.Error !== "" ||
    typeof state.ExitCode !== "number" ||
    !Number.isInteger(state.ExitCode) ||
    state.ExitCode < 0 ||
    state.ExitCode > 255 ||
    !isRecord(carrier.host) ||
    !isRecord(carrier.host.RestartPolicy) ||
    carrier.host.RestartPolicy.MaximumRetryCount !== 0
  ) {
    return refuse();
  }
  return carrier;
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
    `type=volume,src=${input.target.name},dst=/hack-storage-witness,volume-nocopy${input.readonly ? ",readonly" : ""}`,
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
    nativeComposeStorageDockerImageReference(input.artifact),
    "--no-env-file",
    "/hack-storage-witness-helper.mjs",
  ];
}
