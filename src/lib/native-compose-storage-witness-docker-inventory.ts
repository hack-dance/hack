import { isRecord } from "./guards.ts";
import { posix } from "node:path";
import type { NativeComposeMaterialBinding } from "./native-compose-generation.ts";
import { createNativeComposeProbe } from "./native-compose-ownership.ts";
import { nativeComposeVolumeCreatedAt } from "./native-compose-retained-storage.ts";
import {
  checkNativeComposeStorageXattrTarget,
  type NativeComposeStorageXattrTarget,
} from "./native-compose-storage-witness-xattr-carrier.ts";
import { refuseNativeComposeStorageXattr as refuse } from "./native-compose-storage-witness-xattr-codec.ts";

const ID = /^[a-f0-9]{64}$/;
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/;
const PREFIX = "io.hack.native-config";
const VOLUME = `{"name":{{json .Name}},"createdAt":{{json .CreatedAt}},"driver":{{json .Driver}},"options":{{json .Options}},"mountpoint":{{json .Mountpoint}},"project":{{json (index .Labels "com.docker.compose.project")}},"instance":{{json (index .Labels "${PREFIX}.instance")}},"owner":{{json (index .Labels "${PREFIX}.owner")}},"version":{{json (index .Labels "${PREFIX}.version")}},"storage":{{json (index .Labels "${PREFIX}.storage")}},"provision":{{json (index .Labels "${PREFIX}.storage-provision")}}}`;
const HOLDER = `{"id":{{json .Id}},"createdAt":{{json .Created}},"mounts":{{json .Mounts}},"running":{{json .State.Running}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"instance":{{json (index .Config.Labels "${PREFIX}.instance")}},"owner":{{json (index .Config.Labels "${PREFIX}.owner")}},"version":{{json (index .Config.Labels "${PREFIX}.version")}},"generation":{{json (index .Config.Labels "${PREFIX}.generation")}},"carrier":{{json (index .Config.Labels "io.hack.storage-witness.carrier")}},"carrierOwner":{{json (index .Config.Labels "io.hack.storage-witness.owner")}},"carrierGeneration":{{json (index .Config.Labels "io.hack.storage-witness.generation")}}}`;
type Probe = ReturnType<typeof createNativeComposeProbe>;
type Selection = { readonly name: string; readonly storage: string };
/** A parent or child bind exposes the selected root too. Normalize complete paths,
 * then compare separator boundaries so a similarly named sibling stays independent. */
export function nativeComposeStorageDockerPathsOverlap(left: string, right: string): boolean {
  if (!(posix.isAbsolute(left) && posix.isAbsolute(right))) return false;
  const a = posix.normalize(left).replace(/\/+$/, "") || "/";
  const b = posix.normalize(right).replace(/\/+$/, "") || "/";
  return a === b || a === "/" || b === "/" || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function rows(text: string): Record<string, unknown>[] {
  if (text.trim() === "") return [];
  return text.trim().split("\n").map((line) => {
    const value: unknown = JSON.parse(line);
    return isRecord(value) ? value : refuse();
  });
}
function strings(text: string, pattern: RegExp): string[] {
  const result = text.trim() === "" ? [] : text.trim().split("\n").map((line) => {
    const value: unknown = JSON.parse(line);
    return typeof value === "string" && pattern.test(value) ? value : refuse();
  });
  if (new Set(result).size !== result.length) return refuse();
  return result.sort();
}
async function volumes(probe: Probe): Promise<string[]> {
  return strings(await probe(["volume", "ls", "--format", "{{json .Name}}"]), NAME);
}
async function containers(probe: Probe): Promise<string[]> {
  return strings(await probe(["container", "ls", "-a", "--no-trunc", "--format", "{{json .ID}}"]), ID);
}
export async function inspectNativeComposeStorageDockerVolume(opts: {
  readonly probe: Probe;
  readonly selection: Selection;
  readonly current: NativeComposeMaterialBinding;
}): Promise<Record<string, unknown>> {
  const { probe, selection, current } = opts;
  if (!NAME.test(selection.name)) return refuse();
  const values = rows(await probe(["volume", "inspect", "--format", VOLUME, selection.name]));
  if (values.length !== 1) return refuse();
  const value = values[0] ?? refuse();
  if (!(value.name === selection.name && nativeComposeVolumeCreatedAt(value.createdAt) &&
    value.project === current.identity.composeProject && value.instance === current.identity.composeProject &&
    value.owner === current.identity.ownerToken && value.version === "1" && value.storage === selection.storage &&
    value.driver === "local" && value.mountpoint === `/var/lib/docker/volumes/${selection.name}/_data` &&
    (value.options === null || (isRecord(value.options) && Object.keys(value.options).length === 0)))) return refuse();
  return value;
}

/** Complete holder reads include foreign containers. The two inventories and selected
 * volume reread are observed fences; they do not claim an atomic daemon transaction. */
export async function observeNativeComposeStorageDockerTarget(opts: {
  readonly probe: Probe;
  readonly selection: Selection;
  readonly current: NativeComposeMaterialBinding;
  readonly engineId: string;
  readonly stopped: boolean;
  /** Only the separately inspected exact created helper may be excluded. */
  readonly carrier?: { readonly id: string; readonly createdAt: string; readonly invocationId: string };
}): Promise<NativeComposeStorageXattrTarget> {
  const { probe, selection, current, engineId, stopped } = opts;
  if (!NAME.test(selection.name)) return refuse();
  if (JSON.parse(await probe(["info", "--format", "{{json .ID}}"])) !== engineId) return refuse();
  const beforeVolumes = await volumes(probe);
  const volume = beforeVolumes.includes(selection.name) ? await inspectNativeComposeStorageDockerVolume(opts) : null;
  const beforeContainers = await containers(probe);
  const holders: Record<string, unknown>[] = [];
  for (let offset = 0; offset < beforeContainers.length; offset += 128) {
    const batch = beforeContainers.slice(offset, offset + 128);
    const values = rows(await probe(["container", "inspect", "--format", HOLDER, ...batch]));
    if (values.length !== batch.length || new Set(values.map((value) => value.id)).size !== batch.length) return refuse();
    for (const value of values) {
      if (!(typeof value.id === "string" && batch.includes(value.id) && Array.isArray(value.mounts))) return refuse();
      let selected = false;
      for (const mount of value.mounts) {
        if (!(isRecord(mount) && typeof mount.Type === "string" && typeof mount.Source === "string" && typeof mount.Destination === "string" && typeof mount.RW === "boolean")) return refuse();
        if ((mount.Type === "volume" && mount.Name === selection.name) ||
          nativeComposeStorageDockerPathsOverlap(mount.Source, `/var/lib/docker/volumes/${selection.name}/_data`)) selected = true;
      }
      if (!selected) continue;
      if (opts.carrier && value.id === opts.carrier.id) {
        if (!(value.createdAt === opts.carrier.createdAt && value.carrier === opts.carrier.invocationId &&
          value.carrierOwner === current.identity.ownerToken && value.carrierGeneration === current.generationId && value.running === false)) return refuse();
        continue;
      }
      if (!(value.project === current.identity.composeProject && value.instance === current.identity.composeProject &&
        value.owner === current.identity.ownerToken && value.version === "1")) return refuse();
      holders.push({ id: value.id, runtimeIdentity: value.project, ownerToken: value.owner, generationId: value.generation, running: value.running });
    }
  }
  const repeated = volume ? await inspectNativeComposeStorageDockerVolume(opts) : null;
  if (JSON.stringify(repeated) !== JSON.stringify(volume) ||
    JSON.stringify(await volumes(probe)) !== JSON.stringify(beforeVolumes) ||
    JSON.stringify(await containers(probe)) !== JSON.stringify(beforeContainers) ||
    JSON.parse(await probe(["info", "--format", "{{json .ID}}"])) !== engineId) return refuse();
  return checkNativeComposeStorageXattrTarget({
    current, engineId, selection, stopped,
    value: { engineId, runtimeIdentity: current.identity.composeProject, ownerToken: current.identity.ownerToken,
      ...selection, volume: volume ? { ...selection, createdAt: volume.createdAt } : null,
      mountpoint: volume?.mountpoint ?? null, driver: volume ? "local" : null,
      options: volume ? {} : null, holders },
  });
}
