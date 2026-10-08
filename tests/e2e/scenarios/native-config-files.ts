import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { PROJECT_ENV_KEY_FILENAME } from "../../../src/constants.ts";
import { isRecord } from "../../../src/lib/guards.ts";
import { parseNativeComposeFileReference } from "../../../src/lib/native-compose-file-state.ts";
import { openNativeComposeGenerationStore } from "../../../src/lib/native-compose-generation.ts";
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
  type Scenario,
  type ScenarioContext,
  seedIsolatedHackHome,
} from "../harness.ts";
import {
  observeNativeComposeFixture,
  runWithOwnedCleanup,
} from "../native-compose-owned-fixture.ts";

const SPACE = /\s+/;
const ID = /^[a-f0-9]{64}$/;
const IMAGE = /^sha256:[a-f0-9]{64}$/;
const TIMEOUT = 90_000;
const TOKEN_VALUE = "synthetic-file-secret-$-no-newline";
const BINARY = Buffer.from([0, 255, 4, 10]);
const TARGET = "/etc/settings-${LITERAL}$";
const FORMATS = {
  container:
    '{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Image}},"createdAt":{{json .Created}},"running":{{json .State.Running}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"owner":{{json (index .Config.Labels "io.hack.native-config.owner")}},"instance":{{json (index .Config.Labels "io.hack.native-config.instance")}},"ports":{{json .HostConfig.PortBindings}},"publishAll":{{json .HostConfig.PublishAllPorts}},"runtimePorts":{{json .NetworkSettings.Ports}},"mounts":[{{range $i,$m := .Mounts}}{{if $i}},{{end}}{"type":{{json $m.Type}},"name":{{json (index $m "Name")}},"source":{{json $m.Source}},"target":{{json $m.Destination}},"rw":{{json $m.RW}}}{{end}}],"networks":[{{$first := true}}{{range $name,$n := .NetworkSettings.Networks}}{{if not $first}},{{end}}{{$first = false}}{"name":{{json $name}},"id":{{json $n.NetworkID}}}{{end}}]}',
  network:
    '{"id":{{json .Id}},"name":{{json .Name}},"createdAt":{{json .Created}},"project":{{json (index .Labels "com.docker.compose.project")}},"members":[{{$first := true}}{{range $id,$c := .Containers}}{{if not $first}},{{end}}{{$first = false}}{{json $id}}{{end}}]}',
  volume:
    '{"name":{{json .Name}},"createdAt":{{json .CreatedAt}},"project":{{json (index .Labels "com.docker.compose.project")}},"driver":{{json .Driver}},"scope":{{json .Scope}}}',
} as const;
type Kind = keyof typeof FORMATS;
type Docker = (args: readonly string[]) => Promise<string>;

function requireValue(value: unknown): asserts value {
  expect({
    that: Boolean(value),
    message: "Native file fixture contract failed; values omitted",
  });
}
function object(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  requireValue(isRecord(value));
  return value;
}
function sorted(rows: readonly unknown[]): unknown[] {
  return [...rows].sort((left, right) => {
    const a = JSON.stringify(left),
      b = JSON.stringify(right);
    requireValue(typeof a === "string" && typeof b === "string");
    return a < b ? -1 : a > b ? 1 : 0;
  });
}
/** Ordering carries no authority: preserve every complete row, duplicate and field. */
export function normalizeNativeFileObservation(
  value: unknown
): Record<string, unknown> {
  requireValue(
    isRecord(value) &&
      Array.isArray(value.mounts) &&
      Array.isArray(value.networks)
  );
  return {
    ...value,
    mounts: sorted(value.mounts),
    networks: sorted(value.networks),
  };
}
async function inventory(docker: Docker) {
  const engine: unknown = JSON.parse(
    await docker(["info", "--format", "{{json .ID}}"])
  );
  requireValue(typeof engine === "string" && engine.length > 0);
  const resources: Record<Kind, unknown[]> = {
    container: [],
    network: [],
    volume: [],
  };
  for (const kind of ["container", "network", "volume"] as const) {
    const ids = (
      await docker([
        kind,
        "ls",
        ...(kind === "container" ? ["--all"] : []),
        ...(kind === "volume" ? [] : ["--no-trunc"]),
        "--format",
        kind === "volume" ? "{{.Name}}" : "{{.ID}}",
      ])
    )
      .split(SPACE)
      .filter(Boolean)
      .sort();
    for (const id of ids) {
      const row = object(
        await docker([kind, "inspect", "--format", FORMATS[kind], id])
      );
      resources[kind].push(
        kind === "container" ? normalizeNativeFileObservation(row) : row
      );
    }
  }
  const images = [
    ...new Set(
      (
        await docker([
          "image",
          "ls",
          "--all",
          "--no-trunc",
          "--format",
          "{{.ID}}",
        ])
      )
        .split(SPACE)
        .filter(Boolean)
    ),
  ].sort();
  requireValue(
    JSON.parse(await docker(["info", "--format", "{{json .ID}}"])) === engine
  );
  return { engine, ...resources, images };
}
async function saved(root: string) {
  const store = await openNativeComposeGenerationStore({
    projectRoot: root,
    instance: null,
    mode: "saved",
  });
  try {
    const current = await store.loadCurrent(),
      pending = await store.loadPending();
    const generation = pending ?? current.generation;
    requireValue(generation !== null);
    const document = await store.withLease({
      generation,
      run: () => store.readGenerationDocument(generation),
    });
    const reference = parseNativeComposeFileReference(
      document["x-hack-native-files"]
    );
    requireValue(
      isRecord(document.services) &&
        isRecord(document.services.reader) &&
        Array.isArray(document.services.reader.volumes)
    );
    const members = document.services.reader.volumes.map((volume: unknown) => {
      requireValue(
        isRecord(volume) &&
          volume.type === "bind" &&
          volume.read_only === true &&
          isRecord(volume.bind) &&
          volume.bind.create_host_path === false &&
          typeof volume.source === "string" &&
          typeof volume.target === "string"
      );
      return {
        source: volume.source.replaceAll("$$", () => "$"),
        target: volume.target.replaceAll("$$", () => "$"),
      };
    });
    const directory = join(
      reference.root,
      `${reference.generationId}-${reference.snapshotToken}`
    );
    return { current, pending, generation, reference, members, directory };
  } finally {
    await store.close();
  }
}
type Saved = Awaited<ReturnType<typeof saved>>;
/** Private evidence only; this observation grants no material mutation authority. */
export async function observeNativeFileFixtureMembers(
  paths: readonly string[]
) {
  const selected = [...paths];
  const result: {
    readonly dev: number;
    readonly ino: number;
    readonly nlink: number;
    readonly size: number;
    readonly mode: number;
    readonly digest: string;
  }[] = [];
  for (const path of selected) {
    const before = await lstat(path);
    requireValue(
      before.isFile() &&
        !before.isSymbolicLink() &&
        before.nlink === 1 &&
        before.size <= 1024 * 1024 &&
        before.mode % 512 === 0o444
    );
    const bytes = new Uint8Array(
      await Bun.file(path)
        .slice(0, before.size + 1)
        .arrayBuffer()
    );
    const after = await lstat(path);
    requireValue(
      after.isFile() &&
        before.dev === after.dev &&
        before.ino === after.ino &&
        before.nlink === after.nlink &&
        before.size === after.size &&
        before.mode === after.mode &&
        bytes.byteLength === before.size
    );
    result.push({
      dev: before.dev,
      ino: before.ino,
      nlink: before.nlink,
      size: before.size,
      mode: before.mode,
      digest: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
    });
  }
  return result;
}
function privateOutput(result: CliResult, selected?: Saved) {
  requireValue(!result.combined.includes(TOKEN_VALUE));
  if (selected) {
    requireValue(
      !(
        result.combined.includes(selected.reference.root) ||
        result.combined.includes(selected.reference.manifest.digest)
      )
    );
  }
}
function ready(result: CliResult) {
  const envelope = object(result.stdout);
  requireValue(
    !result.timedOut &&
      result.exitCode === 0 &&
      envelope.ok === true &&
      isRecord(envelope.data) &&
      envelope.data.status === "ready"
  );
}
async function setup(ctx: ScenarioContext) {
  requireValue(resolveCliSpawnArgs([]).length === 1);
  const docker: Docker = async (args) =>
    (await createNativeComposeProbe({ timeoutMs: 15_000 })(args)).trim();
  requireValue((await docker(["info", "--format", "{{.OSType}}"])) === "linux");
  const image = await docker([
    "image",
    "inspect",
    "oven/bun:1.4.2-slim",
    "--format",
    "{{.Id}}",
  ]);
  requireValue(IMAGE.test(image)); // An absent cached image fails; never pull.
  const baseline = await inventory(docker);
  const materialHome = join(ctx.hackHome, "material-${LITERAL}$");
  await seedIsolatedHackHome({ hackHome: materialHome });
  await chmod(materialHome, 0o700);
  const created = await createMonorepoFixture({
    parentDir: ctx.tempRoot,
    withHackConfig: false,
  });
  const root = await realpath(created.root),
    projectDir = join(root, ".hack");
  await mkdir(projectDir);
  await writeFile(
    join(root, PROJECT_ENV_KEY_FILENAME),
    "synthetic-file-key-no-real-credentials",
    { mode: 0o600 }
  );
  await setProjectEnvValue({
    projectRoot: root,
    projectDir,
    envName: null,
    scope: "global",
    key: "TOKEN",
    value: TOKEN_VALUE,
    secret: true,
  });
  await setProjectEnvValue({
    projectRoot: root,
    projectDir,
    envName: null,
    scope: "global",
    key: "EMPTY",
    value: "",
    secret: false,
  });
  const source = {
    schema_version: 1,
    name: created.name,
    worktree: { auto_branch: false, inherit_local: false },
    configs: { settings: { file: "settings.bin" } },
    secrets: {
      token: { env_ref: "TOKEN" },
      empty: { env_ref: "EMPTY" },
      file: { file: "secret.bin" },
    },
    services: {
      reader: {
        image,
        pull_policy: "never",
        command: { exec: ["bun", "-e", "setInterval(()=>{},60000)"] },
        restart: { kind: "no" },
        shutdown: { signal: "SIGTERM", grace: "1s" },
        environment: { TOKEN: { unset: true } },
        mounts: [
          { config: "settings", target: TARGET, access: "read-only" },
          { secret: "token", target: "/run/token", access: "read-only" },
          { secret: "empty", target: "/run/empty", access: "read-only" },
          { secret: "file", target: "/run/file", access: "read-only" },
        ],
      },
    },
  };
  await writeFile(
    join(projectDir, "hack.project.json"),
    JSON.stringify(source)
  );
  await writeFile(join(root, "settings.bin"), BINARY);
  await writeFile(join(root, "secret.bin"), Buffer.alloc(0), { mode: 0o600 });
  await writeFile(join(root, ".gitignore"), `\n${PROJECT_ENV_KEY_FILENAME}\n`, {
    flag: "a",
  });
  await commitAll({ root, message: "synthetic native file fixture" });
  const env = {
    HACK_HOME: materialHome,
    HACK_RUNTIME_BACKEND: "compose",
    HACK_COMPOSE_STARTUP_TIMEOUT_MS: "15000",
    HACK_DAEMON_DISABLE_DOCKER_EVENTS: "1",
  };
  const invoke = async (
    checkout: string,
    args: readonly string[],
    extra: Record<string, string> = {}
  ) => {
    const result = await ctx.cli({
      cwd: checkout,
      args: ["--path", checkout, ...args],
      timeoutMs: TIMEOUT,
      env: { ...env, ...extra },
    });
    privateOutput(result);
    if (result.timedOut) {
      ctx.retainFixtures(
        "Unknown file fixture CLI child; preserve immutable recovery anchors"
      );
    }
    return result;
  };
  return { ctx, docker, baseline, created, root, invoke };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
async function verify(
  fixture: Fixture,
  root: string,
  bytes: Uint8Array
): Promise<Saved> {
  const state = await observeNativeComposeFixture(root),
    selected = await saved(root);
  requireValue(
    !state.stopped &&
      state.pending === null &&
      state.observed.containers.length === 1 &&
      state.observed.volumes.length === 0 &&
      selected.members.length === 4
  );
  const container = state.observed.containers[0];
  requireValue(
    container && ID.test(container.id) && container.state === "running"
  );
  const metadata = object(
    await fixture.docker([
      "container",
      "inspect",
      "--format",
      FORMATS.container,
      container.id,
    ])
  );
  requireValue(
    metadata.publishAll === false &&
      (metadata.ports === null ||
        (isRecord(metadata.ports) &&
          Object.keys(metadata.ports).length === 0)) &&
      (metadata.runtimePorts === null ||
        (isRecord(metadata.runtimePorts) &&
          Object.values(metadata.runtimePorts).every(
            (value) => value === null
          )))
  );
  const expected = [
    { target: TARGET, bytes: Array.from(bytes) },
    { target: "/run/token", bytes: Array.from(Buffer.from(TOKEN_VALUE)) },
    { target: "/run/empty", bytes: [] },
    { target: "/run/file", bytes: [] },
  ];
  const program = `import {stat,writeFile} from "node:fs/promises";const expected=await Bun.stdin.json();if(Object.hasOwn(process.env,"TOKEN")||!Array.isArray(expected)||expected.length!==4)process.exit(41);for(const row of expected){const actual=new Uint8Array(await Bun.file(row.target).arrayBuffer());if(JSON.stringify(Array.from(actual))!==JSON.stringify(row.bytes)||(await stat(row.target)).mode%512!==292)process.exit(42);try{await writeFile(row.target,"unexpected-write");process.exit(43);}catch(error){if(error?.code!=="EROFS")process.exit(44);}}process.stdout.write("exact-files-read-only-env-absent");`;
  const child = Bun.spawn(
    ["docker", "exec", "-i", container.id, "bun", "-e", program],
    {
      stdin: new Blob([JSON.stringify(expected)]),
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
  try {
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    requireValue(
      code === 0 &&
        err.length === 0 &&
        out === "exact-files-read-only-env-absent"
    );
  } finally {
    clearTimeout(timer);
  }
  for (const member of selected.members) {
    requireValue((await lstat(member.source)).mode % 512 === 0o444);
  }
  requireValue(
    (
      await readFile(join(selected.directory, "journal.jsonl"), "utf8")
    ).includes('"phase":"reaped"')
  );
  return selected;
}
async function stop(fixture: Fixture, root: string, selected: Saved) {
  const result = await fixture.invoke(root, ["down", "--recover", "--json"]);
  privateOutput(result, selected);
  requireValue(result.exitCode === 0 && !result.timedOut);
  const state = await observeNativeComposeFixture(root);
  requireValue(
    state.stopped &&
      state.pending === null &&
      state.hostHookPhase === null &&
      state.observed.containers.length === 0 &&
      state.observed.networks.length === 0 &&
      state.observed.volumes.length === 0
  );
  requireValue(
    (
      await readFile(join(selected.directory, "journal.jsonl"), "utf8")
    ).includes('"phase":"retired"')
  );
  for (const member of selected.members) {
    await lstat(member.source).then(
      () => {
        throw new Error("Retired material member survived; values omitted");
      },
      (error: unknown) =>
        requireValue(isRecord(error) && error.code === "ENOENT")
    );
  }
}

export const nativeConfigFilesScenario: Scenario = {
  name: "native-config-files",
  tier: "docker",
  summary:
    "actual private binary/empty/encrypted file delivery, readonly mode, worktree isolation and saved retirement",
  preserveFixtureOnFailure: true,
  run: async (ctx) => {
    const fixture = await setup(ctx);
    const roots: {
      root: string;
      bytes: Uint8Array;
      selected?: Saved;
      effectsPossible?: boolean;
    }[] = [{ root: fixture.root, bytes: BINARY }];
    await runWithOwnedCleanup({
      run: async () => {
        for (const [branch, bytes] of [
          ["alpha", Buffer.from([1, 3])],
          ["beta", Buffer.from([2, 4])],
        ] as const) {
          const root = await addLinkedWorktree({
            fixture: fixture.created,
            branch,
          });
          await writeFile(join(root, "settings.bin"), bytes);
          await writeFile(join(root, "secret.bin"), Buffer.alloc(0), {
            mode: 0o600,
          });
          await chmod(join(root, "secret.bin"), 0o600);
          roots.push({ root, bytes });
        }
        for (const entry of roots) {
          entry.effectsPossible = true;
          const result = await fixture.invoke(entry.root, [
            "up",
            "--detach",
            "--json",
          ]);
          ready(result);
          entry.selected = await verify(fixture, entry.root, entry.bytes);
          privateOutput(result, entry.selected);
        }
        requireValue(
          new Set(roots.map((entry) => entry.selected?.directory)).size === 3
        );
        const primary = roots[0];
        requireValue(primary?.selected);
        const tripwire = join(ctx.tempRoot, "tripwire");
        await mkdir(tripwire);
        const marker = join(tripwire, "engine-called");
        await writeFile(
          join(tripwire, "docker"),
          `#!${process.execPath}\nawait Bun.write(${JSON.stringify(marker)},"called");process.exit(99);\n`,
          { mode: 0o700 }
        );
        await unlink(join(primary.root, PROJECT_ENV_KEY_FILENAME));
        const refused = await fixture.invoke(
          primary.root,
          ["restart", "--json"],
          { PATH: `${tripwire}:${process.env.PATH ?? ""}` }
        );
        privateOutput(refused, primary.selected);
        requireValue(
          refused.exitCode !== 0 &&
            !refused.timedOut &&
            !(await Bun.file(marker).exists())
        );
        const afterRefusal = await saved(primary.root);
        requireValue(
          afterRefusal.pending === null &&
            afterRefusal.generation.generationId ===
              primary.selected.generation.generationId &&
            JSON.stringify(afterRefusal.reference) ===
              JSON.stringify(primary.selected.reference)
        );
        for (const entry of roots) {
          await writeFile(
            join(entry.root, ".hack/hack.project.json"),
            "malformed source unavailable"
          );
          await unlink(join(entry.root, "settings.bin"));
          await unlink(join(entry.root, "secret.bin"));
        }
        await stop(fixture, primary.root, primary.selected);
        primary.selected = undefined;
        primary.effectsPossible = false;
        for (const entry of roots.slice(1)) {
          await verify(fixture, entry.root, entry.bytes);
        }
        ctx.log(
          "exact container bytes, 0444/read-only mounts, unset env, primary refusal and linked isolation verified"
        );
      },
      cleanup: async () => {
        for (const entry of roots) {
          if (entry.effectsPossible) {
            await stop(
              fixture,
              entry.root,
              entry.selected ?? (await saved(entry.root))
            );
            entry.effectsPossible = false;
          }
        }
        requireValue(
          JSON.stringify(await inventory(fixture.docker)) ===
            JSON.stringify(fixture.baseline)
        );
      },
      secondaryFailure: () =>
        ctx.retainFixtures(
          "Owned file fixture stop is incomplete; original failure and recovery anchors retained"
        ),
    });
  },
};

/** Preserve the selected executable spelling: multiplexed Docker tools select their command by argv0. */
export function nativeFileUnknownStopWrapper(opts: {
  readonly executable: string;
  readonly bun: string;
  readonly marker: string;
}): string {
  return `#!${opts.bun}\nconst args=process.argv.slice(2);const child=Bun.spawn([${JSON.stringify(opts.executable)},...args],{stdin:"inherit",stdout:"inherit",stderr:"inherit"});const code=await child.exited;if(code===0&&args[0]==="compose"&&args.includes("down")){await Bun.write(${JSON.stringify(opts.marker)},"stopped");await Bun.sleep(600000);}process.exit(code);\n`;
}

/** An expected uncertain journal remains owned; explicit kept roots are mandatory. */
export const nativeConfigFileUnknownStopScenario: Scenario = {
  name: "native-config-file-stop-unknown",
  tier: "docker",
  summary:
    "unknown owned stop child retains material and exact pending recovery despite real engine absence",
  requiresExplicitSelection: true,
  preserveFixtureOnFailure: true,
  run: async (ctx) => {
    requireValue(process.env.HACK_E2E_KEEP === "1");
    const fixture = await setup(ctx);
    ready(await fixture.invoke(fixture.root, ["up", "--detach", "--json"]));
    const selected = await verify(fixture, fixture.root, BINARY);
    const memberPaths = selected.members.map((member) => member.source);
    const originalMembers = await observeNativeFileFixtureMembers(memberPaths);
    const executable = Bun.which("docker");
    requireValue(typeof executable === "string" && executable.startsWith("/"));
    const wrapper = join(ctx.tempRoot, "stop-wrapper");
    await mkdir(wrapper);
    const marker = join(wrapper, "stopped");
    await writeFile(
      join(wrapper, "docker"),
      nativeFileUnknownStopWrapper({
        executable,
        bun: process.execPath,
        marker,
      }),
      { mode: 0o700 }
    );
    const result = await fixture.invoke(fixture.root, ["down", "--json"], {
      PATH: `${wrapper}:${process.env.PATH ?? ""}`,
      HACK_COMPOSE_STARTUP_TIMEOUT_MS: "15000",
    });
    privateOutput(result, selected);
    requireValue(
      result.exitCode !== 0 &&
        !result.timedOut &&
        (await Bun.file(marker).exists())
    );
    const journalPath = join(selected.directory, "journal.jsonl");
    const journal = await readFile(journalPath, "utf8"),
      before = await saved(fixture.root);
    requireValue(
      journal.includes('"phase":"stop-armed"') &&
        !journal.includes('"phase":"stop-reaped"') &&
        !journal.includes('"phase":"retiring"') &&
        before.pending?.generationId === selected.generation.generationId &&
        JSON.stringify(before.reference) === JSON.stringify(selected.reference)
    );
    await writeFile(
      join(fixture.root, ".hack/hack.project.json"),
      "unavailable source"
    );
    await unlink(join(fixture.root, PROJECT_ENV_KEY_FILENAME));
    const retry = await fixture.invoke(fixture.root, [
      "down",
      "--recover",
      "--json",
    ]);
    privateOutput(retry, selected);
    const observed = await observeNativeComposeFixture(fixture.root),
      after = await saved(fixture.root);
    requireValue(
      retry.exitCode !== 0 &&
        !retry.timedOut &&
        observed.observed.containers.length === 0 &&
        observed.observed.networks.length === 0 &&
        observed.observed.volumes.length === 0 &&
        !after.current.stopped &&
        after.pending?.generationId === selected.generation.generationId &&
        JSON.stringify(after.reference) ===
          JSON.stringify(selected.reference) &&
        (await readFile(journalPath, "utf8")) === journal
    );
    requireValue(
      JSON.stringify(await observeNativeFileFixtureMembers(memberPaths)) ===
        JSON.stringify(originalMembers)
    );
    requireValue(
      JSON.stringify(await inventory(fixture.docker)) ===
        JSON.stringify(fixture.baseline)
    );
    ctx.log(
      "real resource absence does not transfer unknown child authority; exact journal and material remain deliberately retained"
    );
  },
};
