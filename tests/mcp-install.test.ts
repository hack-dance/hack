import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  checkDeprecatedCodexMcpConfig,
  checkDeprecatedPluginMcpConfig,
  installMcpConfig,
  removeDeprecatedCodexMcpConfig,
  removeDeprecatedPluginMcpConfig,
} from "../src/mcp/install.ts";

let tempDir: string | null = null;
const originalHome = process.env.HOME;

afterEach(async () => {
  process.env.HOME = originalHome;
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

test("installMcpConfig writes cursor + claude configs", async () => {
  const homeDir = await setupTempHome();

  const results = await installMcpConfig({
    targets: ["cursor", "claude"],
    scope: "user",
  });

  expect(results.map((r) => r.status)).toEqual(["updated", "updated"]);

  const cursorPath = join(homeDir, ".cursor", "mcp.json");
  const cursor = JSON.parse(await Bun.file(cursorPath).text()) as Record<
    string,
    unknown
  >;
  const cursorServers = cursor.mcpServers as Record<string, unknown>;
  const cursorHack = cursorServers.hack as Record<string, unknown>;
  expect(cursorHack.command).toBe("hack");
  expect(cursorHack.args).toEqual(["mcp", "serve"]);

  const claudePath = join(homeDir, ".claude", "settings.json");
  const claude = JSON.parse(await Bun.file(claudePath).text()) as Record<
    string,
    unknown
  >;
  const claudeServers = claude.mcpServers as Record<string, unknown>;
  const claudeHack = claudeServers.hack as Record<string, unknown>;
  expect(claudeHack.command).toBe("hack");
  expect(claudeHack.type).toBe("stdio");
});

test("installMcpConfig is idempotent for codex", async () => {
  const homeDir = await setupTempHome();

  const first = await installMcpConfig({
    targets: ["codex"],
    scope: "user",
  });
  const second = await installMcpConfig({
    targets: ["codex"],
    scope: "user",
  });

  expect(first[0]?.status).toBe("updated");
  expect(second[0]?.status).toBe("noop");

  const codexPath = join(homeDir, ".codex", "config.toml");
  const codexText = await Bun.file(codexPath).text();
  expect(codexText).toContain("[mcp_servers.hack]");
  expect(codexText).toContain('command = "hack"');
  expect(codexText).toContain('args = ["mcp", "serve"]');
});

test("deprecated Codex MCP cleanup removes generated config", async () => {
  await setupTempHome();
  await installMcpConfig({ targets: ["codex"], scope: "user" });

  const check = await checkDeprecatedCodexMcpConfig({ scope: "user" });
  expect(check.status).toBe("deprecated");

  const removed = await removeDeprecatedCodexMcpConfig({ scope: "user" });
  expect(removed.status).toBe("removed");
  const absent = await checkDeprecatedCodexMcpConfig({ scope: "user" });
  expect(absent.status).toBe("absent");
});

test("deprecated Codex MCP cleanup preserves customized config", async () => {
  const homeDir = await setupTempHome();
  const codexPath = join(homeDir, ".codex", "config.toml");
  await Bun.write(
    codexPath,
    '[mcp_servers.hack]\ncommand = "custom-hack"\nargs = ["mcp", "serve"]\n'
  );

  const result = await removeDeprecatedCodexMcpConfig({ scope: "user" });
  expect(result.status).toBe("preserved");
  expect(await Bun.file(codexPath).text()).toContain('command = "custom-hack"');
});

test("plugin MCP cleanup removes generated entries and preserves customized entries", async () => {
  const homeDir = await setupTempHome();
  await installMcpConfig({ targets: ["cursor", "claude"], scope: "user" });

  const deprecated = await checkDeprecatedPluginMcpConfig({
    target: "cursor",
    scope: "user",
  });
  expect(deprecated.status).toBe("deprecated");
  const cursorResult = await removeDeprecatedPluginMcpConfig({
    target: "cursor",
    scope: "user",
  });
  expect(cursorResult.status).toBe("removed");
  expect(await Bun.file(join(homeDir, ".cursor", "mcp.json")).exists()).toBe(
    false
  );

  const claudePath = join(homeDir, ".claude", "settings.json");
  const claude = await Bun.file(claudePath).json();
  claude.mcpServers.hack.command = "custom-hack";
  await Bun.write(claudePath, `${JSON.stringify(claude, null, 2)}\n`);
  const claudeResult = await removeDeprecatedPluginMcpConfig({
    target: "claude",
    scope: "user",
  });
  expect(claudeResult.status).toBe("preserved");
  expect(await Bun.file(claudePath).text()).toContain("custom-hack");
});

async function setupTempHome(): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), "hack-mcp-install-"));
  const homeDir = join(tempDir, "home");
  await mkdir(homeDir, { recursive: true });
  process.env.HOME = homeDir;
  return homeDir;
}
