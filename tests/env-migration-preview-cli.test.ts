import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fixtureChildren } from "./helpers/fixture-children.ts";
import { privateCliEnv, privateCliHome } from "./helpers/private-cli-env.ts";

const binary = process.env.HACK_TEST_ENV_MIGRATION_BINARY;
function cliPrefix(): readonly string[] {
  if (binary && !isAbsolute(binary)) {
    throw new Error("Compiled test executable must be absolute");
  }
  return binary
    ? [binary]
    : [
        process.execPath,
        "--no-env-file",
        resolve(import.meta.dir, "..", "index.ts"),
      ];
}
const sentinel = "synthetic-preview-cli-value";
const children = fixtureChildren("env-migration-preview");
let root: string | null = null;
afterEach(async () => {
  await children.stopAll();
  if (root) {
    await rm(root, { recursive: true, force: true });
  }
  root = null;
});

async function fixture() {
  root = await realpath(await mkdtemp(join(tmpdir(), "env-preview-")));
  const project = join(root, "project");
  const projectDir = join(project, ".hack");
  await mkdir(projectDir, { recursive: true });
  await writeFile(join(projectDir, "hack.config.json"), '{"name":"preview"}\n');
  await writeFile(
    join(projectDir, "docker-compose.yml"),
    "services:\n  api:\n    image: alpine:3.22\n"
  );
  await writeFile(
    join(projectDir, "hack.env.json"),
    JSON.stringify({
      version: 1,
      vars: [{ key: "TOKEN", source: "plain_env" }],
    })
  );
  await writeFile(join(projectDir, ".env"), `TOKEN=${sentinel}\n`);
  const env = privateCliEnv({
    root,
    env: {
      HACK_HOME: join(root, "data"),
      HACK_NO_INTERACTIVE: "1",
      PATH: "/nonexistent",
    },
  });
  return { root, project, projectDir, env, home: privateCliHome(root) };
}

test("CLI preview JSON is versioned and value-free with no runtime, HOME state or project writes", async () => {
  const selected = await fixture();
  const names = (await readdir(selected.projectDir)).sort();
  const before = await Promise.all(
    names.map((name) => readFile(join(selected.projectDir, name), "utf8"))
  );
  for (const flags of [[], ["--cleanup"]]) {
    const result = await children.run({
      cmd: [
        ...cliPrefix(),
        "env",
        "migrate",
        "--path",
        selected.project,
        "--json",
        ...flags,
      ],
      cwd: selected.project,
      env: selected.env,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout + result.stderr).not.toContain(sentinel);
    const output = JSON.parse(result.stdout);
    expect(output).toMatchObject({
      ok: true,
      data: {
        version: 1,
        status: "ready",
        dryRun: true,
        action: flags.length ? "cleanup" : "preview",
        manifestPath: null,
        project: {
          projectRoot: selected.project,
          projectDir: selected.projectDir,
          projectName: "preview",
          serviceNames: ["api"],
        },
      },
    });
    expect(Object.keys(output.data).sort()).toEqual(
      [
        "version",
        "status",
        "dryRun",
        "action",
        "project",
        "files",
        "journalPath",
        "manifestPath",
      ].sort()
    );
    for (const file of output.data.files) {
      expect(Object.keys(file).sort()).toEqual(
        ["path", "action", "keys", "tracked"].sort()
      );
      if (flags.length) {
        expect(file.action).toBe("removable");
      }
    }
    expect((await readdir(selected.projectDir)).sort()).toEqual(names);
    expect(
      await Promise.all(
        names.map((name) => readFile(join(selected.projectDir, name), "utf8"))
      )
    ).toEqual(before);
    expect(await Bun.file(output.data.journalPath).exists()).toBe(false);
    expect(await readdir(selected.home)).toEqual([]);
  }
});

test("malformed legacy input cannot print its sentinel in JSON errors", async () => {
  const selected = await fixture();
  await writeFile(
    join(selected.projectDir, "hack.env.json"),
    `{"vars":[${sentinel}`
  );
  const result = await children.run({
    cmd: [
      ...cliPrefix(),
      "env",
      "migrate",
      "--path",
      selected.project,
      "--json",
    ],
    cwd: selected.project,
    env: selected.env,
  });
  expect(result.exitCode).not.toBe(0);
  expect(result.stdout + result.stderr).not.toContain(sentinel);
  expect(JSON.parse(result.stdout).ok).toBe(false);
  expect((await readdir(selected.projectDir)).sort()).toEqual([
    ".env",
    "docker-compose.yml",
    "hack.config.json",
    "hack.env.json",
  ]);
});
