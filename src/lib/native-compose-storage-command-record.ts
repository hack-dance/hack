import { createHash, randomBytes } from "node:crypto";
import { rename } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "./guards.ts";
import type { NativeComposeMaterialBinding } from "./native-compose-generation.ts";
import {
  type HeldDirectory,
  keys,
  parsePrivateJson,
  readPrivate,
  recheckDirectories,
  sameFile,
  writeExclusive,
} from "./native-compose-private-state.ts";
import type { NativeComposeStorageXattrInvocation } from "./native-compose-storage-witness-xattr-carrier.ts";
import { refuseNativeComposeStorageXattr as refuse } from "./native-compose-storage-witness-xattr-codec.ts";

const HASH = /^[a-f0-9]{64}$/;
const TOKEN = /^[a-f0-9]{32}$/;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const BIRTH =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2} \d{2}:\d{2}:\d{2} \d{4}(?:\|[1-9][0-9]*)?$/;
const LIMIT = 32_768;
const KINDS = ["create", "start", "remove"] as const;
export type NativeComposeStorageCommandKind = (typeof KINDS)[number];
type Identity = { readonly dev: number; readonly ino: number };
export type NativeComposeStorageCommandExecutable = {
  readonly dev: string;
  readonly ino: string;
  readonly path: string;
  readonly hash: string;
  readonly size: number;
  readonly uid: number;
  readonly mode: number;
};
export type NativeComposeStorageCommandHost = {
  readonly boot: string;
  readonly uid: number;
  readonly pid: number;
  readonly birth: string;
};
export type NativeComposeStorageCommandChild = {
  readonly pid: number;
  readonly group: number;
  readonly birth: string;
  readonly wrapper: NativeComposeStorageCommandExecutable;
};
type Binding = {
  readonly invocationId: string;
  readonly engineId: string;
  readonly materialHash: string;
  readonly helperHash: string;
  readonly requestHash: string;
  readonly invocationHash: string;
  readonly sourceHash: string;
  readonly fixedInvocationHash: string;
  readonly directory: Identity;
};
type Capture = Identity & { readonly name: string };
type Settlement = {
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly groupAbsent: true;
  readonly captureMode: "held-files-quiescent";
  readonly stdoutHash: string;
  readonly stderrHash: string;
};
type Command = {
  readonly sequence: number;
  readonly token: string;
  readonly kind: NativeComposeStorageCommandKind;
  readonly host: NativeComposeStorageCommandHost;
  readonly executable: NativeComposeStorageCommandExecutable;
  readonly argumentsHash: string;
  readonly deadline: number;
  readonly stdout: Capture;
  readonly stderr: Capture;
  readonly carrier: { readonly id: string; readonly createdAt: string } | null;
  readonly child: NativeComposeStorageCommandChild | null;
  readonly settlement: Settlement | null;
};
type RecordV2 = {
  readonly version: 2;
  readonly kind: "native-carrier-original-commands";
  readonly token: string;
  readonly binding: Binding;
  readonly commands: readonly Command[];
};
function integer(value: unknown, minimum = 0): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    !Object.is(value, -0)
  );
}
function identity(value: unknown): value is Record<string, unknown> & Identity {
  return isRecord(value) && integer(value.dev) && integer(value.ino, 1);
}
function text(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 1024 &&
    !CONTROL.test(value)
  );
}
function digest(value: unknown): value is string {
  return typeof value === "string" && value.length === 64 && HASH.test(value);
}
function device(value: unknown, nonzero = false): value is string {
  return (
    typeof value === "string" &&
    value.length <= 20 &&
    DECIMAL.test(value) &&
    BigInt(value).toString() === value &&
    BigInt(value) <= 18_446_744_073_709_551_615n &&
    (!nonzero || value !== "0")
  );
}
function executable(
  value: unknown
): value is NativeComposeStorageCommandExecutable {
  return (
    isRecord(value) &&
    keys(value, "dev,hash,ino,mode,path,size,uid") &&
    device(value.dev) &&
    device(value.ino, true) &&
    text(value.path) &&
    value.path.startsWith("/") &&
    digest(value.hash) &&
    integer(value.size, 1) &&
    integer(value.uid) &&
    integer(value.mode)
  );
}
function host(value: unknown): value is NativeComposeStorageCommandHost {
  return (
    isRecord(value) &&
    keys(value, "birth,boot,pid,uid") &&
    birth(value.birth) &&
    integer(value.pid, 2) &&
    integer(value.uid) &&
    typeof value.boot === "string" &&
    value.boot.length === 36 &&
    UUID.test(value.boot) &&
    value.boot !== "00000000-0000-0000-0000-000000000000"
  );
}
function birth(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 80 &&
    BIRTH.test(value) &&
    !value.includes("\n")
  );
}
function capture(value: unknown, suffix: string): boolean {
  return (
    isRecord(value) &&
    keys(value, "dev,ino,name") &&
    identity(value) &&
    typeof value.name === "string" &&
    value.name.length === 39 &&
    new RegExp(`^[a-f0-9]{32}\\.${suffix}$`).test(value.name)
  );
}
function child(value: unknown): value is NativeComposeStorageCommandChild {
  return (
    isRecord(value) &&
    keys(value, "birth,group,pid,wrapper") &&
    integer(value.pid, 2) &&
    value.group === value.pid &&
    birth(value.birth) &&
    executable(value.wrapper)
  );
}
function settlement(value: unknown): value is Settlement {
  return (
    isRecord(value) &&
    keys(
      value,
      "cancelled,captureMode,exitCode,groupAbsent,stderrHash,stdoutHash,timedOut"
    ) &&
    integer(value.exitCode) &&
    value.exitCode <= 255 &&
    typeof value.timedOut === "boolean" &&
    typeof value.cancelled === "boolean" &&
    value.groupAbsent === true &&
    value.captureMode === "held-files-quiescent" &&
    digest(value.stdoutHash) &&
    digest(value.stderrHash)
  );
}
/** Closed observation codec. Parsing never issues original-owner, replay or cleanup authority. */
export function parseNativeComposeStorageCommandRecord(
  value: string
): RecordV2 {
  const record = parsePrivateJson(value);
  if (
    !(
      isRecord(record) &&
      keys(record, "binding,commands,kind,token,version") &&
      record.version === 2 &&
      record.kind === "native-carrier-original-commands" &&
      typeof record.token === "string" &&
      record.token.length === 32 &&
      TOKEN.test(record.token) &&
      isRecord(record.binding) &&
      keys(
        record.binding,
        "directory,engineId,fixedInvocationHash,helperHash,invocationHash,invocationId,materialHash,requestHash,sourceHash"
      ) &&
      typeof record.binding.invocationId === "string" &&
      record.binding.invocationId.length === 32 &&
      TOKEN.test(record.binding.invocationId) &&
      text(record.binding.engineId) &&
      digest(record.binding.invocationHash) &&
      digest(record.binding.helperHash) &&
      digest(record.binding.requestHash) &&
      digest(record.binding.materialHash) &&
      digest(record.binding.sourceHash) &&
      digest(record.binding.fixedInvocationHash) &&
      identity(record.binding.directory) &&
      keys(record.binding.directory, "dev,ino") &&
      Array.isArray(record.commands) &&
      record.commands.length <= 3
    )
  ) {
    return refuse();
  }
  const tokens = new Set<string>();
  for (const [index, command] of record.commands.entries()) {
    if (
      !(
        isRecord(command) &&
        keys(
          command,
          "argumentsHash,carrier,child,deadline,executable,host,kind,sequence,settlement,stderr,stdout,token"
        ) &&
        command.sequence === index &&
        command.kind === KINDS[index] &&
        typeof command.token === "string" &&
        command.token.length === 32 &&
        TOKEN.test(command.token) &&
        !tokens.has(command.token) &&
        host(command.host) &&
        executable(command.executable) &&
        digest(command.argumentsHash) &&
        integer(command.deadline, 1) &&
        capture(command.stdout, "stdout") &&
        capture(command.stderr, "stderr") &&
        (index === 0
          ? command.carrier === null
          : isRecord(command.carrier) &&
            keys(command.carrier, "createdAt,id") &&
            digest(command.carrier.id) &&
            text(command.carrier.createdAt)) &&
        (command.child === null || child(command.child)) &&
        (command.settlement === null ||
          (command.child !== null && settlement(command.settlement)))
      )
    ) {
      return refuse();
    }
    tokens.add(command.token);
    if (
      index < record.commands.length - 1 &&
      (!isRecord(command.settlement) ||
        command.settlement.timedOut ||
        command.settlement.cancelled)
    ) {
      return refuse();
    }
  }
  return structuredClone(record) as RecordV2;
}
export function nativeComposeStorageCommandHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
/** Stable saved selection; receipt/lease incarnations and recoveryToken are not
 * source identity. The original pending token and every selected anchor remain. */
export function nativeComposeStorageCommandSourceHash(
  binding: NativeComposeMaterialBinding
): string {
  return nativeComposeStorageCommandHash(
    JSON.stringify({
      identity: binding.identity,
      generationId: binding.generationId,
      checkout: binding.checkout,
      generation: binding.generation,
      documentHash: binding.documentHash,
      currentGenerationId: binding.currentGenerationId,
      pendingGenerationId: binding.pendingGenerationId,
      pendingToken: binding.pendingToken,
    })
  );
}
/** Only live holders and the callback are excluded. All fixed target, request,
 * helper, scope and operation inputs remain bound; historical hashes stay separate. */
export function nativeComposeStorageCommandFixedInvocationHash(
  input: NativeComposeStorageXattrInvocation
): string {
  const { target, artifact, request, scope } = input;
  return nativeComposeStorageCommandHash(
    JSON.stringify({
      invocationId: input.invocationId,
      artifact: {
        version: artifact.version,
        imageId: artifact.imageId,
        platform: artifact.platform,
        bunVersion: artifact.bunVersion,
        bunHash: artifact.bunHash,
        libcHash: artifact.libcHash,
        helperHash: artifact.helperHash,
        kernelAbi: artifact.kernelAbi,
      },
      target: {
        engineId: target.engineId,
        runtimeIdentity: target.runtimeIdentity,
        ownerToken: target.ownerToken,
        name: target.name,
        storage: target.storage,
        volume:
          target.volume === null
            ? null
            : {
                name: target.volume.name,
                storage: target.volume.storage,
                createdAt: target.volume.createdAt,
              },
        mountpoint: target.mountpoint,
        driver: target.driver,
        options: target.options,
      },
      readonly: input.readonly,
      uid: input.uid,
      gid: input.gid,
      request:
        request.operation === "root"
          ? {
              kind: request.kind,
              version: request.version,
              operation: request.operation,
            }
          : {
              kind: request.kind,
              version: request.version,
              operation: request.operation,
              name: request.name,
              valueHex: request.valueHex,
              root: {
                device: request.root.device,
                inode: request.root.inode,
                uid: request.root.uid,
                gid: request.root.gid,
              },
            },
      scope: {
        generationId: scope.generationId,
        currentGenerationId: scope.currentGenerationId,
        pendingGenerationId: scope.pendingGenerationId,
        pendingToken: scope.pendingToken,
      },
    })
  );
}
type OwnerState = {
  readonly directory: HeldDirectory;
  readonly check: () => Promise<void>;
  readonly published: (
    info: Awaited<ReturnType<typeof writeExclusive>>
  ) => void;
  saved: Awaited<ReturnType<typeof readPrivate>>;
  record: RecordV2;
  active: boolean;
  busy: boolean;
};
export type NativeComposeStorageCommandOwner = Readonly<Record<never, never>>;
export type NativeComposeStorageArmedCommand = Readonly<Record<never, never>>;
const owners = new WeakMap<NativeComposeStorageCommandOwner, OwnerState>();
const commands = new WeakMap<
  NativeComposeStorageArmedCommand,
  {
    readonly owner: OwnerState;
    readonly index: number;
    spawning: boolean;
    settling: boolean;
  }
>();
async function unchanged(owner: OwnerState): Promise<void> {
  if (!owner.active) {
    return refuse();
  }
  await owner.check();
  await recheckDirectories([owner.directory]);
  const current = await readPrivate(
    join(owner.directory.path, "commands.json"),
    LIMIT
  );
  if (
    !sameFile(current.info, owner.saved.info) ||
    current.text !== owner.saved.text
  ) {
    owner.active = false;
    return refuse();
  }
}
async function publish(owner: OwnerState, record: RecordV2): Promise<void> {
  if (owner.busy || !owner.active) {
    return refuse();
  }
  owner.busy = true;
  const encoded = JSON.stringify(record);
  parseNativeComposeStorageCommandRecord(encoded);
  try {
    await unchanged(owner);
    const path = join(owner.directory.path, "commands.json");
    const temporary = join(
      owner.directory.path,
      `.commands-${randomBytes(16).toString("hex")}`
    );
    const written = await writeExclusive(temporary, encoded);
    await unchanged(owner);
    await rename(temporary, path);
    await owner.directory.file.sync();
    if (!owner.active) {
      return refuse();
    }
    const saved = await readPrivate(path, LIMIT);
    if (!sameFile(saved.info, written) || saved.text !== encoded) {
      return refuse();
    }
    await owner.check();
    await recheckDirectories([owner.directory]);
    owner.saved = saved;
    owner.record = record;
    owner.published(saved.info);
  } catch {
    owner.active = false;
    return refuse();
  } finally {
    owner.busy = false;
  }
}
/** Exclusive new-invocation writer only; no opener/promoter exists for legacy work. */
export async function createNativeComposeStorageCommandOwner(opts: {
  readonly directory: HeldDirectory;
  readonly binding: Binding;
  readonly check: () => Promise<void>;
  readonly published: OwnerState["published"];
}): Promise<NativeComposeStorageCommandOwner> {
  try {
    const binding = structuredClone(opts.binding);
    const { directory, check, published } = opts;
    const record: RecordV2 = {
      version: 2,
      kind: "native-carrier-original-commands",
      token: randomBytes(16).toString("hex"),
      binding,
      commands: [],
    };
    parseNativeComposeStorageCommandRecord(JSON.stringify(record));
    await check();
    await recheckDirectories([directory]);
    const path = join(directory.path, "commands.json");
    const written = await writeExclusive(path, JSON.stringify(record));
    await directory.file.sync();
    const saved = await readPrivate(path, LIMIT);
    if (
      !sameFile(saved.info, written) ||
      saved.text !== JSON.stringify(record)
    ) {
      return refuse();
    }
    await recheckDirectories([directory]);
    await check();
    const handle = Object.freeze({});
    owners.set(handle, {
      directory,
      check,
      published,
      saved,
      record,
      active: true,
      busy: false,
    });
    published(saved.info);
    return handle;
  } catch {
    return refuse();
  }
}
export async function armNativeComposeStorageCommand(opts: {
  readonly owner: NativeComposeStorageCommandOwner;
  readonly kind: NativeComposeStorageCommandKind;
  readonly host: NativeComposeStorageCommandHost;
  readonly executable: NativeComposeStorageCommandExecutable;
  readonly argumentsHash: string;
  readonly deadline: number;
  readonly stdout: Capture;
  readonly stderr: Capture;
  readonly carrier: Command["carrier"];
}): Promise<NativeComposeStorageArmedCommand> {
  const owner = owners.get(opts.owner) ?? refuse();
  const index = owner.record.commands.length;
  const previous = owner.record.commands.at(-1);
  if (
    KINDS[index] !== opts.kind ||
    (previous &&
      (!previous.settlement ||
        previous.settlement.timedOut ||
        previous.settlement.cancelled))
  ) {
    return refuse();
  }
  if (previous && JSON.stringify(previous.host) !== JSON.stringify(opts.host)) {
    return refuse();
  }
  const entry: Command = {
    ...structuredClone({
      host: opts.host,
      executable: opts.executable,
      argumentsHash: opts.argumentsHash,
      deadline: opts.deadline,
      stdout: opts.stdout,
      stderr: opts.stderr,
      carrier: opts.carrier,
    }),
    kind: opts.kind,
    sequence: index,
    token: randomBytes(16).toString("hex"),
    child: null,
    settlement: null,
  };
  await publish(owner, {
    ...owner.record,
    commands: [...owner.record.commands, entry],
  });
  const handle = Object.freeze({});
  commands.set(handle, { owner, index, spawning: false, settling: false });
  return handle;
}
export async function publishNativeComposeStorageCommandChild(
  handle: NativeComposeStorageArmedCommand,
  value: NativeComposeStorageCommandChild
): Promise<void> {
  const selected = commands.get(handle) ?? refuse();
  if (selected.spawning || selected.settling) {
    return refuse();
  }
  selected.spawning = true;
  const entries = [...selected.owner.record.commands];
  const entry = entries[selected.index] ?? refuse();
  if (entry.child !== null || entry.settlement !== null) {
    return refuse();
  }
  entries[selected.index] = { ...entry, child: structuredClone(value) };
  await publish(selected.owner, {
    ...selected.owner.record,
    commands: entries,
  });
}
/** Original callback only. Facts are observations, never standalone cleanup authority. */
export async function settleNativeComposeStorageCommand(
  handle: NativeComposeStorageArmedCommand,
  value: Settlement
): Promise<void> {
  const selected = commands.get(handle) ?? refuse();
  if (!selected.spawning || selected.settling) {
    return refuse();
  }
  selected.settling = true;
  const entries = [...selected.owner.record.commands];
  const entry = entries[selected.index] ?? refuse();
  if (!entry.child || entry.settlement !== null) {
    return refuse();
  }
  entries[selected.index] = { ...entry, settlement: structuredClone(value) };
  await publish(selected.owner, {
    ...selected.owner.record,
    commands: entries,
  });
}
/** Permanent live-owner veto, including writes that finish after a deadline. */
export function invalidateNativeComposeStorageCommandOwner(
  handle: NativeComposeStorageCommandOwner
): void {
  const owner = owners.get(handle) ?? refuse();
  owner.active = false;
}
/** A live local teardown veto, not durable recovery or deletion authority. */
export function nativeComposeStorageCommandOwnerConfirmed(
  handle: NativeComposeStorageCommandOwner
): boolean {
  const owner = owners.get(handle);
  return Boolean(owner?.active && !owner.busy);
}
/** Local in-flight publication observation only; false grants no effect authority. */
export function nativeComposeStorageCommandOwnerPublicationPending(
  handle: NativeComposeStorageCommandOwner
): boolean {
  const owner = owners.get(handle);
  return owner ? owner.busy : true;
}
