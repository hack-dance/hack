import { openNativeComposeGenerationStore } from "../../src/lib/native-compose-generation.ts";
import { createNativeComposeProbe } from "../../src/lib/native-compose-ownership.ts";

const SERVICES = ["graceful", "forced", "reaper", "retry"] as const;
const SAVED_SERVICES = [...SERVICES, "observer"] as const;
const ID = /^[a-f0-9]{64}$/;
const IMAGE = /^sha256:[a-f0-9]{64}$/;
const ENGINE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const UNCERTAIN_MESSAGE =
  "Native Compose operation has an uncertain outcome; inspect the saved generation or explicitly stop its owned resources before retrying.";
const CONTAINERS = `{"id":{{json .ID}},"name":{{json .Names}},"project":{{json (.Label "com.docker.compose.project")}}}`;
const NETWORKS = `{"id":{{json .ID}},"name":{{json .Name}},"project":{{json (.Label "com.docker.compose.project")}}}`;
const CONTAINER = `{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Image}},"state":{{json .State.Status}},"restartCount":{{json .RestartCount}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"instance":{{json (index .Config.Labels "io.hack.native-config.instance")}},"owner":{{json (index .Config.Labels "io.hack.native-config.owner")}},"generation":{{json (index .Config.Labels "io.hack.native-config.generation")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"version":{{json (index .Config.Labels "io.hack.native-config.version")}},"workload":{{json (index .Config.Labels "io.hack.native-config.workload")}},"oneoff":{{json (index .Config.Labels "com.docker.compose.oneoff")}},"endpoints":[{{$first := true}}{{range $name,$endpoint := .NetworkSettings.Networks}}{{if not $first}},{{end}}{{$first = false}}{"name":{{json $name}},"networkId":{{json $endpoint.NetworkID}},"aliases":{{json $endpoint.Aliases}}}{{end}}]}`;
const NETWORK = `{"id":{{json .Id}},"name":{{json .Name}},"driver":{{json .Driver}},"internal":{{json .Internal}},"project":{{json (index .Labels "com.docker.compose.project")}},"instance":{{json (index .Labels "io.hack.native-config.instance")}},"owner":{{json (index .Labels "io.hack.native-config.owner")}},"version":{{json (index .Labels "io.hack.native-config.version")}},"members":[{{$first := true}}{{range $id,$value := .Containers}}{{if not $first}},{{end}}{{$first = false}}{{json $id}}{{end}}]}`;

type Row = Record<string, unknown>;
type Endpoint = { name: string; networkId: unknown; aliases: unknown };
type Container = Row & { id: string; name: string; endpoints: Endpoint[] };
type Network = Row & { id: string; name: string; members: string[] };
type Scan = { containers: Container[]; bridge: Network | null };
type Context = {
  project: string;
  owner: string;
  generation: string;
  bridge: string;
  image: string;
  engine: string;
};
type Probe = (args: readonly string[]) => Promise<string>;
type Dependencies = {
  readonly openStore: typeof openNativeComposeGenerationStore;
  readonly createProbe: typeof createNativeComposeProbe;
};
const defaultDependencies: Dependencies = {
  openStore: openNativeComposeGenerationStore,
  createProbe: createNativeComposeProbe,
};
const OWN_REASONS = [
  "diagnostic_bound",
  "diagnostic_engine_drift",
  "diagnostic_engine_selection",
  "diagnostic_foreign_bridge",
  "diagnostic_foreign_name",
  "diagnostic_inventory_drift",
  "diagnostic_inventory",
  "diagnostic_pending_drift",
  "diagnostic_pending_selection",
  "diagnostic_saved_image",
  "diagnostic_saved_topology",
  "diagnostic_shape",
] as const;
type OwnReason = (typeof OWN_REASONS)[number];
type DiagnosticStage =
  | "saved-selection"
  | "saved-document"
  | "first-scan"
  | "second-scan"
  | "final-recheck"
  | "record";
class DiagnosticRefusal extends Error {
  readonly reason: OwnReason;
  constructor(reason: OwnReason) {
    super(reason);
    this.reason = reason;
  }
}
function refuse(reason: OwnReason): never {
  throw new DiagnosticRefusal(reason);
}

/** Only the exact failed startup envelope opts into diagnostic observation. */
export function isKnownUncertainProcessPolicyStartup(result: {
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly stdout: string;
}): boolean {
  if (result.timedOut || result.exitCode !== 1 || result.stdout.length > 4096) {
    return false;
  }
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    return false;
  }
  if (!(value !== null && typeof value === "object" && !Array.isArray(value))) {
    return false;
  }
  const envelope = value as Row;
  if (
    !(
      envelope.error !== null &&
      typeof envelope.error === "object" &&
      !Array.isArray(envelope.error)
    )
  ) {
    return false;
  }
  const error = envelope.error as Row;
  return (
    envelope.ok === false &&
    error.code === "E_CONFIG_INVALID" &&
    error.message === UNCERTAIN_MESSAGE
  );
}

function object(value: string): Row {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    refuse("diagnostic_shape");
  }
  if (
    !(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed))
  ) {
    refuse("diagnostic_shape");
  }
  return parsed as Row;
}
function rows(value: string): Row[] {
  if (value.length > 65_536) {
    refuse("diagnostic_bound");
  }
  const lines = value.trim() ? value.trim().split("\n") : [];
  if (lines.length > 64) {
    refuse("diagnostic_bound");
  }
  return lines.map(object);
}
function exactNames(value: unknown, names: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "string") &&
    new Set(value).size === value.length &&
    JSON.stringify([...value].sort()) === JSON.stringify([...names].sort())
  );
}
function container(value: Row): Container {
  if (
    !(
      typeof value.id === "string" &&
      ID.test(value.id) &&
      typeof value.name === "string" &&
      Array.isArray(value.endpoints) &&
      value.endpoints.length <= 4 &&
      value.endpoints.every(
        (item: unknown) =>
          item !== null &&
          typeof item === "object" &&
          !Array.isArray(item) &&
          typeof (item as Row).name === "string"
      )
    )
  ) {
    refuse("diagnostic_shape");
  }
  return value as Container;
}
function network(value: Row): Network {
  if (
    !(
      typeof value.id === "string" &&
      ID.test(value.id) &&
      typeof value.name === "string" &&
      Array.isArray(value.members) &&
      value.members.length <= 16 &&
      value.members.every(
        (id: unknown) => typeof id === "string" && ID.test(id)
      )
    )
  ) {
    refuse("diagnostic_shape");
  }
  return value as Network;
}
async function scan(
  ctx: Context,
  createProbe: Dependencies["createProbe"]
): Promise<Scan> {
  // The production probe bounds command time, bytes and process-group cleanup.
  // Each scan gets a fresh aggregate owner; raw Docker JSON stays in memory.
  const probe: Probe = createProbe({ timeoutMs: 30_000 });
  const engineBefore = (await probe(["info", "--format", "{{.ID}}"])).trim();
  if (engineBefore !== ctx.engine) {
    refuse("diagnostic_engine_drift");
  }
  const listed = rows(
    await probe([
      "container",
      "ls",
      "--all",
      "--no-trunc",
      "--format",
      CONTAINERS,
    ])
  );
  const knownNames = SERVICES.map((service) => `${ctx.project}-${service}-1`);
  const selected = listed.filter(
    (row) =>
      row.project === ctx.project || knownNames.includes(String(row.name))
  );
  if (
    selected.some(
      (row) =>
        knownNames.includes(String(row.name)) && row.project !== ctx.project
    )
  ) {
    refuse("diagnostic_foreign_name");
  }
  if (
    selected.length > 8 ||
    selected.some((row) => !ID.test(String(row.id))) ||
    new Set(selected.map((row) => row.id)).size !== selected.length ||
    new Set(selected.map((row) => row.name)).size !== selected.length
  ) {
    refuse("diagnostic_inventory");
  }
  const inspected =
    selected.length === 0
      ? []
      : rows(
          await probe([
            "container",
            "inspect",
            "--format",
            CONTAINER,
            ...selected.map((row) => String(row.id)),
          ])
        ).map(container);
  if (
    inspected.length !== selected.length ||
    inspected.some((row) => !selected.some((item) => item.id === row.id))
  ) {
    refuse("diagnostic_inventory_drift");
  }
  const bridges = rows(
    await probe(["network", "ls", "--no-trunc", "--format", NETWORKS])
  ).filter((row) => row.project === ctx.project || row.name === ctx.bridge);
  if (
    bridges.some(
      (row) => row.name === ctx.bridge && row.project !== ctx.project
    )
  ) {
    refuse("diagnostic_foreign_bridge");
  }
  if (
    bridges.length > 2 ||
    bridges.some((row) => !ID.test(String(row.id))) ||
    new Set(bridges.map((row) => row.id)).size !== bridges.length
  ) {
    refuse("diagnostic_inventory");
  }
  const selectedBridge = bridges.find((row) => row.name === ctx.bridge);
  const bridge = selectedBridge
    ? network(
        object(
          await probe([
            "network",
            "inspect",
            "--format",
            NETWORK,
            String(selectedBridge.id),
          ])
        )
      )
    : null;
  if (bridge && bridge.id !== selectedBridge?.id) {
    refuse("diagnostic_inventory_drift");
  }
  const engineAfter = (await probe(["info", "--format", "{{.ID}}"])).trim();
  if (engineAfter !== ctx.engine) {
    refuse("diagnostic_engine_drift");
  }
  return { containers: inspected, bridge };
}

function safeScan(ctx: Context, value: Scan) {
  const selectedIds = new Set(value.containers.map((row) => row.id));
  const members = new Set(value.bridge?.members ?? []);
  const services = SERVICES.map((service) => {
    const matches = value.containers.filter((row) => row.service === service);
    const row = matches.length === 1 ? matches[0] : undefined;
    const endpoint = row?.endpoints.find((item) => item.name === ctx.bridge);
    const expectedAliases = [`${ctx.project}-${service}-1`, service];
    const states = [
      "created",
      "running",
      "restarting",
      "exited",
      "paused",
      "dead",
      "removing",
    ];
    return {
      service,
      present: row !== undefined,
      state:
        row && typeof row.state === "string" && states.includes(row.state)
          ? row.state
          : "unknown",
      restartCount:
        typeof row?.restartCount === "number" &&
        Number.isSafeInteger(row.restartCount) &&
        row.restartCount >= 0
          ? row.restartCount
          : null,
      imageMatch: row?.image === ctx.image,
      ownerMatch:
        row !== undefined &&
        row.project === ctx.project &&
        row.instance === ctx.project &&
        row.owner === ctx.owner &&
        row.generation === ctx.generation &&
        row.version === "1" &&
        row.workload === "service" &&
        row.oneoff === "False" &&
        row.name.replace(/^\//, "") === `${ctx.project}-${service}-1`,
      endpointKeyMatch: row
        ? exactNames(
            row.endpoints.map((item) => item.name),
            [ctx.bridge]
          )
        : false,
      networkIdMatch:
        endpoint?.networkId === value.bridge?.id && value.bridge !== null,
      aliasesMatch: exactNames(endpoint?.aliases, expectedAliases),
      memberMatch: row ? members.has(row.id) : false,
    };
  });
  return {
    inventoryMatch:
      value.containers.length === SERVICES.length &&
      services.every((item) => item.present),
    bridgePresent: value.bridge !== null,
    bridgePolicyMatch:
      value.bridge !== null &&
      value.bridge.name === ctx.bridge &&
      value.bridge.driver === "bridge" &&
      value.bridge.internal === false,
    bridgeOwnerMatch:
      value.bridge !== null &&
      value.bridge.project === ctx.project &&
      value.bridge.instance === ctx.project &&
      value.bridge.owner === ctx.owner &&
      value.bridge.version === "1",
    bridgeMembersSelected:
      value.bridge?.members.every((id) => selectedIds.has(id)) ?? false,
    services,
  };
}

function drift(
  first: Scan,
  second: Scan
):
  | "none"
  | "inventory"
  | "endpoint"
  | "member"
  | "state"
  | "binding"
  | "mixed" {
  const differences = [
    [
      "inventory",
      JSON.stringify(first.containers.map((row) => row.id).sort()) !==
        JSON.stringify(second.containers.map((row) => row.id).sort()) ||
        first.bridge?.id !== second.bridge?.id,
    ],
    [
      "endpoint",
      JSON.stringify(
        first.containers.map((row) => [row.id, row.endpoints]).sort()
      ) !==
        JSON.stringify(
          second.containers.map((row) => [row.id, row.endpoints]).sort()
        ),
    ],
    [
      "member",
      JSON.stringify(first.bridge?.members) !==
        JSON.stringify(second.bridge?.members),
    ],
    [
      "state",
      JSON.stringify(
        first.containers
          .map((row) => [row.id, row.state, row.restartCount])
          .sort()
      ) !==
        JSON.stringify(
          second.containers
            .map((row) => [row.id, row.state, row.restartCount])
            .sort()
        ),
    ],
    [
      "binding",
      JSON.stringify(
        first.containers
          .map((row) => [
            row.id,
            row.name,
            row.image,
            row.project,
            row.instance,
            row.owner,
            row.generation,
            row.service,
            row.version,
            row.workload,
            row.oneoff,
          ])
          .sort()
      ) !==
        JSON.stringify(
          second.containers
            .map((row) => [
              row.id,
              row.name,
              row.image,
              row.project,
              row.instance,
              row.owner,
              row.generation,
              row.service,
              row.version,
              row.workload,
              row.oneoff,
            ])
            .sort()
        ) ||
        JSON.stringify(
          first.bridge && [
            first.bridge.name,
            first.bridge.driver,
            first.bridge.internal,
            first.bridge.project,
            first.bridge.instance,
            first.bridge.owner,
            first.bridge.version,
          ]
        ) !==
          JSON.stringify(
            second.bridge && [
              second.bridge.name,
              second.bridge.driver,
              second.bridge.internal,
              second.bridge.project,
              second.bridge.instance,
              second.bridge.owner,
              second.bridge.version,
            ]
          ),
    ],
  ] as const;
  const changed = differences
    .filter(([, differs]) => differs)
    .map(([name]) => name);
  return changed.length === 0
    ? "none"
    : changed.length === 1
      ? (changed[0] ?? "mixed")
      : "mixed";
}

/** The return value contains only fixed service names, enums, counts and booleans. Never serialize the saved document or raw scans. */
export async function captureNativeProcessPolicyStartupDiagnostic(opts: {
  readonly projectRoot: string;
  readonly expectedEngineId: string;
  readonly dependencies?: Dependencies;
  readonly onStage?: (stage: DiagnosticStage) => void;
}) {
  opts.onStage?.("saved-selection");
  if (!ENGINE.test(opts.expectedEngineId)) {
    refuse("diagnostic_engine_selection");
  }
  const dependencies = opts.dependencies ?? defaultDependencies;
  const store = await dependencies.openStore({
    projectRoot: opts.projectRoot,
    instance: null,
    mode: "saved",
  });
  try {
    const before = await store.loadCurrent();
    const pending = await store.loadPending();
    if (
      !(
        before.pending?.operation === "up" &&
        pending &&
        before.pending.generationId === pending.generationId
      )
    ) {
      refuse("diagnostic_pending_selection");
    }
    opts.onStage?.("saved-document");
    const document = await store.readGenerationDocument(pending);
    const serviceMap = document.services;
    const networkMap = document.networks;
    const defaultNetwork =
      networkMap !== null &&
      typeof networkMap === "object" &&
      !Array.isArray(networkMap)
        ? (networkMap as Row).default
        : null;
    if (
      !(
        serviceMap !== null &&
        typeof serviceMap === "object" &&
        !Array.isArray(serviceMap) &&
        exactNames(pending.profiles, ["exercise"]) &&
        exactNames(Object.keys(serviceMap), SAVED_SERVICES) &&
        networkMap !== null &&
        typeof networkMap === "object" &&
        !Array.isArray(networkMap) &&
        exactNames(Object.keys(networkMap), ["default"]) &&
        defaultNetwork !== null &&
        typeof defaultNetwork === "object" &&
        !Array.isArray(defaultNetwork) &&
        (defaultNetwork as Row).name ===
          `${store.identity.composeProject}_default` &&
        Object.entries(serviceMap).every(
          ([name, item]) =>
            item !== null &&
            typeof item === "object" &&
            !Array.isArray(item) &&
            exactNames((item as Row).profiles, [
              name === "observer" ? "readback" : "exercise",
            ]) &&
            !Object.hasOwn(item, "networks")
        )
      )
    ) {
      refuse("diagnostic_saved_topology");
    }
    const images = SERVICES.map((service) => (serviceMap as Row)[service]).map(
      (value) =>
        value !== null && typeof value === "object" && !Array.isArray(value)
          ? (value as Row).image
          : null
    );
    const image = images[0];
    if (
      !(
        images.length === 4 &&
        images.every((item) => item === image) &&
        typeof image === "string" &&
        IMAGE.test(image)
      )
    ) {
      refuse("diagnostic_saved_image");
    }
    const context: Context = {
      project: store.identity.composeProject,
      owner: store.identity.ownerToken,
      generation: pending.generationId,
      bridge: `${store.identity.composeProject}_default`,
      image,
      engine: opts.expectedEngineId,
    };
    opts.onStage?.("first-scan");
    const first = await scan(context, dependencies.createProbe);
    opts.onStage?.("second-scan");
    const second = await scan(context, dependencies.createProbe);
    opts.onStage?.("final-recheck");
    const after = await store.loadCurrent();
    const afterPending = await store.loadPending();
    const afterDocument = afterPending
      ? await store.readGenerationDocument(afterPending)
      : null;
    if (
      JSON.stringify(after) !== JSON.stringify(before) ||
      JSON.stringify(afterPending) !== JSON.stringify(pending) ||
      JSON.stringify(afterDocument) !== JSON.stringify(document)
    ) {
      refuse("diagnostic_pending_drift");
    }
    return {
      version: 1,
      first: safeScan(context, first),
      second: safeScan(context, second),
      drift: drift(first, second),
    };
  } finally {
    await store.close();
  }
}

export type NativeProcessPolicyStartupDiagnostic = Awaited<
  ReturnType<typeof captureNativeProcessPolicyStartupDiagnostic>
>;
type DiagnosticOutcome =
  | { readonly status: "not-applicable" | "captured" }
  | {
      readonly status: "unavailable";
      readonly stage: DiagnosticStage;
      readonly reason: OwnReason | "external_store_or_probe";
    };

/** Diagnostic failure cannot replace the original uncertain startup result. */
export async function recordKnownUncertainProcessPolicyStartup(opts: {
  readonly result: {
    readonly exitCode: number;
    readonly timedOut: boolean;
    readonly stdout: string;
  };
  readonly projectRoot: string;
  readonly expectedEngineId: string;
  readonly record: (
    summary: NativeProcessPolicyStartupDiagnostic
  ) => Promise<void>;
  readonly capture?: typeof captureNativeProcessPolicyStartupDiagnostic;
}): Promise<DiagnosticOutcome> {
  if (!isKnownUncertainProcessPolicyStartup(opts.result)) {
    return { status: "not-applicable" };
  }
  let stage: DiagnosticStage = "saved-selection";
  try {
    const summary = await (
      opts.capture ?? captureNativeProcessPolicyStartupDiagnostic
    )({
      projectRoot: opts.projectRoot,
      expectedEngineId: opts.expectedEngineId,
      onStage: (selected) => {
        stage = selected;
      },
    });
    stage = "record";
    await opts.record(summary);
    return { status: "captured" };
  } catch (error: unknown) {
    return {
      status: "unavailable",
      stage,
      reason:
        error instanceof DiagnosticRefusal
          ? error.reason
          : "external_store_or_probe",
    };
  }
}
