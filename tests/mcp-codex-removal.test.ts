import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  removeCodexLaunch,
  replaceCodexLaunch,
} from "../src/mcp/codex-launch.ts";
import {
  checkMcpConfig,
  installMcpConfig,
  removeMcpConfig,
} from "../src/mcp/install.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

for (const header of [
  "[mcp_servers.hack]",
  '[mcp_servers."hack"]',
  '["mcp_servers".hack]',
]) {
  test(`removal handles ${header} and nested env/tool tables without leaking fields`, () => {
    const other = '# another server\n[mcp_servers.other]\ncommand = "retain"\n';
    const text = `model = "custom"\n${header}\ncommand = "adapter"\nargs = ["--socket", "/private/mcp.sock"]\n[mcp_servers.hack.env]\nHACK_MCP_COMMAND = "/candidate"\n[mcp_servers.hack.tools.read]\napproval_mode = "prompt"\n${other}`;
    const next = removeCodexLaunch(text);
    expect(Bun.TOML.parse(next)).toEqual({
      model: "custom",
      mcp_servers: { other: { command: "retain" } },
    });
    expect(next).toContain(other);
    expect(removeCodexLaunch(next)).toBe(next);
  });
}

test("removing the only server leaves no command or environment at the config root", () => {
  const next = removeCodexLaunch(
    '[mcp_servers.hack]\ncommand = "adapter"\nargs = []\n[mcp_servers.hack.env]\nPIN = "value"\n'
  );
  expect(Bun.TOML.parse(next)).toEqual({});
  expect(next.trim()).toBe("");
});

test("explicit empty parent table remains valid and names sharing a prefix survive", () => {
  const text =
    '[mcp_servers]\n[mcp_servers.hack]\ncommand = "adapter"\n[mcp_servers.hackish]\ncommand = "keep"\n';
  expect(Bun.TOML.parse(removeCodexLaunch(text))).toEqual({
    mcp_servers: { hackish: { command: "keep" } },
  });
  expect(
    Bun.TOML.parse(
      removeCodexLaunch(
        '[mcp_servers]\n[mcp_servers.hack]\ncommand = "adapter"\n'
      )
    )
  ).toEqual({ mcp_servers: {} });
});

test("header-looking string content is never mistaken for an installed server", () => {
  const text = 'note = """\n[mcp_servers.hack]\ncommand = "a string"\n"""\n';
  expect(removeCodexLaunch(text)).toBe(text);
});

test("unsafe text layouts and malformed input refuse with no configuration content in errors", () => {
  const samples = [
    "private-invalid-token = [",
    '[mcp_servers]\nhack = {command = "adapter"}\n',
    'note = """\n[mcp_servers.hack]\nvalue = "string"\n"""\n[mcp_servers.hack]\ncommand = "adapter"\n',
  ];
  for (const text of samples) {
    expect(() => removeCodexLaunch(text)).toThrow();
  }
});

test("bundle replacement also recognizes quoted headers while retaining settings", () => {
  const next = replaceCodexLaunch({
    text: '[mcp_servers."hack"]\ncommand = "old"\nenabled_tools = ["read"]\n',
    launch: {
      command: "/adapter",
      args: [],
      env: { HACK_MCP_COMMAND: "/candidate" },
    },
  });
  expect(Bun.TOML.parse(next)).toMatchObject({
    mcp_servers: { hack: { command: "/adapter", enabled_tools: ["read"] } },
  });
});

test("installer removal roundtrip restores working stdio config and preserves refusal input", async () => {
  const root = await mkdtemp("/tmp/hack-cr-");
  roots.push(root);
  await mkdir(join(root, ".codex"));
  const path = join(root, ".codex/config.toml");
  const opts = {
    targets: ["codex"] as const,
    scope: "project" as const,
    projectRoot: root,
  };
  await Bun.write(
    path,
    'model = "keep"\n[mcp_servers.hack]\ncommand = "/adapter"\nargs = []\n[mcp_servers.hack.env]\nHACK_MCP_COMMAND = "/candidate"\n'
  );
  expect((await removeMcpConfig(opts))[0]?.status).toBe("removed");
  expect(Bun.TOML.parse(await Bun.file(path).text())).toEqual({
    model: "keep",
  });
  expect((await removeMcpConfig(opts))[0]?.status).toBe("noop");
  expect((await installMcpConfig(opts))[0]?.status).toBe("updated");
  expect(Bun.TOML.parse(await Bun.file(path).text())).toEqual({
    model: "keep",
    mcp_servers: { hack: { command: "hack", args: ["mcp", "serve"] } },
  });
  const broken = '[mcp_servers]\nhack = {command = "preserve"}\n';
  await Bun.write(path, broken);
  expect((await removeMcpConfig(opts))[0]?.status).toBe("error");
  expect(await Bun.file(path).text()).toBe(broken);
});

test("Codex inventory parses quoted tables and rejects malformed input without mutating it", async () => {
  const root = await mkdtemp("/tmp/hack-ci-");
  roots.push(root);
  await mkdir(join(root, ".codex"));
  const path = join(root, ".codex/config.toml");
  const opts = {
    targets: ["codex"] as const,
    scope: "project" as const,
    projectRoot: root,
  };
  const quoted = '[mcp_servers."hack"]\ncommand = "custom"\n';
  await Bun.write(path, quoted);
  expect((await checkMcpConfig(opts))[0]?.status).toBe("present");
  expect((await installMcpConfig(opts))[0]?.status).toBe("noop");
  expect(await Bun.file(path).text()).toBe(quoted);
  const string = 'note = """\n[mcp_servers.hack]\n"""\n';
  await Bun.write(path, string);
  expect((await checkMcpConfig(opts))[0]?.status).toBe("missing");
  const broken = "sensitive-broken-value = [";
  await Bun.write(path, broken);
  expect((await checkMcpConfig(opts))[0]?.status).toBe("error");
  expect((await installMcpConfig(opts))[0]?.status).toBe("error");
  expect(await Bun.file(path).text()).toBe(broken);
});
