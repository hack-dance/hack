import { chmod, lstat, mkdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
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

const TIMEOUT = 180_000;
const PROJECT_LABEL = "com.docker.compose.project";
const NATIVE_PREFIX = "io.hack.native-config.";
const SYNTHETIC_VALUE = "nc04-synthetic-primary-local-value";
const SYNTHETIC_KEY = "NC04_INHERITED";
const ID = /^[a-f0-9]{64}$/;
const IMAGE = /^sha256:[a-f0-9]{64}$/;
const CREATED =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
type Kind = "container" | "network" | "volume";
type Instance = {
  readonly root: string;
  readonly name: string;
  readonly marker: string;
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
function refused(): never {
  throw new Error(
    "Adoption worktree fixture ownership or data check failed; values omitted."
  );
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
      row.configFiles !==
        join(opts.instance.root, ".hack/docker-compose.yml") ||
      JSON.stringify(row.mounts) !==
        JSON.stringify(
          row.service === "db"
            ? [
                {
                  type: "volume",
                  name: `${opts.instance.name}_data`,
                  target: "/var/lib/postgresql/data",
                  rw: true,
                },
              ]
            : []
        )
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
      row.name !== `${opts.instance.name}_default` ||
      row.logical !== "default"
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
  if (result.combined.includes(SYNTHETIC_VALUE)) {
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
async function writeLegacy(instance: Instance, image: string) {
  await mkdir(join(instance.root, ".hack"), { recursive: true });
  await Bun.write(
    join(instance.root, ".hack/hack.config.json"),
    JSON.stringify({
      name: instance.name,
      worktree: { auto_branch: false, inherit_local: true },
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
        },
        worker: {
          image,
          pull_policy: "never",
          entrypoint: ["/bin/sh", "-c"],
          command: [
            "trap 'sleep 10; exit 0' TERM; while true; do sleep 1; done",
          ],
          stop_grace_period: "15s",
        },
      },
      volumes: { data: { name: `${instance.name}_data` } },
    })
  );
}
function formats(kind: Kind): string {
  if (kind === "container") {
    return `{"id":{{json .Id}},"name":{{json .Name}},"project":{{json (index .Config.Labels "${PROJECT_LABEL}")}},"nativeNames":[{{$first := true}}{{range $name,$value := .Config.Labels}}{{if not $first}},{{end}}{{$first = false}}{{json $name}}{{end}}],"service":{{json (index .Config.Labels "com.docker.compose.service")}},"workingDir":{{json (index .Config.Labels "com.docker.compose.project.working_dir")}},"configFiles":{{json (index .Config.Labels "com.docker.compose.project.config_files")}},"mounts":[{{range $i,$m := .Mounts}}{{if $i}},{{end}}{"type":{{json $m.Type}},"name":{{json $m.Name}},"target":{{json $m.Destination}},"rw":{{json $m.RW}}}{{end}}]}`;
  }
  if (kind === "network") {
    return `{"id":{{json .Id}},"name":{{json .Name}},"createdAt":{{json .Created}},"project":{{json (index .Labels "${PROJECT_LABEL}")}},"nativeNames":[{{$first := true}}{{range $name,$value := .Labels}}{{if not $first}},{{end}}{{$first = false}}{{json $name}}{{end}}],"logical":{{json (index .Labels "com.docker.compose.network")}}}`;
  }
  return `{"name":{{json .Name}},"createdAt":{{json .CreatedAt}},"project":{{json (index .Labels "${PROJECT_LABEL}")}},"nativeNames":[{{$first := true}}{{range $name,$value := .Labels}}{{if not $first}},{{end}}{{$first = false}}{{json $name}}{{end}}],"storage":{{json (index .Labels "com.docker.compose.volume")}}}`;
}

async function prepareFixtureInputs(ctx: ScenarioContext) {
  expect({
    that: resolveCliSpawnArgs([]).length === 1,
    message:
      "Adoption acceptance requires the current compiled CLI and companion compiler",
  });
  if (process.platform !== "darwin" && process.platform !== "linux") {
    ctx.skip("requires supported native private-state host");
  }
  const boundedProbe = createNativeComposeProbe({ timeoutMs: 30_000 });
  const probe = async (args: readonly string[]) =>
    (await boundedProbe(args)).trim();
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
  };
  const second: Instance = {
    root: await addLinkedWorktree({ fixture, branch: "adoption-beta" }),
    name: `${fixture.name}-beta`,
    marker: "beta-existing-sql-row",
  };
  for (const instance of [first, second]) {
    await writeLegacy(instance, image);
    await commitAll({
      root: instance.root,
      message: "fixture: distinct original identity",
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
  const effect = async (args: readonly string[]) =>
    successful(
      await runCommand({
        argv: [engine, ...args],
        cwd: fixtureRoot,
        timeoutMs: TIMEOUT,
      })
    );
  const container = (instance: Instance, service: string) => {
    const row = anchors
      .get(instance)
      ?.resources.container.find((entry) => entry.service === service);
    if (!row) {
      refused();
    }
    return row.id;
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
    const deadline = performance.now() + 30_000;
    while (performance.now() < deadline) {
      try {
        await probe([
          "container",
          "exec",
          container(instance, "db"),
          "pg_isready",
          "-U",
          "postgres",
          "-d",
          "fixture",
        ]);
        return;
      } catch {
        await Bun.sleep(500);
      }
    }
    refused();
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
  } = h;

  for (const kind of ["container", "network", "volume"] as const) {
    if ((await list(instance, kind)).length) {
      refused();
    }
  }
  for (const [kind, name] of [
    ["volume", `${instance.name}_data`],
    ["network", `${instance.name}_default`],
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
      "--file",
      join(instance.root, ".hack/docker-compose.yml"),
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
    source: await source(instance),
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
  await sql(
    instance,
    `CREATE TABLE marker(id integer PRIMARY KEY,value text NOT NULL); INSERT INTO marker VALUES(1,'${instance.marker}')`
  );
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
  const shim = join(shimRoot, "docker");
  await Bun.write(
    shim,
    `#!${process.execPath}
const args = process.argv.slice(2);
const engine = ${JSON.stringify(engine)};
if(args[0]==="container" && args[1]==="stop") {
 if(args.length!==4 || !args.includes(${JSON.stringify(db)}) || !args.includes(${JSON.stringify(worker)})) process.exit(99);
 const state=JSON.parse(await Bun.file(${JSON.stringify(receipt)}).text());
 if(state.adoption_receipt_version!==2 || state.pendingOperation?.operation!=="stop") process.exit(98);
 const child=Bun.spawn([engine,"container","stop",${JSON.stringify(db)}],{stdin:"ignore",stdout:"ignore",stderr:"ignore"});
 if(await child.exited!==0) process.exit(97);
 await Bun.write(${JSON.stringify(control)},"journal-before-partial-stop");process.exit(71);
}
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

type CleanupInputs = Pick<
  FixtureRuntime,
  "engineId" | "anchors" | "resources" | "owned" | "effect" | "list" | "probe"
> & { readonly instances: readonly Instance[] };

async function requirePreparedEngine(h: CleanupInputs) {
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

/** Two real linked checkouts keep independent original SQL data, sources and retained resource identities. No ingress or global effects. */
export const nativeComposeAdoptionWorktreesScenario: Scenario = {
  name: "native-compose-adoption-worktrees",
  tier: "docker",
  preserveFixtureOnFailure: true,
  summary:
    "two linked original SQL volumes survive isolated adoption, repair and rollback",
  run: async (ctx) => {
    const h = createFixtureRuntime(await prepareFixtureInputs(ctx));
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
        ctx.log(
          "secondary exact-owned cleanup failed; retain fixture evidence"
        ),
    });
  },
};
