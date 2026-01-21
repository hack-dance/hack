import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  DEFAULT_INGRESS_NETWORK,
  DEFAULT_LOGGING_NETWORK,
  GLOBAL_CADDY_COMPOSE_FILENAME,
  GLOBAL_CADDY_DIR_NAME,
  GLOBAL_HACK_DIR_NAME,
  GLOBAL_LOGGING_COMPOSE_FILENAME,
  GLOBAL_LOGGING_DIR_NAME,
} from "../src/constants.ts";

let tempDir: string | null = null;
let originalHome: string | undefined;
let originalLogger: string | undefined;
const execCalls: string[][] = [];
const runCalls: string[][] = [];
let execMockResponder:
  | ((
      cmd: readonly string[]
    ) => { exitCode: number; stdout: string; stderr: string } | null)
  | null = null;

mock.module("../src/lib/shell.ts", () => ({
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
    return 0;
  },
  findExecutableInPath: async (name?: string) =>
    name === "hack" ? "/usr/local/bin/hack" : "/usr/bin/mkcert",
}));

mock.module("../src/lib/os.ts", () => ({
  isMac: () => false,
  openUrl: async () => 0,
}));

beforeEach(async () => {
  originalHome = process.env.HOME;
  originalLogger = process.env.HACK_LOGGER;
  tempDir = await mkdtemp(join(tmpdir(), "hack-global-"));
  process.env.HOME = tempDir;
  process.env.HACK_LOGGER = "console";
  execCalls.length = 0;
  runCalls.length = 0;
  execMockResponder = null;
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
  process.env.HOME = originalHome;
  process.env.HACK_LOGGER = originalLogger;
});

async function writeComposeFile(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "services: {}\n");
}

test("global up runs docker compose up for caddy and logging", async () => {
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
    runCalls.some((call) => call.includes(caddyCompose) && call.includes("up"))
  ).toBe(true);
  expect(
    runCalls.some(
      (call) => call.includes(loggingCompose) && call.includes("up")
    )
  ).toBe(true);
});

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

test("global up fails when compose files are missing", async () => {
  const { runCli } = await import("../src/cli/run.ts");
  const code = await runCli(["global", "up"]);
  expect(code).toBe(1);
});

test("global install writes compose files and starts stacks", async () => {
  const gumPath = join(tempDir!, GLOBAL_HACK_DIR_NAME, "bin", "gum");
  await writeComposeFile(gumPath);
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

  expect(hasCaddy).toBe(true);
  expect(hasLogging).toBe(true);
  expect(
    runCalls.some((call) => call.includes(caddyCompose) && call.includes("up"))
  ).toBe(true);
  expect(
    runCalls.some(
      (call) => call.includes(loggingCompose) && call.includes("up")
    )
  ).toBe(true);
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
