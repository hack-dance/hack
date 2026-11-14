import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { renderCodexSkill } from "../src/agents/codex-skill.ts";
import { HACK_PLUGIN_ID } from "../src/agents/plugin-replacement.ts";
import { withProjectsRegistryLock } from "../src/lib/projects-registry-lock.ts";
import { runUpgradeApply } from "../src/lib/upgrade-apply.ts";
import {
  runUpgradeCheck,
  type UpgradeCheckReport,
} from "../src/lib/upgrade-check.ts";
import type { UpgradeCheckProbes } from "../src/lib/upgrade-check-probes.ts";
import { renderUpgradeCheck } from "../src/lib/upgrade-check-render.ts";
import {
  listUpgradeSnapshots,
  readUpgradeSnapshotJournal,
  restoreUpgradeSnapshot,
} from "../src/lib/upgrade-snapshot.ts";
import { collectUpgradeSnapshotTargets } from "../src/lib/upgrade-snapshot-targets.ts";
import { restoreEnv } from "./helpers/env.ts";
import { fixtureGitEnv } from "./helpers/fixture-git.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

// Values that must never appear in any report, plan, journal or output.
const SENTINEL = ["sentinel", "upgrade", "apply", "7b2e19"].join("-");
const ENTRYPOINT = resolve(import.meta.dir, "..", "index.ts");

const ISOLATED_ENV = [
  "HOME",
  "HACK_HOME",
  "HACK_GLOBAL_CONFIG_PATH",
  "HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK",
  "HACK_SECRETS_FILE_KEY",
  "HACK_ENV_SECRET_KEY",
] as const;
const saved = new Map<string, string | undefined>();
let root = "";
let home = "";
let hackHome = "";

beforeEach(async () => {
  for (const key of ISOLATED_ENV) {
    saved.set(key, process.env[key]);
  }
  root = await realpath(await mkdtemp(join(tmpdir(), "hack-upgrade-apply-")));
  home = join(root, "user-home");
  hackHome = join(home, ".hack");
  await mkdir(hackHome, { recursive: true });
  process.env.HOME = home;
  process.env.HACK_HOME = hackHome;
  process.env.HACK_GLOBAL_CONFIG_PATH = join(hackHome, "hack.config.json");
  process.env.HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK = "1";
  Reflect.deleteProperty(process.env, "HACK_SECRETS_FILE_KEY");
  Reflect.deleteProperty(process.env, "HACK_ENV_SECRET_KEY");
});

afterEach(async () => {
  for (const key of ISOLATED_ENV) {
    restoreEnv(key, saved.get(key));
  }
  await rm(root, { recursive: true, force: true });
});

type Worktree = { path: string; branch: string; lastSeenAt: string };
type Entry = {
  id: string;
  name: string;
  repoRoot: string;
  projectDirName: ".hack";
  projectDir: string;
  createdAt: string;
  worktrees?: Worktree[];
};

function git(dir: string, args: readonly string[]) {
  const result = Bun.spawnSync(["git", "-C", dir, ...args], {
    env: fixtureGitEnv({ env: { HOME: home } }),
  });
  if (result.exitCode !== 0) {
    throw new Error(`fixture git ${args[0]} failed`);
  }
}

/** A Git checkout with a Hack config and no .hack/.gitignore. */
async function checkout(dir: string, name: string): Promise<void> {
  await mkdir(join(dir, ".hack"), { recursive: true });
  await writeFile(
    join(dir, ".hack", "hack.config.json"),
    `${JSON.stringify({ name, dev_host: `${name}.hack` })}\n`
  );
  git(dir, ["init", "-q"]);
}

async function project(
  name: string,
  worktrees = 0
): Promise<Entry & { checkouts: string[] }> {
  const repoRoot = join(root, "repos", name);
  await checkout(repoRoot, name);
  const trees: Worktree[] = [];
  for (let i = 0; i < worktrees; i += 1) {
    const path = join(root, "worktrees", name, `wt${i}`);
    await checkout(path, name);
    trees.push({
      path,
      branch: `wt${i}`,
      lastSeenAt: "2026-01-01T00:00:00.000Z",
    });
  }
  return {
    id: `id-${name}`,
    name,
    repoRoot,
    projectDirName: ".hack",
    projectDir: join(repoRoot, ".hack"),
    createdAt: "2026-01-01T00:00:00.000Z",
    ...(trees.length > 0 ? { worktrees: trees } : {}),
    checkouts: [repoRoot, ...trees.map((t) => t.path)],
  };
}

function dead(name: string): Entry {
  const repoRoot = join(root, "gone", name);
  return {
    id: `id-${name}`,
    name,
    repoRoot,
    projectDirName: ".hack",
    projectDir: join(repoRoot, ".hack"),
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

async function writeRegistry(
  projects: readonly (Entry & { checkouts?: string[] })[]
): Promise<void> {
  const entries = projects.map(({ checkouts: _unused, ...entry }) => entry);
  await writeFile(
    join(hackHome, "projects.json"),
    `${JSON.stringify({ version: 1, projects: entries })}\n`
  );
}

function healthyProbes(): UpgradeCheckProbes {
  return {
    pathHack: async () => ({
      path: "/usr/local/bin/hack",
      install: "standalone",
      version: "4.3.0",
    }),
    daemon: async () => ({
      manager: "systemd",
      registered: true,
      enabled: true,
      running: true,
      managed: true,
      summary: "installed, enabled, active (pid 42)",
      severity: "ok",
      nextStep: null,
    }),
    docker: async () => "reachable",
    globalInfra: async () => ({ installed: true, running: true }),
    linuxDns: async () => null,
    proxyPorts: async () => ({
      name: "proxy ports",
      status: "ok",
      message: "Ports 80 and 443 reach Hack's proxy.",
      verified: true,
      reachable: true,
    }),
    nativePreflight: async () => null,
  };
}

async function check(): Promise<UpgradeCheckReport> {
  return await runUpgradeCheck({
    cliVersion: "5.0.0-next.17",
    homeDir: home,
    probes: healthyProbes(),
    build: "source",
    budgetMs: 180_000,
  });
}

/** Every file under `dir`: path, mode and digest, for a no-change proof. */
async function tree(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (current: string) => {
    for (const name of (await readdir(current)).sort()) {
      const path = join(current, name);
      const info = await lstat(path);
      if (info.isDirectory()) {
        out.push(`${path}/ ${info.mode & 0o7777}`);
        await walk(path);
      } else if (info.isFile()) {
        const digest = createHash("sha256")
          .update(await readFile(path))
          .digest("hex");
        out.push(`${path} ${info.mode & 0o7777} ${digest}`);
      } else {
        out.push(`${path} link`);
      }
    }
  };
  await walk(dir);
  return out;
}

/** A stale standalone Hack skill under HOME: every checkout reports stale agent files. */
async function staleHomeAgentFile(): Promise<string> {
  const path = join(home, ".codex", "skills", "hack-cli", "SKILL.md");
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, "# hack-cli\nan old standalone skill\n");
  return path;
}

test("100 checkouts fit one screen: summary first, worktrees folded, plan grouped by kind", async () => {
  await staleHomeAgentFile();
  const projects: (Entry & { checkouts: string[] })[] = [];
  for (let i = 0; i < 25; i += 1) {
    const name = `app-${String(i).padStart(2, "0")}`;
    const made = await project(name, 3);
    // Mixed findings: legacy env in some, a tracked env file in others.
    if (i % 3 === 0) {
      for (const dir of made.checkouts) {
        await writeFile(join(dir, ".hack", "hack.env.json"), "{}\n");
        await writeFile(join(dir, ".hack", ".env"), `TOKEN=${SENTINEL}\n`);
      }
    }
    if (i % 5 === 0) {
      git(made.repoRoot, ["add", "-f", ".hack/hack.config.json"]);
      git(made.repoRoot, ["commit", "-q", "-m", "fixture"]);
      await writeFile(join(made.projectDir, ".env"), `TOKEN=${SENTINEL}\n`);
      git(made.repoRoot, ["add", "-f", ".hack/.env"]);
      git(made.repoRoot, ["commit", "-q", "-m", "tracked"]);
    }
    projects.push(made);
  }
  // One blocker: an env layer that is a dangling link.
  await symlink(
    join(root, "nowhere.yaml"),
    join(projects[7]?.checkouts[2] as string, ".hack", "hack.env.default.yaml")
  );
  const deadEntries = Array.from({ length: 12 }, (_, i) =>
    dead(`old-${String(i).padStart(2, "0")}`)
  );
  await writeRegistry([...projects, ...deadEntries]);

  const report = await check();
  expect(report.report_version).toBe(2);
  expect(report.registry.total).toBe(112);
  expect(report.registry.live).toBe(100);
  // Stale agent files and the missing .gitignore are one step each.
  const agent = report.plan.find((s) => s.id === "agent-integrations");
  expect(agent?.count).toBe(100);
  expect(agent?.applies).toBe(true);
  expect(agent?.command).toBe("hack upgrade apply --only agent-integrations");
  expect(agent?.targets).toHaveLength(100);
  const ignore = report.plan.find(
    (s) => s.id === "ignore-rules" && s.status === "warn"
  );
  expect(ignore?.applies).toBe(true);
  expect(ignore?.count).toBeGreaterThan(90);
  // A manual step over several checkouts names one command pattern.
  const legacy = report.plan.find((s) => s.id === "env-format");
  expect(legacy?.blocker).toBe(true);
  expect(report.plan.filter((s) => s.id === "env-format")).toHaveLength(1);
  expect(legacy?.command).toBeNull();
  expect(legacy?.action).toContain("checkout");
  expect(
    legacy?.targets.some((target) =>
      target.command?.includes("doctor --migrate-env-config")
    )
  ).toBe(true);
  expect(report.plan.length).toBeLessThanOrEqual(10);

  const text = renderUpgradeCheck(report);
  const lines = text.trimEnd().split("\n");
  expect(lines.length).toBeLessThanOrEqual(60);
  expect(lines[0]).toBe(
    "hack 5.0.0-next.17 (next channel; SOURCE BUILD, not an installed release)"
  );
  // Dead entries are one line with the prune preview, never listed.
  expect(text).toContain(
    "12 dead registry entries (checkout or config gone): hack projects prune --dry-run"
  );
  expect(text).not.toContain("old-03");
  // Worktrees fold under their project.
  expect(text).toContain("app-07 (+3 worktrees): ");
  const projectLines = lines.filter((line) =>
    /^ {2}(BLOCK|warn |UNCHK) app-/.test(line)
  );
  expect(projectLines.length).toBeLessThanOrEqual(13);
  expect(projectLines.some((line) => line.includes("(worktree"))).toBe(false);
  expect(text).toContain("stale agent files, 100 checkouts (apply): ");
  expect(text).toContain("Blocked by: app-07 (worktree wt1) env-format");
  expect(text).toContain("Next: hack upgrade snapshot");
  expect(text).not.toContain(SENTINEL);
  expect(JSON.stringify(report)).not.toContain(SENTINEL);

  // --verbose has every checkout and the dead entries.
  const verbose = renderUpgradeCheck(report, { verbose: true });
  expect(verbose).toContain("old-03");
  expect(verbose).toContain("Checkout app-07 (worktree wt1)");
  expect(verbose).not.toContain(SENTINEL);
}, 180_000);

test("apply --dry-run changes nothing; apply snapshots, journals, refreshes .gitignore and skips blocked checkouts", async () => {
  const agentFile = await staleHomeAgentFile();
  const a = await project("app-a", 1);
  const b = await project("app-b");
  const blocked = await project("app-blocked");
  await writeFile(join(a.projectDir, ".env"), `TOKEN=${SENTINEL}\n`);
  await symlink(
    join(root, "nowhere.yaml"),
    join(blocked.projectDir, "hack.env.default.yaml")
  );
  await writeRegistry([a, b, blocked]);

  const report = await check();
  const before = await tree(root);
  const dry = await runUpgradeApply({
    report,
    dryRun: true,
    home,
    collect: collectUpgradeSnapshotTargets,
  });
  expect(dry.status).toBe("dry-run");
  expect(await tree(root)).toEqual(before);
  if (dry.status !== "dry-run") {
    throw new Error("unreachable");
  }
  const ignorePlanned = dry.targets.filter((t) => t.fix === "ignore-rules");
  expect(ignorePlanned.map((t) => `${t.scope}: ${t.status}`).sort()).toEqual([
    "app-a (worktree wt0): planned",
    "app-a: planned",
    "app-b: planned",
    "app-blocked: skipped",
  ]);

  // --project narrows to one project and its worktrees.
  const one = await runUpgradeApply({
    report,
    dryRun: true,
    project: "app-a",
    only: ["ignore-rules"],
    home,
    collect: collectUpgradeSnapshotTargets,
  });
  expect(
    one.status === "dry-run" ? one.targets.map((t) => t.scope).sort() : []
  ).toEqual(["app-a", "app-a (worktree wt0)"]);
  expect(
    await runUpgradeApply({
      report,
      dryRun: true,
      project: "nope",
      home,
      collect: collectUpgradeSnapshotTargets,
    })
  ).toMatchObject({ status: "refused", reason: "unknown-project" });
  expect(await tree(root)).toEqual(before);

  const applied = await runUpgradeApply({
    report,
    dryRun: false,
    home,
    collect: collectUpgradeSnapshotTargets,
    agentBackupDir: join(hackHome, "agent-migrations"),
  });
  if (applied.status !== "applied" && applied.status !== "partial") {
    throw new Error(`apply did not run: ${applied.status}`);
  }
  const byKey = new Map(
    applied.targets.map((t) => [`${t.fix} ${t.scope}`, t.status])
  );
  expect(byKey.get("ignore-rules app-a")).toBe("applied");
  expect(byKey.get("ignore-rules app-a (worktree wt0)")).toBe("applied");
  expect(byKey.get("ignore-rules app-b")).toBe("applied");
  expect(byKey.get("ignore-rules app-blocked")).toBe("skipped");
  // The blocked checkout was not touched.
  expect(
    await lstat(join(blocked.projectDir, ".gitignore")).catch(() => null)
  ).toBeNull();
  const gitignore = join(a.projectDir, ".gitignore");
  expect(await readFile(gitignore, "utf8")).toContain(".env");
  // The stale agent file under HOME is never removed without a verified plugin.
  expect(byKey.get("agent-integrations machine")).toMatch(
    /^(refused|unchanged)$/
  );
  expect(await readFile(agentFile, "utf8")).toContain("old standalone");
  // A skipped checkout makes the run partial.
  expect(applied.status).toBe("partial");

  // The journal sits beside the snapshot manifest, private, with coverage.
  const journalInfo = await stat(applied.journal_path);
  expect(journalInfo.mode & 0o777).toBe(0o600);
  const journal = (await readUpgradeSnapshotJournal({
    manifestPath: applied.coverage.manifest_path,
  })) as {
    kind: string;
    state: string;
    snapshot: { complete: boolean; gaps: unknown; files: number };
    targets: { scope: string; status: string }[];
  };
  expect(journal.kind).toBe("hack-upgrade-apply");
  expect(journal.state).toBe("failed");
  // The blocked checkout's linked env layer is not kept: a named gap.
  expect(journal.snapshot.complete).toBe(false);
  expect(journal.snapshot.gaps).toEqual(applied.coverage.gaps);
  expect(
    applied.coverage.gaps.some((gap) => gap.name.includes("app-blocked"))
  ).toBe(true);
  expect(journal.snapshot.files).toBe(applied.coverage.files);
  expect(journal.targets).toHaveLength(applied.targets.length);
  expect(journal.targets.some((t) => t.status === "planned")).toBe(false);
  const journalText = await readFile(applied.journal_path, "utf8");
  expect(journalText).not.toContain(SENTINEL);
  expect(JSON.stringify(applied)).not.toContain(SENTINEL);

  // The snapshot recorded what apply wrote, so rollback needs no --overwrite.
  const restored = await restoreUpgradeSnapshot({
    manifestPath: applied.coverage.manifest_path,
    overwrite: false,
  });
  expect(restored.status).toBe("restored");
  expect(await lstat(gitignore).catch(() => null)).toBeNull();
}, 120_000);

test("a snapshot with gaps is recorded in the journal as not complete", async () => {
  const a = await project("app-a");
  // A link at an env path the snapshot keeps: skipped, so a gap.
  await symlink(join(root, "elsewhere"), join(a.projectDir, ".env"));
  await writeRegistry([a]);
  const report = await check();
  const applied = await runUpgradeApply({
    report,
    dryRun: false,
    only: ["ignore-rules"],
    home,
    collect: collectUpgradeSnapshotTargets,
  });
  if (applied.status !== "applied") {
    throw new Error(`apply did not run: ${applied.status}`);
  }
  expect(applied.coverage.complete).toBe(false);
  expect(applied.coverage.gaps.length).toBeGreaterThan(0);
  const journal = (await readUpgradeSnapshotJournal({
    manifestPath: applied.coverage.manifest_path,
  })) as { snapshot: { complete: boolean; gaps: unknown } };
  expect(journal.snapshot.complete).toBe(false);
  expect(journal.snapshot.gaps).toEqual(applied.coverage.gaps);
}, 60_000);

test("--only refuses an unknown step before anything is written", async () => {
  const a = await project("app-a");
  await writeRegistry([a]);
  const report = await check();
  const before = await tree(root);
  expect(
    await runUpgradeApply({
      report,
      dryRun: false,
      only: ["env-format"],
      home,
      collect: collectUpgradeSnapshotTargets,
    })
  ).toMatchObject({ status: "refused", reason: "unknown-fix" });
  expect(await tree(root)).toEqual(before);
}, 60_000);

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function cli(args: readonly string[]) {
  const child = Bun.spawn([process.execPath, ENTRYPOINT, ...args], {
    cwd: root,
    env: privateCliEnv({
      root,
      home,
      env: {
        HACK_HOME: hackHome,
        HACK_GLOBAL_CONFIG_PATH: join(hackHome, "hack.config.json"),
        HACK_SYSTEMD_DISABLE: "1",
        HACK_HOST_PROBES_DISABLE: "1",
        HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK: "1",
        HACK_NO_INTERACTIVE: "1",
      },
    }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr, output: `${stdout}${stderr}` };
}

test("hack upgrade apply: --dry-run lists, apply prints the journal and rollback, check names the source build", async () => {
  const a = await project("app-a");
  await writeFile(join(a.projectDir, ".env"), `TOKEN=${SENTINEL}\n`);
  await writeRegistry([a, dead("old-one")]);

  const checked = await cli(["upgrade", "check"]);
  expect(checked.stdout.split("\n")[0]).toContain("SOURCE BUILD");
  expect(checked.stdout).toContain("1 dead registry entry");
  expect(checked.stdout).not.toContain("old-one");
  const verbose = await cli(["upgrade", "check", "--verbose"]);
  expect(verbose.stdout).toContain("old-one");

  const before = await tree(root);
  const dry = await cli(["upgrade", "apply", "--dry-run"]);
  expect(dry.code).toBe(0);
  expect(dry.stdout).toContain(".hack/.gitignore: would change in 1 (app-a)");
  expect(await tree(root)).toEqual(before);

  const bad = await cli(["upgrade", "apply", "--only", "bogus", "--json"]);
  expect(bad.code).toBe(1);
  expect(JSON.parse(bad.stdout).data.reason).toBe("unknown-fix");

  const applied = await cli([
    "upgrade",
    "apply",
    "--only",
    "ignore-rules",
    "--json",
  ]);
  expect(applied.code).toBe(0);
  const data = JSON.parse(applied.stdout).data as {
    status: string;
    journal_path: string;
    rollback_command: string;
    coverage: { manifest_path: string; complete: boolean };
    after: { plan: { id: string }[] };
  };
  expect(data.status).toBe("applied");
  expect(data.rollback_command).toBe(
    `hack upgrade rollback --rollback-manifest ${data.coverage.manifest_path}`
  );
  expect(data.after.plan.some((s) => s.id === "ignore-rules")).toBe(false);
  expect(applied.output).not.toContain(SENTINEL);
  expect(await readFile(data.journal_path, "utf8")).not.toContain(SENTINEL);
}, 120_000);

test("a .hack/.gitignore that is a link refuses only its own checkout", async () => {
  const a = await project("app-a");
  const b = await project("app-b");
  await writeFile(join(root, "elsewhere-ignore"), "x\n");
  await symlink(
    join(root, "elsewhere-ignore"),
    join(a.projectDir, ".gitignore")
  );
  await writeRegistry([a, b]);
  const report = await check();
  const applied = await runUpgradeApply({
    report,
    dryRun: false,
    only: ["ignore-rules"],
    home,
    collect: collectUpgradeSnapshotTargets,
  });
  if (applied.status !== "partial" && applied.status !== "applied") {
    throw new Error(`apply did not run: ${applied.status}`);
  }
  const byScope = new Map(applied.targets.map((t) => [t.scope, t.status]));
  expect(byScope.get("app-b")).toBe("applied");
  expect(byScope.get("app-a")).toMatch(/^(refused|failed|skipped)$/);
  expect(await readFile(join(root, "elsewhere-ignore"), "utf8")).toBe("x\n");
}, 60_000);

// ---------------------------------------------------------------------------
// Review regressions
// ---------------------------------------------------------------------------

test("checkouts with the same display name are applied by their own root", async () => {
  const a = await project("app-a");
  // Two linked worktrees with the same directory name: the same display name.
  const first = join(root, "wt-one", "feature");
  const second = join(root, "wt-two", "feature");
  await checkout(first, "app-a");
  await checkout(second, "app-a");
  // The second one is blocked; the first must still get its own fix.
  await symlink(
    join(root, "nowhere.yaml"),
    join(second, ".hack", "hack.env.default.yaml")
  );
  const lastSeenAt = "2026-01-01T00:00:00.000Z";
  await writeRegistry([
    {
      ...a,
      worktrees: [
        { path: first, branch: "f1", lastSeenAt },
        { path: second, branch: "f2", lastSeenAt },
      ],
    },
  ]);
  const report = await check();
  const applied = await runUpgradeApply({
    report,
    dryRun: false,
    only: ["ignore-rules"],
    home,
    collect: collectUpgradeSnapshotTargets,
  });
  if (applied.status !== "partial") {
    throw new Error(`unexpected status ${applied.status}`);
  }
  const byRoot = new Map(applied.targets.map((t) => [t.root, t.status]));
  expect(byRoot.get(first)).toBe("applied");
  expect(byRoot.get(second)).toBe("skipped");
  expect(await readFile(join(first, ".hack", ".gitignore"), "utf8")).toContain(
    ".env"
  );
  expect(
    await lstat(join(second, ".hack", ".gitignore")).catch(() => null)
  ).toBeNull();
}, 60_000);

test("--project naming two registered projects is refused as ambiguous", async () => {
  const one = await project("dup");
  const other = {
    ...(await project("dup-2")),
    id: "id-dup-other",
    name: "dup",
  };
  await writeRegistry([one, other]);
  const report = await check();
  const before = await tree(root);
  expect(
    await runUpgradeApply({
      report,
      dryRun: false,
      project: "dup",
      home,
      collect: collectUpgradeSnapshotTargets,
    })
  ).toMatchObject({ status: "refused", reason: "ambiguous-project" });
  expect(await tree(root)).toEqual(before);
}, 60_000);

test("--project leaves HOME agent files out without counting them as unfinished", async () => {
  const agentFile = await staleHomeAgentFile();
  const a = await project("app-a");
  await writeRegistry([a]);
  const report = await check();
  const scopes: string[] = [];
  const applied = await runUpgradeApply({
    report,
    dryRun: false,
    project: "app-a",
    only: ["agent-integrations"],
    home,
    collect: collectUpgradeSnapshotTargets,
    applyPluginMigration: async (input) => {
      scopes.push(...input.scopes.map((s) => s.scope));
      return {
        status: "nothing-to-migrate",
        plan: { checks: [], entries: [] },
      };
    },
  });
  expect(applied.status).toBe("applied");
  expect(scopes).toEqual(["project"]);
  if (applied.status !== "applied") {
    throw new Error("unreachable");
  }
  expect(applied.targets.map((t) => t.scope)).toEqual(["app-a"]);
  expect(applied.notes[0]).toContain("left out with --project");
  expect(await readFile(agentFile, "utf8")).toContain("old standalone");
}, 60_000);

test("a write whose after state cannot be recorded is failed, not applied", async () => {
  const a = await project("app-a");
  await writeRegistry([a]);
  const report = await check();
  for (const record of [
    async () => ({ status: "refused" as const, paths: [] }),
    async () => ({ status: "invalid-manifest" as const, message: "x" }),
    async () => {
      throw new Error("boom");
    },
  ]) {
    await rm(join(a.projectDir, ".gitignore"), { force: true });
    const applied = await runUpgradeApply({
      report,
      dryRun: false,
      only: ["ignore-rules"],
      home,
      collect: collectUpgradeSnapshotTargets,
      recordAfter: record,
    });
    if (applied.status !== "partial") {
      throw new Error(`unexpected status ${applied.status}`);
    }
    expect(applied.targets[0]?.status).toBe("failed");
    expect(applied.targets[0]?.message).toContain("needs --overwrite");
    const journal = (await readUpgradeSnapshotJournal({
      manifestPath: applied.coverage.manifest_path,
    })) as { state: string };
    expect(journal.state).toBe("failed");
  }
}, 60_000);

test("the agent backup manifest is journaled before removal and kept when the migration fails after it", async () => {
  await staleHomeAgentFile();
  const a = await project("app-a");
  await writeRegistry([a]);
  const report = await check();
  const backupDir = join(hackHome, "agent-migrations");
  const snapshotRoot = join(hackHome, "upgrade", "snapshots");
  const seenDuring: (string | null)[] = [];
  const applied = await runUpgradeApply({
    report,
    dryRun: false,
    only: ["agent-integrations"],
    home,
    collect: collectUpgradeSnapshotTargets,
    agentBackupDir: backupDir,
    snapshotRoot,
    applyPluginMigration: async (input) => {
      // Mid-migration (an interruption here): the journal already names
      // this target as started, with the backup it is about to write.
      const [snapshot] = await listUpgradeSnapshots({ root: snapshotRoot });
      const journal = (await readUpgradeSnapshotJournal({
        manifestPath: snapshot?.manifestPath ?? "",
      })) as {
        targets: { status: string; backup_manifest: string | null }[];
      };
      const current = journal.targets.find((t) => t.status === "started");
      seenDuring.push(current?.backup_manifest ?? null);
      expect(current?.backup_manifest).toBe(input.upgradeSnapshotManifest);
      // Production and injected migrations receive the same snapshot mode.
      expect(input.upgradeSnapshotManifest).toBe(snapshot?.manifestPath);
      throw Object.assign(new Error("rewrite failed"), { code: "EIO" });
    },
  });
  // manifestPath is only known after the run; replay the check here.
  if (applied.status !== "partial") {
    throw new Error(`unexpected status ${applied.status}`);
  }
  const manifestPath = applied.coverage.manifest_path;
  const failed = applied.targets.filter((t) => t.status === "failed");
  expect(failed.length).toBeGreaterThan(0);
  for (const target of failed) {
    expect(target.backup_manifest).toBe(manifestPath);
    expect(target.message).toContain("Failed (EIO)");
  }
  expect(applied.agent_backups).toEqual([manifestPath]);
  const journal = (await readUpgradeSnapshotJournal({ manifestPath })) as {
    targets: { status: string; backup_manifest: string | null }[];
  };
  expect(
    journal.targets
      .filter((t) => t.status === "failed")
      .every((t) => t.backup_manifest === manifestPath)
  ).toBe(true);
  expect(seenDuring).toEqual(failed.map((t) => t.backup_manifest));
}, 60_000);

test("hack upgrade apply exits 1 when every selected checkout is blocked", async () => {
  const blocked = await project("app-blocked");
  await symlink(
    join(root, "nowhere.yaml"),
    join(blocked.projectDir, "hack.env.default.yaml")
  );
  await writeRegistry([blocked]);
  // The CLI harness itself prepares the private home; compare what apply could touch.
  const touched = async () => [
    ...(await tree(join(root, "repos"))),
    ...(await tree(hackHome)),
  ];
  const before = await touched();
  const run = await cli(["upgrade", "apply", "--only", "ignore-rules"]);
  expect(run.code).toBe(1);
  expect(run.stdout).toContain("Nothing ran");
  const json = await cli([
    "upgrade",
    "apply",
    "--only",
    "ignore-rules",
    "--json",
  ]);
  expect(json.code).toBe(1);
  expect(JSON.parse(json.stdout).data.status).toBe("blocked");
  expect(await touched()).toEqual(before);
}, 120_000);

test("--project is ambiguous when another registration's primary is dead but its worktree lives", async () => {
  const live = await project("dup");
  const worktree = join(root, "other-wt", "feature");
  await checkout(worktree, "dup");
  const other = {
    ...dead("dup"),
    id: "id-dup-dead",
    worktrees: [
      { path: worktree, branch: "f", lastSeenAt: "2026-01-01T00:00:00.000Z" },
    ],
  };
  await writeRegistry([live, other]);
  const report = await check();
  // The dead primary is not a live checkout, but its worktree is.
  expect(report.projects.map((p) => p.root).sort()).toEqual(
    [live.repoRoot, worktree].sort()
  );
  const before = await tree(root);
  expect(
    await runUpgradeApply({
      report,
      dryRun: false,
      project: "dup",
      home,
      collect: collectUpgradeSnapshotTargets,
    })
  ).toMatchObject({ status: "refused", reason: "ambiguous-project" });
  expect(await tree(root)).toEqual(before);
}, 60_000);

test("snapshot-backed failures retain their receipt without using a legacy backup directory", async () => {
  await staleHomeAgentFile();
  const a = await project("app-a");
  await writeRegistry([a]);
  const report = await check();
  const backupDir = join(hackHome, "agent-migrations");
  await writeFile(backupDir, "not a directory\n");
  const applied = await runUpgradeApply({
    report,
    dryRun: false,
    only: ["agent-integrations"],
    home,
    collect: collectUpgradeSnapshotTargets,
    agentBackupDir: backupDir,
    applyPluginMigration: async (input) => {
      expect(input.upgradeSnapshotManifest).toBeString();
      expect(await lstat(input.upgradeSnapshotManifest ?? "")).toBeDefined();
      throw Object.assign(new Error("rewrite failed"), { code: "EIO" });
    },
  });
  if (applied.status !== "partial") {
    throw new Error(`unexpected status ${applied.status}`);
  }
  const failed = applied.targets.filter((t) => t.status === "failed");
  expect(failed.length).toBeGreaterThan(0);
  expect(
    failed.every((t) => t.backup_manifest === applied.coverage.manifest_path)
  ).toBe(true);
  expect(applied.agent_backups).toEqual([applied.coverage.manifest_path]);
  const journal = (await readUpgradeSnapshotJournal({
    manifestPath: applied.coverage.manifest_path,
  })) as { targets: { status: string; backup_manifest: string | null }[] };
  expect(
    journal.targets
      .filter((t) => t.status === "failed")
      .every((t) => t.backup_manifest === applied.coverage.manifest_path)
  ).toBe(true);
  expect(await readFile(backupDir, "utf8")).toBe("not a directory\n");
}, 60_000);

test("SIGKILL at every apply boundary resumes the same snapshot and rolls back exact bytes and modes", async () => {
  const a = await project("app-a", 1);
  await writeRegistry([a]);
  const ignore = join(a.projectDir, ".gitignore");
  await writeFile(ignore, "# keep custom rules\ncustom\n");
  await chmod(ignore, 0o640);
  const report = await check();
  const reportPath = join(root, "report.json");
  await writeFile(reportPath, JSON.stringify(report));
  const before = [
    ...(await tree(join(root, "repos"))),
    ...(await tree(join(root, "worktrees"))),
  ];
  // Initial journal, then started / published / recorded for both targets.
  for (let boundary = 1; boundary <= 7; boundary += 1) {
    const child = Bun.spawn(
      [
        process.execPath,
        resolve(import.meta.dir, "fixtures/upgrade-apply-worker.ts"),
        reportPath,
        String(boundary),
      ],
      {
        cwd: root,
        env: privateCliEnv({
          root,
          home,
          env: {
            HACK_HOME: hackHome,
            HACK_GLOBAL_CONFIG_PATH: join(hackHome, "hack.config.json"),
            HACK_HOST_PROBES_DISABLE: "1",
            HACK_SYSTEMD_DISABLE: "1",
            HACK_NO_INTERACTIVE: "1",
          },
        }),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const reader = child.stdout.getReader();
    try {
      const reached = await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => {
          setTimeout(
            () => reject(new Error("No interruption checkpoint")),
            15_000
          ).unref();
        }),
      ]);
      expect(new TextDecoder().decode(reached.value)).toContain("checkpoint");
    } finally {
      child.kill("SIGKILL");
      await child.exited;
      reader.releaseLock();
    }
    const [snapshot] = await listUpgradeSnapshots();
    if (snapshot === undefined) {
      throw new Error("Missing interrupted snapshot");
    }
    const resumed = await runUpgradeApply({
      report: await check(),
      home,
      dryRun: false,
      resumeManifest: snapshot.manifestPath,
      collect: async () => {
        throw new Error("Resume must reuse coverage");
      },
    });
    expect(resumed.status).toBe("applied");
    if (resumed.status !== "applied") {
      throw new Error(JSON.stringify(resumed));
    }
    expect(resumed.coverage.manifest_path).toBe(snapshot.manifestPath);
    expect(await readFile(ignore, "utf8")).toContain("# keep custom rules");
    expect(await readFile(resumed.journal_path, "utf8")).not.toContain(
      SENTINEL
    );
    expect(
      (await restoreUpgradeSnapshot({ manifestPath: snapshot.manifestPath }))
        .status
    ).toBe("restored");
    expect([
      ...(await tree(join(root, "repos"))),
      ...(await tree(join(root, "worktrees"))),
    ]).toEqual(before);
  }
}, 120_000);

test("resume refuses an unknown journal and preserves edits after apply", async () => {
  const a = await project("app-a");
  await writeRegistry([a]);
  const result = await runUpgradeApply({
    report: await check(),
    home,
    dryRun: false,
    only: ["ignore-rules"],
    collect: collectUpgradeSnapshotTargets,
  });
  if (result.status !== "applied") {
    throw new Error("Expected apply");
  }
  const path = join(a.projectDir, ".gitignore");
  await writeFile(path, "later edit\n");
  const resumed = await runUpgradeApply({
    report: await check(),
    home,
    dryRun: false,
    resumeManifest: result.coverage.manifest_path,
    collect: collectUpgradeSnapshotTargets,
  });
  expect(resumed.status).toBe("partial");
  expect(await readFile(path, "utf8")).toBe("later edit\n");
  await writeFile(result.journal_path, '{"version":999}\n', { mode: 0o600 });
  const before = await tree(root);
  expect(
    (
      await runUpgradeApply({
        report: await check(),
        home,
        dryRun: false,
        resumeManifest: result.coverage.manifest_path,
        collect: collectUpgradeSnapshotTargets,
      })
    ).status
  ).toBe("refused");
  expect(await tree(root)).toEqual(before);
}, 60_000);

test("agent removals keep metadata-only snapshots and rollback exact files and directories after interruption", async () => {
  const a = await project("app-a");
  await writeRegistry([a]);
  const agent = await staleHomeAgentFile();
  await writeFile(agent, renderCodexSkill());
  await chmod(agent, 0o640);
  await writeFile(
    join(home, ".codex/config.toml"),
    `[plugins."${HACK_PLUGIN_ID}"]\nenabled = true\n`
  );
  await writeFile(
    join(a.repoRoot, "AGENTS.md"),
    "<!-- hack:agent-docs:start -->\nold\n<!-- hack:agent-docs:end -->\n"
  );
  const beforeAgentTree = await tree(join(home, ".codex"));
  const report = await check();
  expect(report.plan.some((step) => step.id === "agent-integrations")).toBe(
    true
  );
  const reportPath = join(root, "report.json");
  await writeFile(reportPath, JSON.stringify(report));
  // Interrupt after the real plugin migration has removed the global file,
  // before apply records its after state or commits the target outcome.
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(import.meta.dir, "fixtures/upgrade-apply-worker.ts"),
      reportPath,
      "3",
      "agent-integrations",
    ],
    {
      cwd: root,
      env: privateCliEnv({
        root,
        home,
        env: {
          HACK_HOME: hackHome,
          HACK_GLOBAL_CONFIG_PATH: join(hackHome, "hack.config.json"),
          HACK_HOST_PROBES_DISABLE: "1",
          HACK_SYSTEMD_DISABLE: "1",
        },
      }),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const reader = child.stdout.getReader();
  try {
    const reached = await reader.read();
    expect(new TextDecoder().decode(reached.value)).toContain("checkpoint");
  } finally {
    child.kill("SIGKILL");
    await child.exited;
    reader.releaseLock();
  }
  expect(await lstat(agent).catch(() => null)).toBeNull();
  const [snapshot] = await listUpgradeSnapshots();
  if (snapshot === undefined) {
    throw new Error("Missing snapshot");
  }
  const resumed = await runUpgradeApply({
    report: await check(),
    home,
    dryRun: false,
    resumeManifest: snapshot.manifestPath,
    collect: collectUpgradeSnapshotTargets,
  });
  expect(resumed.status).toBe("applied");
  const manifest = await readFile(snapshot.manifestPath, "utf8");
  expect(manifest).not.toContain("contentBase64");
  expect(manifest).not.toContain(Buffer.from(SENTINEL).toString("base64"));
  expect(
    (await restoreUpgradeSnapshot({ manifestPath: snapshot.manifestPath }))
      .status
  ).toBe("restored");
  expect(await tree(join(home, ".codex"))).toEqual(beforeAgentTree);
}, 60_000);

test("resume refuses damaged snapshot originals before applying another fix", async () => {
  const a = await project("app-a");
  await writeRegistry([a]);
  await writeFile(join(a.projectDir, ".gitignore"), "keep\n");
  const result = await runUpgradeApply({
    report: await check(),
    home,
    dryRun: false,
    only: ["ignore-rules"],
    collect: collectUpgradeSnapshotTargets,
  });
  if (result.status !== "applied") {
    throw new Error("Expected apply");
  }
  const [snapshot] = await listUpgradeSnapshots();
  const original = snapshot?.manifest.entries.find(
    (entry) => entry.path === join(a.projectDir, ".gitignore")
  );
  if (snapshot === undefined || original?.before.kind !== "file") {
    throw new Error("Missing original");
  }
  await writeFile(
    join(snapshot.dir, "blobs", original.before.sha256),
    "damaged\n",
    { mode: 0o600 }
  );
  const before = await tree(join(root, "repos"));
  const resumed = await runUpgradeApply({
    report: await check(),
    home,
    dryRun: false,
    resumeManifest: result.coverage.manifest_path,
    collect: collectUpgradeSnapshotTargets,
  });
  expect(resumed.status).toBe("partial");
  expect(await tree(join(root, "repos"))).toEqual(before);
}, 60_000);

test("other-volume checkouts are skipped before any write with an accurate remedy, while local work applies", async () => {
  const a = await project("app-a");
  const b = await project("app-b");
  await writeRegistry([a, b]);
  const report = await check();
  const device = async (path: string) => (path.startsWith(b.repoRoot) ? 2 : 1);
  const before = await tree(root);
  const onlyRemote = await runUpgradeApply({
    report,
    home,
    dryRun: false,
    only: ["ignore-rules"],
    project: "app-b",
    filesystemDevice: device,
    collect: async () => {
      throw new Error("Blocked planning must not collect or create a snapshot");
    },
  });
  expect(onlyRemote.status).toBe("blocked");
  if (onlyRemote.status !== "blocked") {
    throw new Error("Expected skipped layout");
  }
  expect(onlyRemote.targets[0]?.reason).toBe("other-filesystem");
  expect(onlyRemote.targets[0]?.message).toContain("--snapshot-root");
  expect(onlyRemote.targets[0]?.message).not.toContain("changed outside");
  expect(await tree(root)).toEqual(before);
  const remoteBefore = await tree(b.repoRoot);
  const applied = await runUpgradeApply({
    report,
    home,
    dryRun: false,
    only: ["ignore-rules"],
    filesystemDevice: device,
    collect: collectUpgradeSnapshotTargets,
  });
  expect(applied.status).toBe("partial");
  if (applied.status !== "partial") {
    throw new Error("Expected partial apply");
  }
  expect(
    applied.targets.find((target) => target.root === a.repoRoot)?.status
  ).toBe("applied");
  expect(
    applied.targets.find((target) => target.root === b.repoRoot)?.reason
  ).toBe("other-filesystem");
  expect(await tree(b.repoRoot)).toEqual(remoteBefore);
  const refused = await runUpgradeApply({
    report,
    home,
    dryRun: false,
    only: ["ignore-rules"],
    snapshotRoot: join(root, "chosen-snapshots"),
    filesystemDevice: device,
    collect: async () => {
      throw new Error(
        "Mixed explicit-root selection must not create a snapshot"
      );
    },
  });
  expect(refused).toMatchObject({ status: "refused", reason: "filesystem" });
}, 60_000);

test("an explicitly selected snapshot root admits its volume and is retained by resume", async () => {
  const a = await project("app-a");
  await writeRegistry([a]);
  const chosenRoot = join(root, "chosen-snapshots");
  const device = async (path: string) =>
    path.startsWith(a.repoRoot) || path.startsWith(chosenRoot) ? 2 : 1;
  const result = await runUpgradeApply({
    report: await check(),
    home,
    dryRun: false,
    only: ["ignore-rules"],
    project: "app-a",
    snapshotRoot: chosenRoot,
    filesystemDevice: device,
    collect: collectUpgradeSnapshotTargets,
  });
  expect(result.status).toBe("applied");
  if (result.status !== "applied") {
    throw new Error("Expected apply");
  }
  expect(result.coverage.manifest_path).toStartWith(chosenRoot);
  const blockedReport = await check();
  const target = blockedReport.projects[0];
  if (target === undefined) {
    throw new Error("Missing checkout");
  }
  const report = {
    ...blockedReport,
    projects: [
      {
        ...target,
        findings: [
          ...target.findings,
          {
            id: "fixture-blocker",
            status: "blocker" as const,
            summary: "Blocked fixture",
            command: null,
            args: null,
            action: null,
          },
        ],
      },
    ],
  };
  const before = await tree(root);
  const blocked = await runUpgradeApply({
    report,
    home,
    dryRun: false,
    resumeManifest: result.coverage.manifest_path,
    filesystemDevice: device,
    collect: collectUpgradeSnapshotTargets,
  });
  expect(blocked.status).toBe("blocked");
  expect(await tree(root)).toEqual(before);
  expect(
    (
      await restoreUpgradeSnapshot({
        manifestPath: result.coverage.manifest_path,
      })
    ).status
  ).toBe("restored");
}, 60_000);

test("CLI rollback refuses a snapshot held by apply's lock without touching files", async () => {
  const a = await project("app-a");
  await writeRegistry([a]);
  const applied = await runUpgradeApply({
    report: await check(),
    home,
    dryRun: false,
    only: ["ignore-rules"],
    collect: collectUpgradeSnapshotTargets,
  });
  if (applied.status !== "applied") {
    throw new Error("Expected apply");
  }
  // Prepare the harness-owned Docker config and HOME mode before the oracle.
  privateCliEnv({ root, home });
  await withProjectsRegistryLock({
    lockPath: join(applied.coverage.manifest_path, "..", "apply.lock"),
    run: async () => {
      const before = await tree(root);
      const started = Date.now();
      const result = await cli([
        "upgrade",
        "rollback",
        "--rollback-manifest",
        applied.coverage.manifest_path,
        "--json",
      ]);
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stdout).data.status).toBe("busy");
      expect(result.output).not.toContain(SENTINEL);
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(await tree(root)).toEqual(before);
    },
  });
}, 60_000);

test("a resume killed while republishing its journal never adopts a user's revert", async () => {
  const a = await project("app-a");
  await writeRegistry([a]);
  const ignore = join(a.projectDir, ".gitignore");
  await writeFile(ignore, "original\n");
  const applied = await runUpgradeApply({
    report: await check(),
    home,
    dryRun: false,
    only: ["ignore-rules"],
    collect: collectUpgradeSnapshotTargets,
  });
  if (applied.status !== "applied") {
    throw new Error("Expected apply");
  }
  await writeFile(ignore, "original\n");
  const reportPath = join(root, "resume-report.json");
  await writeFile(reportPath, JSON.stringify(await check()));
  for (const boundary of [1, 2]) {
    const child = Bun.spawn(
      [
        process.execPath,
        resolve(import.meta.dir, "fixtures/upgrade-apply-worker.ts"),
        reportPath,
        String(boundary),
        "ignore-rules",
        applied.coverage.manifest_path,
      ],
      {
        cwd: root,
        env: privateCliEnv({
          root,
          home,
          env: {
            HACK_HOME: hackHome,
            HACK_GLOBAL_CONFIG_PATH: join(hackHome, "hack.config.json"),
            HACK_HOST_PROBES_DISABLE: "1",
            HACK_SYSTEMD_DISABLE: "1",
          },
        }),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const reader = child.stdout.getReader();
    try {
      const reached = await reader.read();
      expect(new TextDecoder().decode(reached.value)).toContain("checkpoint");
    } finally {
      child.kill("SIGKILL");
      await child.exited;
      reader.releaseLock();
    }
    const journal = (await readUpgradeSnapshotJournal({
      manifestPath: applied.coverage.manifest_path,
    })) as { targets: { status: string }[] };
    expect(journal.targets[0]?.status).toBe("applied");
    expect(await readFile(ignore, "utf8")).toBe("original\n");
  }
  const resumed = await runUpgradeApply({
    report: await check(),
    home,
    dryRun: false,
    resumeManifest: applied.coverage.manifest_path,
    collect: collectUpgradeSnapshotTargets,
  });
  expect(resumed.status).toBe("partial");
  expect(await readFile(ignore, "utf8")).toBe("original\n");
  // Even another resume after the refusal must retain the after-state guard.
  expect(
    (
      await runUpgradeApply({
        report: await check(),
        home,
        dryRun: false,
        resumeManifest: applied.coverage.manifest_path,
        collect: collectUpgradeSnapshotTargets,
      })
    ).status
  ).toBe("partial");
  expect(await readFile(ignore, "utf8")).toBe("original\n");
}, 60_000);

test("an absent agent target cannot resume with a damaged original blob", async () => {
  const a = await project("app-a");
  await writeRegistry([a]);
  const agent = await staleHomeAgentFile();
  await writeFile(agent, renderCodexSkill());
  await writeFile(
    join(home, ".codex/config.toml"),
    `[plugins."${HACK_PLUGIN_ID}"]\nenabled = true\n`
  );
  await writeFile(
    join(a.repoRoot, "AGENTS.md"),
    "<!-- hack:agent-docs:start -->\nold\n<!-- hack:agent-docs:end -->\n"
  );
  const applied = await runUpgradeApply({
    report: await check(),
    home,
    dryRun: false,
    only: ["agent-integrations"],
    collect: collectUpgradeSnapshotTargets,
  });
  if (applied.status !== "applied") {
    throw new Error("Expected agent apply");
  }
  const [snapshot] = await listUpgradeSnapshots();
  const entry = snapshot?.manifest.entries.find((item) => item.path === agent);
  if (snapshot === undefined || entry?.before.kind !== "file") {
    throw new Error("Missing blob");
  }
  await writeFile(
    join(snapshot.dir, "blobs", entry.before.sha256),
    "damaged\n",
    { mode: 0o600 }
  );
  expect(await lstat(agent).catch(() => null)).toBeNull();
  const resumed = await runUpgradeApply({
    report: await check(),
    home,
    dryRun: false,
    resumeManifest: applied.coverage.manifest_path,
    collect: collectUpgradeSnapshotTargets,
  });
  expect(resumed.status).toBe("partial");
  if (resumed.status !== "partial") {
    throw new Error("Expected refusal");
  }
  expect(resumed.targets.find((target) => target.root === home)?.status).toBe(
    "refused"
  );
  expect(await lstat(agent).catch(() => null)).toBeNull();
}, 60_000);
