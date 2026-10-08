import { DEFAULT_INGRESS_NETWORK } from "../constants.ts";
import { isRecord } from "./guards.ts";
import { findExecutableInPath } from "./shell.ts";

const PROJECT = /^[a-z0-9][a-z0-9_-]*$/;
const SERVICE = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const GENERATION = /^[a-f0-9]{32}$/;
const ID = /^[a-f0-9]{64}$/;
const OUTPUT_LIMIT = 8 * 1024 * 1024;
const STDERR_LIMIT = 16 * 1024;
const ARGUMENT_LIMIT = 16 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const PROJECT_LABEL = "com.docker.compose.project";
const PREFIX = "io.hack.native-config";

type Kind = "container" | "volume" | "network";
type Inventory = {
  readonly id: string;
  readonly name: string;
  readonly project: string;
};
const FORMATS = {
  container: {
    list: `{"id":{{json .ID}},"name":{{json .Names}},"project":{{json (.Label "${PROJECT_LABEL}")}}}`,
    inspect: `{"id":{{json .Id}},"name":{{json .Name}},"project":{{json (index .Config.Labels "${PROJECT_LABEL}")}},"version":{{json (index .Config.Labels "${PREFIX}.version")}},"instance":{{json (index .Config.Labels "${PREFIX}.instance")}},"owner":{{json (index .Config.Labels "${PREFIX}.owner")}},"generation":{{json (index .Config.Labels "${PREFIX}.generation")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"oneoff":{{json (index .Config.Labels "com.docker.compose.oneoff")}},"state":{{json .State.Status}},"exitCode":{{json .State.ExitCode}},"health":{{with (index .State "Health")}}{{json .Status}}{{else}}null{{end}},"networks":{{json .NetworkSettings.Networks}}}`,
  },
  volume: {
    // Docker volumes have a name, rather than an immutable engine object ID.
    list: `{"id":{{json .Name}},"name":{{json .Name}},"project":{{json (.Label "${PROJECT_LABEL}")}}}`,
    inspect: `{"id":{{json .Name}},"name":{{json .Name}},"project":{{json (index .Labels "${PROJECT_LABEL}")}},"version":{{json (index .Labels "${PREFIX}.version")}},"instance":{{json (index .Labels "${PREFIX}.instance")}},"owner":{{json (index .Labels "${PREFIX}.owner")}},"storage":{{json (index .Labels "${PREFIX}.storage")}}}`,
  },
  network: {
    list: `{"id":{{json .ID}},"name":{{json .Name}},"project":{{json (.Label "${PROJECT_LABEL}")}}}`,
    inspect: `{"id":{{json .Id}},"name":{{json .Name}},"project":{{json (index .Labels "${PROJECT_LABEL}")}},"version":{{json (index .Labels "${PREFIX}.version")}},"instance":{{json (index .Labels "${PREFIX}.instance")}},"owner":{{json (index .Labels "${PREFIX}.owner")}},"driver":{{json .Driver}},"internal":{{json .Internal}},"containers":{{json .Containers}}}`,
  },
} as const;

export type NativeComposeContainerObservation = {
  readonly id: string;
  /** Verified Docker container name without its inspect-only leading slash. */
  readonly name: string;
  readonly generationId: string;
  readonly service: string;
  readonly state:
    | "created"
    | "restarting"
    | "running"
    | "removing"
    | "paused"
    | "exited"
    | "dead";
  readonly exitCode: number;
  readonly health: "starting" | "healthy" | "unhealthy" | null;
  readonly oneoff: boolean;
};
export type NativeComposeOwnershipObservation = {
  readonly containers: readonly NativeComposeContainerObservation[];
  readonly volumes: readonly {
    readonly name: string;
    readonly storage: string;
  }[];
  readonly networks: readonly { readonly id: string; readonly name: string }[];
};
export type NativeComposeOwnershipOptions = {
  readonly composeProject: string;
  readonly runtimeIdentity: string;
  /** Stable random owner from the verified instance receipt, never authored input. */
  readonly ownerToken: string;
  /** Owner-generated IDs selected from the verified current and pending receipts. */
  readonly generationIds: readonly string[];
  /** Current/pending workload union, including jobs and declared dependencies. */
  readonly expectedServices: readonly string[];
  /** Exact names and logical storage keys from the immutable generated document. */
  readonly expectedVolumes?: readonly {
    readonly name: string;
    readonly storage: string;
  }[];
  /** Pre-topology version-one callers mean the owned outbound default bridge. */
  readonly expectedNetwork?: string;
  readonly expectedNetworks?: readonly NativeComposeNetworkPolicy[];
  readonly expectedWorkloadNetworks?: readonly NativeComposeWorkloadNetworks[];
  /** Only saved down --recover may remove stopped/never-started owned containers with incomplete owned bridge endpoints. */
  readonly recovery?: "down";
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
};

export type NativeComposeNetworkPolicy = {
  readonly name: string;
  readonly driver: "bridge";
  readonly internal: boolean;
};
export type NativeComposeWorkloadNetworks = {
  readonly generationId: string;
  readonly service: string;
  readonly networks: readonly {
    readonly name: string;
    readonly aliases: readonly string[];
    /** Only the separately verified shared ingress is external. */
    readonly externalId?: string;
  }[];
};

function networkPolicies(
  opts: NativeComposeOwnershipOptions
): readonly NativeComposeNetworkPolicy[] {
  return (
    opts.expectedNetworks ??
    (opts.expectedNetwork === undefined
      ? []
      : [{ name: opts.expectedNetwork, driver: "bridge", internal: false }])
  );
}

function workloadNetworks(
  opts: NativeComposeOwnershipOptions
): readonly NativeComposeWorkloadNetworks[] {
  return (
    opts.expectedWorkloadNetworks ??
    opts.generationIds.flatMap((generationId) =>
      opts.expectedServices.map((service) => ({
        generationId,
        service,
        networks:
          opts.expectedNetwork === undefined
            ? []
            : [{ name: opts.expectedNetwork, aliases: [] }],
      }))
    )
  );
}

type FailureCode =
  | "E_NATIVE_COMPOSE_OWNERSHIP"
  | "E_NATIVE_COMPOSE_NETWORK_TRANSITION"
  | "E_NATIVE_COMPOSE_PROBE"
  | "E_NATIVE_COMPOSE_PROBE_TIMEOUT"
  | "E_NATIVE_COMPOSE_PROBE_CANCELLED"
  | "E_NATIVE_COMPOSE_PROBE_BUDGET";
/** Never retain command arguments, raw inspect output, labels, or daemon diagnostics. */
export class NativeComposeOwnershipError extends Error {
  readonly code: FailureCode;
  constructor(code: FailureCode) {
    super(
      {
        E_NATIVE_COMPOSE_OWNERSHIP:
          "Native Compose resource ownership is missing, conflicting or changed; values omitted.",
        E_NATIVE_COMPOSE_NETWORK_TRANSITION:
          "Native Compose network topology changed. Run hack down for this instance before applying the change; values omitted.",
        E_NATIVE_COMPOSE_PROBE:
          "Native Compose ownership could not be inspected; values omitted.",
        E_NATIVE_COMPOSE_PROBE_TIMEOUT:
          "Native Compose ownership inspection timed out; values omitted.",
        E_NATIVE_COMPOSE_PROBE_CANCELLED:
          "Native Compose ownership inspection was cancelled; values omitted.",
        E_NATIVE_COMPOSE_PROBE_BUDGET:
          "Native Compose ownership inspection exceeded its I/O budget; values omitted.",
      }[code]
    );
    this.name = "NativeComposeOwnershipError";
    this.code = code;
  }
}
function refuse(code: FailureCode = "E_NATIVE_COMPOSE_OWNERSHIP"): never {
  throw new NativeComposeOwnershipError(code);
}
function requireValue(value: unknown): asserts value {
  if (!value) {
    refuse();
  }
}

/** Keep every active physical bridge and its policy until a verified down transition. */
export function mergeNativeComposeNetworkPolicies(opts: {
  readonly proposed: readonly NativeComposeNetworkPolicy[];
  readonly retained: readonly (readonly NativeComposeNetworkPolicy[])[];
  /** Down may inspect every saved name, never discard a conflicting saved policy. */
  readonly retiring?: boolean;
}): readonly NativeComposeNetworkPolicy[] {
  const selected = new Map(
    opts.proposed.map((network) => [network.name, network])
  );
  for (const policies of opts.retained) {
    for (const previous of policies) {
      const next = selected.get(previous.name);
      if (!next && opts.retiring) {
        selected.set(previous.name, previous);
        continue;
      }
      if (
        !(
          next &&
          next.driver === previous.driver &&
          next.internal === previous.internal
        )
      ) {
        return refuse("E_NATIVE_COMPOSE_NETWORK_TRANSITION");
      }
    }
  }
  return [...selected.values()].map((network) => ({ ...network }));
}
function hasKeys(
  value: Record<string, unknown>,
  keys: readonly string[]
): boolean {
  return Object.keys(value).sort().join() === [...keys].sort().join();
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
function validateOptions(opts: NativeComposeOwnershipOptions): void {
  requireValue(PROJECT.test(opts.composeProject));
  requireValue(PROJECT.test(opts.runtimeIdentity));
  requireValue(GENERATION.test(opts.ownerToken));
  requireValue(opts.generationIds.every((value) => GENERATION.test(value)));
  requireValue(opts.expectedServices.every((value) => SERVICE.test(value)));
  requireValue(
    new Set(opts.expectedServices).size === opts.expectedServices.length
  );
  const names = new Set<string>();
  for (const volume of opts.expectedVolumes ?? []) {
    requireValue(NAME.test(volume.name) && SERVICE.test(volume.storage));
    requireValue(!names.has(volume.name));
    names.add(volume.name);
  }
  requireValue(
    opts.expectedNetwork === undefined || NAME.test(opts.expectedNetwork)
  );
  requireValue(
    opts.expectedNetwork === undefined || opts.expectedNetworks === undefined
  );
  requireValue(
    opts.expectedNetworks === undefined ||
      opts.expectedWorkloadNetworks !== undefined
  );
  requireValue(opts.recovery === undefined || opts.recovery === "down");
  const networks = new Set<string>();
  for (const network of networkPolicies(opts)) {
    requireValue(
      NAME.test(network.name) &&
        network.driver === "bridge" &&
        typeof network.internal === "boolean" &&
        !networks.has(network.name)
    );
    networks.add(network.name);
  }
  const workloads = new Set<string>();
  for (const workload of workloadNetworks(opts)) {
    const key = `${workload.generationId}\0${workload.service}`;
    requireValue(
      opts.generationIds.includes(workload.generationId) &&
        opts.expectedServices.includes(workload.service) &&
        !workloads.has(key)
    );
    workloads.add(key);
    const names = new Set<string>();
    for (const attachment of workload.networks) {
      requireValue(
        NAME.test(attachment.name) &&
          !names.has(attachment.name) &&
          attachment.aliases.every((alias) => SERVICE.test(alias)) &&
          new Set(attachment.aliases).size === attachment.aliases.length
      );
      names.add(attachment.name);
      requireValue(
        attachment.externalId === undefined
          ? networks.has(attachment.name)
          : attachment.name === DEFAULT_INGRESS_NETWORK &&
              ID.test(attachment.externalId) &&
              attachment.aliases.length === 0
      );
    }
  }
}

/**
 * Read-only preflight under the caller's verified instance lease. Select every
 * project-labelled resource and every expected persistent/replica-one name,
 * inspect immutable container/network IDs, and recheck that selected inventory.
 * Missing resources are allowed for fresh startup. This does not atomically lock
 * Docker: the effect owner must use the same engine/context and recheck at its
 * effect boundary. No engine mutation, repair, admission or lifecycle is performed.
 */
export async function assertNativeComposeOwned(
  input: NativeComposeOwnershipOptions
): Promise<NativeComposeOwnershipObservation> {
  try {
    validateOptions(input);
    const opts: NativeComposeOwnershipOptions = {
      ...input,
      generationIds: [...input.generationIds],
      expectedServices: [...input.expectedServices],
      ...(input.expectedVolumes
        ? {
            expectedVolumes: input.expectedVolumes.map((volume) => ({
              ...volume,
            })),
          }
        : {}),
      ...(input.expectedNetworks
        ? {
            expectedNetworks: input.expectedNetworks.map((network) => ({
              ...network,
            })),
          }
        : {}),
      ...(input.expectedWorkloadNetworks
        ? {
            expectedWorkloadNetworks: input.expectedWorkloadNetworks.map(
              (workload) => ({
                ...workload,
                networks: workload.networks.map((network) => ({
                  ...network,
                  aliases: [...network.aliases],
                })),
              })
            ),
          }
        : {}),
    };
    const probe = createNativeComposeProbe(opts);
    const expected = {
      container: new Set(
        opts.expectedServices.map(
          (service) => `${opts.composeProject}-${service}-1`
        )
      ),
      volume: new Set(
        (opts.expectedVolumes ?? []).map((volume) => volume.name)
      ),
      network: new Set(networkPolicies(opts).map((network) => network.name)),
    };
    const inventory = async (kind: Kind): Promise<Inventory[]> => {
      const output = await probe([
        kind,
        "ls",
        ...(kind === "container" ? ["--all"] : []),
        ...(kind === "volume" ? [] : ["--no-trunc"]),
        "--format",
        FORMATS[kind].list,
      ]);
      const selected: Inventory[] = [];
      const ids = new Set<string>();
      for (const row of lines(output)) {
        requireValue(hasKeys(row, ["id", "name", "project"]));
        requireValue(
          typeof row.id === "string" && typeof row.name === "string"
        );
        requireValue(typeof row.project === "string");
        requireValue(kind === "volume" ? row.id === row.name : ID.test(row.id));
        requireValue(!ids.has(row.id));
        ids.add(row.id);
        if (
          row.project === opts.composeProject ||
          expected[kind].has(row.name)
        ) {
          requireValue(NAME.test(row.name));
          selected.push({ id: row.id, name: row.name, project: row.project });
        }
      }
      return selected.sort((left, right) => left.id.localeCompare(right.id));
    };
    const observations: MutableObservation = {
      containers: [],
      volumes: [],
      networks: [],
      endpoints: new Map(),
      members: new Map(),
    };
    const selected = new Map<Kind, Inventory[]>();
    for (const kind of ["container", "volume", "network"] as const) {
      const resources = await inventory(kind);
      selected.set(kind, resources);
      await collectInspections({
        kind,
        resources,
        selection: opts,
        probe,
        observations,
      });
    }
    validateTopology(opts, observations);
    // Attachments can change without changing container or network object IDs.
    // Recheck policy IDs, aliases and membership; this is not an IP/endpoint-incarnation fence.
    const rechecked: MutableObservation = {
      containers: [],
      volumes: [],
      networks: [],
      endpoints: new Map(),
      members: new Map(),
    };
    for (const kind of ["container", "network"] as const) {
      await collectInspections({
        kind,
        resources: selected.get(kind) ?? [],
        selection: opts,
        probe,
        observations: rechecked,
      });
    }
    validateTopology(opts, rechecked);
    requireValue(
      JSON.stringify(topologySnapshot(observations)) ===
        JSON.stringify(topologySnapshot(rechecked))
    );
    for (const kind of ["container", "volume", "network"] as const) {
      requireValue(
        JSON.stringify(await inventory(kind)) ===
          JSON.stringify(selected.get(kind))
      );
    }
    return {
      containers: rechecked.containers,
      volumes: observations.volumes,
      networks: rechecked.networks,
    };
  } catch (error: unknown) {
    if (error instanceof NativeComposeOwnershipError) {
      throw error;
    }
    refuse("E_NATIVE_COMPOSE_PROBE");
  }
}

type MutableObservation = {
  containers: NativeComposeContainerObservation[];
  volumes: { name: string; storage: string }[];
  networks: { id: string; name: string }[];
  endpoints: Map<string, Record<string, unknown>>;
  members: Map<string, readonly string[]>;
};
async function collectInspections(input: {
  readonly kind: Kind;
  readonly resources: readonly Inventory[];
  readonly selection: NativeComposeOwnershipOptions;
  readonly probe: (args: readonly string[]) => Promise<string>;
  readonly observations: MutableObservation;
}): Promise<void> {
  const { kind, resources, selection: opts, probe, observations } = input;
  const { containers, volumes, networks } = observations;
  for (const batch of batches(resources)) {
    const output = await probe([
      kind,
      "inspect",
      "--format",
      FORMATS[kind].inspect,
      ...batch.map((resource) => resource.id),
    ]);
    const rows = lines(output);
    requireValue(rows.length === batch.length);
    const remaining = new Map(batch.map((resource) => [resource.id, resource]));
    for (const row of rows) {
      requireValue(typeof row.id === "string");
      const resource = remaining.get(row.id);
      requireValue(resource !== undefined);
      remaining.delete(row.id);
      requireValue(
        row.name ===
          (kind === "container" ? `/${resource.name}` : resource.name)
      );
      requireValue(
        row.project === opts.composeProject && row.project === resource.project
      );
      requireValue(
        row.version === "1" &&
          row.instance === opts.runtimeIdentity &&
          row.owner === opts.ownerToken
      );
      if (kind === "container") {
        containers.push(containerObservation(row, opts));
        requireValue(isRecord(row.networks));
        observations.endpoints.set(resource.id, row.networks);
      } else if (kind === "volume") {
        requireValue(
          hasKeys(row, [
            "id",
            "name",
            "project",
            "version",
            "instance",
            "owner",
            "storage",
          ])
        );
        requireValue(
          typeof row.storage === "string" && SERVICE.test(row.storage)
        );
        const expectedVolume = opts.expectedVolumes?.find(
          (volume) => volume.name === resource.name
        );
        requireValue(
          expectedVolume !== undefined && expectedVolume.storage === row.storage
        );
        volumes.push({ name: resource.name, storage: row.storage });
      } else {
        requireValue(
          hasKeys(row, [
            "id",
            "name",
            "project",
            "version",
            "instance",
            "owner",
            "driver",
            "internal",
            "containers",
          ])
        );
        const expected = networkPolicies(opts).find(
          (network) => network.name === resource.name
        );
        requireValue(
          expected !== undefined &&
            row.driver === expected.driver &&
            row.internal === expected.internal
        );
        requireValue(isRecord(row.containers));
        const members = Object.keys(row.containers);
        requireValue(members.every((id) => ID.test(id)));
        observations.members.set(resource.name, members.sort());
        networks.push({ id: resource.id, name: resource.name });
      }
    }
  }
}

function containerObservation(
  row: Record<string, unknown>,
  opts: NativeComposeOwnershipOptions
): NativeComposeContainerObservation {
  requireValue(
    hasKeys(row, [
      "id",
      "name",
      "project",
      "version",
      "instance",
      "owner",
      "generation",
      "service",
      "oneoff",
      "state",
      "exitCode",
      "health",
      "networks",
    ])
  );
  requireValue(
    typeof row.generation === "string" &&
      opts.generationIds.includes(row.generation)
  );
  requireValue(
    typeof row.service === "string" &&
      opts.expectedServices.includes(row.service)
  );
  requireValue(
    row.oneoff === "True" ||
      row.oneoff === "False" ||
      row.oneoff === "true" ||
      row.oneoff === "false"
  );
  requireValue(
    row.state === "created" ||
      row.state === "restarting" ||
      row.state === "running" ||
      row.state === "removing" ||
      row.state === "paused" ||
      row.state === "exited" ||
      row.state === "dead"
  );
  requireValue(
    typeof row.exitCode === "number" &&
      Number.isSafeInteger(row.exitCode) &&
      row.exitCode >= 0
  );
  requireValue(
    row.health === null ||
      row.health === "starting" ||
      row.health === "healthy" ||
      row.health === "unhealthy"
  );
  requireValue(typeof row.id === "string" && ID.test(row.id));
  requireValue(typeof row.name === "string");
  return {
    id: row.id,
    name: row.name.startsWith("/") ? row.name.slice(1) : row.name,
    generationId: row.generation,
    service: row.service,
    state: row.state,
    exitCode: row.exitCode,
    health: row.health,
    oneoff: row.oneoff === "True" || row.oneoff === "true",
  };
}

function endpointAliases(value: unknown): readonly string[] {
  requireValue(
    Array.isArray(value) &&
      value.every((alias) => typeof alias === "string" && NAME.test(alias)) &&
      new Set(value).size === value.length
  );
  return [...new Set(value as string[])].sort();
}

function validateEndpointIdentity(opts: {
  readonly endpoint: Record<string, unknown>;
  readonly id: string | undefined;
  readonly expectedAliases: readonly string[];
  readonly absentOwnedRecovery: boolean;
  readonly createdOwnedRecovery: boolean;
}): void {
  const {
    endpoint,
    id,
    expectedAliases,
    absentOwnedRecovery,
    createdOwnedRecovery,
  } = opts;
  if (createdOwnedRecovery) {
    requireValue(
      id !== undefined &&
        (endpoint.NetworkID === undefined || endpoint.NetworkID === "")
    );
    if (
      endpoint.Aliases === undefined ||
      endpoint.Aliases === null ||
      (Array.isArray(endpoint.Aliases) && endpoint.Aliases.length === 0)
    ) {
      return;
    }
  } else if (absentOwnedRecovery) {
    requireValue(
      endpoint.NetworkID === undefined ||
        endpoint.NetworkID === "" ||
        (typeof endpoint.NetworkID === "string" && ID.test(endpoint.NetworkID))
    );
    if (endpoint.Aliases === undefined || endpoint.Aliases === null) {
      return;
    }
  } else {
    requireValue(id !== undefined && endpoint.NetworkID === id);
  }
  requireValue(
    JSON.stringify(endpointAliases(endpoint.Aliases)) ===
      JSON.stringify(expectedAliases)
  );
}

function validateTopology(
  opts: NativeComposeOwnershipOptions,
  observations: MutableObservation
): void {
  const policies = workloadNetworks(opts);
  const owned = new Map(
    observations.networks.map((network) => [network.name, network.id])
  );
  const containers = new Set(
    observations.containers.map((container) => container.id)
  );
  for (const [name, members] of observations.members) {
    requireValue(
      members.every(
        (id) =>
          containers.has(id) &&
          Object.hasOwn(observations.endpoints.get(id) ?? {}, name)
      )
    );
  }
  for (const container of observations.containers) {
    const policy = policies.find(
      (workload) =>
        workload.generationId === container.generationId &&
        workload.service === container.service
    );
    requireValue(policy !== undefined);
    const endpoints = observations.endpoints.get(container.id);
    requireValue(
      endpoints !== undefined &&
        hasKeys(
          endpoints,
          policy.networks.map((network) => network.name)
        )
    );
    for (const attachment of policy.networks) {
      const endpoint = endpoints[attachment.name];
      requireValue(isRecord(endpoint));
      const id = attachment.externalId ?? owned.get(attachment.name);
      const expected = container.oneoff
        ? [container.name]
        : [
            ...new Set([
              container.name,
              container.service,
              ...attachment.aliases,
            ]),
          ].sort();
      const absentOwnedRecovery =
        opts.recovery === "down" &&
        attachment.externalId === undefined &&
        id === undefined &&
        ["created", "exited", "dead", "removing"].includes(container.state);
      validateEndpointIdentity({
        endpoint,
        id,
        expectedAliases: expected,
        absentOwnedRecovery,
        createdOwnedRecovery:
          opts.recovery === "down" &&
          container.state === "created" &&
          attachment.externalId === undefined &&
          id !== undefined &&
          (endpoint.NetworkID === undefined || endpoint.NetworkID === ""),
      });
      if (
        attachment.externalId === undefined &&
        (container.state === "running" ||
          container.state === "paused" ||
          container.state === "restarting")
      ) {
        requireValue(
          observations.members.get(attachment.name)?.includes(container.id)
        );
      }
    }
  }
}

function topologySnapshot(observations: MutableObservation) {
  return {
    endpoints: [...observations.endpoints]
      .map(([id, endpoints]) => [
        id,
        Object.entries(endpoints)
          .map(([name, endpoint]) => {
            requireValue(isRecord(endpoint));
            return [
              name,
              endpoint.NetworkID,
              endpoint.Aliases == null
                ? null
                : endpointAliases(endpoint.Aliases),
            ];
          })
          .sort(([left], [right]) => String(left).localeCompare(String(right))),
      ])
      .sort(([left], [right]) => String(left).localeCompare(String(right))),
    members: [...observations.members].sort(([left], [right]) =>
      left.localeCompare(right)
    ),
  };
}

/** Bound command argv, rather than the number of resources in the project. */
function batches(resources: readonly Inventory[]): Inventory[][] {
  const result: Inventory[][] = [];
  let batch: Inventory[] = [];
  let bytes = 0;
  for (const resource of resources) {
    const length = Buffer.byteLength(resource.id) + 1;
    requireValue(length <= ARGUMENT_LIMIT);
    if (bytes + length > ARGUMENT_LIMIT) {
      result.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(resource);
    bytes += length;
  }
  if (batch.length > 0) {
    result.push(batch);
  }
  return result;
}

/** Shared bounded, redacted Docker read boundary; callers supply only fixed inspection commands. */
export function createNativeComposeProbe(
  opts: Pick<NativeComposeOwnershipOptions, "signal" | "timeoutMs">
): (args: readonly string[]) => Promise<string> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  requireValue(
    Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 60_000
  );
  const deadline = Date.now() + timeoutMs;
  let remainingOutput = OUTPUT_LIMIT;
  checkInterruption(opts.signal, false);
  const binary = findExecutableInPath("docker");
  if (!binary) {
    refuse("E_NATIVE_COMPOSE_PROBE");
  }
  const environment = { ...process.env };
  return async (args) => {
    checkInterruption(opts.signal, false);
    const remainingTime = deadline - Date.now();
    if (remainingTime <= 0) {
      refuse("E_NATIVE_COMPOSE_PROBE_TIMEOUT");
    }
    let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
    const ownsProcessGroup = process.platform !== "win32";
    try {
      child = Bun.spawn([binary, ...args], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        detached: ownsProcessGroup,
        env: environment,
      });
    } catch {
      refuse("E_NATIVE_COMPOSE_PROBE");
    }
    const io = new AbortController();
    let settled = false;
    let stopped = false;
    const stop = () => {
      if (!(settled || stopped)) {
        stopped = true;
        killProbe({ child, ownsProcessGroup });
      }
      io.abort();
    };
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, remainingTime);
    opts.signal?.addEventListener("abort", stop, { once: true });
    if (opts.signal?.aborted) {
      stop();
    }
    const output = readBounded(child.stdout, remainingOutput, io.signal);
    const diagnostics = readBounded(child.stderr, STDERR_LIMIT, io.signal);
    try {
      const [bytes, , exitCode] = await Promise.all([
        output,
        diagnostics,
        child.exited,
      ]);
      // Exited child and closed streams release the owned group: do not signal
      // its former ID, which may be recycled by an unrelated process group.
      settled = true;
      checkInterruption(opts.signal, timedOut);
      if (exitCode !== 0) {
        refuse("E_NATIVE_COMPOSE_PROBE");
      }
      remainingOutput -= bytes.byteLength;
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error: unknown) {
      checkInterruption(opts.signal, timedOut);
      throw error;
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", stop);
      stop();
      await Promise.allSettled([output, diagnostics, child.exited]);
    }
  };
}

function checkInterruption(
  signal: AbortSignal | undefined,
  timedOut: boolean
): void {
  if (signal?.aborted) {
    refuse("E_NATIVE_COMPOSE_PROBE_CANCELLED");
  }
  if (timedOut) {
    refuse("E_NATIVE_COMPOSE_PROBE_TIMEOUT");
  }
}

function killProbe(opts: {
  readonly child: Bun.Subprocess<"ignore", "pipe", "pipe">;
  readonly ownsProcessGroup: boolean;
}): void {
  if (opts.ownsProcessGroup) {
    try {
      process.kill(-opts.child.pid, "SIGKILL");
    } catch {
      // The owned group may already have exited.
    }
  }
  if (opts.child.exitCode === null) {
    try {
      opts.child.kill("SIGKILL");
    } catch {
      // Exit may race cancellation.
    }
  }
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  signal: AbortSignal
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) {
    cancel();
  }
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      size += chunk.value.byteLength;
      if (size > limit) {
        refuse("E_NATIVE_COMPOSE_PROBE_BUDGET");
      }
      chunks.push(chunk.value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}
