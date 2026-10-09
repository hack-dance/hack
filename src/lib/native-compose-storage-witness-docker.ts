import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rmdir, unlink } from "node:fs/promises";
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
  privateDirectory,
  readPrivate,
  recheckDirectories,
  sameFile,
  writeExclusive,
} from "./native-compose-private-state.ts";
import {
  captureNativeComposeStorageReadonlyCarrierIntent,
  type NativeComposeStorageReadonlyCarrierIntent,
} from "./native-compose-storage-carrier-journal.ts";
import {
  NATIVE_STORAGE_DOCKER_DEPENDENCIES,
  nativeComposeStorageDockerHelper,
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
const CAPTURE_LIMIT = 4096;
type Selection = { readonly name: string; readonly storage: string };
type Context = {
  readonly authority: NativeComposeMaterialAuthority;
  readonly store: NativeComposeGenerationStore;
  readonly engineId: string;
  readonly signal: AbortSignal;
  readonly deadline: number;
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
      dependency.artifact.imageId,
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
async function retireInvocationFiles(files: Files): Promise<void> {
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
export async function observeNativeComposeStorageDockerCarrierRecovery(opts: {
  readonly context: Context;
  readonly intent: NativeComposeStorageReadonlyCarrierIntent;
  readonly request: NativeComposeStorageXattrInvocation["request"];
  readonly assertUnchanged: () => Promise<void>;
}): Promise<"created" | "exited"> {
  const context = Object.freeze({ ...opts.context });
  const intent = captureNativeComposeStorageReadonlyCarrierIntent(opts.intent);
  const request = structuredClone(opts.request);
  const assertUnchanged = opts.assertUnchanged;
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
      phase: "storage-recovery-observe",
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
    return state === "created" || state === "exited" ? state : refuse();
  } catch {
    return refuse();
  } finally {
    await Promise.all(files.held.map((directory) => directory.file.close()));
  }
}
async function groupAbsent(pid: number): Promise<void> {
  if (!(Number.isInteger(pid) && pid > 1)) {
    return refuse();
  }
  const deadline = Date.now() + 3000;
  while (true) {
    try {
      process.kill(-pid, 0);
    } catch (error: unknown) {
      if (isRecord(error) && error.code === "ESRCH") {
        return;
      }
      return refuse();
    }
    if (Date.now() >= deadline) {
      return refuse();
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
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
}): Promise<{ readonly exitCode: number; readonly stdout: string }> {
  const opts = {
    ...supplied,
    context: { ...supplied.context },
    args: [...supplied.args],
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
  try {
    await opts.assertAdmitted();
    const timeoutMs = opts.cleanup
      ? opts.timeoutMs
      : Math.min(opts.timeoutMs, opts.context.deadline - Date.now());
    if (!(timeoutMs > 0)) {
      return refuse();
    }
    // Fixed FSIZE quota bounds both inherited capture files, including daemon
    // stderr. Acceptance remains 4096 bytes; no child reopens a named file.
    const code = await run(
      [
        "/bin/sh",
        "-c",
        'ulimit -f 8; exec "$@"',
        "storage-witness-command",
        ...opts.args,
      ],
      {
        privateIo: io.descriptors,
        timeoutMs,
        signal: opts.cleanup ? undefined : opts.context.signal,
        beforeSpawn: () => {
          io.assertFresh();
          opts.beforeSpawn();
          admitted = true;
        },
        onSpawn: (event) => {
          pid = event.ownsProcessGroup
            ? (event.processGroupId ?? event.pid)
            : 0;
          return Promise.resolve();
        },
        onExit: (event) => {
          exit = event;
          return Promise.resolve();
        },
      }
    );
    await groupAbsent(pid);
    settled = true;
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
  } finally {
    if (!admitted || settled) {
      await io.close();
    } else {
      io.retainUnsettled();
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
    let known: {
      readonly id: string;
      readonly createdAt: string;
      readonly policy: string;
    } | null = null;
    let completed = false;
    try {
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
      if (removed.exitCode !== 0) {
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
      await retireInvocationFiles(files);
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
      await Promise.allSettled(files.held.map((entry) => entry.file.close()));
      if (!completed && known) {
        // Exact retained ID/birth are already in the existing private finite journal.
      }
    }
  };
  return captureNativeComposeStorageXattrCarrier({
    artifact: selectedArtifact,
    ports: { inspect, provision, invoke },
    signal: context.signal,
    deadline: context.deadline,
  });
}
