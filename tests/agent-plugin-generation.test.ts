import { afterEach, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  generateAgentPlugins,
  portableMcpManifest,
  portablePluginManifest,
  renderPluginRule,
} from "../scripts/generate-agent-plugins.ts";
import { renderCodexSkill } from "../src/agents/codex-skill.ts";
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

interface PolicyFinding {
  readonly file: string;
  readonly code:
    | "model-setting"
    | "permission-setting"
    | "output-style-setting"
    | "frontmatter-hooks"
    | "hook-command";
}

const HOOK_COMMAND = "hack agent prime";

/** Model, permission and output-style policy belongs to the user's provider
 * configuration, never to Hack-shipped artifacts. */
function forbiddenSettingCode(key: string): PolicyFinding["code"] | null {
  const normalized = key.toLowerCase().replace(/[^a-z]/g, "");
  if (normalized.startsWith("model") || normalized.endsWith("model")) {
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

function frontmatterKeys(text: string): string[] {
  const match = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!match?.[1]) {
    return [];
  }
  return match[1]
    .split("\n")
    .map((line) => /^([A-Za-z0-9_-]+):/.exec(line)?.[1])
    .filter((key): key is string => key !== undefined);
}

/** Classify one shipped file with closed codes; never report file content. */
function policyFindings(file: string, text: string): PolicyFinding[] {
  const findings: PolicyFinding[] = [];
  const name = file.split("/").at(-1) ?? file;
  if (file.split("/").some((part) => /^output[-_]?styles?$/i.test(part))) {
    findings.push({ file, code: "output-style-setting" });
  }
  if (name.endsWith(".json")) {
    findings.push(...structuredPolicyFindings(file, JSON.parse(text)));
  } else if (name.endsWith(".jsonl")) {
    for (const line of text.split("\n").filter((entry) => entry.trim())) {
      findings.push(...structuredPolicyFindings(file, JSON.parse(line)));
    }
  } else if (name.endsWith(".toml")) {
    findings.push(...structuredPolicyFindings(file, Bun.TOML.parse(text)));
  } else if (name.endsWith(".md") || name.endsWith(".mdc")) {
    for (const key of frontmatterKeys(text)) {
      const code = forbiddenSettingCode(key);
      if (code) {
        findings.push({ file, code });
      }
      if (key.toLowerCase() === "hooks") {
        findings.push({ file, code: "frontmatter-hooks" });
      }
    }
  }
  return findings;
}

test("plugin bundle and examples never pin models, override permissions or run other hooks", async () => {
  const findings: PolicyFinding[] = [];
  let scanned = 0;
  for (const root of ["plugins/hack", "examples/basic"]) {
    const glob = new Bun.Glob("**/*");
    for await (const relative of glob.scan({
      cwd: join(repoRoot, root),
      dot: true,
      onlyFiles: true,
    })) {
      const file = `${root}/${relative}`;
      findings.push(
        ...policyFindings(file, await Bun.file(join(repoRoot, file)).text())
      );
      scanned += 1;
    }
  }
  expect(scanned).toBeGreaterThan(10);
  expect(findings).toEqual([]);
  expect(
    await Bun.file(
      join(repoRoot, "plugins/hack/hooks/claude-hooks.json")
    ).text()
  ).toContain(HOOK_COMMAND);
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
  await cp(
    join(repoRoot, "plugins/hack/.mcp.json"),
    join(pluginRoot, ".mcp.json")
  );
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
