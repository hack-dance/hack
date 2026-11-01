import { afterEach, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { ClosedCliError } from "../src/lib/cli-result.ts";
import {
  hydrateProjectEnvLocalLayer,
  resolveProjectEnvConfig,
  setProjectEnvValue,
  unsetProjectEnvValue,
} from "../src/lib/project-env-config.ts";
import { assertProjectEnvLayerPath } from "../src/lib/project-env-layer-path.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

const ENTRYPOINT = resolve(import.meta.dir, "../index.ts");
const WORKER = resolve(
  import.meta.dir,
  "fixtures/project-env-symlink-swap-worker.ts"
);
const VALUE = "synthetic-boundary-value-1685";
const ORIGINAL = `version: 1\nenvironment: default\nsecretsprovider: project_key\nvalues:\n  global:\n    SETTING: ${VALUE}\n`;
const roots = new Set<string>();
afterEach(async () => {
  for (const root of roots) {
    await rm(root, { recursive: true, force: true });
  }
  roots.clear();
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "hack-env-boundary-"));
  roots.add(root);
  const projectRoot = resolve(root, "proj");
  const projectDir = resolve(projectRoot, ".hack");
  const outsideDir = resolve(root, "proj-x");
  await mkdir(projectDir, { recursive: true });
  await mkdir(outsideDir);
  await writeFile(
    resolve(projectDir, "docker-compose.yml"),
    "services:\n  api:\n    image: alpine:3.20\n"
  );
  await writeFile(
    resolve(projectDir, "hack.config.json"),
    '{"name":"env-boundary","dev_host":"env-boundary.hack"}\n'
  );
  const outside = resolve(outsideDir, "target.yaml");
  await writeFile(outside, ORIGINAL);
  return { root, projectRoot, projectDir, outsideDir, outside };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

function mutation(repo: Fixture) {
  return {
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    envName: null,
    scope: "global",
    key: "SETTING",
  };
}

for (const kind of ["direct", "relative", "two-hop", "root-alias"] as const) {
  test(`in-project ${kind} link preserves the link and writes the target`, async () => {
    const repo = await fixture();
    const target = resolve(repo.projectRoot, "target.yaml");
    await writeFile(target, ORIGINAL);
    const layer = resolve(repo.projectDir, "hack.env.default.yaml");
    if (kind === "two-hop") {
      await symlink("../target.yaml", resolve(repo.projectDir, "hop.yaml"));
      await symlink("hop.yaml", layer);
    } else {
      await symlink(kind === "relative" ? "../target.yaml" : target, layer);
    }
    if (kind === "root-alias") {
      const alias = resolve(repo.root, "alias");
      await symlink(repo.projectRoot, alias);
      repo.projectRoot = alias;
      repo.projectDir = resolve(alias, ".hack");
    }
    const result = await setProjectEnvValue({
      ...mutation(repo),
      value: "synthetic-updated",
      secret: false,
    });
    expect(result.changed).toBe(true);
    expect((await lstat(layer)).isSymbolicLink()).toBe(true);
    expect(await readFile(target, "utf8")).toContain("synthetic-updated");
    const resolved = await resolveProjectEnvConfig({
      ...repo,
      envName: null,
      serviceNames: ["api"],
    });
    expect(resolved?.globalEnv.SETTING).toBe("synthetic-updated");
  });
}

type Escape =
  | "absolute"
  | "relative"
  | "chain"
  | "prefix"
  | "dangling"
  | "loop";
async function plant(repo: Fixture, layer: string, kind: Escape) {
  if (kind === "loop") {
    const hop = resolve(repo.projectDir, "hop.yaml");
    await symlink(layer, hop);
    await symlink(hop, layer);
  } else if (kind === "chain") {
    const hop = resolve(repo.projectRoot, `${basename(layer)}.hop`);
    await symlink(repo.outside, hop);
    await symlink(`../${basename(hop)}`, layer);
  } else {
    const targets = {
      absolute: repo.outside,
      relative: "../../proj-x/target.yaml",
      prefix: repo.outside,
      dangling: resolve(repo.outsideDir, "missing.yaml"),
    };
    await symlink(targets[kind], layer);
  }
}

async function assertOutsideUntouched(repo: Fixture) {
  expect(await readFile(repo.outside, "utf8")).toBe(ORIGINAL);
  expect(await readdir(repo.outsideDir)).toEqual(["target.yaml"]);
}

for (const kind of [
  "absolute",
  "relative",
  "chain",
  "prefix",
  "dangling",
  "loop",
] as const) {
  for (const local of [false, true]) {
    test(`${kind} ${local ? "local overlay" : "base"} link refuses reads, set, unset and hydrate without outside effects`, async () => {
      const repo = await fixture();
      const layer = resolve(
        repo.projectDir,
        local ? "hack.env.dev.local.yaml" : "hack.env.default.yaml"
      );
      await plant(repo, layer, kind);
      const options = {
        ...mutation(repo),
        envName: local ? "dev" : null,
        local,
      };
      const operations = [
        () => resolveProjectEnvConfig({ ...options, serviceNames: ["api"] }),
        () =>
          setProjectEnvValue({
            ...options,
            value: "synthetic-update",
            secret: false,
          }),
        () => unsetProjectEnvValue(options),
        () =>
          hydrateProjectEnvLocalLayer({
            ...options,
            entries: new Map([["SETTING", "synthetic-update"]]),
            secret: false,
          }),
      ];
      // Hydrate reads/writes only local layers; plant that destination for base cases too.
      for (const [index, operation] of operations.entries()) {
        if (index === 3 && !local) {
          await plant(
            repo,
            resolve(repo.projectDir, "hack.env.local.yaml"),
            kind === "loop" ? "absolute" : kind
          );
        }
        try {
          await operation();
          throw new Error("Expected boundary refusal");
        } catch (error: unknown) {
          expect(error).toBeInstanceOf(ClosedCliError);
          expect(error instanceof Error ? error.message : "").toBe(
            "Refused env layer: its path must resolve inside the project and be inspectable (values omitted)."
          );
          expect(String(error)).not.toContain(VALUE);
          expect(String(error)).not.toContain(repo.outside);
        }
        await assertOutsideUntouched(repo);
      }
    });
  }
}

async function cli(repo: Fixture, args: string[], holdStdin = false) {
  const proc = Bun.spawn(
    [process.execPath, ENTRYPOINT, "env", ...args, "--path", repo.projectRoot],
    {
      cwd: repo.projectRoot,
      env: privateCliEnv({
        root: repo.root,
        env: {
          HACK_GLOBAL_CONFIG_PATH: resolve(repo.root, "config.json"),
          HACK_LOGGER: "console",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
        },
      }),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    }
  );
  if (!holdStdin) {
    proc.stdin.write(`SETTING=${VALUE}\n`);
    await proc.stdin.end();
  }
  const [code, out, err] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (holdStdin) {
    await proc.stdin.end();
  }
  expect(code).toBe(1);
  expect(`${out}${err}`).toContain("Refused env layer");
  expect(`${out}${err}`).not.toContain(VALUE);
  expect(`${out}${err}`).not.toContain(repo.outside);
  await assertOutsideUntouched(repo);
}

for (const layer of [
  "hack.env.default.yaml",
  "hack.env.dev.yaml",
  "hack.env.dev.local.yaml",
]) {
  test(`CLI set/add/unset/hydrate guard ${layer}; value commands refuse with stdin still open`, async () => {
    const repo = await fixture();
    await plant(repo, resolve(repo.projectDir, layer), "absolute");
    await cli(repo, ["set", "SETTING", "--value-stdin", "--env", "dev"], true);
    await cli(repo, ["add", "SETTING", "--value-stdin", "--env", "dev"], true);
    await cli(repo, ["unset", "SETTING", "--env", "dev"]);
    await cli(repo, ["hydrate", "--env", "dev"], true);
  }, 50_000);
}

test("relative link targets resolve .. after intermediate symlinks", async () => {
  const repo = await fixture();
  await mkdir(resolve(repo.outsideDir, "sub"));
  await symlink(
    resolve(repo.outsideDir, "sub"),
    resolve(repo.projectDir, "dir-link")
  );
  const layer = resolve(repo.projectDir, "hack.env.default.yaml");
  await symlink("dir-link/../target.yaml", layer);
  await expect(
    assertProjectEnvLayerPath({ ...repo, path: layer })
  ).rejects.toThrow("Refused env layer");
});

for (const phase of ["resolve", "stage"] as const) {
  test(`a link swapped at ${phase} time is refused before any outside write`, async () => {
    const repo = await fixture();
    const target = resolve(repo.projectRoot, "target.yaml");
    await writeFile(target, ORIGINAL);
    const layer = resolve(repo.projectDir, "hack.env.default.yaml");
    await symlink(target, layer);
    const proc = Bun.spawn(
      [
        process.execPath,
        WORKER,
        repo.projectRoot,
        repo.projectDir,
        repo.outside,
        phase,
      ],
      {
        cwd: repo.projectRoot,
        env: privateCliEnv({ root: repo.root }),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
      }
    );
    const [code, out, err] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect({ code, out, err }).toEqual({ code: 0, out: "refused\n", err: "" });
    await assertOutsideUntouched(repo);
    expect(await readFile(target, "utf8")).toBe(ORIGINAL);
    expect(
      (await readdir(repo.projectRoot)).filter((name) => name.endsWith(".tmp"))
    ).toEqual([]);
  });
}

test("hydrate and unset preserve an allowed local-layer link and update its in-project target", async () => {
  const repo = await fixture();
  const target = resolve(repo.projectRoot, "local-target.yaml");
  await writeFile(target, ORIGINAL);
  const layer = resolve(repo.projectDir, "hack.env.local.yaml");
  await symlink("../local-target.yaml", layer);
  const options = { ...mutation(repo), local: true };
  expect(
    (
      await hydrateProjectEnvLocalLayer({
        ...options,
        entries: new Map([["SETTING", "synthetic-hydrated"]]),
        secret: false,
      })
    ).changed
  ).toBe(true);
  expect((await lstat(layer)).isSymbolicLink()).toBe(true);
  expect(await readFile(target, "utf8")).toContain("synthetic-hydrated");
  expect((await unsetProjectEnvValue(options)).changed).toBe(true);
  expect((await lstat(layer)).isSymbolicLink()).toBe(true);
  expect(await readFile(target, "utf8")).not.toContain("SETTING");
  await assertOutsideUntouched(repo);
});
