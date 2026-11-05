import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  PROJECT_COMPOSE_FILENAME,
  PROJECT_CONFIG_FILENAME,
  PROJECT_ENV_FILENAME,
} from "../src/constants.ts";
import { errorResultFromUnknown } from "../src/lib/cli-result.ts";
import {
  ProjectsRegistryReadError,
  projectsRegistryReadDiagnostic,
  readProjectsRegistry,
  touchProjectRegistration,
  upsertProjectRegistration,
} from "../src/lib/projects-registry.ts";
import { restoreEnv } from "./helpers/env.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

/**
 * HACK-1905: only a missing registry is empty. A registry that exists but
 * cannot be read refuses with a closed, coded, value-free error, and writers
 * leave it in place instead of replacing it.
 */

const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
const entrypoint = resolve("index.ts");
const SPAWN_TIMEOUT_MS = 60_000;
const REGISTRY = `${JSON.stringify(
  {
    version: 1,
    projects: [
      {
        id: "a".repeat(16),
        name: "kept",
        repoRoot: "/nonexistent/kept",
        projectDirName: ".hack",
        projectDir: "/nonexistent/kept/.hack",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  },
  null,
  2
)}\n`;

let root: string | null = null;
let originalHome: string | undefined;

beforeEach(async () => {
  originalHome = process.env.HOME;
  root = await realpath(await mkdtemp(join(tmpdir(), "hack-registry-read-")));
  process.env.HOME = join(root, "user-home");
  await mkdir(join(process.env.HOME, ".hack"), {
    recursive: true,
    mode: 0o700,
  });
});

afterEach(async () => {
  if (root) {
    // Restore access so the private fixture can be removed.
    await chmod(registryPath(), 0o600).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    root = null;
  }
  restoreEnv("HOME", originalHome);
});

function home(): string {
  if (!root) {
    throw new Error("fixture root not set");
  }
  return join(root, "user-home");
}

function registryPath(): string {
  return join(home(), ".hack", "projects.json");
}

async function writeUnreadableRegistry(): Promise<void> {
  await writeFile(registryPath(), REGISTRY, { mode: 0o600 });
  await chmod(registryPath(), 0o000);
}

async function createProject() {
  const projectRoot = join(home(), "repo");
  const projectDir = join(projectRoot, ".hack");
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    join(projectDir, PROJECT_CONFIG_FILENAME),
    JSON.stringify({ name: "fresh" })
  );
  await writeFile(join(projectDir, PROJECT_COMPOSE_FILENAME), "services: {}\n");
  await writeFile(join(projectDir, PROJECT_ENV_FILENAME), "");
  return {
    projectRoot,
    projectDirName: ".hack" as const,
    projectDir,
    composeFile: join(projectDir, PROJECT_COMPOSE_FILENAME),
    envFile: join(projectDir, PROJECT_ENV_FILENAME),
    configFile: join(projectDir, PROJECT_CONFIG_FILENAME),
  };
}

async function expectRegistryKept(): Promise<void> {
  expect((await stat(registryPath())).mode & 0o777).toBe(0o000);
  await chmod(registryPath(), 0o600);
  expect(await readFile(registryPath(), "utf8")).toBe(REGISTRY);
}

test("a missing registry reads as empty", async () => {
  expect(await readProjectsRegistry()).toEqual({ version: 1, projects: [] });
});

test("a registry that is not JSON keeps the documented best-effort empty read", async () => {
  await writeFile(registryPath(), "{ not json\n");
  expect(await readProjectsRegistry()).toEqual({ version: 1, projects: [] });
});

test.skipIf(isRoot)(
  "an unreadable registry refuses with E_PERMISSION and no path",
  async () => {
    await writeUnreadableRegistry();
    const error = await readProjectsRegistry().then(
      () => null,
      (caught: unknown) => caught
    );
    expect(error).toBeInstanceOf(ProjectsRegistryReadError);
    const envelope = errorResultFromUnknown({ error });
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe("E_PERMISSION");
    expect(envelope.error.message).toBe(
      "Cannot read the Hack projects registry (projects.json). Check its filesystem permissions before retrying; it was not changed. Values omitted."
    );
    expect(JSON.stringify(envelope)).not.toContain(home());
    expect(projectsRegistryReadDiagnostic(error)).toBe("Error:EACCES");
    await expectRegistryKept();
  }
);

test("a registry path that is not a file refuses with E_CONFIG_INVALID", async () => {
  await mkdir(registryPath());
  const error = await readProjectsRegistry().then(
    () => null,
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(ProjectsRegistryReadError);
  expect((error as ProjectsRegistryReadError).code).toBe("E_CONFIG_INVALID");
  expect((error as Error).message).not.toContain(home());
  await rm(registryPath(), { recursive: true });
});

test.skipIf(isRoot)(
  "writers refuse instead of replacing an unreadable registry",
  async () => {
    await writeUnreadableRegistry();
    const project = await createProject();
    await expect(upsertProjectRegistration({ project })).rejects.toBeInstanceOf(
      ProjectsRegistryReadError
    );
    // The best-effort touch stays non-fatal for read commands.
    expect(await touchProjectRegistration({ project })).toBeNull();
    await expectRegistryKept();
  }
);

test.skipIf(isRoot)(
  "hack projects --json refuses an unreadable registry with a coded error",
  async () => {
    if (!root) {
      throw new Error("fixture root not set");
    }
    await writeUnreadableRegistry();
    const child = Bun.spawn(
      [process.execPath, entrypoint, "projects", "--json", "--no-daemon"],
      {
        cwd: root,
        env: privateCliEnv({
          root,
          env: { HACK_NO_INTERACTIVE: "1", HACK_LOGGER: "console" },
        }),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: SPAWN_TIMEOUT_MS - 5000,
      }
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).toBe(1);
    const parsed: unknown = JSON.parse(stdout);
    expect(parsed).toEqual({
      ok: false,
      error: {
        code: "E_PERMISSION",
        message:
          "Cannot read the Hack projects registry (projects.json). Check its filesystem permissions before retrying; it was not changed. Values omitted.",
      },
    });
    expect(stdout + stderr).not.toContain(root);
    await expectRegistryKept();
  },
  SPAWN_TIMEOUT_MS
);
