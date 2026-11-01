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
import { join, relative, resolve } from "node:path";
import { LEGACY_ENV_LOCAL_CONTRACT_MESSAGE } from "../src/cli/env-arguments.ts";
import { migrateLegacyProjectEnv } from "../src/lib/project-env-config.ts";
import { fixtureChildren } from "./helpers/fixture-children.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

/*
 * HACK-1710: in a project with a `hack.env.json` contract and no env layers,
 * `hack env set --local` wrote `.hack/.env`, and the contract migration then
 * copied the value to tracked `hack.env.default.yaml`.
 */

const ENTRYPOINT = resolve(import.meta.dir, "..", "index.ts");
const VALUE = ["synthetic", "local", "1710"].join("-");
const CONTRACT = `${JSON.stringify({
  version: 1,
  vars: [{ key: "LOCAL_KEY", source: "plain_env", required: false }],
})}\n`;

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function createProject(opts: {
  readonly contract: boolean;
  readonly mirrored?: boolean;
}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hack-1710-")));
  roots.push(root);
  const projectRoot = resolve(root, "repo");
  const projectDir = resolve(projectRoot, ".hack");
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    resolve(projectDir, "docker-compose.yml"),
    "services:\n  api:\n    image: alpine:3.20\n    env_file:\n      - path: .env\n        required: false\n"
  );
  await writeFile(
    resolve(projectDir, "hack.config.json"),
    `${JSON.stringify({
      name: "hack-1710",
      dev_host: "hack-1710.hack",
      ...(opts.mirrored
        ? {
            controlPlane: {
              secrets: {
                backend: "encrypted_file",
                storePlaintextInBackend: true,
                encryptedFile: {
                  path: resolve(projectRoot, "secrets.enc.json"),
                  keyPath: resolve(projectRoot, "secrets-file.key"),
                },
              },
            },
          }
        : {}),
    })}\n`
  );
  if (opts.contract) {
    await writeFile(resolve(projectDir, "hack.env.json"), CONTRACT);
  }
  return { root, projectRoot, projectDir };
}

type Project = Awaited<ReturnType<typeof createProject>>;

async function setLocal(project: Project) {
  const children = fixtureChildren("env-set-local-contract");
  const proc = Bun.spawn(
    [
      process.execPath,
      ENTRYPOINT,
      "env",
      "set",
      "LOCAL_KEY",
      "--local",
      "--value-stdin",
      "--path",
      project.projectRoot,
    ],
    {
      cwd: project.projectRoot,
      env: privateCliEnv({
        root: project.root,
        env: {
          HACK_GLOBAL_CONFIG_PATH: join(project.root, "hack-config.json"),
          HACK_HOME: join(project.root, "hack-home"),
          HACK_LOGGER: "console",
          HACK_NO_INTERACTIVE: "1",
          HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK: "1",
          NO_COLOR: "1",
        },
      }),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  proc.stdin.write(`${VALUE}\n`);
  await proc.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  await children.stopAll();
  return { exitCode, output: `${stdout}\n${stderr}` };
}

async function tree(project: Project): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(project.projectRoot, {
    withFileTypes: true,
    recursive: true,
  })) {
    if (entry.isFile()) {
      const path = join(entry.parentPath, entry.name);
      out[relative(project.projectRoot, path)] = await readFile(path, "utf8");
    }
  }
  return out;
}

function migrate(project: Project) {
  return migrateLegacyProjectEnv({
    projectRoot: project.projectRoot,
    projectDir: project.projectDir,
    projectName: "hack-1710",
    serviceNames: ["api"],
    materialize: false,
  });
}

test("with a contract and no layers, set --local refuses and writes nothing", async () => {
  const project = await createProject({ contract: true });
  const before = await tree(project);

  const run = await setLocal(project);

  expect(run.exitCode).not.toBe(0);
  expect(run.output).toContain(LEGACY_ENV_LOCAL_CONTRACT_MESSAGE);
  expect(run.output).not.toContain(VALUE);
  expect(await tree(project)).toEqual(before);
});

test("with a mirrored backend, the refusal writes neither .env nor the store", async () => {
  const project = await createProject({ contract: true, mirrored: true });
  const before = await tree(project);

  const run = await setLocal(project);

  expect(run.exitCode).not.toBe(0);
  expect(run.output).toContain(LEGACY_ENV_LOCAL_CONTRACT_MESSAGE);
  expect(await tree(project)).toEqual(before);
});

test("the remedy works: after the migration, set --local stays out of tracked layers", async () => {
  const project = await createProject({ contract: true });
  await migrate(project);

  const run = await setLocal(project);

  expect(run.exitCode).toBe(0);
  const files = await tree(project);
  expect(files[".hack/hack.env.local.yaml"]).toContain(VALUE);
  expect(files[".hack/hack.env.default.yaml"]).not.toContain(VALUE);
  expect(files[".hack/.env"]).toBeUndefined();
});

test("without a contract, set --local still writes .env", async () => {
  const project = await createProject({ contract: false });

  const run = await setLocal(project);

  expect(run.exitCode).toBe(0);
  expect((await tree(project))[".hack/.env"]).toContain(VALUE);
});
