import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CheckResult } from "../src/commands/global-mac-dns.ts";
import {
  type ObserveDeps,
  observeGlobalStatus,
} from "../src/commands/global-status-observe.ts";
import type { LinuxDnsInspection } from "../src/lib/linux-dns-setup.ts";
import { isolatedDockerClientEnv } from "./helpers/docker-client.ts";

// `hack global status --json --observe` (HACK-2218, R13): never starts
// anything. The decision logic is tested on both platforms' paths with
// fake boundaries; the real CLI is run with every child process recorded
// and only fake, read-only tools on PATH.

const ok = (name: string): CheckResult => ({ name, status: "ok", message: "" });
const warn = (name: string, message = "missing"): CheckResult => ({
  name,
  status: "warn",
  message,
});

const RUNNING = { exitCode: 0, stdout: "29.0.0\n", stderr: "" };
const DOWN = {
  exitCode: 1,
  stdout: "",
  stderr:
    "Cannot connect to the Docker daemon at unix:///var/run/docker.sock\n",
};

function linuxInspection(
  state: LinuxDnsInspection["state"]
): LinuxDnsInspection {
  return {
    resolver: { kind: "systemd-resolved-stub" },
    state,
    code: state === "configured" ? null : "linux_dns_missing",
    link: null,
    message: state,
    fix: [],
  } as unknown as LinuxDnsInspection;
}

function deps(overrides: Partial<ObserveDeps> = {}): {
  readonly deps: ObserveDeps;
  readonly calls: string[];
} {
  const calls: string[] = [];
  const track =
    <T>(name: string, value: T) =>
    async () => {
      calls.push(name);
      return await Promise.resolve(value);
    };
  const base: ObserveDeps = {
    platform: "linux",
    dockerInstalled: () => true,
    probeDocker: track("docker info", RUNNING),
    readCaddy: track("caddy", { ok: true, error: null, services: [] }),
    readLogging: track("logging", { ok: true, error: null, services: [] }),
    readNetworks: track("networks", { ok: true, missing: [], networks: [] }),
    readProxyNetwork: track("proxy", { ok: true, readable: true, issues: [] }),
    caddyIp: track("caddy ip", "172.30.0.2"),
    inspectLinuxDns: track("linux dns", linuxInspection("configured")),
    macResolver: async (domain) => {
      calls.push(`resolver ${domain}`);
      return await Promise.resolve(ok(`resolver:${domain}`));
    },
    macDnsmasqConfig: async (domain, opts) => {
      calls.push(`dnsmasq ${domain}`);
      await opts.caddyIp();
      return ok(`dnsmasq.conf:${domain}`);
    },
    macDnsmasqPort53: track("port 53", ok("dnsmasq:53")),
    now: () => new Date("2026-11-14T00:00:00.000Z"),
  };
  return { deps: { ...base, ...overrides }, calls };
}

test("Docker that does not answer is never asked again, and its parts are unknown", async () => {
  for (const probe of [
    { result: DOWN, state: "not_running", docker_ok: false },
    {
      result: { exitCode: 124, stdout: "", stderr: "" },
      state: "unknown",
      docker_ok: "unknown",
    },
  ] as const) {
    const { deps: d, calls } = deps({
      probeDocker: async () => await Promise.resolve(probe.result),
    });
    const status = await observeGlobalStatus(d);
    expect(status.docker.state).toBe(probe.state);
    for (const part of [
      "caddy",
      "logging",
      "networks",
      "proxy_network",
    ] as const) {
      expect(status[part].ok).toBe("unknown");
    }
    expect(status.summary).toMatchObject({
      docker_ok: probe.docker_ok,
      caddy_ok: "unknown",
      host_dns_ok: true,
    });
    expect(status.summary.ok).toBe(
      probe.docker_ok === false ? false : "unknown"
    );
    // Only the host DNS read ran; no Docker-backed read was attempted.
    expect(calls).toEqual(["linux dns"]);
  }
});

test("no docker on PATH: nothing is probed, and the Docker parts are unknown", async () => {
  const { deps: d, calls } = deps({ dockerInstalled: () => false });
  const status = await observeGlobalStatus(d);
  expect(status.docker.state).toBe("not_installed");
  expect(status.summary.docker_ok).toBe(false);
  expect(status.caddy.ok).toBe("unknown");
  expect(calls).toEqual(["linux dns"]);
});

test("with Docker running every part is read, and a part that throws is unknown", async () => {
  const { deps: d } = deps({
    readLogging: async () => {
      throw new Error("synthetic read failure");
    },
    readProxyNetwork: async () =>
      await Promise.resolve({ ok: null, readable: false, issues: [] }),
  });
  const status = await observeGlobalStatus(d);
  expect(status.summary).toEqual({
    docker_ok: true,
    caddy_ok: true,
    logging_ok: "unknown",
    networks_ok: true,
    proxy_network_ok: "unknown",
    host_dns_ok: true,
    ok: "unknown",
  });
});

test("Linux host DNS: configured is yes, a resolver Hack does not manage is unknown, others are no", async () => {
  for (const [state, expected] of [
    ["configured", true],
    ["manual", "unknown"],
    ["missing", false],
    ["bridge_missing", false],
    ["not_applied", false],
  ] as const) {
    const { deps: d } = deps({
      inspectLinuxDns: async () =>
        await Promise.resolve(linuxInspection(state)),
    });
    const status = await observeGlobalStatus(d);
    expect(status.host_dns).toMatchObject({
      platform: "linux",
      state,
      ok: expected,
    });
    expect(status.summary.host_dns_ok).toBe(expected);
  }
  const { deps: failing } = deps({
    inspectLinuxDns: async () => {
      throw new Error("synthetic");
    },
  });
  expect((await observeGlobalStatus(failing)).summary.host_dns_ok).toBe(
    "unknown"
  );
});

test("macOS host DNS: resolver files, dnsmasq lines and port 53 decide it; Docker is asked for Caddy's address only when running", async () => {
  const all = await observeGlobalStatus(deps({ platform: "darwin" }).deps);
  expect(all.host_dns).toMatchObject({
    platform: "darwin",
    state: "configured",
    ok: true,
  });
  expect(all.summary.host_dns_ok).toBe(true);

  const missing = await observeGlobalStatus(
    deps({
      platform: "darwin",
      macResolver: async (domain) =>
        await Promise.resolve(warn(`resolver:${domain}`)),
    }).deps
  );
  expect(missing.host_dns).toMatchObject({
    state: "not_configured",
    ok: false,
  });

  // Without Homebrew dnsmasq.conf cannot be located: unknown, not missing.
  const noBrew = await observeGlobalStatus(
    deps({
      platform: "darwin",
      macDnsmasqConfig: async (domain) =>
        await Promise.resolve(
          warn(
            `dnsmasq.conf:${domain}`,
            "Homebrew not found; cannot locate dnsmasq.conf"
          )
        ),
    }).deps
  );
  expect(noBrew.host_dns).toMatchObject({ state: "unknown", ok: "unknown" });

  // Docker down: the dnsmasq check gets a Caddy-address lookup that never
  // reaches Docker.
  const { deps: down, calls } = deps({
    platform: "darwin",
    probeDocker: async () => await Promise.resolve(DOWN),
  });
  await observeGlobalStatus(down);
  expect(calls).not.toContain("caddy ip");
  const { deps: up, calls: upCalls } = deps({ platform: "darwin" });
  await observeGlobalStatus(up);
  expect(upCalls).toContain("caddy ip");
});

test("other platforms report host DNS as unknown", async () => {
  const status = await observeGlobalStatus(deps({ platform: "win32" }).deps);
  expect(status.host_dns).toMatchObject({ state: "unknown", ok: "unknown" });
});

// --- The real CLI, with every child process recorded ------------------------

const REPO_ROOT = resolve(import.meta.dir, "..");
const ENTRYPOINT = resolve(REPO_ROOT, "index.ts");
const RECORDER = resolve(import.meta.dir, "fixtures/spawn-argv-recorder.ts");
const RUN_DEADLINE_MS = 10_000;
const CLI_TEST_TIMEOUT_MS = 30_000;

/**
 * Every program the observe mode may run, with its exact read-only argv
 * (prefix match on the leading words). Anything else, and above all a
 * starter (`open`, `colima`, `orb`, `systemctl start`, `hack daemon`),
 * fails the test.
 */
const ALLOWED: readonly (readonly string[])[] = [
  ["docker", "info", "--format", "{{.ServerVersion}}"],
  ["docker", "compose", "-f"], // … ps --format json (checked below)
  ["docker", "network", "ls", "--format", "json"],
  ["docker", "ps", "-q", "--filter"],
  ["docker", "ps", "-a", "--filter"],
  ["docker", "inspect"],
  ["systemctl", "is-active", "systemd-resolved"],
  ["systemctl", "--version"],
  ["systemctl", "show"],
  ["ip", "-j", "-4", "addr", "show"],
  ["resolvectl"],
  ["brew", "--prefix"],
];

function allowed(argv: readonly string[]): boolean {
  const [program, ...rest] = argv;
  const name = (program ?? "").split("/").at(-1) ?? "";
  const words = [name, ...rest];
  if (name === "docker" && rest[0] === "compose") {
    return words.at(-3) === "ps" && words.at(-2) === "--format";
  }
  if (name === "systemctl" && rest[0] === "show") {
    return !rest.some((word) => ["start", "restart", "enable"].includes(word));
  }
  return ALLOWED.some((prefix) =>
    prefix.every((word, index) => words[index] === word)
  );
}

let root: string | null = null;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hack-global-observe-"));
  await mkdir(join(root, "home"), { recursive: true });
  await mkdir(join(root, "bin"), { recursive: true });
});

afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true });
    root = null;
  }
});

/** Fake read-only tools; `docker` answers as a running or stopped engine. */
async function installFakeTools(base: string, docker: "up" | "down") {
  const script = (body: string) => `#!/bin/sh\n${body}\n`;
  const tools: Record<string, string> = {
    docker:
      docker === "down"
        ? script(
            'echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock" >&2\nexit 1'
          )
        : script(
            [
              'case "$1" in',
              '  info) echo "29.0.0" ;;',
              '  network) printf \'%s\\n\' \'{"Name":"hack-dev","ID":"a","Driver":"bridge","Scope":"local"}\' \'{"Name":"hack-logging","ID":"b","Driver":"bridge","Scope":"local"}\' ;;',
              "  *) : ;;",
              "esac",
              "exit 0",
            ].join("\n")
          ),
    systemctl: script("exit 1"),
    ip: script("exit 1"),
    resolvectl: script("exit 1"),
    brew: script("exit 1"),
    // What a starter would run; present so a regression is recorded rather
    // than skipped (each fails, so nothing could ever start).
    sudo: script("exit 1"),
    open: script("exit 1"),
    colima: script("exit 1"),
    orb: script("exit 1"),
    orbctl: script("exit 1"),
  };
  for (const [name, body] of Object.entries(tools)) {
    const path = join(base, "bin", name);
    await writeFile(path, body);
    await chmod(path, 0o755);
  }
}

async function runObserve(base: string): Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly spawned: readonly (readonly string[])[];
}> {
  const home = join(base, "home");
  const spawnLog = join(base, "spawn.jsonl");
  const proc = Bun.spawn(
    [
      process.execPath,
      "--preload",
      RECORDER,
      ENTRYPOINT,
      "global",
      "status",
      "--json",
      "--observe",
    ],
    {
      cwd: home,
      env: {
        PATH: join(base, "bin"),
        ...isolatedDockerClientEnv(home),
        HOME: home,
        HACK_HOME: join(home, ".hack"),
        TMPDIR: home,
        HACK_GLOBAL_CONFIG_PATH: join(home, ".hack", "hack.config.json"),
        HACK_LOGGER: "console",
        HACK_TEST_SPAWN_ARGV_LOG: spawnLog,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  // An observe read answers quickly; one that waits (for a runtime it
  // started, say) is stopped here so the test reports what it spawned.
  const deadline = setTimeout(() => proc.kill("SIGKILL"), RUN_DEADLINE_MS);
  const [stdout, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]).finally(() => clearTimeout(deadline));
  const log = await readFile(spawnLog, "utf8").catch(() => "");
  const spawned = log
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => (JSON.parse(line) as { argv: string[] }).argv);
  return { exitCode, stdout, spawned };
}

function requireRoot(): string {
  if (!root) {
    throw new Error("Missing temp root");
  }
  return root;
}

test(
  "the CLI with Docker stopped runs only the Docker probe and read-only host probes",
  async () => {
    const base = requireRoot();
    await installFakeTools(base, "down");
    const result = await runObserve(base);
    // Nothing outside the listed read-only probes, checked first.
    expect(result.spawned.filter((argv) => !allowed(argv))).toEqual([]);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      readonly docker: { readonly state: string };
      readonly summary: Record<string, unknown>;
    };
    expect(payload.docker.state).toBe("not_running");
    expect(payload.summary.caddy_ok).toBe("unknown");
    expect(result.spawned.length).toBeGreaterThan(0);
    expect(result.spawned.filter((argv) => !allowed(argv))).toEqual([]);
    // Docker was asked exactly once, and only `info`.
    const dockerCalls = result.spawned.filter(
      (argv) => (argv[0] ?? "").split("/").at(-1) === "docker"
    );
    expect(dockerCalls).toEqual([
      ["docker", "info", "--format", "{{.ServerVersion}}"],
    ]);
  },
  CLI_TEST_TIMEOUT_MS
);

test(
  "the CLI with Docker running and the stack installed still runs only listed read-only probes",
  async () => {
    const base = requireRoot();
    await installFakeTools(base, "up");
    const hackHome = join(base, "home", ".hack");
    for (const stack of ["caddy", "logging"]) {
      await mkdir(join(hackHome, stack), { recursive: true });
      await writeFile(
        join(hackHome, stack, "docker-compose.yml"),
        "services: {}\n"
      );
    }
    const result = await runObserve(base);
    // Nothing outside the listed read-only probes, checked first.
    expect(result.spawned.filter((argv) => !allowed(argv))).toEqual([]);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      readonly docker: { readonly state: string };
      readonly networks: { readonly ok: unknown };
    };
    expect(payload.docker.state).toBe("running");
    expect(payload.networks.ok).toBe(true);
    expect(result.spawned.filter((argv) => !allowed(argv))).toEqual([]);
    expect(
      result.spawned.some(
        (argv) => argv[1] === "compose" && argv.includes("ps")
      )
    ).toBe(true);
  },
  CLI_TEST_TIMEOUT_MS
);

test("without --json, --observe refuses instead of printing a starter-capable view", async () => {
  const base = requireRoot();
  await installFakeTools(base, "down");
  const home = join(base, "home");
  const proc = Bun.spawn(
    [process.execPath, ENTRYPOINT, "global", "status", "--observe"],
    {
      cwd: home,
      env: {
        PATH: join(base, "bin"),
        HOME: home,
        HACK_HOME: join(home, ".hack"),
        TMPDIR: home,
        HACK_LOGGER: "console",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  expect(await proc.exited).toBe(2);
});
