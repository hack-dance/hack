import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "../../../src/lib/guards.ts";
import { createNativeComposeProbe } from "../../../src/lib/native-compose-ownership.ts";
import { setProjectEnvValue } from "../../../src/lib/project-env-config.ts";
import {
  addLinkedWorktree,
  commitAll,
  createMonorepoFixture,
} from "../fixture.ts";
import {
  type CliResult,
  expect,
  resolveCliSpawnArgs,
  runCommand,
  type Scenario,
  type ScenarioContext,
} from "../harness.ts";
import {
  adoptionDependencyHealthcheck,
  assertAdoptionDependencyHealthcheck,
} from "./native-compose-adoption-dependency-inputs.ts";
import {
  prepareTypedLocalAdoptionFixtureSources,
  typedLocalAdoptionFixtureSourceSnapshot,
} from "./native-compose-adoption-local-inputs.ts";
import {
  MANAGED_FIXTURE_VALUE,
  managedAdoptionFixtureComposeFiles,
  managedAdoptionFixtureEnvAssertion,
  managedAdoptionFixtureSourceSnapshot,
  prepareManagedAdoptionFixtureSources,
} from "./native-compose-adoption-managed-inputs.ts";

const TIMEOUT = 180_000;
const PROJECT_LABEL = "com.docker.compose.project";
const NATIVE_PREFIX = "io.hack.native-config.";
const SYNTHETIC_VALUE = "nc04-synthetic-primary-local-value";
const SYNTHETIC_KEY = "NC04_INHERITED";
const ID = /^[a-f0-9]{64}$/;
const IMAGE = /^sha256:[a-f0-9]{64}$/;
const CREATED =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const WORKER_SCRIPT =
  "trap 'sleep 10; exit 0' TERM; while true; do sleep 1; done";
const LITERAL_SOURCE_ENTRYPOINT = [
  "/bin/sh",
  "-c",
  WORKER_SCRIPT,
  "entrypoint-$${NC04_LITERAL}",
];
const LITERAL_SOURCE_COMMAND = ["command-$$NC04_LITERAL", "$$$$", ""];
export const stringAdoptionWorkerSources = {
  "string-entrypoint": {
    entrypoint: `/bin/sh -c ${JSON.stringify(WORKER_SCRIPT)} "entrypoint-${"$$"}{NC04_LITERAL}"`,
    command: '  "command-$$NC04_LITERAL"   "$$$$" ""  ',
  },
  "string-cleared": {
    entrypoint: "",
    command: `/bin/sh -c ${JSON.stringify(WORKER_SCRIPT)} "command-$$NC04_LITERAL" "$$$$" ""`,
  },
} as const;
const LITERAL_ACTUAL_ENTRYPOINT = [
  "/bin/sh",
  "-c",
  WORKER_SCRIPT,
  "entrypoint-${NC04_LITERAL}",
];
const LITERAL_ACTUAL_COMMAND = ["command-$NC04_LITERAL", "$$", ""];
const CLEARED_ACTUAL_COMMAND = [
  "/bin/sh",
  "-c",
  WORKER_SCRIPT,
  ...LITERAL_ACTUAL_COMMAND,
];
type Kind = "container" | "network" | "volume";
type Instance = {
  readonly root: string;
  readonly name: string;
  readonly marker: string;
  readonly sourceMode?: "canonical-generated";
  readonly argvMode?: "string-entrypoint" | "string-cleared";
  readonly typedLocal?: true;
  readonly ownedNetwork?: true;
  readonly dependency?: "service_started" | "service_healthy";
};
type Observation = {
  readonly id: string;
  readonly service?: string;
  readonly createdAt?: string;
};
type Snapshot = {
  readonly resources: {
    readonly container: readonly Observation[];
    readonly network: readonly Observation[];
    readonly volume: readonly Observation[];
  };
  readonly source: string;
};
function fixtureNetworkName(instance: Instance): string {
  return `${instance.name}_${instance.ownedNetwork ? "private" : "default"}`;
}
function networkPolicyMatches(
  instance: Instance,
  row: Record<string, unknown>
) {
  return (
    row.name === fixtureNetworkName(instance) &&
    row.logical === (instance.ownedNetwork ? "private" : "default") &&
    (!instance.ownedNetwork ||
      (row.driver === "bridge" &&
        row.scope === "local" &&
        row.internal === true))
  );
}

/** Pure exact-ID fixture oracle; a stopped bridge must have no remaining members. */
export function assertAdoptionBridgeObservation(opts: {
  readonly instance: Instance;
  readonly id: string;
  readonly members: readonly string[];
  readonly row: unknown;
}) {
  const { instance, id, members, row } = opts;
  if (!(ID.test(id) && isRecord(row))) {
    refused();
  }
  if (
    row.id !== id ||
    !networkPolicyMatches(instance, row) ||
    !Array.isArray(row.members) ||
    row.members.some(
      (member) => typeof member !== "string" || !ID.test(member)
    ) ||
    new Set(row.members).size !== row.members.length ||
    JSON.stringify([...row.members].sort()) !==
      JSON.stringify([...members].sort())
  ) {
    refused();
  }
}

const BRIDGE_INSPECT_FORMAT = `{"id":{{json .Id}},"name":{{json .Name}},"logical":{{json (index .Labels "com.docker.compose.network")}},"internal":{{json .Internal}},"driver":{{json .Driver}},"scope":{{json .Scope}},"members":[{{$first := true}}{{range $id,$c := .Containers}}{{if not $first}},{{end}}{{$first = false}}{{json $id}}{{end}}]}`;

/** The real inspection request and the policy oracle share one fixed row contract. */
export async function inspectAdoptionBridge(opts: {
  readonly instance: Instance;
  readonly id: string;
  readonly members: readonly string[];
  readonly probe: (args: readonly string[]) => Promise<string>;
}) {
  const row = object(
    await opts.probe([
      "network",
      "inspect",
      "--format",
      BRIDGE_INSPECT_FORMAT,
      opts.id,
    ])
  );
  assertAdoptionBridgeObservation({
    instance: opts.instance,
    id: opts.id,
    members: opts.members,
    row,
  });
}

/** A retained original may lose stopped aliases, never a running alias or bridge ID. */
export function assertAdoptionEndpointObservation(opts: {
  readonly instance: Instance;
  readonly networkId: string;
  readonly container: Observation;
  readonly running: boolean;
  readonly row: unknown;
}) {
  const { instance, networkId, container, running, row } = opts;
  const expectedAliases = [
    `${instance.name}-${container.service}-1`,
    container.service,
    container.service === "db" ? "db-reader" : "worker-reader",
  ].sort();
  const endpoint =
    isRecord(row) && Array.isArray(row.networks) ? row.networks[0] : undefined;
  if (
    !(
      ID.test(networkId) &&
      container.service &&
      ["db", "worker"].includes(container.service) &&
      isRecord(row)
    )
  ) {
    refused();
  }
  if (
    row.id !== container.id ||
    row.running !== running ||
    !Array.isArray(row.networks) ||
    row.networks.length !== 1 ||
    !isRecord(endpoint) ||
    endpoint.name !== fixtureNetworkName(instance) ||
    endpoint.id !== networkId ||
    !(
      (Array.isArray(endpoint.aliases) &&
        endpoint.aliases.every((alias) => typeof alias === "string") &&
        new Set(endpoint.aliases).size === endpoint.aliases.length &&
        JSON.stringify([...endpoint.aliases].sort()) ===
          JSON.stringify(expectedAliases)) ||
      (!running &&
        (endpoint.aliases === null ||
          (Array.isArray(endpoint.aliases) && endpoint.aliases.length === 0)))
    )
  ) {
    refused();
  }
}
function refused(): never {
  throw new Error(
    "Adoption worktree fixture ownership or data check failed; values omitted."
  );
}

/**
 * Each complete fixture query needs its own bounded acquisition. The shared
 * createNativeComposeProbe aggregates time and output from factory creation;
 * its owner cannot span later stop/start/recovery stages. Product acquisitions
 * retain their existing aggregate limits and are never renewed by this helper.
 */
export function createAdoptionFixtureProbe() {
  return async (args: readonly string[]) =>
    (await createNativeComposeProbe({ timeoutMs: 30_000 })(args)).trim();
}

/** Fixture-only polling; callers bind SQL to captured original IDs and only seed markers before adoption. */
export async function waitForAdoptionFixtureSql(opts: {
  readonly read: () => Promise<string>;
  readonly expected: string;
  readonly timeoutMs?: number;
  readonly now?: () => number;
  readonly pause?: () => Promise<void>;
}) {
  try {
    const {
      read,
      expected,
      timeoutMs = 30_000,
      now = () => performance.now(),
      pause = () => Bun.sleep(500),
    } = opts;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000) {
      refused();
    }
    const start = now();
    if (!Number.isFinite(start)) {
      refused();
    }
    const deadline = start + timeoutMs;
    while (now() < deadline) {
      let value: string | undefined;
      try {
        value = await read();
      } catch {
        // PostgreSQL may restart its initial server before the fixture database is usable.
      }
      const after = now();
      if (!Number.isFinite(after)) {
        refused();
      }
      if (value === expected && after < deadline) {
        return;
      }
      if (after >= deadline) {
        break;
      }
      await pause();
    }
    refused();
  } catch {
    refused();
  }
}
function object(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    if (!isRecord(value)) {
      refused();
    }
    return value;
  } catch {
    refused();
  }
}

/** Actual container argv must retain the literal dollars; no environment or shell expansion is inferred. */
export function assertAdoptionWorkerArgv(opts: {
  readonly id: string;
  readonly row: unknown;
  readonly mode?: Instance["argvMode"];
}): void {
  const command =
    opts.mode === "string-cleared"
      ? CLEARED_ACTUAL_COMMAND
      : LITERAL_ACTUAL_COMMAND;
  const entrypoint =
    opts.mode === "string-cleared" ? [] : LITERAL_ACTUAL_ENTRYPOINT;
  if (
    !(ID.test(opts.id) && isRecord(opts.row)) ||
    opts.row.id !== opts.id ||
    JSON.stringify(opts.row.command) !== JSON.stringify(command) ||
    JSON.stringify(opts.row.entrypoint) !== JSON.stringify(entrypoint)
  ) {
    refused();
  }
}

/** Exact fixture cleanup oracle, independently checked before any captured-ID removal. */
export function ownedAdoptionFixtureObservation(opts: {
  readonly instance: Instance;
  readonly kind: Kind;
  readonly row: unknown;
}): Observation {
  try {
    return validateOwnedObservation(opts);
  } catch {
    refused();
  }
}
function validateOwnedObservation(opts: {
  readonly instance: Instance;
  readonly kind: Kind;
  readonly row: unknown;
}): Observation {
  const row = opts.row;
  if (
    opts.instance.sourceMode !== undefined &&
    opts.instance.sourceMode !== "canonical-generated"
  ) {
    refused();
  }
  if (
    !isRecord(row) ||
    row.project !== opts.instance.name ||
    !Array.isArray(row.nativeNames) ||
    row.nativeNames.some(
      (name) => typeof name !== "string" || name.startsWith(NATIVE_PREFIX)
    ) ||
    !["container", "network", "volume"].includes(opts.kind)
  ) {
    refused();
  }
  if (opts.kind === "container") {
    if (
      typeof row.id !== "string" ||
      !ID.test(row.id) ||
      typeof row.service !== "string" ||
      !["db", "worker"].includes(row.service) ||
      row.name !== `/${opts.instance.name}-${row.service}-1` ||
      row.workingDir !== join(opts.instance.root, ".hack") ||
      row.configFiles !== fixtureComposeFiles(opts.instance).join(",") ||
      JSON.stringify(row.mounts) !==
        JSON.stringify([
          {
            type: "volume",
            name: `${opts.instance.name}_data`,
            target: "/var/lib/postgresql/data",
            rw: row.service === "db",
          },
        ])
    ) {
      refused();
    }
    return { id: row.id, service: row.service };
  }
  if (
    typeof row.createdAt !== "string" ||
    !CREATED.test(row.createdAt) ||
    !Number.isFinite(Date.parse(row.createdAt))
  ) {
    refused();
  }
  if (opts.kind === "network") {
    if (
      typeof row.id !== "string" ||
      !ID.test(row.id) ||
      !networkPolicyMatches(opts.instance, row)
    ) {
      refused();
    }
    return { id: row.id, createdAt: row.createdAt };
  }
  if (row.name !== `${opts.instance.name}_data` || row.storage !== "data") {
    refused();
  }
  return { id: String(row.name), createdAt: row.createdAt };
}
function privateReport(result: CliResult) {
  if (
    result.combined.includes(SYNTHETIC_VALUE) ||
    result.combined.includes(MANAGED_FIXTURE_VALUE)
  ) {
    refused();
  }
}
function successful(result: CliResult) {
  privateReport(result);
  expect({
    that: !result.timedOut && result.exitCode === 0,
    message:
      "Expected successful isolated adoption fixture command; values omitted",
  });
  return result;
}
async function source(instance: Instance) {
  const files: { name: string; dev: number; ino: number; hash: string }[] = [];
  for (const name of ["hack.config.json", "docker-compose.yml"]) {
    const path = join(instance.root, ".hack", name),
      info = await lstat(path);
    files.push({
      name,
      dev: info.dev,
      ino: info.ino,
      hash: new Bun.CryptoHasher("sha256")
        .update(await readFile(path))
        .digest("hex"),
    });
  }
  return JSON.stringify(files);
}
function fixtureComposeFiles(instance: Instance): readonly string[] {
  return instance.sourceMode === "canonical-generated"
    ? managedAdoptionFixtureComposeFiles(instance.root)
    : [join(instance.root, ".hack/docker-compose.yml")];
}

async function writeLegacy(instance: Instance, image: string) {
  const stringSource = instance.argvMode
    ? stringAdoptionWorkerSources[instance.argvMode]
    : undefined;
  await mkdir(join(instance.root, ".hack"), { recursive: true });
  await Bun.write(
    join(instance.root, ".hack/hack.config.json"),
    JSON.stringify({
      name: instance.name,
      worktree: { auto_branch: false, inherit_local: true },
      ...(instance.sourceMode ? { env: { default_overlay: "qa" } } : {}),
    })
  );
  await Bun.write(
    join(instance.root, ".hack/docker-compose.yml"),
    JSON.stringify({
      name: instance.name,
      services: {
        db: {
          image,
          pull_policy: "never",
          environment: {
            POSTGRES_DB: "fixture",
            POSTGRES_HOST_AUTH_METHOD: "trust",
          },
          volumes: ["data:/var/lib/postgresql/data"],
          ...(instance.ownedNetwork
            ? { networks: { private: { aliases: ["db-reader"] } } }
            : {}),
          ...(instance.dependency === "service_healthy"
            ? { healthcheck: adoptionDependencyHealthcheck }
            : {}),
        },
        worker: {
          image,
          pull_policy: "never",
          // Shadow the image's declared VOLUME with the exact existing named storage.
          volumes: ["data:/var/lib/postgresql/data:ro"],
          entrypoint: instance.sourceMode
            ? ["/bin/sh", "-c"]
            : (stringSource?.entrypoint ?? LITERAL_SOURCE_ENTRYPOINT),
          command: instance.sourceMode
            ? [WORKER_SCRIPT]
            : (stringSource?.command ?? LITERAL_SOURCE_COMMAND),
          stop_grace_period: "15s",
          ...(instance.ownedNetwork
            ? { networks: { private: { aliases: ["worker-reader"] } } }
            : {}),
          ...(instance.dependency
            ? {
                depends_on:
                  instance.dependency === "service_started"
                    ? ["db"]
                    : {
                        db: {
                          condition: instance.dependency,
                          required: true,
                          restart: false,
                        },
                      },
              }
            : {}),
        },
      },
      volumes: { data: { name: `${instance.name}_data` } },
      ...(instance.ownedNetwork
        ? { networks: { private: { driver: "bridge", internal: true } } }
        : {}),
    })
  );
}
function formats(kind: Kind): string {
  if (kind === "container") {
    return `{"id":{{json .Id}},"name":{{json .Name}},"project":{{json (index .Config.Labels "${PROJECT_LABEL}")}},"nativeNames":[{{$first := true}}{{range $name,$value := .Config.Labels}}{{if not $first}},{{end}}{{$first = false}}{{json $name}}{{end}}],"service":{{json (index .Config.Labels "com.docker.compose.service")}},"workingDir":{{json (index .Config.Labels "com.docker.compose.project.working_dir")}},"configFiles":{{json (index .Config.Labels "com.docker.compose.project.config_files")}},"mounts":[{{range $i,$m := .Mounts}}{{if $i}},{{end}}{"type":{{json $m.Type}},"name":{{json $m.Name}},"target":{{json $m.Destination}},"rw":{{json $m.RW}}}{{end}}]}`;
  }
  if (kind === "network") {
    return `{"id":{{json .Id}},"name":{{json .Name}},"createdAt":{{json .Created}},"project":{{json (index .Labels "${PROJECT_LABEL}")}},"nativeNames":[{{$first := true}}{{range $name,$value := .Labels}}{{if not $first}},{{end}}{{$first = false}}{{json $name}}{{end}}],"logical":{{json (index .Labels "com.docker.compose.network")}},"driver":{{json .Driver}},"scope":{{json .Scope}},"internal":{{json .Internal}}}`;
  }
  return `{"name":{{json .Name}},"createdAt":{{json .CreatedAt}},"project":{{json (index .Labels "${PROJECT_LABEL}")}},"nativeNames":[{{$first := true}}{{range $name,$value := .Labels}}{{if not $first}},{{end}}{{$first = false}}{{json $name}}{{end}}],"storage":{{json (index .Labels "com.docker.compose.volume")}}}`;
}

function linkedFixtureFeatures(opts: {
  readonly ownedNetwork: boolean;
  readonly dependencies: boolean;
  readonly role: "first" | "second";
}): Partial<Pick<Instance, "ownedNetwork" | "dependency">> {
  if (opts.ownedNetwork && opts.dependencies) {
    refused();
  }
  return {
    ...(opts.ownedNetwork ? { ownedNetwork: true as const } : {}),
    ...(opts.dependencies
      ? {
          dependency:
            opts.role === "first"
              ? ("service_healthy" as const)
              : ("service_started" as const),
        }
      : {}),
  };
}

async function prepareFixtureInputs(
  ctx: ScenarioContext,
  options: {
    readonly generated?: boolean;
    readonly typedLocal?: boolean;
    readonly stringArgv?: boolean;
    readonly ownedNetwork?: boolean;
    readonly dependencies?: boolean;
  } = {}
) {
  const {
    generated = false,
    typedLocal = false,
    stringArgv = false,
    ownedNetwork = false,
    dependencies = false,
  } = options;
  const firstFeatures = linkedFixtureFeatures({
    ownedNetwork,
    dependencies,
    role: "first",
  });
  const secondFeatures = linkedFixtureFeatures({
    ownedNetwork,
    dependencies,
    role: "second",
  });
  expect({
    that: resolveCliSpawnArgs([]).length === 1,
    message:
      "Adoption acceptance requires the current compiled CLI and companion compiler",
  });
  if (process.platform !== "darwin" && process.platform !== "linux") {
    ctx.skip("requires supported native private-state host");
  }
  const probe = createAdoptionFixtureProbe();
  const engine = Bun.which("docker");
  if (!engine) {
    ctx.skip("Docker executable unavailable");
  }
  const engineId = await probe(["info", "--format", "{{json .ID}}"]);
  const fixture = await createMonorepoFixture({
    parentDir: ctx.tempRoot,
    withHackConfig: false,
  });
  const primary: Instance = {
    root: fixture.root,
    name: `${fixture.name}-main`,
    marker: "unused-primary",
    ...(generated ? { sourceMode: "canonical-generated" as const } : {}),
    ...(stringArgv ? { argvMode: "string-entrypoint" as const } : {}),
    ...(typedLocal ? { typedLocal: true as const } : {}),
    ...(ownedNetwork ? { ownedNetwork: true as const } : {}),
  };
  if ((await probe(["info", "--format", "{{.OSType}}"])) !== "linux") {
    refused();
  }
  await probe(["compose", "version"]);
  const image = (
    await probe([
      "image",
      "inspect",
      "postgres:17.6-alpine",
      "--format",
      "{{.Id}}",
    ])
  ).trim();
  if (!IMAGE.test(image)) {
    refused();
  }
  await writeLegacy(primary, image);
  await commitAll({
    root: primary.root,
    message: "fixture: canonical legacy source",
  });
  const first: Instance = {
    root: await addLinkedWorktree({ fixture, branch: "adoption-alpha" }),
    name: `${fixture.name}-alpha`,
    marker: "alpha-existing-sql-row",
    ...(generated ? { sourceMode: "canonical-generated" as const } : {}),
    ...(stringArgv ? { argvMode: "string-entrypoint" as const } : {}),
    ...(typedLocal ? { typedLocal: true as const } : {}),
    ...firstFeatures,
  };
  const second: Instance = {
    root: await addLinkedWorktree({ fixture, branch: "adoption-beta" }),
    name: `${fixture.name}-beta`,
    marker: "beta-existing-sql-row",
    ...(generated ? { sourceMode: "canonical-generated" as const } : {}),
    ...(stringArgv ? { argvMode: "string-cleared" as const } : {}),
    ...(typedLocal ? { typedLocal: true as const } : {}),
    ...secondFeatures,
  };
  for (const instance of [first, second]) {
    await writeLegacy(instance, image);
    await commitAll({
      root: instance.root,
      message: "fixture: distinct original identity",
    });
  }

  if (generated) {
    await prepareManagedAdoptionFixtureSources({
      hackHome: ctx.hackHome,
      tempRoot: ctx.tempRoot,
      primary,
      instances: [first, second],
    });
  }
  if (typedLocal) {
    await prepareTypedLocalAdoptionFixtureSources({
      primary,
      instances: [first, second],
    });
  }

  return {
    ctx,
    engine,
    engineId,
    fixtureRoot: fixture.root,
    primary,
    first,
    second,
    probe,
  };
}

function createFixtureRuntime(
  opts: Awaited<ReturnType<typeof prepareFixtureInputs>>
) {
  const { ctx, engine, engineId, fixtureRoot, primary, first, second, probe } =
    opts;
  const env = {
    HACK_RUNTIME_BACKEND: "compose",
    CI: "",
    HACK_EXECUTION_MODE: "",
  };
  const cli = async (
    instance: Instance,
    args: readonly string[],
    extra?: Readonly<Record<string, string>>
  ) => {
    const result = await ctx.cli({
      args,
      cwd: instance.root,
      env: { ...env, ...extra },
      timeoutMs: TIMEOUT,
    });
    privateReport(result);
    return result;
  };
  const owned = async (instance: Instance, kind: Kind, id: string) =>
    ownedAdoptionFixtureObservation({
      instance,
      kind,
      row: object(
        await probe([kind, "inspect", "--format", formats(kind), id])
      ),
    });
  const list = async (instance: Instance, kind: Kind) =>
    (
      await probe([
        kind,
        "ls",
        ...(kind === "container" ? ["--all"] : []),
        ...(kind === "volume" ? [] : ["--no-trunc"]),
        "--filter",
        `label=${PROJECT_LABEL}=${instance.name}`,
        "--format",
        kind === "volume" ? "{{.Name}}" : "{{.ID}}",
      ])
    )
      .split(/\s+/)
      .filter(Boolean);
  const resources = async (instance: Instance) => {
    const result = {
      container: [] as Observation[],
      network: [] as Observation[],
      volume: [] as Observation[],
    };
    for (const kind of ["container", "network", "volume"] as const) {
      for (const id of await list(instance, kind)) {
        result[kind].push(await owned(instance, kind, id));
      }
      result[kind].sort((a, b) => a.id.localeCompare(b.id));
    }
    return result;
  };
  const anchors = new Map<Instance, Snapshot>();
  const managedAnchors = new Map<Instance, string>();
  const localAnchors = new Map<Instance, string>();
  const effect = async (args: readonly string[]) => {
    await requirePreparedEngine({ engineId, probe });
    return successful(
      await runCommand({
        argv: [engine, ...args],
        cwd: fixtureRoot,
        timeoutMs: TIMEOUT,
      })
    );
  };
  const container = (instance: Instance, service: string) => {
    const row = anchors
      .get(instance)
      ?.resources.container.find((entry) => entry.service === service);
    if (!row) {
      refused();
    }
    return row.id;
  };
  const checkWorkerArgv = async (instance: Instance) => {
    if (instance.sourceMode) {
      return;
    }
    const id = container(instance, "worker");
    await owned(instance, "container", id);
    assertAdoptionWorkerArgv({
      id,
      mode: instance.argvMode,
      row: object(
        await probe([
          "container",
          "inspect",
          "--format",
          '{"id":{{json .Id}},"command":{{json .Config.Cmd}},"entrypoint":{{json .Config.Entrypoint}}}',
          id,
        ])
      ),
    });
    await owned(instance, "container", id);
  };
  const checkHealthcheck = async (instance: Instance) => {
    if (instance.dependency !== "service_healthy") {
      return;
    }
    const id = container(instance, "db");
    await owned(instance, "container", id);
    assertAdoptionDependencyHealthcheck(
      object(
        await probe([
          "container",
          "inspect",
          "--format",
          '{"test":{{json .Config.Healthcheck.Test}},"interval":{{json .Config.Healthcheck.Interval}},"timeout":{{json .Config.Healthcheck.Timeout}},"retries":{{json .Config.Healthcheck.Retries}}}',
          id,
        ])
      )
    );
    await owned(instance, "container", id);
  };
  const sql = async (instance: Instance, query: string) =>
    (
      await probe([
        "container",
        "exec",
        container(instance, "db"),
        "psql",
        "-U",
        "postgres",
        "-d",
        "fixture",
        "-At",
        "-c",
        query,
      ])
    ).trim();
  const waitReady = async (instance: Instance) => {
    await waitForAdoptionFixtureSql({
      read: () => sql(instance, "SELECT 1"),
      expected: "1",
    });
  };
  const assertTopology = async (instance: Instance, running: boolean) => {
    if (!instance.ownedNetwork) {
      return;
    }
    const baseline = anchors.get(instance);
    const network = baseline?.resources.network[0];
    if (
      !network ||
      baseline.resources.network.length !== 1 ||
      baseline.resources.container.length !== 2
    ) {
      refused();
    }
    const expectedMembers = running
      ? baseline.resources.container.map((entry) => entry.id).sort()
      : [];
    await inspectAdoptionBridge({
      instance,
      id: network.id,
      members: expectedMembers,
      probe,
    });
    for (const entry of baseline.resources.container) {
      const container = object(
        await probe([
          "container",
          "inspect",
          "--format",
          `{"id":{{json .Id}},"running":{{json .State.Running}},"networks":[{{$first := true}}{{range $name,$n := .NetworkSettings.Networks}}{{if not $first}},{{end}}{{$first = false}}{"name":{{json $name}},"id":{{json $n.NetworkID}},"aliases":{{json $n.Aliases}}}{{end}}]}`,
          entry.id,
        ])
      );
      assertAdoptionEndpointObservation({
        instance,
        networkId: network.id,
        container: entry,
        running,
        row: container,
      });
    }
  };
  const check = async (instance: Instance, checkSource = true) => {
    const baseline = anchors.get(instance);
    if (
      !baseline ||
      JSON.stringify(await resources(instance)) !==
        JSON.stringify(baseline.resources) ||
      (checkSource && (await source(instance)) !== baseline.source) ||
      (await sql(instance, "SELECT value FROM marker WHERE id=1")) !==
        instance.marker
    ) {
      refused();
    }
    await assertTopology(instance, true);
    await checkWorkerArgv(instance);
    await checkHealthcheck(instance);
    if (instance.sourceMode === "canonical-generated") {
      if (
        (await managedAdoptionFixtureSourceSnapshot({ primary, instance })) !==
        managedAnchors.get(instance)
      ) {
        refused();
      }
      for (const service of ["db", "worker"] as const) {
        if (
          (await probe([
            "container",
            "exec",
            container(instance, service),
            "/bin/sh",
            "-c",
            managedAdoptionFixtureEnvAssertion(instance, service),
          ])) !== ""
        ) {
          refused();
        }
      }
    }
    if (
      instance.typedLocal &&
      (await typedLocalAdoptionFixtureSourceSnapshot({ primary, instance })) !==
        localAnchors.get(instance)
    ) {
      refused();
    }
    await assertTopology(instance, true);
  };
  const assertNoState = async (instance: Instance) => {
    expect({
      that: !(await Bun.file(
        join(
          instance.root,
          ".hack/.internal/legacy-compose-adoption-v1/receipt.json"
        )
      ).exists()),
      message: "Read-only refusal must not create an adoption receipt",
    });
  };
  const assertStopped = async (instance: Instance) => {
    const baseline = anchors.get(instance);
    if (
      !baseline ||
      JSON.stringify(await resources(instance)) !==
        JSON.stringify(baseline.resources)
    ) {
      refused();
    }
    await assertTopology(instance, false);
    await checkWorkerArgv(instance);
    await checkHealthcheck(instance);
    for (const row of baseline.resources.container) {
      if (
        (await probe([
          "container",
          "inspect",
          "--format",
          "{{.State.Running}}",
          row.id,
        ])) !== "false"
      ) {
        refused();
      }
    }
  };
  return {
    ctx,
    engine,
    engineId,
    fixtureRoot,
    primary,
    first,
    second,
    env,
    probe,
    cli,
    owned,
    list,
    resources,
    anchors,
    managedAnchors,
    localAnchors,
    effect,
    container,
    sql,
    waitReady,
    check,
    assertNoState,
    assertStopped,
  };
}
type FixtureRuntime = ReturnType<typeof createFixtureRuntime>;

function refusedPreview(result: CliResult) {
  privateReport(result);
  expect({
    that: !result.timedOut && result.exitCode === 1,
    message:
      "Unsupported inherited input must refuse before state or engine effects",
  });
  return result;
}

async function bootstrapOriginal(h: FixtureRuntime, instance: Instance) {
  const {
    engine,
    fixtureRoot,
    probe,
    list,
    resources,
    anchors,
    sql,
    waitReady,
    check,
    managedAnchors,
    localAnchors,
    primary,
  } = h;

  for (const kind of ["container", "network", "volume"] as const) {
    if ((await list(instance, kind)).length) {
      refused();
    }
  }
  for (const [kind, name] of [
    ["volume", `${instance.name}_data`],
    ["network", fixtureNetworkName(instance)],
    ["container", `${instance.name}-db-1`],
    ["container", `${instance.name}-worker-1`],
  ] as const) {
    if (
      (
        await probe([
          kind,
          "ls",
          ...(kind === "container" ? ["--all"] : []),
          ...(kind === "volume" ? [] : ["--no-trunc"]),
          "--filter",
          `name=${name}`,
          "--format",
          kind === "volume" ? "{{.Name}}" : "{{.ID}}",
        ])
      ).trim()
    ) {
      refused();
    }
  }
  const originalSource = await source(instance);
  if (instance.sourceMode === "canonical-generated") {
    managedAnchors.set(
      instance,
      await managedAdoptionFixtureSourceSnapshot({ primary, instance })
    );
  }
  if (instance.typedLocal) {
    localAnchors.set(
      instance,
      await typedLocalAdoptionFixtureSourceSnapshot({ primary, instance })
    );
  }
  await requirePreparedEngine(h);
  const started = await runCommand({
    argv: [
      engine,
      "compose",
      "--project-name",
      instance.name,
      "--project-directory",
      join(instance.root, ".hack"),
      "--env-file",
      "/dev/null",
      ...fixtureComposeFiles(instance).flatMap((file) => ["--file", file]),
      "up",
      "--detach",
      "--pull",
      "never",
    ],
    cwd: fixtureRoot,
    timeoutMs: TIMEOUT,
  });
  const captured = await resources(instance);
  anchors.set(instance, {
    resources: captured,
    source: originalSource,
  });
  successful(started);
  if (
    captured.container.length !== 2 ||
    captured.volume.length !== 1 ||
    captured.network.length !== 1
  ) {
    refused();
  }
  await waitReady(instance);
  await waitForAdoptionFixtureSql({
    read: async () => {
      await sql(
        instance,
        `CREATE TABLE IF NOT EXISTS marker(id integer PRIMARY KEY,value text NOT NULL); INSERT INTO marker VALUES(1,'${instance.marker}') ON CONFLICT (id) DO UPDATE SET value=EXCLUDED.value`
      );
      return await sql(instance, "SELECT value FROM marker WHERE id=1");
    },
    expected: instance.marker,
  });
  await check(instance);
}
async function checkInheritedRefusal(h: FixtureRuntime) {
  const { ctx, primary, first, second, env, cli, check, assertNoState } = h;
  await setProjectEnvValue({
    projectRoot: primary.root,
    projectDir: join(primary.root, ".hack"),
    envName: null,
    scope: "global",
    key: SYNTHETIC_KEY,
    value: SYNTHETIC_VALUE,
    secret: false,
    local: true,
  });
  for (const instance of [first, second]) {
    const inherited = await ctx.cli({
      args: ["env", "get", SYNTHETIC_KEY],
      cwd: instance.root,
      env,
      timeoutMs: TIMEOUT,
    });
    if (
      inherited.exitCode !== 0 ||
      inherited.timedOut ||
      inherited.stdout.trim() !== SYNTHETIC_VALUE
    ) {
      refused();
    }
    const denied = refusedPreview(
      await cli(instance, ["config", "adopt", "--dry-run", "--stop", "--json"])
    );
    if (object(denied.stdout).complete !== false) {
      refused();
    }
    await assertNoState(instance);
    await check(instance);
  }
}
async function withholdPrimaryLocal(h: FixtureRuntime) {
  const { ctx, primary, first, second, cli, assertNoState } = h;
  const localPath = join(primary.root, ".hack/hack.env.local.yaml");
  const localOriginal = await readFile(localPath);
  await rename(localPath, join(ctx.tempRoot, "primary-local-withheld.yaml"));
  for (const instance of [first, second]) {
    const preview = successful(
      await cli(instance, ["config", "adopt", "--dry-run", "--stop", "--json"])
    );
    if (object(preview.stdout).complete !== true) {
      refused();
    }
    await assertNoState(instance);
  }

  return { localPath, localOriginal };
}
async function interruptFirstStop(h: FixtureRuntime) {
  const { ctx, engine, first, container, cli } = h;
  const shimRoot = join(ctx.tempRoot, "partial-stop-shim");
  await mkdir(shimRoot, { mode: 0o700 });
  const receipt = join(
    first.root,
    ".hack/.internal/legacy-compose-adoption-v1/receipt.json"
  );
  const db = container(first, "db"),
    worker = container(first, "worker");
  const control = join(shimRoot, "control-hit");
  const generatedVersion = first.typedLocal ? 4 : 3;
  const receiptVersion = first.ownedNetwork
    ? 6
    : first.dependency
      ? 5
      : first.sourceMode
        ? generatedVersion
        : 2;
  const shim = join(shimRoot, "docker");
  await Bun.write(
    shim,
    `#!${process.execPath}
const args = process.argv.slice(2);
const engine = ${JSON.stringify(engine)};
if(args[0]==="container" && args[1]==="stop") {
 if(${first.dependency ? `args.length!==3 || args[2]!==${JSON.stringify(worker)}` : `args.length!==4 || !args.includes(${JSON.stringify(db)}) || !args.includes(${JSON.stringify(worker)})`}) process.exit(99);
 const state=JSON.parse(await Bun.file(${JSON.stringify(receipt)}).text());
 if(state.adoption_receipt_version!==${receiptVersion} || state.pendingOperation?.operation!=="stop") process.exit(98);
 ${first.dependency ? dependencyEngineCheck(h) : ""}
 const child=Bun.spawn([engine,"container","stop",${JSON.stringify(first.dependency ? worker : db)}],{stdin:"ignore",stdout:"ignore",stderr:"ignore"});
 if(await child.exited!==0) process.exit(97);
 await Bun.write(${JSON.stringify(control)},"journal-before-partial-stop");process.exit(71);
}
${first.dependency ? dependencyReadGuard(h, first, receipt) : ""}
const child=Bun.spawn([engine,...args],{stdin:"inherit",stdout:"inherit",stderr:"inherit"});process.exit(await child.exited);
`
  );
  await chmod(shim, 0o700);
  const partial = await cli(first, ["config", "adopt", "--stop", "--json"], {
    PATH: `${shimRoot}:${process.env.PATH ?? "/usr/bin:/bin"}`,
  });
  if (
    partial.timedOut ||
    partial.exitCode === 0 ||
    (await Bun.file(control).text()) !== "journal-before-partial-stop"
  ) {
    refused();
  }
  const pending = object(await Bun.file(receipt).text());
  if (!isRecord(pending.pendingOperation)) {
    refused();
  }
  const blocked = await cli(first, ["ps", "--json"]);
  if (blocked.exitCode === 0) {
    refused();
  }
}

function dependencyEngineCheck(h: FixtureRuntime): string {
  return `const engineCheck=Bun.spawn([engine,'info','--format','{{json .ID}}'],{stdin:'ignore',stdout:'pipe',stderr:'ignore'});
 const engineId=(await new Response(engineCheck.stdout).text()).trim();if(await engineCheck.exited!==0 || engineId!==${JSON.stringify(h.engineId)})process.exit(95);`;
}

/** Only fixed metadata reads and canonical config hashes reach the real engine through new dependency shims. */
function dependencyReadGuard(
  h: FixtureRuntime,
  instance: Instance,
  receipt: string
): string {
  const anchor = h.anchors.get(instance);
  const network = anchor?.resources.network[0];
  const volume = anchor?.resources.volume[0];
  if (
    !anchor ||
    anchor.resources.network.length !== 1 ||
    anchor.resources.volume.length !== 1 ||
    !network ||
    !volume
  ) {
    refused();
  }
  const helper = fileURLToPath(
    new URL("./native-compose-adoption-dependency-inputs.ts", import.meta.url)
  );
  return `import {adoptionDependencyReadAllowed} from ${JSON.stringify(helper)};
try {
 const savedFile=Bun.file(${JSON.stringify(receipt)});
 const saved=await savedFile.exists() ? JSON.parse(await savedFile.text()) : null;
 const generationId=saved?.prepared?.id ?? saved?.publication?.generation?.id;
 if(!adoptionDependencyReadAllowed({args,projectRoot:${JSON.stringify(instance.root)},project:${JSON.stringify(instance.name)},containerIds:${JSON.stringify(anchor.resources.container.map((row) => row.id))},networkId:${JSON.stringify(network.id)},volumeName:${JSON.stringify(volume.id)},generationId}))process.exit(93);
}catch{process.exit(93);}`;
}
async function recoverFirstAndRollback(h: FixtureRuntime) {
  const { first, second, cli, container, waitReady, check, anchors, effect } =
    h;
  const db = container(first, "db"),
    worker = container(first, "worker");
  await check(second);
  successful(
    await cli(first, ["config", "adopt", "--recover", "--stop", "--json"])
  );
  successful(await cli(first, ["up", "--detach", "--json"]));
  await waitReady(first);
  await check(first, false);
  await check(second);
  const exec = successful(
    await cli(first, [
      "exec",
      "db",
      "--",
      "psql",
      "-U",
      "postgres",
      "-d",
      "fixture",
      "-At",
      "-c",
      "SELECT value FROM marker WHERE id=1",
    ])
  );
  if (exec.stdout.trim() !== first.marker) {
    refused();
  }
  const unsupported = await cli(first, ["run", "db", "--", "true"]);
  if (unsupported.exitCode === 0) {
    refused();
  }
  await check(first, false);
  await check(second);
  successful(await cli(first, ["down", "--json"]));
  await h.assertStopped(first);
  await check(second);
  successful(await cli(first, ["config", "adopt", "--rollback", "--json"]));
  if ((await source(first)) !== anchors.get(first)?.source) {
    refused();
  }
  await effect(["container", "start", db, worker]);
  await waitReady(first);
  await check(first);
  await check(second);
}
async function adoptSecondAndRollback(h: FixtureRuntime) {
  const { second, first, cli, waitReady, check, effect, container } = h;
  successful(await cli(second, ["config", "adopt", "--stop", "--json"]));
  successful(await cli(second, ["up", "--detach", "--json"]));
  await waitReady(second);
  await check(second, false);
  await check(first);
  successful(await cli(second, ["down", "--json"]));
  await h.assertStopped(second);
  successful(await cli(second, ["config", "adopt", "--rollback", "--json"]));
  await effect([
    "container",
    "start",
    container(second, "db"),
    container(second, "worker"),
  ]);
  await waitReady(second);
  await check(second);
  await check(first);
}

/** Fixture forwarder observes the actual ordered starts, with no substitution of resources or engine replies. */
async function dependencyFixtureUp(
  h: FixtureRuntime,
  instance: Instance,
  partial: boolean
) {
  if (!instance.dependency) {
    refused();
  }
  const shimRoot = join(
    h.ctx.tempRoot,
    `dependency-start-${instance.name}-${partial ? "partial" : "complete"}`
  );
  await mkdir(shimRoot, { mode: 0o700 });
  const receipt = join(
    instance.root,
    ".hack/.internal/legacy-compose-adoption-v1/receipt.json"
  );
  const db = h.container(instance, "db"),
    worker = h.container(instance, "worker");
  const starts = join(shimRoot, "starts.json");
  const helper = fileURLToPath(
    new URL("./native-compose-adoption-dependency-inputs.ts", import.meta.url)
  );
  const shim = join(shimRoot, "docker");
  await Bun.write(
    shim,
    `#!${process.execPath}
import {assertAdoptionDependencyStart} from ${JSON.stringify(helper)};
const args=process.argv.slice(2), engine=${JSON.stringify(h.engine)};
if(args[0]==='container' && args[1]==='start') {
 if(args.length!==3)process.exit(99);
 const receipt=JSON.parse(await Bun.file(${JSON.stringify(receipt)}).text());
 if(receipt.adoption_receipt_version!==5 || receipt.pendingOperation?.operation!=='start')process.exit(98);
 const startsFile=Bun.file(${JSON.stringify(starts)}), prior=await startsFile.exists() ? JSON.parse(await startsFile.text()) : [];
 let observed;
 if(args[2]===${JSON.stringify(worker)}) {
  const capture=Bun.spawn([engine,'container','inspect','--format','{"id":{{json .Id}},"running":{{json .State.Running}},"paused":{{json .State.Paused}},"status":{{json .State.Status}},"health":{{with (index .State "Health")}}{{json .Status}}{{else}}""{{end}}}',${JSON.stringify(db)}],{stdin:'ignore',stdout:'pipe',stderr:'ignore'});
  const text=await new Response(capture.stdout).text();if(await capture.exited!==0)process.exit(97);observed=JSON.parse(text);
 }
 try {assertAdoptionDependencyStart({db:${JSON.stringify(db)},worker:${JSON.stringify(worker)},condition:${JSON.stringify(instance.dependency)},prior,requested:args[2],observed});}catch{process.exit(96);}
 ${dependencyEngineCheck(h)}
 const effect=Bun.spawn([engine,...args],{stdin:'ignore',stdout:'ignore',stderr:'ignore'});if(await effect.exited!==0)process.exit(94);
 await Bun.write(startsFile,JSON.stringify([...prior,args[2]]));
 if(${partial} && args[2]===${JSON.stringify(db)})process.exit(71);
 process.exit(0);
}
${dependencyReadGuard(h, instance, receipt)}
const child=Bun.spawn([engine,...args],{stdin:'inherit',stdout:'inherit',stderr:'inherit'});process.exit(await child.exited);
`
  );
  await chmod(shim, 0o700);
  const result = await h.cli(instance, ["up", "--detach", "--json"], {
    PATH: `${shimRoot}:${process.env.PATH ?? "/usr/bin:/bin"}`,
  });
  const expected = partial ? [db] : [db, worker];
  if (
    result.timedOut ||
    JSON.stringify(JSON.parse(await Bun.file(starts).text())) !==
      JSON.stringify(expected)
  ) {
    refused();
  }
  if (partial) {
    if (
      result.exitCode === 0 ||
      object(await Bun.file(receipt).text()).pendingOperation === null
    ) {
      refused();
    }
  } else {
    successful(result);
  }
}

/** Active candidate repair pins identity and bytes; prepared authored source timestamps are never rewritten. */
async function dependencyCandidateDriftRefusal(h: FixtureRuntime) {
  const path = join(h.first.root, ".hack/hack.project.json");
  const original = await readFile(path);
  const states = async () =>
    Promise.all(
      ["db", "worker"].map((service) =>
        h.probe([
          "container",
          "inspect",
          "--format",
          "{{.State.Running}}",
          h.container(h.first, service),
        ])
      )
    );
  const prior = await states();
  await h.check(h.second);
  await writeFile(path, Buffer.concat([original, Buffer.from("\n")]));
  try {
    refusedPreview(await h.cli(h.first, ["down", "--recover", "--json"]));
    if (JSON.stringify(await states()) !== JSON.stringify(prior)) {
      refused();
    }
    await h.check(h.second);
  } finally {
    await writeFile(path, original);
  }
}

async function rollbackDependencyInstance(
  h: FixtureRuntime,
  instance: Instance
) {
  successful(await h.cli(instance, ["down", "--json"]));
  await h.assertStopped(instance);
  successful(
    await h.cli(instance, ["config", "adopt", "--rollback", "--json"])
  );
  if ((await source(instance)) !== h.anchors.get(instance)?.source) {
    refused();
  }
  await h.effect([
    "container",
    "start",
    h.container(instance, "db"),
    h.container(instance, "worker"),
  ]);
  await h.waitReady(instance);
  await h.check(instance);
}

/** Explicit selector keeps the new v5 dependency acceptance independent of all previously qualified worktree cases. */
export const nativeComposeAdoptionDependencyWorktreesScenario: Scenario = {
  name: "native-compose-adoption-dependency-worktrees",
  tier: "docker",
  preserveFixtureOnFailure: true,
  summary:
    "started and exec-healthy edges preserve two linked original SQL volumes through ordered repair and rollback",
  run: async (ctx) => {
    const h = createFixtureRuntime(
      await prepareFixtureInputs(ctx, { dependencies: true })
    );
    await runWithFixtureCleanup({
      run: async () => {
        for (const instance of [h.first, h.second]) {
          await bootstrapOriginal(h, instance);
          const preview = successful(
            await h.cli(instance, [
              "config",
              "adopt",
              "--dry-run",
              "--stop",
              "--json",
            ])
          );
          if (object(preview.stdout).complete !== true) {
            refused();
          }
          await h.assertNoState(instance);
          await h.check(instance);
        }
        await interruptFirstStop(h);
        successful(
          await h.cli(h.first, [
            "config",
            "adopt",
            "--recover",
            "--stop",
            "--json",
          ])
        );
        await h.assertStopped(h.first);
        refusedPreview(
          await h.cli(h.first, ["up", "db", "--detach", "--json"])
        );
        await h.assertStopped(h.first);
        await h.check(h.second);
        await dependencyFixtureUp(h, h.first, true);
        await h.waitReady(h.first);
        if (
          (await h.sql(h.first, "SELECT value FROM marker WHERE id=1")) !==
          h.first.marker
        ) {
          refused();
        }
        await dependencyCandidateDriftRefusal(h);
        successful(await h.cli(h.first, ["down", "--recover", "--json"]));
        await h.assertStopped(h.first);
        await h.check(h.second);
        await dependencyFixtureUp(h, h.first, false);
        await h.check(h.first, false);
        await h.check(h.second);
        refusedPreview(await h.cli(h.first, ["run", "db", "--", "true"]));
        await rollbackDependencyInstance(h, h.first);
        await h.check(h.second);
        successful(
          await h.cli(h.second, ["config", "adopt", "--stop", "--json"])
        );
        await h.assertStopped(h.second);
        await h.check(h.first);
        await dependencyFixtureUp(h, h.second, false);
        await h.check(h.second, false);
        await h.check(h.first);
        await rollbackDependencyInstance(h, h.second);
        await h.check(h.first);
        ctx.log(
          "started/exec-healthy ordered originals, SQL/birth/IDs, unchanged-source stop recovery, active-candidate repair and isolated rollback verified"
        );
      },
      cleanup: () =>
        cleanupOwnedAdoptionFixture({ ...h, instances: [h.first, h.second] }),
      secondaryFailure: () =>
        ctx.log(
          "secondary exact-owned cleanup failed; retain fixture evidence"
        ),
    });
  },
};

/** An external raw-byte edit must prevent recovery before another stop while both original data bindings remain intact. */
async function refuseChangedInheritedRepair(h: FixtureRuntime) {
  const path = join(
    h.primary.root,
    h.first.typedLocal
      ? ".hack/hack.local.json"
      : ".hack/hack.env.qa.local.yaml"
  );
  const original = await readFile(path);
  const other = JSON.stringify({
    resources: await h.resources(h.second),
    source: await source(h.second),
    row: await h.sql(h.second, "SELECT value FROM marker WHERE id=1"),
  });
  const first = h.anchors.get(h.first);
  if (!first) {
    refused();
  }
  const states = async () =>
    await Promise.all(
      first.resources.container.map(
        async (entry) =>
          await h.probe([
            "container",
            "inspect",
            "--format",
            "{{.State.Running}}",
            entry.id,
          ])
      )
    );
  const before = await states();
  await writeFile(path, Buffer.concat([original, Buffer.from("\n")]));
  try {
    refusedPreview(
      await h.cli(h.first, ["config", "adopt", "--recover", "--stop", "--json"])
    );
    if (
      JSON.stringify(await states()) !== JSON.stringify(before) ||
      JSON.stringify({
        resources: await h.resources(h.second),
        source: await source(h.second),
        row: await h.sql(h.second, "SELECT value FROM marker WHERE id=1"),
      }) !== other
    ) {
      refused();
    }
  } finally {
    await writeFile(path, original);
  }
  await h.check(h.second);
}

type CleanupInputs = Pick<
  FixtureRuntime,
  "engineId" | "anchors" | "resources" | "owned" | "effect" | "list" | "probe"
> & { readonly instances: readonly Instance[] };

async function requirePreparedEngine(
  h: Pick<CleanupInputs, "engineId" | "probe">
) {
  if ((await h.probe(["info", "--format", "{{json .ID}}"])) !== h.engineId) {
    refused();
  }
}

async function cleanupInstance(h: CleanupInputs, instance: Instance) {
  const baseline = h.anchors.get(instance);
  if (!baseline) {
    return;
  }
  if (
    JSON.stringify(await h.resources(instance)) !==
    JSON.stringify(baseline.resources)
  ) {
    refused();
  }
  for (const row of baseline.resources.container) {
    await h.owned(instance, "container", row.id);
    await requirePreparedEngine(h);
    await h.effect(["container", "rm", "--force", row.id]);
  }
  await cleanupNetworks(h, instance, baseline);
  await cleanupVolumes(h, instance, baseline);
  for (const kind of ["container", "network", "volume"] as const) {
    if ((await h.list(instance, kind)).length) {
      refused();
    }
  }
}
async function cleanupNetworks(
  h: CleanupInputs,
  instance: Instance,
  baseline: Snapshot
) {
  for (const row of baseline.resources.network) {
    const current = await h.owned(instance, "network", row.id);
    if (
      JSON.stringify(current) !== JSON.stringify(row) ||
      (await h.probe([
        "network",
        "inspect",
        "--format",
        "{{len .Containers}}",
        row.id,
      ])) !== "0"
    ) {
      refused();
    }
    await requirePreparedEngine(h);
    await h.effect(["network", "rm", row.id]);
  }
}
async function cleanupVolumes(
  h: CleanupInputs,
  instance: Instance,
  baseline: Snapshot
) {
  for (const row of baseline.resources.volume) {
    const current = await h.owned(instance, "volume", row.id);
    if (
      JSON.stringify(current) !== JSON.stringify(row) ||
      (
        await h.probe([
          "container",
          "ls",
          "--all",
          "--filter",
          `volume=${row.id}`,
          "--format",
          "{{.ID}}",
        ])
      ).trim()
    ) {
      refused();
    }
    await requirePreparedEngine(h);
    await h.effect(["volume", "rm", row.id]);
  }
}
/** Recheck the prepared daemon at cleanup admission and immediately before each exact removal. */
export async function cleanupOwnedAdoptionFixture(h: CleanupInputs) {
  await requirePreparedEngine(h);
  for (const instance of h.instances) {
    await cleanupInstance(h, instance);
  }
}
async function runWithFixtureCleanup(opts: {
  readonly run: () => Promise<void>;
  readonly cleanup: () => Promise<void>;
  readonly secondaryFailure: () => void;
}) {
  let failed = false;
  let failure: unknown;
  try {
    await opts.run();
  } catch (error: unknown) {
    failed = true;
    failure = error;
  }
  try {
    await opts.cleanup();
  } catch (error: unknown) {
    if (!failed) {
      throw error;
    }
    opts.secondaryFailure();
  }
  if (failed) {
    throw failure;
  }
}

async function runLiteralWorktrees(
  ctx: ScenarioContext,
  stringArgv: boolean,
  ownedNetwork = false
) {
  const h = createFixtureRuntime(
    await prepareFixtureInputs(ctx, { stringArgv, ownedNetwork })
  );
  await runWithFixtureCleanup({
    run: async () => {
      for (const instance of [h.first, h.second]) {
        await bootstrapOriginal(h, instance);
      }
      await checkInheritedRefusal(h);
      const local = await withholdPrimaryLocal(h);
      await interruptFirstStop(h);
      await recoverFirstAndRollback(h);
      await adoptSecondAndRollback(h);
      await rename(
        join(ctx.tempRoot, "primary-local-withheld.yaml"),
        local.localPath
      );
      if (!(await readFile(local.localPath)).equals(local.localOriginal)) {
        refused();
      }
      ctx.log(
        "two linked original SQL volumes, retained IDs, partial-stop recovery and isolated rollback verified"
      );
    },
    cleanup: () =>
      cleanupOwnedAdoptionFixture({ ...h, instances: [h.first, h.second] }),
    secondaryFailure: () =>
      ctx.log("secondary exact-owned cleanup failed; retain fixture evidence"),
  });
}

/** Two real linked checkouts keep independent original SQL data, sources and retained resource identities. No ingress or global effects. */
export const nativeComposeAdoptionWorktreesScenario: Scenario = {
  name: "native-compose-adoption-worktrees",
  tier: "docker",
  preserveFixtureOnFailure: true,
  summary:
    "two linked original SQL volumes survive isolated adoption, repair and rollback",
  run: (ctx) => runLiteralWorktrees(ctx, false),
};

/** String-form exec words and explicit empty entrypoint keep actual argv and SQL through both linked adoptions. */
export const nativeComposeAdoptionStringWorktreesScenario: Scenario = {
  name: "native-compose-adoption-string-worktrees",
  tier: "docker",
  preserveFixtureOnFailure: true,
  summary:
    "Compose string argv and explicit cleared entrypoint keep linked SQL and exact original identities",
  run: (ctx) => runLiteralWorktrees(ctx, true),
};

/** Original project bridge IDs, internal policy, aliases and SQL survive two linked adoptions and rollback. */
export const nativeComposeAdoptionNetworkWorktreesScenario: Scenario = {
  name: "native-compose-adoption-network-worktrees",
  tier: "docker",
  preserveFixtureOnFailure: true,
  summary:
    "one authored internal bridge and aliases retain original IDs and linked SQL through adoption and rollback",
  run: (ctx) => runLiteralWorktrees(ctx, false, true),
};

/** Canonical writer-produced sources and six managed layers retain both linked checkouts' original SQL and identities through v3 repair/rollback. */
export const nativeComposeAdoptionManagedWorktreesScenario: Scenario = {
  name: "native-compose-adoption-managed-worktrees",
  tier: "docker",
  preserveFixtureOnFailure: true,
  summary:
    "two linked original SQL volumes survive canonical managed inheritance adoption and rollback",
  run: async (ctx) => {
    const h = createFixtureRuntime(
      await prepareFixtureInputs(ctx, { generated: true })
    );
    await runWithFixtureCleanup({
      run: async () => {
        for (const instance of [h.first, h.second]) {
          await bootstrapOriginal(h, instance);
          const preview = successful(
            await h.cli(instance, [
              "config",
              "adopt",
              "--dry-run",
              "--stop",
              "--json",
            ])
          );
          if (object(preview.stdout).complete !== true) {
            refused();
          }
          await h.assertNoState(instance);
          await h.check(instance);
        }
        await interruptFirstStop(h);
        await refuseChangedInheritedRepair(h);
        await recoverFirstAndRollback(h);
        await adoptSecondAndRollback(h);
        ctx.log(
          "canonical managed inputs, original SQL/IDs, inherited drift refusal, partial-stop repair and separate rollback verified"
        );
      },
      cleanup: () =>
        cleanupOwnedAdoptionFixture({ ...h, instances: [h.first, h.second] }),
      secondaryFailure: () =>
        ctx.log(
          "secondary exact-owned cleanup failed; retain fixture evidence"
        ),
    });
  },
};

/** Same canonical writers and exact cleanup owner, with proof-bearing unchanged typed-local selection through v4 repair and independent rollback. */
export const nativeComposeAdoptionLocalWorktreesScenario: Scenario = {
  name: "native-compose-adoption-local-worktrees",
  tier: "docker",
  preserveFixtureOnFailure: true,
  summary:
    "two linked original SQL volumes survive unchanged typed-local adoption and rollback",
  run: async (ctx) => {
    const h = createFixtureRuntime(
      await prepareFixtureInputs(ctx, {
        generated: true,
        typedLocal: true,
      })
    );
    await runWithFixtureCleanup({
      run: async () => {
        for (const instance of [h.first, h.second]) {
          await bootstrapOriginal(h, instance);
          const preview = successful(
            await h.cli(instance, [
              "config",
              "adopt",
              "--dry-run",
              "--stop",
              "--json",
            ])
          );
          const report = object(preview.stdout);
          const fields = report.fields;
          if (
            report.complete !== true ||
            !Array.isArray(fields) ||
            !["primary_local", "checkout_local"].every((role) =>
              fields.some(
                (field: unknown) =>
                  isRecord(field) &&
                  field.document === role &&
                  field.pointer === "/environment/default_overlay" &&
                  field.status === "exact"
              )
            )
          ) {
            refused();
          }
          await h.assertNoState(instance);
          await h.check(instance);
        }
        await interruptFirstStop(h);
        await refuseChangedInheritedRepair(h);
        await recoverFirstAndRollback(h);
        await adoptSecondAndRollback(h);
        for (const instance of [h.first, h.second]) {
          const receipt = object(
            await readFile(
              join(
                instance.root,
                ".hack/.internal/legacy-compose-adoption-v1/receipt.json"
              ),
              "utf8"
            )
          );
          if (receipt.adoption_receipt_version !== 4) {
            refused();
          }
          await h.check(instance);
        }
        ctx.log(
          "unchanged typed-local selection, canonical inputs, original SQL/IDs, local raw drift refusal, partial-stop repair and separate rollback verified"
        );
      },
      cleanup: () =>
        cleanupOwnedAdoptionFixture({ ...h, instances: [h.first, h.second] }),
      secondaryFailure: () =>
        ctx.log(
          "secondary exact-owned cleanup failed; retain fixture evidence"
        ),
    });
  },
};
