import { afterEach, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  generateAgentPlugins,
  portableMcpManifest,
  portablePluginManifest,
  renderPluginReferences,
  renderPluginRule,
  renderPluginSkill,
} from "../scripts/generate-agent-plugins.ts";
import { renderHackInitSkill } from "../src/agents/hack-init-skill.ts";
import { renderHackInstallSkill } from "../src/agents/install-skill.ts";
import { renderHackRemoteSkill } from "../src/agents/remote-bootstrap-skill.ts";

const repoRoot = join(import.meta.dir, "..");

let tempDir: string | null = null;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

const manifestDirectories = [
  ".codex-plugin",
  ".claude-plugin",
  ".cursor-plugin",
] as const;

/** Seed the client manifests the generator rewrites into a temp plugin root. */
async function seedPluginManifests(pluginRoot: string): Promise<void> {
  for (const manifestDirectory of manifestDirectories) {
    const directory = join(pluginRoot, manifestDirectory);
    await mkdir(directory, { recursive: true });
    await Bun.write(
      join(directory, "plugin.json"),
      JSON.stringify({
        name: "hack",
        version: "0.0.0",
        interface: {
          shortDescription: "Run projects with Hack",
        },
      })
    );
  }
  await Bun.write(
    join(pluginRoot, ".mcp.json"),
    JSON.stringify({
      mcpServers: { hack: { command: "hack", args: ["mcp", "serve"] } },
    })
  );
}

test("release generation applies the requested version to every client manifest", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hack-agent-plugins-"));
  const pluginRoot = join(tempDir, "plugins", "hack");
  await seedPluginManifests(pluginRoot);

  await generateAgentPlugins({ repoRoot: tempDir, version: "9.8.7" });

  for (const manifestDirectory of manifestDirectories) {
    const manifest = await Bun.file(
      join(pluginRoot, manifestDirectory, "plugin.json")
    ).json();
    expect(manifest.version).toBe("9.8.7");
  }
  expect((await Bun.file(join(pluginRoot, "plugin.json")).json()).version).toBe(
    "9.8.7"
  );
});

test("generation writes every registered reference and prunes only stale reference markdown", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hack-agent-plugin-references-"));
  const pluginRoot = join(tempDir, "plugins", "hack");
  await seedPluginManifests(pluginRoot);
  const references = renderPluginReferences();
  expect(references.size).toBeGreaterThan(0);
  const [firstReference] = references.keys();
  if (!firstReference) {
    throw new Error("expected at least one registered reference");
  }
  // Generated references are rewritten in place, not left with stale bytes.
  await Bun.write(join(pluginRoot, firstReference), "outdated\n");
  const stale = [
    "skills/hack-cli/references/retired.md",
    "skills/hack-init/references/retired.md",
  ] as const;
  const kept = {
    "skills/hack-cli/references/notes.txt": "not a reference\n",
    "skills/hack-cli/references/diagram.svg": "<svg/>\n",
    "skills/hack-cli/notes.md": "outside references\n",
  } as const;
  for (const path of stale) {
    await Bun.write(join(pluginRoot, path), "# Retired\n");
  }
  for (const [path, content] of Object.entries(kept)) {
    await Bun.write(join(pluginRoot, path), content);
  }

  await generateAgentPlugins({ repoRoot: tempDir, version: "9.8.7" });

  for (const [path, content] of references) {
    const file = Bun.file(join(pluginRoot, path));
    expect(await file.exists()).toBe(true);
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(
      new TextEncoder().encode(content)
    );
  }
  for (const path of stale) {
    expect(await Bun.file(join(pluginRoot, path)).exists()).toBe(false);
  }
  for (const [path, content] of Object.entries(kept)) {
    expect(await Bun.file(join(pluginRoot, path)).text()).toBe(content);
  }
});

test("semantic-release commits all generated client manifests", async () => {
  const releaseConfig = await Bun.file(
    join(import.meta.dir, "..", ".releaserc.json")
  ).json();
  const gitPlugin = releaseConfig.plugins.find(
    (plugin: unknown) =>
      Array.isArray(plugin) && plugin[0] === "@semantic-release/git"
  );
  expect(gitPlugin).toBeDefined();
  const assets = gitPlugin?.[1]?.assets as string[];
  expect(assets).toContain("plugins/hack");
});

test("bundled skills and rule match current canonical guidance", async () => {
  const root = join(repoRoot, "plugins", "hack");
  expect(await Bun.file(join(root, "skills/hack-cli/SKILL.md")).text()).toBe(
    renderPluginSkill("hack-cli")
  );
  const references = renderPluginReferences();
  expect(references.size).toBeGreaterThan(0);
  for (const [path, content] of references) {
    expect(await Bun.file(join(root, path)).text()).toBe(content);
  }
  expect(await Bun.file(join(root, "skills/hack-init/SKILL.md")).text()).toBe(
    renderHackInitSkill()
  );
  expect(
    await Bun.file(join(root, "skills/hack-install/SKILL.md")).text()
  ).toBe(renderHackInstallSkill());
  expect(await Bun.file(join(root, "skills/hack-remote/SKILL.md")).text()).toBe(
    renderHackRemoteSkill()
  );
  expect(await Bun.file(join(root, "rules/hack.mdc")).text()).toBe(
    renderPluginRule()
  );
  expect(renderPluginRule()).toContain("alwaysApply: false");
  const pkg = await Bun.file(join(repoRoot, "package.json")).json();
  for (const client of ["codex", "claude", "cursor"]) {
    const manifest = await Bun.file(
      join(root, `.${client}-plugin/plugin.json`)
    ).json();
    expect(manifest.version).toBe(pkg.version);
  }
  const portable = await Bun.file(join(root, "plugin.json")).json();
  const overlay = await Bun.file(
    join(root, ".codex-plugin/plugin.json")
  ).json();
  expect(portable.version).toBe(pkg.version);
  expect(portable).toEqual(portablePluginManifest(overlay));
  expect(await Bun.file(join(root, "mcp.json")).json()).toEqual(
    portableMcpManifest(await Bun.file(join(root, ".mcp.json")).json())
  );
});

test("portable presentation preserves prompts and effective OpenAI hooks and apps", () => {
  const prompts = ["Start a project", "Set up a project", "Diagnose a project"];
  const manifest = portablePluginManifest({
    name: "hack",
    version: "1.2.3",
    description: "Test",
    skills: "./skills/",
    mcpServers: "./.mcp.json",
    hooks: "./hooks/hooks.json",
    apps: "./.app.json",
    interface: {
      shortDescription: "Run projects with Hack",
      defaultPrompt: prompts,
    },
  });
  expect(manifest).not.toHaveProperty("skills");
  expect(manifest).not.toHaveProperty("mcpServers");
  expect(manifest).not.toHaveProperty("interface");
  expect(manifest).not.toHaveProperty("hooks");
  expect(manifest).not.toHaveProperty("apps");
  expect(manifest.extensions).toEqual({
    "com.openai": {
      hooks: "./hooks/hooks.json",
      apps: "./.app.json",
      interface: {
        shortDescription: "Run projects with Hack",
        defaultPrompt: prompts,
      },
    },
  });
  expect(() =>
    portablePluginManifest({ interface: { shortDescription: "x".repeat(31) } })
  ).toThrow("30 characters");
});

test("portable MCP preserves selection and rejects ambiguous transports", () => {
  const server = {
    command: "/example/hack-next",
    args: ["mcp", "serve"],
    env: { HACK_NO_INTERACTIVE: "1" },
  };
  expect(portableMcpManifest({ mcpServers: { hack: server } })).toHaveProperty(
    "mcpServers.hack",
    { ...server, type: "stdio" }
  );
  for (const invalid of [
    null,
    [],
    { mcpServers: [] },
    { mcpServers: { hack: { ...server, url: "https://example.com" } } },
    { mcpServers: { hack: { ...server, type: "streamable-http" } } },
  ]) {
    expect(() => portableMcpManifest(invalid)).toThrow();
  }
});

test("release preparation updates both manifests and rendered guidance after bumping the version", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hack-plugin-release-"));
  await cp(join(repoRoot, "src"), join(tempDir, "src"), { recursive: true });
  await cp(join(repoRoot, "plugins"), join(tempDir, "plugins"), {
    recursive: true,
  });
  await mkdir(join(tempDir, "scripts"));
  for (const file of ["prepare-release.ts", "generate-agent-plugins.ts"]) {
    await cp(join(repoRoot, "scripts", file), join(tempDir, "scripts", file));
  }
  await symlink(join(repoRoot, "node_modules"), join(tempDir, "node_modules"));
  await Bun.write(
    join(tempDir, "package.json"),
    JSON.stringify({ version: "0.0.1", workspaces: [] })
  );
  const child = Bun.spawn(
    [process.execPath, "scripts/prepare-release.ts", "--version=9.8.7"],
    {
      cwd: tempDir,
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(exitCode, stdout + stderr).toBe(0);
  for (const client of ["codex", "claude", "cursor"]) {
    const manifest = await Bun.file(
      join(tempDir, "plugins/hack", `.${client}-plugin/plugin.json`)
    ).json();
    expect(manifest.version).toBe("9.8.7");
  }
  expect(
    (await Bun.file(join(tempDir, "plugins/hack/plugin.json")).json()).version
  ).toBe("9.8.7");
  const skill = await Bun.file(
    join(tempDir, "plugins/hack/skills/hack-cli/SKILL.md")
  ).text();
  expect(skill).toContain("hack CLI v9.8.7");
  expect(skill).not.toContain("hack CLI v0.0.1");
}, 15_000);
