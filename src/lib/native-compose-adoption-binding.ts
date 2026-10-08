import { resolve } from "node:path";
import { isRecord } from "./guards.ts";
import {
  type LegacyComposeStorageIntent,
  planLegacyComposeAdoption,
} from "./native-compose-adoption-plan.ts";
import {
  createNativeComposeProbe,
  NativeComposeOwnershipError,
} from "./native-compose-ownership.ts";
import { acquireNativeConfigImportInputs } from "./native-config-import-inputs.ts";
import { freezeImportValue } from "./native-config-import-plan.ts";

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
] as const;
const formats = {
  container: {
    list: `{"id":{{json .ID}},"name":{{json .Names}},"project":{{json (.Label "${PROJECT}")}}}`,
    inspect: `{"id":{{json .Id}},"name":{{json .Name}},"project":{{json (index .Config.Labels "${PROJECT}")}},"native":{{json (index .Config.Labels "${VERSION}")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"number":{{json (index .Config.Labels "com.docker.compose.container-number")}},"oneoff":{{json (index .Config.Labels "com.docker.compose.oneoff")}},"workingDir":{{json (index .Config.Labels "com.docker.compose.project.working_dir")}},"configFiles":{{json (index .Config.Labels "com.docker.compose.project.config_files")}},"mounts":[{{range $i, $m := .Mounts}}{{if $i}},{{end}}{"type":{{json $m.Type}},"name":{{json $m.Name}},"source":{{json $m.Source}},"target":{{json $m.Destination}},"rw":{{json $m.RW}}}{{end}}],"networks":[{{$first := true}}{{range $name, $n := .NetworkSettings.Networks}}{{if not $first}},{{end}}{{$first = false}}{"name":{{json $name}},"id":{{json $n.NetworkID}}}{{end}}]}`,
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
    network: [`${intent.composeProject}_default`],
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
}) {
  const rows: Record<string, unknown>[] = [];
  // One name/ID per request gives a fixed argv bound; cumulative I/O/time is shared.
  for (const resource of opts.resources) {
    const output = lines(
      await opts.probe([
        opts.kind,
        "inspect",
        "--format",
        formats[opts.kind].inspect,
        resource.id,
      ])
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
export type LegacyComposeVerifiedBinding = {
  readonly binding_version: 1;
  readonly projectRoot: string;
  readonly composeFile: string;
  readonly composeProject: string;
  readonly engineId: string;
  readonly containers: readonly LegacyComposeVerifiedContainer[];
  readonly volumes: readonly LegacyComposeVerifiedVolume[];
  readonly mounts: LegacyComposeStorageIntent["mounts"];
  readonly network: {
    readonly id: string;
    readonly name: string;
    readonly createdAt: string;
  };
};
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
  }
) {
  requireValue(Array.isArray(row.mounts));
  const expected = opts.intent.mounts.filter(
    (mount) => mount.service === opts.service
  );
  requireValue(row.mounts.length === expected.length);
  const targets = new Set<string>();
  for (const item of row.mounts) {
    requireValue(isRecord(item));
    keys(item, ["type", "name", "source", "target", "rw"]);
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
    readonly network: { readonly name: string; readonly id: string };
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
          row.workingDir === resolve(opts.root, ".hack") &&
          row.configFiles === resolve(opts.root, ".hack/docker-compose.yml") &&
          typeof row.id === "string" &&
          ID.test(row.id) &&
          typeof row.name === "string"
      );
      services.add(row.service);
      containerMounts(row, {
        service: row.service,
        intent: opts.intent,
        volumes: opts.volumes,
      });
      requireValue(Array.isArray(row.networks) && row.networks.length === 1);
      const network = row.networks[0];
      requireValue(isRecord(network));
      keys(network, ["name", "id"]);
      requireValue(
        network.name === opts.network.name && network.id === opts.network.id
      );
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
      row.name === `${intent.composeProject}_default` &&
      row.logical === "default" &&
      timestamp(row.createdAt) &&
      row.driver === "bridge" &&
      row.scope === "local" &&
      row.internal === false &&
      Array.isArray(row.containers) &&
      row.containers.every((id) => typeof id === "string" && ID.test(id)) &&
      new Set(row.containers).size === row.containers.length
  );
  return {
    network: { id: row.id, name: row.name, createdAt: row.createdAt },
    containerIds: row.containers,
  };
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
}): Promise<LegacyComposeVerifiedBinding> {
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
  const { network, containerIds } = networkRow(
    await inspect({
      kind: "network",
      probe,
      resources: selected.network,
      project: opts.intent.composeProject,
    }),
    opts.intent
  );
  const containers = containerRows(
    await inspect({
      kind: "container",
      probe,
      resources: selected.container,
      project: opts.intent.composeProject,
    }),
    { ...opts, volumes, network }
  );
  requireValue(
    JSON.stringify([...containerIds].sort()) ===
      JSON.stringify(containers.map((container) => container.id).sort())
  );
  for (const kind of ["container", "volume", "network"] as const) {
    requireValue(
      JSON.stringify(await inventory({ kind, probe, intent: opts.intent })) ===
        JSON.stringify(selected[kind])
    );
  }
  requireValue((await engine(probe)) === engineId);
  return {
    binding_version: 1,
    projectRoot: opts.root,
    composeFile: resolve(opts.root, ".hack/docker-compose.yml"),
    composeProject: opts.intent.composeProject,
    engineId,
    containers,
    volumes,
    mounts: opts.intent.mounts,
    network,
  };
}
export type LegacyComposeAdoptionBinding = {
  readonly report: {
    readonly binding_version: 1;
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
  }>;
};
function translate(error: unknown, signal?: AbortSignal): never {
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
export async function acquireLegacyComposeAdoptionBinding(input: {
  readonly projectRoot: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}): Promise<LegacyComposeAdoptionBinding> {
  let signal: AbortSignal | undefined;
  try {
    const selected = selection(input);
    const root = selected.root;
    signal = selected.signal;
    const timeoutMs = input.timeoutMs;
    const route = JSON.stringify(routing());
    cancelled(signal);
    const source = await acquireNativeConfigImportInputs({
      projectRoot: root,
      signal,
    });
    if (!source.ok) {
      refuse("E_LEGACY_COMPOSE_BINDING_UNSUPPORTED");
    }
    const planned = planLegacyComposeAdoption({
      configText: source.configText,
      composeText: source.composeText,
    });
    const intent = planned.intent;
    if (!intent) {
      refuse("E_LEGACY_COMPOSE_BINDING_UNSUPPORTED");
    }
    const baseline = await inspectLegacyComposeAdoptionResources({
      root,
      intent,
      signal,
      timeoutMs,
    });
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
        const observed = await inspectLegacyComposeAdoptionResources({
          root,
          intent,
          signal: currentSignal,
          timeoutMs,
        });
        if (JSON.stringify(observed) !== JSON.stringify(baseline)) {
          refuse("E_LEGACY_COMPOSE_BINDING_CHANGED");
        }
        await source.assertFresh({ signal: currentSignal });
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
        binding_version: 1,
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
        };
        for (const key of ["configText", "composeText", "binding"]) {
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
