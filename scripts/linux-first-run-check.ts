#!/usr/bin/env bun
/**
 * Linux first-run check for the Compose path, without sudo (HACK-2329).
 *
 * Runs a built `hack` the way a new Linux user would, in a fresh private HOME:
 * doctor, global install (and the `proxy.bind_address` retry when :443 is
 * taken), init, up/ps/logs/open/exec/run/restart/down with `--json` shape
 * checks, routed HTTPS against Hack's CA, env and a secret (never printed),
 * host exec, a branch instance, foreground `up` with Ctrl-C in a pty, the
 * daemon, the update check and `native setup`. It prints one Markdown table
 * (step, command, exit, seconds, result) and writes it to `<scratch>/report.md`.
 *
 * Usage:
 *   bun scripts/linux-first-run-check.ts --hack /abs/dist/hack --scratch /abs/new/dir \
 *     [--one-shot-seconds 150] [--reuse-global-stack] [--keep]
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
 * codes Hack reports for them. Not covered: published-artifact install,
 * systemd user services, browsers, rootless Docker.
 */
import { randomBytes } from "node:crypto";
import { accessSync, constants, statSync } from "node:fs";
import { chmod, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

export type StepResult = "pass" | "fail" | "info";

export type StepRecord = {
  readonly step: string;
  readonly command: string;
  readonly exit: number | null;
  readonly seconds: number;
  readonly result: StepResult;
  readonly note: string;
};

export type CheckOptions = {
  readonly hack: string;
  readonly scratch: string;
  readonly oneShotSeconds: number;
  readonly reuseGlobalStack: boolean;
  readonly keep: boolean;
};

const USAGE =
  "Usage: bun scripts/linux-first-run-check.ts --hack /abs/hack --scratch /abs/new/dir [--one-shot-seconds N] [--reuse-global-stack] [--keep]";

/** Parses argv; throws with the usage text on anything unexpected. */
export function parseCheckArgs(argv: readonly string[]): CheckOptions {
  let hack: string | null = null;
  let scratch: string | null = null;
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
  return { hack, scratch, oneShotSeconds, reuseGlobalStack, keep };
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
  return {
    exit,
    stdout,
    stderr,
    seconds: (performance.now() - started) / 1000,
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
      timeoutMs: opts?.timeoutMs ?? 600_000,
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
    const verdict = check(ran);
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

const GLOBAL_PROJECTS = ["hack-dev-proxy", "hack-logging"] as const;
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
  await run.step("2 global trust (no sudo)", ["global", "trust"], (r) => {
    const code =
      /code=([a-z_]+)/.exec(plain(r.stdout + r.stderr))?.[1] ?? "none";
    return { ok: "info", note: `root step not run; Hack reports code=${code}` };
  });
  return ok;
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
    note: oneJson(mainRan).note,
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
  const leftover = await run.sh([
    "pgrep",
    "-u",
    String(process.getuid?.() ?? 0),
    "-xf",
    `${run.opts.hack} up`,
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
  if (!run.opts.keep) {
    await rm(run.home, { recursive: true, force: true });
    await rm(run.repo, { recursive: true, force: true });
  }
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
  const version = await run.hack(["--version"]).catch(() => null);
  run.record({
    step: "1 version",
    command: "hack --version",
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
      }
      await daemonFlow(run);
      await closingFlow(run);
    }
  } finally {
    if (
      run.steps.some((s) => s.step === "0 preflight" && s.result !== "fail")
    ) {
      await cleanup(run);
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
