import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
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

import { runUpgradeApply } from "../src/lib/upgrade-apply.ts";
import {
  runUpgradeCheck,
  type UpgradeCheckReport,
} from "../src/lib/upgrade-check.ts";
import type { UpgradeCheckProbes } from "../src/lib/upgrade-check-probes.ts";
import { renderUpgradeCheck } from "../src/lib/upgrade-check-render.ts";
import {
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
  const legacy = report.plan.find((s) => s.id === "env-format" && !s.blocker);
  expect(legacy?.command).toBeNull();
  expect(legacy?.action).toContain(
    "hack doctor --migrate-env-config --path <checkout>"
  );
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
