import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rmdir,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "./guards.ts";
import {
  assertNativeComposeMaterialAuthority,
  type NativeComposeGenerationStore,
  type NativeComposeMaterialAuthority,
  type NativeComposeMaterialBinding,
} from "./native-compose-generation.ts";
import { createNativeComposeProbe } from "./native-compose-ownership.ts";
import {
  type HeldDirectory,
  holdDirectory,
  observeNativeComposePrivateHostSession,
  privateDirectory,
  readPrivate,
  recheckDirectories,
  sameFile,
  writeExclusive,
} from "./native-compose-private-state.ts";
import {
  captureNativeComposeStorageReadonlyCarrierIntent,
  consumeNativeComposeStorageCarrierCompletion,
  type NativeComposeStorageCarrierCompletion,
  type NativeComposeStorageReadonlyCarrierIntent,
} from "./native-compose-storage-carrier-journal.ts";
import {
  type NativeComposeStorageCommandObservation,
  readNativeComposeStorageCommandObservation,
  recheckNativeComposeStorageRemovedCommands,
} from "./native-compose-storage-command-reader.ts";
import {
  armNativeComposeStorageCommand,
  createNativeComposeStorageCommandOwner,
  invalidateNativeComposeStorageCommandOwner,
  type NativeComposeStorageArmedCommand,
  type NativeComposeStorageCommandChild,
  type NativeComposeStorageCommandExecutable,
  type NativeComposeStorageCommandKind,
  type NativeComposeStorageCommandOwner,
  nativeComposeStorageCommandFixedInvocationHash,
  nativeComposeStorageCommandHash,
  nativeComposeStorageCommandOwnerConfirmed,
  nativeComposeStorageCommandSourceHash,
  publishNativeComposeStorageCommandChild,
  settleNativeComposeStorageCommand,
} from "./native-compose-storage-command-record.ts";
import {
  NATIVE_STORAGE_DOCKER_DEPENDENCIES,
  nativeComposeStorageDockerHelper,
  nativeComposeStorageDockerImageReference,
  selectNativeComposeStorageDockerDependency,
} from "./native-compose-storage-witness-docker-artifact.ts";
import {
  assertNativeComposeStorageDockerCarrierVolume,
  inspectNativeComposeStorageDockerVolume,
  observeNativeComposeStorageDockerTarget,
} from "./native-compose-storage-witness-docker-inventory.ts";
import {
  createNativeComposeStorageDockerEmptyLeaf,
  holdNativeComposeStorageDockerIo,
} from "./native-compose-storage-witness-docker-io.ts";
import {
  checkNativeComposeStorageDockerCarrier,
  checkNativeComposeStorageReadonlyCarrierRecovery,
  NATIVE_STORAGE_CARRIER_FORMAT,
  NATIVE_STORAGE_CARRIER_LABEL,
  type NativeComposeStorageDockerCarrier,
  nativeComposeStorageDockerCarrierPolicy,
  nativeComposeStorageDockerCreateArgs,
} from "./native-compose-storage-witness-docker-policy.ts";
import {
  captureNativeComposeStorageXattrCarrier,
  type NativeComposeStorageXattrCarrier,
  type NativeComposeStorageXattrInvocation,
} from "./native-compose-storage-witness-xattr-carrier.ts";
import {
  encodeNativeComposeStorageXattrRequest,
  parseNativeComposeStorageXattrResponse,
  refuseNativeComposeStorageXattr as refuse,
} from "./native-compose-storage-witness-xattr-codec.ts";
import { findExecutableInPath, type RunExitEvent, run } from "./shell.ts";

const ID = /^[a-f0-9]{64}$/;
const PROCESS =
  /^(\d+)\s+(\d+)\s+(\S+)\s+((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+([^\n\r]+)$/;
const TICKS = /^[1-9][0-9]*$/;
const BOOT = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const CAPTURE_LIMIT = 4096;
// A late/unconfirmed publication cannot release its original held directory FDs.
const unsettledCommandFiles = new Set<readonly HeldDirectory[]>();
type Selection = { readonly name: string; readonly storage: string };
type Context = {
  readonly authority: NativeComposeMaterialAuthority;
  readonly store: NativeComposeGenerationStore;
  readonly engineId: string;
  readonly signal: AbortSignal;
  readonly deadline: number;
  /** Original records for readonly verify only; root/seed retain legacy unknown recovery. */
  readonly originalCommandRecords?: true;
};
type Files = {
  readonly held: readonly HeldDirectory[];
  readonly path: string;
  readonly program: string;
  readonly input: string;
  readonly programInfo: Awaited<ReturnType<typeof writeExclusive>>;
  readonly inputInfo: Awaited<ReturnType<typeof writeExclusive>>;
  readonly requestText: string;
  readonly captures: {
    readonly path: string;
    readonly info: Awaited<ReturnType<typeof writeExclusive>>;
  }[];
};
function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
function lifetime(context: Context): void {
  if (context.signal.aborted || Date.now() >= context.deadline) {
    refuse();
  }
}
async function current(
  context: Context,
  selection?: Selection,
  effect = false
): Promise<NativeComposeMaterialBinding> {
  const saved = await context.store.loadCurrent();
  const generation =
    (await context.store.loadPending()) ?? saved.generation ?? refuse();
  if (selection) {
    const document = await context.store.readGenerationDocument(generation);
    const selected =
      isRecord(document.volumes) &&
      Object.hasOwn(document.volumes, selection.storage)
        ? document.volumes[selection.storage]
        : null;
    const declared = isRecord(selected) && selected.name === selection.name;
    const retained =
      saved.storageWitnesses?.some(
        (entry) =>
          entry.name === selection.name && entry.storage === selection.storage
      ) ?? false;
    if (!(declared || (!effect && retained))) {
      return refuse();
    }
  }
  return await assertNativeComposeMaterialAuthority({
    authority: context.authority,
    generation,
    phase: effect ? "storage-create" : "inspect",
  });
}
function engine(
  probe: ReturnType<typeof createNativeComposeProbe>,
  context: Context
): Promise<void> {
  return probe(["info", "--format", "{{json .ID}}"]).then((text) => {
    if (JSON.parse(text) !== context.engineId) {
      refuse();
    }
  });
}
async function image(
  probe: ReturnType<typeof createNativeComposeProbe>,
  dependency = NATIVE_STORAGE_DOCKER_DEPENDENCIES["linux/arm64"] ?? refuse()
): Promise<void> {
  const value: unknown = JSON.parse(
    await probe([
      "image",
      "inspect",
      "--format",
      '{"id":{{json .Id}},"os":{{json .Os}},"arch":{{json .Architecture}},"volumes":{{json (index .Config "Volumes")}}}',
      nativeComposeStorageDockerImageReference(dependency.artifact),
    ])
  );
  if (
    !(
      isRecord(value) &&
      typeof value.id === "string" &&
      dependency.imageIds.includes(value.id) &&
      value.os === "linux" &&
      value.arch === dependency.artifact.platform.slice(6) &&
      value.volumes === null
    )
  ) {
    return refuse();
  }
}
export { image as assertNativeComposeStorageDockerImage };
async function invocationFiles(
  context: Context,
  input: NativeComposeStorageXattrInvocation
): Promise<Files> {
  const held: HeldDirectory[] = [];
  try {
    const owner = await holdDirectory(
      join(
        context.store.identity.checkoutRoot,
        ".hack",
        ".internal",
        "native-compose",
        context.store.identity.instanceId
      ),
      true
    );
    held.push(owner);
    const root = await privateDirectory(join(owner.path, "storage-carriers"));
    held.push(root);
    await owner.file.sync();
    const path = join(root.path, input.invocationId);
    await mkdir(path, { mode: 0o700 });
    await root.file.sync();
    const directory = await holdDirectory(path, true);
    held.push(directory);
    const program = join(path, "helper.mjs"),
      request = join(path, "request.json");
    const programInfo = await writeExclusive(
      program,
      nativeComposeStorageDockerHelper()
    );
    const requestText = encodeNativeComposeStorageXattrRequest(input.request);
    const inputInfo = await writeExclusive(request, requestText);
    // read-only guest code, private owned parent. This leaf is not executable on the host.
    const file = await open(program, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await file.chmod(0o444);
      await file.sync();
    } finally {
      await file.close();
    }
    await directory.file.sync();
    await recheckDirectories(held);
    return {
      held,
      path,
      program,
      input: request,
      programInfo,
      inputInfo,
      requestText,
      captures: [],
    };
  } catch {
    await Promise.allSettled(held.map((directory) => directory.file.close()));
    return refuse();
  }
}
async function retireInvocationFiles(
  files: Files,
  check?: () => Promise<void>,
  beforeRemove?: () => void
): Promise<void> {
  await checkFiles(files);
  const owned = [
    { path: files.program, info: files.programInfo },
    { path: files.input, info: files.inputInfo },
    ...files.captures,
  ];
  const names = owned
    .map((file) => file.path.slice(files.path.length + 1))
    .sort();
  if (!same((await readdir(files.path)).sort(), names)) {
    return refuse();
  }
  if (check) {
    await check();
  }
  for (const file of owned) {
    await recheckDirectories(files.held);
    const named = await lstat(file.path);
    if (
      !(
        named.isFile() &&
        named.nlink === 1 &&
        named.uid === process.getuid?.() &&
        sameFile(named, file.info)
      )
    ) {
      return refuse();
    }
    beforeRemove?.();
    await unlink(file.path);
  }
  await files.held.at(-1)?.file.sync();
  // The known helper and every owned host group are absent before this retirement.
  await rmdir(files.path);
  await files.held.at(-2)?.file.sync();
}
async function checkFiles(files: Files): Promise<void> {
  await recheckDirectories(files.held);
  for (const [path, original, text] of [
    [files.program, files.programInfo, nativeComposeStorageDockerHelper()],
    [files.input, files.inputInfo, files.requestText],
  ] as const) {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await file.stat();
      if (
        !(
          before.isFile() &&
          before.nlink === 1 &&
          before.uid === process.getuid?.() &&
          sameFile(before, original) &&
          before.size === Buffer.byteLength(text) &&
          (before.mode & 0o777) === (path === files.program ? 0o444 : 0o600)
        )
      ) {
        return refuse();
      }
      const bytes = await file.readFile();
      const after = await file.stat(),
        named = await lstat(path);
      if (
        !(
          sameFile(after, before) &&
          sameFile(named, before) &&
          bytes.toString("utf8") === text &&
          after.mtimeMs === before.mtimeMs &&
          after.ctimeMs === before.ctimeMs
        )
      ) {
        return refuse();
      }
    } finally {
      await file.close();
    }
  }
}

/** Reopen only the original private helper/request. Captures are deliberately
 * neither consumed as settlement evidence nor removed by recovery observation. */
async function savedInvocationFiles(opts: {
  readonly context: Context;
  readonly intent: NativeComposeStorageReadonlyCarrierIntent;
  readonly requestText: string;
}): Promise<Files> {
  const held: HeldDirectory[] = [];
  try {
    const owner = await holdDirectory(
      join(
        opts.context.store.identity.checkoutRoot,
        ".hack",
        ".internal",
        "native-compose",
        opts.context.store.identity.instanceId
      ),
      true
    );
    held.push(owner);
    const root = await holdDirectory(
      join(owner.path, "storage-carriers"),
      true
    );
    held.push(root);
    const directory = await holdDirectory(
      join(root.path, opts.intent.invocationId),
      true
    );
    held.push(directory);
    const program = join(directory.path, "helper.mjs");
    const input = join(directory.path, "request.json");
    const original = await readPrivate(input, 4096);
    if (original.text !== opts.requestText) {
      return refuse();
    }
    const files: Files = {
      held,
      path: directory.path,
      program,
      input,
      programInfo: await lstat(program),
      inputInfo: original.info,
      requestText: opts.requestText,
      captures: [],
    };
    await checkFiles(files);
    return files;
  } catch {
    await Promise.allSettled(held.map((directory) => directory.file.close()));
    return refuse();
  }
}

/** Saved readonly verification observation only. No helper start/exec/removal,
 * kernel invocation, file retirement, journal completion or volume effect occurs.
 * A stopped guest helper does not establish original host-command settlement. */
async function assertRemovedCarrier(
  read: ReturnType<typeof createNativeComposeProbe>,
  invocationId: string,
  id: string
): Promise<void> {
  const text = await read([
    "container",
    "ls",
    "-a",
    "--no-trunc",
    "--format",
    "{{json .ID}}",
  ]);
  const rows: unknown[] =
    text.trim() === ""
      ? []
      : text
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
  if (
    rows.some((row) => typeof row !== "string" || !ID.test(row)) ||
    new Set(rows).size !== rows.length ||
    rows.includes(id)
  ) {
    return refuse();
  }
  const selected = await read([
    "container",
    "ls",
    "-a",
    "--no-trunc",
    "--filter",
    `label=${NATIVE_STORAGE_CARRIER_LABEL}=${invocationId}`,
    "--format",
    "{{json .ID}}",
  ]);
  if (selected.trim() !== "") {
    return refuse();
  }
}
async function savedCarrierRecovery(opts: {
  readonly context: Context;
  readonly intent: NativeComposeStorageReadonlyCarrierIntent;
  readonly request: NativeComposeStorageXattrInvocation["request"];
  readonly assertUnchanged: () => Promise<void>;
  readonly completeRemoved?: (check: () => Promise<void>) => Promise<void>;
}): Promise<{
  readonly helperState: "created" | "exited" | "absent";
  readonly commands: NativeComposeStorageCommandObservation | null;
}> {
  const context = Object.freeze({ ...opts.context });
  const intent = captureNativeComposeStorageReadonlyCarrierIntent(opts.intent);
  const request = structuredClone(opts.request);
  const assertUnchanged = opts.assertUnchanged;
  const completeRemoved = opts.completeRemoved;
  if (
    intent.operation !== "verify" ||
    intent.readonly !== true ||
    request.operation !== "verify" ||
    !(context.signal instanceof AbortSignal) ||
    !Number.isSafeInteger(context.deadline) ||
    typeof assertUnchanged !== "function"
  ) {
    return refuse();
  }
  const docker = findExecutableInPath("docker") ?? refuse();
  const selectors = [
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "DOCKER_CONFIG",
    "DOCKER_TLS_VERIFY",
    "DOCKER_CERT_PATH",
  ].map((key) => [key, process.env[key]] as const);
  const tool = () => {
    lifetime(context);
    if (
      findExecutableInPath("docker") !== docker ||
      selectors.some(([key, value]) => process.env[key] !== value)
    ) {
      refuse();
    }
  };
  const binding = async () => {
    await assertUnchanged();
    tool();
    const state = await context.store.loadCurrent();
    const generation =
      (await context.store.loadPending()) ?? state.generation ?? refuse();
    return await assertNativeComposeMaterialAuthority({
      authority: context.authority,
      generation,
      phase: completeRemoved
        ? "storage-recovery-finish"
        : "storage-recovery-observe",
    });
  };
  const before = await binding();
  if (
    intent.engineId !== context.engineId ||
    intent.ownerToken !== before.identity.ownerToken ||
    intent.runtimeIdentity !== before.identity.composeProject ||
    intent.scope.generationId !== before.generationId ||
    intent.scope.currentGenerationId !== before.currentGenerationId ||
    intent.scope.pendingGenerationId !== before.pendingGenerationId ||
    intent.scope.pendingToken !== before.pendingToken
  ) {
    return refuse();
  }
  const files = await savedInvocationFiles({
    context,
    intent,
    requestText: encodeNativeComposeStorageXattrRequest(request),
  });
  try {
    const guard = async () => {
      tool();
      await checkFiles(files);
      if (!same(before, await binding())) {
        return refuse();
      }
      tool();
    };
    const read: ReturnType<typeof createNativeComposeProbe> = async (args) => {
      await guard();
      const result = await createNativeComposeProbe({
        signal: context.signal,
        timeoutMs: Math.min(15_000, context.deadline - Date.now()),
      })(args);
      await guard();
      return result;
    };
    const dependency = selectNativeComposeStorageDockerDependency({
      engineId: context.engineId,
      daemon: JSON.parse(
        await read([
          "info",
          "--format",
          '{"id":{{json .ID}},"os":{{json .OSType}},"arch":{{json .Architecture}}}',
        ])
      ),
    });
    if (!same(dependency.artifact, intent.artifact)) {
      return refuse();
    }
    await image(read, dependency);
    const invocation = async () => {
      await engine(read, context);
      const text = await read([
        "container",
        "ls",
        "-a",
        "--no-trunc",
        "--filter",
        `label=${NATIVE_STORAGE_CARRIER_LABEL}=${intent.invocationId}`,
        "--format",
        "{{json .ID}}",
      ]);
      const rows: unknown[] =
        text.trim() === ""
          ? []
          : text
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line));
      if (!same(rows, [intent.created.id])) {
        return refuse();
      }
    };
    const helper = async () => {
      await engine(read, context);
      const carrier = checkNativeComposeStorageReadonlyCarrierRecovery({
        value: JSON.parse(
          await read([
            "container",
            "inspect",
            "--format",
            NATIVE_STORAGE_CARRIER_FORMAT,
            intent.created.id,
          ])
        ),
        input: {
          ...intent,
          request,
          target: {
            engineId: intent.engineId,
            runtimeIdentity: intent.runtimeIdentity,
            ownerToken: intent.ownerToken,
            name: intent.volume.name,
            storage: intent.volume.storage,
            volume: intent.volume,
            mountpoint: `/var/lib/docker/volumes/${intent.volume.name}/_data`,
            driver: "local",
            options: {},
            holders: [],
          },
        },
        program: files.program,
        imageIds: dependency.imageIds,
        created: intent.created,
      });
      return carrier;
    };
    const target = async () => {
      const selected = await observeNativeComposeStorageDockerTarget({
        probe: read,
        current: before,
        selection: intent.volume,
        engineId: context.engineId,
        stopped: true,
        carrier: { ...intent.created, invocationId: intent.invocationId },
      });
      if (
        !same(selected.volume, intent.volume) ||
        selected.holders.length !== 0
      ) {
        return refuse();
      }
      return selected;
    };
    const records = async (
      state: "created" | "exited" | "absent",
      helperExitCode: number
    ) => {
      const directory = files.held.at(-1) ?? refuse();
      const input: NativeComposeStorageXattrInvocation = {
        recordCreated: async () => refuse(),
        invocationId: intent.invocationId,
        artifact: intent.artifact,
        target: {
          engineId: intent.engineId,
          runtimeIdentity: intent.runtimeIdentity,
          ownerToken: intent.ownerToken,
          name: intent.volume.name,
          storage: intent.volume.storage,
          volume: intent.volume,
          mountpoint: `/var/lib/docker/volumes/${intent.volume.name}/_data`,
          driver: "local",
          options: {},
          holders: [],
        },
        readonly: true,
        uid: intent.uid,
        gid: intent.gid,
        request,
        scope: intent.scope,
      };
      const executable = await commandExecutable(docker),
        wrapper = await commandExecutable("/bin/sh");
      return await readNativeComposeStorageCommandObservation({
        directory,
        binding: {
          invocationId: intent.invocationId,
          engineId: context.engineId,
          sourceHash: nativeComposeStorageCommandSourceHash(before),
          fixedInvocationHash:
            nativeComposeStorageCommandFixedInvocationHash(input),
          helperHash: nativeComposeStorageCommandHash(
            nativeComposeStorageDockerHelper()
          ),
          requestHash: nativeComposeStorageCommandHash(files.requestText),
          directory: { dev: directory.info.dev, ino: directory.info.ino },
        },
        executable,
        wrapper,
        createArgumentsHash: nativeComposeStorageCommandHash(
          JSON.stringify([
            docker,
            ...nativeComposeStorageDockerCreateArgs({
              input,
              program: files.program,
            }),
          ])
        ),
        removeArgumentsHash: nativeComposeStorageCommandHash(
          JSON.stringify([docker, "rm", intent.created.id])
        ),
        startArgumentsHash: nativeComposeStorageCommandHash(
          JSON.stringify([docker, "start", "-ai", intent.created.id])
        ),
        created: intent.created,
        helperState: state,
        helperExitCode,
        request,
        hostSession: observeNativeComposePrivateHostSession,
        check: async () => {
          await guard();
          if (
            !(
              same(executable, await commandExecutable(docker)) &&
              same(wrapper, await commandExecutable("/bin/sh"))
            )
          ) {
            return refuse();
          }
          tool();
        },
      });
    };
    if (completeRemoved) {
      const original = await records("absent", 0);
      const checkRemoved = async () => {
        await engine(read, context);
        await assertRemovedCarrier(
          read,
          intent.invocationId,
          intent.created.id
        );
        const first = await target();
        await recheckNativeComposeStorageRemovedCommands(original);
        const second = await target();
        await assertRemovedCarrier(
          read,
          intent.invocationId,
          intent.created.id
        );
        await engine(read, context);
        if (!same(first, second)) {
          return refuse();
        }
        await recheckNativeComposeStorageRemovedCommands(original);
        await guard();
      };
      await checkRemoved();
      await completeRemoved(checkRemoved);
      return Object.freeze({ helperState: "absent" as const, commands: null });
    }
    await invocation();
    const first = await helper();
    const firstTarget = await target();
    const second = await helper();
    const secondTarget = await target();
    await invocation();
    if (
      !same(first.state, second.state) ||
      nativeComposeStorageDockerCarrierPolicy(first) !==
        nativeComposeStorageDockerCarrierPolicy(second) ||
      !same(firstTarget, secondTarget)
    ) {
      return refuse();
    }
    await engine(read, context);
    await guard();
    const state = second.state.Status;
    if (state !== "created" && state !== "exited") {
      return refuse();
    }
    // Legacy/incomplete records remain an explicit unknown observation.
    let commands: NativeComposeStorageCommandObservation | null = null;
    try {
      commands = await records(state, Number(second.state.ExitCode));
    } catch {
      commands = null;
    }
    await guard();
    return Object.freeze({ helperState: state, commands });
  } catch {
    return refuse();
  } finally {
    await Promise.all(files.held.map((directory) => directory.file.close()));
  }
}
/** Observation only: a retained helper never gains mutation authority. */
export async function observeNativeComposeStorageDockerCarrierRecovery(
  opts: Parameters<typeof savedCarrierRecovery>[0]
) {
  if (opts.completeRemoved !== undefined) {
    return refuse();
  }
  const result = await savedCarrierRecovery(opts);
  if (result.helperState === "absent") {
    return refuse();
  }
  return { helperState: result.helperState, commands: result.commands };
}
/** Reconcile only independently absent readonly work with a complete successful
 * original prefix. The owning witness supplies the exact intent CAS. No engine mutation. */
export async function reconcileNativeComposeStorageDockerCarrierRecovery(
  opts: Parameters<typeof savedCarrierRecovery>[0] & {
    readonly completeRemoved: (check: () => Promise<void>) => Promise<void>;
  }
): Promise<void> {
  const result = await savedCarrierRecovery(opts);
  if (result.helperState !== "absent") {
    return refuse();
  }
}
async function groupAbsent(
  pid: number,
  monotonicDeadline?: number
): Promise<void> {
  if (!(Number.isInteger(pid) && pid > 1)) {
    return refuse();
  }
  const now =
    monotonicDeadline === undefined ? Date.now : () => performance.now();
  const deadline = monotonicDeadline ?? Date.now() + 3000;
  while (true) {
    try {
      process.kill(-pid, 0);
    } catch (error: unknown) {
      if (isRecord(error) && error.code === "ESRCH") {
        return;
      }
      return refuse();
    }
    if (now() >= deadline) {
      return refuse();
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
async function commandExecutable(
  path: string
): Promise<NativeComposeStorageCommandExecutable> {
  const canonical = await realpath(path);
  const file = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size <= 0n ||
      before.size > 268_435_456n ||
      (before.mode & 0o022n) !== 0n
    ) {
      return refuse();
    }
    const hash = new Bun.CryptoHasher("sha256");
    const bytes = Buffer.alloc(65_536);
    let position = 0;
    const size = Number(before.size);
    while (position < size) {
      const read = await file.read(
        bytes,
        0,
        Math.min(bytes.length, size - position),
        position
      );
      if (read.bytesRead <= 0) {
        return refuse();
      }
      hash.update(bytes.subarray(0, read.bytesRead));
      position += read.bytesRead;
    }
    const after = await file.stat({ bigint: true }),
      named = await lstat(canonical, { bigint: true });
    if (
      !(
        before.dev === after.dev &&
        before.ino === after.ino &&
        before.dev === named.dev &&
        before.ino === named.ino
      ) ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      (await realpath(path)) !== canonical
    ) {
      return refuse();
    }
    return {
      path: canonical,
      dev: before.dev.toString(),
      ino: before.ino.toString(),
      uid: Number(before.uid),
      mode: Number(before.mode),
      size,
      hash: hash.digest("hex"),
    };
  } finally {
    await file.close();
  }
}
async function boundedHostFile(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const buffer = Buffer.alloc(4097);
    const result = await file.read(buffer, 0, buffer.length, 0);
    if (result.bytesRead === 0 || result.bytesRead > 4096) {
      return refuse();
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(
      buffer.subarray(0, result.bytesRead)
    );
  } finally {
    await file.close();
  }
}
async function commandProcess(opts: {
  readonly pid: number;
  readonly read: (args: readonly string[]) => Promise<string>;
}): Promise<{
  readonly uid: number;
  readonly group: number;
  readonly state: string;
  readonly birth: string;
  readonly executable: string;
}> {
  if (!Number.isSafeInteger(opts.pid) || opts.pid <= 1) {
    return refuse();
  }
  const output = (
    await opts.read([
      "/bin/ps",
      "-p",
      String(opts.pid),
      "-o",
      "uid=,pgid=,state=,lstart=,comm=",
    ])
  ).trim();
  const match = PROCESS.exec(output);
  if (!match) {
    return refuse();
  }
  let birth = match[4]?.replace(/\s+/g, " ") ?? refuse();
  let executable = match[5] ?? refuse();
  if (process.platform === "linux") {
    const stat = await boundedHostFile(`/proc/${opts.pid}/stat`);
    const close = stat.lastIndexOf(")");
    const ticks = stat.slice(close + 2).split(" ")[19];
    if (close <= 0 || !ticks || !TICKS.test(ticks)) {
      return refuse();
    }
    birth = `${birth}|${ticks}`;
    executable = await realpath(`/proc/${opts.pid}/exe`);
  }
  return {
    uid: Number(match[1]),
    group: Number(match[2]),
    state: match[3] ?? refuse(),
    birth,
    executable,
  };
}
async function commandBoot(
  read: (args: readonly string[]) => Promise<string>
): Promise<string> {
  let value: string;
  if (process.platform === "darwin") {
    value = (await read(["/usr/sbin/sysctl", "-n", "kern.bootsessionuuid"]))
      .trim()
      .toLowerCase();
  } else if (process.platform === "linux") {
    value = (await boundedHostFile("/proc/sys/kernel/random/boot_id")).trim();
  } else {
    return refuse();
  }
  if (
    value.length !== 36 ||
    !BOOT.test(value) ||
    value === "00000000-0000-0000-0000-000000000000"
  ) {
    return refuse();
  }
  return value;
}
/** No callback can reject before the shared owner awaits exit. A rejected owner or
 * unproven group retains the journal; daemon effects are never inferred from exit. */
export async function runNativeComposeStorageDockerCommand(supplied: {
  readonly context: Pick<Context, "signal" | "deadline">;
  readonly files: Pick<
    Files,
    "held" | "path" | "input" | "inputInfo" | "requestText" | "captures"
  >;
  readonly args: readonly string[];
  readonly beforeSpawn: () => void;
  readonly assertAdmitted: () => Promise<void>;
  readonly timeoutMs: number;
  readonly cleanup?: boolean;
  readonly originalCommand?: {
    readonly owner: NativeComposeStorageCommandOwner;
    readonly kind: NativeComposeStorageCommandKind;
    readonly carrier: {
      readonly id: string;
      readonly createdAt: string;
    } | null;
  };
}): Promise<{ readonly exitCode: number; readonly stdout: string }> {
  const opts = {
    ...supplied,
    context: { ...supplied.context },
    args: [...supplied.args],
    originalCommand: supplied.originalCommand
      ? { ...supplied.originalCommand }
      : undefined,
  };
  const capture = randomBytes(16).toString("hex");
  const stdout = join(opts.files.path, `${capture}.stdout`),
    stderr = join(opts.files.path, `${capture}.stderr`);
  const out = await createNativeComposeStorageDockerEmptyLeaf(stdout),
    err = await createNativeComposeStorageDockerEmptyLeaf(stderr);
  opts.files.captures.push(
    { path: stdout, info: out },
    { path: stderr, info: err }
  );
  await opts.files.held.at(-1)?.file.sync();
  const io = await holdNativeComposeStorageDockerIo({
    directories: opts.files.held,
    input: {
      path: opts.files.input,
      info: opts.files.inputInfo,
      text: opts.files.requestText,
    },
    stdout: { path: stdout, info: out },
    stderr: { path: stderr, info: err },
    limit: CAPTURE_LIMIT,
  });
  let admitted = false,
    settled = false,
    pid = 0,
    exit: RunExitEvent | null = null;
  let armed: NativeComposeStorageArmedCommand | null = null;
  let publicationRefused = false;
  const cancellation = new AbortController();
  try {
    await opts.assertAdmitted();
    const timeoutMs = opts.cleanup
      ? opts.timeoutMs
      : Math.min(opts.timeoutMs, opts.context.deadline - Date.now());
    if (!(timeoutMs > 0)) {
      return refuse();
    }
    const deadline = Date.now() + timeoutMs;
    let boundaryDeadline = performance.now() + timeoutMs;
    let recordingSettlement = false;
    const record = opts.originalCommand;
    const guard = () => {
      if (
        performance.now() >= boundaryDeadline ||
        publicationRefused ||
        (!(recordingSettlement || opts.cleanup) && opts.context.signal.aborted)
      ) {
        return refuse();
      }
    };
    const bounded = async <T>(work: Promise<T>): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        guard();
        const result = await Promise.race([
          work,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => {
                publicationRefused = true;
                if (record) {
                  invalidateNativeComposeStorageCommandOwner(record.owner);
                }
                cancellation.abort();
                reject(
                  new Error(
                    "Original command publication unavailable; values omitted."
                  )
                );
              },
              Math.max(0, boundaryDeadline - performance.now())
            );
          }),
        ]);
        guard();
        return result;
      } catch {
        publicationRefused = true;
        if (record) {
          invalidateNativeComposeStorageCommandOwner(record.owner);
        }
        cancellation.abort();
        return refuse();
      } finally {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      }
    };
    const read = async (args: readonly string[]) => {
      guard();
      const result = await runNativeComposeStorageDockerCommand({
        context: {
          signal: recordingSettlement
            ? new AbortController().signal
            : cancellation.signal,
          deadline:
            Date.now() + Math.max(0, boundaryDeadline - performance.now()),
        },
        files: opts.files,
        args,
        beforeSpawn: guard,
        assertAdmitted: () => {
          guard();
          return Promise.resolve();
        },
        timeoutMs: Math.min(1000, boundaryDeadline - performance.now()),
      });
      if (result.exitCode !== 0) {
        return refuse();
      }
      guard();
      return result.stdout;
    };
    let wrapper: NativeComposeStorageCommandExecutable | null = null;
    let executable: NativeComposeStorageCommandExecutable | null = null;
    let boot = "";
    if (record) {
      executable = await bounded(commandExecutable(opts.args[0] ?? refuse()));
      wrapper = await bounded(commandExecutable("/bin/sh"));
      boot = await bounded(commandBoot(read));
      const host = await bounded(commandProcess({ pid: process.pid, read }));
      if (host.uid !== process.getuid?.()) {
        return refuse();
      }
      armed = await bounded(
        armNativeComposeStorageCommand({
          owner: record.owner,
          kind: record.kind,
          host: { boot, pid: process.pid, uid: host.uid, birth: host.birth },
          executable,
          argumentsHash: nativeComposeStorageCommandHash(
            JSON.stringify(opts.args)
          ),
          deadline,
          carrier: record.carrier,
          stdout: {
            dev: out.dev,
            ino: out.ino,
            name: stdout.slice(opts.files.path.length + 1),
          },
          stderr: {
            dev: err.dev,
            ino: err.ino,
            name: stderr.slice(opts.files.path.length + 1),
          },
        })
      );
      await opts.assertAdmitted();
      guard();
    }
    // Fixed FSIZE quota bounds both inherited capture files, including daemon
    // stderr. Acceptance remains 4096 bytes; no child reopens a named file.
    let signal = opts.cleanup ? undefined : opts.context.signal;
    if (record) {
      signal = AbortSignal.any([
        cancellation.signal,
        ...(opts.cleanup ? [] : [opts.context.signal]),
      ]);
    }
    const code = await run(
      [
        "/bin/sh",
        "-c",
        record
          ? 'ulimit -f 8; kill -STOP "$$"; exec "$@"'
          : 'ulimit -f 8; exec "$@"',
        "storage-witness-command",
        ...opts.args,
      ],
      {
        privateIo: io.descriptors,
        timeoutMs: record ? boundaryDeadline - performance.now() : timeoutMs,
        signal,
        beforeSpawn: () => {
          io.assertFresh();
          opts.beforeSpawn();
          admitted = true;
        },
        onSpawn: async (event) => {
          pid = event.ownsProcessGroup
            ? (event.processGroupId ?? event.pid)
            : 0;
          if (!(record && armed && wrapper && executable)) {
            return;
          }
          try {
            let observed = await bounded(commandProcess({ pid, read }));
            while (!observed.state.startsWith("T")) {
              await bounded(new Promise((resolve) => setTimeout(resolve, 2)));
              observed = await bounded(commandProcess({ pid, read }));
            }
            if (
              observed.group !== pid ||
              observed.uid !== process.getuid?.() ||
              (await realpath(observed.executable)) !== wrapper.path
            ) {
              return refuse();
            }
            const identity: NativeComposeStorageCommandChild = {
              pid,
              group: pid,
              birth: observed.birth,
              wrapper,
            };
            await bounded(
              publishNativeComposeStorageCommandChild(armed, identity)
            );
            await bounded(opts.assertAdmitted());
            const final = await bounded(commandProcess({ pid, read }));
            if (
              !same(final, observed) ||
              (await bounded(commandBoot(read))) !== boot ||
              !same(await bounded(commandExecutable(wrapper.path)), wrapper) ||
              !same(
                await bounded(commandExecutable(opts.args[0] ?? refuse())),
                executable
              )
            ) {
              return refuse();
            }
            io.assertFresh();
            guard();
            if (!event.resumeSuspended?.()) {
              return refuse();
            }
          } catch {
            publicationRefused = true;
            invalidateNativeComposeStorageCommandOwner(record.owner);
            cancellation.abort();
          }
        },
        onExit: (event) => {
          exit = event;
          return Promise.resolve();
        },
      }
    );
    boundaryDeadline = performance.now() + 3000;
    recordingSettlement = true;
    await groupAbsent(pid, record ? boundaryDeadline : undefined);
    settled = true;
    if (record) {
      if (publicationRefused || !armed || !exit) {
        return refuse();
      }
      if (
        (await bounded(commandBoot(read))) !== boot ||
        !executable ||
        !same(
          await bounded(commandExecutable(opts.args[0] ?? refuse())),
          executable
        )
      ) {
        return refuse();
      }
      await bounded(io.sync());
      const captures = io.read();
      const event = exit as RunExitEvent;
      await bounded(
        settleNativeComposeStorageCommand(armed, {
          exitCode: event.exitCode,
          timedOut: event.timedOut,
          cancelled: event.cancelled,
          groupAbsent: true,
          captureMode: "held-files-quiescent",
          stdoutHash: nativeComposeStorageCommandHash(captures.stdout),
          stderrHash: nativeComposeStorageCommandHash(captures.stderr),
        })
      );
    }
    if (
      !(
        exit &&
        !(exit as RunExitEvent).timedOut &&
        !(exit as RunExitEvent).cancelled
      )
    ) {
      return refuse();
    }
    return { exitCode: code, stdout: io.read().stdout };
  } catch (error) {
    if (opts.originalCommand) {
      invalidateNativeComposeStorageCommandOwner(opts.originalCommand.owner);
      return refuse();
    }
    throw error;
  } finally {
    const publicationKnown =
      !opts.originalCommand ||
      nativeComposeStorageCommandOwnerConfirmed(opts.originalCommand.owner);
    if ((!admitted || settled) && publicationKnown) {
      await io.close();
    } else {
      io.retainUnsettled();
      unsettledCommandFiles.add(opts.files.held);
    }
  }
}
function matchesScope(
  input: NativeComposeStorageXattrInvocation,
  binding: NativeComposeMaterialBinding
): boolean {
  return (
    input.scope.generationId === binding.generationId &&
    input.scope.currentGenerationId === binding.currentGenerationId &&
    input.scope.pendingGenerationId === binding.pendingGenerationId &&
    input.scope.pendingToken === binding.pendingToken &&
    input.target.runtimeIdentity === binding.identity.composeProject &&
    input.target.ownerToken === binding.identity.ownerToken
  );
}

/** SOURCE-only transport until its persistent-volume/PGDATA qualification and CLI
 * admission are complete. No module initialization executes Docker or the helper. */
export async function createNativeComposeDockerStorageXattrCarrier(
  opts: Context
): Promise<NativeComposeStorageXattrCarrier> {
  const context: Context = Object.freeze({ ...opts });
  const docker = findExecutableInPath("docker") ?? refuse();
  const selectors = [
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "DOCKER_CONFIG",
    "DOCKER_TLS_VERIFY",
    "DOCKER_CERT_PATH",
  ].map((key) => [key, process.env[key]] as const);
  const tool = () => {
    if (
      findExecutableInPath("docker") !== docker ||
      selectors.some(([key, value]) => process.env[key] !== value)
    ) {
      refuse();
    }
  };
  const probe = (cleanup = false) => {
    tool();
    if (!cleanup) {
      lifetime(context);
    }
    return createNativeComposeProbe({
      signal: cleanup ? undefined : context.signal,
      timeoutMs: cleanup
        ? 10_000
        : Math.min(15_000, context.deadline - Date.now()),
    });
  };
  let dependency: ReturnType<typeof selectNativeComposeStorageDockerDependency>;
  // Resolve the declared dependency before Expected, volume creation or any helper
  // footprint. This first platform remains explicit; emulation is not a fallback.
  try {
    const prerequisite = probe();
    const daemon: unknown = JSON.parse(
      await prerequisite([
        "info",
        "--format",
        '{"id":{{json .ID}},"os":{{json .OSType}},"arch":{{json .Architecture}}}',
      ])
    );
    dependency = selectNativeComposeStorageDockerDependency({
      daemon,
      engineId: context.engineId,
    });
    await image(prerequisite, dependency);
    nativeComposeStorageDockerHelper();
    lifetime(context);
  } catch {
    throw new Error(
      "Native storage witnesses require a matching pinned Linux helper dependency already cached for this daemon; no image is pulled or emulated automatically."
    );
  }
  const selectedArtifact = dependency.artifact;
  const inspect = async (selection: Selection) => {
    const before = await current(context, selection);
    const target = await observeNativeComposeStorageDockerTarget({
      probe: probe(),
      current: before,
      selection,
      engineId: context.engineId,
      stopped: false,
    });
    const after = await current(context, selection);
    if (!same(before, after)) {
      return refuse();
    }
    lifetime(context);
    return target;
  };
  const provision = async (
    selection: Selection & {
      readonly engineId: string;
      readonly runtimeIdentity: string;
      readonly ownerToken: string;
    }
  ) => {
    const before = await current(context, selection, true);
    if (
      !(
        selection.engineId === context.engineId &&
        selection.runtimeIdentity === before.identity.composeProject &&
        selection.ownerToken === before.identity.ownerToken
      )
    ) {
      return refuse();
    }
    const absent = await observeNativeComposeStorageDockerTarget({
      probe: probe(),
      current: before,
      selection,
      engineId: context.engineId,
      stopped: true,
    });
    if (absent.volume !== null) {
      return refuse();
    }
    await image(probe(), dependency);
    const nonce = randomBytes(16).toString("hex");
    const directory = await holdDirectory(
      join(
        context.store.identity.checkoutRoot,
        ".hack",
        ".internal",
        "native-compose",
        context.store.identity.instanceId
      ),
      true
    );
    const held: HeldDirectory[] = [directory];
    let files: Files | null = null;
    try {
      const root = await privateDirectory(
        join(directory.path, "storage-provisions")
      );
      held.push(root);
      const path = join(root.path, nonce);
      await mkdir(path, { mode: 0o700 });
      await root.file.sync();
      const leaf = await holdDirectory(path, true);
      held.push(leaf);
      const request = join(path, "request.json"),
        program = join(path, "intent.json");
      const inputInfo =
        await createNativeComposeStorageDockerEmptyLeaf(request);
      const programInfo = await writeExclusive(
        program,
        JSON.stringify({ ...selection, nonce })
      );
      await leaf.file.sync();
      files = {
        held,
        path,
        input: request,
        program,
        programInfo,
        inputInfo,
        requestText: "",
        captures: [],
      };
      const read = probe();
      await engine(read, context);
      const finalAbsent = await observeNativeComposeStorageDockerTarget({
        probe: read,
        current: before,
        selection,
        engineId: context.engineId,
        stopped: true,
      });
      if (finalAbsent.volume !== null) {
        return refuse();
      }
      tool();
      await recheckDirectories(held);
      const latest = await current(context, selection, true);
      if (!same(before, latest)) {
        return refuse();
      }
      const result = await runNativeComposeStorageDockerCommand({
        context,
        files,
        args: [
          docker,
          "volume",
          "create",
          "--driver",
          "local",
          "--label",
          `com.docker.compose.project=${selection.runtimeIdentity}`,
          "--label",
          `com.docker.compose.volume=${selection.storage}`,
          "--label",
          "io.hack.native-config.version=1",
          "--label",
          `io.hack.native-config.instance=${selection.runtimeIdentity}`,
          "--label",
          `io.hack.native-config.owner=${selection.ownerToken}`,
          "--label",
          `io.hack.native-config.storage=${selection.storage}`,
          "--label",
          `io.hack.native-config.storage-provision=${nonce}`,
          selection.name,
        ],
        timeoutMs: 15_000,
        beforeSpawn: () => {
          tool();
          lifetime(context);
        },
        assertAdmitted: async () => {
          await engine(probe(), context);
          tool();
          if (!same(before, await current(context, selection, true))) {
            refuse();
          }
        },
      });
      if (!(result.exitCode === 0 && result.stdout.trim() === selection.name)) {
        return refuse();
      }
      const created = await inspectNativeComposeStorageDockerVolume({
        probe: probe(),
        current: latest,
        selection,
      });
      if (created.provision !== nonce) {
        return refuse();
      }
      const after = await current(context, selection, true);
      if (!same(before, after)) {
        return refuse();
      }
    } finally {
      await Promise.allSettled(held.map((entry) => entry.file.close()));
    }
  };
  // Original inputs alone can retire their evidence after journal completion.
  // Reader statuses cannot mint or reacquire this closure.
  const finalizers = new WeakMap<
    NativeComposeStorageXattrInvocation,
    (completion: NativeComposeStorageCarrierCompletion) => Promise<void>
  >();
  const invoke = async (input: NativeComposeStorageXattrInvocation) => {
    const before = await current(context, input.target, !input.readonly);
    if (
      !(matchesScope(input, before) && same(input.artifact, selectedArtifact))
    ) {
      return refuse();
    }
    const target = await inspect(input.target);
    if (!same(target, input.target)) {
      return refuse();
    }
    const files = await invocationFiles(context, input);
    let commandOwner: NativeComposeStorageCommandOwner | undefined;
    let known: {
      readonly id: string;
      readonly createdAt: string;
      readonly policy: string;
    } | null = null;
    let completed = false;
    let deferred = false;
    try {
      if (
        context.originalCommandRecords === true &&
        input.readonly &&
        input.request.operation === "verify"
      ) {
        const directory = files.held.at(-1) ?? refuse();
        const recordPath = join(directory.path, "commands.json");
        const recordIndex = files.captures.length;
        commandOwner = await createNativeComposeStorageCommandOwner({
          directory,
          binding: {
            invocationId: input.invocationId,
            engineId: context.engineId,
            materialHash: nativeComposeStorageCommandHash(
              JSON.stringify(before)
            ),
            helperHash: nativeComposeStorageCommandHash(
              nativeComposeStorageDockerHelper()
            ),
            requestHash: nativeComposeStorageCommandHash(files.requestText),
            invocationHash: nativeComposeStorageCommandHash(
              JSON.stringify({ ...input, recordCreated: undefined })
            ),
            sourceHash: nativeComposeStorageCommandSourceHash(before),
            fixedInvocationHash:
              nativeComposeStorageCommandFixedInvocationHash(input),
            directory: { dev: directory.info.dev, ino: directory.info.ino },
          },
          check: async () => {
            tool();
            await checkFiles(files);
            if (
              !same(
                before,
                await current(context, input.target, !input.readonly)
              )
            ) {
              return refuse();
            }
          },
          published: (info) => {
            files.captures[recordIndex] = { path: recordPath, info };
          },
        });
      }
      const read = probe();
      await engine(read, context);
      await image(read, dependency);
      await checkFiles(files);
      tool();
      const admitted = await current(context, input.target, !input.readonly);
      if (!same(before, admitted)) {
        return refuse();
      }
      const created = await runNativeComposeStorageDockerCommand({
        context,
        files,
        originalCommand: commandOwner
          ? { owner: commandOwner, kind: "create", carrier: null }
          : undefined,
        args: [
          docker,
          ...nativeComposeStorageDockerCreateArgs({
            input,
            program: files.program,
          }),
        ],
        timeoutMs: 15_000,
        beforeSpawn: () => {
          tool();
          lifetime(context);
        },
        assertAdmitted: async () => {
          await engine(probe(), context);
          tool();
          if (
            !same(before, await current(context, input.target, !input.readonly))
          ) {
            refuse();
          }
        },
      });
      const id = created.stdout.trim();
      if (!(created.exitCode === 0 && ID.test(id))) {
        return refuse();
      }
      const inspectCarrier = async (
        cleanup = false
      ): Promise<NativeComposeStorageDockerCarrier> => {
        const observed = probe(cleanup);
        await engine(observed, context);
        const value: unknown = JSON.parse(
          await observed([
            "container",
            "inspect",
            "--format",
            NATIVE_STORAGE_CARRIER_FORMAT,
            id,
          ])
        );
        return checkNativeComposeStorageDockerCarrier({
          value,
          input,
          program: files.program,
          imageIds: dependency.imageIds,
        });
      };
      const carrier = await inspectCarrier();
      known = {
        id,
        createdAt: carrier.createdAt,
        policy: nativeComposeStorageDockerCarrierPolicy(carrier),
      };
      const owned = known;
      if (
        !(
          carrier.state.Running === false &&
          carrier.state.Pid === 0 &&
          carrier.state.Status === "created"
        )
      ) {
        return refuse();
      }
      await input.recordCreated({ id, createdAt: known.createdAt });
      await checkFiles(files);
      await image(probe(), dependency);
      await assertNativeComposeStorageDockerCarrierVolume({
        probe: probe(),
        current: before,
        target: input.target,
      });
      const holders = await observeNativeComposeStorageDockerTarget({
        probe: probe(),
        current: before,
        selection: input.target,
        engineId: context.engineId,
        stopped: !input.readonly,
        carrier: { ...known, invocationId: input.invocationId },
      });
      if (!same(holders, input.target)) {
        return refuse();
      }
      const ready = await inspectCarrier();
      if (
        !(
          ready.createdAt === known.createdAt &&
          nativeComposeStorageDockerCarrierPolicy(ready) === known.policy &&
          ready.state.Running === false &&
          ready.state.Pid === 0 &&
          ready.state.Status === "created"
        )
      ) {
        return refuse();
      }
      tool();
      const final = await current(context, input.target, !input.readonly);
      if (!same(before, final)) {
        return refuse();
      }
      const result = await runNativeComposeStorageDockerCommand({
        context,
        files,
        originalCommand: commandOwner
          ? {
              owner: commandOwner,
              kind: "start",
              carrier: { id, createdAt: owned.createdAt },
            }
          : undefined,
        args: [docker, "start", "-ai", id],
        timeoutMs: 15_000,
        beforeSpawn: () => {
          tool();
          lifetime(context);
        },
        assertAdmitted: async () => {
          const selected = await observeNativeComposeStorageDockerTarget({
            probe: probe(),
            current: before,
            selection: input.target,
            engineId: context.engineId,
            stopped: !input.readonly,
            carrier: { ...owned, invocationId: input.invocationId },
          });
          if (!same(selected, input.target)) {
            refuse();
          }
          await checkFiles(files);
          const ready = await inspectCarrier();
          if (
            !(
              ready.createdAt === owned.createdAt &&
              nativeComposeStorageDockerCarrierPolicy(ready) === owned.policy &&
              ready.state.Running === false &&
              ready.state.Pid === 0 &&
              ready.state.Status === "created"
            )
          ) {
            refuse();
          }
          await engine(probe(), context);
          tool();
          if (
            !same(before, await current(context, input.target, !input.readonly))
          ) {
            refuse();
          }
        },
      });
      if (result.exitCode !== 0 && result.exitCode !== 1) {
        return refuse();
      }
      const response = parseNativeComposeStorageXattrResponse(result.stdout);
      if ((response.outcome === "refused") !== (result.exitCode === 1)) {
        return refuse();
      }
      const stopped = await inspectCarrier(true);
      if (
        !(
          stopped.createdAt === known.createdAt &&
          nativeComposeStorageDockerCarrierPolicy(stopped) === known.policy &&
          stopped.state.Running === false &&
          stopped.state.Pid === 0 &&
          stopped.state.Status === "exited" &&
          stopped.state.ExitCode === result.exitCode &&
          stopped.state.Paused === false &&
          stopped.state.Restarting === false &&
          stopped.state.OOMKilled === false &&
          stopped.state.Dead === false &&
          stopped.state.Error === ""
        )
      ) {
        return refuse();
      }
      const repeated = await inspectCarrier(true);
      if (
        !(
          repeated.createdAt === known.createdAt &&
          nativeComposeStorageDockerCarrierPolicy(repeated) === known.policy &&
          same(repeated.state, stopped.state)
        )
      ) {
        return refuse();
      }
      await checkFiles(files);
      tool();
      const cleanupAuthority = await current(context, input.target);
      if (!same(before, cleanupAuthority)) {
        return refuse();
      }
      const removed = await runNativeComposeStorageDockerCommand({
        context,
        files,
        originalCommand: commandOwner
          ? {
              owner: commandOwner,
              kind: "remove",
              carrier: { id, createdAt: owned.createdAt },
            }
          : undefined,
        cleanup: true,
        args: [docker, "rm", id],
        timeoutMs: 10_000,
        beforeSpawn: tool,
        assertAdmitted: async () => {
          const finalCarrier = await inspectCarrier(true);
          if (
            !(
              finalCarrier.createdAt === owned.createdAt &&
              nativeComposeStorageDockerCarrierPolicy(finalCarrier) ===
                owned.policy &&
              same(finalCarrier.state, stopped.state)
            )
          ) {
            refuse();
          }
          await engine(probe(true), context);
          tool();
          if (!same(before, await current(context, input.target))) {
            refuse();
          }
        },
      });
      if (
        removed.exitCode !== 0 ||
        (commandOwner && removed.stdout.trim() !== id)
      ) {
        return refuse();
      }
      const absent = probe(true);
      await engine(absent, context);
      const inventory = (
        await absent([
          "container",
          "ls",
          "-a",
          "--no-trunc",
          "--format",
          "{{json .ID}}",
        ])
      )
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as unknown);
      if (
        inventory.some(
          (value) => typeof value !== "string" || !ID.test(value)
        ) ||
        inventory.includes(id) ||
        new Set(inventory).size !== inventory.length
      ) {
        return refuse();
      }
      const selected = (
        await absent([
          "container",
          "ls",
          "-a",
          "--no-trunc",
          "--filter",
          `label=${NATIVE_STORAGE_CARRIER_LABEL}=${input.invocationId}`,
          "--format",
          "{{json .ID}}",
        ])
      ).trim();
      if (selected !== "") {
        return refuse();
      }
      const after = await inspect(input.target);
      if (!same(after, input.target)) {
        return refuse();
      }
      if (commandOwner) {
        const owner = commandOwner;
        deferred = true;
        finalizers.set(input, async (completion) => {
          const checkCompletion = consumeNativeComposeStorageCarrierCompletion({
            completion,
            invocationId: input.invocationId,
          });
          const check = async () => {
            await checkCompletion();
            tool();
            if (
              !(
                nativeComposeStorageCommandOwnerConfirmed(owner) &&
                same(before, await current(context, input.target))
              )
            ) {
              return refuse();
            }
          };
          try {
            await check();
            await engine(probe(), context);
            const target = await inspect(input.target);
            if (!same(target, input.target)) {
              return refuse();
            }
            // Original removal and all original command groups were already
            // confirmed. Recheck complete current absence before file retirement.
            await assertRemovedCarrier(probe(), input.invocationId, id);
            await check();
            await retireInvocationFiles(files, check, tool);
          } finally {
            await Promise.allSettled(
              files.held.map((entry) => entry.file.close())
            );
          }
        });
      } else {
        await retireInvocationFiles(files);
      }
      completed = true;
      return {
        artifact: selectedArtifact,
        carrierId: id,
        carrierCreatedAt: known.createdAt,
        containersAfterCleanup: [],
        engineId: context.engineId,
        invocationId: input.invocationId,
        readonly: input.readonly,
        uid: input.uid,
        gid: input.gid,
        scope: input.scope,
        outcome: "complete",
        exitCode: result.exitCode,
        response: result.stdout,
        target: after,
        stopped: { id, running: false, pid: 0, exitCode: result.exitCode },
      };
    } finally {
      // Failure never starts a competing stop/remove after unknown child disposition.
      // The original prospective/created journal and private input remain authoritative.
      if (
        unsettledCommandFiles.has(files.held) ||
        (commandOwner &&
          !nativeComposeStorageCommandOwnerConfirmed(commandOwner))
      ) {
        unsettledCommandFiles.add(files.held);
      } else if (!deferred) {
        await Promise.allSettled(files.held.map((entry) => entry.file.close()));
      }
      if (!completed && known) {
        // Exact retained ID/birth are already in the existing private finite journal.
      }
    }
  };
  return captureNativeComposeStorageXattrCarrier({
    artifact: selectedArtifact,
    ports: {
      inspect,
      provision,
      invoke,
      finish:
        context.originalCommandRecords === true
          ? async ({ input, completion }) => {
              const finish = finalizers.get(input) ?? refuse();
              finalizers.delete(input);
              await finish(completion);
            }
          : undefined,
    },
    signal: context.signal,
    deadline: context.deadline,
  });
}
