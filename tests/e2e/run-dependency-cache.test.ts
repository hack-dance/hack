import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const roots: string[] = [];
const cli = resolve(import.meta.dir, "../../index.ts");
const containerId = "a".repeat(64);

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

type DockerCall = {
  readonly args: string[];
  readonly volumeName: string | null;
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "hack-run-cache-"));
  roots.push(root);
  const primary = join(root, "primary");
  const projectDir = join(primary, ".hack");
  const bin = join(root, "bin");
  const home = join(root, "home");
  for (const path of [projectDir, bin, home]) {
    await mkdir(path, { recursive: true });
  }
  const compose = `name: cache-run
services:
  installer:
    image: alpine:3.20
    command: ["true"]
    labels:
      hack.dependencies.cache-volume: dependencies
      hack.dependencies.lockfiles: bun.lock
    volumes:
      - dependencies:/deps
  api:
    image: alpine:3.20
    depends_on:
      installer:
        condition: service_completed_successfully
    volumes:
      - dependencies:/deps
volumes:
  dependencies: {}
`;
  await writeFile(join(projectDir, "docker-compose.yml"), compose);
  await writeFile(
    join(projectDir, "hack.config.json"),
    '{"name":"cache-run","dev_host":"cache-run.hack"}\n'
  );
  await writeFile(join(primary, "bun.lock"), "lock-one\n");
  const git = (args: string[]) => {
    const result = Bun.spawnSync(["git", "-C", primary, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
  };
  git(["init", "-b", "main"]);
  git(["add", "."]);
  git([
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-qm",
    "fixture",
  ]);
  const worktree = join(root, "worktree");
  git(["worktree", "add", "-qb", "feature/cache", worktree]);
  const state = join(root, "docker-state.json");
  const log = join(root, "docker-log.jsonl");
  await writeFile(state, "{}");
  await writeFile(log, "");
  const docker = join(bin, "docker");
  await writeFile(
    docker,
    `#!${process.execPath}
import { appendFileSync } from "node:fs";
import { YAML } from "bun";
const args = process.argv.slice(2);
const state = await Bun.file(${JSON.stringify(state)}).json();
let merged = {services:{}, volumes:{}};
for (let i=0; i<args.length; i++) {
  if(args[i] !== "-f") continue;
  const doc=YAML.parse(await Bun.file(args[++i]).text());
  Object.assign(merged.services, doc.services ?? {});
  Object.assign(merged.volumes, doc.volumes ?? {});
}
appendFileSync(${JSON.stringify(log)}, JSON.stringify({args,volumeName:merged.volumes.dependencies?.name ?? null})+"\\n");
if(args[0] === "inspect") {
  process.stdout.write(state.rawInspect ?? JSON.stringify(state.inspect ?? {}));
  process.exit(state.inspectExit ?? 0);
}
if(args.includes("ps")) for(const row of state.ps ?? []) console.log(JSON.stringify(row));
else if(args.includes("config")) console.log(JSON.stringify(merged));
else if(args.includes("run")) console.log("fixture-command-output");
`
  );
  await chmod(docker, 0o755);
  const run = async (project: string = primary, extra: string[] = []) => {
    const child = Bun.spawn(
      [
        process.execPath,
        cli,
        "run",
        "--path",
        project,
        ...extra,
        "api",
        "echo",
        "ok",
      ],
      {
        cwd: primary,
        env: {
          ...process.env,
          HOME: home,
          HACK_HOME: join(home, ".hack"),
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          HACK_NO_INTERACTIVE: "1",
          HACK_LOGGER: "console",
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ exitCode, stderr: exitCode === 0 ? "" : stderr }).toEqual({
      exitCode: 0,
      stderr: "",
    });
    expect(stdout).toContain("fixture-command-output");
    const calls = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as DockerCall);
    const call = calls.findLast((entry) => entry.args.includes("run"));
    expect(call).toBeDefined();
    return { call: call as DockerCall, calls };
  };
  const running = async (
    volumeName: string | null,
    overrides: Record<string, unknown> = {}
  ) => {
    await writeFile(
      state,
      JSON.stringify({
        ps: [{ ID: containerId, Service: "api", State: "running" }],
        inspect: {
          id: containerId,
          running: true,
          project: "cache-run",
          service: "api",
          mounts: [{ Type: "volume", Name: volumeName }],
          ...overrides,
        },
      })
    );
  };
  return { primary, worktree, projectDir, state, log, run, running };
}

test("run shares the startup cache across primary and linked worktrees", async () => {
  const f = await fixture();
  const primary = await f.run();
  const branch = await f.run(f.worktree, [
    "--profile",
    "worker",
    "--workdir",
    "/deps",
  ]);
  expect(primary.call.volumeName).toMatch(
    /^hack-cache-cache-run-dependencies-[a-f0-9]{16}$/
  );
  expect(branch.call.volumeName).toBe(primary.call.volumeName);
  expect(branch.call.args).toContain("cache-run--feature-cache");
  expect(branch.call.args).toContain("--profile");
  expect(branch.call.args).toContain("worker");
  expect(branch.call.args).toContain("/deps");
  expect(branch.call.args).not.toContain("--no-deps");
  await f.running(branch.call.volumeName, {
    project: "cache-run--feature-cache",
  });
  expect((await f.run(f.worktree)).call.args).toContain("--no-deps");
  expect(
    primary.call.args.some((arg) =>
      arg.endsWith("compose.dependencies.override.yml")
    )
  ).toBe(true);
});

test("run skips dependencies only while running mounts match the selected fingerprint", async () => {
  const f = await fixture();
  const cold = await f.run();
  await f.running(cold.call.volumeName);
  expect((await f.run()).call.args).toContain("--no-deps");
  await writeFile(join(f.primary, "bun.lock"), "lock-two\n");
  const changed = await f.run();
  expect(changed.call.volumeName).not.toBe(cold.call.volumeName);
  expect(changed.call.args).not.toContain("--no-deps");
  expect(
    changed.calls.some(
      (call) => call.args.includes("rm") || call.args.includes("prune")
    )
  ).toBe(false);
});

test("run reconciles dependencies when inspection cannot prove identity and cache mounts", async () => {
  const f = await fixture();
  const cold = await f.run();
  for (const mismatch of [
    { id: "b".repeat(64) },
    { running: false },
    { project: "another-project" },
    { service: "another-service" },
    { mounts: [] },
    { mounts: [{ Type: "bind", Name: cold.call.volumeName }] },
  ]) {
    await f.running(cold.call.volumeName, mismatch);
    expect((await f.run()).call.args).not.toContain("--no-deps");
  }
  for (const failure of [{ rawInspect: "invalid JSON" }, { inspectExit: 1 }]) {
    await f.running(cold.call.volumeName);
    await writeFile(
      f.state,
      JSON.stringify({
        ...JSON.parse(await readFile(f.state, "utf8")),
        ...failure,
      })
    );
    expect((await f.run()).call.args).not.toContain("--no-deps");
  }
});

test("unlabelled run keeps the existing dependency skip without container inspection", async () => {
  const f = await fixture();
  await writeFile(
    join(f.projectDir, "docker-compose.yml"),
    "name: cache-run\nservices:\n  api:\n    image: alpine:3.20\n"
  );
  await f.running(null);
  const result = await f.run();
  expect(result.call.args).toContain("--no-deps");
  expect(result.call.volumeName).toBeNull();
  expect(result.calls.some((call) => call.args[0] === "inspect")).toBe(false);
});
