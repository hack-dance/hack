import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readGlobalConfig, updateGlobalConfig } from "../src/lib/config.ts";

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
      process.env.HACK_GLOBAL_CONFIG_PATH = originalConfigPath;
    } else {
      process.env.HACK_GLOBAL_CONFIG_PATH = undefined;
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
