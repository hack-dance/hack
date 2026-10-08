import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  assertTestConfigCompiler,
  resolveTestConfigCompilerBinary,
} from "../scripts/check-test-config-compiler.ts";
import { isRecord } from "../src/lib/guards.ts";

const ROOT = resolve(import.meta.dir, "..");
const PROTOCOL = {
  transport_version: 1,
  authored_version: 1,
  plan_version: 1,
  resolve_version: 1,
  local_version: 1,
  env_plan_version: 1,
  host_env_plan_version: 1,
  routing_plan_version: 1,
  endpoint_plan_version: 1,
  process_plan_version: 1,
  acquisition_plan_version: 1,
  network_plan_version: 1,
  file_plan_version: 1,
};
const SUCCESS = {
  transport_version: 1,
  ok: true,
  plan: {
    plan_version: 1,
    name: "hack-test-preflight",
    services: {},
    jobs: {},
  },
  declared_workloads: {},
  semantic_hash: "a".repeat(64),
};
let directory = "";
const children: Bun.Subprocess<"ignore", "pipe", "pipe">[] = [];
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "hack-test-preflight-"));
});
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
    }
    await child.exited;
  }
  await rm(directory, { recursive: true, force: true });
});

async function compiler(
  opts: {
    readonly protocol?: Readonly<Record<string, unknown>>;
    readonly response?: unknown;
    readonly body?: string;
  } = {}
): Promise<string> {
  const binary = join(directory, "compiler");
  const body =
    opts.body ??
    `if (process.argv[2] === '--protocol') console.log(${JSON.stringify(JSON.stringify(opts.protocol ?? PROTOCOL))}); else { await Bun.write(${JSON.stringify(join(directory, "received"))}, JSON.stringify({input:await Bun.stdin.text(),env:Object.keys(process.env)})); console.log(${JSON.stringify(JSON.stringify(opts.response ?? SUCCESS))}); }`;
  await Bun.write(binary, `#!${process.execPath}\n${body}\n`);
  await chmod(binary, 0o755);
  return binary;
}

test("uses caller selection and sends only fixed input with no caller environment", async () => {
  const binary = await compiler();
  expect(resolveTestConfigCompilerBinary({ override: binary })).toBe(binary);
  await assertTestConfigCompiler({ binary });
  const receipt: unknown = await Bun.file(join(directory, "received")).json();
  expect(receipt).toEqual({
    input: '{"schema_version":1,"name":"hack-test-preflight"}',
    env: ["PATH"],
  });
});

test.each(
  Object.keys(PROTOCOL)
)("requires current %s before synthetic input delivery", async (field) => {
  const binary = await compiler({ protocol: { ...PROTOCOL, [field]: 99 } });
  await expect(assertTestConfigCompiler({ binary })).rejects.toThrow(
    "Compiler prerequisite failed"
  );
  expect(await Bun.file(join(directory, "received")).exists()).toBe(false);
});

test.each([
  "missing",
  "non-executable",
  "wrong-loader",
  "directory",
])("refuses %s without selecting another compiler", async (kind) => {
  const binary = join(directory, "compiler");
  if (kind === "directory") {
    await mkdir(binary);
  } else if (kind === "non-executable") {
    await compiler();
    await chmod(binary, 0o600);
  } else if (kind === "wrong-loader") {
    await Bun.write(binary, "#!/nonexistent-architecture-loader\n");
    await chmod(binary, 0o755);
  }
  await expect(assertTestConfigCompiler({ binary })).rejects.toThrow(
    "never replaced by a fallback"
  );
  expect(await Bun.file(join(directory, "received")).exists()).toBe(false);
});

test("rejects relative explicit paths and a malformed usable protocol response", async () => {
  expect(() =>
    resolveTestConfigCompilerBinary({ override: "relative" })
  ).toThrow("absolute");
  const binary = await compiler({
    response: { ...SUCCESS, plan: { ...SUCCESS.plan, name: "wrong-project" } },
  });
  await expect(assertTestConfigCompiler({ binary })).rejects.toThrow(
    "Compiler prerequisite failed"
  );
});

test("pre-cancellation launches no compiler", async () => {
  const binary = await compiler({
    body: `await Bun.write(${JSON.stringify(join(directory, "spawned"))},'spawned');`,
  });
  const controller = new AbortController();
  controller.abort();
  await expect(
    assertTestConfigCompiler({ binary, signal: controller.signal })
  ).rejects.toThrow("Compiler prerequisite failed");
  expect(await Bun.file(join(directory, "spawned")).exists()).toBe(false);
});

async function waitForPid(path: string): Promise<number> {
  const deadline = Date.now() + 5000;
  while (!(await Bun.file(path).exists())) {
    if (Date.now() >= deadline) {
      throw new Error("Synthetic compiler did not start");
    }
    await Bun.sleep(10);
  }
  const pid = Number(await Bun.file(path).text());
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error("Invalid synthetic compiler identity");
  }
  return pid;
}

test("timeout reaps the owned compiler and never emits its output", async () => {
  const pidPath = join(directory, "pid");
  const binary = await compiler({
    body: `await Bun.write(${JSON.stringify(pidPath)},String(process.pid)); console.error('private-compiler-output'); await Bun.sleep(10000);`,
  });
  const pending = assertTestConfigCompiler({ binary, timeoutMs: 500 });
  const rejected = expect(pending).rejects.toThrow(
    "Compiler prerequisite failed"
  );
  const pid = await waitForPid(pidPath);
  await rejected;
  expect(() => process.kill(pid, 0)).toThrow();
}, 15_000);

async function suiteFixture(): Promise<void> {
  await mkdir(join(directory, "node_modules/turbo/bin"), { recursive: true });
  await mkdir(join(directory, "node_modules/.bin"));
  await mkdir(join(directory, "packages/cli"), { recursive: true });
  await mkdir(join(directory, "tests"));
  await symlink(join(ROOT, "scripts"), join(directory, "scripts"));
  const pkg: unknown = await Bun.file(join(ROOT, "package.json")).json();
  const cli: unknown = await Bun.file(
    join(ROOT, "packages/cli/package.json")
  ).json();
  if (!(isRecord(pkg) && isRecord(cli))) {
    throw new Error("Missing suite entry points");
  }
  await Bun.write(join(directory, "package.json"), JSON.stringify(pkg));
  await Bun.write(
    join(directory, "packages/cli/package.json"),
    JSON.stringify(cli)
  );
  const marker = join(directory, "suite-launched");
  const turbo = join(directory, "node_modules/turbo/bin/turbo");
  await Bun.write(
    turbo,
    `#!${process.execPath}\nawait Bun.write(${JSON.stringify(marker)},'turbo');\n`
  );
  await chmod(turbo, 0o755);
  await Bun.write(
    join(directory, "node_modules/turbo/package.json"),
    JSON.stringify({
      name: "turbo",
      version: "0.0.0",
      bin: { turbo: "bin/turbo" },
    })
  );
  await symlink(
    "../turbo/bin/turbo",
    join(directory, "node_modules/.bin/turbo")
  );
  await Bun.write(
    join(directory, "tests/suite.test.ts"),
    `import {test} from 'bun:test'; test('synthetic suite',async()=>{await Bun.write(${JSON.stringify(marker)},'cli');});\n`
  );
}

async function runSuite(opts: {
  readonly command: readonly string[];
  readonly binary: string;
}) {
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", ...opts.command],
    {
      cwd: directory,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        PATH: `${resolve(process.execPath, "..")}:/usr/bin:/bin`,
        HACK_CONFIG_COMPILER_BINARY: opts.binary,
      },
    }
  );
  children.push(child);
  const timer = setTimeout(() => child.kill("SIGTERM"), 15_000);
  try {
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, exit };
  } finally {
    clearTimeout(timer);
  }
}

const ENTRYPOINTS = [
  ["root test", ["run", "test"]],
  ["direct Turbo test", ["run", "turbo:test"]],
  ["CLI package test", ["run", "--cwd", "packages/cli", "test"]],
] as const;
test.each(ENTRYPOINTS)(
  "suite %s refuses missing compiler before launch",
  async (_name, command) => {
    await suiteFixture();
    const result = await runSuite({
      command,
      binary: join(directory, "missing"),
    });
    expect(result.exit).not.toBe(0);
    expect(result.stderr).toContain("Compiler prerequisite failed");
    expect(result.stderr).toContain("build:config-compiler");
    expect(await Bun.file(join(directory, "suite-launched")).exists()).toBe(
      false
    );
  },
  30_000
);

test.each(ENTRYPOINTS)(
  "suite %s launches only after explicit compiler succeeds",
  async (_name, command) => {
    await suiteFixture();
    const result = await runSuite({ command, binary: await compiler() });
    expect(result.exit, result.stderr).toBe(0);
    expect(await Bun.file(join(directory, "suite-launched")).exists()).toBe(
      true
    );
    expect(await Bun.file(join(directory, "received")).exists()).toBe(true);
  },
  30_000
);

async function gatedCompiler() {
  const pidPath = join(directory, "pid");
  const releasePath = join(directory, "release");
  const binary = await compiler({
    body: `if (process.argv[2] === '--protocol') { await Bun.write(${JSON.stringify(pidPath)},String(process.pid)); while (!(await Bun.file(${JSON.stringify(releasePath)}).exists())) await Bun.sleep(10); console.log(${JSON.stringify(JSON.stringify(PROTOCOL))}); } else { await Bun.write(${JSON.stringify(join(directory, "received"))},await Bun.stdin.text()); console.log(${JSON.stringify(JSON.stringify(SUCCESS))}); }`,
  });
  return { binary, pidPath, releasePath };
}

test("blocked synthetic prerequisite can succeed and launch the root suite", async () => {
  await suiteFixture();
  const { binary, pidPath, releasePath } = await gatedCompiler();
  const pending = runSuite({ command: ["run", "test"], binary });
  await waitForPid(pidPath);
  await Bun.write(releasePath, "release");
  const result = await pending;
  expect(result.exit, result.stderr).toBe(0);
  expect(await Bun.file(join(directory, "suite-launched")).text()).toBe(
    "turbo"
  );
  expect(await Bun.file(join(directory, "received")).exists()).toBe(true);
}, 30_000);

test.each([
  "SIGINT",
  "SIGTERM",
] as const)("preflight cancellation %s reaps compiler and exits nonzero", async (signal) => {
  const pidPath = join(directory, "pid");
  const binary = await compiler({
    body: `await Bun.write(${JSON.stringify(pidPath)},String(process.pid)); console.error('private-compiler-output'); await Bun.sleep(10000);`,
  });
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      join(ROOT, "scripts/check-test-config-compiler.ts"),
    ],
    {
      cwd: directory,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: "/usr/bin:/bin", HACK_CONFIG_COMPILER_BINARY: binary },
    }
  );
  children.push(child);
  const pid = await waitForPid(pidPath);
  child.kill(signal);
  const [output, error, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exit).toBe(signal === "SIGINT" ? 130 : 143);
  expect(output).toBe("");
  expect(error).toContain("Compiler prerequisite failed");
  expect(error).not.toContain("private-compiler-output");
  expect(() => process.kill(pid, 0)).toThrow();
}, 30_000);

test.each([
  "SIGINT",
  "SIGTERM",
] as const)("owned foreground suite group cancellation %s refuses launch and reaps compiler", async (signal) => {
  await suiteFixture();
  const { binary, pidPath, releasePath } = await gatedCompiler();
  const child = Bun.spawn([process.execPath, "--no-env-file", "run", "test"], {
    cwd: directory,
    detached: process.platform !== "win32",
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: `${resolve(process.execPath, "..")}:/usr/bin:/bin`,
      HACK_CONFIG_COMPILER_BINARY: binary,
    },
  });
  children.push(child);
  const pid = await waitForPid(pidPath);
  process.kill(process.platform === "win32" ? child.pid : -child.pid, signal);
  await Bun.write(releasePath, "release");
  const [_stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exit, stderr).not.toBe(0);
  expect(() => process.kill(pid, 0)).toThrow();
  expect(await Bun.file(join(directory, "suite-launched")).exists()).toBe(
    false
  );
}, 30_000);

test("raw focused Bun tests retain independent compiler setup", async () => {
  await suiteFixture();
  const result = await runSuite({
    command: ["test", "tests/suite.test.ts"],
    binary: join(directory, "missing"),
  });
  expect(result.exit, result.stderr).toBe(0);
  expect(await Bun.file(join(directory, "suite-launched")).text()).toBe("cli");
  expect(await Bun.file(join(directory, "received")).exists()).toBe(false);
}, 30_000);

test("Turbo explicitly hashes and forwards compiler selection", async () => {
  const child = Bun.spawn(
    [
      join(ROOT, "node_modules/.bin/turbo"),
      "run",
      "test",
      "--filter=@hack/cli",
      "--dry=json",
    ],
    {
      cwd: ROOT,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        PATH: process.env.PATH,
        HACK_CONFIG_COMPILER_BINARY: "/synthetic/selected",
      },
    }
  );
  children.push(child);
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exit, stderr).toBe(0);
  const summary: unknown = JSON.parse(stdout);
  if (!(isRecord(summary) && Array.isArray(summary.tasks))) {
    throw new Error("Missing Turbo summary");
  }
  const task = summary.tasks.find(
    (entry: unknown) => isRecord(entry) && entry.package === "@hack/cli"
  );
  if (
    !(
      isRecord(task) &&
      isRecord(task.environmentVariables) &&
      isRecord(task.environmentVariables.specified)
    )
  ) {
    throw new Error("Missing CLI environment selection");
  }
  expect(task.environmentVariables.specified.env).toEqual([
    "HACK_CONFIG_COMPILER_BINARY",
  ]);
}, 15_000);

test("toolchain full test checks the prerequisite without changing focused test dispatch", async () => {
  const script = await Bun.file(join(ROOT, ".hack/toolchain/run.sh")).text();
  expect(script).toContain(
    'if [ "$#" -eq 0 ]; then bun run test:preflight; fi'
  );
  expect(script).toContain('exec bun test "$@"');
});
