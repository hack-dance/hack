import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  checkMcpConfig,
  installMcpConfig,
  removeMcpConfig,
  renderMcpConfigSnippet,
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

  const claudePath = join(homeDir, ".claude.json");
  const claude = JSON.parse(await Bun.file(claudePath).text()) as Record<
    string,
    unknown
  >;
  const claudeServers = claude.mcpServers as Record<string, unknown>;
  const claudeHack = claudeServers.hack as Record<string, unknown>;
  expect(claudeHack.command).toBe("hack");
  expect(claudeHack.type).toBe("stdio");
});

for (const scope of ["project", "user"] as const) {
  test(`Claude ${scope} config install/check/remove preserve other settings and servers`, async () => {
    const home = await setupTempHome();
    const projectRoot = join(home, "project");
    await mkdir(projectRoot);
    const root = scope === "user" ? home : projectRoot;
    const path = join(root, scope === "user" ? ".claude.json" : ".mcp.json");
    const legacy = join(root, ".claude", "settings.json");
    await mkdir(join(root, ".claude"));
    const legacyText =
      '{"hooks":{},"mcpServers":{"hack":{"command":"legacy"}}}\n';
    await Bun.write(legacy, legacyText);
    await Bun.write(
      path,
      JSON.stringify({
        syntheticPreference: "keep",
        mcpServers: { other: { command: "other-tool" } },
      })
    );
    const opts = { targets: ["claude"] as const, scope, projectRoot };
    expect((await checkMcpConfig(opts))[0]?.status).toBe("missing");
    const snippet = renderMcpConfigSnippet({
      target: "claude",
      scope,
      projectRoot,
    });
    expect(snippet.ok && snippet.path).toBe(path);
    expect((await installMcpConfig(opts))[0]?.status).toBe("updated");
    expect((await installMcpConfig(opts))[0]?.status).toBe("noop");
    expect((await checkMcpConfig(opts))[0]?.status).toBe("present");
    expect(await Bun.file(path).json()).toMatchObject({
      syntheticPreference: "keep",
      mcpServers: {
        other: { command: "other-tool" },
        hack: { type: "stdio", command: "hack" },
      },
    });
    expect((await removeMcpConfig(opts))[0]?.status).toBe("removed");
    expect((await checkMcpConfig(opts))[0]?.status).toBe("missing");
    expect((await removeMcpConfig(opts))[0]?.status).toBe("noop");
    expect(await Bun.file(path).json()).toEqual({
      syntheticPreference: "keep",
      mcpServers: { other: { command: "other-tool" } },
    });
    expect(await Bun.file(legacy).text()).toBe(legacyText);
  });
}

test("malformed Claude user state is preserved and parse errors do not echo content", async () => {
  const home = await setupTempHome();
  const path = join(home, ".claude.json");
  const text = "synthetic-private-config-invalid-json";
  await Bun.write(path, text);
  const opts = { targets: ["claude"] as const, scope: "user" as const };
  for (const result of [
    await installMcpConfig(opts),
    await checkMcpConfig(opts),
    await removeMcpConfig(opts),
  ]) {
    expect(result[0]?.status).toBe("error");
    expect(result[0]?.message).toBe("Failed to parse config JSON.");
    expect(await Bun.file(path).text()).toBe(text);
  }
});

test("invalid server-map shape is refused without dropping existing config", async () => {
  const home = await setupTempHome();
  const path = join(home, ".claude.json");
  const text = '{"mcpServers":["retain-this-value"],"preference":true}';
  await Bun.write(path, text);
  const opts = { targets: ["claude"] as const, scope: "user" as const };
  for (const result of [
    await installMcpConfig(opts),
    await checkMcpConfig(opts),
    await removeMcpConfig(opts),
  ]) {
    expect(result[0]?.status).toBe("error");
    expect(await Bun.file(path).text()).toBe(text);
  }
});

test.skipIf(process.getuid?.() === 0)(
  "an unreadable writable config is never treated as missing",
  async () => {
    const home = await setupTempHome();
    const path = join(home, ".claude.json");
    const text = '{"retain":"existing-state"}';
    await Bun.write(path, text);
    await chmod(path, 0o200);
    try {
      await expect(
        installMcpConfig({
          targets: ["claude"],
          scope: "user",
        })
      ).rejects.toThrow("Unable to read MCP configuration");
    } finally {
      await chmod(path, 0o600);
    }
    expect(await Bun.file(path).text()).toBe(text);
  }
);

for (const scope of ["project", "user"] as const) {
  test.skipIf(!process.env.HACK_CLAUDE_TEST_BINARY)(
    `installed Claude discovers Hack's ${scope} config in an isolated home`,
    async () => {
      const executable = process.env.HACK_CLAUDE_TEST_BINARY;
      if (!executable) {
        throw new Error("Explicit Claude executable required");
      }
      const home = await setupTempHome();
      const projectRoot = join(home, "project");
      await mkdir(projectRoot);
      await installMcpConfig({ targets: ["claude"], scope, projectRoot });
      const child = Bun.spawn([executable, "mcp", "get", "hack"], {
        cwd: projectRoot,
        env: {
          HOME: home,
          PATH: join(home, "unavailable-bin"),
          DISABLE_AUTOUPDATER: "1",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      try {
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect(code).toBe(0);
        expect(stderr.length).toBe(0);
        expect(
          stdout.includes(`Scope: ${scope === "user" ? "User" : "Project"}`)
        ).toBe(true);
        expect(stdout.includes("Command: hack")).toBe(true);
        expect(stdout.includes("Args: mcp serve")).toBe(true);
        // Empty PATH intentionally prevents launching an installed Hack. This
        // proves client discovery, not MCP connectivity or session authorization.
        expect(stdout.includes("Failed to connect")).toBe(true);
      } finally {
        clearTimeout(timer);
        if (child.exitCode === null) {
          child.kill("SIGKILL");
        }
        await child.exited;
      }
    },
    15_000
  );
}

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
