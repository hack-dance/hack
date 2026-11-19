#!/usr/bin/env bun
/**
 * VM check for `localDirectories` on the native backend (HACK-2358).
 *
 * Usage: bun scripts/check-native-local-directories.ts
 *          --hack PATH --native-home DIR [--work DIR] [--keep]
 *          [--start-timeout SECONDS] [--install-timeout SECONDS]
 *
 *   --hack         the CLI under test (a prepared `hack-next` launcher)
 *   --native-home  that install's native home (exported as HACK_NATIVE_HOME)
 *   --work         parent directory for the copied project (default: TMPDIR)
 *   --keep         leave the project and its run in place at the end
 *
 * Copies `scripts/fixtures/runtime-bench` to a fresh directory, makes it a git
 * repository, declares `localDirectories`, and runs the project on native in
 * shared-source mode (HACK_NATIVE_SHARED_SOURCE=1). It prints one PASS, FAIL
 * or INFO line per point, with the evidence under it:
 *
 *   1. each declared directory is its own mount inside the service, on the
 *      guest disk, not the share (mount source and filesystem type);
 *   2. an install inside the service lands there, the host checkout's
 *      directory stays empty, and how long the install took;
 *   3. what appears in the host checkout at each declared path (owner, mode)
 *      and whether `git status` is clean afterwards;
 *   4. `down --remove-data` deletes the volumes (a marker written in one is
 *      gone after the next up), and how many volumes the run uses against
 *      the 16-volume limit (counted from the native model this checkout
 *      builds);
 *   5. adding a directory to a project that already has a run: what `up` and
 *      `restart` do, with the exact lines they print;
 *   6. a detached `up --json` with a notice: stdout is one JSON envelope and
 *      the notice is on stderr.
 *
 * Every spawn has a timeout. It prints no environment values. It needs
 * network access for the install in point 2.
 */
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    hack: { type: "string" },
    "native-home": { type: "string" },
    work: { type: "string" },
    keep: { type: "boolean", default: false },
    "start-timeout": { type: "string", default: "1800" },
    "install-timeout": { type: "string", default: "900" },
  },
});

function fail(message: string): never {
  process.stderr.write(`check-native-local-directories: ${message}\n`);
  process.exit(2);
}

const hack = values.hack ? resolve(values.hack) : fail("--hack is required");
const nativeHome = values["native-home"]
  ? resolve(values["native-home"])
  : fail("--native-home is required");
const startTimeout = Number(values["start-timeout"]);
const installTimeout = Number(values["install-timeout"]);
if (!(startTimeout > 0 && installTimeout > 0)) {
  fail("timeouts must be positive numbers of seconds");
}

const repo = resolve(dirname(import.meta.path), "..");
const fixture = join(repo, "scripts/fixtures/runtime-bench");
const work = mkdtempSync(
  join(values.work ? resolve(values.work) : tmpdir(), "hack-local-dirs-")
);
const project = join(work, "project");
const configPath = join(project, ".hack/hack.config.json");

/** The declared directories. `web` binds `../web:/app`. */
const ENTRIES = ["web/node_modules", "web/dist"] as const;
const TARGETS: Record<string, string> = {
  "web/node_modules": "/app/node_modules",
  "web/dist": "/app/dist",
};
/** Added to a running project in point 5; `api` binds `../api:/app`. */
const ADDED = "api/.cache";
/** No service's source bind shows it: `up` prints a notice (point 6). */
const UNSHOWN = "notes/cache";

const env: Record<string, string> = {
  ...(process.env as Record<string, string>),
  HACK_RUNTIME_BACKEND: "native",
  HACK_NATIVE_SHARED_SOURCE: "1",
  HACK_NATIVE_HOME: nativeHome,
  HACK_NO_INTERACTIVE: "1",
  HACK_DAEMON_AUTOSTART_DISABLE: "1",
  NO_COLOR: "1",
};

type Exec = {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly seconds: number;
};

async function run(
  argv: readonly string[],
  timeoutSeconds: number,
  cwd = project
): Promise<Exec> {
  const started = performance.now();
  const child = Bun.spawn([...argv], {
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: timeoutSeconds * 1000,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return {
    code,
    stdout,
    stderr,
    seconds: (performance.now() - started) / 1000,
  };
}

function cli(args: readonly string[], timeoutSeconds = 300): Promise<Exec> {
  return run([hack, ...args], timeoutSeconds);
}

function inService(
  service: string,
  script: string,
  timeoutSeconds = 120
): Promise<Exec> {
  return cli(["exec", service, "--", "sh", "-c", script], timeoutSeconds);
}

function writeEntries(entries: readonly string[]): void {
  const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<
    string,
    unknown
  >;
  writeFileSync(
    configPath,
    `${JSON.stringify({ ...config, localDirectories: entries }, null, 2)}\n`
  );
}

function git(args: readonly string[]): string {
  const result = spawnSync("git", [...args], {
    cwd: project,
    encoding: "utf8",
    timeout: 30_000,
  });
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
}

function lines(text: string, limit = 6): string[] {
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .slice(-limit);
}

type Result = {
  readonly point: number;
  readonly status: "PASS" | "FAIL" | "INFO";
  readonly title: string;
  readonly evidence: readonly string[];
};
const results: Result[] = [];

function report(result: Result): void {
  results.push(result);
  process.stdout.write(
    `${result.status} ${result.point}. ${result.title}\n${result.evidence.map((line) => `     ${line}`).join("\n")}\n`
  );
}

function evidenceOf(label: string, exec: Exec): string[] {
  return [
    `${label}: exit ${exec.code} in ${exec.seconds.toFixed(1)}s`,
    ...lines(exec.stderr).map((line) => `  stderr: ${line}`),
    ...lines(exec.stdout, 3).map((line) => `  stdout: ${line}`),
  ];
}

/** `/proc/self/mountinfo` rows by mount point: filesystem type and source. */
function mounts(text: string): Map<string, { fstype: string; source: string }> {
  const byPoint = new Map<string, { fstype: string; source: string }>();
  for (const row of text.split("\n")) {
    const [left, right] = row.split(" - ");
    const point = left?.split(" ")[4];
    const [fstype, source] = (right ?? "").split(" ");
    if (point && fstype) {
      byPoint.set(point, { fstype, source: source ?? "" });
    }
  }
  return byPoint;
}

/** Filesystems that carry a host share into the guest. */
const SHARE_TYPES = new Set(["virtiofs", "9p", "nfs", "nfs4", "fuse"]);

async function upDetached(label: string): Promise<Exec> {
  const exec = await cli(["up", "--detach", "--json"], startTimeout);
  if (exec.code !== 0) {
    report({
      point: 0,
      status: "FAIL",
      title: `${label}: hack up --detach --json did not start the project`,
      evidence: evidenceOf("up", exec),
    });
  }
  return exec;
}

async function removeData(): Promise<Exec> {
  const direct = await cli(["down", "--remove-data", "--yes"], 600);
  if (direct.code === 0) {
    return direct;
  }
  await cli(["down"], 600);
  return await cli(["down", "--remove-data", "--yes"], 600);
}

/** Volumes in the native model this checkout builds: declared plus anonymous. */
async function modelVolumeCount(): Promise<{
  declared: string[];
  anonymous: number;
}> {
  const { prepareNativeProjectInput } = await import(
    "../src/backends/native-project-input.ts"
  );
  const { prepareNativeProjectAdaptation } = await import(
    "../src/backends/native-project-adaptation.ts"
  );
  const input = await prepareNativeProjectInput({
    projectRoot: project,
    projectDir: join(project, ".hack"),
    composeFile: join(project, ".hack/docker-compose.yml"),
  });
  const model = JSON.parse(
    (await prepareNativeProjectAdaptation({ input })).normalizedComposeJson
  ) as {
    services?: Record<string, { volumes?: unknown[] }>;
    volumes?: Record<string, unknown>;
  };
  let anonymous = 0;
  for (const spec of Object.values(model.services ?? {})) {
    for (const mount of spec.volumes ?? []) {
      const lone = typeof mount === "string" && !mount.includes(":");
      const sourceless =
        typeof mount === "object" &&
        mount !== null &&
        (mount as { type?: unknown }).type === "volume" &&
        (mount as { source?: unknown }).source === undefined;
      if (lone || sourceless) {
        anonymous++;
      }
    }
  }
  return { declared: Object.keys(model.volumes ?? {}), anonymous };
}

async function setup(): Promise<boolean> {
  cpSync(fixture, project, { recursive: true });
  rmSync(join(project, "web/node_modules"), { recursive: true, force: true });
  writeEntries(ENTRIES);
  git(["init", "-q"]);
  git(["add", "-A"]);
  git([
    "-c",
    "user.name=check",
    "-c",
    "user.email=check@example.invalid",
    "commit",
    "-q",
    "--no-gpg-sign",
    "-m",
    "fixture",
  ]);
  process.stdout.write(`project: ${project}\nhack: ${hack}\n`);

  const up = await upDetached("start");
  return up.code === 0;
}

async function point1(): Promise<void> {
  const table = await inService("web", "cat /proc/self/mountinfo");
  const byPoint = mounts(table.stdout);
  const appMount = byPoint.get("/app");
  const evidence1 = [
    `/app: ${appMount?.fstype ?? "?"} from ${appMount?.source ?? "?"}`,
  ];
  let ok1 = table.code === 0 && appMount !== undefined;
  for (const entry of ENTRIES) {
    const target = TARGETS[entry] ?? "";
    const mount = byPoint.get(target);
    evidence1.push(
      `${target}: ${mount ? `${mount.fstype} from ${mount.source}` : "no mount of its own"}`
    );
    ok1 =
      ok1 &&
      mount !== undefined &&
      !SHARE_TYPES.has(mount.fstype) &&
      !mount.fstype.startsWith("fuse") &&
      mount.fstype !== appMount?.fstype;
  }
  report({
    point: 1,
    status: ok1 ? "PASS" : "FAIL",
    title:
      "each declared directory is a volume on the guest disk, not the share",
    evidence: evidence1,
  });
}

async function point2(): Promise<void> {
  const install = await inService(
    "web",
    "cd /app && bun install --no-progress",
    installTimeout
  );
  const inside = await inService(
    "web",
    "find /app/node_modules -type f | wc -l"
  );
  const insideCount = Number(inside.stdout.trim()) || 0;
  const hostDir = join(project, "web/node_modules");
  const hostCount = existsSync(hostDir) ? readdirSync(hostDir).length : 0;
  report({
    point: 2,
    status:
      install.code === 0 && insideCount > 0 && hostCount === 0
        ? "PASS"
        : "FAIL",
    title: "an install inside the service lands in the volume",
    evidence: [
      `bun install: exit ${install.code} in ${install.seconds.toFixed(1)}s (wall time of hack exec)`,
      `files in /app/node_modules inside the service: ${insideCount}`,
      `entries in the host checkout's web/node_modules: ${hostCount}`,
      ...lines(install.stderr, 3).map((line) => `  stderr: ${line}`),
    ],
  });
}

function point3(): void {
  const evidence3: string[] = [];
  const uid = process.getuid?.() ?? -1;
  let ownedByUser = true;
  for (const entry of ENTRIES) {
    const path = join(project, entry);
    if (existsSync(path)) {
      const info = statSync(path);
      ownedByUser = ownedByUser && info.uid === uid;
      evidence3.push(
        `${entry}: present, uid ${info.uid}${info.uid === uid ? " (this user)" : ""}, mode ${(info.mode & 0o7777).toString(8)}, ${readdirSync(path).length} entries`
      );
    } else {
      evidence3.push(`${entry}: absent`);
    }
  }
  const status = git(["status", "--porcelain", "--untracked-files=all"]);
  evidence3.push(
    `git status --porcelain: ${status === "" ? "(clean)" : status}`
  );
  report({
    point: 3,
    status: ownedByUser && status === "" ? "PASS" : "FAIL",
    title: "the host checkout gets no foreign-owned mountpoint and stays clean",
    evidence: evidence3,
  });
}

async function point4(): Promise<void> {
  const marker = await inService(
    "web",
    "echo check > /app/node_modules/.hack-local-dirs-marker && echo written"
  );
  const removed = await removeData();
  const upAgain = await upDetached("start after --remove-data");
  const after =
    upAgain.code === 0
      ? await inService(
          "web",
          "test -e /app/node_modules/.hack-local-dirs-marker && echo kept || echo gone"
        )
      : null;
  const volumes = await modelVolumeCount();
  const total = volumes.declared.length + volumes.anonymous;
  report({
    point: 4,
    status:
      marker.stdout.includes("written") &&
      removed.code === 0 &&
      after?.stdout.includes("gone") === true &&
      total <= 16
        ? "PASS"
        : "FAIL",
    title:
      "down --remove-data deletes the volumes; the run fits the 16-volume limit",
    evidence: [
      `marker in /app/node_modules: ${marker.stdout.trim() || "not written"}`,
      ...evidenceOf("down --remove-data --yes", removed),
      `marker after the next up: ${after?.stdout.trim() ?? "not checked (up failed)"}`,
      `volumes in the native model: ${total} of 16 (${volumes.declared.join(", ")}${volumes.anonymous ? `, ${volumes.anonymous} anonymous` : ""})`,
    ],
  });
}

async function point5(): Promise<void> {
  writeEntries([...ENTRIES, ADDED]);
  const upRunning = await cli(["up", "--detach", "--json"], startTimeout);
  const restart = await cli(["restart", "--json"], startTimeout);
  const apiTable = await inService("api", "cat /proc/self/mountinfo");
  const applied = mounts(apiTable.stdout).get("/app/.cache");
  const said = `${upRunning.stdout}${upRunning.stderr}${restart.stdout}${restart.stderr}`;
  report({
    point: 5,
    status: "INFO",
    title: `adding ${ADDED} while the project runs (behavior is recorded, not judged)`,
    evidence: [
      ...evidenceOf("up --detach --json", upRunning),
      ...evidenceOf("restart --json", restart),
      `/app/.cache in api after restart: ${applied ? `${applied.fstype} from ${applied.source}` : "no mount of its own"}`,
      `mentions localDirectories: ${said.includes("localDirectories") ? "yes" : "no"}`,
    ],
  });
}

async function point6(): Promise<void> {
  writeEntries([...ENTRIES, UNSHOWN]);
  await cli(["down"], 600);
  const noticed = await cli(["up", "--detach", "--json"], startTimeout);
  let parsed = false;
  try {
    const value: unknown = JSON.parse(noticed.stdout.trim());
    parsed = typeof value === "object" && value !== null;
  } catch {
    parsed = false;
  }
  const notice = noticed.stderr.includes(
    `localDirectories: no service's source bind in .hack/docker-compose.yml shows ${UNSHOWN}`
  );
  report({
    point: 6,
    status:
      parsed && notice && !noticed.stdout.includes("localDirectories")
        ? "PASS"
        : "FAIL",
    title:
      "detached up --json: stdout is one JSON envelope, the notice is on stderr",
    evidence: [
      `exit ${noticed.code} in ${noticed.seconds.toFixed(1)}s`,
      `stdout parses as one JSON value: ${parsed ? "yes" : "no"}`,
      `notice on stderr: ${notice ? "yes" : "no"}`,
      ...lines(noticed.stderr, 4).map((line) => `  stderr: ${line}`),
    ],
  });
}

async function main(): Promise<void> {
  if (!(await setup())) {
    return;
  }
  await point1();
  await point2();
  point3();
  await point4();
  await point5();
  await point6();
}

try {
  await main();
} finally {
  if (values.keep) {
    process.stdout.write(
      `kept: ${project} (stop it with hack down --remove-data --yes)\n`
    );
  } else {
    await removeData();
    rmSync(work, { recursive: true, force: true });
  }
  const failed = results.filter((result) => result.status === "FAIL").length;
  process.stdout.write(
    `summary: ${results.filter((r) => r.status === "PASS").length} pass, ${failed} fail, ${results.filter((r) => r.status === "INFO").length} info\n`
  );
  process.exitCode = failed > 0 ? 1 : 0;
}
