import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "../src/lib/guards.ts";
import { packageMcpBundle } from "../src/mcp/bundle.ts";
import { prepareMcpBundleLaunch } from "../src/mcp/bundle-launch.ts";
import { replaceCodexLaunch } from "../src/mcp/codex-launch.ts";
import {
  installMcpConfig,
  renderMcpConfigSnippet,
} from "../src/mcp/install.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});
async function fixture() {
  const root = await realpath(await mkdtemp("/tmp/hack-ba-"));
  roots.push(root);
  const inputs = {
    adapter: join(root, "adapter"),
    owner: join(root, "owner"),
    backend: join(root, "backend"),
  };
  for (const [role, path] of Object.entries(inputs)) {
    const info = {
      schemaVersion: 1,
      role,
      startupProtocol: 2,
      wireProtocol: 1,
      platform: process.platform,
      architecture: process.arch,
    };
    await writeFile(
      path,
      `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(info)}'\n`,
      { mode: 0o700 }
    );
  }
  const outputRoot = join(root, "bundles with ' quotes");
  const a = await packageMcpBundle({ inputs, outputRoot });
  await writeFile(
    inputs.backend,
    `${await Bun.file(inputs.backend).text()}# next build\n`
  );
  const b = await packageMcpBundle({ inputs, outputRoot });
  const selection = {
    directory: a.directory,
    cli: process.execPath,
    runtimeDirectory: join(root, "runtime"),
  };
  return { root, a, b, selection };
}

test("preview validates and quotes exact bundle paths without creating runtime state", async () => {
  const f = await fixture();
  const launch = await prepareMcpBundleLaunch({
    selection: f.selection,
    createRuntime: false,
  });
  expect(
    await lstat(f.selection.runtimeDirectory).catch(() => null)
  ).toBeNull();
  expect(launch.command).toBe(f.a.executables.adapter);
  expect(launch.args).toContain(f.a.manifest.bundleId);
  expect(launch.env?.HACK_MCP_COMMAND).toBe(await realpath(process.execPath));
  for (const target of ["codex", "claude", "cursor"] as const) {
    const snippet = renderMcpConfigSnippet({
      target,
      scope: "project",
      projectRoot: f.root,
      launch,
    });
    if (!snippet.ok) {
      throw new Error("Expected config preview");
    }
    const document: unknown =
      target === "codex"
        ? Bun.TOML.parse(snippet.content)
        : JSON.parse(snippet.content);
    if (!isRecord(document)) {
      throw new Error("Expected configuration object");
    }
    const parsed =
      target === "codex" ? document.mcp_servers : document.mcpServers;
    if (!(isRecord(parsed) && isRecord(parsed.hack))) {
      throw new Error("Expected Hack entry");
    }
    expect(parsed.hack.command).toBe(launch.command);
    expect(parsed.hack.args).toEqual(launch.args);
    expect(parsed.hack.env).toEqual(launch.env);
  }
});

test("candidate install switches and rolls back Codex while retaining custom settings", async () => {
  const f = await fixture();
  await mkdir(join(f.root, ".codex"));
  const path = join(f.root, ".codex/config.toml");
  await writeFile(
    path,
    '# user preference\nmodel = "custom-model"\n[mcp_servers.hack]\ncommand = "hack"\nargs = ["mcp", "serve"]\nenabled_tools = ["hack.projects.list"]\n[mcp_servers.hack.env]\nCUSTOM = "keep"\n[mcp_servers.other]\ncommand = "other"\n'
  );
  const opts = {
    targets: ["codex"] as const,
    scope: "project" as const,
    projectRoot: f.root,
  };
  for (const bundle of [f.a, f.b, f.a]) {
    const result = await installMcpConfig({
      ...opts,
      bundle: { ...f.selection, directory: bundle.directory },
    });
    expect(result[0]?.status).toBe("updated");
    const text = await Bun.file(path).text();
    expect(text).toContain('# user preference\nmodel = "custom-model"');
    expect(Bun.TOML.parse(text)).toMatchObject({
      model: "custom-model",
      mcp_servers: {
        other: { command: "other" },
        hack: {
          command: bundle.executables.adapter,
          enabled_tools: ["hack.projects.list"],
          env: { CUSTOM: "keep" },
        },
      },
    });
    expect(
      (
        await installMcpConfig({
          ...opts,
          bundle: { ...f.selection, directory: bundle.directory },
        })
      )[0]?.status
    ).toBe("noop");
  }
  expect((await lstat(f.selection.runtimeDirectory)).mode & 0o777).toBe(0o700);
});

for (const target of ["claude", "cursor"] as const) {
  test(`${target} candidate switch preserves other servers and custom environment`, async () => {
    const f = await fixture();
    const path =
      target === "claude"
        ? join(f.root, ".mcp.json")
        : join(f.root, ".cursor/mcp.json");
    if (target === "cursor") {
      await mkdir(join(f.root, ".cursor"));
    }
    await writeFile(
      path,
      JSON.stringify({
        custom: true,
        mcpServers: {
          other: { command: "other" },
          hack: { command: "hack", custom: true, env: { CUSTOM: "keep" } },
        },
      })
    );
    const opts = {
      targets: [target],
      scope: "project" as const,
      projectRoot: f.root,
    };
    for (const bundle of [f.a, f.b, f.a]) {
      expect(
        (
          await installMcpConfig({
            ...opts,
            bundle: { ...f.selection, directory: bundle.directory },
          })
        )[0]?.status
      ).toBe("updated");
      expect(await Bun.file(path).json()).toMatchObject({
        custom: true,
        mcpServers: {
          other: { command: "other" },
          hack: {
            command: bundle.executables.adapter,
            custom: true,
            env: { CUSTOM: "keep" },
          },
        },
      });
    }
  });
}

test("corrupt bundle refuses before runtime or client configuration creation", async () => {
  const f = await fixture();
  await chmod(f.a.executables.adapter, 0o700);
  await writeFile(f.a.executables.adapter, "corrupted");
  await chmod(f.a.executables.adapter, 0o500);
  await expect(
    installMcpConfig({
      targets: ["codex", "claude", "cursor"],
      scope: "project",
      projectRoot: f.root,
      bundle: f.selection,
    })
  ).rejects.toThrow("integrity check");
  for (const path of [
    f.selection.runtimeDirectory,
    join(f.root, ".codex"),
    join(f.root, ".mcp.json"),
    join(f.root, ".cursor"),
  ]) {
    expect(await lstat(path).catch(() => null)).toBeNull();
  }
});

test("unsafe runtime directory and long socket paths refuse without chmod or aliases", async () => {
  const f = await fixture();
  await mkdir(f.selection.runtimeDirectory, { mode: 0o755 });
  await expect(
    prepareMcpBundleLaunch({ selection: f.selection, createRuntime: true })
  ).rejects.toThrow("private");
  expect((await lstat(f.selection.runtimeDirectory)).mode & 0o777).toBe(0o755);
  await chmod(f.selection.runtimeDirectory, 0o700);
  const alias = join(f.root, "alias");
  await symlink(f.selection.runtimeDirectory, alias);
  await expect(
    prepareMcpBundleLaunch({
      selection: { ...f.selection, runtimeDirectory: alias },
      createRuntime: false,
    })
  ).rejects.toThrow("private");
  await expect(
    prepareMcpBundleLaunch({
      selection: {
        ...f.selection,
        runtimeDirectory: join(f.root, "x".repeat(110)),
      },
      createRuntime: false,
    })
  ).rejects.toThrow("too long");
});

test("Codex ambiguous layouts and non-stdio entries are refused rather than damaged", () => {
  const launch = {
    command: "/native",
    args: ["--socket", "/private/mcp.sock"],
    env: { HACK_MCP_COMMAND: "/candidate" },
  };
  for (const text of [
    '[mcp_servers]\nhack = {command = "old"}\n',
    '[mcp_servers.hack]\nurl = "https://example.invalid"\n',
    "broken = [",
  ]) {
    expect(() => replaceCodexLaunch({ text, launch })).toThrow();
  }
  const text =
    'note = """\n[mcp_servers.hack]\ncommand = "inside a string"\n"""\n';
  expect(() => replaceCodexLaunch({ text, launch })).toThrow("safely");
});
