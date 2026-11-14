import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLifecycleCommands } from "../src/commands/project.ts";
import { bootstrapDependencyCaches } from "../src/lib/dependency-cache-bootstrap.ts";
import { quoteShellWord } from "../src/lib/logs.ts";
import { resolveSecretStore } from "../src/lib/secret-store.ts";
import { restoreEnv } from "./helpers/env.ts";

test("the actual hook runner refuses unattended code while manual execution remains available", async () => {
  const root = await mkdtemp(join(tmpdir(), "hack-host-boundary-"));
  const previous = process.env.HACK_AUTOSTART_LOGIN;
  try {
    const projectDir = join(root, ".hack");
    await mkdir(projectDir, { mode: 0o700 });
    const receipt = join(root, "hook-ran");
    const options = {
      title: "fixture startup",
      commands: [{ command: `printf manual > ${quoteShellWord(receipt)}` }],
      projectRoot: root,
      projectDir,
      composeProject: "fixture",
      env: { PATH: "/usr/bin:/bin" },
      routeStdoutToStderr: true,
    };
    process.env.HACK_AUTOSTART_LOGIN = "1";
    await expect(runLifecycleCommands(options)).rejects.toMatchObject({
      code: "E_PERMISSION",
      detail: { reason: "host_commands_require_manual_start" },
    });
    expect(await Bun.file(receipt).exists()).toBe(false);
    await expect(
      bootstrapDependencyCaches({
        composeFiles: [join(projectDir, "docker-compose.yml")],
        cwd: root,
        services: ["installer"],
        env: { PATH: "/nonexistent" },
      })
    ).rejects.toMatchObject({
      detail: { reason: "host_commands_require_manual_start" },
    });
    process.env.HACK_AUTOSTART_LOGIN = "0";
    expect(await runLifecycleCommands(options)).toBe(0);
    expect(await Bun.file(receipt).text()).toBe("manual");
  } finally {
    restoreEnv("HACK_AUTOSTART_LOGIN", previous);
    await rm(root, { recursive: true, force: true });
  }
});

test("the runtime secret-store boundary refuses external providers before adapter setup", async () => {
  const root = await mkdtemp(join(tmpdir(), "hack-provider-boundary-"));
  const previous = process.env.HACK_AUTOSTART_LOGIN;
  const previousHome = process.env.HOME;
  try {
    process.env.HOME = root;
    process.env.HACK_AUTOSTART_LOGIN = "1";
    const projectDir = join(root, "project", ".hack");
    await mkdir(projectDir, { recursive: true, mode: 0o700 });
    await writeFile(
      join(projectDir, "hack.config.json"),
      JSON.stringify({
        controlPlane: {
          secrets: { backend: "cloud", cloud: { provider: "aws" } },
        },
      })
    );
    await expect(
      resolveSecretStore({ projectName: "fixture", projectDir })
    ).rejects.toMatchObject({
      code: "E_PERMISSION",
      detail: { reason: "command_provider_requires_manual_start" },
    });
    expect(
      await Bun.file(join(root, ".hack", "secrets-file.key")).exists()
    ).toBe(false);
  } finally {
    restoreEnv("HOME", previousHome);
    restoreEnv("HACK_AUTOSTART_LOGIN", previous);
    await rm(root, { recursive: true, force: true });
  }
});
