import { mock } from "bun:test";
import * as fs from "node:fs/promises";
import { join } from "node:path";

const [root, operation, argument = "", gate] = process.argv.slice(2);
if (!(root && operation)) {
  throw new Error("Missing registry fixture arguments");
}
if (gate) {
  await fs.writeFile(`${gate}.${argument}.ready`, "");
  while (!(await Bun.file(gate).exists())) {
    await Bun.sleep(10);
  }
}
const registry = join(root, "projects.json");
const lockPath = `${registry}.lock`;
process.env.HOME = root;
process.env.HACK_GLOBAL_CONFIG_PATH = join(root, "hack.config.json");

// Pause the real writer at its final rename syscall. Everything preceding this
// boundary (private file creation, content write and fsync) runs unmocked in a
// disposable child; SIGKILL then tests an actual pre-commit process interruption.
if (operation === "interrupt-write") {
  const rename = fs.rename;
  mock.module("node:fs/promises", () => ({
    ...fs,
    rename: async (from: string, to: string) => {
      process.stdout.write("prepared\n");
      await Bun.stdin.text();
      return await rename(from, to);
    },
  }));
}
if (operation === "delayed-reaper") {
  const mkdir = fs.mkdir;
  let paused = false;
  mock.module("node:fs/promises", () => ({
    ...fs,
    mkdir: async (path: string, options: { mode?: number }) => {
      if (path.endsWith(".recovery") && !paused) {
        paused = true;
        process.stdout.write("observed\n");
        await Bun.stdin.text();
      }
      return await mkdir(path, options);
    },
  }));
}

const { withProjectsRegistryLock, writeProjectsRegistryAtomic } = await import(
  "../../src/lib/projects-registry-lock.ts"
);
if (operation === "delayed-reaper") {
  try {
    await withProjectsRegistryLock({
      lockPath,
      timeoutMs: 1000,
      run: async () => {
        throw new Error("Reclaimer deleted a live successor");
      },
    });
  } catch (error) {
    if (
      !(error instanceof Error && error.message.startsWith("Timed out waiting"))
    ) {
      throw error;
    }
    process.stdout.write("refused\n");
  }
} else if (operation === "hold" || operation === "interrupt-write") {
  await withProjectsRegistryLock({
    lockPath,
    run: async () => {
      if (operation === "interrupt-write") {
        await writeProjectsRegistryAtomic({
          path: registry,
          text: "replacement\n",
        });
      } else {
        process.stdout.write("held\n");
        await Bun.stdin.text();
      }
    },
  });
} else {
  const {
    readProjectsRegistry,
    removeProjectsById,
    upsertProjectRegistration,
  } = await import("../../src/lib/projects-registry.ts");
  if (operation === "read") {
    process.stdout.write(JSON.stringify(await readProjectsRegistry()));
  } else if (operation === "remove") {
    process.stdout.write(
      JSON.stringify(await removeProjectsById({ ids: [argument] }))
    );
  } else {
    const projectRoot = join(root, `repo-${argument}`);
    const projectDir = join(projectRoot, ".hack");
    await fs.mkdir(projectDir, { recursive: true });
    const configFile = join(projectDir, "hack.config.json");
    await fs.writeFile(
      configFile,
      JSON.stringify({ name: `${operation}-${argument}` })
    );
    const composeFile = join(projectDir, "docker-compose.yml");
    await fs.writeFile(composeFile, "services: {}\n");
    const result = await upsertProjectRegistration({
      project: {
        projectRoot,
        projectDir,
        projectDirName: ".hack",
        configFile,
        composeFile,
        envFile: join(projectDir, ".env"),
      },
    });
    process.stdout.write(JSON.stringify(result));
  }
}
