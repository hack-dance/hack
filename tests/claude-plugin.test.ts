import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installClaudeHooks } from "../src/agents/claude.ts";
import {
  checkDeprecatedHackClaudeIntegration,
  checkHackClaudePlugin,
  prepareHackClaudePlugin,
  removeDeprecatedHackClaudeIntegration,
} from "../src/agents/claude-plugin.ts";
import { installMcpConfig } from "../src/mcp/install.ts";

let tempDir: string | null = null;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

test("checkHackClaudePlugin detects enabled, disabled, and missing states", async () => {
  const enabled = await checkHackClaudePlugin({
    scope: "user",
    runClaudeCommand: async () => ({
      exitCode: 0,
      stdout: JSON.stringify([
        { id: "hack@hack-dance", enabled: true, scope: "user" },
      ]),
      stderr: "",
    }),
  });
  expect(enabled.status).toBe("noop");

  const disabled = await checkHackClaudePlugin({
    scope: "user",
    runClaudeCommand: async () => ({
      exitCode: 0,
      stdout: JSON.stringify([{ id: "hack@hack-dance", enabled: false }]),
      stderr: "",
    }),
  });
  expect(disabled.status).toBe("stale");

  const missing = await checkHackClaudePlugin({
    scope: "user",
    runClaudeCommand: async () => ({
      exitCode: 0,
      stdout: "[]",
      stderr: "",
    }),
  });
  expect(missing.status).toBe("missing");
  expect(missing.message).toContain(
    "claude plugin marketplace add hack-dance/hack"
  );
});

test("Claude plugin migration removes generated hooks, skill, and MCP", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hack-claude-plugin-"));
  await installClaudeHooks({ scope: "project", projectRoot: tempDir });
  await installMcpConfig({
    targets: ["claude"],
    scope: "project",
    projectRoot: tempDir,
  });

  const result = await removeDeprecatedHackClaudeIntegration({
    scope: "project",
    projectRoot: tempDir,
  });
  expect(result.status).toBe("removed");
  expect(
    await Bun.file(
      join(tempDir, ".claude", "skills", "hack-init", "SKILL.md")
    ).exists()
  ).toBe(false);

  const localSettings = await Bun.file(
    join(tempDir, ".claude", "settings.local.json")
  ).json();
  expect(localSettings.hooks.SessionStart).toEqual([]);
  expect(
    await Bun.file(join(tempDir, ".claude", "settings.json")).exists()
  ).toBe(false);
});

test("Claude plugin migration detects and removes a partial legacy hook install", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hack-claude-plugin-"));
  const settingsPath = join(tempDir, ".claude", "settings.local.json");
  await mkdir(join(tempDir, ".claude"), { recursive: true });
  await Bun.write(
    settingsPath,
    JSON.stringify({
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: "hack agent prime" }] },
        ],
      },
    })
  );

  const deprecated = await checkDeprecatedHackClaudeIntegration({
    scope: "project",
    projectRoot: tempDir,
  });
  expect(deprecated.status).toBe("deprecated");

  const removed = await removeDeprecatedHackClaudeIntegration({
    scope: "project",
    projectRoot: tempDir,
  });
  expect(removed.status).toBe("removed");
  const settings = await Bun.file(settingsPath).json();
  expect(settings.hooks.SessionStart).toEqual([]);
});

test("Claude preparation preserves missing plugin readiness after cleanup", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hack-claude-plugin-"));
  await installClaudeHooks({ scope: "project", projectRoot: tempDir });

  const result = await prepareHackClaudePlugin({
    scope: "project",
    projectRoot: tempDir,
    runClaudeCommand: async () => ({ exitCode: 0, stdout: "[]", stderr: "" }),
  });
  expect(result.status).toBe("missing");
  expect(result.cleanupStatus).toBe("removed");
  expect(result.message).toContain("Removed deprecated standalone");
  expect(result.message).toContain("not installed");
});

test("Claude plugin manifests match the CLI package version", async () => {
  const repoRoot = join(import.meta.dir, "..");
  const packageJson = await Bun.file(join(repoRoot, "package.json")).json();
  const manifest = await Bun.file(
    join(repoRoot, "plugins", "hack", ".claude-plugin", "plugin.json")
  ).json();
  expect(manifest.version).toBe(packageJson.version);
});
