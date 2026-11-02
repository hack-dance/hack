import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { renderCodexSkill } from "../src/agents/codex-skill.ts";
import { renderCursorRules } from "../src/agents/cursor.ts";
import { CliUsageError } from "../src/cli/command.ts";
import { parseSkipPluginCheck } from "../src/commands/setup-migrate.ts";
import { fixtureChildren } from "./helpers/fixture-children.ts";
import { requireFixtureRoot } from "./helpers/fixture-root.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

/**
 * `hack setup migrate` through the source CLI. HOME and HACK_HOME are private
 * fixture directories; the contributor's HOME is never read or written.
 */

const CLI = resolve(import.meta.dir, "..", "index.ts");
/** Each test spawns the source CLI; a cold start under suite load exceeds 5 s. */
const CLI_TEST_TIMEOUT_MS = 60_000;

let root = "";
/**
 * CLI children of the current test. A test that hits its timeout leaves its
 * `runCli` call running; `afterEach` kills and awaits these before it removes
 * the fixture, so no child outlives the test that started it (HACK-1343).
 */
const children = fixtureChildren("setup-migrate-command fixture");

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hack-setup-migrate-"));
  await mkdir(join(root, "repo", ".git"), { recursive: true });
});

afterEach(async () => {
  // Reset first: from here on a late call reads "" and is refused, closed, by
  // requireFixtureRoot instead of resolving paths against the checkout.
  const removed = root;
  root = "";
  await children.stopAll();
  if (removed) {
    await rm(removed, { recursive: true, force: true });
  }
});

const fixture = (): string =>
  requireFixtureRoot(root, "setup-migrate-command fixture");
const repo = (): string => join(fixture(), "repo");
const hackHome = (): string => join(fixture(), "hack-home");

async function put(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

async function runCli(args: readonly string[]): Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  return await children.run({
    cmd: [process.execPath, CLI, "setup", "migrate", ...args],
    cwd: repo(),
    env: privateCliEnv({
      root: fixture(),
      env: { HACK_HOME: hackHome(), NO_COLOR: "1" },
    }),
  });
}

async function snapshotRepo(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function visit(path: string): Promise<void> {
    const info = await lstat(path);
    if (info.isDirectory()) {
      for (const name of await readdir(path)) {
        await visit(join(path, name));
      }
      return;
    }
    out.set(path, await readFile(path, "base64"));
  }
  await visit(repo());
  return out;
}

async function seed(): Promise<{
  readonly owned: string;
  readonly rule: string;
}> {
  const owned = join(repo(), ".codex/skills/hack-cli/SKILL.md");
  const rule = join(repo(), ".cursor/rules/hack.mdc");
  await put(owned, renderCodexSkill());
  await put(rule, `${renderCursorRules()}\nteam addition\n`);
  return { owned, rule };
}

function data(stdout: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(stdout);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("ok" in parsed) ||
    parsed.ok !== true ||
    !("data" in parsed) ||
    typeof parsed.data !== "object" ||
    parsed.data === null
  ) {
    throw new Error("unexpected envelope");
  }
  return parsed.data as Record<string, unknown>;
}

test(
  "preview is read-only, apply refuses unverified replacements, and rollback restores",
  async () => {
    const { owned, rule } = await seed();
    const before = await snapshotRepo();

    const preview = await runCli(["--json"]);
    expect(preview.exitCode).toBe(0);
    const plan = data(preview.stdout);
    expect(plan.action).toBe("preview");
    expect(plan.dryRun).toBe(true);
    expect(plan.counts).toEqual({ preserve: 1, blocked: 1, absent: 2 });
    expect(await snapshotRepo()).toEqual(before);

    const refused = await runCli(["--apply"]);
    expect(refused.exitCode).toBe(1);
    expect(`${refused.stdout}${refused.stderr}`).toContain(
      "Migration refused; nothing was changed."
    );
    expect(await snapshotRepo()).toEqual(before);
    await expect(lstat(join(hackHome(), "agent-migrations"))).rejects.toThrow();

    const applied = await runCli([
      "--apply",
      "--skip-plugin-check",
      "codex,cursor",
      "--json",
    ]);
    expect(applied.exitCode).toBe(0);
    const result = data(applied.stdout);
    expect(result.status).toBe("applied");
    const manifestPath = String(result.manifestPath);
    expect(dirname(manifestPath)).toBe(join(hackHome(), "agent-migrations"));
    await expect(lstat(owned)).rejects.toThrow();
    expect(await readFile(rule, "utf8")).toContain("team addition");

    const rollback = await runCli(["--rollback-manifest", manifestPath]);
    expect(rollback.exitCode).toBe(0);
    expect(rollback.stdout).toContain("1 restored");
    expect(await snapshotRepo()).toEqual(before);
  },
  CLI_TEST_TIMEOUT_MS
);

test(
  "a nonexistent manifest is refused without output of file content",
  async () => {
    const result = await runCli([
      "--rollback-manifest",
      join(fixture(), "missing.json"),
    ]);
    expect(result.exitCode).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "nothing was restored"
    );
  },
  CLI_TEST_TIMEOUT_MS
);

test(
  "rollback rejects scope, client and apply flags",
  async () => {
    for (const extra of [["--apply"], ["--global"], ["--codex"]]) {
      const result = await runCli(["--rollback-manifest", "m.json", ...extra]);
      expect(result.exitCode).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain(
        "--rollback-manifest takes only the manifest path"
      );
    }
  },
  CLI_TEST_TIMEOUT_MS
);

test("--skip-plugin-check accepts only known clients", () => {
  expect(parseSkipPluginCheck(undefined)).toEqual([]);
  expect(parseSkipPluginCheck("all")).toEqual(["claude", "codex", "cursor"]);
  expect(parseSkipPluginCheck(" codex , cursor ")).toEqual(["codex", "cursor"]);
  expect(() => parseSkipPluginCheck("vscode")).toThrow(CliUsageError);
  expect(() => parseSkipPluginCheck(",")).toThrow(CliUsageError);
});
