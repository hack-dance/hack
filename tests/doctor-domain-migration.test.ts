import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const directories: string[] = [];
const sentinel = "PRIVATE_CONFIG_MUST_NOT_APPEAR";
afterEach(async () => {
  for (const path of directories.splice(0)) {
    await rm(path, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "hack-domain-cli-"))
  );
  directories.push(root);
  const projectDir = join(root, "repo", ".hack");
  const home = join(root, "isolated-home");
  await mkdir(projectDir, { recursive: true });
  await mkdir(home);
  const configPath = join(projectDir, "hack.config.json");
  const composePath = join(projectDir, "docker-compose.yml");
  const config = `{"name":"demo", "dev_host":"demo.hack", "private_note":"${sentinel}"}\n`;
  const compose = `# retain this comment\nservices:\n  web:\n    image: nginx:alpine\n    labels:\n      caddy: "demo.hack, demo.hack.gy"\n      caddy.tls: internal\n    environment:\n      PRIVATE_NOTE: "${sentinel}"\n`;
  await Bun.write(configPath, config);
  await Bun.write(composePath, compose);
  await chmod(configPath, 0o640);
  await chmod(composePath, 0o600);
  return { root, projectDir, home, configPath, composePath, config, compose };
}

async function invoke(
  f: Awaited<ReturnType<typeof fixture>>,
  action: string,
  extra: string[] = []
) {
  const binary = process.env.HACK_E2E_CLI_BIN;
  const command = binary
    ? [resolve(binary)]
    : [process.execPath, resolve("index.ts")];
  const processHandle = Bun.spawn(
    [
      ...command,
      "doctor",
      "--domain-migration",
      action,
      "--path",
      join(f.root, "repo"),
      "--json",
      ...extra,
    ],
    {
      env: {
        ...process.env,
        HACK_HOME: f.home,
        HACK_NO_INTERACTIVE: "1",
        PATH: join(f.root, "no-tools"),
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
    processHandle.exited,
  ]);
  expect(stdout + stderr).not.toContain(sentinel);
  return { stdout, stderr, exitCode };
}

test("standalone Doctor migration previews, applies and restores exact bytes and modes without host tools", async () => {
  const f = await fixture();
  const preview = await invoke(f, "preview");
  expect(preview.exitCode).toBe(0);
  expect(JSON.parse(preview.stdout).toHost).toBe("demo.hack.local");
  expect(await readFile(f.configPath, "utf8")).toBe(f.config);
  expect(await readFile(f.composePath, "utf8")).toBe(f.compose);
  expect(await Bun.file(join(f.home, "projects.json")).exists()).toBe(false);

  const applied = await invoke(f, "apply");
  expect(applied.exitCode).toBe(0);
  expect(JSON.parse(applied.stdout).status).toBe("applied");
  expect((await Bun.file(f.configPath).json()).dev_host).toBe(
    "demo.hack.local"
  );
  const changed = await readFile(f.composePath, "utf8");
  expect(changed).toContain("demo.hack.local");
  expect(changed).toContain("demo.hack.gy");

  const rollback = await invoke(f, "rollback");
  expect(rollback.exitCode).toBe(0);
  expect(JSON.parse(rollback.stdout).status).toBe("restored");
  expect(await readFile(f.configPath, "utf8")).toBe(f.config);
  expect(await readFile(f.composePath, "utf8")).toBe(f.compose);
  expect((await stat(f.configPath)).mode & 0o777).toBe(0o640);
  expect((await stat(f.composePath)).mode & 0o777).toBe(0o600);
});

test("migration rejects broad Doctor repairs and invalid actions before writes", async () => {
  const f = await fixture();
  for (const [action, extra] of [
    ["apply", ["--fix"]],
    ["unknown", []],
  ] as const) {
    expect((await invoke(f, action, [...extra])).exitCode).not.toBe(0);
    expect(await readFile(f.configPath, "utf8")).toBe(f.config);
    expect(await readFile(f.composePath, "utf8")).toBe(f.compose);
  }
});

test("rollback refuses subsequent edits without restoring either file", async () => {
  const f = await fixture();
  expect((await invoke(f, "apply")).exitCode).toBe(0);
  const appliedConfig = await readFile(f.configPath, "utf8");
  const edited = `${await readFile(f.composePath, "utf8")}# independent edit\n`;
  await Bun.write(f.composePath, edited);
  expect((await invoke(f, "rollback")).exitCode).not.toBe(0);
  expect(await readFile(f.configPath, "utf8")).toBe(appliedConfig);
  expect(await readFile(f.composePath, "utf8")).toBe(edited);
});

test("registered route collision prevents apply and does not disclose config", async () => {
  const f = await fixture();
  const other = join(f.root, "other", ".hack");
  await mkdir(other, { recursive: true });
  await Bun.write(
    join(other, "docker-compose.yml"),
    "services:\n  web:\n    labels:\n      caddy: demo.hack.local\n"
  );
  await Bun.write(
    join(f.home, "projects.json"),
    JSON.stringify({ version: 1, projects: [{ projectDir: other }] })
  );
  expect((await invoke(f, "apply")).exitCode).not.toBe(0);
  expect(await readFile(f.configPath, "utf8")).toBe(f.config);
  expect(await readFile(f.composePath, "utf8")).toBe(f.compose);
});
