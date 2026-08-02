import { dirname, resolve } from "node:path";

import { renderCodexSkill } from "../src/agents/codex-skill.ts";
import { renderCursorPluginRule } from "../src/agents/cursor.ts";
import { renderHackInitSkill } from "../src/agents/hack-init-skill.ts";

export async function generateAgentPlugins({
  repoRoot,
  version,
}: {
  readonly repoRoot: string;
  readonly version: string;
}): Promise<void> {
  const pluginRoot = resolve(repoRoot, "plugins", "hack");

  const generatedSkills = [
    {
      path: resolve(pluginRoot, "skills", "hack-cli", "SKILL.md"),
      content: renderCodexSkill(),
    },
    {
      path: resolve(pluginRoot, "skills", "hack-init", "SKILL.md"),
      content: renderHackInitSkill(),
    },
    {
      path: resolve(pluginRoot, "rules", "hack.mdc"),
      content: renderCursorPluginRule(),
    },
  ] as const;

  for (const skill of generatedSkills) {
    await Bun.$`mkdir -p ${dirname(skill.path)}`;
    await Bun.write(skill.path, skill.content);
  }

  const manifestPaths = [
    resolve(pluginRoot, ".codex-plugin", "plugin.json"),
    resolve(pluginRoot, ".claude-plugin", "plugin.json"),
    resolve(pluginRoot, ".cursor-plugin", "plugin.json"),
  ] as const;

  for (const manifestPath of manifestPaths) {
    const manifest = (await Bun.file(manifestPath).json()) as Record<
      string,
      unknown
    >;
    manifest.version = version;
    await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await Bun.$`bun x biome format --write ${manifestPath}`.quiet();
  }
}

if (import.meta.main) {
  const repoRoot = resolve(import.meta.dir, "..");
  const packageJson = await Bun.file(resolve(repoRoot, "package.json")).json();
  if (
    typeof packageJson !== "object" ||
    packageJson === null ||
    typeof packageJson.version !== "string"
  ) {
    throw new Error("package.json is missing a string version");
  }
  await generateAgentPlugins({ repoRoot, version: packageJson.version });
}
