import { join, posix, resolve } from "node:path";
import { isRecord } from "./guards.ts";
import {
  holdNativeComposeFile,
  NATIVE_COMPOSE_FILE_BYTES_LIMIT,
} from "./native-compose-file-bytes.ts";
import {
  type NativeComposeFileMode,
  nativeComposeFileMode,
  nativeComposeFileModeBits,
} from "./native-compose-file-permissions.ts";
import {
  type HeldDirectory,
  holdDirectory,
  recheckDirectories,
} from "./native-compose-private-state.ts";
import type { RetainedFilePermissionPolicy } from "./native-config-import-files.ts";
import {
  freezeImportValue,
  legacyNativeRetainedFilePolicies,
} from "./native-config-import-plan.ts";

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ID = /^[a-f0-9]{64}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const TRAILING_NEWLINE = /\n$/;
const DECIMAL = /^(0|[1-9]\d*)$/;
const HEX = /^[a-f0-9]+$/;
const PATH_FORBIDDEN = /[\\\0\r\n:]/;
type Kind = "config" | "secret";
export type LegacyComposeRetainedFileGrant = {
  readonly service: string;
  readonly kind: Kind;
  readonly name: string;
  readonly file: string;
  readonly target: string;
};
type SourceFact = {
  readonly kind: Kind;
  readonly name: string;
  readonly file: string;
  readonly dev: number;
  readonly ino: number;
  readonly uid: number;
  readonly gid: number;
  readonly mode: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly digest: string;
};
type GuestFact = {
  readonly service: string;
  readonly container: string;
  readonly target: string;
  readonly dev: number;
  readonly ino: number;
  readonly uid: number;
  readonly gid: number;
  readonly mode: NativeComposeFileMode;
  readonly size: number;
  readonly digest: string;
};
/** Private material digests and identities. Never serialize this proof into a public report. */
export type LegacyComposeRetainedFileProof = {
  readonly sources: readonly SourceFact[];
  readonly guests: readonly GuestFact[];
} & (
  | { readonly file_proof_version: 1 }
  | {
      readonly file_proof_version: 2;
      readonly policies: readonly RetainedFilePermissionPolicy[];
    }
);
export class LegacyComposeRetainedFileError extends Error {
  constructor() {
    super(
      "Retained file material, permissions or original binding could not be verified; values omitted."
    );
    this.name = "LegacyComposeRetainedFileError";
  }
}
function refuse(): never {
  throw new LegacyComposeRetainedFileError();
}
function record(value: unknown): Record<string, unknown> {
  if (
    !isRecord(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    refuse();
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !descriptor?.enumerable ||
      !Object.hasOwn(descriptor, "value")
    ) {
      refuse();
    }
  }
  return value;
}
function keys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): void {
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some(
      (key) => !(required.includes(key) || optional.includes(key))
    )
  ) {
    refuse();
  }
}
function array(value: unknown): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) {
    refuse();
  }
  const length = Object.getOwnPropertyDescriptor(value, "length");
  if (
    !(
      length &&
      Object.hasOwn(length, "value") &&
      identityNumber(length.value)
    ) ||
    Reflect.ownKeys(value).length !== length.value + 1
  ) {
    refuse();
  }
  const result: unknown[] = [];
  for (let index = 0; index < length.value; index++) {
    const entry = Object.getOwnPropertyDescriptor(value, String(index));
    if (!(entry?.enumerable && Object.hasOwn(entry, "value"))) {
      refuse();
    }
    result.push(entry.value);
  }
  return result;
}
function containers(value: unknown): readonly {
  readonly id: string;
  readonly service: string;
  readonly running?: boolean;
}[] {
  const selected = array(value).map((raw) => {
    const item = record(raw);
    keys(item, ["id", "service"], ["name", "running"]);
    if (
      typeof item.id !== "string" ||
      !ID.test(item.id) ||
      typeof item.service !== "string" ||
      (Object.hasOwn(item, "name") && typeof item.name !== "string") ||
      (Object.hasOwn(item, "running") && typeof item.running !== "boolean")
    ) {
      refuse();
    }
    name(item.service);
    return {
      id: item.id,
      service: item.service,
      ...(Object.hasOwn(item, "running")
        ? { running: item.running as boolean }
        : {}),
    };
  });
  if (
    new Set(selected.map((item) => item.id)).size !== selected.length ||
    new Set(selected.map((item) => item.service)).size !== selected.length
  ) {
    refuse();
  }
  return selected;
}
function name(value: string): void {
  if (value.length > 63 || !NAME.test(value)) {
    refuse();
  }
}
function relative(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.startsWith("/") &&
    !PATH_FORBIDDEN.test(value) &&
    value
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..")
  );
}
function target(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith("/") &&
    value !== "/" &&
    !value.endsWith("/") &&
    !PATH_FORBIDDEN.test(value) &&
    posix.normalize(value) === value
  );
}
function identityNumber(value: unknown, positive = false): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= (positive ? 1 : 0)
  );
}
function fileDeclarations(
  candidate: Record<string, unknown>,
  kind: Kind
): Record<string, unknown> {
  const namespace = `${kind}s`;
  const definitions = Object.hasOwn(candidate, namespace)
    ? record(candidate[namespace])
    : Object.create(null);
  for (const [key, value] of Object.entries(definitions)) {
    name(key);
    const declaration = record(value);
    keys(declaration, ["file"]);
    if (!relative(declaration.file)) {
      refuse();
    }
  }
  return definitions;
}
type GrantContext = {
  readonly storage: Record<string, unknown>;
  readonly definitions: Readonly<Record<Kind, Record<string, unknown>>>;
  readonly grants: LegacyComposeRetainedFileGrant[];
  readonly policies?: readonly RetainedFilePermissionPolicy[];
};
function validateRetainedStorage(storage: Record<string, unknown>): void {
  for (const [logical, raw] of Object.entries(storage)) {
    name(logical);
    const declaration = record(raw);
    keys(declaration, ["kind", "scope"]);
    if (declaration.kind !== "persistent" || declaration.scope !== "worktree") {
      refuse();
    }
  }
}
function appendRetainedMount(
  opts: GrantContext & {
    readonly service: string;
    readonly raw: unknown;
    readonly targets: Set<string>;
  }
): void {
  const mount = record(opts.raw);
  if (
    !(Object.hasOwn(mount, "target") && target(mount.target)) ||
    opts.targets.has(mount.target)
  ) {
    refuse();
  }
  opts.targets.add(mount.target);
  if (Object.hasOwn(mount, "storage")) {
    keys(mount, ["storage", "target", "access"]);
    if (
      typeof mount.storage !== "string" ||
      !Object.hasOwn(opts.storage, mount.storage) ||
      !["read-only", "read-write"].includes(String(mount.access))
    ) {
      refuse();
    }
    return;
  }
  const kind = Object.hasOwn(mount, "config") ? "config" : "secret";
  keys(mount, [kind, "target", "access", "mode"]);
  const logical = mount[kind];
  const mode = nativeComposeFileMode(mount.mode);
  if (
    typeof logical !== "string" ||
    !Object.hasOwn(opts.definitions[kind], logical) ||
    mount.access !== "read-only" ||
    !mode ||
    (kind === "config" && mode !== "0444")
  ) {
    refuse();
  }
  if (kind === "secret") {
    const policy = opts.policies?.find(
      (entry) =>
        entry.service === opts.service &&
        entry.kind === kind &&
        entry.name === logical &&
        entry.target === mount.target
    );
    if (!policy || mode !== (policy.declaredMode ?? "0444")) {
      refuse();
    }
  }
  const declaration = record(opts.definitions[kind][logical]);
  if (!relative(declaration.file)) {
    refuse();
  }
  opts.grants.push({
    service: opts.service,
    kind,
    name: logical,
    file: declaration.file,
    target: mount.target,
  });
}
function appendRetainedWorkload(
  opts: GrantContext & {
    readonly service: string;
    readonly raw: unknown;
  }
): void {
  name(opts.service);
  const workload = record(opts.raw);
  keys(
    workload,
    ["image"],
    [
      "command",
      "entrypoint",
      "environment",
      "restart",
      "init",
      "shutdown",
      "mounts",
    ]
  );
  if (typeof workload.image !== "string" || workload.image.length === 0) {
    refuse();
  }
  if (!Object.hasOwn(workload, "mounts")) {
    return;
  }
  const targets = new Set<string>();
  for (const raw of array(workload.mounts)) {
    appendRetainedMount({ ...opts, raw, targets });
  }
}
/** Closed original-file family: static image services, local named storage, no jobs/build/profile or generated/managed file sources. */
export function legacyComposeRetainedFileGrants(
  candidateValue: unknown
): readonly LegacyComposeRetainedFileGrant[] {
  const candidate = record(candidateValue);
  keys(
    candidate,
    ["schema_version", "name", "services", "storage"],
    ["configs", "secrets"]
  );
  if (candidate.schema_version !== 1 || typeof candidate.name !== "string") {
    refuse();
  }
  name(candidate.name);
  const definitions = {
    config: fileDeclarations(candidate, "config"),
    secret: fileDeclarations(candidate, "secret"),
  };
  const services = record(candidate.services);
  const storage = record(candidate.storage);
  if (Object.keys(services).length === 0 || Object.keys(storage).length === 0) {
    refuse();
  }
  validateRetainedStorage(storage);
  const grants: LegacyComposeRetainedFileGrant[] = [];
  for (const [service, raw] of Object.entries(services)) {
    appendRetainedWorkload({
      service,
      raw,
      storage,
      definitions,
      grants,
      policies: legacyNativeRetainedFilePolicies(candidate),
    });
  }
  if (grants.length === 0) {
    refuse();
  }
  grants.sort(
    (a, b) =>
      a.service.localeCompare(b.service) || a.target.localeCompare(b.target)
  );
  freezeImportValue(grants);
  return grants;
}
function sourceKey(value: Pick<SourceFact, "kind" | "name">): string {
  return `${value.kind}/${value.name}`;
}
function guestKey(value: Pick<GuestFact, "service" | "target">): string {
  return `${value.service}:${value.target}`;
}
function parseSource(value: unknown): SourceFact {
  const item = record(value);
  keys(item, [
    "kind",
    "name",
    "file",
    "dev",
    "ino",
    "uid",
    "gid",
    "mode",
    "size",
    "mtimeMs",
    "ctimeMs",
    "digest",
  ]);
  if (
    (item.kind !== "config" && item.kind !== "secret") ||
    typeof item.name !== "string" ||
    !relative(item.file) ||
    !identityNumber(item.dev) ||
    !identityNumber(item.ino, true) ||
    !identityNumber(item.uid) ||
    !identityNumber(item.gid) ||
    !identityNumber(item.mode) ||
    item.mode > 0o777 ||
    !identityNumber(item.size) ||
    item.size > NATIVE_COMPOSE_FILE_BYTES_LIMIT ||
    typeof item.mtimeMs !== "number" ||
    !Number.isFinite(item.mtimeMs) ||
    typeof item.ctimeMs !== "number" ||
    !Number.isFinite(item.ctimeMs) ||
    typeof item.digest !== "string" ||
    !DIGEST.test(item.digest)
  ) {
    refuse();
  }
  name(item.name);
  return {
    kind: item.kind,
    name: item.name,
    file: item.file,
    dev: item.dev,
    ino: item.ino,
    uid: item.uid,
    gid: item.gid,
    mode: item.mode,
    size: item.size,
    mtimeMs: item.mtimeMs,
    ctimeMs: item.ctimeMs,
    digest: item.digest,
  };
}
function parseGuest(value: unknown, version: 1 | 2): GuestFact {
  const item = record(value);
  keys(item, [
    "service",
    "container",
    "target",
    "dev",
    "ino",
    "uid",
    "gid",
    "mode",
    "size",
    "digest",
  ]);
  if (
    typeof item.service !== "string" ||
    typeof item.container !== "string" ||
    !ID.test(item.container) ||
    !target(item.target) ||
    !identityNumber(item.dev) ||
    !identityNumber(item.ino, true) ||
    !identityNumber(item.uid) ||
    !identityNumber(item.gid) ||
    !nativeComposeFileMode(item.mode) ||
    (version === 1 && item.mode !== "0444") ||
    !identityNumber(item.size) ||
    item.size > NATIVE_COMPOSE_FILE_BYTES_LIMIT ||
    typeof item.digest !== "string" ||
    !DIGEST.test(item.digest)
  ) {
    refuse();
  }
  name(item.service);
  return {
    service: item.service,
    container: item.container,
    target: item.target,
    dev: item.dev,
    ino: item.ino,
    uid: item.uid,
    gid: item.gid,
    mode: nativeComposeFileMode(item.mode) ?? refuse(),
    size: item.size,
    digest: item.digest,
  };
}
function parsePolicy(value: unknown): RetainedFilePermissionPolicy {
  const item = record(value);
  keys(item, ["service", "kind", "name", "target", "declaredMode"]);
  if (
    typeof item.service !== "string" ||
    typeof item.name !== "string" ||
    (item.kind !== "config" && item.kind !== "secret") ||
    !target(item.target) ||
    (item.declaredMode !== null && !nativeComposeFileMode(item.declaredMode))
  ) {
    refuse();
  }
  name(item.service);
  name(item.name);
  return {
    service: item.service,
    kind: item.kind,
    name: item.name,
    target: item.target,
    declaredMode:
      item.declaredMode === null
        ? null
        : (nativeComposeFileMode(item.declaredMode) ?? refuse()),
  };
}
function effectiveMode(opts: {
  readonly candidate: unknown;
  readonly grant: LegacyComposeRetainedFileGrant;
  readonly source: SourceFact;
}): NativeComposeFileMode {
  if (opts.grant.kind === "config") {
    return "0444";
  }
  const policy = legacyNativeRetainedFilePolicies(opts.candidate)?.find(
    (entry) =>
      entry.service === opts.grant.service &&
      entry.target === opts.grant.target &&
      entry.kind === "secret" &&
      entry.name === opts.grant.name
  );
  const mode = new Map<number, NativeComposeFileMode>([
    [0o400, "0400"],
    [0o600, "0600"],
  ]).get(opts.source.mode);
  if (
    !(policy && mode) ||
    (policy.declaredMode !== null && policy.declaredMode !== mode)
  ) {
    refuse();
  }
  return mode;
}

function assertProofSources(opts: {
  readonly sources: readonly SourceFact[];
  readonly grants: ReadonlyMap<string, LegacyComposeRetainedFileGrant>;
}) {
  for (const source of opts.sources) {
    const grant = opts.grants.get(sourceKey(source));
    if (
      grant?.file !== source.file ||
      source.uid !== process.getuid?.() ||
      (source.kind === "secret"
        ? ![0o400, 0o600].includes(source.mode)
        : (source.mode & 0o022) !== 0)
    ) {
      refuse();
    }
  }
}
/** Saved proof parsing binds every private claim to the actual converted source and exact original container. */
export function readLegacyComposeRetainedFileProof(opts: {
  readonly proof: unknown;
  readonly candidate: unknown;
  readonly containers: readonly {
    readonly id: string;
    readonly service: string;
  }[];
}): LegacyComposeRetainedFileProof {
  const grants = legacyComposeRetainedFileGrants(opts.candidate);
  const originals = containers(opts.containers);
  const value = record(opts.proof);
  if (value.file_proof_version !== 1 && value.file_proof_version !== 2) {
    refuse();
  }
  const version = value.file_proof_version;
  keys(
    value,
    version === 1
      ? ["file_proof_version", "sources", "guests"]
      : ["file_proof_version", "sources", "guests", "policies"]
  );
  const protectedGrants = grants.some((grant) => grant.kind === "secret");
  if ((version === 2) !== protectedGrants) {
    refuse();
  }
  const policies =
    version === 2 ? array(value.policies).map(parsePolicy) : undefined;
  if (
    policies &&
    JSON.stringify(policies) !==
      JSON.stringify(legacyNativeRetainedFilePolicies(opts.candidate))
  ) {
    refuse();
  }
  const sources = array(value.sources).map(parseSource);
  const guests = array(value.guests).map((entry) => parseGuest(entry, version));
  const unique = new Map(grants.map((grant) => [sourceKey(grant), grant]));
  if (
    sources.length !== unique.size ||
    guests.length !== grants.length ||
    new Set(sources.map(sourceKey)).size !== sources.length ||
    new Set(guests.map(guestKey)).size !== guests.length
  ) {
    refuse();
  }
  assertProofSources({ sources, grants: unique });
  for (const grant of grants) {
    const source = sources.find(
      (entry) => sourceKey(entry) === sourceKey(grant)
    );
    const matches = originals.filter(
      (container) => container.service === grant.service
    );
    const guest = guests.find((entry) => guestKey(entry) === guestKey(grant));
    if (
      !(source && guest) ||
      matches.length !== 1 ||
      guest.container !== matches[0]?.id ||
      guest.size !== source.size ||
      guest.digest !== source.digest ||
      guest.mode !== effectiveMode({ candidate: opts.candidate, grant, source })
    ) {
      refuse();
    }
  }
  sources.sort((a, b) => sourceKey(a).localeCompare(sourceKey(b)));
  guests.sort((a, b) => guestKey(a).localeCompare(guestKey(b)));
  const result: LegacyComposeRetainedFileProof =
    version === 1
      ? { file_proof_version: 1, sources, guests }
      : {
          file_proof_version: 2,
          sources,
          guests,
          policies: policies ?? refuse(),
        };
  freezeImportValue(result);
  return result;
}
/** Normalize only an issued raw candidate through its closed original permission proof. No material lookup or owner remapping. */
export function normalizeLegacyComposeRetainedFileCandidate(opts: {
  readonly candidate: unknown;
  readonly proof: unknown;
  readonly containers: readonly {
    readonly id: string;
    readonly service: string;
  }[];
}): Readonly<Record<string, unknown>> {
  const proof = readLegacyComposeRetainedFileProof(opts);
  const candidate = record(opts.candidate);
  if (proof.file_proof_version === 1) {
    return candidate;
  }
  if (!legacyNativeRetainedFilePolicies(candidate)) {
    refuse();
  }
  const services = Object.fromEntries(
    Object.entries(record(candidate.services)).map(([service, raw]) => {
      const workload = record(raw);
      if (!Object.hasOwn(workload, "mounts")) {
        return [service, workload];
      }
      const mounts = array(workload.mounts).map((rawMount) => {
        const mount = record(rawMount);
        if (!Object.hasOwn(mount, "secret")) {
          return mount;
        }
        const guest = proof.guests.find(
          (entry) => entry.service === service && entry.target === mount.target
        );
        if (!guest) {
          refuse();
        }
        return { ...mount, mode: guest.mode };
      });
      return [service, { ...workload, mounts }];
    })
  );
  const result = { ...candidate, services };
  freezeImportValue(result);
  return result;
}
/** Descriptor-held reads preserve binary/empty material. The returned proof has no bytes; temporary buffers are zeroed and all FDs close. */
export async function observeLegacyComposeRetainedFileSources(opts: {
  readonly projectRoot: string;
  readonly candidate: unknown;
  readonly signal?: AbortSignal;
}): Promise<readonly SourceFact[]> {
  const grants = legacyComposeRetainedFileGrants(opts.candidate);
  const selected = [
    ...new Map(grants.map((grant) => [sourceKey(grant), grant])).values(),
  ].sort((a, b) => sourceKey(a).localeCompare(sourceKey(b)));
  const root = resolve(opts.projectRoot);
  if (root !== opts.projectRoot) {
    refuse();
  }
  const directories: HeldDirectory[] = [];
  const facts: SourceFact[] = [];
  let remaining = NATIVE_COMPOSE_FILE_BYTES_LIMIT;
  try {
    directories.push(await holdDirectory(root, false));
    for (const grant of selected) {
      if (opts.signal?.aborted) {
        refuse();
      }
      let parent = root;
      for (const part of grant.file.split("/").slice(0, -1)) {
        parent = join(parent, part);
        if (!directories.some((held) => held.path === parent)) {
          directories.push(await holdDirectory(parent, false));
        }
      }
      await recheckDirectories(directories);
      const held = await holdNativeComposeFile({
        path: join(root, grant.file),
        modes: grant.kind === "secret" ? [0o400, 0o600] : [],
        limit: remaining,
      });
      try {
        await held.assertFresh();
        const info = held.info;
        const fact: SourceFact = {
          kind: grant.kind,
          name: grant.name,
          file: grant.file,
          dev: info.dev,
          ino: info.ino,
          uid: info.uid,
          gid: info.gid,
          mode: info.mode & 0o777,
          size: info.size,
          mtimeMs: info.mtimeMs,
          ctimeMs: info.ctimeMs,
          digest: held.anchor.digest,
        };
        for (const request of grants.filter(
          (entry) => sourceKey(entry) === sourceKey(grant)
        )) {
          effectiveMode({
            candidate: opts.candidate,
            grant: request,
            source: fact,
          });
        }
        facts.push(fact);
        remaining -= info.size;
        await recheckDirectories(directories);
        await held.assertFresh();
      } finally {
        await held.close();
      }
    }
    if (opts.signal?.aborted) {
      refuse();
    }
    await recheckDirectories(directories);
    freezeImportValue(facts);
    return facts;
  } finally {
    await Promise.allSettled(directories.map((held) => held.file.close()));
  }
}

function parseGuestStat(
  raw: string,
  sourceSize: number,
  requiredMode: NativeComposeFileMode
) {
  const parts = raw.replace(TRAILING_NEWLINE, "").split(":");
  if (
    parts.length !== 7 ||
    parts.slice(0, 5).some((part) => !DECIMAL.test(part)) ||
    !HEX.test(parts[5] ?? "") ||
    parts[6] !== requiredMode.slice(1)
  ) {
    refuse();
  }
  const [dev, ino, uid, gid, size] = parts.slice(0, 5).map(Number);
  if (
    !(
      identityNumber(dev) &&
      identityNumber(ino, true) &&
      identityNumber(uid) &&
      identityNumber(gid) &&
      identityNumber(size)
    ) ||
    size !== sourceSize ||
    (Number.parseInt(parts[5] ?? "", 16) & 0xf0_00) !== 0x80_00 ||
    (Number.parseInt(parts[5] ?? "", 16) & 0o777) !==
      nativeComposeFileModeBits(requiredMode)
  ) {
    refuse();
  }
  return { dev, ino, uid, gid, size };
}
async function observeRunningGuest(opts: {
  readonly grant: LegacyComposeRetainedFileGrant;
  readonly container: { readonly id: string };
  readonly source: SourceFact;
  readonly probe: (args: readonly string[]) => Promise<string>;
  readonly mode: NativeComposeFileMode;
}): Promise<GuestFact> {
  const { grant, container, source, probe } = opts;
  const raw = await probe([
    "exec",
    container.id,
    "stat",
    "-c",
    "%d:%i:%u:%g:%s:%f:%a",
    "--",
    grant.target,
  ]);
  const { dev, ino, uid, gid, size } = parseGuestStat(
    raw,
    source.size,
    opts.mode
  );
  const digest = await probe([
    "exec",
    container.id,
    "sha256sum",
    "--",
    grant.target,
  ]);
  if (digest !== `${source.digest}  ${grant.target}\n`) {
    refuse();
  }
  const repeated = await probe([
    "exec",
    container.id,
    "stat",
    "-c",
    "%d:%i:%u:%g:%s:%f:%a",
    "--",
    grant.target,
  ]);
  if (repeated !== raw) {
    refuse();
  }
  return {
    service: grant.service,
    container: container.id,
    target: grant.target,
    dev,
    ino,
    uid,
    gid,
    mode: opts.mode,
    size,
    digest: source.digest,
  };
}
/** Fixed read-only guest commands emit only stat fields and a private digest. They cannot authorize effects or replace original bind checks. */
export async function observeLegacyComposeRetainedFileGuests(opts: {
  readonly candidate: unknown;
  readonly containers: readonly {
    readonly id: string;
    readonly service: string;
    readonly running: boolean;
  }[];
  readonly sources: readonly SourceFact[];
  readonly saved?: LegacyComposeRetainedFileProof;
  readonly probe: (args: readonly string[]) => Promise<string>;
}): Promise<readonly GuestFact[]> {
  const originals = containers(opts.containers);
  const sources = array(opts.sources).map(parseSource);
  const saved =
    opts.saved === undefined
      ? undefined
      : readLegacyComposeRetainedFileProof({
          proof: opts.saved,
          candidate: opts.candidate,
          containers: originals,
        });
  const guests: GuestFact[] = [];
  for (const grant of legacyComposeRetainedFileGrants(opts.candidate)) {
    const matches = originals.filter(
      (container) => container.service === grant.service
    );
    const container = matches[0];
    const source = sources.find(
      (entry) => sourceKey(entry) === sourceKey(grant)
    );
    if (
      matches.length !== 1 ||
      !container ||
      !ID.test(container.id) ||
      !source
    ) {
      refuse();
    }
    if (!container.running) {
      const old = saved?.guests.find(
        (entry) => guestKey(entry) === guestKey(grant)
      );
      if (
        !old ||
        old.container !== container.id ||
        old.size !== source.size ||
        old.digest !== source.digest
      ) {
        refuse();
      }
      guests.push(old);
      continue;
    }
    guests.push(
      await observeRunningGuest({
        grant,
        container,
        source,
        probe: opts.probe,
        mode: effectiveMode({ candidate: opts.candidate, grant, source }),
      })
    );
  }
  guests.sort((a, b) => guestKey(a).localeCompare(guestKey(b)));
  freezeImportValue(guests);
  return guests;
}

/** Private full proof; repeated descriptor reads fence changes while guest observations run. */
export async function observeLegacyComposeRetainedFileProof(opts: {
  readonly projectRoot: string;
  readonly candidate: unknown;
  readonly containers: readonly {
    readonly id: string;
    readonly service: string;
    readonly running: boolean;
  }[];
  readonly saved?: LegacyComposeRetainedFileProof;
  readonly signal?: AbortSignal;
  readonly probe: (args: readonly string[]) => Promise<string>;
}): Promise<LegacyComposeRetainedFileProof> {
  const originals = containers(opts.containers);
  if (originals.some((container) => container.running === undefined)) {
    refuse();
  }
  const saved =
    opts.saved === undefined
      ? undefined
      : readLegacyComposeRetainedFileProof({
          proof: opts.saved,
          candidate: opts.candidate,
          containers: originals,
        });
  const sources = await observeLegacyComposeRetainedFileSources(opts);
  if (saved && JSON.stringify(sources) !== JSON.stringify(saved.sources)) {
    refuse();
  }
  const guests = await observeLegacyComposeRetainedFileGuests({
    ...opts,
    sources,
    saved,
  });
  if (saved && JSON.stringify(guests) !== JSON.stringify(saved.guests)) {
    refuse();
  }
  const repeated = await observeLegacyComposeRetainedFileSources(opts);
  if (JSON.stringify(sources) !== JSON.stringify(repeated)) {
    refuse();
  }
  return readLegacyComposeRetainedFileProof({
    proof: legacyComposeRetainedFileGrants(opts.candidate).some(
      (grant) => grant.kind === "secret"
    )
      ? {
          file_proof_version: 2,
          sources,
          guests,
          policies:
            legacyNativeRetainedFilePolicies(opts.candidate) ?? refuse(),
        }
      : { file_proof_version: 1, sources, guests },
    candidate: opts.candidate,
    containers: opts.containers,
  });
}
