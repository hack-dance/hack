import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  DEFAULT_CADDY_IP,
  DEFAULT_HOST_DNS_IP,
  GLOBAL_CADDY_COMPOSE_FILENAME,
  GLOBAL_CADDY_DIR_NAME,
  GLOBAL_HACK_DIR_NAME,
  GLOBAL_LOGGING_COMPOSE_FILENAME,
  GLOBAL_LOGGING_DIR_NAME,
} from "../src/constants.ts";

const runCalls: string[][] = [];
let runResponder: ((cmd: readonly string[]) => number | null) | null = null;

let tempDir: string | null = null;
let originalHome: string | undefined;
let originalLogger: string | undefined;
let originalUser: string | undefined;
let reachabilityByHost: Record<string, boolean> = {};
let idUser = "mock-user";

mock.module("@clack/prompts", () => ({
  access: async () => true,
  autocompleteMultiselect: async () => [],
  cancel: () => {},
  confirm: async () => true,
  multiselect: async () => [],
  isCancel: () => false,
  log: {
    error: () => {},
    info: () => {},
    message: () => {},
    success: () => {},
    step: () => {},
    warn: () => {},
  },
  note: () => {},
  password: async () => "",
  select: async () => "",
  spinner: () => ({
    start: () => {},
    stop: () => {},
  }),
  text: async () => "",
}));

mock.module("node:net", () => ({
  createConnection: (opts: { host: string }) => {
    const handlers = new Map<string, () => void>();
    const reachable = reachabilityByHost[opts.host] ?? false;

    queueMicrotask(() => {
      const event = reachable ? "connect" : "error";
      handlers.get(event)?.();
    });

    return {
      destroy: () => {},
      on: (event: string, handler: () => void) => {
        handlers.set(event, handler);
      },
    };
  },
}));

mock.module("../src/lib/shell.ts", () => ({
  exec: async (cmd: readonly string[]) => {
    if (cmd[0] === "docker" && cmd[1] === "info") {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (cmd[0] === "brew" && cmd[1] === "--prefix") {
      return {
        exitCode: 0,
        stdout: resolve(tempDir ?? "/tmp", "brew-prefix"),
        stderr: "",
      };
    }
    if (cmd[0] === "brew" && cmd[1] === "list" && cmd[2] === "dnsmasq") {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (cmd[0] === "docker" && cmd[1] === "network" && cmd[2] === "inspect") {
      return { exitCode: 0, stdout: "[]", stderr: "" };
    }
    if (cmd[0] === "id" && cmd[1] === "-un") {
      return { exitCode: 0, stdout: `${idUser}\n`, stderr: "" };
    }

    return { exitCode: 0, stdout: "", stderr: "" };
  },
  execOrThrow: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  run: async (cmd: readonly string[]) => {
    runCalls.push([...cmd]);
    return runResponder?.(cmd) ?? 0;
  },
  findExecutableInPath: (name?: string) => {
    if (name === "hack") {
      return "/usr/local/bin/hack";
    }
    if (name === "brew") {
      return "/opt/homebrew/bin/brew";
    }
    return "/usr/bin/mock-bin";
  },
  CommandError: class CommandError extends Error {},
}));

mock.module("../src/lib/os.ts", () => ({
  isMac: () => true,
  openUrl: async () => 0,
}));

beforeEach(async () => {
  originalHome = process.env.HOME;
  originalLogger = process.env.HACK_LOGGER;
  originalUser = process.env.USER;
  tempDir = await mkdtemp(join(tmpdir(), "hack-global-macos-"));
  process.env.HOME = tempDir;
  process.env.USER = "env-user";
  process.env.HACK_LOGGER = "console";
  runCalls.length = 0;
  runResponder = null;
  reachabilityByHost = {};
  idUser = "mock-user";
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
  process.env.HOME = originalHome;
  process.env.USER = originalUser;
  process.env.HACK_LOGGER = originalLogger;
});

afterAll(() => {
  mock.restore();
});

async function writeExecutable(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "#!/usr/bin/env sh\nexit 0\n");
  await chmod(path, 0o755);
}

async function prepareManagedTools(root: string): Promise<void> {
  await writeExecutable(join(root, GLOBAL_HACK_DIR_NAME, "bin", "gum"));
  await writeExecutable(join(root, GLOBAL_HACK_DIR_NAME, "bin", "mutagen"));
  await mkdir(join(root, GLOBAL_HACK_DIR_NAME, "libexec"), { recursive: true });
  await writeFile(
    join(root, GLOBAL_HACK_DIR_NAME, "libexec", "mutagen-agents.tar.gz"),
    "stub"
  );
}

async function readDnsmasqConf(root: string): Promise<string> {
  const dnsmasqConf = join(root, "brew-prefix", "etc", "dnsmasq.conf");
  return await Bun.file(dnsmasqConf).text();
}

async function writeComposeFile(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "services: {}\n");
}

test("global install keeps container ip host dns when bridge ip is reachable", async () => {
  await prepareManagedTools(tempDir!);
  reachabilityByHost = {
    [DEFAULT_CADDY_IP]: true,
    [DEFAULT_HOST_DNS_IP]: true,
  };

  const { runCli } = await import("../src/cli/run.ts");
  const code = await runCli(["global", "install"]);

  expect(code).toBe(0);
  expect(await readDnsmasqConf(tempDir!)).toContain(
    `address=/.hack/${DEFAULT_CADDY_IP}`
  );
  expect(runCalls).toEqual(
    expect.arrayContaining([
      ["sudo", "install", "-d", "-m", "0755", "/etc/sudoers.d"],
      [
        "sudo",
        "install",
        "-m",
        "0440",
        expect.stringContaining("dance.hack-dns-recovery.sudoers"),
        "/etc/sudoers.d/dance.hack-dns-recovery",
      ],
      ["/usr/local/bin/hack", "daemon", "install"],
    ])
  );
});

test("global install falls back to localhost host dns when bridge ip is unreachable", async () => {
  await prepareManagedTools(tempDir!);
  reachabilityByHost = {
    [DEFAULT_CADDY_IP]: false,
    [DEFAULT_HOST_DNS_IP]: true,
  };

  const { runCli } = await import("../src/cli/run.ts");
  const code = await runCli(["global", "install"]);

  expect(code).toBe(0);
  expect(await readDnsmasqConf(tempDir!)).toContain(
    `address=/.hack/${DEFAULT_HOST_DNS_IP}`
  );
});

test("global authorize installs passwordless dns recovery sudoers rule", async () => {
  const { runCli } = await import("../src/cli/run.ts");
  const code = await runCli(["global", "authorize"]);

  expect(code).toBe(0);
  expect(runCalls).toEqual(
    expect.arrayContaining([
      [
        "/usr/bin/mock-bin",
        "-cf",
        expect.stringContaining("dance.hack-dns-recovery.sudoers"),
      ],
      ["sudo", "install", "-d", "-m", "0755", "/etc/sudoers.d"],
      [
        "sudo",
        "install",
        "-m",
        "0440",
        expect.stringContaining("dance.hack-dns-recovery.sudoers"),
        "/etc/sudoers.d/dance.hack-dns-recovery",
      ],
      [
        "sudo",
        "/usr/bin/mock-bin",
        "-cf",
        "/etc/sudoers.d/dance.hack-dns-recovery",
      ],
    ])
  );
});

test("global authorize uses the OS account lookup instead of USER env", async () => {
  idUser = "real-login-user";
  process.env.USER = "spoofed-user";

  const { runCli } = await import("../src/cli/run.ts");
  const code = await runCli(["global", "authorize"]);

  expect(code).toBe(0);
  const sudoersPath = resolve(
    tempDir!,
    GLOBAL_HACK_DIR_NAME,
    "tmp",
    "dance.hack-dns-recovery.sudoers"
  );
  const sudoersText = await Bun.file(sudoersPath).text();
  expect(sudoersText).toContain("real-login-user ALL = (root) NOPASSWD:");
  expect(sudoersText).not.toContain("spoofed-user ALL = (root) NOPASSWD:");
});

test("global up tries passwordless sudo before prompting for dnsmasq recovery", async () => {
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
  expect(runCalls[0]).toEqual([
    "sudo",
    "-n",
    "/opt/homebrew/bin/brew",
    "services",
    "restart",
    "dnsmasq",
  ]);
});

test("global up falls back to interactive sudo when stdin is tty but stdout is redirected", async () => {
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

  const stdinDescriptor = Object.getOwnPropertyDescriptor(
    process.stdin,
    "isTTY"
  );
  const stdoutDescriptor = Object.getOwnPropertyDescriptor(
    process.stdout,
    "isTTY"
  );
  Object.defineProperty(process.stdin, "isTTY", {
    configurable: true,
    value: true,
  });
  Object.defineProperty(process.stdout, "isTTY", {
    configurable: true,
    value: false,
  });
  runResponder = (cmd) => {
    if (
      cmd.join(" ") ===
      "sudo -n /opt/homebrew/bin/brew services restart dnsmasq"
    ) {
      return 1;
    }
    return 0;
  };

  try {
    const { runCli } = await import("../src/cli/run.ts");
    const code = await runCli(["global", "up"]);

    expect(code).toBe(0);
    expect(runCalls).toEqual(
      expect.arrayContaining([
        [
          "sudo",
          "-n",
          "/opt/homebrew/bin/brew",
          "services",
          "restart",
          "dnsmasq",
        ],
        ["sudo", "/opt/homebrew/bin/brew", "services", "restart", "dnsmasq"],
      ])
    );
  } finally {
    if (stdinDescriptor) {
      Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
    }
    if (stdoutDescriptor) {
      Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
    }
  }
});
