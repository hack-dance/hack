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
import { renderAgentInitPatterns } from "../src/agents/init-patterns.ts";
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
import {
  extractHackInvocations,
  findGuidanceCommandIssues,
} from "./helpers/cli-guidance-commands.ts";

const RENDERED_SURFACES: Readonly<Record<InstructionSurface, string>> = {
  docs: renderAgentDocsSnippet(),
  skill: renderCodexSkill(),
  rules: renderCursorRules(),
  primer: renderAgentPrimer(),
};

/** Rendered guidance outside the canonical sections that agents also execute. */
const SUPPLEMENTAL_SURFACES: Readonly<Record<string, string>> = {
  "agent patterns": renderAgentInitPatterns(),
};

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

test("every documented hack command path and long flag exists in CLI_SPEC", () => {
  for (const [surface, rendered] of Object.entries({
    ...RENDERED_SURFACES,
    ...SUPPLEMENTAL_SURFACES,
  })) {
    expect(
      extractHackInvocations(rendered).length,
      `surface "${surface}" has no hack invocations to validate`
    ).toBeGreaterThan(0);
    expect(
      findGuidanceCommandIssues({ cli: CLI_SPEC, rendered }),
      `surface "${surface}" references unknown hack commands or flags`
    ).toEqual([]);
  }
});

test("guidance command validator rejects unknown nested subcommands and flags", () => {
  for (const fixture of [
    "`hack env bogus`",
    "`hack up --no-such-flag`",
    "`hack agent patterns --json`",
    "`hack setup claude|bogus`",
    "`hack up/down --json`",
    "`hack bogus`",
  ]) {
    expect(
      findGuidanceCommandIssues({ cli: CLI_SPEC, rendered: fixture }),
      `validator accepted ${fixture}`
    ).not.toEqual([]);
  }
  for (const fixture of [
    "`hack up/down/restart/doctor --json`",
    "`hack init --with claude|codex`",
    "`hack setup claude|codex`",
    "`hack run <service> -- <cmd...> --child-flag`",
    "```sh\nhack logs --no-follow --tail 100\n```",
  ]) {
    expect(
      findGuidanceCommandIssues({ cli: CLI_SPEC, rendered: fixture }),
      `validator rejected ${fixture}`
    ).toEqual([]);
  }
  expect(
    findGuidanceCommandIssues({
      cli: CLI_SPEC,
      rendered: "```sh\nhack env bogus\n```",
    })
  ).not.toEqual([]);
});

test("canonical guidance states run separators, adopt limits, and pipe hazards", () => {
  for (const [surface, rendered] of Object.entries(RENDERED_SURFACES)) {
    expect(rendered, `surface "${surface}"`).toContain(
      "`hack run <service> -- <cmd...>`"
    );
    expect(rendered, `surface "${surface}"`).not.toContain(
      "`hack run <service> <cmd...>`"
    );
    expect(rendered, `surface "${surface}"`).toContain(
      "do not pipe `hack` output through `| tail` or `| grep`"
    );
  }
  for (const surface of ["docs", "skill"] as const) {
    const rendered = RENDERED_SURFACES[surface];
    expect(rendered).toContain(
      "Adopt only checks that every configured singleton port is already occupied; that is not a health, identity, or readiness check"
    );
    expect(rendered).toContain("`lifecycle.up.before` identity check");
    expect(rendered).not.toContain("reuses a healthy existing listener");
  }
  expect(renderAgentInitPatterns()).toContain(
    "`hack run <service> -- <cmd...>`"
  );
});

test("no stale command patterns in any surface", () => {
  for (const rendered of Object.values(RENDERED_SURFACES)) {
    expect(rendered).not.toContain("hack env exec");
    expect(rendered).not.toMatch(/host exec[^\n]*--service\b/);
  }
});

test("retired Tickets do not appear in generated agent guidance", () => {
  for (const [surface, rendered] of Object.entries(RENDERED_SURFACES)) {
    expect(
      rendered,
      `surface "${surface}" mentions retired Tickets`
    ).not.toMatch(/hack[ -]?tickets|dance\.hack\.tickets/i);
  }
});

test("active contributor guidance and examples do not advertise retired Tickets", async () => {
  const guidancePaths = [
    "AGENTS.md",
    ".hack/README.md",
    ".ai/skills/hack-repo-code-quality/SKILL.md",
    ".ai/skills/hack-repo-verify/SKILL.md",
  ];
  const retiredGuidancePattern =
    /`hack(?: x)? tickets\b|optional local tickets|tickets extension|dance\.hack\.tickets/i;
  for (const path of guidancePaths) {
    const content = await Bun.file(path).text();
    expect(content, `${path} advertises retired Tickets`).not.toMatch(
      retiredGuidancePattern
    );
  }

  for (const path of [
    ".hack/hack.config.json",
    "examples/basic/.hack/hack.config.json",
  ]) {
    const content = await Bun.file(path).text();
    expect(content, `${path} configures a retired extension`).not.toMatch(
      /dance\.hack\.(?:github|linear|tickets)/
    );
  }
  expect(await Bun.file("examples/tickets/README.md").exists()).toBe(false);
});

test("rendered guidance retires automatic instructions and freshness", () => {
  for (const rendered of Object.values(RENDERED_SURFACES)) {
    expect(rendered).not.toContain("Integration freshness");
    expect(rendered).not.toContain("hack setup sync");
    expect(rendered).toContain("does not inject project instructions");
    expect(rendered).toContain(
      "Existing customized and legacy files are preserved"
    );
  }
});

test("optional plugin uses current guidance without updating contributor or historical examples", async () => {
  const content = await Bun.file(
    "plugins/hack/skills/hack-cli/SKILL.md"
  ).text();
  expect(content).toContain("explicit opt-ins");
  expect(content).not.toContain("Integration freshness");
});

test("rendered guidance has no runtime freshness marker requirement", () => {
  for (const rendered of Object.values(RENDERED_SURFACES)) {
    expect(rendered).not.toContain("Content revision:");
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

test("agent guidance retains explicit skills and independently selected MCP", () => {
  const section = INSTRUCTION_SECTIONS.find(
    (section) => section.id === "agent-setup"
  );
  expect(section).toBeDefined();
  const text = section?.bullets.join("\n");
  expect(text).toContain("invoke its skills");
  expect(text).toContain("no automatic hooks, rules or MCP server");
  expect(text).toContain("verified executable and candidate bundle selection");
  expect(text).toContain("never injects AGENTS.md or CLAUDE.md");
});

test("linked worktree guidance is present in every surface", () => {
  for (const rendered of Object.values(RENDERED_SURFACES)) {
    expect(rendered).toContain("Linked git worktrees");
    expect(rendered).toContain("HACK_ENV_SECRET_KEY");
    expect(rendered).toContain("detached linked worktree");
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

test("contributors share one baseline without per-edit repository-wide hooks", async () => {
  expect((await Bun.file("CLAUDE.md").text()).trim()).toBe("@AGENTS.md");
  expect(await Bun.file(".claude/CLAUDE.md").exists()).toBe(false);
  expect(await Bun.file(".cursor/hooks.json").exists()).toBe(false);
  const settings = await Bun.file(".claude/settings.json").json();
  expect(settings.hooks).toBeUndefined();
});

test("rendered routing guidance distinguishes new defaults and legacy aliases", () => {
  for (const surface of ["docs", "skill", "primer"] as const) {
    expect(RENDERED_SURFACES[surface]).toContain(
      "new-project default: `<project>.hack.local`"
    );
    expect(RENDERED_SURFACES[surface]).toContain(
      "legacy `.hack` fallbacks remain supported"
    );
    expect(RENDERED_SURFACES[surface]).toContain("`<project>.hack.gy`");
    expect(RENDERED_SURFACES[surface]).not.toContain(
      "default: `<project>.hack`)"
    );
  }
});
