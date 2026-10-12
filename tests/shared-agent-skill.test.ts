import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { renderCodexSkill } from "../src/agents/codex-skill.ts";
import {
  checkSharedHackSkill,
  installSharedHackSkill,
  removeSharedHackSkill,
} from "../src/agents/shared-skill.ts";

let tempHome: string | null = null;
let originalHome: string | undefined;

beforeEach(async () => {
  originalHome = process.env.HOME;
  tempHome = await mkdtemp(join(tmpdir(), "hack-shared-skill-"));
  process.env.HOME = tempHome;
});

afterEach(async () => {
  if (originalHome === undefined) {
    Reflect.deleteProperty(process.env, "HOME");
  } else {
    process.env.HOME = originalHome;
  }
  if (tempHome) {
    await rm(tempHome, { recursive: true, force: true });
    tempHome = null;
  }
});

test("shared Hack skill installs current ticket-free guidance and detects drift", async () => {
  expect((await checkSharedHackSkill()).status).toBe("missing");

  const installed = await installSharedHackSkill();
  expect(installed.status).toBe("created");
  expect(installed.path).toBe(
    join(tempHome ?? "", ".ai", "skills", "hack-cli", "SKILL.md")
  );

  const content = await Bun.file(installed.path).text();
  expect(content).toContain("Integration freshness");
  expect(content).not.toMatch(/hack[ -]?tickets/i);
  expect((await checkSharedHackSkill()).status).toBe("noop");

  await Bun.write(
    installed.path,
    content.replace("Integration freshness", "Old rules")
  );
  const stale = await checkSharedHackSkill();
  expect(stale.status).toBe("stale");
  expect(stale.message).toContain("only the authorized integration");
  expect(stale.message).not.toContain("Run: hack setup sync");
});

/** The shared/Codex `hack-cli` render shipped in v1.1.0. */
const HACK_CLI_V1_1_0 = [
  "---",
  "name: hack-cli",
  "description: >",
  "  Use the hack CLI for local dev environments (docker compose, logs, run commands) and agent integration setup.",
  "  Trigger when asked to start/stop services, open project URLs, inspect logs, run commands in services, manage",
  "  branch instances, or configure agent integrations (Cursor/Claude/Codex/MCP). Prefer CLI over MCP when shell",
  "  access is available.",
  "---",
  "",
  "# hack CLI",
  "",
  "Use hack CLI as the primary interface for local dev.",
  "",
  "## Quick Start",
  "",
  "- Start services: `hack up --detach`",
  "- Open app: `hack open --json`",
  "- Tail logs: `hack logs --pretty`",
  "- Snapshot logs: `hack logs --json --no-follow`",
  "- Run commands: `hack run <service> <cmd...>`",
  "- Stop services: `hack down`",
  "",
  "## Branch Instances",
  "",
  "Use branch instances to run parallel environments:",
  "",
  "- `hack up --branch <name> --detach`",
  "- `hack open --branch <name>`",
  "- `hack logs --branch <name>`",
  "- `hack down --branch <name>`",
  "",
  "## Logs",
  "",
  "- Loki history: `hack logs --loki --since 2h --pretty`",
  "- Filter services: `hack logs --loki --services api,web`",
  "- Force compose logs: `hack logs --compose`",
  "",
  "## Project Targeting",
  "",
  "- Run from repo root when possible.",
  "- Otherwise use `--project <name>` or `--path <repo-root>`.",
  "- List projects: `hack projects --json`.",
  "",
  "## Agent Setup",
  "",
  "- Cursor rules: `hack setup cursor`",
  "- Claude hooks: `hack setup claude`",
  "- Codex skill: `hack setup codex`",
  "- Init prompt: `hack agent init` (use --client cursor|claude|codex to open)",
  "- Init patterns: `hack agent patterns`",
  "- MCP (no shell only): `hack setup mcp`",
  "",
].join("\n");

function sharedSkillPath(): string {
  return join(tempHome ?? "", ".ai", "skills", "hack-cli", "SKILL.md");
}

test("a customized shared Hack skill survives remove and install byte-identical", async () => {
  const path = sharedSkillPath();
  const customized = `${renderCodexSkill()}\n## Personal notes\n- Prefer hack logs --json.\n`;
  await Bun.write(path, customized);

  const removed = await removeSharedHackSkill();
  expect(removed.status).toBe("preserved");
  expect(removed.reason).toBe("customized-content");
  expect(await Bun.file(path).text()).toBe(customized);

  const installed = await installSharedHackSkill();
  expect(installed.status).toBe("preserved");
  expect(installed.message).toContain("unchanged");
  expect(await Bun.file(path).text()).toBe(customized);
});

test("removing the shared Hack skill keeps extra files in its directory", async () => {
  const installed = await installSharedHackSkill();
  const skillDir = dirname(installed.path);
  await Bun.write(join(skillDir, "references", "team.md"), "team notes\n");

  const removed = await removeSharedHackSkill();
  expect(removed.status).toBe("removed");
  expect(await Bun.file(installed.path).exists()).toBe(false);
  expect(await readdir(skillDir)).toEqual(["references"]);
  expect(await Bun.file(join(skillDir, "references", "team.md")).text()).toBe(
    "team notes\n"
  );
});

test("an owned shared Hack skill is removed with its empty directory", async () => {
  const installed = await installSharedHackSkill();
  expect((await removeSharedHackSkill()).status).toBe("removed");
  expect(await readdir(join(tempHome ?? "", ".ai", "skills"))).toEqual([]);
  expect((await removeSharedHackSkill()).status).toBe("missing");
  expect(await Bun.file(installed.path).exists()).toBe(false);
});

test("the shared Hack skill upgrades a prior Hack render", async () => {
  const path = sharedSkillPath();
  await Bun.write(path, HACK_CLI_V1_1_0);

  const installed = await installSharedHackSkill();
  expect(installed.status).toBe("updated");
  expect(await Bun.file(path).text()).toBe(renderCodexSkill());
});

test("a foreign shared skill at the hack-cli path is preserved", async () => {
  const path = sharedSkillPath();
  const foreign = "---\nname: my-cli\n---\n# Mine\n";
  await Bun.write(path, foreign);

  expect((await installSharedHackSkill()).reason).toBe(
    "missing-ownership-marker"
  );
  expect((await removeSharedHackSkill()).status).toBe("preserved");
  expect(await Bun.file(path).text()).toBe(foreign);
});
