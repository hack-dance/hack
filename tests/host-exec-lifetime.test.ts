import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const fixtures: string[] = [];
const wrappers: ReturnType<typeof Bun.spawn>[] = [];
const entrypoint = resolve(import.meta.dir, "../index.ts");

afterEach(async () => {
  for (const root of fixtures) {
    for (const name of ["grandchild.pid", "child.pid"]) {
      const pid = await readPid(resolve(root, name));
      if (pid !== null) {
        signalPid(pid, "SIGKILL");
      }
    }
  }
  for (const wrapper of wrappers.splice(0)) {
    if (wrapper.exitCode === null) {
      wrapper.kill("SIGKILL");
    }
    await wrapper.exited;
  }
  await Promise.all(
    fixtures.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  test(`host exec forwards wrapper-only ${signal} and removes stubborn descendants`, async () => {
    const root = await createFixture({ childIgnoresSignals: false });
    const wrapper = startHostCommand({ root });
    const child = await waitForPid(resolve(root, "child.pid"));
    const grandchild = await waitForPid(resolve(root, "grandchild.pid"));

    signalPid(wrapper.pid, signal);

    expect(await wrapper.exited).toBe(signal === "SIGTERM" ? 143 : 130);
    await expectStopped(child);
    await expectStopped(grandchild);
  });
}

test("host exec bounds cancellation when the child ignores SIGTERM", async () => {
  const root = await createFixture({ childIgnoresSignals: true });
  const wrapper = startHostCommand({ root });
  const child = await waitForPid(resolve(root, "child.pid"));
  const grandchild = await waitForPid(resolve(root, "grandchild.pid"));
  const started = performance.now();

  signalPid(wrapper.pid, "SIGTERM");

  expect(await wrapper.exited).toBe(143);
  expect(performance.now() - started).toBeLessThan(4000);
  await expectStopped(child);
  await expectStopped(grandchild);
});

test("host exec forwards cancellation received by the wrapper's process group", async () => {
  const root = await createFixture({ childIgnoresSignals: false });
  const wrapper = startHostCommand({ root });
  const child = await waitForPid(resolve(root, "child.pid"));
  const grandchild = await waitForPid(resolve(root, "grandchild.pid"));

  process.kill(-wrapper.pid, "SIGTERM");

  expect(await wrapper.exited).toBe(143);
  await expectStopped(child);
  await expectStopped(grandchild);
});

test("host exec preserves piped stdin and a normal nonzero exit status", async () => {
  const root = await createFixture({ childIgnoresSignals: false });
  await writeFile(
    resolve(root, "child.ts"),
    "console.log(`received:${await Bun.stdin.text()}`); process.exitCode = 7;"
  );
  const wrapper = Bun.spawn(hostCommand({ root }), {
    cwd: root,
    env: fixtureEnv(root),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  wrappers.push(wrapper);
  wrapper.stdin.write("fixture-input");
  wrapper.stdin.end();
  const output = new Response(wrapper.stdout).text();

  expect(await wrapper.exited).toBe(7);
  expect(await output).toBe("received:fixture-input\n");
});

for (const ignores of [false, true]) {
  test(`host timeout records bounded lifetime and stops descendants (ignores=${ignores})`, async () => {
    const root = await createFixture({ childIgnoresSignals: ignores });
    const wrapper = Bun.spawn(
      hostCommand({ root, flags: ["--timeout", "0.5"] }),
      {
        cwd: root,
        env: fixtureEnv(root),
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
        detached: true,
      }
    );
    wrappers.push(wrapper);
    const child = await waitForPid(resolve(root, "child.pid"));
    const grandchild = await waitForPid(resolve(root, "grandchild.pid"));
    expect(await wrapper.exited).toBe(124);
    await expectStopped(child);
    await expectStopped(grandchild);
    const directory = resolve(root, "hack-home", "host-commands");
    const files = (await readdir(directory)).filter((name) =>
      name.endsWith(".json")
    );
    expect(files).toHaveLength(1);
    const record = await Bun.file(resolve(directory, files[0] ?? "")).json();
    expect(record).toMatchObject({
      lifetime: "bounded",
      status: "timed_out",
      exitCode: 124,
      ownsProcessGroup: true,
      timeoutMs: 500,
    });
    expect(record.cpuTimeMs).toBeGreaterThanOrEqual(0);
  }, 10_000);
}

test("persistent commands have no implicit deadline and orphan inspection leaves them alive", async () => {
  const root = await createFixture({ childIgnoresSignals: false });
  const wrapper = Bun.spawn(
    [
      ...hostCommand({ root, flags: ["--lifetime", "persistent"] }),
      "sensitive-argument-fixture",
    ],
    {
      cwd: root,
      env: fixtureEnv(root),
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      detached: true,
    }
  );
  wrappers.push(wrapper);
  const child = await waitForPid(resolve(root, "child.pid"));
  await waitForPid(resolve(root, "grandchild.pid"));
  const recordDir = resolve(root, "hack-home", "host-commands");
  for (let attempt = 0; attempt < 100; attempt++) {
    const files = await readdir(recordDir).catch(() => []);
    if (files.some((file) => file.endsWith(".json"))) {
      break;
    }
    await Bun.sleep(20);
  }
  expect(wrapper.exitCode).toBeNull();
  signalPid(wrapper.pid, "SIGKILL");
  await wrapper.exited;
  const query = Bun.spawn(
    [process.execPath, entrypoint, "host", "ps", "--json"],
    {
      cwd: root,
      env: fixtureEnv(root),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const output = await new Response(query.stdout).text();
  expect(await query.exited).toBe(0);
  const record = JSON.parse(output).commands[0];
  expect(record).toMatchObject({
    lifetime: "persistent",
    status: "orphaned",
    attention: "persistent_wrapper_lost",
    timeoutMs: null,
  });
  expect(output).not.toContain("sensitive-argument-fixture");
  expect(process.kill(child, 0)).toBe(true);
});

function startHostCommand({ root }: { readonly root: string }) {
  const wrapper = Bun.spawn(hostCommand({ root }), {
    cwd: root,
    env: fixtureEnv(root),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    detached: true,
  });
  wrappers.push(wrapper);
  return wrapper;
}

function hostCommand({
  root,
  flags = [],
}: {
  readonly root: string;
  readonly flags?: readonly string[];
}): string[] {
  return [
    process.execPath,
    entrypoint,
    "host",
    "exec",
    "--path",
    root,
    "--no-interactive",
    ...flags,
    "--",
    process.execPath,
    resolve(root, "child.ts"),
  ];
}

function fixtureEnv(root: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HACK_HOME: resolve(root, "hack-home"),
    HACK_NO_INTERACTIVE: "1",
  };
}

async function createFixture(opts: {
  readonly childIgnoresSignals: boolean;
}): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "hack-host-lifetime-"));
  fixtures.push(root);
  await mkdir(resolve(root, ".hack"));
  await writeFile(
    resolve(root, ".hack/hack.config.json"),
    JSON.stringify({ name: "lifetime-test", dev_host: "lifetime-test.hack" })
  );
  await writeFile(
    resolve(root, ".hack/docker-compose.yml"),
    "services:\n  noop:\n    image: alpine:3.20\n"
  );
  await writeFile(
    resolve(root, ".hack/hack.env.default.yaml"),
    "version: 1\nenvironment: default\nsecretsprovider: project_key\nvalues:\n  global: {}\n"
  );
  await writeFile(
    resolve(root, "grandchild.ts"),
    [
      'process.on("SIGTERM", () => {});',
      'process.on("SIGINT", () => {});',
      'await Bun.write("grandchild.pid", String(process.pid));',
      "setInterval(() => {}, 1000);",
    ].join("\n")
  );
  await writeFile(
    resolve(root, "child.ts"),
    [
      `const stop = () => { ${opts.childIgnoresSignals ? "" : "process.exit(0);"} };`,
      'process.on("SIGTERM", stop);',
      'process.on("SIGINT", stop);',
      'await Bun.write("child.pid", String(process.pid));',
      'Bun.spawn([process.execPath, "grandchild.ts"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });',
      "setInterval(() => {}, 1000);",
    ].join("\n")
  );
  return root;
}

async function readPid(path: string): Promise<number | null> {
  try {
    const pid = Number((await readFile(path, "utf8")).trim());
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function waitForPid(path: string): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const pid = await readPid(path);
    if (pid !== null) {
      return pid;
    }
    await Bun.sleep(20);
  }
  throw new Error(`Child did not become ready: ${path}`);
}

async function expectStopped(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await Bun.sleep(10);
  }
  expect(isAlive(pid)).toBe(false);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Test-owned processes may already have exited.
  }
}
