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
import { privateCliEnv } from "./helpers/private-cli-env.ts";

/**
 * The project's managed Compose env (here a managed DOCKER_HOST) reaches
 * every Docker subprocess of an export: Compose, `volume inspect`, `ps`,
 * `events` and both helper runs. A stub `docker` found through the managed
 * PATH records the DOCKER_HOST each call saw; the runner's own environment
 * is not changed.
 */

const MANAGED_HOST = "unix:///managed/engine.sock";

const STUB = `
const { appendFileSync, readFileSync, existsSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.DATA_STUB_LOG, JSON.stringify({ args, host: process.env.DOCKER_HOST ?? null }) + "\\n");
// An unreachable engine at one step: the client names DOCKER_HOST verbatim.
const failAt = process.env.DATA_STUB_FAIL;
if (failAt && args.join(" ").includes(failAt)) {
  process.stderr.write("Cannot connect to the Docker daemon at " + process.env.DOCKER_HOST + ". Is the docker daemon running?\\n");
  process.exit(1);
}
const feed = process.env.DATA_STUB_LOG + ".events";
const out = (value) => process.stdout.write(typeof value === "string" ? value : JSON.stringify(value) + "\\n");
if (args[0] === "events") {
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
  out({ name: "shop", services: {}, volumes: { db: { name: "shop_db" } } });
} else if (args[0] === "volume" && args[1] === "inspect") {
  out({ name: "shop_db", createdAt: "2026-11-24T00:00:00Z", driver: "local", mountpoint: "/var/lib/docker/volumes/shop_db/_data", options: null, labels: { "com.docker.compose.project": "shop", "com.docker.compose.volume": "db" } });
} else if (args[0] === "ps") {
  out("");
} else if (args[0] === "run" || args[0] === "start") {
  const name = args[0] === "run" ? args[args.indexOf("--name") + 1] : args.at(-1);
  appendFileSync(feed, JSON.stringify({ Type: "container", Action: "start", Actor: { ID: name, Attributes: { name } } }) + "\\n");
} else if (args[0] === "create") {
  out("c".repeat(64));
} else if (args[0] === "container" && args.includes("{{json .Mounts}}")) {
  out([{ Type: "bind", Source: "/var/lib/docker/volumes/shop_db/_data", Destination: "/v", RW: false }]);
} else if (args[0] === "container") {
  process.stderr.write("Error: No such container: " + args.at(-1) + "\\n");
  process.exit(1);
} else if (args[0] === "rm") {
  out(args.at(-1));
} else if (args[0] === "exec") {
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
    expect(refusal.message).toContain("Engine said: Cannot connect");
    expect(refusal.message).toContain("[REDACTED]");
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
    expect(output).toContain(
      "Cannot connect to the Docker daemon at [REDACTED]"
    );
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
