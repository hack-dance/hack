import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkCodexSkill,
  installCodexSkill,
  renderCodexSkill,
} from "../src/agents/codex-skill.ts";
import {
  checkCursorRules,
  installCursorRules,
  renderCursorRules,
} from "../src/agents/cursor.ts";
import {
  INSTRUCTION_SECTIONS,
  type InstructionSurface,
} from "../src/agents/instruction-source.ts";
import { renderAgentPrimer } from "../src/agents/primer.ts";
import { CLI_SPEC } from "../src/cli/spec.ts";
import {
  checkAgentDocs,
  renderAgentDocsSnippet,
  upsertAgentDocs,
} from "../src/mcp/agent-docs.ts";

const RENDERED_SURFACES: Readonly<Record<InstructionSurface, string>> = {
  docs: renderAgentDocsSnippet(),
  skill: renderCodexSkill(),
  rules: renderCursorRules(),
  primer: renderAgentPrimer(),
};

const TOP_LEVEL_COMMANDS: ReadonlySet<string> = new Set(
  CLI_SPEC.commands.map((command) => command.name)
);

/** Subcommand tokens allowed even though they are not top-level CLI commands. */
const COMMAND_TOKEN_ALLOWLIST: ReadonlySet<string> = new Set([]);

const BACKTICK_SEGMENT_PATTERN = /`([^`]+)`/g;

/**
 * Extract the first subcommand token of every backtick-quoted `hack ...`
 * invocation in a rendered surface. Composite tokens like `up/down` are split
 * so each part is validated individually.
 */
function extractHackSubcommandTokens(rendered: string): string[] {
  const tokens: string[] = [];
  for (const match of rendered.matchAll(BACKTICK_SEGMENT_PATTERN)) {
    const segment = (match[1] ?? "").trim();
    if (!(segment === "hack" || segment.startsWith("hack "))) {
      continue;
    }
    const first = segment.slice("hack ".length).trim().split(/\s+/)[0] ?? "";
    if (first.length === 0 || first.startsWith("-") || first.startsWith("<")) {
      continue;
    }
    for (const part of first.split("/")) {
      if (part.length > 0) {
        tokens.push(part);
      }
    }
  }
  return tokens;
}

let tempDir: string | null = null;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

async function setupTempRepo(): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), "hack-instruction-"));
  return tempDir;
}

test("every documented hack subcommand exists in CLI_SPEC", () => {
  for (const [surface, rendered] of Object.entries(RENDERED_SURFACES)) {
    const unknown = extractHackSubcommandTokens(rendered).filter(
      (token) =>
        !(TOP_LEVEL_COMMANDS.has(token) || COMMAND_TOKEN_ALLOWLIST.has(token))
    );
    expect(
      unknown,
      `surface "${surface}" references unknown hack subcommands`
    ).toEqual([]);
  }
});

test("no stale command patterns in any surface", () => {
  for (const rendered of Object.values(RENDERED_SURFACES)) {
    expect(rendered).not.toContain("hack env exec");
    expect(rendered).not.toMatch(/host exec[^\n]*--service\b/);
  }
});

test("tickets appear at most once, only as an optional extension", () => {
  for (const [surface, rendered] of Object.entries(RENDERED_SURFACES)) {
    const ticketLines = rendered
      .split("\n")
      .filter((line) => /ticket/i.test(line));
    expect(
      ticketLines.length,
      `surface "${surface}" mentions tickets more than once`
    ).toBeLessThanOrEqual(1);
    const only = ticketLines[0];
    if (only !== undefined) {
      expect(only).toContain("hack tickets");
      expect(only).toContain("only use it when the project explicitly uses it");
    }
  }
});

test("all surfaces contain the canonical bullets for their tagged sections", () => {
  const misses: string[] = [];
  for (const section of INSTRUCTION_SECTIONS) {
    for (const surface of section.surfaces) {
      const rendered = RENDERED_SURFACES[surface];
      for (const bullet of section.bullets) {
        if (!rendered.includes(bullet)) {
          misses.push(`${surface}:${section.id}: ${bullet}`);
        }
      }
    }
  }
  expect(misses).toEqual([]);
});

test("linked worktree guidance is present in every surface", () => {
  for (const rendered of Object.values(RENDERED_SURFACES)) {
    expect(rendered).toContain("Linked git worktrees");
    expect(rendered).toContain("HACK_ENV_SECRET_KEY");
    expect(rendered).toContain("worktree.auto_branch=false");
  }
});

test("checkAgentDocs reports missing, present, and stale states", async () => {
  const repoRoot = await setupTempRepo();

  const missing = await checkAgentDocs({
    projectRoot: repoRoot,
    targets: ["agents"],
  });
  expect(missing[0]?.status).toBe("missing");

  await upsertAgentDocs({ projectRoot: repoRoot, targets: ["agents"] });
  const present = await checkAgentDocs({
    projectRoot: repoRoot,
    targets: ["agents"],
  });
  expect(present[0]?.status).toBe("present");

  const docPath = join(repoRoot, "AGENTS.md");
  const content = await Bun.file(docPath).text();
  expect(content).toContain("Standard workflow:");
  await Bun.write(
    docPath,
    content.replace("Standard workflow:", "Old workflow section:")
  );
  const stale = await checkAgentDocs({
    projectRoot: repoRoot,
    targets: ["agents"],
  });
  expect(stale[0]?.status).toBe("stale");
});

test("checkAgentDocs errors when markers are absent from an existing file", async () => {
  const repoRoot = await setupTempRepo();
  await Bun.write(join(repoRoot, "AGENTS.md"), "# My project\n\nNo snippet.\n");

  const results = await checkAgentDocs({
    projectRoot: repoRoot,
    targets: ["agents"],
  });
  expect(results[0]?.status).toBe("error");
});

test("checkCursorRules detects content drift as stale", async () => {
  const repoRoot = await setupTempRepo();
  await installCursorRules({ scope: "project", projectRoot: repoRoot });

  const fresh = await checkCursorRules({
    scope: "project",
    projectRoot: repoRoot,
  });
  expect(fresh.status).toBe("noop");

  const rulesPath = join(repoRoot, ".cursor", "rules", "hack.mdc");
  const content = await Bun.file(rulesPath).text();
  await Bun.write(
    rulesPath,
    content.replace("## Standard workflow", "## Old workflow")
  );
  const stale = await checkCursorRules({
    scope: "project",
    projectRoot: repoRoot,
  });
  expect(stale.status).toBe("stale");
});

test("checkCodexSkill detects content drift as stale", async () => {
  const repoRoot = await setupTempRepo();
  await installCodexSkill({ scope: "project", projectRoot: repoRoot });

  const fresh = await checkCodexSkill({
    scope: "project",
    projectRoot: repoRoot,
  });
  expect(fresh.status).toBe("noop");

  const skillPath = join(repoRoot, ".codex", "skills", "hack-cli", "SKILL.md");
  const content = await Bun.file(skillPath).text();
  await Bun.write(
    skillPath,
    content.replace("## Standard workflow", "## Old workflow")
  );
  const stale = await checkCodexSkill({
    scope: "project",
    projectRoot: repoRoot,
  });
  expect(stale.status).toBe("stale");
});
