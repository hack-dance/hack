import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isRecord } from "../src/lib/guards.ts";
import { renderCodexLaunch } from "../src/mcp/codex-launch.ts";

// Reuse the real CLI boundary checks against the current compiled candidate.
const cli = process.env.HACK_MCP_SETUP_TEST_BINARY
  ? [resolve(process.env.HACK_MCP_SETUP_TEST_BINARY)]
  : [process.execPath, resolve(import.meta.dir, "../index.ts")];
const roots: string[] = [];
const clients = ["claude", "cursor", "codex"] as const;
const scopes = ["user", "project"] as const;
type Client = (typeof clients)[number];
type Scope = (typeof scopes)[number];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture(kind: "managed" | "custom") {
  const root = await realpath(await mkdtemp("/tmp/hack-mcp-repeat-"));
  roots.push(root);
  const home = join(root, "home");
  const project = join(root, "project");
  const state = join(root, "state");
  await mkdir(join(project, ".git"), { recursive: true });
  await mkdir(home);
  await mkdir(state);
  const files: { target: Client; scope: Scope; path: string }[] = [];
  for (const scope of scopes) {
    const directory = scope === "user" ? home : project;
    for (const target of clients) {
      const path = join(
        directory,
        target === "codex"
          ? ".codex/config.toml"
          : target === "cursor"
            ? ".cursor/mcp.json"
            : scope === "user"
              ? ".claude.json"
              : ".mcp.json"
      );
      const launch = {
        command: join(root, `${kind}-executable`),
        args:
          kind === "managed"
            ? [
                "--socket",
                join(root, "runtime/mcp.sock"),
                "--backend-id",
                "a".repeat(64),
                "--owner",
                join(root, "owner"),
                "--backend",
                join(root, "backend"),
              ]
            : ["custom-mcp", "--fixture"],
        env: {
          CUSTOM: `synthetic-${scope}`,
          ...(kind === "managed"
            ? { HACK_MCP_COMMAND: join(root, "candidate-cli") }
            : {}),
        },
      };
      const text =
        target === "codex"
          ? `# retain exact formatting\nmodel = "synthetic"\n${renderCodexLaunch(launch)}\nenabled_tools = ["hack.projects.list"]\n[mcp_servers.other]\ncommand = "synthetic-other"\n`
          : `${JSON.stringify({ preference: "synthetic", mcpServers: { other: { command: "synthetic-other" }, hack: { ...launch, type: "stdio", enabled_tools: ["hack.projects.list"] } } }, null, 3)}\n\n`;
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text);
      files.push({ target, scope, path });
    }
  }
  const env = {
    HOME: home,
    HACK_HOME: state,
    HACK_GLOBAL_CONFIG_PATH: join(state, "hack.config.json"),
    CODEX_HOME: join(home, ".codex"),
    PATH: join(root, "unavailable-bin"),
    HACK_NO_INTERACTIVE: "1",
    HACK_DAEMON_DISABLE: "1",
    DOCKER_HOST: `unix://${root}/unavailable.sock`,
    NO_COLOR: "1",
  };
  async function invoke(args: readonly string[]) {
    const child = Bun.spawn([...cli, ...args], {
      cwd: project,
      env,
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
      expect(code, `${args.join(" ")}\n${stdout}\n${stderr}`).toBe(0);
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
      await child.exited;
    }
  }
  async function snapshot() {
    return await Promise.all(
      files.map(async (file) => ({
        ...file,
        text: await readFile(file.path, "utf8"),
      }))
    );
  }
  return { files, invoke, snapshot };
}

function parseConfig(target: Client, text: string) {
  const document: unknown =
    target === "codex" ? Bun.TOML.parse(text) : JSON.parse(text);
  if (!isRecord(document)) {
    throw new Error("Expected fixture configuration object");
  }
  return document;
}

for (const scope of scopes) {
  for (const kind of ["managed", "custom"] as const) {
    test(`real ${scope} setup preserves ${kind} launches until explicit stdio rollback`, async () => {
      const f = await fixture(kind);
      const initial = await f.snapshot();
      const untouched = initial.filter((file) => file.scope !== scope);
      const scopeFlags = scope === "user" ? ["--global"] : [];
      for (const args of [
        ["mcp", "install", "--all", "--scope", scope],
        ["setup", "mcp", "--all", ...scopeFlags],
        ["setup", "sync", ...scopeFlags],
      ]) {
        await f.invoke(args);
        expect(await f.snapshot()).toEqual(initial);
      }
      await f.invoke(["setup", "mcp", "--all", "--remove", ...scopeFlags]);
      const removed = await f.snapshot();
      expect(removed.filter((file) => file.scope !== scope)).toEqual(untouched);
      for (const file of removed) {
        if (file.scope !== scope) {
          continue;
        }
        expect(parseConfig(file.target, file.text)).toEqual(
          file.target === "codex"
            ? {
                model: "synthetic",
                mcp_servers: { other: { command: "synthetic-other" } },
              }
            : {
                preference: "synthetic",
                mcpServers: { other: { command: "synthetic-other" } },
              }
        );
      }
      await f.invoke(["mcp", "install", "--all", "--scope", scope]);
      const restored = await f.snapshot();
      expect(restored.filter((file) => file.scope !== scope)).toEqual(
        untouched
      );
      for (const file of restored) {
        if (file.scope !== scope) {
          continue;
        }
        const entry = {
          command: "hack",
          args: ["mcp", "serve"],
          ...(file.target === "claude" ? { type: "stdio" } : {}),
        };
        expect(parseConfig(file.target, file.text)).toEqual(
          file.target === "codex"
            ? {
                model: "synthetic",
                mcp_servers: {
                  other: { command: "synthetic-other" },
                  hack: entry,
                },
              }
            : {
                preference: "synthetic",
                mcpServers: {
                  other: { command: "synthetic-other" },
                  hack: entry,
                },
              }
        );
      }
      await f.invoke(["setup", "mcp", "--all", ...scopeFlags]);
      expect(await f.snapshot()).toEqual(restored);
    }, 30_000);
  }
}
