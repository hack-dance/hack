import { isRecord } from "./guards.ts";
import {
  type NativeComposeFileAnchor,
  refuseNativeComposeFile,
} from "./native-compose-file-bytes.ts";
import type { NativeComposeMaterialBinding } from "./native-compose-generation.ts";
import { keys, parsePrivateJson } from "./native-compose-private-state.ts";
export const NATIVE_COMPOSE_FILE_STATE_LIMIT = 1024 * 1024;
export const NATIVE_COMPOSE_FILES_EXTENSION = "x-hack-native-files";
const TOKEN = /^[a-f0-9]{32}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const TARGET_FORBIDDEN = /[\\\0]/;
export type FileIdentity = { readonly dev: number; readonly ino: number };
export type StateAnchor = FileIdentity & { readonly digest: string };
export type NativeComposeFileReference = {
  readonly version: 1;
  readonly root: string;
  readonly rootToken: string;
  readonly rootDirectory: FileIdentity;
  readonly rootReceipt: StateAnchor;
  readonly snapshotToken: string;
  readonly snapshotDirectory: FileIdentity;
  readonly generationId: string;
  readonly manifest: StateAnchor;
};
export type NativeComposeFileMember = {
  readonly id: string;
  readonly workload: string;
  readonly target: string;
  readonly file: NativeComposeFileAnchor;
};
export type NativeComposeFileManifest = {
  readonly version: 1;
  readonly kind: "native-compose-file-material";
  readonly reference: Omit<NativeComposeFileReference, "manifest">;
  readonly creation: NativeComposeMaterialBinding;
  readonly journal: StateAnchor;
  readonly members: readonly NativeComposeFileMember[];
};
export type FileJournalRecord =
  | {
      readonly phase: "armed" | "reaped" | "retiring" | "rollback";
      readonly binding: NativeComposeMaterialBinding;
      readonly members: readonly string[];
    }
  | { readonly phase: "retired"; readonly intentDigest: string };
export type FileJournalState = {
  readonly armed: boolean;
  readonly reaped: boolean;
  readonly intent: Extract<
    FileJournalRecord,
    { readonly phase: "armed" | "reaped" | "retiring" | "rollback" }
  > | null;
  readonly retired: boolean;
};
export function freezeNativeComposeFileState(value: unknown): void {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) {
      freezeNativeComposeFileState(child);
    }
    Object.freeze(value);
  }
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])])
    );
  }
  return value;
}
export function sameNativeComposeFileState(
  left: unknown,
  right: unknown
): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}
function identity(value: unknown): value is FileIdentity {
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
function anchor(value: unknown): value is StateAnchor {
  return (
    isRecord(value) &&
    keys(value, "dev,digest,ino") &&
    identity({ dev: value.dev, ino: value.ino }) &&
    typeof value.digest === "string" &&
    DIGEST.test(value.digest)
  );
}
export function parseNativeComposeFileReference(
  value: unknown
): NativeComposeFileReference {
  if (
    !(
      isRecord(value) &&
      keys(
        value,
        "generationId,manifest,root,rootDirectory,rootReceipt,rootToken,snapshotDirectory,snapshotToken,version"
      ) &&
      value.version === 1 &&
      typeof value.root === "string" &&
      value.root.startsWith("/") &&
      typeof value.rootToken === "string" &&
      TOKEN.test(value.rootToken) &&
      typeof value.snapshotToken === "string" &&
      TOKEN.test(value.snapshotToken) &&
      typeof value.generationId === "string" &&
      TOKEN.test(value.generationId) &&
      identity(value.rootDirectory) &&
      identity(value.snapshotDirectory) &&
      anchor(value.rootReceipt) &&
      anchor(value.manifest)
    )
  ) {
    return refuseNativeComposeFile();
  }
  const result: NativeComposeFileReference = {
    version: 1,
    root: value.root,
    rootToken: value.rootToken,
    rootDirectory: value.rootDirectory,
    rootReceipt: value.rootReceipt,
    snapshotToken: value.snapshotToken,
    snapshotDirectory: value.snapshotDirectory,
    generationId: value.generationId,
    manifest: value.manifest,
  };
  freezeNativeComposeFileState(result);
  return result;
}
function fileAnchor(value: unknown): value is NativeComposeFileAnchor {
  return (
    isRecord(value) &&
    keys(value, "dev,digest,ino,mode,size") &&
    anchor({ dev: value.dev, ino: value.ino, digest: value.digest }) &&
    value.mode === 0o444 &&
    typeof value.size === "number" &&
    Number.isSafeInteger(value.size) &&
    value.size >= 0 &&
    value.size <= NATIVE_COMPOSE_FILE_STATE_LIMIT
  );
}
function member(value: unknown): value is NativeComposeFileMember {
  if (
    !(
      isRecord(value) &&
      keys(value, "file,id,target,workload") &&
      typeof value.id === "string" &&
      TOKEN.test(value.id) &&
      typeof value.workload === "string" &&
      NAME.test(value.workload) &&
      typeof value.target === "string" &&
      value.target.startsWith("/") &&
      value.target !== "/" &&
      !TARGET_FORBIDDEN.test(value.target) &&
      fileAnchor(value.file)
    )
  ) {
    return false;
  }
  return value.target
    .slice(1)
    .split("/")
    .every((part) => part !== "" && part !== "." && part !== "..");
}
function nullableToken(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && TOKEN.test(value));
}
function parseBinding(
  value: unknown,
  expected: NativeComposeMaterialBinding
): NativeComposeMaterialBinding {
  if (
    !(
      isRecord(value) &&
      keys(
        value,
        "checkout,currentGenerationId,documentHash,generation,generationId,identity,lease,pendingGenerationId,pendingToken,receipt"
      ) &&
      JSON.stringify(value.identity) === JSON.stringify(expected.identity) &&
      JSON.stringify(value.checkout) === JSON.stringify(expected.checkout) &&
      value.generationId === expected.generationId &&
      JSON.stringify(value.generation) ===
        JSON.stringify(expected.generation) &&
      value.documentHash === expected.documentHash &&
      isRecord(value.receipt) &&
      keys(value.receipt, "dev,hash,ino") &&
      anchor({
        dev: value.receipt.dev,
        ino: value.receipt.ino,
        digest: value.receipt.hash,
      }) &&
      isRecord(value.lease) &&
      keys(value.lease, "directory,owner,token") &&
      typeof value.lease.token === "string" &&
      TOKEN.test(value.lease.token) &&
      identity(value.lease.directory) &&
      identity(value.lease.owner) &&
      nullableToken(value.currentGenerationId) &&
      nullableToken(value.pendingGenerationId) &&
      nullableToken(value.pendingToken)
    )
  ) {
    return refuseNativeComposeFile();
  }
  const receipt = value.receipt;
  if (
    !(
      typeof receipt.dev === "number" &&
      typeof receipt.ino === "number" &&
      typeof receipt.hash === "string"
    )
  ) {
    return refuseNativeComposeFile();
  }
  return {
    ...expected,
    receipt: { dev: receipt.dev, ino: receipt.ino, hash: receipt.hash },
    lease: {
      token: value.lease.token,
      directory: value.lease.directory,
      owner: value.lease.owner,
    },
    currentGenerationId: value.currentGenerationId,
    pendingGenerationId: value.pendingGenerationId,
    pendingToken: value.pendingToken,
  };
}
/** Private records are selected only through an actual generation-bound reference, never by directory scanning. */
export function parseNativeComposeFileManifest(opts: {
  readonly text: string;
  readonly reference: NativeComposeFileReference;
  readonly binding: NativeComposeMaterialBinding;
}): NativeComposeFileManifest {
  const value = parsePrivateJson(opts.text);
  const { manifest: _, ...reference } = opts.reference;
  if (
    !(
      isRecord(value) &&
      keys(value, "creation,journal,kind,members,reference,version") &&
      value.version === 1 &&
      value.kind === "native-compose-file-material" &&
      sameNativeComposeFileState(value.reference, reference) &&
      isRecord(value.creation) &&
      JSON.stringify(value.creation.identity) ===
        JSON.stringify(opts.binding.identity) &&
      JSON.stringify(value.creation.checkout) ===
        JSON.stringify(opts.binding.checkout) &&
      value.creation.generationId === opts.binding.generationId &&
      value.creation.generation === null &&
      value.creation.documentHash === null &&
      anchor(value.journal) &&
      Array.isArray(value.members) &&
      value.members.every(member)
    )
  ) {
    return refuseNativeComposeFile();
  }
  const ids = new Set(value.members.map((entry) => entry.id));
  const targets = new Set(
    value.members.map((entry) => `${entry.workload}:${entry.target}`)
  );
  if (
    ids.size !== value.members.length ||
    targets.size !== value.members.length
  ) {
    return refuseNativeComposeFile();
  }
  // Creation bindings are produced by the same opaque authority. Saved identities
  // select immutable material; they never grant a live completion capability.
  const result: NativeComposeFileManifest = {
    version: 1,
    kind: "native-compose-file-material",
    reference,
    creation: parseBinding(value.creation, {
      ...opts.binding,
      generation: null,
      documentHash: null,
    }),
    journal: value.journal,
    members: value.members,
  };
  freezeNativeComposeFileState(result);
  return result;
}
function journalLines(text: string): readonly string[] {
  if (text === "") {
    return [];
  }
  const lines = text.slice(0, -1).split("\n");
  if (lines.some((line) => line === "")) {
    return refuseNativeComposeFile();
  }
  return lines;
}
function validRetiredRecord(
  value: Record<string, unknown>,
  intent: FileJournalState["intent"],
  digest: (text: string) => string
): boolean {
  return (
    intent !== null &&
    keys(value, "intentDigest,phase") &&
    value.intentDigest === digest(JSON.stringify(intent))
  );
}
type JournalOptions = {
  readonly text: string;
  readonly header: string;
  readonly manifest: NativeComposeFileManifest;
  readonly binding: NativeComposeMaterialBinding;
  readonly digest: (text: string) => string;
};
export function parseNativeComposeFileJournal(
  opts: JournalOptions
): FileJournalState {
  if (!(opts.text.startsWith(opts.header) && opts.text.endsWith("\n"))) {
    return refuseNativeComposeFile();
  }
  let state: FileJournalState = {
    armed: false,
    reaped: false,
    intent: null,
    retired: false,
  };
  for (const line of journalLines(opts.text.slice(opts.header.length))) {
    state = advanceJournal({ state, value: parsePrivateJson(line), opts });
  }
  return state;
}
function advanceJournal(input: {
  readonly state: FileJournalState;
  readonly value: unknown;
  readonly opts: JournalOptions;
}): FileJournalState {
  const { state, value, opts } = input;
  if (state.retired || !isRecord(value)) {
    return refuseNativeComposeFile();
  }
  if (value.phase === "retired") {
    if (!validRetiredRecord(value, state.intent, opts.digest)) {
      return refuseNativeComposeFile();
    }
    return { ...state, retired: true };
  }
  const record = parseIntent({
    value,
    manifest: opts.manifest,
    binding: opts.binding,
  });
  if (state.intent !== null) {
    return refuseNativeComposeFile();
  }
  switch (record.phase) {
    case "armed":
      if (state.armed) {
        return refuseNativeComposeFile();
      }
      return { ...state, armed: true };
    case "reaped":
      if (!state.armed || state.reaped) {
        return refuseNativeComposeFile();
      }
      return { ...state, reaped: true };
    case "rollback":
      if (state.armed) {
        return refuseNativeComposeFile();
      }
      return { ...state, intent: record };
    case "retiring":
      if (state.armed && !state.reaped) {
        return refuseNativeComposeFile();
      }
      return { ...state, intent: record };
    default:
      return refuseNativeComposeFile();
  }
}
function parseIntent(opts: {
  readonly value: Record<string, unknown>;
  readonly manifest: NativeComposeFileManifest;
  readonly binding: NativeComposeMaterialBinding;
}): Extract<
  FileJournalRecord,
  { readonly phase: "armed" | "reaped" | "retiring" | "rollback" }
> {
  const value = opts.value;
  if (
    !(
      keys(value, "binding,members,phase") &&
      intentPhase(value.phase) &&
      isRecord(value.binding) &&
      value.binding.generationId === opts.binding.generationId &&
      JSON.stringify(value.binding.identity) ===
        JSON.stringify(opts.binding.identity) &&
      JSON.stringify(value.binding.checkout) ===
        JSON.stringify(opts.binding.checkout) &&
      JSON.stringify(value.binding.generation) ===
        JSON.stringify(opts.binding.generation) &&
      value.binding.documentHash === opts.binding.documentHash &&
      JSON.stringify(value.members) ===
        JSON.stringify(opts.manifest.members.map((entry) => entry.id))
    )
  ) {
    return refuseNativeComposeFile();
  }
  const binding = parseBinding(value.binding, opts.binding);
  if (
    value.phase === "rollback"
      ? binding.pendingToken !== null || binding.generation !== null
      : binding.pendingToken === null
  ) {
    return refuseNativeComposeFile();
  }
  return {
    phase: value.phase,
    binding,
    members: opts.manifest.members.map((entry) => entry.id),
  };
}
function intentPhase(
  value: unknown
): value is "armed" | "reaped" | "retiring" | "rollback" {
  return (
    value === "armed" ||
    value === "reaped" ||
    value === "retiring" ||
    value === "rollback"
  );
}
