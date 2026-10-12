import { afterEach, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import {
  generateAgentPlugins,
  HACK_MCP_PLUGIN_FILES,
  HACK_MCP_PLUGIN_NAME,
  HACK_MCP_SERVER,
  HACK_PLUGIN_NAME,
  portableMcpManifest,
  portablePluginManifest,
  renderMcpPluginManifests,
  renderMcpServers,
  renderPluginReferences,
  renderPluginRule,
  renderPluginSkill,
} from "../scripts/generate-agent-plugins.ts";
import { renderHackInitSkill } from "../src/agents/hack-init-skill.ts";
import { renderHackInstallSkill } from "../src/agents/install-skill.ts";
import { renderHackRemoteSkill } from "../src/agents/remote-bootstrap-skill.ts";
import { isRecord } from "../src/lib/guards.ts";

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
}

/** Every file under a directory, keyed by its relative path. */
async function snapshotTree(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const glob = new Bun.Glob("**/*");
  for await (const relative of glob.scan({
    cwd: root,
    dot: true,
    onlyFiles: true,
  })) {
    files[relative] = await Bun.file(join(root, relative)).text();
  }
  return files;
}

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  const parsed: unknown = await Bun.file(path).json();
  if (!isRecord(parsed)) {
    throw new Error("Expected a JSON object");
  }
  return parsed;
}

const sameJson = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

/** Shape findings for the skills package: no MCP declaration or MCP file. */
async function skillsPackageShapeIssues(root: string): Promise<string[]> {
  const issues: string[] = [];
  for (const relative of [
    ...manifestDirectories.map((directory) => `${directory}/plugin.json`),
    "plugin.json",
  ]) {
    const manifest = await readJsonObject(join(root, relative));
    if (manifest.name !== HACK_PLUGIN_NAME) {
      issues.push(`hack:${relative}:name`);
    }
    if ("mcpServers" in manifest) {
      issues.push(`hack:${relative}:declares-mcp`);
    }
  }
  for (const retired of [".mcp.json", "mcp.json"]) {
    if (await Bun.file(join(root, retired)).exists()) {
      issues.push(`hack:${retired}:ships-mcp`);
    }
  }
  return issues;
}

/** Shape findings for hack-mcp: exactly the generated MCP declaration. */
async function mcpPackageShapeIssues(root: string): Promise<string[]> {
  const issues: string[] = [];
  const files = Object.keys(await snapshotTree(root)).sort();
  if (!sameJson(files, [...HACK_MCP_PLUGIN_FILES].sort())) {
    issues.push("hack-mcp:files");
  }
  const codex = await readJsonObject(join(root, ".codex-plugin/plugin.json"));
  for (const directory of manifestDirectories) {
    const relative = `${directory}/plugin.json`;
    const manifest = await readJsonObject(join(root, relative));
    if (manifest.name !== HACK_MCP_PLUGIN_NAME) {
      issues.push(`hack-mcp:${relative}:name`);
    }
    if (manifest.mcpServers !== "./.mcp.json") {
      issues.push(`hack-mcp:${relative}:mcp`);
    }
    for (const key of ["skills", "hooks", "rules"]) {
      if (key in manifest) {
        issues.push(`hack-mcp:${relative}:${key}`);
      }
    }
  }
  const servers = await readJsonObject(join(root, ".mcp.json"));
  if (!sameJson(servers, renderMcpServers())) {
    issues.push("hack-mcp:.mcp.json:server");
  }
  if (
    !sameJson(
      await readJsonObject(join(root, "mcp.json")),
      portableMcpManifest(servers)
    )
  ) {
    issues.push("hack-mcp:mcp.json:derived");
  }
  if (
    !sameJson(
      await readJsonObject(join(root, "plugin.json")),
      portablePluginManifest(codex)
    )
  ) {
    issues.push("hack-mcp:plugin.json:derived");
  }
  return issues;
}

/**
 * Closed findings for both packages: `hack` ships skills, hooks and rules but
 * no MCP; `hack-mcp` ships exactly the generated MCP declaration. Findings
 * name a package-relative file and a fixed code, never file content.
 */
async function pluginPackageShapeIssues(
  pluginsRoot: string
): Promise<string[]> {
  return [
    ...(await skillsPackageShapeIssues(join(pluginsRoot, HACK_PLUGIN_NAME))),
    ...(await mcpPackageShapeIssues(join(pluginsRoot, HACK_MCP_PLUGIN_NAME))),
  ];
}

test("the hack package is skills-only and hack-mcp carries the only MCP declaration", async () => {
  expect(await pluginPackageShapeIssues(join(repoRoot, "plugins"))).toEqual([]);
  expect(renderMcpServers()).toEqual({
    mcpServers: {
      [HACK_MCP_SERVER.name]: { command: "hack", args: ["mcp", "serve"] },
    },
  });
  const claude = await readJsonObject(
    join(repoRoot, "plugins/hack/.claude-plugin/plugin.json")
  );
  expect(claude.skills).toBe("./skills/");
  expect(claude.hooks).toBe("./hooks/claude-hooks.json");
  const cursor = await readJsonObject(
    join(repoRoot, "plugins/hack/.cursor-plugin/plugin.json")
  );
  expect(cursor.rules).toBe("./rules/");
});

test("negative control: re-adding MCP to the skills package fails the shape check and generation", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hack-plugin-shape-"));
  const pluginsRoot = join(tempDir, "plugins");
  await cp(join(repoRoot, "plugins"), pluginsRoot, { recursive: true });
  const manifestPath = join(pluginsRoot, "hack/.claude-plugin/plugin.json");
  await Bun.write(
    manifestPath,
    JSON.stringify({
      ...(await readJsonObject(manifestPath)),
      mcpServers: "./.mcp.json",
    })
  );
  await Bun.write(
    join(pluginsRoot, "hack/.mcp.json"),
    JSON.stringify(renderMcpServers())
  );
  expect(await pluginPackageShapeIssues(pluginsRoot)).toEqual([
    "hack:.claude-plugin/plugin.json:declares-mcp",
    "hack:.mcp.json:ships-mcp",
  ]);
  await expect(
    generateAgentPlugins({ repoRoot: tempDir, version: "9.8.7" })
  ).rejects.toThrow("skills-only");

  await Bun.write(
    join(pluginsRoot, "hack-mcp/.cursor-plugin/plugin.json"),
    JSON.stringify({ name: HACK_MCP_PLUGIN_NAME, skills: "./skills/" })
  );
  expect(
    await mcpPackageShapeIssues(join(pluginsRoot, HACK_MCP_PLUGIN_NAME))
  ).toEqual([
    "hack-mcp:.cursor-plugin/plugin.json:mcp",
    "hack-mcp:.cursor-plugin/plugin.json:skills",
  ]);
});

test("release generation applies the requested version to both packages", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hack-agent-plugins-"));
  const pluginRoot = join(tempDir, "plugins", HACK_PLUGIN_NAME);
  await seedPluginManifests(pluginRoot);
  // A checkout from before hack-mcp still carries the skills package's MCP files.
  await Bun.write(join(pluginRoot, ".mcp.json"), "{}\n");
  await Bun.write(join(pluginRoot, "mcp.json"), "{}\n");

  await generateAgentPlugins({ repoRoot: tempDir, version: "9.8.7" });

  for (const name of [HACK_PLUGIN_NAME, HACK_MCP_PLUGIN_NAME]) {
    for (const manifestDirectory of manifestDirectories) {
      const manifest = await Bun.file(
        join(tempDir, "plugins", name, manifestDirectory, "plugin.json")
      ).json();
      expect(manifest.version).toBe("9.8.7");
    }
    expect(
      (await Bun.file(join(tempDir, "plugins", name, "plugin.json")).json())
        .version
    ).toBe("9.8.7");
  }
  expect(await Bun.file(join(pluginRoot, ".mcp.json")).exists()).toBe(false);
  expect(await Bun.file(join(pluginRoot, "mcp.json")).exists()).toBe(false);
  expect(
    await mcpPackageShapeIssues(join(tempDir, "plugins", HACK_MCP_PLUGIN_NAME))
  ).toEqual([]);
  expect(
    await Bun.file(
      join(tempDir, "plugins/hack-mcp/.claude-plugin/plugin.json")
    ).json()
  ).toEqual(renderMcpPluginManifests({ version: "9.8.7" }).claude);
});

test("generating twice is a no-op and reproduces the committed packages", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hack-plugin-idempotent-"));
  const pluginsRoot = join(tempDir, "plugins");
  await cp(join(repoRoot, "plugins"), pluginsRoot, { recursive: true });
  const committed = await snapshotTree(join(repoRoot, "plugins"));
  const pkg = await readJsonObject(join(repoRoot, "package.json"));
  const version = String(pkg.version);

  await generateAgentPlugins({ repoRoot: tempDir, version });
  const first = await snapshotTree(pluginsRoot);
  await generateAgentPlugins({ repoRoot: tempDir, version });
  const second = await snapshotTree(pluginsRoot);

  expect(first).toEqual(committed);
  expect(second).toEqual(first);
}, 15_000);

test("docs present the skills-only plugin as default and hack-mcp as opt-in", async () => {
  const read = (path: string) => Bun.file(join(repoRoot, path)).text();
  const readme = await read("README.md");
  expect(readme).not.toContain("sync themselves into");
  expect(readme).toContain("claude plugin install hack@hack-dance");
  expect(readme).toContain("`hack-mcp`");

  const integrations = await read("docs/integrations.md");
  for (const phrase of [
    "`hack-mcp` (`plugins/hack-mcp`)",
    "### One integration path per client",
    "even when the plugin manifest omits",
    "### Upgrading from a plugin that bundled MCP",
    "--sparse .claude-plugin plugins/hack plugins/hack-mcp",
  ]) {
    expect(integrations).toContain(phrase);
  }

  const guide = await read("docs/guides/agent-first-setup.md");
  expect(guide).not.toContain(
    "`hack setup claude` and `hack setup codex` install a thin `hack-init` skill"
  );
  expect(guide).toContain(
    "The optional `hack` plugin ships a thin `hack-init`"
  );

  const pluginReadme = await read("plugins/hack/README.md");
  expect(pluginReadme).not.toContain("mcp_servers.hack");
  expect(pluginReadme).toContain("only when MCP is\nwanted");
});

test("each marketplace lists the hack and hack-mcp packages separately", async () => {
  const sourcePath = (entry: Record<string, unknown>): string =>
    String(isRecord(entry.source) ? entry.source.path : entry.source).replace(
      /^\.\//,
      ""
    );
  for (const path of [
    ".claude-plugin/marketplace.json",
    ".agents/plugins/marketplace.json",
    ".cursor-plugin/marketplace.json",
  ]) {
    const marketplace = await readJsonObject(join(repoRoot, path));
    const entries = Array.isArray(marketplace.plugins)
      ? marketplace.plugins.filter(isRecord)
      : [];
    expect(entries.map((entry) => entry.name)).toEqual([
      HACK_PLUGIN_NAME,
      HACK_MCP_PLUGIN_NAME,
    ]);
    expect(entries.map(sourcePath)).toEqual([
      "plugins/hack",
      "plugins/hack-mcp",
    ]);
  }
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
  expect(assets).toContain("plugins/hack-mcp");
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
  const mcpRoot = join(repoRoot, "plugins", HACK_MCP_PLUGIN_NAME);
  const mcpManifests = renderMcpPluginManifests({ version: pkg.version });
  for (const client of ["codex", "claude", "cursor"] as const) {
    expect(
      await Bun.file(join(mcpRoot, `.${client}-plugin/plugin.json`)).json()
    ).toEqual(mcpManifests[client]);
  }
  expect(await Bun.file(join(mcpRoot, "mcp.json")).json()).toEqual(
    portableMcpManifest(await Bun.file(join(mcpRoot, ".mcp.json")).json())
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
  for (const name of [HACK_PLUGIN_NAME, HACK_MCP_PLUGIN_NAME]) {
    for (const client of ["codex", "claude", "cursor"]) {
      const manifest = await Bun.file(
        join(tempDir, "plugins", name, `.${client}-plugin/plugin.json`)
      ).json();
      expect(manifest.version).toBe("9.8.7");
    }
    expect(
      (await Bun.file(join(tempDir, "plugins", name, "plugin.json")).json())
        .version
    ).toBe("9.8.7");
  }
  const skill = await Bun.file(
    join(tempDir, "plugins/hack/skills/hack-cli/SKILL.md")
  ).text();
  expect(skill).toContain("hack CLI v9.8.7");
  expect(skill).not.toContain("hack CLI v0.0.1");
}, 15_000);

interface PolicyFinding {
  readonly file: string;
  readonly code:
    | "model-setting"
    | "permission-setting"
    | "output-style-setting"
    | "frontmatter-hooks"
    | "hook-command"
    | "unparsed-config";
}

/** How the scan treated one file. Only `parsed` files count as scanned. */
type PolicyScanKind = "parsed" | "not-config";

interface PolicyScan {
  readonly kind: PolicyScanKind;
  readonly findings: readonly PolicyFinding[];
}

const HOOK_COMMAND = "hack agent prime";

/**
 * Generated agent guidance surfaces: the native skills and MCP plugin
 * packages, the client marketplace manifests, the shared `.agents` tree
 * (skills reach it through symlinks) and the agent configuration in the basic
 * example. Example compose and runtime files are application configuration,
 * not agent guidance.
 */
const GUIDANCE_SURFACES = [
  "plugins/hack",
  "plugins/hack-mcp",
  ".claude-plugin",
  ".cursor-plugin",
  ".agents",
  "examples/basic/.claude",
  "examples/basic/.codex",
  "examples/basic/.cursor",
] as const;

/** Structured-config formats the scan cannot parse. Shipping one fails the
 * scan instead of counting it as inspected. */
const UNPARSED_CONFIG_EXTENSIONS = new Set([
  "cfg",
  "conf",
  "env",
  "ini",
  "json5",
  "jsonc",
  "plist",
  "properties",
  "xml",
]);

/** Model, reasoning-effort, permission and output-style policy belongs to the
 * user's provider configuration, never to Hack-shipped artifacts. */
function forbiddenSettingCode(key: string): PolicyFinding["code"] | null {
  const normalized = key.toLowerCase().replace(/[^a-z]/g, "");
  if (
    normalized.startsWith("model") ||
    normalized.endsWith("model") ||
    normalized.includes("effort") ||
    normalized.startsWith("reasoning")
  ) {
    return "model-setting";
  }
  if (
    normalized.includes("permission") ||
    normalized.includes("approval") ||
    normalized.startsWith("sandbox") ||
    normalized === "allowedtools" ||
    normalized === "disallowedtools" ||
    normalized === "yolo"
  ) {
    return "permission-setting";
  }
  if (normalized.includes("outputstyle")) {
    return "output-style-setting";
  }
  return null;
}

/** Hook entries may only run the session primer as a plain command. */
function hasDisallowedHook(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(hasDisallowedHook);
  }
  if (!isRecord(value)) {
    return false;
  }
  if (
    ("type" in value || "command" in value) &&
    !(value.type === "command" && value.command === HOOK_COMMAND)
  ) {
    return true;
  }
  return Object.values(value).some(hasDisallowedHook);
}

function structuredPolicyFindings(
  file: string,
  value: unknown
): PolicyFinding[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => structuredPolicyFindings(file, item));
  }
  if (!isRecord(value)) {
    return [];
  }
  const findings: PolicyFinding[] = [];
  for (const [key, nested] of Object.entries(value)) {
    const code = forbiddenSettingCode(key);
    if (code) {
      findings.push({ file, code });
    }
    if (key === "hooks" && hasDisallowedHook(nested)) {
      findings.push({ file, code: "hook-command" });
    }
    findings.push(...structuredPolicyFindings(file, nested));
  }
  return findings;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/** Parses markdown frontmatter as YAML; returns null when there is none. */
function frontmatter(text: string): unknown {
  const match = FRONTMATTER.exec(text);
  return match ? parseYaml(match[1] ?? "") : null;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** Classify one shipped file with closed codes; never report file content. */
function policyScan(file: string, text: string): PolicyScan {
  const findings: PolicyFinding[] = [];
  const name = file.split("/").at(-1) ?? file;
  if (file.split("/").some((part) => /^output[-_]?styles?$/i.test(part))) {
    findings.push({ file, code: "output-style-setting" });
  }
  const extension = extensionOf(name);
  let parsed: unknown = null;
  let kind: PolicyScanKind = "parsed";
  if (extension === "json") {
    parsed = JSON.parse(text);
  } else if (extension === "jsonl") {
    parsed = text
      .split("\n")
      .filter((line) => line.trim())
      .map((line): unknown => JSON.parse(line));
  } else if (extension === "toml") {
    parsed = Bun.TOML.parse(text);
  } else if (extension === "yaml" || extension === "yml") {
    parsed = parseYaml(text);
  } else if (extension === "md" || extension === "mdc") {
    parsed = frontmatter(text);
    if (parsed === null) {
      kind = "not-config";
    } else if (isRecord(parsed) && "hooks" in parsed) {
      findings.push({ file, code: "frontmatter-hooks" });
    }
  } else {
    kind = "not-config";
    if (
      UNPARSED_CONFIG_EXTENSIONS.has(extension) ||
      name.toLowerCase().startsWith(".env")
    ) {
      findings.push({ file, code: "unparsed-config" });
    }
  }
  findings.push(...structuredPolicyFindings(file, parsed));
  return { kind, findings };
}

function policyFindings(file: string, text: string): PolicyFinding[] {
  return [...policyScan(file, text).findings];
}

test("generated guidance surfaces never pin models, override permissions or run other hooks", async () => {
  const findings: PolicyFinding[] = [];
  const parsedFiles: string[] = [];
  for (const root of GUIDANCE_SURFACES) {
    const glob = new Bun.Glob("**/*");
    for await (const relative of glob.scan({
      cwd: join(repoRoot, root),
      dot: true,
      onlyFiles: true,
      followSymlinks: true,
    })) {
      const file = `${root}/${relative}`;
      const scan = policyScan(
        file,
        await Bun.file(join(repoRoot, file)).text()
      );
      findings.push(...scan.findings);
      if (scan.kind === "parsed") {
        parsedFiles.push(file);
      }
    }
  }
  expect(findings).toEqual([]);
  // Scope guard: every known config surface was actually parsed, including
  // YAML and markdown frontmatter reached through the `.agents` symlinks.
  for (const file of [
    "plugins/hack/plugin.json",
    "plugins/hack-mcp/plugin.json",
    "plugins/hack-mcp/.mcp.json",
    "plugins/hack-mcp/mcp.json",
    "plugins/hack-mcp/.codex-plugin/plugin.json",
    "plugins/hack-mcp/.claude-plugin/plugin.json",
    "plugins/hack-mcp/.cursor-plugin/plugin.json",
    "plugins/hack/.codex-plugin/plugin.json",
    "plugins/hack/.claude-plugin/plugin.json",
    "plugins/hack/.cursor-plugin/plugin.json",
    "plugins/hack/hooks/claude-hooks.json",
    "plugins/hack/rules/hack.mdc",
    "plugins/hack/skills/hack-cli/SKILL.md",
    ".claude-plugin/marketplace.json",
    ".cursor-plugin/marketplace.json",
    ".agents/plugins/marketplace.json",
    ".agents/skills/hack-repo-tla/SKILL.md",
    ".agents/skills/hack-repo-tla/agents/openai.yaml",
    "examples/basic/.claude/settings.json",
    "examples/basic/.codex/config.toml",
    "examples/basic/.cursor/mcp.json",
  ]) {
    expect(parsedFiles).toContain(file);
  }
  expect(parsedFiles.some((file) => file.includes("compose"))).toBe(false);
  expect(
    await Bun.file(
      join(repoRoot, "plugins/hack/hooks/claude-hooks.json")
    ).text()
  ).toContain(HOOK_COMMAND);
});

test("policy scan counts only parsed files and fails closed on unparsed config", () => {
  expect(policyScan("plugins/hack/README.md", "# Hack\n").kind).toBe(
    "not-config"
  );
  expect(policyScan("skills/x/scripts/run", "#!/bin/sh\n").kind).toBe(
    "not-config"
  );
  expect(policyScan("skills/x/SKILL.md", "---\nname: x\n---\n").kind).toBe(
    "parsed"
  );
  expect(policyScan("skills/x/agents/openai.yaml", "a: 1\n").kind).toBe(
    "parsed"
  );
  for (const file of [
    "plugins/hack/settings.ini",
    "plugins/hack/client.conf",
    "plugins/hack/config.jsonc",
    "plugins/hack/.env",
    "plugins/hack/.env.local",
  ]) {
    const scan = policyScan(file, "model=x\n");
    expect(scan.kind).toBe("not-config");
    expect(scan.findings.map((finding) => finding.code)).toEqual([
      "unparsed-config",
    ]);
  }
  expect(() => policyScan("skills/x/agents/openai.yaml", "a: [\n")).toThrow();
});

test("negative control: the policy scan rejects each forbidden setting", () => {
  const cases: readonly (readonly [string, string, PolicyFinding["code"]])[] = [
    ["plugin.json", JSON.stringify({ model: "opus" }), "model-setting"],
    [
      "settings.json",
      JSON.stringify({ env: { x: "1" }, modelOverride: "x" }),
      "model-setting",
    ],
    ["config.toml", 'model = "gpt-5"\n', "model-setting"],
    ["config.toml", 'model_reasoning_effort = "high"\n', "model-setting"],
    ["config.toml", 'reasoning_effort = "high"\n', "model-setting"],
    ["config.toml", 'plan_mode_reasoning_effort = "low"\n', "model-setting"],
    [
      "settings.json",
      JSON.stringify({ env: { CLAUDE_CODE_EFFORT_LEVEL: "high" } }),
      "model-setting",
    ],
    [
      "settings.json",
      JSON.stringify({ reasoning: { effort: "high" } }),
      "model-setting",
    ],
    ["skills/x/SKILL.md", "---\nname: x\neffort: high\n---\n", "model-setting"],
    [
      "skills/x/SKILL.md",
      "---\nname: x\nmetadata:\n  reasoningEffort: high\n---\n",
      "model-setting",
    ],
    ["agents/openai.yaml", "model: gpt-5\n", "model-setting"],
    ["agents/openai.yaml", "model_reasoning_effort: high\n", "model-setting"],
    [
      "agents/openai.yaml",
      "policy:\n  approval_policy: never\n",
      "permission-setting",
    ],
    [
      "agents/openai.yml",
      "sandbox_mode: danger-full-access\n",
      "permission-setting",
    ],
    [
      "hooks/hooks.yaml",
      "hooks:\n  Stop:\n    - type: command\n      command: curl example\n",
      "hook-command",
    ],
    ["config.toml", 'approval_policy = "never"\n', "permission-setting"],
    [
      "config.toml",
      'sandbox_mode = "danger-full-access"\n',
      "permission-setting",
    ],
    [
      "settings.json",
      JSON.stringify({ permissions: { defaultMode: "bypassPermissions" } }),
      "permission-setting",
    ],
    [
      "settings.json",
      JSON.stringify({ outputStyle: "Explanatory" }),
      "output-style-setting",
    ],
    ["output-styles/hack.md", "# Style\n", "output-style-setting"],
    ["skills/x/SKILL.md", "---\nname: x\nmodel: opus\n---\n", "model-setting"],
    [
      "skills/x/SKILL.md",
      "---\nname: x\nallowed-tools: Bash\n---\n",
      "permission-setting",
    ],
    [
      "skills/x/SKILL.md",
      "---\nname: x\nhooks:\n  Stop: []\n---\n",
      "frontmatter-hooks",
    ],
    [
      "hooks/claude-hooks.json",
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              hooks: [
                { type: "command", command: `${HOOK_COMMAND}; curl example` },
              ],
            },
          ],
        },
      }),
      "hook-command",
    ],
    [
      "hooks/claude-hooks.json",
      JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: "prompt", prompt: "x" }] }] },
      }),
      "hook-command",
    ],
  ];
  for (const [file, text, code] of cases) {
    expect(policyFindings(file, text).map((finding) => finding.code)).toContain(
      code
    );
  }
  expect(
    policyFindings(
      "hooks/claude-hooks.json",
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              matcher: "",
              hooks: [{ type: "command", command: HOOK_COMMAND }],
            },
          ],
        },
      })
    )
  ).toEqual([]);
});

test("shipped skill inventory matches the generator and the integration doc", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hack-agent-skills-"));
  const pluginRoot = join(tempDir, "plugins", "hack");
  for (const directory of [
    ".codex-plugin",
    ".claude-plugin",
    ".cursor-plugin",
  ]) {
    await mkdir(join(pluginRoot, directory), { recursive: true });
    await cp(
      join(repoRoot, "plugins/hack", directory, "plugin.json"),
      join(pluginRoot, directory, "plugin.json")
    );
  }
  await generateAgentPlugins({ repoRoot: tempDir, version: "0.0.0" });
  const skillNames = async (root: string) =>
    (await readdir(join(root, "skills"), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  const generated = await skillNames(pluginRoot);
  expect(generated.length).toBeGreaterThan(0);
  expect(await skillNames(join(repoRoot, "plugins/hack"))).toEqual(generated);
  const doc = await Bun.file(join(repoRoot, "docs/integrations.md")).text();
  for (const name of generated) {
    expect(doc).toContain(`\`${name}\``);
  }
  expect(doc).not.toContain("both skills");
}, 15_000);
