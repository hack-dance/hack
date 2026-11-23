import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectContext } from "../../src/lib/project.ts";
import type { RegisteredProject } from "../../src/lib/projects-registry.ts";
import { mkdirOwnedFixture, writeOwnedFixture } from "./owned-fixture.ts";
import { privateCliEnv } from "./private-cli-env.ts";

/** Synthetic checkout and registry; callers own cleanup of root. */
export async function projectNameFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hack-name-")));
  const state = join(root, "state");
  await mkdirOwnedFixture(state);
  const registryPath = join(state, "projects.json");
  // The source CLI runs with this env: no runner variable such as DOCKER_HOST,
  // XDG_* or HACK_* reaches it, and HOME is the fixture root.
  const env = privateCliEnv({
    root,
    home: root,
    env: {
      HACK_HOME: state,
      HACK_GLOBAL_CONFIG_PATH: join(state, "hack.config.json"),
      NO_COLOR: "1",
    },
  });
  async function createProject(directory: string, name: string) {
    const projectRoot = join(root, directory);
    const projectDir = join(projectRoot, ".hack");
    await mkdirOwnedFixture(projectDir, true);
    const project: ProjectContext = {
      projectRoot,
      projectDirName: ".hack",
      projectDir,
      composeFile: join(projectDir, "docker-compose.yml"),
      configFile: join(projectDir, "hack.config.json"),
      envFile: join(projectDir, ".env"),
    };
    await writeOwnedFixture(
      project.composeFile,
      "name: original_runtime\nservices: {}\n"
    );
    await writeOwnedFixture(
      project.configFile,
      JSON.stringify({ name, dev_host: "name-fixture.hack.local" })
    );
    await writeOwnedFixture(
      project.envFile,
      "SYNTHETIC_NAME_VALUE=fixture-only\n"
    );
    const entry: RegisteredProject = {
      id: `${directory}-identity`,
      name,
      repoRoot: projectRoot,
      projectDir,
      projectDirName: ".hack",
      devHost: "name-fixture.hack.local",
      createdAt: "2026-01-01T00:00:00Z",
    };
    return { project, entry };
  }
  async function writeRegistry(projects: readonly RegisteredProject[]) {
    await writeOwnedFixture(
      registryPath,
      `${JSON.stringify({ version: 1, projects }, null, 2)}\n`
    );
  }
  return { root, state, registryPath, env, createProject, writeRegistry };
}
