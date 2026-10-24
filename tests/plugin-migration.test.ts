import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { renderCodexSkill } from "../src/agents/codex-skill.ts";
import { renderCursorRules } from "../src/agents/cursor.ts";
import { renderHackInitSkill } from "../src/agents/hack-init-skill.ts";
import {
  applyPluginMigration,
  type PluginMigrationInput,
  planPluginMigration,
  rollbackPluginMigration,
} from "../src/agents/plugin-migration.ts";
import {
  HACK_PLUGIN_ID,
  type MigrationClient,
} from "../src/agents/plugin-replacement.ts";
import { requireFixtureRoot } from "./helpers/fixture-root.ts";

/**
 * Plugin migration engine (HACK-1132). Every path is under a per-test temp
 * root: a fixture project and a fixture HOME passed explicitly. The process
 * HOME is never read or written.
 */

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hack-plugin-migration-"));
  await mkdir(join(root, "home"), { recursive: true });
  await mkdir(join(root, "repo"), { recursive: true });
});

afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true });
    // A call that outlives its test reads "" and is refused, closed, by
    // requireFixtureRoot instead of writing into the checkout (HACK-1343).
    root = "";
  }
});

const fixture = (): string =>
  requireFixtureRoot(root, "plugin-migration fixture");
const repo = (): string => join(fixture(), "repo");
const home = (): string => join(fixture(), "home");
const backupDir = (): string =>
  join(fixture(), "hack-home", "agent-migrations");

const CUSTOM_SKILL =
  "---\nname: hack-init\n---\nTeam-edited hack-init skill. Keep me.\n";
const UNKNOWN_RULE = "Our own cursor rule without any Hack marker.\n";

async function put(path: string, content: string, mode = 0o644) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  await chmod(path, mode);
}

/** Hack-owned current renders plus customized and unknown neighbours. */
async function seedProject(): Promise<void> {
  await put(
    join(repo(), ".codex/skills/hack-cli/SKILL.md"),
    renderCodexSkill(),
    0o640
  );
  await put(join(repo(), ".codex/skills/hack-init/SKILL.md"), CUSTOM_SKILL);
  await put(
    join(repo(), ".claude/skills/hack-init/SKILL.md"),
    renderHackInitSkill()
  );
  await put(join(repo(), ".cursor/rules/hack.mdc"), UNKNOWN_RULE);
}

async function enableClaude(opts?: {
  readonly skills?: readonly string[];
  readonly settingsRoot?: string;
  readonly settingsFile?: string;
  readonly enabled?: boolean;
}): Promise<void> {
  const installPath = join(fixture(), "claude-plugin-copy");
  for (const skill of opts?.skills ?? ["hack-cli", "hack-init"]) {
    await put(
      join(installPath, "skills", skill, "SKILL.md"),
      `---\nname: ${skill}\n---\n`
    );
  }
  await put(
    join(home(), ".claude/plugins/installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: { [HACK_PLUGIN_ID]: [{ scope: "user", installPath }] },
    })
  );
  await put(
    join(
      opts?.settingsRoot ?? home(),
      ".claude",
      opts?.settingsFile ?? "settings.json"
    ),
    JSON.stringify({
      enabledPlugins: { [HACK_PLUGIN_ID]: opts?.enabled ?? true },
    })
  );
}

async function enableCodex(opts?: {
  readonly configRoot?: string;
  readonly body?: string;
}): Promise<void> {
  await put(
    join(opts?.configRoot ?? home(), ".codex/config.toml"),
    opts?.body ??
      `model = "x"\n\n[plugins."${HACK_PLUGIN_ID}"]\nenabled = true\n`
  );
}

function input(
  overrides: Partial<PluginMigrationInput> = {}
): PluginMigrationInput {
  return {
    scopes: [{ scope: "project", root: repo() }],
    home: home(),
    clients: ["claude", "codex", "cursor"],
    skipPluginCheck: [],
    ...overrides,
  };
}

/** Path to sha/mode for every file and symlink under the fixture root. */
async function snapshotTree(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function visit(path: string): Promise<void> {
    const info = await lstat(path);
    if (info.isDirectory()) {
      for (const name of await readdir(path)) {
        await visit(join(path, name));
      }
      return;
    }
    const body = info.isSymbolicLink()
      ? "symlink"
      : new Bun.CryptoHasher("sha256")
          .update(await readFile(path))
          .digest("hex");
    out.set(path, `${body}:${(info.mode & 0o777).toString(8)}`);
  }
  await visit(fixture());
  return out;
}

function actions(
  plan: Awaited<ReturnType<typeof planPluginMigration>>
): Record<string, string> {
  return Object.fromEntries(
    plan.entries.map((entry) => [
      `${entry.scope}:${entry.target}`,
      entry.reason ? `${entry.action}:${entry.reason}` : entry.action,
    ])
  );
}

function checks(
  plan: Awaited<ReturnType<typeof planPluginMigration>>
): Record<string, string> {
  return Object.fromEntries(
    plan.checks.map((check) => [`${check.scope}:${check.client}`, check.status])
  );
}

test("preview without a plugin blocks owned files, preserves custom ones and writes nothing", async () => {
  await seedProject();
  const before = await snapshotTree();

  const plan = await planPluginMigration(input());

  expect(checks(plan)).toEqual({
    "project:claude": "not-installed",
    "project:codex": "not-installed",
    "project:cursor": "not-inspectable",
  });
  expect(actions(plan)).toEqual({
    "project:cursor-rules": "preserve:missing-ownership-marker",
    "project:claude-hack-init-skill": "blocked",
    "project:codex-hack-cli-skill": "blocked",
    "project:codex-hack-init-skill": "preserve:customized-content",
  });
  for (const entry of plan.entries) {
    expect(entry.message ?? "").not.toContain("Team-edited");
  }
  expect(await snapshotTree()).toEqual(before);
});

test("apply refuses without writing when any owned file lacks a verified replacement", async () => {
  await seedProject();
  await enableClaude();
  const before = await snapshotTree();

  const result = await applyPluginMigration({
    ...input(),
    backupDir: backupDir(),
  });

  expect(result.status).toBe("refused");
  expect(result.status === "refused" && result.reason).toBe("blocked");
  expect(actions(result.plan)["project:codex-hack-cli-skill"]).toBe("blocked");
  expect(actions(result.plan)["project:claude-hack-init-skill"]).toBe("remove");
  expect(await snapshotTree()).toEqual(before);
});

test("verified apply backs up and removes only owned files; rollback restores exact bytes and mode", async () => {
  await seedProject();
  await enableClaude();
  await enableCodex();
  const before = await snapshotTree();
  const codexSkill = join(repo(), ".codex/skills/hack-cli/SKILL.md");
  const claudeSkill = join(repo(), ".claude/skills/hack-init/SKILL.md");

  const result = await applyPluginMigration({
    ...input(),
    backupDir: backupDir(),
    hooks: { id: "fixture" },
  });

  expect(result.status).toBe("applied");
  if (result.status !== "applied") {
    return;
  }
  expect(
    result.results.map((entry) => `${entry.target}:${entry.status}`).sort()
  ).toEqual(["claude-hack-init-skill:removed", "codex-hack-cli-skill:removed"]);
  // The removed skill directories were left empty, so they are gone too.
  await expect(stat(dirname(codexSkill))).rejects.toThrow();
  await expect(stat(dirname(claudeSkill))).rejects.toThrow();
  // Customized and unknown neighbours are byte-identical.
  for (const kept of [
    join(repo(), ".codex/skills/hack-init/SKILL.md"),
    join(repo(), ".cursor/rules/hack.mdc"),
  ]) {
    expect((await snapshotTree()).get(kept)).toBe(before.get(kept));
  }
  expect(result.manifestPath).toBe(join(backupDir(), "fixture.json"));
  expect((await stat(result.manifestPath)).mode & 0o777).toBe(0o600);
  const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
  expect(manifest.state).toBe("applied");
  expect(manifest.entries).toHaveLength(2);

  const rollback = await rollbackPluginMigration({
    manifestPath: result.manifestPath,
  });
  expect(rollback.status).toBe("rolled-back");
  if (rollback.status !== "rolled-back") {
    return;
  }
  expect(rollback.results.map((entry) => entry.status)).toEqual([
    "restored",
    "restored",
  ]);
  const after = await snapshotTree();
  after.delete(result.manifestPath);
  expect(after).toEqual(before);

  const again = await rollbackPluginMigration({
    manifestPath: result.manifestPath,
  });
  expect(
    again.status === "rolled-back" &&
      again.results.every((entry) => entry.status === "already-present")
  ).toBe(true);
});

test("an installed Claude copy without the replacement skills is not a verified replacement", async () => {
  await seedProject();
  await enableClaude({ skills: ["hack-cli"] });

  const plan = await planPluginMigration(input({ clients: ["claude"] }));

  expect(checks(plan)["project:claude"]).toBe("incomplete");
  expect(actions(plan)["project:claude-hack-init-skill"]).toBe("blocked");
});

test("nearest Claude settings decide: a project-local disable overrides a user enable", async () => {
  await seedProject();
  await enableClaude();
  await put(
    join(repo(), ".claude/settings.local.json"),
    JSON.stringify({ enabledPlugins: { [HACK_PLUGIN_ID]: false } })
  );

  const plan = await planPluginMigration(input({ clients: ["claude"] }));

  expect(checks(plan)["project:claude"]).toBe("disabled");
  expect(actions(plan)["project:claude-hack-init-skill"]).toBe("blocked");
});

test("Codex must enable the plugin explicitly; disabled and malformed configs block", async () => {
  await seedProject();
  const codex = { clients: ["codex"] as MigrationClient[] };

  await enableCodex({
    body: `[plugins."${HACK_PLUGIN_ID}"]\nenabled = false\n`,
  });
  expect(checks(await planPluginMigration(input(codex)))["project:codex"]).toBe(
    "disabled"
  );

  await enableCodex({ body: "[plugins\nnot toml" });
  const malformed = await planPluginMigration(input(codex));
  expect(checks(malformed)["project:codex"]).toBe("unreadable");
  expect(actions(malformed)["project:codex-hack-cli-skill"]).toBe("blocked");

  await enableCodex({ body: '[plugins."other@market"]\nenabled = true\n' });
  expect(checks(await planPluginMigration(input(codex)))["project:codex"]).toBe(
    "not-installed"
  );
});

test("project-scope plugin config does not verify user-scope duplicates", async () => {
  await seedProject();
  await put(
    join(home(), ".codex/skills/hack-cli/SKILL.md"),
    renderCodexSkill()
  );
  await put(join(home(), ".ai/skills/hack-cli/SKILL.md"), renderCodexSkill());
  await enableCodex({ configRoot: repo() });
  const scopes = [
    { scope: "project", root: repo() },
    { scope: "global", root: home() },
  ] as const;

  const plan = await planPluginMigration(input({ scopes, clients: ["codex"] }));

  expect(checks(plan)).toEqual({
    "project:codex": "verified",
    "global:codex": "not-installed",
  });
  expect(actions(plan)["project:codex-hack-cli-skill"]).toBe("remove");
  expect(actions(plan)["global:codex-hack-cli-skill"]).toBe("blocked");
  expect(actions(plan)["global:shared-hack-cli-skill"]).toBe("blocked");

  const before = await snapshotTree();
  const result = await applyPluginMigration({
    ...input({ scopes, clients: ["codex"] }),
    backupDir: backupDir(),
  });
  expect(result.status).toBe("refused");
  expect(await snapshotTree()).toEqual(before);
});

test("an explicit skip satisfies Cursor, which Hack cannot inspect", async () => {
  await put(join(repo(), ".cursor/rules/hack.mdc"), renderCursorRules());

  const unskipped = await planPluginMigration(input({ clients: ["cursor"] }));
  expect(actions(unskipped)).toEqual({ "project:cursor-rules": "blocked" });

  const skipped = await planPluginMigration(
    input({ clients: ["cursor"], skipPluginCheck: ["cursor"] })
  );
  expect(checks(skipped)).toEqual({ "project:cursor": "skipped" });
  expect(actions(skipped)).toEqual({ "project:cursor-rules": "remove" });
});

test("client selection limits targets; shared skill follows Claude or Codex", async () => {
  const plan = await planPluginMigration(
    input({ scopes: [{ scope: "global", root: home() }], clients: ["cursor"] })
  );
  expect(Object.keys(actions(plan))).toEqual(["global:cursor-rules"]);

  const codexOnly = await planPluginMigration(
    input({ scopes: [{ scope: "global", root: home() }], clients: ["codex"] })
  );
  expect(Object.keys(actions(codexOnly)).sort()).toEqual([
    "global:codex-hack-cli-skill",
    "global:codex-hack-init-skill",
    "global:shared-hack-cli-skill",
  ]);
});

test("an owned file reached through a symlinked directory is preserved", async () => {
  const real = join(fixture(), "elsewhere", "hack-cli");
  await put(join(real, "SKILL.md"), renderCodexSkill());
  await mkdir(join(repo(), ".codex/skills"), { recursive: true });
  await symlink(real, join(repo(), ".codex/skills/hack-cli"));
  await enableCodex();
  const before = await snapshotTree();

  const result = await applyPluginMigration({
    ...input({ clients: ["codex"] }),
    backupDir: backupDir(),
  });

  expect(actions(result.plan)["project:codex-hack-cli-skill"]).toBe(
    "preserve:symlinked-path"
  );
  expect(result.status).toBe("nothing-to-migrate");
  expect(await snapshotTree()).toEqual(before);
});

test("an interrupted apply leaves a manifest that rollback recovers", async () => {
  await seedProject();
  await enableClaude();
  await enableCodex();
  const before = await snapshotTree();

  await expect(
    applyPluginMigration({
      ...input(),
      backupDir: backupDir(),
      hooks: {
        id: "interrupted",
        beforeRemove: ({ index }) => {
          if (index === 1) {
            return Promise.reject(new Error("simulated interruption"));
          }
          return Promise.resolve();
        },
      },
    })
  ).rejects.toThrow("simulated interruption");

  const manifestPath = join(backupDir(), "interrupted.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  expect(manifest.state).toBe("applying");
  expect(manifest.entries).toHaveLength(2);

  const rollback = await rollbackPluginMigration({ manifestPath });
  expect(
    rollback.status === "rolled-back" &&
      rollback.results.map((entry) => entry.status).sort()
  ).toEqual(["already-present", "restored"]);
  const after = await snapshotTree();
  after.delete(manifestPath);
  expect(after).toEqual(before);
});

test("a file edited after backup is left in place and reported as changed", async () => {
  await seedProject();
  await enableCodex();
  const target = join(repo(), ".codex/skills/hack-cli/SKILL.md");

  const result = await applyPluginMigration({
    ...input({ clients: ["codex"] }),
    backupDir: backupDir(),
    hooks: {
      beforeRemove: async () => {
        await writeFile(target, `${renderCodexSkill()}\nlocal edit\n`);
      },
    },
  });

  expect(result.status === "applied" && result.results).toEqual([
    expect.objectContaining({
      target: "codex-hack-cli-skill",
      status: "changed",
    }),
  ]);
  expect(await readFile(target, "utf8")).toContain("local edit");
});

test("rollback never overwrites a file that reappeared at a restore path", async () => {
  await seedProject();
  await enableClaude();
  await enableCodex();
  const result = await applyPluginMigration({
    ...input(),
    backupDir: backupDir(),
  });
  if (result.status !== "applied") {
    throw new Error("apply did not run");
  }
  const target = join(repo(), ".codex/skills/hack-cli/SKILL.md");
  await put(target, "user replacement\n");

  const rollback = await rollbackPluginMigration({
    manifestPath: result.manifestPath,
  });

  expect(
    rollback.status === "rolled-back" &&
      Object.fromEntries(
        rollback.results.map((entry) => [entry.target, entry.status])
      )
  ).toEqual({
    "claude-hack-init-skill": "restored",
    "codex-hack-cli-skill": "conflict",
  });
  expect(await readFile(target, "utf8")).toBe("user replacement\n");
});

test("rollback refuses a tampered manifest and restores nothing", async () => {
  await seedProject();
  await enableClaude();
  await enableCodex();
  const result = await applyPluginMigration({
    ...input(),
    backupDir: backupDir(),
  });
  if (result.status !== "applied") {
    throw new Error("apply did not run");
  }
  const original = JSON.parse(await readFile(result.manifestPath, "utf8"));
  let count = 0;
  const tamper = async (mutate: (entry: Record<string, unknown>) => void) => {
    const copy = structuredClone(original);
    mutate(copy.entries[0]);
    count += 1;
    const path = join(fixture(), `tampered-${count}.json`);
    await writeFile(path, JSON.stringify(copy));
    return path;
  };
  const cases = [
    await tamper((entry) => {
      entry.path = join(fixture(), "outside", "SKILL.md");
    }),
    await tamper((entry) => {
      entry.contentBase64 = Buffer.from("other bytes").toString("base64");
    }),
    await tamper((entry) => {
      entry.target = "agents-md";
    }),
    // Hack-owned bytes whose recorded digest does not match.
    await tamper((entry) => {
      entry.sha256 = "0".repeat(64);
    }),
    // Consistent digest, but the bytes are not a Hack render.
    await tamper((entry) => {
      const bytes = Buffer.from("---\nname: hack-cli\n---\nnot Hack's\n");
      entry.contentBase64 = bytes.toString("base64");
      entry.sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    }),
  ];
  const before = await snapshotTree();

  for (const manifestPath of cases) {
    const rollback = await rollbackPluginMigration({ manifestPath });
    expect(rollback.status).toBe("invalid-manifest");
  }
  expect(
    (
      await rollbackPluginMigration({
        manifestPath: join(fixture(), "absent.json"),
      })
    ).status
  ).toBe("invalid-manifest");
  expect(await snapshotTree()).toEqual(before);
});

test("an unresolved scope root refuses apply", async () => {
  const result = await applyPluginMigration({
    ...input({ scopes: [{ scope: "global", root: " " }] }),
    backupDir: backupDir(),
  });
  expect(result.status === "refused" && result.reason).toBe("scope-error");
});
