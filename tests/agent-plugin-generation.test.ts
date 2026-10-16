import { afterEach, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  generateAgentPlugins,
  renderPluginRule,
} from "../scripts/generate-agent-plugins.ts";
import { renderCodexSkill } from "../src/agents/codex-skill.ts";
import { renderHackInitSkill } from "../src/agents/hack-init-skill.ts";

const repoRoot = join(import.meta.dir, "..");

let tempDir: string | null = null;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

test("release generation applies the requested version to every client manifest", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hack-agent-plugins-"));
  const pluginRoot = join(tempDir, "plugins", "hack");
  const manifestDirectories = [
    ".codex-plugin",
    ".claude-plugin",
    ".cursor-plugin",
  ] as const;

  for (const manifestDirectory of manifestDirectories) {
    const directory = join(pluginRoot, manifestDirectory);
    await mkdir(directory, { recursive: true });
    await Bun.write(
      join(directory, "plugin.json"),
      JSON.stringify({ name: "hack", version: "0.0.0" })
    );
  }

  await generateAgentPlugins({ repoRoot: tempDir, version: "9.8.7" });

  for (const manifestDirectory of manifestDirectories) {
    const manifest = await Bun.file(
      join(pluginRoot, manifestDirectory, "plugin.json")
    ).json();
    expect(manifest.version).toBe("9.8.7");
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
    renderCodexSkill()
  );
  expect(await Bun.file(join(root, "skills/hack-init/SKILL.md")).text()).toBe(
    renderHackInitSkill()
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
  const skill = await Bun.file(
    join(tempDir, "plugins/hack/skills/hack-cli/SKILL.md")
  ).text();
  expect(skill).toContain("hack CLI v9.8.7");
  expect(skill).not.toContain("hack CLI v0.0.1");
}, 15_000);
