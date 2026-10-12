import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  INIT_AGENT_EXPORT_CONFIRM,
  INIT_AGENT_EXPORT_OPTIONS,
  type InitAgentExportTarget,
  type InitAgentIntegrationPrompts,
  planInitAgentExport,
  renderInitAgentIntegrationNote,
  runInitAgentIntegrations,
} from "../src/agents/init-agent-integrations.ts";

/**
 * Every test runs against a fixture project root and a fixture HOME so the
 * real installers can execute without touching the contributor's
 * ~/.claude, ~/.codex or ~/.cursor configuration.
 */

const AGENT_PATHS = [
  ".cursor",
  ".claude",
  ".codex",
  "AGENTS.md",
  "CLAUDE.md",
  ".mcp.json",
] as const;

let root: string | null = null;
let savedHome: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hack-init-agents-"));
  await mkdir(join(root, "home"), { recursive: true });
  await mkdir(join(root, "repo", ".hack"), { recursive: true });
  await writeFile(
    join(root, "repo", ".hack", "docker-compose.yml"),
    "services: {}\n"
  );
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

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
    .sort();
}

type PromptLog = {
  notes: string[];
  confirms: { message: string; initialValue: boolean }[];
  multiselects: {
    initialValues: readonly InitAgentExportTarget[];
    required: boolean;
    labels: readonly string[];
  }[];
};

/** Simulates a user pressing Enter on every prompt (accepting each default). */
function defaultAnswerPrompts(log: PromptLog): InitAgentIntegrationPrompts {
  return {
    note: ({ message }) => {
      log.notes.push(message);
    },
    confirm: (opts) => {
      log.confirms.push({ ...opts });
      return Promise.resolve(opts.initialValue);
    },
    multiselect: (opts) => {
      log.multiselects.push({
        initialValues: opts.initialValues,
        required: opts.required,
        labels: opts.options.map((option) => option.label),
      });
      return Promise.resolve([...opts.initialValues]);
    },
  };
}

/** Simulates a user who opts in and selects exactly `selected`. */
function optInPrompts(opts: {
  readonly log: PromptLog;
  readonly selected: readonly InitAgentExportTarget[];
}): InitAgentIntegrationPrompts {
  const base = defaultAnswerPrompts(opts.log);
  return {
    ...base,
    confirm: (confirmOpts) => {
      opts.log.confirms.push({ ...confirmOpts });
      return Promise.resolve(true);
    },
    multiselect: async (selectOpts) => {
      await base.multiselect(selectOpts);
      return [...opts.selected];
    },
  };
}

function emptyLog(): PromptLog {
  return { notes: [], confirms: [], multiselects: [] };
}

const noopGuard = (): Promise<void> => Promise.resolve();

test("default answers print a note and write no agent files", async () => {
  const { repo, home } = fixture();
  const log = emptyLog();
  const before = await listFiles(repo);

  const outcome = await runInitAgentIntegrations({
    repoRoot: repo,
    interactive: true,
    guard: noopGuard,
    prompts: defaultAnswerPrompts(log),
  });

  expect(outcome).toEqual({ kind: "note-only" });
  expect(log.notes).toEqual([renderInitAgentIntegrationNote()]);
  expect(log.notes[0]).toContain("hack agent onboard");
  expect(log.notes[0]).toContain("plugin");
  expect(log.confirms).toHaveLength(1);
  expect(log.confirms[0]?.initialValue).toBe(false);
  expect(log.multiselects).toEqual([]);

  expect(await listFiles(repo)).toEqual(before);
  for (const path of AGENT_PATHS) {
    expect(await Bun.file(join(repo, path)).exists()).toBe(false);
    expect(
      await readdir(join(repo, path)).then(
        () => true,
        () => false
      )
    ).toBe(false);
  }
  expect(await listFiles(home)).toEqual([]);
});

test("export prompt has no preselection and labels repository writes", () => {
  expect(INIT_AGENT_EXPORT_CONFIRM.initialValue).toBe(false);
  for (const option of INIT_AGENT_EXPORT_OPTIONS) {
    expect(option.label).toContain("into this repository");
  }
  expect(INIT_AGENT_EXPORT_OPTIONS.map((option) => option.value)).toEqual([
    "cursor",
    "claude",
    "codex",
    "agents",
    "mcp",
  ]);
});

test("opting in without selecting a target writes nothing", async () => {
  const { repo, home } = fixture();
  const log = emptyLog();
  const before = await listFiles(repo);

  const outcome = await runInitAgentIntegrations({
    repoRoot: repo,
    interactive: true,
    guard: noopGuard,
    prompts: optInPrompts({ log, selected: [] }),
  });

  expect(outcome).toEqual({ kind: "note-only" });
  expect(log.multiselects).toHaveLength(1);
  expect(log.multiselects[0]?.initialValues).toEqual([]);
  expect(log.multiselects[0]?.required).toBe(false);
  expect(await listFiles(repo)).toEqual(before);
  expect(await listFiles(home)).toEqual([]);
});

test("non-interactive init neither prompts nor writes", async () => {
  const { repo, home } = fixture();
  const log = emptyLog();
  const before = await listFiles(repo);
  let guardCalls = 0;

  const outcome = await runInitAgentIntegrations({
    repoRoot: repo,
    interactive: false,
    guard: () => {
      guardCalls += 1;
      return Promise.resolve();
    },
    prompts: defaultAnswerPrompts(log),
  });

  expect(outcome).toEqual({ kind: "skipped" });
  expect(guardCalls).toBe(1);
  expect(log).toEqual(emptyLog());
  expect(await listFiles(repo)).toEqual(before);
  expect(await listFiles(home)).toEqual([]);
});

test("explicit Cursor opt-in writes only the Cursor rules file", async () => {
  const { repo, home } = fixture();
  const log = emptyLog();
  const before = await listFiles(repo);
  let guardCalls = 0;

  const outcome = await runInitAgentIntegrations({
    repoRoot: repo,
    interactive: true,
    guard: () => {
      guardCalls += 1;
      return Promise.resolve();
    },
    prompts: optInPrompts({ log, selected: ["cursor"] }),
  });

  expect(outcome.kind).toBe("exported");
  expect(guardCalls).toBe(2);
  expect(await listFiles(repo)).toEqual(
    [...before, join(".cursor", "rules", "hack.mdc")].sort()
  );
  expect(await listFiles(home)).toEqual([]);
});

test("explicit Claude opt-in writes only Claude project files", async () => {
  const { repo, home } = fixture();
  const before = await listFiles(repo);

  await runInitAgentIntegrations({
    repoRoot: repo,
    interactive: true,
    guard: noopGuard,
    prompts: optInPrompts({ log: emptyLog(), selected: ["claude"] }),
  });

  const added = (await listFiles(repo)).filter(
    (path) => !before.includes(path)
  );
  expect(added.length).toBeGreaterThan(0);
  for (const path of added) {
    expect(path.startsWith(".claude/")).toBe(true);
  }
  expect(added).toContain(join(".claude", "settings.local.json"));
  expect(await listFiles(home)).toEqual([]);
});

test("a failing ownership guard prevents every export write", async () => {
  const { repo, home } = fixture();
  const before = await listFiles(repo);
  let guardCalls = 0;

  await expect(
    runInitAgentIntegrations({
      repoRoot: repo,
      interactive: true,
      guard: () => {
        guardCalls += 1;
        return guardCalls > 1
          ? Promise.reject(new Error("project input changed"))
          : Promise.resolve();
      },
      prompts: optInPrompts({
        log: emptyLog(),
        selected: ["cursor", "claude", "codex", "agents", "mcp"],
      }),
    })
  ).rejects.toThrow("project input changed");

  expect(await listFiles(repo)).toEqual(before);
  expect(await listFiles(home)).toEqual([]);
});

test("planInitAgentExport maps selections to exactly the selected writes", () => {
  expect(planInitAgentExport({ selected: [] })).toEqual({
    cursor: false,
    claude: false,
    codex: false,
    agentDocs: false,
    mcpTargets: [],
  });
  expect(planInitAgentExport({ selected: ["agents"] })).toEqual({
    cursor: false,
    claude: false,
    codex: false,
    agentDocs: true,
    mcpTargets: [],
  });
  expect(planInitAgentExport({ selected: ["claude", "mcp"] })).toEqual({
    cursor: false,
    claude: true,
    codex: false,
    agentDocs: false,
    mcpTargets: ["claude"],
  });
  expect(planInitAgentExport({ selected: ["mcp"] }).mcpTargets).toEqual([
    "cursor",
    "claude",
    "codex",
  ]);
});
