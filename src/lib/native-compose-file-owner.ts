import { constants } from "node:fs";
import { type FileHandle, lstat, mkdir, open, unlink } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { isRecord } from "./guards.ts";
import {
  holdNativeComposeFile,
  nativeComposeFileDigest,
  refuseNativeComposeFile,
  writeNativeComposeFile,
} from "./native-compose-file-bytes.ts";
import { nativeComposeFileMode } from "./native-compose-file-permissions.ts";
import {
  assertNativeComposeFileSources,
  closeNativeComposeFileSources,
  type NativeComposeFileSources,
  withNativeComposeFileBytes,
} from "./native-compose-file-sources.ts";
import {
  type FileJournalRecord,
  freezeNativeComposeFileState,
  NATIVE_COMPOSE_FILE_STATE_LIMIT,
  NATIVE_COMPOSE_FILES_EXTENSION,
  type NativeComposeFileManifest,
  type NativeComposeFileMember,
  type NativeComposeFileReference,
  nativeComposeFileChildrenKnown,
  parseNativeComposeFileJournal,
  parseNativeComposeFileManifest,
  parseNativeComposeFileReference,
  type StateAnchor,
  sameNativeComposeFileState,
} from "./native-compose-file-state.ts";
import {
  assertNativeComposeMaterialAuthority,
  NATIVE_COMPOSE_DOCUMENT_LIMIT,
  type NativeComposeGeneration,
  type NativeComposeMaterialAuthority,
  type NativeComposeMaterialBinding,
  type NativeComposeReservation,
  runNativeComposeMaterialAction,
} from "./native-compose-generation.ts";
import {
  type HeldDirectory,
  hasCode,
  holdDirectory,
  keys,
  parsePrivateJson,
  privateDirectory,
  readPrivate,
  recheckDirectories,
  sameFile,
  token,
  writeExclusive,
} from "./native-compose-private-state.ts";

export type NativeComposeFileAttempt = Readonly<Record<never, never>>;
export type NativeComposeFileStopAttempt = Readonly<Record<never, never>>;
/** Private generated-document binds. Dollar signs are already encoded once for Compose. */
export type NativeComposeFileProjection = {
  readonly reference: NativeComposeFileReference;
  readonly workloads: Readonly<
    Record<
      string,
      readonly {
        readonly type: "bind";
        readonly source: string;
        readonly target: string;
        readonly read_only: true;
        readonly bind: { readonly create_host_path: false };
      }[]
    >
  >;
};
const projections = new WeakMap<
  NativeComposeFileProjection,
  {
    readonly reservation: NativeComposeReservation;
    readonly sources: NativeComposeFileSources;
    readonly active: () => boolean;
  }
>();
/** A caller-supplied path map cannot qualify private file delivery. This is not effect authority. */
export function nativeComposeFileProjectionMatches(opts: {
  readonly projection: NativeComposeFileProjection;
  readonly plan: unknown;
  readonly environmentPlan: unknown;
  readonly filePlan: unknown;
  readonly projectRoot: string;
  readonly runtimeIdentity: string;
  readonly ownerToken: string;
  readonly generationIdentity: string;
}): boolean {
  const selected = projections.get(opts.projection);
  return Boolean(
    selected?.active() &&
      selected.sources.result.plan === opts.plan &&
      selected.sources.result.environment_plan === opts.environmentPlan &&
      selected.sources.result.file_plan === opts.filePlan &&
      selected.reservation.identity.checkoutRoot === opts.projectRoot &&
      selected.reservation.identity.composeProject === opts.runtimeIdentity &&
      selected.reservation.identity.ownerToken === opts.ownerToken &&
      selected.reservation.generationId === opts.generationIdentity
  );
}
type Attempt = {
  readonly reservation: NativeComposeReservation;
  readonly sources: NativeComposeFileSources;
  readonly reference: NativeComposeFileReference;
};
type Snapshot = {
  readonly binding: NativeComposeMaterialBinding;
  readonly reference: NativeComposeFileReference;
  readonly manifest: NativeComposeFileManifest;
  readonly root: HeldDirectory;
  readonly parent: HeldDirectory;
  readonly directory: HeldDirectory;
  readonly path: string;
  readonly header: string;
  journal: {
    readonly text: string;
    readonly info: { readonly dev: number; readonly ino: number };
  };
  readonly check: () => Promise<void>;
  readonly close: () => Promise<void>;
};
function digest(text: string): string {
  return nativeComposeFileDigest(Buffer.from(text));
}
function anchored(
  text: string,
  info: { readonly dev: number; readonly ino: number }
): StateAnchor {
  return { dev: info.dev, ino: info.ino, digest: digest(text) };
}
function snapshotPath(reference: NativeComposeFileReference): string {
  return join(
    reference.root,
    `${reference.generationId}-${reference.snapshotToken}`
  );
}
function headerFor(
  reference: Pick<
    NativeComposeFileReference,
    "generationId" | "snapshotToken" | "version"
  >
): string {
  return `${JSON.stringify({ version: reference.version, kind: "native-compose-file-journal", generationId: reference.generationId, snapshotToken: reference.snapshotToken })}\n`;
}
function checkText(
  read: {
    readonly text: string;
    readonly info: { readonly dev: number; readonly ino: number };
  },
  anchor: StateAnchor
): void {
  if (
    read.info.dev !== anchor.dev ||
    read.info.ino !== anchor.ino ||
    digest(read.text) !== anchor.digest
  ) {
    refuseNativeComposeFile();
  }
}
async function pinPrivateMetadata(
  path: string,
  expected: { readonly dev: number; readonly ino: number }
): Promise<FileHandle> {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    const info = await file.stat();
    if (
      !(sameFile(info, expected) && info.isFile()) ||
      info.uid !== process.getuid?.() ||
      info.nlink !== 1 ||
      (info.mode & 0o777) !== 0o600
    ) {
      refuseNativeComposeFile();
    }
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}
function outsideCheckout(root: string, checkout: string): void {
  const offset = relative(checkout, root);
  if (
    root !== resolve(root) ||
    offset === "" ||
    !(offset.startsWith("../") || offset === "..")
  ) {
    refuseNativeComposeFile();
  }
}
const TOKEN = /^[a-f0-9]{32}$/;
function requireRootReceipt(
  read: Awaited<ReturnType<typeof readPrivate>>,
  held: HeldDirectory
): string {
  const value = parsePrivateJson(read.text);
  if (
    !(
      isRecord(value) &&
      keys(value, "directory,kind,token,version") &&
      value.version === 1 &&
      value.kind === "native-compose-file-root" &&
      isRecord(value.directory) &&
      keys(value.directory, "dev,ino") &&
      value.directory.dev === held.info.dev &&
      value.directory.ino === held.info.ino &&
      typeof value.token === "string" &&
      TOKEN.test(value.token)
    )
  ) {
    return refuseNativeComposeFile();
  }
  return value.token;
}
async function initializeRoot(root: string): Promise<{
  readonly root: HeldDirectory;
  readonly parent: HeldDirectory;
  readonly receipt: StateAnchor;
  readonly rootToken: string;
}> {
  const parent = await initializeRootParent(dirname(root));
  let held: HeldDirectory | undefined;
  try {
    let created = false;
    try {
      await mkdir(root, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (!hasCode(error, "EEXIST")) {
        throw error;
      }
    }
    held = await holdDirectory(root, true);
    if (created) {
      await writeExclusive(
        join(root, "owner.json"),
        JSON.stringify({
          version: 1,
          kind: "native-compose-file-root",
          token: token(),
          directory: { dev: held.info.dev, ino: held.info.ino },
        })
      );
      await held.file.sync();
      await parent.file.sync();
    }
    const receipt = await readPrivate(
      join(root, "owner.json"),
      NATIVE_COMPOSE_FILE_STATE_LIMIT
    );
    const rootToken = requireRootReceipt(receipt, held);
    await recheckDirectories([parent, held]);
    return {
      root: held,
      parent,
      receipt: anchored(receipt.text, receipt.info),
      rootToken,
    };
  } catch (error) {
    await held?.file.close();
    await parent.file.close();
    throw error;
  }
}

/** Create only the missing global-home leaf beneath a held owned parent. */
async function initializeRootParent(path: string): Promise<HeldDirectory> {
  try {
    await lstat(path);
    return await holdDirectory(path, false);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) {
      throw error;
    }
  }
  const ancestor = await holdDirectory(dirname(path), false);
  let held: HeldDirectory | undefined;
  try {
    await recheckDirectories([ancestor]);
    held = await privateDirectory(path);
    await recheckDirectories([ancestor, held]);
    await held.file.sync();
    await ancestor.file.sync();
    return held;
  } catch (error) {
    await held?.file.close();
    throw error;
  } finally {
    await ancestor.file.close();
  }
}
async function readOwnedDocument(
  generation: NativeComposeGeneration,
  binding: NativeComposeMaterialBinding
): Promise<Record<string, unknown>> {
  const read = await readPrivate(
    generation.composeFile,
    NATIVE_COMPOSE_DOCUMENT_LIMIT
  );
  if (digest(read.text) !== binding.documentHash) {
    return refuseNativeComposeFile();
  }
  const value = parsePrivateJson(read.text);
  if (!isRecord(value)) {
    return refuseNativeComposeFile();
  }
  return value;
}
function composeLiteral(value: string): string {
  return value.replaceAll("$", () => "$$");
}
/** Reject interpolation instead of interpreting caller environment in saved bind checks. */
function rawComposeLiteral(value: string): string {
  const raw = value.replaceAll("$$", () => "$");
  if (composeLiteral(raw) !== value) {
    return refuseNativeComposeFile();
  }
  return raw;
}
function projection(
  reference: NativeComposeFileReference,
  members: readonly NativeComposeFileMember[]
): NativeComposeFileProjection {
  const workloads: Record<
    string,
    {
      type: "bind";
      source: string;
      target: string;
      read_only: true;
      bind: { create_host_path: false };
    }[]
  > = {};
  for (const member of members) {
    const selected = workloads[member.workload] ?? [];
    selected.push({
      type: "bind",
      source: composeLiteral(join(snapshotPath(reference), member.id)),
      target: composeLiteral(member.target),
      read_only: true,
      bind: { create_host_path: false },
    });
    workloads[member.workload] = selected;
  }
  const result = { reference, workloads };
  freezeNativeComposeFileState(result);
  return result;
}
function assertDocumentProjection(
  document: Record<string, unknown>,
  reference: NativeComposeFileReference,
  members: readonly NativeComposeFileMember[]
): void {
  if (
    !isRecord(document.services) ||
    JSON.stringify(
      parseNativeComposeFileReference(document[NATIVE_COMPOSE_FILES_EXTENSION])
    ) !== JSON.stringify(reference)
  ) {
    refuseNativeComposeFile();
  }
  const expected = projection(reference, members).workloads;
  const matched = new Set<string>();
  for (const [name, service] of Object.entries(document.services)) {
    if (
      !isRecord(service) ||
      (service.volumes !== undefined && !Array.isArray(service.volumes))
    ) {
      refuseNativeComposeFile();
    }
    for (const volume of service.volumes ?? []) {
      matchVolume({
        volume,
        grants: expected[name] ?? [],
        root: reference.root,
        name,
        matched,
      });
    }
  }
  if (matched.size !== members.length) {
    refuseNativeComposeFile();
  }
}
function matchVolume(opts: {
  readonly volume: unknown;
  readonly grants: NativeComposeFileProjection["workloads"][string];
  readonly root: string;
  readonly name: string;
  readonly matched: Set<string>;
}): void {
  const volume = opts.volume;
  if (!isRecord(volume) || typeof volume.target !== "string") {
    refuseNativeComposeFile();
  }
  const target = volume.target;
  const grant = opts.grants.find((item) => item.target === target);
  if (grant) {
    if (
      !sameNativeComposeFileState(volume, grant) ||
      opts.matched.has(`${opts.name}:${grant.target}`)
    ) {
      refuseNativeComposeFile();
    }
    opts.matched.add(`${opts.name}:${grant.target}`);
    return;
  }
  const source =
    typeof volume.source === "string"
      ? rawComposeLiteral(volume.source)
      : undefined;
  const rawTarget = rawComposeLiteral(target);
  const ownedSource =
    source === opts.root || source?.startsWith(`${opts.root}/`);
  const overlaps = opts.grants.some((item) => {
    const grantedTarget = rawComposeLiteral(item.target);
    return (
      rawTarget === "/" ||
      grantedTarget.startsWith(`${rawTarget}/`) ||
      rawTarget.startsWith(`${grantedTarget}/`)
    );
  });
  if (ownedSource || overlaps) {
    refuseNativeComposeFile();
  }
}

function snapshotVersion(sources: NativeComposeFileSources): 1 | 2 {
  const plan = sources.result.file_plan;
  if (!plan?.complete) {
    return refuseNativeComposeFile();
  }
  let version: 1 | 2 = 1;
  for (const bindings of Object.values(plan.workloads)) {
    for (const binding of bindings) {
      const mode = nativeComposeFileMode(binding.mode);
      if (!mode) {
        return refuseNativeComposeFile();
      }
      if (mode !== "0444") {
        version = 2;
      }
    }
  }
  return version;
}
async function memberPresent(
  snapshot: Snapshot,
  member: NativeComposeFileMember
): Promise<boolean> {
  const path = join(snapshot.path, member.id);
  try {
    await lstat(path);
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
  const held = await holdNativeComposeFile({
    path,
    modes: [member.file.mode],
    limit: member.file.size,
  });
  try {
    if (JSON.stringify(held.anchor) !== JSON.stringify(member.file)) {
      return refuseNativeComposeFile();
    }
    await held.assertFresh();
    return true;
  } finally {
    await held.close();
  }
}
async function requireMembers(snapshot: Snapshot): Promise<void> {
  for (const member of snapshot.manifest.members) {
    if (!(await memberPresent(snapshot, member))) {
      refuseNativeComposeFile();
    }
  }
}
async function appendJournal(
  snapshot: Snapshot,
  record: FileJournalRecord
): Promise<void> {
  await snapshot.check();
  const path = join(snapshot.path, "journal.jsonl");
  const file = await open(
    path,
    constants.O_WRONLY |
      constants.O_APPEND |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK
  );
  try {
    if (!sameFile(await file.stat(), snapshot.manifest.journal)) {
      refuseNativeComposeFile();
    }
    const addition = `${JSON.stringify(record)}\n`;
    if (
      Buffer.byteLength(snapshot.journal.text) + Buffer.byteLength(addition) >
      NATIVE_COMPOSE_FILE_STATE_LIMIT
    ) {
      refuseNativeComposeFile();
    }
    await file.writeFile(addition);
    await file.sync();
    await snapshot.directory.file.sync();
    const next = await readPrivate(path, NATIVE_COMPOSE_FILE_STATE_LIMIT);
    if (
      !sameFile(next.info, snapshot.manifest.journal) ||
      next.text !== snapshot.journal.text + addition
    ) {
      refuseNativeComposeFile();
    }
    snapshot.journal = next;
    await snapshot.check();
  } finally {
    await file.close();
  }
}
function journalState(snapshot: Snapshot) {
  return parseNativeComposeFileJournal({
    text: snapshot.journal.text,
    header: snapshot.header,
    manifest: snapshot.manifest,
    binding: snapshot.binding,
    digest,
  });
}

async function retireMembers(opts: {
  readonly snapshot: Snapshot;
  readonly retired: boolean;
  readonly proveAbsent: () => Promise<void>;
  readonly afterMemberUnlink?: () => Promise<void>;
}): Promise<void> {
  for (const member of opts.snapshot.manifest.members) {
    await opts.proveAbsent();
    if (!(await memberPresent(opts.snapshot, member))) {
      continue;
    }
    if (opts.retired) {
      refuseNativeComposeFile();
    }
    await opts.proveAbsent();
    if (!(await memberPresent(opts.snapshot, member))) {
      refuseNativeComposeFile();
    }
    await unlink(join(opts.snapshot.path, member.id));
    await opts.afterMemberUnlink?.();
    await opts.snapshot.directory.file.sync();
    await opts.proveAbsent();
  }
}
/**
 * Filesystem material owner. The generation
 * mutation is its only authority; saved documents supply exact immutable references.
 * No acquisition/recovery scans or reconstructs orphan snapshots. Close retains data.
 */
export function createNativeComposeFileOwner(opts: {
  readonly root: string;
  readonly authority: NativeComposeMaterialAuthority;
  /** Failure seam after an individual unlink and before its directory sync. It cannot suppress guards. */
  readonly afterMemberUnlink?: () => Promise<void>;
}) {
  const root = resolve(opts.root);
  const authority = opts.authority;
  const afterMemberUnlink = opts.afterMemberUnlink;
  const attempts = new WeakMap<NativeComposeFileAttempt, Attempt>();
  const ownedSources = new Set<NativeComposeFileSources>();
  let active = true;
  const checkAuthority = async (
    selection: Parameters<typeof assertNativeComposeMaterialAuthority>[0]
  ) => {
    if (!active) {
      return refuseNativeComposeFile();
    }
    const binding = await assertNativeComposeMaterialAuthority(selection);
    outsideCheckout(root, binding.identity.checkoutRoot);
    return binding;
  };
  const run = <T>(action: () => Promise<T>): Promise<T> =>
    runNativeComposeMaterialAction({
      authority,
      run: async () => {
        try {
          return await action();
        } catch {
          return refuseNativeComposeFile();
        }
      },
    });
  const openSnapshot = async (input: {
    readonly selection: Parameters<
      typeof assertNativeComposeMaterialAuthority
    >[0];
    readonly reference: NativeComposeFileReference;
  }): Promise<Snapshot> => {
    const binding = await checkAuthority(input.selection);
    const reference = parseNativeComposeFileReference(input.reference);
    if (
      reference.root !== root ||
      reference.generationId !== binding.generationId
    ) {
      return refuseNativeComposeFile();
    }
    const parent = await holdDirectory(dirname(root), false);
    const held: HeldDirectory[] = [parent];
    const metadata: FileHandle[] = [];
    try {
      const rootDirectory = await holdDirectory(root, true);
      held.push(rootDirectory);
      const path = snapshotPath(reference);
      const directory = await holdDirectory(path, true);
      held.push(directory);
      if (
        !(
          sameFile(rootDirectory.info, reference.rootDirectory) &&
          sameFile(directory.info, reference.snapshotDirectory)
        )
      ) {
        return refuseNativeComposeFile();
      }
      const ownerRead = await readPrivate(
        join(root, "owner.json"),
        NATIVE_COMPOSE_FILE_STATE_LIMIT
      );
      checkText(ownerRead, reference.rootReceipt);
      metadata.push(
        await pinPrivateMetadata(
          join(root, "owner.json"),
          reference.rootReceipt
        )
      );
      if (
        requireRootReceipt(ownerRead, rootDirectory) !== reference.rootToken
      ) {
        return refuseNativeComposeFile();
      }
      const manifestRead = await readPrivate(
        join(path, "manifest.json"),
        NATIVE_COMPOSE_FILE_STATE_LIMIT
      );
      checkText(manifestRead, reference.manifest);
      metadata.push(
        await pinPrivateMetadata(
          join(path, "manifest.json"),
          reference.manifest
        )
      );
      const manifest = parseNativeComposeFileManifest({
        text: manifestRead.text,
        reference,
        binding,
      });
      const header = headerFor(reference);
      if (digest(header) !== manifest.journal.digest) {
        return refuseNativeComposeFile();
      }
      const journal = await readPrivate(
        join(path, "journal.jsonl"),
        NATIVE_COMPOSE_FILE_STATE_LIMIT
      );
      if (!sameFile(journal.info, manifest.journal)) {
        return refuseNativeComposeFile();
      }
      metadata.push(
        await pinPrivateMetadata(join(path, "journal.jsonl"), manifest.journal)
      );
      const snapshot: Snapshot = {
        binding,
        reference,
        manifest,
        root: rootDirectory,
        parent,
        directory,
        path,
        header,
        journal,
        async check() {
          const current = await checkAuthority(input.selection);
          if (JSON.stringify(current) !== JSON.stringify(binding)) {
            refuseNativeComposeFile();
          }
          await recheckDirectories(held);
          checkText(
            await readPrivate(
              join(root, "owner.json"),
              NATIVE_COMPOSE_FILE_STATE_LIMIT
            ),
            reference.rootReceipt
          );
          checkText(
            await readPrivate(
              join(path, "manifest.json"),
              NATIVE_COMPOSE_FILE_STATE_LIMIT
            ),
            reference.manifest
          );
          const latest = await readPrivate(
            join(path, "journal.jsonl"),
            NATIVE_COMPOSE_FILE_STATE_LIMIT
          );
          if (
            !sameFile(latest.info, manifest.journal) ||
            latest.text !== snapshot.journal.text
          ) {
            refuseNativeComposeFile();
          }
          await checkAuthority(input.selection);
        },
        async close() {
          await Promise.allSettled(
            [...held.map((item) => item.file), ...metadata].map((file) =>
              file.close()
            )
          );
        },
      };
      journalState(snapshot);
      await snapshot.check();
      return snapshot;
    } catch (error) {
      await Promise.allSettled(
        [...held.map((item) => item.file), ...metadata].map((file) =>
          file.close()
        )
      );
      throw error;
    }
  };
  const savedSnapshot = async (
    generation: NativeComposeGeneration,
    phase: "inspect" | "effect" | "stop" | "retire"
  ) => {
    const selection = { authority, generation, phase };
    const binding = await checkAuthority(selection);
    const document = await readOwnedDocument(generation, binding);
    const reference = parseNativeComposeFileReference(
      document[NATIVE_COMPOSE_FILES_EXTENSION]
    );
    const snapshot = await openSnapshot({ selection, reference });
    try {
      assertDocumentProjection(document, reference, snapshot.manifest.members);
      await snapshot.check();
      return snapshot;
    } catch (error) {
      await snapshot.close();
      throw error;
    }
  };
  const stops = new WeakMap<
    NativeComposeFileStopAttempt,
    {
      readonly generation: NativeComposeGeneration;
      readonly binding: NativeComposeMaterialBinding;
      readonly reference: NativeComposeFileReference;
    }
  >();
  return Object.freeze({
    /** A prior unknown stop child is never adopted by a later stop. Returning null
     * still permits owned engine stop, but cannot authorize material retirement. */
    async armStop(
      generation: NativeComposeGeneration
    ): Promise<NativeComposeFileStopAttempt | null> {
      return await run(async () => {
        const snapshot = await savedSnapshot(generation, "stop");
        try {
          const state = journalState(snapshot);
          if (state.stopBinding !== null && !state.stopReaped) {
            return null;
          }
          await appendJournal(snapshot, {
            phase: "stop-armed",
            binding: snapshot.binding,
            members: snapshot.manifest.members.map((member) => member.id),
          });
          const attempt = Object.freeze({});
          stops.set(attempt, {
            generation,
            binding: snapshot.binding,
            reference: snapshot.reference,
          });
          return attempt;
        } finally {
          await snapshot.close();
        }
      });
    },
    async recordStopReaped(input: {
      readonly attempt: NativeComposeFileStopAttempt;
      readonly assertReaped: () => Promise<void>;
    }): Promise<void> {
      const { attempt, assertReaped } = input;
      await run(async () => {
        const selected = stops.get(attempt);
        if (!selected) {
          refuseNativeComposeFile();
        }
        const snapshot = await savedSnapshot(selected.generation, "stop");
        try {
          const state = journalState(snapshot);
          if (
            state.stopReaped ||
            !sameNativeComposeFileState(state.stopBinding, selected.binding) ||
            !sameNativeComposeFileState(snapshot.binding, selected.binding) ||
            !sameNativeComposeFileState(snapshot.reference, selected.reference)
          ) {
            refuseNativeComposeFile();
          }
          await snapshot.check();
          await assertReaped();
          await snapshot.check();
          await appendJournal(snapshot, {
            phase: "stop-reaped",
            binding: snapshot.binding,
            members: snapshot.manifest.members.map((member) => member.id),
          });
          stops.delete(attempt);
        } finally {
          await snapshot.close();
        }
      });
    },
    async prepare(input: {
      readonly reservation: NativeComposeReservation;
      readonly sources: NativeComposeFileSources;
    }): Promise<NativeComposeFileAttempt> {
      const reservation = input.reservation;
      const sources = input.sources;
      return await run(async () => {
        const selection = { authority, reservation, phase: "prepare" as const };
        const binding = await checkAuthority(selection);
        await assertNativeComposeFileSources({
          authority,
          reservation,
          sources,
        });
        const version = snapshotVersion(sources);
        const initialized = await initializeRoot(root);
        let directory: HeldDirectory | undefined;
        try {
          await checkAuthority(selection);
          const snapshotToken = token();
          const base = {
            version,
            root,
            rootToken: initialized.rootToken,
            rootDirectory: {
              dev: initialized.root.info.dev,
              ino: initialized.root.info.ino,
            },
            rootReceipt: initialized.receipt,
            snapshotToken,
            generationId: reservation.generationId,
          };
          const path = join(
            root,
            `${reservation.generationId}-${snapshotToken}`
          );
          await mkdir(path, { mode: 0o700 });
          directory = await holdDirectory(path, true);
          const snapshotDirectory = {
            dev: directory.info.dev,
            ino: directory.info.ino,
          };
          const members: NativeComposeFileMember[] = [];
          await withNativeComposeFileBytes({
            authority,
            reservation,
            sources,
            run: async (acquired) => {
              for (const member of acquired) {
                await checkAuthority(selection);
                await recheckDirectories([
                  initialized.parent,
                  initialized.root,
                  ...(directory ? [directory] : []),
                ]);
                const id = token();
                const mode = nativeComposeFileMode(member.binding.mode);
                if (!mode) {
                  return refuseNativeComposeFile();
                }
                const file = await writeNativeComposeFile({
                  path: join(path, id),
                  bytes: member.bytes,
                  mode,
                });
                members.push({
                  id,
                  workload: member.workload,
                  target: member.binding.target,
                  file,
                });
                await checkAuthority(selection);
              }
            },
          });
          const referenceBase = { ...base, snapshotDirectory };
          const header = headerFor(referenceBase);
          const journalInfo = await writeExclusive(
            join(path, "journal.jsonl"),
            header
          );
          const manifest: NativeComposeFileManifest = {
            version,
            kind: "native-compose-file-material",
            reference: referenceBase,
            creation: binding,
            journal: anchored(header, journalInfo),
            members,
          };
          const text = JSON.stringify(manifest);
          if (Buffer.byteLength(text) > NATIVE_COMPOSE_FILE_STATE_LIMIT) {
            refuseNativeComposeFile();
          }
          const manifestInfo = await writeExclusive(
            join(path, "manifest.json"),
            text
          );
          await directory.file.sync();
          await initialized.root.file.sync();
          await assertNativeComposeFileSources({
            authority,
            reservation,
            sources,
          });
          await checkAuthority(selection);
          const reference = parseNativeComposeFileReference({
            ...referenceBase,
            manifest: anchored(text, manifestInfo),
          });
          const attempt = Object.freeze({});
          attempts.set(attempt, { reservation, sources, reference });
          ownedSources.add(sources);
          return attempt;
        } finally {
          await directory?.file.close();
          await initialized.root.file.close();
          await initialized.parent.file.close();
        }
      });
    },
    async projection(
      attempt: NativeComposeFileAttempt
    ): Promise<NativeComposeFileProjection> {
      return await run(async () => {
        const selected = attempts.get(attempt);
        if (!selected) {
          return refuseNativeComposeFile();
        }
        const snapshot = await openSnapshot({
          selection: {
            authority,
            reservation: selected.reservation,
            phase: "prepare",
          },
          reference: selected.reference,
        });
        try {
          await requireMembers(snapshot);
          await assertNativeComposeFileSources({
            authority,
            reservation: selected.reservation,
            sources: selected.sources,
          });
          const result = projection(
            selected.reference,
            snapshot.manifest.members
          );
          projections.set(result, {
            reservation: selected.reservation,
            sources: selected.sources,
            active: () => active,
          });
          return result;
        } finally {
          await snapshot.close();
        }
      });
    },
    async arm(input: {
      readonly attempt: NativeComposeFileAttempt;
      readonly generation: NativeComposeGeneration;
    }): Promise<void> {
      const { attempt, generation } = input;
      await run(async () => {
        const selected = attempts.get(attempt);
        if (
          !selected ||
          selected.reference.generationId !== generation.generationId
        ) {
          refuseNativeComposeFile();
        }
        await assertNativeComposeFileSources({
          authority,
          reservation: selected.reservation,
          sources: selected.sources,
        });
        const snapshot = await savedSnapshot(generation, "effect");
        try {
          if (
            JSON.stringify(snapshot.reference) !==
              JSON.stringify(selected.reference) ||
            journalState(snapshot).armed ||
            journalState(snapshot).intent
          ) {
            refuseNativeComposeFile();
          }
          await requireMembers(snapshot);
          await appendJournal(snapshot, {
            phase: "armed",
            binding: snapshot.binding,
            members: snapshot.manifest.members.map((member) => member.id),
          });
          await assertNativeComposeFileSources({
            authority,
            reservation: selected.reservation,
            sources: selected.sources,
          });
          await snapshot.check();
        } finally {
          await snapshot.close();
        }
      });
    },
    /** Only the original live armed attempt may record an awaited child's completion, including a failed readiness result. */
    async recordChildReaped(input: {
      readonly attempt: NativeComposeFileAttempt;
      readonly generation: NativeComposeGeneration;
      readonly assertReaped: () => Promise<void>;
    }): Promise<void> {
      const { attempt, generation, assertReaped } = input;
      await run(async () => {
        const selected = attempts.get(attempt);
        if (!selected) {
          refuseNativeComposeFile();
        }
        const snapshot = await savedSnapshot(generation, "effect");
        try {
          const state = journalState(snapshot);
          if (
            JSON.stringify(snapshot.reference) !==
              JSON.stringify(selected.reference) ||
            !state.armed ||
            state.reaped ||
            state.intent !== null
          ) {
            refuseNativeComposeFile();
          }
          await requireMembers(snapshot);
          await snapshot.check();
          await assertReaped();
          await snapshot.check();
          await appendJournal(snapshot, {
            phase: "reaped",
            binding: snapshot.binding,
            members: snapshot.manifest.members.map((member) => member.id),
          });
        } finally {
          await snapshot.close();
        }
      });
    },
    /** Inspect immutable member/projection identity without claiming child readiness. */
    async assertSavedProjection(
      generation: NativeComposeGeneration
    ): Promise<void> {
      await run(async () => {
        const snapshot = await savedSnapshot(generation, "inspect");
        try {
          const state = journalState(snapshot);
          if (state.intent !== null || state.retired) {
            refuseNativeComposeFile();
          }
          await requireMembers(snapshot);
          await snapshot.check();
        } finally {
          await snapshot.close();
        }
      });
    },
    async assertSavedReady(generation: NativeComposeGeneration): Promise<void> {
      await run(async () => {
        const snapshot = await savedSnapshot(generation, "inspect");
        try {
          const state = journalState(snapshot);
          if (
            !(
              state.armed &&
              state.reaped &&
              (state.stopBinding === null || state.stopReaped) &&
              state.intent === null &&
              !state.retired
            )
          ) {
            refuseNativeComposeFile();
          }
          await requireMembers(snapshot);
          await snapshot.check();
        } finally {
          await snapshot.close();
        }
      });
    },
    async rollback(attempt: NativeComposeFileAttempt): Promise<void> {
      await run(async () => {
        const selected = attempts.get(attempt);
        if (!selected) {
          refuseNativeComposeFile();
        }
        const snapshot = await openSnapshot({
          selection: {
            authority,
            reservation: selected.reservation,
            phase: "prepare",
          },
          reference: selected.reference,
        });
        try {
          let state = journalState(snapshot);
          if (
            state.armed ||
            (state.intent !== null && state.intent.phase !== "rollback")
          ) {
            refuseNativeComposeFile();
          }
          if (state.intent === null) {
            await requireMembers(snapshot);
            await appendJournal(snapshot, {
              phase: "rollback",
              binding: snapshot.binding,
              members: snapshot.manifest.members.map((member) => member.id),
            });
            state = journalState(snapshot);
          }
          await retireMembers({
            snapshot,
            retired: state.retired,
            proveAbsent: snapshot.check,
            afterMemberUnlink,
          });
          if (!state.retired && state.intent) {
            await appendJournal(snapshot, {
              phase: "retired",
              intentDigest: digest(JSON.stringify(state.intent)),
            });
          }
          await snapshot.check();
          attempts.delete(attempt);
        } finally {
          await snapshot.close();
        }
      });
    },
    async retire(input: {
      readonly generation: NativeComposeGeneration;
      readonly assertAbsent: () => Promise<void>;
    }): Promise<void> {
      const generation = input.generation;
      const assertAbsent = input.assertAbsent;
      await run(async () => {
        const snapshot = await savedSnapshot(generation, "retire");
        const proveAbsent = async () => {
          await snapshot.check();
          await assertAbsent();
          await snapshot.check();
        };
        try {
          let state = journalState(snapshot);
          if (!nativeComposeFileChildrenKnown(state)) {
            refuseNativeComposeFile();
          }
          await proveAbsent();
          if (state.intent === null) {
            await requireMembers(snapshot);
            await proveAbsent();
            await appendJournal(snapshot, {
              phase: "retiring",
              binding: snapshot.binding,
              members: snapshot.manifest.members.map((member) => member.id),
            });
            state = journalState(snapshot);
          }
          await retireMembers({
            snapshot,
            retired: state.retired,
            proveAbsent,
            afterMemberUnlink,
          });
          if (!state.retired) {
            if (!state.intent) {
              refuseNativeComposeFile();
            }
            await appendJournal(snapshot, {
              phase: "retired",
              intentDigest: digest(JSON.stringify(state.intent)),
            });
          }
          await proveAbsent();
        } finally {
          await snapshot.close();
        }
      });
    },
    async close(): Promise<void> {
      active = false;
      await Promise.allSettled(
        [...ownedSources].map(closeNativeComposeFileSources)
      );
      ownedSources.clear();
    },
  });
}
