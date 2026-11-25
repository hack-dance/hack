#!/usr/bin/env bun
/**
 * Linux first-run check for the Compose path, without sudo (HACK-2329).
 *
 * Runs a built `hack` the way a new Linux user would, in a fresh private HOME:
 * doctor, global install without the Compose plugin (a `docker` wrapper that
 * rejects `compose` must get the plugin's code, not a port hint), global
 * install (and the `proxy.bind_address` retry when :443 is taken), init, up/ps/logs/open/exec/run/restart/down with `--json` shape
 * checks, routed HTTPS against Hack's CA, env and a secret (never printed),
 * host exec, a branch instance, foreground `up` with Ctrl-C in a pty, the
 * daemon, the update check and `native setup`. It prints one Markdown table
 * (step, command, exit, seconds, result) and writes it to `<scratch>/report.md`.
 *
 * Usage:
 *   bun scripts/linux-first-run-check.ts --hack /abs/dist/hack --scratch /abs/new/dir \
 *     [--one-shot-seconds 150] [--reuse-global-stack] [--keep]
 *   bun scripts/linux-first-run-check.ts --installer /abs/hack-next-install.sh --scratch /abs/new/dir \
 *     [--archive /abs/bundle.tar.gz --sha256 DIGEST] [--manager /abs/hack-next-manager-linux-ARCH] ...
 *
 * Installer mode (HACK-2364) installs a v5 prerelease through its rendered
 * installer into the fresh HOME first, then runs the same steps through
 * `~/.hack-next/bin/hack-next`. It adds: the installer refusing an unsupported
 * architecture, the install itself, `--manager status`, `stable`, `rollback`
 * and `uninstall`, and what the uninstall leaves on disk. `--archive/--sha256`
 * and `--manager` install local files (the installer still checks the manager
 * against its embedded digest); without them it downloads the published
 * release.
 *
 * Ownership: the global proxy and logging stacks have fixed Compose names
 * (`hack-dev-proxy`, `hack-logging`) and the `hack-dev` network, so HOME does
 * not isolate them. Like `scripts/linux-isolated-home-preflight.sh`, the check
 * refuses when they already exist, unless `--reuse-global-stack` says the
 * operator owns them; existing volumes of those projects count too, since they
 * hold the operator's state (Caddy's CA). It removes only what it created: its
 * `lq-<id>` project containers, networks and volumes; it stops the global
 * stack when none of its containers existed before, and removes a global
 * project's labeled volumes when that project had none before. PATH entries holding a
 * `hack` are dropped, so re-invocations run the CLI under test.
 *
 * Root steps (Linux DNS, system trust) are never run; the check records the
 * codes Hack reports for them. Not covered: systemd user services, browsers,
 * rootless Docker; with `--hack`, no install is exercised.
 */
import { randomBytes } from "node:crypto";
import { accessSync, constants, statSync } from "node:fs";
import { chmod, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { LINUX_INSTALLED_NOTE } from "./installer/bootstrap.ts";

export type StepResult = "pass" | "fail" | "info";

export type StepRecord = {
  readonly step: string;
  readonly command: string;
  readonly exit: number | null;
  readonly seconds: number;
  readonly result: StepResult;
  readonly note: string;
};

/** Installer mode: the rendered `hack-next-install.sh` and its optional local inputs. */
export type InstallerInput = {
  readonly path: string;
  readonly archive?: string;
  readonly sha256?: string;
  readonly manager?: string;
};

export type CheckOptions = {
  /** The CLI under test; in installer mode, the `hack-next` the install creates. */
  readonly hack: string;
  readonly scratch: string;
  readonly oneShotSeconds: number;
  readonly reuseGlobalStack: boolean;
  readonly keep: boolean;
  /** Present only in installer mode. */
  readonly installer?: InstallerInput;
};

const USAGE =
  "Usage: bun scripts/linux-first-run-check.ts (--hack /abs/hack | --installer /abs/hack-next-install.sh [--archive /abs/archive --sha256 DIGEST] [--manager /abs/manager]) --scratch /abs/new/dir [--one-shot-seconds N] [--reuse-global-stack] [--keep]";

/** Where installer mode installs: the installer's default root in the check's HOME. */
export function installedLauncher(scratch: string): string {
  return join(scratch, "home", ".hack-next", "bin", "hack-next");
}

/** Parses argv; throws with the usage text on anything unexpected. */
export function parseCheckArgs(argv: readonly string[]): CheckOptions {
  let hack: string | null = null;
  let scratch: string | null = null;
  const installer: Record<string, string | undefined> = {};
  let oneShotSeconds = 150;
  let reuseGlobalStack = false;
  let keep = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = argv[i + 1];
    switch (arg) {
      case "--hack":
        hack = value ?? null;
        i++;
        break;
      case "--scratch":
        scratch = value ?? null;
        i++;
        break;
      case "--installer":
      case "--archive":
      case "--sha256":
      case "--manager":
        installer[arg.slice(2)] = value ?? "";
        i++;
        break;
      case "--one-shot-seconds":
        oneShotSeconds = Number(value);
        i++;
        break;
      case "--reuse-global-stack":
        reuseGlobalStack = true;
        break;
      case "--keep":
        keep = true;
        break;
      default:
        throw new Error(`Unknown argument ${String(arg)}. ${USAGE}`);
    }
  }
  const installerInput = installerOptions(installer);
  if (installerInput !== undefined && hack !== null) {
    throw new Error(`Use --hack or --installer, not both. ${USAGE}`);
  }
  if (installerInput !== undefined && scratch && isAbsolute(scratch)) {
    hack = installedLauncher(scratch);
  }
  if (!(hack && isAbsolute(hack) && scratch && isAbsolute(scratch))) {
    throw new Error(`--hack and --scratch must be absolute paths. ${USAGE}`);
  }
  if (
    !Number.isInteger(oneShotSeconds) ||
    oneShotSeconds < 1 ||
    oneShotSeconds > 1500
  ) {
    throw new Error(
      `--one-shot-seconds must be 1..1500 (the start ceiling is 30 minutes). ${USAGE}`
    );
  }
  return {
    hack,
    scratch,
    oneShotSeconds,
    reuseGlobalStack,
    keep,
    ...(installerInput === undefined ? {} : { installer: installerInput }),
  };
}

/** Validates the installer-mode flags; undefined when none was given. */
function installerOptions(
  raw: Readonly<Record<string, string | undefined>>
): InstallerInput | undefined {
  if (Object.keys(raw).length === 0) {
    return;
  }
  const { installer, archive, sha256, manager } = raw;
  if (!(installer && isAbsolute(installer))) {
    throw new Error(
      `--archive, --sha256 and --manager need --installer with an absolute path. ${USAGE}`
    );
  }
  if ((archive === undefined) !== (sha256 === undefined)) {
    throw new Error(`--archive and --sha256 go together. ${USAGE}`);
  }
  if (
    (archive !== undefined && !isAbsolute(archive)) ||
    (manager !== undefined && !isAbsolute(manager)) ||
    (sha256 !== undefined && !/^[0-9a-f]{64}$/.test(sha256))
  ) {
    throw new Error(
      `--archive and --manager must be absolute paths and --sha256 a lowercase SHA-256. ${USAGE}`
    );
  }
  return {
    path: installer,
    ...(archive === undefined ? {} : { archive }),
    ...(sha256 === undefined ? {} : { sha256 }),
    ...(manager === undefined ? {} : { manager }),
  };
}

/** How many JSON values `text` holds (one per line or one document), or null if any part does not parse. */
export function countJsonValues(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "") {
    return 0;
  }
  try {
    JSON.parse(trimmed);
    return 1;
  } catch {
    // Fall through to line-delimited JSON.
  }
  let count = 0;
  for (const line of trimmed.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    try {
      JSON.parse(line);
      count++;
    } catch {
      return null;
    }
  }
  return count;
}

export function renderStepTable(steps: readonly StepRecord[]): string {
  const cell = (text: string) =>
    text.replaceAll("|", "\\|").replaceAll("\n", " ");
  return [
    "| Step | Command | Exit | Seconds | Result | Note |",
    "| --- | --- | --- | --- | --- | --- |",
    ...steps.map(
      (s) =>
        `| ${cell(s.step)} | \`${cell(s.command)}\` | ${s.exit ?? "-"} | ${s.seconds.toFixed(1)} | ${s.result} | ${cell(s.note)} |`
    ),
  ].join("\n");
}

type Ran = {
  readonly exit: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly seconds: number;
  /** The check's own limit (ms) when it killed the command, else null. */
  readonly killedAtLimitMs: number | null;
};

async function runProcess(opts: {
  readonly argv: readonly string[];
  readonly env: Record<string, string>;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly stdin?: string;
}): Promise<Ran> {
  const started = performance.now();
  const proc = Bun.spawn([...opts.argv], {
    cwd: opts.cwd,
    env: opts.env,
    stdin:
      opts.stdin === undefined
        ? "ignore"
        : new TextEncoder().encode(opts.stdin),
    stdout: "pipe",
    stderr: "pipe",
    timeout: opts.timeoutMs,
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exit = await proc.exited;
  const elapsedMs = performance.now() - started;
  // Bun kills the command with a signal when `timeout` expires.
  const killedAtLimit =
    proc.signalCode !== null && elapsedMs >= opts.timeoutMs - 1000;
  return {
    exit,
    stdout,
    stderr,
    seconds: elapsedMs / 1000,
    killedAtLimitMs: killedAtLimit ? opts.timeoutMs : null,
  };
}

/**
 * `path` without the entries that hold an executable `hack`. The CLI prefers a
 * `hack` on PATH over itself when it re-invokes itself (daemon start, global
 * up), so an installed Hack would otherwise be tested instead of `--hack`.
 */
export function pathWithoutHack(
  path: string,
  isExecutable: (file: string) => boolean = executableFile
): { readonly path: string; readonly dropped: readonly string[] } {
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const entry of path.split(":")) {
    // An empty entry means the current directory: never keep it.
    if (entry === "") {
      continue;
    }
    if (isExecutable(join(entry, "hack"))) {
      dropped.push(entry);
    } else {
      kept.push(entry);
    }
  }
  return { path: kept.join(":"), dropped };
}

function executableFile(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Directories on the way to `path` that other users can write (sticky ones
 * excepted). hackd refuses a HOME below such a directory, which is host setup,
 * not a product failure, so the check reports it as a precondition.
 */
export function groupWritableAncestors(path: string): string[] {
  const found: string[] = [];
  let dir = path;
  for (;;) {
    try {
      const mode = statSync(dir).mode;
      if ((mode & 0o022) !== 0 && (mode & 0o1000) === 0) {
        found.push(dir);
      }
    } catch {
      // Not created yet.
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return found;
    }
    dir = parent;
  }
}

const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]/g;

function plain(text: string): string {
  return text.replace(ANSI, "");
}

class FirstRun {
  readonly steps: StepRecord[] = [];
  readonly home: string;
  readonly project: string;
  readonly repo: string;
  readonly env: Record<string, string>;
  /** PATH entries removed because they hold a `hack` (see pathWithoutHack). */
  readonly droppedPath: readonly string[];
  /** No global container existed before: `global down` at the end. */
  startedGlobalStack = false;
  /** Global projects with no volume before the run: their volumes are removed. */
  ownedVolumeProjects: string[] = [];

  readonly opts: CheckOptions;
  /**
   * Per-command limit: ten minutes, or the one-shot's duration plus ten
   * minutes (image pulls and startup) when that is longer, so a healthy `up`
   * or `restart` waiting on a long one-shot is not killed before Hack's own
   * 30-minute start ceiling would report.
   */
  get lifecycleTimeoutMs(): number {
    return Math.max(600_000, (this.opts.oneShotSeconds + 600) * 1000);
  }

  constructor(opts: CheckOptions) {
    this.opts = opts;
    const id = randomBytes(3).toString("hex");
    this.home = join(opts.scratch, "home");
    this.project = `lq-${id}`;
    this.repo = join(opts.scratch, this.project);
    const path = pathWithoutHack(process.env.PATH ?? "/usr/bin:/bin");
    this.droppedPath = path.dropped;
    this.env = {
      PATH: path.path,
      HOME: this.home,
      TMPDIR: join(opts.scratch, "tmp"),
      LANG: "C.UTF-8",
      HACK_RUNTIME_BACKEND: "compose",
      HACK_NO_INTERACTIVE: "1",
      HACK_SYSTEMD_DISABLE: "1",
      HACK_DAEMON_AUTOSTART_DISABLE: "1",
    };
  }

  record(
    step: Omit<StepRecord, "seconds"> & { readonly seconds?: number }
  ): void {
    const full = { ...step, seconds: step.seconds ?? 0 };
    this.steps.push(full);
    process.stderr.write(
      `${full.result.toUpperCase()} ${full.step} (exit ${full.exit ?? "-"}, ${full.seconds.toFixed(1)}s) ${full.note}\n`
    );
  }

  async hack(
    args: readonly string[],
    opts?: {
      readonly stdin?: string;
      readonly timeoutMs?: number;
      readonly env?: Record<string, string>;
    }
  ): Promise<Ran> {
    return await runProcess({
      argv: [this.opts.hack, ...args],
      env: { ...this.env, ...opts?.env },
      cwd: this.repo,
      timeoutMs: opts?.timeoutMs ?? this.lifecycleTimeoutMs,
      stdin: opts?.stdin,
    });
  }

  async sh(argv: readonly string[], timeoutMs = 60_000): Promise<Ran> {
    return await runProcess({
      argv,
      env: this.env,
      cwd: this.opts.scratch,
      timeoutMs,
    });
  }

  /** Runs `hack <args>` and records it; `check` turns the run into pass/fail and a note. */
  async step(
    name: string,
    args: readonly string[],
    check: (ran: Ran) => {
      readonly ok: boolean | "info";
      readonly note: string;
    },
    opts?: { readonly stdin?: string; readonly display?: string }
  ): Promise<Ran> {
    const ran = await this.hack(args, { stdin: opts?.stdin });
    const verdict =
      ran.killedAtLimitMs === null
        ? check(ran)
        : {
            ok: false,
            note: `killed by the check's ${Math.round(ran.killedAtLimitMs / 60_000)}-minute command limit, not a Hack result`,
          };
    this.record({
      step: name,
      command: opts?.display ?? `hack ${args.join(" ")}`,
      exit: ran.exit,
      seconds: ran.seconds,
      result: verdict.ok === "info" ? "info" : verdict.ok ? "pass" : "fail",
      note: verdict.note,
    });
    return ran;
  }
}

function oneJson(
  ran: Ran,
  extra?: (value: unknown) => string | null
): { ok: boolean; note: string } {
  const count = countJsonValues(ran.stdout);
  if (count !== 1) {
    return {
      ok: false,
      note: `stdout holds ${count ?? "unparsable"} JSON values`,
    };
  }
  if (ran.exit !== 0) {
    return { ok: false, note: `one JSON value; ${firstError(ran)}` };
  }
  const problem = extra?.(JSON.parse(ran.stdout)) ?? null;
  return problem === null
    ? { ok: true, note: "one JSON value" }
    : { ok: false, note: problem };
}

function firstError(ran: Ran): string {
  try {
    const value = JSON.parse(ran.stdout) as { error?: { code?: string } };
    if (value.error?.code) {
      return value.error.code;
    }
  } catch {
    // Not JSON.
  }
  const line = plain(`${ran.stdout}\n${ran.stderr}`)
    .split("\n")
    .map((l) => l.replace(/^[│■▲◆●◇\s]+/, "").trim())
    .find((l) => l.length > 0);
  return line ? line.slice(0, 160) : "no output";
}

const LOGGING_PROJECT = "hack-logging";
const GLOBAL_PROJECTS = ["hack-dev-proxy", LOGGING_PROJECT] as const;

/** How long started global containers get to fail before they are judged. */
const GLOBAL_SETTLE_MS = 5000;

/**
 * The services Hack's global stack can run, by Compose project. The logging
 * stack is opt-in: `hack global install` starts the proxy project only.
 */
const GLOBAL_SERVICES: Readonly<Record<string, readonly string[]>> = {
  "hack-dev-proxy": ["caddy", "coredns"],
  "hack-logging": ["loki", "alloy", "grafana"],
};

/**
 * Judges `docker ps -a` lines of the form `<project> <name> <state>`: every
 * service of the proxy project must have a container, and each must be
 * `running`. With logging on that also holds for the logging stack; with
 * logging off no logging container may be running. The note names each one
 * that is wrong.
 */
export function globalContainersVerdict(
  stdout: string,
  opts: { readonly logging: "on" | "off" }
): {
  readonly ok: boolean;
  readonly note: string;
} {
  const seen = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const [project, name, state] = line.trim().split(" ");
    if (project && name && state && project in GLOBAL_SERVICES) {
      seen.set(name, state);
    }
  }
  const containers = Object.entries(GLOBAL_SERVICES).flatMap(
    ([project, services]) =>
      services.map((service) => ({
        name: `${project}-${service}-1`,
        wanted: project !== LOGGING_PROJECT || opts.logging === "on",
      }))
  );
  const expected = containers.filter((c) => c.wanted).length;
  const problems = containers.flatMap(({ name, wanted }) => {
    const state = seen.get(name);
    if (!wanted) {
      return state === "running" ? [`${name} running with logging off`] : [];
    }
    return state === "running" ? [] : [`${name} ${state ?? "missing"}`];
  });
  return problems.length === 0
    ? {
        ok: true,
        note: `all ${expected} global containers running, logging ${opts.logging}`,
      }
    : { ok: false, note: `not as expected: ${problems.join(", ")}` };
}
const REQUIRED_TOOLS = ["docker", "curl", "sh", "grep", "pgrep"] as const;

async function preflight(run: FirstRun): Promise<boolean> {
  if (process.platform !== "linux") {
    run.record({
      step: "0 preflight",
      command: "uname",
      exit: null,
      result: "fail",
      note: `platform ${process.platform}, not linux`,
    });
    return false;
  }
  const missing = REQUIRED_TOOLS.filter(
    (tool) => Bun.which(tool, { PATH: run.env.PATH ?? "" }) === null
  );
  if (missing.length > 0) {
    run.record({
      step: "0 preflight",
      command: "which <tools>",
      exit: null,
      result: "fail",
      note: `precondition: ${missing.join(", ")} not on PATH${run.droppedPath.length > 0 ? ` after dropping ${run.droppedPath.join(", ")} (they hold a hack)` : ""}; install them or move the other hack out of those directories`,
    });
    return false;
  }
  const info = await run.sh([
    "docker",
    "info",
    "--format",
    "{{.ServerVersion}}",
  ]);
  if (info.exit !== 0) {
    run.record({
      step: "0 preflight",
      command: "docker info",
      exit: info.exit,
      result: "fail",
      note: "Docker engine not reachable",
    });
    return false;
  }
  const unsafe = groupWritableAncestors(run.opts.scratch);
  if (unsafe.length > 0) {
    run.record({
      step: "0 preflight",
      command: "stat <scratch ancestors>",
      exit: null,
      result: "fail",
      note: `precondition: ${unsafe.join(", ")} writable by other users; hackd would refuse a HOME below it. Use a scratch directory under private directories`,
    });
    return false;
  }
  const shared: string[] = [];
  let containersExisted = false;
  const fresh: string[] = [];
  for (const project of GLOBAL_PROJECTS) {
    const label = `label=com.docker.compose.project=${project}`;
    const ids = await run.sh(["docker", "ps", "-aq", "--filter", label]);
    if (ids.stdout.trim() !== "") {
      shared.push(`Compose project ${project}`);
      containersExisted = true;
    }
    // Kept volumes hold the operator's state, such as Caddy's CA and key.
    const volumes = await run.sh([
      "docker",
      "volume",
      "ls",
      "-q",
      "--filter",
      label,
    ]);
    if (volumes.stdout.trim() !== "") {
      shared.push(`${project} volumes`);
    } else {
      fresh.push(project);
    }
  }
  if ((await run.sh(["docker", "network", "inspect", "hack-dev"])).exit === 0) {
    shared.push("network hack-dev");
  }
  if (shared.length > 0 && !run.opts.reuseGlobalStack) {
    run.record({
      step: "0 preflight",
      command: "docker ps/network inspect",
      exit: null,
      result: "fail",
      note: `refused: ${shared.join(", ")} already exist and HOME does not isolate them; pass --reuse-global-stack only if you own them`,
    });
    return false;
  }
  // Stop the global containers at the end only if none existed before, and
  // remove a global project's volumes only if that project had none (a
  // reused volume, such as Caddy's CA, stays).
  run.startedGlobalStack = !containersExisted;
  run.ownedVolumeProjects = fresh;
  run.record({
    step: "0 preflight",
    command: "docker info",
    exit: 0,
    result: "info",
    note: `Docker ${info.stdout.trim()}; ${shared.length === 0 ? "no shared Hack stack" : `reusing ${shared.join(", ")}`}; ${run.droppedPath.length === 0 ? "no hack on PATH" : `dropped ${run.droppedPath.length} PATH entries holding a hack`}`,
  });
  return true;
}

function fixtureCompose(opts: {
  readonly project: string;
  readonly oneShotSeconds: number;
}): string {
  return `name: ${opts.project}
services:
  web:
    image: python:3.12-alpine
    working_dir: /app
    volumes:
      - ../web:/app:ro
    command: python -u server.py
    depends_on:
      db:
        condition: service_healthy
    labels:
      caddy: ${opts.project}.hack.local
      caddy.reverse_proxy: "{{upstreams 8080}}"
      caddy.tls: internal
    networks:
      - hack-dev
      - default
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_PASSWORD: local-only
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 2s
      timeout: 3s
      retries: 30
    volumes:
      - db-data:/var/lib/postgresql/data
  migrate:
    image: alpine:3.20
    command: ["sh", "-c", "echo migrate start; sleep ${opts.oneShotSeconds}; echo migrate done"]
    depends_on:
      db:
        condition: service_healthy
  worker:
    image: alpine:3.20
    init: true
    command: ["sh", "-c", "echo worker up; while true; do sleep 5; done"]
    depends_on:
      migrate:
        condition: service_completed_successfully
networks:
  hack-dev:
    external: true
volumes:
  db-data:
`;
}

const WEB_SERVER = `import http.server, json, os, socket
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        ok = True
        try:
            socket.create_connection(("db", 5432), timeout=2).close()
        except Exception:
            ok = False
        body = json.dumps({"ok": ok, "greeting": os.environ.get("GREETING", "")}).encode()
        self.send_response(200 if ok else 503)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
http.server.ThreadingHTTPServer(("0.0.0.0", 8080), H).serve_forever()
`;

async function writeFixture(run: FirstRun): Promise<void> {
  await mkdir(join(run.repo, "web"), { recursive: true });
  await writeFile(join(run.repo, "web", "server.py"), WEB_SERVER);
  await writeFile(
    join(run.repo, "README.md"),
    "Linux first-run check fixture.\n"
  );
}

async function httpsHealth(
  run: FirstRun,
  host: string,
  address: string,
  ca: string
): Promise<Ran> {
  return await run.sh([
    "curl",
    "-sS",
    "-m",
    "10",
    "--cacert",
    ca,
    "--resolve",
    `${host}:443:${address}`,
    "-w",
    "\\n%{http_code}",
    `https://${host}/health`,
  ]);
}

/**
 * A `docker` that has no Compose plugin: `docker compose …` fails the way
 * Docker's CLI does without it, and every other command runs `docker` (an
 * absolute path to the real CLI).
 */
export function noComposeDockerScript(docker: string): string {
  const quoted = `'${docker.replaceAll("'", "'\\''")}'`;
  return [
    "#!/bin/sh",
    'if [ "$1" = compose ]; then',
    "  echo \"docker: 'compose' is not a docker command.\" >&2",
    "  exit 1",
    "fi",
    `exec ${quoted} "$@"`,
    "",
  ].join("\n");
}

/**
 * Pass when `hack global install` without the Compose plugin failed, named
 * the plugin with its code, and did not blame ports 80/443 (HACK-2673).
 */
export function noComposeInstallVerdict(ran: {
  readonly exit: number | null;
  readonly stdout: string;
  readonly stderr: string;
}): { readonly ok: boolean; readonly note: string } {
  const text = plain(`${ran.stdout}\n${ran.stderr}`);
  if (ran.exit === 0) {
    return { ok: false, note: "install succeeded without the Compose plugin" };
  }
  if (text.includes("could not start on ports")) {
    return { ok: false, note: "blamed ports 80/443" };
  }
  const named =
    text.includes("E_DOCKER_UNAVAILABLE") &&
    text.includes("Docker Compose v2 plugin");
  return named
    ? { ok: true, note: "E_DOCKER_UNAVAILABLE names the Compose plugin" }
    : {
        ok: false,
        note: `did not name the plugin: ${firstError({ ...ran, seconds: 0, killedAtLimitMs: null })}`,
      };
}

/**
 * `hack global install` with a `docker` on PATH that has no Compose plugin
 * (see {@link noComposeDockerScript}). It refuses once the engine answers,
 * before it creates networks or starts the proxy, so it leaves nothing for
 * the real install that follows (HACK-2673).
 */
async function composePluginMissingStep(run: FirstRun): Promise<void> {
  const name = "2 global install (no Compose plugin)";
  const command = "hack global install  # docker without compose on PATH";
  const docker = Bun.which("docker", { PATH: run.env.PATH });
  if (docker === null) {
    run.record({
      step: name,
      command,
      exit: null,
      result: "fail",
      note: "no docker on PATH",
    });
    return;
  }
  const bin = join(run.opts.scratch, "no-compose-bin");
  await mkdir(bin, { recursive: true, mode: 0o700 });
  await writeFile(join(bin, "docker"), noComposeDockerScript(docker), {
    mode: 0o700,
  });
  try {
    const ran = await run.hack(["global", "install"], {
      env: { PATH: `${bin}:${run.env.PATH}` },
      timeoutMs: 300_000,
    });
    const verdict =
      ran.killedAtLimitMs === null
        ? noComposeInstallVerdict(ran)
        : { ok: false, note: "killed by the step's command limit" };
    run.record({
      step: name,
      command,
      exit: ran.exit,
      seconds: ran.seconds,
      result: verdict.ok ? "pass" : "fail",
      note: verdict.note,
    });
  } finally {
    await rm(bin, { recursive: true, force: true });
  }
}

async function globalSetup(run: FirstRun): Promise<boolean> {
  await run.step("2 doctor (fresh)", ["doctor"], (r) => ({
    ok: "info",
    note: `exit ${r.exit}: ${firstError(r)}`,
  }));
  await run.step(
    "2 global install --plan --json",
    ["global", "install", "--plan", "--json"],
    (r) => ({
      ok: countJsonValues(r.stdout) === 1 && (r.exit === 0 || r.exit === 3),
      note:
        countJsonValues(r.stdout) === 1
          ? "one JSON value (exit 3 = incomplete plan on a fresh host)"
          : "not one JSON value",
    })
  );
  await composePluginMissingStep(run);
  const install = await run.step(
    "2 global install",
    ["global", "install"],
    (r) => ({
      ok: "info",
      note:
        r.exit === 0
          ? "proxy started"
          : plain(r.stdout + r.stderr).includes("proxy.bind_address")
            ? "proxy could not publish 80/443; the error names proxy.bind_address"
            : firstError(r),
    })
  );
  let ok = install.exit === 0;
  if (
    !ok &&
    plain(install.stdout + install.stderr).includes("proxy.bind_address")
  ) {
    await run.step(
      "2 config set proxy.bind_address 127.0.0.1",
      ["config", "set", "--global", "proxy.bind_address", "127.0.0.1"],
      (r) => ({ ok: r.exit === 0, note: "the fix the proxy error names" })
    );
    const retry = await run.step(
      "2 global install (after bind_address)",
      ["global", "install"],
      (r) => ({
        ok: r.exit === 0,
        note: r.exit === 0 ? "proxy started on loopback" : firstError(r),
      })
    );
    ok = retry.exit === 0;
  } else if (!ok) {
    const last = run.steps.pop();
    if (last) {
      run.steps.push({ ...last, result: "fail" });
    }
  }
  const caddy = await run.sh([
    "docker",
    "inspect",
    "hack-dev-proxy-caddy-1",
    "--format",
    "{{range $k,$v := .NetworkSettings.Networks}}{{$k}}={{$v.IPAddress}} {{end}}",
  ]);
  run.record({
    step: "2 proxy container",
    command: "docker inspect hack-dev-proxy-caddy-1",
    exit: caddy.exit,
    seconds: caddy.seconds,
    result: caddy.stdout.includes("hack-dev=172.30.0.2") ? "pass" : "fail",
    note: caddy.stdout.trim() || "no proxy container",
  });
  // The proxy step above looks at Caddy only, and Caddy runs as root: it
  // stayed up while CoreDNS had exited because it could not read a config
  // written under the prerelease manager's umask (HACK-2381).
  if (run.opts.reuseGlobalStack) {
    run.record({
      step: "2 global containers running",
      command: "docker ps -a",
      exit: null,
      result: "info",
      note: "not judged: the reused stack's logging choice is the operator's",
    });
  } else {
    await checkGlobalContainers(run, {
      step: "2 global containers running",
      logging: "off",
    });
  }
  await run.step("2 global trust (no sudo)", ["global", "trust"], (r) => {
    const code =
      /code=([a-z_]+)/.exec(plain(r.stdout + r.stderr))?.[1] ?? "none";
    return { ok: "info", note: `root step not run; Hack reports code=${code}` };
  });
  return ok;
}

async function checkGlobalContainers(
  run: FirstRun,
  opts: { readonly step: string; readonly logging: "on" | "off" }
): Promise<void> {
  // A container that cannot read its config takes a second or two to exit,
  // so look only after they have had time to fail.
  await Bun.sleep(GLOBAL_SETTLE_MS);
  const states = await run.sh([
    "docker",
    "ps",
    "-a",
    "--filter",
    "label=com.docker.compose.project",
    "--format",
    '{{.Label "com.docker.compose.project"}} {{.Names}} {{.State}}',
  ]);
  const containers = globalContainersVerdict(states.stdout, opts);
  run.record({
    step: opts.step,
    command: `docker ps -a (${GLOBAL_PROJECTS.join(", ")})`,
    exit: states.exit,
    seconds: states.seconds,
    result: states.exit === 0 && containers.ok ? "pass" : "fail",
    note: containers.note,
  });
}

async function proxyOnLoopback(run: FirstRun, when: string): Promise<boolean> {
  const ports = await run.sh([
    "docker",
    "port",
    "hack-dev-proxy-caddy-1",
    "443/tcp",
  ]);
  const ok = ports.stdout.trim() === "127.0.0.1:443";
  run.record({
    step: `7 proxy on loopback, ${when}`,
    command: "docker port hack-dev-proxy-caddy-1 443/tcp",
    exit: ports.exit,
    seconds: ports.seconds,
    result: ok ? "pass" : "fail",
    note: ports.stdout.trim().split("\n").join(", ") || "not published",
  });
  return ok;
}

/**
 * Turns the opt-in logging stack on and off again. Loki and Grafana do not run
 * as root, so this is what shows that they can read the configs Hack wrote
 * (HACK-2381). A reused stack is the operator's: its choice is not changed.
 */
async function loggingFlow(run: FirstRun): Promise<void> {
  if (run.opts.reuseGlobalStack) {
    run.record({
      step: "7 global up --logging",
      command: "hack global up --logging",
      exit: null,
      result: "info",
      note: "skipped: the reused stack's logging choice is the operator's",
    });
    return;
  }
  // Loki answers without authentication and Alloy reads every container of
  // the daemon, so the proxy must not listen on the network while logging is
  // on: this host may be reachable.
  const bound = await run.step(
    "7 config set proxy.bind_address 127.0.0.1",
    ["config", "set", "--global", "proxy.bind_address", "127.0.0.1"],
    (r) => ({
      ok: r.exit === 0,
      note: r.exit === 0 ? "loopback before logging" : firstError(r),
    })
  );
  if (bound.exit !== 0) {
    return;
  }
  // The binding is written by `global install`, not by `global up`.
  const installed = await run.step(
    "7 global install (proxy on loopback)",
    ["global", "install"],
    (r) => ({
      ok: r.exit === 0,
      note: r.exit === 0 ? "proxy restarted on loopback" : firstError(r),
    })
  );
  if (installed.exit !== 0 || !(await proxyOnLoopback(run, "before logging"))) {
    return;
  }
  for (const logging of ["on", "off"] as const) {
    const flag = logging === "on" ? "--logging" : "--no-logging";
    await run.step(`7 global up ${flag}`, ["global", "up", flag], (r) => ({
      ok: r.exit === 0,
      note: r.exit === 0 ? `logging turned ${logging}` : firstError(r),
    }));
    await checkGlobalContainers(run, {
      step: `7 global containers, logging ${logging}`,
      logging,
    });
    await proxyOnLoopback(run, `logging ${logging}`);
  }
}

async function projectFlow(run: FirstRun, ca: string): Promise<void> {
  await run.step(
    "3 init --auto --manual",
    ["init", "--path", run.repo, "--auto", "--manual", "--name", run.project],
    (r) => ({
      ok: r.exit === 0,
      note: r.exit === 0 ? ".hack/ written" : firstError(r),
    }),
    { display: "hack init --path <fixture> --auto --manual --name lq-<id>" }
  );
  await writeFile(
    join(run.repo, ".hack", "docker-compose.yml"),
    fixtureCompose({
      project: run.project,
      oneShotSeconds: run.opts.oneShotSeconds,
    })
  );
  await run.step(
    "3 up -d --json",
    ["up", "-d", "--json"],
    (r) =>
      oneJson(r, (v) => {
        const completed =
          (v as { data?: { services?: { completed?: string[] } } }).data
            ?.services?.completed ?? [];
        return completed.includes("migrate")
          ? null
          : "migrate not reported completed";
      }),
    {
      display: `hack up -d --json (one-shot ${run.opts.oneShotSeconds}s, default startup budget)`,
    }
  );
  await run.step("3 ps --json", ["ps", "--json"], (r) => oneJson(r));
  await run.step(
    "3 logs --json --no-follow",
    ["logs", "--json", "--no-follow"],
    (r) => {
      const lines = r.stdout.trim().split("\n").filter(Boolean);
      const count = countJsonValues(r.stdout);
      const framed =
        lines.length > 1 &&
        lines[0]?.includes('"type":"start"') &&
        lines.at(-1)?.includes('"type":"end"');
      return {
        ok: r.exit === 0 && count !== null && framed === true,
        note: `hack.logs.v1 stream, ${count ?? "unparsable"} lines`,
      };
    }
  );
  await run.step("3 open --json", ["open", "--json"], (r) => {
    const base = oneJson(r);
    const dns = /"dns":\s*"([a-z]+)"/.exec(r.stdout)?.[1];
    return { ok: base.ok, note: `${base.note}${dns ? `; dns=${dns}` : ""}` };
  });
  const host = `${run.project}.hack.local`;
  const https = await httpsHealth(run, host, "127.0.0.1", ca);
  run.record({
    step: "3 routed HTTPS",
    command: `curl --resolve ${host}:443:127.0.0.1 --cacert <hack global ca> /health`,
    exit: https.exit,
    seconds: https.seconds,
    result: https.stdout.trim().endsWith("200") ? "pass" : "fail",
    note: https.stdout.trim().split("\n").at(-1) ?? "",
  });
  await run.step(
    "3 exec web",
    ["exec", "web", "python", "-c", "print('exec-ok')"],
    (r) => ({
      ok: r.exit === 0 && r.stdout.includes("exec-ok"),
      note: r.stdout.includes("exec-ok")
        ? "exec-ok printed"
        : "expected output missing",
    })
  );
  await run.step(
    "3 run worker",
    ["run", "worker", "sh", "-c", "echo run-ok"],
    (r) => ({
      ok: r.exit === 0 && r.stdout.includes("run-ok"),
      note: r.stdout.includes("run-ok")
        ? "run-ok printed"
        : "expected output missing",
    })
  );
  await run.step("3 restart --json", ["restart", "--json"], (r) => oneJson(r));
  await run.step("3 down --json", ["down", "--json"], (r) => oneJson(r));
}

async function envFlow(run: FirstRun): Promise<void> {
  await run.step(
    "4 env set GREETING --service web",
    ["env", "set", "GREETING", "hello", "--service", "web"],
    (r) => ({ ok: r.exit === 0, note: "" })
  );
  const secret = `s-${randomBytes(12).toString("hex")}`;
  // Kept in a private file so no later command carries it in argv.
  const expectedFile = join(run.opts.scratch, "tmp", "expected-secret");
  await writeFile(expectedFile, secret, { mode: 0o600 });
  await run.step(
    "4 env set SECRET --secret --value-stdin",
    ["env", "set", "LQ_TOKEN", "--secret", "--value-stdin"],
    (r) => ({ ok: r.exit === 0, note: "value never printed" }),
    { stdin: secret }
  );
  await run.step("4 env list --json", ["env", "list", "--json"], (r) =>
    oneJson(r, (v) => {
      const row = (
        v as { vars?: { key: string; source?: string }[] }
      ).vars?.find((x) => x.key === "LQ_TOKEN");
      return row ? null : "LQ_TOKEN missing";
    })
  );
  await run.step("4 env get SECRET", ["env", "get", "LQ_TOKEN"], (r) => ({
    ok: r.exit === 0 && r.stdout === secret,
    note: r.stdout === secret ? "matches (compared, not printed)" : "MISMATCH",
  }));
  const leaked = await run.sh([
    "grep",
    "-rlF",
    "-f",
    expectedFile,
    join(run.repo, ".hack"),
  ]);
  run.record({
    step: "4 no plaintext secret in .hack/",
    command: "grep -rlF <secret> .hack",
    exit: leaked.exit,
    result: leaked.exit === 1 ? "pass" : "fail",
    note: leaked.exit === 1 ? "none found" : "plaintext found",
  });
  await run.step(
    "4 host exec (injected env)",
    [
      "host",
      "exec",
      "--",
      "sh",
      "-c",
      // The expected value is read from a private file, never put in argv.
      `[ "$LQ_TOKEN" = "$(cat '${expectedFile}')" ] && echo injected`,
    ],
    (r) => ({
      ok: r.exit === 0 && r.stdout.includes("injected"),
      note: "secret compared inside the child",
    }),
    { display: "hack host exec -- sh -c <compare>" }
  );
  // The throwaway secret is not kept once the comparisons are done.
  await rm(expectedFile, { force: true });
}

async function branchFlow(run: FirstRun, ca: string): Promise<void> {
  const main = run.hack(["up", "-d", "--json"]);
  await Bun.sleep(3000);
  await run.step(
    "5 up --branch b1 -d --json",
    ["up", "--branch", "b1", "-d", "--json"],
    (r) => oneJson(r)
  );
  const mainRan = await main;
  run.record({
    step: "5 up -d --json (main, concurrent)",
    command: "hack up -d --json",
    exit: mainRan.exit,
    seconds: mainRan.seconds,
    result: oneJson(mainRan).ok ? "pass" : "fail",
    note:
      mainRan.killedAtLimitMs === null
        ? oneJson(mainRan).note
        : `killed by the check's ${Math.round(mainRan.killedAtLimitMs / 60_000)}-minute command limit, not a Hack result`,
  });
  for (const host of [
    `${run.project}.hack.local`,
    `b1.${run.project}.hack.local`,
  ]) {
    const r = await httpsHealth(run, host, "127.0.0.1", ca);
    const greeting = r.stdout.includes('"greeting": "hello"');
    run.record({
      step: `5 HTTPS ${host.startsWith("b1.") ? "b1" : "main"}`,
      command: `curl https://${host}/health`,
      exit: r.exit,
      seconds: r.seconds,
      result: r.stdout.trim().endsWith("200") && greeting ? "pass" : "fail",
      note: greeting ? "200, env reached web" : r.stdout.trim().slice(-60),
    });
  }
  await run.step(
    "5 down --branch b1 --json",
    ["down", "--branch", "b1", "--json"],
    (r) => oneJson(r)
  );
  await run.step("5 down --json", ["down", "--json"], (r) => oneJson(r));
}

async function foregroundInterrupt(run: FirstRun): Promise<void> {
  if (Bun.which("script") === null) {
    run.record({
      step: "6 foreground up + Ctrl-C",
      command: "script",
      exit: null,
      result: "info",
      note: "not run: util-linux script missing",
    });
    return;
  }
  const started = performance.now();
  const log = join(run.opts.scratch, "fg-up.log");
  const proc = Bun.spawn(["script", "-qfec", `${run.opts.hack} up`, log], {
    cwd: run.repo,
    env: run.env,
    stdin: "pipe",
    stdout: "ignore",
    stderr: "ignore",
  });
  const worker = `${run.project}-worker-1`;
  const deadline = Date.now() + (run.opts.oneShotSeconds + 180) * 1000;
  let state = "";
  while (Date.now() < deadline) {
    state = (
      await run.sh(["docker", "inspect", "-f", "{{.State.Status}}", worker])
    ).stdout.trim();
    if (state === "running") {
      break;
    }
    await Bun.sleep(1000);
  }
  await Bun.sleep(3000);
  proc.stdin.write("\u0003");
  await proc.stdin.flush();
  const exit = await Promise.race([
    proc.exited,
    Bun.sleep(60_000).then(() => null),
  ]);
  if (exit === null) {
    proc.kill("SIGKILL");
  }
  // `hack-next up` is a launcher, its manager and the bundle's CLI: all three
  // run from the channel root, so any process naming it is a leftover.
  const leftover = await run.sh([
    "pgrep",
    "-u",
    String(process.getuid?.() ?? 0),
    ...(run.opts.installer === undefined
      ? ["-xf", `${run.opts.hack} up`]
      : ["-f", `^${escapeRegExp(join(run.home, ".hack-next"))}/.* up$`]),
  ]);
  const running = (
    await run.sh([
      "docker",
      "ps",
      "-q",
      "--filter",
      `label=com.docker.compose.project=${run.project}`,
    ])
  ).stdout.trim();
  run.record({
    step: "6 foreground up + Ctrl-C",
    command: "hack up (pty), then ^C",
    exit,
    seconds: (performance.now() - started) / 1000,
    result:
      state === "running" &&
      exit === 130 &&
      leftover.exit === 1 &&
      running === ""
        ? "pass"
        : "fail",
    note: `worker reached ${state || "nothing"}; ${leftover.exit === 1 ? "no hack process left" : "hack process left"}; ${running === "" ? "containers stopped" : "containers still running"}`,
  });
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Records one installer or manager command of installer mode. */
async function installerStep(
  run: FirstRun,
  opts: {
    readonly step: string;
    readonly display: string;
    readonly argv: readonly string[];
    readonly env?: Record<string, string>;
    readonly check: (ran: Ran) => {
      readonly ok: boolean;
      readonly note: string;
    };
  }
): Promise<Ran> {
  const ran = await runProcess({
    argv: opts.argv,
    env: { ...run.env, ...opts.env },
    cwd: run.opts.scratch,
    timeoutMs: 1_800_000,
  });
  const verdict = opts.check(ran);
  run.record({
    step: opts.step,
    command: opts.display,
    exit: ran.exit,
    seconds: ran.seconds,
    result: verdict.ok ? "pass" : "fail",
    note: verdict.note,
  });
  return ran;
}

/** The `selected` field of a manager status line, or undefined if it is not one. */
function selectedVersion(stdout: string): string | null | undefined {
  try {
    const value = JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as {
      selected?: unknown;
    };
    return typeof value.selected === "string" || value.selected === null
      ? value.selected
      : undefined;
  } catch {
    return;
  }
}

/**
 * Installer mode, before any Hack command: the installer must refuse an
 * architecture with no bundle without touching HOME, then install under HOME
 * with no sudo and say that the native backend is macOS only.
 */
async function installFlow(
  run: FirstRun,
  installer: InstallerInput
): Promise<boolean> {
  const root = join(run.home, ".hack-next");
  const fakeBin = join(run.opts.scratch, "tmp", "fake-uname");
  await mkdir(fakeBin, { mode: 0o700 });
  await writeFile(
    join(fakeBin, "uname"),
    '#!/bin/sh\ncase "${1-}" in -s) echo Linux ;; -m) echo riscv64 ;; *) echo Linux ;; esac\n',
    { mode: 0o755 }
  );
  await installerStep(run, {
    step: "1 installer refuses an unsupported architecture",
    display: "sh hack-next-install.sh (uname -m = riscv64)",
    argv: ["sh", installer.path],
    env: { PATH: `${fakeBin}:${run.env.PATH ?? ""}` },
    check: (r) => {
      const named = r.stderr.includes("Linux x86_64 or arm64");
      const untouched = !pathExists(root);
      return {
        ok: r.exit !== 0 && named && untouched,
        note: `${named ? "names the supported platforms" : "does not name the supported platforms"}; ${untouched ? "nothing installed" : "~/.hack-next was created"}`,
      };
    },
  });
  await rm(fakeBin, { recursive: true, force: true });
  const local = [
    ...(installer.archive === undefined
      ? []
      : ["--archive", installer.archive, "--sha256", installer.sha256 ?? ""]),
    ...(installer.manager === undefined
      ? []
      : ["--manager", installer.manager]),
  ];
  const install = await installerStep(run, {
    step: "1 install through the installer",
    display: `sh hack-next-install.sh${installer.archive === undefined ? "" : " --archive <archive> --sha256 <digest>"}${installer.manager === undefined ? "" : " --manager <manager>"}`,
    argv: ["sh", installer.path, ...local],
    check: (r) => {
      const noted = r.stdout.includes(LINUX_INSTALLED_NOTE);
      return {
        ok: r.exit === 0 && noted && executableFile(run.opts.hack),
        note:
          r.exit === 0
            ? `installed under ~/.hack-next without sudo; ${noted ? "says the native backend is macOS only" : "does NOT say the native backend is macOS only"}`
            : firstError(r),
      };
    },
  });
  if (install.exit !== 0) {
    return false;
  }
  await installerStep(run, {
    step: "1 hack-next --manager status",
    display: "hack-next --manager status",
    argv: [run.opts.hack, "--manager", "status"],
    check: (r) => {
      const selected = selectedVersion(r.stdout);
      return {
        ok: r.exit === 0 && typeof selected === "string",
        note:
          typeof selected === "string"
            ? `selected ${selected}`
            : "no selected version reported",
      };
    },
  });
  return true;
}

function pathExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Installer mode, after the Hack steps: deselect, roll back to the candidate,
 * then uninstall and record what is left under HOME.
 */
async function managerFlow(run: FirstRun): Promise<void> {
  const manager = (args: readonly string[]) => [
    run.opts.hack,
    "--manager",
    ...args,
  ];
  const before = selectedVersion((await run.sh(manager(["status"]))).stdout);
  await installerStep(run, {
    step: "10 hack-next --manager stable",
    display: "hack-next --manager stable",
    argv: manager(["stable"]),
    check: (r) => ({
      ok: r.exit === 0 && selectedVersion(r.stdout) === null,
      note:
        selectedVersion(r.stdout) === null
          ? "no candidate selected; bundle kept"
          : firstError(r),
    }),
  });
  await installerStep(run, {
    step: "10 hack-next with nothing selected",
    display: "hack-next --version",
    argv: [run.opts.hack, "--version"],
    check: (r) => ({
      ok: r.exit !== 0 && r.stderr.includes("No candidate selected"),
      note: r.exit === 0 ? "ran a deselected candidate" : firstError(r),
    }),
  });
  await installerStep(run, {
    step: "10 hack-next --manager rollback",
    display: "hack-next --manager rollback",
    argv: manager(["rollback"]),
    check: (r) => ({
      ok: r.exit === 0 && selectedVersion(r.stdout) === before,
      note:
        selectedVersion(r.stdout) === before
          ? `selected ${String(before)} again`
          : firstError(r),
    }),
  });
  await installerStep(run, {
    step: "10 hack-next --manager uninstall (preview)",
    display: "hack-next --manager uninstall",
    argv: manager(["uninstall"]),
    check: (r) => ({
      ok:
        r.exit === 0 &&
        r.stdout.includes('"applied":false') &&
        executableFile(run.opts.hack),
      note: "preview only; channel unchanged",
    }),
  });
  await installerStep(run, {
    step: "10 hack-next --manager uninstall --apply",
    display: "hack-next --manager uninstall --apply",
    argv: manager(["uninstall", "--apply"]),
    check: (r) => ({
      ok: r.exit === 0 && r.stdout.includes('"applied":true'),
      note: r.exit === 0 ? "channel moved aside" : firstError(r),
    }),
  });
  const left = (await readdir(run.home).catch(() => [])).filter((name) =>
    name.includes("hack-next")
  );
  // The manager names the retained sibling `.<root name>.uninstalled-<id>`.
  const retained = left.filter((name) =>
    /^\.\.hack-next\.uninstalled-[0-9a-f]{32}(\.json)?$/.test(name)
  );
  run.record({
    step: "10 left on disk after uninstall",
    command: "ls -a ~ | grep hack-next",
    exit: null,
    result:
      !left.includes(".hack-next") && retained.length === 2 && left.length === 2
        ? "pass"
        : "fail",
    note: `~/.hack-next ${left.includes(".hack-next") ? "still present" : "gone"}; kept ${retained.length === 2 ? "one retained channel directory and its rollback manifest" : left.join(", ") || "nothing"}`,
  });
}

async function daemonFlow(run: FirstRun): Promise<void> {
  await run.step("6 daemon start", ["daemon", "start"], (r) => ({
    ok: r.exit === 0,
    note: r.exit === 0 ? "started" : firstError(r),
  }));
  await run.step(
    "6 daemon status --json",
    ["daemon", "status", "--json"],
    (r) => {
      const count = countJsonValues(r.stdout);
      return {
        ok: count === 1 && r.exit === 0,
        note:
          count === 1
            ? `status ${/"status":\s*"(\w+)"/.exec(r.stdout)?.[1]}`
            : "not one JSON value",
      };
    }
  );
  await run.step("6 daemon stop", ["daemon", "stop"], (r) => ({
    ok: r.exit === 0,
    note: "",
  }));
}

async function closingFlow(run: FirstRun): Promise<void> {
  await run.step(
    "7 update --check --json --observe",
    ["update", "--check", "--json", "--observe"],
    (r) => ({
      ok: countJsonValues(r.stdout) === 1 ? "info" : false,
      note:
        countJsonValues(r.stdout) === 1
          ? "one JSON value"
          : "not one JSON value",
    })
  );
  await run.step(
    "8 native setup --json",
    ["native", "setup", "--json"],
    (r) => {
      const code = /"code":\s*"(E_[A-Z_]+)"/.exec(r.stdout)?.[1] ?? "none";
      return {
        ok: r.exit !== 0 && code === "E_UNSUPPORTED_PLATFORM",
        note: `code ${code}`,
      };
    }
  );
}

/** Lists Docker objects of `kind` carrying one Compose project label. */
async function labeled(
  run: FirstRun,
  kind: "container" | "volume" | "network",
  project: string
): Promise<string[]> {
  const label = `label=com.docker.compose.project=${project}`;
  const argv =
    kind === "container"
      ? ["docker", "ps", "-aq", "--filter", label]
      : ["docker", kind, "ls", "-q", "--filter", label];
  return (await run.sh(argv)).stdout.split("\n").filter(Boolean);
}

/** Removes labeled volumes (and networks) of `projects`; returns their names. */
async function removeLabeled(
  run: FirstRun,
  projects: readonly string[],
  kinds: readonly ("volume" | "network")[]
): Promise<string[]> {
  const removed: string[] = [];
  for (const project of projects) {
    const containers = await labeled(run, "container", project);
    if (containers.length > 0) {
      await run.sh(["docker", "rm", "-f", ...containers]);
    }
    for (const kind of kinds) {
      const names = await labeled(run, kind, project);
      if (
        names.length > 0 &&
        (await run.sh(["docker", kind, "rm", ...names])).exit === 0
      ) {
        removed.push(...names);
      }
    }
  }
  return removed;
}

async function cleanup(run: FirstRun): Promise<void> {
  // Always stop hackd before its state under HOME is removed.
  await run.hack(["daemon", "stop"], { timeoutMs: 60_000 });
  await run.hack(["down", "--branch", "b1"], { timeoutMs: 120_000 });
  await run.hack(["down"], { timeoutMs: 120_000 });
  const removed = await removeLabeled(
    run,
    [run.project, `${run.project}--b1`],
    ["volume", "network"]
  );
  if (run.startedGlobalStack) {
    await run.hack(["global", "down"], { timeoutMs: 120_000 });
  }
  const removesGlobalVolumes =
    run.startedGlobalStack && run.ownedVolumeProjects.length > 0;
  if (removesGlobalVolumes) {
    // `global down` keeps named volumes; the check created these projects'
    // volumes, so it removes them. removeLabeled first force-removes any
    // container still labeled with those projects: they are the check's own
    // (no global container existed before), and a failed `global down` would
    // otherwise keep the volumes in use.
    removed.push(
      ...(await removeLabeled(run, run.ownedVolumeProjects, ["volume"]))
    );
  }
  const left = await readdir(join(run.home, ".hack")).catch(() => []);
  const stack = run.startedGlobalStack ? "stopped" : "left as found";
  run.record({
    step: "9 cleanup",
    command: "hack down; docker rm/volume rm (own labels); hack global down",
    exit: null,
    result: "info",
    note: `removed ${removed.length} volumes/networks it created; global stack ${stack}${removesGlobalVolumes ? " and its volumes removed" : ""}; ~/.hack holds ${left.length} entries${run.opts.keep ? " (kept)" : ""}`,
  });
}

export async function main(argv: readonly string[]): Promise<number> {
  const opts = parseCheckArgs(argv);
  await mkdir(opts.scratch, { recursive: true, mode: 0o700 });
  if ((await readdir(opts.scratch)).length > 0) {
    throw new Error(
      `--scratch must be a new or empty directory: ${opts.scratch}`
    );
  }
  const run = new FirstRun(opts);
  await mkdir(run.home, { mode: 0o700 });
  await chmod(run.home, 0o700);
  await mkdir(join(opts.scratch, "tmp"), { mode: 0o700 });
  await mkdir(run.repo, { mode: 0o700 });
  let cleaned = false;
  const installed =
    opts.installer === undefined
      ? true
      : await installFlow(run, opts.installer).catch(() => false);
  const version = await run.hack(["--version"]).catch(() => null);
  run.record({
    step: "1 version",
    command: `${opts.installer === undefined ? "hack" : "hack-next"} --version`,
    exit: version?.exit ?? null,
    seconds: version?.seconds,
    result: version?.exit === 0 ? "info" : "fail",
    note: version?.stdout.trim() ?? "not runnable",
  });
  try {
    if (version?.exit === 0 && (await preflight(run))) {
      await writeFixture(run);
      if (await globalSetup(run)) {
        const ca = (await run.hack(["global", "ca"])).stdout.trim();
        await projectFlow(run, ca);
        await envFlow(run);
        await branchFlow(run, ca);
        await foregroundInterrupt(run);
        await loggingFlow(run);
      }
      await daemonFlow(run);
      await closingFlow(run);
    }
  } finally {
    if (
      run.steps.some((s) => s.step === "0 preflight" && s.result !== "fail")
    ) {
      await cleanup(run);
      cleaned = true;
    }
    // Last: the uninstall moves the channel, and with it the CLI under test.
    if (opts.installer !== undefined && installed && version?.exit === 0) {
      await managerFlow(run);
    }
    // As before installer mode existed, a run that failed preflight keeps
    // its scratch; installer mode has installed into it by then, so it clears.
    if (!opts.keep && (cleaned || opts.installer !== undefined)) {
      await rm(run.home, { recursive: true, force: true });
      await rm(run.repo, { recursive: true, force: true });
    }
  }
  const table = renderStepTable(run.steps);
  const failed = run.steps.filter((s) => s.result === "fail").length;
  const summary = `${failed === 0 ? "PASS" : "FAIL"}: ${run.steps.length} steps, ${failed} failed. Root steps (Linux DNS, system trust) were not run.`;
  await writeFile(join(opts.scratch, "report.md"), `${summary}\n\n${table}\n`);
  process.stdout.write(`${table}\n\n${summary}\n`);
  return failed === 0 ? 0 : 1;
}

if (import.meta.main) {
  try {
    process.exit(await main(Bun.argv.slice(2)));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exit(2);
  }
}
