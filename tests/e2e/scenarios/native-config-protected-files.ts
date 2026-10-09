import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "../../../src/lib/guards.ts";
import { bindNativeComposeEngineSocketPath } from "../../../src/lib/native-compose-engine-identity.ts";
import { parseNativeComposeFileReference } from "../../../src/lib/native-compose-file-state.ts";
import { openNativeComposeGenerationStore } from "../../../src/lib/native-compose-generation.ts";
import {
  buildCliEnv,
  REPO_ROOT,
  type Scenario,
  type ScenarioContext,
} from "../harness.ts";
import {
  observeNativeComposeFixture,
  runWithOwnedCleanup,
} from "../native-compose-owned-fixture.ts";
import { provisionNativeNetworkFixtureComposePlugin } from "../native-config-networks-acceptance.ts";
import {
  type NativeFileFixtureCommandResult,
  runNativeFileFixtureCommand,
} from "../native-file-permission-command.ts";
import {
  nativeProtectedFileStateRefused,
  nativeProtectedFileToolAllowed,
} from "../native-file-permission-control.ts";
import {
  type NativeFileFixtureGrant,
  nativeFileFixtureAbsentProgram,
  nativeFileFixtureDeniedProgram,
  nativeFileFixtureNonowner,
  nativeFileFixtureReadProgram,
  nativeFileFixtureWriteProgram,
  readNativeFileFixtureGuest,
} from "../native-file-permission-guest.ts";

const ID = /^[a-f0-9]{64}$/;
const HASH = /^[a-f0-9]{64}$/;
const IMAGE = /^sha256:[a-f0-9]{64}$/;
const PROJECT = "com.docker.compose.project";
const BUN_TAG = "oven/bun:1.4.2-slim";
const DB_TAG = "postgres:17.6-alpine";
const LOOP = ["bun", "-e", "setInterval(()=>{},1000)"];
const FORMATS = {
  container:
    '{"id":{{json .Id}},"name":{{json .Name}},"createdAt":{{json .Created}},"image":{{json .Image}},"labels":{{json .Config.Labels}},"command":{{json .Config.Cmd}},"entrypoint":{{json .Config.Entrypoint}},"running":{{json .State.Running}},"status":{{json .State.Status}},"paused":{{json .State.Paused}},"ports":{{json .HostConfig.PortBindings}},"publishAll":{{json .HostConfig.PublishAllPorts}},"runtimePorts":{{json .NetworkSettings.Ports}},"mounts":[{{range $i,$m := .Mounts}}{{if $i}},{{end}}{"type":{{json $m.Type}},"name":{{json $m.Name}},"source":{{json $m.Source}},"target":{{json $m.Destination}},"rw":{{json $m.RW}}}{{end}}],"networks":[{{$first := true}}{{range $name,$n := .NetworkSettings.Networks}}{{if not $first}},{{end}}{{$first = false}}{"name":{{json $name}},"id":{{json $n.NetworkID}},"aliases":{{json $n.Aliases}}}{{end}}]}',
  network:
    '{"id":{{json .Id}},"name":{{json .Name}},"createdAt":{{json .Created}},"driver":{{json .Driver}},"scope":{{json .Scope}},"internal":{{json .Internal}},"labels":{{json .Labels}},"members":[{{$first := true}}{{range $id,$c := .Containers}}{{if not $first}},{{end}}{{$first = false}}{{json $id}}{{end}}]}',
  volume:
    '{"name":{{json .Name}},"createdAt":{{json .CreatedAt}},"driver":{{json .Driver}},"scope":{{json .Scope}},"labels":{{json .Labels}},"options":{{json .Options}},"mountpoint":{{json .Mountpoint}}}',
} as const;
type Kind = keyof typeof FORMATS;
type Row = Record<string, unknown>;
type Inventory = {
  readonly engine: string;
  readonly container: readonly Row[];
  readonly network: readonly Row[];
  readonly volume: readonly Row[];
  readonly images: readonly string[];
  readonly tags: Readonly<Record<string, string>>;
};
type SourcePin = {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
  readonly size: number;
  readonly hash: string;
};
type Checkout = {
  readonly root: string;
  readonly name: string;
  readonly grants: readonly NativeFileFixtureGrant[];
  readonly material: readonly SourcePin[];
  readonly marker: string;
  privateMembers?: readonly string[];
  original?: {
    readonly resources: Record<Kind, readonly Row[]>;
    readonly sources: readonly SourcePin[];
  };
  rolledBack?: boolean;
  bootstrapped?: boolean;
};
function requireValue(value: unknown): asserts value {
  if (!value) {
    throw new Error("Protected file acceptance refused; values omitted.");
  }
}
function object(text: string): Row {
  const value: unknown = JSON.parse(text);
  requireValue(isRecord(value));
  return value;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return JSON.stringify(value.map((entry) => JSON.parse(canonical(entry))));
  }
  if (isRecord(value)) {
    return JSON.stringify(
      Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, JSON.parse(canonical(value[key]))])
      )
    );
  }
  return JSON.stringify(value);
}
function rows(value: readonly unknown[]): unknown[] {
  return [...value].sort((a, b) => canonical(a).localeCompare(canonical(b)));
}
function hash(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
async function sourcePin(path: string): Promise<SourcePin> {
  const before = await lstat(path);
  requireValue(
    before.isFile() &&
      !before.isSymbolicLink() &&
      before.nlink === 1 &&
      before.size <= 8192 &&
      before.uid === process.getuid?.()
  );
  const descriptor = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    const held = await descriptor.stat();
    requireValue(
      held.dev === before.dev &&
        held.ino === before.ino &&
        held.mode === before.mode &&
        held.isFile() &&
        held.nlink === 1 &&
        held.uid === before.uid &&
        held.gid === before.gid &&
        held.size === before.size
    );
    const buffer = Buffer.alloc(8193),
      { bytesRead } = await descriptor.read(buffer, 0, buffer.length, 0);
    const after = await lstat(path),
      final = await descriptor.stat();
    for (const current of [after, final]) {
      requireValue(
        current.isFile() &&
          !current.isSymbolicLink() &&
          current.nlink === 1 &&
          before.dev === current.dev &&
          before.ino === current.ino &&
          before.mode === current.mode &&
          before.size === bytesRead &&
          current.size === bytesRead &&
          before.uid === current.uid &&
          before.gid === current.gid
      );
    }
    requireValue(bytesRead <= 8192);
    return {
      path,
      dev: before.dev,
      ino: before.ino,
      mode: before.mode & 0o7777,
      uid: before.uid,
      gid: before.gid,
      size: bytesRead,
      hash: hash(buffer.subarray(0, bytesRead)),
    };
  } finally {
    await descriptor.close();
  }
}
async function checkSources(pins: readonly SourcePin[]) {
  for (const pin of pins) {
    requireValue(canonical(await sourcePin(pin.path)) === canonical(pin));
  }
}
async function createMaterial(path: string, bytes: Uint8Array, mode: number) {
  // Initialize only a newly created exclusive synthetic file. No chmod is allowed
  // after bootstrap or against any original/caller source.
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(bytes);
    await file.chmod(mode);
    await file.sync();
  } finally {
    await file.close();
  }
  const pin = await sourcePin(path);
  requireValue(pin.mode === mode);
  return pin;
}
function noPorts(row: Row) {
  return (
    row.publishAll === false &&
    (row.ports === null ||
      (isRecord(row.ports) && Object.keys(row.ports).length === 0)) &&
    (row.runtimePorts === null ||
      (isRecord(row.runtimePorts) &&
        Object.values(row.runtimePorts).every(
          (value) =>
            value === null || (Array.isArray(value) && value.length === 0)
        )))
  );
}
/** Compare immutable container facts, preserving every mount and label. State is separately inspected. */
export function nativeProtectedFileContainerIdentity(value: unknown): string {
  requireValue(
    isRecord(value) &&
      Array.isArray(value.mounts) &&
      Array.isArray(value.networks)
  );
  const {
    running: _running,
    status: _status,
    paused: _paused,
    networks: _networks,
    ...identity
  } = value;
  return canonical({ ...identity, mounts: rows(value.mounts) });
}
/** Fixture cleanup cannot target an added resource, changed creation birth, or a live container. */
export function nativeProtectedFileRemovalMatches(opts: {
  readonly pin: Row;
  readonly current: Row;
  readonly kind: Kind;
}): boolean {
  if (opts.kind === "container") {
    return (
      opts.current.running === false &&
      opts.current.paused === false &&
      opts.current.status === "exited" &&
      Array.isArray(opts.pin.networks) &&
      Array.isArray(opts.current.networks) &&
      canonical(rows(opts.pin.networks)) ===
        canonical(rows(opts.current.networks)) &&
      nativeProtectedFileContainerIdentity(opts.pin) ===
        nativeProtectedFileContainerIdentity(opts.current)
    );
  }
  if (opts.kind === "network") {
    const { members: _before, ...pin } = opts.pin,
      { members, ...current } = opts.current;
    return (
      Array.isArray(members) &&
      members.length === 0 &&
      canonical(pin) === canonical(current)
    );
  }
  return canonical(opts.pin) === canonical(opts.current);
}
function legacy(instance: Checkout, bun: string, db: string) {
  return {
    name: instance.name,
    services: {
      db: {
        image: db,
        pull_policy: "never",
        environment: {
          POSTGRES_HOST_AUTH_METHOD: "trust",
          POSTGRES_DB: "fixture",
        },
        volumes: ["data:/var/lib/postgresql/data"],
        restart: "no",
        stop_grace_period: "1s",
      },
      reader: {
        image: bun,
        pull_policy: "never",
        command: LOOP,
        restart: "no",
        stop_grace_period: "1s",
        configs: [
          {
            source: "settings",
            target: instance.grants[0]?.target,
            mode: "0444",
          },
        ],
        secrets: [
          { source: "owner", target: instance.grants[1]?.target },
          {
            source: "private",
            target: instance.grants[2]?.target,
            mode: "0600",
          },
        ],
      },
      ungranted: {
        image: bun,
        pull_policy: "never",
        command: LOOP,
        restart: "no",
        stop_grace_period: "1s",
      },
    },
    configs: { settings: { file: "../material/settings" } },
    secrets: {
      owner: { file: "../material/owner" },
      private: { file: "../material/private" },
    },
    volumes: { data: { name: `${instance.name}_data` } },
  };
}
function native(instance: Checkout, bun: string) {
  return {
    schema_version: 1,
    name: instance.name,
    configs: { settings: { file: "material/settings" } },
    secrets: {
      owner: { file: "material/owner" },
      private: { file: "material/private" },
    },
    services: {
      reader: {
        image: bun,
        pull_policy: "never",
        command: { exec: LOOP },
        restart: { kind: "no" },
        shutdown: { grace: "1s" },
        mounts: [
          {
            config: "settings",
            target: instance.grants[0]?.target,
            access: "read-only",
            mode: "0444",
          },
          {
            secret: "owner",
            target: instance.grants[1]?.target,
            access: "read-only",
            mode: "0400",
          },
          {
            secret: "private",
            target: instance.grants[2]?.target,
            access: "read-only",
            mode: "0600",
          },
        ],
      },
      ungranted: {
        image: bun,
        pull_policy: "never",
        command: { exec: LOOP },
        restart: { kind: "no" },
        shutdown: { grace: "1s" },
      },
    },
  };
}

async function setup(ctx: ScenarioContext) {
  requireValue(process.env.HACK_E2E_KEEP === "1");
  const deadline = Date.now() + 600_000;
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  const remaining = (max = 90_000) => {
    const time = deadline - Date.now();
    requireValue(time > 0 && !controller.signal.aborted);
    return Math.min(max, time);
  };
  const cli = process.env.HACK_E2E_CLI_BIN,
    compiler = process.env.HACK_CONFIG_COMPILER_BINARY;
  const expectedCli = process.env.HACK_E2E_CLI_SHA256,
    expectedCompiler = process.env.HACK_E2E_COMPILER_SHA256,
    expectedSource = process.env.HACK_E2E_SOURCE_REVISION;
  const pluginPath = process.env.HACK_E2E_COMPOSE_PLUGIN_PATH,
    pluginHash = process.env.HACK_E2E_COMPOSE_PLUGIN_SHA256;
  requireValue(
    process.env.HACK_E2E_PROTECTED_FILES_SLOT_RELEASED === expectedSource
  );
  requireValue(
    cli &&
      compiler &&
      expectedCli &&
      expectedCompiler &&
      expectedSource &&
      pluginPath &&
      pluginHash &&
      isAbsolute(cli) &&
      isAbsolute(compiler) &&
      HASH.test(expectedCli) &&
      HASH.test(expectedCompiler) &&
      /^[a-f0-9]{40}$/.test(expectedSource)
  );
  const docker = Bun.which("docker"),
    git = Bun.which("git");
  requireValue(docker && git && isAbsolute(docker) && isAbsolute(git));
  const requestedSocket = process.env.DOCKER_HOST;
  requireValue(
    typeof requestedSocket === "string" && requestedSocket.startsWith("unix://")
  );
  const socketBinding = bindNativeComposeEngineSocketPath(
    requestedSocket.slice(7)
  );
  const socket = socketBinding.path,
    socketInfo = await lstat(socket);
  requireValue(socketInfo.isSocket());
  const artifacts = await Promise.all(
    [
      { path: cli, role: "artifact" as const },
      { path: compiler, role: "artifact" as const },
      { path: docker, role: "artifact" as const },
      { path: git, role: "git" as const },
      { path: process.execPath, role: "artifact" as const },
    ].map(async ({ path, role }) => {
      const physical = await realpath(path);
      return {
        path,
        role,
        physical,
        info: await lstat(physical),
        hash: hash(await readFile(physical)),
      };
    })
  );
  requireValue(
    artifacts[0]?.hash === expectedCli &&
      artifacts[1]?.hash === expectedCompiler &&
      artifacts.every((pin) =>
        nativeProtectedFileToolAllowed({
          role: pin.role,
          platform: process.platform,
          selected: pin.path,
          physical: pin.physical,
          regular: pin.info.isFile(),
          symlink: pin.info.isSymbolicLink(),
          uid: pin.info.uid,
          mode: pin.info.mode,
          nlink: pin.info.nlink,
        })
      )
  );
  const home = join(ctx.tempRoot, "protected-home"),
    captures = join(ctx.tempRoot, "protected-captures");
  await mkdir(home, { mode: 0o700 });
  await mkdir(join(home, ".docker"), { mode: 0o700 });
  await mkdir(captures, { mode: 0o700 });
  await writeFile(join(home, ".docker/config.json"), "{}\n", {
    mode: 0o600,
    flag: "wx",
  });
  await provisionNativeNetworkFixtureComposePlugin({
    dockerConfig: join(home, ".docker"),
    path: pluginPath,
    expectedHash: pluginHash,
  });
  const env = buildCliEnv({
    hackHome: join(home, "hack"),
    extra: {
      HOME: home,
      DOCKER_HOST: `unix://${socket}`,
      DOCKER_CONFIG: join(home, ".docker"),
      HACK_DAEMON_DISABLE_DOCKER_EVENTS: "1",
      HACK_CONFIG_COMPILER_BINARY: compiler,
      HACK_RUNTIME_BACKEND: "compose",
      HACK_DAEMON_AUTO_START: "0",
      HACK_COMPOSE_STARTUP_TIMEOUT_MS: "45000",
    },
  });
  let serial = 0,
    remainingOutput = 16 * 1024 * 1024;
  const command = async (
    argv: readonly string[],
    cwd = ctx.tempRoot,
    stdin?: unknown,
    extra?: Readonly<Record<string, string>>
  ) => {
    requireValue(serial < 1000 && remainingOutput > 0);
    const result = await runNativeFileFixtureCommand({
      argv,
      cwd,
      env: { ...env, ...extra },
      timeoutMs: remaining(),
      signal: controller.signal,
      stdin:
        stdin === undefined ? undefined : Buffer.from(JSON.stringify(stdin)),
      capturePrefix: join(captures, String(++serial).padStart(5, "0")),
    });
    remainingOutput -=
      Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr);
    requireValue(remainingOutput >= 0);
    return result;
  };
  const successful = (result: NativeFileFixtureCommandResult) => {
    requireValue(result.exitCode === 0);
    return result.stdout.trim();
  };
  const probe = async (args: readonly string[]) =>
    successful(await command([docker, ...args]));
  const invoke = async (
    instance: Checkout,
    args: readonly string[],
    stdin?: unknown,
    extra?: Readonly<Record<string, string>>
  ) => {
    await fence();
    return command(
      [cli, "--path", instance.root, ...args],
      instance.root,
      stdin,
      extra
    );
  };
  const fence = async () => {
    remaining();
    socketBinding.assertFresh();
    const currentSocket = await lstat(socket);
    requireValue(
      currentSocket.isSocket() &&
        currentSocket.dev === socketInfo.dev &&
        currentSocket.ino === socketInfo.ino &&
        currentSocket.mode === socketInfo.mode &&
        currentSocket.uid === socketInfo.uid &&
        currentSocket.gid === socketInfo.gid
    );
    for (const pin of artifacts) {
      requireValue((await realpath(pin.path)) === pin.physical);
      const latest = await lstat(pin.physical);
      requireValue(
        latest.dev === pin.info.dev &&
          latest.ino === pin.info.ino &&
          latest.size === pin.info.size &&
          latest.mode === pin.info.mode &&
          latest.uid === pin.info.uid &&
          latest.gid === pin.info.gid &&
          latest.nlink === pin.info.nlink &&
          hash(await readFile(pin.physical)) === pin.hash
      );
    }
    requireValue(
      successful(await command([git, "-C", REPO_ROOT, "rev-parse", "HEAD"])) ===
        expectedSource
    );
    requireValue(
      successful(
        await command([
          git,
          "-C",
          REPO_ROOT,
          "status",
          "--porcelain",
          "--untracked-files=no",
        ])
      ) === ""
    );
    remaining();
  };
  await fence();
  const inspect = async (kind: Kind, id: string) => {
    const row = object(
      await probe([kind, "inspect", "--format", FORMATS[kind], id])
    );
    if (kind === "container") {
      requireValue(Array.isArray(row.networks) && Array.isArray(row.mounts));
      row.mounts = rows(row.mounts);
      row.networks = rows(
        row.networks.map((entry: unknown) => {
          requireValue(
            isRecord(entry) &&
              (entry.aliases === null || Array.isArray(entry.aliases))
          );
          if (Array.isArray(entry.aliases)) {
            requireValue(
              entry.aliases.every(
                (alias: unknown) => typeof alias === "string"
              ) && new Set(entry.aliases).size === entry.aliases.length
            );
            return { ...entry, aliases: [...entry.aliases].sort() };
          }
          return entry;
        })
      );
    }
    return row;
  };
  const list = async (kind: Kind, project?: string) => {
    const text = await probe([
      kind,
      "ls",
      ...(kind === "container" ? ["--all"] : []),
      ...(kind === "volume" ? [] : ["--no-trunc"]),
      "--format",
      kind === "volume" ? "{{.Name}}" : "{{.ID}}",
      ...(project ? ["--filter", `label=${PROJECT}=${project}`] : []),
    ]);
    const ids = text.split(/\s+/).filter(Boolean).sort();
    requireValue(
      new Set(ids).size === ids.length &&
        (kind === "volume" || ids.every((id) => ID.test(id)))
    );
    return ids;
  };
  const engine = JSON.parse(await probe(["info", "--format", "{{json .ID}}"]));
  requireValue(typeof engine === "string" && engine.length > 0);
  const assertEngine = async () =>
    requireValue(
      JSON.parse(await probe(["info", "--format", "{{json .ID}}"])) === engine
    );
  const tags = {
    [BUN_TAG]: await probe([
      "image",
      "inspect",
      BUN_TAG,
      "--format",
      "{{.Id}}",
    ]),
    [DB_TAG]: await probe(["image", "inspect", DB_TAG, "--format", "{{.Id}}"]),
  };
  requireValue(Object.values(tags).every((id) => IMAGE.test(id)));
  const inventory = async (): Promise<Inventory> => {
    await assertEngine();
    const resources: Record<Kind, Row[]> = {
      container: [],
      network: [],
      volume: [],
    };
    for (const kind of ["container", "network", "volume"] as const) {
      for (const id of await list(kind)) {
        const row = await inspect(kind, id);
        if (kind === "container") {
          requireValue(
            Array.isArray(row.mounts) && Array.isArray(row.networks)
          );
          row.mounts = rows(row.mounts);
          row.networks = rows(row.networks);
        } else if (kind === "network") {
          requireValue(Array.isArray(row.members));
          row.members = rows(row.members);
        }
        resources[kind].push(row);
      }
    }
    const images = [
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
          .trim()
          .split(/\s+/)
          .filter(Boolean)
      ),
    ].sort();
    requireValue(images.every((id) => IMAGE.test(id)));
    const currentTags = Object.fromEntries(
      await Promise.all(
        Object.keys(tags).map(async (tag) => [
          tag,
          await probe(["image", "inspect", tag, "--format", "{{.Id}}"]),
        ])
      )
    );
    await assertEngine();
    return { engine, ...resources, images, tags: currentTags };
  };
  const baseline = await inventory();
  requireValue(baseline.container.every((row) => row.running === false));
  const make = async (
    root: string,
    name: string,
    marker: string
  ): Promise<Checkout> => {
    await mkdir(join(root, ".hack"), { mode: 0o700, recursive: true });
    await mkdir(join(root, "material"), { mode: 0o700 });
    const grants: NativeFileFixtureGrant[] = [
      {
        target: "/etc/fixture-settings",
        mode: "0444",
        bytes: Array.from(Buffer.from(`fixture-config-${marker}`)),
      },
      {
        target: "/run/secrets/owner",
        mode: "0400",
        bytes: Array.from(Buffer.from(`fixture-owner-${marker}`)),
      },
      {
        target: "/run/secrets/private",
        mode: "0600",
        bytes: Array.from(Buffer.from(`fixture-private-${marker}`)),
      },
    ];
    const material: SourcePin[] = [];
    for (const [index, filename] of [
      "settings",
      "owner",
      "private",
    ].entries()) {
      const grant = grants[index];
      requireValue(grant);
      material.push(
        await createMaterial(
          join(root, "material", filename),
          Buffer.from(grant.bytes),
          Number.parseInt(grant.mode, 8)
        )
      );
    }
    return { root, name, marker, grants, material };
  };
  const suffix = randomBytes(4).toString("hex"),
    ordinary = await make(
      join(ctx.tempRoot, "ordinary"),
      `file-native-${suffix}`,
      "native"
    );
  await writeFile(
    join(ordinary.root, ".hack/hack.project.json"),
    JSON.stringify(native(ordinary, tags[BUN_TAG])),
    { mode: 0o600, flag: "wx" }
  );
  const primaryRoot = join(ctx.tempRoot, "retained-primary");
  await mkdir(primaryRoot, { mode: 0o700 });
  successful(await command([git, "init", "--quiet", primaryRoot]));
  successful(
    await command([git, "-C", primaryRoot, "config", "user.name", "Fixture"])
  );
  successful(
    await command([
      git,
      "-C",
      primaryRoot,
      "config",
      "user.email",
      "fixture@example.invalid",
    ])
  );
  await writeFile(
    join(primaryRoot, ".gitignore"),
    "material/\n.hack/.internal/\n.hack/hack.project.json\n",
    { mode: 0o600 }
  );
  successful(await command([git, "-C", primaryRoot, "add", ".gitignore"]));
  successful(
    await command([
      git,
      "-C",
      primaryRoot,
      "commit",
      "--quiet",
      "-m",
      "fixture: initial retained checkout",
    ])
  );
  const secondRoot = join(ctx.tempRoot, "retained-second");
  successful(
    await command([
      git,
      "-C",
      primaryRoot,
      "worktree",
      "add",
      "--quiet",
      "-b",
      "file-second",
      secondRoot,
    ])
  );
  const first = await make(primaryRoot, `file-first-${suffix}`, "first"),
    second = await make(secondRoot, `file-second-${suffix}`, "second");
  for (const instance of [first, second]) {
    await writeFile(
      join(instance.root, ".hack/hack.config.json"),
      JSON.stringify({ name: instance.name, worktree: { inherit: false } }),
      { mode: 0o600, flag: "wx" }
    );
    await writeFile(
      join(instance.root, ".hack/docker-compose.yml"),
      JSON.stringify(legacy(instance, tags[BUN_TAG], tags[DB_TAG])),
      { mode: 0o600, flag: "wx" }
    );
    successful(
      await command([
        git,
        "-C",
        instance.root,
        "add",
        ".hack/hack.config.json",
        ".hack/docker-compose.yml",
      ])
    );
    successful(
      await command([
        git,
        "-C",
        instance.root,
        "commit",
        "--quiet",
        "-m",
        "fixture: isolated retained file inputs",
      ])
    );
  }
  const stop = () => {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
  };
  return {
    ctx,
    deadline,
    remaining,
    env,
    cli,
    git,
    docker,
    home,
    command,
    successful,
    probe,
    invoke,
    fence,
    inspect,
    list,
    assertEngine,
    inventory,
    baseline,
    ordinary,
    first,
    second,
    stop,
  };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
async function fixtureEnvironment<T>(
  h: Fixture,
  run: () => Promise<T>
): Promise<T> {
  const prior = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(h.env)) {
    prior.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of prior) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}
function containerTopology(entries: readonly unknown[]) {
  return entries.map((entry) => {
    requireValue(isRecord(entry));
    return { name: entry.name, aliases: entry.aliases };
  });
}
function requireOriginalResourceIdentity(kind: Kind, pin: Row, current: Row) {
  if (kind === "container") {
    requireValue(
      nativeProtectedFileContainerIdentity(current) ===
        nativeProtectedFileContainerIdentity(pin) &&
        Array.isArray(pin.networks) &&
        Array.isArray(current.networks)
    );
    requireValue(
      canonical(rows(containerTopology(pin.networks))) ===
        canonical(rows(containerTopology(current.networks)))
    );
  } else if (kind === "network") {
    const { members: _a, ...a } = pin,
      { members: _b, ...b } = current;
    requireValue(canonical(a) === canonical(b));
  } else {
    requireValue(canonical(pin) === canonical(current));
  }
}
function requireOriginalResources(
  current: Record<Kind, readonly Row[]>,
  original: Record<Kind, readonly Row[]>
) {
  for (const kind of ["container", "network", "volume"] as const) {
    const before = original[kind];
    requireValue(before.length === current[kind].length);
    for (const pin of before) {
      const identity = kind === "volume" ? "name" : "id";
      const row = current[kind].find(
        (value) => value[identity] === pin[identity]
      );
      requireValue(row);
      requireOriginalResourceIdentity(kind, pin, row);
    }
  }
}
async function resources(
  h: Fixture,
  instance: Checkout
): Promise<Record<Kind, readonly Row[]>> {
  await h.assertEngine();
  const result: Record<Kind, Row[]> = {
    container: [],
    network: [],
    volume: [],
  };
  for (const kind of ["container", "network", "volume"] as const) {
    for (const id of await h.list(kind, instance.name)) {
      result[kind].push(await h.inspect(kind, id));
    }
  }
  requireValue(
    result.container.length === 3 &&
      result.network.length === 1 &&
      result.volume.length === 1
  );
  const roles = new Set<string>();
  for (const row of result.container) {
    requireValue(
      typeof row.id === "string" &&
        ID.test(row.id) &&
        isRecord(row.labels) &&
        row.labels[PROJECT] === instance.name &&
        typeof row.labels["com.docker.compose.service"] === "string" &&
        ["db", "reader", "ungranted"].includes(
          row.labels["com.docker.compose.service"]
        ) &&
        row.labels["com.docker.compose.container-number"] === "1" &&
        row.labels["com.docker.compose.oneoff"] === "False" &&
        row.labels["com.docker.compose.project.working_dir"] ===
          join(instance.root, ".hack") &&
        row.labels["com.docker.compose.project.config_files"] ===
          join(instance.root, ".hack/docker-compose.yml") &&
        !Object.keys(row.labels).some((key) =>
          key.startsWith("io.hack.native-config.")
        ) &&
        noPorts(row) &&
        Array.isArray(row.mounts) &&
        Array.isArray(row.networks) &&
        row.networks.length === 1
    );
    const service = row.labels["com.docker.compose.service"];
    requireValue(!roles.has(service));
    roles.add(service);
    const mounts =
      service === "db"
        ? [
            {
              type: "volume",
              name: `${instance.name}_data`,
              target: "/var/lib/postgresql/data",
              rw: true,
            },
          ]
        : service === "reader"
          ? instance.grants.map((grant, index) => ({
              type: "bind",
              name: "",
              source: instance.material[index]?.path,
              target: grant.target,
              rw: false,
            }))
          : [];
    const projected = row.mounts.map((mount: unknown) => {
      requireValue(isRecord(mount));
      return service === "db"
        ? {
            type: mount.type,
            name: mount.name,
            target: mount.target,
            rw: mount.rw,
          }
        : mount;
    });
    requireValue(canonical(rows(projected)) === canonical(rows(mounts)));
    const endpoint = row.networks[0];
    requireValue(
      isRecord(endpoint) &&
        endpoint.name === `${instance.name}_default` &&
        (endpoint.id === result.network[0]?.id ||
          (!row.running && endpoint.id === ""))
    );
  }
  const network = result.network[0],
    volume = result.volume[0];
  requireValue(
    network &&
      typeof network.id === "string" &&
      ID.test(network.id) &&
      network.name === `${instance.name}_default` &&
      network.driver === "bridge" &&
      network.scope === "local" &&
      network.internal === false &&
      isRecord(network.labels) &&
      network.labels[PROJECT] === instance.name &&
      network.labels["com.docker.compose.network"] === "default" &&
      Array.isArray(network.members) &&
      canonical(rows(network.members)) ===
        canonical(
          rows(
            result.container.filter((row) => row.running).map((row) => row.id)
          )
        )
  );
  requireValue(
    volume &&
      volume.name === `${instance.name}_data` &&
      volume.driver === "local" &&
      volume.scope === "local" &&
      (volume.options === null ||
        (isRecord(volume.options) &&
          Object.keys(volume.options).length === 0)) &&
      isRecord(volume.labels) &&
      volume.labels[PROJECT] === instance.name &&
      volume.labels["com.docker.compose.volume"] === "data" &&
      typeof volume.createdAt === "string" &&
      volume.createdAt.length > 0
  );
  if (instance.original) {
    requireOriginalResources(result, instance.original.resources);
  }
  await h.assertEngine();
  return result;
}
function container(
  rows: Record<Kind, readonly Row[]>,
  service: string
): string {
  const row = rows.container.find(
    (item) =>
      isRecord(item.labels) &&
      item.labels["com.docker.compose.service"] === service
  );
  requireValue(row && typeof row.id === "string" && ID.test(row.id));
  return row.id;
}
async function sourcePair(instance: Checkout) {
  return [
    await sourcePin(join(instance.root, ".hack/hack.config.json")),
    await sourcePin(join(instance.root, ".hack/docker-compose.yml")),
  ];
}
async function sql(h: Fixture, instance: Checkout, query: string) {
  const rows = await resources(h, instance);
  return h.successful(
    await h.command([
      h.docker,
      "container",
      "exec",
      container(rows, "db"),
      "psql",
      "-U",
      "postgres",
      "-d",
      "fixture",
      "-At",
      "-c",
      query,
    ])
  );
}
async function waitSql(h: Fixture, instance: Checkout) {
  const limit = Date.now() + Math.min(30_000, h.remaining());
  while (true) {
    h.remaining();
    const rows = await resources(h, instance),
      result = await h.command([
        h.docker,
        "container",
        "exec",
        container(rows, "db"),
        "psql",
        "-U",
        "postgres",
        "-d",
        "fixture",
        "-At",
        "-c",
        "SELECT 1",
      ]);
    if (result.exitCode === 0 && result.stdout.trim() === "1") {
      return;
    }
    requireValue(Date.now() < limit);
    await Bun.sleep(100);
  }
}
async function retainedReceipt(instance: Checkout) {
  const path = join(
    instance.root,
    ".hack/.internal/legacy-compose-adoption-v1/receipt.json"
  );
  const before = await lstat(path);
  requireValue(
    before.isFile() &&
      !before.isSymbolicLink() &&
      before.nlink === 1 &&
      before.size <= 64 * 1024 &&
      (before.mode & 0o777) === 0o600
  );
  const raw = await readFile(path, "utf8"),
    after = await lstat(path);
  requireValue(
    before.dev === after.dev &&
      before.ino === after.ino &&
      before.size === after.size
  );
  const row = object(raw);
  requireValue(
    row.adoption_receipt_version === 8 &&
      isRecord(row.prepared) &&
      isRecord(row.publication) &&
      row.publication.phase === "active" &&
      canonical(row.publication.generation) === canonical(row.prepared)
  );
  return row;
}
async function savedRetained(h: Fixture, instance: Checkout) {
  const receipt = await retainedReceipt(instance);
  requireValue(receipt.pendingOperation === null);
  await fixtureEnvironment(h, async () => {
    const { openLegacyComposeAdoptedGenerationStore } = await import(
      "../../../src/lib/native-compose-adoption-generation.ts"
    );
    const store = await openLegacyComposeAdoptedGenerationStore({
      projectRoot: instance.root,
      mode: "saved",
    });
    try {
      const generation = await store.loadActive();
      requireValue(generation?.report.adoption_generation_version === 8);
      await store.withLease({
        generation,
        material: "saved",
        run: async (input) => {
          const sourceHashes = [
            hash(Buffer.from(input.configText)),
            hash(Buffer.from(input.composeText)),
          ];
          requireValue(
            canonical(sourceHashes) ===
              canonical(instance.original?.sources.map((pin) => pin.hash))
          );
          const rows = await resources(h, instance);
          requireValue(
            canonical(
              [...input.binding.containers.map((row) => row.id)].sort()
            ) === canonical([...rows.container.map((row) => row.id)].sort())
          );
        },
      });
    } finally {
      await store.close();
    }
  });
  return receipt;
}
async function permissionRead(
  h: Fixture,
  instance: Checkout,
  mode: "native" | "retained"
) {
  await checkSources(instance.material);
  await h.fence();
  let reader: string, ungranted: string;
  if (mode === "native") {
    const observed = await fixtureEnvironment(h, () =>
      observeNativeComposeFixture(instance.root)
    );
    requireValue(
      observed.pending === null &&
        !observed.stopped &&
        observed.observed.containers.length === 2
    );
    const selected = observed.observed.containers.find(
        (row) => row.service === "reader"
      ),
      absent = observed.observed.containers.find(
        (row) => row.service === "ungranted"
      );
    requireValue(selected && absent);
    reader = selected.id;
    ungranted = absent.id;
  } else {
    const rows = await resources(h, instance);
    requireValue(rows.container.every((row) => row.running === true));
    reader = container(rows, "reader");
    ungranted = container(rows, "ungranted");
    await savedRetained(h, instance);
  }
  const read = h.successful(
    await h.invoke(
      instance,
      ["exec", "reader", "--", "bun", "-e", nativeFileFixtureReadProgram],
      instance.grants
    )
  );
  const guest = readNativeFileFixtureGuest({
    text: read,
    expected: instance.grants,
  });
  requireValue(guest.members.length === 3);
  const protectedMembers = guest.members.filter(
      (member) => member.mode !== "0444"
    ),
    nonowner = nativeFileFixtureNonowner(guest);
  const protectedOwners = new Set(protectedMembers.map((member) => member.uid));
  requireValue(protectedOwners.size === 1);
  const ownerUid = protectedMembers[0]?.uid;
  requireValue(ownerUid !== undefined);
  await h.fence();
  const ownerRead = h.successful(
    await h.command(
      [
        h.docker,
        "container",
        "exec",
        "--interactive",
        "--user",
        String(ownerUid),
        reader,
        "bun",
        "-e",
        nativeFileFixtureReadProgram,
      ],
      instance.root,
      instance.grants
    )
  );
  const authorized = readNativeFileFixtureGuest({
    text: ownerRead,
    expected: instance.grants,
  });
  requireValue(
    authorized.uid === ownerUid &&
      canonical(authorized.members) === canonical(guest.members)
  );
  await h.fence();
  requireValue(
    h.successful(
      await h.command(
        [
          h.docker,
          "container",
          "exec",
          "--interactive",
          "--user",
          "0",
          reader,
          "bun",
          "-e",
          nativeFileFixtureWriteProgram,
        ],
        instance.root,
        guest.members
      )
    ) === "exact-readonly-files"
  );
  await h.fence();
  requireValue(
    h.successful(
      await h.command(
        [
          h.docker,
          "container",
          "exec",
          "--interactive",
          "--user",
          String(nonowner),
          reader,
          "bun",
          "-e",
          nativeFileFixtureDeniedProgram,
        ],
        instance.root,
        protectedMembers
      )
    ) === "exact-nonowner-read-refused"
  );
  await h.fence();
  requireValue(
    h.successful(
      await h.invoke(
        instance,
        [
          "exec",
          "ungranted",
          "--",
          "bun",
          "-e",
          nativeFileFixtureAbsentProgram,
        ],
        guest.members
      )
    ) === "exact-ungranted-files-absent"
  );
  // Independently bind the ungranted ID; no config/secret target is delivered there.
  const absent = await h.inspect("container", ungranted);
  requireValue(
    Array.isArray(absent.mounts) &&
      absent.mounts.every(
        (value: unknown) =>
          isRecord(value) &&
          !instance.grants.some((grant) => grant.target === value.target)
      )
  );
  await checkSources(instance.material);
  await h.fence();
  return guest;
}
async function savedNative(h: Fixture, instance: Checkout) {
  return fixtureEnvironment(h, async () => {
    const store = await openNativeComposeGenerationStore({
      projectRoot: instance.root,
      instance: null,
      mode: "saved",
    });
    try {
      const current = await store.loadCurrent();
      requireValue(current.generation && !current.pending);
      const doc = await store.withLease({
        generation: current.generation,
        run: () => store.readGenerationDocument(current.generation!),
      });
      const reference = parseNativeComposeFileReference(
        doc["x-hack-native-files"]
      );
      requireValue(reference.version === 2);
      requireValue(
        isRecord(doc.services) &&
          isRecord(doc.services.reader) &&
          Array.isArray(doc.services.reader.volumes)
      );
      const members = doc.services.reader.volumes.map((value: unknown) => {
        requireValue(
          isRecord(value) &&
            value.type === "bind" &&
            value.read_only === true &&
            typeof value.source === "string"
        );
        return value.source.replaceAll("$$", "$");
      });
      instance.privateMembers = [
        ...(instance.privateMembers ?? []),
        ...members,
      ];
      return { generation: current.generation.generationId, reference };
    } finally {
      await store.close();
    }
  });
}
async function ordinaryFlow(h: Fixture) {
  const instance = h.ordinary;
  await h.fence();
  h.successful(await h.invoke(instance, ["up", "--detach", "--json"]));
  instance.bootstrapped = true;
  const before = await savedNative(h, instance),
    guest = await permissionRead(h, instance, "native");
  h.successful(await h.invoke(instance, ["ps", "--json"]));
  h.successful(await h.invoke(instance, ["restart", "--json"]));
  const after = await savedNative(h, instance);
  requireValue(
    before.reference.snapshotToken !== after.reference.snapshotToken &&
      canonical(await permissionRead(h, instance, "native")) ===
        canonical(guest)
  );
  h.ctx.log(
    "Ordinary native snapshot2 guest modes, owner facts, granted/nonowner/ungranted reads and readonly writes verified"
  );
}
async function bootstrap(h: Fixture, instance: Checkout) {
  for (const kind of ["container", "network", "volume"] as const) {
    requireValue((await h.list(kind, instance.name)).length === 0);
  }
  await h.fence();
  await checkSources(instance.material);
  const sources = await sourcePair(instance);
  const result = await h.command(
    [
      h.docker,
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
      "--no-build",
      "--pull",
      "never",
    ],
    instance.root
  );
  // Latch the complete exact inventory before any later readiness or permission assertion.
  const observed = await resources(h, instance);
  instance.original = { resources: observed, sources };
  instance.bootstrapped = true;
  h.successful(result);
  await waitSql(h, instance);
  requireValue(
    (await sql(
      h,
      instance,
      "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename='marker'"
    )) === "0"
  );
  // Exactly one seed call. No upsert, polling write or automatic retry.
  await h.fence();
  h.successful(
    await h.command(
      [
        h.docker,
        "container",
        "exec",
        container(observed, "db"),
        "psql",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        "postgres",
        "-d",
        "fixture",
        "-c",
        `CREATE TABLE marker(id integer primary key,value text not null); INSERT INTO marker VALUES (1,'${instance.marker}');`,
      ],
      instance.root
    )
  );
  requireValue(
    (await sql(h, instance, "SELECT value FROM marker WHERE id=1")) ===
      instance.marker
  );
  await checkSources(instance.material);
  await checkSources(sources);
}
async function retainedRunning(h: Fixture, instance: Checkout) {
  requireValue(
    (await sql(h, instance, "SELECT value FROM marker WHERE id=1")) ===
      instance.marker
  );
  await savedRetained(h, instance);
  return permissionRead(h, instance, "retained");
}
async function activeSourceRefusal(h: Fixture) {
  const instance = h.first,
    before = await savedRetained(h, instance),
    originals = await resources(h, instance),
    sibling = await resources(h, h.second);
  requireValue(originals.container.every((row) => row.running === true));
  const directory = join(h.ctx.tempRoot, "source-readonly-guard"),
    marker = join(directory, "unexpected-effect.json");
  await mkdir(directory, { mode: 0o700 });
  const prepared = before.prepared;
  requireValue(isRecord(prepared) && typeof prepared.id === "string");
  const scope = {
    projectRoot: instance.root,
    project: instance.name,
    containerIds: originals.container.map((row) => row.id),
    networkId: originals.network[0]?.id,
    volumeName: originals.volume[0]?.name,
    generationId: prepared.id,
    reader: container(originals, "reader"),
    targets: instance.grants.map((grant) => grant.target),
  };
  const control = fileURLToPath(
    new URL("../native-file-permission-control.ts", import.meta.url)
  );
  await writeFile(
    join(directory, "docker"),
    `#!${process.execPath}\nimport {open} from 'node:fs/promises';\nimport {nativeProtectedFileReadAllowed} from ${JSON.stringify(control)};\nconst args=process.argv.slice(2),engine=${JSON.stringify(h.docker)},scope=${JSON.stringify(scope)};\nconst proof=Bun.spawn([engine,'info','--format','{{json .ID}}'],{stdin:'ignore',stdout:'pipe',stderr:'ignore'});const text=await new Response(proof.stdout).text();if(text.length>4096||await proof.exited!==0||JSON.parse(text)!==${JSON.stringify(h.baseline.engine)})process.exit(95);\nif(!nativeProtectedFileReadAllowed({...scope,args})){const file=await open(${JSON.stringify(marker)},'wx',0o600);try{await file.writeFile(JSON.stringify({version:1,stage:'effect-refused-before-forwarding'}));await file.sync()}finally{await file.close()}process.exit(98)}\nconst child=Bun.spawn([engine,...args],{stdin:'inherit',stdout:'inherit',stderr:'inherit'});process.exit(await child.exited);\n`,
    { mode: 0o700, flag: "wx" }
  );
  const path = h.env.PATH;
  requireValue(path);
  const withheld = join(h.ctx.tempRoot, "active-material-withheld");
  await h.fence();
  await rename(join(instance.root, "material"), withheld);
  try {
    for (const args of [
      ["restart", "--json"],
      ["--json", "exec", "reader", "--", "true"],
    ]) {
      const refused = await h.invoke(instance, args, undefined, {
        PATH: `${directory}:${path}`,
      });
      // Always inspect the journal and physical originals independently of the
      // diagnostic, so an arbitrary earlier refusal cannot hide a mutation.
      const receipt = await retainedReceipt(instance),
        observed = await resources(h, instance),
        siblingAfter = await resources(h, h.second);
      requireValue(
        refused.exitCode !== 0 &&
          nativeProtectedFileStateRefused(object(refused.stdout))
      );
      requireValue(
        canonical(receipt) === canonical(before) &&
          receipt.pendingOperation === null &&
          canonical(observed) === canonical(originals) &&
          canonical(siblingAfter) === canonical(sibling)
      );
      try {
        await lstat(marker);
        requireValue(false);
      } catch (error: unknown) {
        requireValue(isRecord(error) && error.code === "ENOENT");
      }
    }
  } finally {
    await rename(withheld, join(instance.root, "material"));
  }
  await checkSources(instance.material);
  await h.fence();
  h.successful(await h.invoke(instance, ["exec", "reader", "--", "true"]));
  requireValue(
    canonical(await resources(h, instance)) === canonical(originals) &&
      canonical(await resources(h, h.second)) === canonical(sibling)
  );
  h.ctx.log(
    "Missing current source refused restart and exec before effects or journal changes; original source incarnation restored"
  );
}
async function interruptedStart(h: Fixture) {
  const instance = h.first,
    sibling = h.second;
  h.successful(await h.invoke(instance, ["down", "--json"]));
  const stopped = await resources(h, instance);
  requireValue(stopped.container.every((row) => row.running === false));
  const before = await savedRetained(h, instance),
    siblingBefore = await resources(h, sibling);
  const directory = join(h.ctx.tempRoot, "interrupted-start"),
    marker = join(directory, "armed.json");
  await mkdir(directory, { mode: 0o700 });
  const ids = stopped.container.map((row) => row.id);
  const wrapper = join(directory, "docker");
  const control = fileURLToPath(
    new URL("../native-file-permission-control.ts", import.meta.url)
  );
  const prepared = before.prepared;
  requireValue(isRecord(prepared) && typeof prepared.id === "string");
  const scope = {
    projectRoot: instance.root,
    project: instance.name,
    containerIds: ids,
    networkId: stopped.network[0]?.id,
    volumeName: stopped.volume[0]?.name,
    generationId: prepared.id,
    reader: container(stopped, "reader"),
    targets: instance.grants.map((grant) => grant.target),
  };
  await writeFile(
    wrapper,
    `#!${process.execPath}\nimport {open,lstat,readFile} from 'node:fs/promises';\nimport {nativeProtectedFileReadAllowed,nativeProtectedFileStartAllowed} from ${JSON.stringify(control)};\nconst args=process.argv.slice(2),engine=${JSON.stringify(h.docker)},scope=${JSON.stringify(scope)};\nconst proof=Bun.spawn([engine,'info','--format','{{json .ID}}'],{stdin:'ignore',stdout:'pipe',stderr:'ignore'});const engineText=await new Response(proof.stdout).text();if(engineText.length>4096||await proof.exited!==0||JSON.parse(engineText)!==${JSON.stringify(h.baseline.engine)})process.exit(95);\nconst receiptPath=${JSON.stringify(join(instance.root, ".hack/.internal/legacy-compose-adoption-v1/receipt.json"))};const info=await lstat(receiptPath);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size>65536||(info.mode&511)!==384)process.exit(98);const receipt=JSON.parse(await readFile(receiptPath,'utf8'));\nif(args[0]==='container'&&args[1]==='start'){\nif(!nativeProtectedFileStartAllowed({args,ids:${JSON.stringify(ids)},prepared:${JSON.stringify(prepared)},receipt}))process.exit(98);\nconst file=await open(${JSON.stringify(marker)},'wx',0o600);try{await file.writeFile(JSON.stringify({version:1,stage:'journaled-start-before-effect',ids:${JSON.stringify(ids)}}));await file.sync();}finally{await file.close()}process.exit(71);}\nif(!nativeProtectedFileReadAllowed({...scope,args}))process.exit(98);\nconst child=Bun.spawn([engine,...args],{stdin:'inherit',stdout:'inherit',stderr:'inherit'});process.exit(await child.exited);\n`,
    { mode: 0o700, flag: "wx" }
  );
  const originalPath = h.env.PATH;
  requireValue(originalPath);
  const failed = await h.invoke(
    instance,
    ["up", "--detach", "--json"],
    undefined,
    { PATH: `${directory}:${originalPath}` }
  );
  requireValue(failed.exitCode !== 0);
  const admitted = object(await readFile(marker, "utf8"));
  requireValue(
    admitted.stage === "journaled-start-before-effect" &&
      canonical(admitted.ids) === canonical(ids)
  );
  const pending = await retainedReceipt(instance);
  requireValue(
    isRecord(pending.pendingOperation) &&
      pending.pendingOperation.operation === "start" &&
      canonical(pending.pendingOperation.generation) ===
        canonical(
          before.publication && isRecord(before.publication)
            ? before.publication.generation
            : null
        ) &&
      canonical(pending.prepared) === canonical(before.prepared)
  );
  requireValue(canonical(await resources(h, instance)) === canonical(stopped));
  requireValue(
    canonical(await resources(h, sibling)) === canonical(siblingBefore)
  );
  // Only this synthetic source directory is withheld. Saved stop/recovery and rollback must not read it.
  const withheld = join(h.ctx.tempRoot, "first-material-withheld");
  await rename(join(instance.root, "material"), withheld);
  try {
    const exec = await h.invoke(instance, ["exec", "reader", "--", "true"]);
    requireValue(exec.exitCode !== 0);
    h.successful(await h.invoke(instance, ["down", "--recover", "--json"]));
    requireValue((await retainedReceipt(instance)).pendingOperation === null);
    requireValue(
      (await resources(h, instance)).container.every(
        (row) => row.running === false
      )
    );
    h.successful(
      await h.invoke(instance, ["config", "adopt", "--rollback", "--json"])
    );
    instance.rolledBack = true;
    await checkSources(instance.original?.sources ?? []);
    requireValue(
      canonical(await resources(h, sibling)) === canonical(siblingBefore)
    );
  } finally {
    await rename(withheld, join(instance.root, "material"));
  }
  await checkSources(instance.material);
  h.ctx.log(
    "Journaled retained start interruption kept exact originals; source-free saved stop recovery and rollback preserved sibling"
  );
}
async function retainedFlow(h: Fixture) {
  await bootstrap(h, h.first);
  await bootstrap(h, h.second);
  for (const instance of [h.first, h.second]) {
    const before = await resources(h, instance);
    const preview = object(
      h.successful(
        await h.invoke(instance, [
          "config",
          "adopt",
          "--dry-run",
          "--stop",
          "--json",
        ])
      )
    );
    requireValue(preview.complete === true);
    requireValue(canonical(await resources(h, instance)) === canonical(before));
    h.successful(
      await h.invoke(instance, ["config", "adopt", "--stop", "--json"])
    );
    requireValue(
      (await resources(h, instance)).container.every(
        (row) => row.running === false
      )
    );
    h.successful(await h.invoke(instance, ["up", "--detach", "--json"]));
    await waitSql(h, instance);
    const guest = await retainedRunning(h, instance);
    h.successful(await h.invoke(instance, ["restart", "--json"]));
    await waitSql(h, instance);
    requireValue(
      canonical(await retainedRunning(h, instance)) === canonical(guest)
    );
    await h.fence();
  }
  requireValue(
    h.first.original &&
      h.second.original &&
      h.first.original.resources.volume[0]?.name !==
        h.second.original.resources.volume[0]?.name &&
      h.first.material.every((pin) =>
        h.second.material.every(
          (other) => pin.dev !== other.dev || pin.ino !== other.ino
        )
      )
  );
  await activeSourceRefusal(h);
  await interruptedStart(h);
  h.successful(await h.invoke(h.second, ["down", "--json"]));
  requireValue(
    (await resources(h, h.second)).container.every(
      (row) => row.running === false
    )
  );
  h.successful(
    await h.invoke(h.second, ["config", "adopt", "--rollback", "--json"])
  );
  h.second.rolledBack = true;
  await checkSources(h.second.original.sources);
  await checkSources(h.second.material);
}
async function removeRetained(h: Fixture, instance: Checkout) {
  if (!instance.bootstrapped) {
    return;
  }
  requireValue(instance.original);
  // Never dispatch a cleanup down through the legacy path if adoption did not
  // reach this exact active file8 receipt. Unknown bootstrap/publication is
  // retained for explicit inspection instead of inferred or replayed.
  if (!instance.rolledBack) {
    await retainedReceipt(instance);
    h.successful(await h.invoke(instance, ["down", "--recover", "--json"]));
    h.successful(
      await h.invoke(instance, ["config", "adopt", "--rollback", "--json"])
    );
    instance.rolledBack = true;
  }
  const stopped = await resources(h, instance);
  requireValue(
    stopped.container.every(
      (row) =>
        row.running === false && row.paused === false && row.status === "exited"
    )
  );
  await checkSources(instance.original.sources);
  await checkSources(instance.material);
  await h.fence();
  const remainingIds = stopped.container.map((row) => row.id);
  requireValue(
    remainingIds.every((id) => typeof id === "string" && ID.test(id))
  );
  for (const pin of stopped.container) {
    await h.fence();
    await h.assertEngine();
    requireValue(
      canonical(await h.list("container", instance.name)) ===
        canonical([...remainingIds].sort())
    );
    requireValue(
      typeof pin.id === "string" &&
        nativeProtectedFileRemovalMatches({
          pin,
          current: await h.inspect("container", pin.id),
          kind: "container",
        })
    );
    h.successful(await h.command([h.docker, "container", "rm", pin.id]));
    remainingIds.splice(remainingIds.indexOf(pin.id), 1);
  }
  requireValue((await h.list("container", instance.name)).length === 0);
  const network = stopped.network[0],
    volume = stopped.volume[0];
  requireValue(
    network &&
      volume &&
      typeof network.id === "string" &&
      typeof volume.name === "string"
  );
  await h.fence();
  await h.assertEngine();
  requireValue(
    canonical(await h.list("network", instance.name)) ===
      canonical([network.id])
  );
  requireValue(
    nativeProtectedFileRemovalMatches({
      pin: network,
      current: await h.inspect("network", network.id),
      kind: "network",
    })
  );
  h.successful(await h.command([h.docker, "network", "rm", network.id]));
  await h.fence();
  await h.assertEngine();
  requireValue(
    (await h.list("network", instance.name)).length === 0 &&
      canonical(await h.list("volume", instance.name)) ===
        canonical([volume.name])
  );
  requireValue(
    (
      await h.probe([
        "container",
        "ls",
        "--all",
        "--no-trunc",
        "--filter",
        `volume=${volume.name}`,
        "--format",
        "{{.ID}}",
      ])
    ).trim() === ""
  );
  requireValue(
    nativeProtectedFileRemovalMatches({
      pin: volume,
      current: await h.inspect("volume", volume.name),
      kind: "volume",
    })
  );
  h.successful(await h.command([h.docker, "volume", "rm", volume.name]));
  for (const kind of ["container", "network", "volume"] as const) {
    requireValue((await h.list(kind, instance.name)).length === 0);
  }
  await checkSources(instance.original.sources);
  await checkSources(instance.material);
}
async function removeOrdinary(h: Fixture) {
  if (!h.ordinary.bootstrapped) {
    return;
  }
  await h.fence();
  const source = join(h.ordinary.root, "material"),
    withheld = join(h.ctx.tempRoot, "native-material-withheld");
  await rename(source, withheld);
  try {
    h.successful(await h.invoke(h.ordinary, ["down", "--recover", "--json"]));
  } finally {
    await rename(withheld, source);
  }
  await checkSources(h.ordinary.material);
  const observed = await fixtureEnvironment(h, () =>
    observeNativeComposeFixture(h.ordinary.root)
  );
  requireValue(
    observed.pending === null &&
      observed.stopped &&
      observed.observed.containers.length === 0 &&
      observed.observed.networks.length === 0 &&
      observed.observed.volumes.length === 0
  );
  for (const path of h.ordinary.privateMembers ?? []) {
    try {
      await lstat(path);
      requireValue(false);
    } catch (error: unknown) {
      requireValue(isRecord(error) && error.code === "ENOENT");
    }
  }
}
async function refusalBeforeEngine(h: Fixture) {
  const root = join(h.ctx.tempRoot, "invalid-mode"),
    name = `file-invalid-${randomBytes(4).toString("hex")}`;
  await mkdir(join(root, ".hack"), { recursive: true, mode: 0o700 });
  await mkdir(join(root, "material"), { mode: 0o700 });
  h.successful(await h.command([h.git, "init", "--quiet", root]));
  const source = await createMaterial(
    join(root, "material/private"),
    Buffer.from("synthetic-private-refusal"),
    0o400
  );
  await writeFile(
    join(root, ".hack/hack.config.json"),
    JSON.stringify({ name, worktree: { inherit: false } }),
    { flag: "wx", mode: 0o600 }
  );
  const compose = {
    name,
    services: {
      db: {
        image: h.baseline.tags[DB_TAG],
        pull_policy: "never",
        environment: {
          POSTGRES_HOST_AUTH_METHOD: "trust",
          POSTGRES_DB: "fixture",
        },
        volumes: ["data:/var/lib/postgresql/data"],
        restart: "no",
        stop_grace_period: "1s",
      },
      reader: {
        image: h.baseline.tags[BUN_TAG],
        pull_policy: "never",
        command: LOOP,
        restart: "no",
        stop_grace_period: "1s",
        secrets: [{ source: "private", mode: "0444" }],
      },
    },
    secrets: { private: { file: "../material/private" } },
    volumes: { data: { name: `${name}_data` } },
  };
  await writeFile(
    join(root, ".hack/docker-compose.yml"),
    JSON.stringify(compose),
    { flag: "wx", mode: 0o600 }
  );
  h.successful(
    await h.command([h.git, "-C", root, "config", "user.name", "Fixture"])
  );
  h.successful(
    await h.command([
      h.git,
      "-C",
      root,
      "config",
      "user.email",
      "fixture@example.invalid",
    ])
  );
  h.successful(
    await h.command([
      h.git,
      "-C",
      root,
      "add",
      ".hack/hack.config.json",
      ".hack/docker-compose.yml",
    ])
  );
  h.successful(
    await h.command([
      h.git,
      "-C",
      root,
      "commit",
      "--quiet",
      "-m",
      "fixture: explicit-mode source refusal",
    ])
  );
  const shimRoot = join(h.ctx.tempRoot, "no-engine-mode-refusal"),
    marker = join(shimRoot, "invoked");
  await mkdir(shimRoot, { mode: 0o700 });
  await writeFile(
    join(shimRoot, "docker"),
    `#!${process.execPath}\nimport {open} from 'node:fs/promises';const file=await open(${JSON.stringify(marker)},'wx',0o600);await file.writeFile('unexpected-engine-query');await file.close();process.exit(98);\n`,
    { flag: "wx", mode: 0o700 }
  );
  const result = await h.invoke(
    { root, name, marker: "invalid", material: [source], grants: [] },
    ["config", "adopt", "--dry-run", "--stop", "--json"],
    undefined,
    { PATH: `${shimRoot}:${h.env.PATH}` }
  );
  requireValue(result.exitCode !== 0);
  const report = object(result.stdout);
  requireValue(report.complete === false);
  try {
    await lstat(marker);
    requireValue(false);
  } catch (error: unknown) {
    requireValue(isRecord(error) && error.code === "ENOENT");
  }
  for (const path of [
    join(root, ".hack/.internal/legacy-compose-adoption-v1"),
    join(root, ".hack/hack.project.json"),
  ]) {
    try {
      await lstat(path);
      requireValue(false);
    } catch (error: unknown) {
      requireValue(isRecord(error) && error.code === "ENOENT");
    }
  }
  // Positive control changes only the explicit declaration. Same source mode/owner
  // now passes the material gate and reaches the rejecting (never-forwarding) shim.
  compose.services.reader.secrets[0]!.mode = "0400";
  await writeFile(
    join(root, ".hack/docker-compose.yml"),
    JSON.stringify(compose)
  );
  const permitted = await h.invoke(
    { root, name, marker: "valid-source", material: [source], grants: [] },
    ["config", "adopt", "--dry-run", "--stop", "--json"],
    undefined,
    { PATH: `${shimRoot}:${h.env.PATH}` }
  );
  requireValue(permitted.exitCode !== 0);
  requireValue((await readFile(marker, "utf8")) === "unexpected-engine-query");
  await checkSources([source]);
  requireValue(canonical(await h.inventory()) === canonical(h.baseline));
}
/**
 * Explicit, synthetic-only ordinary + retained permission qualification. No ports,
 * pulls, builds, global DNS/trust, caller material or broad cleanup. Every original
 * remains its exact engine/ID/birth; stop/rollback precede non-forced removals.
 * A failure preserves bounded private captures and cannot be converted into pass.
 */
export const nativeConfigProtectedFilesScenario: Scenario = {
  name: "native-config-protected-files",
  tier: "docker",
  requiresExplicitSelection: true,
  preserveFixtureOnFailure: true,
  summary:
    "ordinary snapshots and two original retained worktrees preserve protected guest access, readonly binds, SQL and saved recovery",
  run: async (ctx) => {
    const h = await setup(ctx);
    try {
      await runWithOwnedCleanup({
        run: async () => {
          await writeFile(
            join(ctx.tempRoot, "protected-intent.json"),
            JSON.stringify({
              version: 1,
              source: process.env.HACK_E2E_SOURCE_REVISION,
              scope:
                "one ordinary native and two original retained synthetic file checkouts",
              replay: "refused",
            }),
            { mode: 0o600, flag: "wx" }
          );
          await refusalBeforeEngine(h);
          await ordinaryFlow(h);
          await retainedFlow(h);
        },
        cleanup: async () => {
          await removeRetained(h, h.first);
          await removeRetained(h, h.second);
          await removeOrdinary(h);
          await h.fence();
          requireValue(
            canonical(await h.inventory()) === canonical(h.baseline)
          );
          h.remaining();
          ctx.log(
            "Exact stopped original cleanup and full daemon/container/network/volume-birth/image/tag baseline verified"
          );
        },
        secondaryFailure: () =>
          ctx.retainFixtures(
            "Protected file exact cleanup is incomplete; original failure, private captures and saved anchors retained"
          ),
      });
      await h.fence();
      h.remaining();
      ctx.log(
        "Protected-file ordinary and retained access/lifecycle qualification passed"
      );
    } finally {
      h.stop();
    }
  },
};
