import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installCursorRules } from "../src/agents/cursor.ts";
import {
  checkHackCursorPlugin,
  prepareHackCursorPlugin,
  removeDeprecatedHackCursorIntegration,
} from "../src/agents/cursor-plugin.ts";
import { installMcpConfig } from "../src/mcp/install.ts";

let tempDir: string | null = null;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

test("checkHackCursorPlugin detects enabled, disabled, and missing states", async () => {
  const enabled = await checkHackCursorPlugin({
    scope: "user",
    runCursorCommand: async () => ({
      exitCode: 0,
      stdout: JSON.stringify([{ id: "hack@hack-dance", enabled: true }]),
      stderr: "",
    }),
  });
  expect(enabled.status).toBe("noop");

  const disabled = await checkHackCursorPlugin({
    scope: "user",
    runCursorCommand: async () => ({
      exitCode: 0,
      stdout: JSON.stringify([{ id: "hack@hack-dance", enabled: false }]),
      stderr: "",
    }),
  });
  expect(disabled.status).toBe("stale");

  const missing = await checkHackCursorPlugin({
    scope: "user",
    runCursorCommand: async () => ({ exitCode: 0, stdout: "[]", stderr: "" }),
  });
  expect(missing.status).toBe("missing");
  expect(missing.message).toContain(
    "cursor-agent plugin marketplace add hack-dance/hack"
  );
});

test("Cursor plugin migration removes generated rules and MCP", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hack-cursor-plugin-"));
  await installCursorRules({ scope: "project", projectRoot: tempDir });
  await installMcpConfig({
    targets: ["cursor"],
    scope: "project",
    projectRoot: tempDir,
  });

  const result = await removeDeprecatedHackCursorIntegration({
    scope: "project",
    projectRoot: tempDir,
  });
  expect(result.status).toBe("removed");
  expect(
    await Bun.file(join(tempDir, ".cursor", "rules", "hack.mdc")).exists()
  ).toBe(false);
  expect(await Bun.file(join(tempDir, ".cursor", "mcp.json")).exists()).toBe(
    false
  );
});

test("Cursor preparation preserves legacy rules when the plugin is missing", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hack-cursor-plugin-"));
  await installCursorRules({ scope: "project", projectRoot: tempDir });

  const result = await prepareHackCursorPlugin({
    scope: "project",
    projectRoot: tempDir,
    runCursorCommand: async () => ({ exitCode: 0, stdout: "[]", stderr: "" }),
  });
  expect(result.status).toBe("missing");
  expect(result.cleanupStatus).toBeUndefined();
  expect(
    await Bun.file(join(tempDir, ".cursor", "rules", "hack.mdc")).exists()
  ).toBe(true);
});

test("Cursor plugin manifests match the CLI package version", async () => {
  const repoRoot = join(import.meta.dir, "..");
  const packageJson = await Bun.file(join(repoRoot, "package.json")).json();
  const manifest = await Bun.file(
    join(repoRoot, "plugins", "hack", ".cursor-plugin", "plugin.json")
  ).json();
  expect(manifest.version).toBe(packageJson.version);
  const rule = await Bun.file(
    join(repoRoot, "plugins", "hack", "rules", "hack.mdc")
  ).text();
  expect(rule).toStartWith("---\ndescription:");
  expect(rule).toContain("alwaysApply: true");
});
