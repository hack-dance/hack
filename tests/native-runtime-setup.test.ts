import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveNativeHome } from "../src/backends/native-runtime-client.ts";
import { parseNativeSetupInspection } from "../src/backends/native-runtime-setup.ts";
import { nativeSetupInspection } from "./helpers/native-setup-inspection.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

const roots: string[] = [];
const entrypoint = resolve("index.ts");
const SENTINEL = "synthetic-setup-project-value-must-not-be-in-child";
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "native-first-use-"))
  );
  roots.push(root);
  const home = join(root, "native-home");
  const binary = join(root, "native-executor");
  const calls = join(root, "calls");
  const result = '{"status":"installed","files":[]}\n';
  await writeFile(
    binary,
    `#!${process.execPath}
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = Bun.argv.slice(2);
const home = args[1];
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args.slice(2)) + "\\n");
if (args.includes("inspect")) {
  const reply = ${JSON.stringify(nativeSetupInspection())};
  reply.state = reply.installation_state = existsSync(join(home, "installed")) ? "ready" : existsSync(home) ? "partial_resumable" : "not_set_up";
  reply.code = reply.state === "ready" ? "native_setup_ready" : "E_NATIVE_SETUP_REQUIRED";
  console.log(JSON.stringify(reply));
} else if (args[2] === "runtime" && args[3] === "setup") {
  if (process.env.SETUP_PROJECT_SENTINEL || process.env.HACK_ENV_SECRET_KEY) process.exit(91);
  mkdirSync(home, { mode: 0o700, recursive: true });
  if (existsSync(${JSON.stringify(join(root, "interrupt-setup"))})) {
    mkdirSync(join(home, ".hack-local/setup/downloads"), { mode: 0o700, recursive: true });
    writeFileSync(join(home, ".hack-local/setup/downloads/provider.part"), "prefix");
    process.stderr.write("fixture-download-started\\n");
    await Bun.sleep(60_000);
    process.exit(93);
  }
  if (existsSync(${JSON.stringify(join(root, "child-signal"))})) { process.kill(process.pid, "SIGTERM"); await Bun.sleep(60_000); }
  writeFileSync(join(home, "installed"), "fixture");
  process.stdout.write(${JSON.stringify(result)});
} else { process.exit(92); }
`
  );
  await chmod(binary, 0o700);
  const env = privateCliEnv({
    root,
    env: {
      HACK_RUNTIME_BACKEND: "native",
      HACK_NATIVE_BINARY: binary,
      HACK_NATIVE_HOME: home,
      SETUP_PROJECT_SENTINEL: SENTINEL,
    },
  });
  async function cli(args: string[]) {
    const child = Bun.spawn([process.execPath, entrypoint, ...args], {
      cwd: root,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(stdout + stderr).not.toContain(SENTINEL);
    return { stdout, stderr, exitCode };
  }
  return { root, home, calls, cli, result, env };
}

test("explicit and isolated default native homes are deterministic without creating directories", () => {
  expect(resolveNativeHome({ HOME: "/user" })).toBe(
    "/user/.hack/native-runtime"
  );
  expect(resolveNativeHome({ HOME: "/user", HACK_HOME: " /isolated " })).toBe(
    "/isolated/native-runtime"
  );
  expect(
    resolveNativeHome({
      HACK_NATIVE_HOME: " /explicit ",
      HACK_HOME: "relative",
    })
  ).toBe("/explicit");
  expect(() => resolveNativeHome({ HACK_NATIVE_HOME: "relative" })).toThrow(
    "absolute"
  );
  expect(() => resolveNativeHome({ HACK_HOME: "relative" })).toThrow(
    "absolute"
  );
});

test("setup inspection rejects old, unknown or contradictory readiness replies", () => {
  expect(parseNativeSetupInspection(nativeSetupInspection()).state).toBe(
    "ready"
  );
  for (const value of [
    {},
    { ...nativeSetupInspection(), protocol_version: 2 },
    { ...nativeSetupInspection(), state: "future" },
    { ...nativeSetupInspection(), supported_host: false },
    {
      ...nativeSetupInspection(),
      pins: [
        {
          url: "https://user:secret@example.invalid/file",
          size_bytes: 5,
          archive_sha256: "a".repeat(64),
        },
      ],
    },
  ]) {
    expect(() => parseNativeSetupInspection(value)).toThrow();
  }
});

test("fresh foreground/detached/JSON up refuses before startup with the setup sentence", async () => {
  const f = await fixture();
  for (const options of [[], ["-d"], ["--json"]]) {
    const reply = await f.cli(["up", ...options]);
    expect(reply.exitCode).toBe(1);
    expect(reply.stdout + reply.stderr).toContain(
      "Native runtime is not set up; run hack native setup."
    );
    expect(reply.stdout + reply.stderr).not.toContain("provider_state");
    if (options.includes("--json")) {
      expect(JSON.parse(reply.stdout).error.code).toBe(
        "E_NATIVE_SETUP_REQUIRED"
      );
    }
    expect(existsSync(f.home)).toBe(false);
  }
  const calls = (await readFile(f.calls, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(calls).toEqual(
    new Array(3).fill(["runtime", "setup", "inspect", "--json"])
  );
}, 90_000);

test("noninteractive setup requires consent; accepted JSON passes through and up passes the gate", async () => {
  const f = await fixture();
  const refused = await f.cli(["native", "setup", "--json"]);
  expect(refused.exitCode).toBe(1);
  expect(JSON.parse(refused.stdout).error.code).toBe("E_INTERACTIVE_REQUIRED");
  expect(existsSync(f.home)).toBe(false);
  const installed = await f.cli([
    "native",
    "setup",
    "--accept-downloads",
    "--json",
  ]);
  expect(installed.exitCode).toBe(0);
  expect(installed.stdout).toBe(f.result);
  expect(installed.stderr).toContain("5 bytes");
  expect(installed.stderr).toContain("a".repeat(64));
  const up = await f.cli(["up"]);
  expect(up.exitCode).toBe(1);
  expect(up.stdout + up.stderr).not.toContain("E_NATIVE_SETUP_REQUIRED");
  // No project exists: reaching project resolution proves the install gate passed.
  expect(up.stdout + up.stderr).toContain("E_PROJECT_NOT_FOUND");
}, 90_000);

test("preflight JSON reports missing runtime as its own blocker", async () => {
  const f = await fixture();
  const projectDir = join(f.root, ".hack");
  await mkdir(projectDir);
  await writeFile(
    join(projectDir, "docker-compose.yml"),
    "services:\n  web:\n    image: alpine:3\n"
  );
  await writeFile(join(projectDir, "hack.config.json"), '{"name":"first-use"}');
  const report = await f.cli(["doctor", "--native-preflight", "--json"]);
  expect(report.exitCode).toBe(1);
  const data = JSON.parse(report.stdout).data;
  expect(data.ready).toBe(false);
  expect(data.runtime_setup.state).toBe("not_set_up");
  expect(data.runtime_setup.code).toBe("E_NATIVE_SETUP_REQUIRED");
  expect(data.runtime_setup.fix).toContain("hack native setup");
  expect(
    data.blockers.some(
      (found: { code: string }) => found.code === "native_runtime_setup"
    )
  ).toBe(true);
}, 90_000);

test("interactive up asks once, forwards interruption and retains resumable inputs without starting", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "interrupt-setup"), "interrupt this fixture");
  let output = "";
  let answered = false;
  let interrupted = false;
  let cancel: (() => void) | undefined;
  const terminal = new Bun.Terminal({
    cols: 120,
    rows: 40,
    data(tty, bytes) {
      output += new TextDecoder().decode(bytes);
      if (!answered && output.includes("then continue hack up?")) {
        answered = true;
        tty.write("y\r");
      }
      if (!interrupted && output.includes("fixture-download-started")) {
        interrupted = true;
        cancel?.();
      }
    },
  });
  try {
    const child = Bun.spawn([process.execPath, entrypoint, "up"], {
      cwd: f.root,
      env: { ...f.env, HACK_NO_INTERACTIVE: "0" },
      terminal,
      timeout: 30_000,
    });
    cancel = () => child.kill("SIGINT");
    expect(await child.exited).toBe(130);
    expect(answered && interrupted).toBe(true);
    const calls = (await readFile(f.calls, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls).toEqual([
      ["runtime", "setup", "inspect", "--json"],
      ["runtime", "setup", "--no-interactive", "--accept-downloads"],
    ]);
    expect(
      await readFile(
        join(f.home, ".hack-local/setup/downloads/provider.part"),
        "utf8"
      )
    ).toBe("prefix");
    expect(existsSync(join(f.home, "installed"))).toBe(false);
    const preflight = await f.cli(["up", "--json"]);
    expect(preflight.stdout).toContain("setup is incomplete");
    expect(preflight.stdout).not.toContain("provider_state");
  } finally {
    terminal.close();
  }
}, 40_000);

test("human setup prints a summary and a ready inspection does not grant download consent", async () => {
  const f = await fixture();
  const installed = await f.cli(["native", "setup", "--accept-downloads"]);
  expect(installed.exitCode).toBe(0);
  expect(installed.stdout).toBe("Native runtime is set up.\n");
  const reused = await f.cli(["native", "setup", "--json"]);
  expect(reused.exitCode).toBe(0);
  expect(reused.stderr).toBe("");
  expect(reused.stdout).toBe(f.result);
  const calls = (await readFile(f.calls, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(calls.at(-1)).toEqual([
    "runtime",
    "setup",
    "--no-interactive",
    "--json",
  ]);
}, 30_000);

test("a signaled setup child propagates its signal status", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "child-signal"), "terminate this fixture child");
  const result = await f.cli([
    "native",
    "setup",
    "--accept-downloads",
    "--json",
  ]);
  expect(result.exitCode).toBe(143);
  expect(existsSync(join(f.home, "installed"))).toBe(false);
}, 30_000);
