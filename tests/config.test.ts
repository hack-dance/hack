import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readGlobalConfig,
  updateGlobalConfig,
  updateProjectConfig,
  updateProjectConfigBatch,
} from "../src/lib/config.ts";
import { restoreEnv } from "./helpers/env.ts";

describe("global config utilities", () => {
  let tempDir: string;
  let configPath: string;
  let originalConfigPath: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "hack-test-"));
    configPath = join(tempDir, "hack.config.json");
    originalConfigPath = process.env.HACK_GLOBAL_CONFIG_PATH;
    process.env.HACK_GLOBAL_CONFIG_PATH = configPath;
  });

  afterEach(async () => {
    if (originalConfigPath !== undefined) {
      restoreEnv("HACK_GLOBAL_CONFIG_PATH", originalConfigPath);
    } else {
      Reflect.deleteProperty(process.env, "HACK_GLOBAL_CONFIG_PATH");
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  test("updateGlobalConfig creates config file if missing", async () => {
    const result = await updateGlobalConfig({
      path: "controlPlane.daemon.launchd.installed",
      value: true,
    });

    expect(result.changed).toBe(true);

    const content = await Bun.file(configPath).text();
    const parsed = JSON.parse(content);

    expect(parsed.controlPlane.daemon.launchd.installed).toBe(true);
  });

  test("updateGlobalConfig updates existing config", async () => {
    await Bun.write(
      configPath,
      JSON.stringify({ controlPlane: { gateway: { enabled: true } } }, null, 2)
    );

    const result = await updateGlobalConfig({
      path: "controlPlane.daemon.launchd.runAtLoad",
      value: true,
    });

    expect(result.changed).toBe(true);

    const content = await Bun.file(configPath).text();
    const parsed = JSON.parse(content);

    expect(parsed.controlPlane.gateway.enabled).toBe(true);
    expect(parsed.controlPlane.daemon.launchd.runAtLoad).toBe(true);
  });

  test.each([
    ["malformed JSON", '{"privateFixtureValue":"do-not-echo",', "invalid JSON"],
    ["empty file", "", "invalid JSON"],
    ["whitespace", " \n\t", "invalid JSON"],
    ["array", "[1, 2]\n", "expected a JSON object"],
    ["null", "null\n", "expected a JSON object"],
    ["string", '"do-not-echo"\n', "expected a JSON object"],
    ["number", "42\n", "expected a JSON object"],
    ["boolean", "true\n", "expected a JSON object"],
  ])("all config writers preserve %s", async (_label, contents, reason) => {
    await Bun.write(configPath, contents);
    const expectedError = `Cannot update config at ${configPath}: ${reason}. Repair the file before retrying; it has not been changed.`;
    const operations = [
      () => updateGlobalConfig({ path: "enabled", value: true }),
      () =>
        updateProjectConfig({
          projectDir: tempDir,
          path: "enabled",
          value: true,
        }),
      () =>
        updateProjectConfigBatch({
          projectDir: tempDir,
          values: [
            { path: "enabled", value: true },
            { path: "sessions.mux", value: "tmux" },
          ],
        }),
    ];
    for (const update of operations) {
      await expect(update()).rejects.toThrow(expectedError);
      expect(await Bun.file(configPath).text()).toBe(contents);
    }
  });

  test.skipIf(process.getuid?.() === 0)(
    "unreadable existing config is not treated as missing",
    async () => {
      const contents = '{"existing":true}\n';
      await Bun.write(configPath, contents);
      await chmod(configPath, 0o200);
      try {
        await expect(
          updateGlobalConfig({ path: "enabled", value: true })
        ).rejects.toThrow(
          `Cannot update config at ${configPath}: unable to read the existing file.`
        );
      } finally {
        await chmod(configPath, 0o600);
      }
      expect(await Bun.file(configPath).text()).toBe(contents);
    }
  );

  test("readGlobalConfig returns undefined for missing config", async () => {
    const value = await readGlobalConfig({
      path: "controlPlane.daemon.launchd.installed",
    });

    expect(value).toBeUndefined();
  });

  test("readGlobalConfig reads nested value", async () => {
    await Bun.write(
      configPath,
      JSON.stringify(
        {
          controlPlane: {
            daemon: {
              launchd: {
                installed: true,
                runAtLoad: false,
                guiSessionOnly: true,
              },
            },
          },
        },
        null,
        2
      )
    );

    const installed = await readGlobalConfig({
      path: "controlPlane.daemon.launchd.installed",
    });
    const runAtLoad = await readGlobalConfig({
      path: "controlPlane.daemon.launchd.runAtLoad",
    });
    const guiSessionOnly = await readGlobalConfig({
      path: "controlPlane.daemon.launchd.guiSessionOnly",
    });

    expect(installed).toBe(true);
    expect(runAtLoad).toBe(false);
    expect(guiSessionOnly).toBe(true);
  });

  test("updateGlobalConfig handles bracket notation", async () => {
    const result = await updateGlobalConfig({
      path: 'controlPlane.extensions["dance.hack.supervisor"].enabled',
      value: true,
    });

    expect(result.changed).toBe(true);

    const content = await Bun.file(configPath).text();
    const parsed = JSON.parse(content);

    expect(
      parsed.controlPlane.extensions["dance.hack.supervisor"].enabled
    ).toBe(true);
  });

  test("updateGlobalConfig returns changed=false when value unchanged", async () => {
    await Bun.write(
      configPath,
      `${JSON.stringify({ test: { value: 123 } }, null, 2)}\n`
    );

    const result = await updateGlobalConfig({
      path: "test.value",
      value: 123,
    });

    expect(result.changed).toBe(false);
  });
});

describe("project config batch utilities", () => {
  let tempDir: string;
  let projectDir: string;
  let configPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "hack-project-test-"));
    projectDir = join(tempDir, ".hack");
    configPath = join(projectDir, "hack.config.json");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("single project update creates a missing config and preserves unrelated fields", async () => {
    const values = { nested: { enabled: true }, list: ["web", "db"] };
    await updateProjectConfig({ projectDir, path: "custom", value: values });
    await updateProjectConfig({ projectDir, path: "name", value: "example" });
    expect(await Bun.file(configPath).json()).toEqual({
      custom: values,
      name: "example",
    });
  });

  test("batch update preserves unrelated and sibling fields", async () => {
    await Bun.write(
      configPath,
      JSON.stringify({ custom: ["untouched"], sessions: { existing: true } })
    );
    await updateProjectConfigBatch({
      projectDir,
      values: [
        { path: "name", value: "example" },
        { path: "sessions.mux", value: "tmux" },
      ],
    });
    expect(await Bun.file(configPath).json()).toEqual({
      custom: ["untouched"],
      sessions: { existing: true, mux: "tmux" },
      name: "example",
    });
  });

  test("updateProjectConfigBatch persists multi-key routing overrides in one write", async () => {
    await updateProjectConfigBatch({
      projectDir,
      values: [
        {
          path: "controlPlane.routing.overrides.local.projectId",
          value: "proj_runtime",
        },
        {
          path: "controlPlane.routing.overrides.local.projectName",
          value: "Runtime",
        },
        {
          path: "controlPlane.routing.overrides.local.scopeId",
          value: "scope_dev",
        },
      ],
    });

    const content = await Bun.file(configPath).text();
    const parsed = JSON.parse(content);

    expect(parsed.controlPlane.routing.overrides.local).toEqual({
      projectId: "proj_runtime",
      projectName: "Runtime",
      scopeId: "scope_dev",
    });
  });
});
