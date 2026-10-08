import { createHash } from "node:crypto";
import { isRecord } from "./guards.ts";
import type { NativeComposeMaterialBinding } from "./native-compose-generation.ts";
import { keys } from "./native-compose-private-state.ts";
import {
  type NativeComposeRetainedVolume,
  nativeComposeRetainedVolumesValid,
} from "./native-compose-retained-storage.ts";
import {
  type NativeComposeStorageXattrRequest,
  type NativeComposeStorageXattrResponse,
  parseNativeComposeStorageXattrResponse,
  refuseNativeComposeStorageXattr as refuse,
} from "./native-compose-storage-witness-xattr-codec.ts";

const HASH = /^[a-f0-9]{64}$/;
const TOKEN = /^[a-f0-9]{32}$/;
const IMAGE = /^sha256:[a-f0-9]{64}$/;
const ENGINE = /^[a-zA-Z0-9][a-zA-Z0-9:-]{0,127}$/;

/** Required private pins. A well-shaped pin is not an artifact/runtime qualification. */
export type NativeComposeStorageXattrArtifact = {
  readonly version: 1;
  readonly imageId: string;
  readonly platform: "linux/arm64" | "linux/amd64";
  readonly bunVersion: "1.4.2";
  readonly bunHash: string;
  readonly libcHash: string;
  readonly helperHash: string;
  readonly kernelAbi: 1;
};
export function nativeComposeStorageXattrArtifactValid(
  value: unknown
): value is NativeComposeStorageXattrArtifact {
  return (
    isRecord(value) &&
    keys(
      value,
      "bunHash,bunVersion,helperHash,imageId,kernelAbi,libcHash,platform,version"
    ) &&
    value.version === 1 &&
    value.kernelAbi === 1 &&
    value.bunVersion === "1.4.2" &&
    (value.platform === "linux/arm64" || value.platform === "linux/amd64") &&
    typeof value.imageId === "string" &&
    IMAGE.test(value.imageId) &&
    typeof value.bunHash === "string" &&
    HASH.test(value.bunHash) &&
    typeof value.libcHash === "string" &&
    HASH.test(value.libcHash) &&
    typeof value.helperHash === "string" &&
    HASH.test(value.helperHash)
  );
}
export function captureNativeComposeStorageXattrArtifact(
  value: unknown
): NativeComposeStorageXattrArtifact {
  if (!nativeComposeStorageXattrArtifactValid(value)) {
    return refuse();
  }
  return Object.freeze({
    version: 1,
    imageId: value.imageId,
    platform: value.platform,
    bunVersion: "1.4.2",
    bunHash: value.bunHash,
    libcHash: value.libcHash,
    helperHash: value.helperHash,
    kernelAbi: 1,
  });
}
type Holder = {
  readonly id: string;
  readonly runtimeIdentity: string;
  readonly ownerToken: string;
  readonly generationId: string;
  readonly running: boolean;
};
/** A complete selected-volume holder inventory, not merely project-label filtered containers. */
export type NativeComposeStorageXattrTarget = {
  readonly engineId: string;
  readonly runtimeIdentity: string;
  readonly ownerToken: string;
  readonly name: string;
  readonly storage: string;
  readonly volume: NativeComposeRetainedVolume | null;
  readonly mountpoint: string | null;
  readonly driver: "local" | null;
  readonly options: Readonly<Record<string, never>> | null;
  readonly holders: readonly Holder[];
};
export type NativeComposeStorageXattrInvocation = {
  /** Durably pin the exact created carrier before starting it; invocation intent already exists. */
  readonly recordCreated: (value: {
    readonly id: string;
    readonly createdAt: string;
  }) => Promise<void>;
  readonly invocationId: string;
  readonly artifact: NativeComposeStorageXattrArtifact;
  readonly target: NativeComposeStorageXattrTarget;
  readonly readonly: boolean;
  readonly uid: number;
  readonly gid: number;
  readonly request: NativeComposeStorageXattrRequest;
  readonly scope: {
    readonly generationId: string;
    readonly currentGenerationId: string | null;
    readonly pendingGenerationId: string | null;
    readonly pendingToken: string | null;
  };
};
/** Only a future qualified engine owner may implement these ports; the CLI supplies none. */
export type NativeComposeStorageXattrPorts = {
  readonly inspect: (selection: {
    readonly name: string;
    readonly storage: string;
  }) => Promise<unknown>;
  /** Exactly one original cold attempt. Idempotent create alone cannot establish admission. */
  readonly provision?: (selection: {
    readonly name: string;
    readonly storage: string;
    readonly engineId: string;
    readonly runtimeIdentity: string;
    readonly ownerToken: string;
  }) => Promise<void>;
  /** Fresh non-creating current-root mount; durable intent before effects and exact cleanup before return. */
  readonly invoke: (
    input: NativeComposeStorageXattrInvocation
  ) => Promise<unknown>;
};
export type NativeComposeStorageXattrCarrier = Readonly<Record<never, never>>;
type Captured = {
  readonly artifact: NativeComposeStorageXattrArtifact;
  readonly ports: NativeComposeStorageXattrPorts;
  readonly invocationIds: Set<string>;
  readonly carrierIds: Set<string>;
  readonly signal: AbortSignal;
  readonly deadline: number;
};
const carriers = new WeakMap<NativeComposeStorageXattrCarrier, Captured>();
/** Synchronous capture prevents later callback, scalar or artifact retargeting. It grants no effect authority. */
export function captureNativeComposeStorageXattrCarrier(opts: {
  readonly artifact: NativeComposeStorageXattrArtifact;
  readonly ports: NativeComposeStorageXattrPorts;
  readonly signal: AbortSignal;
  readonly deadline: number;
}): NativeComposeStorageXattrCarrier {
  const artifact = captureNativeComposeStorageXattrArtifact(opts.artifact);
  const { signal, deadline } = opts;
  if (
    !(signal instanceof AbortSignal && Number.isSafeInteger(deadline)) ||
    deadline <= Date.now()
  ) {
    return refuse();
  }
  const { inspect, provision, invoke } = opts.ports;
  if (
    typeof inspect !== "function" ||
    typeof invoke !== "function" ||
    (provision !== undefined && typeof provision !== "function")
  ) {
    return refuse();
  }
  const handle = Object.freeze({});
  carriers.set(handle, {
    artifact,
    ports: Object.freeze({ inspect, provision, invoke }),
    invocationIds: new Set(),
    carrierIds: new Set(),
    signal,
    deadline,
  });
  return handle;
}
function parts(handle: NativeComposeStorageXattrCarrier): Captured {
  return carriers.get(handle) ?? refuse();
}
export function nativeComposeStorageXattrCarrierArtifact(
  handle: NativeComposeStorageXattrCarrier
): NativeComposeStorageXattrArtifact {
  return parts(handle).artifact;
}
export function nativeComposeStorageXattrCarrierPorts(
  handle: NativeComposeStorageXattrCarrier
): NativeComposeStorageXattrPorts {
  return parts(handle).ports;
}
export function checkNativeComposeStorageXattrCarrierLifetime(
  handle: NativeComposeStorageXattrCarrier
): void {
  const { signal, deadline } = parts(handle);
  if (signal.aborted || deadline <= Date.now()) {
    refuse();
  }
}
export function checkNativeComposeStorageXattrTarget(opts: {
  readonly value: unknown;
  readonly current: NativeComposeMaterialBinding;
  readonly engineId: string;
  readonly selection: { readonly name: string; readonly storage: string };
  readonly stopped: boolean;
}): NativeComposeStorageXattrTarget {
  const { value, current, engineId, selection, stopped } = opts;
  if (
    !(
      isRecord(value) &&
      keys(
        value,
        "driver,engineId,holders,mountpoint,name,options,ownerToken,runtimeIdentity,storage,volume"
      ) &&
      typeof value.engineId === "string" &&
      ENGINE.test(value.engineId) &&
      value.engineId === engineId &&
      value.runtimeIdentity === current.identity.composeProject &&
      value.ownerToken === current.identity.ownerToken &&
      value.name === selection.name &&
      value.storage === selection.storage &&
      Array.isArray(value.holders) &&
      value.holders.length <= 256
    )
  ) {
    return refuse();
  }
  let volume: NativeComposeRetainedVolume | null = null;
  if (value.volume === null) {
    if (
      value.mountpoint !== null ||
      value.driver !== null ||
      value.options !== null ||
      value.holders.length !== 0
    ) {
      return refuse();
    }
  } else {
    if (
      !(
        nativeComposeRetainedVolumesValid([value.volume]) &&
        isRecord(value.volume) &&
        value.volume.name === selection.name &&
        value.volume.storage === selection.storage &&
        value.driver === "local" &&
        isRecord(value.options) &&
        keys(value.options, "") &&
        value.mountpoint === `/var/lib/docker/volumes/${selection.name}/_data`
      )
    ) {
      return refuse();
    }
    volume = Object.freeze({
      name: selection.name,
      storage: selection.storage,
      createdAt: String(value.volume.createdAt),
    });
  }
  const ids = new Set<string>();
  const holders = value.holders
    .map((holder: unknown): Holder => {
      if (
        !(
          isRecord(holder) &&
          keys(holder, "generationId,id,ownerToken,running,runtimeIdentity") &&
          typeof holder.id === "string" &&
          HASH.test(holder.id) &&
          !ids.has(holder.id) &&
          holder.runtimeIdentity === current.identity.composeProject &&
          holder.ownerToken === current.identity.ownerToken &&
          typeof holder.generationId === "string" &&
          TOKEN.test(holder.generationId) &&
          (holder.generationId === current.currentGenerationId ||
            holder.generationId === current.pendingGenerationId) &&
          typeof holder.running === "boolean" &&
          !(stopped && holder.running)
        )
      ) {
        return refuse();
      }
      ids.add(holder.id);
      return Object.freeze({
        id: holder.id,
        runtimeIdentity: current.identity.composeProject,
        ownerToken: current.identity.ownerToken,
        generationId: holder.generationId,
        running: holder.running,
      });
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  return Object.freeze({
    engineId,
    runtimeIdentity: current.identity.composeProject,
    ownerToken: current.identity.ownerToken,
    name: selection.name,
    storage: selection.storage,
    volume,
    mountpoint: volume
      ? `/var/lib/docker/volumes/${selection.name}/_data`
      : null,
    driver: volume ? "local" : null,
    options: volume ? Object.freeze({}) : null,
    holders: Object.freeze(holders),
  });
}
/** Validate the exact captured artifact, fresh invocation/current-root target and finite cleanup observations. */
export function checkNativeComposeStorageXattrResult(opts: {
  readonly value: unknown;
  readonly input: NativeComposeStorageXattrInvocation;
  readonly carrier: NativeComposeStorageXattrCarrier;
  readonly current: NativeComposeMaterialBinding;
}): {
  readonly response: NativeComposeStorageXattrResponse;
  readonly responseHash: string;
  readonly created: { readonly id: string; readonly createdAt: string };
} {
  const { value, input } = opts;
  const captured = parts(opts.carrier);
  if (
    !(
      isRecord(value) &&
      keys(
        value,
        "artifact,carrierCreatedAt,carrierId,containersAfterCleanup,engineId,exitCode,gid,invocationId,outcome,readonly,response,scope,stopped,target,uid"
      ) &&
      value.outcome === "complete" &&
      (value.exitCode === 0 || value.exitCode === 1) &&
      value.invocationId === input.invocationId &&
      TOKEN.test(input.invocationId) &&
      !captured.invocationIds.has(input.invocationId) &&
      typeof value.carrierId === "string" &&
      HASH.test(value.carrierId) &&
      !captured.carrierIds.has(value.carrierId) &&
      value.engineId === input.target.engineId &&
      value.readonly === input.readonly &&
      value.uid === input.uid &&
      value.gid === input.gid &&
      isRecord(value.scope) &&
      keys(
        value.scope,
        "currentGenerationId,generationId,pendingGenerationId,pendingToken"
      ) &&
      value.scope.generationId === input.scope.generationId &&
      value.scope.currentGenerationId === input.scope.currentGenerationId &&
      value.scope.pendingGenerationId === input.scope.pendingGenerationId &&
      value.scope.pendingToken === input.scope.pendingToken &&
      nativeComposeStorageXattrArtifactValid(value.artifact) &&
      JSON.stringify(
        captureNativeComposeStorageXattrArtifact(value.artifact)
      ) === JSON.stringify(captured.artifact) &&
      isRecord(value.stopped) &&
      keys(value.stopped, "exitCode,id,pid,running") &&
      value.stopped.id === value.carrierId &&
      value.stopped.running === false &&
      value.stopped.pid === 0 &&
      value.stopped.exitCode === value.exitCode &&
      nativeComposeRetainedVolumesValid([
        {
          name: "carrier",
          storage: "carrier",
          createdAt: value.carrierCreatedAt,
        },
      ]) &&
      Array.isArray(value.containersAfterCleanup) &&
      value.containersAfterCleanup.length === 0 &&
      typeof value.response === "string"
    )
  ) {
    return refuse();
  }
  const target = checkNativeComposeStorageXattrTarget({
    value: value.target,
    current: opts.current,
    engineId: input.target.engineId,
    selection: input.target,
    stopped: !input.readonly,
  });
  if (JSON.stringify(target) !== JSON.stringify(input.target)) {
    return refuse();
  }
  const response = parseNativeComposeStorageXattrResponse(value.response);
  if ((response.outcome === "refused") !== (value.exitCode === 1)) {
    return refuse();
  }
  captured.invocationIds.add(input.invocationId);
  captured.carrierIds.add(value.carrierId);
  return Object.freeze({
    response,
    created: Object.freeze({
      id: value.carrierId,
      createdAt: String(value.carrierCreatedAt),
    }),
    responseHash: createHash("sha256").update(value.response).digest("hex"),
  });
}
