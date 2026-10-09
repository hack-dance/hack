import { createHash, randomBytes } from "node:crypto";
import { mkdir, opendir } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "./guards.ts";
import {
  armNativeComposeStorageWitnessIntent,
  assertNativeComposeMaterialAuthority,
  type NativeComposeGeneration,
  type NativeComposeMaterialAuthority,
  type NativeComposeMaterialBinding,
  publishNativeComposeStorageWitnessEnrollment,
  runNativeComposeMaterialAction,
} from "./native-compose-generation.ts";
import {
  type HeldDirectory,
  holdDirectory,
  keys,
  parsePrivateJson,
  privateDirectory,
  readPrivate,
  recheckDirectories,
  sameFile,
  writeExclusive,
} from "./native-compose-private-state.ts";
import {
  type NativeComposeRetainedVolume,
  nativeComposeRetainedVolumesValid,
} from "./native-compose-retained-storage.ts";
import {
  beginNativeComposeStorageCarrierIntent,
  initializeNativeComposeStorageCarrierJournal,
  type NativeComposeStorageReadonlyCarrierIntent,
  readNativeComposeStorageReadonlyCarrierIntent,
} from "./native-compose-storage-carrier-journal.ts";
import {
  encodeNativeComposeStorageWitnessArchive,
  type NativeComposeStorageWitnessMarker,
  nativeComposeStorageWitnessMarkerValid,
  refuseNativeComposeStorageWitness as refuse,
  verifyNativeComposeStorageWitnessArchive,
} from "./native-compose-storage-witness-codec.ts";

import {
  type NativeComposeStorageWitnessCompletionProof,
  type NativeComposeStorageWitnessReference,
  nativeComposeStorageWitnessReferenceValid,
} from "./native-compose-storage-witness-state.ts";
import {
  captureNativeComposeStorageXattrArtifact,
  checkNativeComposeStorageXattrCarrierLifetime,
  checkNativeComposeStorageXattrResult,
  checkNativeComposeStorageXattrTarget,
  type NativeComposeStorageXattrArtifact,
  type NativeComposeStorageXattrCarrier,
  type NativeComposeStorageXattrInvocation,
  type NativeComposeStorageXattrTarget,
  nativeComposeStorageXattrCarrierArtifact,
  nativeComposeStorageXattrCarrierPorts,
} from "./native-compose-storage-witness-xattr-carrier.ts";
import {
  createNativeComposeStorageXattrMarker,
  decodeNativeComposeStorageXattrRequest,
  type NativeComposeStorageXattrMarker,
  type NativeComposeStorageXattrRoot,
  nativeComposeStorageXattrRootValid,
  nativeComposeStorageXattrValueMatches,
  sameNativeComposeStorageXattrRoot,
} from "./native-compose-storage-witness-xattr-codec.ts";

export type { NativeComposeStorageWitnessReference } from "./native-compose-storage-witness-state.ts";

const LIMIT = 16 * 1024;
const SLOT_LIMIT = 4096;
const ENGINE = /^[a-zA-Z0-9][a-zA-Z0-9:-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;
const TOKEN = /^[a-f0-9]{32}$/;
type Anchor = {
  readonly dev: number;
  readonly ino: number;
  readonly hash: string;
};
type DirectoryAnchor = { readonly dev: number; readonly ino: number };
type Selection = { readonly name: string; readonly storage: string };
type Binding = Selection & {
  readonly engineId: string;
  readonly instanceId: string;
  readonly ownerToken: string;
  readonly generationId: string;
  readonly pendingToken: string;
};
type ExpectationBinding = {
  readonly binding: Binding;
  readonly admission: "initial-create" | "explicit-adoption";
  readonly originalVolume: NativeComposeRetainedVolume | null;
};
type XattrExpectation = ExpectationBinding & {
  readonly version: 3;
  readonly kind: "directory-xattr";
  readonly artifact: NativeComposeStorageXattrArtifact;
  readonly carrierJournalToken: string;
  readonly marker: NativeComposeStorageXattrMarker;
};
type Expectation = ExpectationBinding &
  (
    | {
        readonly version: 1;
        readonly marker: NativeComposeStorageWitnessMarker;
      }
    | XattrExpectation
  );
type CompletionBinding = {
  readonly expectationHash: string;
  readonly volume: NativeComposeRetainedVolume;
};
type KernelProof = {
  readonly root: NativeComposeStorageXattrRoot;
  readonly responseHash: string;
};
type Completion = CompletionBinding &
  (
    | { readonly version: 1 }
    | {
        readonly version: 3;
        readonly kind: "directory-xattr";
        readonly kernelProof: KernelProof;
      }
  );
export type NativeComposeStorageWitnessEnrollment = Readonly<
  Record<never, never>
>;
type Enrollment = {
  readonly authority: NativeComposeMaterialAuthority;
  readonly generation: NativeComposeGeneration;
  readonly phase: "effect" | "storage-create";
  readonly expectation: Expectation;
  readonly anchor: Anchor;
  readonly root: DirectoryAnchor;
  readonly directory: DirectoryAnchor;
  readonly assertAdmission: () => Promise<void>;
  readonly carrier?: NativeComposeStorageXattrCarrier;
  consumed: boolean;
};
const enrollments = new WeakMap<
  NativeComposeStorageWitnessEnrollment,
  Enrollment
>();
const completionProofs = new WeakMap<
  NativeComposeStorageWitnessCompletionProof,
  {
    readonly authority: NativeComposeMaterialAuthority;
    readonly generation: NativeComposeGeneration;
    readonly reference: NativeComposeStorageWitnessReference;
    readonly verify: () => Promise<void>;
    consumed: boolean;
  }
>();
/** Generation publication consumes an issued proof; arbitrary references or no-op callbacks cannot mint one. */
export function consumeNativeComposeStorageWitnessCompletionProof(opts: {
  readonly authority: NativeComposeMaterialAuthority;
  readonly generation: NativeComposeGeneration;
  readonly proof: NativeComposeStorageWitnessCompletionProof;
}): {
  readonly reference: NativeComposeStorageWitnessReference;
  readonly verify: () => Promise<void>;
} {
  const { authority, generation, proof } = opts;
  const issued = completionProofs.get(proof);
  if (
    !issued ||
    issued.consumed ||
    issued.authority !== authority ||
    issued.generation !== generation
  ) {
    return refuse();
  }
  issued.consumed = true;
  return Object.freeze({ reference: issued.reference, verify: issued.verify });
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
function anchor(read: {
  readonly info: { readonly dev: number; readonly ino: number };
  readonly text: string;
}): Anchor {
  return Object.freeze({
    dev: read.info.dev,
    ino: read.info.ino,
    hash: hash(read.text),
  });
}
function selectionValid(value: Selection): boolean {
  return nativeComposeRetainedVolumesValid([
    { ...value, createdAt: "2000-01-01T00:00:00Z" },
  ]);
}
function bindingValid(value: unknown): value is Binding {
  return (
    isRecord(value) &&
    keys(
      value,
      "engineId,generationId,instanceId,name,ownerToken,pendingToken,storage"
    ) &&
    typeof value.name === "string" &&
    typeof value.storage === "string" &&
    selectionValid({ name: value.name, storage: value.storage }) &&
    typeof value.engineId === "string" &&
    ENGINE.test(value.engineId) &&
    typeof value.instanceId === "string" &&
    HASH.test(value.instanceId) &&
    typeof value.ownerToken === "string" &&
    TOKEN.test(value.ownerToken) &&
    typeof value.generationId === "string" &&
    TOKEN.test(value.generationId) &&
    typeof value.pendingToken === "string" &&
    TOKEN.test(value.pendingToken)
  );
}
function expectationRecordValid(value: unknown): value is Record<
  string,
  unknown
> & {
  readonly binding: Binding;
  readonly marker: Record<string, unknown>;
} {
  return (
    isRecord(value) &&
    ((value.version === 1 &&
      keys(value, "admission,binding,marker,originalVolume,version")) ||
      (value.version === 3 &&
        value.kind === "directory-xattr" &&
        keys(
          value,
          "admission,artifact,binding,carrierJournalToken,kind,marker,originalVolume,version"
        ))) &&
    bindingValid(value.binding) &&
    isRecord(value.marker) &&
    (value.version === 1
      ? keys(value.marker, "name,token") &&
        typeof value.marker.name === "string" &&
        typeof value.marker.token === "string" &&
        nativeComposeStorageWitnessMarkerValid({
          name: value.marker.name,
          token: value.marker.token,
        })
      : keys(value.marker, "kind,name,valueHex,version")) &&
    (value.admission === "initial-create"
      ? value.originalVolume === null
      : value.admission === "explicit-adoption" &&
        nativeComposeRetainedVolumesValid([value.originalVolume]))
  );
}
function expectation(text: string): Expectation {
  const value = parsePrivateJson(text);
  if (!expectationRecordValid(value)) {
    return refuse();
  }
  const originalVolume =
    value.originalVolume === null ? null : parseVolume(value.originalVolume);
  if (
    originalVolume &&
    (originalVolume.name !== value.binding.name ||
      originalVolume.storage !== value.binding.storage)
  ) {
    return refuse();
  }
  const common: ExpectationBinding = {
    binding: value.binding,
    admission:
      value.admission === "initial-create"
        ? "initial-create"
        : "explicit-adoption",
    originalVolume,
  };
  if (value.version === 1) {
    if (
      typeof value.marker.name !== "string" ||
      typeof value.marker.token !== "string"
    ) {
      return refuse();
    }
    return {
      ...common,
      version: 1,
      marker: { name: value.marker.name, token: value.marker.token },
    };
  }
  const marker = decodeNativeComposeStorageXattrRequest({
    ...value.marker,
    operation: "verify",
    root: { device: "1", inode: "1", uid: 0, gid: 0 },
  });
  if (marker.operation === "root") {
    return refuse();
  }
  return {
    ...common,
    version: 3,
    kind: "directory-xattr",
    artifact: captureNativeComposeStorageXattrArtifact(value.artifact),
    carrierJournalToken:
      typeof value.carrierJournalToken === "string" &&
      TOKEN.test(value.carrierJournalToken)
        ? value.carrierJournalToken
        : refuse(),
    marker: {
      kind: marker.kind,
      version: marker.version,
      name: marker.name,
      valueHex: marker.valueHex,
    },
  };
}
function parseVolume(value: unknown): NativeComposeRetainedVolume {
  const entries = [value];
  if (!nativeComposeRetainedVolumesValid(entries)) {
    return refuse();
  }
  return Object.freeze({ ...(entries[0] ?? refuse()) });
}
function completion(text: string): Completion {
  const value = parsePrivateJson(text);
  if (
    !(
      isRecord(value) &&
      ((value.version === 1 && keys(value, "expectationHash,version,volume")) ||
        (value.version === 3 &&
          value.kind === "directory-xattr" &&
          keys(value, "expectationHash,kernelProof,kind,version,volume") &&
          isRecord(value.kernelProof) &&
          keys(value.kernelProof, "responseHash,root") &&
          nativeComposeStorageXattrRootValid(value.kernelProof.root) &&
          typeof value.kernelProof.responseHash === "string" &&
          HASH.test(value.kernelProof.responseHash))) &&
      typeof value.expectationHash === "string" &&
      HASH.test(value.expectationHash)
    )
  ) {
    return refuse();
  }
  const common: CompletionBinding = {
    expectationHash: value.expectationHash,
    volume: parseVolume(value.volume),
  };
  if (value.version === 1) {
    return { ...common, version: 1 };
  }
  if (
    !(
      isRecord(value.kernelProof) &&
      nativeComposeStorageXattrRootValid(value.kernelProof.root)
    ) ||
    typeof value.kernelProof.responseHash !== "string"
  ) {
    return refuse();
  }
  return {
    ...common,
    version: 3,
    kind: "directory-xattr",
    kernelProof: {
      root: { ...value.kernelProof.root },
      responseHash: value.kernelProof.responseHash,
    },
  };
}
function sameVolume(
  left: NativeComposeRetainedVolume,
  right: NativeComposeRetainedVolume
): boolean {
  return (
    left.name === right.name &&
    left.storage === right.storage &&
    left.createdAt === right.createdAt
  );
}
function matchesBinding(
  saved: Binding,
  current: NativeComposeMaterialBinding,
  engineId: string
): boolean {
  return (
    saved.engineId === engineId &&
    saved.instanceId === current.identity.instanceId &&
    saved.ownerToken === current.identity.ownerToken
  );
}
function matchesAdmission(
  saved: Binding,
  current: NativeComposeMaterialBinding
): boolean {
  return (
    matchesBinding(saved, current, saved.engineId) &&
    saved.generationId === current.generationId &&
    saved.pendingToken === current.pendingToken &&
    current.pendingGenerationId === saved.generationId
  );
}
type XattrCheck = () => Promise<NativeComposeMaterialBinding>;
function checkXattrArtifact(
  saved: XattrExpectation,
  carrier: NativeComposeStorageXattrCarrier
): void {
  checkNativeComposeStorageXattrCarrierLifetime(carrier);
  if (
    JSON.stringify(saved.artifact) !==
    JSON.stringify(nativeComposeStorageXattrCarrierArtifact(carrier))
  ) {
    refuse();
  }
}
async function inspectXattr(opts: {
  readonly carrier: NativeComposeStorageXattrCarrier;
  readonly saved: XattrExpectation;
  readonly stopped: boolean;
  readonly check: XattrCheck;
}): Promise<NativeComposeStorageXattrTarget> {
  checkXattrArtifact(opts.saved, opts.carrier);
  const before = await opts.check();
  checkNativeComposeStorageXattrCarrierLifetime(opts.carrier);
  const value = await nativeComposeStorageXattrCarrierPorts(
    opts.carrier
  ).inspect(
    Object.freeze({
      name: opts.saved.binding.name,
      storage: opts.saved.binding.storage,
    })
  );
  const current = await opts.check();
  checkNativeComposeStorageXattrCarrierLifetime(opts.carrier);
  if (JSON.stringify(before) !== JSON.stringify(current)) {
    return refuse();
  }
  return checkNativeComposeStorageXattrTarget({
    value,
    current,
    engineId: opts.saved.binding.engineId,
    selection: opts.saved.binding,
    stopped: opts.stopped,
  });
}
function requireXattrAdmission(
  saved: XattrExpectation,
  target: NativeComposeStorageXattrTarget
): void {
  if (saved.admission === "initial-create") {
    if (target.volume !== null) {
      refuse();
    }
  } else if (
    !(
      target.volume &&
      saved.originalVolume &&
      sameVolume(target.volume, saved.originalVolume)
    )
  ) {
    refuse();
  }
}
async function invokeXattr(opts: {
  readonly carrier: NativeComposeStorageXattrCarrier;
  readonly saved: XattrExpectation;
  readonly volume: NativeComposeRetainedVolume;
  readonly stopped: boolean;
  readonly check: XattrCheck;
  readonly journal: HeldDirectory;
  readonly request: Parameters<
    typeof decodeNativeComposeStorageXattrRequest
  >[0];
}) {
  const request = decodeNativeComposeStorageXattrRequest(opts.request);
  const target = await inspectXattr(opts);
  if (!(target.volume && sameVolume(target.volume, opts.volume))) {
    return refuse();
  }
  const current = await opts.check();
  checkNativeComposeStorageXattrCarrierLifetime(opts.carrier);
  const captured = Object.freeze({
    invocationId: randomBytes(16).toString("hex"),
    artifact: opts.saved.artifact,
    target,
    readonly: request.operation !== "seed",
    uid: request.operation === "root" ? 0 : request.root.uid,
    gid: request.operation === "root" ? 0 : request.root.gid,
    request,
    scope: Object.freeze({
      generationId: current.generationId,
      currentGenerationId: current.currentGenerationId,
      pendingGenerationId: current.pendingGenerationId,
      pendingToken: current.pendingToken,
    }),
  });
  const journal = await beginNativeComposeStorageCarrierIntent({
    directory: opts.journal,
    token: opts.saved.carrierJournalToken,
    check: opts.check,
    input: captured,
  });
  const beforeInvoke = await opts.check();
  checkNativeComposeStorageXattrCarrierLifetime(opts.carrier);
  if (JSON.stringify(current) !== JSON.stringify(beforeInvoke)) {
    return refuse();
  }
  const input: NativeComposeStorageXattrInvocation = Object.freeze({
    ...captured,
    recordCreated: journal.recordCreated,
  });
  const value = await nativeComposeStorageXattrCarrierPorts(
    opts.carrier
  ).invoke(input);
  const latest = await opts.check();
  checkNativeComposeStorageXattrCarrierLifetime(opts.carrier);
  if (JSON.stringify(current) !== JSON.stringify(latest)) {
    return refuse();
  }
  const result = checkNativeComposeStorageXattrResult({
    value,
    input,
    carrier: opts.carrier,
    current: latest,
  });
  const after = await inspectXattr(opts);
  if (JSON.stringify(after) !== JSON.stringify(target)) {
    return refuse();
  }
  await journal.complete(result.created);
  await opts.check();
  checkNativeComposeStorageXattrCarrierLifetime(opts.carrier);
  const expectedOutcome = (
    { root: "root", seed: "seeded", verify: "verified" } as const
  )[request.operation];
  if (result.response.outcome !== expectedOutcome) {
    return refuse();
  }
  if (
    request.operation !== "root" &&
    !sameNativeComposeStorageXattrRoot(result.response.root, request.root)
  ) {
    return refuse();
  }
  return result;
}
async function observeXattr(opts: {
  readonly carrier: NativeComposeStorageXattrCarrier;
  readonly saved: XattrExpectation;
  readonly volume: NativeComposeRetainedVolume;
  readonly stopped: boolean;
  readonly check: XattrCheck;
  readonly journal: HeldDirectory;
}): Promise<{
  readonly volume: NativeComposeRetainedVolume;
  readonly kernelProof: KernelProof;
}> {
  const discovered = await invokeXattr({
    ...opts,
    request: { kind: "directory-xattr", version: 1, operation: "root" },
  });
  if (discovered.response.outcome !== "root") {
    return refuse();
  }
  const proof = await invokeXattr({
    ...opts,
    request: {
      ...opts.saved.marker,
      operation: "verify",
      root: discovered.response.root,
    },
  });
  if (
    proof.response.outcome !== "verified" ||
    !nativeComposeStorageXattrValueMatches(
      Buffer.from(proof.response.valueHex, "hex"),
      opts.saved.marker.valueHex
    )
  ) {
    return refuse();
  }
  // A bind reader may retain an unlinked root across its await. Observe the current
  // namespace with another fresh non-creating carrier; Docker metadata alone cannot
  // detect a replacement which repeats both name and birth. This remains a finite fence.
  const after = await invokeXattr({
    ...opts,
    request: { kind: "directory-xattr", version: 1, operation: "root" },
  });
  if (
    after.response.outcome !== "root" ||
    !sameNativeComposeStorageXattrRoot(after.response.root, proof.response.root)
  ) {
    return refuse();
  }
  return {
    volume: opts.volume,
    kernelProof: {
      root: proof.response.root,
      responseHash: proof.responseHash,
    },
  };
}
async function seedXattr(opts: {
  readonly carrier: NativeComposeStorageXattrCarrier;
  readonly saved: XattrExpectation;
  readonly check: XattrCheck;
  readonly journal: HeldDirectory;
}): Promise<{
  readonly volume: NativeComposeRetainedVolume;
  readonly kernelProof: KernelProof;
}> {
  const initial = await inspectXattr({ ...opts, stopped: true });
  requireXattrAdmission(opts.saved, initial);
  if (opts.saved.admission === "initial-create") {
    const provision =
      nativeComposeStorageXattrCarrierPorts(opts.carrier).provision ?? refuse();
    const current = await opts.check();
    checkNativeComposeStorageXattrCarrierLifetime(opts.carrier);
    await provision(
      Object.freeze({
        name: opts.saved.binding.name,
        storage: opts.saved.binding.storage,
        engineId: opts.saved.binding.engineId,
        runtimeIdentity: current.identity.composeProject,
        ownerToken: opts.saved.binding.ownerToken,
      })
    );
    await opts.check();
    checkNativeComposeStorageXattrCarrierLifetime(opts.carrier);
  }
  const created = await inspectXattr({ ...opts, stopped: true });
  const volume = created.volume ?? refuse();
  if (
    opts.saved.originalVolume &&
    !sameVolume(volume, opts.saved.originalVolume)
  ) {
    return refuse();
  }
  const stopped = { ...opts, stopped: true, volume };
  const discovered = await invokeXattr({
    ...stopped,
    request: { kind: "directory-xattr", version: 1, operation: "root" },
  });
  if (discovered.response.outcome !== "root") {
    return refuse();
  }
  await invokeXattr({
    ...stopped,
    request: {
      ...opts.saved.marker,
      operation: "seed",
      root: discovered.response.root,
    },
  });
  return await observeXattr(stopped);
}
async function directories(opts: {
  readonly binding: NativeComposeMaterialBinding;
  readonly name: string;
  readonly create: boolean;
}): Promise<readonly HeldDirectory[]> {
  const held: HeldDirectory[] = [];
  try {
    const parent = await holdDirectory(
      join(
        opts.binding.identity.checkoutRoot,
        ".hack",
        ".internal",
        "native-compose",
        opts.binding.identity.instanceId
      ),
      true
    );
    held.push(parent);
    const rootPath = join(parent.path, "storage-witnesses");
    held.push(
      opts.create
        ? await privateDirectory(rootPath)
        : await holdDirectory(rootPath, true)
    );
    const count = await countSlots(rootPath);
    if (opts.create && count >= SLOT_LIMIT) {
      refuse();
    }
    if (opts.create) {
      await parent.file.sync();
    }
    const path = join(rootPath, hash(opts.name));
    if (opts.create) {
      // An interrupted/empty slot refuses too. No ordinary resume may recreate it.
      await mkdir(path, { mode: 0o700 });
      await held[1]?.file.sync();
    }
    held.push(await holdDirectory(path, true));
    if (opts.create) {
      await countSlots(rootPath);
    }
    await recheckDirectories(held);
    return held;
  } catch {
    await Promise.allSettled(held.map((directory) => directory.file.close()));
    return refuse();
  }
}
async function countSlots(path: string): Promise<number> {
  let count = 0;
  for await (const entry of await opendir(path)) {
    count++;
    if (count > SLOT_LIMIT || !entry.isDirectory() || !HASH.test(entry.name)) {
      refuse();
    }
  }
  return count;
}
async function close(held: readonly HeldDirectory[]) {
  await Promise.allSettled(held.map((directory) => directory.file.close()));
}
function last(held: readonly HeldDirectory[]): HeldDirectory {
  return held.at(-1) ?? refuse();
}
function directoryAnchor(directory: HeldDirectory): DirectoryAnchor {
  return Object.freeze({ dev: directory.info.dev, ino: directory.info.ino });
}
function checkDirectoryAnchors(
  held: readonly HeldDirectory[],
  selected: {
    readonly root: DirectoryAnchor;
    readonly directory: DirectoryAnchor;
  }
) {
  const root = held[1] ?? refuse();
  if (
    !(
      sameFile(root.info, selected.root) &&
      sameFile(last(held).info, selected.directory)
    )
  ) {
    refuse();
  }
}
async function checkedExpectation(
  held: readonly HeldDirectory[],
  expected: Anchor
) {
  const read = await readPrivate(
    join(last(held).path, "expectation.json"),
    LIMIT
  );
  if (!sameFile(read.info, expected) || hash(read.text) !== expected.hash) {
    return refuse();
  }
  await recheckDirectories(held);
  return expectation(read.text);
}

type EnrollmentObservation = {
  readonly volume: NativeComposeRetainedVolume;
  readonly archive?: Uint8Array;
  readonly kernelProof?: KernelProof;
};
async function observeEnrollment(opts: {
  readonly saved: Expectation;
  readonly carrier?: NativeComposeStorageXattrCarrier;
  readonly seed?: (archive: Uint8Array) => Promise<void>;
  readonly observe?: () => Promise<{
    readonly volume: NativeComposeRetainedVolume;
    readonly archive: Uint8Array;
  }>;
  readonly check: XattrCheck;
  readonly journal: HeldDirectory;
}): Promise<EnrollmentObservation> {
  const { saved, carrier, seed, observe, check } = opts;
  if (saved.version === 3) {
    if (seed || observe || !carrier) {
      return refuse();
    }
    return await seedXattr({ carrier, saved, check, journal: opts.journal });
  }
  if (!(seed && observe) || carrier) {
    return refuse();
  }
  await seed(encodeNativeComposeStorageWitnessArchive(saved.marker));
  const observed = await observe();
  verifyNativeComposeStorageWitnessArchive({
    marker: saved.marker,
    archive: observed.archive,
  });
  return observed;
}
function completionMatches(opts: {
  readonly record: Completion;
  readonly reference: NativeComposeStorageWitnessReference;
  readonly saved: Expectation;
}): boolean {
  const { record, reference, saved } = opts;
  return (
    record.version === reference.version &&
    record.expectationHash === reference.expectation.hash &&
    sameVolume(record.volume, reference.volume) &&
    (saved.originalVolume === null ||
      sameVolume(saved.originalVolume, record.volume)) &&
    record.volume.name === saved.binding.name &&
    record.volume.storage === saved.binding.storage
  );
}
function expectationMatchesReference(opts: {
  readonly saved: Expectation;
  readonly reference: NativeComposeStorageWitnessReference;
}): boolean {
  const { saved, reference } = opts;
  if (saved.version !== reference.version) {
    return false;
  }
  if (saved.version === 1) {
    return true;
  }
  return (
    reference.version === 3 &&
    saved.carrierJournalToken === reference.carrierJournalToken &&
    JSON.stringify(saved.artifact) ===
      JSON.stringify(
        captureNativeComposeStorageXattrArtifact(reference.artifact)
      )
  );
}

/**
 * Internal foundation: the CLI refuses witness-bearing workload admission until its carrier is qualified.
 * The owning generation mutation must prove a genuinely absent new volume or
 * explicit stopped adoption. It must publish a required new receipt version
 * before creating this extension; v1/v2 migration cannot establish past continuity.
 * Durable expectation precedes all provisioning. An existing slot is never reset.
 */
export async function prepareNativeComposeStorageWitness(opts: {
  readonly authority: NativeComposeMaterialAuthority;
  readonly generation: NativeComposeGeneration;
  readonly engineId: string;
  readonly volume: Selection;
  readonly admission: "initial-create" | "explicit-adoption";
  readonly originalVolume?: NativeComposeRetainedVolume;
  readonly assertAdmission: () => Promise<void>;
  /** Explicit internal xattr path; no CLI caller supplies this unactivated carrier. */
  readonly xattrCarrier?: NativeComposeStorageXattrCarrier;
}): Promise<NativeComposeStorageWitnessEnrollment> {
  const input = Object.freeze({
    ...opts,
    volume: Object.freeze({ ...opts.volume }),
    originalVolume: opts.originalVolume
      ? Object.freeze({ ...opts.originalVolume })
      : undefined,
  });
  const artifact = input.xattrCarrier
    ? nativeComposeStorageXattrCarrierArtifact(input.xattrCarrier)
    : null;
  // Initial xattr creation can use the original cold-run grant. Adoption and the
  // older archive carrier retain their existing startup-only effect authority.
  const phase =
    input.admission === "initial-create" && input.xattrCarrier
      ? "storage-create"
      : "effect";
  if (input.xattrCarrier) {
    checkNativeComposeStorageXattrCarrierLifetime(input.xattrCarrier);
  }
  return await runNativeComposeMaterialAction({
    authority: input.authority,
    run: async () => {
      const current = await assertNativeComposeMaterialAuthority({
        authority: input.authority,
        generation: input.generation,
        phase,
      });
      const binding: Binding = {
        ...input.volume,
        engineId: input.engineId,
        instanceId: current.identity.instanceId,
        ownerToken: current.identity.ownerToken,
        generationId: current.generationId,
        pendingToken: current.pendingToken ?? refuse(),
      };
      const common: ExpectationBinding = {
        binding,
        admission: input.admission,
        originalVolume: input.originalVolume ?? null,
      };
      const record: Expectation = artifact
        ? {
            ...common,
            version: 3,
            kind: "directory-xattr",
            artifact,
            carrierJournalToken: randomBytes(16).toString("hex"),
            marker: createNativeComposeStorageXattrMarker(),
          }
        : {
            ...common,
            version: 1,
            marker: {
              name: `.hack-storage-${randomBytes(32).toString("hex")}.witness`,
              token: randomBytes(32).toString("hex"),
            },
          };
      const text = JSON.stringify(record);
      expectation(text);
      if (!matchesAdmission(binding, current)) {
        return refuse();
      }
      await input.assertAdmission();
      if (input.xattrCarrier && record.version === 3) {
        const target = await inspectXattr({
          carrier: input.xattrCarrier,
          saved: record,
          stopped: true,
          check: async () => {
            const latest = await assertNativeComposeMaterialAuthority({
              authority: input.authority,
              generation: input.generation,
              phase,
            });
            if (!matchesAdmission(binding, latest)) {
              return refuse();
            }
            return latest;
          },
        });
        requireXattrAdmission(record, target);
      }
      const intent = {
        name: binding.name,
        storage: binding.storage,
        engineId: binding.engineId,
        generationId: binding.generationId,
        pendingToken: binding.pendingToken,
        admission: record.admission,
        originalVolume: record.originalVolume,
      };
      await armNativeComposeStorageWitnessIntent({
        authority: input.authority,
        generation: input.generation,
        intent:
          record.version === 3
            ? {
                ...intent,
                carrier: record.kind,
                artifact: record.artifact,
                carrierJournalToken: record.carrierJournalToken,
              }
            : intent,
      });
      const held = await directories({
        binding: current,
        name: binding.name,
        create: true,
      });
      try {
        const info = await writeExclusive(
          join(last(held).path, "expectation.json"),
          text
        ).catch(() => refuse());
        await last(held).file.sync();
        await recheckDirectories(held);
        const latest = await assertNativeComposeMaterialAuthority({
          authority: input.authority,
          generation: input.generation,
          phase,
        });
        if (!matchesAdmission(binding, latest)) {
          return refuse();
        }
        if (record.version === 3) {
          await initializeNativeComposeStorageCarrierJournal({
            directory: last(held),
            token: record.carrierJournalToken,
            check: async () => {
              await checkedExpectation(held, anchor({ info, text }));
              const live = await assertNativeComposeMaterialAuthority({
                authority: input.authority,
                generation: input.generation,
                phase,
              });
              if (!matchesAdmission(binding, live)) {
                return refuse();
              }
              if (input.xattrCarrier) {
                checkNativeComposeStorageXattrCarrierLifetime(
                  input.xattrCarrier
                );
              }
            },
          });
        }
        if (input.xattrCarrier) {
          checkNativeComposeStorageXattrCarrierLifetime(input.xattrCarrier);
        }
        const capability = Object.freeze({});
        enrollments.set(capability, {
          authority: input.authority,
          generation: input.generation,
          phase,
          expectation: record,
          anchor: anchor({ info, text }),
          root: directoryAnchor(held[1] ?? refuse()),
          directory: directoryAnchor(last(held)),
          assertAdmission: input.assertAdmission,
          carrier: input.xattrCarrier,
          consumed: false,
        });
        return capability;
      } finally {
        await close(held);
      }
    },
  }).catch(() => refuse());
}

/**
 * Consume before awaiting effects. The transport must refuse an existing marker
 * path and never follow/overwrite links; a tar archive itself is not O_EXCL.
 * Reopened, copied, failed or revoked capabilities cannot authorize another seed.
 * Missing completion after a crash remains uncertain, even if the marker exists.
 */
export async function enrollNativeComposeStorageWitness(opts: {
  readonly enrollment: NativeComposeStorageWitnessEnrollment;
  readonly seed?: (archive: Uint8Array) => Promise<void>;
  readonly observe?: () => Promise<{
    readonly volume: NativeComposeRetainedVolume;
    readonly archive: Uint8Array;
  }>;
}): Promise<NativeComposeStorageWitnessReference> {
  const { enrollment, seed, observe } = opts;
  const selected = enrollments.get(enrollment);
  if (!selected || selected.consumed) {
    return refuse();
  }
  selected.consumed = true;
  return await runNativeComposeMaterialAction({
    authority: selected.authority,
    run: async () => {
      const check = async () => {
        const binding = await assertNativeComposeMaterialAuthority({
          authority: selected.authority,
          generation: selected.generation,
          phase: selected.phase,
        });
        if (!matchesAdmission(selected.expectation.binding, binding)) {
          return refuse();
        }
        if (selected.carrier) {
          checkNativeComposeStorageXattrCarrierLifetime(selected.carrier);
        }
        return binding;
      };
      const held = await directories({
        binding: await check(),
        name: selected.expectation.binding.name,
        create: false,
      });
      try {
        checkDirectoryAnchors(held, selected);
        const saved = await checkedExpectation(held, selected.anchor);
        await selected.assertAdmission();
        await checkedExpectation(held, selected.anchor);
        await check();
        const live = async () => {
          await checkedExpectation(held, selected.anchor);
          return await check();
        };
        const observed = await observeEnrollment({
          saved,
          carrier: selected.carrier,
          seed,
          observe,
          check: live,
          journal: last(held),
        });
        const volume = parseVolume(observed.volume);
        if (
          volume.name !== saved.binding.name ||
          volume.storage !== saved.binding.storage ||
          (saved.originalVolume && !sameVolume(saved.originalVolume, volume))
        ) {
          return refuse();
        }
        await checkedExpectation(held, selected.anchor);
        await check();
        const completedRecord: Completion =
          saved.version === 1
            ? { version: 1, expectationHash: selected.anchor.hash, volume }
            : {
                version: 3,
                kind: "directory-xattr",
                expectationHash: selected.anchor.hash,
                volume,
                kernelProof: observed.kernelProof ?? refuse(),
              };
        const text = JSON.stringify(completedRecord);
        const info = await writeExclusive(
          join(last(held).path, "enrolled.json"),
          text
        ).catch(() => refuse());
        await last(held).file.sync();
        await recheckDirectories(held);
        await check();
        await checkedExpectation(held, selected.anchor);
        const completed = await readPrivate(
          join(last(held).path, "enrolled.json"),
          LIMIT
        );
        if (!sameFile(completed.info, info) || completed.text !== text) {
          return refuse();
        }
        await recheckDirectories(held);
        await check();
        const anchors = {
          volume: Object.freeze({ ...volume }),
          root: selected.root,
          directory: selected.directory,
          expectation: selected.anchor,
          completion: anchor({ info, text }),
        };
        const reference: NativeComposeStorageWitnessReference = Object.freeze(
          saved.version === 1
            ? { ...anchors, version: 1 as const }
            : {
                ...anchors,
                version: 3 as const,
                kind: "directory-xattr" as const,
                artifact: saved.artifact,
                carrierJournalToken: saved.carrierJournalToken,
              }
        );
        const proof = Object.freeze({});
        completionProofs.set(proof, {
          authority: selected.authority,
          generation: selected.generation,
          reference,
          consumed: false,
          verify: async () => {
            await verifyNativeComposeStorageWitness({
              authority: selected.authority,
              generation: selected.generation,
              engineId: saved.binding.engineId,
              reference,
              ...(saved.version === 1 && observe
                ? { observe: async () => await observe() }
                : { xattrCarrier: selected.carrier }),
            });
          },
        });
        await publishNativeComposeStorageWitnessEnrollment({
          authority: selected.authority,
          generation: selected.generation,
          proof,
        });
        return reference;
      } finally {
        await close(held);
      }
    },
  }).catch(() => refuse());
}

/** Read-only verification. No missing journal/marker, including interrupted enrollment, is seeded or repaired. */
export async function verifyNativeComposeStorageWitness(opts: {
  readonly authority: NativeComposeMaterialAuthority;
  readonly generation: NativeComposeGeneration;
  readonly engineId: string;
  readonly reference: NativeComposeStorageWitnessReference;
  readonly observe?: (markerName: string) => Promise<{
    readonly volume: NativeComposeRetainedVolume;
    readonly archive: Uint8Array;
  }>;
  readonly xattrCarrier?: NativeComposeStorageXattrCarrier;
}): Promise<void> {
  const { authority, generation, engineId, observe, xattrCarrier } = opts;
  if (!nativeComposeStorageWitnessReferenceValid(opts.reference)) {
    return refuse();
  }
  const reference = structuredClone(opts.reference);
  if (
    reference.version === 1
      ? !observe || xattrCarrier !== undefined
      : !xattrCarrier || observe !== undefined
  ) {
    return refuse();
  }
  if (
    reference.version === 3 &&
    xattrCarrier &&
    JSON.stringify(
      captureNativeComposeStorageXattrArtifact(reference.artifact)
    ) !== JSON.stringify(nativeComposeStorageXattrCarrierArtifact(xattrCarrier))
  ) {
    return refuse();
  }
  if (xattrCarrier) {
    checkNativeComposeStorageXattrCarrierLifetime(xattrCarrier);
  }
  return await runNativeComposeMaterialAction({
    authority,
    run: async () => {
      const current = await assertNativeComposeMaterialAuthority({
        authority,
        generation,
        phase: "inspect",
      });
      const held = await directories({
        binding: current,
        name: reference.volume.name,
        create: false,
      });
      try {
        checkDirectoryAnchors(held, reference);
        const saved = await checkedExpectation(held, reference.expectation);
        if (!expectationMatchesReference({ saved, reference })) {
          return refuse();
        }
        const readCompletion = async () => {
          const read = await readPrivate(
            join(last(held).path, "enrolled.json"),
            LIMIT
          );
          const record = completion(read.text);
          if (
            !sameFile(read.info, reference.completion) ||
            hash(read.text) !== reference.completion.hash ||
            !completionMatches({ record, reference, saved })
          ) {
            return refuse();
          }
        };
        await readCompletion();
        if (!matchesBinding(saved.binding, current, engineId)) {
          return refuse();
        }
        if (saved.version === 1) {
          if (!observe) {
            return refuse();
          }
          const observed = await observe(saved.marker.name);
          if (!sameVolume(parseVolume(observed.volume), reference.volume)) {
            return refuse();
          }
          verifyNativeComposeStorageWitnessArchive({
            marker: saved.marker,
            archive: observed.archive,
          });
        } else {
          if (!xattrCarrier) {
            return refuse();
          }
          await observeXattr({
            carrier: xattrCarrier,
            saved,
            volume: reference.volume,
            stopped: false,
            journal: last(held),
            check: async () => {
              await checkedExpectation(held, reference.expectation);
              await readCompletion();
              await recheckDirectories(held);
              const latest = await assertNativeComposeMaterialAuthority({
                authority,
                generation,
                phase: "inspect",
              });
              if (!matchesBinding(saved.binding, latest, engineId)) {
                return refuse();
              }
              return latest;
            },
          });
        }
        await checkedExpectation(held, reference.expectation);
        await readCompletion();
        await recheckDirectories(held);
        const latest = await assertNativeComposeMaterialAuthority({
          authority,
          generation,
          phase: "inspect",
        });
        if (!matchesBinding(saved.binding, latest, engineId)) {
          refuse();
        }
        if (xattrCarrier) {
          checkNativeComposeStorageXattrCarrierLifetime(xattrCarrier);
        }
      } finally {
        await close(held);
      }
    },
  }).catch(() => refuse());
}

/** Explicitly tagged, unactivated source-only xattr enrollment path. */
export async function prepareNativeComposeStorageXattrWitness(
  opts: Omit<
    Parameters<typeof prepareNativeComposeStorageWitness>[0],
    "xattrCarrier"
  > & {
    readonly carrier: NativeComposeStorageXattrCarrier;
  }
): Promise<NativeComposeStorageWitnessEnrollment> {
  const { carrier, ...input } = opts;
  return await prepareNativeComposeStorageWitness({
    ...input,
    xattrCarrier: carrier,
  });
}
export async function enrollNativeComposeStorageXattrWitness(opts: {
  readonly enrollment: NativeComposeStorageWitnessEnrollment;
}): Promise<NativeComposeStorageWitnessReference> {
  return await enrollNativeComposeStorageWitness({
    enrollment: opts.enrollment,
  });
}
export async function verifyNativeComposeStorageXattrWitness(
  opts: Omit<
    Parameters<typeof verifyNativeComposeStorageWitness>[0],
    "observe" | "xattrCarrier"
  > & {
    readonly carrier: NativeComposeStorageXattrCarrier;
  }
): Promise<void> {
  const { carrier, ...input } = opts;
  await verifyNativeComposeStorageWitness({ ...input, xattrCarrier: carrier });
}

/** Private saved observation seam. It never performs a kernel read, repairs an
 * expectation, enrolls storage or clears uncertain carrier work. The callback is
 * a trusted readonly transport, not a completion/retirement proof issuer. */
export async function observeNativeComposeStorageWitnessCarrier(opts: {
  readonly authority: NativeComposeMaterialAuthority;
  readonly generation: NativeComposeGeneration;
  readonly engineId: string;
  readonly reference: NativeComposeStorageWitnessReference;
  readonly observe: (input: {
    readonly intent: NativeComposeStorageReadonlyCarrierIntent;
    readonly request: ReturnType<typeof decodeNativeComposeStorageXattrRequest>;
    readonly assertUnchanged: () => Promise<void>;
  }) => Promise<"created" | "exited">;
}): Promise<{
  readonly kind: "readonly-verification-retained";
  readonly helperState: "created" | "exited";
  readonly hostCommandSettlement: "unknown";
}> {
  const { authority, generation, engineId, observe } = opts;
  if (
    !nativeComposeStorageWitnessReferenceValid(opts.reference) ||
    opts.reference.version !== 3 ||
    typeof observe !== "function"
  ) {
    return refuse();
  }
  const reference = structuredClone(opts.reference);
  return await runNativeComposeMaterialAction({
    authority,
    run: async () => {
      const current = await assertNativeComposeMaterialAuthority({
        authority,
        generation,
        phase: "storage-recovery-observe",
      });
      const held = await directories({
        binding: current,
        name: reference.volume.name,
        create: false,
      });
      try {
        checkDirectoryAnchors(held, reference);
        const saved = await checkedExpectation(held, reference.expectation);
        if (
          saved.version !== 3 ||
          !expectationMatchesReference({ saved, reference }) ||
          !matchesBinding(saved.binding, current, engineId)
        ) {
          return refuse();
        }
        const readCompletion = async () => {
          const read = await readPrivate(
            join(last(held).path, "enrolled.json"),
            LIMIT
          );
          const record = completion(read.text);
          if (
            record.version !== 3 ||
            !sameFile(read.info, reference.completion) ||
            hash(read.text) !== reference.completion.hash ||
            !completionMatches({ record, reference, saved })
          ) {
            return refuse();
          }
          return record;
        };
        const completed = await readCompletion();
        const check = async () => {
          await checkedExpectation(held, reference.expectation);
          await readCompletion();
          await recheckDirectories(held);
          const latest = await assertNativeComposeMaterialAuthority({
            authority,
            generation,
            phase: "storage-recovery-observe",
          });
          if (JSON.stringify(latest) !== JSON.stringify(current)) {
            return refuse();
          }
        };
        const selected = await readNativeComposeStorageReadonlyCarrierIntent({
          directory: last(held),
          token: saved.carrierJournalToken,
          check,
          current,
          engineId,
          volume: reference.volume,
          artifact: saved.artifact,
        });
        const request = decodeNativeComposeStorageXattrRequest({
          ...saved.marker,
          operation: "verify",
          root: completed.kernelProof.root,
        });
        if (
          selected.intent.uid !== completed.kernelProof.root.uid ||
          selected.intent.gid !== completed.kernelProof.root.gid
        ) {
          return refuse();
        }
        const helperState = await observe(
          Object.freeze({
            intent: selected.intent,
            request,
            assertUnchanged: selected.assertUnchanged,
          })
        );
        await selected.assertUnchanged();
        if (helperState !== "created" && helperState !== "exited") {
          return refuse();
        }
        return Object.freeze({
          kind: "readonly-verification-retained" as const,
          helperState,
          hostCommandSettlement: "unknown" as const,
        });
      } finally {
        await close(held);
      }
    },
  }).catch(() => refuse());
}
