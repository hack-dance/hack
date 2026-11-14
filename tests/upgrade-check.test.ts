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
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { setProjectEnvValue } from "../src/lib/project-env-config.ts";
import { resolveSecretStore } from "../src/lib/secret-store.ts";
import {
  runUpgradeCheck,
  type UpgradeCheckReport,
} from "../src/lib/upgrade-check.ts";
import {
  defaultUpgradeCheckProbes,
  type UpgradeCheckProbes,
} from "../src/lib/upgrade-check-probes.ts";
import { inspectUpgradeProject } from "../src/lib/upgrade-check-project.ts";
import { collectUpgradeSnapshotTargets } from "../src/lib/upgrade-snapshot-targets.ts";
import { restoreEnv } from "./helpers/env.ts";
import { fixtureGitEnv } from "./helpers/fixture-git.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

// Values that must never appear in any report, plan or output.
const SENTINEL = ["sentinel", "upgrade", "check", "c41d07"].join("-");
const ENTRYPOINT = resolve(import.meta.dir, "..", "index.ts");

const STORE_KEY = ["synthetic", "upgrade", "store", "key", "51e0"].join("-");
const ISOLATED_ENV = [
  "HOME",
  "PATH",
  "HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK",
  "HACK_HOME",
  "HACK_GLOBAL_CONFIG_PATH",
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
  root = await realpath(await mkdtemp(join(tmpdir(), "hack-upgrade-check-")));
  home = join(root, "user-home");
  hackHome = join(home, ".hack");
  await mkdir(hackHome, { recursive: true });
  process.env.HOME = home;
  process.env.HACK_HOME = hackHome;
  process.env.HACK_GLOBAL_CONFIG_PATH = join(hackHome, "hack.config.json");
  Reflect.deleteProperty(process.env, "HACK_SECRETS_FILE_KEY");
  Reflect.deleteProperty(process.env, "HACK_ENV_SECRET_KEY");
});

afterEach(async () => {
  for (const key of ISOLATED_ENV) {
    restoreEnv(key, saved.get(key));
  }
  await rm(root, { recursive: true, force: true });
});

type Entry = {
  id: string;
  name: string;
  repoRoot: string;
  projectDirName: ".hack";
  projectDir: string;
  createdAt: string;
  worktrees?: { path: string; branch: string; lastSeenAt: string }[];
};

function entry(name: string): Entry {
  const repoRoot = join(root, "repos", name);
  return {
    id: `id-${name}`,
    name,
    repoRoot,
    projectDirName: ".hack",
    projectDir: join(repoRoot, ".hack"),
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

async function liveProject(name: string): Promise<Entry> {
  const project = entry(name);
  await mkdir(project.projectDir, { recursive: true });
  await writeFile(
    join(project.projectDir, "hack.config.json"),
    `${JSON.stringify({ name, dev_host: `${name}.hack` })}\n`
  );
  return project;
}

async function writeRegistry(projects: readonly Entry[]): Promise<void> {
  await writeFile(
    join(hackHome, "projects.json"),
    `${JSON.stringify({ version: 1, projects })}\n`
  );
}

/** Probes that report a healthy, fully installed host. */
function healthyProbes(
  overrides: Partial<UpgradeCheckProbes> = {}
): UpgradeCheckProbes {
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
    ...overrides,
  };
}

async function check(probes: UpgradeCheckProbes): Promise<UpgradeCheckReport> {
  return await runUpgradeCheck({
    cliVersion: "5.0.0-next.17",
    homeDir: home,
    probes,
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

test("dead registry entries are counted apart from unreadable ones, and only live projects are checked", async () => {
  const live = await liveProject("app-live");
  const configGone = entry("app-config-gone");
  await mkdir(configGone.projectDir, { recursive: true });
  const invalid = await liveProject("app-invalid");
  await writeFile(join(invalid.projectDir, "hack.config.json"), "{ not json");
  const dead = Array.from({ length: 76 }, (_, i) =>
    entry(`app-dead-${String(i).padStart(2, "0")}`)
  );
  await writeRegistry([live, configGone, invalid, ...dead]);

  const report = await check(healthyProbes());
  expect(report.registry.state).toBe("valid");
  expect(report.registry.total).toBe(79);
  expect(report.registry.live).toBe(1);
  expect(report.registry.missing).toHaveLength(77);
  expect(
    report.registry.missing.find((e) => e.name === "app-config-gone")?.reason
  ).toContain("is gone");
  expect(report.registry.unreadable.map((e) => e.name)).toEqual([
    "app-invalid",
  ]);
  expect(report.projects.map((p) => [p.name, p.state])).toEqual([
    ["app-invalid", "unreadable"],
    ["app-live", "live"],
  ]);
  const dead77 = report.machine.find((f) => f.id === "registry-dead");
  expect(dead77?.status).toBe("warn");
  expect(dead77?.command).toBe("hack projects prune --dry-run");
  expect(dead77?.summary).toContain("not live projects that failed to read");
  // A live checkout that cannot be read blocks: its safety is unknown.
  expect(report.ready).toBe(false);
  expect(report.blockers).toContainEqual({
    scope: "app-invalid",
    id: "project-config",
    summary: expect.stringContaining("not valid JSON"),
  });
  // A registry of mostly dead entries stays fast.
  expect(report.duration_ms).toBeLessThan(30_000);
});

test("a project with only the legacy TOML config or only a Compose file is live, not dead", async () => {
  const toml = entry("app-toml");
  await mkdir(toml.projectDir, { recursive: true });
  await writeFile(join(toml.projectDir, "hack.toml"), 'name = "app-toml"\n');
  const compose = entry("app-compose");
  await mkdir(compose.projectDir, { recursive: true });
  await writeFile(
    join(compose.projectDir, "docker-compose.yml"),
    "services: {}\n"
  );
  await writeRegistry([toml, compose]);
  const report = await check(healthyProbes());
  expect(report.registry.live).toBe(2);
  expect(report.registry.missing).toEqual([]);
});

test("once the time budget is spent, project checks report not checked without running", async () => {
  const project = await liveProject("app-late");
  let ran = false;
  const findings = await inspectUpgradeProject({
    project: { ...project, project: project.name },
    homeDir: home,
    deadline: Date.now() - 1,
    nativePreflight: async () => {
      ran = true;
      return null;
    },
  });
  expect(ran).toBe(false);
  const byId = new Map(findings.map((f) => [f.id, f]));
  // Required checks are incomplete (readiness not established); optional
  // ones are warnings.
  for (const id of ["env-format", "env-key", "tracked-files", "ignore-rules"]) {
    expect(byId.get(id)?.status).toBe("incomplete");
    expect(byId.get(id)?.summary).toContain("ran out of time");
  }
  expect(byId.get("agent-integrations")?.status).toBe("warn");
});

test("the plan starts with the snapshot, then blockers, then machine and project steps", async () => {
  // A conflicting env layer (a dangling link) blocks; legacy env is a step.
  const blocked = await liveProject("app-blocked");
  await symlink(
    join(root, "nowhere.yaml"),
    join(blocked.projectDir, "hack.env.default.yaml")
  );
  const legacy = await liveProject("app-legacy");
  await writeFile(join(legacy.projectDir, "hack.env.json"), "{}\n");
  await writeFile(join(legacy.projectDir, ".env"), `TOKEN=${SENTINEL}\n`);
  await writeRegistry([blocked, legacy, entry("app-dead")]);

  const report = await check(
    healthyProbes({
      globalInfra: async () => ({ installed: true, running: false }),
    })
  );
  expect(report.ready).toBe(false);
  expect(report.blockers).toEqual([
    {
      scope: "app-blocked",
      id: "env-format",
      summary: expect.stringContaining("link or not a regular file"),
    },
  ]);
  expect(
    report.plan.map((step) => [step.id, step.scope, step.blocker])
  ).toEqual([
    ["snapshot", "machine", false],
    ["env-format", "projects", true],
    // Its dangling layer link cannot be inspected for secrets either.
    ["env-secrets", "app-blocked", false],
    ["registry-dead", "machine", false],
    ["global-infra", "machine", false],
  ]);
  expect(report.next_command).toBe("hack upgrade snapshot");
  const grouped = report.plan.filter((step) => step.id === "env-format");
  expect(grouped).toHaveLength(1);
  expect(
    grouped[0]?.targets.find((target) => target.scope === "app-blocked")?.status
  ).toBe("blocker");
  expect(
    grouped[0]?.targets.find((target) => target.scope === "app-legacy")?.status
  ).toBe("warn");
  expect(grouped[0]?.targets.map((target) => target.scope).sort()).toEqual([
    "app-blocked",
    "app-legacy",
  ]);
  const legacyTarget = grouped[0]?.targets.find(
    (target) => target.scope === "app-legacy"
  );
  expect(legacyTarget?.command).toBe(
    `hack doctor --migrate-env-config --path ${legacy.repoRoot}`
  );
  expect(
    report.projects
      .find((project) => project.name === "app-legacy")
      ?.findings.find((finding) => finding.id === "env-format")?.summary
  ).toContain("legacy-json, dotenv");
});

test("a host with nothing to do is ready, with no plan and no next command", async () => {
  const current = await liveProject("app-current");
  // A YAML env layer written the way Hack writes it (no legacy env files).
  await setProjectEnvValue({
    projectRoot: current.repoRoot,
    projectDir: current.projectDir,
    envName: null,
    scope: "global",
    key: "PORT",
    value: "3000",
    secret: false,
  });
  await writeRegistry([current]);
  const report = await check(healthyProbes());
  expect(report.blockers).toEqual([]);
  expect(report.incomplete).toEqual([]);
  expect(report.ready).toBe(true);
  expect(report.plan).toEqual([]);
  expect(report.next_command).toBeNull();
  expect(report.cli).toEqual({
    version: "5.0.0-next.17",
    channel: "next",
    candidate_run: false,
    build: "release",
    command: "hack",
  });
});

test("a global store whose key is gone blocks only when a registered project reads it", async () => {
  const storePath = join(hackHome, "secrets.enc.json");
  await writeFile(
    process.env.HACK_GLOBAL_CONFIG_PATH ?? "",
    `${JSON.stringify({
      controlPlane: {
        secrets: {
          backend: "encrypted_file",
          encryptedFile: {
            path: storePath,
            keyPath: join(hackHome, "secrets-file.key"),
          },
        },
      },
    })}\n`
  );
  // A store envelope whose key file is missing; its content is never read.
  await writeFile(
    storePath,
    `${JSON.stringify({ version: 1, alg: "aes-256-gcm", iv: "AAAA", tag: "AAAA", data: SENTINEL })}\n`,
    { mode: 0o600 }
  );
  const bystander = await liveProject("app-bystander");
  await writeRegistry([bystander]);
  const warned = await check(healthyProbes());
  const store = warned.machine.find((f) => f.id === "secret-store");
  expect(store?.status).toBe("warn");
  expect(warned.ready).toBe(true);

  const reader = await liveProject("app-reader");
  await writeFile(
    join(reader.projectDir, "hack.env.json"),
    `${JSON.stringify({ version: 1, vars: [{ key: "TOKEN", source: "keychain" }] })}\n`
  );
  await writeRegistry([bystander, reader]);
  const blocked = await check(healthyProbes());
  const blocking = blocked.machine.find((f) => f.id === "secret-store");
  expect(blocking?.status).toBe("blocker");
  expect(blocking?.summary).toContain("app-reader");
  expect(blocked.ready).toBe(false);
  expect(blocked.plan.map((step) => step.id).slice(0, 2)).toEqual([
    "snapshot",
    "secret-store",
  ]);
  const step = blocked.plan[1];
  expect(step?.command).toBe("hack secrets retire-store --allow-unchecked");
  expect(step?.action).toContain("restore the store's key file");
  expect(JSON.stringify(blocked)).not.toContain(SENTINEL);
});

test("the check changes nothing and reports no value", async () => {
  const legacy = await liveProject("app-legacy");
  await writeFile(join(legacy.projectDir, "hack.env.json"), "{}\n");
  await writeFile(join(legacy.projectDir, ".env"), `TOKEN=${SENTINEL}\n`, {
    mode: 0o600,
  });
  await writeFile(
    join(legacy.projectDir, ".env.production"),
    `A=${SENTINEL}\n`
  );
  await writeRegistry([legacy, entry("app-dead")]);
  const before = await tree(root);
  const report = await check(healthyProbes());
  expect(await tree(root)).toEqual(before);
  expect(JSON.stringify(report)).not.toContain(SENTINEL);
});

test("probes that are disabled or fail report not checked, never a pass", async () => {
  await writeRegistry([await liveProject("app-a")]);
  const report = await check(defaultUpgradeCheckProbes());
  const byId = new Map(report.machine.map((f) => [f.id, f]));
  expect(byId.get("daemon")?.summary).toContain("Not checked");
  expect(byId.get("global-infra")?.summary).toContain("Not checked");
  expect(byId.get("docker")?.status).toBe("warn");
  // Disabled probes leave the check incomplete, never ready.
  expect(report.host_probes).toBe("disabled");
  expect(byId.get("host-probes")?.status).toBe("incomplete");
  expect(report.ready).toBe(false);
  // A probe that throws or hangs does not stop the check.
  const failing = await check(
    healthyProbes({
      daemon: async () => {
        throw new Error("boom");
      },
    })
  );
  // A proxy ports probe that fails while global services run is reported.
  const proxyFailed = await check(
    healthyProbes({
      proxyPorts: async () => {
        throw new Error("boom");
      },
    })
  );
  expect(proxyFailed.machine.find((f) => f.id === "proxy-ports")?.status).toBe(
    "incomplete"
  );
  expect(proxyFailed.ready).toBe(false);
  const daemon = failing.machine.find((f) => f.id === "daemon");
  expect(daemon?.summary).toContain("Not checked");
  // A probe that failed (not one disabled on purpose) leaves the check
  // unperformed: not ready.
  expect(daemon?.status).toBe("incomplete");
  expect(failing.ready).toBe(false);
});

test("tracked machine-local files and a missing .hack/.gitignore are steps, a tracked secret key blocks", async () => {
  const project = await liveProject("app-git");
  const git = (args: string[]) =>
    Bun.spawnSync(["git", "-C", project.repoRoot, ...args], {
      env: fixtureGitEnv({ env: { HOME: home } }),
    });
  git(["init", "-q"]);
  await writeFile(join(project.projectDir, ".env"), `TOKEN=${SENTINEL}\n`);
  git(["add", "-f", ".hack/.env", ".hack/hack.config.json"]);
  git(["commit", "-q", "-m", "fixture"]);
  await writeRegistry([project]);
  const report = await check(healthyProbes());
  const findings = new Map(
    report.projects[0]?.findings.map((f) => [f.id, f]) ?? []
  );
  expect(findings.get("tracked-files")?.status).toBe("warn");
  expect(findings.get("tracked-files")?.command).toBe(
    `hack doctor --fix --path ${project.repoRoot}`
  );
  expect(findings.get("ignore-rules")?.status).toBe("warn");

  await writeFile(join(project.repoRoot, ".hack.secret.key"), "x".repeat(43));
  git(["add", "-f", ".hack.secret.key"]);
  git(["commit", "-q", "-m", "key"]);
  const blocked = await check(healthyProbes());
  expect(blocked.ready).toBe(false);
  expect(
    blocked.blockers.some(
      (b) => b.scope === "app-git" && b.id === "tracked-files"
    )
  ).toBe(true);
  expect(JSON.stringify(blocked)).not.toContain(SENTINEL);
});

test("a checkout Git fails on is incomplete, not a directory without Git", async () => {
  if (process.getuid?.() === 0) {
    return; // root reads an unreadable index anyway
  }
  const project = await liveProject("app-broken-git");
  const git = (args: string[]) =>
    Bun.spawnSync(["git", "-C", project.repoRoot, ...args], {
      env: fixtureGitEnv({ env: { HOME: home } }),
    });
  git(["init", "-q"]);
  git(["add", "-f", ".hack/hack.config.json"]);
  git(["commit", "-q", "-m", "fixture"]);
  const index = join(project.repoRoot, ".git", "index");
  await chmod(index, 0o000);
  await writeRegistry([project]);
  try {
    const report = await check(healthyProbes());
    const tracked = report.projects[0]?.findings.find(
      (f) => f.id === "tracked-files"
    );
    expect(tracked?.status).toBe("incomplete");
    expect(report.ready).toBe(false);
  } finally {
    await chmod(index, 0o644);
  }
});

test("a checkout whose Git is broken leaves tracked files and ignore rules incomplete", async () => {
  const project = await liveProject("app-broken-dotgit");
  // A .git that git cannot use: inspections fail fast (exit 128).
  await mkdir(join(project.repoRoot, ".git"));
  await writeRegistry([project]);
  const report = await check(healthyProbes());
  const byId = new Map(
    report.projects[0]?.findings.map((f) => [f.id, f.status]) ?? []
  );
  expect(byId.get("tracked-files")).toBe("incomplete");
  expect(byId.get("ignore-rules")).toBe("incomplete");
  expect(report.ready).toBe(false);
});

test("an expired budget starts no probe and no registry read", async () => {
  await writeRegistry([await liveProject("app-a")]);
  let calls = 0;
  const healthy = healthyProbes();
  const counted =
    <A extends unknown[], T>(run: (...args: A) => Promise<T>) =>
    (...args: A): Promise<T> => {
      calls += 1;
      return run(...args);
    };
  const report = await runUpgradeCheck({
    cliVersion: "5.0.0-next.17",
    homeDir: home,
    budgetMs: 0,
    probes: {
      ...healthy,
      pathHack: counted(healthy.pathHack),
      daemon: counted(healthy.daemon),
      docker: counted(healthy.docker),
      globalInfra: counted(healthy.globalInfra),
      linuxDns: counted(healthy.linuxDns),
    },
  });
  expect(calls).toBe(0);
  expect(report.registry.state).toBe("unreadable");
  expect(report.ready).toBe(false);
});

test("a probe that would spawn after the deadline starts no child", async () => {
  const pids = join(root, "late-pids");
  const bin = join(root, "late-bin");
  await mkdir(bin, { recursive: true });
  await writeFile(
    join(bin, "late-probe"),
    `#!/bin/sh\necho "$$" >> '${pids}'\nexec sleep 60\n`,
    { mode: 0o755 }
  );
  await chmod(join(bin, "late-probe"), 0o755);
  const { exec } = await import("../src/lib/shell.ts");
  await runUpgradeCheck({
    cliVersion: "5.0.0-next.17",
    homeDir: home,
    budgetMs: 500,
    probes: healthyProbes({
      daemon: async () => {
        await Bun.sleep(1000);
        await exec([join(bin, "late-probe")], { stdin: "ignore" });
        throw new Error("the late probe has no result");
      },
    }),
  });
  // Give the late probe time to try.
  await Bun.sleep(1200);
  expect(await readFile(pids, "utf8").catch(() => "")).toBe("");
}, 20_000);

test("a reader key that cannot be established is incomplete, never retire advice", async () => {
  const reader = await liveProject("app-unknown-key");
  await writeRegistry([reader]);
  const { storePath, keyPath } = await globalStore({ reader });
  // The global key file is wrong; the reader names its own key file.
  await writeFile(keyPath, "synthetic-wrong-global-key\n", { mode: 0o600 });
  const ownKey = join(root, "unknown-own.key");
  await writeFile(
    join(reader.projectDir, "hack.config.json"),
    `${JSON.stringify({
      name: "app-unknown-key",
      controlPlane: {
        secrets: {
          backend: "encrypted_file",
          encryptedFile: { path: storePath, keyPath: ownKey },
        },
      },
    })}\n`
  );
  // Its key file is missing and the keychain fallback is on: not asked.
  Reflect.deleteProperty(process.env, "HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK");
  const uninspected = await check(healthyProbes());
  process.env.HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK = "1";
  const first = uninspected.machine.find((f) => f.id === "secret-store");
  expect(first?.status).toBe("incomplete");
  expect(first?.args).toEqual(["doctor"]);
  expect(uninspected.ready).toBe(false);

  // Its key file exists but cannot be read.
  if (process.getuid?.() !== 0) {
    await writeFile(ownKey, `${STORE_KEY}\n`, { mode: 0o600 });
    await chmod(ownKey, 0o000);
    try {
      const unreadable = await check(healthyProbes());
      const second = unreadable.machine.find((f) => f.id === "secret-store");
      expect(second?.status).toBe("incomplete");
      expect(second?.args).toEqual(["doctor"]);
    } finally {
      await chmod(ownKey, 0o600);
    }
  }
});

test("a snapshot that cannot cover everything says so", async () => {
  // A malformed registry: no project is covered.
  await writeFile(join(hackHome, "projects.json"), "{ not json");
  const malformed = await collectUpgradeSnapshotTargets();
  expect(malformed.gaps.map((g) => g.name)).toContain("projects registry");

  // An unreadable live checkout, and a skipped (linked) file.
  const live = await liveProject("app-live");
  await symlink(
    join(root, "elsewhere.env"),
    join(live.projectDir, "hack.env.json")
  );
  const broken = await liveProject("app-broken");
  await writeFile(join(broken.projectDir, "hack.config.json"), "{ not json");
  await writeRegistry([live, broken]);
  const partial = await collectUpgradeSnapshotTargets();
  const names = partial.gaps.map((g) => g.name);
  expect(names).toContain("app-broken");
  expect(names).toContain("project app-live: .hack/hack.env.json");
});

test("a registered linked worktree is checked on its own and can block", async () => {
  const project = await liveProject("app-wt");
  const worktreeRoot = join(root, "worktrees", "feature");
  const worktreeDir = join(worktreeRoot, ".hack");
  await mkdir(worktreeDir, { recursive: true });
  await writeFile(
    join(worktreeDir, "hack.config.json"),
    `${JSON.stringify({ name: "app-wt" })}\n`
  );
  await symlink(
    join(root, "nowhere.yaml"),
    join(worktreeDir, "hack.env.default.yaml")
  );
  await writeRegistry([
    {
      ...project,
      worktrees: [
        {
          path: worktreeRoot,
          branch: "feature",
          lastSeenAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    },
  ]);
  const report = await check(healthyProbes());
  expect(report.registry.live).toBe(2);
  expect(report.ready).toBe(false);
  expect(report.blockers.map((b) => b.scope)).toEqual([
    "app-wt (worktree feature)",
  ]);
});

test("printed commands run the candidate launcher when the check ran through it", async () => {
  const legacy = await liveProject("app-legacy");
  await writeFile(join(legacy.projectDir, "hack.env.json"), "{}\n");
  await writeRegistry([legacy]);
  const report = await runUpgradeCheck({
    cliVersion: "5.0.0-next.17",
    homeDir: home,
    probes: healthyProbes(),
    env: {
      HACK_CANDIDATE_ENTRYPOINT: "hack-next",
      HACK_RUNTIME_BACKEND: "compose",
    },
  });
  const launcher = `HACK_RUNTIME_BACKEND=compose ${join(home, ".hack-next", "bin", "hack-next")}`;
  expect(report.cli.command).toBe(launcher);
  expect(report.next_command).toBe(`${launcher} upgrade snapshot`);
  for (const step of report.plan) {
    expect((step.command ?? `${launcher} `).startsWith(`${launcher} `)).toBe(
      true
    );
  }
});

/** A global encrypted_file store with one entry, and its key file. */
async function globalStore(opts: {
  readonly reader: Entry;
  readonly entries?: Readonly<Record<string, string>>;
}) {
  const storePath = join(hackHome, "secrets.enc.json");
  const keyPath = join(hackHome, "secrets-file.key");
  await writeFile(
    process.env.HACK_GLOBAL_CONFIG_PATH ?? "",
    `${JSON.stringify({
      controlPlane: {
        secrets: {
          backend: "encrypted_file",
          encryptedFile: { path: storePath, keyPath },
        },
      },
    })}\n`
  );
  await writeFile(
    join(opts.reader.projectDir, "hack.env.json"),
    `${JSON.stringify({ version: 1, vars: [{ key: "TOKEN", source: "keychain" }] })}\n`
  );
  await writeFile(keyPath, `${STORE_KEY}\n`, { mode: 0o600 });
  await chmod(keyPath, 0o600);
  const store = await resolveSecretStore({
    projectName: opts.reader.name,
    projectDir: opts.reader.projectDir,
  });
  for (const [key, value] of Object.entries(
    opts.entries ?? { TOKEN: SENTINEL }
  )) {
    await store.set({ key, value });
  }
  return { storePath, keyPath };
}

test("the global key is audited with the runtime's rules, not only by decrypting", async () => {
  const reader = await liveProject("app-reader");
  await writeRegistry([reader]);
  const { keyPath } = await globalStore({ reader });
  const storeFinding = async () =>
    (await check(healthyProbes())).machine.find((f) => f.id === "secret-store");

  expect((await storeFinding())?.status).toBe("ok");

  // A key others can read decrypts the store, but the runtime refuses it.
  await chmod(keyPath, 0o644);
  const permissive = await storeFinding();
  expect(permissive?.status).toBe("blocker");
  expect(permissive?.summary).toContain("refused at runtime");
  expect(permissive?.action).toContain("chmod 600");
  await chmod(keyPath, 0o600);

  // The same key tracked by Git is refused too.
  const repo = join(root, "keys-repo");
  await mkdir(repo, { recursive: true });
  const trackedKey = join(repo, "secrets-file.key");
  await writeFile(trackedKey, `${STORE_KEY}\n`, { mode: 0o600 });
  await chmod(trackedKey, 0o600);
  const git = (args: string[]) =>
    Bun.spawnSync(["git", "-C", repo, ...args], {
      env: fixtureGitEnv({ env: { HOME: home } }),
    });
  git(["init", "-q"]);
  git(["add", "-f", "secrets-file.key"]);
  git(["commit", "-q", "-m", "key"]);
  const config = JSON.parse(
    await readFile(process.env.HACK_GLOBAL_CONFIG_PATH ?? "", "utf8")
  ) as { controlPlane: { secrets: { encryptedFile: { keyPath: string } } } };
  config.controlPlane.secrets.encryptedFile.keyPath = trackedKey;
  await writeFile(
    process.env.HACK_GLOBAL_CONFIG_PATH ?? "",
    `${JSON.stringify(config)}\n`
  );
  const tracked = await storeFinding();
  expect(tracked?.status).toBe("blocker");
  expect(tracked?.action).toContain("git tracks it");
});

test("a dead registry entry does not leave a healthy store check incomplete", async () => {
  // Codex review: a deleted checkout counted as an unchecked store reader,
  // so a healthy machine could not be ready until stale entries were pruned.
  const reader = await liveProject("app-reader");
  await writeRegistry([reader, entry("app-deleted")]);
  await globalStore({ reader });
  const report = await check(healthyProbes());
  const store = report.machine.find((f) => f.id === "secret-store");
  expect(store?.status).toBe("ok");
  expect(report.incomplete).toEqual([]);
  // The dead entry is reported as a registry step, not as store uncertainty.
  expect(report.machine.find((f) => f.id === "registry-dead")?.status).toBe(
    "warn"
  );
});

test("a project that names its own working key is not blocked by a broken global key", async () => {
  // Codex review: the global key file decided for every reader, though a
  // project may select the global store with its own keyPath.
  const reader = await liveProject("app-own-key");
  await writeRegistry([reader]);
  const { storePath, keyPath } = await globalStore({ reader });
  const ownKey = join(root, "own.key");
  await writeFile(ownKey, `${STORE_KEY}\n`, { mode: 0o600 });
  await chmod(ownKey, 0o600);
  await writeFile(
    join(reader.projectDir, "hack.config.json"),
    `${JSON.stringify({
      name: "app-own-key",
      controlPlane: {
        secrets: {
          backend: "encrypted_file",
          encryptedFile: { path: storePath, keyPath: ownKey },
        },
      },
    })}\n`
  );
  // The global key file is now wrong.
  await writeFile(keyPath, "synthetic-wrong-global-key\n", { mode: 0o600 });
  const report = await check(healthyProbes());
  const store = report.machine.find((f) => f.id === "secret-store");
  expect(store?.status).toBe("warn");
  expect(store?.summary).toContain("app-own-key");
  expect(report.ready).toBe(true);

  // A second reader on the broken global key is blocked, and retiring is
  // not suggested while another configured key opens the store.
  const other = await liveProject("app-global-key");
  await writeFile(
    join(other.projectDir, "hack.env.json"),
    `${JSON.stringify({ version: 1, vars: [{ key: "TOKEN", source: "keychain" }] })}\n`
  );
  await writeRegistry([reader, other]);
  const blocked = await check(healthyProbes());
  const blocking = blocked.machine.find((f) => f.id === "secret-store");
  expect(blocking?.status).toBe("blocker");
  expect(blocking?.summary).toContain("app-global-key");
  expect(blocking?.args).toEqual(["doctor"]);
  expect(blocking?.action).toContain("app-global-key");
  expect(JSON.stringify(blocked)).not.toContain(STORE_KEY);
});

test("a reader whose own key does not open the store blocks even when the global key works", async () => {
  // Codex review: reader keys were checked only when the global key failed.
  const reader = await liveProject("app-wrong-own-key");
  await writeRegistry([reader]);
  const { storePath } = await globalStore({ reader });
  const ownKey = join(root, "wrong-own.key");
  await writeFile(ownKey, "synthetic-wrong-own-key\n", { mode: 0o600 });
  await chmod(ownKey, 0o600);
  await writeFile(
    join(reader.projectDir, "hack.config.json"),
    `${JSON.stringify({
      name: "app-wrong-own-key",
      controlPlane: {
        secrets: {
          backend: "encrypted_file",
          encryptedFile: { path: storePath, keyPath: ownKey },
        },
      },
    })}\n`
  );
  const report = await check(healthyProbes());
  const store = report.machine.find((f) => f.id === "secret-store");
  expect(store?.status).toBe("blocker");
  expect(store?.summary).toContain("app-wrong-own-key");
  expect(report.ready).toBe(false);
});

test("the global store's states: no store, an env key, a keychain not asked", async () => {
  const reader = await liveProject("app-reader");
  await writeRegistry([reader]);
  const { storePath, keyPath } = await globalStore({ reader });
  const finding = async (env?: Record<string, string>) => {
    const report = await runUpgradeCheck({
      cliVersion: "5.0.0-next.17",
      homeDir: home,
      probes: healthyProbes(),
      // Only the variables the check reads; never the runner's environment.
      env: { ...env },
    });
    return {
      report,
      store: report.machine.find((f) => f.id === "secret-store"),
    };
  };
  // HACK_SECRETS_FILE_KEY from this shell opens it; the value never shows.
  await rm(keyPath);
  const viaEnv = await finding({ HACK_SECRETS_FILE_KEY: STORE_KEY });
  expect(viaEnv.store?.status).toBe("ok");
  expect(viaEnv.store?.summary).toContain("HACK_SECRETS_FILE_KEY");
  expect(JSON.stringify(viaEnv.report)).not.toContain(STORE_KEY);
  expect(JSON.stringify(viaEnv.report)).not.toContain(SENTINEL);

  // No key file and the keychain fallback on: not asked, so not established.
  Reflect.deleteProperty(process.env, "HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK");
  const uninspected = await finding();
  expect(uninspected.store?.status).toBe("incomplete");
  expect(uninspected.report.ready).toBe(false);
  process.env.HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK = "1";

  // No store file at all is not a store that lost its key.
  await rm(storePath);
  const none = await finding();
  expect(none.store?.status).toBe("ok");
  expect(none.store?.summary).toContain("No global secret store file");
});

test("the snapshot covers overlays only the store holds, and reports when it cannot list them", async () => {
  const reader = await liveProject("app-reader");
  await writeRegistry([reader]);
  const { keyPath } = await globalStore({
    reader,
    entries: { TOKEN: SENTINEL, "env.staging.TOKEN": SENTINEL },
  });
  const covered = await collectUpgradeSnapshotTargets();
  const labels = covered.targets.map((t) => t.label);
  expect(labels).toContain("project app-reader: .hack/hack.env.staging.yaml");
  expect(labels).toContain(
    "project app-reader: .hack/hack.env.staging.local.yaml"
  );
  expect(covered.gaps).toEqual([]);
  expect(JSON.stringify(covered)).not.toContain(SENTINEL);

  // Only the keychain could open the store: listing it would prompt.
  await rm(keyPath);
  Reflect.deleteProperty(process.env, "HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK");
  const gapped = await collectUpgradeSnapshotTargets();
  process.env.HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK = "1";
  expect(gapped.gaps).toEqual([
    { name: "app-reader", reason: expect.stringContaining("OS keychain") },
  ]);
});

test("the snapshot keeps a project's own secret store and key", async () => {
  // Codex review: migration cleanup can remove a project-selected store and
  // key; only the global backend was kept.
  const project = await liveProject("app-own-store");
  const storePath = join(project.projectDir, "secrets.enc.json");
  const keyPath = join(project.repoRoot, ".store.key");
  await writeFile(
    join(project.projectDir, "hack.config.json"),
    `${JSON.stringify({
      name: "app-own-store",
      controlPlane: {
        secrets: {
          backend: "encrypted_file",
          encryptedFile: { path: storePath, keyPath },
        },
      },
    })}\n`
  );
  await writeFile(storePath, `{"sentinel":"${SENTINEL}"}\n`, { mode: 0o600 });
  await writeFile(keyPath, `${STORE_KEY}\n`, { mode: 0o600 });
  await writeRegistry([project]);
  const collected = await collectUpgradeSnapshotTargets();
  const byLabel = new Map(collected.targets.map((t) => [t.label, t.path]));
  expect(byLabel.get("project app-own-store: secret store")).toBe(storePath);
  expect(byLabel.get("project app-own-store: secret store key")).toBe(keyPath);
  expect(JSON.stringify(collected)).not.toContain(SENTINEL);
});

test("a project's own secret store is checked with the key it selects", async () => {
  // Codex review: only the global store was checked, so a project-selected
  // store with a wrong key passed.
  const project = await liveProject("app-own-store");
  const storePath = join(project.projectDir, "secrets.enc.json");
  const keyPath = join(project.repoRoot, ".store.key");
  await writeFile(
    join(project.projectDir, "hack.config.json"),
    `${JSON.stringify({
      name: "app-own-store",
      controlPlane: {
        secrets: {
          backend: "encrypted_file",
          encryptedFile: { path: storePath, keyPath },
        },
      },
    })}\n`
  );
  await writeFile(
    join(project.projectDir, "hack.env.json"),
    `${JSON.stringify({ version: 1, vars: [{ key: "TOKEN", source: "keychain" }] })}\n`
  );
  await writeFile(keyPath, `${STORE_KEY}\n`, { mode: 0o600 });
  await chmod(keyPath, 0o600);
  await (
    await resolveSecretStore({
      projectName: "app-own-store",
      projectDir: project.projectDir,
    })
  ).set({ key: "TOKEN", value: SENTINEL });
  await writeRegistry([project]);
  const good = await check(healthyProbes());
  const finding = (r: UpgradeCheckReport) =>
    r.projects[0]?.findings.find((f) => f.id === "project-store");
  expect(finding(good)?.status).toBe("ok");

  await writeFile(keyPath, "synthetic-wrong-project-key\n", { mode: 0o600 });
  const bad = await check(healthyProbes());
  expect(finding(bad)?.status).toBe("blocker");
  expect(bad.ready).toBe(false);
  expect(JSON.stringify(bad)).not.toContain(SENTINEL);
  expect(JSON.stringify(bad)).not.toContain(STORE_KEY);
});

test("a refused project key's remedy quotes a hostile path", async () => {
  // Second-family review: the runtime's "Run: chmod 600 <path>" interpolated a
  // repo-controlled key path into shell text.
  const project = await liveProject("app-hostile-key");
  const storePath = join(project.projectDir, "secrets.enc.json");
  const keyPath = join(
    project.repoRoot,
    "key it's here; printf REVIEW_MARKER; #"
  );
  await writeFile(
    join(project.projectDir, "hack.config.json"),
    `${JSON.stringify({
      name: "app-hostile-key",
      controlPlane: {
        secrets: {
          backend: "encrypted_file",
          encryptedFile: { path: storePath, keyPath },
        },
      },
    })}\n`
  );
  await writeFile(
    join(project.projectDir, "hack.env.json"),
    `${JSON.stringify({ version: 1, vars: [{ key: "TOKEN", source: "keychain" }] })}\n`
  );
  await writeFile(keyPath, `${STORE_KEY}\n`, { mode: 0o600 });
  await chmod(keyPath, 0o600);
  await (
    await resolveSecretStore({
      projectName: "app-hostile-key",
      projectDir: project.projectDir,
    })
  ).set({ key: "TOKEN", value: SENTINEL });
  await chmod(keyPath, 0o644);
  await writeRegistry([project]);
  const report = await check(healthyProbes());
  const finding = report.projects[0]?.findings.find(
    (f) => f.id === "project-store"
  );
  expect(finding?.status).toBe("blocker");
  const command = (finding?.action ?? "").split("Run: ")[1] ?? "";
  // Split it the way a shell does: exactly chmod, 600 and that file.
  const split = Bun.spawnSync([
    "sh",
    "-c",
    `eval "set -- $1"; printf '%s\\0' "$@"`,
    "sh",
    command,
  ]);
  const out = split.stdout.toString();
  expect(out).not.toContain("REVIEW_MARKER\0");
  expect(out.split("\0").slice(0, -1)).toEqual(["chmod", "600", keyPath]);
});

test("Docker answering but the container listing failing is incomplete", async () => {
  await writeRegistry([await liveProject("app-a")]);
  const report = await check(
    healthyProbes({
      globalInfra: async () => ({
        installed: true,
        running: null,
        listFailed: true,
      }),
    })
  );
  expect(report.machine.find((f) => f.id === "global-infra")?.status).toBe(
    "incomplete"
  );
  expect(report.ready).toBe(false);
});

test("the snapshot covers the configured default overlay with a keychain backend", async () => {
  // Codex review: with no file store active, only .env.<name> files were
  // considered, though the migration also converts the configured default
  // overlay.
  const project = await liveProject("app-keychain");
  await writeFile(
    join(project.projectDir, "hack.config.json"),
    `${JSON.stringify({ name: "app-keychain", env: { defaultOverlay: "staging" } })}\n`
  );
  await writeFile(join(project.projectDir, "hack.env.json"), "{}\n");
  await writeRegistry([project]);
  const collected = await collectUpgradeSnapshotTargets();
  const labels = collected.targets.map((t) => t.label);
  expect(labels).toContain("project app-keychain: .hack/hack.env.staging.yaml");
  expect(labels).toContain(
    "project app-keychain: .hack/hack.env.staging.local.yaml"
  );
});

test("store-only overlays are found under a name set in the legacy hack.toml", async () => {
  // Codex review: the snapshot read the name from hack.config.json only.
  const project = entry("checkout-dir");
  await mkdir(project.projectDir, { recursive: true });
  await writeFile(
    join(project.projectDir, "hack.toml"),
    'name = "toml-named"\n'
  );
  await writeFile(
    join(project.projectDir, "docker-compose.yml"),
    "services: {}\n"
  );
  await writeRegistry([project]);
  // A global store holding a staging-only value for "toml-named".
  const storePath = join(hackHome, "secrets.enc.json");
  const keyPath = join(hackHome, "secrets-file.key");
  await writeFile(
    process.env.HACK_GLOBAL_CONFIG_PATH ?? "",
    `${JSON.stringify({
      controlPlane: {
        secrets: {
          backend: "encrypted_file",
          encryptedFile: { path: storePath, keyPath },
        },
      },
    })}\n`
  );
  await writeFile(
    join(project.projectDir, "hack.env.json"),
    `${JSON.stringify({ version: 1, vars: [{ key: "TOKEN", source: "keychain" }] })}\n`
  );
  await writeFile(keyPath, `${STORE_KEY}\n`, { mode: 0o600 });
  await chmod(keyPath, 0o600);
  await (
    await resolveSecretStore({
      projectName: "toml-named",
      projectDir: project.projectDir,
    })
  ).set({ key: "env.staging.TOKEN", value: SENTINEL });
  const collected = await collectUpgradeSnapshotTargets();
  expect(collected.targets.map((t) => t.label)).toContain(
    "project checkout-dir: .hack/hack.env.staging.yaml"
  );
});

test("a project directory that cannot be listed is a snapshot gap, not an empty inventory", async () => {
  if (process.getuid?.() === 0) {
    return; // root lists any directory
  }
  const project = await liveProject("app-unlisted");
  await writeFile(join(project.projectDir, ".env"), `TOKEN=${SENTINEL}\n`);
  await writeRegistry([project]);
  // Searchable (its config still reads) but not listable.
  await chmod(project.projectDir, 0o300);
  try {
    const collected = await collectUpgradeSnapshotTargets();
    expect(collected.gaps).toContainEqual({
      name: "app-unlisted",
      reason: expect.stringContaining("could not be listed"),
    });
  } finally {
    await chmod(project.projectDir, 0o755);
  }
});

test("env layer secrets must open under the project env key", async () => {
  // Codex review: a missing or wrong env key passed as "none needed yet".
  const project = await liveProject("app-env-secrets");
  await setProjectEnvValue({
    projectRoot: project.repoRoot,
    projectDir: project.projectDir,
    envName: null,
    scope: "global",
    key: "TOKEN",
    value: SENTINEL,
    secret: true,
  });
  await writeRegistry([project]);
  const finding = (r: UpgradeCheckReport) =>
    r.projects[0]?.findings.find((f) => f.id === "env-secrets");
  const good = await check(healthyProbes());
  expect(finding(good)?.status).toBe("ok");

  const keyFile = join(project.repoRoot, ".hack.secret.key");
  const key = await readFile(keyFile, "utf8");
  await rm(keyFile);
  const missing = await check(healthyProbes());
  expect(finding(missing)?.status).toBe("blocker");
  expect(missing.ready).toBe(false);

  await writeFile(keyFile, `${"A".repeat(43)}\n`, { mode: 0o600 });
  await chmod(keyFile, 0o600);
  const wrong = await check(healthyProbes());
  expect(finding(wrong)?.status).toBe("blocker");
  for (const report of [good, missing, wrong]) {
    expect(JSON.stringify(report)).not.toContain(SENTINEL);
    expect(JSON.stringify(report)).not.toContain(key.trim());
  }
});

test("a config path that is a FIFO is refused at once, never waited on", async () => {
  const project = entry("app-fifo");
  await mkdir(project.projectDir, { recursive: true });
  Bun.spawnSync(["mkfifo", join(project.projectDir, "hack.config.json")]);
  await writeRegistry([project]);
  const started = Date.now();
  const report = await check(healthyProbes());
  expect(Date.now() - started).toBeLessThan(10_000);
  expect(report.registry.unreadable.map((e) => e.name)).toEqual(["app-fifo"]);
  expect(report.ready).toBe(false);
});

test("a hanging git leaves the required check incomplete, and its children are ended", async () => {
  const project = await liveProject("app-hang");
  const bin = join(root, "fake-bin");
  await mkdir(bin, { recursive: true });
  const pids = join(root, "git-pids");
  await writeFile(
    join(bin, "git"),
    `#!/bin/sh\necho "$$ $*" >> '${pids}'\nexec sleep 60\n`,
    { mode: 0o755 }
  );
  await chmod(join(bin, "git"), 0o755);
  await writeRegistry([project]);
  process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
  const started = Date.now();
  const report = await runUpgradeCheck({
    cliVersion: "5.0.0-next.17",
    homeDir: home,
    probes: healthyProbes(),
    budgetMs: 4000,
    checkTimeoutMs: 1500,
  });
  expect(Date.now() - started).toBeLessThan(10_000);
  const findings = new Map(
    report.projects[0]?.findings.map((f) => [f.id, f]) ?? []
  );
  expect(findings.get("tracked-files")?.status).toBe("incomplete");
  expect(report.ready).toBe(false);
  expect(report.incomplete.some((i) => i.id === "tracked-files")).toBe(true);
  // Every git the check started is ended by the check's own deadline.
  const alive = async () =>
    (await readFile(pids, "utf8").catch(() => ""))
      .split("\n")
      .filter((line) => line.trim() !== "")
      .filter((line) => {
        try {
          process.kill(Number(line.split(" ")[0]), 0);
          return true;
        } catch {
          return false;
        }
      });
  // Each check's children end with the check: allow only kill latency.
  const until = Date.now() + 3000;
  while ((await alive()).length > 0 && Date.now() < until) {
    await Bun.sleep(250);
  }
  expect(await alive()).toEqual([]);
}, 40_000);

test("a host probe's children end with the probe, not after the report", async () => {
  // Codex review: the probe deadline stopped waiting but left children.
  const pids = join(root, "probe-pids");
  const bin = join(root, "probe-bin");
  await mkdir(bin, { recursive: true });
  await writeFile(
    join(bin, "slow-probe"),
    `#!/bin/sh\necho "$$" >> '${pids}'\nexec sleep 60\n`,
    { mode: 0o755 }
  );
  await chmod(join(bin, "slow-probe"), 0o755);
  const { exec } = await import("../src/lib/shell.ts");
  const started = Date.now();
  await runUpgradeCheck({
    cliVersion: "5.0.0-next.17",
    homeDir: home,
    budgetMs: 3000,
    probes: healthyProbes({
      // A probe that runs a hanging command with no limit of its own.
      daemon: async () => {
        await exec([join(bin, "slow-probe")], { stdin: "ignore" });
        throw new Error("unreachable");
      },
    }),
  });
  expect(Date.now() - started).toBeLessThan(8000);
  const until = Date.now() + 3000;
  const alive = async () =>
    (await readFile(pids, "utf8").catch(() => ""))
      .split("\n")
      .filter((pid) => pid.trim() !== "")
      .filter((pid) => {
        try {
          process.kill(Number(pid), 0);
          return true;
        } catch {
          return false;
        }
      });
  while ((await alive()).length > 0 && Date.now() < until) {
    await Bun.sleep(200);
  }
  expect(await alive()).toEqual([]);
}, 20_000);

test("candidate commands keep a path with spaces, quotes and ' hack ' intact", async () => {
  const name = "my hack repo's";
  const project = await liveProject(name);
  await writeFile(join(project.projectDir, "hack.env.json"), "{}\n");
  await writeRegistry([project]);
  const weirdHome = join(root, "home with space's");
  const report = await runUpgradeCheck({
    cliVersion: "5.0.0-next.17",
    homeDir: weirdHome,
    probes: healthyProbes(),
    env: {
      HACK_CANDIDATE_ENTRYPOINT: "hack-next",
      HACK_RUNTIME_BACKEND: "compose",
    },
  });
  const step = report.plan.find((s) => s.id === "env-format");
  expect(step?.args).toEqual([
    "doctor",
    "--migrate-env-config",
    "--path",
    project.repoRoot,
  ]);
  // Split the command the way a shell does: every argument survives.
  const split = Bun.spawnSync([
    "sh",
    "-c",
    `eval "set -- $1"; printf '%s\\0' "$@"`,
    "sh",
    step?.command ?? "",
  ]);
  const words = split.stdout.toString().split("\0").slice(0, -1);
  expect(words).toEqual([
    "HACK_RUNTIME_BACKEND=compose",
    join(weirdHome, ".hack-next", "bin", "hack-next"),
    "doctor",
    "--migrate-env-config",
    "--path",
    project.repoRoot,
  ]);
});

test("a step with no command is manual: its action is never shown as a command", async () => {
  await writeFile(join(hackHome, "projects.json"), "{ not json");
  const report = await check(healthyProbes());
  const registry = report.plan.find((step) => step.id === "registry");
  expect(registry?.command).toBeNull();
  expect(registry?.args).toBeNull();
  expect(registry?.action).toContain("Repair");
  expect(report.ready).toBe(false);
  // The first step is the snapshot, a real command.
  expect(report.next_command).toBe("hack upgrade snapshot");
  expect(report.next_action).toBeNull();
});

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

test("hack upgrade check exits 1 naming the blockers, and prints the next command", async () => {
  const blocked = await liveProject("app-blocked");
  await symlink(
    join(root, "nowhere.yaml"),
    join(blocked.projectDir, "hack.env.default.yaml")
  );
  await writeRegistry([blocked]);
  const json = await cli(["upgrade", "check", "--json"]);
  expect(json.code).toBe(1);
  const parsed = JSON.parse(json.stdout) as {
    ok: boolean;
    data: UpgradeCheckReport;
  };
  expect(parsed.ok).toBe(true);
  expect(parsed.data.ready).toBe(false);
  expect(parsed.data.blockers[0]?.scope).toBe("app-blocked");

  const text = await cli(["upgrade", "check"]);
  expect(text.code).toBe(1);
  expect(text.stdout).toContain("Blocked by: app-blocked env-format");
  expect(text.stdout).toContain("Next: hack upgrade snapshot");
  expect(text.stdout).toContain("[blocker] hack doctor --path");
}, 60_000);

test("hack upgrade snapshot, then rollback restores exact bytes; a changed file needs --overwrite", async () => {
  const project = await liveProject("app-a");
  const envPath = join(project.projectDir, ".env");
  await writeFile(envPath, `TOKEN=${SENTINEL}\n`, { mode: 0o600 });
  await chmod(envPath, 0o600);
  const configPath = join(project.projectDir, "hack.config.json");
  await writeRegistry([project]);
  const envBefore = await readFile(envPath);
  const configBefore = await readFile(configPath);

  const made = await cli(["upgrade", "snapshot", "--json"]);
  expect(made.code).toBe(0);
  const snapshot = (
    JSON.parse(made.stdout) as {
      data: {
        manifest_path: string;
        rollback_command: string;
        files: { label: string }[];
      };
    }
  ).data;
  const labels = snapshot.files.map((f) => f.label);
  for (const label of [
    "global: projects.json",
    "project app-a: .hack/.env",
    "project app-a: .hack/hack.config.json",
    // The env migration's write set, recorded even while absent.
    "project app-a: .hack/docker-compose.yml",
    "project app-a: .hack/hack.env.default.yaml",
    "project app-a: .hack/.gitignore",
  ]) {
    expect(labels).toContain(label);
  }
  expect(made.output).not.toContain(SENTINEL);
  expect(await readFile(snapshot.manifest_path, "utf8")).not.toContain(
    SENTINEL
  );

  // Change one file, delete another and create a layer, as the env
  // migration does.
  await writeFile(configPath, '{"name":"app-a","v":5}\n');
  await rm(envPath);
  const layerPath = join(project.projectDir, "hack.env.default.yaml");
  await writeFile(layerPath, "vars: {}\n");

  // Without --overwrite, the changed config is refused; the deleted .env is
  // put back only with --overwrite too (no step recorded what it wrote).
  const refused = await cli([
    "upgrade",
    "rollback",
    "--rollback-manifest",
    snapshot.manifest_path,
  ]);
  expect(refused.code).toBe(1);
  expect(refused.stdout).toContain("conflict");
  expect(await readFile(configPath, "utf8")).toBe('{"name":"app-a","v":5}\n');

  const restored = await cli([
    "upgrade",
    "rollback",
    "--rollback-manifest",
    snapshot.manifest_path,
    "--overwrite",
    "--json",
  ]);
  expect(restored.code).toBe(0);
  expect(await readFile(envPath)).toEqual(envBefore);
  expect(await readFile(configPath)).toEqual(configBefore);
  // The created layer is moved into the snapshot, not left in place.
  expect(await lstat(layerPath).catch(() => null)).toBeNull();
  expect(restored.output).not.toContain(SENTINEL);

  // Without a manifest it lists snapshots and changes nothing.
  const listed = await cli(["upgrade", "rollback"]);
  expect(listed.code).toBe(1);
  expect(listed.stdout).toContain("Choose a snapshot to restore");
  expect(listed.stdout).toContain(snapshot.manifest_path);
}, 60_000);
