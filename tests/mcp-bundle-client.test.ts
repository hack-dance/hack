import { expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { isRecord } from "../src/lib/guards.ts";
import { verifyMcpBundle } from "../src/mcp/bundle.ts";

const bundleDirectory = process.env.HACK_MCP_BUNDLE_TEST_DIRECTORY;
const cli = process.env.HACK_MCP_CLI_TEST_BINARY;
const claude = process.env.HACK_CLAUDE_TEST_BINARY;
const codex = process.env.HACK_CODEX_TEST_BINARY;

test.skipIf(!(bundleDirectory && cli && claude && codex))(
  "generated bundle configuration loads in clients, serves a real tool and retires",
  async () => {
    if (!(bundleDirectory && cli && claude && codex)) {
      throw new Error("Explicit qualified executables required");
    }
    const bundle = await verifyMcpBundle({ directory: bundleDirectory });
    const root = await realpath(await mkdtemp("/tmp/hack-bc-"));
    const project = join(root, "project");
    const runtime = join(root, "runtime");
    await mkdir(project);
    const env = {
      HOME: root,
      HACK_HOME: join(root, "state"),
      HACK_GLOBAL_CONFIG_PATH: join(root, "state/config.json"),
      PATH: join(root, "no-bin"),
      DOCKER_HOST: `unix://${root}/no-docker.sock`,
      DOCKER_CONFIG: join(root, "docker"),
      CODEX_HOME: join(project, ".codex"),
      DISABLE_AUTOUPDATER: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    };
    async function run(command: string[], check: (output: string) => boolean) {
      const child = Bun.spawn(command, {
        cwd: project,
        env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
      try {
        const [code, output] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect(code).toBe(0);
        // Never include response bodies on failure; isolation is being tested.
        expect(check(output)).toBe(true);
      } finally {
        clearTimeout(timer);
        if (child.exitCode === null) {
          child.kill("SIGKILL");
        }
        await child.exited;
      }
    }
    const client = new Client({ name: "bundle-activation", version: "1" });
    try {
      const flags = [
        "--all",
        "--scope",
        "project",
        "--bundle",
        bundle.directory,
        "--cli",
        cli,
        "--runtime-directory",
        runtime,
      ];
      await run(
        [
          cli,
          "mcp",
          "print",
          "--codex",
          "--scope",
          "project",
          "--bundle",
          bundle.directory,
          "--cli",
          cli,
          "--runtime-directory",
          runtime,
        ],
        (output) => output.includes(bundle.manifest.bundleId)
      );
      expect(await lstat(runtime).catch(() => null)).toBeNull();
      await run([cli, "mcp", "install", ...flags], () => true);
      await run([codex, "mcp", "get", "hack", "--json"], (output) => {
        const parsed: unknown = JSON.parse(output);
        return (
          isRecord(parsed) &&
          isRecord(parsed.transport) &&
          parsed.transport.command === bundle.executables.adapter
        );
      });
      await run(
        [claude, "mcp", "get", "hack"],
        (output) =>
          output.includes("✓ Connected") &&
          output.includes(bundle.executables.adapter)
      );
      const before = await lstat(join(runtime, "mcp.sock"));
      const document: unknown = await Bun.file(
        join(project, ".mcp.json")
      ).json();
      if (
        !(
          isRecord(document) &&
          isRecord(document.mcpServers) &&
          isRecord(document.mcpServers.hack)
        )
      ) {
        throw new Error("Missing generated config");
      }
      const entry = document.mcpServers.hack;
      if (
        typeof entry.command !== "string" ||
        !Array.isArray(entry.args) ||
        !entry.args.every((arg): arg is string => typeof arg === "string") ||
        !isRecord(entry.env) ||
        typeof entry.env.HACK_MCP_COMMAND !== "string"
      ) {
        throw new Error("Invalid generated launch");
      }
      await client.connect(
        new StdioClientTransport({
          command: entry.command,
          args: entry.args,
          cwd: project,
          env: { ...env, HACK_MCP_COMMAND: entry.env.HACK_MCP_COMMAND },
          stderr: "pipe",
        })
      );
      const result = await client.callTool({
        name: "hack.projects.list",
        arguments: {},
      });
      const structured = result.structuredContent;
      expect(
        isRecord(structured) &&
          structured.exitCode === 0 &&
          isRecord(structured.data) &&
          Array.isArray(structured.data.projects) &&
          structured.data.projects.length === 0 &&
          structured.data.runtime_ok === false
      ).toBe(true);
      expect((await lstat(join(runtime, "mcp.sock"))).ino).toBe(before.ino);
    } finally {
      await client.close();
      await waitForRetirement(runtime);
      for (const name of [".mcp-owner", ".mcp-receipt.json"]) {
        expect(await lstat(join(runtime, name)).catch(() => null)).toBeNull();
      }
      await rm(root, { recursive: true, force: true });
      await verifyMcpBundle({ directory: bundleDirectory });
    }
  },
  100_000
);

async function waitForRetirement(runtime: string) {
  const deadline = Date.now() + 70_000;
  while (await lstat(join(runtime, "mcp.sock")).catch(() => null)) {
    if (Date.now() >= deadline) {
      throw new Error(
        "Owned candidate fixture did not retire; retained for diagnosis"
      );
    }
    await Bun.sleep(250);
  }
}
