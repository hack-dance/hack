import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
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
import { resetGumPathCacheForTests } from "../src/ui/gum.ts";
import { registerScopedModuleMock } from "./helpers/scoped-module-mock.ts";

const runCalls: string[][] = [];
const execCalls: string[][] = [];
let runResponder: ((cmd: readonly string[]) => number | null) | null = null;
let execMockResponder:
  | ((
      cmd: readonly string[]
    ) => { exitCode: number; stdout: string; stderr: string } | null)
  | null = null;

let tempDir: string | null = null;
let originalHome: string | undefined;
let originalLogger: string | undefined;
let originalUser: string | undefined;
let reachabilityByHost: Record<string, boolean> = {};
let idUser = "mock-user";
let pathExistsOverrides = new Map<string, boolean>();
let statMetadataByPath = new Map<string, string>();
let brewExecutablePath = "/opt/homebrew/bin/brew";
let confirmResponder: (() => boolean) | null = null;

const clackMock = await registerScopedModuleMock({
  importerPath: import.meta.path,
  specifier: "@clack/prompts",
  overrides: {
    access: async () => true,
    autocompleteMultiselect: async () => [],
    cancel: () => {},
    confirm: async () => confirmResponder?.() ?? true,
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
  },
});

const netMock = await registerScopedModuleMock({
  importerPath: import.meta.path,
  specifier: "node:net",
  overrides: {
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
    createServer: () => ({
      close: () => {},
      listen: () => {},
      on: () => {},
    }),
  },
});

const fsMock = await registerScopedModuleMock({
  importerPath: import.meta.path,
  specifier: "../src/lib/fs.ts",
  overrides: {
    ensureDir: async (absoluteDir: string) => {
      await mkdir(absoluteDir, { recursive: true });
    },
    ensureGitignoreEntry: async () => ({ changed: false }),
    pathExists: async (absolutePath: string) => {
      const override = pathExistsOverrides.get(absolutePath);
      if (override !== undefined) {
        return override;
      }
      try {
        await Bun.file(absolutePath).stat();
        return true;
      } catch {
        return false;
      }
    },
    readTextFile: async (absolutePath: string) => {
      try {
        return await Bun.file(absolutePath).text();
      } catch {
        return null;
      }
    },
    writeTextFile: async (absolutePath: string, content: string) => {
      await Bun.write(absolutePath, content);
    },
    writeTextFileIfChanged: async (absolutePath: string, content: string) => {
      const existing = await Bun.file(absolutePath)
        .text()
        .catch(() => null);
      if (existing === content) {
        return { changed: false };
      }
      await Bun.write(absolutePath, content);
      return { changed: true };
    },
  },
});

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
      if (cmd[0] === "/usr/bin/stat" && cmd[1] === "-f") {
        const metadata = statMetadataByPath.get(cmd[3] ?? "");
        if (!metadata) {
          return { exitCode: 1, stdout: "", stderr: "missing" };
        }
        return { exitCode: 0, stdout: `${metadata}\n`, stderr: "" };
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
        return brewExecutablePath;
      }
      return "/usr/bin/mock-bin";
    },
    CommandError: class CommandError extends Error {},
  },
});

const osMock = await registerScopedModuleMock({
  importerPath: import.meta.path,
  specifier: "../src/lib/os.ts",
  overrides: {
    isMac: () => true,
    openUrl: async () => 0,
  },
});

beforeAll(() => {
  clackMock.activate();
  netMock.activate();
  fsMock.activate();
  shellMock.activate();
  osMock.activate();
});

beforeEach(async () => {
  originalHome = process.env.HOME;
  originalLogger = process.env.HACK_LOGGER;
  originalUser = process.env.USER;
  tempDir = await mkdtemp(join(tmpdir(), "hack-global-macos-"));
  process.env.HOME = tempDir;
  process.env.USER = "env-user";
  process.env.HACK_LOGGER = "console";
  runCalls.length = 0;
  execCalls.length = 0;
  runResponder = null;
  execMockResponder = null;
  pathExistsOverrides = new Map([
    ["/etc/sudoers.d/dance.hack-dns-recovery", false],
    ["/usr/local/libexec/hack-dns-recovery", false],
    ["/System/Library/Keychains/SystemRootCertificates.keychain", true],
  ]);
  statMetadataByPath = new Map([
    ["/usr/local", "0:0:755"],
    ["/usr/local/libexec", "0:0:755"],
    ["/usr/local/libexec/hack-dns-recovery", "0:0:755"],
  ]);
  brewExecutablePath = "/opt/homebrew/bin/brew";
  reachabilityByHost = {};
  idUser = "mock-user";
  confirmResponder = null;
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
  process.env.HOME = originalHome;
  process.env.USER = originalUser;
  process.env.HACK_LOGGER = originalLogger;
  resetGumPathCacheForTests();
});

afterAll(() => {
  clackMock.deactivate();
  netMock.deactivate();
  fsMock.deactivate();
  shellMock.deactivate();
  osMock.deactivate();
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

async function fileExists(path: string): Promise<boolean> {
  try {
    await Bun.file(path).stat();
    return true;
  } catch {
    return false;
  }
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
      [
        "sudo",
        "install",
        "-d",
        "-o",
        "root",
        "-g",
        "wheel",
        "-m",
        "0755",
        "/etc/sudoers.d",
      ],
      [
        "sudo",
        "install",
        "-d",
        "-o",
        "root",
        "-g",
        "wheel",
        "-m",
        "0755",
        "/usr/local/libexec",
      ],
      [
        "sudo",
        "install",
        "-o",
        "root",
        "-g",
        "wheel",
        "-m",
        "0755",
        expect.stringContaining("hack-dns-recovery"),
        "/usr/local/libexec/hack-dns-recovery",
      ],
      [
        "sudo",
        "install",
        "-o",
        "root",
        "-g",
        "wheel",
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
  expect(runCalls).toContainEqual([
    "sudo",
    "install",
    "-d",
    "-o",
    "root",
    "-g",
    "wheel",
    "-m",
    "0755",
    "/usr/local/libexec",
  ]);
  expect(runCalls).toContainEqual([
    "sudo",
    "install",
    "-d",
    "-o",
    "root",
    "-g",
    "wheel",
    "-m",
    "0755",
    "/etc/sudoers.d",
  ]);
  expect(runCalls).toContainEqual([
    "sudo",
    "install",
    "-o",
    "root",
    "-g",
    "wheel",
    "-m",
    "0755",
    expect.stringContaining("hack-dns-recovery"),
    "/usr/local/libexec/hack-dns-recovery",
  ]);
  expect(runCalls).toContainEqual([
    "sudo",
    "install",
    "-o",
    "root",
    "-g",
    "wheel",
    "-m",
    "0440",
    expect.stringContaining("dance.hack-dns-recovery.sudoers"),
    "/etc/sudoers.d/dance.hack-dns-recovery",
  ]);
  expect(runCalls).toContainEqual([
    "sudo",
    "/usr/bin/mock-bin",
    "-cf",
    "/etc/sudoers.d/dance.hack-dns-recovery",
  ]);
  expect(runCalls).toContainEqual(["sudo", "-k"]);
  expect(runCalls).toContainEqual([
    "sudo",
    "-n",
    "/usr/local/libexec/hack-dns-recovery",
    "check",
  ]);
  expect(execCalls).toContainEqual([
    "/usr/bin/stat",
    "-f",
    "%u:%g:%Lp",
    "/usr/local",
  ]);
  expect(execCalls).toContainEqual([
    "/usr/bin/stat",
    "-f",
    "%u:%g:%Lp",
    "/usr/local/libexec",
  ]);
  expect(execCalls).toContainEqual([
    "/usr/bin/stat",
    "-f",
    "%u:%g:%Lp",
    "/usr/local/libexec/hack-dns-recovery",
  ]);
});

test("global authorize refreshes an existing dns recovery sudoers rule", async () => {
  pathExistsOverrides.set("/etc/sudoers.d/dance.hack-dns-recovery", true);

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
      [
        "sudo",
        "install",
        "-d",
        "-o",
        "root",
        "-g",
        "wheel",
        "-m",
        "0755",
        "/etc/sudoers.d",
      ],
      [
        "sudo",
        "install",
        "-d",
        "-o",
        "root",
        "-g",
        "wheel",
        "-m",
        "0755",
        "/usr/local/libexec",
      ],
      [
        "sudo",
        "install",
        "-o",
        "root",
        "-g",
        "wheel",
        "-m",
        "0755",
        expect.stringContaining("hack-dns-recovery"),
        "/usr/local/libexec/hack-dns-recovery",
      ],
      [
        "sudo",
        "install",
        "-o",
        "root",
        "-g",
        "wheel",
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
      ["sudo", "-k"],
      ["sudo", "-n", "/usr/local/libexec/hack-dns-recovery", "check"],
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
  expect(sudoersText).toContain("/usr/local/libexec/hack-dns-recovery check");
});

test("global authorize shell-escapes the embedded brew path in the helper", async () => {
  brewExecutablePath = "/tmp/$(touch /tmp/pwned)";

  const { runCli } = await import("../src/cli/run.ts");
  const code = await runCli(["global", "authorize"]);

  expect(code).toBe(0);
  const helperPath = resolve(
    tempDir!,
    GLOBAL_HACK_DIR_NAME,
    "tmp",
    "hack-dns-recovery"
  );
  const helperText = await Bun.file(helperPath).text();
  expect(helperText).toContain(
    "exec '/tmp/$(touch /tmp/pwned)' services restart dnsmasq"
  );
  expect(helperText).toContain(
    "exec '/tmp/$(touch /tmp/pwned)' services stop dnsmasq"
  );
  expect(helperText).not.toContain("brew_path=");
});

test("global authorize refuses insecure helper path ownership", async () => {
  statMetadataByPath.set("/usr/local", "501:20:775");

  const { runCli } = await import("../src/cli/run.ts");
  const code = await runCli(["global", "authorize"]);

  expect(code).toBe(1);
  expect(runCalls).not.toContainEqual([
    "sudo",
    "install",
    "-o",
    "root",
    "-g",
    "wheel",
    "-m",
    "0755",
    expect.stringContaining("hack-dns-recovery"),
    "/usr/local/libexec/hack-dns-recovery",
  ]);
  expect(runCalls).not.toContainEqual([
    "sudo",
    "install",
    "-o",
    "root",
    "-g",
    "wheel",
    "-m",
    "0440",
    expect.stringContaining("dance.hack-dns-recovery.sudoers"),
    "/etc/sudoers.d/dance.hack-dns-recovery",
  ]);
});

test("global authorize creates missing libexec before post-install verification", async () => {
  statMetadataByPath.delete("/usr/local/libexec");
  statMetadataByPath.delete("/usr/local/libexec/hack-dns-recovery");
  runResponder = (cmd) => {
    if (
      cmd.join(" ") ===
      "sudo install -d -o root -g wheel -m 0755 /usr/local/libexec"
    ) {
      statMetadataByPath.set("/usr/local/libexec", "0:0:755");
      return 0;
    }
    if (
      cmd.join(" ") ===
      `sudo install -o root -g wheel -m 0755 ${resolve(
        tempDir!,
        GLOBAL_HACK_DIR_NAME,
        "tmp",
        "hack-dns-recovery"
      )} /usr/local/libexec/hack-dns-recovery`
    ) {
      statMetadataByPath.set("/usr/local/libexec/hack-dns-recovery", "0:0:755");
      return 0;
    }
    return 0;
  };

  const { runCli } = await import("../src/cli/run.ts");
  const code = await runCli(["global", "authorize"]);

  expect(code).toBe(0);
  expect(runCalls).toContainEqual([
    "sudo",
    "install",
    "-d",
    "-o",
    "root",
    "-g",
    "wheel",
    "-m",
    "0755",
    "/usr/local/libexec",
  ]);
  expect(execCalls).toContainEqual([
    "/usr/bin/stat",
    "-f",
    "%u:%g:%Lp",
    "/usr/local/libexec",
  ]);
  expect(execCalls).toContainEqual([
    "/usr/bin/stat",
    "-f",
    "%u:%g:%Lp",
    "/usr/local/libexec/hack-dns-recovery",
  ]);
});

test("global authorize fails when passwordless sudo is still inactive after install", async () => {
  runResponder = (cmd) => {
    if (
      cmd.join(" ") === "sudo -n /usr/local/libexec/hack-dns-recovery check"
    ) {
      return 1;
    }
    return 0;
  };

  const { runCli } = await import("../src/cli/run.ts");
  const code = await runCli(["global", "authorize"]);

  expect(code).toBe(1);
  expect(runCalls).toEqual(
    expect.arrayContaining([
      ["sudo", "-k"],
      ["sudo", "-n", "/usr/local/libexec/hack-dns-recovery", "check"],
    ])
  );
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

test("global up uses the dns recovery helper when it is installed", async () => {
  pathExistsOverrides.set("/usr/local/libexec/hack-dns-recovery", true);
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
    "/usr/local/libexec/hack-dns-recovery",
    "restart-dnsmasq",
  ]);
});

test("global up falls back to brew when the helper restart fails", async () => {
  pathExistsOverrides.set("/usr/local/libexec/hack-dns-recovery", true);
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
  runResponder = (cmd) => {
    if (
      cmd.join(" ") ===
      "sudo -n /usr/local/libexec/hack-dns-recovery restart-dnsmasq"
    ) {
      return 1;
    }
    return 0;
  };

  const { runCli } = await import("../src/cli/run.ts");
  const code = await runCli(["global", "up"]);

  expect(code).toBe(0);
  expect(runCalls).toEqual(
    expect.arrayContaining([
      ["sudo", "-n", "/usr/local/libexec/hack-dns-recovery", "restart-dnsmasq"],
      [
        "sudo",
        "-n",
        "/opt/homebrew/bin/brew",
        "services",
        "restart",
        "dnsmasq",
      ],
    ])
  );
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
    restoreIsTty({ stream: process.stdin, descriptor: stdinDescriptor });
    restoreIsTty({ stream: process.stdout, descriptor: stdoutDescriptor });
  }
});

/**
 * Restores a stubbed isTTY property. When the stream had no own isTTY
 * descriptor before the stub, the stubbed own property must be deleted
 * (skipping the restore would leak the stubbed value into other test files).
 */
function restoreIsTty(opts: {
  readonly stream: NodeJS.ReadStream | NodeJS.WriteStream;
  readonly descriptor: PropertyDescriptor | undefined;
}): void {
  if (opts.descriptor) {
    Object.defineProperty(opts.stream, "isTTY", opts.descriptor);
    return;
  }
  Reflect.deleteProperty(opts.stream, "isTTY");
}

test("global down falls back to brew stop when the dns recovery helper is missing", async () => {
  const { runCli } = await import("../src/cli/run.ts");
  const code = await runCli(["global", "down"]);

  expect(code).toBe(0);
  expect(runCalls).toEqual(
    expect.arrayContaining([
      ["sudo", "-n", "/opt/homebrew/bin/brew", "services", "stop", "dnsmasq"],
    ])
  );
});

test("global down falls back to brew stop when the helper stop fails", async () => {
  pathExistsOverrides.set("/usr/local/libexec/hack-dns-recovery", true);
  runResponder = (cmd) => {
    if (
      cmd.join(" ") ===
        "sudo -n /usr/local/libexec/hack-dns-recovery stop-dnsmasq" ||
      cmd.join(" ") === "sudo /usr/local/libexec/hack-dns-recovery stop-dnsmasq"
    ) {
      return 1;
    }
    return 0;
  };

  const { runCli } = await import("../src/cli/run.ts");
  const code = await runCli(["global", "down"]);

  expect(code).toBe(0);
  expect(runCalls).toEqual(
    expect.arrayContaining([
      ["sudo", "-n", "/usr/local/libexec/hack-dns-recovery", "stop-dnsmasq"],
      ["sudo", "-n", "/opt/homebrew/bin/brew", "services", "stop", "dnsmasq"],
    ])
  );
});

test("global trust prepares host runtime trust env for future shells", async () => {
  const caddyCompose = join(
    tempDir!,
    GLOBAL_HACK_DIR_NAME,
    GLOBAL_CADDY_DIR_NAME,
    GLOBAL_CADDY_COMPOSE_FILENAME
  );
  await writeComposeFile(caddyCompose);

  const localCaPath = join(
    tempDir!,
    GLOBAL_HACK_DIR_NAME,
    GLOBAL_CADDY_DIR_NAME,
    "pki",
    "caddy-local-authority.crt"
  );
  await mkdir(dirname(localCaPath), { recursive: true });
  await writeFile(
    localCaPath,
    "-----BEGIN CERTIFICATE-----\nLOCAL\n-----END CERTIFICATE-----\n"
  );

  execMockResponder = (cmd) => {
    if (
      cmd[0] === "docker" &&
      cmd[1] === "compose" &&
      cmd[2] === "-f" &&
      cmd[4] === "ps"
    ) {
      return { exitCode: 0, stdout: "caddy-123\n", stderr: "" };
    }
    if (
      cmd[0] === "security" &&
      cmd[1] === "find-certificate" &&
      cmd[2] === "-c"
    ) {
      return { exitCode: 0, stdout: "already trusted", stderr: "" };
    }
    if (
      cmd[0] === "security" &&
      cmd[1] === "find-certificate" &&
      cmd[2] === "-a" &&
      cmd[3] === "-p"
    ) {
      return {
        exitCode: 0,
        stdout:
          "-----BEGIN CERTIFICATE-----\nSYSTEM\n-----END CERTIFICATE-----\n",
        stderr: "",
      };
    }
    return null;
  };

  const { runCli } = await import("../src/cli/run.ts");
  const code = await runCli(["global", "trust"]);

  const bundlePath = join(
    tempDir!,
    GLOBAL_HACK_DIR_NAME,
    GLOBAL_CADDY_DIR_NAME,
    "pki",
    "caddy-host-trust-bundle.pem"
  );
  const envScriptPath = join(
    tempDir!,
    GLOBAL_HACK_DIR_NAME,
    GLOBAL_CADDY_DIR_NAME,
    "pki",
    "caddy-host-trust-env.sh"
  );

  expect(code).toBe(0);
  expect(await Bun.file(bundlePath).text()).toContain("LOCAL");
  expect(await Bun.file(bundlePath).text()).toContain("SYSTEM");
  expect(await Bun.file(envScriptPath).text()).toContain("NODE_EXTRA_CA_CERTS");
  expect(execCalls).toEqual(
    expect.arrayContaining([
      [
        "security",
        "find-certificate",
        "-a",
        "-p",
        "/System/Library/Keychains/SystemRootCertificates.keychain",
      ],
    ])
  );
  expect(execCalls).not.toEqual(
    expect.arrayContaining([
      expect.arrayContaining([
        "security",
        "find-certificate",
        "-a",
        "-p",
        "/Library/Keychains/System.keychain",
      ]),
      expect.arrayContaining([
        "security",
        "find-certificate",
        "-a",
        "-p",
        resolve(tempDir!, "Library", "Keychains", "login.keychain-db"),
      ]),
    ])
  );
  expect(runCalls).toEqual(
    expect.arrayContaining([
      [
        "docker",
        "cp",
        "caddy-123:/data/caddy/pki/authorities/local/root.crt",
        localCaPath,
      ],
      ["launchctl", "setenv", "NODE_EXTRA_CA_CERTS", localCaPath],
      ["launchctl", "setenv", "SSL_CERT_FILE", bundlePath],
      ["launchctl", "setenv", "CURL_CA_BUNDLE", bundlePath],
      ["launchctl", "setenv", "REQUESTS_CA_BUNDLE", bundlePath],
      ["launchctl", "setenv", "GIT_SSL_CAINFO", bundlePath],
    ])
  );
});

test("global trust leaves host TLS env unchanged when keychain trust is declined", async () => {
  const caddyCompose = join(
    tempDir!,
    GLOBAL_HACK_DIR_NAME,
    GLOBAL_CADDY_DIR_NAME,
    GLOBAL_CADDY_COMPOSE_FILENAME
  );
  await writeComposeFile(caddyCompose);
  confirmResponder = () => false;

  const localCaPath = join(
    tempDir!,
    GLOBAL_HACK_DIR_NAME,
    GLOBAL_CADDY_DIR_NAME,
    "pki",
    "caddy-local-authority.crt"
  );
  await mkdir(dirname(localCaPath), { recursive: true });
  await writeFile(
    localCaPath,
    "-----BEGIN CERTIFICATE-----\nLOCAL\n-----END CERTIFICATE-----\n"
  );

  execMockResponder = (cmd) => {
    if (
      cmd[0] === "docker" &&
      cmd[1] === "compose" &&
      cmd[2] === "-f" &&
      cmd[4] === "ps"
    ) {
      return { exitCode: 0, stdout: "caddy-123\n", stderr: "" };
    }
    return null;
  };

  const { runCli } = await import("../src/cli/run.ts");
  const code = await runCli(["global", "trust"]);

  const bundlePath = join(
    tempDir!,
    GLOBAL_HACK_DIR_NAME,
    GLOBAL_CADDY_DIR_NAME,
    "pki",
    "caddy-host-trust-bundle.pem"
  );
  const envScriptPath = join(
    tempDir!,
    GLOBAL_HACK_DIR_NAME,
    GLOBAL_CADDY_DIR_NAME,
    "pki",
    "caddy-host-trust-env.sh"
  );

  expect(code).toBe(0);
  expect(await fileExists(bundlePath)).toBe(false);
  expect(await fileExists(envScriptPath)).toBe(false);
  expect(runCalls).toEqual(
    expect.arrayContaining([
      [
        "docker",
        "cp",
        "caddy-123:/data/caddy/pki/authorities/local/root.crt",
        localCaPath,
      ],
    ])
  );
  expect(runCalls).not.toEqual(
    expect.arrayContaining([
      ["launchctl", "setenv", "NODE_EXTRA_CA_CERTS", localCaPath],
    ])
  );
});

test("global trust falls back to an existing exported CA when Caddy is unavailable", async () => {
  const caddyCompose = join(
    tempDir!,
    GLOBAL_HACK_DIR_NAME,
    GLOBAL_CADDY_DIR_NAME,
    GLOBAL_CADDY_COMPOSE_FILENAME
  );
  await writeComposeFile(caddyCompose);

  const localCaPath = join(
    tempDir!,
    GLOBAL_HACK_DIR_NAME,
    GLOBAL_CADDY_DIR_NAME,
    "pki",
    "caddy-local-authority.crt"
  );
  await mkdir(dirname(localCaPath), { recursive: true });
  await writeFile(
    localCaPath,
    "-----BEGIN CERTIFICATE-----\nLOCAL\n-----END CERTIFICATE-----\n"
  );

  execMockResponder = (cmd) => {
    if (cmd[0] === "docker" && cmd[1] === "info") {
      return { exitCode: 1, stdout: "", stderr: "down" };
    }
    if (
      cmd[0] === "security" &&
      cmd[1] === "find-certificate" &&
      cmd[2] === "-c"
    ) {
      return { exitCode: 0, stdout: "already trusted", stderr: "" };
    }
    if (
      cmd[0] === "security" &&
      cmd[1] === "find-certificate" &&
      cmd[2] === "-a" &&
      cmd[3] === "-p"
    ) {
      return {
        exitCode: 0,
        stdout:
          "-----BEGIN CERTIFICATE-----\nSYSTEM\n-----END CERTIFICATE-----\n",
        stderr: "",
      };
    }
    return null;
  };

  const { runCli } = await import("../src/cli/run.ts");
  const code = await runCli(["global", "trust"]);

  const bundlePath = join(
    tempDir!,
    GLOBAL_HACK_DIR_NAME,
    GLOBAL_CADDY_DIR_NAME,
    "pki",
    "caddy-host-trust-bundle.pem"
  );
  const envScriptPath = join(
    tempDir!,
    GLOBAL_HACK_DIR_NAME,
    GLOBAL_CADDY_DIR_NAME,
    "pki",
    "caddy-host-trust-env.sh"
  );

  expect(code).toBe(0);
  expect(await Bun.file(bundlePath).text()).toContain("LOCAL");
  expect(await Bun.file(bundlePath).text()).toContain("SYSTEM");
  expect(await Bun.file(envScriptPath).text()).toContain("NODE_EXTRA_CA_CERTS");
  expect(runCalls).toEqual(
    expect.arrayContaining([
      ["launchctl", "setenv", "NODE_EXTRA_CA_CERTS", localCaPath],
      ["launchctl", "setenv", "SSL_CERT_FILE", bundlePath],
    ])
  );
  expect(runCalls).not.toEqual(
    expect.arrayContaining([expect.arrayContaining(["docker", "cp"])])
  );
});
