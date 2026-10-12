import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installCursorRules } from "../src/agents/cursor.ts";
import { installSharedHackSkill } from "../src/agents/shared-skill.ts";
import { inspectAgentIntegrationFreshness } from "../src/cli/integration-sync.ts";

/**
 * Freshness treats optional integrations as current when absent. Every test
 * uses a fixture project root and fixture HOME, never the contributor's HOME.
 */

let root: string | null = null;
let savedHome: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hack-integration-sync-"));
  await mkdir(join(root, "home"), { recursive: true });
  await mkdir(join(root, "repo"), { recursive: true });
  savedHome = process.env.HOME;
  process.env.HOME = join(root, "home");
});

afterEach(async () => {
  if (savedHome === undefined) {
    // biome-ignore lint/performance/noDelete: restoring an unset env var
    delete process.env.HOME;
  } else {
    process.env.HOME = savedHome;
  }
  if (root) {
    await rm(root, { recursive: true, force: true });
    root = null;
  }
});

function fixture(): { readonly repo: string; readonly home: string } {
  if (!root) {
    throw new Error("fixture not initialized");
  }
  return { repo: join(root, "repo"), home: join(root, "home") };
}

async function status(projectRoot: string | null): Promise<string> {
  return (await inspectAgentIntegrationFreshness({ projectRoot })).status;
}

test("empty project and empty HOME are current", async () => {
  const { repo } = fixture();
  expect(await status(repo)).toBe("current");
  expect(await status(null)).toBe("current");
});

test("plugin-only setups without standalone files are current", async () => {
  const { repo, home } = fixture();
  const pluginDir = join(home, ".claude", "plugins", "hack");
  await mkdir(pluginDir, { recursive: true });
  await writeFile(join(pluginDir, "plugin.json"), "{}\n");
  await writeFile(
    join(home, ".claude", "settings.json"),
    `${JSON.stringify({ enabledPlugins: { "hack@hack-dance": true } })}\n`
  );
  await mkdir(join(home, ".codex"), { recursive: true });
  await writeFile(
    join(home, ".codex", "config.toml"),
    '[plugins."hack@hack-dance"]\nenabled = true\n'
  );
  await writeFile(join(repo, "AGENTS.md"), "# Team notes\n");
  await writeFile(join(repo, "CLAUDE.md"), "Use bun.\n");
  await writeFile(
    join(repo, ".mcp.json"),
    `${JSON.stringify({ mcpServers: { other: { command: "other" } } })}\n`
  );

  expect(await status(repo)).toBe("current");
});

test("a current installed integration stays current", async () => {
  const { repo } = fixture();
  await installCursorRules({ scope: "project", projectRoot: repo });
  expect(await status(repo)).toBe("current");
});

test("one stale present file is stale", async () => {
  const { repo } = fixture();
  await installCursorRules({ scope: "project", projectRoot: repo });
  const rules = join(repo, ".cursor", "rules", "hack.mdc");
  await writeFile(rules, `${await Bun.file(rules).text()}\nSTALE-PROBE\n`);
  expect(await status(repo)).toBe("stale");
});

test("a stale Hack-managed agent doc section is stale", async () => {
  const { repo } = fixture();
  await writeFile(
    join(repo, "AGENTS.md"),
    "# Team notes\n<!-- hack:agent-docs:start -->\nold\n<!-- hack:agent-docs:end -->\n"
  );
  expect(await status(repo)).toBe("stale");
});

test("an unreadable MCP config counts as drift", async () => {
  const { repo } = fixture();
  await writeFile(join(repo, ".mcp.json"), "{ not json\n");
  expect(await status(repo)).toBe("stale");
});

test("a retired legacy artifact is stale", async () => {
  const { repo, home } = fixture();
  await writeFile(
    join(repo, "CLAUDE.md"),
    "<!-- hack:tickets:start -->\nRetired\n<!-- hack:tickets:end -->\n"
  );
  expect(await status(repo)).toBe("stale");

  await rm(join(repo, "CLAUDE.md"));
  const legacySkillDir = join(home, ".codex", "skills", "hack-tickets");
  await mkdir(legacySkillDir, { recursive: true });
  await writeFile(
    join(legacySkillDir, "SKILL.md"),
    "---\nname: hack-tickets\n---\n"
  );
  expect(await status(null)).toBe("stale");
});

test("a doc with only the Hack start marker is a corrupted section and stale", async () => {
  const { repo } = fixture();
  await writeFile(
    join(repo, "AGENTS.md"),
    "# notes\n<!-- hack:agent-docs:start -->\nold content without end\n"
  );
  expect(await status(repo)).toBe("stale");
});

test("a doc with only the Hack end marker is a corrupted section and stale", async () => {
  const { repo } = fixture();
  await writeFile(
    join(repo, "CLAUDE.md"),
    "# notes\nold content without start\n<!-- hack:agent-docs:end -->\n"
  );
  expect(await status(repo)).toBe("stale");
});

// Root can read mode-000 files, so the unreadable fixture cannot be built.
const runsAsRoot = process.getuid?.() === 0;

test.skipIf(runsAsRoot)(
  "an installed but unreadable Hack-owned project file counts as drift",
  async () => {
    const { repo } = fixture();
    await installCursorRules({ scope: "project", projectRoot: repo });
    const rules = join(repo, ".cursor", "rules", "hack.mdc");
    expect(await status(repo)).toBe("current");
    await chmod(rules, 0o000);
    try {
      expect(await status(repo)).toBe("stale");
    } finally {
      await chmod(rules, 0o644);
    }
    expect(await status(repo)).toBe("current");
  }
);

test.skipIf(runsAsRoot)(
  "an installed but unreadable Hack-owned HOME file counts as drift",
  async () => {
    const { home } = fixture();
    await installSharedHackSkill();
    const skill = join(home, ".ai", "skills", "hack-cli", "SKILL.md");
    expect(await status(null)).toBe("current");
    await chmod(skill, 0o000);
    try {
      expect(await status(null)).toBe("stale");
    } finally {
      await chmod(skill, 0o644);
    }
  }
);

test.skipIf(runsAsRoot)("an unreadable agent doc counts as drift", async () => {
  const { repo } = fixture();
  const doc = join(repo, "AGENTS.md");
  await writeFile(doc, "# Team notes\n");
  expect(await status(repo)).toBe("current");
  await chmod(doc, 0o000);
  try {
    expect(await status(repo)).toBe("stale");
  } finally {
    await chmod(doc, 0o644);
  }
});
