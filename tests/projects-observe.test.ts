import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

let root = "";
let state = "";
let bin = "";
let registry = "";
let cwd = "";
const entrypoint = resolve(import.meta.dir, "..", "index.ts");

async function project(name: string, native = false) {
  const repoRoot = join(root, name);
  const projectDir = join(repoRoot, ".hack");
  await mkdir(projectDir, { recursive: true });
  if (native) {
    await writeFile(join(projectDir, "hack.project.json"), "{}\n");
  } else {
    await writeFile(
      join(projectDir, "hack.config.json"),
      JSON.stringify({ name })
    );
    await writeFile(
      join(projectDir, "docker-compose.yml"),
      "services:\n  web:\n    image: example/web:1\n"
    );
  }
  return {
    id: `id-${name}`,
    name,
    repoRoot,
    projectDir,
    projectDirName: ".hack",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-01T00:00:00.000Z",
  };
}

beforeEach(async () => {
  root = await realpath(
    await mkdtemp(join(tmpdir(), "hack-projects-observe-"))
  );
  state = join(root, "state");
  bin = join(root, "bin");
  await mkdir(state);
  await mkdir(bin);
  registry = join(state, "projects.json");
  const compose = await project("compose-app");
  const native = await project("native-app", true);
  const unregistered = await project("unregistered-app");
  cwd = compose.repoRoot;
  await writeFile(
    registry,
    JSON.stringify({ version: 1, projects: [compose, native] })
  );
  await utimes(registry, new Date("2026-01-01"), new Date("2026-01-01"));
  const docker = join(bin, "docker");
  await writeFile(
    docker,
    `#!${process.execPath}\nconst args=process.argv.slice(2);\nawait Bun.write(Bun.file(process.env.CALLS), (await Bun.file(process.env.CALLS).text().catch(()=>""))+JSON.stringify(args)+"\\n");\nif(args[0]==="ps") {\n if(process.env.OFFLINE==="1") process.exit(1);\n console.log(JSON.stringify({ID:"fixture-container",State:"running",Status:"Up",Names:"fixture-web",Labels:${JSON.stringify(`com.docker.compose.project=unregistered-app,com.docker.compose.service=web,com.docker.compose.project.working_dir=${unregistered.projectDir}`)}}));\n} else if(args[0]!=="inspect") process.exit(99);\n`
  );
  await chmod(docker, 0o755);
  for (const name of [
    "hack",
    "open",
    "systemctl",
    "launchctl",
    "native-runtime",
  ]) {
    await writeFile(
      join(bin, name),
      `#!${process.execPath}\nawait Bun.write(process.env.FORBIDDEN, "unexpected effect"); process.exit(99);\n`
    );
    await chmod(join(bin, name), 0o755);
  }
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function run(args: string[], extra: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, entrypoint, "projects", ...args], {
    cwd,
    env: privateCliEnv({
      root,
      env: {
        PATH: bin,
        HACK_HOME: state,
        HACK_GLOBAL_CONFIG_PATH: join(state, "hack.config.json"),
        CALLS: join(root, "calls"),
        FORBIDDEN: join(root, "forbidden"),
        ...extra,
      },
    }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

test("observe full/summary/filter listings preserve registry bytes and mtime without starting services", async () => {
  const before = await readFile(registry);
  const time = (await stat(registry)).mtimeMs;
  for (const flags of [
    [],
    ["--summary"],
    ["--project", "native-app"],
    ["--all"],
  ]) {
    const result = await run(["--json", "--observe", ...flags]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.observe).toBe(true);
    const native = payload.projects.find(
      (row: { name: string }) => row.name === "native-app"
    );
    expect(native.backend).toBe("native");
    expect(native.state).toBe("unknown");
    expect(native.state_reason).toBe("native-observer-required");
    expect(native.started_at).toBeNull();
    expect(native.services).toEqual([]);
    if (flags.includes("--all")) {
      expect(
        payload.projects.some(
          (row: { name: string }) => row.name === "unregistered-app"
        )
      ).toBe(true);
      expect(
        payload.projects.find(
          (row: { name: string }) => row.name === "unregistered-app"
        ).state
      ).toBe("running");
    }
    expect(await readFile(registry)).toEqual(before);
    expect((await stat(registry)).mtimeMs).toBe(time);
  }
  const calls = (await readFile(join(root, "calls"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(
    calls.every((args: string[]) => ["ps", "inspect"].includes(args[0] ?? ""))
  ).toBe(true);
  expect(await stat(join(root, "forbidden")).catch(() => null)).toBeNull();
  expect(await stat(join(state, "daemon")).catch(() => null)).toBeNull();
});

test("observe keeps native rows and unknown Compose services when Docker is unavailable", async () => {
  const before = await readFile(registry);
  const time = (await stat(registry)).mtimeMs;
  const result = await run(["--json", "--observe"], { OFFLINE: "1" });
  expect(result.code).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload.runtime_ok).toBe(false);
  const compose = payload.projects.find(
    (row: { name: string }) => row.name === "compose-app"
  );
  expect(compose.backend).toBe("compose");
  expect(compose.state).toBe("unknown");
  expect(compose.services).toEqual([
    {
      name: "web",
      state: "unknown",
      ready: null,
      completed: null,
      health: null,
      exit_code: null,
      started_at: null,
    },
  ]);
  expect(payload.projects).toHaveLength(2);
  expect(await readFile(registry)).toEqual(before);
  expect((await stat(registry)).mtimeMs).toBe(time);
});

test("observe never creates a missing registry or registers the current checkout", async () => {
  await rm(registry);
  const result = await run(["--json", "--observe"]);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout).projects).toEqual([]);
  expect(await stat(registry).catch(() => null)).toBeNull();
});

test("observe rejects text and metadata before touching registration", async () => {
  const before = await readFile(registry);
  const time = (await stat(registry)).mtimeMs;
  for (const args of [["--observe"], ["--observe", "--json", "--meta"]]) {
    expect((await run(args)).code).not.toBe(0);
    expect(await readFile(registry)).toEqual(before);
    expect((await stat(registry)).mtimeMs).toBe(time);
  }
});

test("observe does not query an available daemon cache", async () => {
  const daemonDir = join(state, "daemon");
  await mkdir(daemonDir);
  let requests = 0;
  const server = Bun.serve({
    unix: join(daemonDir, "hackd.sock"),
    fetch() {
      requests += 1;
      return Response.json({ projects: [{ name: "stale-cache" }] });
    },
  });
  try {
    const result = await run(["--json", "--observe"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).projects).toHaveLength(2);
    expect(requests).toBe(0);
  } finally {
    await server.stop(true);
  }
});
