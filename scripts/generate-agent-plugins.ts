import { readdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { renderHackCliSkill } from "../src/agents/codex-skill.ts";
import {
  FEEDBACK_ISSUE_TEMPLATE_PATH,
  renderFeedbackIssueTemplateFile,
  renderHackFeedbackSkill,
} from "../src/agents/feedback-skill.ts";
import {
  FOCUSED_SKILLS,
  type FocusedSkillName,
  HACK_CLI_PLUGIN_ROUTING,
  renderDescriptionFrontmatter,
  renderFocusedSkill,
  renderSkillDescription,
} from "../src/agents/focused-skills.ts";
import { renderHackInitSkill } from "../src/agents/hack-init-skill.ts";
import { renderHackInstallSkill } from "../src/agents/install-skill.ts";
import { renderHackRemoteSkill } from "../src/agents/remote-bootstrap-skill.ts";
import {
  type PluginSkillName,
  referencesForSkill,
  renderSkillReference,
  skillReferencePath,
  withSkillReferenceLinks,
} from "../src/agents/skill-references.ts";
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
      content: renderPluginSkill("hack-cli"),
    },
    ...FOCUSED_SKILLS.map((skill) => ({
      path: resolve(pluginRoot, "skills", skill.name, "SKILL.md"),
      content: renderPluginSkill(skill.name),
    })),
    {
      path: resolve(pluginRoot, "skills", "hack-feedback", "SKILL.md"),
      content: renderPluginSkill("hack-feedback"),
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
      // The repository issue template shares the hack-feedback skill's source.
      path: resolve(repoRoot, FEEDBACK_ISSUE_TEMPLATE_PATH),
      content: renderFeedbackIssueTemplateFile(),
    },
  ] as const;

  for (const skill of generatedSkills) {
    await Bun.$`mkdir -p ${dirname(skill.path)}`;
    await Bun.write(skill.path, skill.content);
  }
  await writeSkillReferences({ pluginRoot });

  for (const relative of SKILLS_PACKAGE_MANIFESTS) {
    const manifestPath = resolve(pluginRoot, relative);
    const manifest: unknown = await Bun.file(manifestPath).json();
    if (!isRecord(manifest)) {
      throw new Error("Expected a hack plugin client manifest object");
    }
    if ("mcpServers" in manifest) {
      throw new Error(
        "The hack plugin is skills-only; declare MCP in the hack-mcp package"
      );
    }
    Reflect.deleteProperty(manifest, "hooks");
    Reflect.deleteProperty(manifest, "rules");
    manifest.version = version;
    await writeFormattedJson({ path: manifestPath, value: manifest });
  }

  // The portable manifest derives from the Codex overlay. MCP is not part of
  // the skills package; remove copies a pre-hack-mcp checkout still carries.
  const codexManifest: unknown = await Bun.file(
    resolve(pluginRoot, SKILLS_PACKAGE_MANIFESTS[0])
  ).json();
  await writeFormattedJson({
    path: resolve(pluginRoot, "plugin.json"),
    value: portablePluginManifest(codexManifest),
  });
  for (const retired of RETIRED_SKILLS_PACKAGE_FILES) {
    await rm(resolve(pluginRoot, retired), { force: true });
  }

  await generateMcpPlugin({
    pluginRoot: resolve(repoRoot, "plugins", HACK_MCP_PLUGIN_NAME),
    version,
  });
}

/** Default plugin: explicitly invoked skills; no MCP. */
export const HACK_PLUGIN_NAME = "hack";

/** Opt-in companion plugin that only declares the Hack MCP server. */
export const HACK_MCP_PLUGIN_NAME = "hack-mcp";

/** Client manifests of the skills package; Codex first as the portable source. */
const SKILLS_PACKAGE_MANIFESTS = [
  ".codex-plugin/plugin.json",
  ".claude-plugin/plugin.json",
  ".cursor-plugin/plugin.json",
] as const;

/** Retired product package assets only; never paths in installed client homes. */
const RETIRED_SKILLS_PACKAGE_FILES = [
  ".mcp.json",
  "mcp.json",
  "hooks/claude-hooks.json",
  "rules/hack.mdc",
] as const;

/**
 * The single source of truth for the MCP launch Hack packages as a plugin:
 * the `hack` executable from the client's PATH, serving stdio. Every hack-mcp
 * client manifest and both MCP files render from this value.
 */
export const HACK_MCP_SERVER = {
  name: "hack",
  command: "hack",
  args: ["mcp", "serve"],
} as const;

/** Every file the generator owns in plugins/hack-mcp, relative to its root. */
export const HACK_MCP_PLUGIN_FILES = [
  ".claude-plugin/plugin.json",
  ".codex-plugin/plugin.json",
  ".cursor-plugin/plugin.json",
  ".mcp.json",
  "README.md",
  "mcp.json",
  "plugin.json",
] as const;

const HACK_MCP_DESCRIPTION =
  "Opt-in Hack MCP server (`hack mcp serve`) for agent clients without shell access.";
const HACK_MCP_KEYWORDS = [
  "local-development",
  "developer-tools",
  "agents",
  "mcp",
] as const;
const HACK_HOMEPAGE = "https://github.com/hack-dance/hack";
const HACK_AUTHOR = {
  name: "Hack Dance LLC",
  url: "https://github.com/hack-dance",
} as const;
const MCP_DECLARATION = "./.mcp.json";

/** Client-compatible `.mcp.json` rendered from {@link HACK_MCP_SERVER}. */
export function renderMcpServers(): Record<string, unknown> {
  return {
    mcpServers: {
      [HACK_MCP_SERVER.name]: {
        command: HACK_MCP_SERVER.command,
        args: [...HACK_MCP_SERVER.args],
      },
    },
  };
}

/** Client manifests of the hack-mcp package for one release version. */
export function renderMcpPluginManifests({
  version,
}: {
  readonly version: string;
}): Readonly<Record<"codex" | "claude" | "cursor", Record<string, unknown>>> {
  const identity = {
    name: HACK_MCP_PLUGIN_NAME,
    version,
    description: HACK_MCP_DESCRIPTION,
    author: { ...HACK_AUTHOR },
    homepage: HACK_HOMEPAGE,
    repository: HACK_HOMEPAGE,
    license: "MIT",
    keywords: [...HACK_MCP_KEYWORDS],
  };
  return {
    codex: {
      ...identity,
      interface: {
        displayName: "Hack MCP",
        shortDescription: "Hack tools over MCP",
        longDescription:
          "Opt-in MCP server for Codex sessions without shell access. Install the hack plugin for skills; prefer the Hack CLI whenever shell access is available.",
        developerName: HACK_AUTHOR.name,
        category: "Developer Tools",
        capabilities: ["MCP tools"],
        websiteURL: HACK_HOMEPAGE,
        defaultPrompt: ["List my Hack projects and their status."],
        brandColor: "#FF5C35",
      },
      mcpServers: MCP_DECLARATION,
    },
    claude: { ...identity, mcpServers: MCP_DECLARATION },
    cursor: {
      ...identity,
      author: { name: HACK_AUTHOR.name },
      mcpServers: MCP_DECLARATION,
    },
  };
}

/** README of the hack-mcp package. */
export function renderMcpPluginReadme(): string {
  const launch = [HACK_MCP_SERVER.command, ...HACK_MCP_SERVER.args].join(" ");
  return `# Hack MCP plugin

Opt-in companion to the \`hack\` plugin. It declares one stdio MCP server,
\`${launch}\`, for Codex, Claude Code and Cursor sessions without shell
access. It ships no skills, hooks or rules; those stay in the \`hack\` plugin.

Install it only when MCP is wanted. With shell access, the \`hack\` plugin and the
Hack CLI cover the same workflows without a server process. Install the \`hack\`
executable first; the server resolves \`hack\` from the client's PATH. Keep one
Hack MCP registration per client: do not add this plugin next to an existing
\`hack mcp install\` entry for the same client and scope.

Portable clients read \`plugin.json\` and \`mcp.json\`; other clients read their
\`.<client>-plugin/plugin.json\` and \`.mcp.json\`. Verify in a fresh session that
the server initializes and lists Hack tools. A marketplace listing alone does not
prove that it loaded.

Generated by \`bun run generate:agent-plugins\` from
\`scripts/generate-agent-plugins.ts\`; do not edit these files directly. See
[integration setup](../../docs/integrations.md#optional-native-plugins).
`;
}

/** Write the complete hack-mcp package; every file renders from code. */
async function generateMcpPlugin({
  pluginRoot,
  version,
}: {
  readonly pluginRoot: string;
  readonly version: string;
}): Promise<void> {
  const manifests = renderMcpPluginManifests({ version });
  const servers = renderMcpServers();
  const files: readonly (readonly [string, unknown])[] = [
    [".codex-plugin/plugin.json", manifests.codex],
    [".claude-plugin/plugin.json", manifests.claude],
    [".cursor-plugin/plugin.json", manifests.cursor],
    [".mcp.json", servers],
    ["plugin.json", portablePluginManifest(manifests.codex)],
    ["mcp.json", portableMcpManifest(servers)],
  ];
  for (const [relative, value] of files) {
    await writeFormattedJson({ path: resolve(pluginRoot, relative), value });
  }
  await Bun.write(resolve(pluginRoot, "README.md"), renderMcpPluginReadme());
}

async function writeFormattedJson({
  path,
  value,
}: {
  readonly path: string;
  readonly value: unknown;
}): Promise<void> {
  await Bun.$`mkdir -p ${dirname(path)}`;
  await Bun.write(path, `${JSON.stringify(value, null, 2)}\n`);
  await Bun.$`${process.execPath} x --no-install biome format --write ${path}`.quiet();
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

/**
 * Render a plugin skill's SKILL.md with links to its packaged references.
 *
 * The plugin `hack-cli` routes branch, env and diagnosis intents to the
 * focused skills; standalone installs keep `renderCodexSkill` (broad routing,
 * no references) because they ship neither. `hack-feedback` is plugin-only.
 */
export function renderPluginSkill(
  skill: "hack-cli" | "hack-feedback" | FocusedSkillName
): string {
  return withSkillReferenceLinks({ skill, content: pluginSkillContent(skill) });
}

function pluginSkillContent(
  skill: "hack-cli" | "hack-feedback" | FocusedSkillName
): string {
  if (skill === "hack-cli") {
    return renderHackCliSkill({
      descriptionLines: renderDescriptionFrontmatter(
        renderSkillDescription(HACK_CLI_PLUGIN_ROUTING)
      ),
    });
  }
  if (skill === "hack-feedback") {
    return renderHackFeedbackSkill();
  }
  return renderFocusedSkill(skill);
}

const PLUGIN_SKILLS: readonly PluginSkillName[] = [
  "hack-cli",
  ...FOCUSED_SKILLS.map((skill) => skill.name),
  "hack-feedback",
  "hack-init",
  "hack-install",
  "hack-remote",
];

/** Every packaged skill reference keyed by its plugin-relative path. */
export function renderPluginReferences(): ReadonlyMap<string, string> {
  return new Map(
    PLUGIN_SKILLS.flatMap((skill) =>
      referencesForSkill(skill).map(
        (reference) =>
          [
            skillReferencePath(reference),
            renderSkillReference(reference),
          ] as const
      )
    )
  );
}

/**
 * Write every registered reference and remove stale generated ones, so each
 * bundled `references/` directory holds exactly the registry's markdown files.
 */
async function writeSkillReferences({
  pluginRoot,
}: {
  readonly pluginRoot: string;
}): Promise<void> {
  const references = renderPluginReferences();
  for (const skill of PLUGIN_SKILLS) {
    const directory = resolve(pluginRoot, "skills", skill, "references");
    const existing = await readdir(directory).catch((): string[] => []);
    for (const name of existing) {
      if (
        name.endsWith(".md") &&
        !references.has(`skills/${skill}/references/${name}`)
      ) {
        await rm(resolve(directory, name));
      }
    }
  }
  for (const [relativePath, content] of references) {
    const path = resolve(pluginRoot, relativePath);
    await Bun.$`mkdir -p ${dirname(path)}`;
    await Bun.write(path, content);
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
