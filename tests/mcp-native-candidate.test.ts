import { expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { isRecord, isStringArray } from "../src/lib/guards.ts";
import { verifyMcpBundle } from "../src/mcp/bundle.ts";
import { nativeCandidateMcpPayload } from "../src/mcp/candidate-payload.ts";

// Point this at a complete built or installed native candidate. No wrapper or
// replacement executable is allowed: the generated entry uses the packaged bytes.
const selected = process.env.HACK_MCP_CANDIDATE_TEST_BUNDLE;

async function retired(directory: string): Promise<boolean> {
  const states = await Promise.all(
    ["mcp.sock", ".mcp-owner", ".mcp-receipt.json"].map((name) =>
      lstat(join(directory, name)).catch((error: unknown) => {
        if (isRecord(error) && error.code === "ENOENT") {
          return null;
        }
        throw error;
      })
    )
  );
  return states.every((state) => state === null);
}

async function waitForRetirement(directory: string) {
  const deadline = Date.now() + 70_000;
  while (!(await retired(directory))) {
    if (Date.now() >= deadline) {
      throw new Error(
        "Packaged backend did not retire within its default idle deadline"
      );
    }
    await Bun.sleep(100);
  }
}

test.skipIf(!selected)(
  "packaged MCP selection shares ownership across clients and retires after final disconnect",
  async () => {
    if (!selected) {
      throw new Error("Explicit native candidate bundle required");
    }
    const bundle = resolve(selected);
    const payload = await nativeCandidateMcpPayload(bundle);
    const first = payload[0];
    if (!first) {
      throw new Error("Candidate has no packaged MCP selection");
    }
    const directory = dirname(join(bundle, first));
    const verified = await verifyMcpBundle({ directory });
    const cli = join(bundle, "hack-cli");
    const root = await realpath(await mkdtemp("/tmp/hack-mcp-pkg-"));
    const runtime = join(root, "r");
    const home = join(root, "home");
    const project = join(root, "project");
    const clients: Client[] = [];
    await mkdir(home, { mode: 0o700 });
    await mkdir(join(project, ".git"), { recursive: true, mode: 0o700 });
    const env = {
      HOME: home,
      HACK_HOME: join(root, "state"),
      HACK_GLOBAL_CONFIG_PATH: join(root, "state", "config.json"),
      HACK_NO_INTERACTIVE: "1",
      PATH: join(root, "unavailable-bin"),
      DOCKER_HOST: `unix://${root}/unavailable-docker.sock`,
      DOCKER_CONFIG: join(root, "docker-config"),
    };
    try {
      const child = Bun.spawn(
        [
          cli,
          "mcp",
          "install",
          "--claude",
          "--scope",
          "project",
          "--bundle",
          directory,
          "--cli",
          cli,
          "--runtime-directory",
          runtime,
        ],
        {
          cwd: project,
          env,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        }
      );
      const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
      try {
        const [code, output, error] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect(code, `${output}\n${error}`).toBe(0);
      } finally {
        clearTimeout(timer);
        if (child.exitCode === null) {
          child.kill("SIGKILL");
        }
        await child.exited;
      }
      const config: unknown = JSON.parse(
        await readFile(join(project, ".mcp.json"), "utf8")
      );
      if (
        !(
          isRecord(config) &&
          isRecord(config.mcpServers) &&
          isRecord(config.mcpServers.hack)
        )
      ) {
        throw new Error("Expected generated MCP configuration");
      }
      const entry = config.mcpServers.hack;
      expect(entry.command).toBe(verified.executables.adapter);
      expect(entry.args).toEqual([
        "--socket",
        join(runtime, "mcp.sock"),
        "--backend-id",
        verified.manifest.bundleId,
        "--owner",
        verified.executables.owner,
        "--backend",
        verified.executables.backend,
      ]);
      expect(entry.env).toEqual({ HACK_MCP_COMMAND: cli });
      if (typeof entry.command !== "string" || !isStringArray(entry.args)) {
        throw new Error("Invalid generated launch");
      }
      const launch = { command: entry.command, args: entry.args };
      async function connect(index: number) {
        const client = new Client({
          name: `packaged-${index}`,
          version: "1",
        });
        clients.push(client);
        await client.connect(
          new StdioClientTransport({
            ...launch,
            cwd: project,
            env: { ...env, HACK_MCP_COMMAND: cli },
            stderr: "pipe",
          })
        );
        return client;
      }
      const initial = await connect(0);
      const before = await lstat(join(runtime, "mcp.sock"));
      const receipt = await readFile(
        join(runtime, ".mcp-receipt.json"),
        "utf8"
      );
      const survivor = await connect(1);
      expect(clients).toHaveLength(2);
      await initial.close();
      expect((await survivor.listTools()).tools.length).toBeGreaterThan(0);
      const result = await survivor.callTool({
        name: "hack.projects.list",
        arguments: {},
      });
      const structured = isRecord(result.structuredContent)
        ? result.structuredContent
        : undefined;
      expect(result.isError === true).toBe(false);
      expect(structured?.exitCode === 0).toBe(true);
      const data = structured?.data;
      expect(
        isRecord(data) &&
          Array.isArray(data.projects) &&
          data.projects.length === 0 &&
          data.runtime_ok === false
      ).toBe(true);
      const after = await lstat(join(runtime, "mcp.sock"));
      expect({ dev: after.dev, ino: after.ino }).toEqual({
        dev: before.dev,
        ino: before.ino,
      });
      expect(await readFile(join(runtime, ".mcp-receipt.json"), "utf8")).toBe(
        receipt
      );
      await survivor.close();
      await waitForRetirement(runtime);
      expect(await retired(runtime)).toBe(true);
    } finally {
      await Promise.all(clients.map((client) => client.close()));
      // Preserve the fixture on retirement failure; never delete an active backend's state.
      await waitForRetirement(runtime);
      await rm(root, { recursive: true });
    }
  },
  100_000
);
