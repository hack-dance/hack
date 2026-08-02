import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  checkDeprecatedCodexSkills,
  checkDeprecatedHackCodexIntegration,
  checkHackCodexPlugin,
  prepareHackCodexPlugin,
  removeDeprecatedCodexSkills,
  removeDeprecatedHackCodexIntegration,
} from "../src/agents/codex-plugin.ts";
import { renderCodexSkill } from "../src/agents/codex-skill.ts";
import { renderHackInitSkill } from "../src/agents/hack-init-skill.ts";
import { installMcpConfig } from "../src/mcp/install.ts";

let tempDir: string | null = null;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

test("checkHackCodexPlugin detects enabled, disabled, and missing states", async () => {
  const runCodexCommand = async () => ({
    exitCode: 0,
    stdout: JSON.stringify({
      installed: [
        {
          name: "hack",
          marketplaceName: "hack-dance",
          installed: true,
          enabled: true,
        },
      ],
    }),
    stderr: "",
  });
  const enabled = await checkHackCodexPlugin({
    scope: "user",
    runCodexCommand,
  });
  expect(enabled.status).toBe("noop");

  const disabled = await checkHackCodexPlugin({
    scope: "user",
    runCodexCommand: async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        installed: [
          {
            name: "hack",
            marketplaceName: "hack-dance",
            installed: true,
            enabled: false,
          },
        ],
      }),
      stderr: "",
    }),
  });
  expect(disabled.status).toBe("stale");

  const missing = await checkHackCodexPlugin({
    scope: "user",
    runCodexCommand: async () => ({
      exitCode: 0,
      stdout: JSON.stringify({ installed: [] }),
      stderr: "",
    }),
  });
  expect(missing.status).toBe("missing");
  expect(missing.message).toContain(
    "codex plugin marketplace add hack-dance/hack"
  );
});

test("legacy cleanup removes generated skills and preserves edited copies", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hack-codex-plugin-"));
  const cliPath = join(tempDir, ".codex", "skills", "hack-cli", "SKILL.md");
  const initPath = join(tempDir, ".codex", "skills", "hack-init", "SKILL.md");
  await Bun.write(cliPath, renderCodexSkill());
  await Bun.write(
    initPath,
    renderHackInitSkill().replace("hack agent onboard", "custom onboard")
  );

  const deprecated = await checkDeprecatedCodexSkills({
    scope: "project",
    projectRoot: tempDir,
  });
  expect(deprecated.status).toBe("deprecated");

  const cleanup = await removeDeprecatedCodexSkills({
    scope: "project",
    projectRoot: tempDir,
  });
  expect(cleanup.status).toBe("removed");
  expect(await Bun.file(cliPath).exists()).toBe(false);
  expect(await Bun.file(initPath).exists()).toBe(true);
  expect(cleanup.message).toContain("Preserved user-modified");
});

test("legacy integration cleanup removes generated skills and Codex MCP config", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hack-codex-plugin-"));
  const skillPath = join(tempDir, ".codex", "skills", "hack-cli", "SKILL.md");
  const configPath = join(tempDir, ".codex", "config.toml");
  await Bun.write(skillPath, renderCodexSkill());
  await installMcpConfig({
    targets: ["codex"],
    scope: "project",
    projectRoot: tempDir,
  });

  const result = await removeDeprecatedHackCodexIntegration({
    scope: "project",
    projectRoot: tempDir,
  });
  expect(result.status).toBe("removed");
  expect(await Bun.file(skillPath).exists()).toBe(false);
  expect(await Bun.file(configPath).text()).toBe("");
});

test("Codex legacy check covers skills and MCP as one integration", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hack-codex-plugin-"));
  await installMcpConfig({
    targets: ["codex"],
    scope: "project",
    projectRoot: tempDir,
  });

  const result = await checkDeprecatedHackCodexIntegration({
    scope: "project",
    projectRoot: tempDir,
  });
  expect(result.status).toBe("deprecated");
  expect(result.message).toContain("skills or MCP config");
});

test("Codex preparation preserves missing plugin readiness after cleanup", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hack-codex-plugin-"));
  const skillPath = join(tempDir, ".codex", "skills", "hack-cli", "SKILL.md");
  await Bun.write(skillPath, renderCodexSkill());

  const result = await prepareHackCodexPlugin({
    scope: "project",
    projectRoot: tempDir,
    runCodexCommand: async () => ({
      exitCode: 0,
      stdout: JSON.stringify({ installed: [] }),
      stderr: "",
    }),
  });
  expect(result.status).toBe("missing");
  expect(result.cleanupStatus).toBe("removed");
});

test("plugin manifest version matches the CLI package", async () => {
  const packageJson = await Bun.file(
    join(import.meta.dir, "..", "package.json")
  ).json();
  const manifest = await Bun.file(
    join(
      import.meta.dir,
      "..",
      "plugins",
      "hack",
      ".codex-plugin",
      "plugin.json"
    )
  ).json();
  expect(manifest.version).toBe(packageJson.version);
});
