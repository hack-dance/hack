import {
  chmod,
  lstat,
  mkdir,
  open,
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
  createRetainedBuildFixtureEvidence,
  qualifyRetainedBuildFixtureBuilder,
  qualifyRetainedBuildFixtureCopy,
  RETAINED_BUILD_BOOTSTRAP_ENV,
} from "./native-compose-adoption-build-evidence.ts";
import { observeRetainedBuildFixtureCli } from "./native-compose-adoption-build-diagnostics.ts";
import {
  assertRetainedFixtureImageUnchanged,
  prepareRetainedBuildFixtureSources,
  RETAINED_BUILD_BASE_TAG,
  RETAINED_BUILD_COPY_ORACLE,
  RETAINED_BUILD_IMAGE_FORMAT,
  RETAINED_BUILD_IMAGE_OWNER,
  RETAINED_BUILD_OBJECT_FORMAT,
  type RetainedBuildFixtureMode,
  type RetainedFixtureBuildObject,
  type RetainedFixtureImage,
  retainedBuildFixtureComposeVersion,
  retainedBuildFixtureDefinition,
  retainedBuildFixtureImage,
  retainedBuildFixtureMarker,
  retainedBuildFixtureObject,
  retainedBuildFixtureObjectGraph,
  retainedBuildFixtureSourceSnapshot,
} from "./native-compose-adoption-build-inputs.ts";
import {
  adoptionDependencyHealthcheck,
  assertAdoptionDependencyControl,
  assertAdoptionDependencyHealthcheck,
} from "./native-compose-adoption-dependency-inputs.ts";
import {
  type AdoptionDependencyFirstPrepare,
  captureAdoptionDependencyFirstPrepare,
} from "./native-compose-adoption-dependency-staged-read.ts";
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
  readonly ownedNetworks?: true;
  readonly dependency?: "service_started" | "service_healthy";
  readonly basicBuild?: RetainedBuildFixtureMode;
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
  return `${instance.name}_${instance.ownedNetwork || instance.ownedNetworks ? "private" : "default"}`;
}
function fixtureNetworkNames(instance: Instance): readonly string[] {
  return instance.ownedNetworks
    ? [`${instance.name}_edge`, `${instance.name}_private`]
    : [fixtureNetworkName(instance)];
}
function networkPolicyMatches(
  instance: Instance,
  row: Record<string, unknown>
) {
  return (
    typeof row.name === "string" &&
    typeof row.logical === "string" &&
    fixtureNetworkNames(instance).includes(row.name) &&
    row.name === `${instance.name}_${row.logical}` &&
    (!(instance.ownedNetwork || instance.ownedNetworks) ||
      (row.driver === "bridge" &&
        row.scope === "local" &&
        row.internal === (row.logical === "private")))
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
/** A plural original keeps each configured ID even when stopped aliases vanish. */
export function assertAdoptionPluralEndpointObservation(opts: {
  readonly instance: Instance;
  readonly networkIds: Readonly<Record<"edge" | "private", string>>;
  readonly container: Observation;
  readonly running: boolean;
  readonly row: unknown;
}) {
  const { instance, networkIds, container, running, row } = opts;
  const expected =
    container.service === "db"
      ? { edge: "db-edge", private: "db-reader" }
      : container.service === "worker"
        ? { private: "worker-reader" }
        : undefined;
  if (
    !(
      instance.ownedNetworks &&
      expected &&
      isRecord(row) &&
      row.id === container.id &&
      row.running === running &&
      Array.isArray(row.networks) &&
      row.networks.length === Object.keys(expected).length &&
      ID.test(networkIds.edge) &&
      ID.test(networkIds.private) &&
      networkIds.edge !== networkIds.private
    )
  ) {
    refused();
  }
  const seen = new Set<string>();
  for (const endpoint of row.networks) {
    if (!isRecord(endpoint) || typeof endpoint.name !== "string") {
      refused();
    }
    const logical = endpoint.name.slice(instance.name.length + 1);
    if (
      !(
        endpoint.name === `${instance.name}_${logical}` &&
        Object.hasOwn(expected, logical) &&
        !seen.has(logical) &&
        endpoint.id === networkIds[logical as "edge" | "private"]
      )
    ) {
      refused();
    }
    seen.add(logical);
    const aliases = endpoint.aliases;
    const full = [
      `${instance.name}-${container.service}-1`,
      container.service,
      expected[logical as keyof typeof expected],
    ].sort();
    if (
      !(
        (Array.isArray(aliases) &&
          aliases.every((alias) => typeof alias === "string") &&
          new Set(aliases).size === aliases.length &&
          JSON.stringify([...aliases].sort()) === JSON.stringify(full)) ||
        (!running &&
          (aliases === null ||
            (Array.isArray(aliases) && aliases.length === 0)))
      )
    ) {
      refused();
    }
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
          ...(instance.basicBuild
            ? { build: retainedBuildFixtureDefinition(instance.basicBuild) }
            : { image, pull_policy: "never" }),
          environment: {
            POSTGRES_DB: "fixture",
            POSTGRES_HOST_AUTH_METHOD: "trust",
          },
          volumes: ["data:/var/lib/postgresql/data"],
          ...(instance.ownedNetworks
            ? {
                networks: {
                  private: { aliases: ["db-reader"] },
                  edge: { aliases: ["db-edge"] },
                },
              }
            : instance.ownedNetwork
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
          ...(instance.ownedNetworks
            ? { networks: { private: { aliases: ["worker-reader"] } } }
            : instance.ownedNetwork
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
      ...(instance.ownedNetworks
        ? {
            networks: {
              private: { driver: "bridge", internal: true },
              edge: { driver: "bridge", internal: false },
            },
          }
        : instance.ownedNetwork
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
  readonly ownedNetworks: boolean;
  readonly dependencies: boolean;
  readonly role: "first" | "second";
}): Partial<Pick<Instance, "ownedNetwork" | "ownedNetworks" | "dependency">> {
  if (opts.ownedNetworks && (opts.ownedNetwork || opts.dependencies)) {
    refused();
  }
  return {
    ...(opts.ownedNetwork ? { ownedNetwork: true as const } : {}),
    ...(opts.ownedNetworks ? { ownedNetworks: true as const } : {}),
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

function authoredFixtureFeatures(opts: {
  readonly generated: boolean;
  readonly stringArgv: boolean;
  readonly typedLocal: boolean;
  readonly role: "primary" | "first" | "second";
}): Partial<Pick<Instance, "sourceMode" | "argvMode" | "typedLocal">> {
  return {
    ...(opts.generated ? { sourceMode: "canonical-generated" as const } : {}),
    ...(opts.stringArgv
      ? {
          argvMode:
            opts.role === "second"
              ? ("string-cleared" as const)
              : ("string-entrypoint" as const),
        }
      : {}),
    ...(opts.typedLocal ? { typedLocal: true as const } : {}),
  };
}

async function prepareFixtureInputs(
  ctx: ScenarioContext,
  options: {
    readonly generated?: boolean;
    readonly typedLocal?: boolean;
    readonly stringArgv?: boolean;
    readonly ownedNetwork?: boolean;
    readonly ownedNetworks?: boolean;
    readonly dependencies?: boolean;
    readonly basicBuild?: boolean;
  } = {}
) {
  const {
    generated = false,
    typedLocal = false,
    stringArgv = false,
    ownedNetwork = false,
    ownedNetworks = false,
    dependencies = false,
    basicBuild = false,
  } = options;
  if (
    basicBuild &&
    (generated ||
      typedLocal ||
      stringArgv ||
      ownedNetwork ||
      ownedNetworks ||
      dependencies)
  ) {
    refused();
  }
  const firstFeatures = linkedFixtureFeatures({
    ownedNetwork,
    ownedNetworks,
    dependencies,
    role: "first",
  });
  const secondFeatures = linkedFixtureFeatures({
    ownedNetwork,
    ownedNetworks,
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
    ...authoredFixtureFeatures({
      generated,
      stringArgv,
      typedLocal,
      role: "primary",
    }),
    ...(ownedNetwork ? { ownedNetwork: true as const } : {}),
    ...(basicBuild ? { basicBuild: "root-specific" as const } : {}),
    ...(ownedNetworks ? { ownedNetworks: true as const } : {}),
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
  if (primary.basicBuild) {
    await prepareRetainedBuildFixtureSources({
      ...primary,
      mode: primary.basicBuild,
    });
  }
  await commitAll({
    root: primary.root,
    message: "fixture: canonical legacy source",
  });
  const first: Instance = {
    root: await addLinkedWorktree({ fixture, branch: "adoption-alpha" }),
    name: `${fixture.name}-alpha`,
    marker: "alpha-existing-sql-row",
    ...authoredFixtureFeatures({
      generated,
      stringArgv,
      typedLocal,
      role: "first",
    }),
    ...firstFeatures,
    ...(basicBuild ? { basicBuild: "root-specific" as const } : {}),
  };
  const second: Instance = {
    root: await addLinkedWorktree({ fixture, branch: "adoption-beta" }),
    name: `${fixture.name}-beta`,
    marker: "beta-existing-sql-row",
    ...authoredFixtureFeatures({
      generated,
      stringArgv,
      typedLocal,
      role: "second",
    }),
    ...secondFeatures,
    ...(basicBuild ? { basicBuild: "hack-default" as const } : {}),
  };
  for (const instance of [first, second]) {
    await writeLegacy(instance, image);
    if (instance.basicBuild) {
      await prepareRetainedBuildFixtureSources({
        ...instance,
        mode: instance.basicBuild,
      });
    }
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
    baseImage: image,
    originalImageIds: basicBuild ? await fixtureImageInventory(probe) : [],
  };
}

function createFixtureRuntime(
  opts: Awaited<ReturnType<typeof prepareFixtureInputs>>
) {
  const {
    ctx,
    engine,
    engineId,
    fixtureRoot,
    primary,
    first,
    second,
    probe,
    baseImage,
    originalImageIds,
  } = opts;
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
  const buildSourceAnchors = new Map<Instance, string>();
  const buildEvidence = createRetainedBuildFixtureEvidence({
    tempRoot: ctx.tempRoot,
  });
  const buildEnv = Object.freeze({
    ...RETAINED_BUILD_BOOTSTRAP_ENV,
    DOCKER_HOST: process.env.DOCKER_HOST,
    DOCKER_CONTEXT: process.env.DOCKER_CONTEXT,
  });
  const builtImages = new Map<Instance, RetainedFixtureImage>();
  const builtImageObjects = new Map<
    Instance,
    readonly RetainedFixtureBuildObject[]
  >();
  const buildImageAnchors = new Map<Instance, string>();
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
  const aliasSql = async (instance: Instance) =>
    (
      await probe([
        "container",
        "exec",
        container(instance, "worker"),
        "psql",
        "-h",
        "db-reader",
        "-U",
        "postgres",
        "-d",
        "fixture",
        "-At",
        "-c",
        "SELECT value FROM marker WHERE id=1",
      ])
    ).trim();
  const edgeAliasSql = async (instance: Instance) =>
    (
      await probe([
        "container",
        "exec",
        container(instance, "db"),
        "psql",
        "-h",
        "db-edge",
        "-U",
        "postgres",
        "-d",
        "fixture",
        "-At",
        "-c",
        "SELECT value FROM marker WHERE id=1",
      ])
    ).trim();
  const assertAliasSql = async (instance: Instance) => {
    if (
      (instance.ownedNetwork || instance.ownedNetworks) &&
      (await aliasSql(instance)) !== instance.marker
    ) {
      refused();
    }
    if (
      instance.ownedNetworks &&
      (await edgeAliasSql(instance)) !== instance.marker
    ) {
      refused();
    }
  };
  const waitReady = async (instance: Instance) => {
    await waitForAdoptionFixtureSql({
      read: () => sql(instance, "SELECT 1"),
      expected: "1",
    });
  };
  const assertTopology = async (instance: Instance, running: boolean) => {
    if (!(instance.ownedNetwork || instance.ownedNetworks)) {
      return;
    }
    const baseline = anchors.get(instance);
    if (instance.ownedNetworks) {
      if (
        !baseline ||
        baseline.resources.network.length !== 2 ||
        baseline.resources.container.length !== 2
      ) {
        refused();
      }
      const networkIds: Partial<Record<"edge" | "private", string>> = {};
      for (const network of baseline.resources.network) {
        const row = object(
          await probe([
            "network",
            "inspect",
            "--format",
            BRIDGE_INSPECT_FORMAT,
            network.id,
          ])
        );
        const logical = row.logical;
        if (
          (logical !== "edge" && logical !== "private") ||
          networkIds[logical]
        ) {
          refused();
        }
        networkIds[logical] = network.id;
        const members = running
          ? baseline.resources.container
              .filter(
                (entry) => logical === "private" || entry.service === "db"
              )
              .map((entry) => entry.id)
          : [];
        assertAdoptionBridgeObservation({
          instance,
          id: network.id,
          members,
          row,
        });
      }
      if (!(networkIds.edge && networkIds.private)) {
        refused();
      }
      for (const entry of baseline.resources.container) {
        const row = object(
          await probe([
            "container",
            "inspect",
            "--format",
            `{"id":{{json .Id}},"running":{{json .State.Running}},"networks":[{{$first := true}}{{range $name,$n := .NetworkSettings.Networks}}{{if not $first}},{{end}}{{$first = false}}{"name":{{json $name}},"id":{{json $n.NetworkID}},"aliases":{{json $n.Aliases}}}{{end}}]}`,
            entry.id,
          ])
        );
        assertAdoptionPluralEndpointObservation({
          instance,
          networkIds: { edge: networkIds.edge, private: networkIds.private },
          container: entry,
          running,
          row,
        });
      }
      return;
    }
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
  const checkBuild = async (instance: Instance, baseline: Snapshot) => {
    if (!instance.basicBuild) {
      refused();
    }
    await buildEvidence(instance.basicBuild, "image-admission-begin");
    await assertFixtureBuildImages({
      probe,
      builtImages,
      builtImageObjects,
      originalImageIds,
      instance,
    });
    await buildEvidence(instance.basicBuild, "image-admitted");
    await buildEvidence(instance.basicBuild, "source-recheck-begin");
    if (
      (await retainedBuildFixtureSourceSnapshot({
        root: instance.root,
        mode: instance.basicBuild,
      })) !== buildSourceAnchors.get(instance)
    ) {
      refused();
    }
    await buildEvidence(instance.basicBuild, "source-rechecked");
    await buildEvidence(instance.basicBuild, "runtime-image-begin");
    if (
      (await fixtureRuntimeImages({
        probe,
        instance,
        containers: baseline.resources.container,
        builtImages,
        baseImage,
      })) !== buildImageAnchors.get(instance)
    ) {
      refused();
    }
    await buildEvidence(instance.basicBuild, "runtime-image-rechecked");
    await qualifyRetainedBuildFixtureCopy({
      mode: instance.basicBuild,
      record: buildEvidence,
      read: () =>
        createNativeComposeProbe({ timeoutMs: 30_000 })([
          "container",
          "exec",
          container(instance, "db"),
          "/bin/sh",
          "-c",
          RETAINED_BUILD_COPY_ORACLE,
        ]),
    });
    await owned(instance, "container", container(instance, "db"));
  };
  const checkedRunningBaseline = async (
    instance: Instance,
    checkSource: boolean
  ) => {
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
    return baseline;
  };
  const check = async (instance: Instance, checkSource = true) => {
    const baseline = await checkedRunningBaseline(instance, checkSource);
    await assertTopology(instance, true);
    await assertAliasSql(instance);
    await checkWorkerArgv(instance);
    await checkHealthcheck(instance);
    if (instance.basicBuild) {
      await checkBuild(instance, baseline);
    }
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
    if (instance.basicBuild) {
      await assertFixtureBuildImages({
        ...opts,
        builtImages,
        builtImageObjects,
        instance,
      });
      if (
        (await fixtureRuntimeImages({
          ...opts,
          builtImages,
          instance,
          containers: baseline.resources.container,
        })) !== buildImageAnchors.get(instance)
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
    buildSourceAnchors,
    buildEvidence,
    buildEnv,
    buildImageAnchors,
    builtImages,
    builtImageObjects,
    baseImage,
    originalImageIds,
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
async function fixtureImageInventory(
  probe: ReturnType<typeof createAdoptionFixtureProbe>
) {
  const ids = [
    ...new Set(
      (
        await probe([
          "image",
          "ls",
          "--all",
          "--no-trunc",
          "--format",
          "{{.ID}}",
        ])
      )
        .split(/\s+/)
        .filter(Boolean)
    ),
  ].sort();
  if (!ids.every((id) => IMAGE.test(id))) {
    refused();
  }
  return ids;
}
function fixtureComposePrefix(
  instance: Instance,
  composeFile = join(instance.root, ".hack/docker-compose.yml")
) {
  return [
    "compose",
    "--project-name",
    instance.name,
    "--project-directory",
    join(instance.root, ".hack"),
    "--env-file",
    "/dev/null",
    "--profile",
    "*",
    "--file",
    composeFile,
  ];
}
type BuildImageContext = {
  readonly probe: ReturnType<typeof createAdoptionFixtureProbe>;
  readonly builtImages: ReadonlyMap<Instance, RetainedFixtureImage>;
  readonly builtImageObjects: ReadonlyMap<
    Instance,
    readonly RetainedFixtureBuildObject[]
  >;
  readonly originalImageIds: readonly string[];
  readonly baseImage: string;
};
async function assertFixtureBuildImages(
  opts: Pick<
    BuildImageContext,
    "probe" | "builtImages" | "builtImageObjects" | "originalImageIds"
  > & { readonly instance: Instance }
) {
  const captured = opts.builtImages.get(opts.instance);
  if (!captured) {
    refused();
  }
  for (const reference of [captured.reference, captured.id]) {
    assertRetainedFixtureImageUnchanged({
      captured,
      current: retainedBuildFixtureImage({
        value: object(
          await opts.probe([
            "image",
            "inspect",
            "--format",
            RETAINED_BUILD_IMAGE_FORMAT,
            reference,
          ])
        ),
        reference: captured.reference,
        owner: opts.instance.name,
        originalImageIds: opts.originalImageIds,
      }),
    });
  }
  const objects = opts.builtImageObjects.get(opts.instance);
  if (!objects || objects.length < 1) {
    refused();
  }
  for (const expected of objects) {
    const current = retainedBuildFixtureObject({
      value: object(
        await opts.probe([
          "image",
          "inspect",
          "--format",
          RETAINED_BUILD_OBJECT_FORMAT,
          expected.id,
        ])
      ),
      selected: captured,
      originalImageIds: opts.originalImageIds,
      ...(expected.composeVersion !== null
        ? { composeVersion: expected.composeVersion }
        : {}),
    });
    if (JSON.stringify(current) !== JSON.stringify(expected)) {
      refused();
    }
  }
}
async function fixtureRuntimeImages(
  opts: Pick<BuildImageContext, "probe" | "builtImages" | "baseImage"> & {
    readonly instance: Instance;
    readonly containers: readonly Observation[];
  }
) {
  const selected = opts.builtImages.get(opts.instance);
  if (!selected || opts.containers.length !== 2) {
    refused();
  }
  const result: Record<string, unknown>[] = [];
  for (const container of opts.containers) {
    const row = object(
      await opts.probe([
        "container",
        "inspect",
        "--format",
        '{"id":{{json .Id}},"image":{{json .Image}},"reference":{{json .Config.Image}},"createdAt":{{json .Created}}}',
        container.id,
      ])
    );
    const reference =
      container.service === "db" ? selected.reference : opts.baseImage;
    const id = container.service === "db" ? selected.id : opts.baseImage;
    if (
      Object.keys(row).sort().join() !== "createdAt,id,image,reference" ||
      row.id !== container.id ||
      row.image !== id ||
      row.reference !== reference ||
      typeof row.createdAt !== "string" ||
      !CREATED.test(row.createdAt)
    ) {
      refused();
    }
    const image = object(
      await opts.probe([
        "image",
        "inspect",
        "--format",
        '{"id":{{json .Id}},"createdAt":{{json .Created}}}',
        id,
      ])
    );
    if (
      Object.keys(image).sort().join() !== "createdAt,id" ||
      image.id !== id ||
      typeof image.createdAt !== "string" ||
      !CREATED.test(image.createdAt)
    ) {
      refused();
    }
    result.push({
      service: container.service,
      ...row,
      imageCreatedAt: image.createdAt,
    });
  }
  return JSON.stringify(
    result.sort((a, b) => String(a.service).localeCompare(String(b.service)))
  );
}
async function saveFixtureBuildRecovery(h: FixtureRuntime, pending?: unknown) {
  const path = join(h.ctx.tempRoot, "retained-build-original-images.json");
  await Bun.write(
    path,
    JSON.stringify({
      engineId: h.engineId,
      originalImageIds: h.originalImageIds,
      baseImage: h.baseImage,
      images: [...h.builtImages.entries()].map(([instance, image]) => ({
        project: instance.name,
        root: instance.root,
        image,
      })),
      objects: [...h.builtImageObjects.entries()].map(
        ([instance, objects]) => ({
          project: instance.name,
          objects,
        })
      ),
      ...(pending !== undefined ? { pending } : {}),
    })
  );
  await chmod(path, 0o600);
}
async function bootstrapFixtureBuildImage(
  h: FixtureRuntime,
  instance: Instance
) {
  if (!instance.basicBuild || h.builtImages.has(instance)) {
    refused();
  }
  await requirePreparedEngine(h);
  const previousIds = [
    ...h.originalImageIds,
    ...[...h.builtImageObjects.values()].flatMap((rows) =>
      rows.map((row) => row.id)
    ),
  ].sort();
  if (
    JSON.stringify(await fixtureImageInventory(h.probe)) !==
    JSON.stringify(previousIds)
  ) {
    refused();
  }
  if (
    (
      await h.probe([
        "image",
        "inspect",
        "--format",
        "{{.Id}}",
        RETAINED_BUILD_BASE_TAG,
      ])
    ).trim() !== h.baseImage
  ) {
    refused();
  }
  const reference = (
    await h.probe([
      ...fixtureComposePrefix(instance),
      "config",
      "--no-env-resolution",
      "--images",
      "db",
    ])
  ).trim();
  if (
    !reference ||
    reference.length > 512 ||
    /\s/.test(reference) ||
    (
      await h.probe([
        "image",
        "ls",
        "--all",
        "--no-trunc",
        "--filter",
        `reference=${reference}`,
        "--format",
        "{{.ID}}",
      ])
    ).trim() ||
    (
      await h.probe([
        "image",
        "ls",
        "--all",
        "--no-trunc",
        "--filter",
        `label=${RETAINED_BUILD_IMAGE_OWNER}=${instance.name}`,
        "--format",
        "{{.ID}}",
      ])
    ).trim()
  ) {
    refused();
  }
  const composeVersion = retainedBuildFixtureComposeVersion(
    await h.probe(["compose", "version", "--short"])
  );
  await saveFixtureBuildRecovery(h, {
    project: instance.name,
    reference,
    stage: "before-build",
  });
  await qualifyRetainedBuildFixtureBuilder({
    mode: instance.basicBuild,
    env: h.buildEnv,
    read: h.probe,
    record: h.buildEvidence,
  });
  await h.buildEvidence(instance.basicBuild, "build-begin");
  await requirePreparedEngine(h);
  const built = await runCommand({
    argv: [
      h.engine,
      ...fixtureComposePrefix(instance),
      "build",
      "--builder",
      "default",
      "db",
    ],
    cwd: h.fixtureRoot,
    env: RETAINED_BUILD_BOOTSTRAP_ENV,
    timeoutMs: TIMEOUT,
  });
  await h.buildEvidence(instance.basicBuild, "build-settled");
  await h.buildEvidence(instance.basicBuild, "image-admission-begin");
  const observation = object(
    await h.probe([
      "image",
      "inspect",
      "--format",
      RETAINED_BUILD_IMAGE_FORMAT,
      reference,
    ])
  );
  await saveFixtureBuildRecovery(h, {
    project: instance.name,
    reference,
    stage: "image-observed",
    observation,
  });
  const image = retainedBuildFixtureImage({
    value: observation,
    reference,
    owner: instance.name,
    originalImageIds: h.originalImageIds,
  });
  await h.buildEvidence(instance.basicBuild, "image-admitted");
  const observedIds = await fixtureImageInventory(h.probe);
  if (!previousIds.every((id) => observedIds.includes(id))) {
    refused();
  }
  const newIds = observedIds.filter((id) => !previousIds.includes(id));
  if (newIds.length < 1 || newIds.length > 16) {
    refused();
  }
  const values: unknown[] = [];
  for (const id of newIds) {
    values.push(
      object(
        await h.probe([
          "image",
          "inspect",
          "--format",
          RETAINED_BUILD_OBJECT_FORMAT,
          id,
        ])
      )
    );
    await saveFixtureBuildRecovery(h, {
      project: instance.name,
      reference,
      stage: "objects-observed",
      observations: values,
    });
  }
  const objects = retainedBuildFixtureObjectGraph({
    values,
    selected: image,
    originalImageIds: h.originalImageIds,
    baseImage: h.baseImage,
    composeVersion,
  });
  h.builtImages.set(instance, image);
  h.builtImageObjects.set(instance, objects);
  await saveFixtureBuildRecovery(h);
  await h.buildEvidence(instance.basicBuild, "graph-admitted");
  successful(built);
  await assertFixtureBuildImages({ ...h, instance });
  if (
    (
      await h.probe([
        "image",
        "inspect",
        "--format",
        "{{.Id}}",
        RETAINED_BUILD_BASE_TAG,
      ])
    ).trim() !== h.baseImage ||
    (await retainedBuildFixtureSourceSnapshot({
      root: instance.root,
      mode: instance.basicBuild,
    })) !== h.buildSourceAnchors.get(instance)
  ) {
    refused();
  }
}

async function requireFixtureNamesAbsent(
  h: FixtureRuntime,
  instance: Instance
) {
  const { list, probe } = h;
  for (const kind of ["container", "network", "volume"] as const) {
    if ((await list(instance, kind)).length) {
      refused();
    }
  }
  for (const [kind, name] of [
    ["volume", `${instance.name}_data`],
    ...fixtureNetworkNames(instance).map((name) => ["network", name] as const),
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
}
async function bootstrapOriginal(h: FixtureRuntime, instance: Instance) {
  const {
    engine,
    fixtureRoot,
    resources,
    anchors,
    sql,
    waitReady,
    check,
    managedAnchors,
    localAnchors,
    primary,
    buildSourceAnchors,
  } = h;

  await requireFixtureNamesAbsent(h, instance);
  const originalSource = await source(instance);
  if (instance.basicBuild) {
    buildSourceAnchors.set(
      instance,
      await retainedBuildFixtureSourceSnapshot({
        root: instance.root,
        mode: instance.basicBuild,
      })
    );
    await bootstrapFixtureBuildImage(h, instance);
  }
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
  if (instance.basicBuild) {
    await h.buildEvidence(instance.basicBuild, "original-start-begin");
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
      ...(instance.basicBuild ? ["--no-build"] : []),
    ],
    cwd: fixtureRoot,
    timeoutMs: TIMEOUT,
  });
  if (instance.basicBuild) {
    await h.buildEvidence(instance.basicBuild, "original-start-settled");
  }
  const captured = await resources(instance);
  anchors.set(instance, {
    resources: captured,
    source: originalSource,
  });
  successful(started);
  if (
    captured.container.length !== 2 ||
    captured.volume.length !== 1 ||
    captured.network.length !== (instance.ownedNetworks ? 2 : 1)
  ) {
    refused();
  }
  if (instance.basicBuild) {
    h.buildImageAnchors.set(
      instance,
      await fixtureRuntimeImages({
        ...h,
        instance,
        containers: captured.container,
      })
    );
    await h.buildEvidence(instance.basicBuild, "original-ids-captured");
    await h.buildEvidence(instance.basicBuild, "readiness-begin");
  }
  await waitReady(instance);
  if (instance.basicBuild) {
    await h.buildEvidence(instance.basicBuild, "readiness-qualified");
    await h.buildEvidence(instance.basicBuild, "sql-begin");
  }
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
  if (instance.basicBuild) {
    await h.buildEvidence(instance.basicBuild, "sql-qualified");
    await h.buildEvidence(instance.basicBuild, "full-check-begin");
  }
  await check(instance);
  if (instance.basicBuild) {
    await h.buildEvidence(instance.basicBuild, "full-check-qualified");
  }
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

const FOREIGN_CANARY_LABEL = "io.hack.nc04.foreign-canary";
export const FOREIGN_CANARY_FORMAT = `{"id":{{json .Id}},"name":{{json .Name}},"created":{{json .Created}},"image":{{json .Image}},"project":{{json (index .Config.Labels "${PROJECT_LABEL}")}},"task":{{json (index .Config.Labels "${FOREIGN_CANARY_LABEL}")}},"native":{{json (index .Config.Labels "io.hack.native-config.version")}},"state":{{json .State.Status}},"running":{{json .State.Running}},"pid":{{json .State.Pid}},"startedAt":{{json .State.StartedAt}},"networkMode":{{json .HostConfig.NetworkMode}},"readOnlyRootfs":{{json .HostConfig.ReadonlyRootfs}},"publishAllPorts":{{json .HostConfig.PublishAllPorts}},"portBindings":{{json (index .HostConfig "PortBindings")}},"runtimePorts":{{json .NetworkSettings.Ports}},"configuredTmpfs":{{json (index .HostConfig "Tmpfs")}},"hostBinds":{{json (index .HostConfig "Binds")}},"hostMounts":{{json (index .HostConfig "Mounts")}},"volumesFrom":{{json (index .HostConfig "VolumesFrom")}},"imageVolumes":{{json .Config.Volumes}},"networks":[{{$first := true}}{{range $name,$n := .NetworkSettings.Networks}}{{if not $first}},{{end}}{{$first = false}}{"name":{{json $name}},"id":{{json $n.NetworkID}}}{{end}}],"mounts":[{{range $i,$m := .Mounts}}{{if $i}},{{end}}{"type":{{json $m.Type}},"target":{{json $m.Destination}}}{{end}}]}`;
/** Docker may omit an active --tmpfs from inspect Mounts; read the owned container's mount namespace. */
export const FOREIGN_CANARY_MOUNTINFO_SCRIPT = `set -eu
matched=0
while IFS=' ' read -r mount_id parent device root mountpoint options rest; do
  if [ "$mountpoint" = "/var/lib/postgresql/data" ]; then
    [ "$matched" -eq 0 ] || exit 71
    case "$rest" in
      "- "*) after_separator=\${rest#- } ;;
      *" - "*) after_separator=\${rest#* - } ;;
      *) exit 72 ;;
    esac
    case "$after_separator" in
      "tmpfs "*) matched=1 ;;
      *) exit 72 ;;
    esac
  fi
done < /proc/self/mountinfo
[ "$matched" -eq 1 ] || exit 73
printf 'tmpfs-ok\\n'`;
type ForeignCanaryPin = {
  readonly id: string;
  readonly name: string;
  readonly created: string;
  readonly image: string;
  readonly project: string;
  readonly task: string;
  readonly networkId: string;
  readonly networkName: string;
};

function canaryIdentityMatches(
  row: Record<string, unknown>,
  pin: ForeignCanaryPin
) {
  return (
    row.id === pin.id &&
    row.name === `/${pin.name}` &&
    row.created === pin.created &&
    row.image === pin.image &&
    row.project === pin.project &&
    row.task === pin.task &&
    (row.native === null || row.native === "")
  );
}

function canaryStateMatches(
  row: Record<string, unknown>,
  state: "created" | "running" | "exited"
) {
  const pid = row.pid;
  const neverStarted = "0001-01-01T00:00:00Z";
  return (
    row.state === state &&
    row.running === (state === "running") &&
    typeof pid === "number" &&
    Number.isSafeInteger(pid) &&
    (state === "running" ? pid > 0 : pid === 0) &&
    typeof row.startedAt === "string" &&
    (state === "created"
      ? row.startedAt === neverStarted
      : CREATED.test(row.startedAt) && row.startedAt !== neverStarted)
  );
}

function canaryStorageMatches(
  row: Record<string, unknown>,
  state: "created" | "running" | "exited"
) {
  const target = "/var/lib/postgresql/data";
  const activeTmpfs = JSON.stringify([{ type: "tmpfs", target }]);
  const mounts = JSON.stringify(row.mounts);
  return (
    isRecord(row.configuredTmpfs) &&
    Object.keys(row.configuredTmpfs).length === 1 &&
    row.configuredTmpfs[target] === "rw,noexec,nosuid,nodev,mode=700" &&
    isRecord(row.imageVolumes) &&
    Object.keys(row.imageVolumes).length === 1 &&
    isRecord(row.imageVolumes[target]) &&
    (state === "created"
      ? mounts === "[]"
      : mounts === "[]" || mounts === activeTmpfs)
  );
}

function absentOrEmptyArray(value: unknown) {
  return value === null || (Array.isArray(value) && value.length === 0);
}

function canaryHostIsolationMatches(row: Record<string, unknown>) {
  const noRuntimePorts =
    row.runtimePorts === null ||
    (isRecord(row.runtimePorts) &&
      Object.values(row.runtimePorts).every(
        (bindings) =>
          bindings === null ||
          (Array.isArray(bindings) && bindings.length === 0)
      ));
  return (
    row.readOnlyRootfs === true &&
    row.publishAllPorts === false &&
    (row.portBindings === null ||
      (isRecord(row.portBindings) &&
        Object.keys(row.portBindings).length === 0)) &&
    noRuntimePorts &&
    absentOrEmptyArray(row.hostBinds) &&
    absentOrEmptyArray(row.hostMounts) &&
    absentOrEmptyArray(row.volumesFrom)
  );
}

function canaryNetworkMatches(
  row: Record<string, unknown>,
  pin: ForeignCanaryPin,
  state: "created" | "running" | "exited"
) {
  const endpoint = Array.isArray(row.networks) && row.networks[0];
  return (
    row.networkMode === pin.networkId &&
    Array.isArray(row.networks) &&
    row.networks.length === 1 &&
    isRecord(endpoint) &&
    endpoint.name === pin.networkName &&
    (endpoint.id === pin.networkId ||
      (state !== "running" && endpoint.id === ""))
  );
}

/** The canary has a different project owner, one selected bridge, and no data volume. */
export function assertAdoptionForeignCanaryObservation(opts: {
  readonly pin: ForeignCanaryPin;
  readonly state: "created" | "running" | "exited";
  readonly row: unknown;
}) {
  const { pin, row, state } = opts;
  if (!isRecord(row)) {
    refused();
  }
  const validPin =
    ID.test(pin.id) && IMAGE.test(pin.image) && CREATED.test(pin.created);
  const selected =
    validPin &&
    canaryIdentityMatches(row, pin) &&
    canaryStateMatches(row, state) &&
    canaryStorageMatches(row, state) &&
    canaryHostIsolationMatches(row) &&
    canaryNetworkMatches(row, pin, state);
  if (!selected) {
    refused();
  }
}

async function foreignCanaryRefusal(
  h: FixtureRuntime,
  gate: { pending: boolean }
) {
  const first = h.first;
  if (!(first.ownedNetwork || first.ownedNetworks) || gate.pending) {
    refused();
  }
  await h.check(first);
  await h.check(h.second);
  const baseline = h.anchors.get(first);
  const privateBridges = [] as Observation[];
  if (first.ownedNetworks && baseline) {
    for (const candidate of baseline.resources.network) {
      const row = object(
        await h.probe([
          "network",
          "inspect",
          "--format",
          BRIDGE_INSPECT_FORMAT,
          candidate.id,
        ])
      );
      if (row.logical === "private") {
        assertAdoptionBridgeObservation({
          instance: first,
          id: candidate.id,
          members: baseline.resources.container.map((entry) => entry.id),
          row,
        });
        privateBridges.push(candidate);
      }
    }
  }
  const bridge = first.ownedNetworks
    ? privateBridges[0]
    : baseline?.resources.network[0];
  if (
    !baseline ||
    baseline.resources.network.length !== (first.ownedNetworks ? 2 : 1) ||
    (first.ownedNetworks && privateBridges.length !== 1) ||
    baseline.resources.container.length !== 2 ||
    !bridge ||
    !ID.test(bridge.id)
  ) {
    refused();
  }
  const name = `${first.name}-foreign-canary`;
  const task = first.name;
  const project = `${first.name}-foreign`;
  const image = await h.probe([
    "container",
    "inspect",
    "--format",
    "{{.Image}}",
    h.container(first, "db"),
  ]);
  if (!IMAGE.test(image)) {
    refused();
  }
  const byName = await h.probe([
    "container",
    "ls",
    "--all",
    "--no-trunc",
    "--filter",
    `name=^/${name}$`,
    "--format",
    "{{.ID}}",
  ]);
  const byTask = await h.probe([
    "container",
    "ls",
    "--all",
    "--no-trunc",
    "--filter",
    `label=${FOREIGN_CANARY_LABEL}=${task}`,
    "--format",
    "{{.ID}}",
  ]);
  if (byName || byTask) {
    refused();
  }
  const proofRoot = join(h.ctx.tempRoot, "foreign-canary-proof");
  await mkdir(proofRoot, { mode: 0o700 });
  const record = async (filename: string, value: unknown) => {
    const handle = await open(join(proofRoot, filename), "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const directory = await open(proofRoot, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  };
  await record("intent.json", {
    engine: h.engineId,
    bridge: bridge.id,
    source: baseline.source,
    name,
    task,
    project,
    image,
  });
  gate.pending = true;
  let pin: ForeignCanaryPin | undefined;
  let stage: "created" | "running" = "created";
  const inspect = async (state: "created" | "running" | "exited") => {
    if (!pin) {
      refused();
    }
    await requirePreparedEngine(h);
    assertAdoptionForeignCanaryObservation({
      pin,
      state,
      row: object(
        await h.probe([
          "container",
          "inspect",
          "--format",
          FOREIGN_CANARY_FORMAT,
          pin.id,
        ])
      ),
    });
  };
  const verifyRunningTmpfs = async () => {
    if (!pin) {
      refused();
    }
    await inspect("running");
    await requirePreparedEngine(h);
    const result = await h.probe([
      "container",
      "exec",
      pin.id,
      "/bin/sh",
      "-c",
      FOREIGN_CANARY_MOUNTINFO_SCRIPT,
    ]);
    if (result !== "tmpfs-ok") {
      refused();
    }
    await inspect("running");
    await requirePreparedEngine(h);
  };
  const retire = async () => {
    if (!pin) {
      refused();
    }
    if (stage === "running") {
      await verifyRunningTmpfs();
      await h.effect(["container", "stop", "--time", "5", pin.id]);
      await inspect("exited");
    } else {
      await inspect(stage);
    }
    await h.effect(["container", "rm", pin.id]);
    await requirePreparedEngine(h);
    if (
      await h.probe([
        "container",
        "ls",
        "--all",
        "--no-trunc",
        "--filter",
        `label=${FOREIGN_CANARY_LABEL}=${task}`,
        "--format",
        "{{.ID}}",
      ])
    ) {
      refused();
    }
    await record("retired.json", { id: pin.id, created: pin.created });
    gate.pending = false;
  };
  try {
    const created = await h.effect([
      "container",
      "create",
      "--pull=never",
      "--name",
      name,
      "--network",
      bridge.id,
      "--label",
      `${PROJECT_LABEL}=${project}`,
      "--label",
      `${FOREIGN_CANARY_LABEL}=${task}`,
      "--read-only",
      "--tmpfs",
      "/var/lib/postgresql/data:rw,noexec,nosuid,nodev,mode=700",
      "--entrypoint",
      "/bin/sh",
      image,
      "-c",
      "while true; do sleep 1; done",
    ]);
    const id = created.stdout.trim();
    if (!ID.test(id)) {
      refused();
    }
    const createdAt = await h.probe([
      "container",
      "inspect",
      "--format",
      "{{.Created}}",
      id,
    ]);
    if (!CREATED.test(createdAt)) {
      refused();
    }
    const selectedPin = {
      id,
      name,
      created: createdAt,
      image,
      project,
      task,
      networkId: bridge.id,
      networkName: fixtureNetworkName(first),
    };
    await record("selected.json", selectedPin);
    pin = selectedPin;
    await inspect("created");
    await h.effect(["container", "start", id]);
    stage = "running";
    await verifyRunningTmpfs();
    await inspectAdoptionBridge({
      instance: first,
      id: bridge.id,
      members: [...baseline.resources.container.map((row) => row.id), id],
      probe: h.probe,
    });
    const before = JSON.stringify(await h.resources(first));
    const sourceBefore = await source(first);
    const sqlBefore = await h.sql(first, "SELECT value FROM marker WHERE id=1");
    await requirePreparedEngine(h);
    const denied = refusedPreview(
      await h.cli(first, ["config", "adopt", "--dry-run", "--stop", "--json"])
    );
    await requirePreparedEngine(h);
    if (
      object(denied.stdout).complete !== false ||
      before !== JSON.stringify(baseline.resources) ||
      before !== JSON.stringify(await h.resources(first)) ||
      sourceBefore !== baseline.source ||
      sourceBefore !== (await source(first)) ||
      sqlBefore !== first.marker ||
      sqlBefore !== (await h.sql(first, "SELECT value FROM marker WHERE id=1"))
    ) {
      refused();
    }
    await h.assertNoState(first);
    await h.check(h.second);
    await verifyRunningTmpfs();
    await inspectAdoptionBridge({
      instance: first,
      id: bridge.id,
      members: [...baseline.resources.container.map((row) => row.id), id],
      probe: h.probe,
    });
  } finally {
    if (pin && gate.pending) {
      await retire();
    }
  }
  await h.check(first);
  await h.check(h.second);
  const restored = successful(
    await h.cli(first, ["config", "adopt", "--dry-run", "--stop", "--json"])
  );
  if (object(restored.stdout).complete !== true) {
    refused();
  }
  await h.assertNoState(first);
}
function partialStopReceiptVersion(first: Instance): number {
  const generatedVersion = first.typedLocal ? 4 : 3;
  return first.basicBuild
    ? 9
    : first.ownedNetworks
      ? 11
      : first.ownedNetwork
        ? first.dependency
          ? 10
          : 6
        : first.dependency
          ? 5
          : first.sourceMode
            ? generatedVersion
            : 2;
}
function partialStopDockerScript(opts: {
  readonly h: FixtureRuntime;
  readonly engine: string;
  readonly first: Instance;
  readonly receipt: string;
  readonly db: string;
  readonly worker: string;
  readonly control: string;
  readonly firstPrepare?: AdoptionDependencyFirstPrepare;
}): string {
  const { h, engine, first, receipt, db, worker, control, firstPrepare } = opts;
  const receiptVersion = partialStopReceiptVersion(first);
  return `#!${process.execPath}
const args = process.argv.slice(2);
const engine = ${JSON.stringify(engine)};
if(args[0]==="container" && args[1]==="stop") {
 if(${first.dependency || first.basicBuild ? `args.length!==3 || args[2]!==${JSON.stringify(worker)}` : `args.length!==4 || !args.includes(${JSON.stringify(db)}) || !args.includes(${JSON.stringify(worker)})`}) process.exit(99);
 const state=JSON.parse(await Bun.file(${JSON.stringify(receipt)}).text());
 if(state.adoption_receipt_version!==${receiptVersion} || state.pendingOperation?.operation!=="stop") process.exit(98);
 ${first.dependency || first.basicBuild ? dependencyEngineCheck(h) : ""}
 ${first.basicBuild ? buildMutationGuard(h, first, receipt) : ""}
 const child=Bun.spawn([engine,"container","stop",${JSON.stringify(first.dependency || first.basicBuild ? worker : db)}],{stdin:"ignore",stdout:"ignore",stderr:"ignore"});
 if(await child.exited!==0) process.exit(97);
 await Bun.write(${JSON.stringify(control)},"journal-before-partial-stop");process.exit(71);
}
${first.dependency ? dependencyReadGuard(h, first, receipt, firstPrepare) : ""}
${first.basicBuild ? buildReadGuard(h, first, receipt, firstPrepare) : ""}
const child=Bun.spawn([engine,...args],{stdin:"inherit",stdout:"inherit",stderr:"inherit"});process.exit(await child.exited);
`;
}
async function interruptFirstStop(h: FixtureRuntime) {
  const { ctx, engine, first, container, cli } = h;
  const firstPrepare =
    first.dependency || first.basicBuild
      ? await captureAdoptionDependencyFirstPrepare({ projectRoot: first.root })
      : undefined;
  const shimRoot = join(ctx.tempRoot, "partial-stop-shim");
  await mkdir(shimRoot, { mode: 0o700 });
  const receipt = join(
    first.root,
    ".hack/.internal/legacy-compose-adoption-v1/receipt.json"
  );
  const db = container(first, "db"),
    worker = container(first, "worker");
  const control = join(shimRoot, "control-hit");
  const shim = join(shimRoot, "docker");
  await Bun.write(
    shim,
    partialStopDockerScript({
      h,
      engine,
      first,
      receipt,
      db,
      worker,
      control,
      firstPrepare,
    })
  );
  await chmod(shim, 0o700);
  const partial = await cli(first, ["config", "adopt", "--stop", "--json"], {
    PATH: `${shimRoot}:${process.env.PATH ?? "/usr/bin:/bin"}`,
  });
  if (first.dependency || first.basicBuild) {
    assertAdoptionDependencyControl({
      stage: "prepared-stop",
      exitCode: partial.exitCode,
      timedOut: partial.timedOut,
      control: await dependencyControlMarker(
        control,
        "journal-before-partial-stop"
      ),
    });
  } else if (
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

async function dependencyControlMarker(path: string, expected: string) {
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) {
      return "missing" as const;
    }
    return (await file.text()) === expected
      ? ("valid" as const)
      : ("invalid" as const);
  } catch {
    return "invalid" as const;
  }
}

function dependencyEngineCheck(h: Pick<FixtureRuntime, "engineId">): string {
  return `const engineCheck=Bun.spawn([engine,'info','--format','{{json .ID}}'],{stdin:'ignore',stdout:'pipe',stderr:'ignore'});
 const engineId=(await new Response(engineCheck.stdout).text()).trim();if(await engineCheck.exited!==0 || engineId!==${JSON.stringify(h.engineId)})process.exit(95);`;
}

/** Only fixed metadata reads and canonical config hashes reach the real engine through new dependency shims. */
function dependencyReadGuard(
  h: FixtureRuntime,
  instance: Instance,
  receipt: string,
  firstPrepare?: AdoptionDependencyFirstPrepare
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
  const stagedHelper = fileURLToPath(
    new URL(
      "./native-compose-adoption-dependency-staged-read.ts",
      import.meta.url
    )
  );
  return `import {adoptionDependencyReadAllowed} from ${JSON.stringify(helper)};
import {adoptionDependencyStagedReadAllowed} from ${JSON.stringify(stagedHelper)};
try {
 const savedFile=Bun.file(${JSON.stringify(receipt)});
 const saved=await savedFile.exists() ? JSON.parse(await savedFile.text()) : null;
 const generationId=saved?.prepared?.id ?? saved?.publication?.generation?.id;
 const allowed=adoptionDependencyReadAllowed({args,projectRoot:${JSON.stringify(instance.root)},project:${JSON.stringify(instance.name)},containerIds:${JSON.stringify(anchor.resources.container.map((row) => row.id))},networkId:${JSON.stringify(network.id)},volumeName:${JSON.stringify(volume.id)},generationId})${firstPrepare ? ` || await adoptionDependencyStagedReadAllowed({args,project:${JSON.stringify(instance.name)},first:${JSON.stringify(firstPrepare)}})` : ""};
 if(!allowed){console.error('dependency-read-refused stage=read-admission code=93');process.exit(93);}
}catch{console.error('dependency-read-refused stage=read-admission code=93');process.exit(93);}`;
}
type BuildFixtureTransport = Pick<
  FixtureRuntime,
  "engine" | "engineId" | "baseImage" | "anchors" | "builtImages" | "cli"
> & {
  readonly ctx: Pick<ScenarioContext, "tempRoot"> &
    Partial<Pick<ScenarioContext, "log">>;
};
function fixtureBuildScope(h: BuildFixtureTransport, instance: Instance) {
  const anchor = h.anchors.get(instance);
  const built = h.builtImages.get(instance);
  if (
    !(anchor && built) ||
    anchor.resources.container.length !== 2 ||
    anchor.resources.network.length !== 1 ||
    anchor.resources.volume.length !== 1
  ) {
    refused();
  }
  return {
    projectRoot: instance.root,
    project: instance.name,
    containerIds: anchor.resources.container.map((row) => row.id),
    networkId: anchor.resources.network[0]?.id,
    volumeName: anchor.resources.volume[0]?.id,
    images: [
      { id: built.id, reference: built.reference },
      { id: h.baseImage, reference: h.baseImage },
    ],
  };
}
function buildMutationGuard(
  h: BuildFixtureTransport,
  instance: Instance,
  receipt: string,
  recoverPendingStartStop = false
) {
  const helper = fileURLToPath(
    new URL("./native-compose-adoption-build-inputs.ts", import.meta.url)
  );
  return `const {retainedBuildFixtureMutationAllowed}=await import(${JSON.stringify(helper)});
const mutationReceipt=JSON.parse(await Bun.file(${JSON.stringify(receipt)}).text());
if(!retainedBuildFixtureMutationAllowed({args,receipt:mutationReceipt,ids:${JSON.stringify(fixtureBuildScope(h, instance).containerIds)},services:['db','worker']${recoverPendingStartStop ? ",recoverPendingStartStop:true" : ""}})) {console.error('retained-build-refused stage=mutation-admission code=94');process.exit(94);}`;
}
function buildReadGuard(
  h: BuildFixtureTransport,
  instance: Instance,
  receipt: string,
  firstPrepare?: AdoptionDependencyFirstPrepare
) {
  const helper = fileURLToPath(
    new URL("./native-compose-adoption-build-inputs.ts", import.meta.url)
  );
  return `import {retainedBuildFixtureReadAllowed,retainedBuildFixtureStagedReadAllowed} from ${JSON.stringify(helper)};
try {
 const savedFile=Bun.file(${JSON.stringify(receipt)});
 const saved=await savedFile.exists()?JSON.parse(await savedFile.text()):null;
 const generationId=saved?.prepared?.id ?? saved?.publication?.generation?.id;
 const scope={...${JSON.stringify(fixtureBuildScope(h, instance))},args,generationId};
 const allowed=retainedBuildFixtureReadAllowed(scope)${firstPrepare ? ` || await retainedBuildFixtureStagedReadAllowed({scope,first:${JSON.stringify(firstPrepare)}})` : ""};
 if(!allowed){console.error('retained-build-refused stage=read-admission code=93');process.exit(93);}
}catch{console.error('retained-build-refused stage=read-admission code=93');process.exit(93);}`;
}
/** Actual closed transport used by every post-bootstrap build9 CLI invocation, including previews. */
export async function buildFixtureCli(
  h: BuildFixtureTransport,
  instance: Instance,
  args: readonly string[],
  driftAfterStart = false
) {
  const invocation = Object.freeze([...args]);
  const recoverPendingStartStop =
    invocation.length === 3 &&
    invocation[0] === "down" &&
    invocation[1] === "--recover" &&
    invocation[2] === "--json";
  if (!instance.basicBuild) {
    refused();
  }
  const receipt = join(
    instance.root,
    ".hack/.internal/legacy-compose-adoption-v1/receipt.json"
  );
  const firstPrepare =
    invocation[0] === "config" &&
    invocation[1] === "adopt" &&
    !(await Bun.file(receipt).exists())
      ? await captureAdoptionDependencyFirstPrepare({
          projectRoot: instance.root,
        })
      : undefined;
  const shimRoot = join(
    h.ctx.tempRoot,
    `retained-build-${instance.name}-${crypto.randomUUID()}`
  );
  await mkdir(shimRoot, { mode: 0o700 });
  const control = join(shimRoot, "control-hit");
  const shim = join(shimRoot, "docker");
  await Bun.write(
    shim,
    `#!${process.execPath}
const args=process.argv.slice(2); const engine=${JSON.stringify(h.engine)};
if(args[0]==='container' && ['start','stop'].includes(args[1])) {
 ${buildMutationGuard(h, instance, receipt, recoverPendingStartStop)}
 ${dependencyEngineCheck(h)}
 const child=Bun.spawn([engine,...args],{stdin:'ignore',stdout:'ignore',stderr:'ignore'});
 const code=await child.exited;
 ${driftAfterStart ? `if(code===0 && args[1]==='start') {await Bun.write(${JSON.stringify(retainedBuildFixtureMarker(instance.root, instance.basicBuild))},${JSON.stringify("synthetic-controlled-context-drift\n")});await Bun.write(${JSON.stringify(control)},'original-start-before-context-drift');}` : ""}
 process.exit(code);
}
${buildReadGuard(h, instance, receipt, firstPrepare)}
const child=Bun.spawn([engine,...args],{stdin:'inherit',stdout:'inherit',stderr:'inherit'});process.exit(await child.exited);
`
  );
  await chmod(shim, 0o700);
  const result = await observeRetainedBuildFixtureCli({
    context: h.ctx,
    mode: instance.basicBuild,
    args: invocation,
    driftAfterStart,
    run: () =>
      h.cli(instance, invocation, {
        PATH: `${shimRoot}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      }),
  });
  if (driftAfterStart) {
    assertAdoptionDependencyControl({
      stage: "pending-start",
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      control: await dependencyControlMarker(
        control,
        "original-start-before-context-drift"
      ),
    });
  }
  return result;
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
if(receipt.adoption_receipt_version!==${instance.ownedNetwork ? 10 : 5} || receipt.pendingOperation?.operation!=='start')process.exit(98);
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
  assertAdoptionDependencyControl({
    stage: partial ? "pending-start" : "ordered-start",
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    control: await dependencyControlMarker(starts, JSON.stringify(expected)),
  });
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
async function fixtureRunningIds(h: FixtureRuntime, instance: Instance) {
  const anchor = h.anchors.get(instance);
  if (!anchor) {
    refused();
  }
  return JSON.stringify(
    await Promise.all(
      anchor.resources.container.map(async (row) => ({
        id: row.id,
        running: await h.probe([
          "container",
          "inspect",
          "--format",
          "{{.State.Running}}",
          row.id,
        ]),
      }))
    )
  );
}
async function retainedBuildContextRecovery(h: FixtureRuntime) {
  const { first, second } = h;
  if (!first.basicBuild) {
    refused();
  }
  const path = retainedBuildFixtureMarker(first.root, first.basicBuild);
  const bytes = await readFile(path);
  try {
    refusedPreview(
      await buildFixtureCli(h, first, ["up", "--detach", "--json"], true)
    );
    const receiptPath = join(
      first.root,
      ".hack/.internal/legacy-compose-adoption-v1/receipt.json"
    );
    const receiptBytes = await Bun.file(receiptPath).text();
    const receipt = object(receiptBytes);
    if (
      !isRecord(receipt.pendingOperation) ||
      receipt.pendingOperation.operation !== "start"
    ) {
      refused();
    }
    const state = await fixtureRunningIds(h, first);
    refusedPreview(
      await buildFixtureCli(h, first, ["down", "--recover", "--json"])
    );
    if (
      (await fixtureRunningIds(h, first)) !== state ||
      (await Bun.file(receiptPath).text()) !== receiptBytes
    ) {
      refused();
    }
    await assertFixtureBuildImages({ ...h, instance: first });
    await h.check(second);
  } finally {
    // The active included-context proof permits only exact bytes on the same
    // inode. Prepared authored-source timestamp repair is never exercised here.
    await writeFile(path, bytes);
  }
  successful(await buildFixtureCli(h, first, ["down", "--recover", "--json"]));
  await h.assertStopped(first);
  await h.check(second);
  successful(await buildFixtureCli(h, first, ["up", "--detach", "--json"]));
  await h.waitReady(first);
  await h.check(first, false);
  await h.check(second);
}
async function retainedBuildCandidateRefusal(h: FixtureRuntime) {
  const path = join(h.first.root, ".hack/hack.project.json");
  const original = await readFile(path);
  const candidate = object(
    new TextDecoder("utf-8", { fatal: true }).decode(original)
  );
  if (
    !(
      isRecord(candidate.services) &&
      isRecord(candidate.services.db) &&
      isRecord(candidate.services.db.build)
    )
  ) {
    refused();
  }
  candidate.services.db.build.context = "unsupported-context-edit";
  const running = await fixtureRunningIds(h, h.first);
  await writeFile(path, JSON.stringify(candidate));
  try {
    refusedPreview(
      await buildFixtureCli(h, h.first, ["up", "--detach", "--json"])
    );
    if ((await fixtureRunningIds(h, h.first)) !== running) {
      refused();
    }
    await assertFixtureBuildImages({ ...h, instance: h.first });
    await h.check(h.second);
  } finally {
    await writeFile(path, original);
  }
  await h.check(h.first, false);
}
async function rollbackRetainedBuildFixture(
  h: FixtureRuntime,
  instance: Instance
) {
  successful(await buildFixtureCli(h, instance, ["down", "--json"]));
  await h.assertStopped(instance);
  successful(
    await buildFixtureCli(h, instance, [
      "config",
      "adopt",
      "--rollback",
      "--json",
    ])
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
type BuildCleanupInputs = Pick<
  FixtureRuntime,
  | "engineId"
  | "probe"
  | "builtImages"
  | "builtImageObjects"
  | "originalImageIds"
  | "baseImage"
> & {
  readonly effect: (args: readonly string[]) => Promise<void>;
  readonly journal: (value: unknown) => Promise<void>;
};
async function requireRemainingBuildObjects(
  h: BuildCleanupInputs,
  pending: ReadonlySet<string>
) {
  await requirePreparedEngine(h);
  if (
    JSON.stringify(await fixtureImageInventory(h.probe)) !==
    JSON.stringify([...h.originalImageIds, ...pending].sort())
  ) {
    refused();
  }
  for (const [instance, rows] of h.builtImageObjects) {
    const selected = h.builtImages.get(instance);
    if (!selected) {
      refused();
    }
    for (const captured of rows) {
      if (!pending.has(captured.id)) {
        continue;
      }
      const current = retainedBuildFixtureObject({
        value: object(
          await h.probe([
            "image",
            "inspect",
            "--format",
            RETAINED_BUILD_OBJECT_FORMAT,
            captured.id,
          ])
        ),
        selected,
        originalImageIds: h.originalImageIds,
        ...(captured.composeVersion !== null
          ? { composeVersion: captured.composeVersion }
          : {}),
      });
      if (
        JSON.stringify(current) !== JSON.stringify(captured) ||
        (
          await h.probe([
            "container",
            "ls",
            "--all",
            "--no-trunc",
            "--filter",
            `ancestor=${captured.id}`,
            "--format",
            "{{.ID}}",
          ])
        ).trim()
      ) {
        refused();
      }
    }
  }
  if (
    (
      await h.probe([
        "image",
        "inspect",
        "--format",
        "{{.Id}}",
        RETAINED_BUILD_BASE_TAG,
      ])
    ).trim() !== h.baseImage
  ) {
    refused();
  }
  await requirePreparedEngine(h);
}
/** Exact captured child-before-parent disposal, never prune or general cache removal. */
export async function cleanupRetainedBuildFixtureImages(h: BuildCleanupInputs) {
  if (h.builtImages.size !== h.builtImageObjects.size) {
    refused();
  }
  const rows = [...h.builtImageObjects.values()].flat();
  const pending = new Set(rows.map((row) => row.id));
  if (
    pending.size !== rows.length ||
    rows.some((row) => h.originalImageIds.includes(row.id))
  ) {
    refused();
  }
  for (const [instance, objects] of h.builtImageObjects) {
    const selected = h.builtImages.get(instance);
    const composeVersion = selected
      ? objects.find((row) => row.id === selected.id)?.composeVersion
      : undefined;
    if (
      !selected ||
      JSON.stringify(
        retainedBuildFixtureObjectGraph({
          values: objects,
          selected,
          originalImageIds: h.originalImageIds,
          baseImage: h.baseImage,
          ...(typeof composeVersion === "string" ? { composeVersion } : {}),
        })
      ) !== JSON.stringify(objects)
    ) {
      refused();
    }
    for (const row of objects) {
      await requireRemainingBuildObjects(h, pending);
      await h.journal({
        stage: "before-image-remove",
        id: row.id,
        remaining: [...pending].sort(),
      });
      await requireRemainingBuildObjects(h, pending);
      await h.effect(["image", "rm", "--no-prune", row.id]);
      pending.delete(row.id);
      await requireRemainingBuildObjects(h, pending);
      await h.journal({
        stage: "after-image-remove",
        id: row.id,
        remaining: [...pending].sort(),
      });
    }
  }
  await requireRemainingBuildObjects(h, pending);
}
/** Basic builds qualify separately from preview; no builder is reachable after bootstrap. */
export const nativeComposeAdoptionBuildWorktreesScenario: Scenario = {
  name: "native-compose-adoption-build-worktrees",
  tier: "docker",
  requiresExplicitSelection: true,
  preserveFixtureOnFailure: true,
  summary:
    "root/specific and default .hack COPY projections retain two existing SQL volumes, images and original IDs through recovery and rollback",
  run: async (ctx) => {
    const h = createFixtureRuntime(
      await prepareFixtureInputs(ctx, { basicBuild: true })
    );
    await runWithFixtureCleanup({
      run: async () => {
        for (const instance of [h.first, h.second]) {
          await bootstrapOriginal(h, instance);
          const preview = successful(
            await buildFixtureCli(h, instance, [
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
          await buildFixtureCli(h, h.first, [
            "config",
            "adopt",
            "--recover",
            "--stop",
            "--json",
          ])
        );
        await h.assertStopped(h.first);
        await h.check(h.second);
        refusedPreview(
          await buildFixtureCli(h, h.first, ["up", "db", "--detach", "--json"])
        );
        await h.assertStopped(h.first);
        await retainedBuildContextRecovery(h);
        await retainedBuildCandidateRefusal(h);
        refusedPreview(
          await buildFixtureCli(h, h.first, ["run", "db", "--", "true"])
        );
        await h.check(h.first, false);
        await rollbackRetainedBuildFixture(h, h.first);
        await h.check(h.second);
        successful(
          await buildFixtureCli(h, h.second, [
            "config",
            "adopt",
            "--stop",
            "--json",
          ])
        );
        await h.assertStopped(h.second);
        await h.check(h.first);
        successful(
          await buildFixtureCli(h, h.second, ["up", "--detach", "--json"])
        );
        await h.waitReady(h.second);
        await h.check(h.second, false);
        await h.check(h.first);
        await rollbackRetainedBuildFixture(h, h.second);
        await h.check(h.first);
        ctx.log(
          "basic build COPY/ignore/target parity, original image/container/volume births and SQL, partial-stop/source repair and isolated rollback verified; historical image provenance and cache reclamation unqualified"
        );
      },
      cleanup: async () => {
        await cleanupOwnedAdoptionFixture({
          ...h,
          instances: [h.first, h.second],
        });
        await cleanupRetainedBuildFixtureImages({
          ...h,
          effect: async (args) => {
            await h.effect(args);
          },
          journal: async (pending) => {
            await saveFixtureBuildRecovery(h, pending);
          },
        });
      },
      secondaryFailure: () =>
        ctx.retainFixtures(
          "Retained build exact-owned cleanup failed; original resource and image evidence retained"
        ),
    });
  },
};

async function runDependencyWorktrees(
  ctx: ScenarioContext,
  ownedNetwork: boolean
) {
  const h = createFixtureRuntime(
    await prepareFixtureInputs(ctx, { dependencies: true, ownedNetwork })
  );
  const foreignCanary = { pending: false };
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
      if (ownedNetwork) {
        await foreignCanaryRefusal(h, foreignCanary);
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
      refusedPreview(await h.cli(h.first, ["up", "db", "--detach", "--json"]));
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
        ownedNetwork
          ? "owned internal bridges and started/exec-healthy ordered originals retain alias SQL, source, IDs and births through stop recovery and rollback"
          : "started/exec-healthy ordered originals, SQL/birth/IDs, unchanged-source stop recovery, active-candidate repair and isolated rollback verified"
      );
    },
    cleanup: guardedAdoptionCanaryCleanup(foreignCanary, () =>
      cleanupOwnedAdoptionFixture({ ...h, instances: [h.first, h.second] })
    ),
    secondaryFailure: () =>
      ctx.log("secondary exact-owned cleanup failed; retain fixture evidence"),
  });
}

/** Explicit selector keeps the version 5 dependency acceptance independent of the owned-bridge intersection. */
export const nativeComposeAdoptionDependencyWorktreesScenario: Scenario = {
  name: "native-compose-adoption-dependency-worktrees",
  tier: "docker",
  preserveFixtureOnFailure: true,
  summary:
    "started and exec-healthy edges preserve two linked original SQL volumes through ordered repair and rollback",
  run: (ctx) => runDependencyWorktrees(ctx, false),
};

/** Combined version 10 owner keeps original bridge, SQL and dependency order through two linked recoveries. */
export const nativeComposeAdoptionNetworkHealthWorktreesScenario: Scenario = {
  name: "native-compose-adoption-network-health-worktrees",
  tier: "docker",
  preserveFixtureOnFailure: true,
  summary:
    "owned internal bridges and healthy dependencies retain original IDs, alias SQL and rollback through linked recovery",
  run: (ctx) => runDependencyWorktrees(ctx, true),
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
export async function runWithFixtureCleanup(opts: {
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

/** An uncertain foreign-canary retirement must retain the original fixture. */
export function guardedAdoptionCanaryCleanup(
  gate: { readonly pending: boolean },
  cleanup: () => Promise<void>
): () => Promise<void> {
  return async () => {
    if (gate.pending) {
      refused();
    }
    await cleanup();
  };
}

async function runLiteralWorktrees(
  ctx: ScenarioContext,
  stringArgv: boolean,
  ownedNetwork = false,
  ownedNetworks = false
) {
  const h = createFixtureRuntime(
    await prepareFixtureInputs(ctx, { stringArgv, ownedNetwork, ownedNetworks })
  );
  const foreignCanary = { pending: false };
  await runWithFixtureCleanup({
    run: async () => {
      for (const instance of [h.first, h.second]) {
        await bootstrapOriginal(h, instance);
      }
      await checkInheritedRefusal(h);
      const local = await withholdPrimaryLocal(h);
      if (ownedNetwork || ownedNetworks) {
        await foreignCanaryRefusal(h, foreignCanary);
      }
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
    cleanup: async () => {
      // An ambiguous canary create or retirement must preserve the original data.
      if (foreignCanary.pending) {
        refused();
      }
      await cleanupOwnedAdoptionFixture({
        ...h,
        instances: [h.first, h.second],
      });
    },
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
    "owned internal bridges retain original IDs, alias DNS and linked SQL; a foreign member refuses before adoption",
  run: (ctx) => runLiteralWorktrees(ctx, false, true),
};

/** Two distinct original bridge IDs, per-bridge member sets and aliases survive adoption. */
export const nativeComposeAdoptionPluralNetworkWorktreesScenario: Scenario = {
  name: "native-compose-adoption-plural-network-worktrees",
  tier: "docker",
  preserveFixtureOnFailure: true,
  summary:
    "two owned bridges preserve original IDs, policies, alias SQL and linked data through recovery and rollback",
  run: (ctx) => runLiteralWorktrees(ctx, false, false, true),
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
