import { afterEach, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  LegacyDotenvMigrationRefusalError,
  migrateLegacyProjectEnv,
} from "../src/lib/project-env-config.ts";

const SHELL_KEY = "HACK_1688_SYNTHETIC_TOKEN";
const SHELL_VALUE = ["synthetic", "shell", "1688"].join("-");
const DOTENV_VALUE = ["synthetic", "dotenv", "1688"].join("-");
const tempDirs = new Set<string>();

afterEach(async () => {
  delete process.env[SHELL_KEY];
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

type Repo = { readonly projectRoot: string; readonly projectDir: string };

async function createContractRepo(opts: {
  readonly services?: readonly string[];
  readonly files?: Readonly<Record<string, string>>;
}): Promise<Repo> {
  const root = await mkdtemp(join(tmpdir(), "hack-env-contract-shell-"));
  tempDirs.add(root);
  const projectRoot = resolve(root, "repo");
  const projectDir = resolve(projectRoot, ".hack");
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    resolve(projectDir, "docker-compose.yml"),
    "services:\n  api:\n    image: alpine:3.20\n"
  );
  await writeFile(
    resolve(projectDir, "hack.config.json"),
    `${JSON.stringify({ name: "contract-shell", dev_host: "contract-shell.hack" })}\n`
  );
  await writeFile(
    resolve(projectDir, "hack.env.json"),
    `${JSON.stringify({
      version: 1,
      vars: [
        {
          key: SHELL_KEY,
          source: "plain_env",
          required: false,
          ...(opts.services ? { services: opts.services } : {}),
        },
      ],
    })}\n`
  );
  for (const [name, text] of Object.entries(opts.files ?? {})) {
    await writeFile(resolve(projectDir, name), text);
  }
  return { projectRoot, projectDir };
}

function migrate(repo: Repo) {
  return migrateLegacyProjectEnv({
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    projectName: "contract-shell",
    serviceNames: ["api"],
    materialize: false,
  });
}

async function layerTexts(repo: Repo): Promise<string> {
  const names = (await readdir(repo.projectDir)).filter(
    (name) => name.startsWith("hack.env.") && name.endsWith(".yaml")
  );
  const texts = await Promise.all(
    names.map((name) => readFile(resolve(repo.projectDir, name), "utf8"))
  );
  return texts.join("\n");
}

async function expectShellValueRefused(repo: Repo): Promise<void> {
  const before = (await readdir(repo.projectDir)).sort();
  const error = await migrate(repo).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(LegacyDotenvMigrationRefusalError);
  const { message } = error as Error;
  expect(message).toContain(SHELL_KEY);
  expect(message).not.toContain(SHELL_VALUE);
  expect((await readdir(repo.projectDir)).sort()).toEqual(before);
  expect(await layerTexts(repo)).not.toContain(SHELL_VALUE);
}

test("a shell-only plain_env value never reaches a layer, and the migration refuses", async () => {
  process.env[SHELL_KEY] = SHELL_VALUE;
  await expectShellValueRefused(await createContractRepo({}));
});

test("a service-scoped shell-only plain_env value is refused the same way", async () => {
  process.env[SHELL_KEY] = SHELL_VALUE;
  await expectShellValueRefused(
    await createContractRepo({ services: ["api"] })
  );
});

test("a shell-only value is refused when an overlay would also be migrated", async () => {
  process.env[SHELL_KEY] = SHELL_VALUE;
  await expectShellValueRefused(
    await createContractRepo({ files: { ".env.staging": "OTHER=1\n" } })
  );
});

test("a dotenv value still migrates as documented, and a same-named shell value stays out", async () => {
  process.env[SHELL_KEY] = SHELL_VALUE;
  const repo = await createContractRepo({
    files: { ".env": `${SHELL_KEY}=${DOTENV_VALUE}\n` },
  });
  const migrated = await migrate(repo);
  expect(migrated.legacyDetected).toBe(true);
  const layers = await layerTexts(repo);
  expect(layers).toContain(DOTENV_VALUE);
  expect(layers).not.toContain(SHELL_VALUE);
});

test("with the key unset in the shell, the migration proceeds and writes no value for it", async () => {
  const repo = await createContractRepo({});
  const migrated = await migrate(repo);
  expect(migrated.legacyDetected).toBe(true);
  expect(await layerTexts(repo)).not.toContain(SHELL_KEY);
  expect(
    await lstat(resolve(repo.projectDir, "hack.env.default.yaml")).catch(
      () => null
    )
  ).not.toBeNull();
});
