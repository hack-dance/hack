import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installClaudeHooks } from "../src/agents/claude.ts";
import { installCodexSkill } from "../src/agents/codex-skill.ts";
import { installCursorRules } from "../src/agents/cursor.ts";
import {
  buildInitAssistantReport,
  renderInitAssistantPrompt,
} from "../src/agents/init-assistant.ts";
import { renderAgentInitPatterns } from "../src/agents/init-patterns.ts";
import { renderAgentPrimer } from "../src/agents/primer.ts";
import { buildSetupSyncScopeResult } from "../src/commands/setup.ts";
import { renderAgentDocsSnippet } from "../src/mcp/agent-docs.ts";

let tempDir: string | null = null;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

test("installCursorRules writes hack.mdc with markers", async () => {
  const repoRoot = await setupTempRepo();
  const result = await installCursorRules({
    scope: "project",
    projectRoot: repoRoot,
  });

  expect(result.status).toBe("created");
  const rulesPath = join(repoRoot, ".cursor", "rules", "hack.mdc");
  const content = await Bun.file(rulesPath).text();
  expect(content).toContain("# BEGIN HACK INTEGRATION");
  expect(content).toContain("hack up --detach");
  expect(content).toContain("Hack v3 is local-first");
  expect(content).toContain("singleton.ports");
  expect(content).not.toContain(".hack/hack.env.json");
});

test("installClaudeHooks writes settings.local.json hooks", async () => {
  const repoRoot = await setupTempRepo();
  const result = await installClaudeHooks({
    scope: "project",
    projectRoot: repoRoot,
  });

  expect(result.status).toBe("updated");
  const settingsPath = join(repoRoot, ".claude", "settings.local.json");
  const settings = JSON.parse(await Bun.file(settingsPath).text()) as Record<
    string,
    unknown
  >;
  const hooks = settings.hooks as Record<string, unknown>;
  const sessionHooks = hooks.SessionStart as Record<string, unknown>[];
  const preCompactHooks = hooks.PreCompact as Record<string, unknown>[];

  expect(containsCommand(sessionHooks, "hack agent prime")).toBe(true);
  expect(containsCommand(preCompactHooks, "hack agent prime")).toBe(true);
});

test("installCodexSkill writes SKILL.md with hack-cli frontmatter", async () => {
  const repoRoot = await setupTempRepo();
  const result = await installCodexSkill({
    scope: "project",
    projectRoot: repoRoot,
  });

  expect(result.status).toBe("created");
  const skillPath = join(repoRoot, ".codex", "skills", "hack-cli", "SKILL.md");
  const content = await Bun.file(skillPath).text();
  expect(content).toContain("name: hack-cli");
  expect(content).toContain("hack setup cursor");
  expect(content).toContain("## Product boundary");
  expect(content).toContain(
    "Experimental and unsupported: remote/gateway/node/dispatch"
  );
  expect(content).toContain("singleton.ports");
  expect(content).not.toContain(".hack/hack.env.json");
});

test("renderAgentPrimer is CLI-first and mentions MCP", () => {
  const primer = renderAgentPrimer();
  expect(primer).toContain("hack up --detach");
  expect(primer).toContain("hack agent init");
  expect(primer).toContain("hack agent patterns");
  expect(primer).toContain("MCP");
  expect(primer).toContain("Supported v3 surface");
  expect(primer).toContain("singleton.ports");
  expect(primer).not.toContain(".hack/hack.env.json");
});

test("renderAgentDocsSnippet reflects local-first v3 boundaries", () => {
  const snippet = renderAgentDocsSnippet();
  expect(snippet).toContain("Supported v3 surface");
  expect(snippet).toContain("built-in GitHub workflows");
  expect(snippet).toContain("built-in Linear sync");
  expect(snippet).toContain("singleton.ports");
  expect(snippet).toContain("HACK_ENV_SECRET_KEY");
  expect(snippet).not.toContain("services/auth-broker");
  expect(snippet).not.toContain(".hack/hack.env.json");
});

test("renderAgentInitPatterns includes dependency signals", () => {
  const patterns = renderAgentInitPatterns();
  expect(patterns).toContain("Postgres");
  expect(patterns).toContain("DATABASE_URL");
  expect(patterns).toContain("docker-compose.yml");
});

test("setup sync collapses healthy artifacts into one scope row", () => {
  const result = buildSetupSyncScopeResult({
    action: "check",
    scope: "Project",
    groups: [
      {
        label: "Cursor",
        results: [{ status: "noop", path: "/repo/.cursor/rules/hack.mdc" }],
      },
      {
        label: "MCP config",
        results: [
          { status: "present", path: "/repo/.cursor/mcp.json" },
          { status: "present", path: "/repo/.codex/config.toml" },
        ],
      },
    ],
  });

  expect(result).toEqual({
    exitCode: 0,
    item: {
      label: "Project",
      status: "ok",
      meta: "3 current",
      detail: undefined,
    },
  });
});

test("setup sync keeps failing artifact paths visible", () => {
  const result = buildSetupSyncScopeResult({
    action: "check",
    scope: "Global",
    groups: [
      {
        label: "Codex",
        results: [{ status: "stale", path: "<home>/.codex/skill.md" }],
      },
      {
        label: "Claude",
        results: [{ status: "noop", path: "<home>/.claude/settings.json" }],
      },
    ],
  });

  expect(result.exitCode).toBe(1);
  expect(result.item).toEqual({
    label: "Global",
    status: "warn",
    meta: "1/2 current",
    detail: "Codex: stale at <home>/.codex/skill.md",
  });
});

test("setup sync treats installed deprecated artifacts as actionable", () => {
  const result = buildSetupSyncScopeResult({
    action: "check",
    scope: "Global",
    groups: [
      {
        label: "Deprecated shared Hack skills",
        results: [
          {
            status: "deprecated",
            path: "<home>/.ai/skills/hack/SKILL.md",
            message: "Deprecated Hack skill is still installed",
          },
          { status: "absent", path: "<home>/.ai/skills/hack-tickets/SKILL.md" },
        ],
      },
    ],
  });

  expect(result).toEqual({
    exitCode: 1,
    item: {
      label: "Global",
      status: "warn",
      meta: "1/2 current",
      detail:
        "Deprecated shared Hack skills: Deprecated Hack skill is still installed",
    },
  });
});

test("buildInitAssistantReport captures repo signals", async () => {
  const repoRoot = await setupTempRepo();
  await Bun.write(
    join(repoRoot, "package.json"),
    JSON.stringify(
      {
        name: "demo",
        scripts: {
          dev: "vite",
          "db:migrate": "prisma migrate dev",
          "db:seed": "prisma db seed",
        },
      },
      null,
      2
    )
  );

  await mkdir(join(repoRoot, "prisma"), { recursive: true });
  await Bun.write(
    join(repoRoot, "prisma", "schema.prisma"),
    "datasource db {}"
  );
  await Bun.write(
    join(repoRoot, "docker-compose.yml"),
    [
      "services:",
      "  api:",
      "    image: node:20",
      "  db:",
      "    image: postgres:16",
    ].join("\n")
  );
  await Bun.write(join(repoRoot, ".env.example"), "EXAMPLE=1\n");

  const report = await buildInitAssistantReport({ repoRoot });

  expect(
    report.composeFiles.some((entry) => entry.services.includes("api"))
  ).toBe(true);
  expect(
    report.setupScripts.some((script) => script.scriptName === "db:migrate")
  ).toBe(true);
  expect(
    report.dbSignals.some((path) => path.includes("prisma/schema.prisma"))
  ).toBe(true);
  expect(report.envFiles).toContain(".env.example");

  const prompt = renderInitAssistantPrompt({ report });
  expect(prompt).toContain("hack init");
  expect(prompt).toContain("docker-compose.yml");
});

async function setupTempRepo(): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), "hack-setup-"));
  return tempDir;
}

function containsCommand(
  hooks: Record<string, unknown>[],
  command: string
): boolean {
  return hooks.some((hook) => {
    const hookEntries = hook.hooks;
    if (!Array.isArray(hookEntries)) {
      return false;
    }
    return hookEntries.some((entry) => {
      if (!entry || typeof entry !== "object") {
        return false;
      }
      return (entry as Record<string, unknown>).command === command;
    });
  });
}
