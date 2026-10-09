import { spawn } from "node:child_process";
import { lstat, mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "../../../src/lib/guards.ts";
import { legacyComposeTimestampInstant } from "../../../src/lib/native-compose-adoption-jobs.ts";
import { createNativeComposeProbe } from "../../../src/lib/native-compose-ownership.ts";
import {
  addLinkedWorktree,
  commitAll,
  createMonorepoFixture,
} from "../fixture.ts";
import {
  buildCliEnv,
  type CliResult,
  resolveCliSpawnArgs,
  type Scenario,
  type ScenarioContext,
} from "../harness.ts";
import { completedJobFixtureSources } from "./native-compose-adoption-job-inputs.ts";
import {
  createAdoptionFixtureProbe,
  waitForAdoptionFixtureSql,
} from "./native-compose-adoption-worktrees.ts";
import { proxyHasNoPublishedPorts } from "./native-config-routing.ts";

const TIMEOUT = 180_000;
const FULL_ID = /^[a-f0-9]{64}$/;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const PROJECT = "com.docker.compose.project";
const ROLES = ["db", "seed", "app"] as const;
const PHASES = [
  "prepare",
  "alpha-bootstrap",
  "beta-bootstrap",
  "alpha-adopt",
  "alpha-start-2",
  "alpha-partial-refusal",
  "alpha-down-up-3",
  "alpha-restart-4",
  "alpha-nonzero-job-5",
  "alpha-interrupt-6",
  "alpha-stop-recovery",
  "alpha-start-7",
  "alpha-rollback",
  "beta-adopt-start-2",
  "beta-rollback",
  "cleanup",
] as const;
type Phase = (typeof PHASES)[number];
type Role = (typeof ROLES)[number];
type Kind = "container" | "network" | "volume";
type Instance = {
  readonly root: string;
  readonly name: string;
  readonly marker: string;
};
type Resource = {
  readonly id: string;
  readonly service?: Role;
  readonly networkId?: string;
  readonly createdAt?: string;
};
type Source = {
  readonly config: string;
  readonly compose: string;
  readonly configInode: number;
  readonly composeInode: number;
};
type Anchor = {
  readonly source: Source;
  readonly container: readonly Resource[];
  readonly network: readonly Resource[];
  readonly volume: readonly Resource[];
};
type InterruptReadAdmission = {
  readonly pid: number;
  readonly signal: AbortSignal;
  readonly deadline: number;
};

/** Closed diagnostics never expose fixture values or replace a runtime/cleanup failure. */
export function createCompletedJobFixturePhases(
  log: (message: string) => void
) {
  let current: Phase = "prepare";
  const emit = (status: "enter" | "failed") => {
    try {
      log(`phase=${current} status=${status}`);
    } catch {
      // Diagnostics cannot skip cleanup or replace its original refusal.
    }
  };
  return Object.freeze({
    mark: (phase: unknown) => {
      if (
        typeof phase !== "string" ||
        !PHASES.some((value) => value === phase)
      ) {
        return;
      }
      current = phase as Phase;
      emit("enter");
    },
    failed: () => emit("failed"),
  });
}

/** An unfinished owned callback or child prevents teardown, even if it settles later. */
export function createCompletedJobFixtureSettlement() {
  let unconfirmed = false;
  return Object.freeze({
    markUnconfirmed: () => {
      unconfirmed = true;
    },
    assertConfirmed: () => requireValue(!unconfirmed),
  });
}

function resourceNames(instance: Instance, kind: Kind): readonly string[] {
  const names = {
    container: ROLES.map((role) => `${instance.name}-${role}-1`),
    network: [`${instance.name}_default`],
    volume: [`${instance.name}_data`],
  };
  return names[kind];
}

function refused(): never {
  throw new Error("Completed-job worktree acceptance refused; values omitted.");
}
function requireValue(value: boolean): asserts value {
  if (!value) {
    refused();
  }
}
export function completedJobFixtureObject(
  text: string
): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    refused();
  }
  if (!isRecord(value)) {
    refused();
  }
  return value;
}

/** Exact retained dependent/job-success attempts supplement fresh job exit0; row counts alone are insufficient. */
export function completedJobFixtureAppAttempts(opts: {
  readonly expected: readonly number[];
  readonly observed: string;
}): void {
  requireValue(
    opts.expected.length > 0 &&
      opts.expected.every(
        (value) => Number.isSafeInteger(value) && value > 0
      ) &&
      new Set(opts.expected).size === opts.expected.length
  );
  requireValue(opts.observed === opts.expected.join(","));
}
function successful(result: CliResult): CliResult {
  requireValue(!result.timedOut && result.exitCode === 0);
  return result;
}
function isRole(value: unknown): value is Role {
  return value === "db" || value === "seed" || value === "app";
}

/** Cleanup requires the exact original role/name/storage owner, not merely a project label. */
export function completedJobFixtureResource(opts: {
  readonly instance: Instance;
  readonly image: string;
  readonly kind: Kind;
  readonly row: unknown;
}): Resource {
  const row = opts.row;
  requireValue(
    isRecord(row) &&
      row.project === opts.instance.name &&
      Array.isArray(row.nativeNames) &&
      row.nativeNames.every(
        (name) =>
          typeof name === "string" && !name.startsWith("io.hack.native-config.")
      )
  );
  if (!isRecord(row)) {
    refused();
  }
  if (opts.kind === "container") {
    const role = row.service;
    requireValue(
      isRole(role) &&
        typeof row.id === "string" &&
        FULL_ID.test(row.id) &&
        row.name === `/${opts.instance.name}-${role}-1` &&
        row.number === "1" &&
        row.oneoff === "False" &&
        IMAGE_ID.test(opts.image) &&
        row.image === opts.image &&
        row.workingDir === join(opts.instance.root, ".hack") &&
        row.configFiles ===
          join(opts.instance.root, ".hack/docker-compose.yml") &&
        proxyHasNoPublishedPorts(row)
    );
    if (!isRole(role) || typeof row.id !== "string") {
      refused();
    }
    requireValue(
      JSON.stringify(row.mounts) ===
        JSON.stringify([
          {
            type: "volume",
            name: `${opts.instance.name}_data`,
            target: "/var/lib/postgresql/data",
            rw: role === "db",
          },
        ]) &&
        Array.isArray(row.networks) &&
        row.networks.length === 1 &&
        isRecord(row.networks[0]) &&
        row.networks[0].name === `${opts.instance.name}_default` &&
        typeof row.networks[0].id === "string" &&
        FULL_ID.test(row.networks[0].id)
    );
    const network = row.networks[0];
    if (!isRecord(network) || typeof network.id !== "string") {
      refused();
    }
    return { id: row.id, service: role, networkId: network.id };
  }
  requireValue(
    typeof row.createdAt === "string" &&
      Number.isFinite(Date.parse(row.createdAt))
  );
  if (typeof row.createdAt !== "string") {
    refused();
  }
  if (opts.kind === "network") {
    requireValue(
      typeof row.id === "string" &&
        FULL_ID.test(row.id) &&
        row.name === `${opts.instance.name}_default` &&
        row.logical === "default" &&
        row.driver === "bridge" &&
        row.internal === false
    );
    if (typeof row.id !== "string") {
      refused();
    }
    return { id: row.id, createdAt: row.createdAt };
  }
  requireValue(
    row.name === `${opts.instance.name}_data` &&
      row.storage === "data" &&
      row.driver === "local" &&
      row.options === null
  );
  return { id: `${opts.instance.name}_data`, createdAt: row.createdAt };
}

/** Historical or equivalent-spelling exit zero cannot qualify a newly started job. */
export function completedJobFixtureFreshExit(opts: {
  readonly id: string;
  readonly priorStartedAt: string;
  readonly observed: unknown;
}): void {
  const row = opts.observed;
  requireValue(isRecord(row));
  if (!isRecord(row)) {
    refused();
  }
  const prior = legacyComposeTimestampInstant(opts.priorStartedAt);
  const start =
    typeof row.startedAt === "string"
      ? legacyComposeTimestampInstant(row.startedAt)
      : undefined;
  const finish =
    typeof row.finishedAt === "string"
      ? legacyComposeTimestampInstant(row.finishedAt)
      : undefined;
  const zero = legacyComposeTimestampInstant("0001-01-01T00:00:00Z");
  requireValue(
    FULL_ID.test(opts.id) &&
      row.id === opts.id &&
      row.running === false &&
      row.paused === false &&
      row.status === "exited" &&
      row.exitCode === 0 &&
      prior !== undefined &&
      start !== undefined &&
      finish !== undefined &&
      start !== prior &&
      start !== zero &&
      finish !== zero
  );
}

/** Retained app timestamp and SQL counter jointly expose a dependent start after a failed/held job. */
export function completedJobFixtureNoDependentStart(opts: {
  readonly id: string;
  readonly before: unknown;
  readonly after: unknown;
}): void {
  const { before, after } = opts;
  requireValue(isRecord(before) && isRecord(after));
  if (!(isRecord(before) && isRecord(after))) {
    refused();
  }
  const start =
    typeof before.startedAt === "string"
      ? legacyComposeTimestampInstant(before.startedAt)
      : undefined;
  const current =
    typeof after.startedAt === "string"
      ? legacyComposeTimestampInstant(after.startedAt)
      : undefined;
  requireValue(
    FULL_ID.test(opts.id) &&
      before.id === opts.id &&
      after.id === opts.id &&
      before.running === false &&
      after.running === false &&
      after.paused === false &&
      after.status === "exited" &&
      start !== undefined &&
      current === start
  );
}

function format(kind: Kind): string {
  const labels = kind === "container" ? ".Config.Labels" : ".Labels";
  const common = `"project":{{json (index ${labels} "${PROJECT}")}},"nativeNames":[{{$first := true}}{{range $name,$value := ${labels}}}{{if not $first}},{{end}}{{$first = false}}{{json $name}}{{end}}]`;
  if (kind === "container") {
    return `{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Image}},${common},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"number":{{json (index .Config.Labels "com.docker.compose.container-number")}},"oneoff":{{json (index .Config.Labels "com.docker.compose.oneoff")}},"workingDir":{{json (index .Config.Labels "com.docker.compose.project.working_dir")}},"configFiles":{{json (index .Config.Labels "com.docker.compose.project.config_files")}},"ports":{{json .HostConfig.PortBindings}},"publishAll":{{json .HostConfig.PublishAllPorts}},"runtimePorts":{{json .NetworkSettings.Ports}},"mounts":[{{range $i,$m := .Mounts}}{{if $i}},{{end}}{"type":{{json $m.Type}},"name":{{json $m.Name}},"target":{{json $m.Destination}},"rw":{{json $m.RW}}}{{end}}],"networks":[{{$first := true}}{{range $name,$n := .NetworkSettings.Networks}}{{if not $first}},{{end}}{{$first = false}}{"name":{{json $name}},"id":{{json $n.NetworkID}}}{{end}}]}`;
  }
  if (kind === "network") {
    return `{"id":{{json .Id}},"name":{{json .Name}},${common},"createdAt":{{json .Created}},"logical":{{json (index .Labels "com.docker.compose.network")}},"driver":{{json .Driver}},"internal":{{json .Internal}}}`;
  }
  return `{"name":{{json .Name}},${common},"createdAt":{{json .CreatedAt}},"storage":{{json (index .Labels "com.docker.compose.volume")}},"driver":{{json .Driver}},"options":{{json .Options}}}`;
}
const STATE =
  '{"id":{{json .Id}},"running":{{json .State.Running}},"paused":{{json .State.Paused}},"status":{{json .State.Status}},"exitCode":{{json .State.ExitCode}},"startedAt":{{json .State.StartedAt}},"finishedAt":{{json .State.FinishedAt}}}';

async function source(instance: Instance): Promise<Source> {
  const config = join(instance.root, ".hack/hack.config.json");
  const compose = join(instance.root, ".hack/docker-compose.yml");
  const [configInfo, composeInfo] = await Promise.all([
    lstat(config),
    lstat(compose),
  ]);
  requireValue(
    configInfo.isFile() &&
      !configInfo.isSymbolicLink() &&
      composeInfo.isFile() &&
      !composeInfo.isSymbolicLink()
  );
  return {
    config: await readFile(config, "utf8"),
    compose: await readFile(compose, "utf8"),
    configInode: configInfo.ino,
    composeInode: composeInfo.ino,
  };
}
async function prepare(ctx: ScenarioContext) {
  requireValue(resolveCliSpawnArgs([]).length === 1);
  const probe = createAdoptionFixtureProbe();
  const engine = Bun.which("docker");
  if (!engine) {
    ctx.skip("Docker executable unavailable");
  }
  const engineId = await probe(["info", "--format", "{{json .ID}}"]);
  const parsedEngine: unknown = JSON.parse(engineId);
  requireValue(
    typeof parsedEngine === "string" &&
      parsedEngine.length > 0 &&
      parsedEngine.length <= 256
  );
  requireValue(
    (await probe(["info", "--format", "{{.OSType}}"])).trim() === "linux"
  );
  await probe(["compose", "version"]);
  const image = await probe([
    "image",
    "inspect",
    "postgres:17.6-alpine",
    "--format",
    "{{.Id}}",
  ]);
  requireValue(IMAGE_ID.test(image));
  const fixture = await createMonorepoFixture({
    parentDir: ctx.tempRoot,
    withHackConfig: false,
  });
  const write = async (instance: Instance) => {
    const authored = completedJobFixtureSources({ ...instance, image });
    await mkdir(join(instance.root, ".hack"), { recursive: true });
    await Bun.write(
      join(instance.root, ".hack/hack.config.json"),
      JSON.stringify(authored.config)
    );
    await Bun.write(
      join(instance.root, ".hack/docker-compose.yml"),
      JSON.stringify(authored.compose)
    );
    await commitAll({
      root: instance.root,
      message: "fixture: explicit retained completed job",
    });
  };
  await write({
    root: fixture.root,
    name: `${fixture.name}-main`,
    marker: "unused-primary",
  });
  const first = {
    root: await addLinkedWorktree({ fixture, branch: "completed-alpha" }),
    name: `${fixture.name}-alpha`,
    marker: "alpha-original-seed",
  };
  const second = {
    root: await addLinkedWorktree({ fixture, branch: "completed-beta" }),
    name: `${fixture.name}-beta`,
    marker: "beta-original-seed",
  };
  await write(first);
  await write(second);
  return {
    ctx,
    probe,
    engine,
    engineId,
    image,
    first,
    second,
    fixtureRoot: fixture.root,
  };
}

function runtime(input: Awaited<ReturnType<typeof prepare>>) {
  const { ctx, probe: initialProbe, engine, engineId, fixtureRoot } = input;
  const anchors = new Map<Instance, Anchor>();
  const settlement = createCompletedJobFixtureSettlement();
  let readAdmission: InterruptReadAdmission | undefined;
  const readBudget = () => {
    if (readAdmission === undefined) {
      return 30_000;
    }
    const remaining = readAdmission.deadline - Date.now();
    requireValue(!readAdmission.signal.aborted && remaining > 0);
    return Math.min(30_000, remaining);
  };
  const probe = async (args: readonly string[]) => {
    const admission = readAdmission;
    if (admission === undefined) {
      return await initialProbe(args);
    }
    const value = await createNativeComposeProbe({
      signal: admission.signal,
      timeoutMs: readBudget(),
    })(args);
    readBudget();
    return value.trim();
  };
  const withReadAdmission = async (
    admission: InterruptReadAdmission,
    read: () => Promise<void>
  ) => {
    requireValue(readAdmission === undefined);
    readAdmission = admission;
    try {
      readBudget();
      await read();
      readBudget();
    } finally {
      readAdmission = undefined;
    }
  };
  const env = buildCliEnv({
    hackHome: ctx.hackHome,
    extra: { HACK_RUNTIME_BACKEND: "compose", CI: "", HACK_EXECUTION_MODE: "" },
  });
  const freshEngine = async () =>
    requireValue(
      (await probe(["info", "--format", "{{json .ID}}"])) === engineId
    );
  let commandCapture = 0;
  const captured = async (argv: readonly string[], cwd: string) => {
    commandCapture += 1;
    return await captureCompletedJobFixtureCommand({
      argv,
      cwd,
      env,
      captures: join(ctx.hackHome, `job-command-${commandCapture}`),
      timeoutMs: TIMEOUT,
      onUnconfirmed: settlement.markUnconfirmed,
    });
  };
  const effect = async (argv: readonly string[]) => {
    await freshEngine();
    return successful(await captured([engine, ...argv], fixtureRoot));
  };
  const cli = async (instance: Instance, args: readonly string[]) => {
    await freshEngine();
    return await captured(resolveCliSpawnArgs(args), instance.root);
  };
  const list = async (instance: Instance, kind: Kind) =>
    (
      await probe([
        kind,
        "ls",
        ...(kind === "container" ? ["--all"] : []),
        ...(kind === "volume" ? [] : ["--no-trunc"]),
        "--filter",
        `label=${PROJECT}=${instance.name}`,
        "--format",
        kind === "volume" ? "{{.Name}}" : "{{.ID}}",
      ])
    )
      .split(/\s+/)
      .filter(Boolean);
  const owned = async (instance: Instance, kind: Kind, id: string) =>
    completedJobFixtureResource({
      instance,
      image: input.image,
      kind,
      row: completedJobFixtureObject(
        await probe([kind, "inspect", "--format", format(kind), id])
      ),
    });
  const resources = async (instance: Instance) => {
    const value: {
      container: Resource[];
      network: Resource[];
      volume: Resource[];
    } = { container: [], network: [], volume: [] };
    for (const kind of ["container", "network", "volume"] as const) {
      for (const id of await list(instance, kind)) {
        value[kind].push(await owned(instance, kind, id));
      }
      value[kind].sort((a, b) => a.id.localeCompare(b.id));
    }
    if (value.container.length > 0) {
      requireValue(
        value.network.length === 1 &&
          value.container.every(
            (item) => item.networkId === value.network[0]?.id
          )
      );
    }
    return value;
  };
  const id = (instance: Instance, role: Role) => {
    const item = anchors
      .get(instance)
      ?.container.find((row) => row.service === role);
    if (!item) {
      refused();
    }
    return item.id;
  };
  const sameResources = async (instance: Instance) => {
    const anchor = anchors.get(instance);
    requireValue(anchor !== undefined);
    if (!anchor) {
      refused();
    }
    const current = await resources(instance);
    requireValue(
      JSON.stringify(current) ===
        JSON.stringify({
          container: anchor.container,
          network: anchor.network,
          volume: anchor.volume,
        })
    );
  };
  const state = async (instance: Instance, role: Role) => {
    await sameResources(instance);
    return completedJobFixtureObject(
      await probe([
        "container",
        "inspect",
        "--format",
        STATE,
        id(instance, role),
      ])
    );
  };
  const sql = async (instance: Instance, query: string) => {
    await sameResources(instance);
    return await probe([
      "container",
      "exec",
      id(instance, "db"),
      "psql",
      "-U",
      "postgres",
      "-d",
      "fixture",
      "-At",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      query,
    ]);
  };
  const waitSql = async (instance: Instance, query: string, expected: string) =>
    await waitForAdoptionFixtureSql({
      read: () => sql(instance, query),
      expected,
      now: () => {
        readBudget();
        return performance.now();
      },
    });
  const counts = async (
    instance: Instance,
    attempts: number,
    expected: readonly number[]
  ) => {
    await sameResources(instance);
    requireValue(
      (await sql(instance, "SELECT value FROM marker WHERE id=1")) ===
        instance.marker
    );
    requireValue(
      (await sql(instance, "SELECT count(*) FROM job_attempts")) ===
        String(attempts)
    );
    requireValue(
      (await sql(instance, "SELECT count(*) FROM app_starts")) ===
        String(expected.length)
    );
    for (const table of ["app_starts", "job_successes"]) {
      completedJobFixtureAppAttempts({
        expected,
        observed: await sql(
          instance,
          `SELECT COALESCE(string_agg(attempt::text, ',' ORDER BY ${table === "app_starts" ? "id" : "attempt"}),'') FROM ${table}`
        ),
      });
    }
  };
  const receipt = async (instance: Instance) => {
    readBudget();
    const value = await readFile(
      join(
        instance.root,
        ".hack/.internal/legacy-compose-adoption-v1/receipt.json"
      ),
      { encoding: "utf8", signal: readAdmission?.signal }
    );
    readBudget();
    return completedJobFixtureObject(value);
  };
  const pending = async (instance: Instance, operation: "start" | null) => {
    const saved = await receipt(instance);
    requireValue(
      saved.adoption_receipt_version === 7 &&
        isRecord(saved.publication) &&
        saved.publication.phase === "active"
    );
    requireValue(
      operation === null
        ? saved.pendingOperation === null
        : isRecord(saved.pendingOperation) &&
            saved.pendingOperation.operation === operation
    );
  };
  const stopped = async (instance: Instance) => {
    await sameResources(instance);
    for (const role of ROLES) {
      const current = await state(instance, role);
      requireValue(
        current.running === false &&
          current.paused === false &&
          current.status === "exited"
      );
    }
  };
  const unclaimed = async (instance: Instance) => {
    for (const kind of ["container", "network", "volume"] as const) {
      requireValue((await list(instance, kind)).length === 0);
      for (const name of resourceNames(instance, kind)) {
        requireValue(
          !(
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
        );
      }
    }
  };
  const bootstrap = async (instance: Instance) => {
    await unclaimed(instance);
    const authored = await source(instance);
    let started: CliResult | undefined;
    try {
      started = await effect([
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
      ]);
    } finally {
      const captured = await resources(instance);
      anchors.set(instance, { source: authored, ...captured });
      await Bun.write(
        join(ctx.hackHome, `${instance.name}-anchor.json`),
        JSON.stringify(anchors.get(instance))
      );
    }
    requireValue(started !== undefined);
    const anchor = anchors.get(instance);
    requireValue(
      anchor?.container.length === 3 &&
        anchor.network.length === 1 &&
        anchor.volume.length === 1 &&
        new Set(anchor.container.map((row) => row.service)).size === 3
    );
    await waitSql(instance, "SELECT count(*) FROM app_starts", "1");
    await counts(instance, 1, [1]);
    const seed = await state(instance, "seed");
    requireValue(
      seed.running === false && seed.exitCode === 0 && seed.status === "exited"
    );
  };
  const freshUp = async (
    instance: Instance,
    attempts: number,
    expected: readonly number[],
    restart = false
  ) => {
    const previous = await state(instance, "seed");
    requireValue(typeof previous.startedAt === "string");
    successful(
      await cli(
        instance,
        restart ? ["restart", "--json"] : ["up", "--detach", "--json"]
      )
    );
    const current = await state(instance, "seed");
    if (typeof previous.startedAt !== "string") {
      refused();
    }
    completedJobFixtureFreshExit({
      id: id(instance, "seed"),
      priorStartedAt: previous.startedAt,
      observed: current,
    });
    await pending(instance, null);
    await waitSql(
      instance,
      "SELECT count(*) FROM app_starts",
      String(expected.length)
    );
    await counts(instance, attempts, expected);
  };
  const control = async (
    instance: Instance,
    mode: "success" | "fail" | "hold"
  ) => {
    await sql(instance, `UPDATE control SET mode='${mode}' WHERE id=1`);
    requireValue(
      (await sql(instance, "SELECT mode FROM control WHERE id=1")) === mode
    );
  };
  return {
    ...input,
    env,
    anchors,
    freshEngine,
    effect,
    cli,
    list,
    owned,
    resources,
    id,
    sameResources,
    state,
    sql,
    waitSql,
    counts,
    receipt,
    pending,
    stopped,
    bootstrap,
    freshUp,
    control,
    withReadAdmission,
    markChildUnconfirmed: settlement.markUnconfirmed,
    assertChildrenSettled: settlement.assertConfirmed,
  };
}
type Runtime = ReturnType<typeof runtime>;

async function stop(h: Runtime, instance: Instance, recover = false) {
  successful(
    await h.cli(instance, ["down", ...(recover ? ["--recover"] : []), "--json"])
  );
  await h.stopped(instance);
  await h.pending(instance, null);
}

/**
 * Exit plus both inherited pipe EOFs releases the just-launched group owner.
 * Leader exit alone never authorizes a former-group signal or fixture teardown.
 */
type CompletedJobCaptureOptions = {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly captures: string;
  readonly timeoutMs: number;
  readonly beforeInterrupt?: (
    admission: InterruptReadAdmission
  ) => Promise<void>;
  readonly onUnconfirmed: () => void;
};

/** Ordinary effects and CLI calls reuse the interruption owner, including exit/EOF and fresh captured-group absence. */
export async function captureCompletedJobFixtureCommand(
  opts: Omit<CompletedJobCaptureOptions, "beforeInterrupt">
): Promise<CliResult> {
  return await captureCompletedJobFixtureChild({
    ...opts,
    beforeInterrupt: undefined,
  });
}

export async function captureCompletedJobFixtureInterrupt(
  opts: CompletedJobCaptureOptions & {
    readonly beforeInterrupt: NonNullable<
      CompletedJobCaptureOptions["beforeInterrupt"]
    >;
  }
): Promise<void> {
  await captureCompletedJobFixtureChild(opts);
}

async function captureCompletedJobFixtureChild(
  opts: CompletedJobCaptureOptions
): Promise<CliResult> {
  const started = Date.now();
  const snapshot = Object.freeze({
    argv: Object.freeze([...opts.argv]),
    cwd: opts.cwd,
    env: Object.freeze({ ...opts.env }),
    captures: opts.captures,
    timeoutMs: opts.timeoutMs,
    beforeInterrupt: opts.beforeInterrupt,
    onUnconfirmed: opts.onUnconfirmed,
    deadline: Date.now() + opts.timeoutMs,
  });
  const [executable, ...argv] = snapshot.argv;
  requireValue(
    typeof executable === "string" &&
      executable.startsWith("/") &&
      Number.isSafeInteger(snapshot.timeoutMs) &&
      snapshot.timeoutMs > 0 &&
      snapshot.timeoutMs <= TIMEOUT
  );
  let ownerStarted = false;
  const output = await open(`${snapshot.captures}.stdout`, "wx", 0o600);
  try {
    const errors = await open(`${snapshot.captures}.stderr`, "wx", 0o600);
    try {
      requireValue(snapshot.deadline > Date.now());
      ownerStarted = true;
      const exitCode = await captureInterruptedPipes({
        ...snapshot,
        executable,
        args: argv,
        output,
        errors,
      });
      const stdout = await readFile(`${snapshot.captures}.stdout`, "utf8"),
        stderr = await readFile(`${snapshot.captures}.stderr`, "utf8");
      requireValue(snapshot.deadline > Date.now());
      return {
        command: "owned completed-job fixture command",
        exitCode,
        stdout,
        stderr,
        combined: stdout + stderr,
        timedOut: false,
        durationMs: Date.now() - started,
      };
    } finally {
      if (!ownerStarted) {
        errors.close().catch(snapshot.onUnconfirmed);
      }
    }
  } finally {
    if (!ownerStarted) {
      output.close().catch(snapshot.onUnconfirmed);
    }
  }
}

async function captureInterruptedPipes(
  opts: CompletedJobCaptureOptions & {
    readonly deadline: number;
    readonly executable: string;
    readonly args: readonly string[];
    readonly output: Awaited<ReturnType<typeof open>>;
    readonly errors: Awaited<ReturnType<typeof open>>;
  }
): Promise<number> {
  const child = spawn(opts.executable, [...opts.args], {
    cwd: opts.cwd,
    env: { ...opts.env },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdoutStream = child.stdout,
    stderrStream = child.stderr;
  requireValue(stdoutStream !== null && stderrStream !== null);
  let leaderExited = false;
  let capturedExitCode: number | null = null;
  let capturedExitSignal: NodeJS.Signals | null = null;
  let openPipes = 2;
  let settled = false;
  let timedOut = false;
  let oversized = false;
  let groupFailure = false;
  let captureFailure = false;
  let stopRequested = false;
  let remaining = 524_288;
  const stopOwned = () => {
    // Open inherited pipes retain settlement work, never a former leader's PGID authority.
    if (stopRequested || settled || leaderExited) {
      return;
    }
    stopRequested = true;
    if (child.pid === undefined) {
      return;
    }
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error: unknown) {
      if (!(isRecord(error) && error.code === "ESRCH")) {
        groupFailure = true;
        opts.onUnconfirmed();
        if (!leaderExited) {
          child.kill("SIGKILL");
        }
      }
    }
  };
  const exited = new Promise<number>((resolveExit, reject) => {
    child.once("error", () => {
      leaderExited = true;
      reject(new Error("Completed-job capture refused; values omitted."));
    });
    child.once("exit", (code, signal) => {
      leaderExited = true;
      capturedExitCode = code;
      capturedExitSignal = signal;
      resolveExit(code ?? 128);
    });
  });
  const capture = async (
    stream: NonNullable<typeof child.stdout>,
    file: Awaited<ReturnType<typeof open>>
  ) => {
    try {
      for await (const raw of stream) {
        requireValue(Buffer.isBuffer(raw));
        const count = Math.min(raw.length, remaining);
        remaining -= count;
        if (count < raw.length) {
          oversized = true;
          stopOwned();
        }
        if (count > 0) {
          requireValue(
            (await file.write(raw.subarray(0, count))).bytesWritten === count
          );
        }
      }
    } catch {
      captureFailure = true;
      stopOwned();
      throw new Error("Completed-job capture refused; values omitted.");
    } finally {
      openPipes -= 1;
    }
  };
  const stdout = capture(stdoutStream, opts.output);
  const stderr = capture(stderrStream, opts.errors);
  const all = Promise.all([exited, stdout, stderr]).then(([code]) => {
    settled = true;
    return code;
  });
  all.catch(() => undefined);
  const admission = new AbortController();
  let outstandingPhase = 0;
  let expire: (() => void) | undefined;
  const expired = new Promise<never>((_, reject) => {
    expire = () =>
      reject(
        new Error("Completed-job capture deadline expired; values omitted.")
      );
  });
  expired.catch(() => undefined);
  const timer = setTimeout(
    () => {
      timedOut = true;
      admission.abort();
      stopOwned();
      expire?.();
    },
    Math.max(0, opts.deadline - Date.now())
  );
  const beforeDeadline = async (work: () => Promise<unknown>) => {
    requireValue(!admission.signal.aborted && opts.deadline > Date.now());
    outstandingPhase += 1;
    const pending = Promise.resolve()
      .then(() => {
        requireValue(!admission.signal.aborted && opts.deadline > Date.now());
        return work();
      })
      .finally(() => {
        outstandingPhase -= 1;
      });
    try {
      await Promise.race([pending, expired]);
    } catch (error: unknown) {
      if (outstandingPhase > 0) {
        opts.onUnconfirmed();
      }
      throw error;
    }
  };
  const confirmSettlement = async () => {
    const settlementDeadline = Date.now() + 2000;
    let settlementTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          await Promise.allSettled([exited, stdout, stderr]);
          requireValue(settlementDeadline > Date.now());
          requireValue(
            leaderExited && openPipes === 0 && !captureFailure && !groupFailure
          );
          requireValue(child.pid !== undefined);
          for (const identity of [child.pid, -child.pid]) {
            let absent = false;
            try {
              // Read-only existence probe; an exited leader grants no former-group signal authority.
              process.kill(identity, 0);
            } catch (error: unknown) {
              if (isRecord(error) && error.code === "ESRCH") {
                absent = true;
              } else {
                throw error;
              }
            }
            requireValue(absent);
          }
          // Flush/close the capture handles inside the same settlement budget.
          await Promise.all([opts.output.close(), opts.errors.close()]);
          requireValue(settlementDeadline > Date.now());
          await Bun.write(
            `${opts.captures}.settlement.json`,
            JSON.stringify({
              authority: "observation-only",
              completionRequires: "successful-return-and-live-settlement-gate",
              pid: child.pid,
              pgid: child.pid,
              exitCode: capturedExitCode,
              exitSignal: capturedExitSignal,
              leaderExited,
              stdoutEof: true,
              stderrEof: true,
              capturedLeaderAbsent: true,
              capturedGroupAbsent: true,
              scope: "captured-child-group",
              interrupted: timedOut || oversized,
              callbackSettled: outstandingPhase === 0,
            })
          );
          requireValue(settlementDeadline > Date.now());
        })(),
        new Promise<never>((_, reject) => {
          settlementTimer = setTimeout(
            () =>
              reject(
                new Error("Completed-job settlement refused; values omitted.")
              ),
            Math.max(0, settlementDeadline - Date.now())
          );
        }),
      ]);
    } catch {
      opts.onUnconfirmed();
      stdoutStream.destroy();
      stderrStream.destroy();
      // A FileHandle.write already in progress cannot be canceled by destroying its stream.
      // Keep its rejection handled, but never extend this settlement deadline to await it.
      Promise.allSettled([stdout, stderr])
        .then(() =>
          Promise.allSettled([opts.output.close(), opts.errors.close()])
        )
        .catch(() => undefined);
      throw new Error("Completed-job settlement refused; values omitted.");
    } finally {
      if (settlementTimer !== undefined) {
        clearTimeout(settlementTimer);
      }
    }
  };
  let code: number | undefined;
  try {
    requireValue(child.pid !== undefined);
    const readAdmission = Object.freeze({
      pid: child.pid,
      signal: admission.signal,
      deadline: opts.deadline,
    });
    await beforeDeadline(
      async () =>
        await Bun.write(
          `${opts.captures}.owner.json`,
          JSON.stringify({
            pid: readAdmission.pid,
            pgid: readAdmission.pid,
            executable: opts.executable,
            phase: "captured-child",
            groupAuthority: "live-leader-only",
          })
        )
    );
    const beforeInterrupt = opts.beforeInterrupt;
    if (beforeInterrupt) {
      await beforeDeadline(() => beforeInterrupt(readAdmission));
      requireValue(
        !(
          leaderExited ||
          settled ||
          timedOut ||
          oversized ||
          admission.signal.aborted
        ) && opts.deadline > Date.now()
      );
      child.kill("SIGINT");
    }
    code = await Promise.race([all, expired]);
    requireValue((!beforeInterrupt || code !== 0) && !timedOut && !oversized);
  } finally {
    if (outstandingPhase > 0) {
      opts.onUnconfirmed();
    }
    stopOwned();
    try {
      await confirmSettlement();
    } finally {
      admission.abort();
      clearTimeout(timer);
    }
  }
  requireValue(
    code !== undefined && !timedOut && !oversized && opts.deadline > Date.now()
  );
  return code;
}

async function interruptedStart(h: Runtime, instance: Instance) {
  await h.freshEngine();
  const beforeApp = await h.state(instance, "app");
  await captureCompletedJobFixtureInterrupt({
    argv: resolveCliSpawnArgs(["up", "--detach", "--json"]),
    cwd: instance.root,
    env: h.env,
    captures: join(h.ctx.hackHome, "interrupted-job"),
    timeoutMs: TIMEOUT,
    onUnconfirmed: h.markChildUnconfirmed,
    beforeInterrupt: async (admission) =>
      await h.withReadAdmission(admission, async () => {
        await h.waitSql(instance, "SELECT count(*) FROM job_attempts", "6");
        await h.pending(instance, "start");
        requireValue(
          (await h.state(instance, "seed")).running === true &&
            (await h.state(instance, "app")).running === false
        );
      }),
  });
  await h.pending(instance, "start");
  await h.counts(instance, 6, [1, 2, 3, 4]);
  completedJobFixtureNoDependentStart({
    id: h.id(instance, "app"),
    before: beforeApp,
    after: await h.state(instance, "app"),
  });
}

async function rollback(
  h: Runtime,
  instance: Instance,
  attempts: number,
  expected: readonly number[]
) {
  await stop(h, instance);
  successful(
    await h.cli(instance, ["config", "adopt", "--rollback", "--json"])
  );
  requireValue(
    JSON.stringify(await source(instance)) ===
      JSON.stringify(h.anchors.get(instance)?.source)
  );
  requireValue(
    !(await Bun.file(join(instance.root, ".hack/hack.project.json")).exists())
  );
  const saved = await h.receipt(instance);
  requireValue(
    isRecord(saved.publication) &&
      saved.publication.phase === "rolled-back" &&
      saved.pendingOperation === null
  );
  await h.effect(["container", "start", h.id(instance, "db")]);
  await h.waitSql(instance, "SELECT 1", "1");
  await h.counts(instance, attempts, expected);
  // Only the DB is started for retained-data observation; this must not replay the stopped job/app.
  requireValue(
    (await h.state(instance, "seed")).running === false &&
      (await h.state(instance, "app")).running === false
  );
}

async function retireSavedOwner(h: Runtime, instance: Instance) {
  const path = join(
    instance.root,
    ".hack/.internal/legacy-compose-adoption-v1/receipt.json"
  );
  if (await Bun.file(path).exists()) {
    const saved = await h.receipt(instance);
    if (isRecord(saved.publication) && saved.publication.phase === "active") {
      await stop(h, instance, true);
    } else if (
      !(
        isRecord(saved.publication) &&
        saved.publication.phase === "rolled-back" &&
        saved.pendingOperation === null
      )
    ) {
      successful(
        await h.cli(instance, [
          "config",
          "adopt",
          "--recover",
          "--stop",
          "--json",
        ])
      );
    }
  }
}

async function requireAbsent(h: Runtime, instance: Instance) {
  for (const kind of ["container", "network", "volume"] as const) {
    requireValue((await h.list(instance, kind)).length === 0);
  }
}

async function cleanupInstance(h: Runtime, instance: Instance) {
  const anchor = h.anchors.get(instance);
  if (!anchor) {
    await requireAbsent(h, instance);
    return;
  }
  await h.sameResources(instance);
  await retireSavedOwner(h, instance);
  await h.sameResources(instance);
  for (const role of [...ROLES].reverse()) {
    await h.owned(instance, "container", h.id(instance, role));
    const current = await h.state(instance, role);
    if (current.running === true) {
      await h.effect(["container", "stop", h.id(instance, role)]);
    }
    const after = await h.state(instance, role);
    requireValue(after.running === false && after.paused === false);
  }
  await h.sameResources(instance);
  for (const original of anchor.container) {
    requireValue(
      JSON.stringify(await h.owned(instance, "container", original.id)) ===
        JSON.stringify(original)
    );
    await h.effect(["container", "rm", original.id]);
  }
  for (const original of anchor.network) {
    requireValue(
      JSON.stringify(await h.owned(instance, "network", original.id)) ===
        JSON.stringify(original)
    );
    requireValue(
      (await h.probe([
        "network",
        "inspect",
        "--format",
        "{{len .Containers}}",
        original.id,
      ])) === "0"
    );
    await h.effect(["network", "rm", original.id]);
  }
  for (const original of anchor.volume) {
    requireValue(
      JSON.stringify(await h.owned(instance, "volume", original.id)) ===
        JSON.stringify(original)
    );
    requireValue(
      !(
        await h.probe([
          "container",
          "ls",
          "--all",
          "--filter",
          `volume=${original.id}`,
          "--format",
          "{{.ID}}",
        ])
      ).trim()
    );
    await h.effect(["volume", "rm", original.id]);
  }
  await requireAbsent(h, instance);
}

async function cleanup(h: Runtime) {
  h.assertChildrenSettled();
  await h.freshEngine();
  for (const instance of [h.first, h.second]) {
    await cleanupInstance(h, instance);
  }
}

/** Live retained-ID job acceptance. No routes, published ports, generated/managed sources, profile or custom-network claim. */
export const nativeComposeAdoptionJobWorktreesScenario: Scenario = {
  name: "native-compose-adoption-job-worktrees",
  tier: "docker",
  preserveFixtureOnFailure: true,
  summary:
    "fresh completed jobs preserve two worktree SQL seeds through ordered start, cancellation, recovery and rollback",
  run: async (ctx) => {
    const phases = createCompletedJobFixturePhases(ctx.log);
    phases.mark("prepare");
    const h = runtime(await prepare(ctx));
    let failed = false;
    let failure: unknown;
    try {
      for (const instance of [h.first, h.second]) {
        phases.mark(
          instance === h.first ? "alpha-bootstrap" : "beta-bootstrap"
        );
        await h.bootstrap(instance);
      }
      const first = h.first,
        second = h.second;
      phases.mark("alpha-adopt");
      successful(await h.cli(first, ["config", "adopt", "--stop", "--json"]));
      await h.stopped(first);
      await h.pending(first, null);
      await h.counts(second, 1, [1]);
      phases.mark("alpha-start-2");
      await h.freshUp(first, 2, [1, 2]);
      await h.counts(second, 1, [1]);
      phases.mark("alpha-partial-refusal");
      const partial = await h.cli(first, ["up", "seed", "--detach", "--json"]);
      requireValue(!partial.timedOut && partial.exitCode !== 0);
      await h.pending(first, null);
      await h.counts(first, 2, [1, 2]);
      phases.mark("alpha-down-up-3");
      await stop(h, first);
      await h.freshUp(first, 3, [1, 2, 3]);
      phases.mark("alpha-restart-4");
      await h.freshUp(first, 4, [1, 2, 3, 4], true);
      await h.counts(second, 1, [1]);
      phases.mark("alpha-nonzero-job-5");
      await h.control(first, "fail");
      await stop(h, first);
      const beforeApp = await h.state(first, "app");
      const denied = await h.cli(first, ["up", "--detach", "--json"]);
      requireValue(!denied.timedOut && denied.exitCode !== 0);
      await h.pending(first, "start");
      const job = await h.state(first, "seed");
      requireValue(
        job.running === false && job.status === "exited" && job.exitCode === 17
      );
      requireValue((await h.state(first, "app")).running === false);
      completedJobFixtureNoDependentStart({
        id: h.id(first, "app"),
        before: beforeApp,
        after: await h.state(first, "app"),
      });
      await h.counts(first, 5, [1, 2, 3, 4]);
      phases.mark("alpha-interrupt-6");
      await h.control(first, "hold");
      await stop(h, first, true);
      await interruptedStart(h, first);
      phases.mark("alpha-stop-recovery");
      await h.control(first, "success");
      await stop(h, first, true);
      // Recovery must not start a job; inspect its retained attempt count after a DB-only observation start.
      await h.effect(["container", "start", h.id(first, "db")]);
      await h.waitSql(first, "SELECT 1", "1");
      await h.counts(first, 6, [1, 2, 3, 4]);
      requireValue(
        (await h.state(first, "seed")).running === false &&
          (await h.state(first, "app")).running === false
      );
      phases.mark("alpha-start-7");
      await h.freshUp(first, 7, [1, 2, 3, 4, 7]);
      await h.counts(second, 1, [1]);
      phases.mark("alpha-rollback");
      await rollback(h, first, 7, [1, 2, 3, 4, 7]);
      phases.mark("beta-adopt-start-2");
      successful(await h.cli(second, ["config", "adopt", "--stop", "--json"]));
      await h.stopped(second);
      await h.freshUp(second, 2, [1, 2]);
      await h.counts(first, 7, [1, 2, 3, 4, 7]);
      phases.mark("beta-rollback");
      await rollback(h, second, 2, [1, 2]);
      await h.counts(first, 7, [1, 2, 3, 4, 7]);
      ctx.log(
        "fresh job exit0, seed-once SQL, no dependent start on17, pending cancellation, no-replay stop recovery and isolated retained-ID rollback verified"
      );
    } catch (error: unknown) {
      phases.failed();
      failed = true;
      failure = error;
    }
    phases.mark("cleanup");
    try {
      await cleanup(h);
    } catch (error: unknown) {
      phases.failed();
      ctx.retainFixtures(
        "Exact completed-job fixture cleanup is incomplete; original owner evidence retained"
      );
      if (!failed) {
        throw error;
      }
    }
    if (failed) {
      throw failure;
    }
  },
};
