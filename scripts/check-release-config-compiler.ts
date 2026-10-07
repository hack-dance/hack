#!/usr/bin/env bun
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isRecord } from "../src/lib/guards.ts";

const SCHEMAS = ["hack.project.schema.json", "hack.local.schema.json"] as const;
const HASH = /^[a-f0-9]{64}$/;
const root = resolve(import.meta.dir, "..");
const releaseRoot = resolve(Bun.argv[2] ?? join(root, "dist/release"));
const suffix = `-${process.platform}-${process.arch === "x64" ? "x86_64" : process.arch}.tar.gz`;
const archives = (await readdir(releaseRoot)).filter(
  (name) => name.startsWith("hack-") && name.endsWith(suffix)
);
require(archives.length === 1, "exactly one host release archive is required");
const archive = archives[0];
require(archive !== undefined, "host release archive");
const version = archive.slice("hack-".length, -suffix.length);
const directory = await mkdtemp(join(tmpdir(), "hack-release-compiler-"));
try {
  const extracted = join(directory, "extracted");
  const releases = join(directory, "releases");
  const download = join(releases, `v${version}`);
  const installerTools = join(directory, "installer-tools");
  const runtimeTools = join(directory, "runtime-tools");
  await Promise.all(
    [extracted, download, installerTools, runtimeTools].map((path) =>
      mkdir(path, { recursive: true })
    )
  );
  await copyFile(join(releaseRoot, archive), join(download, archive));
  await run({
    command: [
      systemTool("tar"),
      "--no-same-owner",
      "-xzf",
      join(download, archive),
      "-C",
      extracted,
    ],
    cwd: directory,
  });
  const bundle = join(extracted, `hack-${version}-release`);
  await run({
    command:
      process.platform === "darwin"
        ? [systemTool("shasum"), "-a", "256", "-c", "SHA256SUMS"]
        : [systemTool("sha256sum"), "-c", "SHA256SUMS"],
    cwd: bundle,
  });
  const sums = new Map(
    (await Bun.file(join(bundle, "SHA256SUMS")).text())
      .trim()
      .split("\n")
      .map((line) => {
        const [hash, name] = line.split("  ");
        require(hash !== undefined &&
          HASH.test(hash) &&
          name !== undefined, "release checksum record");
        return [name, hash] as const;
      })
  );
  for (const name of [
    "hack",
    "hack-config-compiler",
    ...SCHEMAS.map((schema) => `assets/schemas/${schema}`),
  ]) {
    require(sums.has(name), `release checksum covers ${name}`);
  }
  for (const schema of SCHEMAS) {
    require((await sha256(join(bundle, "assets/schemas", schema))) ===
      (await sha256(
        join(root, "packages/config-compiler/generated", schema)
      )), `release schema matches the compiler projection: ${schema}`);
  }
  for (const name of [
    "bash",
    "basename",
    "chmod",
    "cp",
    "curl",
    "dirname",
    "gzip",
    "head",
    "mkdir",
    "mktemp",
    "rm",
    "sed",
    "tar",
    "tr",
    "uname",
  ]) {
    await symlink(systemTool(name), join(installerTools, name));
  }
  await symlink(systemTool("bash"), join(runtimeTools, "bash"));
  await verifyNetworkDenial({ cwd: directory });
  for (const kind of ["normal", "slim"] as const) {
    await checkInstallation({
      kind,
      directory,
      releaseRoot,
      releases,
      version,
      installerTools,
      runtimeTools,
      sums,
    });
  }
  process.stdout.write(
    `Release compiler acceptance (${process.platform}/${process.arch}): independent checksums, generated schemas, actual normal/slim download installs, installed and relocated validate/plan, network denial, missing/mismatch refusal, no PATH fallback and legacy config passed\n`
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}

/** Use the assembled download/install scripts, then only their installed executable bytes. */
async function checkInstallation(opts: {
  readonly kind: "normal" | "slim";
  readonly directory: string;
  readonly releaseRoot: string;
  readonly releases: string;
  readonly version: string;
  readonly installerTools: string;
  readonly runtimeTools: string;
  readonly sums: ReadonlyMap<string, string>;
}): Promise<void> {
  const fixture = join(opts.directory, opts.kind);
  const installed = join(fixture, "installed");
  const bin = join(installed, "bin");
  const assets = join(installed, "assets");
  const home = join(fixture, "home");
  const temporary = join(fixture, "temporary");
  const project = join(fixture, "project");
  const legacy = join(fixture, "legacy");
  const relocated = join(fixture, "relocated");
  await Promise.all(
    [
      home,
      temporary,
      join(project, ".hack"),
      join(legacy, ".hack"),
      relocated,
    ].map((path) => mkdir(path, { recursive: true }))
  );
  const env = {
    HOME: home,
    HACK_HOME: join(home, ".hack"),
    PATH: opts.runtimeTools,
    HACK_DAEMON_DISABLE_DOCKER_EVENTS: "1",
    HACK_LOGGER: "console",
    NO_COLOR: "1",
    TERM: "dumb",
  };
  const script = `hack-${opts.version}-${opts.kind === "slim" ? "codex-" : ""}install.sh`;
  await run({
    command: [systemTool("bash"), join(opts.releaseRoot, script)],
    cwd: fixture,
    env: {
      ...env,
      PATH: `${bin}:${opts.installerTools}`,
      TMPDIR: temporary,
      HACK_INSTALL_TAG: `v${opts.version}`,
      HACK_RELEASE_BASE_URL: pathToFileURL(opts.releases).href,
      HACK_INSTALL_BIN: bin,
      HACK_INSTALL_ASSETS: assets,
    },
    // Decline optional global setup. PATH already includes the isolated install dir.
    input: "n\n",
    offline: true,
  });
  require((await readdir(temporary)).length ===
    0, "download extraction cleanup");
  const executable = opts.kind === "slim" ? "hack-real" : "hack";
  for (const [path, source] of [
    [join(bin, executable), "hack"],
    [join(bin, "hack-config-compiler"), "hack-config-compiler"],
    ...SCHEMAS.map((name) => [
      join(assets, "schemas", name),
      `assets/schemas/${name}`,
    ]),
  ]) {
    require(path !== undefined &&
      source !== undefined, "installed artifact path");
    const info = await lstat(path);
    require(info.isFile() &&
      !info.isSymbolicLink() &&
      info.nlink === 1 &&
      info.uid ===
        process.getuid?.(), `independent user-owned installed file: ${source}`);
    require((await sha256(path)) ===
      opts.sums.get(source), `installed bytes match release: ${source}`);
    if (source === "hack" || source === "hack-config-compiler") {
      require((info.mode & 0o111) !==
        0, `installed executable permission: ${source}`);
    }
  }
  const authored = join(project, ".hack/hack.project.json");
  await Bun.write(
    authored,
    JSON.stringify({
      schema_version: 1,
      name: "release-fixture",
      services: {
        web: {
          image: "example/web:1",
          environment: { TOKEN: { env_ref: "TOKEN" } },
        },
      },
    })
  );
  await Bun.write(
    join(project, ".hack/hack.env.default.yaml"),
    JSON.stringify({
      version: 1,
      environment: "default",
      secretsprovider: "project_key",
      values: {
        global: {
          TOKEN: { secure: "synthetic-managed-value-must-stay-private" },
        },
      },
    })
  );
  await mkdir(join(project, ".hack/.hack.secret.key"));
  const legacyConfig = '{"name":"legacy-fixture"}\n';
  await Bun.write(join(legacy, ".hack/hack.config.json"), legacyConfig);
  await Bun.write(join(legacy, ".hack/docker-compose.yml"), "services: {}\n");
  await validatedAndPlanned({ binary: join(bin, "hack"), project, env });
  for (const [from, to] of [
    [join(bin, executable), join(relocated, "hack")],
    [
      join(bin, "hack-config-compiler"),
      join(relocated, "hack-config-compiler"),
    ],
  ]) {
    require(from !== undefined && to !== undefined, "relocation path");
    await copyFile(from, to);
  }
  await rm(installed, { recursive: true });
  const binary = join(relocated, "hack");
  const compiler = join(relocated, "hack-config-compiler");
  const protocol = await run({
    command: [compiler, "--protocol"],
    cwd: project,
    env,
    offline: true,
  });
  const handshake = record(protocol.stdout);
  for (const capability of [
    "transport_version",
    "authored_version",
    "plan_version",
    "resolve_version",
    "local_version",
    "env_plan_version",
  ]) {
    require(handshake[capability] ===
      1, `installed compiler handshake: ${capability}`);
  }
  await validatedAndPlanned({ binary, project, env });
  const malformed = join(fixture, "invalid.json");
  await Bun.write(
    malformed,
    '{"schema_version":1,"name":"release-fixture","name":"private-diagnostic-sentinel"}'
  );
  const invalid = await run({
    command: [binary, "config", "validate", "--file", malformed, "--json"],
    cwd: project,
    env,
    offline: true,
    expectedExit: 1,
  });
  require(JSON.stringify(record(invalid.stdout).diagnostics).includes(
    '"duplicate_key"'
  ) &&
    !(invalid.stdout + invalid.stderr).includes(
      "private-diagnostic-sentinel"
    ), "installed diagnostic forwarding and redaction");
  await rm(compiler);
  const fallback = join(opts.runtimeTools, "hack-config-compiler");
  const attempted = join(fixture, "path-fallback-attempt");
  await Bun.write(
    fallback,
    `#!/bin/sh\nprintf attempted > '${attempted}'\nexit 1\n`
  );
  await chmod(fallback, 0o755);
  await refused({ binary, project, env, code: "E_COMPILER_MISSING" });
  require(!(await Bun.file(
    attempted
  ).exists()), "missing adjacent compiler never searches PATH");
  await rm(fallback);
  await Bun.write(
    compiler,
    '#!/bin/sh\nprintf \'{"transport_version":2,"authored_version":1,"plan_version":1}\\n\'\n'
  );
  await chmod(compiler, 0o755);
  await refused({ binary, project, env, code: "E_COMPILER_VERSION" });
  const v4 = await run({
    command: [binary, "config", "get", "name", "--path", legacy],
    cwd: legacy,
    env,
    offline: true,
  });
  require(v4.stdout === "legacy-fixture\n" &&
    (await Bun.file(join(legacy, ".hack/hack.config.json")).text()) ===
      legacyConfig, "legacy config remains readable with an incompatible compiler");
  require(JSON.stringify((await readdir(join(project, ".hack"))).sort()) ===
    '[".hack.secret.key","hack.env.default.yaml","hack.project.json"]', "offline validation and planning create no project state");
  require((await readdir(home)).length ===
    0, "isolated home receives no global/runtime setup");
}

async function validatedAndPlanned(opts: {
  readonly binary: string;
  readonly project: string;
  readonly env: Record<string, string>;
}): Promise<void> {
  const results: Record<string, unknown>[] = [];
  for (const mode of ["validate", "plan"]) {
    const result = await run({
      command: [opts.binary, "config", mode, "--json"],
      cwd: opts.project,
      env: opts.env,
      offline: true,
    });
    const value = record(result.stdout);
    require(value.ok === true &&
      isRecord(value.plan) &&
      value.plan.name === "release-fixture" &&
      typeof value.semantic_hash === "string" &&
      HASH.test(
        value.semantic_hash
      ), `installed ${mode} with matching adjacent compiler`);
    require(!(result.stdout + result.stderr).includes(
      "synthetic-managed-value-must-stay-private"
    ), "managed values never enter installed CLI output");
    results.push(value);
  }
  const [validation, planning] = results;
  require(validation !== undefined &&
    planning !== undefined &&
    validation.semantic_hash === planning.semantic_hash &&
    isRecord(planning.environment_plan) &&
    planning.environment_plan.complete === true &&
    isRecord(planning.environment_plan.workloads) &&
    isRecord(planning.environment_plan.workloads.web) &&
    isRecord(planning.environment_plan.workloads.web.TOKEN) &&
    planning.environment_plan.workloads.web.TOKEN.kind === "managed" &&
    planning.environment_plan.workloads.web.TOKEN.secret ===
      true, "installed plan resolves symbolic metadata without decrypting values");
}

async function refused(opts: {
  readonly binary: string;
  readonly project: string;
  readonly env: Record<string, string>;
  readonly code: string;
}): Promise<void> {
  for (const mode of ["validate", "plan"]) {
    const result = await run({
      command: [opts.binary, "config", mode, "--json"],
      cwd: opts.project,
      env: opts.env,
      offline: true,
      expectedExit: 1,
    });
    require((result.stdout + result.stderr).includes(
      opts.code
    ), `installed ${mode} refuses ${opts.code}`);
  }
}

/** A live loopback canary verifies that the OS sandbox/namespace actually denies network. */
async function verifyNetworkDenial(opts: {
  readonly cwd: string;
}): Promise<void> {
  let requests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      requests += 1;
      return new Response("network canary");
    },
  });
  try {
    const command = [
      systemTool("curl"),
      "--silent",
      "--max-time",
      "2",
      `http://127.0.0.1:${server.port}`,
    ];
    const reachable = await run({ command, cwd: opts.cwd });
    require(reachable.stdout === "network canary" &&
      requests === 1, "network-denial reachable positive control");
    requests = 0;
    const result = await run({
      command,
      cwd: opts.cwd,
      offline: true,
      expectedExit: null,
    });
    require(result.exit !== 0 &&
      requests === 0, "network-denial negative control");
  } finally {
    server.stop(true);
  }
}

function systemTool(name: string): string {
  const tool = Bun.which(name, { PATH: "/usr/bin:/bin" });
  require(tool !== null, `required Unix acceptance tool: ${name}`);
  return tool;
}

async function sha256(path: string): Promise<string> {
  const result = await run({
    command:
      process.platform === "darwin"
        ? [systemTool("shasum"), "-a", "256", path]
        : [systemTool("sha256sum"), path],
    cwd: root,
  });
  const hash = result.stdout.split(" ")[0];
  require(hash !== undefined &&
    HASH.test(hash), "independent Unix SHA-256 output");
  return hash;
}

function record(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  require(isRecord(value), "installed JSON response");
  return value;
}

function require(condition: boolean, label: string): asserts condition {
  if (!condition) {
    throw new Error(`Release compiler acceptance failed: ${label}`);
  }
}

async function run(opts: {
  readonly command: readonly string[];
  readonly cwd: string;
  readonly env?: Record<string, string>;
  readonly input?: string;
  readonly offline?: boolean;
  readonly expectedExit?: number | null;
}): Promise<{
  readonly exit: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const env = opts.env ?? { PATH: "/usr/bin:/bin" };
  let command = [...opts.command];
  if (opts.offline) {
    if (process.platform === "darwin") {
      command = [
        systemTool("sandbox-exec"),
        "-p",
        "(version 1) (allow default) (deny network*)",
        ...command,
      ];
    } else {
      require(process.platform ===
        "linux", "network isolation supports Unix release hosts");
      const uid = process.getuid?.();
      const gid = process.getgid?.();
      require(uid !== undefined &&
        gid !== undefined, "Linux acceptance user identity");
      command = [
        systemTool("sudo"),
        "-n",
        systemTool("unshare"),
        "--net",
        "--",
        systemTool("setpriv"),
        `--reuid=${uid}`,
        `--regid=${gid}`,
        "--clear-groups",
        systemTool("env"),
        "-i",
        ...Object.entries(env).map(([key, value]) => `${key}=${value}`),
        ...command,
      ];
    }
  }
  const child = Bun.spawn(command, {
    cwd: opts.cwd,
    env,
    stdin:
      opts.input === undefined
        ? "ignore"
        : new TextEncoder().encode(opts.input),
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  const kill = () => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // The owned process group may already have exited.
    }
  };
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, 30_000);
  try {
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      readOutput(child.stdout),
      readOutput(child.stderr),
    ]);
    require(!timedOut, "release acceptance subprocess time budget");
    require(opts.expectedExit === null ||
      exit ===
        (opts.expectedExit ??
          0), `command ${opts.command.join(" ")} exited ${exit}: ${(stderr + stdout).slice(0, 2000)}`);
    return { exit, stdout, stderr };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) {
      kill();
    }
    await child.exited;
  }
}

async function readOutput(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let size = 0;
  let output = "";
  for await (const chunk of stream) {
    size += chunk.byteLength;
    require(size <= 1024 * 1024, "release acceptance subprocess output budget");
    output += decoder.decode(chunk, { stream: true });
  }
  return output + decoder.decode();
}
