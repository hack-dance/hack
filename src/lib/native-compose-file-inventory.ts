import { join, posix } from "node:path";
import { resolveComposeStartupTimeoutMs } from "./compose-startup-budget.ts";
import { isRecord } from "./guards.ts";
import { refuseNativeComposeFile } from "./native-compose-file-bytes.ts";
import {
  NATIVE_COMPOSE_FILES_EXTENSION,
  type NativeComposeFileReference,
  parseNativeComposeFileReference,
} from "./native-compose-file-state.ts";
import {
  createNativeComposeProbe,
  type NativeComposeOwnershipObservation,
} from "./native-compose-ownership.ts";

const ENGINE_ID = /^[A-Za-z0-9:-]{1,128}$/;
const OBJECT_ID = /^[a-f0-9]{64}$/;
const INSPECT_FORMAT = '{"id":{{json .Id}},"mounts":{{json .Mounts}}}';
export const NATIVE_COMPOSE_FILE_ENGINE_EXTENSION = "x-hack-native-file-engine";
type Probe = ReturnType<typeof createNativeComposeProbe>;
type Mount = {
  readonly type: "bind" | "volume" | "tmpfs";
  readonly source: string;
  readonly target: string;
  readonly writable: boolean;
};
type Container = { readonly id: string; readonly mounts: readonly Mount[] };
type Document = Readonly<Record<string, unknown>>;
type ProbeOptions = { readonly signal?: AbortSignal; readonly probe?: Probe };
/** Charge the whole observation, with one configured phase deadline; limits are
 * private protocol I/O bounds, not container-count or workload admission limits. */
function boundedProbe(opts: ProbeOptions): Probe {
  const signal = opts.signal;
  const provided = opts.probe;
  const deadline = Date.now() + resolveComposeStartupTimeoutMs();
  let bytes = 0;
  return async (args) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0 || signal?.aborted) {
      refuseNativeComposeFile();
    }
    const text = await (
      provided ??
      createNativeComposeProbe({
        signal,
        timeoutMs: Math.min(15_000, remaining),
      })
    )(args);
    bytes += Buffer.byteLength(text);
    if (bytes > 8 * 1024 * 1024 || Date.now() >= deadline || signal?.aborted) {
      refuseNativeComposeFile();
    }
    return text;
  };
}

function engine(value: unknown): string {
  return typeof value === "string" && ENGINE_ID.test(value)
    ? value
    : refuseNativeComposeFile();
}
export function readNativeComposeFileEngine(document: Document): string {
  const value = document[NATIVE_COMPOSE_FILE_ENGINE_EXTENSION];
  if (
    !(
      isRecord(value) &&
      Object.keys(value).sort().join() === "engineId,version" &&
      value.version === 1
    )
  ) {
    return refuseNativeComposeFile();
  }
  return engine(value.engineId);
}
async function checkEngine(probe: Probe, expected?: string): Promise<string> {
  const selected = engine(
    JSON.parse(await probe(["info", "--format", "{{json .ID}}"]))
  );
  if (expected !== undefined && selected !== expected) {
    return refuseNativeComposeFile();
  }
  return selected;
}
/** Fixed bounded read only. The private generated document retains this exact engine. */
export async function observeNativeComposeFileEngine(
  opts: {
    readonly expected?: string;
    readonly signal?: AbortSignal;
    readonly probe?: Probe;
  } = {}
): Promise<string> {
  const expected = opts.expected;
  const probe = boundedProbe(opts);
  try {
    const selected = await checkEngine(probe, expected);
    await checkEngine(probe, selected);
    return selected;
  } catch {
    return refuseNativeComposeFile();
  }
}
function objectLines(text: string): Record<string, unknown>[] {
  return text.trim() === ""
    ? []
    : text
        .trim()
        .split("\n")
        .map((line) => {
          const value: unknown = JSON.parse(line);
          return isRecord(value) ? value : refuseNativeComposeFile();
        });
}
function mount(value: unknown): Mount {
  if (
    !(
      isRecord(value) &&
      ["bind", "volume", "tmpfs"].includes(String(value.Type)) &&
      typeof value.Source === "string" &&
      typeof value.Destination === "string" &&
      typeof value.RW === "boolean"
    )
  ) {
    return refuseNativeComposeFile();
  }
  const type = value.Type;
  if (type !== "bind" && type !== "volume" && type !== "tmpfs") {
    return refuseNativeComposeFile();
  }
  return {
    type,
    source: value.Source,
    target: value.Destination,
    writable: value.RW,
  };
}
async function containers(probe: Probe): Promise<readonly Container[]> {
  const listed = await probe([
    "container",
    "ls",
    "-a",
    "--no-trunc",
    "--format",
    "{{json .ID}}",
  ]);
  const ids =
    listed.trim() === ""
      ? []
      : listed
          .trim()
          .split("\n")
          .map((line) => {
            const value: unknown = JSON.parse(line);
            return typeof value === "string" && OBJECT_ID.test(value)
              ? value
              : refuseNativeComposeFile();
          });
  if (new Set(ids).size !== ids.length) {
    return refuseNativeComposeFile();
  }
  const result: Container[] = [];
  for (let start = 0; start < ids.length; start += 128) {
    const batch = ids.slice(start, start + 128);
    const rows = objectLines(
      await probe([
        "container",
        "inspect",
        "--format",
        INSPECT_FORMAT,
        ...batch,
      ])
    );
    if (rows.length !== batch.length) {
      refuseNativeComposeFile();
    }
    for (const row of rows) {
      if (
        !(
          Object.keys(row).sort().join() === "id,mounts" &&
          typeof row.id === "string" &&
          batch.includes(row.id) &&
          !result.some((container) => container.id === row.id) &&
          Array.isArray(row.mounts)
        )
      ) {
        return refuseNativeComposeFile();
      }
      result.push({ id: row.id, mounts: row.mounts.map(mount) });
    }
  }
  return result;
}
function literal(value: unknown): string {
  if (typeof value !== "string") {
    return refuseNativeComposeFile();
  }
  const raw = value.replaceAll("$$", () => "$");
  if (raw.replaceAll("$", () => "$$") !== value) {
    return refuseNativeComposeFile();
  }
  return raw;
}
function fileReference(document: Document): NativeComposeFileReference {
  return parseNativeComposeFileReference(
    document[NATIVE_COMPOSE_FILES_EXTENSION]
  );
}
function snapshot(reference: NativeComposeFileReference): string {
  return join(
    reference.root,
    `${reference.generationId}-${reference.snapshotToken}`
  );
}
function containsPath(parent: string, child: string): boolean {
  return (
    parent === child || child.startsWith(parent === "/" ? "/" : `${parent}/`)
  );
}
function normalizedPath(path: string): string {
  const normalized = posix.normalize(path);
  return normalized !== "/" && normalized.endsWith("/")
    ? normalized.slice(0, -1)
    : normalized;
}
function sourceContains(source: string, path: string): boolean {
  return (
    source.startsWith("/") &&
    containsPath(normalizedPath(source), normalizedPath(path))
  );
}
function overlapsSnapshot(source: string, prefix: string): boolean {
  return (
    sourceContains(source, prefix) ||
    (source.startsWith("/") &&
      containsPath(normalizedPath(prefix), normalizedPath(source)))
  );
}
/** Existing ancestor/root mounts can expose bytes as soon as staging writes them.
 * Other instances' descendant snapshots remain independent. Recheck before effects. */
export async function assertNativeComposeFileRootUnbound(opts: {
  readonly root: string;
  readonly engineId: string;
  readonly signal?: AbortSignal;
  readonly probe?: Probe;
}): Promise<void> {
  const root = normalizedPath(opts.root);
  const expectedEngine = opts.engineId;
  const probe = boundedProbe(opts);
  try {
    if (!root.startsWith("/")) {
      refuseNativeComposeFile();
    }
    await checkEngine(probe, expectedEngine);
    const inventory = await containers(probe);
    if (
      inventory.some((container) =>
        container.mounts.some((mount) => sourceContains(mount.source, root))
      )
    ) {
      refuseNativeComposeFile();
    }
    await checkEngine(probe, expectedEngine);
  } catch {
    refuseNativeComposeFile();
  }
}
function grants(document: Document, prefix: string) {
  if (!isRecord(document.services)) {
    return refuseNativeComposeFile();
  }
  return Object.entries(document.services)
    .map(([service, value]) => {
      if (
        !(
          isRecord(value) &&
          (value.volumes === undefined || Array.isArray(value.volumes))
        )
      ) {
        return refuseNativeComposeFile();
      }
      const selected: Mount[] = [];
      for (const volume of value.volumes ?? []) {
        if (!isRecord(volume)) {
          return refuseNativeComposeFile();
        }
        const source = literal(volume.source);
        if (source.startsWith(`${prefix}/`)) {
          if (!(volume.type === "bind" && volume.read_only === true)) {
            return refuseNativeComposeFile();
          }
          selected.push({
            type: "bind",
            source,
            target: literal(volume.target),
            writable: false,
          });
        }
      }
      return { service, mounts: selected };
    })
    .filter((selected) => selected.mounts.length > 0);
}
function exactMounts(
  actual: readonly Mount[],
  expected: readonly Mount[]
): void {
  for (const grant of expected) {
    const selected = actual.filter((entry) => entry.target === grant.target);
    if (
      !(
        selected.length === 1 &&
        selected[0]?.type === "bind" &&
        selected[0].source === grant.source &&
        selected[0].writable === false
      )
    ) {
      refuseNativeComposeFile();
    }
  }
}
function assertSnapshotMountsGranted(opts: {
  readonly inventory: readonly Container[];
  readonly prefix: string;
  readonly granted: ReadonlyMap<string, readonly Mount[]>;
}): void {
  for (const container of opts.inventory) {
    for (const mount of container.mounts) {
      if (!overlapsSnapshot(mount.source, opts.prefix)) {
        continue;
      }
      if (
        !(
          mount.type === "bind" &&
          !mount.writable &&
          opts.granted
            .get(container.id)
            ?.some(
              (grant) =>
                grant.source === mount.source && grant.target === mount.target
            )
        )
      ) {
        refuseNativeComposeFile();
      }
    }
  }
}
/** Actual binds, including stopped jobs, must match immutable source/target/read-only delivery. */
export async function assertNativeComposeFileMounts(opts: {
  readonly document: Document;
  readonly generationId: string;
  readonly observed: NativeComposeOwnershipObservation;
  readonly signal?: AbortSignal;
  readonly probe?: Probe;
}): Promise<void> {
  const { document, generationId, observed, signal } = opts;
  const observedContainers = observed.containers.map((container) => ({
    ...container,
  }));
  const probe = boundedProbe({ signal, probe: opts.probe });
  try {
    const expectedEngine = readNativeComposeFileEngine(document);
    const reference = fileReference(document);
    if (reference.generationId !== generationId) {
      refuseNativeComposeFile();
    }
    const prefix = snapshot(reference);
    const expected = grants(document, prefix);
    await checkEngine(probe, expectedEngine);
    const inventory = await containers(probe);
    const granted = new Map<string, readonly Mount[]>();
    for (const grant of expected) {
      const selected = observedContainers.filter(
        (container) =>
          !container.oneoff &&
          container.generationId === generationId &&
          container.service === grant.service
      );
      const actual = inventory.find(
        (container) => container.id === selected[0]?.id
      );
      if (!(selected.length === 1 && actual)) {
        return refuseNativeComposeFile();
      }
      exactMounts(actual.mounts, grant.mounts);
      granted.set(actual.id, grant.mounts);
    }
    assertSnapshotMountsGranted({ inventory, prefix, granted });
    await checkEngine(probe, expectedEngine);
  } catch {
    return refuseNativeComposeFile();
  }
}
/** Any engine container still binding the exact snapshot vetoes retirement, regardless of labels. */
export async function assertNativeComposeFileMountsAbsent(opts: {
  readonly document: Document;
  readonly signal?: AbortSignal;
  readonly probe?: Probe;
}): Promise<void> {
  const document = opts.document;
  const probe = boundedProbe(opts);
  try {
    const expectedEngine = readNativeComposeFileEngine(document);
    const prefix = snapshot(fileReference(document));
    await checkEngine(probe, expectedEngine);
    const inventory = await containers(probe);
    if (
      inventory.some((container) =>
        container.mounts.some((mount) => overlapsSnapshot(mount.source, prefix))
      )
    ) {
      return refuseNativeComposeFile();
    }
    await checkEngine(probe, expectedEngine);
  } catch {
    return refuseNativeComposeFile();
  }
}
