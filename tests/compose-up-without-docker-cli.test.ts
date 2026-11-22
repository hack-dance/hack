import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateCliEnv, privateCliHome } from "./helpers/private-cli-env.ts";

/**
 * HACK-2356. A machine with Hack's global proxy files but no `docker` on PATH
 * (a sandbox image copied from another machine, or a removed engine) must
 * get the closed E_DOCKER_UNAVAILABLE refusal from `hack up`, not a spawn
 * failure from the internal DNS discovery that runs before Compose.
 */

const repoRoot = join(import.meta.dir, "..");
let root = "";
let project = "";
let emptyBin = "";

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "hack-up-nodocker-")));
  project = join(root, "project");
  emptyBin = join(root, "empty-bin");
  await mkdir(join(project, ".hack"), { recursive: true });
  await mkdir(emptyBin);
  await Bun.write(
    join(project, ".hack", "hack.config.json"),
    '{"name":"up-nodocker","internal":{"dns":true,"tls":true}}\n'
  );
  await Bun.write(
    join(project, ".hack", "docker-compose.yml"),
    "services:\n  web:\n    image: example/web:1\n    networks: [hack-dev]\nnetworks:\n  hack-dev:\n    external: true\n"
  );
  // Global proxy files exist, as after an earlier `hack global install`.
  const caddy = join(privateCliHome(root), ".hack", "caddy");
  await mkdir(caddy, { recursive: true });
  await Bun.write(
    join(caddy, "docker-compose.yml"),
    "services:\n  caddy:\n    image: example/caddy:1\n  coredns:\n    image: example/coredns:1\n"
  );
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function hack(args: readonly string[], cwd = project, path = emptyBin) {
  const child = Bun.spawn(
    [process.execPath, join(repoRoot, "index.ts"), ...args],
    {
      cwd,
      env: privateCliEnv({
        root,
        env: {
          PATH: path,
          HACK_LOGGER: "console",
          NO_COLOR: "1",
          HACK_RUNTIME_BACKEND: "compose",
          HACK_NO_INTERACTIVE: "1",
        },
      }),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr, all: stdout + stderr };
}

test("up --json without docker names the missing engine even with global proxy files present", async () => {
  const result = await hack(["up", "--detach", "--json"]);
  expect(result.code).toBe(1);
  const envelope = JSON.parse(result.stdout) as {
    ok: boolean;
    error: { code: string; message: string };
  };
  expect(envelope.ok).toBe(false);
  expect(envelope.error.code).toBe("E_DOCKER_UNAVAILABLE");
  expect(envelope.error.message).toContain("no `docker` command");
  expect(result.all).not.toContain("Executable not found");
}, 60_000);

test("text-mode up without docker prints the engine blocker", async () => {
  const result = await hack(["up", "--detach"]);
  expect(result.code).toBe(1);
  expect(result.stderr).toEndWith(
    "! docker  cli missing · install docker engine with compose v2\n"
  );
  expect(result.all).not.toContain("Executable not found");
  expect(result.all).not.toContain("    at ");
}, 60_000);

test.each([
  "before",
  "after",
] as const)("a failed %s hook has one refusal and keeps the selected retry", async (phase) => {
  const cwd = join(root, `hook-project-${phase}`);
  const configDir = join(cwd, ".hack");
  await mkdir(configDir, { recursive: true });
  await Bun.write(
    join(configDir, "docker-compose.yml"),
    "services:\n  web:\n    image: example/web:1\n"
  );
  await Bun.write(
    join(configDir, "hack.config.json"),
    JSON.stringify({
      name: "hook-fixture",
      internal: { dns: false, tls: false },
      lifecycle: { up: { [phase]: [{ name: "check", command: "exit 17" }] } },
    })
  );
  const args = ["up", "--detach", "--path", cwd];
  const docker = join(configDir, "docker");
  await Bun.write(docker, "#!/bin/sh\nexit 0\n");
  await chmod(docker, 0o700);
  const result = await hack(args, cwd, `${configDir}:/usr/bin:/bin`);
  expect(result.code, result.all).toBe(17);
  expect(result.stdout).not.toContain("failed (exit 17)");
  expect(result.stderr).toEndWith(
    `! lifecycle  hook failed (${phase}, check, exit 17)\n  fix the failing hook and retry this start. run:\n  hack ${args.join(" ")}\n`
  );
});
