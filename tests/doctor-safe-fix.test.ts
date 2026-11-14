import { expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runFixtureGit } from "./helpers/fixture-git.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

const cli = resolve(import.meta.dir, "../index.ts");
const selected = ["--fix", "--only", "hack gitignore", "--yes", "--json"];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "doctor-safe-fix-"));
  const project = join(root, "project");
  await mkdir(join(project, ".hack"), { recursive: true });
  await runFixtureGit({ cwd: project, args: ["init", "--quiet"] });
  await Bun.write(join(project, ".hack/docker-compose.yml"), "services: {}\n");
  const tools = join(root, "tools");
  await mkdir(tools);
  const called = join(root, "unexpected-tool");
  for (const name of ["docker", "hackd", "sudo", "security", "systemctl"]) {
    await Bun.write(
      join(tools, name),
      `#!/bin/sh\nprintf unexpected >> '${called}'\nexit 90\n`
    );
    await chmod(join(tools, name), 0o700);
  }
  const invoke = async (flags: string[]) => {
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        cli,
        "doctor",
        "--path",
        project,
        ...flags,
      ],
      {
        cwd: root,
        env: privateCliEnv({
          root,
          env: {
            HACK_HOME: join(root, "state"),
            HACK_GLOBAL_CONFIG_PATH: join(root, "state/hack.config.json"),
            PATH: `${tools}:/usr/bin:/bin`,
            HACK_NO_INTERACTIVE: "1",
            HACK_LOGGER: "console",
          },
        }),
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(await Bun.file(called).exists()).toBe(false);
    return { code, stdout, stderr, json: JSON.parse(stdout) };
  };
  return { root, project, invoke, file: join(project, ".hack/.gitignore") };
}

test("one safe fix preserves user lines and other findings, rechecks, and is idempotent", async () => {
  const f = await fixture();
  try {
    await Bun.write(f.file, "# user-owned rule\ncustom.tmp\n");
    const unrelated = join(f.project, ".hack/.env");
    await Bun.write(unrelated, "SYNTHETIC_SENTINEL=not-a-real-secret\n");
    const result = await f.invoke(selected);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(Object.keys(result.json)).toEqual(["ok", "data"]);
    expect(result.json).toMatchObject({
      ok: true,
      data: {
        schema: 1,
        fix: { id: "hack gitignore", changed: true, confirmed: true },
        counts: { ok: 1, warn: 0, error: 0 },
        checks: [{ id: "hack gitignore", status: "ok", fix: { kind: "safe" } }],
      },
    });
    expect(result.json.data.checks).toHaveLength(1);
    expect(await Bun.file(f.file).text()).toContain(
      "# user-owned rule\ncustom.tmp\n"
    );
    expect(await Bun.file(unrelated).text()).toBe(
      "SYNTHETIC_SENTINEL=not-a-real-secret\n"
    );
    expect(result.stdout).not.toContain("SYNTHETIC_SENTINEL");
    const before = await readFile(f.file);
    const again = await f.invoke(selected);
    expect(again.code).toBe(0);
    expect(again.json.data.fix).toMatchObject({
      changed: false,
      confirmed: true,
    });
    expect(await readFile(f.file)).toEqual(before);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("missing consent, broad fix, admin/manual/unknown IDs and mixed modes refuse before mutation", async () => {
  const f = await fixture();
  try {
    for (const flags of [
      ["--fix", "--only", "hack gitignore", "--json"],
      ["--only", "hack gitignore", "--yes", "--json"],
      ["--fix", "--yes", "--json"],
      ["--fix", "--json"],
      ...["local ca trust", "daemon", "unknown", "__proto__"].map((id) => [
        "--fix",
        "--only",
        id,
        "--yes",
        "--json",
      ]),
      [...selected, "--migrate-env-config"],
      [...selected, "--native-preflight"],
    ]) {
      const result = await f.invoke(flags);
      expect(result.code).not.toBe(0);
      expect(result.json).toMatchObject({
        ok: false,
        error: { code: "E_USAGE" },
      });
      expect(await Bun.file(f.file).exists()).toBe(false);
      expect(await readdir(join(f.project, ".hack"))).toEqual([
        "docker-compose.yml",
      ]);
    }
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

for (const mode of ["read-only", "symlink"] as const) {
  test(`a ${mode} ignore file is retained and cannot be reported fixed`, async () => {
    const f = await fixture();
    try {
      const target = join(f.root, "user-content");
      await Bun.write(target, "user content\n");
      if (mode === "symlink") {
        await symlink(target, f.file);
      } else {
        await Bun.write(f.file, "user rule\n");
        await chmod(f.file, 0o400);
      }
      const result = await f.invoke(selected);
      expect(result.code).toBe(1);
      expect(result.json).toMatchObject({
        ok: true,
        data: {
          fix: { changed: false, confirmed: false },
          checks: [{ status: "error" }],
        },
      });
      expect(await Bun.file(target).text()).toBe("user content\n");
      expect(await Bun.file(f.file).text()).toBe(
        mode === "symlink" ? "user content\n" : "user rule\n"
      );
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
}
