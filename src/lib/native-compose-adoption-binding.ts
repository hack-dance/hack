import { resolve } from "node:path";
import { isRecord } from "./guards.ts";
import {
  acquireLegacyComposeBuildSource,
  type LegacyComposeBuildSourceProof,
} from "./native-compose-adoption-build.ts";
import {
  inspectLegacyComposeRetainedBuildImages,
  type LegacyComposeRetainedBuildImage,
} from "./native-compose-adoption-build-images.ts";
import {
  legacyComposeAdoptionCandidateSupported,
  legacyComposeAdoptionLayoutSupported,
} from "./native-compose-adoption-contract.ts";
import { retainLegacyAdoptionLocalRefusal } from "./native-compose-adoption-local.ts";
import {
  type LegacyComposeStorageIntent,
  planLegacyComposeAdoption,
  planLegacyComposeRetainedBasicBuildAdoption,
  planLegacyComposeSourceBindAdoption,
} from "./native-compose-adoption-plan.ts";
import {
  hasLegacyComposeGeneratedSources,
  LegacyComposeAdoptionProjection,
} from "./native-compose-adoption-projection.ts";
import { legacyComposeRetainedPlan } from "./native-compose-adoption-readiness.ts";
import {
  acquireLegacyComposeSourceBind,
  type LegacyComposeSourceBindProof,
} from "./native-compose-adoption-source-bind.ts";
import {
  createNativeComposeProbe,
  NativeComposeOwnershipError,
} from "./native-compose-ownership.ts";
import {
  acquireLegacyAdoptionSourceInputs,
  type NativeConfigImportSourceIdentity,
} from "./native-config-import-inputs.ts";
import {
  freezeImportValue,
  mapLegacyNativeStorageAdoption,
} from "./native-config-import-plan.ts";
import type { LegacyComposeSourceBindIntent } from "./native-config-import-storage.ts";

const ID = /^[a-f0-9]{64}$/;
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/;
const ENGINE_ID = /^[a-zA-Z0-9:._-]{1,128}$/;
const TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/;
const PROJECT = "com.docker.compose.project";
const VERSION = "io.hack.native-config.version";
const ROUTING = [
  "PATH",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH",
  "DOCKER_API_VERSION",
  "CI",
  "HACK_EXECUTION_MODE",
] as const;
const formats = {
  container: {
    list: `{"id":{{json .ID}},"name":{{json .Names}},"project":{{json (.Label "${PROJECT}")}}}`,
    inspect: `{"id":{{json .Id}},"name":{{json .Name}},"project":{{json (index .Config.Labels "${PROJECT}")}},"native":{{json (index .Config.Labels "${VERSION}")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"number":{{json (index .Config.Labels "com.docker.compose.container-number")}},"oneoff":{{json (index .Config.Labels "com.docker.compose.oneoff")}},"running":{{json .State.Running}},"workingDir":{{json (index .Config.Labels "com.docker.compose.project.working_dir")}},"configFiles":{{json (index .Config.Labels "com.docker.compose.project.config_files")}},"mounts":[{{range $i, $m := .Mounts}}{{if $i}},{{end}}{"type":{{json $m.Type}},"name":{{json $m.Name}},"source":{{json $m.Source}},"target":{{json $m.Destination}},"rw":{{json $m.RW}}}{{end}}],"networks":[{{$first := true}}{{range $name, $n := .NetworkSettings.Networks}}{{if not $first}},{{end}}{{$first = false}}{"name":{{json $name}},"id":{{json $n.NetworkID}}}{{end}}]}`,
  },
  volume: {
    list: `{"id":{{json .Name}},"name":{{json .Name}},"project":{{json (.Label "${PROJECT}")}}}`,
    inspect: `{"id":{{json .Name}},"name":{{json .Name}},"project":{{json (index .Labels "${PROJECT}")}},"native":{{json (index .Labels "${VERSION}")}},"storage":{{json (index .Labels "com.docker.compose.volume")}},"createdAt":{{json .CreatedAt}},"driver":{{json .Driver}},"scope":{{json .Scope}},"mountpoint":{{json .Mountpoint}},"options":{{json .Options}}}`,
  },
  network: {
    list: `{"id":{{json .ID}},"name":{{json .Name}},"project":{{json (.Label "${PROJECT}")}}}`,
    inspect: `{"id":{{json .Id}},"name":{{json .Name}},"project":{{json (index .Labels "${PROJECT}")}},"native":{{json (index .Labels "${VERSION}")}},"logical":{{json (index .Labels "com.docker.compose.network")}},"createdAt":{{json .Created}},"driver":{{json .Driver}},"scope":{{json .Scope}},"internal":{{json .Internal}},"containers":[{{$first := true}}{{range $id, $c := .Containers}}{{if not $first}},{{end}}{{$first = false}}{{json $id}}{{end}}]}`,
  },
} as const;
const CUSTOM_CONTAINER_NETWORK_FORMAT = formats.container.inspect.replace(
  '"id":{{json $n.NetworkID}}}',
  '"id":{{json $n.NetworkID}},"aliases":{{json $n.Aliases}}}'
);
const SOURCE_BIND_CONTAINER_FORMAT = formats.container.inspect.replace(
  "{{json $m.Name}}",
  '{{if eq $m.Type "bind"}}{{json (index $m "Name")}}{{else}}{{json $m.Name}}{{end}}'
);
if (CUSTOM_CONTAINER_NETWORK_FORMAT === formats.container.inspect) {
  throw new Error(
    "Legacy adoption inspection format is invalid; values omitted."
  );
}
type Kind = keyof typeof formats;
type Probe = (args: readonly string[]) => Promise<string>;
type Inventory = {
  readonly id: string;
  readonly name: string;
  readonly project: string;
};
type Code =
  | "E_LEGACY_COMPOSE_BINDING_INPUT"
  | "E_LEGACY_COMPOSE_BINDING_UNSUPPORTED"
  | "E_LEGACY_COMPOSE_BINDING_IDENTITY"
  | "E_LEGACY_COMPOSE_BINDING_CHANGED"
  | "E_LEGACY_COMPOSE_BINDING_PROBE"
  | "E_LEGACY_COMPOSE_BINDING_CANCELLED";

/** Fixed redacted failures never retain authored source, daemon output or abort reasons. */
export class LegacyComposeAdoptionBindingError extends Error {
  readonly code: Code;
  constructor(code: Code) {
    super(
      {
        E_LEGACY_COMPOSE_BINDING_INPUT:
          "Legacy Compose binding inputs are invalid, unsafe or changed; values omitted.",
        E_LEGACY_COMPOSE_BINDING_UNSUPPORTED:
          "Legacy Compose binding mapping is unsupported; values omitted.",
        E_LEGACY_COMPOSE_BINDING_IDENTITY:
          "Existing legacy Compose resource identities could not be verified; values omitted.",
        E_LEGACY_COMPOSE_BINDING_CHANGED:
          "Legacy Compose binding changed after acquisition; values omitted.",
        E_LEGACY_COMPOSE_BINDING_PROBE:
          "Legacy Compose binding inspection failed or exceeded its time or I/O budget; values omitted.",
        E_LEGACY_COMPOSE_BINDING_CANCELLED:
          "Legacy Compose binding inspection was cancelled; values omitted.",
      }[code]
    );
    this.name = "LegacyComposeAdoptionBindingError";
    this.code = code;
  }
}
function refuse(code: Code = "E_LEGACY_COMPOSE_BINDING_IDENTITY"): never {
  throw new LegacyComposeAdoptionBindingError(code);
}
function requireValue(value: unknown): asserts value {
  if (!value) {
    refuse();
  }
}
function cancelled(signal?: AbortSignal) {
  if (signal?.aborted) {
    refuse("E_LEGACY_COMPOSE_BINDING_CANCELLED");
  }
}
function keys(row: Record<string, unknown>, expected: readonly string[]) {
  requireValue(Object.keys(row).sort().join() === [...expected].sort().join());
}
function lines(text: string): Record<string, unknown>[] {
  if (!text.trim()) {
    return [];
  }
  return text
    .trim()
    .split("\n")
    .map((line) => {
      const value: unknown = JSON.parse(line);
      requireValue(isRecord(value));
      return value;
    });
}
function emptyNative(value: unknown) {
  return value === "" || value === null;
}
function timestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    TIME.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}
function absolute(value: unknown): value is string {
  return (
    typeof value === "string" && value.startsWith("/") && !value.includes("\0")
  );
}
function routing() {
  return ROUTING.map((key) => process.env[key]);
}
function selection(value: unknown) {
  if (!isRecord(value)) {
    refuse("E_LEGACY_COMPOSE_BINDING_INPUT");
  }
  const projectRoot = value.projectRoot;
  const signal = value.signal;
  if (
    typeof projectRoot !== "string" ||
    !projectRoot.length ||
    projectRoot.includes("\0") ||
    (signal !== undefined && !(signal instanceof AbortSignal))
  ) {
    refuse("E_LEGACY_COMPOSE_BINDING_INPUT");
  }
  return { root: resolve(projectRoot), signal };
}

async function inventory(opts: {
  readonly kind: Kind;
  readonly probe: Probe;
  readonly intent: LegacyComposeStorageIntent;
}): Promise<Inventory[]> {
  const { kind, probe, intent } = opts;
  const output = await probe([
    kind,
    "ls",
    ...(kind === "container" ? ["--all"] : []),
    ...(kind === "volume" ? [] : ["--no-trunc"]),
    "--format",
    formats[kind].list,
  ]);
  const expected = {
    volume: intent.volumes.map((volume) => volume.name),
    network: intent.ownedNetworks
      ? intent.ownedNetworks.networks.map((network) => network.name)
      : [intent.ownedNetwork?.name ?? `${intent.composeProject}_default`],
    container: intent.services.map(
      (service) => `${intent.composeProject}-${service}-1`
    ),
  }[kind];
  const ids = new Set<string>();
  const selected: Inventory[] = [];
  for (const row of lines(output)) {
    keys(row, ["id", "name", "project"]);
    requireValue(
      typeof row.id === "string" &&
        typeof row.name === "string" &&
        typeof row.project === "string"
    );
    requireValue(kind === "volume" ? row.id === row.name : ID.test(row.id));
    requireValue(!ids.has(row.id));
    ids.add(row.id);
    if (row.project === intent.composeProject || expected.includes(row.name)) {
      requireValue(
        NAME.test(row.name) && row.project === intent.composeProject
      );
      selected.push({ id: row.id, name: row.name, project: row.project });
    }
  }
  return selected.sort((a, b) => a.id.localeCompare(b.id));
}

async function inspect(opts: {
  readonly kind: Kind;
  readonly probe: Probe;
  readonly resources: readonly Inventory[];
  readonly project: string;
  readonly ownedNetwork?: boolean;
  readonly sourceBinds?: boolean;
}) {
  const rows: Record<string, unknown>[] = [];
  let format: string = formats[opts.kind].inspect;
  if (opts.kind === "container" && opts.sourceBinds) {
    format = SOURCE_BIND_CONTAINER_FORMAT;
  } else if (opts.kind === "container" && opts.ownedNetwork) {
    format = CUSTOM_CONTAINER_NETWORK_FORMAT;
  }
  // One name/ID per request gives a fixed argv bound; cumulative I/O/time is shared.
  for (const resource of opts.resources) {
    const output = lines(
      await opts.probe([opts.kind, "inspect", "--format", format, resource.id])
    );
    requireValue(output.length === 1);
    const row = output[0];
    requireValue(
      row &&
        row.id === resource.id &&
        row.name ===
          (opts.kind === "container" ? `/${resource.name}` : resource.name) &&
        row.project === opts.project &&
        emptyNative(row.native)
    );
    rows.push(row);
  }
  return rows;
}
export type LegacyComposeVerifiedVolume = {
  readonly storage: string;
  readonly name: string;
  readonly createdAt: string;
  readonly mountpoint: string;
};
export type LegacyComposeVerifiedContainer = {
  readonly id: string;
  readonly name: string;
  readonly service: string;
};
type LegacyComposeVerifiedBindingBase = {
  readonly projectRoot: string;
  readonly composeFile: string;
  readonly composeProject: string;
  readonly engineId: string;
  readonly containers: readonly LegacyComposeVerifiedContainer[];
  readonly volumes: readonly LegacyComposeVerifiedVolume[];
  readonly mounts: LegacyComposeStorageIntent["mounts"];
};
type LegacyComposeVerifiedNetwork = {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly logical: string;
  readonly internal: boolean;
};
type LegacyComposeOriginalNetwork = {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly logical?: string;
  readonly internal?: boolean;
};
export type LegacyComposeVerifiedBinding = LegacyComposeVerifiedBindingBase &
  (
    | {
        readonly binding_version: 12;
        readonly sourceBinds: LegacyComposeSourceBindIntent["sourceBinds"];
        readonly network: LegacyComposeOriginalNetwork;
      }
    | {
        readonly binding_version: 1 | 3;
        readonly network: LegacyComposeOriginalNetwork;
      }
    | {
        readonly binding_version: 2 | 4;
        readonly composeFiles: readonly string[];
        readonly network: LegacyComposeOriginalNetwork;
      }
    | {
        readonly binding_version: 5;
        readonly networks: readonly LegacyComposeVerifiedNetwork[];
      }
    | {
        readonly binding_version: 6;
        readonly composeFiles: readonly string[];
        readonly networks: readonly LegacyComposeVerifiedNetwork[];
      }
  );

type ProjectedPreparation = Pick<
  Awaited<ReturnType<LegacyComposeAdoptionProjection["resolve"]>>,
  "candidate" | "composeFiles" | "metadata" | "projectionProof" | "localFields"
>;

/** Canonical ordered owner paths only; observations cannot introduce caller-selected override authority. */
function canonicalComposeFiles(
  root: string,
  files?: readonly string[]
): readonly string[] {
  const base = resolve(root, ".hack/docker-compose.yml");
  if (files === undefined) {
    return [base];
  }
  const allowed = [
    base,
    resolve(root, ".hack/.internal/compose.runtime.override.yml"),
    resolve(root, ".hack/.internal/compose.env.override.yml"),
  ];
  requireValue(
    Array.isArray(files) &&
      files.length > 0 &&
      files.length <= 3 &&
      files[0] === base
  );
  requireValue(
    JSON.stringify(files) ===
      JSON.stringify(allowed.filter((file) => files.includes(file)))
  );
  return [...files];
}
function volumeRows(
  rows: readonly Record<string, unknown>[],
  intent: LegacyComposeStorageIntent
): LegacyComposeVerifiedVolume[] {
  requireValue(rows.length === intent.volumes.length);
  return rows
    .map((row) => {
      keys(row, [
        "id",
        "name",
        "project",
        "native",
        "storage",
        "createdAt",
        "driver",
        "scope",
        "mountpoint",
        "options",
      ]);
      const expected = intent.volumes.find(
        (volume) => volume.name === row.name
      );
      requireValue(
        expected &&
          row.storage === expected.storage &&
          row.driver === "local" &&
          row.scope === "local" &&
          (row.options === null ||
            (isRecord(row.options) && Object.keys(row.options).length === 0)) &&
          timestamp(row.createdAt) &&
          absolute(row.mountpoint)
      );
      return {
        storage: expected.storage,
        name: expected.name,
        createdAt: row.createdAt,
        mountpoint: row.mountpoint,
      };
    })
    .sort((a, b) => a.storage.localeCompare(b.storage));
}
function containerMounts(
  row: Record<string, unknown>,
  opts: {
    readonly service: string;
    readonly intent: LegacyComposeStorageIntent;
    readonly volumes: readonly LegacyComposeVerifiedVolume[];
    readonly root?: string;
    readonly sourceBinds?: LegacyComposeSourceBindIntent["sourceBinds"];
  }
) {
  requireValue(Array.isArray(row.mounts));
  const expected = opts.intent.mounts.filter(
    (mount) => mount.service === opts.service
  );
  const sources =
    opts.sourceBinds?.filter((mount) => mount.service === opts.service) ?? [];
  requireValue(row.mounts.length === expected.length + sources.length);
  const targets = new Set<string>();
  for (const item of row.mounts) {
    requireValue(isRecord(item));
    keys(item, ["type", "name", "source", "target", "rw"]);
    const source = sources.find((entry) => entry.target === item.target);
    if (source) {
      requireValue(
        opts.root &&
          item.type === "bind" &&
          emptyNative(item.name) &&
          item.source === resolve(opts.root, source.source) &&
          item.rw === !source.readOnly &&
          typeof item.target === "string" &&
          !targets.has(item.target)
      );
      targets.add(item.target);
      continue;
    }
    const mount = expected.find((entry) => entry.target === item.target);
    const volume = opts.volumes.find(
      (entry) => entry.storage === mount?.storage
    );
    requireValue(
      mount &&
        volume &&
        item.type === "volume" &&
        item.name === volume.name &&
        item.source === volume.mountpoint &&
        item.rw === !mount.readOnly &&
        typeof item.target === "string" &&
        !targets.has(item.target)
    );
    targets.add(item.target);
  }
}
function containerRows(
  rows: readonly Record<string, unknown>[],
  opts: {
    readonly root: string;
    readonly intent: LegacyComposeStorageIntent;
    readonly volumes: readonly LegacyComposeVerifiedVolume[];
    readonly network?: { readonly name: string; readonly id: string };
    readonly networks?: readonly LegacyComposeVerifiedNetwork[];
    readonly composeFiles: readonly string[];
    readonly sourceBinds?: LegacyComposeSourceBindIntent["sourceBinds"];
  }
): LegacyComposeVerifiedContainer[] {
  requireValue(rows.length === opts.intent.services.length);
  const services = new Set<string>();
  return rows
    .map((row) => {
      keys(row, [
        "id",
        "name",
        "project",
        "native",
        "service",
        "number",
        "oneoff",
        "running",
        "workingDir",
        "configFiles",
        "mounts",
        "networks",
      ]);
      requireValue(
        typeof row.service === "string" &&
          opts.intent.services.includes(row.service) &&
          !services.has(row.service) &&
          row.number === "1" &&
          (row.oneoff === "False" || row.oneoff === "false") &&
          typeof row.running === "boolean" &&
          row.workingDir === resolve(opts.root, ".hack") &&
          row.configFiles === opts.composeFiles.join(",") &&
          typeof row.id === "string" &&
          ID.test(row.id) &&
          typeof row.name === "string"
      );
      if (opts.intent.ownedNetwork || opts.intent.ownedNetworks) {
        requireValue(
          row.name === `/${opts.intent.composeProject}-${row.service}-1`
        );
      }
      services.add(row.service);
      containerMounts(row, {
        root: opts.root,
        sourceBinds: opts.sourceBinds,
        service: row.service,
        intent: opts.intent,
        volumes: opts.volumes,
      });
      if (opts.intent.ownedNetworks) {
        const verifiedNetworks = opts.networks;
        const configured = opts.intent.ownedNetworks.attachments.find(
          (entry) => entry.service === row.service
        );
        requireValue(
          configured &&
            Array.isArray(row.networks) &&
            row.networks.length === configured.networks.length &&
            verifiedNetworks?.length === 2
        );
        const observedNames = new Set<string>();
        for (const item of row.networks) {
          requireValue(isRecord(item));
          keys(item, ["name", "id", "aliases"]);
          requireValue(
            typeof item.name === "string" && !observedNames.has(item.name)
          );
          observedNames.add(item.name);
          const verified = verifiedNetworks.find(
            (entry) => entry.name === item.name
          );
          const declared = configured.networks.find(
            (entry) => entry.logical === verified?.logical
          );
          requireValue(verified && declared && item.id === verified.id);
          const expected = [
            `${opts.intent.composeProject}-${row.service}-1`,
            row.service,
            ...declared.aliases,
          ].sort();
          const actual = item.aliases;
          requireValue(
            (Array.isArray(actual) &&
              actual.every(
                (alias) => typeof alias === "string" && NAME.test(alias)
              ) &&
              new Set(actual).size === actual.length &&
              JSON.stringify([...actual].sort()) ===
                JSON.stringify(expected)) ||
              (!row.running &&
                (actual === null ||
                  (Array.isArray(actual) && actual.length === 0)))
          );
        }
        return { id: row.id, name: row.name.slice(1), service: row.service };
      }
      requireValue(Array.isArray(row.networks) && row.networks.length === 1);
      const network = row.networks[0];
      requireValue(isRecord(network));
      keys(
        network,
        opts.intent.ownedNetwork ? ["name", "id", "aliases"] : ["name", "id"]
      );
      requireValue(
        opts.network &&
          network.name === opts.network.name &&
          network.id === opts.network.id
      );
      if (opts.intent.ownedNetwork) {
        const configured = opts.intent.ownedNetwork.attachments.find(
          (entry) => entry.service === row.service
        );
        requireValue(configured);
        const expected = [
          `${opts.intent.composeProject}-${row.service}-1`,
          row.service,
          ...configured.aliases,
        ].sort();
        const actual = network.aliases;
        requireValue(
          (Array.isArray(actual) &&
            actual.every(
              (alias) => typeof alias === "string" && NAME.test(alias)
            ) &&
            new Set(actual).size === actual.length &&
            JSON.stringify([...actual].sort()) === JSON.stringify(expected)) ||
            (!row.running &&
              (actual === null ||
                (Array.isArray(actual) && actual.length === 0)))
        );
      }
      return { id: row.id, name: row.name.slice(1), service: row.service };
    })
    .sort((a, b) => a.service.localeCompare(b.service));
}
function networkRow(
  rows: readonly Record<string, unknown>[],
  intent: LegacyComposeStorageIntent
) {
  requireValue(rows.length === 1);
  const row = rows[0];
  requireValue(row);
  keys(row, [
    "id",
    "name",
    "project",
    "native",
    "logical",
    "createdAt",
    "driver",
    "scope",
    "internal",
    "containers",
  ]);
  requireValue(
    typeof row.id === "string" &&
      ID.test(row.id) &&
      row.name ===
        (intent.ownedNetwork?.name ?? `${intent.composeProject}_default`) &&
      row.logical === (intent.ownedNetwork?.logical ?? "default") &&
      timestamp(row.createdAt) &&
      row.driver === "bridge" &&
      row.scope === "local" &&
      row.internal === (intent.ownedNetwork?.internal ?? false) &&
      Array.isArray(row.containers) &&
      row.containers.every((id) => typeof id === "string" && ID.test(id)) &&
      new Set(row.containers).size === row.containers.length
  );
  return {
    network: {
      id: row.id,
      name: row.name,
      createdAt: row.createdAt,
      ...(intent.ownedNetwork
        ? {
            logical: intent.ownedNetwork.logical,
            internal: intent.ownedNetwork.internal,
          }
        : {}),
    },
    containerIds: row.containers,
  };
}
function pluralNetworkRows(
  rows: readonly Record<string, unknown>[],
  intent: LegacyComposeStorageIntent
): {
  readonly networks: readonly LegacyComposeVerifiedNetwork[];
  readonly members: ReadonlyMap<string, readonly string[]>;
} {
  const declared = intent.ownedNetworks?.networks;
  requireValue(declared && declared.length === 2 && rows.length === 2);
  requireValue(
    new Set(declared.map((network) => network.logical)).size === 2 &&
      new Set(declared.map((network) => network.name)).size === 2 &&
      declared.every(
        (network) =>
          typeof network.logical === "string" &&
          typeof network.name === "string" &&
          typeof network.internal === "boolean"
      )
  );
  const ids = new Set<string>();
  const names = new Set<string>();
  const members = new Map<string, readonly string[]>();
  const networks = rows
    .map((row) => {
      keys(row, [
        "id",
        "name",
        "project",
        "native",
        "logical",
        "createdAt",
        "driver",
        "scope",
        "internal",
        "containers",
      ]);
      const expected = declared.find((network) => network.name === row.name);
      const id = row.id;
      const rowMembers = row.containers;
      requireValue(
        expected &&
          typeof id === "string" &&
          ID.test(id) &&
          !ids.has(id) &&
          !names.has(expected.name) &&
          row.logical === expected.logical &&
          row.internal === expected.internal &&
          row.driver === "bridge" &&
          row.scope === "local" &&
          timestamp(row.createdAt) &&
          Array.isArray(rowMembers) &&
          rowMembers.every(
            (member) => typeof member === "string" && ID.test(member)
          ) &&
          new Set(rowMembers).size === rowMembers.length
      );
      ids.add(id);
      names.add(expected.name);
      members.set(expected.logical, [...rowMembers].sort());
      return {
        id,
        name: expected.name,
        createdAt: row.createdAt,
        logical: expected.logical,
        internal: expected.internal,
      };
    })
    .sort((a, b) => a.logical.localeCompare(b.logical));
  return { networks, members };
}
async function engine(probe: Probe) {
  const rows = lines(
    await probe([
      "info",
      "--format",
      '{"id":{{json .ID}},"os":{{json .OSType}}}',
    ])
  );
  requireValue(rows.length === 1);
  const row = rows[0];
  requireValue(row);
  keys(row, ["id", "os"]);
  requireValue(
    typeof row.id === "string" && ENGINE_ID.test(row.id) && row.os === "linux"
  );
  return row.id;
}
/**
 * Private read-only observation reused by the durable adoption owner. It grants
 * no mutation authority: that owner must first validate its saved source/binding
 * anchors and compare every returned fact to the original verified acquisition.
 */
export async function inspectLegacyComposeAdoptionResources(opts: {
  readonly root: string;
  readonly intent: LegacyComposeStorageIntent;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly composeFiles?: readonly string[];
}): Promise<LegacyComposeVerifiedBinding> {
  return await inspectResources(opts);
}

/** Separate read-only directory family; no caller-selected source can grant a mutation capability. */
export async function inspectLegacyComposeSourceBindResources(opts: {
  readonly root: string;
  readonly intent: LegacyComposeSourceBindIntent;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}): Promise<LegacyComposeVerifiedBinding> {
  requireValue(
    opts.intent.sourceBinds.length > 0 &&
      !(opts.intent.ownedNetwork || opts.intent.ownedNetworks)
  );
  return await inspectResources(opts, opts.intent.sourceBinds);
}

async function inspectResources(
  opts: {
    readonly root: string;
    readonly intent: LegacyComposeStorageIntent;
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
    readonly composeFiles?: readonly string[];
  },
  sourceBinds?: LegacyComposeSourceBindIntent["sourceBinds"]
): Promise<LegacyComposeVerifiedBinding> {
  const composeFiles = canonicalComposeFiles(opts.root, opts.composeFiles);
  requireValue(!(opts.intent.ownedNetwork && opts.intent.ownedNetworks));
  const probe = createNativeComposeProbe(opts);
  const engineId = await engine(probe);
  const selected = {
    container: await inventory({
      kind: "container",
      probe,
      intent: opts.intent,
    }),
    volume: await inventory({ kind: "volume", probe, intent: opts.intent }),
    network: await inventory({ kind: "network", probe, intent: opts.intent }),
  };
  const volumes = volumeRows(
    await inspect({
      kind: "volume",
      probe,
      resources: selected.volume,
      project: opts.intent.composeProject,
    }),
    opts.intent
  );
  const networkFacts = await inspect({
    kind: "network",
    probe,
    resources: selected.network,
    project: opts.intent.composeProject,
  });
  const plural = opts.intent.ownedNetworks
    ? pluralNetworkRows(networkFacts, opts.intent)
    : undefined;
  const single = plural ? undefined : networkRow(networkFacts, opts.intent);
  const containerFacts = await inspect({
    kind: "container",
    probe,
    resources: selected.container,
    project: opts.intent.composeProject,
    ownedNetwork:
      opts.intent.ownedNetwork !== undefined ||
      opts.intent.ownedNetworks !== undefined,
    sourceBinds: sourceBinds !== undefined,
  });
  const containers = containerRows(containerFacts, {
    ...opts,
    composeFiles,
    volumes,
    network: single?.network,
    networks: plural?.networks,
    sourceBinds,
  });
  // Docker drops stopped endpoints from network inspection. Each original must
  // still configure every declared NetworkID; live members are exact per bridge.
  if (plural) {
    for (const network of plural.networks) {
      const members = plural.members.get(network.logical);
      requireValue(members);
      const expected = containerFacts
        .filter(
          (container) =>
            container.running &&
            opts.intent.ownedNetworks?.attachments.some(
              (entry) =>
                entry.service === container.service &&
                entry.networks.some(
                  (attached) => attached.logical === network.logical
                )
            )
        )
        .map((container) => container.id)
        .sort();
      requireValue(JSON.stringify(members) === JSON.stringify(expected));
    }
  } else {
    requireValue(single);
    requireValue(
      JSON.stringify([...single.containerIds].sort()) ===
        JSON.stringify(
          containerFacts
            .filter((container) => container.running)
            .map((container) => container.id)
            .sort()
        )
    );
  }
  for (const kind of ["container", "volume", "network"] as const) {
    requireValue(
      JSON.stringify(await inventory({ kind, probe, intent: opts.intent })) ===
        JSON.stringify(selected[kind])
    );
  }
  requireValue((await engine(probe)) === engineId);
  const common = {
    projectRoot: opts.root,
    composeFile: resolve(opts.root, ".hack/docker-compose.yml"),
    composeProject: opts.intent.composeProject,
    engineId,
    containers,
    volumes,
    mounts: opts.intent.mounts,
  };
  if (plural) {
    return opts.composeFiles
      ? {
          ...common,
          binding_version: 6 as const,
          composeFiles: Object.freeze(composeFiles),
          networks: plural.networks,
        }
      : {
          ...common,
          binding_version: 5 as const,
          networks: plural.networks,
        };
  }
  requireValue(single);
  if (sourceBinds) {
    requireValue(
      !(
        opts.composeFiles ||
        opts.intent.ownedNetwork ||
        opts.intent.ownedNetworks
      )
    );
    return {
      ...common,
      binding_version: 12,
      sourceBinds,
      network: single.network,
    };
  }
  return {
    ...(opts.composeFiles
      ? {
          binding_version: opts.intent.ownedNetwork
            ? (4 as const)
            : (2 as const),
          composeFiles: Object.freeze(composeFiles),
        }
      : {
          binding_version: opts.intent.ownedNetwork
            ? (3 as const)
            : (1 as const),
        }),
    ...common,
    network: single.network,
  };
}
export type LegacyComposeAdoptionBinding = {
  readonly report: {
    readonly binding_version: LegacyComposeVerifiedBinding["binding_version"];
    readonly status: "verified";
    readonly adoption: "not_performed";
    readonly containers: number;
    readonly volumes: number;
  };
  readonly assertFresh: (opts: {
    readonly projectRoot: string;
    readonly signal?: AbortSignal;
  }) => Promise<void>;
  /** Private identity facts for a future explicit generation transition. Never report/log. */
  readonly resolveBinding: (opts: {
    readonly projectRoot: string;
    readonly signal?: AbortSignal;
  }) => Promise<LegacyComposeVerifiedBinding>;
  /** Same bounded raw-source acquisition and binding, exclusively for private durable preparation. */
  readonly resolvePreparationInputs: (opts: {
    readonly projectRoot: string;
    readonly signal?: AbortSignal;
  }) => Promise<{
    readonly configText: string;
    readonly composeText: string;
    readonly binding: LegacyComposeVerifiedBinding;
    readonly sourceFiles: {
      readonly config: NativeConfigImportSourceIdentity;
      readonly compose: NativeConfigImportSourceIdentity;
    };
    readonly projection?: Readonly<ProjectedPreparation>;
    readonly sourceBindProof?: LegacyComposeSourceBindProof;
    readonly build?: {
      readonly source: LegacyComposeBuildSourceProof;
      readonly images: readonly LegacyComposeRetainedBuildImage[];
    };
  }>;
};
function translate(error: unknown, signal?: AbortSignal): never {
  retainLegacyAdoptionLocalRefusal(error);
  cancelled(signal);
  if (error instanceof LegacyComposeAdoptionBindingError) {
    throw error;
  }
  if (error instanceof NativeComposeOwnershipError) {
    refuse(
      error.code === "E_NATIVE_COMPOSE_PROBE_CANCELLED"
        ? "E_LEGACY_COMPOSE_BINDING_CANCELLED"
        : "E_LEGACY_COMPOSE_BINDING_PROBE"
    );
  }
  refuse("E_LEGACY_COMPOSE_BINDING_INPUT");
}

/**
 * Read-only existing-instance prerequisite. Every declared local named volume
 * must already exist and be mounted by the exact selected Compose checkout.
 * Captures source bytes, engine ID, immutable container/network IDs and volume
 * creation identity; all private facts and callbacks are non-enumerable.
 * This does not publish a candidate, relabel resources, change an engine, open
 * the native generation store or authorize execution. A future transaction must
 * consume this binding explicitly and recheck it on the same engine under its
 * lease. Repeated checks cannot atomically freeze Docker or external editors.
 */
type BindingSelection = {
  readonly projectRoot: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly binary?: string;
};
export async function acquireLegacyComposeAdoptionBinding(
  input: BindingSelection
): Promise<LegacyComposeAdoptionBinding> {
  return await acquireBinding(input, "image-only");
}

/** Distinct current-source/image proof; ordinary image-only admission is unchanged. */
export async function acquireLegacyComposeRetainedBasicBuildBinding(
  input: BindingSelection
): Promise<LegacyComposeAdoptionBinding> {
  return await acquireBinding(input, "basic-build");
}

/** Preparation self-selects a qualified owner; no caller-provided binding or bypass is accepted. */
export async function acquireLegacyComposeAdoptionPreparationBinding(
  input: BindingSelection
): Promise<LegacyComposeAdoptionBinding> {
  return await acquireBinding(input, "preparation");
}

export async function acquireLegacyComposeSourceBindBinding(
  input: BindingSelection
): Promise<LegacyComposeAdoptionBinding> {
  return await acquireBinding(input, "source-bind");
}

async function acquireBinding(
  input: BindingSelection,
  purpose: "image-only" | "basic-build" | "source-bind" | "preparation"
): Promise<LegacyComposeAdoptionBinding> {
  let signal: AbortSignal | undefined;
  try {
    const selected = selection(input);
    const root = selected.root;
    signal = selected.signal;
    const timeoutMs = input.timeoutMs;
    const binary = input.binary;
    const route = JSON.stringify(routing());
    cancelled(signal);
    const source = await acquireLegacyAdoptionSourceInputs({
      projectRoot: root,
      signal,
      allowLinkedWorktree: true,
    });
    if (!source.ok) {
      refuse("E_LEGACY_COMPOSE_BINDING_UNSUPPORTED");
    }
    const ordinary = planLegacyComposeAdoption({
      configText: source.configText,
      composeText: source.composeText,
    });
    const basicPlan =
      purpose === "basic-build" ||
      (purpose === "preparation" && !ordinary.intent)
        ? planLegacyComposeRetainedBasicBuildAdoption(source)
        : undefined;
    const basic =
      purpose === "basic-build" ||
      (purpose === "preparation" &&
        !ordinary.intent &&
        Boolean(basicPlan?.intent));
    const sources =
      purpose === "source-bind" ||
      (purpose === "preparation" && !ordinary.intent && !basic);
    let planned = ordinary;
    if (sources) {
      planned = planLegacyComposeSourceBindAdoption(source);
    } else if (basic && basicPlan) {
      planned = basicPlan;
    }
    const intent = planned.intent;
    if (!intent) {
      refuse("E_LEGACY_COMPOSE_BINDING_UNSUPPORTED");
    }
    const buildSource = basic
      ? await acquireLegacyComposeBuildSource({ source, signal })
      : undefined;
    const sourceBind = sources
      ? await acquireLegacyComposeSourceBind({ source, signal })
      : undefined;
    const mapped = mapLegacyNativeStorageAdoption({
      configText: source.configText,
      composeText: source.composeText,
    });
    const candidate =
      sourceBind?.candidate ?? buildSource?.candidate ?? mapped.candidate;
    const jobFamily =
      candidate && legacyComposeRetainedPlan(candidate).requiresV7 === true;
    if (
      jobFamily &&
      (buildSource || !legacyComposeAdoptionCandidateSupported(candidate))
    ) {
      refuse("E_LEGACY_COMPOSE_BINDING_UNSUPPORTED");
    }
    let projection: LegacyComposeAdoptionProjection | undefined;
    let projected: Readonly<ProjectedPreparation> | undefined;
    const generatedPresent = await hasLegacyComposeGeneratedSources(
      root,
      signal
    );
    if (
      candidate &&
      (generatedPresent ||
        !(await legacyComposeAdoptionLayoutSupported({
          projectRoot: root,
          candidate,
          signal,
        })))
    ) {
      if (sourceBind || buildSource || jobFamily) {
        refuse("E_LEGACY_COMPOSE_BINDING_UNSUPPORTED");
      }
      projection = await LegacyComposeAdoptionProjection.acquire({
        source,
        signal,
        binary,
      });
      const resolved = await projection.resolve({ signal });
      projected = Object.freeze({
        candidate: resolved.candidate,
        composeFiles: resolved.composeFiles,
        metadata: resolved.metadata,
        projectionProof: resolved.projectionProof,
        localFields: resolved.localFields,
      });
    }
    const layoutSupported = async (selectedSignal?: AbortSignal) => {
      if (projection) {
        await projection.assertFresh({ signal: selectedSignal });
        return;
      }
      if (buildSource) {
        await buildSource.assertFresh({ signal: selectedSignal });
      }
      if (await hasLegacyComposeGeneratedSources(root, selectedSignal)) {
        refuse("E_LEGACY_COMPOSE_BINDING_CHANGED");
      }
      if (
        !(
          candidate &&
          (await legacyComposeAdoptionLayoutSupported({
            projectRoot: root,
            candidate,
            signal: selectedSignal,
          }))
        )
      ) {
        refuse("E_LEGACY_COMPOSE_BINDING_UNSUPPORTED");
      }
    };
    await layoutSupported(signal);
    const inspectBinding = () =>
      sources && "sourceBinds" in intent
        ? inspectLegacyComposeSourceBindResources({
            root,
            intent,
            signal,
            timeoutMs,
          })
        : inspectLegacyComposeAdoptionResources({
            root,
            intent,
            signal,
            timeoutMs,
            composeFiles: projected?.composeFiles,
          });
    const baseline = sourceBind
      ? await sourceBind.withFresh({ signal }, inspectBinding)
      : await inspectBinding();
    const buildImages = buildSource
      ? await inspectLegacyComposeRetainedBuildImages({
          binding: baseline,
          composeFile: baseline.composeFile,
          signal,
          timeoutMs,
        })
      : undefined;
    freezeImportValue(baseline);
    const assertFresh = async (current: {
      readonly projectRoot: string;
      readonly signal?: AbortSignal;
    }) => {
      let currentSignal = signal;
      try {
        const selectedCurrent = selection(current);
        const currentRoot = selectedCurrent.root;
        const suppliedSignal = selectedCurrent.signal;
        currentSignal =
          signal && suppliedSignal
            ? AbortSignal.any([signal, suppliedSignal])
            : (suppliedSignal ?? signal);
        cancelled(signal);
        cancelled(currentSignal);
        if (currentRoot !== root || JSON.stringify(routing()) !== route) {
          refuse("E_LEGACY_COMPOSE_BINDING_CHANGED");
        }
        await source.assertFresh({ signal: currentSignal });
        await layoutSupported(currentSignal);
        const inspectCurrent = () =>
          sources && "sourceBinds" in intent
            ? inspectLegacyComposeSourceBindResources({
                root,
                intent,
                signal: currentSignal,
                timeoutMs,
              })
            : inspectLegacyComposeAdoptionResources({
                root,
                intent,
                signal: currentSignal,
                timeoutMs,
                composeFiles: projected?.composeFiles,
              });
        const observed = sourceBind
          ? await sourceBind.withFresh(
              { signal: currentSignal },
              inspectCurrent
            )
          : await inspectCurrent();
        if (JSON.stringify(observed) !== JSON.stringify(baseline)) {
          refuse("E_LEGACY_COMPOSE_BINDING_CHANGED");
        }
        if (
          buildImages &&
          JSON.stringify(
            await inspectLegacyComposeRetainedBuildImages({
              binding: observed,
              composeFile: observed.composeFile,
              signal: currentSignal,
              timeoutMs,
            })
          ) !== JSON.stringify(buildImages)
        ) {
          refuse("E_LEGACY_COMPOSE_BINDING_CHANGED");
        }
        await source.assertFresh({ signal: currentSignal });
        await layoutSupported(currentSignal);
        cancelled(signal);
        if (JSON.stringify(routing()) !== route) {
          refuse("E_LEGACY_COMPOSE_BINDING_CHANGED");
        }
      } catch (error: unknown) {
        translate(error, currentSignal);
      }
    };
    const result: LegacyComposeAdoptionBinding = {
      report: {
        binding_version: baseline.binding_version,
        status: "verified",
        adoption: "not_performed",
        containers: baseline.containers.length,
        volumes: baseline.volumes.length,
      },
      assertFresh,
      resolveBinding: async (current) => {
        await assertFresh(current);
        return baseline;
      },
      resolvePreparationInputs: async (current) => {
        await assertFresh(current);
        const result = {
          configText: source.configText,
          composeText: source.composeText,
          binding: baseline,
          sourceFiles: source.sourceFiles,
          ...(projected ? { projection: projected } : {}),
          ...(sourceBind ? { sourceBindProof: sourceBind.proof } : {}),
          ...(buildSource && buildImages
            ? {
                build: Object.freeze({
                  source: buildSource.proof,
                  images: buildImages,
                }),
              }
            : {}),
        };
        for (const key of [
          "configText",
          "composeText",
          "binding",
          "sourceFiles",
          "projection",
          "sourceBindProof",
          "build",
        ]) {
          Object.defineProperty(result, key, { enumerable: false });
        }
        return Object.freeze(result);
      },
    };
    freezeImportValue(result.report);
    for (const key of [
      "assertFresh",
      "resolveBinding",
      "resolvePreparationInputs",
    ]) {
      Object.defineProperty(result, key, { enumerable: false });
    }
    await assertFresh({ projectRoot: root, signal });
    return Object.freeze(result);
  } catch (error: unknown) {
    translate(error, signal);
  }
}
