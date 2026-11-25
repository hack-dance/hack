import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { readFileSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
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
import { resetStdoutReservationForTests } from "../src/lib/machine-stdout.ts";
import {
  renderGlobalCaddyCompose,
  renderGlobalLoggingCompose,
} from "../src/templates.ts";
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
/** Where each `run` call sent the child's stdout. */
const runStdoutTargets: string[] = [];
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
      // The route probe's HTTPS request through the proxy: any status
      // means the route answered (src/lib/global-route-probe.ts).
      if (cmd.includes("--resolve")) {
        return { exitCode: 0, stdout: "404", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    execOrThrow: async (cmd: readonly string[]) => {
      execCalls.push([...cmd]);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    run: async (
      cmd: readonly string[],
      opts?: { readonly stdout?: string }
    ) => {
      runCalls.push([...cmd]);
      runStdoutTargets.push(opts?.stdout ?? "inherit");
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

// The route probe's Docker and TLS reads (src/lib/global-route-checks.ts).
// Unset responders answer as Docker does under the shell mock above: the
// proxy's runtime and addresses cannot be read, so both steps are reported
// as not checked and `up` does not wait on them.
type ProxyRuntimeAnswer = {
  readonly caPem: string | null;
  readonly loopbackPorts: Readonly<Record<80 | 443, readonly string[]>> | null;
};
let proxyRuntimeAnswer: ProxyRuntimeAnswer | null = null;
let caddyAddressesAnswer: string[] | null = null;
let httpsStateAnswer: ((address: string) => string) | null = null;
/** What the OS resolver answers for the selected name (none by default). */
let systemAddressesAnswer: readonly string[] = [];
const httpsProbeCalls: string[][] = [];
/** The name each HTTPS look asked for (TLS name and Host). */
const httpsProbeNames: string[] = [];
const routeChecksMock = await registerScopedModuleMock({
  importerPath: import.meta.path,
  specifier: "../src/lib/global-route-checks.ts",
  overrides: {
    readProxyRuntime: async () =>
      proxyRuntimeAnswer ?? { caPem: null, loopbackPorts: null },
    readCaddyAddresses: async () => caddyAddressesAnswer,
    resolveSystemAddresses: async () => systemAddressesAnswer,
    probeProxyHttpsAt: async (opts: {
      readonly addresses: readonly string[];
      readonly name: string;
    }) => {
      httpsProbeCalls.push([...opts.addresses]);
      httpsProbeNames.push(opts.name);
      return opts.addresses.map((address) => ({
        address,
        state: httpsStateAnswer?.(address) ?? "ok",
      }));
    },
  },
});

beforeAll(() => {
  shellMock.activate();
  osMock.activate();
  linuxDnsHostMock.activate();
  routeChecksMock.activate();
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
  routeChecksMock.deactivate();
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
    await enableLogging();
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

/** Turns the opt-in logging stack on for this home (`logging.enabled`). */
async function enableLogging(): Promise<void> {
  const home = join(tempDir!, GLOBAL_HACK_DIR_NAME);
  await mkdir(home, { recursive: true });
  await writeFile(
    join(home, "hack.config.json"),
    `${JSON.stringify({ logging: { enabled: true } })}\n`
  );
}

/**
 * The install stubs. These install tests cover the logging stack too, so
 * they turn it on; the opt-in default has its own tests below.
 */
async function writeInstallStubs(
  opts: { readonly logging?: boolean } = {}
): Promise<void> {
  if (opts.logging !== false) {
    await enableLogging();
  }
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

function globalCaddyComposePath(): string {
  return join(
    tempDir!,
    GLOBAL_HACK_DIR_NAME,
    GLOBAL_CADDY_DIR_NAME,
    GLOBAL_CADDY_COMPOSE_FILENAME
  );
}

/** Prompts `runNonInteractiveInstall` saw for the logging Compose file. */
const loggingComposePrompts: string[] = [];

/** Runs `hack global install` with no terminal, capturing stdout and stderr. */
async function runNonInteractiveInstall(
  opts: {
    /** Leave HACK_NO_INTERACTIVE unset, so a prompt is a real question. */
    readonly interactive?: boolean;
    /** The answer to "Overwrite existing file?" (default: no). */
    readonly overwrite?: boolean;
  } = {}
): Promise<{
  readonly code: number;
  readonly output: string;
}> {
  const overwrite = opts.overwrite === true;
  const saved = process.env.HACK_NO_INTERACTIVE;
  if (opts.interactive === true) {
    Reflect.deleteProperty(process.env, "HACK_NO_INTERACTIVE");
  } else {
    process.env.HACK_NO_INTERACTIVE = "1";
  }
  process.env.HACK_DAEMON_AUTOSTART_DISABLE = "1";
  const chunks: string[] = [];
  const capture = (chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  };
  const stdout = spyOn(process.stdout, "write").mockImplementation(capture);
  const stderr = spyOn(process.stderr, "write").mockImplementation(capture);
  // The proxy Compose file is Hack-managed: no run may ask before
  // replacing it. (The logging one asks only when it is not Hack's own.)
  const confirm = spyOn(interactivity, "confirmSafe").mockImplementation(
    async (opts) => {
      if (
        String(opts.message).includes(
          `${GLOBAL_CADDY_DIR_NAME}/${GLOBAL_CADDY_COMPOSE_FILENAME}`
        )
      ) {
        throw new Error("The proxy Compose file must not prompt");
      }
      if (
        String(opts.message).includes(
          `${GLOBAL_LOGGING_DIR_NAME}/${GLOBAL_LOGGING_COMPOSE_FILENAME}`
        )
      ) {
        loggingComposePrompts.push(String(opts.message));
      }
      return overwrite;
    }
  );
  try {
    const { runCli } = await import("../src/cli/run.ts");
    const code = await runCli(["global", "install"]);
    return { code, output: chunks.join("") };
  } finally {
    confirm.mockRestore();
    stderr.mockRestore();
    stdout.mockRestore();
    restoreEnv("HACK_NO_INTERACTIVE", saved);
  }
}

test(
  "global install without a TTY fails, keeps the bind hint and removes a never-started proxy when :443 is taken (HACK-2328)",
  async () => {
    await writeInstallStubs();
    const caddyCompose = globalCaddyComposePath();
    runExitResponder = (cmd) =>
      cmd.includes(caddyCompose) && cmd.includes("up") ? 1 : null;
    execMockResponder = (cmd) => {
      if (cmd[0] === "ss") {
        return {
          exitCode: 0,
          stdout:
            'LISTEN 0 4096 10.8.0.2:443 0.0.0.0:* users:(("vpn-client",pid=4242,fd=7))\n',
          stderr: "",
        };
      }
      if (
        cmd[0] === "docker" &&
        cmd[1] === "ps" &&
        cmd.includes("status=created")
      ) {
        return { exitCode: 0, stdout: "0123456789ab\n", stderr: "" };
      }
      return null;
    };

    const { code, output } = await runNonInteractiveInstall();

    expect(code).not.toBe(0);
    expect(output).toContain("already in use by");
    expect(output).toContain("10.8.0.2:443 vpn-client (pid 4242)");
    expect(output).toContain("proxy.bind_address");
    expect(output).toContain("Global install did not finish");
    expect(output).not.toContain("Next:");
    expect(output).not.toContain("Linux DNS");
    expect(
      execCalls.some(
        (cmd) =>
          cmd[0] === "docker" &&
          cmd[1] === "ps" &&
          cmd.includes("label=com.docker.compose.project=hack-dev-proxy")
      )
    ).toBe(true);
    expect(execCalls).toContainEqual(["docker", "rm", "0123456789ab"]);
    expect(linuxDnsPrivileged).toEqual([]);
  },
  { timeout: 20_000 }
);

/** A Docker CLI without the Compose v2 plugin, as on a fresh Linux host. */
const NO_COMPOSE_PLUGIN = {
  exitCode: 1,
  stdout: "",
  stderr: "docker: 'compose' is not a docker command.\nSee 'docker --help'\n",
} as const;

function isComposeVersion(cmd: readonly string[]): boolean {
  return cmd[0] === "docker" && cmd[1] === "compose" && cmd[2] === "version";
}

function composeUpRuns(): string[][] {
  return runCalls.filter(
    (cmd) => cmd.includes("compose") && cmd.includes("up")
  );
}

test(
  "global install without the Compose plugin names it with a stable code, not ports 80/443 (HACK-2673)",
  async () => {
    await writeInstallStubs();
    execMockResponder = (cmd) =>
      isComposeVersion(cmd) ? NO_COMPOSE_PLUGIN : null;

    const { code, output } = await runNonInteractiveInstall();

    expect(code).not.toBe(0);
    expect(output).toContain("E_DOCKER_UNAVAILABLE");
    expect(output).toContain("Docker Compose v2 plugin");
    expect(output).toContain("docker-compose-plugin");
    expect(output).not.toContain("could not start on ports");
    expect(output).not.toContain("proxy.bind_address");
    expect(output).not.toContain("Next:");
    // Refused once Docker answered: no network, no proxy start, no host DNS.
    expect(execCalls.some(isComposeVersion)).toBe(true);
    expect(
      execCalls.some((cmd) => cmd[0] === "docker" && cmd[1] === "network")
    ).toBe(false);
    expect(composeUpRuns()).toEqual([]);
    expect(linuxDnsPrivileged).toEqual([]);
  },
  { timeout: 20_000 }
);

test("global up --json without the Compose plugin fails routing with E_DOCKER_UNAVAILABLE before Compose runs (HACK-2673)", async () => {
  const caddyCompose = globalCaddyComposePath();
  await writeComposeFile(caddyCompose);
  execMockResponder = (cmd) =>
    isComposeVersion(cmd) ? NO_COMPOSE_PLUGIN : null;
  process.env.HACK_DAEMON_AUTOSTART_DISABLE = "1";
  const out: string[] = [];
  const stdout = spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    const { runCli } = await import("../src/cli/run.ts");
    expect(await runCli(["global", "up", "--json"])).toBe(1);
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
    resetStdoutReservationForTests();
  }
  const error = machineError(out.join(""), "E_DOCKER_UNAVAILABLE");
  expect(error.message).toContain("Docker Compose v2 plugin");
  expect(error.detail).toMatchObject({ failedStage: "routing" });
  expect(composeUpRuns()).toEqual([]);
});

test(
  "global install whose proxy start fails for another reason does not blame ports 80/443 (HACK-2673)",
  async () => {
    await writeInstallStubs();
    const caddyCompose = globalCaddyComposePath();
    // Compose failed before it created the proxy container (a pull or
    // network error, say): no never-started caddy, so no failed publish.
    runExitResponder = (cmd) =>
      cmd.includes(caddyCompose) && cmd.includes("up") ? 1 : null;

    const { code, output } = await runNonInteractiveInstall();

    expect(code).not.toBe(0);
    expect(output).toContain("did not report a problem with ports 80 or 443");
    expect(output).not.toContain("could not start on ports");
    expect(output).not.toContain("proxy.bind_address");
    expect(output).toContain("Global install did not finish");
  },
  { timeout: 20_000 }
);

test(
  "global install keeps the port hint when Docker recorded a failed publish on the never-started proxy (HACK-2673)",
  async () => {
    await writeInstallStubs();
    const caddyCompose = globalCaddyComposePath();
    runExitResponder = (cmd) =>
      cmd.includes(caddyCompose) && cmd.includes("up") ? 1 : null;
    execMockResponder = (cmd) => {
      if (
        cmd[0] === "docker" &&
        cmd[1] === "ps" &&
        cmd.includes("status=created")
      ) {
        return { exitCode: 0, stdout: "0123456789ab\n", stderr: "" };
      }
      if (
        cmd[0] === "docker" &&
        cmd[1] === "inspect" &&
        cmd.includes("{{.State.Error}}")
      ) {
        return {
          exitCode: 0,
          stdout:
            "driver failed programming external connectivity on endpoint hack-dev-proxy-caddy-1: Bind for 0.0.0.0:443 failed: port is already allocated\n",
          stderr: "",
        };
      }
      return null;
    };

    const { code, output } = await runNonInteractiveInstall();

    expect(code).not.toBe(0);
    expect(output).toContain("could not start on ports 80 and 443");
    expect(output).toContain("proxy.bind_address");
    // The start error was read before the container was removed.
    const inspect = execCalls.findIndex(
      (cmd) => cmd[1] === "inspect" && cmd.includes("{{.State.Error}}")
    );
    const removal = execCalls.findIndex(
      (cmd) => cmd[1] === "rm" && cmd.includes("0123456789ab")
    );
    expect(inspect).toBeGreaterThanOrEqual(0);
    expect(removal).toBeGreaterThan(inspect);
  },
  { timeout: 20_000 }
);

test(
  "global install without a TTY applies a new proxy.bind_address to the existing proxy file (HACK-2328)",
  async () => {
    await writeInstallStubs();
    // First install: default bind, all interfaces.
    expect((await runNonInteractiveInstall()).code).toBe(0);
    const caddyCompose = globalCaddyComposePath();
    expect(await Bun.file(caddyCompose).text()).toContain('      - "443:443"');

    const configPath = resolveGlobalConfigPath();
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      `${JSON.stringify({ proxy: { bind_address: "127.0.0.1" } })}\n`
    );
    const { code, output } = await runNonInteractiveInstall();

    expect(code).toBe(0);
    expect(output).toContain("Next:");
    const compose = await Bun.file(caddyCompose).text();
    expect(compose).toContain('      - "127.0.0.1:80:80"');
    expect(compose).toContain('      - "127.0.0.1:443:443"');
    // A file Hack rendered is replaced without a backup.
    const { readdir } = await import("node:fs/promises");
    expect(
      (await readdir(dirname(caddyCompose))).filter((name) =>
        name.includes(".bak-")
      )
    ).toEqual([]);
  },
  { timeout: 20_000 }
);

test(
  "global install keeps a backup of a hand-edited proxy file it replaces (HACK-2328)",
  async () => {
    await writeInstallStubs();
    const caddyCompose = globalCaddyComposePath();
    await mkdir(dirname(caddyCompose), { recursive: true });
    const handEdited =
      'services:\n  caddy:\n    image: my/caddy\n    ports:\n      - "443:443"\n';
    await writeFile(caddyCompose, handEdited);

    const { code, output } = await runNonInteractiveInstall();

    expect(code).toBe(0);
    expect(output).toContain("differed from Hack's current rendering");
    const { readdir } = await import("node:fs/promises");
    const backups = (await readdir(dirname(caddyCompose))).filter((name) =>
      name.startsWith(`${GLOBAL_CADDY_COMPOSE_FILENAME}.bak-`)
    );
    expect(backups).toHaveLength(1);
    expect(
      await Bun.file(join(dirname(caddyCompose), backups[0]!)).text()
    ).toBe(handEdited);
    expect(await Bun.file(caddyCompose).text()).toContain("caddy-docker-proxy");
  },
  { timeout: 20_000 }
);

const VPN_LISTENER = {
  exitCode: 0,
  stdout:
    'LISTEN 0 4096 10.8.0.2:443 0.0.0.0:* users:(("vpn-client",pid=4242,fd=7))\n',
  stderr: "",
};

test(
  "global install fails while :443 is taken, then succeeds once proxy.bind_address is set (HACK-2328)",
  async () => {
    await writeInstallStubs();
    const caddyCompose = globalCaddyComposePath();
    // Compose fails to publish on every interface, as Docker does when
    // another address already holds :443; the loopback bind starts.
    runExitResponder = (cmd) => {
      if (!(cmd.includes(caddyCompose) && cmd.includes("up"))) {
        return null;
      }
      const text = readFileSync(caddyCompose, "utf8");
      return text.includes('"127.0.0.1:443:443"') ? 0 : 1;
    };
    execMockResponder = (cmd) => (cmd[0] === "ss" ? VPN_LISTENER : null);

    const failed = await runNonInteractiveInstall();
    expect(failed.code).not.toBe(0);
    expect(failed.output).toContain(
      "hack config set --global proxy.bind_address"
    );
    expect(failed.output).not.toContain("Next:");

    const configPath = resolveGlobalConfigPath();
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      `${JSON.stringify({ proxy: { bind_address: "127.0.0.1" } })}\n`
    );
    const fixed = await runNonInteractiveInstall();

    expect(fixed.code).toBe(0);
    expect(fixed.output).toContain("Next:");
    const compose = await Bun.file(caddyCompose).text();
    expect(compose).toContain('      - "127.0.0.1:80:80"');
    expect(compose).toContain('      - "127.0.0.1:443:443"');
  },
  { timeout: 20_000 }
);

test(
  "global install sets up host DNS but exits non-zero when only the logging stack fails (HACK-2328)",
  async () => {
    await writeInstallStubs();
    const loggingCompose = join(
      tempDir!,
      GLOBAL_HACK_DIR_NAME,
      GLOBAL_LOGGING_DIR_NAME,
      GLOBAL_LOGGING_COMPOSE_FILENAME
    );
    runExitResponder = (cmd) =>
      cmd.includes(loggingCompose) && cmd.includes("up") ? 1 : null;

    const { code, output } = await runNonInteractiveInstall();

    expect(code).not.toBe(0);
    expect(output).toContain(
      "the logging stack (Grafana, Loki, Alloy) did not start"
    );
    expect(output).not.toContain(
      "the global proxy (Caddy and CoreDNS) did not start"
    );
    expect(output).not.toContain("Next:");
    if (process.platform === "linux") {
      expect(output).toContain("Linux DNS result");
    }
  },
  { timeout: 20_000 }
);

test("never-started proxy cleanup reports listing and removal failures (HACK-2328)", async () => {
  const { removeUnstartedProxyContainers } = await import(
    "../src/lib/managed-proxy-compose.ts"
  );
  const fail = { exitCode: 1, stdout: "", stderr: "boom" };
  execMockResponder = (cmd) =>
    cmd[1] === "ps" ? { exitCode: 0, stdout: "", stderr: "" } : null;
  expect(await removeUnstartedProxyContainers()).toEqual({ kind: "none" });

  execMockResponder = (cmd) => (cmd[1] === "ps" ? fail : null);
  const listing = await removeUnstartedProxyContainers();
  expect(listing.kind).toBe("failed");
  expect(listing.kind === "failed" && listing.message).toContain(
    "docker ps --all"
  );

  execMockResponder = (cmd) =>
    cmd[1] === "ps"
      ? { exitCode: 0, stdout: "0123456789ab\nnot-an-id\n", stderr: "" }
      : cmd[1] === "rm"
        ? fail
        : null;
  const removal = await removeUnstartedProxyContainers();
  expect(removal).toMatchObject({ kind: "failed", ids: ["0123456789ab"] });
  expect(removal.kind === "failed" && removal.message).toContain(
    "docker rm 0123456789ab"
  );
  // Only this project's caddy containers that never started are listed.
  const ps = execCalls.find((cmd) => cmd[1] === "ps") ?? [];
  expect(ps).toContain("label=com.docker.compose.project=hack-dev-proxy");
  expect(ps).toContain("label=com.docker.compose.service=caddy");
  expect(ps).toContain("status=created");
});

test(
  "global install never widens a proxy file restricted to one address while proxy.bind_address is unset (HACK-2328)",
  async () => {
    await writeInstallStubs();
    const caddyCompose = globalCaddyComposePath();
    await mkdir(dirname(caddyCompose), { recursive: true });
    // An older or hand-edited file that publishes on loopback only.
    const { renderGlobalCaddyCompose } = await import("../src/templates.ts");
    await writeFile(
      caddyCompose,
      `${renderGlobalCaddyCompose({ bindAddress: "127.0.0.1" })}# local edit\n`
    );

    const { code, output } = await runNonInteractiveInstall();

    expect(code).toBe(0);
    expect(output).toContain("Kept the proxy on 127.0.0.1");
    const compose = await Bun.file(caddyCompose).text();
    expect(compose).toContain('      - "127.0.0.1:443:443"');
    expect(compose).not.toContain('      - "443:443"');
    const config = JSON.parse(
      await Bun.file(resolveGlobalConfigPath()).text()
    ) as { proxy?: { bind_address?: string } };
    expect(config.proxy?.bind_address).toBe("127.0.0.1");
  },
  { timeout: 20_000 }
);

describe("resolveManagedProxyBind (HACK-2328)", () => {
  async function writeProxyFile(bind: string | null): Promise<string> {
    const path = globalCaddyComposePath();
    await mkdir(dirname(path), { recursive: true });
    const { renderGlobalCaddyCompose } = await import("../src/templates.ts");
    await writeFile(path, renderGlobalCaddyCompose({ bindAddress: bind }));
    return path;
  }

  test("a configured address wins over the file", async () => {
    const path = await writeProxyFile("127.0.0.1");
    const configPath = resolveGlobalConfigPath();
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      `${JSON.stringify({ proxy: { bind_address: "::1" } })}\n`
    );
    const { resolveManagedProxyBind } = await import(
      "../src/lib/managed-proxy-compose.ts"
    );
    expect(await resolveManagedProxyBind({ path })).toEqual({
      bindAddress: "::1",
      migrated: null,
    });
  });

  test.each([
    "0.0.0.0",
    "::",
  ])("a wildcard file (%s) is migrated, never widened to both families", async (bind) => {
    const path = await writeProxyFile(bind);
    const { resolveManagedProxyBind } = await import(
      "../src/lib/managed-proxy-compose.ts"
    );
    expect(await resolveManagedProxyBind({ path })).toEqual({
      bindAddress: bind,
      migrated: bind,
    });
    const config = JSON.parse(
      await Bun.file(resolveGlobalConfigPath()).text()
    ) as { proxy?: { bind_address?: string } };
    expect(config.proxy?.bind_address).toBe(bind);
  });

  test("a binding it cannot determine leaves the file alone", async () => {
    const path = globalCaddyComposePath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      'services:\n  caddy:\n    ports:\n      - "127.0.0.1:80:80"\n      - "443:443"\n'
    );
    const { resolveManagedProxyBind } = await import(
      "../src/lib/managed-proxy-compose.ts"
    );
    const result = await resolveManagedProxyBind({ path });
    expect(result.bindAddress).toBeNull();
    expect(result.keep).toContain("left unchanged");
    expect(await Bun.file(resolveGlobalConfigPath()).exists()).toBe(false);
  });

  test.each([
    [
      "single-quoted with a comment",
      "      - '127.0.0.1:80:80' # loopback\n      - '127.0.0.1:443:443'\n",
    ],
    [
      "long form",
      "      - target: 80\n        published: 80\n        host_ip: 127.0.0.1\n      - target: 443\n        published: 443\n        host_ip: 127.0.0.1\n",
    ],
  ])("a hand-edited %s mapping keeps its address", async (_label, ports) => {
    const path = globalCaddyComposePath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `services:\n  caddy:\n    ports:\n${ports}`);
    const { resolveManagedProxyBind } = await import(
      "../src/lib/managed-proxy-compose.ts"
    );
    expect(await resolveManagedProxyBind({ path })).toEqual({
      bindAddress: "127.0.0.1",
      migrated: "127.0.0.1",
    });
  });

  test("an unsavable config still keeps the restricted address", async () => {
    const path = await writeProxyFile("127.0.0.1");
    const configPath = resolveGlobalConfigPath();
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, "{ not json");
    const { resolveManagedProxyBind } = await import(
      "../src/lib/managed-proxy-compose.ts"
    );
    const result = await resolveManagedProxyBind({ path });
    expect(result.bindAddress).toBe("127.0.0.1");
    expect(result.migrated).toBeNull();
    expect(result.saveError).toBeString();
    expect(await Bun.file(configPath).text()).toBe("{ not json");
  });
});

test(
  "global install leaves a proxy file with an undeterminable binding unchanged (HACK-2328)",
  async () => {
    await writeInstallStubs();
    const caddyCompose = globalCaddyComposePath();
    await mkdir(dirname(caddyCompose), { recursive: true });
    const handEdited =
      'services:\n  caddy:\n    image: my/caddy\n    ports:\n      - "127.0.0.1:80:80"\n      - "10.0.0.5:443:443"\n';
    await writeFile(caddyCompose, handEdited);

    const { output } = await runNonInteractiveInstall();

    expect(output).toContain("Proxy file not updated");
    expect(await Bun.file(caddyCompose).text()).toBe(handEdited);
  },
  { timeout: 20_000 }
);

/** `docker compose ps --all --format json` for one stack, one line per service. */
function composePsLines(
  services: Readonly<Record<string, { state: string; exitCode?: number }>>,
  project: string
): string {
  return Object.entries(services)
    .map(([service, { state, exitCode }]) =>
      JSON.stringify({
        Name: `${project}-${service}-1`,
        Service: service,
        State: state,
        ExitCode: exitCode ?? 0,
      })
    )
    .join("\n");
}

for (const [stage, exited, wanted, unwanted] of [
  [
    "routing",
    "coredns",
    "Global install did not finish: the global proxy (Caddy and CoreDNS) did not start.",
    "the proxy is up, but the logging stack",
  ],
  [
    "logging",
    "grafana",
    "Global install did not finish: the proxy is up, but the logging stack (Grafana, Loki, Alloy) did not start.",
    "the global proxy (Caddy and CoreDNS) did not start",
  ],
] as const) {
  test(
    `global install fails and names the container when a ${stage} container has exited after a successful start (HACK-2381)`,
    async () => {
      await writeInstallStubs();
      const caddyCompose = globalCaddyComposePath();
      execMockResponder = (cmd) => {
        if (
          cmd[0] === "docker" &&
          cmd[1] === "compose" &&
          cmd.includes("ps") &&
          cmd.includes("--all")
        ) {
          const routing = cmd.includes(caddyCompose);
          return {
            exitCode: 0,
            stderr: "",
            stdout: routing
              ? composePsLines(
                  {
                    caddy: { state: "running" },
                    coredns:
                      exited === "coredns"
                        ? { state: "exited", exitCode: 1 }
                        : { state: "running" },
                  },
                  "hack-dev-proxy"
                )
              : composePsLines(
                  {
                    loki: { state: "running" },
                    alloy: { state: "running" },
                    grafana: { state: "exited", exitCode: 1 },
                  },
                  "hack-logging"
                ),
          };
        }
        return null;
      };

      const { code, output } = await runNonInteractiveInstall();

      expect(code).not.toBe(0);
      const container =
        exited === "coredns"
          ? "hack-dev-proxy-coredns-1"
          : "hack-logging-grafana-1";
      expect(output).toContain(`${container} (exited, exit code 1)`);
      expect(output).toContain(`docker logs --tail 50 ${container}`);
      expect(output).toContain(wanted);
      expect(output).not.toContain(unwanted);
      // Compose said the start worked; that is no longer taken as "up".
      expect(output).not.toContain("Global infra is up");
      expect(output).not.toContain("Next:");
    },
    { timeout: 20_000 }
  );
}

test(
  "global install succeeds when every container is still running after the start (HACK-2381)",
  async () => {
    await writeInstallStubs();
    const caddyCompose = globalCaddyComposePath();
    let looks = 0;
    execMockResponder = (cmd) => {
      if (
        cmd[0] === "docker" &&
        cmd[1] === "compose" &&
        cmd.includes("ps") &&
        cmd.includes("--all")
      ) {
        looks++;
        return {
          exitCode: 0,
          stderr: "",
          stdout: cmd.includes(caddyCompose)
            ? composePsLines(
                { caddy: { state: "running" }, coredns: { state: "running" } },
                "hack-dev-proxy"
              )
            : composePsLines(
                {
                  loki: { state: "running" },
                  alloy: { state: "running" },
                  grafana: { state: "running" },
                },
                "hack-logging"
              ),
        };
      }
      return null;
    };

    const { code, output } = await runNonInteractiveInstall();

    expect(code).toBe(0);
    expect(output).toContain("Global infra is up");
    // Both stacks were watched for their whole settle windows, not looked at
    // once: 2 s for the proxy, 10 s for the logging stack, every 500 ms.
    expect(looks).toBeGreaterThanOrEqual(5 + 21);
  },
  { timeout: 40_000 }
);

test(
  "global install writes container-read configs world-readable under a strict umask, repairs tight ones, and keeps the rest private (HACK-2381)",
  async () => {
    await writeInstallStubs();
    const { stat } = await import("node:fs/promises");
    const mode = async (path: string) => (await stat(path)).mode & 0o777;
    const caddyDir = dirname(globalCaddyComposePath());
    const loggingDir = join(
      tempDir!,
      GLOBAL_HACK_DIR_NAME,
      GLOBAL_LOGGING_DIR_NAME
    );
    const readable = {
      [join(caddyDir, "Corefile")]: 0o644,
      [join(loggingDir, "loki.yaml")]: 0o644,
      [join(
        loggingDir,
        "grafana/provisioning/datasources/hack-datasources.yaml"
      )]: 0o644,
      [join(
        loggingDir,
        "grafana/provisioning/dashboards/hack-dashboards.yaml"
      )]: 0o644,
      [join(loggingDir, "grafana/dashboards")]: 0o755,
      [join(loggingDir, "grafana/dashboards/hack-logs.json")]: 0o644,
    };
    const previous = process.umask(0o077);
    try {
      expect((await runNonInteractiveInstall()).code).toBe(0);
      for (const [path, wanted] of Object.entries(readable)) {
        expect([path, await mode(path)]).toEqual([path, wanted]);
      }
      // Everything else keeps what the strict umask gave it: the stack
      // directories, the Compose files, the Alloy config and the schemas.
      for (const [path, wanted] of [
        [caddyDir, 0o700],
        [loggingDir, 0o700],
        [globalCaddyComposePath(), 0o600],
        [join(loggingDir, GLOBAL_LOGGING_COMPOSE_FILENAME), 0o600],
        [join(loggingDir, "alloy.alloy"), 0o600],
        [join(loggingDir, "grafana"), 0o700],
        [join(loggingDir, "grafana/provisioning"), 0o700],
        [join(loggingDir, "grafana/provisioning/datasources"), 0o700],
      ] as const) {
        expect([path, await mode(path)]).toEqual([path, wanted]);
      }

      // Repair: files an earlier run left owner-only are reset by a rerun
      // even though their content did not change.
      for (const [path, wanted] of Object.entries(readable)) {
        await chmod(path, wanted === 0o755 ? 0o700 : 0o600);
      }
      expect((await runNonInteractiveInstall()).code).toBe(0);
      for (const [path, wanted] of Object.entries(readable)) {
        expect([path, await mode(path)]).toEqual([path, wanted]);
      }
    } finally {
      process.umask(previous);
    }
  },
  { timeout: 30_000 }
);

test(
  "global install never widens a customised config: it keeps mode 600 when the overwrite is declined, interactively or not (HACK-2381)",
  async () => {
    await writeInstallStubs();
    const { stat } = await import("node:fs/promises");
    const mode = async (path: string) => (await stat(path)).mode & 0o777;
    const loggingDir = join(
      tempDir!,
      GLOBAL_HACK_DIR_NAME,
      GLOBAL_LOGGING_DIR_NAME
    );
    const datasource = join(
      loggingDir,
      "grafana/provisioning/datasources/hack-datasources.yaml"
    );
    const loki = join(loggingDir, "loki.yaml");
    const previous = process.umask(0o077);
    try {
      expect((await runNonInteractiveInstall()).code).toBe(0);
      const template = readFileSync(datasource, "utf8");
      // The user edits the datasource, adds credentials and keeps it private.
      const custom = `${template}    basicAuth: true\n    secureJsonData:\n      basicAuthPassword: hunter2\n`;
      for (const interactive of [false, true]) {
        await writeFile(datasource, custom);
        await chmod(datasource, 0o600);
        // A template file left tight by an earlier run, for contrast.
        await chmod(loki, 0o600);
        const { code, output } = await runNonInteractiveInstall({
          interactive,
        });
        expect(code).toBe(0);
        // Declined: content kept, and so are its permissions.
        expect(readFileSync(datasource, "utf8")).toBe(custom);
        expect([interactive, await mode(datasource)]).toEqual([
          interactive,
          0o600,
        ]);
        expect(output).toContain(
          "Kept the permissions of global configs whose content differs from what this Hack writes."
        );
        expect(output).toContain(`${datasource} (mode 600)`);
        expect(output).toContain(`chmod 644 ${datasource}`);
        // The template file beside it is still repaired.
        expect(await mode(loki)).toBe(0o644);
      }
      // Approving the overwrite makes it Hack's content again, and readable.
      const approved = await runNonInteractiveInstall({
        interactive: true,
        overwrite: true,
      });
      expect(approved.code).toBe(0);
      expect(readFileSync(datasource, "utf8")).toBe(template);
      expect(await mode(datasource)).toBe(0o644);
      expect(approved.output).not.toContain("Kept the permissions");
    } finally {
      process.umask(previous);
    }
  },
  { timeout: 60_000 }
);

describe("global up's route probe: only Hack's own proxy passes, and what cannot be checked never fails (HACK-2468)", () => {
  const savedDockerHost = process.env.DOCKER_HOST;
  const CADDY = "172.30.0.2";
  const answer = (address: string) => ({
    exitCode: 0,
    stdout: `Server:\t\tcoredns\nAddress:\t127.0.0.11:53\n\nNon-authoritative answer:\nName:\tschemas.hack\nAddress: ${address}\n`,
    stderr: "",
  });
  afterEach(() => {
    if (savedDockerHost === undefined) {
      Reflect.deleteProperty(process.env, "DOCKER_HOST");
    } else {
      process.env.DOCKER_HOST = savedDockerHost;
    }
    proxyRuntimeAnswer = null;
    caddyAddressesAnswer = null;
    httpsStateAnswer = null;
    systemAddressesAnswer = [];
    httpsProbeCalls.length = 0;
    httpsProbeNames.length = 0;
    // `runCli` reserves stdout for a `--json` run; later tests run without.
    resetStdoutReservationForTests();
  });

  async function upWith(opts: {
    readonly dockerHost: string;
    readonly nslookup?: { exitCode: number; stdout: string; stderr: string };
    readonly published443?: readonly string[];
    readonly https?: (address: string) => string;
    readonly args?: readonly string[];
    /** The OS resolver's answer for the selected name; default none. */
    readonly resolved?: readonly string[];
  }) {
    systemAddressesAnswer = opts.resolved ?? [];
    process.env.DOCKER_HOST = opts.dockerHost;
    proxyRuntimeAnswer = {
      caPem: "PEM",
      loopbackPorts: { 80: ["0.0.0.0"], 443: opts.published443 ?? ["0.0.0.0"] },
    };
    caddyAddressesAnswer = [CADDY];
    httpsStateAnswer = opts.https ?? null;
    const caddyCompose = globalCaddyComposePath();
    await mkdir(dirname(caddyCompose), { recursive: true });
    await writeFile(caddyCompose, renderGlobalCaddyCompose());
    await writeFile(join(dirname(caddyCompose), "Corefile"), ".:53 {}\n");
    execMockResponder = (cmd) =>
      cmd.includes("nslookup") ? (opts.nslookup ?? answer(CADDY)) : null;
    const out: string[] = [];
    const err: string[] = [];
    const outSpy = spyOn(process.stdout, "write").mockImplementation(
      (chunk: string | Uint8Array) => {
        out.push(String(chunk));
        return true;
      }
    );
    const errSpy = spyOn(process.stderr, "write").mockImplementation(
      (chunk: string | Uint8Array) => {
        err.push(String(chunk));
        return true;
      }
    );
    try {
      const { runCli } = await import("../src/cli/run.ts");
      const code = await runCli(["global", "up", ...(opts.args ?? [])]);
      return {
        code,
        stdout: out.join(""),
        output: `${out.join("")}${err.join("")}`,
      };
    } finally {
      outSpy.mockRestore();
      errSpy.mockRestore();
    }
  }

  test("Hack's proxy answering at doctor's loopback endpoint, with CoreDNS naming the proxy: ready", async () => {
    const result = await upWith({ dockerHost: "unix:///var/run/docker.sock" });
    expect(result.code).toBe(0);
    expect(result.output).not.toContain("Not checked");
    // The endpoint comes from the live 443 binding (0.0.0.0 → 127.0.0.1).
    expect(httpsProbeCalls).toEqual([["127.0.0.1"]]);
  });

  test("HTTPS goes where the OS resolves the name: the proxy container's address served, loopback rejecting, is ready", async () => {
    const result = await upWith({
      dockerHost: "unix:///var/run/docker.sock",
      resolved: [CADDY],
      https: (address) => (address === CADDY ? "ok" : "rejected"),
    });
    expect(result.code).toBe(0);
    expect(result.output).not.toContain("Not checked");
    // Only the resolved address is probed, not loopback.
    expect(httpsProbeCalls).toEqual([[CADDY]]);
  });

  test("no OS answer for the name: loopback rejecting is not checked, with the DNS hint, and up succeeds", async () => {
    const result = await upWith({
      dockerHost: "unix:///var/run/docker.sock",
      https: (address) => (address === "127.0.0.1" ? "timeout" : "rejected"),
      published443: ["0.0.0.0", "::"],
    });
    expect(result.code).toBe(0);
    expect(httpsProbeCalls).toEqual([["127.0.0.1", "::1"]]);
    expect(result.output).toContain(
      "Not checked: schemas.hack.local has no address on this machine yet (hack global install sets up Hack's domains, and hack doctor shows the DNS checks); at the proxy's published loopback port 443 on ::1 refused TLS for schemas.hack.local"
    );
  });

  test("an OS answer that another server holds is a refusal naming that address", async () => {
    const result = await upWith({
      dockerHost: "unix:///var/run/docker.sock",
      resolved: ["10.9.9.9"],
      https: () => "untrusted",
    });
    expect(result.code).toBe(1);
    expect(result.output).toContain(
      "port 443 on 10.9.9.9 answered with a certificate this home's proxy did not issue"
    );
  }, 60_000);

  test("the HTTPS step asks for the name the DNS step resolved: the one the proxy file routes", async () => {
    expect(
      (await upWith({ dockerHost: "unix:///var/run/docker.sock" })).code
    ).toBe(0);
    const resolved = execCalls
      .filter((call) => call.includes("nslookup"))
      .map((call) => call[call.indexOf("nslookup") + 1]);
    expect(resolved).toEqual(["schemas.hack.local"]);
    expect(httpsProbeNames).toEqual(["schemas.hack.local"]);

    // A v4 file routes only schemas.hack: both steps use that name.
    execCalls.length = 0;
    httpsProbeNames.length = 0;
    await mkdir(dirname(globalCaddyComposePath()), { recursive: true });
    const v4 = renderGlobalCaddyCompose().replace(
      /caddy: schemas\.hack\.local, schemas\.hack/,
      "caddy: schemas.hack"
    );
    expect(v4).toContain("caddy: schemas.hack\n");
    execMockResponder = (cmd) =>
      cmd.includes("nslookup")
        ? {
            exitCode: 0,
            stdout: `Name:\tschemas.hack\nAddress: ${CADDY}\n`,
            stderr: "",
          }
        : null;
    await writeFile(globalCaddyComposePath(), v4);
    const { runCli } = await import("../src/cli/run.ts");
    const out = spyOn(process.stdout, "write").mockImplementation(() => true);
    const err = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(await runCli(["global", "up"])).toBe(0);
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
    expect(httpsProbeNames).toEqual(["schemas.hack"]);
  });

  test("a TLS server that refuses the selected name (an alert) fails up with E_GLOBAL_NOT_READY", async () => {
    const result = await upWith({
      dockerHost: "unix:///var/run/docker.sock",
      https: () => "rejected",
      resolved: ["127.0.0.1"],
    });
    expect(result.code).toBe(1);
    expect(result.output).toContain(
      "port 443 on 127.0.0.1 refused TLS for schemas.hack.local: the server there does not serve that name"
    );
  }, 60_000);

  test("another server answering HTTPS (a certificate the proxy's CA did not issue) fails up with E_GLOBAL_NOT_READY", async () => {
    const result = await upWith({
      dockerHost: "unix:///var/run/docker.sock",
      https: () => "untrusted",
      resolved: ["127.0.0.1"],
    });
    expect(result.code).toBe(1);
    expect(result.output).toContain("E_GLOBAL_NOT_READY");
    expect(result.output).toContain(
      "port 443 on 127.0.0.1 answered with a certificate this home's proxy did not issue"
    );
  }, 60_000);

  test("CoreDNS answering with another address fails up with E_GLOBAL_NOT_READY", async () => {
    const result = await upWith({
      dockerHost: "unix:///var/run/docker.sock",
      nslookup: answer("192.0.2.99"),
    });
    expect(result.code).toBe(1);
    expect(result.output).toContain(
      `CoreDNS answered 192.0.2.99, not only the proxy's address (${CADDY})`
    );
  }, 60_000);

  test("a v4 proxy image without nslookup: up succeeds and says DNS was not checked", async () => {
    const result = await upWith({
      dockerHost: "unix:///var/run/docker.sock",
      nslookup: {
        exitCode: 127,
        stdout: "",
        stderr:
          'OCI runtime exec failed: exec: "nslookup": executable file not found in $PATH',
      },
    });
    expect(result.code).toBe(0);
    expect(result.output).toContain(
      "Not checked: the proxy image has no nslookup"
    );
    expect(execCalls.filter((call) => call.includes("nslookup"))).toHaveLength(
      1
    );
  });

  test("loopback 443 that does not complete TLS (timeout, reset): up succeeds, not checked", async () => {
    for (const state of ["timeout", "tls-error"]) {
      const result = await upWith({
        dockerHost: "unix:///var/run/docker.sock",
        https: () => state,
      });
      expect(result.code).toBe(0);
      expect(result.output).toContain(
        `HTTPS for schemas.hack.local through port 443 on 127.0.0.1 did not complete (${state}), so it was not checked`
      );
    }
  });

  test("443 not published on loopback: not checked, as in doctor, and nothing is probed", async () => {
    const result = await upWith({
      dockerHost: "unix:///var/run/docker.sock",
      published443: [],
    });
    expect(result.code).toBe(0);
    expect(httpsProbeCalls).toEqual([]);
    expect(result.output).toContain(
      "the proxy does not publish port 443 on a loopback address"
    );
  });

  test("a TCP engine is probed at its address; one given by host name, or an SSH engine, is not probed and says so", async () => {
    const tcp = await upWith({ dockerHost: "tcp://10.1.2.3:2376" });
    expect(tcp.code).toBe(0);
    expect(httpsProbeCalls).toEqual([["10.1.2.3"]]);

    httpsProbeCalls.length = 0;
    const named = await upWith({ dockerHost: "tcp://builder.example:2376" });
    expect(named.code).toBe(0);
    expect(httpsProbeCalls).toEqual([]);
    expect(named.output).toContain(
      "the Docker engine is given by host name (builder.example), which is not resolved here"
    );

    const ssh = await upWith({ dockerHost: "ssh://builder@remote" });
    expect(ssh.code).toBe(0);
    expect(httpsProbeCalls).toEqual([]);
    expect(ssh.output).toContain(
      "the Docker engine is not local and its address is not known here"
    );
  });

  test("global up --json sends every child's stdout (Compose, hack daemon start) to stderr; without it they inherit", async () => {
    runStdoutTargets.length = 0;
    expect(
      (await upWith({ dockerHost: "unix:///var/run/docker.sock" })).code
    ).toBe(0);
    expect(runStdoutTargets.length).toBeGreaterThan(0);
    expect(new Set(runStdoutTargets)).toEqual(new Set(["inherit"]));
    runStdoutTargets.length = 0;
    const json = await upWith({
      dockerHost: "unix:///var/run/docker.sock",
      args: ["--json"],
    });
    expect(json.code).toBe(0);
    expect(runStdoutTargets.length).toBeGreaterThan(0);
    expect(new Set(runStdoutTargets)).toEqual(new Set(["stderr"]));
  });

  test("global up --json: stdout is one envelope, with the route outcome, or the readiness code on failure", async () => {
    const ok = await upWith({
      dockerHost: "unix:///var/run/docker.sock",
      args: ["--json"],
    });
    expect(ok.code).toBe(0);
    const envelope = JSON.parse(ok.stdout);
    expect(envelope).toMatchObject({
      ok: true,
      data: {
        schema: "hack.global-up.v1",
        failedStage: null,
        logging: { enabled: false },
        routes: { dns: { state: "ready" }, https: { state: "ready" } },
      },
    });

    const failed = await upWith({
      dockerHost: "unix:///var/run/docker.sock",
      https: () => "untrusted",
      resolved: ["127.0.0.1"],
      args: ["--json"],
    });
    expect(failed.code).toBe(1);
    expect(JSON.parse(failed.stdout)).toMatchObject({
      ok: false,
      error: {
        code: "E_GLOBAL_NOT_READY",
        detail: {
          schema: "hack.global-up.v1",
          failedStage: "routing",
          routes: { https: { state: "not-ready" } },
        },
      },
    });
  }, 60_000);
});

describe("the opt-in logging stack (HACK-2468)", () => {
  const home = () => join(tempDir!, GLOBAL_HACK_DIR_NAME);
  const loggingCompose = () =>
    join(home(), GLOBAL_LOGGING_DIR_NAME, GLOBAL_LOGGING_COMPOSE_FILENAME);
  const loggingSetting = async (): Promise<unknown> => {
    const text = await readFile(join(home(), "hack.config.json"), "utf8").catch(
      () => null
    );
    return text === null ? undefined : JSON.parse(text).logging?.enabled;
  };
  // `docker ps --format` lines: id, then the recorded Compose working dir.
  const psLines = (...ids: readonly string[]) =>
    ids.map((id) => `${id}\t${dirname(loggingCompose())}\n`).join("");
  // Another Hack home's logging stack on the same engine: never touched.
  const otherHome = "ccc333\t/srv/other-home/.hack/logging\n";
  const loggingCalls = (calls: readonly string[][], verb: string) =>
    calls.filter(
      (call) => call.includes(loggingCompose()) && call.includes(verb)
    );

  test("a fresh home's install starts the proxy only, writes no logging files and saves nothing", async () => {
    await writeInstallStubs({ logging: false });
    const { code, output } = await runNonInteractiveInstall();
    expect(code).toBe(0);
    expect(await Bun.file(globalCaddyComposePath()).exists()).toBe(true);
    expect(await Bun.file(loggingCompose()).exists()).toBe(false);
    expect(
      runCalls.some(
        (call) => call.includes(globalCaddyComposePath()) && call.includes("up")
      )
    ).toBe(true);
    expect(loggingCalls(runCalls, "up")).toEqual([]);
    expect(loggingCalls(execCalls, "stop")).toEqual([]);
    expect(output).toContain("hack global up --logging");
    expect(await loggingSetting()).toBeUndefined();
  });

  test("an existing home keeps its logging stack and its first start saves that choice", async () => {
    await writeComposeFile(globalCaddyComposePath());
    await writeComposeFile(loggingCompose());
    const { runCli } = await import("../src/cli/run.ts");
    expect(await runCli(["global", "up"])).toBe(0);
    expect(loggingCalls(runCalls, "up")).toHaveLength(1);
    // Saved, so the choice no longer hangs on the compose file.
    expect(await loggingSetting()).toBe(true);
  });

  test("an existing home whose compose file was moved aside keeps the stack: the file is written again", async () => {
    await writeComposeFile(globalCaddyComposePath());
    await writeFile(
      join(home(), GLOBAL_CADDY_DIR_NAME, "Corefile"),
      ".:53 {}\n"
    );
    // The logging directory is the marker; only its compose file is gone.
    await mkdir(join(home(), GLOBAL_LOGGING_DIR_NAME), { recursive: true });
    const { runCli } = await import("../src/cli/run.ts");
    expect(await runCli(["global", "up"])).toBe(0);
    expect(await loggingSetting()).toBe(true);
    expect(await Bun.file(loggingCompose()).exists()).toBe(true);
    expect(loggingCalls(runCalls, "up")).toHaveLength(1);
  });

  test("global up --logging turns it on in a fresh home: saves the setting, writes the files, starts it", async () => {
    await writeComposeFile(globalCaddyComposePath());
    await writeFile(
      join(home(), GLOBAL_CADDY_DIR_NAME, "Corefile"),
      ".:53 {}\n"
    );
    const { runCli } = await import("../src/cli/run.ts");
    expect(await runCli(["global", "up", "--logging"])).toBe(0);
    expect(await loggingSetting()).toBe(true);
    expect(await Bun.file(loggingCompose()).exists()).toBe(true);
    expect(loggingCalls(runCalls, "up")).toHaveLength(1);

    // Later runs keep it on without the flag.
    runCalls.length = 0;
    expect(await runCli(["global", "up"])).toBe(0);
    expect(loggingCalls(runCalls, "up")).toHaveLength(1);
  });

  test("a failed save does not block routing: the stack stays on for this run, and the warning says it was not saved", async () => {
    await writeComposeFile(globalCaddyComposePath());
    await writeFile(
      join(home(), GLOBAL_CADDY_DIR_NAME, "Corefile"),
      ".:53 {}\n"
    );
    await writeComposeFile(loggingCompose());
    // A config path under a regular file: reads find nothing, writes fail.
    const blocker = join(tempDir!, "not-a-directory");
    await writeFile(blocker, "");
    const saved = process.env.HACK_GLOBAL_CONFIG_PATH;
    process.env.HACK_GLOBAL_CONFIG_PATH = join(blocker, "hack.config.json");
    const lines: string[] = [];
    const capture = (chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    };
    const out = spyOn(process.stdout, "write").mockImplementation(capture);
    const err = spyOn(process.stderr, "write").mockImplementation(capture);
    try {
      const { runCli } = await import("../src/cli/run.ts");
      // The decision an existing home's first start saves.
      expect(await runCli(["global", "up"])).toBe(0);
      expect(loggingCalls(runCalls, "up")).toHaveLength(1);
      // An explicit flag: this run follows it.
      runCalls.length = 0;
      expect(await runCli(["global", "up", "--no-logging"])).toBe(0);
      expect(loggingCalls(runCalls, "up")).toEqual([]);
    } finally {
      out.mockRestore();
      err.mockRestore();
      if (saved === undefined) {
        Reflect.deleteProperty(process.env, "HACK_GLOBAL_CONFIG_PATH");
      } else {
        process.env.HACK_GLOBAL_CONFIG_PATH = saved;
      }
    }
    const text = lines.join("");
    expect(text).toContain(
      "so it stays on for this run, but logging.enabled=true was not saved"
    );
    expect(text).toContain("logging.enabled=false was not saved");
    expect(text).toContain("This run uses it");
    // Routing started both times.
    expect(
      runCalls.some(
        (call) => call.includes(globalCaddyComposePath()) && call.includes("up")
      )
    ).toBe(true);
  });

  test("after an engine upgrade Hack's own logging Compose file is replaced silently; a hand edit only after a yes", async () => {
    await writeInstallStubs();
    // The file an older engine got (no start_interval), and now Engine 29.
    await mkdir(dirname(loggingCompose()), { recursive: true });
    await writeFile(loggingCompose(), renderGlobalLoggingCompose());
    execMockResponder = (cmd) =>
      cmd[1] === "version" && cmd.includes("{{.Server.Version}}")
        ? { exitCode: 0, stdout: "29.0.1\n", stderr: "" }
        : null;
    const backups = async () =>
      (await readdir(dirname(loggingCompose()))).filter((name) =>
        name.startsWith(`${GLOBAL_LOGGING_COMPOSE_FILENAME}.bak-`)
      );
    const rendered = renderGlobalLoggingCompose({ startInterval: true });
    loggingComposePrompts.length = 0;
    // Hack's own rendering: replaced with no prompt, even when every prompt
    // would be declined, and with no backup.
    const upgraded = await runNonInteractiveInstall({ interactive: true });
    expect(upgraded.code).toBe(0);
    expect(readFileSync(loggingCompose(), "utf8")).toBe(rendered);
    expect(loggingComposePrompts).toEqual([]);
    expect(await backups()).toEqual([]);

    // A hardened hand edit (here: Loki's proxy route removed) is kept
    // without a terminal, and the warning says how to take Hack's file.
    const edited = rendered.replace(/^\s+caddy[^\n]*\n/gm, "");
    expect(edited).not.toBe(rendered);
    await writeFile(loggingCompose(), edited);
    const kept = await runNonInteractiveInstall();
    expect(kept.code).toBe(0);
    expect(readFileSync(loggingCompose(), "utf8")).toBe(edited);
    expect(await backups()).toEqual([]);
    expect(kept.output).toContain(
      "it differs from Hack's rendering, so `hack global up` keeps its fixed waits unless it has healthchecks"
    );

    // Declined in a terminal: kept, and the question named the file.
    const declined = await runNonInteractiveInstall({ interactive: true });
    expect(declined.code).toBe(0);
    expect(readFileSync(loggingCompose(), "utf8")).toBe(edited);
    expect(loggingComposePrompts.at(-1)).toContain(loggingCompose());

    // Accepted: backed up, then replaced.
    const replaced = await runNonInteractiveInstall({
      interactive: true,
      overwrite: true,
    });
    expect(replaced.code).toBe(0);
    expect(readFileSync(loggingCompose(), "utf8")).toBe(rendered);
    const [backup] = await backups();
    expect(backup).toBeDefined();
    expect(readFileSync(join(dirname(loggingCompose()), backup!), "utf8")).toBe(
      edited
    );
  });

  test("global up --no-logging saves false and stops the stack, keeping its volumes", async () => {
    await writeComposeFile(globalCaddyComposePath());
    await writeComposeFile(loggingCompose());
    execMockResponder = (cmd) =>
      cmd[1] === "ps" &&
      cmd.includes("label=com.docker.compose.project=hack-logging")
        ? {
            exitCode: 0,
            stdout: psLines("aaa111", "bbb222") + otherHome,
            stderr: "",
          }
        : null;
    const { runCli } = await import("../src/cli/run.ts");
    expect(await runCli(["global", "up", "--no-logging"])).toBe(0);
    expect(await loggingSetting()).toBe(false);
    expect(loggingCalls(runCalls, "up")).toEqual([]);
    // Found by the stack's Compose labels, so even a home whose logging
    // files are gone has its containers stopped; another home's are not.
    expect(execCalls.filter((call) => call[1] === "stop")).toEqual([
      ["docker", "stop", "aaa111", "bbb222"],
    ]);
    for (const call of [...execCalls, ...runCalls]) {
      if (call.includes(loggingCompose())) {
        expect(call).not.toContain("down");
        expect(call).not.toContain("-v");
      }
    }
    // The files stay, so turning it back on needs no install.
    expect(await Bun.file(loggingCompose()).exists()).toBe(true);
  });

  test("a failed stop of the disabled stack fails global up and says the containers may still run", async () => {
    await writeComposeFile(globalCaddyComposePath());
    await writeComposeFile(loggingCompose());
    execMockResponder = (cmd) => {
      if (
        cmd[1] === "ps" &&
        cmd.includes("label=com.docker.compose.project=hack-logging")
      ) {
        return { exitCode: 0, stdout: psLines("aaa111"), stderr: "" };
      }
      return cmd[1] === "stop"
        ? {
            exitCode: 1,
            stdout: "",
            stderr: "Cannot connect to the Docker daemon\nsecond line\n",
          }
        : null;
    };
    const errors: string[] = [];
    const capture = (chunk: string | Uint8Array) => {
      errors.push(String(chunk));
      return true;
    };
    const out = spyOn(process.stdout, "write").mockImplementation(capture);
    const err = spyOn(process.stderr, "write").mockImplementation(capture);
    let code: number;
    try {
      const { runCli } = await import("../src/cli/run.ts");
      code = await runCli(["global", "up", "--no-logging"]);
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
    expect(code).toBe(1);
    expect(await loggingSetting()).toBe(false);
    const message = errors.join("\n");
    expect(message).toContain(
      "its containers could not be stopped (docker stop exited 1): Cannot connect to the Docker daemon"
    );
    expect(message).toContain("They may still be running.");
    expect(message).not.toContain("second line");
  });

  test("a failed lookup of the disabled stack's containers fails global up instead of reporting it stopped", async () => {
    await writeComposeFile(globalCaddyComposePath());
    await writeComposeFile(loggingCompose());
    execMockResponder = (cmd) =>
      cmd[1] === "ps" &&
      cmd.includes("label=com.docker.compose.project=hack-logging")
        ? { exitCode: 1, stdout: "", stderr: "Cannot connect\n" }
        : null;
    const lines: string[] = [];
    const capture = (chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    };
    const out = spyOn(process.stdout, "write").mockImplementation(capture);
    const err = spyOn(process.stderr, "write").mockImplementation(capture);
    let code: number;
    try {
      const { runCli } = await import("../src/cli/run.ts");
      code = await runCli(["global", "up", "--no-logging"]);
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
    expect(code).toBe(1);
    const text = lines.join("");
    expect(text).toContain(
      "Docker could not be asked for its containers, so none were stopped."
    );
    expect(text).toContain("They may still be running.");
    expect(text).not.toContain("Logging stack (Loki, Alloy, Grafana) is off;");
    expect(execCalls.filter((call) => call[1] === "stop")).toEqual([]);
  });

  async function statusJson(): Promise<{
    readonly logging: {
      readonly ok: unknown;
      readonly enabled?: boolean;
      readonly error: string | null;
    };
  }> {
    let output = "";
    const write = spyOn(process.stdout, "write").mockImplementation(
      (chunk: string | Uint8Array) => {
        output += String(chunk);
        return true;
      }
    );
    try {
      const { runCli } = await import("../src/cli/run.ts");
      await runCli(["global", "status", "--json"]);
    } finally {
      write.mockRestore();
    }
    return JSON.parse(output.trim());
  }

  test("status with logging off still asks Docker: running containers are not reported as off", async () => {
    await writeComposeFile(globalCaddyComposePath());
    await enableLogging();
    await writeFile(
      join(home(), "hack.config.json"),
      `${JSON.stringify({ logging: { enabled: false } })}\n`
    );
    let running = psLines("aaa111") + otherHome;
    execMockResponder = (cmd) =>
      cmd[1] === "ps" &&
      cmd.includes("label=com.docker.compose.project=hack-logging")
        ? { exitCode: 0, stdout: running, stderr: "" }
        : null;
    const busy = await statusJson();
    expect(busy.logging).toMatchObject({ ok: false, enabled: false });
    expect(busy.logging.error).toContain(
      "1 logging container is still running"
    );
    expect(busy.logging.error).toContain("hack global up");
    running = otherHome;
    expect((await statusJson()).logging).toMatchObject({
      ok: true,
      enabled: false,
      error: null,
    });
  });

  test("logs-reset with logging off and no files checks Docker for the stack's volumes, and never deletes them", async () => {
    await writeComposeFile(globalCaddyComposePath());
    let volumes: { exitCode: number; stdout: string; stderr: string } = {
      exitCode: 0,
      stdout: "",
      stderr: "",
    };
    execMockResponder = (cmd) =>
      cmd[1] === "volume" && cmd[2] === "ls" ? volumes : null;
    const lines: string[] = [];
    const capture = (chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    };
    const out = spyOn(process.stdout, "write").mockImplementation(capture);
    const err = spyOn(process.stderr, "write").mockImplementation(capture);
    const codes: number[] = [];
    try {
      const { runCli } = await import("../src/cli/run.ts");
      // None: nothing to reset.
      codes.push(await runCli(["global", "logs-reset"]));
      // Left over from before: listed with the command, not removed.
      volumes = {
        exitCode: 0,
        stdout: "hack-logging_loki-data\nhack-logging_grafana-data\n",
        stderr: "",
      };
      codes.push(await runCli(["global", "logs-reset"]));
      // Docker could not be asked: not reported as nothing to reset.
      volumes = { exitCode: 1, stdout: "", stderr: "Cannot connect\n" };
      codes.push(await runCli(["global", "logs-reset"]));
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
    expect(codes).toEqual([0, 1, 1]);
    const text = lines.join("");
    expect(text).toContain(
      "with no files or volumes here, so there are no logs to reset"
    );
    expect(text).toContain(
      "Docker still has 2 of its volumes: hack-logging_loki-data, hack-logging_grafana-data."
    );
    expect(text).toContain(
      "docker volume rm hack-logging_loki-data hack-logging_grafana-data"
    );
    expect(text).toContain(
      "Could not ask Docker for the logging stack's volumes: Cannot connect"
    );
    expect(
      execCalls.filter((call) => call[1] === "volume" && call[2] === "ls")[0]
    ).toEqual([
      "docker",
      "volume",
      "ls",
      "-q",
      "--filter",
      "label=com.docker.compose.project=hack-logging",
    ]);
    for (const call of [...runCalls, ...execCalls]) {
      expect(call).not.toContain("down");
      expect(call.slice(0, 3)).not.toEqual(["docker", "volume", "rm"]);
    }
  });

  test("a fresh home's global up only looks for stray logging containers: no files, no start, no stop", async () => {
    await writeComposeFile(globalCaddyComposePath());
    const { runCli } = await import("../src/cli/run.ts");
    expect(await runCli(["global", "up"])).toBe(0);
    const logging = [...execCalls, ...runCalls].filter((call) =>
      call.some(
        (arg) =>
          arg.includes(join(home(), GLOBAL_LOGGING_DIR_NAME)) ||
          arg.includes("hack-logging")
      )
    );
    // One read by Compose labels; nothing is written, started or stopped.
    expect(logging).toEqual([
      [
        "docker",
        "ps",
        "--filter",
        "label=com.docker.compose.project=hack-logging",
        "--format",
        '{{.ID}}\t{{.Label "com.docker.compose.project.working_dir"}}',
      ],
    ]);
    expect(await Bun.file(loggingCompose()).exists()).toBe(false);
  });

  test("--logging and --no-logging together are refused and change nothing", async () => {
    await writeComposeFile(globalCaddyComposePath());
    const { runCli } = await import("../src/cli/run.ts");
    expect(await runCli(["global", "up", "--logging", "--no-logging"])).toBe(1);
    expect(await loggingSetting()).toBeUndefined();
    expect(runCalls).toEqual([]);
  });
});
