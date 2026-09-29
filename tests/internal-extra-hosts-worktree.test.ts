import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveInternalExtraHosts } from "../src/lib/internal-extra-hosts.ts";
import { resolvePrimaryLocalProjectDir } from "../src/lib/worktree-local-config.ts";

const roots: string[] = [];
let savedCi: string | undefined;
let savedMode: string | undefined;
beforeEach(() => {
  savedCi = process.env.CI;
  savedMode = process.env.HACK_EXECUTION_MODE;
  process.env.CI = undefined;
  process.env.HACK_EXECUTION_MODE = undefined;
});
afterEach(() => {
  if (savedCi === undefined) {
    process.env.CI = undefined;
  } else {
    process.env.CI = savedCi;
  }
  if (savedMode === undefined) {
    process.env.HACK_EXECUTION_MODE = undefined;
  } else {
    process.env.HACK_EXECUTION_MODE = savedMode;
  }
});
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});
async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "hack-host-inheritance-"))
  );
  roots.push(root);
  const primary = join(root, "main");
  const branch = join(root, "branch");
  await mkdir(primary);
  const git = async (...args: string[]) => {
    const child = Bun.spawn(["git", "-C", primary, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await child.exited;
    if (code) {
      throw new Error(await new Response(child.stderr).text());
    }
  };
  await git("init", "--quiet");
  await git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "fixture",
    "--quiet"
  );
  await git("worktree", "add", "--quiet", "-b", "fixture", branch);
  const context = { projectRoot: branch, projectDir: join(branch, ".hack") };
  for (const dir of [primary, branch]) {
    await mkdir(join(dir, ".hack", ".internal"), { recursive: true });
  }
  const write = (dir: string, value: unknown) =>
    Bun.write(
      join(dir, ".hack", ".internal", "extra-hosts.json"),
      JSON.stringify(value)
    );
  return { root, primary, branch, context, write };
}

test("linked checkout observes primary edits without copying state and exposes origins", async () => {
  const f = await fixture();
  await f.write(f.primary, { "search.test": "host-gateway" });
  expect(await resolveInternalExtraHosts(f.context)).toEqual({
    hosts: { "search.test": "host-gateway" },
    origins: {
      "search.test": join(f.primary, ".hack/.internal/extra-hosts.json"),
    },
  });
  expect(
    await Bun.file(
      join(f.context.projectDir, ".internal/extra-hosts.json")
    ).exists()
  ).toBe(false);
  await f.write(f.primary, { "new.test": "127.0.0.1" });
  expect((await resolveInternalExtraHosts(f.context)).hosts).toEqual({
    "new.test": "127.0.0.1",
  });
});

test("local override and tombstone survive later primary edits", async () => {
  const f = await fixture();
  await f.write(f.primary, {
    "search.test": "host-gateway",
    "remove.test": "host-gateway",
  });
  await f.write(f.branch, { "search.test": "127.0.0.2", "remove.test": null });
  expect((await resolveInternalExtraHosts(f.context)).hosts).toEqual({
    "search.test": "127.0.0.2",
  });
  await f.write(f.primary, {
    "search.test": "127.0.0.3",
    "remove.test": "127.0.0.4",
  });
  expect((await resolveInternalExtraHosts(f.context)).hosts).toEqual({
    "search.test": "127.0.0.2",
  });
});

test("optout and missing primary retain only local aliases", async () => {
  const f = await fixture();
  await f.write(f.primary, { "search.test": "host-gateway" });
  await f.write(f.branch, { "local.test": "127.0.0.1" });
  await Bun.write(
    join(f.context.projectDir, "hack.config.json"),
    JSON.stringify({ worktree: { inherit_local: false } })
  );
  expect((await resolveInternalExtraHosts(f.context)).hosts).toEqual({
    "local.test": "127.0.0.1",
  });
  await Bun.write(join(f.context.projectDir, "hack.config.json"), "{}");
  await rm(join(f.primary, ".hack"), { recursive: true });
  expect((await resolveInternalExtraHosts(f.context)).hosts).toEqual({
    "local.test": "127.0.0.1",
  });
});

test("primary and non-git directories do not inherit; redirected primary config is refused", async () => {
  const f = await fixture();
  expect(
    await resolvePrimaryLocalProjectDir({
      projectRoot: f.primary,
      projectDir: join(f.primary, ".hack"),
    })
  ).toBeNull();
  expect(
    await resolvePrimaryLocalProjectDir({
      projectRoot: f.root,
      projectDir: join(f.root, ".hack"),
    })
  ).toBeNull();
  await rm(join(f.primary, ".hack"), { recursive: true });
  await symlink(f.context.projectDir, join(f.primary, ".hack"));
  expect(await resolvePrimaryLocalProjectDir(f.context)).toBeNull();
});

test("malformed inherited alias data fails rather than silently removing aliases", async () => {
  const f = await fixture();
  await f.write(f.primary, { "search.test": 42 });
  await expect(resolveInternalExtraHosts(f.context)).rejects.toThrow(
    "Invalid internal extra-hosts entry"
  );
});

test("CLI list provenance, unset tombstone, and set affect only the linked checkout", async () => {
  const f = await fixture();
  for (const dir of [f.primary, f.branch]) {
    await Bun.write(
      join(dir, ".hack/docker-compose.yml"),
      "services:\n  app:\n    image: alpine\n"
    );
  }
  await f.write(f.primary, { "search.test": "host-gateway" });
  const cli = async (...args: string[]) => {
    const child = Bun.spawn(
      [
        ...(process.env.HACK_TEST_CLI_EXECUTABLE
          ? [process.env.HACK_TEST_CLI_EXECUTABLE]
          : [process.execPath, join(import.meta.dir, "../index.ts")]),
        "internal",
        "extra-hosts",
        ...args,
        "--path",
        f.branch,
      ],
      {
        cwd: f.branch,
        env: {
          PATH: process.env.PATH,
          HOME: f.root,
          HACK_HOME: join(f.root, "hack-home"),
        },
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const [code, output, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(error).not.toContain("ERROR");
    expect(code).toBe(0);
    return output;
  };
  expect(
    JSON.parse(await cli("list", "--origins")).origins["search.test"]
  ).toBe(join(f.primary, ".hack/.internal/extra-hosts.json"));
  await cli("unset", "search.test");
  expect(JSON.parse(await cli("list"))).toEqual({});
  expect(
    await Bun.file(join(f.primary, ".hack/.internal/extra-hosts.json")).json()
  ).toEqual({ "search.test": "host-gateway" });
  await cli("set", "search.test", "127.0.0.2");
  expect(JSON.parse(await cli("list"))).toEqual({ "search.test": "127.0.0.2" });
});

test("CI and slim runners do not read primary aliases", async () => {
  const f = await fixture();
  await f.write(f.primary, { "search.test": "host-gateway" });
  process.env.CI = "true";
  expect((await resolveInternalExtraHosts(f.context)).hosts).toEqual({});
  process.env.CI = undefined;
  process.env.HACK_EXECUTION_MODE = "slim";
  expect((await resolveInternalExtraHosts(f.context)).hosts).toEqual({});
});

test("inherited nested directories and files cannot redirect source provenance", async () => {
  const f = await fixture();
  await f.write(f.branch, { "local.test": "host-gateway" });
  const internal = join(f.primary, ".hack/.internal");
  await rm(internal, { recursive: true });
  await symlink(join(f.branch, ".hack/.internal"), internal);
  await expect(resolveInternalExtraHosts(f.context)).rejects.toThrow(
    "Refusing redirected"
  );
  await rm(internal);
  await mkdir(internal);
  await symlink(
    join(f.branch, ".hack/.internal/extra-hosts.json"),
    join(internal, "extra-hosts.json")
  );
  await expect(resolveInternalExtraHosts(f.context)).rejects.toThrow(
    "Refusing redirected"
  );
});

test("explicit local static aliases override inherited aliases; local dynamic wins last", async () => {
  const f = await fixture();
  await f.write(f.primary, { "search.test": "host-gateway" });
  const opts = { ...f.context, staticHosts: { "search.test": "127.0.0.2" } };
  expect((await resolveInternalExtraHosts(opts)).hosts).toEqual({
    "search.test": "127.0.0.2",
  });
  await f.write(f.branch, { "search.test": "127.0.0.3" });
  expect((await resolveInternalExtraHosts(opts)).hosts).toEqual({
    "search.test": "127.0.0.3",
  });
});
