import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  checkClaudeHooks,
  installClaudeHooks,
  removeClaudeHooks,
} from "../src/agents/claude.ts";
import {
  checkCodexSkill,
  installCodexSkill,
  removeCodexSkill,
} from "../src/agents/codex-skill.ts";
import {
  checkHackInitSkill,
  installHackInitSkill,
  removeHackInitSkill,
  renderHackInitSkill,
} from "../src/agents/hack-init-skill.ts";

let tempDir: string | null = null;
let originalHome: string | undefined;

beforeEach(() => {
  originalHome = process.env.HOME;
});

afterEach(async () => {
  if (originalHome === undefined) {
    Reflect.deleteProperty(process.env, "HOME");
  } else {
    process.env.HOME = originalHome;
  }
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

async function setupTempDir(): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), "hack-init-skill-"));
  return tempDir;
}

test("renderHackInitSkill is a thin pointer to the CLI prompt source", () => {
  const skill = renderHackInitSkill();
  expect(skill).toContain("name: hack-init");
  expect(skill).toContain("Stand up or adopt hack in a project");
  expect(skill).toContain("hack agent onboard");
  expect(skill).toContain("`hack-init` MCP prompt");
  // Thin: the full onboarding content must NOT be duplicated into the skill.
  expect(skill).not.toContain("node_modules:/app/node_modules");
  expect(skill).not.toContain("## Phase 1");
});

test("installHackInitSkill writes project-scoped skills for both clients", async () => {
  const repoRoot = await setupTempDir();

  const claude = await installHackInitSkill({
    client: "claude",
    scope: "project",
    projectRoot: repoRoot,
  });
  const codex = await installHackInitSkill({
    client: "codex",
    scope: "project",
    projectRoot: repoRoot,
  });

  expect(claude.status).toBe("created");
  expect(codex.status).toBe("created");
  expect(claude.path).toBe(
    join(repoRoot, ".claude", "skills", "hack-init", "SKILL.md")
  );
  expect(codex.path).toBe(
    join(repoRoot, ".codex", "skills", "hack-init", "SKILL.md")
  );

  const content = await Bun.file(claude.path).text();
  expect(content).toContain("name: hack-init");
});

test("installHackInitSkill supports user scope via HOME", async () => {
  const home = await setupTempDir();
  process.env.HOME = home;

  const result = await installHackInitSkill({
    client: "claude",
    scope: "user",
  });

  expect(result.status).toBe("created");
  expect(result.path).toBe(
    join(home, ".claude", "skills", "hack-init", "SKILL.md")
  );
});

test("checkHackInitSkill reports noop, stale, and missing", async () => {
  const repoRoot = await setupTempDir();

  const missing = await checkHackInitSkill({
    client: "codex",
    scope: "project",
    projectRoot: repoRoot,
  });
  expect(missing.status).toBe("missing");

  await installHackInitSkill({
    client: "codex",
    scope: "project",
    projectRoot: repoRoot,
  });
  const fresh = await checkHackInitSkill({
    client: "codex",
    scope: "project",
    projectRoot: repoRoot,
  });
  expect(fresh.status).toBe("noop");

  const skillPath = join(repoRoot, ".codex", "skills", "hack-init", "SKILL.md");
  const content = await Bun.file(skillPath).text();
  await Bun.write(
    skillPath,
    content.replace("hack agent onboard", "hack agent old-command")
  );
  const stale = await checkHackInitSkill({
    client: "codex",
    scope: "project",
    projectRoot: repoRoot,
  });
  expect(stale.status).toBe("stale");
  expect(stale.message).toContain("hack setup codex");
});

test("removeHackInitSkill deletes the skill directory", async () => {
  const repoRoot = await setupTempDir();
  await installHackInitSkill({
    client: "claude",
    scope: "project",
    projectRoot: repoRoot,
  });

  const removed = await removeHackInitSkill({
    client: "claude",
    scope: "project",
    projectRoot: repoRoot,
  });
  expect(removed.status).toBe("removed");

  const gone = await checkHackInitSkill({
    client: "claude",
    scope: "project",
    projectRoot: repoRoot,
  });
  expect(gone.status).toBe("missing");
});

test("installCodexSkill also installs the hack-init skill and detects its drift", async () => {
  const repoRoot = await setupTempDir();

  const installed = await installCodexSkill({
    scope: "project",
    projectRoot: repoRoot,
  });
  expect(installed.status).toBe("created");

  const initSkillPath = join(
    repoRoot,
    ".codex",
    "skills",
    "hack-init",
    "SKILL.md"
  );
  const content = await Bun.file(initSkillPath).text();
  expect(content).toContain("name: hack-init");

  const fresh = await checkCodexSkill({
    scope: "project",
    projectRoot: repoRoot,
  });
  expect(fresh.status).toBe("noop");

  await Bun.write(initSkillPath, content.replace("hack agent onboard", "nope"));
  const stale = await checkCodexSkill({
    scope: "project",
    projectRoot: repoRoot,
  });
  expect(stale.status).toBe("stale");

  const removed = await removeCodexSkill({
    scope: "project",
    projectRoot: repoRoot,
  });
  expect(removed.status).toBe("removed");
  expect(await Bun.file(initSkillPath).exists()).toBe(false);
});

test("installClaudeHooks also installs the hack-init skill and detects its drift", async () => {
  const repoRoot = await setupTempDir();

  const installed = await installClaudeHooks({
    scope: "project",
    projectRoot: repoRoot,
  });
  expect(installed.status).toBe("updated");

  const initSkillPath = join(
    repoRoot,
    ".claude",
    "skills",
    "hack-init",
    "SKILL.md"
  );
  const content = await Bun.file(initSkillPath).text();
  expect(content).toContain("name: hack-init");

  const fresh = await checkClaudeHooks({
    scope: "project",
    projectRoot: repoRoot,
  });
  expect(fresh.status).toBe("noop");

  await Bun.write(initSkillPath, content.replace("hack agent onboard", "nope"));
  const stale = await checkClaudeHooks({
    scope: "project",
    projectRoot: repoRoot,
  });
  expect(stale.status).toBe("stale");

  const removed = await removeClaudeHooks({
    scope: "project",
    projectRoot: repoRoot,
  });
  expect(removed.status).toBe("removed");
  expect(await Bun.file(initSkillPath).exists()).toBe(false);
});
