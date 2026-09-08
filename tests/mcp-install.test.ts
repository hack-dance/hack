import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { installMcpConfig } from "../src/mcp/install.ts";

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

async function setupTempHome(): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), "hack-mcp-install-"));
  const homeDir = join(tempDir, "home");
  await mkdir(homeDir, { recursive: true });
  process.env.HOME = homeDir;
  return homeDir;
}
