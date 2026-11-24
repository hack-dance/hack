import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { HackCliError } from "../src/lib/cli-result.ts";
import { createHostDataBackupDocker } from "../src/lib/data-backup-docker.ts";
import { exportProjectData } from "../src/lib/data-backup-export.ts";
import {
  dataCleanupRecordPath,
  endpointDigest,
  engineSource,
  writeDataCleanupRecord,
} from "../src/lib/data-cleanup-record.ts";
import { privateCliEnv, privateCliHome } from "./helpers/private-cli-env.ts";

/**
 * The project's managed Compose env (here a managed DOCKER_HOST) reaches
 * every Docker subprocess of an export: Compose, `volume inspect`, `ps`,
 * `events` and both helper runs. A stub `docker` found through the managed
 * PATH records the DOCKER_HOST each call saw; the runner's own environment
 * is not changed.
 */

const MANAGED_HOST = "unix:///managed/engine.sock";
/** The daemon ID the stub answers by default. */
const STUB_DAEMON_ID = "STUB:DAEMON:0001";

const STUB = `
const { appendFileSync, readFileSync, existsSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.DATA_STUB_LOG, JSON.stringify({ args, host: process.env.DOCKER_HOST ?? null, context: process.env.DOCKER_CONTEXT ?? null }) + "\\n");
// An unreachable engine at one step: the client names DOCKER_HOST verbatim.
const failAt = process.env.DATA_STUB_FAIL;
if (failAt && args.join(" ").includes(failAt)) {
  process.stderr.write((process.env.DATA_STUB_FAIL_TEXT || ("Cannot connect to the Docker daemon at " + process.env.DOCKER_HOST + ". Is the docker daemon running?")) + "\\n");
  process.exit(1);
}
const feed = process.env.DATA_STUB_LOG + ".events";
// The resolved Compose project name; a test can make it carry a value.
const project = process.env.DATA_STUB_PROJECT || "shop";
const volumeName = project + "_db";
const mountpoint = "/var/lib/docker/volumes/" + volumeName + "/_data";
const out = (value) => process.stdout.write(typeof value === "string" ? value : JSON.stringify(value) + "\\n");
if (args[0] === "info") {
  // The daemon's ID, as the test configures it; empty when asked to be.
  if (process.env.DATA_STUB_INFO_FAIL) { process.stderr.write(process.env.DATA_STUB_INFO_FAIL + "\\n"); process.exit(1); }
  out((process.env.DATA_STUB_DAEMON_ID ?? "STUB:DAEMON:0001") + "\\n");
} else if (args[0] === "context" && args[1] === "show") {
  out("default\\n");
} else if (args[0] === "context" && args[1] === "inspect") {
  // A context's endpoints, as the test configures them (local CLI read).
  out((process.env.DATA_STUB_CONTEXT_ENDPOINT || "{}") + "\\n");
} else if (args[0] === "events") {
  // A live subscription: replay what runs append, until SIGTERM.
  let offset = 0;
  process.on("SIGTERM", () => process.exit(0));
  const tick = () => {
    const text = existsSync(feed) ? readFileSync(feed, "utf8") : "";
    if (text.length > offset) { process.stdout.write(text.slice(offset)); offset = text.length; }
    setTimeout(tick, 10);
  };
  tick();
} else if (args[0] === "compose") {
  out({ name: project, services: {}, volumes: { db: { name: volumeName } } });
} else if (args[0] === "volume" && args[1] === "inspect") {
  out({ name: volumeName, createdAt: "2026-11-24T00:00:00Z", driver: "local", mountpoint, options: null, labels: { "com.docker.compose.project": project, "com.docker.compose.volume": "db" } });
} else if (args[0] === "ps" && args.includes("--all")) {
  // Containers labeled with a nonce, as the test lists them.
  out((process.env.DATA_STUB_LABELED || "").split(",").filter(Boolean).map((id) => id + "\\n").join(""));
} else if (args[0] === "ps") {
  // A running container named by the test: its name, or its short ID.
  const named = process.env.DATA_STUB_RUNNING;
  const format = args[args.indexOf("--format") + 1];
  if (!named) out("");
  else if (args.includes("--quiet")) out("5".repeat(64) + "\\n");
  else out(format === "{{.ID}}" ? "5".repeat(12) + "\\n" : named + "\\n");
} else if (args[0] === "run" || args[0] === "start") {
  const name = args[0] === "run" ? args[args.indexOf("--name") + 1] : args.at(-1);
  appendFileSync(feed, JSON.stringify({ Type: "container", Action: "start", Actor: { ID: name, Attributes: { name } } }) + "\\n");
} else if (args[0] === "create") {
  out("c".repeat(64));
} else if (args[0] === "container" && args.some((arg) => arg.includes("index .Config.Labels")) && !args.some((arg) => arg.includes("{{.Id}}"))) {
  if (process.env.DATA_STUB_INSPECT_FAIL) { process.stderr.write("error during connect\\n"); process.exit(1); }
  out((process.env.DATA_STUB_NONCE || "") + "\\n");
} else if (args[0] === "container" && args.includes("{{.Id}} {{json .Mounts}}")) {
  // Batched: every container binds the owned Mountpoint.
  const ids = args.slice(args.indexOf("--format") + 2);
  out(ids.map((id) => id + " " + JSON.stringify([{ Type: "bind", Source: mountpoint, Destination: "/v", RW: false }])).join("\\n") + "\\n");
} else if (args[0] === "container" && args.includes("{{json .Mounts}}")) {
  out([{ Type: "bind", Source: mountpoint, Destination: "/v", RW: false }]);
} else if (args[0] === "container") {
  process.stderr.write("Error: No such container: " + args.at(-1) + "\\n");
  process.exit(1);
} else if (args[0] === "rm") {
  out(args.at(-1));
} else if (args[0] === "exec") {
  // A foreign container starts during the copy and mounts the owned volume;
  // its inspect (below) shows a bind of the owned Mountpoint too.
  if (args.includes("tar") && process.env.DATA_STUB_FOREIGN) {
    appendFileSync(feed, JSON.stringify({ Type: "container", Action: "start", Actor: { ID: "6".repeat(64), Attributes: { name: process.env.DATA_STUB_FOREIGN } } }) + "\\n");
    appendFileSync(feed, JSON.stringify({ Type: "volume", Action: "mount", Actor: { ID: volumeName, Attributes: { container: "6".repeat(64), destination: "/x" } } }) + "\\n");
  }
  if (args.includes("tar")) out("tar bytes");
  else out({ algorithm: "hack.tree-digest.v1", entries: 2, excludedSockets: 0, digest: "a".repeat(64) });
} else {
  process.exit(97);
}
`;

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "hack-data-docker-env-")));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("a managed DOCKER_HOST reaches every docker argv of an export", async () => {
  const bin = join(root, "bin");
  const log = join(root, "calls.ndjson");
  await Bun.write(join(bin, "docker"), `#!${process.execPath}\n${STUB}`);
  await chmod(join(bin, "docker"), 0o755);
  await writeFile(log, "");
  const inherited = process.env.DOCKER_HOST;

  const result = await exportProjectData({
    docker: createHostDataBackupDocker({
      env: {
        DOCKER_HOST: MANAGED_HOST,
        DATA_STUB_LOG: log,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
      },
    }),
    composeArgs: ["docker", "compose", "-f", join(root, "compose.yml")],
    project: "shop",
    branch: null,
    hackHome: join(root, "home"),
    hackVersion: "9.9.9",
  });

  expect(result.manifest.volumes.map((volume) => volume.key)).toEqual(["db"]);
  const calls = (await readFile(log, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { args: string[]; host: string });
  const kinds = calls.map((call) => {
    if (call.args[0] === "exec") {
      const args = call.args.filter((arg) => arg !== "--interactive");
      return `exec ${args[2]}`;
    }
    return call.args
      .slice(0, ["volume", "container"].includes(call.args[0] ?? "") ? 2 : 1)
      .join(" ");
  });
  expect(new Set(kinds)).toEqual(
    new Set([
      "compose",
      "info",
      "volume inspect",
      "ps",
      "events",
      "create",
      "start",
      "container inspect",
      "exec bun",
      "exec tar",
      "rm",
    ])
  );
  expect(calls.filter((call) => call.host !== MANAGED_HOST)).toEqual([]);
  expect(process.env.DOCKER_HOST).toBe(inherited);
});

/**
 * Not a credential: a recognizable private socket path standing in for a
 * managed engine endpoint, so a leak is easy to spot.
 */
const PRIVATE_ENDPOINT_MARKER = "managed-private-endpoint";

async function stubBin(): Promise<{ bin: string; log: string }> {
  const bin = join(root, "bin");
  const log = join(root, "calls.ndjson");
  await Bun.write(join(bin, "docker"), `#!${process.execPath}\n${STUB}`);
  await chmod(join(bin, "docker"), 0o755);
  await writeFile(log, "");
  return { bin, log };
}

test("an unreachable managed DOCKER_HOST is redacted from every engine refusal", async () => {
  const { bin, log } = await stubBin();
  const managedHost = `unix://${root}/${PRIVATE_ENDPOINT_MARKER}.sock`;
  // Each step that can quote an engine line: Compose, the volume and
  // container reads, the marker and hold containers and a helper exec.
  for (const failAt of [
    "compose",
    "volume inspect",
    "ps --filter",
    "create",
    "type=bind",
    "exec",
  ]) {
    const error = await exportProjectData({
      docker: createHostDataBackupDocker({
        env: {
          DOCKER_HOST: managedHost,
          DATA_STUB_LOG: log,
          DATA_STUB_FAIL: failAt,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
        },
      }),
      composeArgs: ["docker", "compose", "-f", join(root, "compose.yml")],
      project: "shop",
      branch: null,
      hackHome: join(root, `home-${failAt.replace(/\W/g, "-")}`),
      hackVersion: "9.9.9",
    }).then(
      () => null,
      (caught: unknown) => caught
    );
    expect(error).toBeInstanceOf(HackCliError);
    const refusal = error as HackCliError;
    expect({ failAt, code: refusal.code }).toEqual({
      failAt,
      code: "E_DOCKER_UNAVAILABLE",
    });
    // Fixed text and a stable reason: the engine's own line is never quoted.
    expect(refusal.message).toContain(
      "cannot reach the selected Docker engine"
    );
    expect(refusal.detail).toEqual({ reason: "engine_unreachable" });
    expect(refusal.message).not.toContain("Cannot connect");
    const rendered = JSON.stringify({
      message: refusal.message,
      detail: refusal.detail,
      startBlocker: refusal.startBlocker,
    });
    expect({
      failAt,
      leaked: rendered.includes(PRIVATE_ENDPOINT_MARKER),
    }).toEqual({
      failAt,
      leaked: false,
    });
  }
});

test("hack data export prints no managed DOCKER_HOST in text or JSON when the engine is unreachable", async () => {
  const { bin, log } = await stubBin();
  const projectRoot = join(root, "repo");
  const hackDir = join(projectRoot, ".hack");
  await mkdir(hackDir, { recursive: true });
  await writeFile(
    join(hackDir, "docker-compose.yml"),
    "name: shop\nservices: {}\nvolumes:\n  db: {}\n"
  );
  // The project's own env selects the engine: a managed value, not the
  // caller's environment.
  const managedHost = `unix://${root}/${PRIVATE_ENDPOINT_MARKER}.sock`;
  await writeFile(
    join(hackDir, "hack.env.default.yaml"),
    [
      "version: 1",
      "environment: default",
      "secretsprovider: project_key",
      "values:",
      "  global:",
      `    DOCKER_HOST: "${managedHost}"`,
      "",
    ].join("\n")
  );
  for (const json of [false, true]) {
    const child = Bun.spawn(
      [
        process.execPath,
        resolve(import.meta.dir, "..", "index.ts"),
        "data",
        "export",
        ...(json ? ["--json"] : []),
      ],
      {
        cwd: projectRoot,
        env: privateCliEnv({
          root,
          env: {
            PATH: `${bin}:/usr/bin:/bin`,
            HACK_NO_INTERACTIVE: "1",
            DATA_STUB_LOG: log,
            DATA_STUB_FAIL: "volume inspect",
          },
        }),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const output = `${stdout}\n${stderr}`;
    expect({ json, exitCode: exitCode === 0 }).toEqual({
      json,
      exitCode: false,
    });
    expect(output).toContain("cannot reach the selected Docker engine");
    expect({ json, leaked: output.includes(PRIVATE_ENDPOINT_MARKER) }).toEqual({
      json,
      leaked: false,
    });
  }
  // The stub saw the managed endpoint, so the refusal really quoted it.
  expect(await readFile(log, "utf8")).toContain(PRIVATE_ENDPOINT_MARKER);
});

async function runDataCli(opts: {
  readonly cwd: string;
  readonly args: readonly string[];
  readonly bin: string;
  readonly env: Readonly<Record<string, string>>;
}): Promise<{ exitCode: number; output: string; stdout: string }> {
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(import.meta.dir, "..", "index.ts"),
      ...opts.args,
    ],
    {
      cwd: opts.cwd,
      env: privateCliEnv({
        root,
        env: {
          PATH: `${opts.bin}:/usr/bin:/bin`,
          HACK_NO_INTERACTIVE: "1",
          ...opts.env,
        },
      }),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, output: `${stdout}\n${stderr}`, stdout };
}

async function shopProject(opts: {
  readonly envFiles: Readonly<Record<string, readonly string[]>>;
}): Promise<string> {
  const projectRoot = join(root, "repo");
  const hackDir = join(projectRoot, ".hack");
  await mkdir(hackDir, { recursive: true });
  await writeFile(
    join(hackDir, "docker-compose.yml"),
    "name: shop\nservices: {}\nvolumes:\n  db: {}\n"
  );
  for (const [env, values] of Object.entries(opts.envFiles)) {
    await writeFile(
      join(hackDir, `hack.env.${env}.yaml`),
      [
        "version: 1",
        `environment: ${env}`,
        "secretsprovider: project_key",
        "values:",
        "  global:",
        ...values.map((line) => `    ${line}`),
        "",
      ].join("\n")
    );
  }
  return projectRoot;
}

/** A one-volume backup of Compose project `shop`, as export writes it. */
async function shopBackup(): Promise<string> {
  const sha = (text: string): string =>
    new Bun.CryptoHasher("sha256").update(text).digest("hex");
  const dir = join(root, "backups", "20261124T090000Z");
  await mkdir(dir, { recursive: true });
  const bytes = "tar bytes";
  await writeFile(join(dir, "db.tar"), bytes);
  await writeFile(
    join(dir, "manifest.json"),
    `${JSON.stringify({
      schema: "hack.data-backup.v1",
      project: "shop",
      branch: null,
      composeProjectSha256: sha("shop"),
      createdAt: "2026-11-24T09:00:00.000Z",
      hackVersion: "9.9.9",
      helperImage: "oven/bun@sha256:x",
      digestAlgorithm: "hack.tree-digest.v1",
      volumes: [
        {
          key: "db",
          nameSha256: sha("shop_db"),
          driver: "local",
          labelsSha256: {
            "com.docker.compose.project": sha("shop"),
            "com.docker.compose.volume": sha("db"),
          },
          file: "db.tar",
          tarBytes: bytes.length,
          tarSha256: sha(bytes),
          entries: 2,
          excludedSockets: 0,
          contentDigest: "a".repeat(64),
        },
      ],
      skipped: [],
    })}\n`
  );
  return dir;
}

test("hack data import prints no managed DOCKER_HOST in text or JSON when the engine is unreachable", async () => {
  const { bin, log } = await stubBin();
  const managedHost = `unix://${root}/${PRIVATE_ENDPOINT_MARKER}.sock`;
  const projectRoot = await shopProject({
    envFiles: { default: [`DOCKER_HOST: "${managedHost}"`] },
  });
  const backup = await shopBackup();
  for (const failAt of ["compose", "volume inspect"]) {
    for (const json of [false, true]) {
      const result = await runDataCli({
        cwd: projectRoot,
        args: ["data", "import", backup, ...(json ? ["--json"] : [])],
        bin,
        env: { DATA_STUB_LOG: log, DATA_STUB_FAIL: failAt },
      });
      expect({ failAt, json, ok: result.exitCode === 0 }).toEqual({
        failAt,
        json,
        ok: false,
      });
      expect(result.output).toContain(
        "Cannot connect to the Docker daemon at [REDACTED]"
      );
      expect({
        failAt,
        json,
        leaked: result.output.includes(PRIVATE_ENDPOINT_MARKER),
      }).toEqual({ failAt, json, leaked: false });
    }
  }
  expect(await readFile(log, "utf8")).toContain(PRIVATE_ENDPOINT_MARKER);
});

test("without --env or a recorded selection, export and import refuse before any Docker call when the project has overlays", async () => {
  const { bin, log } = await stubBin();
  const projectRoot = await shopProject({
    envFiles: { default: ['VOL: "base"'], staging: ['VOL: "staging"'] },
  });
  const backup = await shopBackup();
  for (const args of [
    ["data", "export", "--json"],
    ["data", "import", backup, "--json"],
  ]) {
    const result = await runDataCli({
      cwd: projectRoot,
      args,
      bin,
      env: { DATA_STUB_LOG: log },
    });
    expect({ args, exitCode: result.exitCode === 0 }).toEqual({
      args,
      exitCode: false,
    });
    const envelope = JSON.parse(result.stdout) as {
      ok: boolean;
      error: { code: string; message: string };
    };
    expect(envelope.ok).toBeFalse();
    expect(envelope.error.code).toBe("E_USAGE");
    expect(envelope.error.message).toBe(
      "This project has environment overlays (staging); the environment `hack up` used is no longer recorded. Pass --env <name> (or --env base for base layers only)."
    );
  }
  expect(await readFile(log, "utf8")).toBe("");
});

test("hack data export never prints a container name, which can carry a managed value", async () => {
  // The reviewer's example: `name: app-${STORAGE_TOKEN}` and
  // `container_name: worker-${STORAGE_TOKEN}`, with STORAGE_TOKEN a managed
  // value. The old redactor replaced only the full `app-…` project name, so
  // the token stayed in `worker-…` in `detail.running` and mount refusals.
  const { bin, log } = await stubBin();
  // Not a credential: a recognizable stand-in for a managed secret.
  const token = "storage-token-canary-5c1d";
  const projectRoot = await shopProject({
    envFiles: { default: [`STORAGE_TOKEN: "${token}"`] },
  });
  for (const [stage, env] of [
    ["running", { DATA_STUB_RUNNING: `worker-${token}` }],
    ["mount", { DATA_STUB_FOREIGN: `worker-${token}` }],
  ] as const) {
    for (const json of [false, true]) {
      const result = await runDataCli({
        cwd: projectRoot,
        args: ["data", "export", ...(json ? ["--json"] : [])],
        bin,
        env: { DATA_STUB_LOG: log, DATA_STUB_PROJECT: `app-${token}`, ...env },
      });
      expect(result.output).toContain("E_PROJECT_RUNNING");
      expect({ stage, json, ok: result.exitCode === 0 }).toEqual({
        stage,
        json,
        ok: false,
      });
      // The refusal names the container by its short ID (the running
      // refusal lists it in `detail.running` only).
      if (json || stage === "mount") {
        expect(result.output).toContain(
          stage === "running" ? "5".repeat(12) : "6".repeat(12)
        );
      }
      expect({ stage, json, leaked: result.output.includes(token) }).toEqual({
        stage,
        json,
        leaked: false,
      });
    }
  }
});

/**
 * Write the run's cleanup record the way export does: the engine source and
 * endpoint digest a client with the project's managed env resolves.
 */
async function recordRun(opts: {
  readonly nonce: string;
  readonly managed: Readonly<Record<string, string>>;
  readonly bin: string;
  readonly log: string;
  readonly extraEnv?: Readonly<Record<string, string>>;
  readonly envName?: string | null;
  readonly endpointSha256?: string;
  /** The daemon ID the run read (the stub answers DATA_STUB_DAEMON_ID). */
  readonly daemonId?: string;
}): Promise<string> {
  const docker = createHostDataBackupDocker({
    env: {
      ...opts.managed,
      PATH: `${opts.bin}:/usr/bin:/bin`,
      DATA_STUB_LOG: opts.log,
      ...opts.extraEnv,
    },
  });
  const hackHome = join(privateCliHome(root), ".hack");
  await writeDataCleanupRecord({
    hackHome,
    record: {
      version: 1,
      nonce: opts.nonce,
      command: "export",
      project: "repo",
      branch: null,
      envName: opts.envName ?? null,
      envDefault: opts.envName === undefined,
      engine: engineSource({ docker, envName: opts.envName ?? null }),
      endpointSha256: opts.endpointSha256 ?? (await endpointDigest(docker)),
      daemonId: opts.daemonId ?? STUB_DAEMON_ID,
      createdAt: "2026-11-24T00:00:00.000Z",
    },
  });
  await writeFile(opts.log, "");
  return dataCleanupRecordPath({ hackHome, nonce: opts.nonce });
}

const stubCalls = async (log: string) =>
  (await readFile(log, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(
      (line) =>
        JSON.parse(line) as {
          args: string[];
          host: string | null;
          context: string | null;
        }
    );

test("hack data cleanup removes the nonce's containers through the managed DOCKER_HOST, never a volume", async () => {
  const { bin, log } = await stubBin();
  const managedHost = `unix://${root}/managed-engine.sock`;
  const projectRoot = await shopProject({
    envFiles: { default: [`DOCKER_HOST: "${managedHost}"`] },
  });
  const nonce = "0123456789abcdef0123456789abcdef";
  const labeled = ["a".repeat(64), "b".repeat(64)];
  const record = await recordRun({
    nonce,
    managed: { DOCKER_HOST: managedHost },
    bin,
    log,
  });
  // The record names how the engine was selected, never the endpoint.
  const recordText = await readFile(record, "utf8");
  expect(recordText).not.toContain(managedHost);
  expect(JSON.parse(recordText).engine).toEqual({
    kind: "managed-host",
    overlay: null,
  });
  const result = await runDataCli({
    cwd: projectRoot,
    args: ["data", "cleanup", "--nonce", nonce, "--json"],
    bin,
    env: {
      DATA_STUB_LOG: log,
      DATA_STUB_LABELED: labeled.join(","),
      DATA_STUB_NONCE: nonce,
    },
  });
  expect(result.exitCode).toBe(0);
  const envelope = JSON.parse(result.stdout) as {
    data: { schema: string; removed: string[]; label: string };
  };
  expect(envelope.data.schema).toBe("hack.data-cleanup.v1");
  expect(envelope.data.removed).toEqual(labeled);
  expect(envelope.data.label).toBe(`io.hack.data-backup.nonce=${nonce}`);
  const calls = (await readFile(log, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { args: string[]; host: string });
  // Every call went to the managed engine; removals by ID only, no volumes.
  expect(calls.filter((call) => call.host !== managedHost)).toEqual([]);
  expect(calls.some((call) => call.args[0] === "volume")).toBeFalse();
  const removals = calls.filter((call) => call.args[0] === "rm");
  expect(removals.map((call) => call.args)).toEqual(
    labeled.map((id) => ["rm", "--force", id])
  );
  // Every removal confirmed: the record is gone.
  expect(await readFile(record, "utf8").catch(() => null)).toBeNull();
  // A malformed nonce is a usage error before any Docker call.
  await writeFile(log, "");
  const bad = await runDataCli({
    cwd: projectRoot,
    args: ["data", "cleanup", "--nonce", "not-a-nonce", "--json"],
    bin,
    env: { DATA_STUB_LOG: log },
  });
  expect(bad.stdout).toContain("E_USAGE");
  expect(await readFile(log, "utf8")).toBe("");
});

test("hack data cleanup uses a recorded managed context and reaches it", async () => {
  const { bin, log } = await stubBin();
  const projectRoot = await shopProject({
    envFiles: { default: ['DOCKER_CONTEXT: "build-box"'] },
  });
  const nonce = "1123456789abcdef0123456789abcdef";
  const endpoint = '{"docker":{"Host":"tcp://10.0.0.5:2376"}}';
  const record = await recordRun({
    nonce,
    managed: { DOCKER_CONTEXT: "build-box" },
    bin,
    log,
    extraEnv: { DATA_STUB_CONTEXT_ENDPOINT: endpoint },
  });
  const recordText = await readFile(record, "utf8");
  expect(JSON.parse(recordText).engine).toEqual({
    kind: "managed-context",
    context: "build-box",
  });
  // The context's endpoint is hashed, never stored.
  expect(recordText).not.toContain("10.0.0.5");
  const result = await runDataCli({
    cwd: projectRoot,
    args: ["data", "cleanup", "--nonce", nonce, "--json"],
    bin,
    env: {
      DATA_STUB_LOG: log,
      DATA_STUB_LABELED: "c".repeat(64),
      DATA_STUB_NONCE: nonce,
      DATA_STUB_CONTEXT_ENDPOINT: endpoint,
    },
  });
  expect(result.exitCode).toBe(0);
  expect(result.output).not.toContain("10.0.0.5");
  const calls = await stubCalls(log);
  expect(calls.filter((call) => call.context !== "build-box")).toEqual([]);
  expect(calls.some((call) => call.args[0] === "rm")).toBeTrue();
});

test("hack data cleanup without a record, or whose engine now differs, refuses with no engine call", async () => {
  const { bin, log } = await stubBin();
  const projectRoot = await shopProject({
    envFiles: { default: [`DOCKER_HOST: "unix://${root}/now-elsewhere.sock"`] },
  });
  const cases = [
    {
      nonce: "2123456789abcdef0123456789abcdef",
      // Missing: no record at all.
      record: false,
      why: "there is no record",
    },
    {
      nonce: "3123456789abcdef0123456789abcdef",
      // Recorded through the same managed DOCKER_HOST setting, but on an
      // engine the overlay no longer points at.
      record: true,
      why: "endpoint digest differs",
    },
  ] as const;
  for (const entry of cases) {
    if (entry.record) {
      await recordRun({
        nonce: entry.nonce,
        managed: { DOCKER_HOST: `unix://${root}/the-recorded-one.sock` },
        bin,
        log,
      });
    }
    await writeFile(log, "");
    for (const json of [true, false]) {
      const refused = await runDataCli({
        cwd: projectRoot,
        args: [
          "data",
          "cleanup",
          "--nonce",
          entry.nonce,
          ...(json ? ["--json"] : []),
        ],
        bin,
        env: {
          DATA_STUB_LOG: log,
          DATA_STUB_LABELED: "d".repeat(64),
          DATA_STUB_NONCE: entry.nonce,
        },
      });
      expect({ nonce: entry.nonce, json, ok: refused.exitCode === 0 }).toEqual({
        nonce: entry.nonce,
        json,
        ok: false,
      });
      expect(refused.output).toContain("E_DATA_CLEANUP_RECORD");
      expect(refused.output).toContain(entry.why);
      // No endpoint in the refusal, and not one Docker call.
      expect(refused.output).not.toContain(".sock");
      expect(await readFile(log, "utf8")).toBe("");
    }
  }
});

test("hack data cleanup no longer takes --env: the record holds the selection", async () => {
  const { bin, log } = await stubBin();
  const projectRoot = await shopProject({ envFiles: { default: [] } });
  const refused = await runDataCli({
    cwd: projectRoot,
    args: [
      "data",
      "cleanup",
      "--env",
      "staging",
      "--nonce",
      "4123456789abcdef0123456789abcdef",
      "--json",
    ],
    bin,
    env: { DATA_STUB_LOG: log },
  });
  expect(refused.exitCode).not.toBe(0);
  expect(refused.output).toContain("E_USAGE");
  expect(await readFile(log, "utf8")).toBe("");
});

test("hack data cleanup: a listed container it cannot verify exits nonzero; an empty list is a no-op", async () => {
  const { bin, log } = await stubBin();
  const managedHost = `unix://${root}/managed-engine.sock`;
  const projectRoot = await shopProject({
    envFiles: { default: [`DOCKER_HOST: "${managedHost}"`] },
  });
  const nonce = "5123456789abcdef0123456789abcdef";
  const record = await recordRun({
    nonce,
    managed: { DOCKER_HOST: managedHost },
    bin,
    log,
  });
  for (const json of [true, false]) {
    const unverified = await runDataCli({
      cwd: projectRoot,
      args: ["data", "cleanup", "--nonce", nonce, ...(json ? ["--json"] : [])],
      bin,
      env: {
        DATA_STUB_LOG: log,
        DATA_STUB_LABELED: "e".repeat(64),
        DATA_STUB_NONCE: nonce,
        DATA_STUB_INSPECT_FAIL: "1",
      },
    });
    expect({ json, ok: unverified.exitCode === 0 }).toEqual({
      json,
      ok: false,
    });
    expect(unverified.output).toContain(`io.hack.data-backup.nonce=${nonce}`);
    expect(unverified.output).toContain("e".repeat(12));
    expect(unverified.output).not.toContain("No container is labeled");
  }
  // Unconfirmed: the record stays for a retry.
  expect(await readFile(record, "utf8")).toContain(nonce);
  const empty = await runDataCli({
    cwd: projectRoot,
    args: ["data", "cleanup", "--nonce", nonce],
    bin,
    env: { DATA_STUB_LOG: log, DATA_STUB_NONCE: nonce },
  });
  expect(empty.exitCode).toBe(0);
  expect(empty.output).toContain(
    `No container is labeled io.hack.data-backup.nonce=${nonce}; nothing to remove.`
  );
  expect(await readFile(record, "utf8").catch(() => null)).toBeNull();
});

/** Engine lines that name private endpoints (recognizable stand-ins). */
const PRIVATE_ENGINE_LINES = [
  "Cannot connect to the Docker daemon at unix:///run/user/4242/.private-runtime/docker.sock. Is the docker daemon running?",
  'error during connect: Get "http://%2Fvar%2Frun%2Fdocker.sock/v1.47/info": dial tcp://remote-user@198.51.100.42:2376: connect: connection refused',
];
const PRIVATE_FRAGMENTS = [
  "/run/user/4242/.private-runtime",
  ".private-runtime",
  "remote-user@198.51.100.42",
  "198.51.100.42",
];

test("hack data cleanup: a matching daemon ID proceeds; another, an unreadable one or none refuses before any listing", async () => {
  const { bin, log } = await stubBin();
  const managedHost = `unix://${root}/managed-engine.sock`;
  const projectRoot = await shopProject({
    envFiles: { default: [`DOCKER_HOST: "${managedHost}"`] },
  });
  const listOrRemove = async () =>
    (await stubCalls(log)).filter(
      (call) => call.args[0] === "ps" || call.args[0] === "rm"
    );
  // Matching: proceeds to list and remove.
  const matching = "6123456789abcdef0123456789abcdef";
  const record = await recordRun({
    nonce: matching,
    managed: { DOCKER_HOST: managedHost },
    bin,
    log,
    daemonId: "DAEMON-A",
  });
  expect(JSON.parse(await readFile(record, "utf8")).daemonId).toBe("DAEMON-A");
  const ok = await runDataCli({
    cwd: projectRoot,
    args: ["data", "cleanup", "--nonce", matching, "--json"],
    bin,
    env: {
      DATA_STUB_LOG: log,
      DATA_STUB_DAEMON_ID: "DAEMON-A",
      DATA_STUB_LABELED: "f".repeat(64),
      DATA_STUB_NONCE: matching,
    },
  });
  expect(ok.exitCode).toBe(0);
  expect((await listOrRemove()).length).toBeGreaterThan(0);
  // Another daemon, an unreadable ID: refuse, zero list or remove calls.
  for (const [nonce, env, why] of [
    [
      "7123456789abcdef0123456789abcdef",
      { DATA_STUB_DAEMON_ID: "DAEMON-B" },
      "daemon ID differs",
    ],
    [
      "8123456789abcdef0123456789abcdef",
      { DATA_STUB_DAEMON_ID: "" },
      "could not be read",
    ],
    [
      "9123456789abcdef0123456789abcdef",
      { DATA_STUB_INFO_FAIL: "unexpected server response" },
      "could not be read",
    ],
  ] as const) {
    await recordRun({
      nonce,
      managed: { DOCKER_HOST: managedHost },
      bin,
      log,
      daemonId: "DAEMON-A",
    });
    const refused = await runDataCli({
      cwd: projectRoot,
      args: ["data", "cleanup", "--nonce", nonce, "--json"],
      bin,
      env: {
        DATA_STUB_LOG: log,
        DATA_STUB_LABELED: "f".repeat(64),
        DATA_STUB_NONCE: nonce,
        ...env,
      },
    });
    expect({ nonce, ok: refused.exitCode === 0 }).toEqual({ nonce, ok: false });
    expect(refused.output).toContain("E_DATA_CLEANUP_RECORD");
    expect(refused.output).toContain(why);
    expect(await listOrRemove()).toEqual([]);
  }
  // A record an older Hack wrote, without a daemon ID: refuses, no call.
  const older = "a123456789abcdef0123456789abcdef";
  const olderPath = await recordRun({
    nonce: older,
    managed: { DOCKER_HOST: managedHost },
    bin,
    log,
  });
  const { daemonId: _dropped, ...withoutId } = JSON.parse(
    await readFile(olderPath, "utf8")
  );
  await writeFile(olderPath, `${JSON.stringify(withoutId)}\n`);
  const refused = await runDataCli({
    cwd: projectRoot,
    args: ["data", "cleanup", "--nonce", older, "--json"],
    bin,
    env: { DATA_STUB_LOG: log, DATA_STUB_NONCE: older },
  });
  expect(refused.output).toContain("E_DATA_CLEANUP_RECORD");
  expect(refused.output).toContain("holds no Docker engine ID");
  expect(await readFile(log, "utf8")).toBe("");
});

test("engine connection errors in export and cleanup are fixed text with a stable code, never the engine's line", async () => {
  const { bin, log } = await stubBin();
  const managedHost = `unix://${root}/managed-engine.sock`;
  const projectRoot = await shopProject({
    envFiles: { default: [`DOCKER_HOST: "${managedHost}"`] },
  });
  const nonce = "b123456789abcdef0123456789abcdef";
  await recordRun({
    nonce,
    managed: { DOCKER_HOST: managedHost },
    bin,
    log,
  });
  for (const line of PRIVATE_ENGINE_LINES) {
    for (const [args, failAt] of [
      [["data", "export"], "compose"],
      [["data", "export"], "info"],
      [["data", "export"], "volume inspect"],
      [["data", "cleanup", "--nonce", nonce], "info"],
      [["data", "cleanup", "--nonce", nonce], "ps --all"],
    ] as const) {
      for (const json of [false, true]) {
        const result = await runDataCli({
          cwd: projectRoot,
          args: [...args, ...(json ? ["--json"] : [])],
          bin,
          env: {
            DATA_STUB_LOG: log,
            DATA_STUB_FAIL: failAt,
            DATA_STUB_FAIL_TEXT: line,
            DATA_STUB_NONCE: nonce,
          },
        });
        const label = { command: args[1], failAt, json };
        expect({ ...label, ok: result.exitCode === 0 }).toEqual({
          ...label,
          ok: false,
        });
        expect({
          ...label,
          fixed: result.output.includes(
            "cannot reach the selected Docker engine"
          ),
          code: result.output.includes("E_DOCKER_UNAVAILABLE"),
        }).toEqual({ ...label, fixed: true, code: true });
        if (json) {
          const envelope = JSON.parse(result.stdout) as {
            error: { detail?: unknown };
          };
          expect({ ...label, detail: envelope.error.detail }).toEqual({
            ...label,
            detail: { reason: "engine_unreachable" },
          });
        }
        for (const fragment of PRIVATE_FRAGMENTS) {
          expect({
            ...label,
            fragment,
            leaked: result.output.includes(fragment),
          }).toEqual({
            ...label,
            fragment,
            leaked: false,
          });
        }
      }
    }
  }
});
