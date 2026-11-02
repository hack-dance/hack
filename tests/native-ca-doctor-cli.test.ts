import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

const CLI = join(import.meta.dir, "..", "index.ts");

async function fixtureRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "native-ca-cli-")));
  roots.push(root);
  return root;
}

/** Runs the source CLI from `cwd` (default: a fresh directory outside any project). */
async function invoke(args: string[], cwd?: string) {
  const root = await fixtureRoot();
  const child = Bun.spawn([process.execPath, CLI, ...args], {
    cwd: cwd ?? root,
    env: privateCliEnv({
      root,
      env: {
        HACK_HOME: join(root, "home"),
        HACK_RUNTIME_BACKEND: "native",
        HACK_NATIVE_BINARY: "/nonexistent/hack-native",
        HACK_NATIVE_HOME: "/nonexistent/native-home",
        HACK_NO_INTERACTIVE: "1",
      },
    }),
    stdout: "pipe",
    stderr: "pipe",
    timeout: 5000,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}

test("native Doctor reports unknown owner without consulting Docker-era CA state", async () => {
  const result = await invoke(["doctor", "--json"]);
  expect(result.code).toBe(0);
  const envelope: unknown = JSON.parse(result.stdout);
  const checks: Record<string, unknown>[] = [
    { id: "native https owner", status: "warn" },
    { id: "native root trust", status: "warn" },
  ];
  if (process.platform === "darwin") {
    // The hack.local route check refuses before reading any host DNS file.
    checks.push({
      id: "native hack.local route",
      status: "warn",
      hackLocalRoute: { status: "refused", reason: "relay-not-verified" },
    });
  }
  expect(envelope).toMatchObject({ ok: true, data: { checks } });
  expect(result.stdout).not.toContain("caddy local ca");
  expect(result.stdout).not.toContain("docker daemon");
});

test("native global trust refuses the stale Docker export path", async () => {
  const result = await invoke(["global", "trust"]);
  expect(result.code).toBe(1);
  expect(result.stdout + result.stderr).toContain(
    "hack doctor --fix --browser-url"
  );
  expect(result.stdout + result.stderr).toContain(
    "No Docker-era CA was installed"
  );
});

test("native Doctor audits the project env key value-free, including nested public copies", async () => {
  const project = await fixtureRoot();
  await mkdir(join(project, ".hack"));
  await writeFile(
    join(project, ".hack", "docker-compose.yml"),
    "services:\n  web:\n    image: busybox\n"
  );
  const weakKey = "synthetic-weak-key";
  await writeFile(join(project, ".hack.secret.key"), `${weakKey}\n`, {
    mode: 0o600,
  });
  await chmod(join(project, ".hack.secret.key"), 0o600);
  await mkdir(join(project, "apps", "web", "public"), { recursive: true });
  await writeFile(
    join(project, "apps", "web", "public", ".hack.secret.key"),
    `${weakKey}\n`
  );

  const result = await invoke(["doctor", "--json"], project);

  expect(result.code).toBe(1);
  const envelope: unknown = JSON.parse(result.stdout);
  expect(envelope).toMatchObject({
    data: {
      checks: expect.arrayContaining([
        expect.objectContaining({
          id: "env key",
          status: "error",
          envKey: expect.objectContaining({
            findings: expect.arrayContaining([
              expect.objectContaining({
                code: "env-key-public-path",
                subject: "apps/web/public/.hack.secret.key",
              }),
              expect.objectContaining({ code: "env-key-wrong-length" }),
            ]),
          }),
        }),
      ]),
    },
  });
  const output = result.stdout + result.stderr;
  expect(output).not.toContain(weakKey);
  expect(output).not.toContain(project);
});

test("negative control: native Doctor outside a project adds no env key check", async () => {
  const result = await invoke(["doctor", "--json"]);
  expect(result.code).toBe(0);
  expect(result.stdout).not.toContain('"env key"');
});
