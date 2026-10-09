import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join, posix } from "node:path";
import { resolveComposeStartupTimeoutMs } from "./compose-startup-budget.ts";
import { isRecord } from "./guards.ts";
import {
  nativeComposeFileDigest,
  refuseNativeComposeFile,
} from "./native-compose-file-bytes.ts";
import {
  consumeNativeComposeFileRetirementProof,
  type NativeComposeFileProjection,
  type NativeComposeFileRetirementProof,
  nativeComposeFileHostProjectionMatches,
} from "./native-compose-file-owner.ts";
import {
  assertNativeComposeFileSources,
  type NativeComposeFileSources,
  withNativeComposeFileBytes,
} from "./native-compose-file-sources.ts";
import {
  type NativeComposeFileMember,
  type NativeComposeFileReference,
  parseNativeComposeFileReference,
  sameNativeComposeFileState,
} from "./native-compose-file-state.ts";
import {
  assertNativeComposeMaterialAuthority,
  type NativeComposeGeneration,
  type NativeComposeMaterialAuthority,
  type NativeComposeMaterialBinding,
  type NativeComposeReservation,
  runNativeComposeMaterialAction,
} from "./native-compose-generation.ts";
import type { NativeComposeOwnershipObservation } from "./native-compose-ownership.ts";
import {
  holdDirectory,
  keys,
  readPrivate,
  recheckDirectories,
  sameFile,
  token,
  writeExclusive,
} from "./native-compose-private-state.ts";
import { createNativeComposeVmFileClient } from "./native-compose-vm-file-client.ts";
import {
  NATIVE_COMPOSE_VM_FILE_IMAGE,
  NATIVE_COMPOSE_VM_FILE_LIMIT,
  NATIVE_COMPOSE_VM_FILES_EXTENSION,
  parseVmFileFacts,
  parseVmFileJournal,
  resolveVmFileOwnership,
  VM_FILE_IMAGE_FORMAT,
  VM_FILE_OBSERVER_PROGRAM,
  VM_FILE_VERIFY_PROGRAM,
  VM_FILE_WRITER_PROGRAM,
  type VmFileFacts,
  vmFileJournalReady,
} from "./native-compose-vm-file-protocol.ts";

type Anchor = {
  readonly dev: number;
  readonly ino: number;
  readonly digest: string;
};
type Document = Readonly<Record<string, unknown>>;
type Client = ReturnType<typeof createNativeComposeVmFileClient>;
type Image = {
  readonly workload: string;
  readonly reference: string;
  readonly id: string;
  readonly user: string;
  readonly labels: Readonly<Record<string, string>>;
};
type Volume = {
  readonly name: string;
  readonly driver: "local";
  readonly scope: "local";
  readonly created: string;
  readonly mountpoint: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly options: null | Readonly<Record<string, never>>;
};
type Container = {
  readonly id: string;
  readonly immutable: Readonly<Record<string, unknown>>;
  readonly running: boolean;
  readonly status: string;
  readonly exitCode: number;
  readonly restarts: number;
  readonly execs: readonly string[];
};
export type NativeComposeVmFileReference = {
  readonly version: 1;
  readonly host: NativeComposeFileReference;
  readonly manifest: Anchor;
  readonly journal: Anchor;
  readonly intent: Anchor;
};
type Manifest = {
  readonly version: 1;
  readonly engineId: string;
  readonly host: NativeComposeFileReference;
  readonly volume: Volume;
  readonly observer: Container["immutable"];
  readonly helper: Image;
  readonly images: readonly Image[];
  readonly facts: VmFileFacts;
};
const ID = /^[a-f0-9]{64}$/;
const UNSAFE_MOUNTPOINT = /[,\0\r\n\\]/;
const VOLUME_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const MEMBER_ID = /^[a-f0-9]{32}$/;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const VOLUME_FORMAT =
  '{"name":{{json .Name}},"driver":{{json .Driver}},"scope":{{json .Scope}},"created":{{json .CreatedAt}},"mountpoint":{{json .Mountpoint}},"labels":{{json .Labels}},"options":{{json .Options}}}';
const CONTAINER_FORMAT =
  '{"id":{{json .Id}},"name":{{json .Name}},"created":{{json .Created}},"image":{{json .Image}},"labels":{{json .Config.Labels}},"entrypoint":{{json .Config.Entrypoint}},"command":{{json .Config.Cmd}},"user":{{json .Config.User}},"openStdin":{{json .Config.OpenStdin}},"tty":{{json .Config.Tty}},"network":{{json .HostConfig.NetworkMode}},"ports":{{json .HostConfig.PortBindings}},"restart":{{json .HostConfig.RestartPolicy}},"readonly":{{json .HostConfig.ReadonlyRootfs}},"privileged":{{json .HostConfig.Privileged}},"capAdd":{{json .HostConfig.CapAdd}},"capDrop":{{json .HostConfig.CapDrop}},"security":{{json .HostConfig.SecurityOpt}},"autoRemove":{{json .HostConfig.AutoRemove}},"mounts":{{json .Mounts}},"running":{{json .State.Running}},"status":{{json .State.Status}},"exitCode":{{json .State.ExitCode}},"restarts":{{json .RestartCount}},"execs":{{json .ExecIDs}}}';
const projections = new WeakMap<
  NativeComposeFileProjection,
  { readonly host: NativeComposeFileProjection }
>();
function digest(text: string): string {
  return nativeComposeFileDigest(Buffer.from(text));
}
function anchored(
  text: string,
  info: { readonly dev: number; readonly ino: number }
): Anchor {
  return { dev: info.dev, ino: info.ino, digest: digest(text) };
}
function requireValue(value: unknown): asserts value {
  if (!value) {
    refuseNativeComposeFile();
  }
}
function json(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return refuseNativeComposeFile();
  }
}
function ordered(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(ordered);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, ordered(value[key])])
    );
  }
  return value;
}
function canonicalMounts(value: unknown): readonly unknown[] {
  requireValue(Array.isArray(value));
  return value
    .map(ordered)
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
function sameOwner(
  saved: unknown,
  current: NativeComposeMaterialBinding
): void {
  // Receipt and lease incarnations legitimately change at publication and on a
  // saved mutation. The host owner verifies those current fences separately.
  requireValue(
    isRecord(saved) &&
      sameNativeComposeFileState(saved.identity, current.identity) &&
      saved.generationId === current.generationId &&
      sameNativeComposeFileState(saved.checkout, current.checkout)
  );
}
function literal(value: string): string {
  return value.replaceAll("$", () => "$$");
}
function path(host: NativeComposeFileReference): string {
  return join(host.root, `${host.generationId}-${host.snapshotToken}`);
}
function labels(
  host: NativeComposeFileReference,
  selectedToken: string,
  role: string
): Record<string, string> {
  return {
    "io.hack.native-file.generation": host.generationId,
    "io.hack.native-file.owner": host.rootToken,
    "io.hack.native-file.token": selectedToken,
    "io.hack.native-file.role": role,
  };
}
function imageLabels(value: unknown): Readonly<Record<string, string>> {
  if (value === null) {
    return Object.freeze({});
  }
  requireValue(isRecord(value));
  const entries = Object.entries(value);
  const selected: [string, string][] = [];
  requireValue(entries.length <= 128);
  let size = 0;
  for (const [key, entry] of entries) {
    requireValue(
      key.length > 0 &&
        key.length <= 1024 &&
        typeof entry === "string" &&
        entry.length <= 4096
    );
    selected.push([key, entry]);
    size += Buffer.byteLength(key) + Buffer.byteLength(entry);
  }
  requireValue(size <= 64 * 1024);
  return Object.freeze(Object.fromEntries(selected));
}
function parseImage(value: unknown): Image {
  requireValue(
    isRecord(value) &&
      keys(value, "id,labels,reference,user,workload") &&
      typeof value.id === "string" &&
      IMAGE_ID.test(value.id) &&
      typeof value.reference === "string" &&
      typeof value.user === "string" &&
      typeof value.workload === "string"
  );
  return Object.freeze({
    workload: value.workload,
    reference: value.reference,
    id: value.id,
    user: value.user,
    labels: imageLabels(value.labels),
  });
}
function helperLabels(opts: {
  readonly host: NativeComposeFileReference;
  readonly token: string;
  readonly role: "writer" | "observer";
  readonly inherited: Readonly<Record<string, string>>;
}): Readonly<Record<string, string>> {
  const issued = labels(opts.host, opts.token, opts.role);
  requireValue(
    Object.keys(issued).every((key) => !Object.hasOwn(opts.inherited, key))
  );
  return Object.freeze({ ...opts.inherited, ...issued });
}
async function image(
  client: Client,
  reference: string,
  workload: string
): Promise<Image> {
  const row = json(
    await client.call([
      "image",
      "inspect",
      "--format",
      VM_FILE_IMAGE_FORMAT,
      reference,
    ])
  );
  return decodeNativeComposeVmFileImage({ value: row, workload, reference });
}
/** Decode only the bounded image projection; no material or engine authority. */
export function decodeNativeComposeVmFileImage(opts: {
  readonly value: unknown;
  readonly workload: string;
  readonly reference: string;
}): Image {
  const row = opts.value;
  requireValue(
    isRecord(row) &&
      keys(row, "id,labels,user,volumes") &&
      (row.volumes === null ||
        (isRecord(row.volumes) && Object.keys(row.volumes).length === 0))
  );
  return parseImage({
    workload: opts.workload,
    reference: opts.reference,
    id: row.id,
    user: row.user,
    labels: row.labels,
  });
}
function volume(
  text: string,
  expectedName: string,
  expectedLabels: Readonly<Record<string, string>>
): Volume {
  const row = json(text);
  requireValue(
    isRecord(row) &&
      typeof row.mountpoint === "string" &&
      !UNSAFE_MOUNTPOINT.test(row.mountpoint)
  );
  requireValue(
    isRecord(row) &&
      keys(row, "created,driver,labels,mountpoint,name,options,scope") &&
      row.name === expectedName &&
      row.driver === "local" &&
      row.scope === "local" &&
      typeof row.created === "string" &&
      Number.isFinite(Date.parse(row.created)) &&
      typeof row.mountpoint === "string" &&
      row.mountpoint.startsWith("/") &&
      row.mountpoint !== "/" &&
      posix.normalize(row.mountpoint) === row.mountpoint &&
      row.mountpoint.endsWith(`/volumes/${expectedName}/_data`) &&
      (row.options === null ||
        (isRecord(row.options) && Object.keys(row.options).length === 0)) &&
      sameNativeComposeFileState(row.labels, expectedLabels)
  );
  return Object.freeze({
    name: expectedName,
    driver: "local",
    scope: "local",
    created: row.created,
    mountpoint: row.mountpoint,
    labels: Object.freeze({ ...expectedLabels }),
    options: row.options === null ? null : Object.freeze({}),
  });
}
async function inspect(client: Client, id: string): Promise<Container> {
  requireValue(ID.test(id));
  const row = json(
    await client.call([
      "container",
      "inspect",
      "--format",
      CONTAINER_FORMAT,
      id,
    ])
  );
  requireValue(
    isRecord(row) &&
      keys(
        row,
        "autoRemove,capAdd,capDrop,command,created,entrypoint,execs,exitCode,id,image,labels,mounts,name,network,openStdin,ports,privileged,readonly,restart,restarts,running,security,status,tty,user"
      ) &&
      row.id === id &&
      typeof row.running === "boolean" &&
      typeof row.status === "string" &&
      typeof row.exitCode === "number" &&
      Number.isSafeInteger(row.exitCode) &&
      row.restarts === 0 &&
      (row.execs === null ||
        (Array.isArray(row.execs) &&
          row.execs.every((id) => typeof id === "string" && ID.test(id))))
  );
  const { running, status, exitCode, restarts, execs, ...immutable } = row;
  return {
    id,
    immutable: { ...immutable, mounts: canonicalMounts(immutable.mounts) },
    running,
    status,
    exitCode,
    restarts,
    execs: execs ?? [],
  };
}
function assertHelper(
  row: Container,
  opts: {
    readonly host: NativeComposeFileReference;
    readonly token: string;
    readonly role: "writer" | "observer";
    readonly image: Image;
    readonly name: string;
    readonly volume: Volume;
    readonly facts?: VmFileFacts;
  }
): void {
  const r = row.immutable;
  const caps =
    opts.role === "writer"
      ? ["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETGID", "SETUID"]
      : ["DAC_OVERRIDE", "SETGID", "SETUID"];
  requireValue(
    r.name === `/${opts.name}` &&
      typeof r.created === "string" &&
      Number.isFinite(Date.parse(r.created)) &&
      r.image === opts.image.id &&
      r.user === "0:0" &&
      r.openStdin === true &&
      r.tty === false &&
      r.network === "none" &&
      r.readonly === true &&
      r.privileged === false &&
      r.autoRemove === false &&
      (r.ports === null ||
        (isRecord(r.ports) && Object.keys(r.ports).length === 0)) &&
      sameNativeComposeFileState(
        r.labels,
        helperLabels({
          host: opts.host,
          token: opts.token,
          role: opts.role,
          inherited: opts.image.labels,
        })
      ) &&
      sameNativeComposeFileState(r.entrypoint, ["/usr/local/bin/bun"]) &&
      sameNativeComposeFileState(r.command, [
        "-e",
        opts.role === "writer"
          ? VM_FILE_WRITER_PROGRAM
          : VM_FILE_OBSERVER_PROGRAM,
      ]) &&
      sameNativeComposeFileState(r.restart, {
        Name: "no",
        MaximumRetryCount: 0,
      }) &&
      sameNativeComposeFileState(r.capDrop, ["ALL"]) &&
      Array.isArray(r.capAdd) &&
      sameNativeComposeFileState([...r.capAdd].sort(), caps) &&
      sameNativeComposeFileState(r.security, ["no-new-privileges"]) &&
      Array.isArray(r.mounts) &&
      r.mounts.length ===
        (opts.role === "writer" ? 1 : 1 + (opts.facts?.members.length ?? -1))
  );
  requireValue(
    r.mounts.filter(
      (mount) =>
        isRecord(mount) &&
        mount.Type === "volume" &&
        mount.Name === opts.volume.name &&
        mount.Source === opts.volume.mountpoint &&
        mount.Destination === "/material" &&
        mount.RW === (opts.role === "writer")
    ).length === 1
  );
  if (opts.role === "observer") {
    requireValue(opts.facts);
    for (const row of opts.facts.members) {
      requireValue(
        r.mounts.filter(
          (raw) =>
            isRecord(raw) &&
            raw.Type === "bind" &&
            (raw.Name === undefined || raw.Name === "") &&
            raw.Source === `${opts.volume.mountpoint}/${row.id}` &&
            raw.Destination === `/projection/${row.id}` &&
            raw.RW === false
        ).length === 1
      );
    }
  }
}
async function allContainers(client: Client): Promise<
  readonly {
    readonly id: string;
    readonly image: string;
    readonly user: string;
    readonly mounts: readonly unknown[];
  }[]
> {
  const text = await client.call([
    "container",
    "ls",
    "-a",
    "--no-trunc",
    "--format",
    "{{json .ID}}",
  ]);
  const ids = text.trim() === "" ? [] : text.trim().split("\n").map(json);
  requireValue(
    ids.every((id) => typeof id === "string" && ID.test(id)) &&
      new Set(ids).size === ids.length
  );
  const rows: {
    id: string;
    image: string;
    user: string;
    mounts: readonly unknown[];
  }[] = [];
  for (const id of ids) {
    requireValue(typeof id === "string");
    const row = json(
      await client.call([
        "container",
        "inspect",
        "--format",
        '{"id":{{json .Id}},"image":{{json .Image}},"user":{{json .Config.User}},"mounts":{{json .Mounts}}}',
        id,
      ])
    );
    requireValue(
      isRecord(row) &&
        keys(row, "id,image,mounts,user") &&
        row.id === id &&
        typeof row.image === "string" &&
        IMAGE_ID.test(row.image) &&
        typeof row.user === "string" &&
        Array.isArray(row.mounts)
    );
    rows.push({ id, image: row.image, user: row.user, mounts: row.mounts });
  }
  return rows;
}
async function volumeNames(client: Client): Promise<readonly string[]> {
  const text = await client.call([
    "volume",
    "ls",
    "--format",
    "{{json .Name}}",
  ]);
  const names = text.trim() === "" ? [] : text.trim().split("\n").map(json);
  requireValue(
    names.every((name) => typeof name === "string" && VOLUME_NAME.test(name)) &&
      new Set(names).size === names.length
  );
  return names.filter((name): name is string => typeof name === "string");
}
async function writerOnly(
  client: Client,
  writer: Container,
  selectedVolume: Volume
): Promise<void> {
  let count = 0;
  for (const row of await allContainers(client)) {
    for (const raw of row.mounts) {
      requireValue(
        isRecord(raw) &&
          typeof raw.Type === "string" &&
          typeof raw.Source === "string" &&
          typeof raw.Destination === "string" &&
          typeof raw.RW === "boolean"
      );
      if (
        !(
          (raw.Type === "volume" && raw.Name === selectedVolume.name) ||
          (raw.Source.startsWith("/") &&
            overlaps(posix.normalize(raw.Source), selectedVolume.mountpoint))
        )
      ) {
        continue;
      }
      requireValue(
        row.id === writer.id &&
          raw.Type === "volume" &&
          raw.Name === selectedVolume.name &&
          raw.Source === selectedVolume.mountpoint &&
          raw.Destination === "/material" &&
          raw.RW === true &&
          ++count === 1
      );
    }
  }
  requireValue(count === 1);
}
function overlaps(left: string, right: string): boolean {
  return (
    left === right ||
    left.startsWith(`${right}/`) ||
    right.startsWith(left === "/" ? "/" : `${left}/`)
  );
}
function consumerMount(opts: {
  readonly raw: unknown;
  readonly id: string;
  readonly manifest: Manifest;
  readonly observerId: string;
  readonly observer: boolean;
  readonly allowed: ReadonlyMap<
    string,
    readonly { readonly source: string; readonly target: string }[]
  >;
}): boolean {
  const { raw, id, manifest, observerId, observer, allowed } = opts;
  requireValue(
    isRecord(raw) &&
      typeof raw.Type === "string" &&
      typeof raw.Source === "string" &&
      typeof raw.Destination === "string" &&
      typeof raw.RW === "boolean"
  );
  const related =
    (raw.Type === "volume" && raw.Name === manifest.volume.name) ||
    (raw.Source.startsWith("/") &&
      overlaps(posix.normalize(raw.Source), manifest.volume.mountpoint));
  if (!related) {
    return observer;
  }
  if (raw.Type === "bind") {
    requireValue(raw.Name === undefined || raw.Name === "");
  }
  if (
    id === observerId &&
    raw.Type === "volume" &&
    raw.Name === manifest.volume.name &&
    raw.Source === manifest.volume.mountpoint &&
    raw.Destination === "/material" &&
    raw.RW === false &&
    !observer
  ) {
    return true;
  }
  if (
    id === observerId &&
    raw.Type === "bind" &&
    raw.RW === false &&
    manifest.facts.members.some(
      (member) =>
        raw.Source === `${manifest.volume.mountpoint}/${member.id}` &&
        raw.Destination === `/projection/${member.id}`
    )
  ) {
    return observer;
  }
  requireValue(
    raw.Type === "bind" &&
      raw.RW === false &&
      allowed
        .get(id)
        ?.some(
          (grant) =>
            grant.source === raw.Source && grant.target === raw.Destination
        )
  );
  return observer;
}
async function consumers(
  client: Client,
  manifest: Manifest,
  allowed: ReadonlyMap<
    string,
    readonly { readonly source: string; readonly target: string }[]
  > = new Map()
): Promise<void> {
  const rows = await allContainers(client);
  let observer = false;
  const observerId = manifest.observer.id;
  requireValue(typeof observerId === "string");
  for (const row of rows) {
    for (const raw of row.mounts) {
      observer = consumerMount({
        raw,
        id: row.id,
        manifest,
        observerId,
        observer,
        allowed,
      });
    }
  }
  for (const [id, grants] of allowed) {
    const row = rows.find((container) => container.id === id);
    requireValue(row);
    const member = manifest.facts.members.find((member) =>
      grants.some(
        (grant) =>
          grant.target === member.target &&
          grant.source === `${manifest.volume.mountpoint}/${member.id}`
      )
    );
    const expectedImage = manifest.images.find(
      (image) => image.workload === member?.workload
    );
    requireValue(
      expectedImage &&
        row.image === expectedImage.id &&
        row.user === expectedImage.user
    );
    for (const grant of grants) {
      requireValue(
        row.mounts.filter(
          (raw) =>
            isRecord(raw) &&
            raw.Type === "bind" &&
            raw.Source === grant.source &&
            raw.Destination === grant.target &&
            raw.RW === false
        ).length === 1
      );
    }
  }
  requireValue(observer);
}
function binds(manifest: Manifest): NativeComposeFileProjection["workloads"] {
  const workloads: Record<
    string,
    NativeComposeFileProjection["workloads"][string]
  > = Object.create(null);
  for (const row of manifest.facts.members) {
    workloads[row.workload] = [
      ...(workloads[row.workload] ?? []),
      {
        type: "bind",
        source: literal(`${manifest.volume.mountpoint}/${row.id}`),
        target: literal(row.target),
        read_only: true,
        bind: { create_host_path: false },
      },
    ];
  }
  return workloads;
}
export function nativeComposeVmProjectionHost(
  projection: NativeComposeFileProjection
): NativeComposeFileProjection | null {
  const selected = projections.get(projection);
  return selected?.host ?? null;
}
function reference(value: unknown): NativeComposeVmFileReference {
  requireValue(
    isRecord(value) &&
      keys(value, "host,intent,journal,manifest,version") &&
      value.version === 1 &&
      isRecord(value.host)
  );
  for (const anchor of [value.journal, value.manifest, value.intent]) {
    requireValue(
      isRecord(anchor) &&
        keys(anchor, "dev,digest,ino") &&
        typeof anchor.dev === "number" &&
        Number.isSafeInteger(anchor.dev) &&
        anchor.dev >= 0 &&
        typeof anchor.ino === "number" &&
        Number.isSafeInteger(anchor.ino) &&
        anchor.ino > 0 &&
        typeof anchor.digest === "string" &&
        ID.test(anchor.digest)
    );
  }
  const host = parseNativeComposeFileReference(value.host);
  requireValue(
    isRecord(value.manifest) &&
      isRecord(value.journal) &&
      isRecord(value.intent)
  );
  return {
    version: 1,
    host,
    manifest: {
      dev: Number(value.manifest.dev),
      ino: Number(value.manifest.ino),
      digest: String(value.manifest.digest),
    },
    journal: {
      dev: Number(value.journal.dev),
      ino: Number(value.journal.ino),
      digest: String(value.journal.digest),
    },
    intent: {
      dev: Number(value.intent.dev),
      ino: Number(value.intent.ino),
      digest: String(value.intent.digest),
    },
  };
}
async function state(document: Document) {
  const ref = reference(document[NATIVE_COMPOSE_VM_FILES_EXTENSION]);
  const directory = await holdDirectory(path(ref.host), true);
  const root = await holdDirectory(ref.host.root, true).catch(
    async (error: unknown) => {
      await directory.file.close();
      throw error;
    }
  );
  try {
    requireValue(
      sameFile(directory.info, ref.host.snapshotDirectory) &&
        sameFile(root.info, ref.host.rootDirectory)
    );
    const read = await readPrivate(
      join(directory.path, "vm-manifest.json"),
      NATIVE_COMPOSE_VM_FILE_LIMIT
    );
    requireValue(
      sameFile(read.info, ref.manifest) &&
        digest(read.text) === ref.manifest.digest
    );
    const raw = json(read.text);
    requireValue(
      isRecord(raw) &&
        keys(
          raw,
          "engineId,facts,helper,host,images,observer,version,volume"
        ) &&
        raw.version === 1 &&
        typeof raw.engineId === "string" &&
        sameNativeComposeFileState(raw.host, ref.host) &&
        isRecord(raw.volume) &&
        typeof raw.volume.name === "string" &&
        isRecord(raw.volume.labels) &&
        isRecord(raw.observer) &&
        typeof raw.observer.id === "string" &&
        ID.test(raw.observer.id) &&
        Array.isArray(raw.images)
    );
    const facts = parseVmFileFacts(JSON.stringify(raw.facts));
    const intent = await readPrivate(
      join(directory.path, "vm-intent.json"),
      NATIVE_COMPOSE_VM_FILE_LIMIT
    );
    requireValue(
      sameFile(intent.info, ref.intent) &&
        digest(intent.text) === ref.intent.digest
    );
    const intended = json(intent.text);
    requireValue(
      isRecord(intended) &&
        keys(intended, "binding,engineId,helper,host,name,token,version") &&
        intended.version === 1 &&
        intended.engineId === raw.engineId &&
        intended.token === facts.token &&
        intended.name === raw.volume.name &&
        intended.helper === raw.observer.image &&
        sameNativeComposeFileState(intended.host, ref.host) &&
        isRecord(intended.binding) &&
        intended.binding.generationId === ref.host.generationId
    );
    const selectedVolume = volume(
      JSON.stringify(raw.volume),
      raw.volume.name,
      labels(ref.host, facts.token, "volume")
    );
    const helper = parseImage(raw.helper);
    requireValue(
      helper.workload === "" &&
        helper.reference === NATIVE_COMPOSE_VM_FILE_IMAGE &&
        helper.id === raw.observer.image
    );
    const images: Image[] = [];
    for (const row of raw.images) {
      images.push(parseImage(row));
    }
    const workloads = new Set(facts.members.map((row) => row.workload));
    requireValue(
      images.length === workloads.size &&
        new Set(images.map((row) => row.workload)).size === images.length &&
        images.every((row) => workloads.has(row.workload))
    );
    const manifest: Manifest = {
      version: 1,
      engineId: raw.engineId,
      host: ref.host,
      volume: selectedVolume,
      observer: raw.observer,
      helper,
      images,
      facts,
    };
    requireValue(
      typeof manifest.observer.image === "string" &&
        IMAGE_ID.test(manifest.observer.image)
    );
    assertHelper(
      {
        id: raw.observer.id,
        immutable: manifest.observer,
        running: false,
        status: "created",
        exitCode: 0,
        restarts: 0,
        execs: [],
      },
      {
        host: ref.host,
        token: facts.token,
        role: "observer",
        image: manifest.helper,
        name: `${selectedVolume.name}-observer`,
        volume: selectedVolume,
        facts,
      }
    );
    const journal = {
      ...(await readPrivate(
        join(directory.path, "vm-journal.jsonl"),
        NATIVE_COMPOSE_VM_FILE_LIMIT
      )),
    };
    requireValue(
      sameFile(journal.info, ref.journal) &&
        journal.text.startsWith(
          `${JSON.stringify({ version: 1, kind: "native-compose-vm-file-journal", token: facts.token, generationId: ref.host.generationId })}\n`
        ) &&
        digest(`${journal.text.split("\n")[0]}\n`) === ref.journal.digest
    );
    const header = `${journal.text.split("\n")[0]}\n`;
    const phases = [...parseVmFileJournal({ text: journal.text, header })];
    const check = async () => {
      await recheckDirectories([root, directory]);
      const next = await readPrivate(
        join(directory.path, "vm-manifest.json"),
        NATIVE_COMPOSE_VM_FILE_LIMIT
      );
      requireValue(
        sameFile(next.info, ref.manifest) && next.text === read.text
      );
      const nextIntent = await readPrivate(
        join(directory.path, "vm-intent.json"),
        NATIVE_COMPOSE_VM_FILE_LIMIT
      );
      requireValue(
        sameFile(nextIntent.info, ref.intent) && nextIntent.text === intent.text
      );
      const nextJournal = await readPrivate(
        join(directory.path, "vm-journal.jsonl"),
        NATIVE_COMPOSE_VM_FILE_LIMIT
      );
      requireValue(
        sameFile(nextJournal.info, journal.info) &&
          nextJournal.text === journal.text
      );
    };
    return {
      ref,
      manifest,
      binding: intended.binding,
      phases,
      check,
      append: async (phase: string) => {
        await check();
        parseVmFileJournal({
          text: `${journal.text}${JSON.stringify({ phase })}\n`,
          header,
        });
        const fd = await open(
          join(directory.path, "vm-journal.jsonl"),
          constants.O_WRONLY |
            constants.O_APPEND |
            constants.O_NOFOLLOW |
            constants.O_NONBLOCK
        );
        try {
          requireValue(sameFile(await fd.stat(), journal.info));
          const addition = `${JSON.stringify({ phase })}\n`;
          requireValue(
            Buffer.byteLength(journal.text) + Buffer.byteLength(addition) <=
              NATIVE_COMPOSE_VM_FILE_LIMIT
          );
          await fd.writeFile(addition);
          await fd.sync();
          await directory.file.sync();
          journal.text += addition;
          phases.push(phase);
          await check();
        } finally {
          await fd.close();
        }
      },
      close: async () => {
        await directory.file.close();
        await root.file.close();
      },
    };
  } catch (error) {
    await directory.file.close();
    await root.file.close();
    throw error;
  }
}

/** Convert only an actually issued host snapshot under the same material lease.
 * A failed/unknown stage remains private and unpublishable; close never cleans it. */
export async function stageNativeComposeVmFiles(opts: {
  readonly authority: NativeComposeMaterialAuthority;
  readonly reservation: NativeComposeReservation;
  readonly sources: NativeComposeFileSources;
  readonly host: NativeComposeFileProjection;
  readonly engineId: string;
  readonly signal: AbortSignal;
  readonly deadline: number;
}): Promise<NativeComposeFileProjection> {
  const { authority, reservation, sources, host, engineId, signal, deadline } =
    opts;
  return await runNativeComposeMaterialAction({
    authority,
    run: async () => {
      const check = async () => {
        requireValue(
          !signal.aborted &&
            Date.now() < deadline &&
            nativeComposeFileHostProjectionMatches({
              projection: host,
              plan: sources.result.plan,
              environmentPlan: sources.result.environment_plan,
              filePlan: sources.result.file_plan,
              projectRoot: reservation.identity.checkoutRoot,
              runtimeIdentity: reservation.identity.composeProject,
              ownerToken: reservation.identity.ownerToken,
              generationIdentity: reservation.generationId,
            })
        );
        await assertNativeComposeMaterialAuthority({
          authority,
          reservation,
          phase: "prepare",
        });
        await assertNativeComposeFileSources({
          authority,
          reservation,
          sources,
        });
      };
      await check();
      let currentCheck = check;
      const client = createNativeComposeVmFileClient({
        engineId,
        signal,
        deadline,
        assertFresh: async () => await currentCheck(),
      });
      const helper = await image(client, NATIVE_COMPOSE_VM_FILE_IMAGE, "");
      const images: Image[] = [];
      const payload: {
        id: string;
        workload: string;
        target: string;
        mode: string;
        uid: number;
        gid: number;
        bytes: string;
      }[] = [];
      const digests = new Map<string, string>();
      await withNativeComposeFileBytes({
        authority,
        reservation,
        sources,
        run: async (acquired) => {
          for (const row of acquired) {
            let selected = images.find(
              (entry) => entry.workload === row.workload
            );
            if (!selected) {
              const plan = sources.result.plan;
              const namespace =
                isRecord(plan.services) &&
                Object.hasOwn(plan.services, row.workload)
                  ? plan.services
                  : plan.jobs;
              requireValue(
                isRecord(namespace) && Object.hasOwn(namespace, row.workload)
              );
              const workload = namespace[row.workload];
              requireValue(
                isRecord(workload) &&
                  typeof workload.image === "string" &&
                  (workload.pull_policy === undefined ||
                    workload.pull_policy === "missing" ||
                    workload.pull_policy === "never")
              );
              selected = await image(client, workload.image, row.workload);
              images.push(selected);
            }
            const grant = host.workloads[row.workload]?.find(
              (bind) => bind.target === literal(row.binding.target)
            );
            requireValue(grant);
            const id = grant.source.slice(grant.source.lastIndexOf("/") + 1);
            requireValue(MEMBER_ID.test(id));
            digests.set(id, nativeComposeFileDigest(row.bytes));
            payload.push({
              id,
              workload: row.workload,
              target: row.binding.target,
              mode: row.binding.mode,
              ...resolveVmFileOwnership({
                uid: row.binding.uid,
                gid: row.binding.gid,
                imageUser: selected.user,
              }),
              bytes: Buffer.from(row.bytes).toString("base64"),
            });
          }
        },
      });
      const selectedToken = token();
      // Reject inherited ownership-label collisions before the first resource effect.
      for (const role of ["writer", "observer"] as const) {
        helperLabels({
          host: host.reference,
          token: selectedToken,
          role,
          inherited: helper.labels,
        });
      }
      const name = `hack-files-${host.reference.generationId}-${selectedToken}`;
      const directory = await holdDirectory(path(host.reference), true);
      try {
        const header = `${JSON.stringify({ version: 1, kind: "native-compose-vm-file-journal", token: selectedToken, generationId: host.reference.generationId })}\n`;
        let journalText = header;
        const journalInfo = await writeExclusive(
          join(directory.path, "vm-journal.jsonl"),
          header
        );
        const intentText = JSON.stringify({
          version: 1,
          engineId,
          name,
          token: selectedToken,
          host: host.reference,
          helper: helper.id,
          binding: await assertNativeComposeMaterialAuthority({
            authority,
            reservation,
            phase: "prepare",
          }),
        });
        const intentInfo = await writeExclusive(
          join(directory.path, "vm-intent.json"),
          intentText
        );
        await directory.file.sync();
        const checkIntent = async () => {
          await check();
          await recheckDirectories([directory]);
          const intent = await readPrivate(
            join(directory.path, "vm-intent.json"),
            NATIVE_COMPOSE_VM_FILE_LIMIT
          );
          requireValue(
            sameFile(intent.info, intentInfo) && intent.text === intentText
          );
        };
        currentCheck = checkIntent;
        const append = async (phase: string) => {
          await checkIntent();
          const before = await readPrivate(
            join(directory.path, "vm-journal.jsonl"),
            NATIVE_COMPOSE_VM_FILE_LIMIT
          );
          requireValue(
            sameFile(before.info, journalInfo) && before.text === journalText
          );
          const fd = await open(
            join(directory.path, "vm-journal.jsonl"),
            constants.O_WRONLY |
              constants.O_APPEND |
              constants.O_NOFOLLOW |
              constants.O_NONBLOCK
          );
          try {
            requireValue(sameFile(await fd.stat(), journalInfo));
            const text = `${JSON.stringify({ phase })}\n`;
            parseVmFileJournal({ text: journalText + text, header });
            await fd.writeFile(text);
            await fd.sync();
            await directory.file.sync();
            journalText += text;
            const after = await readPrivate(
              join(directory.path, "vm-journal.jsonl"),
              NATIVE_COMPOSE_VM_FILE_LIMIT
            );
            requireValue(
              sameFile(after.info, journalInfo) && after.text === journalText
            );
            await checkIntent();
          } finally {
            await fd.close();
          }
        };
        await checkIntent();
        requireValue(!(await volumeNames(client)).includes(name));
        await checkIntent();
        await client.call([
          "volume",
          "create",
          "--driver",
          "local",
          ...Object.entries(
            labels(host.reference, selectedToken, "volume")
          ).flatMap(([key, value]) => ["--label", `${key}=${value}`]),
          name,
        ]);
        const selectedVolume = volume(
          await client.call([
            "volume",
            "inspect",
            "--format",
            VOLUME_FORMAT,
            name,
          ]),
          name,
          labels(host.reference, selectedToken, "volume")
        );
        await append("volume-created");
        const create = async (role: "writer" | "observer") => {
          await checkIntent();
          const expectedName = `${name}-${role}`;
          const caps =
            role === "writer"
              ? ["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETGID", "SETUID"]
              : ["DAC_OVERRIDE", "SETGID", "SETUID"];
          const id = (
            await client.call([
              "container",
              "create",
              "--pull",
              "never",
              "--name",
              expectedName,
              "--network",
              "none",
              "--read-only",
              "--user",
              "0:0",
              "--restart",
              "no",
              "--cap-drop",
              "ALL",
              ...caps.flatMap((cap) => ["--cap-add", cap]),
              "--security-opt",
              "no-new-privileges",
              ...Object.entries(
                labels(host.reference, selectedToken, role)
              ).flatMap(([key, value]) => ["--label", `${key}=${value}`]),
              "--mount",
              `type=volume,source=${name},target=/material,volume-nocopy${role === "observer" ? ",readonly" : ""}`,
              ...(role === "observer"
                ? facts.members.flatMap((row) => [
                    "--mount",
                    `type=bind,source=${selectedVolume.mountpoint}/${row.id},target=/projection/${row.id},readonly`,
                  ])
                : []),
              "--entrypoint",
              "/usr/local/bin/bun",
              "--interactive",
              helper.id,
              "-e",
              role === "writer"
                ? VM_FILE_WRITER_PROGRAM
                : VM_FILE_OBSERVER_PROGRAM,
            ])
          ).trim();
          const row = await inspect(client, id);
          assertHelper(row, {
            host: host.reference,
            token: selectedToken,
            role,
            image: helper,
            name: expectedName,
            volume: selectedVolume,
            facts: role === "observer" ? facts : undefined,
          });
          requireValue(
            row.status === "created" && !row.running && row.execs.length === 0
          );
          return row;
        };
        const writer = await create("writer");
        await append("writer-created");
        await writerOnly(client, writer, selectedVolume);
        await append("writer-armed");
        const input = Buffer.from(
          JSON.stringify({ version: 1, token: selectedToken, members: payload })
        );
        let facts: VmFileFacts;
        try {
          facts = parseVmFileFacts(
            await client.call(
              ["container", "start", "--attach", "--interactive", writer.id],
              input
            )
          );
        } finally {
          input.fill(0);
          for (const row of payload) {
            row.bytes = "";
          }
        }
        requireValue(
          facts.token === selectedToken &&
            facts.members.length === payload.length &&
            facts.members.every((row, index) => {
              const expected = payload[index];
              return (
                expected &&
                row.id === expected.id &&
                row.workload === expected.workload &&
                row.target === expected.target &&
                row.mode === expected.mode &&
                row.uid === expected.uid &&
                row.gid === expected.gid &&
                row.digest === digests.get(row.id)
              );
            })
        );
        const completed = await inspect(client, writer.id);
        requireValue(
          sameNativeComposeFileState(completed.immutable, writer.immutable) &&
            completed.status === "exited" &&
            !completed.running &&
            completed.exitCode === 0 &&
            completed.execs.length === 0
        );
        await append("writer-complete");
        const observer = await create("observer");
        await append("observer-created");
        await append("observer-armed");
        await check();
        await client.call(["container", "start", observer.id]);
        const observed = await inspect(client, observer.id);
        requireValue(
          sameNativeComposeFileState(observed.immutable, observer.immutable) &&
            observed.running &&
            observed.status === "running" &&
            observed.execs.length === 0
        );
        await check();
        const stopped = await inspect(client, writer.id);
        requireValue(sameNativeComposeFileState(stopped, completed));
        await client.call(["container", "rm", writer.id]);
        requireValue(
          !(await allContainers(client)).some((row) => row.id === writer.id)
        );
        await append("writer-removed");
        const manifest: Manifest = {
          version: 1,
          engineId,
          host: host.reference,
          volume: selectedVolume,
          observer: observer.immutable,
          helper,
          images,
          facts,
        };
        await consumers(client, manifest);
        await append("observe-armed");
        const verified = parseVmFileFacts(
          await client.call(
            [
              "container",
              "exec",
              "--interactive",
              observer.id,
              "/usr/local/bin/bun",
              "-e",
              VM_FILE_VERIFY_PROGRAM,
            ],
            Buffer.from(JSON.stringify(facts))
          )
        );
        requireValue(sameNativeComposeFileState(verified, facts));
        requireValue((await inspect(client, observer.id)).execs.length === 0);
        await append("observe-complete");
        const manifestText = JSON.stringify(manifest);
        const manifestInfo = await writeExclusive(
          join(directory.path, "vm-manifest.json"),
          manifestText
        );
        await directory.file.sync();
        await append("ready");
        await check();
        const vm: NativeComposeVmFileReference = Object.freeze({
          version: 1,
          host: host.reference,
          manifest: anchored(manifestText, manifestInfo),
          journal: anchored(header, journalInfo),
          intent: anchored(intentText, intentInfo),
        });
        const result: NativeComposeFileProjection = Object.freeze({
          reference: host.reference,
          workloads: Object.freeze(binds(manifest)),
          vm,
          images: Object.freeze(
            Object.fromEntries(images.map((row) => [row.workload, row.id]))
          ),
        });
        projections.set(result, { host });
        return result;
      } finally {
        for (const row of payload) {
          row.bytes = "";
        }
        await directory.file.close();
      }
    },
  }).catch(() => refuseNativeComposeFile());
}

export async function restoreNativeComposeVmHostProjection(
  document: Document,
  host: NativeComposeFileReference,
  expected: NativeComposeFileProjection["workloads"],
  members: readonly NativeComposeFileMember[]
): Promise<Document> {
  const ref = reference(document[NATIVE_COMPOSE_VM_FILES_EXTENSION]);
  requireValue(sameNativeComposeFileState(ref.host, host));
  const selected = await state(document);
  try {
    const m = selected.manifest;
    requireValue(
      m.facts.members.length === members.length &&
        m.facts.members.every((row) =>
          members.some(
            (member) =>
              member.id === row.id &&
              member.workload === row.workload &&
              member.target === row.target &&
              member.file.digest === row.digest
          )
        )
    );
    requireValue(isRecord(document.services));
    const vm = binds(m);
    const services = Object.fromEntries(
      Object.entries(document.services).map(([name, value]) => {
        requireValue(
          isRecord(value) &&
            (value.volumes === undefined || Array.isArray(value.volumes))
        );
        const grants = vm[name] ?? [];
        for (const grant of grants) {
          requireValue(
            (value.volumes ?? []).filter(
              (mount: unknown) =>
                isRecord(mount) &&
                mount.target === grant.target &&
                sameNativeComposeFileState(mount, grant)
            ).length === 1
          );
        }
        for (const raw of value.volumes ?? []) {
          requireValue(isRecord(raw));
          if (
            typeof raw.source === "string" &&
            overlaps(raw.source.replaceAll("$$", "$"), m.volume.mountpoint)
          ) {
            requireValue(
              grants.some((grant) => sameNativeComposeFileState(raw, grant))
            );
          }
        }
        return [
          name,
          {
            ...value,
            volumes: [
              ...(value.volumes ?? []).filter(
                (mount: unknown) =>
                  !(
                    isRecord(mount) &&
                    grants.some((grant) => grant.target === mount.target)
                  )
              ),
              ...(expected[name] ?? []),
            ],
          },
        ];
      })
    );
    await selected.check();
    return { ...document, services };
  } finally {
    await selected.close();
  }
}
/** Local journal readiness is necessary, never sufficient for live guest proof.
 * Saved stop intentionally uses only immutable projection validation instead. */
export async function assertNativeComposeVmJournalReady(
  document: Document
): Promise<void> {
  if (!Object.hasOwn(document, NATIVE_COMPOSE_VM_FILES_EXTENSION)) {
    return;
  }
  const selected = await state(document);
  try {
    requireValue(vmFileJournalReady(selected.phases));
    await selected.check();
  } finally {
    await selected.close();
  }
}

export async function assertNativeComposeVmFiles(opts: {
  readonly authority: NativeComposeMaterialAuthority;
  readonly generation: NativeComposeGeneration;
  readonly document: Document;
  readonly signal: AbortSignal;
  readonly deadline: number;
  readonly observed?: NativeComposeOwnershipObservation;
}): Promise<void> {
  const { authority, generation, document, signal, deadline, observed } = opts;
  if (!Object.hasOwn(document, NATIVE_COMPOSE_VM_FILES_EXTENSION)) {
    return;
  }
  await runNativeComposeMaterialAction({
    authority,
    run: async () => {
      const binding = await assertNativeComposeMaterialAuthority({
        authority,
        generation,
        phase: "inspect",
      });
      const selected = await state(document);
      try {
        sameOwner(selected.binding, binding);
        requireValue(vmFileJournalReady(selected.phases));
        const m = selected.manifest;
        const client = createNativeComposeVmFileClient({
          engineId: m.engineId,
          signal,
          deadline,
          assertFresh: async () => {
            await selected.check();
            await assertNativeComposeMaterialAuthority({
              authority,
              generation,
              phase: "inspect",
            });
          },
        });
        requireValue(
          sameNativeComposeFileState(
            volume(
              await client.call([
                "volume",
                "inspect",
                "--format",
                VOLUME_FORMAT,
                m.volume.name,
              ]),
              m.volume.name,
              m.volume.labels
            ),
            m.volume
          )
        );
        const observerId = m.observer.id;
        requireValue(typeof observerId === "string");
        const current = await inspect(client, observerId);
        requireValue(
          sameNativeComposeFileState(current.immutable, m.observer) &&
            current.running &&
            current.status === "running" &&
            current.execs.length === 0
        );
        for (const row of [m.helper, ...m.images]) {
          requireValue(
            sameNativeComposeFileState(
              await image(client, row.reference, row.workload),
              row
            )
          );
        }
        const allowed = new Map<
          string,
          readonly { source: string; target: string }[]
        >();
        if (observed) {
          for (const workload of new Set(
            m.facts.members.map((row) => row.workload)
          )) {
            const containers = observed.containers.filter(
              (container) =>
                !container.oneoff &&
                container.generationId === generation.generationId &&
                container.service === workload
            );
            requireValue(containers.length === 1);
            const container = containers[0];
            requireValue(container);
            const rows = m.facts.members.filter(
              (row) => row.workload === workload
            );
            allowed.set(
              container.id,
              rows.map((row) => ({
                source: `${m.volume.mountpoint}/${row.id}`,
                target: row.target,
              }))
            );
          }
        }
        requireValue(isRecord(document.services));
        const expected = binds(m);
        for (const [name, grants] of Object.entries(expected)) {
          const service = document.services[name];
          requireValue(
            isRecord(service) &&
              Array.isArray(service.volumes) &&
              service.image ===
                m.images.find((row) => row.workload === name)?.id &&
              service.pull_policy === "never"
          );
          for (const grant of grants) {
            requireValue(
              service.volumes.filter(
                (row: unknown) =>
                  isRecord(row) &&
                  row.target === grant.target &&
                  sameNativeComposeFileState(row, grant)
              ).length === 1
            );
          }
        }
        await consumers(client, m, allowed);
        await selected.append("observe-armed");
        requireValue(
          sameNativeComposeFileState(
            parseVmFileFacts(
              await client.call(
                [
                  "container",
                  "exec",
                  "--interactive",
                  observerId,
                  "/usr/local/bin/bun",
                  "-e",
                  VM_FILE_VERIFY_PROGRAM,
                ],
                Buffer.from(JSON.stringify(m.facts))
              )
            ),
            m.facts
          )
        );
        requireValue((await inspect(client, observerId)).execs.length === 0);
        await selected.append("observe-complete");
        await selected.check();
        await assertNativeComposeMaterialAuthority({
          authority,
          generation,
          phase: "inspect",
        });
      } finally {
        await selected.close();
      }
    },
  });
}

/** Called only inside the existing host owner's children-known retirement fence.
 * Once the observer has been removed, a still-present volume cannot be adopted
 * from name/birth alone on a later invocation. It stays retained. */
export async function retireNativeComposeVmFiles(opts: {
  readonly authority: NativeComposeMaterialAuthority;
  readonly proof: NativeComposeFileRetirementProof;
  readonly document: Document;
}): Promise<void> {
  const { authority, document } = opts;
  if (!Object.hasOwn(document, NATIVE_COMPOSE_VM_FILES_EXTENSION)) {
    return;
  }
  const ref = reference(document[NATIVE_COMPOSE_VM_FILES_EXTENSION]);
  const granted = consumeNativeComposeFileRetirementProof({
    proof: opts.proof,
    authority,
    reference: ref.host,
  });
  const signal = granted.signal;
  const deadline = Date.now() + resolveComposeStartupTimeoutMs();
  await runNativeComposeMaterialAction({
    authority,
    run: async () => {
      const check = async () => {
        requireValue(!signal.aborted && Date.now() < deadline);
        await granted.check();
        await assertNativeComposeMaterialAuthority(granted.selection);
      };
      await check();
      const selected = await state(document);
      try {
        sameOwner(
          selected.binding,
          await assertNativeComposeMaterialAuthority(granted.selection)
        );
        const m = selected.manifest;
        const client = createNativeComposeVmFileClient({
          engineId: m.engineId,
          signal,
          deadline,
          assertFresh: async () => {
            await check();
            await selected.check();
          },
        });
        const last = selected.phases.at(-1);
        if (last === "retired") {
          requireValue(
            !(await allContainers(client)).some(
              (row) => row.id === m.observer.id
            )
          );
          requireValue(!(await volumeNames(client)).includes(m.volume.name));
          return;
        }
        requireValue(vmFileJournalReady(selected.phases));
        await consumers(client, m);
        const observerId = m.observer.id;
        requireValue(typeof observerId === "string");
        const live = await inspect(client, observerId);
        requireValue(
          sameNativeComposeFileState(live.immutable, m.observer) &&
            live.running &&
            live.status === "running" &&
            live.execs.length === 0
        );
        requireValue(
          sameNativeComposeFileState(
            volume(
              await client.call([
                "volume",
                "inspect",
                "--format",
                VOLUME_FORMAT,
                m.volume.name,
              ]),
              m.volume.name,
              m.volume.labels
            ),
            m.volume
          )
        );
        await selected.append("observe-armed");
        requireValue(
          sameNativeComposeFileState(
            parseVmFileFacts(
              await client.call(
                [
                  "container",
                  "exec",
                  "--interactive",
                  observerId,
                  "/usr/local/bin/bun",
                  "-e",
                  VM_FILE_VERIFY_PROGRAM,
                ],
                Buffer.from(JSON.stringify(m.facts))
              )
            ),
            m.facts
          )
        );
        requireValue((await inspect(client, observerId)).execs.length === 0);
        await selected.append("observe-complete");
        await selected.append("retiring");
        await check();
        await client.call(["container", "stop", "--time", "2", observerId]);
        const stopped = await inspect(client, observerId);
        requireValue(
          sameNativeComposeFileState(stopped.immutable, m.observer) &&
            !stopped.running &&
            stopped.status === "exited" &&
            stopped.exitCode === 0 &&
            stopped.execs.length === 0
        );
        await selected.append("observer-stopped");
        await check();
        await consumers(client, m);
        await client.call(["container", "rm", observerId]);
        await selected.append("observer-removed");
        requireValue(
          !(await allContainers(client)).some((row) => row.id === observerId)
        );
        // Recheck full volume/bind absence after removing the only permitted
        // consumer. The live preceding VM witness is never reconstructed on retry.
        const rows = await allContainers(client);
        requireValue(
          rows.every((row) =>
            row.mounts.every(
              (raw) =>
                isRecord(raw) &&
                !(raw.Type === "volume" && raw.Name === m.volume.name) &&
                !(
                  typeof raw.Source === "string" &&
                  raw.Source.startsWith("/") &&
                  overlaps(posix.normalize(raw.Source), m.volume.mountpoint)
                )
            )
          )
        );
        requireValue(
          sameNativeComposeFileState(
            volume(
              await client.call([
                "volume",
                "inspect",
                "--format",
                VOLUME_FORMAT,
                m.volume.name,
              ]),
              m.volume.name,
              m.volume.labels
            ),
            m.volume
          )
        );
        await selected.check();
        await check();
        await client.call(["volume", "rm", m.volume.name]);
        requireValue(!(await volumeNames(client)).includes(m.volume.name));
        await selected.append("retired");
        await check();
      } finally {
        await selected.close();
      }
    },
  });
}
