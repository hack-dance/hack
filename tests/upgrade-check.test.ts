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

import {
  runUpgradeCheck,
  type UpgradeCheckReport,
} from "../src/lib/upgrade-check.ts";
import {
  defaultUpgradeCheckProbes,
  type UpgradeCheckProbes,
} from "../src/lib/upgrade-check-probes.ts";
import { inspectUpgradeProject } from "../src/lib/upgrade-check-project.ts";
import { restoreEnv } from "./helpers/env.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

// Values that must never appear in any report, plan or output.
const SENTINEL = ["sentinel", "upgrade", "check", "c41d07"].join("-");
const ENTRYPOINT = resolve(import.meta.dir, "..", "index.ts");

const ISOLATED_ENV = [
  "HOME",
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
  expect(dead77?.fix).toBe("hack projects prune --dry-run");
  expect(dead77?.summary).toContain("not live projects that failed to read");
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
    project,
    homeDir: home,
    deadline: Date.now() - 1,
    nativePreflight: async () => {
      ran = true;
      return null;
    },
  });
  expect(ran).toBe(false);
  expect(findings.length).toBeGreaterThan(0);
  for (const finding of findings) {
    expect(finding.status).toBe("warn");
    expect(finding.summary).toContain("ran out of time");
  }
});

test("the plan puts blockers first, then the snapshot, then machine and project steps", async () => {
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
    ["env-format", "app-blocked", true],
    ["snapshot", "machine", false],
    ["registry-dead", "machine", false],
    ["global-infra", "machine", false],
    ["env-format", "app-legacy", false],
  ]);
  expect(report.next_command).toBe(report.plan[0]?.command ?? "");
  const legacyStep = report.plan.find((step) => step.scope === "app-legacy");
  expect(legacyStep?.command).toBe(
    `hack doctor --migrate-env-config --path ${legacy.repoRoot}`
  );
  expect(legacyStep?.why).toContain("legacy-json, dotenv");
});

test("a host with nothing to do is ready, with no plan and no next command", async () => {
  const current = await liveProject("app-current");
  await writeFile(
    join(current.projectDir, "hack.env.default.yaml"),
    "vars: {}\n"
  );
  await writeRegistry([current]);
  const report = await check(healthyProbes());
  expect(report.ready).toBe(true);
  expect(report.plan).toEqual([]);
  expect(report.next_command).toBeNull();
  expect(report.cli).toEqual({
    version: "5.0.0-next.17",
    channel: "next",
    candidate_run: false,
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
  expect(blocked.plan[0]?.id).toBe("secret-store");
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
  // A probe that throws or hangs does not stop the check.
  const failing = await check(
    healthyProbes({
      daemon: async () => {
        throw new Error("boom");
      },
    })
  );
  expect(failing.machine.find((f) => f.id === "daemon")?.summary).toContain(
    "Not checked"
  );
});

test("tracked machine-local files and a missing .hack/.gitignore are steps, a tracked secret key blocks", async () => {
  const project = await liveProject("app-git");
  const git = (args: string[]) =>
    Bun.spawnSync(["git", "-C", project.repoRoot, ...args], {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.invalid",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.invalid",
      },
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
  expect(findings.get("tracked-files")?.fix).toBe(
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
  expect(text.stdout).toContain("Next: hack doctor --path");
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
  expect(snapshot.files.map((f) => f.label).sort()).toEqual([
    "global: projects.json",
    "project app-a: .hack/.env",
    "project app-a: .hack/hack.config.json",
  ]);
  expect(made.output).not.toContain(SENTINEL);
  expect(await readFile(snapshot.manifest_path, "utf8")).not.toContain(
    SENTINEL
  );

  // Change one file and delete another, as a manual upgrade step might.
  await writeFile(configPath, '{"name":"app-a","v":5}\n');
  await rm(envPath);

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
  expect(restored.output).not.toContain(SENTINEL);

  // Without a manifest it lists snapshots and changes nothing.
  const listed = await cli(["upgrade", "rollback"]);
  expect(listed.code).toBe(1);
  expect(listed.stdout).toContain("Choose a snapshot to restore");
  expect(listed.stdout).toContain(snapshot.manifest_path);
}, 60_000);
