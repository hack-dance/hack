import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  type FileHandle,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { DEFAULT_INGRESS_NETWORK } from "../constants.ts";
import { isRecord } from "./guards.ts";
import { inspectProjectInputsAtRoot } from "./project-input-selection.ts";
import { resolveVerifiedPrimaryWorktreeRoot } from "./worktree-local-config.ts";

const TOKEN = /^[a-f0-9]{32}$/;
const HASH = /^[a-f0-9]{64}$/;
const PROFILE = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const CONTROL = /[\x00-\x1f\x7f]/;
const BOOT_ID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const BIRTH =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/;
const PROCESS_BIRTH_ROW = /^(\d+)\s+(.+)$/;
const LOCK_OWNER_LIMIT = 1024;
const RECEIPT_LIMIT = 64 * 1024;
/** Matches the compiler output budget; this is an artifact bound, not a workload limit. */
export const NATIVE_COMPOSE_DOCUMENT_LIMIT = 8 * 1024 * 1024;

export type NativeComposeIdentity = {
  readonly checkoutRoot: string;
  readonly repositoryRoot: string;
  readonly instance: string | null;
  readonly instanceId: string;
  readonly composeProject: string;
  readonly ownerToken: string;
};

export type NativeComposeGeneration = {
  readonly identity: NativeComposeIdentity;
  readonly generationId: string;
  readonly composeFile: string;
  readonly profiles: readonly string[];
};

export type NativeComposeReservation = {
  readonly identity: NativeComposeIdentity;
  readonly generationId: string;
};

export type NativeComposeOperation = "up" | "restart" | "run" | "down";
export type NativeComposePending = {
  readonly token: string;
  readonly operation: NativeComposeOperation;
  readonly generationId: string;
  readonly recoveryToken?: string;
};

type Receipt = {
  readonly version: 1;
  readonly identity: NativeComposeIdentity;
  readonly checkout: CheckoutAnchor;
  readonly current: GenerationAnchor | null;
  readonly stopped: boolean;
  readonly pending: (NativeComposePending & GenerationAnchor) | null;
  /** No command, PID, environment, or content fingerprint. Interrupted finite hooks never replay. */
  readonly beforeHooks: { readonly token: string } | null;
};
type FileIdentity = { readonly dev: number; readonly ino: number };
type CheckoutAnchor = FileIdentity & {
  readonly projectDirectory: FileIdentity;
  readonly gitMarker: FileIdentity | null;
};
type GenerationAnchor = {
  readonly generationId: string;
  readonly manifestHash: string;
  readonly manifest: { readonly dev: number; readonly ino: number };
};
type Manifest = {
  readonly version: 1;
  readonly identity: NativeComposeIdentity;
  readonly generationId: string;
  readonly profiles: readonly string[];
  readonly documentHash: string;
  readonly inputRevision: string;
  readonly document: { readonly dev: number; readonly ino: number };
};
type HeldDirectory = {
  readonly path: string;
  readonly file: FileHandle;
  readonly info: Stats;
  readonly private: boolean;
};
type LockOwner = {
  readonly version: 1;
  readonly token: string;
  readonly pid: number;
  readonly uid: number;
  readonly bootId: string;
  readonly birth: string;
};

async function inspection(
  command: readonly string[]
): Promise<{ readonly output: string; readonly code: number }> {
  const child = Bun.spawn([...command], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin",
      LANG: "C",
      LC_ALL: "C",
    },
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
  try {
    const chunks: Uint8Array[] = [];
    const reader = child.stdout.getReader();
    let total = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) {
          break;
        }
        total += next.value.byteLength;
        if (total > LOCK_OWNER_LIMIT) {
          child.kill("SIGKILL");
          refuse();
        }
        chunks.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }
    return {
      output: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
        .decode(Buffer.concat(chunks))
        .trim(),
      code: await child.exited,
    };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
    await child.exited;
  }
}
async function bootId(): Promise<string> {
  let value: string;
  if (process.platform === "darwin") {
    const result = await inspection([
      "/usr/sbin/sysctl",
      "-n",
      "kern.bootsessionuuid",
    ]);
    if (result.code !== 0) {
      refuse();
    }
    value = result.output.toLowerCase();
  } else if (process.platform === "linux") {
    const file = await open(
      "/proc/sys/kernel/random/boot_id",
      constants.O_RDONLY | constants.O_NOFOLLOW
    );
    try {
      const bytes = Buffer.alloc(128);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      value = new TextDecoder("utf-8", { fatal: true })
        .decode(bytes.subarray(0, bytesRead))
        .trim();
    } finally {
      await file.close();
    }
  } else {
    return refuse();
  }
  if (!BOOT_ID.test(value)) {
    refuse();
  }
  return value;
}
async function processBirth(
  pid: number
): Promise<{ readonly uid: number; readonly birth: string } | null> {
  const result = await inspection([
    "/bin/ps",
    "-p",
    String(pid),
    "-o",
    "uid=,lstart=",
  ]);
  if (result.code === 1 && result.output === "") {
    return null;
  }
  const match = PROCESS_BIRTH_ROW.exec(result.output);
  const birth = match?.[2]?.replace(/\s+/g, " ");
  const uid = Number(match?.[1]);
  if (
    result.code !== 0 ||
    !Number.isSafeInteger(uid) ||
    uid < 0 ||
    birth === undefined ||
    !BIRTH.test(birth)
  ) {
    refuse();
  }
  return { uid, birth };
}
async function captureLockOwner(): Promise<LockOwner> {
  const birth = await processBirth(process.pid);
  const uid = process.getuid?.();
  if (!birth || uid === undefined || birth.uid !== uid) {
    return refuse();
  }
  return {
    version: 1,
    token: token(),
    pid: process.pid,
    uid,
    bootId: await bootId(),
    birth: birth.birth,
  };
}
function parseLockOwner(text: string): LockOwner {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return refuse();
  }
  if (
    !(
      isRecord(value) &&
      keys(value, "birth,bootId,pid,token,uid,version") &&
      value.version === 1 &&
      typeof value.token === "string" &&
      TOKEN.test(value.token) &&
      typeof value.pid === "number" &&
      Number.isSafeInteger(value.pid) &&
      value.pid > 0 &&
      typeof value.uid === "number" &&
      value.uid === process.getuid?.() &&
      typeof value.bootId === "string" &&
      BOOT_ID.test(value.bootId) &&
      typeof value.birth === "string" &&
      BIRTH.test(value.birth)
    )
  ) {
    return refuse();
  }
  return {
    version: 1,
    token: value.token,
    pid: value.pid,
    uid: value.uid,
    bootId: value.bootId,
    birth: value.birth,
  };
}
function absentProcess(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return hasCode(error, "ESRCH");
  }
}
async function requireDeadOwner(owner: LockOwner): Promise<void> {
  if (
    owner.bootId !== (await bootId()) ||
    owner.uid !== process.getuid?.() ||
    !absentProcess(owner.pid) ||
    (await processBirth(owner.pid)) !== null ||
    !absentProcess(owner.pid)
  ) {
    throw new NativeComposeGenerationError("E_NATIVE_COMPOSE_BUSY");
  }
}

export class NativeComposeGenerationError extends Error {
  readonly code:
    | "E_NATIVE_COMPOSE_STATE"
    | "E_NATIVE_COMPOSE_BUSY"
    | "E_NATIVE_COMPOSE_UNCERTAIN"
    | "E_NATIVE_COMPOSE_STALE";
  constructor(
    code:
      | "E_NATIVE_COMPOSE_STATE"
      | "E_NATIVE_COMPOSE_BUSY"
      | "E_NATIVE_COMPOSE_UNCERTAIN"
      | "E_NATIVE_COMPOSE_STALE"
  ) {
    super(
      {
        E_NATIVE_COMPOSE_STATE:
          "Native Compose state is unsafe or changed; values omitted. Inspect owned state before recovery.",
        E_NATIVE_COMPOSE_BUSY:
          "Native Compose instance is busy or has an interrupted lock; explicit ownership recovery is required.",
        E_NATIVE_COMPOSE_UNCERTAIN:
          "Native Compose operation has an uncertain outcome; inspect the saved generation or explicitly stop its owned resources before retrying.",
        E_NATIVE_COMPOSE_STALE:
          "Native Compose inputs changed before execution; prepare a fresh generation. Values omitted.",
      }[code]
    );
    this.code = code;
  }
}
function refuse(): never {
  throw new NativeComposeGenerationError("E_NATIVE_COMPOSE_STATE");
}
function token(): string {
  return randomUUID().replaceAll("-", "");
}
function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
function keys(value: Record<string, unknown>, expected: string): boolean {
  return Object.keys(value).sort().join() === expected;
}
function sameFile(
  left: Stats,
  right: { readonly dev: number; readonly ino: number }
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}
function hasCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}
async function requireAbsentGuard(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }
  throw new NativeComposeGenerationError("E_NATIVE_COMPOSE_BUSY");
}
function identityMatches(left: unknown, right: NativeComposeIdentity): boolean {
  return (
    isRecord(left) &&
    keys(
      left,
      "checkoutRoot,composeProject,instance,instanceId,ownerToken,repositoryRoot"
    ) &&
    left.checkoutRoot === right.checkoutRoot &&
    left.repositoryRoot === right.repositoryRoot &&
    left.instance === right.instance &&
    left.instanceId === right.instanceId &&
    left.composeProject === right.composeProject &&
    left.ownerToken === right.ownerToken
  );
}
function fileSafe(info: Stats, limit: number): boolean {
  return (
    info.isFile() &&
    info.nlink === 1 &&
    info.uid === process.getuid?.() &&
    (info.mode & 0o777) === 0o600 &&
    info.size > 0 &&
    info.size <= limit
  );
}
async function holdDirectory(
  path: string,
  privateDirectory: boolean
): Promise<HeldDirectory> {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  ).catch(() => refuse());
  try {
    const info = await file.stat();
    const named = await lstat(path);
    if (
      !(info.isDirectory() && sameFile(info, named)) ||
      named.isSymbolicLink() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o022) !== 0 ||
      (privateDirectory && (info.mode & 0o777) !== 0o700) ||
      (await realpath(path)) !== path
    ) {
      refuse();
    }
    return { path, file, info, private: privateDirectory };
  } catch (error) {
    await file.close();
    throw error;
  }
}
async function recheckDirectories(
  directories: readonly HeldDirectory[]
): Promise<void> {
  for (const held of directories) {
    const named = await lstat(held.path);
    if (
      !(named.isDirectory() && sameFile(named, held.info)) ||
      named.uid !== process.getuid?.() ||
      (named.mode & 0o022) !== 0 ||
      (held.private && (named.mode & 0o777) !== 0o700) ||
      (await realpath(held.path)) !== held.path
    ) {
      refuse();
    }
  }
}
async function privateDirectory(path: string): Promise<HeldDirectory> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (!hasCode(error, "EEXIST")) {
      throw error;
    }
  }
  return await holdDirectory(path, true);
}
async function readPrivate(
  path: string,
  limit: number
): Promise<{ readonly text: string; readonly info: Stats }> {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  ).catch((error: unknown) => {
    if (hasCode(error, "ENOENT")) {
      throw error;
    }
    return refuse();
  });
  try {
    const before = await file.stat();
    if (!fileSafe(before, limit)) {
      refuse();
    }
    const bytes = Buffer.alloc(before.size + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    const after = await file.stat();
    const named = await lstat(path);
    if (
      bytesRead !== before.size ||
      !fileSafe(after, limit) ||
      !sameFile(before, after) ||
      !sameFile(before, named) ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      refuse();
    }
    return {
      text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        bytes.subarray(0, bytesRead)
      ),
      info: before,
    };
  } catch {
    return refuse();
  } finally {
    await file.close();
  }
}
async function jsonPrivate(path: string): Promise<unknown> {
  const read = await readPrivate(path, RECEIPT_LIMIT);
  try {
    return JSON.parse(read.text) as unknown;
  } catch {
    return refuse();
  }
}
async function writeExclusive(path: string, text: string): Promise<Stats> {
  const file = await open(
    path,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600
  );
  try {
    await file.writeFile(text);
    await file.sync();
    const info = await file.stat();
    if (!fileSafe(info, Buffer.byteLength(text))) {
      refuse();
    }
    return info;
  } finally {
    await file.close();
  }
}
async function privateIgnore(path: string, create: boolean) {
  if (create) {
    try {
      await writeExclusive(path, "*\n");
    } catch (error) {
      if (!hasCode(error, "EEXIST")) {
        throw error;
      }
    }
  }
  const read = await readPrivate(path, 2);
  if (read.text !== "*\n") {
    refuse();
  }
  return read;
}
async function synchronizeDirectories(
  directories: readonly HeldDirectory[]
): Promise<void> {
  for (const directory of [...directories].reverse()) {
    await directory.file.sync();
  }
}
function anchorValid(
  value: unknown
): value is GenerationAnchor & Record<string, unknown> {
  return (
    isRecord(value) &&
    typeof value.generationId === "string" &&
    TOKEN.test(value.generationId) &&
    typeof value.manifestHash === "string" &&
    HASH.test(value.manifestHash) &&
    isRecord(value.manifest) &&
    keys(value.manifest, "dev,ino") &&
    typeof value.manifest.dev === "number" &&
    Number.isSafeInteger(value.manifest.dev) &&
    typeof value.manifest.ino === "number" &&
    Number.isSafeInteger(value.manifest.ino)
  );
}
function pendingValid(
  value: unknown
): value is NativeComposePending & GenerationAnchor {
  return (
    isRecord(value) &&
    [
      "generationId,manifest,manifestHash,operation,token",
      "generationId,manifest,manifestHash,operation,recoveryToken,token",
    ].includes(Object.keys(value).sort().join()) &&
    anchorValid(value) &&
    typeof value.token === "string" &&
    TOKEN.test(value.token) &&
    ["up", "restart", "run", "down"].includes(String(value.operation)) &&
    (!Object.hasOwn(value, "recoveryToken") ||
      (typeof value.recoveryToken === "string" &&
        TOKEN.test(value.recoveryToken)))
  );
}
function beforeHooksValid(
  value: unknown
): value is { readonly token: string } | null {
  return (
    value === null ||
    (isRecord(value) &&
      keys(value, "token") &&
      typeof value.token === "string" &&
      TOKEN.test(value.token))
  );
}
function requireBeforeHooksAdmission(
  state: Receipt,
  mode: "prepare" | "saved" | undefined
): void {
  if (
    mode === "saved" ||
    state.pending !== null ||
    state.beforeHooks !== null
  ) {
    throw new NativeComposeGenerationError("E_NATIVE_COMPOSE_UNCERTAIN");
  }
}
function parseReceipt(
  value: unknown,
  identity: NativeComposeIdentity,
  checkout: CheckoutAnchor
): Receipt {
  if (
    !(
      isRecord(value) &&
      (keys(value, "checkout,current,identity,pending,stopped,version") ||
        keys(
          value,
          "beforeHooks,checkout,current,identity,pending,stopped,version"
        )) &&
      value.version === 1 &&
      identityMatches(value.identity, identity) &&
      checkoutMatches(value.checkout, checkout) &&
      (value.current === null ||
        (isRecord(value.current) &&
          keys(value.current, "generationId,manifest,manifestHash") &&
          anchorValid(value.current))) &&
      typeof value.stopped === "boolean" &&
      (value.pending === null || pendingValid(value.pending)) &&
      (value.beforeHooks === undefined || beforeHooksValid(value.beforeHooks))
    )
  ) {
    return refuse();
  }
  return {
    version: 1,
    identity,
    checkout,
    current: value.current,
    stopped: value.stopped,
    pending: value.pending,
    beforeHooks: value.beforeHooks ?? null,
  };
}
function checkoutMatches(value: unknown, expected: CheckoutAnchor): boolean {
  if (
    !(
      isRecord(value) &&
      keys(value, "dev,gitMarker,ino,projectDirectory") &&
      value.dev === expected.dev &&
      value.ino === expected.ino &&
      isRecord(value.projectDirectory) &&
      keys(value.projectDirectory, "dev,ino") &&
      value.projectDirectory.dev === expected.projectDirectory.dev &&
      value.projectDirectory.ino === expected.projectDirectory.ino
    )
  ) {
    return false;
  }
  if (expected.gitMarker === null) {
    return value.gitMarker === null;
  }
  return (
    isRecord(value.gitMarker) &&
    keys(value.gitMarker, "dev,ino") &&
    value.gitMarker.dev === expected.gitMarker.dev &&
    value.gitMarker.ino === expected.gitMarker.ino
  );
}
function profilesValid(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.every((name) => typeof name === "string" && PROFILE.test(name)) &&
    new Set(value).size === value.length
  );
}
function parseManifest(
  value: unknown,
  identity: NativeComposeIdentity,
  generationId: string
): Manifest {
  if (
    !(
      isRecord(value) &&
      keys(
        value,
        "document,documentHash,generationId,identity,inputRevision,profiles,version"
      ) &&
      value.version === 1 &&
      identityMatches(value.identity, identity) &&
      value.generationId === generationId &&
      profilesValid(value.profiles) &&
      typeof value.documentHash === "string" &&
      HASH.test(value.documentHash) &&
      typeof value.inputRevision === "string" &&
      HASH.test(value.inputRevision) &&
      isRecord(value.document) &&
      keys(value.document, "dev,ino") &&
      typeof value.document.dev === "number" &&
      Number.isSafeInteger(value.document.dev) &&
      typeof value.document.ino === "number" &&
      Number.isSafeInteger(value.document.ino)
    )
  ) {
    return refuse();
  }
  return {
    version: 1,
    identity,
    generationId,
    profiles: value.profiles,
    documentHash: value.documentHash,
    inputRevision: value.inputRevision,
    document: { dev: value.document.dev, ino: value.document.ino },
  };
}
function publicPending(value: Receipt["pending"]): NativeComposePending | null {
  return value === null
    ? null
    : {
        token: value.token,
        operation: value.operation,
        generationId: value.generationId,
        ...(value.recoveryToken === undefined
          ? {}
          : { recoveryToken: value.recoveryToken }),
      };
}
/** Check reserved delivery identity only; renderer owns all Compose feature policy. */
function documentOwned(
  document: unknown,
  reservation: NativeComposeReservation
): boolean {
  if (
    !(
      isRecord(document) &&
      document.name === reservation.identity.composeProject &&
      isRecord(document.services)
    )
  ) {
    return false;
  }
  const labelsMatch = (item: unknown, generation: boolean, storage?: string) =>
    isRecord(item) &&
    isRecord(item.labels) &&
    item.labels["io.hack.native-config.version"] === "1" &&
    item.labels["io.hack.native-config.instance"] ===
      reservation.identity.composeProject &&
    item.labels["io.hack.native-config.owner"] ===
      reservation.identity.ownerToken &&
    (!generation ||
      (item.labels["io.hack.native-config.generation"] ===
        reservation.generationId &&
        (item.labels["io.hack.native-config.workload"] === "service" ||
          item.labels["io.hack.native-config.workload"] === "job"))) &&
    (storage === undefined ||
      item.labels["io.hack.native-config.storage"] === storage);
  if (
    !Object.values(document.services).every((service) =>
      labelsMatch(service, true)
    )
  ) {
    return false;
  }
  if (
    Object.hasOwn(document, "volumes") &&
    !(
      isRecord(document.volumes) &&
      Object.entries(document.volumes).every(([name, volume]) =>
        labelsMatch(volume, false, name)
      )
    )
  ) {
    return false;
  }
  return (
    !Object.hasOwn(document, "networks") ||
    (isRecord(document.networks) &&
      Object.entries(document.networks).every(([name, network]) =>
        name === "ingress"
          ? isRecord(network) &&
            keys(network, "external,name") &&
            network.external === true &&
            network.name === DEFAULT_INGRESS_NETWORK
          : labelsMatch(network, false)
      ))
  );
}
function requireDocumentOwned(
  json: string,
  reservation: NativeComposeReservation
): void {
  let document: unknown;
  try {
    document = JSON.parse(json) as unknown;
  } catch {
    refuse();
  }
  if (!documentOwned(document, reservation)) {
    refuse();
  }
}

export type NativeComposeEffectOptions<T> = {
  readonly generation: NativeComposeGeneration;
  readonly operation: NativeComposeOperation;
  readonly assertFresh?: () => Promise<void>;
  readonly assertOwned: () => Promise<void>;
  readonly recoverPending?: boolean;
  /**
   * Finalize dependent ownership after a reaped, verified complete effect and fresh
   * pending/ownership checks, before publishing the completed generation receipt.
   * Failure preserves the uncertain pending generation; this is not a cross-store
   * atomic commit, and the finalizer must retain its own crash recovery evidence.
   */
  readonly beforeComplete?: () => Promise<void>;
  readonly effect: () => Promise<{
    readonly outcome: "complete" | "uncertain";
    readonly value: T;
  }>;
};
type PublishOptions = {
  readonly reservation: NativeComposeReservation;
  readonly composeJson: string;
  readonly profiles: readonly string[];
  readonly inputRevision: string;
  readonly assertFresh: () => Promise<void>;
};
function publishInputValid(input: PublishOptions): boolean {
  return (
    profilesValid(input.profiles) &&
    HASH.test(input.inputRevision) &&
    Buffer.byteLength(input.composeJson) <= NATIVE_COMPOSE_DOCUMENT_LIMIT
  );
}
function admitEffect<T>(
  input: NativeComposeEffectOptions<T>,
  state: Receipt,
  mode: "prepare" | "saved" | undefined
): void {
  if (!["up", "restart", "run", "down"].includes(input.operation)) {
    refuse();
  }
  if (input.operation !== "down" && state.beforeHooks !== null) {
    throw new NativeComposeGenerationError("E_NATIVE_COMPOSE_UNCERTAIN");
  }
  if (
    (mode === "saved" && input.operation !== "down") ||
    (input.operation !== "down" && input.assertFresh === undefined)
  ) {
    refuse();
  }
  if (
    input.operation === "run" &&
    state.current !== null &&
    input.generation.generationId !== state.current.generationId
  ) {
    refuse();
  }
  if (
    state.pending !== null &&
    !(
      input.operation === "down" &&
      input.recoverPending === true &&
      input.generation.generationId === state.pending.generationId
    )
  ) {
    throw new NativeComposeGenerationError("E_NATIVE_COMPOSE_UNCERTAIN");
  }
  if (input.recoverPending && state.pending === null) {
    refuse();
  }
}
function completedReceipt(
  state: Receipt,
  anchor: GenerationAnchor,
  operation: NativeComposeOperation
): Receipt {
  if (operation === "up" || operation === "restart") {
    return { ...state, current: anchor, stopped: false, pending: null };
  }
  if (operation === "run") {
    return {
      ...state,
      current: state.current ?? anchor,
      stopped: false,
      pending: null,
    };
  }
  return {
    ...state,
    stopped: operation === "down" || state.stopped,
    pending: null,
  };
}

export type NativeComposeMutation = {
  /** Journal finite host effects before spawning. Unknown completion permanently fences replay. */
  runBeforeHooks<T>(opts: {
    readonly assertFresh: () => Promise<void>;
    readonly effect: () => Promise<{
      readonly outcome: "complete" | "uncertain";
      readonly value: T;
    }>;
  }): Promise<{
    readonly outcome: "complete" | "uncertain";
    readonly value: T;
  }>;
  reserveGeneration(): NativeComposeReservation;
  publish(opts: PublishOptions): Promise<NativeComposeGeneration>;
  /** Only a caller-verified complete postcondition clears intent; engine exit alone is insufficient. */
  runEffect<T>(opts: NativeComposeEffectOptions<T>): Promise<{
    readonly outcome: "complete" | "uncertain";
    readonly value: T;
  }>;
};
export type NativeComposeGenerationStore = {
  readonly identity: NativeComposeIdentity;
  loadCurrent(): Promise<{
    readonly generation: NativeComposeGeneration | null;
    readonly stopped: boolean;
    readonly pending: NativeComposePending | null;
    readonly beforeHooksPending: boolean;
  }>;
  loadPending(): Promise<NativeComposeGeneration | null>;
  /** Private values: never serialize/log this object. Use within a saved-generation lease. */
  readGenerationDocument(
    generation: NativeComposeGeneration
  ): Promise<Readonly<Record<string, unknown>>>;
  /** Explicit same-boot recovery only; live/unknown owners, empty locks and recovery guards refuse. */
  recoverInterruptedLock(): Promise<void>;
  withMutation<T>(
    run: (mutation: NativeComposeMutation) => Promise<T>
  ): Promise<T>;
  withLease<T>(opts: {
    readonly generation: NativeComposeGeneration;
    readonly run: (generation: NativeComposeGeneration) => Promise<T>;
  }): Promise<T>;
  close(): Promise<void>;
};

/**
 * Owned private documents for cooperative writers. Saved mode reads/stops retained
 * identity without reading authored contents or managed env. It cannot publish/start.
 * Held directories and effect-time checks detect rebinding, but cannot freeze arbitrary
 * outside edits. Locks are never stolen; interrupted locks require explicit recovery.
 * No API removes generations or persistent engine data.
 */
export async function openNativeComposeGenerationStore(opts: {
  readonly projectRoot: string;
  readonly instance: string | null;
  readonly mode?: "prepare" | "saved";
}): Promise<NativeComposeGenerationStore> {
  const directories: HeldDirectory[] = [];
  try {
    const checkoutRoot = resolve(opts.projectRoot);
    if (
      opts.mode !== undefined &&
      opts.mode !== "prepare" &&
      opts.mode !== "saved"
    ) {
      refuse();
    }
    if (
      opts.instance !== null &&
      (!opts.instance ||
        Buffer.byteLength(opts.instance) > 256 ||
        CONTROL.test(opts.instance))
    ) {
      refuse();
    }
    if (
      opts.mode !== "saved" &&
      (await inspectProjectInputsAtRoot({ projectRoot: checkoutRoot })).kind !==
        "native"
    ) {
      refuse();
    }
    directories.push(await holdDirectory(checkoutRoot, false));
    const checkout = directories[0];
    if (!checkout) {
      refuse();
    }
    const repositoryRoot =
      (await resolveVerifiedPrimaryWorktreeRoot({
        projectRoot: checkoutRoot,
      })) ?? checkoutRoot;
    const gitMarker = join(checkoutRoot, ".git");
    const gitIdentity = await lstat(gitMarker).catch((error: unknown) => {
      if (hasCode(error, "ENOENT")) {
        return null;
      }
      throw error;
    });
    const projectDirectory = await holdDirectory(
      join(checkoutRoot, ".hack"),
      false
    );
    directories.push(projectDirectory);
    const checkoutAnchor: CheckoutAnchor = {
      dev: checkout.info.dev,
      ino: checkout.info.ino,
      projectDirectory: {
        dev: projectDirectory.info.dev,
        ino: projectDirectory.info.ino,
      },
      gitMarker:
        gitIdentity === null
          ? null
          : { dev: gitIdentity.dev, ino: gitIdentity.ino },
    };
    const internal = join(checkoutRoot, ".hack", ".internal");
    if (opts.mode !== "saved") {
      try {
        await mkdir(internal, { mode: 0o700 });
      } catch (error) {
        if (!hasCode(error, "EEXIST")) {
          throw error;
        }
      }
    }
    directories.push(await holdDirectory(internal, false));
    const root = join(internal, "native-compose");
    const ownedDirectory = async (path: string) =>
      opts.mode === "saved"
        ? await holdDirectory(path, true)
        : await privateDirectory(path);
    directories.push(await ownedDirectory(root));
    const ignorePath = join(root, ".gitignore");
    const ignore = await privateIgnore(ignorePath, opts.mode !== "saved");
    const instanceId = hash(
      JSON.stringify([
        checkoutRoot,
        checkout.info.dev,
        checkout.info.ino,
        opts.instance,
      ])
    );
    const instanceRoot = join(root, instanceId);
    directories.push(await ownedDirectory(instanceRoot));
    const generationsRoot = join(instanceRoot, "generations");
    const leasesRoot = join(instanceRoot, "leases");
    directories.push(
      await ownedDirectory(generationsRoot),
      await ownedDirectory(leasesRoot)
    );
    const receiptPath = join(instanceRoot, "receipt.json");
    const lockPath = join(instanceRoot, "mutation.lock");
    const recoveryPath = join(instanceRoot, "recovery.lock");
    let closed = false;
    const check = async () => {
      if (closed) {
        refuse();
      }
      await recheckDirectories(directories);
      const currentIgnore = await readPrivate(ignorePath, 2);
      if (
        !sameFile(currentIgnore.info, ignore.info) ||
        currentIgnore.text !== ignore.text
      ) {
        refuse();
      }
      const currentGit = await lstat(gitMarker).catch((error: unknown) => {
        if (hasCode(error, "ENOENT")) {
          return null;
        }
        throw error;
      });
      if (
        gitIdentity === null
          ? currentGit !== null
          : currentGit === null ||
            !sameFile(currentGit, gitIdentity) ||
            (gitIdentity.isFile() && currentGit.ctimeMs !== gitIdentity.ctimeMs)
      ) {
        refuse();
      }
    };
    const withLock = async <T>(run: () => Promise<T>) => {
      await check();
      await requireAbsentGuard(recoveryPath);
      const lockOwner = await captureLockOwner();
      try {
        await mkdir(lockPath, { mode: 0o700 });
      } catch (error) {
        if (hasCode(error, "EEXIST")) {
          throw new NativeComposeGenerationError("E_NATIVE_COMPOSE_BUSY");
        }
        throw error;
      }
      const lock = await holdDirectory(lockPath, true);
      const ownerPath = join(lockPath, "owner");
      const lockToken = JSON.stringify(lockOwner);
      let ownerInfo: Stats | undefined;
      try {
        ownerInfo = await writeExclusive(ownerPath, lockToken);
        await lock.file.sync();
        await check();
        await requireAbsentGuard(recoveryPath);
        return await run();
      } finally {
        try {
          await check();
          await recheckDirectories([lock]);
          const latest = await readPrivate(ownerPath, LOCK_OWNER_LIMIT);
          if (
            ownerInfo === undefined ||
            !sameFile(latest.info, ownerInfo) ||
            latest.text !== lockToken
          ) {
            refuse();
          }
          await unlink(ownerPath);
          await rmdir(lockPath);
          await directories[4]?.file.sync();
        } finally {
          await lock.file.close();
        }
      }
    };
    const initialize = async () => {
      let value: unknown;
      try {
        value = await jsonPrivate(receiptPath);
      } catch (error) {
        if (!hasCode(error, "ENOENT")) {
          throw error;
        }
        if (opts.mode === "saved") {
          refuse();
        }
        const initialIdentity = {
          checkoutRoot,
          repositoryRoot,
          instance: opts.instance,
          instanceId,
          composeProject: `hack-nc-${instanceId.slice(0, 32)}`,
          ownerToken: token(),
        };
        value = {
          version: 1,
          identity: initialIdentity,
          checkout: checkoutAnchor,
          current: null,
          stopped: true,
          pending: null,
          beforeHooks: null,
        };
        await writeExclusive(receiptPath, JSON.stringify(value));
        await synchronizeDirectories(directories);
      }
      if (
        !(isRecord(value) && isRecord(value.identity)) ||
        typeof value.identity.ownerToken !== "string" ||
        !TOKEN.test(value.identity.ownerToken)
      ) {
        refuse();
      }
      const identity = Object.freeze({
        checkoutRoot,
        repositoryRoot,
        instance: opts.instance,
        instanceId,
        composeProject: `hack-nc-${instanceId.slice(0, 32)}`,
        ownerToken: value.identity.ownerToken,
      });
      parseReceipt(value, identity, checkoutAnchor);
      return identity;
    };
    const ownedIdentity =
      opts.mode === "saved" ? await initialize() : await withLock(initialize);
    const receipt = async () => {
      await check();
      const result = parseReceipt(
        await jsonPrivate(receiptPath),
        ownedIdentity,
        checkoutAnchor
      );
      await check();
      return result;
    };
    const save = async (state: Receipt) => {
      await receipt();
      const temporary = join(instanceRoot, `${token()}.receipt.tmp`);
      const text = JSON.stringify(state);
      const stagedInfo = await writeExclusive(temporary, text);
      await check();
      await receipt();
      const staged = await readPrivate(temporary, RECEIPT_LIMIT);
      if (!sameFile(staged.info, stagedInfo) || staged.text !== text) {
        refuse();
      }
      await rename(temporary, receiptPath);
      await directories[4]?.file.sync();
      await receipt();
    };
    const known = new WeakMap<NativeComposeGeneration, Manifest>();
    const anchors = new WeakMap<NativeComposeGeneration, GenerationAnchor>();
    const reservations = new WeakSet<NativeComposeReservation>();
    const load = async (
      generationId: string,
      expected?: GenerationAnchor
    ): Promise<NativeComposeGeneration> => {
      if (!TOKEN.test(generationId)) {
        refuse();
      }
      await check();
      const generationRoot = join(generationsRoot, generationId);
      const held = await holdDirectory(generationRoot, true);
      try {
        const manifestRead = await readPrivate(
          join(generationRoot, "manifest.json"),
          RECEIPT_LIMIT
        );
        const anchor: GenerationAnchor = {
          generationId,
          manifestHash: hash(manifestRead.text),
          manifest: { dev: manifestRead.info.dev, ino: manifestRead.info.ino },
        };
        if (expected && JSON.stringify(expected) !== JSON.stringify(anchor)) {
          refuse();
        }
        let value: unknown;
        try {
          value = JSON.parse(manifestRead.text) as unknown;
        } catch {
          return refuse();
        }
        const manifest = parseManifest(value, ownedIdentity, generationId);
        const document = await readPrivate(
          join(generationRoot, "compose.json"),
          NATIVE_COMPOSE_DOCUMENT_LIMIT
        );
        if (
          !sameFile(document.info, manifest.document) ||
          hash(document.text) !== manifest.documentHash
        ) {
          refuse();
        }
        await recheckDirectories([held]);
        await check();
        const generation = Object.freeze({
          identity: ownedIdentity,
          generationId,
          composeFile: join(generationRoot, "compose.json"),
          profiles: Object.freeze([...manifest.profiles]),
        });
        known.set(generation, manifest);
        anchors.set(generation, anchor);
        return generation;
      } finally {
        await held.file.close();
      }
    };
    const verifyGeneration = async (generation: NativeComposeGeneration) => {
      const manifest = known.get(generation);
      if (!manifest) {
        refuse();
      }
      const anchor = anchors.get(generation);
      if (!anchor) {
        refuse();
      }
      const loaded = await load(generation.generationId, anchor);
      if (JSON.stringify(known.get(loaded)) !== JSON.stringify(manifest)) {
        refuse();
      }
    };
    const knownAnchor = (generation: NativeComposeGeneration) => {
      const anchor = anchors.get(generation);
      if (!anchor) {
        return refuse();
      }
      return anchor;
    };
    const finalizeEffect = async <T>(
      input: NativeComposeEffectOptions<T>,
      pending: Receipt["pending"],
      anchor: GenerationAnchor
    ) => {
      await verifyGeneration(input.generation);
      await input.assertOwned();
      let latest = await receipt();
      if (JSON.stringify(latest.pending) !== JSON.stringify(pending)) {
        refuse();
      }
      if (input.beforeComplete) {
        await input.beforeComplete();
        await verifyGeneration(input.generation);
        latest = await receipt();
        if (JSON.stringify(latest.pending) !== JSON.stringify(pending)) {
          refuse();
        }
      }
      await save(completedReceipt(latest, anchor, input.operation));
    };
    const assertFresh = async (callback: () => Promise<void>) => {
      try {
        await callback();
      } catch {
        throw new NativeComposeGenerationError("E_NATIVE_COMPOSE_STALE");
      }
      await check();
    };
    return {
      identity: ownedIdentity,
      async loadCurrent() {
        const state = await receipt();
        return {
          generation:
            state.current === null
              ? null
              : await load(state.current.generationId, state.current),
          stopped: state.stopped,
          pending: publicPending(state.pending),
          beforeHooksPending: state.beforeHooks !== null,
        };
      },
      async loadPending() {
        const state = await receipt();
        return state.pending === null
          ? null
          : await load(state.pending.generationId, {
              generationId: state.pending.generationId,
              manifestHash: state.pending.manifestHash,
              manifest: state.pending.manifest,
            });
      },
      async readGenerationDocument(generation) {
        await verifyGeneration(generation);
        const manifest = known.get(generation);
        if (!manifest) {
          return refuse();
        }
        const read = await readPrivate(
          generation.composeFile,
          NATIVE_COMPOSE_DOCUMENT_LIMIT
        );
        if (
          !sameFile(read.info, manifest.document) ||
          hash(read.text) !== manifest.documentHash
        ) {
          refuse();
        }
        let value: unknown;
        try {
          value = JSON.parse(read.text) as unknown;
        } catch {
          return refuse();
        }
        if (
          !(
            isRecord(value) &&
            documentOwned(value, {
              identity: ownedIdentity,
              generationId: generation.generationId,
            })
          )
        ) {
          return refuse();
        }
        await check();
        return Object.freeze(value);
      },
      async recoverInterruptedLock() {
        await check();
        await requireAbsentGuard(recoveryPath);
        try {
          await lstat(lockPath);
        } catch (error) {
          if (hasCode(error, "ENOENT")) {
            return;
          }
          throw error;
        }
        try {
          await mkdir(recoveryPath, { mode: 0o700 });
        } catch (error) {
          if (hasCode(error, "EEXIST")) {
            throw new NativeComposeGenerationError("E_NATIVE_COMPOSE_BUSY");
          }
          throw error;
        }
        const recovery = await holdDirectory(recoveryPath, true);
        try {
          const lock = await holdDirectory(lockPath, true);
          try {
            const ownerPath = join(lockPath, "owner");
            const original = await readPrivate(ownerPath, LOCK_OWNER_LIMIT);
            const owner = parseLockOwner(original.text);
            await requireDeadOwner(owner);
            await check();
            await recheckDirectories([recovery, lock]);
            const latest = await readPrivate(ownerPath, LOCK_OWNER_LIMIT);
            if (
              !sameFile(original.info, latest.info) ||
              latest.text !== original.text ||
              JSON.stringify(await readdir(lockPath)) !== '["owner"]'
            ) {
              refuse();
            }
            await requireDeadOwner(owner);
            await recheckDirectories([recovery, lock]);
            await unlink(ownerPath);
            await rmdir(lockPath);
            await directories[4]?.file.sync();
          } finally {
            await lock.file.close();
          }
        } finally {
          try {
            await check();
            await recheckDirectories([recovery]);
            await rmdir(recoveryPath);
            await directories[4]?.file.sync();
          } finally {
            await recovery.file.close();
          }
        }
      },
      async withMutation<T>(
        run: (mutation: NativeComposeMutation) => Promise<T>
      ) {
        return await withLock(async () => {
          let active = true;
          let actionDone: Promise<void> | null = null;
          const requireActive = () => {
            if (!active) {
              refuse();
            }
          };
          const runAction = async <T>(action: () => Promise<T>): Promise<T> => {
            requireActive();
            if (actionDone !== null) {
              throw new NativeComposeGenerationError("E_NATIVE_COMPOSE_BUSY");
            }
            let done = () => {
              /* Assigned synchronously by the Promise constructor. */
            };
            actionDone = new Promise<void>((resolveDone) => {
              done = resolveDone;
            });
            try {
              return await action();
            } finally {
              done();
              actionDone = null;
            }
          };
          const checkEffect = async <T>(
            input: NativeComposeEffectOptions<T>
          ) => {
            requireActive();
            await verifyGeneration(input.generation);
            if (input.assertFresh) {
              await assertFresh(input.assertFresh);
            }
            try {
              await input.assertOwned();
            } catch (error) {
              if (error instanceof NativeComposeGenerationError) {
                throw error;
              }
              refuse();
            }
            await check();
            requireActive();
          };
          const mutation: NativeComposeMutation = {
            async runBeforeHooks<T>(input: {
              readonly assertFresh: () => Promise<void>;
              readonly effect: () => Promise<{
                readonly outcome: "complete" | "uncertain";
                readonly value: T;
              }>;
            }) {
              const captured = Object.freeze({ ...input });
              return await runAction(async () => {
                const state = await receipt();
                requireBeforeHooksAdmission(state, opts.mode);
                await assertFresh(captured.assertFresh);
                const beforeHooks = Object.freeze({ token: token() });
                await save({ ...state, beforeHooks });
                try {
                  await assertFresh(captured.assertFresh);
                  const result = await captured.effect();
                  if (result.outcome !== "complete") {
                    return result;
                  }
                  const latest = await receipt();
                  if (latest.beforeHooks?.token !== beforeHooks.token) {
                    refuse();
                  }
                  await save({ ...latest, beforeHooks: null });
                  return result;
                } catch {
                  throw new NativeComposeGenerationError(
                    "E_NATIVE_COMPOSE_UNCERTAIN"
                  );
                }
              });
            },
            reserveGeneration() {
              requireActive();
              if (opts.mode === "saved") {
                refuse();
              }
              const reservation = Object.freeze({
                identity: ownedIdentity,
                generationId: token(),
              });
              reservations.add(reservation);
              return reservation;
            },
            async publish(input) {
              const captured = Object.freeze({
                ...input,
                profiles: Object.freeze([...input.profiles]),
              });
              return await runAction(async () => {
                requireActive();
                if (
                  opts.mode === "saved" ||
                  !reservations.has(captured.reservation) ||
                  !publishInputValid(captured)
                ) {
                  refuse();
                }
                requireDocumentOwned(
                  captured.composeJson,
                  captured.reservation
                );
                const state = await receipt();
                if (state.pending !== null || state.beforeHooks !== null) {
                  throw new NativeComposeGenerationError(
                    "E_NATIVE_COMPOSE_UNCERTAIN"
                  );
                }
                await assertFresh(captured.assertFresh);
                const generationRoot = join(
                  generationsRoot,
                  captured.reservation.generationId
                );
                await mkdir(generationRoot, { mode: 0o700 });
                const held = await holdDirectory(generationRoot, true);
                try {
                  const path = join(generationRoot, "compose.json");
                  await writeExclusive(path, captured.composeJson);
                  const written = await readPrivate(
                    path,
                    NATIVE_COMPOSE_DOCUMENT_LIMIT
                  );
                  const manifest: Manifest = {
                    version: 1,
                    identity: ownedIdentity,
                    generationId: captured.reservation.generationId,
                    profiles: [...captured.profiles],
                    documentHash: hash(captured.composeJson),
                    inputRevision: captured.inputRevision,
                    document: { dev: written.info.dev, ino: written.info.ino },
                  };
                  await writeExclusive(
                    join(generationRoot, "manifest.json"),
                    JSON.stringify(manifest)
                  );
                  await held.file.sync();
                  await directories[5]?.file.sync();
                  await recheckDirectories([held]);
                  await assertFresh(captured.assertFresh);
                  requireActive();
                  reservations.delete(captured.reservation);
                  return await load(captured.reservation.generationId);
                } finally {
                  await held.file.close();
                }
              });
            },
            async runEffect<T>(options: NativeComposeEffectOptions<T>) {
              const input = Object.freeze({ ...options });
              return await runAction(async () => {
                requireActive();
                const state = await receipt();
                admitEffect(input, state, opts.mode);
                await checkEffect(input);
                const anchor = knownAnchor(input.generation);
                const pending: NativeComposePending & GenerationAnchor =
                  state.pending === null
                    ? { ...anchor, token: token(), operation: input.operation }
                    : { ...state.pending, recoveryToken: token() };
                await save({ ...state, pending });
                try {
                  await checkEffect(input);
                  const result = await input.effect();
                  if (result.outcome !== "complete") {
                    return result;
                  }
                  await finalizeEffect(input, pending, anchor);
                  return result;
                } catch {
                  throw new NativeComposeGenerationError(
                    "E_NATIVE_COMPOSE_UNCERTAIN"
                  );
                }
              });
            },
          };
          try {
            return await run(mutation);
          } finally {
            active = false;
            if (actionDone !== null) {
              await actionDone;
            }
          }
        });
      },
      async withLease<T>(input: {
        readonly generation: NativeComposeGeneration;
        readonly run: (generation: NativeComposeGeneration) => Promise<T>;
      }) {
        await verifyGeneration(input.generation);
        const leasePath = join(leasesRoot, `${token()}.json`);
        const lease = JSON.stringify({
          version: 1,
          identity: ownedIdentity,
          generationId: input.generation.generationId,
        });
        const leaseInfo = await writeExclusive(leasePath, lease);
        await directories[6]?.file.sync();
        try {
          await verifyGeneration(input.generation);
          return await input.run(input.generation);
        } finally {
          await check();
          const latest = await readPrivate(leasePath, RECEIPT_LIMIT);
          if (!sameFile(latest.info, leaseInfo) || latest.text !== lease) {
            refuse();
          }
          await unlink(leasePath);
          await directories[6]?.file.sync();
        }
      },
      async close() {
        closed = true;
        await Promise.all(directories.map((held) => held.file.close()));
      },
    };
  } catch (error) {
    await Promise.all(directories.map((held) => held.file.close()));
    if (error instanceof NativeComposeGenerationError) {
      throw error;
    }
    throw new NativeComposeGenerationError("E_NATIVE_COMPOSE_STATE");
  }
}
