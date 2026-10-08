import { isRecord } from "./guards.ts";
import { keys } from "./native-compose-private-state.ts";
import {
  type NativeComposeRetainedVolume,
  nativeComposeRetainedVolumesValid,
} from "./native-compose-retained-storage.ts";

const HASH = /^[a-f0-9]{64}$/;
const TOKEN = /^[a-f0-9]{32}$/;
const ENGINE = /^[a-zA-Z0-9][a-zA-Z0-9:-]{0,127}$/;
type DirectoryAnchor = { readonly dev: number; readonly ino: number };
type Anchor = DirectoryAnchor & { readonly hash: string };
/** Private immutable extension references. Never include in a public DTO. */
export type NativeComposeStorageWitnessReference = {
  readonly version: 1;
  readonly volume: NativeComposeRetainedVolume;
  readonly root: DirectoryAnchor;
  readonly directory: DirectoryAnchor;
  readonly expectation: Anchor;
  readonly completion: Anchor;
};
/** Issued privately by the witness owner. An object copy cannot authorize receipt publication. */
export type NativeComposeStorageWitnessCompletionProof = Readonly<
  Record<never, never>
>;
export type NativeComposeStorageWitnessIntent = {
  readonly name: string;
  readonly storage: string;
  readonly engineId: string;
  readonly generationId: string;
  readonly pendingToken: string;
  readonly admission: "initial-create" | "explicit-adoption";
  readonly originalVolume: NativeComposeRetainedVolume | null;
};
/** Required v3 state: Expected survives every interruption; only this invocation can enroll. */
export type NativeComposeStorageWitnessState =
  NativeComposeStorageWitnessIntent &
    (
      | { readonly state: "expected" }
      | {
          readonly state: "enrolled";
          readonly reference: NativeComposeStorageWitnessReference;
        }
    );

function directoryValid(value: unknown): value is DirectoryAnchor {
  return (
    isRecord(value) &&
    keys(value, "dev,ino") &&
    typeof value.dev === "number" &&
    Number.isSafeInteger(value.dev) &&
    value.dev >= 0 &&
    typeof value.ino === "number" &&
    Number.isSafeInteger(value.ino) &&
    value.ino > 0
  );
}
function anchorValid(value: unknown): value is Anchor {
  if (!(isRecord(value) && keys(value, "dev,hash,ino"))) {
    return false;
  }
  return (
    directoryValid({ dev: value.dev, ino: value.ino }) &&
    typeof value.hash === "string" &&
    HASH.test(value.hash)
  );
}
export function nativeComposeStorageWitnessReferenceValid(
  value: unknown
): value is NativeComposeStorageWitnessReference {
  return (
    isRecord(value) &&
    keys(value, "completion,directory,expectation,root,version,volume") &&
    value.version === 1 &&
    nativeComposeRetainedVolumesValid([value.volume]) &&
    directoryValid(value.root) &&
    directoryValid(value.directory) &&
    anchorValid(value.expectation) &&
    anchorValid(value.completion)
  );
}
export function nativeComposeStorageWitnessIntentValid(
  value: unknown
): value is NativeComposeStorageWitnessIntent {
  if (
    !(
      isRecord(value) &&
      keys(
        value,
        "admission,engineId,generationId,name,originalVolume,pendingToken,storage"
      ) &&
      nativeComposeRetainedVolumesValid([
        {
          name: value.name,
          storage: value.storage,
          createdAt: "2000-01-01T00:00:00Z",
        },
      ]) &&
      typeof value.engineId === "string" &&
      ENGINE.test(value.engineId) &&
      typeof value.generationId === "string" &&
      TOKEN.test(value.generationId) &&
      typeof value.pendingToken === "string" &&
      TOKEN.test(value.pendingToken)
    )
  ) {
    return false;
  }
  if (value.admission === "initial-create") {
    return value.originalVolume === null;
  }
  return (
    value.admission === "explicit-adoption" &&
    nativeComposeRetainedVolumesValid([value.originalVolume]) &&
    isRecord(value.originalVolume) &&
    value.originalVolume.name === value.name &&
    value.originalVolume.storage === value.storage
  );
}
export function nativeComposeStorageWitnessStatesValid(
  value: unknown
): value is readonly NativeComposeStorageWitnessState[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) {
    return false;
  }
  const names = new Set<string>();
  let engineId: string | null = null;
  let previousName = "";
  for (const entry of value) {
    if (
      !(
        isRecord(entry) &&
        keys(
          entry,
          entry.state === "expected"
            ? "admission,engineId,generationId,name,originalVolume,pendingToken,state,storage"
            : "admission,engineId,generationId,name,originalVolume,pendingToken,reference,state,storage"
        )
      )
    ) {
      return false;
    }
    const { state, reference, ...intent } = entry;
    if (
      !nativeComposeStorageWitnessIntentValid(intent) ||
      names.has(intent.name) ||
      intent.name.localeCompare(previousName) <= 0 ||
      (engineId !== null && engineId !== intent.engineId)
    ) {
      return false;
    }
    names.add(intent.name);
    previousName = intent.name;
    engineId = intent.engineId;
    if (
      state !== "expected" &&
      !(
        state === "enrolled" &&
        nativeComposeStorageWitnessReferenceValid(reference) &&
        reference.volume.name === intent.name &&
        reference.volume.storage === intent.storage &&
        (intent.originalVolume === null ||
          reference.volume.createdAt === intent.originalVolume.createdAt)
      )
    ) {
      return false;
    }
  }
  return true;
}
