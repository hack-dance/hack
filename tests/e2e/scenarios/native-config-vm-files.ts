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
import { isRecord } from "../../../src/lib/guards.ts";
import {
  parseNativeComposeFileReference,
  sameNativeComposeFileState,
} from "../../../src/lib/native-compose-file-state.ts";
import { openNativeComposeGenerationStore } from "../../../src/lib/native-compose-generation.ts";
import {
  holdDirectory,
  readPrivate,
  recheckDirectories,
  sameFile,
} from "../../../src/lib/native-compose-private-state.ts";
import { decodeNativeComposeVmFileImage } from "../../../src/lib/native-compose-vm-file-owner.ts";
import {
  NATIVE_COMPOSE_VM_FILE_IMAGE,
  NATIVE_COMPOSE_VM_FILES_EXTENSION,
  parseVmFileFacts,
  parseVmFileJournal,
  VM_FILE_IMAGE_FORMAT,
  vmFileJournalReady,
} from "../../../src/lib/native-compose-vm-file-protocol.ts";
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
  seedIsolatedHackHome,
} from "../harness.ts";
import { runWithOwnedCleanup } from "../native-compose-owned-fixture.ts";
import {
  VM_FIXTURE_BYTES,
  VM_FIXTURE_GUEST,
  VM_FIXTURE_OTHER,
  VM_FIXTURE_TARGETS,
} from "../native-vm-file-guest.ts";
import {
  captureCompletedJobFixtureCommand,
  createCompletedJobFixtureSettlement,
} from "./native-compose-adoption-job-worktrees.ts";

const ID = /^[a-f0-9]{64}$/;
const SPACE = /\s+/;
const LIMIT = 2 * 1024 * 1024;
const FORMATS = {
  helper:
    '{"id":{{json .Id}},"name":{{json .Name}},"created":{{json .Created}},"image":{{json .Image}},"labels":{{json .Config.Labels}},"entrypoint":{{json .Config.Entrypoint}},"command":{{json .Config.Cmd}},"user":{{json .Config.User}},"openStdin":{{json .Config.OpenStdin}},"tty":{{json .Config.Tty}},"network":{{json .HostConfig.NetworkMode}},"ports":{{json .HostConfig.PortBindings}},"restart":{{json .HostConfig.RestartPolicy}},"readonly":{{json .HostConfig.ReadonlyRootfs}},"privileged":{{json .HostConfig.Privileged}},"capAdd":{{json .HostConfig.CapAdd}},"capDrop":{{json .HostConfig.CapDrop}},"security":{{json .HostConfig.SecurityOpt}},"autoRemove":{{json .HostConfig.AutoRemove}},"mounts":{{json .Mounts}},"running":{{json .State.Running}},"status":{{json .State.Status}},"exitCode":{{json .State.ExitCode}},"restarts":{{json .RestartCount}},"execs":{{json .ExecIDs}}}',
  container:
    '{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Image}},"created":{{json .Created}},"running":{{json .State.Running}},"status":{{json .State.Status}},"labels":{{json .Config.Labels}},"ports":{{json .HostConfig.PortBindings}},"publishAll":{{json .HostConfig.PublishAllPorts}},"mounts":{{json .Mounts}},"networks":{{json .NetworkSettings.Networks}}}',
  volume:
    '{"name":{{json .Name}},"driver":{{json .Driver}},"scope":{{json .Scope}},"created":{{json .CreatedAt}},"mountpoint":{{json .Mountpoint}},"labels":{{json .Labels}},"options":{{json .Options}}}',
} as const;
function requireValue(value: unknown): asserts value {
  if (!value) {
    throw new Error("VM-file acceptance refused; private evidence retained.");
  }
}
function object(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  requireValue(isRecord(value));
  return value;
}
function same(left: unknown, right: unknown): boolean {
  return sameNativeComposeFileState(left, right);
}
/** Ignore only the engine's mount order, retaining every field and multiplicity. */
export function nativeVmFixtureObserverMatched(
  actual: unknown,
  expected: unknown
): boolean {
  if (
    !(
      isRecord(actual) &&
      isRecord(expected) &&
      Array.isArray(actual.mounts) &&
      Array.isArray(expected.mounts) &&
      actual.running === true &&
      actual.status === "running" &&
      actual.restarts === 0 &&
      (actual.execs === null ||
        (Array.isArray(actual.execs) && actual.execs.length === 0))
    )
  ) {
    return false;
  }
  const observedMounts = actual.mounts,
    expectedMounts = expected.mounts;
  if (
    observedMounts.length !== expectedMounts.length ||
    !observedMounts.every(
      (row) =>
        observedMounts.filter((other) => same(row, other)).length ===
        expectedMounts.filter((other) => same(row, other)).length
    )
  ) {
    return false;
  }
  const { running, status, exitCode, restarts, execs, ...immutable } = actual;
  return same({ ...immutable, mounts: expectedMounts }, expected);
}
function digest(value: Uint8Array | string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}
function decode(value: string): string {
  return value.replaceAll("$$", () => "$");
}
function anchor(value: unknown) {
  requireValue(
    isRecord(value) &&
      Object.keys(value).sort().join() === "dev,digest,ino" &&
      typeof value.dev === "number" &&
      Number.isSafeInteger(value.dev) &&
      value.dev >= 0 &&
      typeof value.ino === "number" &&
      Number.isSafeInteger(value.ino) &&
      value.ino > 0 &&
      typeof value.digest === "string" &&
      ID.test(value.digest)
  );
  return { dev: value.dev, ino: value.ino, digest: value.digest };
}

/** Closed source builder shared with the effect-free mapper/compiler controls. */
export function nativeVmFileFixtureSource(opts: {
  readonly name: string;
  readonly image: string;
}) {
  return {
    schema_version: 1,
    name: opts.name,
    worktree: { auto_branch: false, inherit_local: false },
    secrets: {
      owner: { file: "owner.bin" },
      private: { file: "private.bin" },
      unused: { file: "unused.bin" },
    },
    services: {
      reader: {
        image: opts.image,
        pull_policy: "never",
        command: { exec: ["bun", "-e", "setInterval(()=>{},60000)"] },
        restart: { kind: "no" },
        shutdown: { signal: "SIGTERM", grace: "1s" },
        mounts: [
          {
            secret: "owner",
            target: VM_FIXTURE_TARGETS[0],
            access: "read-only",
            mode: "0400",
          },
          {
            secret: "private",
            target: VM_FIXTURE_TARGETS[1],
            access: "read-only",
            mode: "0600",
            uid: 10_001,
            gid: 10_002,
          },
        ],
      },
      ungranted: {
        image: opts.image,
        pull_policy: "never",
        command: { exec: ["bun", "-e", "setInterval(()=>{},60000)"] },
        restart: { kind: "no" },
        shutdown: { signal: "SIGTERM", grace: "1s" },
      },
    },
  };
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
    requireValue(generation);
    const document = await store.withLease({
      generation,
      run: () => store.readGenerationDocument(generation),
    });
    const host = parseNativeComposeFileReference(
      document["x-hack-native-files"]
    );
    const ref = document[NATIVE_COMPOSE_VM_FILES_EXTENSION];
    requireValue(
      isRecord(ref) &&
        ref.version === 1 &&
        same(ref.host, host) &&
        isRecord(ref.manifest) &&
        isRecord(ref.journal)
    );
    const directory = join(
      host.root,
      `${host.generationId}-${host.snapshotToken}`
    );
    const manifestAnchor = anchor(ref.manifest),
      savedJournalAnchor = anchor(ref.journal);
    const held = await holdDirectory(directory, true);
    try {
      requireValue(sameFile(held.info, host.snapshotDirectory));
      const manifestRead = await readPrivate(
        join(directory, "vm-manifest.json"),
        LIMIT
      );
      requireValue(
        sameFile(manifestRead.info, manifestAnchor) &&
          digest(manifestRead.text) === manifestAnchor.digest
      );
      const rawManifest = object(manifestRead.text),
        facts = parseVmFileFacts(JSON.stringify(rawManifest.facts));
      const volume = rawManifest.volume,
        observer = rawManifest.observer;
      requireValue(
        isRecord(volume) &&
          typeof volume.name === "string" &&
          typeof volume.mountpoint === "string" &&
          isRecord(observer) &&
          typeof observer.id === "string" &&
          ID.test(observer.id)
      );
      const manifest = {
        ...rawManifest,
        volume: { ...volume, name: volume.name, mountpoint: volume.mountpoint },
        observer: { ...observer, id: observer.id, labels: observer.labels },
      };
      requireValue(
        isRecord(manifest.volume) &&
          typeof manifest.volume.name === "string" &&
          typeof manifest.volume.mountpoint === "string" &&
          isRecord(manifest.observer) &&
          typeof manifest.observer.id === "string" &&
          ID.test(manifest.observer.id)
      );
      requireValue(
        same(rawManifest.host, host) &&
          facts.members.length === 2 &&
          facts.members.every((row) => row.workload === "reader")
      );
      requireValue(
        isRecord(document.services) &&
          isRecord(document.services.reader) &&
          Array.isArray(document.services.reader.volumes) &&
          document.services.reader.volumes.length === 2 &&
          isRecord(document.services.ungranted) &&
          (!Object.hasOwn(document.services.ungranted, "volumes") ||
            (Array.isArray(document.services.ungranted.volumes) &&
              document.services.ungranted.volumes.length === 0))
      );
      for (const row of facts.members) {
        const authored =
          row.target === VM_FIXTURE_TARGETS[0]
            ? { mode: "0400", uid: 0, gid: 0 }
            : row.target === VM_FIXTURE_TARGETS[1]
              ? { mode: "0600", uid: 10_001, gid: 10_002 }
              : null;
        requireValue(
          authored &&
            row.mode === authored.mode &&
            row.uid === authored.uid &&
            row.gid === authored.gid &&
            row.digest === digest(VM_FIXTURE_BYTES)
        );
        requireValue(
          document.services.reader.volumes.filter(
            (raw) =>
              isRecord(raw) &&
              raw.type === "bind" &&
              typeof raw.source === "string" &&
              decode(raw.source) ===
                `${manifest.volume.mountpoint}/${row.id}` &&
              typeof raw.target === "string" &&
              decode(raw.target) === row.target &&
              raw.read_only === true &&
              isRecord(raw.bind) &&
              raw.bind.create_host_path === false
          ).length === 1
        );
      }
      const journal = await readPrivate(
        join(directory, "vm-journal.jsonl"),
        LIMIT
      );
      requireValue(sameFile(journal.info, savedJournalAnchor));
      const header = `${journal.text.split("\n")[0]}\n`;
      requireValue(
        digest(header) === savedJournalAnchor.digest &&
          vmFileJournalReady(parseVmFileJournal({ text: journal.text, header }))
      );
      await recheckDirectories([held]);
      return {
        current,
        pending,
        generation,
        host,
        document,
        directory,
        manifest,
        facts,
        journalAnchor: journal.info,
        journalHeader: header,
      };
    } finally {
      await held.file.close();
    }
  } finally {
    await store.close();
  }
}
type Saved = Awaited<ReturnType<typeof saved>>;
type Runtime = Awaited<ReturnType<typeof setup>>;
type Instance = { readonly root: string; effects: boolean; selected?: Saved };

/** Nested production probes own detached groups. Any failed observation must
 * permanently veto fixture teardown even when the outer child has settled. */
export async function observeNativeVmFileFixture(opts: {
  readonly root: string;
  readonly command: (
    argv: readonly string[],
    cwd: string,
    timeout: number
  ) => Promise<CliResult>;
  readonly markUnconfirmed: () => void;
  readonly retain: () => void;
}) {
  const { root, command, markUnconfirmed, retain } = opts;
  try {
    const module = join(import.meta.dir, "../native-compose-owned-fixture.ts");
    const program = `const {observeNativeComposeFixture}=await import(${JSON.stringify(module)});const value=await observeNativeComposeFixture(${JSON.stringify(root)});console.log(JSON.stringify({stopped:value.stopped,pending:value.pending,containers:value.observed.containers.map(({id,service,state})=>({id,service,state})),networks:value.observed.networks.length,volumes:value.observed.volumes.length}));`;
    const result = await command(
      [process.execPath, "--no-env-file", "-e", program],
      root,
      30_000
    );
    requireValue(
      result.exitCode === 0 && !result.timedOut && result.stderr === ""
    );
    const value = object(result.stdout);
    requireValue(
      Object.keys(value).sort().join() ===
        "containers,networks,pending,stopped,volumes" &&
        typeof value.stopped === "boolean" &&
        value.pending === null &&
        Array.isArray(value.containers) &&
        typeof value.networks === "number" &&
        Number.isSafeInteger(value.networks) &&
        value.networks >= 0 &&
        typeof value.volumes === "number" &&
        Number.isSafeInteger(value.volumes) &&
        value.volumes >= 0
    );
    const containers = value.containers.map((row) => {
      requireValue(
        isRecord(row) &&
          Object.keys(row).sort().join() === "id,service,state" &&
          typeof row.id === "string" &&
          ID.test(row.id) &&
          typeof row.service === "string" &&
          typeof row.state === "string"
      );
      return { id: row.id, service: row.service, state: row.state };
    });
    return {
      stopped: value.stopped,
      pending: value.pending,
      containers,
      networks: value.networks,
      volumes: value.volumes,
    };
  } catch (error) {
    markUnconfirmed();
    retain();
    throw error;
  }
}

async function setup(ctx: ScenarioContext) {
  const deadline = Date.now() + 600_000,
    settlement = createCompletedJobFixtureSettlement();
  const cli = resolveCliSpawnArgs([]),
    docker = Bun.which("docker");
  requireValue(
    cli.length === 1 &&
      typeof cli[0] === "string" &&
      cli[0].startsWith("/") &&
      typeof docker === "string" &&
      docker.startsWith("/")
  );
  const compiler = process.env.HACK_CONFIG_COMPILER_BINARY;
  requireValue(typeof compiler === "string" && compiler.startsWith("/"));
  const captures = join(ctx.hackHome, "vm-file-captures");
  await mkdir(captures, { mode: 0o700 });
  const home = join(ctx.hackHome, "vm-file-home");
  await seedIsolatedHackHome({ hackHome: home });
  await chmod(home, 0o700);
  const env = buildCliEnv({
    hackHome: home,
    extra: {
      HACK_RUNTIME_BACKEND: "compose",
      HACK_COMPOSE_STARTUP_TIMEOUT_MS: "30000",
      HACK_DAEMON_DISABLE_DOCKER_EVENTS: "1",
      HACK_CONFIG_COMPILER_BINARY: compiler,
    },
  });
  let sequence = 0,
    bytes = 0;
  const command = async (
    argv: readonly string[],
    cwd: string,
    timeout: number
  ): Promise<CliResult> => {
    settlement.assertConfirmed();
    const remaining = deadline - Date.now();
    requireValue(remaining > 0 && sequence < 400);
    try {
      const result = await captureCompletedJobFixtureCommand({
        argv,
        cwd,
        env,
        captures: join(captures, String(++sequence).padStart(4, "0")),
        timeoutMs: Math.min(timeout, remaining),
        onUnconfirmed: settlement.markUnconfirmed,
      });
      settlement.assertConfirmed();
      bytes += Buffer.byteLength(result.combined);
      requireValue(bytes <= 16 * 1024 * 1024 && Date.now() < deadline);
      requireValue(!result.combined.includes(VM_FIXTURE_BYTES.toString()));
      return result;
    } catch (error) {
      ctx.retainFixtures(
        "VM-file command failed; retain exact private settlement and generation anchors"
      );
      throw error;
    }
  };
  const probe = async (args: readonly string[]) => {
    const result = await command([docker, ...args], ctx.tempRoot, 15_000);
    requireValue(result.exitCode === 0);
    return result.stdout.trim();
  };
  requireValue((await probe(["info", "--format", "{{.OSType}}"])) === "linux");
  const image = decodeNativeComposeVmFileImage({
    workload: "",
    reference: NATIVE_COMPOSE_VM_FILE_IMAGE,
    value: object(
      await probe([
        "image",
        "inspect",
        NATIVE_COMPOSE_VM_FILE_IMAGE,
        "--format",
        VM_FILE_IMAGE_FORMAT,
      ])
    ),
  });
  requireValue(image.user === "");
  const engine = await probe(["info", "--format", "{{json .ID}}"]);
  const inventory = async () => {
    const containers = await probe([
      "container",
      "ls",
      "--all",
      "--no-trunc",
      "--format",
      "{{json .ID}} {{json .State}}",
    ]);
    const networks = await probe([
      "network",
      "ls",
      "--no-trunc",
      "--format",
      "{{.ID}}",
    ]);
    const volumes: unknown[] = [];
    for (const name of (await probe(["volume", "ls", "--format", "{{.Name}}"]))
      .split(SPACE)
      .filter(Boolean)
      .sort()) {
      volumes.push(
        object(
          await probe(["volume", "inspect", "--format", FORMATS.volume, name])
        )
      );
    }
    const images = await probe([
      "image",
      "ls",
      "--all",
      "--no-trunc",
      "--format",
      "{{json .ID}} {{json .Repository}} {{json .Tag}}",
    ]);
    requireValue(
      (await probe(["info", "--format", "{{json .ID}}"])) === engine
    );
    return {
      engine,
      containers: containers.split("\n").filter(Boolean).sort(),
      networks: networks.split("\n").filter(Boolean).sort(),
      volumes,
      images: images.split("\n").filter(Boolean).sort(),
    };
  };
  const baseline = await inventory();
  const created = await createMonorepoFixture({
    parentDir: ctx.tempRoot,
    withHackConfig: false,
  });
  const root = await realpath(created.root);
  await mkdir(join(root, ".hack"));
  const source = JSON.stringify(
    nativeVmFileFixtureSource({ name: created.name, image: image.id })
  );
  await writeFile(join(root, ".hack/hack.project.json"), source);
  for (const name of ["owner.bin", "private.bin", "unused.bin"]) {
    await writeFile(join(root, name), VM_FIXTURE_BYTES, { mode: 0o600 });
    await chmod(join(root, name), 0o600);
  }
  await commitAll({ root, message: "synthetic new VM file fixture" });
  const invoke = async (instance: Instance, args: readonly string[]) =>
    await command(
      [...cli, "--path", instance.root, ...args],
      instance.root,
      90_000
    );
  const observe = async (instance: Instance) =>
    await observeNativeVmFileFixture({
      root: instance.root,
      command,
      markUnconfirmed: settlement.markUnconfirmed,
      retain: () =>
        ctx.retainFixtures(
          "VM-file whole-owner observation failed; detached probe settlement is unconfirmed"
        ),
    });
  return {
    ctx,
    root,
    created,
    source,
    image: image.id,
    docker,
    env,
    settlement,
    command,
    probe,
    inventory,
    baseline,
    invoke,
    observe,
  };
}
function successful(result: CliResult) {
  const value = object(result.stdout);
  requireValue(result.exitCode === 0 && value.ok === true && !result.timedOut);
}

async function verify(h: Runtime, instance: Instance): Promise<Saved> {
  const selected = await saved(instance.root),
    observed = await h.observe(instance);
  requireValue(
    !observed.stopped &&
      observed.pending === null &&
      observed.containers.length === 2 &&
      observed.volumes === 0 &&
      selected.pending === null
  );
  const rows = selected.facts.members.map((row) => ({
    target: row.target,
    file: row.file,
    digest: row.digest,
  }));
  for (const service of ["reader", "ungranted"] as const) {
    const container = observed.containers.find(
      (row) => row.service === service
    );
    requireValue(
      container && ID.test(container.id) && container.state === "running"
    );
    const metadata = object(
      await h.probe([
        "container",
        "inspect",
        "--format",
        FORMATS.container,
        container.id,
      ])
    );
    requireValue(
      metadata.image === h.image &&
        metadata.publishAll === false &&
        (metadata.ports === null ||
          (isRecord(metadata.ports) &&
            Object.keys(metadata.ports).length === 0)) &&
        Array.isArray(metadata.mounts)
    );
    if (service === "reader") {
      requireValue(metadata.mounts.length === 2);
      for (const row of selected.facts.members) {
        requireValue(
          metadata.mounts.filter(
            (m) =>
              isRecord(m) &&
              m.Type === "bind" &&
              m.Source === `${selected.manifest.volume.mountpoint}/${row.id}` &&
              m.Destination === row.target &&
              m.RW === false
          ).length === 1
        );
      }
    } else {
      requireValue(metadata.mounts.length === 0);
    }
    for (const [kind, uid, gid] of service === "reader"
      ? ([
          ["owner", 0, 0],
          ["owner", 10_001, 10_002],
          ["denied", VM_FIXTURE_OTHER, VM_FIXTURE_OTHER],
          ["readonly", 0, 0],
        ] as const)
      : ([["ungranted", 0, 0]] as const)) {
      const result = await h.command(
        [
          h.docker,
          "container",
          "exec",
          "--user",
          `${uid}:${gid}`,
          container.id,
          "/usr/local/bin/bun",
          "-e",
          VM_FIXTURE_GUEST,
          JSON.stringify({ kind, uid, gid, rows }),
        ],
        instance.root,
        15_000
      );
      requireValue(
        result.exitCode === 0 &&
          result.stderr === "" &&
          result.stdout === `vm-file-guest-${kind}-passed`
      );
    }
  }
  const volume = object(
    await h.probe([
      "volume",
      "inspect",
      "--format",
      FORMATS.volume,
      String(selected.manifest.volume.name),
    ])
  );
  requireValue(same(volume, selected.manifest.volume));
  const observer = object(
    await h.probe([
      "container",
      "inspect",
      "--format",
      FORMATS.helper,
      String(selected.manifest.observer.id),
    ])
  );
  requireValue(
    nativeVmFixtureObserverMatched(observer, selected.manifest.observer)
  );
  for (const name of ["owner.bin", "private.bin", "unused.bin"]) {
    const file = await lstat(join(instance.root, name));
    requireValue(
      file.isFile() &&
        file.mode % 512 === 0o600 &&
        digest(await readFile(join(instance.root, name))) ===
          digest(VM_FIXTURE_BYTES)
    );
  }
  return selected;
}

async function stop(h: Runtime, instance: Instance) {
  h.settlement.assertConfirmed();
  const selected = instance.selected;
  successful(await h.invoke(instance, ["down", "--recover", "--json"]));
  const observed = await h.observe(instance);
  requireValue(
    observed.stopped &&
      observed.pending === null &&
      observed.containers.length === 0 &&
      observed.networks === 0 &&
      observed.volumes === 0
  );
  if (selected) {
    await retired(h, selected);
  }
  instance.effects = false;
}

async function retired(h: Runtime, selected: Saved) {
  const journal = await readPrivate(
    join(selected.directory, "vm-journal.jsonl"),
    LIMIT
  );
  requireValue(
    sameFile(journal.info, selected.journalAnchor) &&
      parseVmFileJournal({
        text: journal.text,
        header: selected.journalHeader,
      }).at(-1) === "retired"
  );
  const containers = (
    await h.probe([
      "container",
      "ls",
      "--all",
      "--no-trunc",
      "--format",
      "{{.ID}}",
    ])
  ).split(SPACE);
  const volumes = (
    await h.probe(["volume", "ls", "--format", "{{.Name}}"])
  ).split(SPACE);
  requireValue(
    !(
      containers.includes(String(selected.manifest.observer.id)) ||
      volumes.includes(String(selected.manifest.volume.name))
    )
  );
}

/** Explicit selection until real provider delivery is qualified. No retained adoption policy changes. */
export const nativeConfigVmFilesScenario: Scenario = {
  name: "native-config-vm-files",
  tier: "docker",
  requiresExplicitSelection: true,
  preserveFixtureOnFailure: true,
  summary:
    "ordinary new-container VM files: exact modes/UIDs, owner read/nonowner EACCES/root EROFS, linked isolation and saved singleton retirement",
  run: async (ctx) => {
    const h = await setup(ctx),
      instances: Instance[] = [{ root: h.root, effects: false }];
    await runWithOwnedCleanup({
      run: async () => {
        const beta = await addLinkedWorktree({
          fixture: h.created,
          branch: "vm-file-beta",
        });
        for (const name of ["owner.bin", "private.bin", "unused.bin"]) {
          await chmod(join(beta, name), 0o600);
        }
        instances.push({ root: beta, effects: false });
        for (const instance of instances) {
          instance.effects = true;
          successful(await h.invoke(instance, ["up", "--detach", "--json"]));
          instance.selected = await verify(h, instance);
        }
        const alpha = instances[0],
          sibling = instances[1];
        requireValue(alpha?.selected && sibling?.selected);
        requireValue(
          alpha.selected.manifest.volume.name !==
            sibling.selected.manifest.volume.name &&
            alpha.selected.manifest.observer.id !==
              sibling.selected.manifest.observer.id
        );
        const first = alpha.selected,
          siblingPin = sibling.selected;
        successful(await h.invoke(alpha, ["ps", "--json"]));
        successful(await h.invoke(alpha, ["restart", "--json"]));
        alpha.selected = await verify(h, alpha);
        requireValue(
          alpha.selected.generation.generationId !==
            first.generation.generationId &&
            alpha.selected.manifest.volume.name !==
              first.manifest.volume.name &&
            alpha.selected.manifest.observer.id !== first.manifest.observer.id
        );
        await retired(h, first);
        sibling.selected = await verify(h, sibling);
        requireValue(same(sibling.selected.manifest, siblingPin.manifest));
        await writeFile(
          join(alpha.root, ".hack/hack.project.json"),
          "unavailable source"
        );
        for (const name of ["owner.bin", "private.bin", "unused.bin"]) {
          await unlink(join(alpha.root, name));
        }
        await stop(h, alpha); // Saved stop/recovery must not reacquire deleted authored material.
        sibling.selected = await verify(h, sibling);
        requireValue(same(sibling.selected.manifest, siblingPin.manifest));
        await writeFile(join(alpha.root, ".hack/hack.project.json"), h.source);
        for (const name of ["owner.bin", "private.bin", "unused.bin"]) {
          await writeFile(join(alpha.root, name), VM_FIXTURE_BYTES, {
            mode: 0o600,
          });
          await chmod(join(alpha.root, name), 0o600);
        }
        alpha.effects = true;
        successful(await h.invoke(alpha, ["up", "--detach", "--json"]));
        alpha.selected = await verify(h, alpha);
        requireValue(
          alpha.selected.generation.generationId !==
            first.generation.generationId &&
            alpha.selected.manifest.volume.name !==
              first.manifest.volume.name &&
            alpha.selected.manifest.observer.id !== first.manifest.observer.id
        );
        ctx.log(
          "VM files: actual owner reads, EACCES, EROFS, exact single-file/ungranted and linked saved lifecycle checks passed"
        );
      },
      cleanup: async () => {
        h.settlement.assertConfirmed();
        for (const instance of instances) {
          if (instance.effects) {
            await stop(h, instance);
          }
        }
        requireValue(same(await h.inventory(), h.baseline));
        h.settlement.assertConfirmed();
      },
      secondaryFailure: () =>
        ctx.retainFixtures(
          "VM-file saved stop/retirement is incomplete; exact resources and recovery anchors retained"
        ),
    });
  },
};
