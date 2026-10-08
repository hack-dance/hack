import { createHash, randomBytes } from "node:crypto";
import { mkdir, opendir } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "./guards.ts";
import {
  assertNativeComposeMaterialAuthority,
  type NativeComposeGeneration,
  type NativeComposeMaterialAuthority,
  type NativeComposeMaterialBinding,
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
  encodeNativeComposeStorageWitnessArchive,
  type NativeComposeStorageWitnessMarker,
  nativeComposeStorageWitnessMarkerValid,
  refuseNativeComposeStorageWitness as refuse,
  verifyNativeComposeStorageWitnessArchive,
} from "./native-compose-storage-witness-codec.ts";

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
type Expectation = {
  readonly version: 1;
  readonly binding: Binding;
  readonly admission: "initial-create" | "explicit-adoption";
  readonly originalVolume: NativeComposeRetainedVolume | null;
  readonly marker: NativeComposeStorageWitnessMarker;
};
type Completion = {
  readonly version: 1;
  readonly expectationHash: string;
  readonly volume: NativeComposeRetainedVolume;
};
/** Private receipt extension candidate. Existing v1/v2 receipts must never silently ignore it. */
export type NativeComposeStorageWitnessReference = {
  readonly version: 1;
  readonly volume: NativeComposeRetainedVolume;
  readonly root: DirectoryAnchor;
  readonly directory: DirectoryAnchor;
  readonly expectation: Anchor;
  readonly completion: Anchor;
};
export type NativeComposeStorageWitnessEnrollment = Readonly<
  Record<never, never>
>;
type Enrollment = {
  readonly authority: NativeComposeMaterialAuthority;
  readonly generation: NativeComposeGeneration;
  readonly expectation: Expectation;
  readonly anchor: Anchor;
  readonly root: DirectoryAnchor;
  readonly directory: DirectoryAnchor;
  readonly assertAdmission: () => Promise<void>;
  consumed: boolean;
};
const enrollments = new WeakMap<
  NativeComposeStorageWitnessEnrollment,
  Enrollment
>();

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
function anchorValid(value: unknown): value is Anchor {
  return (
    isRecord(value) &&
    keys(value, "dev,hash,ino") &&
    typeof value.dev === "number" &&
    Number.isSafeInteger(value.dev) &&
    value.dev >= 0 &&
    typeof value.ino === "number" &&
    Number.isSafeInteger(value.ino) &&
    value.ino > 0 &&
    typeof value.hash === "string" &&
    HASH.test(value.hash)
  );
}
function directoryAnchorValid(value: unknown): value is DirectoryAnchor {
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
function expectation(text: string): Expectation {
  const value = parsePrivateJson(text);
  if (
    !(
      isRecord(value) &&
      keys(value, "admission,binding,marker,originalVolume,version") &&
      value.version === 1 &&
      bindingValid(value.binding) &&
      isRecord(value.marker) &&
      keys(value.marker, "name,token") &&
      typeof value.marker.name === "string" &&
      typeof value.marker.token === "string" &&
      nativeComposeStorageWitnessMarkerValid({
        name: value.marker.name,
        token: value.marker.token,
      }) &&
      (value.admission === "initial-create"
        ? value.originalVolume === null
        : value.admission === "explicit-adoption" &&
          nativeComposeRetainedVolumesValid([value.originalVolume]))
    )
  ) {
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
  return {
    version: 1,
    binding: value.binding,
    admission:
      value.admission === "initial-create"
        ? "initial-create"
        : "explicit-adoption",
    originalVolume,
    marker: { name: value.marker.name, token: value.marker.token },
  };
}
function parseVolume(value: unknown): NativeComposeRetainedVolume {
  const entries = [value];
  if (!nativeComposeRetainedVolumesValid(entries)) {
    return refuse();
  }
  return entries[0] ?? refuse();
}
function completion(text: string): Completion {
  const value = parsePrivateJson(text);
  if (
    !(
      isRecord(value) &&
      keys(value, "expectationHash,version,volume") &&
      value.version === 1 &&
      typeof value.expectationHash === "string" &&
      HASH.test(value.expectationHash)
    )
  ) {
    return refuse();
  }
  return {
    version: 1,
    expectationHash: value.expectationHash,
    volume: parseVolume(value.volume),
  };
}
function referenceValid(value: NativeComposeStorageWitnessReference): boolean {
  return (
    isRecord(value) &&
    keys(value, "completion,directory,expectation,root,version,volume") &&
    value.version === 1 &&
    nativeComposeRetainedVolumesValid([value.volume]) &&
    directoryAnchorValid(value.root) &&
    directoryAnchorValid(value.directory) &&
    anchorValid(value.expectation) &&
    anchorValid(value.completion)
  );
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

/**
 * Foundation only: the CLI does not yet enroll or enforce these references.
 * The owning generation mutation must prove a genuinely absent new volume or
 * explicit stopped adoption. It must publish a required new receipt version
 * before using this extension; v1/v2 migration cannot establish past continuity.
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
}): Promise<NativeComposeStorageWitnessEnrollment> {
  const input = Object.freeze({
    ...opts,
    volume: Object.freeze({ ...opts.volume }),
    originalVolume: opts.originalVolume
      ? Object.freeze({ ...opts.originalVolume })
      : undefined,
  });
  return await runNativeComposeMaterialAction({
    authority: input.authority,
    run: async () => {
      const current = await assertNativeComposeMaterialAuthority({
        authority: input.authority,
        generation: input.generation,
        phase: "effect",
      });
      const binding: Binding = {
        ...input.volume,
        engineId: input.engineId,
        instanceId: current.identity.instanceId,
        ownerToken: current.identity.ownerToken,
        generationId: current.generationId,
        pendingToken: current.pendingToken ?? refuse(),
      };
      const record: Expectation = {
        version: 1,
        binding,
        admission: input.admission,
        originalVolume: input.originalVolume ?? null,
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
          phase: "effect",
        });
        if (!matchesAdmission(binding, latest)) {
          return refuse();
        }
        const capability = Object.freeze({});
        enrollments.set(capability, {
          authority: input.authority,
          generation: input.generation,
          expectation: record,
          anchor: anchor({ info, text }),
          root: directoryAnchor(held[1] ?? refuse()),
          directory: directoryAnchor(last(held)),
          assertAdmission: input.assertAdmission,
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
  readonly seed: (archive: Uint8Array) => Promise<void>;
  readonly observe: () => Promise<{
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
          phase: "effect",
        });
        if (!matchesAdmission(selected.expectation.binding, binding)) {
          return refuse();
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
        await seed(encodeNativeComposeStorageWitnessArchive(saved.marker));
        const observed = await observe();
        const volume = parseVolume(observed.volume);
        if (
          volume.name !== saved.binding.name ||
          volume.storage !== saved.binding.storage ||
          (saved.originalVolume && !sameVolume(saved.originalVolume, volume))
        ) {
          return refuse();
        }
        verifyNativeComposeStorageWitnessArchive({
          marker: saved.marker,
          archive: observed.archive,
        });
        await checkedExpectation(held, selected.anchor);
        await check();
        const text = JSON.stringify({
          version: 1,
          expectationHash: selected.anchor.hash,
          volume,
        } satisfies Completion);
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
        return Object.freeze({
          version: 1,
          volume: Object.freeze({ ...volume }),
          root: selected.root,
          directory: selected.directory,
          expectation: selected.anchor,
          completion: anchor({ info, text }),
        });
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
  readonly observe: (markerName: string) => Promise<{
    readonly volume: NativeComposeRetainedVolume;
    readonly archive: Uint8Array;
  }>;
}): Promise<void> {
  const { authority, generation, engineId, observe } = opts;
  if (!referenceValid(opts.reference)) {
    return refuse();
  }
  const reference = structuredClone(opts.reference);
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
        const readCompletion = async () => {
          const read = await readPrivate(
            join(last(held).path, "enrolled.json"),
            LIMIT
          );
          const record = completion(read.text);
          if (
            !sameFile(read.info, reference.completion) ||
            hash(read.text) !== reference.completion.hash ||
            record.expectationHash !== reference.expectation.hash ||
            !sameVolume(record.volume, reference.volume) ||
            (saved.originalVolume !== null &&
              !sameVolume(saved.originalVolume, record.volume)) ||
            record.volume.name !== saved.binding.name ||
            record.volume.storage !== saved.binding.storage
          ) {
            return refuse();
          }
        };
        await readCompletion();
        if (!matchesBinding(saved.binding, current, engineId)) {
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
      } finally {
        await close(held);
      }
    },
  }).catch(() => refuse());
}
