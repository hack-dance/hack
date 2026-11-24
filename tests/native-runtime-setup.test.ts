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
const BUILDER_PIN = {
  url: "https://example.invalid/builder.bin",
  size_bytes: 7,
  archive_sha256: "b".repeat(64),
};
const BUILDER_PATHS = {
  directory: ".hack-local/providers/builder-1.0.0",
  record: ".hack-local/providers/builder.json",
};
const BUILDER_HINT =
  "The image builder is not installed, so native up cannot build images yet. Run hack native setup --accept-downloads to add it; offline, add --builder <pinned builder file> to the offline setup inputs.\n";
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
if (args[0]?.startsWith("--internal-timings=")) args.shift();
const home = args[1];
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args.slice(2)) + "\\n");
if (args.includes("inspect")) {
  const reply = ${JSON.stringify(nativeSetupInspection())};
  reply.state = reply.installation_state = existsSync(join(home, "installed")) ? "ready" : existsSync(home) ? "partial_resumable" : "not_set_up";
  reply.code = reply.state === "ready" ? "native_setup_ready" : "E_NATIVE_SETUP_REQUIRED";
  if (existsSync(${JSON.stringify(join(root, "report-builder"))})) {
    reply.pins.push(${JSON.stringify(BUILDER_PIN)});
    // Record-level, as the runtime's inspection is: a builder whose bytes changed
    // still reads as prepared here.
    reply.builder = { state: existsSync(join(home, "builder")) ? "prepared" : "not_prepared", file: "builder.bin", ...(existsSync(${JSON.stringify(join(root, "builder-without-paths"))}) ? {} : ${JSON.stringify(BUILDER_PATHS)}) };
  }
  console.log(JSON.stringify(reply));
} else if (args[2] === "runtime" && args[3] === "setup") {
  if (process.env.SETUP_PROJECT_SENTINEL || process.env.HACK_ENV_SECRET_KEY) process.exit(91);
  mkdirSync(home, { mode: 0o700, recursive: true });
  // What the run does about the builder: a changed one is reported and never replaced.
  const changed = existsSync(${JSON.stringify(join(root, "builder-changed"))});
  const had = existsSync(join(home, "builder"));
  const adds = !changed && !had && (args.includes("--accept-downloads") || args.includes("--builder"));
  if (adds) writeFileSync(join(home, "builder"), "fixture");
  if (existsSync(${JSON.stringify(join(root, "interrupt-setup"))})) {
    mkdirSync(join(home, ".hack-local/setup/downloads"), { mode: 0o700, recursive: true });
    writeFileSync(join(home, ".hack-local/setup/downloads/provider.part"), "prefix");
    process.stderr.write("fixture-download-started\\n");
    await Bun.sleep(60_000);
    process.exit(93);
  }
  if (existsSync(${JSON.stringify(join(root, "child-signal"))})) { process.kill(process.pid, "SIGTERM"); await Bun.sleep(60_000); }
  writeFileSync(join(home, "installed"), "fixture");
  const result = JSON.parse(${JSON.stringify(result)});
  if (existsSync(${JSON.stringify(join(root, "report-builder"))})) {
    result.builder = changed ? "changed" : adds ? "installed" : had ? "reused" : "not_prepared";
  }
  process.stdout.write(JSON.stringify(result) + "\\n");
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

test("setup inspection reports the image builder apart from readiness", () => {
  const reply = (builder: unknown) => ({
    ...nativeSetupInspection(),
    pins: [...nativeSetupInspection().pins, BUILDER_PIN],
    builder,
  });
  const named = { file: "builder.bin", ...BUILDER_PATHS };
  // A runtime that does not report the builder is still a ready runtime.
  expect(
    parseNativeSetupInspection(nativeSetupInspection()).builder
  ).toBeUndefined();
  for (const state of ["prepared", "not_prepared", "changed"] as const) {
    const inspection = parseNativeSetupInspection(reply({ state, ...named }));
    // The builder never changes readiness, and its pin is one of the listed pins.
    expect(inspection.state).toBe("ready");
    expect(inspection.pins).toHaveLength(2);
    expect(inspection.builder).toEqual({
      state,
      pin: BUILDER_PIN,
      paths: BUILDER_PATHS,
    });
    // A runtime that reports the builder's state without its paths, or with
    // only one of them, is still read: the state is kept and no path is.
    for (const partial of [
      { state, file: "builder.bin" },
      { state, file: "builder.bin", record: BUILDER_PATHS.record },
      { state, file: "builder.bin", directory: BUILDER_PATHS.directory },
    ]) {
      expect(parseNativeSetupInspection(reply(partial)).builder).toEqual({
        state,
        pin: BUILDER_PIN,
      });
    }
  }
  for (const builder of [
    null,
    "prepared",
    { ...named, state: "future" },
    { state: "prepared" },
    { ...named, state: "prepared", file: "not-a-listed-pin" },
    // A supplied path is one name under the runtime's providers directory,
    // nothing else, also when the other path is omitted.
    {
      state: "prepared",
      file: "builder.bin",
      record: "/absolute/builder.json",
    },
    { state: "prepared", file: "builder.bin", directory: 7 },
    { ...named, state: "prepared", directory: "/absolute/builder-1.0.0" },
    { ...named, state: "prepared", record: ".hack-local/providers/../x" },
    { ...named, state: "prepared", record: ".hack-local/providers/a/b" },
    { ...named, state: "prepared", directory: "builder-1.0.0" },
  ]) {
    expect(() => parseNativeSetupInspection(reply(builder))).toThrow(
      "Invalid native setup builder."
    );
  }
});

test("fresh foreground and detached up show a setup blocker and preserve the JSON refusal", async () => {
  const f = await fixture();
  for (const options of [[], ["-d"], ["--json"]]) {
    const reply = await f.cli(["up", ...options]);
    expect(reply.exitCode).toBe(1);
    expect(reply.stdout + reply.stderr).not.toContain("provider_state");
    if (options.includes("--json")) {
      expect(JSON.parse(reply.stdout).error).toMatchObject({
        code: "E_NATIVE_SETUP_REQUIRED",
        message: "Native runtime is not set up; run hack native setup.",
      });
    } else {
      expect(reply.stderr).toEndWith(
        "! native runtime  setup required\n  this start needs the native runtime. run:\n  hack native setup --accept-downloads\n"
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
  expect(up.stderr).toContain(
    "! project  E_PROJECT_NOT_FOUND: No .hack/ (or legacy .dev/) found."
  );
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

test("a set-up home without the image builder gains it only with consent", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "report-builder"), "the runtime reports it");
  // A home an older build set up: ready, and no image builder.
  await mkdir(f.home, { mode: 0o700 });
  await writeFile(join(f.home, "installed"), "fixture");

  // Without consent setup succeeds as before, downloads nothing and says in
  // one line how to add the builder.
  const plain = await f.cli(["native", "setup"]);
  expect(plain.exitCode).toBe(0);
  expect(plain.stdout).toBe(`Native runtime is set up.\n${BUILDER_HINT}`);
  expect(plain.stderr).not.toContain("Pinned downloads");
  expect(existsSync(join(f.home, "builder"))).toBe(false);
  // JSON stays the runtime's result alone; its `builder` field carries the state.
  const json = await f.cli(["native", "setup", "--json"]);
  expect(json.exitCode).toBe(0);
  expect(json.stdout).toBe(
    '{"status":"installed","files":[],"builder":"not_prepared"}\n'
  );
  expect(json.stderr).toBe("");
  expect(existsSync(join(f.home, "builder"))).toBe(false);

  // With consent the preview lists the builder alone: nothing else downloads.
  const accepted = await f.cli(["native", "setup", "--accept-downloads"]);
  expect(accepted.exitCode).toBe(0);
  expect(accepted.stdout).toBe("Native runtime is set up.\n");
  expect(accepted.stderr).toContain("Pinned downloads");
  expect(accepted.stderr).toContain(
    `builder.bin: 7 bytes; source example.invalid; SHA-256 ${"b".repeat(64)}`
  );
  expect(accepted.stderr).not.toContain("provider.tgz");
  expect(existsSync(join(f.home, "builder"))).toBe(true);

  // A home that has everything is shown and told nothing more.
  const complete = await f.cli(["native", "setup", "--accept-downloads"]);
  expect(complete.exitCode).toBe(0);
  expect(complete.stdout).toBe("Native runtime is set up.\n");
  expect(complete.stderr).not.toContain("Pinned downloads");
  const calls = (await readFile(f.calls, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const inspect = ["runtime", "setup", "inspect", "--json"];
  expect(calls).toEqual([
    inspect,
    ["runtime", "setup", "--no-interactive"],
    inspect,
    ["runtime", "setup", "--no-interactive", "--json"],
    inspect,
    ["runtime", "setup", "--no-interactive", "--accept-downloads"],
    inspect,
    ["runtime", "setup", "--no-interactive", "--accept-downloads"],
  ]);
}, 60_000);

test("a fresh home is shown the image builder with the other pinned downloads", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "report-builder"), "the runtime reports it");
  const installed = await f.cli(["native", "setup", "--accept-downloads"]);
  expect(installed.exitCode).toBe(0);
  expect(installed.stderr).toContain("provider.tgz: 5 bytes");
  expect(installed.stderr).toContain("builder.bin: 7 bytes");
  // Setup installed the builder with the rest: no hint.
  expect(installed.stdout).toBe("Native runtime is set up.\n");
}, 30_000);

test("the offline builder file joins the offline inputs and is refused alone", async () => {
  const f = await fixture();
  const alone = await f.cli(["native", "setup", "--builder", "/input/builder"]);
  expect(alone.exitCode).toBe(1);
  expect(alone.stdout + alone.stderr).toContain(
    "--builder adds the pinned image builder file to them"
  );
  expect(existsSync(f.calls)).toBe(false);
  const offline = [
    "--archive",
    "/input/provider",
    "--engine-archive",
    "/input/engine",
    "--network-tools-directory",
    "/input/packages",
  ];
  await writeFile(join(f.root, "report-builder"), "the runtime reports it");
  // Without the builder file the request is the one offline setup always sent,
  // and the summary says that the home has no image builder.
  const without = await f.cli(["native", "setup", ...offline]);
  expect(without.exitCode).toBe(0);
  expect(without.stdout).toBe(`Native runtime is set up.\n${BUILDER_HINT}`);
  expect(existsSync(join(f.home, "builder"))).toBe(false);
  // The same inputs with the builder file add it to the home that is now set up.
  const withBuilder = await f.cli([
    "native",
    "setup",
    ...offline,
    "--builder",
    "/input/builder",
  ]);
  expect(withBuilder.exitCode).toBe(0);
  expect(withBuilder.stdout).toBe("Native runtime is set up.\n");
  expect(withBuilder.stderr).not.toContain("Pinned downloads");
  expect(existsSync(join(f.home, "builder"))).toBe(true);
  const calls = (await readFile(f.calls, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(calls.filter((call) => !call.includes("inspect"))).toEqual([
    ["runtime", "setup", "--no-interactive", ...offline],
    [
      "runtime",
      "setup",
      "--no-interactive",
      ...offline,
      "--builder",
      "/input/builder",
    ],
  ]);
}, 60_000);

test("a builder that does not match the pin is a warning, never a failed setup", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "report-builder"), "the runtime reports it");
  // A complete home whose builder's bytes changed: the record-level inspection
  // still reads it as prepared, and only the setup run finds out.
  await mkdir(f.home, { mode: 0o700 });
  await writeFile(join(f.home, "installed"), "fixture");
  await writeFile(join(f.home, "builder"), "changed bytes");
  await writeFile(join(f.root, "builder-changed"), "the run reports it");
  const warning =
    "WARN: Setup found that the image builder in this native home does not match the pinned release, so image builds are refused until it is replaced. Setup left it as it is. Remove .hack-local/providers/builder-1.0.0 and .hack-local/providers/builder.json from the native home, then run hack native setup --accept-downloads.\n";

  // With and without consent, and offline with the builder file: setup succeeds,
  // says what to do in one line, and never replaces the builder.
  for (const flags of [
    [],
    ["--accept-downloads"],
    [
      "--archive",
      "/input/provider",
      "--engine-archive",
      "/input/engine",
      "--network-tools-directory",
      "/input/packages",
      "--builder",
      "/input/builder",
    ],
  ]) {
    const run = await f.cli(["native", "setup", ...flags]);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe("Native runtime is set up.\n");
    expect(run.stderr).toContain(warning);
    expect(run.stderr.split("WARN:")).toHaveLength(2);
    expect(run.stderr).not.toContain("Pinned downloads");
    expect(await readFile(join(f.home, "builder"), "utf8")).toBe(
      "changed bytes"
    );
  }
  // JSON stays the runtime's result alone.
  const json = await f.cli(["native", "setup", "--json"]);
  expect(json.exitCode).toBe(0);
  expect(json.stdout).toBe(
    '{"status":"installed","files":[],"builder":"changed"}\n'
  );
  expect(json.stderr).toBe("");
}, 60_000);

test("a runtime that reports the builder without its paths still sets up, with the remedy that names no paths", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "report-builder"), "the runtime reports it");
  await writeFile(join(f.root, "builder-without-paths"), "state and file only");
  await mkdir(f.home, { mode: 0o700 });
  await writeFile(join(f.home, "installed"), "fixture");

  // The inspection is accepted, so setup runs and says how to add the builder.
  const missing = await f.cli(["native", "setup"]);
  expect(missing.exitCode).toBe(0);
  expect(missing.stdout).toBe(`Native runtime is set up.\n${BUILDER_HINT}`);
  expect(missing.stdout + missing.stderr).not.toContain(
    "Unsupported native setup inspection"
  );
  expect(missing.stdout + missing.stderr).not.toContain(
    "Invalid native setup builder"
  );

  // A changed builder is still a warning; without the paths it says where the
  // directory and record are instead of naming them.
  await writeFile(join(f.home, "builder"), "changed bytes");
  await writeFile(join(f.root, "builder-changed"), "the run reports it");
  const changed = await f.cli(["native", "setup"]);
  expect(changed.exitCode).toBe(0);
  expect(changed.stdout).toBe("Native runtime is set up.\n");
  expect(changed.stderr).toContain(
    "WARN: Setup found that the image builder in this native home does not match the pinned release, so image builds are refused until it is replaced. Setup left it as it is. Remove the image builder's directory and record from .hack-local/providers in the native home, then run hack native setup --accept-downloads.\n"
  );
  expect(changed.stderr).not.toContain("builder-1.0.0");
  const calls = (await readFile(f.calls, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(calls.filter((call) => !call.includes("inspect"))).toEqual([
    ["runtime", "setup", "--no-interactive"],
    ["runtime", "setup", "--no-interactive"],
  ]);
}, 60_000);
