import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  spyOn,
  test,
} from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  DEFAULT_CADDY_IP,
  DEFAULT_COREDNS_IP,
  DEFAULT_INGRESS_NETWORK,
  DEFAULT_LOGGING_NETWORK,
  GLOBAL_CADDY_COMPOSE_FILENAME,
  GLOBAL_CADDY_DIR_NAME,
  GLOBAL_HACK_DIR_NAME,
  GLOBAL_LOGGING_COMPOSE_FILENAME,
  GLOBAL_LOGGING_DIR_NAME,
  GLOBAL_MANAGED_ENV_SCHEMA_FILENAME,
  GLOBAL_SCHEMAS_DIR_NAME,
} from "../src/constants.ts";
import { resolveGlobalConfigPath } from "../src/lib/config-paths.ts";
import * as interactivity from "../src/lib/interactivity.ts";
import { resetGumPathCacheForTests } from "../src/ui/gum.ts";
import { restoreEnv } from "./helpers/env.ts";
import { machineData, machineError } from "./helpers/machine-output.ts";
import { registerScopedModuleMock } from "./helpers/scoped-module-mock.ts";

let tempDir: string | null = null;
let originalHome: string | undefined;
let originalLogger: string | undefined;
// HACK-1368: `global up` skips its `hack daemon start` step under either one.
const DAEMON_AUTOSTART_DENY_ENV = [
  "HACK_CANDIDATE_ENTRYPOINT",
  "HACK_DAEMON_AUTOSTART_DISABLE",
] as const;
const originalDenyEnv = new Map<string, string | undefined>();
const ISOLATED_ENV = [
  "HACK_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
] as const;
const originalIsolatedEnv = new Map<string, string | undefined>();
const execCalls: string[][] = [];
const runCalls: string[][] = [];
let runExitResponder: ((cmd: readonly string[]) => number | null) | null = null;
let execMockResponder:
  | ((
      cmd: readonly string[]
    ) => { exitCode: number; stdout: string; stderr: string } | null)
  | null = null;

const shellMock = await registerScopedModuleMock({
  importerPath: import.meta.path,
  specifier: "../src/lib/shell.ts",
  overrides: {
    exec: async (cmd: readonly string[]) => {
      execCalls.push([...cmd]);
      const custom = execMockResponder?.(cmd) ?? null;
      if (custom) {
        return custom;
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    execOrThrow: async (cmd: readonly string[]) => {
      execCalls.push([...cmd]);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    run: async (cmd: readonly string[]) => {
      runCalls.push([...cmd]);
      return runExitResponder?.(cmd) ?? 0;
    },
    findExecutableInPath: (name?: string) =>
      name === "hack" ? "/usr/local/bin/hack" : "/usr/bin/mkcert",
    CommandError: class CommandError extends Error {},
  },
});

const osMock = await registerScopedModuleMock({
  importerPath: import.meta.path,
  specifier: "../src/lib/os.ts",
  overrides: {
    isMac: () => false,
    openUrl: async () => 0,
  },
});

// HACK-2053: Linux runs of global install/down/status go through this fake
// DNS host, never the real /etc, resolvectl or sudo.
const linuxDnsPrivileged: string[][] = [];
// Default: resolved inactive, so Linux installs take the manual (no prompt)
// path even in a terminal. Only the sudo test opts into the apply path.
let fakeLinuxResolvedActive = false;
const linuxDnsHostMock = await registerScopedModuleMock({
  importerPath: import.meta.path,
  specifier: "../src/lib/linux-dns-host.ts",
  overrides: {
    createLinuxDnsHost: () => ({
      readFile: async (path: string) =>
        path === "/etc/resolv.conf" ? "nameserver 127.0.0.53\n" : null,
      listDir: async () => [],
      isResolvedActive: async () => fakeLinuxResolvedActive,
      systemdVersion: async () => 255,
      findLinkWithAddress: async () => "br-0123456789ab",
      readLinkRoute: async () => ({ dns: [], domains: [], defaultRoute: null }),
      stageFile: async ({ name }: { readonly name: string }) =>
        join(tempDir ?? tmpdir(), name),
      runPrivileged: async (argv: readonly string[]) => {
        linuxDnsPrivileged.push([...argv]);
        return 0;
      },
    }),
  },
});

beforeAll(() => {
  shellMock.activate();
  osMock.activate();
  linuxDnsHostMock.activate();
});

beforeEach(async () => {
  originalHome = process.env.HOME;
  originalLogger = process.env.HACK_LOGGER;
  tempDir = await mkdtemp(join(tmpdir(), "hack-global-"));
  process.env.HOME = tempDir;
  for (const key of ISOLATED_ENV) {
    originalIsolatedEnv.set(key, process.env[key]);
    process.env[key] = join(
      tempDir,
      key === "HACK_HOME" ? GLOBAL_HACK_DIR_NAME : key.toLowerCase()
    );
  }
  process.env.HACK_LOGGER = "console";
  for (const key of DAEMON_AUTOSTART_DENY_ENV) {
    originalDenyEnv.set(key, process.env[key]);
    Reflect.deleteProperty(process.env, key);
  }
  execCalls.length = 0;
  runCalls.length = 0;
  linuxDnsPrivileged.length = 0;
  fakeLinuxResolvedActive = false;
  execMockResponder = null;
  runExitResponder = null;
});

afterEach(async () => {
  for (const key of ISOLATED_ENV) {
    restoreEnv(key, originalIsolatedEnv.get(key));
  }
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
  restoreEnv("HOME", originalHome);
  restoreEnv("HACK_LOGGER", originalLogger);
  for (const key of DAEMON_AUTOSTART_DENY_ENV) {
    restoreEnv(key, originalDenyEnv.get(key));
  }
  resetGumPathCacheForTests();
});

afterAll(() => {
  shellMock.deactivate();
  osMock.deactivate();
  linuxDnsHostMock.deactivate();
});

async function writeComposeFile(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "services: {}\n");
}

async function writeExecutable(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "#!/usr/bin/env sh\nexit 0\n");
  await chmod(path, 0o755);
}

test.each([
  "install",
  "trust",
])("global %s --json without --plan refuses before any effect", async (command) => {
  const chunks: string[] = [];
  const output = spyOn(process.stdout, "write").mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  const confirm = spyOn(interactivity, "confirmSafe").mockImplementation(() => {
    throw new Error("No confirmation expected");
  });
  try {
    const { runCli } = await import("../src/cli/run.ts");
    expect(await runCli(["global", command, "--json"])).toBe(2);
    expect(execCalls).toEqual([]);
    expect(runCalls).toEqual([]);
    expect(linuxDnsPrivileged).toEqual([]);
    expect(confirm).not.toHaveBeenCalled();
    machineError(chunks.join(""), "E_USAGE");
  } finally {
    confirm.mockRestore();
    output.mockRestore();
  }
});

test.skipIf(process.platform !== "linux")(
  "global install --plan --json uses read-only probes and --plan requires JSON",
  async () => {
    process.env.HACK_DAEMON_AUTOSTART_DISABLE = "1";
    const chunks: string[] = [];
    const stdout = spyOn(process.stdout, "write").mockImplementation(
      (chunk) => {
        chunks.push(String(chunk));
        return true;
      }
    );
    try {
      const { runCli } = await import("../src/cli/run.ts");
      expect(await runCli(["global", "install", "--plan"])).toBe(2);
      expect(execCalls).toEqual([]);
      expect(await runCli(["global", "install", "--plan", "--json"])).toBe(0);
    } finally {
      stdout.mockRestore();
    }
    expect(
      machineData(chunks.join(""), "hack.global-admin-plan.v1")
    ).toMatchObject({
      schema: "hack.global-admin-plan.v1",
      command: "install",
      complete: true,
      refused: null,
    });
    expect(runCalls).toEqual([]);
    expect(linuxDnsPrivileged).toEqual([]);
    expect(
      await Bun.file(
        join(
          tempDir!,
          GLOBAL_HACK_DIR_NAME,
          GLOBAL_CADDY_DIR_NAME,
          GLOBAL_CADDY_COMPOSE_FILENAME
        )
      ).exists()
    ).toBe(false);
  }
);

async function writeStaticCaddyCompose(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    [
      "services:",
      "  caddy:",
      "    networks:",
      "      default:",
      `        ipv4_address: ${DEFAULT_CADDY_IP}`,
      "  coredns:",
      "    networks:",
      "      default:",
      `        ipv4_address: ${DEFAULT_COREDNS_IP}`,
      "",
    ].join("\n")
  );
}

test(
  "global up runs docker compose up for caddy and logging",
  async () => {
    const caddyCompose = join(
      tempDir!,
      GLOBAL_HACK_DIR_NAME,
      GLOBAL_CADDY_DIR_NAME,
      GLOBAL_CADDY_COMPOSE_FILENAME
    );
    const loggingCompose = join(
      tempDir!,
      GLOBAL_HACK_DIR_NAME,
      GLOBAL_LOGGING_DIR_NAME,
      GLOBAL_LOGGING_COMPOSE_FILENAME
    );
    await writeComposeFile(caddyCompose);
    await writeComposeFile(loggingCompose);

    const { runCli } = await import("../src/cli/run.ts");
    const code = await runCli(["global", "up"]);
    expect(code).toBe(0);
    expect(
      runCalls.some((call) => call.includes("daemon") && call.includes("start"))
    ).toBe(true);
    expect(
      runCalls.some(
        (call) => call.includes(caddyCompose) && call.includes("up")
      )
    ).toBe(true);
    expect(
      runCalls.some(
        (call) => call.includes(loggingCompose) && call.includes("up")
      )
    ).toBe(true);
  },
  { timeout: 20_000 }
);

test.each([
  {
    label: "a candidate run",
    key: "HACK_CANDIDATE_ENTRYPOINT",
    value: "hack-v5",
    reason: "candidate run",
  },
  {
    label: "the autostart opt-out",
    key: "HACK_DAEMON_AUTOSTART_DISABLE",
    value: "1",
    reason: "HACK_DAEMON_AUTOSTART_DISABLE=1",
  },
])(
  "global up never runs `hack daemon start` under $label (HACK-1368)",
  async ({ key, value, reason }) => {
    const caddyCompose = join(
      tempDir!,
      GLOBAL_HACK_DIR_NAME,
      GLOBAL_CADDY_DIR_NAME,
      GLOBAL_CADDY_COMPOSE_FILENAME
    );
    const loggingCompose = join(
      tempDir!,
      GLOBAL_HACK_DIR_NAME,
      GLOBAL_LOGGING_DIR_NAME,
      GLOBAL_LOGGING_COMPOSE_FILENAME
    );
    await writeComposeFile(caddyCompose);
    await writeComposeFile(loggingCompose);
    process.env[key] = value;

    const stderrLines: string[] = [];
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(
      (chunk: string | Uint8Array) => {
        stderrLines.push(String(chunk));
        return true;
      }
    );
    let code: number;
    try {
      const { runCli } = await import("../src/cli/run.ts");
      code = await runCli(["global", "up"]);
    } finally {
      stderrSpy.mockRestore();
    }

    expect(code).toBe(0);
    expect(runCalls.filter((call) => call.includes("daemon"))).toEqual([]);
    const skip = stderrLines.filter((line) =>
      line.includes("Skipping hackd start")
    );
    expect(skip).toHaveLength(1);
    expect(skip[0]).toContain(reason);
    expect(
      stderrLines.some((line) => line.includes("Ensuring hackd is running"))
    ).toBe(false);
    expect(
      runCalls.some(
        (call) => call.includes(caddyCompose) && call.includes("up")
      )
    ).toBe(true);
    expect(
      runCalls.some(
        (call) => call.includes(loggingCompose) && call.includes("up")
      )
    ).toBe(true);
  },
  { timeout: 20_000 }
);

/**
 * Runs the macOS `global install` launchd offer non-interactively (which
 * accepts it) with launchd access allowed: HOME is the temp dir, so no plist
 * exists and no launchctl runs. `run` is mocked, so nothing is spawned.
 */
async function runLaunchdInstallOffer(
  env: Readonly<Record<string, string>>
): Promise<string[]> {
  const keys = [
    "HACK_NO_INTERACTIVE",
    "HACK_HOME",
    "HACK_LAUNCHD_DISABLE",
    ...Object.keys(env),
  ];
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  Reflect.deleteProperty(process.env, "HACK_HOME");
  Reflect.deleteProperty(process.env, "HACK_LAUNCHD_DISABLE");
  process.env.HACK_NO_INTERACTIVE = "1";
  Object.assign(process.env, env);
  const stderrLines: string[] = [];
  const stderrSpy = spyOn(process.stderr, "write").mockImplementation(
    (chunk: string | Uint8Array) => {
      stderrLines.push(String(chunk));
      return true;
    }
  );
  try {
    const { maybeOfferMacHackdLaunchdInstall } = await import(
      "../src/commands/global.ts"
    );
    await maybeOfferMacHackdLaunchdInstall();
  } finally {
    stderrSpy.mockRestore();
    for (const [key, value] of saved) {
      restoreEnv(key, value);
    }
  }
  return stderrLines;
}

test("global install offers `hack daemon install` when autostart is allowed", async () => {
  const lines = await runLaunchdInstallOffer({});

  const daemonCalls = runCalls.filter((call) => call.includes("daemon"));
  expect(daemonCalls).toHaveLength(1);
  expect(daemonCalls[0]?.slice(-2)).toEqual(["daemon", "install"]);
  expect(
    lines.some((line) => line.includes("Skipping hackd launchd setup"))
  ).toBe(false);
});

test.each([
  {
    label: "a candidate run",
    key: "HACK_CANDIDATE_ENTRYPOINT",
    value: "hack-next",
    reason: "candidate run",
  },
  {
    label: "the autostart opt-out",
    key: "HACK_DAEMON_AUTOSTART_DISABLE",
    value: "1",
    reason: "HACK_DAEMON_AUTOSTART_DISABLE=1",
  },
])("global install never runs `hack daemon install` under $label (HACK-1368)", async ({
  key,
  value,
  reason,
}) => {
  const lines = await runLaunchdInstallOffer({ [key]: value });

  expect(runCalls.filter((call) => call.includes("daemon"))).toEqual([]);
  const skip = lines.filter((line) =>
    line.includes("Skipping hackd launchd setup")
  );
  expect(skip).toHaveLength(1);
  expect(skip[0]).toContain(reason);
});

test(
  "global up reassigns containers when reserved ingress IPs are occupied",
  async () => {
    const caddyCompose = join(
      tempDir!,
      GLOBAL_HACK_DIR_NAME,
      GLOBAL_CADDY_DIR_NAME,
      GLOBAL_CADDY_COMPOSE_FILENAME
    );
    const loggingCompose = join(
      tempDir!,
      GLOBAL_HACK_DIR_NAME,
      GLOBAL_LOGGING_DIR_NAME,
      GLOBAL_LOGGING_COMPOSE_FILENAME
    );
    await writeStaticCaddyCompose(caddyCompose);
    await writeComposeFile(loggingCompose);

    let inspectCallCount = 0;
    execMockResponder = (cmd) => {
      if (
        cmd[0] === "docker" &&
        cmd[1] === "network" &&
        cmd[2] === "inspect" &&
        cmd[3] === DEFAULT_INGRESS_NETWORK
      ) {
        inspectCallCount += 1;
        if (inspectCallCount === 1) {
          return {
            exitCode: 0,
            stdout: JSON.stringify([
              {
                Containers: {
                  abc123: {
                    Name: "example-temporal-server-1",
                    IPv4Address: `${DEFAULT_CADDY_IP}/16`,
                  },
                },
              },
            ]),
            stderr: "",
          };
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify([{ Containers: {} }]),
          stderr: "",
        };
      }

      return null;
    };

    const { runCli } = await import("../src/cli/run.ts");
    const code = await runCli(["global", "up"]);
    expect(code).toBe(0);

    expect(
      execCalls.some(
        (call) =>
          call.join(" ") ===
          `docker network disconnect -f ${DEFAULT_INGRESS_NETWORK} example-temporal-server-1`
      )
    ).toBe(true);
    expect(
      execCalls.some(
        (call) =>
          call.join(" ") ===
          `docker network connect ${DEFAULT_INGRESS_NETWORK} example-temporal-server-1`
      )
    ).toBe(true);
    expect(
      runCalls.some(
        (call) => call.includes(caddyCompose) && call.includes("up")
      )
    ).toBe(true);
  },
  { timeout: 20_000 }
);

test(
  "global install writes compose files and starts stacks",
  async () => {
    const gumPath = join(tempDir!, GLOBAL_HACK_DIR_NAME, "bin", "gum");
    const mutagenPath = join(tempDir!, GLOBAL_HACK_DIR_NAME, "bin", "mutagen");
    const mutagenAgentBundlePath = join(
      tempDir!,
      GLOBAL_HACK_DIR_NAME,
      "libexec",
      "mutagen-agents.tar.gz"
    );
    await writeExecutable(gumPath);
    await writeExecutable(mutagenPath);
    await mkdir(dirname(mutagenAgentBundlePath), { recursive: true });
    await writeFile(mutagenAgentBundlePath, "stub");
    const { runCli } = await import("../src/cli/run.ts");
    const code = await runCli(["global", "install"]);
    expect(code).toBe(0);

    const caddyCompose = join(
      tempDir!,
      GLOBAL_HACK_DIR_NAME,
      GLOBAL_CADDY_DIR_NAME,
      GLOBAL_CADDY_COMPOSE_FILENAME
    );
    const loggingCompose = join(
      tempDir!,
      GLOBAL_HACK_DIR_NAME,
      GLOBAL_LOGGING_DIR_NAME,
      GLOBAL_LOGGING_COMPOSE_FILENAME
    );
    const hasCaddy = await Bun.file(caddyCompose).exists();
    const hasLogging = await Bun.file(loggingCompose).exists();
    const managedEnvSchema = join(
      tempDir!,
      GLOBAL_HACK_DIR_NAME,
      GLOBAL_SCHEMAS_DIR_NAME,
      GLOBAL_MANAGED_ENV_SCHEMA_FILENAME
    );
    const hasManagedEnvSchema = await Bun.file(managedEnvSchema).exists();

    expect(hasCaddy).toBe(true);
    expect(hasLogging).toBe(true);
    expect(hasManagedEnvSchema).toBe(true);
    expect(
      runCalls.some(
        (call) => call.includes(caddyCompose) && call.includes("up")
      )
    ).toBe(true);
    expect(
      runCalls.some(
        (call) => call.includes(loggingCompose) && call.includes("up")
      )
    ).toBe(true);
  },
  { timeout: 20_000 }
);

test("global down runs docker compose down when files exist", async () => {
  const caddyCompose = join(
    tempDir!,
    GLOBAL_HACK_DIR_NAME,
    GLOBAL_CADDY_DIR_NAME,
    GLOBAL_CADDY_COMPOSE_FILENAME
  );
  const loggingCompose = join(
    tempDir!,
    GLOBAL_HACK_DIR_NAME,
    GLOBAL_LOGGING_DIR_NAME,
    GLOBAL_LOGGING_COMPOSE_FILENAME
  );
  await writeComposeFile(caddyCompose);
  await writeComposeFile(loggingCompose);

  const { runCli } = await import("../src/cli/run.ts");
  const code = await runCli(["global", "down"]);
  expect(code).toBe(0);
  expect(
    runCalls.some(
      (call) => call.includes(caddyCompose) && call.includes("down")
    )
  ).toBe(true);
  expect(
    runCalls.some(
      (call) => call.includes(loggingCompose) && call.includes("down")
    )
  ).toBe(true);
});

test("global down keeps the logging stack's named volumes", async () => {
  // HACK-1379: Alloy's read positions live in the `alloy-data` volume (next to
  // `loki-data` and `grafana-data`). A plain `docker compose down` keeps named
  // volumes; only `hack global logs-reset` passes `-v`. A `down` here that
  // removed volumes would make every `global down`/`up` re-read all retained
  // container logs into a wiped Loki.
  const caddyCompose = join(
    tempDir!,
    GLOBAL_HACK_DIR_NAME,
    GLOBAL_CADDY_DIR_NAME,
    GLOBAL_CADDY_COMPOSE_FILENAME
  );
  const loggingCompose = join(
    tempDir!,
    GLOBAL_HACK_DIR_NAME,
    GLOBAL_LOGGING_DIR_NAME,
    GLOBAL_LOGGING_COMPOSE_FILENAME
  );
  await writeComposeFile(caddyCompose);
  await writeComposeFile(loggingCompose);

  const { runCli } = await import("../src/cli/run.ts");
  expect(await runCli(["global", "down"])).toBe(0);
  const loggingDown = runCalls.filter(
    (call) => call.includes(loggingCompose) && call.includes("down")
  );
  expect(loggingDown).toHaveLength(1);
  expect(loggingDown[0]).toEqual([
    "docker",
    "compose",
    "-f",
    loggingCompose,
    "down",
  ]);
  for (const call of loggingDown) {
    expect(call).not.toContain("-v");
    expect(call).not.toContain("--volumes");
  }

  runCalls.length = 0;
  expect(await runCli(["global", "up"])).toBe(0);
  const loggingUp = runCalls.filter(
    (call) => call.includes(loggingCompose) && call.includes("up")
  );
  expect(loggingUp).toHaveLength(1);
  for (const call of loggingUp) {
    expect(call).not.toContain("-V");
    expect(call).not.toContain("--renew-anon-volumes");
  }
});

test("global up fails when compose files are missing", async () => {
  const { runCli } = await import("../src/cli/run.ts");
  const code = await runCli(["global", "up"]);
  expect(code).toBe(1);
});

test("global status --json returns summary payload", async () => {
  const caddyCompose = join(
    tempDir!,
    GLOBAL_HACK_DIR_NAME,
    GLOBAL_CADDY_DIR_NAME,
    GLOBAL_CADDY_COMPOSE_FILENAME
  );
  const loggingCompose = join(
    tempDir!,
    GLOBAL_HACK_DIR_NAME,
    GLOBAL_LOGGING_DIR_NAME,
    GLOBAL_LOGGING_COMPOSE_FILENAME
  );
  await writeComposeFile(caddyCompose);
  await writeComposeFile(loggingCompose);

  execMockResponder = (cmd) => {
    if (cmd[0] === "docker" && cmd[1] === "compose" && cmd.includes("ps")) {
      const service = cmd.includes(caddyCompose) ? "caddy" : "loki";
      const stdout = `${JSON.stringify({
        Service: service,
        Name: `${service}-1`,
        Status: "running",
        Ports: "80->80/tcp",
      })}\n`;
      return { exitCode: 0, stdout, stderr: "" };
    }

    if (cmd[0] === "docker" && cmd[1] === "network" && cmd[2] === "ls") {
      const stdout = [
        JSON.stringify({
          Name: DEFAULT_INGRESS_NETWORK,
          ID: "net-1",
          Driver: "bridge",
          Scope: "local",
        }),
        JSON.stringify({
          Name: DEFAULT_LOGGING_NETWORK,
          ID: "net-2",
          Driver: "bridge",
          Scope: "local",
        }),
      ].join("\n");
      return { exitCode: 0, stdout, stderr: "" };
    }

    return null;
  };

  let output = "";
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output +=
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;

  try {
    const { runCli } = await import("../src/cli/run.ts");
    const code = await runCli(["global", "status", "--json"]);
    expect(code).toBe(0);
  } finally {
    process.stdout.write = originalWrite;
  }

  const parsed = JSON.parse(output.trim()) as {
    summary: {
      ok: boolean;
      caddy_ok: boolean;
      logging_ok: boolean;
      networks_ok: boolean;
    };
  };

  expect(parsed.summary.ok).toBe(true);
  expect(parsed.summary.caddy_ok).toBe(true);
  expect(parsed.summary.logging_ok).toBe(true);
  expect(parsed.summary.networks_ok).toBe(true);
});

test(
  "global up recreates a proxy that runs with no network while a project holds its IP (HACK-2056)",
  async () => {
    const caddyCompose = join(
      tempDir!,
      GLOBAL_HACK_DIR_NAME,
      GLOBAL_CADDY_DIR_NAME,
      GLOBAL_CADDY_COMPOSE_FILENAME
    );
    await writeStaticCaddyCompose(caddyCompose);
    await writeComposeFile(
      join(
        tempDir!,
        GLOBAL_HACK_DIR_NAME,
        GLOBAL_LOGGING_DIR_NAME,
        GLOBAL_LOGGING_COMPOSE_FILENAME
      )
    );

    // Fake Docker: caddy reports Up but is attached to no network, and a
    // project container holds caddy's reserved address. The proxy is only
    // reattached once the stack is taken down and brought up again.
    let proxyDown = false;
    let proxyUpAfterDown = false;
    let projectReassigned = false;
    const proxyInspect = () =>
      JSON.stringify([
        {
          Name: "/hack-dev-proxy-caddy-1",
          Config: { Labels: { "com.docker.compose.service": "caddy" } },
          State: { Running: true },
          NetworkSettings: {
            Networks: proxyUpAfterDown
              ? { [DEFAULT_INGRESS_NETWORK]: { IPAddress: DEFAULT_CADDY_IP } }
              : {},
          },
        },
      ]);
    execMockResponder = (cmd) => {
      const line = cmd.join(" ");
      if (line.includes(caddyCompose) && line.includes("ps --format json")) {
        return proxyDown && !proxyUpAfterDown
          ? { exitCode: 0, stdout: "", stderr: "" }
          : {
              exitCode: 0,
              stdout: `${JSON.stringify({ ID: "caddy1", Service: "caddy" })}\n`,
              stderr: "",
            };
      }
      if (line === "docker inspect caddy1") {
        return { exitCode: 0, stdout: proxyInspect(), stderr: "" };
      }
      if (line === `docker network inspect ${DEFAULT_INGRESS_NETWORK}`) {
        return {
          exitCode: 0,
          stdout: JSON.stringify([
            {
              Containers: projectReassigned
                ? {}
                : {
                    abc: {
                      Name: "example-web-1",
                      IPv4Address: `${DEFAULT_CADDY_IP}/16`,
                    },
                  },
            },
          ]),
          stderr: "",
        };
      }
      if (line.startsWith("docker network connect")) {
        projectReassigned = true;
      }
      return null;
    };
    runExitResponder = (cmd) => {
      if (cmd.includes(caddyCompose) && cmd.includes("down")) {
        proxyDown = true;
      }
      if (cmd.includes(caddyCompose) && cmd.includes("up") && proxyDown) {
        proxyUpAfterDown = true;
      }
      return null;
    };

    const { runCli } = await import("../src/cli/run.ts");
    expect(await runCli(["global", "up"])).toBe(0);

    const downIndex = runCalls.findIndex(
      (call) => call.includes(caddyCompose) && call.includes("down")
    );
    const upIndex = runCalls.findIndex(
      (call) => call.includes(caddyCompose) && call.includes("up")
    );
    expect(downIndex).toBeGreaterThanOrEqual(0);
    expect(upIndex).toBeGreaterThan(downIndex);
    expect(projectReassigned).toBe(true);
  },
  { timeout: 20_000 }
);

test("global status --json reports a proxy with no network (HACK-2056)", async () => {
  const caddyCompose = join(
    tempDir!,
    GLOBAL_HACK_DIR_NAME,
    GLOBAL_CADDY_DIR_NAME,
    GLOBAL_CADDY_COMPOSE_FILENAME
  );
  await writeStaticCaddyCompose(caddyCompose);
  execMockResponder = (cmd) => {
    const line = cmd.join(" ");
    if (line.includes(caddyCompose) && line.includes("ps --format json")) {
      return {
        exitCode: 0,
        stdout: `${JSON.stringify({ ID: "caddy1", Service: "caddy", Status: "Up 2 hours" })}\n`,
        stderr: "",
      };
    }
    if (line === "docker inspect caddy1") {
      return {
        exitCode: 0,
        stdout: JSON.stringify([
          {
            Name: "/hack-dev-proxy-caddy-1",
            Config: { Labels: { "com.docker.compose.service": "caddy" } },
            State: { Running: true },
            NetworkSettings: { Networks: {} },
          },
        ]),
        stderr: "",
      };
    }
    return null;
  };
  const chunks: string[] = [];
  const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(
    (chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }
  );
  try {
    const { runCli } = await import("../src/cli/run.ts");
    expect(await runCli(["global", "status", "--json"])).toBe(0);
  } finally {
    stdoutSpy.mockRestore();
  }
  const payload = JSON.parse(chunks.join(""));
  expect(payload.summary.proxy_network_ok).toBe(false);
  expect(payload.summary.ok).toBe(false);
  expect(payload.proxy_network.issues[0]).toMatchObject({
    service: "caddy",
    problem: "no_network",
    expected_ip: DEFAULT_CADDY_IP,
  });
});

async function writeInstallStubs(): Promise<void> {
  await writeExecutable(join(tempDir!, GLOBAL_HACK_DIR_NAME, "bin", "gum"));
  await writeExecutable(join(tempDir!, GLOBAL_HACK_DIR_NAME, "bin", "mutagen"));
  const bundle = join(
    tempDir!,
    GLOBAL_HACK_DIR_NAME,
    "libexec",
    "mutagen-agents.tar.gz"
  );
  await mkdir(dirname(bundle), { recursive: true });
  await writeFile(bundle, "stub");
}

test.skipIf(process.platform !== "linux")(
  "install plans the same privileged Docker startup the real command runs",
  async () => {
    await writeInstallStubs();
    process.env.HACK_DAEMON_AUTOSTART_DISABLE = "1";
    let dockerStarted = false;
    execMockResponder = (argv) => {
      if (
        argv[0] === "docker" &&
        (argv[1] === "info" || argv[1] === "network")
      ) {
        return { exitCode: dockerStarted ? 0 : 1, stdout: "", stderr: "" };
      }
      return null;
    };
    runExitResponder = (argv) => {
      if (argv[0] === "sudo") {
        expect(argv).toEqual(["sudo", "systemctl", "start", "docker"]);
        dockerStarted = true;
      }
      return 0;
    };
    const chunks: string[] = [];
    const stdout = spyOn(process.stdout, "write").mockImplementation(
      (chunk) => {
        chunks.push(String(chunk));
        return true;
      }
    );
    const { runCli } = await import("../src/cli/run.ts");
    try {
      expect(await runCli(["global", "install", "--plan", "--json"])).toBe(3);
    } finally {
      stdout.mockRestore();
    }
    expect(dockerStarted).toBe(false);
    expect(runCalls).toEqual([]);
    const planned: unknown = machineError(chunks.join(""), "E_PLAN_INCOMPLETE")
      .detail.plan;
    expect(planned).toMatchObject({
      steps: expect.arrayContaining([
        expect.objectContaining({
          id: "docker-start",
          privilege: "root",
          argv: ["sudo", "systemctl", "start", "docker"],
          shell: "sudo systemctl start docker",
        }),
      ]),
    });
    expect(await runCli(["global", "install"])).toBe(0);
    expect(runCalls.filter((argv) => argv[0] === "sudo")).toEqual([
      ["sudo", "systemctl", "start", "docker"],
    ]);
  }
);

test(
  "global install renders the proxy ports from proxy.bind_address (HACK-2055)",
  async () => {
    await writeInstallStubs();
    const configPath = resolveGlobalConfigPath();
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      `${JSON.stringify({ proxy: { bind_address: "127.0.0.1" } })}\n`
    );
    const { runCli } = await import("../src/cli/run.ts");
    expect(await runCli(["global", "install"])).toBe(0);
    const compose = await Bun.file(
      join(
        tempDir!,
        GLOBAL_HACK_DIR_NAME,
        GLOBAL_CADDY_DIR_NAME,
        GLOBAL_CADDY_COMPOSE_FILENAME
      )
    ).text();
    expect(compose).toContain('      - "127.0.0.1:80:80"');
    expect(compose).toContain('      - "127.0.0.1:443:443"');
  },
  { timeout: 20_000 }
);

test("global up names the listener holding :443 when the proxy cannot start (HACK-2055)", async () => {
  const caddyCompose = join(
    tempDir!,
    GLOBAL_HACK_DIR_NAME,
    GLOBAL_CADDY_DIR_NAME,
    GLOBAL_CADDY_COMPOSE_FILENAME
  );
  await writeComposeFile(caddyCompose);
  await writeComposeFile(
    join(
      tempDir!,
      GLOBAL_HACK_DIR_NAME,
      GLOBAL_LOGGING_DIR_NAME,
      GLOBAL_LOGGING_COMPOSE_FILENAME
    )
  );
  runExitResponder = (cmd) =>
    cmd.includes(caddyCompose) && cmd.includes("up") ? 1 : null;
  execMockResponder = (cmd) =>
    cmd[0] === "ss"
      ? {
          exitCode: 0,
          stdout:
            'LISTEN 0 4096 10.8.0.2:443 0.0.0.0:* users:(("vpn-client",pid=4242,fd=7))\n',
          stderr: "",
        }
      : null;
  const errors: string[] = [];
  const errorSpy = spyOn(process.stderr, "write").mockImplementation(
    (chunk: string | Uint8Array) => {
      errors.push(String(chunk));
      return true;
    }
  );
  try {
    const { runCli } = await import("../src/cli/run.ts");
    expect(await runCli(["global", "up"])).toBe(1);
  } finally {
    errorSpy.mockRestore();
  }
  const text = errors.join("\n");
  expect(text).toContain("10.8.0.2:443 vpn-client (pid 4242)");
  expect(text).toContain("proxy.bind_address");
});

test(
  "non-interactive global install on Linux never runs sudo for DNS (HACK-2053)",
  async () => {
    if (process.platform !== "linux") {
      return;
    }
    await writeInstallStubs();
    fakeLinuxResolvedActive = true;
    const saved = process.env.HACK_NO_INTERACTIVE;
    process.env.HACK_NO_INTERACTIVE = "1";
    try {
      const { runCli } = await import("../src/cli/run.ts");
      expect(await runCli(["global", "install"])).toBe(0);
    } finally {
      restoreEnv("HACK_NO_INTERACTIVE", saved);
    }
    expect(linuxDnsPrivileged).toEqual([]);
    expect(runCalls.some((call) => call[0] === "sudo")).toBe(false);
  },
  { timeout: 20_000 }
);
