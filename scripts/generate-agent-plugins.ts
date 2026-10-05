import { dirname, resolve } from "node:path";

import { renderCodexSkill } from "../src/agents/codex-skill.ts";
import { renderCursorRules } from "../src/agents/cursor.ts";
import { renderHackInitSkill } from "../src/agents/hack-init-skill.ts";
import { renderHackInstallSkill } from "../src/agents/install-skill.ts";
import { renderHackRemoteSkill } from "../src/agents/remote-bootstrap-skill.ts";
import { isRecord } from "../src/lib/guards.ts";

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
      path: resolve(pluginRoot, "skills", "hack-install", "SKILL.md"),
      content: renderHackInstallSkill(),
    },
    {
      path: resolve(pluginRoot, "skills", "hack-remote", "SKILL.md"),
      content: renderHackRemoteSkill(),
    },
    {
      path: resolve(pluginRoot, "rules", "hack.mdc"),
      content: renderPluginRule(),
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
    await Bun.$`${process.execPath} x --no-install biome format --write ${manifestPath}`.quiet();
  }

  // Keep legacy clients working while deriving portable files from the same source.
  const codexManifest: unknown = await Bun.file(manifestPaths[0]).json();
  const mcpManifest: unknown = await Bun.file(
    resolve(pluginRoot, ".mcp.json")
  ).json();
  for (const [name, manifest] of [
    ["plugin.json", portablePluginManifest(codexManifest)],
    ["mcp.json", portableMcpManifest(mcpManifest)],
  ] as const) {
    const path = resolve(pluginRoot, name);
    await Bun.write(path, `${JSON.stringify(manifest, null, 2)}\n`);
    await Bun.$`${process.execPath} x --no-install biome format --write ${path}`.quiet();
  }
}

/** Preserve effective OpenAI settings: an inline extension replaces the overlay. */
export function portablePluginManifest(
  manifest: unknown
): Record<string, unknown> {
  if (!isRecord(manifest)) {
    throw new Error("Expected a Codex plugin manifest object");
  }
  const {
    skills: _skills,
    mcpServers: _mcp,
    interface: presentation,
    apps,
    hooks,
    ...identity
  } = manifest;
  if (
    !isRecord(presentation) ||
    typeof presentation.shortDescription !== "string" ||
    presentation.shortDescription.length > 30
  ) {
    throw new Error("Plugin shortDescription must be at most 30 characters");
  }
  return {
    $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    ...identity,
    extensions: {
      "com.openai": {
        interface: presentation,
        ...(apps === undefined ? {} : { apps }),
        ...(hooks === undefined ? {} : { hooks }),
      },
    },
  };
}

/** Add explicit portable transports without changing legacy server selection. */
export function portableMcpManifest(
  manifest: unknown
): Record<string, unknown> {
  if (!(isRecord(manifest) && isRecord(manifest.mcpServers))) {
    throw new Error("Expected a plugin mcpServers object");
  }
  const mcpServers: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(manifest.mcpServers)) {
    if (
      !isRecord(server) ||
      typeof server.command !== "string" ||
      "url" in server
    ) {
      throw new Error(`Expected a local stdio server: ${name}`);
    }
    if (server.type !== undefined && server.type !== "stdio") {
      throw new Error(`Unsupported transport for local server: ${name}`);
    }
    mcpServers[name] = { ...server, type: "stdio" };
  }
  return {
    $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
    mcpServers,
  };
}

export function renderPluginRule(): string {
  return [
    "---",
    "description: Use Hack for local services, environments, logs, and project onboarding when working with a Hack-managed project.",
    "alwaysApply: false",
    "---",
    "",
    renderCursorRules(),
  ].join("\n");
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
