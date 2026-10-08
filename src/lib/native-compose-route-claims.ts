import { createHash, randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  type FileHandle,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  unlink,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isRecord } from "./guards.ts";

const TOKEN = /^[a-f0-9]{32}$/;
const HASH = /^[a-f0-9]{64}$/;
const PROJECT = /^[a-z0-9][a-z0-9_-]*$/;
const ENGINE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const CLAIM_FILE = /^[a-f0-9]{64}\.json$/;
const RECORD_LIMIT = 64 * 1024;
const READ_LIMIT = 8 * 1024 * 1024;

/** Public, freshly verified Docker ingress identity; no endpoint credentials. */
export type NativeComposeRouteBinding = {
  readonly engineId: string;
  readonly proxyId: string;
  readonly networkId: string;
};
export type NativeComposeRouteOwner = {
  readonly composeProject: string;
  readonly ownerToken: string;
};
type Anchor = {
  readonly dev: number;
  readonly ino: number;
  readonly hash: string;
};
/** Persist in the private generated-document metadata, never engine labels. */
export type NativeComposeRouteReference = {
  readonly attemptId: string;
  readonly generationIdentity: string;
  readonly intent: Anchor;
  readonly reservation: Anchor;
};
export type NativeComposeRouteAttempt = {
  readonly reference: NativeComposeRouteReference;
  readonly hostnames: readonly string[];
  readonly phase: "reserved" | "armed" | "complete" | "retained" | "aborted";
};
type Claim = {
  readonly version: 1;
  readonly hostname: string;
  readonly binding: NativeComposeRouteBinding;
  readonly owner: NativeComposeRouteOwner;
  readonly claimToken: string;
};
type Entry = { readonly claim: Claim; readonly anchor: Anchor };
type Intent = {
  readonly version: 1;
  readonly attemptId: string;
  readonly generationIdentity: string;
  readonly binding: NativeComposeRouteBinding;
  readonly owner: NativeComposeRouteOwner;
  readonly claims: readonly Claim[];
};
type Reservation = {
  readonly version: 1;
  readonly intentHash: string;
  readonly entries: readonly Entry[];
};
type Journal = {
  readonly intent: Intent;
  readonly intentAnchor: Anchor;
  readonly entries: readonly Entry[] | null;
  readonly reservationAnchor: Anchor | null;
  readonly armed: boolean;
  readonly complete: boolean;
  readonly retained: boolean;
  readonly aborted: boolean;
};
type HeldDirectory = {
  readonly path: string;
  readonly handle: FileHandle;
  readonly info: Stats;
  readonly private: boolean;
};
type Read = { readonly text: string; readonly anchor: Anchor };
type FailureCode =
  | "E_NATIVE_COMPOSE_ROUTE_STATE"
  | "E_NATIVE_COMPOSE_ROUTE_CONFLICT"
  | "E_NATIVE_COMPOSE_ROUTE_RETAINED";
export class NativeComposeRouteClaimError extends Error {
  readonly code: FailureCode;
  constructor(code: FailureCode) {
    super(
      {
        E_NATIVE_COMPOSE_ROUTE_STATE:
          "Native Compose hostname ownership is unsafe or changed; values omitted.",
        E_NATIVE_COMPOSE_ROUTE_CONFLICT:
          "Native Compose hostname ownership conflicts; values omitted.",
        E_NATIVE_COMPOSE_ROUTE_RETAINED:
          "Native Compose hostname claims remain retained after uncertain effects; values omitted.",
      }[code]
    );
    this.name = "NativeComposeRouteClaimError";
    this.code = code;
  }
}
function refuse(code: FailureCode = "E_NATIVE_COMPOSE_ROUTE_STATE"): never {
  throw new NativeComposeRouteClaimError(code);
}
function hasCode(value: unknown, code: string): boolean {
  return isRecord(value) && value.code === code;
}
function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function token(): string {
  return randomBytes(16).toString("hex");
}
function keys(value: Record<string, unknown>, expected: string): boolean {
  return Object.keys(value).sort().join(",") === expected;
}
function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}
function anchorValid(value: unknown): value is Anchor {
  return (
    isRecord(value) &&
    keys(value, "dev,hash,ino") &&
    Number.isSafeInteger(value.dev) &&
    Number.isSafeInteger(value.ino) &&
    typeof value.hash === "string" &&
    HASH.test(value.hash)
  );
}
function bindingValid(value: unknown): value is NativeComposeRouteBinding {
  return (
    isRecord(value) &&
    keys(value, "engineId,networkId,proxyId") &&
    typeof value.engineId === "string" &&
    ENGINE.test(value.engineId) &&
    typeof value.proxyId === "string" &&
    HASH.test(value.proxyId) &&
    typeof value.networkId === "string" &&
    HASH.test(value.networkId)
  );
}
function ownerValid(value: unknown): value is NativeComposeRouteOwner {
  return (
    isRecord(value) &&
    keys(value, "composeProject,ownerToken") &&
    typeof value.composeProject === "string" &&
    PROJECT.test(value.composeProject) &&
    Buffer.byteLength(value.composeProject) <= 256 &&
    typeof value.ownerToken === "string" &&
    TOKEN.test(value.ownerToken)
  );
}
function bindingEqual(
  value: unknown,
  expected: NativeComposeRouteBinding
): boolean {
  return (
    bindingValid(value) &&
    value.engineId === expected.engineId &&
    value.proxyId === expected.proxyId &&
    value.networkId === expected.networkId
  );
}
function ownerEqual(
  value: unknown,
  expected: NativeComposeRouteOwner
): boolean {
  return (
    ownerValid(value) &&
    value.composeProject === expected.composeProject &&
    value.ownerToken === expected.ownerToken
  );
}
function hostnameValid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 253 &&
    value.includes(".") &&
    value.split(".").every((label) => LABEL.test(label))
  );
}
function hostnames(values: readonly string[]): string[] {
  if (!(Array.isArray(values) && values.every(hostnameValid))) {
    refuse();
  }
  return [...new Set(values)].sort();
}
function claimValid(value: unknown): value is Claim {
  return (
    isRecord(value) &&
    keys(value, "binding,claimToken,hostname,owner,version") &&
    value.version === 1 &&
    hostnameValid(value.hostname) &&
    bindingValid(value.binding) &&
    ownerValid(value.owner) &&
    typeof value.claimToken === "string" &&
    TOKEN.test(value.claimToken)
  );
}
function entryValid(value: unknown): value is Entry {
  return (
    isRecord(value) &&
    keys(value, "anchor,claim") &&
    claimValid(value.claim) &&
    anchorValid(value.anchor)
  );
}
function referenceValid(value: unknown): value is NativeComposeRouteReference {
  return (
    isRecord(value) &&
    keys(value, "attemptId,generationIdentity,intent,reservation") &&
    typeof value.attemptId === "string" &&
    TOKEN.test(value.attemptId) &&
    typeof value.generationIdentity === "string" &&
    TOKEN.test(value.generationIdentity) &&
    anchorValid(value.intent) &&
    anchorValid(value.reservation)
  );
}
function snapshotReference(
  value: NativeComposeRouteReference
): NativeComposeRouteReference {
  if (!referenceValid(value)) {
    refuse();
  }
  return Object.freeze({
    attemptId: value.attemptId,
    generationIdentity: value.generationIdentity,
    intent: Object.freeze({
      dev: value.intent.dev,
      ino: value.intent.ino,
      hash: value.intent.hash,
    }),
    reservation: Object.freeze({
      dev: value.reservation.dev,
      ino: value.reservation.ino,
      hash: value.reservation.hash,
    }),
  });
}
function freezeAttempt(
  attempt: NativeComposeRouteAttempt
): NativeComposeRouteAttempt {
  return Object.freeze({
    reference: snapshotReference(attempt.reference),
    hostnames: Object.freeze([...attempt.hostnames]),
    phase: attempt.phase,
  });
}
function parse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return refuse();
  }
}
function parseIntent(opts: {
  readonly value: unknown;
  readonly name: string;
  readonly binding: NativeComposeRouteBinding;
  readonly owner: NativeComposeRouteOwner;
}): Intent {
  const { value, name, binding, owner } = opts;
  if (
    !(
      isRecord(value) &&
      keys(value, "attemptId,binding,claims,generationIdentity,owner,version")
    ) ||
    value.version !== 1 ||
    value.attemptId !== name ||
    typeof value.generationIdentity !== "string" ||
    !TOKEN.test(value.generationIdentity) ||
    !bindingEqual(value.binding, binding) ||
    !ownerEqual(value.owner, owner) ||
    !Array.isArray(value.claims) ||
    !value.claims.every(claimValid) ||
    !value.claims.every(
      (claim) =>
        bindingEqual(claim.binding, binding) && ownerEqual(claim.owner, owner)
    )
  ) {
    refuse();
  }
  if (
    !equal(
      value.claims.map((claim) => claim.hostname),
      hostnames(value.claims.map((claim) => claim.hostname))
    )
  ) {
    refuse();
  }
  return {
    version: 1,
    attemptId: name,
    generationIdentity: value.generationIdentity,
    binding,
    owner,
    claims: value.claims,
  };
}
function parseReservation(opts: {
  readonly value: unknown;
  readonly intent: Intent;
  readonly intentHash: string;
}): readonly Entry[] {
  const { value, intent, intentHash } = opts;
  if (
    !(isRecord(value) && keys(value, "entries,intentHash,version")) ||
    value.version !== 1 ||
    value.intentHash !== intentHash ||
    !Array.isArray(value.entries) ||
    !value.entries.every(entryValid) ||
    !equal(
      value.entries.map((entry) => entry.claim),
      intent.claims
    )
  ) {
    refuse();
  }
  return value.entries;
}
function phase(journal: Journal): NativeComposeRouteAttempt["phase"] {
  if (journal.aborted) {
    return "aborted";
  }
  if (journal.retained) {
    return "retained";
  }
  if (journal.complete) {
    return "complete";
  }
  return journal.armed ? "armed" : "reserved";
}
function fileSafe(info: Stats): boolean {
  return (
    info.isFile() &&
    info.uid === process.getuid?.() &&
    (info.mode & 0o777) === 0o600 &&
    info.nlink === 1 &&
    info.size > 0 &&
    info.size <= RECORD_LIMIT
  );
}
function directorySafe(info: Stats, privateDirectory: boolean): boolean {
  const owned = info.uid === process.getuid?.();
  const trustedSticky = info.uid === 0 && (info.mode & 0o1000) !== 0;
  return (
    info.isDirectory() &&
    (owned || info.uid === 0) &&
    ((info.mode & 0o022) === 0 || (!privateDirectory && trustedSticky)) &&
    (!privateDirectory || (owned && (info.mode & 0o777) === 0o700))
  );
}
async function holdDirectory(
  path: string,
  privateDirectory: boolean
): Promise<HeldDirectory> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    const info = await handle.stat();
    const named = await lstat(path);
    if (
      !(directorySafe(info, privateDirectory) && sameFile(info, named)) ||
      named.isSymbolicLink() ||
      (await realpath(path)) !== path
    ) {
      refuse();
    }
    return { path, handle, info, private: privateDirectory };
  } catch (error) {
    await handle.close();
    throw error;
  }
}
async function readPrivate(path: string): Promise<Read> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    const before = await handle.stat();
    if (!fileSafe(before)) {
      refuse();
    }
    const bytes = Buffer.alloc(before.size + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const after = await handle.stat();
    const named = await lstat(path);
    if (
      bytesRead !== before.size ||
      !fileSafe(after) ||
      !fileSafe(named) ||
      !sameFile(before, after) ||
      !sameFile(before, named) ||
      before.size !== after.size ||
      before.size !== named.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      before.mtimeMs !== named.mtimeMs ||
      before.ctimeMs !== named.ctimeMs
    ) {
      refuse();
    }
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes.subarray(0, bytesRead));
    return {
      text,
      anchor: { dev: before.dev, ino: before.ino, hash: hash(text) },
    };
  } finally {
    await handle.close();
  }
}

export type NativeComposeRouteClaims = {
  /** The caller's instance mutation lock must cover the complete operation. */
  acquire(opts: {
    readonly hostnames: readonly string[];
    readonly generationIdentity: string;
  }): Promise<NativeComposeRouteAttempt>;
  reopen(
    reference: NativeComposeRouteReference
  ): Promise<NativeComposeRouteAttempt>;
  /** Synchronize uncertain intent before invoking any engine child/effect. */
  markEffectsPossible(attempt: NativeComposeRouteAttempt): Promise<void>;
  /** Only the live armed attempt can complete; reopened uncertainty cannot. */
  complete(opts: {
    readonly attempt: NativeComposeRouteAttempt;
    readonly assertTransition: () => Promise<void>;
  }): Promise<void>;
  retain(attempt: NativeComposeRouteAttempt): Promise<void>;
  /** Abort this live unarmed preparation; remove only its newly acquired claims. */
  rollback(attempt: NativeComposeRouteAttempt): Promise<void>;
  /**
   * The callback proves obsolete route containers ABSENT and route absence on the
   * exact ingress. With an empty keep set, every owned container must be ABSENT.
   * Stopped-container snapshots and unknown/outliving effects are insufficient.
   */
  release(opts: {
    readonly keepHostnames?: readonly string[];
    readonly assertAbsent: (opts: {
      readonly hostnames: readonly string[];
      readonly binding: NativeComposeRouteBinding;
      readonly owner: NativeComposeRouteOwner;
    }) => Promise<void>;
  }): Promise<void>;
  close(): Promise<void>;
};

/**
 * Private cooperative hostname admission, not a Docker routing controller. The
 * binding must come from a fresh public engine/proxy/network ownership probe.
 * Publication is complete-file hardlink admission; failed/malformed competitors
 * are never reclaimed by age or PID. Root may have a non-0700 existing parent;
 * all created children are user-owned 0700. Same-UID hostile edits remain outside
 * this cooperative filesystem boundary, as with the generation store.
 */
export async function openNativeComposeRouteClaims(opts: {
  readonly root: string;
  readonly binding: NativeComposeRouteBinding;
  readonly owner: NativeComposeRouteOwner;
}): Promise<NativeComposeRouteClaims> {
  const directories: HeldDirectory[] = [];
  const immutable = new Map<string, Anchor>();
  const live = new WeakMap<
    NativeComposeRouteAttempt,
    {
      readonly reference: NativeComposeRouteReference;
      readonly added: readonly Entry[];
    }
  >();
  let closed = false;
  try {
    if (!(bindingValid(opts.binding) && ownerValid(opts.owner))) {
      refuse();
    }
    const binding = Object.freeze({
      engineId: opts.binding.engineId,
      proxyId: opts.binding.proxyId,
      networkId: opts.binding.networkId,
    });
    const owner = Object.freeze({
      composeProject: opts.owner.composeProject,
      ownerToken: opts.owner.ownerToken,
    });
    const root = resolve(opts.root);
    const parent = dirname(root);
    const ancestors: string[] = [];
    for (let path = parent; ; path = dirname(path)) {
      ancestors.unshift(path);
      if (dirname(path) === path) {
        break;
      }
    }
    for (const path of ancestors) {
      directories.push(await holdDirectory(path, false));
    }
    const parentInfo = directories.at(-1)?.info;
    if (!parentInfo || parentInfo.uid !== process.getuid?.()) {
      refuse();
    }
    const check = async () => {
      if (closed) {
        refuse();
      }
      for (const directory of directories) {
        const fd = await directory.handle.stat();
        const named = await lstat(directory.path);
        if (
          !(
            directorySafe(fd, directory.private) &&
            directorySafe(named, directory.private) &&
            sameFile(fd, directory.info) &&
            sameFile(fd, named)
          ) ||
          (await realpath(directory.path)) !== directory.path
        ) {
          refuse();
        }
      }
    };
    const make = async (path: string) => {
      await check();
      await mkdir(path, { mode: 0o700 }).catch((error: unknown) => {
        if (!hasCode(error, "EEXIST")) {
          throw error;
        }
      });
      const held = await holdDirectory(path, true);
      directories.push(held);
      await held.handle.sync();
      await directories
        .find((item) => item.path === dirname(path))
        ?.handle.sync();
      return held;
    };
    await make(root);
    const namespace = join(root, hash(binding.engineId));
    await make(namespace);
    const claimsRoot = join(namespace, "claims");
    const claimsDirectory = await make(claimsRoot);
    const ownersRoot = join(namespace, "owners");
    await make(ownersRoot);
    const ownerRoot = join(ownersRoot, hash(JSON.stringify(owner)));
    await make(ownerRoot);
    const attemptsRoot = join(ownerRoot, "attempts");
    await make(attemptsRoot);
    const releasesRoot = join(ownerRoot, "releases");
    await make(releasesRoot);
    const claimPath = (hostname: string) =>
      join(claimsRoot, `${hash(hostname)}.json`);
    const read = async (path: string): Promise<Read> => {
      await check();
      const value = await readPrivate(path);
      const expected = immutable.get(path);
      if (expected && !equal(expected, value.anchor)) {
        refuse();
      }
      if (!path.startsWith(`${claimsRoot}/`)) {
        immutable.set(path, value.anchor);
      }
      await check();
      return value;
    };
    const optional = async (path: string): Promise<Read | null> => {
      try {
        return await read(path);
      } catch (error) {
        if (hasCode(error, "ENOENT") && !immutable.has(path)) {
          return null;
        }
        throw error;
      }
    };
    const exactUnlink = async (path: string, expected: Read) => {
      await check();
      const current = await read(path);
      if (!equal(current, expected)) {
        refuse();
      }
      await check();
      await unlink(path);
      await claimsDirectory.handle.sync();
    };
    const publish = async (path: string, value: unknown): Promise<Read> => {
      const text = JSON.stringify(value);
      if (Buffer.byteLength(text) > RECORD_LIMIT) {
        refuse();
      }
      const temporary = join(dirname(path), `${token()}.tmp`);
      await check();
      const handle = await open(
        temporary,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          constants.O_NOFOLLOW,
        0o600
      );
      try {
        await handle.writeFile(text);
        await handle.sync();
      } finally {
        await handle.close();
      }
      const staged = await readPrivate(temporary);
      if (staged.text !== text) {
        refuse();
      }
      await check();
      try {
        await link(temporary, path);
      } finally {
        const current = await lstat(temporary);
        if (
          current.dev !== staged.anchor.dev ||
          current.ino !== staged.anchor.ino ||
          current.uid !== process.getuid?.() ||
          (current.mode & 0o777) !== 0o600
        ) {
          refuse();
        }
        await check();
        await unlink(temporary);
      }
      const directory = directories.find((item) => item.path === dirname(path));
      await directory?.handle.sync();
      const result = await read(path);
      if (result.text !== text) {
        refuse();
      }
      return result;
    };
    const validateClaim = (value: unknown): Claim => {
      if (!claimValid(value)) {
        refuse();
      }
      return value;
    };
    const owned = (claim: Claim) =>
      ownerEqual(claim.owner, owner) && bindingEqual(claim.binding, binding);
    const lookupClaim = async (hostname: string): Promise<Entry | null> => {
      const result = await optional(claimPath(hostname));
      if (!result) {
        return null;
      }
      const claim = validateClaim(parse(result.text));
      if (claim.hostname !== hostname) {
        refuse();
      }
      return { claim, anchor: result.anchor };
    };
    const readClaim = async (hostname: string): Promise<Entry | null> => {
      const result = await lookupClaim(hostname);
      if (result && !owned(result.claim)) {
        refuse("E_NATIVE_COMPOSE_ROUTE_CONFLICT");
      }
      return result;
    };
    const journalAt = async (opts: {
      readonly name: string;
      readonly bounded: (path: string) => Promise<Read | null>;
    }): Promise<Journal | null> => {
      const { name, bounded } = opts;
      if (!TOKEN.test(name)) {
        refuse();
      }
      const path = join(attemptsRoot, name);
      if (!directories.some((item) => item.path === path)) {
        directories.push(await holdDirectory(path, true));
      }
      const intentRead = await bounded(join(path, "intent.json"));
      // Empty directories precede intent publication and cannot own effects.
      if (!intentRead) {
        if ((await readdir(path)).length !== 0) {
          refuse();
        }
        return null;
      }
      const intent = parseIntent({
        value: parse(intentRead.text),
        name,
        binding,
        owner,
      });
      const reservationRead = await bounded(join(path, "reserved.json"));
      const entries = reservationRead
        ? parseReservation({
            value: parse(reservationRead.text),
            intent,
            intentHash: intentRead.anchor.hash,
          })
        : null;
      const marker = async (kind: string) => {
        const value = await bounded(join(path, `${kind}.json`));
        if (!value) {
          return false;
        }
        if (
          (kind !== "aborted" && !reservationRead) ||
          !equal(parse(value.text), {
            version: 1,
            intentHash: intentRead.anchor.hash,
            reservationHash: reservationRead?.anchor.hash ?? null,
          })
        ) {
          refuse();
        }
        return true;
      };
      const armed = await marker("armed");
      const complete = await marker("complete");
      const retained = await marker("retained");
      const aborted = await marker("aborted");
      if (
        (complete && !armed) ||
        (aborted && (armed || complete || retained))
      ) {
        refuse();
      }
      return {
        intent,
        intentAnchor: intentRead.anchor,
        entries,
        reservationAnchor: reservationRead?.anchor ?? null,
        armed,
        complete,
        retained,
        aborted,
      };
    };
    const journals = async (): Promise<Journal[]> => {
      await check();
      let bytes = 0;
      const bounded = async (path: string) => {
        const result = await optional(path);
        bytes += Buffer.byteLength(result?.text ?? "");
        if (bytes > READ_LIMIT) {
          refuse();
        }
        return result;
      };
      const result: Journal[] = [];
      for (const name of (await readdir(attemptsRoot)).sort()) {
        const record = await journalAt({ name, bounded });
        if (record) {
          result.push(record);
        }
      }
      await check();
      return result;
    };
    const releases = async (): Promise<Map<string, Entry>> => {
      await check();
      const result = new Map<string, Entry>();
      let bytes = 0;
      for (const name of (await readdir(releasesRoot)).sort()) {
        if (!CLAIM_FILE.test(name)) {
          refuse();
        }
        const value = await read(join(releasesRoot, name));
        bytes += Buffer.byteLength(value.text);
        const record = parse(value.text);
        if (
          bytes > READ_LIMIT ||
          !isRecord(record) ||
          !keys(record, "binding,entries,owner,version") ||
          record.version !== 1 ||
          !bindingEqual(record.binding, binding) ||
          !ownerEqual(record.owner, owner) ||
          !Array.isArray(record.entries) ||
          !record.entries.every(entryValid) ||
          !record.entries.every((entry) => owned(entry.claim))
        ) {
          refuse();
        }
        for (const entry of record.entries) {
          const key = hash(JSON.stringify(entry.claim));
          const old = result.get(key);
          if (old && !equal(old, entry)) {
            refuse();
          }
          result.set(key, entry);
        }
      }
      return result;
    };
    const activeEntry = async (opts: {
      readonly journal: Journal;
      readonly claim: Claim;
      readonly retired: Map<string, Entry>;
    }): Promise<Entry | null> => {
      const { journal, claim, retired } = opts;
      const key = hash(JSON.stringify(claim));
      const expected = journal.entries?.find((entry) =>
        equal(entry.claim, claim)
      );
      if (retired.has(key)) {
        if (expected && !equal(retired.get(key), expected)) {
          refuse();
        }
        return null;
      }
      const actual = await lookupClaim(claim.hostname);
      if (!(actual && equal(actual.claim, claim))) {
        if (expected) {
          refuse();
        }
        return null;
      }
      if (expected && !equal(actual, expected)) {
        refuse();
      }
      return actual;
    };
    const activeEntries = async (records: readonly Journal[]) => {
      const retired = await releases();
      const byHostname = new Map<string, Entry>();
      for (const journal of records) {
        if (journal.aborted) {
          continue;
        }
        for (const claim of journal.intent.claims) {
          const actual = await activeEntry({ journal, claim, retired });
          if (!actual) {
            continue;
          }
          const old = byHostname.get(claim.hostname);
          if (old && !equal(old, actual)) {
            refuse();
          }
          byHostname.set(claim.hostname, actual);
        }
      }
      return { retired, entries: byHostname };
    };
    const asAttempt = (journal: Journal): NativeComposeRouteAttempt => {
      if (!journal.reservationAnchor) {
        refuse();
      }
      return freezeAttempt({
        reference: {
          attemptId: journal.intent.attemptId,
          generationIdentity: journal.intent.generationIdentity,
          intent: journal.intentAnchor,
          reservation: journal.reservationAnchor,
        },
        hostnames: journal.intent.claims.map((claim) => claim.hostname),
        phase: phase(journal),
      });
    };
    const find = (
      records: readonly Journal[],
      reference: NativeComposeRouteReference
    ) => {
      if (!referenceValid(reference)) {
        refuse();
      }
      const found = records.find(
        (journal) => journal.intent.attemptId === reference.attemptId
      );
      if (!(found && equal(asAttempt(found).reference, reference))) {
        refuse();
      }
      return found;
    };
    const capability = (attempt: NativeComposeRouteAttempt) => {
      const result = live.get(attempt);
      if (!(result && equal(result.reference, attempt.reference))) {
        refuse("E_NATIVE_COMPOSE_ROUTE_RETAINED");
      }
      return result;
    };
    const mark = async (attempt: NativeComposeRouteAttempt, kind: string) => {
      const { reference } = capability(attempt);
      const records = await journals();
      const record = find(records, reference);
      await activeEntries(records);
      await publish(join(attemptsRoot, reference.attemptId, `${kind}.json`), {
        version: 1,
        intentHash: record.intentAnchor.hash,
        reservationHash: record.reservationAnchor?.hash,
      });
    };
    const guard = async <T>(run: () => Promise<T>): Promise<T> => {
      try {
        return await run();
      } catch (error) {
        if (error instanceof NativeComposeRouteClaimError) {
          throw error;
        }
        return refuse();
      }
    };
    const prepareClaims = async (
      names: readonly string[]
    ): Promise<Claim[]> => {
      const current = await activeEntries(await journals());
      const claims: Claim[] = [];
      for (const hostname of names) {
        const existing = await readClaim(hostname);
        if (!existing) {
          claims.push({
            version: 1,
            hostname,
            binding,
            owner,
            claimToken: token(),
          });
          continue;
        }
        if (!equal(current.entries.get(hostname), existing)) {
          refuse();
        }
        claims.push(existing.claim);
      }
      return claims;
    };
    const publishClaims = async (
      claims: readonly Claim[],
      added: Entry[]
    ): Promise<Entry[]> => {
      const entries: Entry[] = [];
      for (const claim of claims) {
        let entry = await readClaim(claim.hostname);
        if (!entry) {
          const written = await publish(claimPath(claim.hostname), claim);
          entry = { claim, anchor: written.anchor };
          added.push(entry);
        }
        if (!equal(entry.claim, claim)) {
          refuse("E_NATIVE_COMPOSE_ROUTE_CONFLICT");
        }
        entries.push(entry);
      }
      return entries;
    };
    const recordRollback = async (
      attemptId: string,
      added: readonly Entry[]
    ) => {
      if (added.length === 0) {
        return;
      }
      await publish(join(releasesRoot, `${hash(attemptId)}.json`), {
        version: 1,
        binding,
        owner,
        entries: added,
      });
    };
    const removeEntries = async (added: readonly Entry[]) => {
      for (const entry of added) {
        await exactUnlink(claimPath(entry.claim.hostname), {
          text: JSON.stringify(entry.claim),
          anchor: entry.anchor,
        });
      }
    };
    const resumedRetirements = async (
      retired: Map<string, Entry>,
      keep: Set<string>
    ): Promise<Entry[]> => {
      const result: Entry[] = [];
      for (const entry of retired.values()) {
        if (keep.has(entry.claim.hostname)) {
          continue;
        }
        const actual = await optional(claimPath(entry.claim.hostname));
        if (!actual) {
          continue;
        }
        const claim = validateClaim(parse(actual.text));
        // A new owner/token may legitimately claim an already removed hostname.
        // A surviving original token never authorizes an altered inode/content.
        if (
          claim.claimToken !== entry.claim.claimToken ||
          !ownerEqual(claim.owner, owner)
        ) {
          continue;
        }
        if (
          !equal(actual, {
            text: JSON.stringify(entry.claim),
            anchor: entry.anchor,
          })
        ) {
          refuse();
        }
        result.push(entry);
      }
      return result;
    };
    return {
      acquire: (options) =>
        guard(async () => {
          const generationIdentity = options.generationIdentity;
          if (!TOKEN.test(generationIdentity)) {
            refuse();
          }
          const names = hostnames(options.hostnames);
          const claims = await prepareClaims(names);
          const attemptId = token();
          const path = join(attemptsRoot, attemptId);
          await make(path);
          const intent: Intent = {
            version: 1,
            attemptId,
            generationIdentity,
            binding,
            owner,
            claims,
          };
          const intentRead = await publish(join(path, "intent.json"), intent);
          const added: Entry[] = [];
          try {
            const entries = await publishClaims(claims, added);
            const reserved: Reservation = {
              version: 1,
              intentHash: intentRead.anchor.hash,
              entries,
            };
            const reservedRead = await publish(
              join(path, "reserved.json"),
              reserved
            );
            const attempt = freezeAttempt({
              reference: {
                attemptId,
                generationIdentity,
                intent: intentRead.anchor,
                reservation: reservedRead.anchor,
              },
              hostnames: names,
              phase: "reserved",
            });
            live.set(attempt, {
              reference: snapshotReference(attempt.reference),
              added,
            });
            await activeEntries(await journals());
            return attempt;
          } catch (error) {
            // No effects can have occurred: reservation has not returned. Never
            // remove adopted claims, foreign claims, or a changed newly written inode.
            await recordRollback(attemptId, added);
            await removeEntries(added);
            const reservationRead = await optional(join(path, "reserved.json"));
            await publish(join(path, "aborted.json"), {
              version: 1,
              intentHash: intentRead.anchor.hash,
              reservationHash: reservationRead?.anchor.hash ?? null,
            });
            throw error;
          }
        }),
      reopen: (reference) =>
        guard(async () => {
          const snapshot = snapshotReference(reference);
          const records = await journals();
          const result = asAttempt(find(records, snapshot));
          await activeEntries(records);
          return result;
        }),
      markEffectsPossible: (attempt) =>
        guard(async () => {
          const { reference } = capability(attempt);
          const records = await journals();
          const record = find(records, reference);
          if (
            record.aborted ||
            record.armed ||
            record.complete ||
            record.retained ||
            records.some(
              (value) => value.retained || (value.armed && !value.complete)
            )
          ) {
            refuse("E_NATIVE_COMPOSE_ROUTE_RETAINED");
          }
          await mark(attempt, "armed");
        }),
      complete: (options) =>
        guard(async () => {
          const { attempt, assertTransition } = options;
          const { reference } = capability(attempt);
          if (typeof assertTransition !== "function") {
            refuse();
          }
          const records = await journals();
          const record = find(records, reference);
          if (
            !record.armed ||
            record.aborted ||
            record.complete ||
            record.retained
          ) {
            refuse("E_NATIVE_COMPOSE_ROUTE_RETAINED");
          }
          await activeEntries(records);
          await assertTransition();
          await mark(attempt, "complete");
        }),
      retain: (attempt) =>
        guard(async () => {
          const { reference } = capability(attempt);
          const record = find(await journals(), reference);
          if (record.aborted || record.complete || record.retained) {
            refuse();
          }
          await mark(attempt, "retained");
        }),
      rollback: (attempt) =>
        guard(async () => {
          const { reference, added } = capability(attempt);
          const record = find(await journals(), reference);
          if (
            record.aborted ||
            record.armed ||
            record.complete ||
            record.retained
          ) {
            refuse("E_NATIVE_COMPOSE_ROUTE_RETAINED");
          }
          await activeEntries(await journals());
          await recordRollback(reference.attemptId, added);
          await mark(attempt, "aborted");
          await removeEntries(added);
        }),
      release: (options) =>
        guard(async () => {
          const keep = new Set(hostnames(options.keepHostnames ?? []));
          const assertAbsent = options.assertAbsent;
          if (typeof assertAbsent !== "function") {
            refuse();
          }
          const records = await journals();
          if (
            records.some(
              (value) => value.retained || (value.armed && !value.complete)
            )
          ) {
            refuse("E_NATIVE_COMPOSE_ROUTE_RETAINED");
          }
          const current = await activeEntries(records);
          const entries = [...current.entries.values()]
            .filter((entry) => !keep.has(entry.claim.hostname))
            .sort((a, b) => a.claim.hostname.localeCompare(b.claim.hostname));
          // Resume only exact, previously journaled deletion intent, after fresh proof.
          for (const entry of await resumedRetirements(current.retired, keep)) {
            if (!entries.some((value) => equal(value, entry))) {
              entries.push(entry);
            }
          }
          await assertAbsent({
            hostnames: Object.freeze(
              entries.map((entry) => entry.claim.hostname)
            ),
            binding,
            owner,
          });
          await activeEntries(await journals());
          await publish(join(releasesRoot, `${hash(token())}.json`), {
            version: 1,
            binding,
            owner,
            entries,
          });
          for (const entry of entries) {
            await exactUnlink(claimPath(entry.claim.hostname), {
              text: JSON.stringify(entry.claim),
              anchor: entry.anchor,
            });
          }
        }),
      close: async () => {
        if (!closed) {
          closed = true;
          await Promise.all(
            directories.map((directory) => directory.handle.close())
          );
        }
      },
    };
  } catch (error) {
    await Promise.all(directories.map((directory) => directory.handle.close()));
    if (error instanceof NativeComposeRouteClaimError) {
      throw error;
    }
    return refuse();
  }
}
