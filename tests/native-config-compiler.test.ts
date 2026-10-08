import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compileNativeConfig,
  NATIVE_CONFIG_INPUT_LIMIT,
  readNativeConfigInput,
  resolveNativeConfig,
  resolveNativeConfigCompilerBinary,
} from "../src/lib/native-config-compiler.ts";
import { restoreEnv } from "./helpers/env.ts";

const PROTOCOL = { transport_version: 1, authored_version: 1, plan_version: 1 };
const SUCCESS = {
  transport_version: 1,
  ok: true,
  plan: { plan_version: 1 },
  semantic_hash: "a".repeat(64),
};
const INPUT = new TextEncoder().encode('{"schema_version":1,"name":"fixture"}');
let directory = "";

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "hack-compiler-transport-"));
});

const LOCAL_RESOLUTION = {
  overlay: "qa",
  origin: "checkout_local",
  auto_branch: true,
  inherit_local: true,
  resolution_hash: "b".repeat(64),
} as const;

function resolverScript(body: string): string {
  return `if (process.argv[2] === '--protocol') { console.log(${JSON.stringify(JSON.stringify({ ...PROTOCOL, resolve_version: 1, local_version: 1 }))}); } else { ${body} }`;
}

test("local resolution preserves original document text and explicit tri-state", async () => {
  const local =
    '\ufeff{"schema_version":1,"environment":{"default_overlay":"qa","default_overlay":null}}';
  const binary = await fixture(
    resolverScript(
      `const received = JSON.parse(await Bun.stdin.text()); console.log(JSON.stringify({ ...${JSON.stringify(SUCCESS)}, plan: {plan_version:1, received, arguments:process.argv.slice(2), keys:Object.keys(process.env).sort()}, local_resolution:${JSON.stringify(LOCAL_RESOLUTION)} }));`
    )
  );
  for (const explicitOverlay of [undefined, null, "qa"]) {
    const result = await resolveNativeConfig({
      input: INPUT,
      checkoutLocal: new TextEncoder().encode(local),
      explicitOverlay,
      binary,
      profiles: ["qa"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("Expected local resolution success");
    }
    expect(result.plan.received).toEqual({
      request_version: 1,
      project: new TextDecoder().decode(INPUT),
      checkout_local: local,
      ...(explicitOverlay === undefined
        ? {}
        : { explicit_overlay: explicitOverlay }),
    });
    expect(result.plan.arguments).toEqual(["resolve", "--profile", "qa"]);
    expect(result.plan.keys).toEqual(["PATH"]);
    expect(result.local_resolution).toEqual(LOCAL_RESOLUTION);
  }
});

test("old compiler can compile explicit input but refuses project resolution before input", async () => {
  const receipt = join(directory, "resolver-received-input");
  const binary = await fixture(
    script(
      `await Bun.write(${JSON.stringify(receipt)}, await Bun.stdin.text()); console.log(${JSON.stringify(JSON.stringify(SUCCESS))});`
    )
  );
  await expect(resolveNativeConfig({ input: INPUT, binary })).rejects.toThrow(
    "version mismatch"
  );
  await expect(
    compileNativeConfig({ input: INPUT, binary, requireLocalResolution: true })
  ).rejects.toThrow("version mismatch");
  expect(await Bun.file(receipt).exists()).toBe(false);
  expect((await compileNativeConfig({ input: INPUT, binary })).ok).toBe(true);
});

test("local diagnostics retain role and fixed redacted messages", async () => {
  const result = {
    transport_version: 1,
    ok: false,
    diagnostics: [
      {
        document: "checkout_local",
        code: "duplicate_key",
        pointer: "/environment",
        message: "Duplicate JSON object keys are not allowed.",
        line: 2,
        column: 3,
      },
    ],
  } as const;
  const binary = await fixture(
    resolverScript(
      `console.log(${JSON.stringify(JSON.stringify(result))}); process.exitCode=1;`
    )
  );
  expect(await resolveNativeConfig({ input: INPUT, binary })).toEqual(result);
});

test.each([
  { ...LOCAL_RESOLUTION, overlay: "QA" },
  { ...LOCAL_RESOLUTION, origin: "private-output" },
  { ...LOCAL_RESOLUTION, inherit_local: null },
  { ...LOCAL_RESOLUTION, resolution_hash: "invalid" },
  undefined,
])("rejects invalid local resolution metadata without exposing it", async (local_resolution) => {
  const binary = await fixture(
    resolverScript(
      `console.log(${JSON.stringify(JSON.stringify({ ...SUCCESS, local_resolution }))});`
    )
  );
  await expect(resolveNativeConfig({ input: INPUT, binary })).rejects.toThrow(
    "invalid result"
  );
});

test("local resolution refuses invalid UTF-8 and oversized documents before spawning", async () => {
  const binary = join(directory, "absent");
  await expect(
    resolveNativeConfig({
      input: INPUT,
      checkoutLocal: new Uint8Array([255]),
      binary,
    })
  ).rejects.toThrow("checkout_local input must be valid UTF-8");
  await expect(
    resolveNativeConfig({
      input: INPUT,
      primaryLocal: new Uint8Array(NATIVE_CONFIG_INPUT_LIMIT + 1),
      binary,
    })
  ).rejects.toThrow("input budget");
  await expect(
    resolveNativeConfig({
      input: INPUT,
      explicitOverlay: "x".repeat(NATIVE_CONFIG_INPUT_LIMIT + 1),
      binary,
    })
  ).rejects.toThrow("selection exceeds the input budget");
  const escaped = new Uint8Array(NATIVE_CONFIG_INPUT_LIMIT);
  await expect(
    resolveNativeConfig({
      input: escaped,
      primaryLocal: escaped,
      checkoutLocal: escaped,
      explicitOverlay: "\u0000".repeat(NATIVE_CONFIG_INPUT_LIMIT),
      binary,
    })
  ).rejects.toThrow("request exceeds the input budget");
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function fixture(body: string): Promise<string> {
  const path = join(directory, "compiler");
  await Bun.write(path, `#!${process.execPath}\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

function script(compile: string): string {
  return `if (process.argv[2] === '--protocol') { process.stdout.write(${JSON.stringify(JSON.stringify(PROTOCOL))}); } else { ${compile} }`;
}

/** Observe only real owned fixture children; keep the native spawn unchanged. */
function observeFixtureChildren(binary: string) {
  const children: Bun.Subprocess[] = [];
  const exits = new Map<Bun.Subprocess, number>();
  const spawn = Bun.spawn.bind(Bun);
  const observed = spyOn(Bun, "spawn").mockImplementation(((
    ...args: unknown[]
  ) => {
    const child = Reflect.apply(spawn, Bun, args);
    if (Array.isArray(args[0]) && args[0][0] === binary) {
      children.push(child);
      // Observe the promise the product already awaits; do not reap in the test.
      void child.exited.then(
        (exitCode: number) => {
          exits.set(child, exitCode);
        },
        () => {
          // A rejected exit promise leaves the strict completion marker absent.
        }
      );
    }
    return child;
  }) as typeof Bun.spawn);
  return { children, exits, restore: () => observed.mockRestore() };
}

function observeGroupSignals() {
  const groups: number[] = [];
  const kill = process.kill.bind(process);
  const observed = spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (pid < 0 && signal === "SIGKILL") {
      groups.push(pid);
    }
    return kill(pid, signal);
  });
  return { groups, restore: () => observed.mockRestore() };
}

function ownedProcessAbsent(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ESRCH"
    ) {
      return true;
    }
    throw error;
  }
}

async function waitForOwnedExit(pid: number): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (ownedProcessAbsent(pid)) {
      return;
    }
    await Bun.sleep(10);
  }
  expect(ownedProcessAbsent(pid)).toBe(true);
}

test.each([
  "ESRCH",
  "EPERM",
  "EIO",
])("only ESRCH proves owned process absence: %s", (code) => {
  const error = Object.assign(new Error("Synthetic presence failure"), {
    code,
  });
  const signals = spyOn(process, "kill").mockImplementation(() => {
    throw error;
  });
  try {
    if (code === "ESRCH") {
      expect(ownedProcessAbsent(123)).toBe(true);
    } else {
      expect(() => ownedProcessAbsent(123)).toThrow(error);
    }
    expect(signals).toHaveBeenCalledWith(123, 0);
  } finally {
    signals.mockRestore();
  }
});

test.each([
  ["success", JSON.stringify(SUCCESS), 0],
  ["invalid response", "private-invalid-json", 0],
  ["nonzero response", JSON.stringify(SUCCESS), 2],
] as const)("fully settled real compiler %s never signals its former group", async (kind, output, exit) => {
  const binary = await fixture(
    script(
      `process.stdout.write(${JSON.stringify(output)}); process.exitCode = ${exit};`
    )
  );
  const children = observeFixtureChildren(binary);
  const signals = spyOn(process, "kill").mockImplementation(() => true);
  try {
    const result = await compileNativeConfig({ input: INPUT, binary }).catch(
      (error: unknown) => error
    );
    if (kind === "success") {
      expect(result).toMatchObject({ ok: true });
    } else {
      expect(result).toMatchObject({ code: "E_COMPILER_RESPONSE" });
      expect(result).not.toHaveProperty("message", output);
    }
    expect(children.children).toHaveLength(2);
    expect(children.children.every((child) => child.exitCode !== null)).toBe(
      true
    );
    expect(signals).not.toHaveBeenCalled();
  } finally {
    signals.mockRestore();
    children.restore();
  }
});

test("compiler timeout signals the active owned group once and reaps its real child", async () => {
  const binary = await fixture("await Bun.sleep(10_000);");
  const children = observeFixtureChildren(binary);
  const signals = observeGroupSignals();
  try {
    await expect(
      compileNativeConfig({ input: INPUT, binary, timeoutMs: 250 })
    ).rejects.toMatchObject({ code: "E_COMPILER_TIMEOUT" });
    expect(children.children).toHaveLength(1);
    const child = children.children[0];
    if (!child) {
      throw new Error("Missing real compiler subprocess");
    }
    expect(children.exits.has(child)).toBe(true);
    expect(Number.isInteger(children.exits.get(child))).toBe(true);
    expect(children.exits.get(child)).not.toBe(0);
    expect(child.signalCode).toBe("SIGKILL");
    expect(signals.groups).toEqual([-child.pid]);
    expect(ownedProcessAbsent(child.pid)).toBe(true);
  } finally {
    signals.restore();
    children.restore();
  }
});

test("compiler output failure still reaps its leader and inherited-pipe descendant", async () => {
  const readyPath = join(directory, "overflow-descendant-ready");
  const descendant = `process.on('SIGTERM', () => {}); await Bun.write(${JSON.stringify(readyPath)}, String(process.pid)); await Bun.sleep(10_000);`;
  const binary = await fixture(
    script(
      `Bun.spawn([process.execPath, '-e', ${JSON.stringify(descendant)}], {stdout:'inherit', stderr:'inherit'}); while (!(await Bun.file(${JSON.stringify(readyPath)}).exists())) { await Bun.sleep(5); } await Bun.write(Bun.stdout, 'x'.repeat(9 * 1024 * 1024)); await Bun.sleep(10_000);`
    )
  );
  const children = observeFixtureChildren(binary);
  const signals = observeGroupSignals();
  try {
    await expect(
      compileNativeConfig({ input: INPUT, binary, timeoutMs: 5000 })
    ).rejects.toMatchObject({ code: "E_COMPILER_BUDGET" });
    expect(children.children).toHaveLength(2);
    const leader = children.children[1];
    if (!leader) {
      throw new Error("Missing owned compiler leader");
    }
    expect(children.exits.has(leader)).toBe(true);
    expect(Number.isInteger(children.exits.get(leader))).toBe(true);
    expect(children.exits.get(leader)).not.toBe(0);
    expect(leader.signalCode).toBe("SIGKILL");
    expect(signals.groups).toEqual([-leader.pid]);
    const pid = Number(await Bun.file(readyPath).text());
    expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
    await waitForOwnedExit(pid);
    expect(ownedProcessAbsent(leader.pid)).toBe(true);
  } finally {
    signals.restore();
    children.restore();
  }
}, 10_000);

test("leader exit leaves inherited-pipe descendant cleanup armed until manual abort", async () => {
  const readyPath = join(directory, "descendant-ready");
  const latePath = join(directory, "descendant-late-write");
  const descendant = `process.on('SIGTERM', () => {}); await Bun.write(${JSON.stringify(readyPath)}, String(process.pid)); await Bun.sleep(10_000); await Bun.write(${JSON.stringify(latePath)}, 'unexpected');`;
  const binary = await fixture(
    script(
      `Bun.spawn([process.execPath, '-e', ${JSON.stringify(descendant)}], {stdout:'inherit', stderr:'inherit'}); while (!(await Bun.file(${JSON.stringify(readyPath)}).exists())) { await Bun.sleep(5); } process.exit(0);`
    )
  );
  const controller = new AbortController();
  const children = observeFixtureChildren(binary);
  const signals = observeGroupSignals();
  let completed = false;
  const attempt = compileNativeConfig({
    input: INPUT,
    binary,
    timeoutMs: 5000,
    signal: controller.signal,
  }).then(
    (value) => {
      completed = true;
      return value;
    },
    (error: unknown) => {
      completed = true;
      return error;
    }
  );
  try {
    const deadline = Date.now() + 2000;
    while (
      (children.children.length !== 2 ||
        children.children[1]?.exitCode !== 0 ||
        !(await Bun.file(readyPath).exists())) &&
      Date.now() < deadline
    ) {
      await Bun.sleep(5);
    }
    const leader = children.children[1];
    if (!leader) {
      throw new Error("Missing owned compiler leader");
    }
    expect(leader.exitCode).toBe(0);
    expect(await Bun.file(readyPath).exists()).toBe(true);
    expect(completed).toBe(false);
    const pid = Number(await Bun.file(readyPath).text());
    expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
    expect(process.kill(pid, 0)).toBe(true);
    expect(signals.groups).toEqual([]);
    controller.abort();
    expect(await attempt).toMatchObject({ code: "E_COMPILER_CANCELLED" });
    expect(signals.groups).toEqual([-leader.pid]);
    await waitForOwnedExit(pid);
    expect(await Bun.file(latePath).exists()).toBe(false);
  } finally {
    controller.abort();
    await attempt;
    signals.restore();
    children.restore();
  }
}, 10_000);

test("uses adjacent bundle compiler without PATH lookup", () => {
  expect(
    resolveNativeConfigCompilerBinary({ override: "/fixture/compiler" })
  ).toBe("/fixture/compiler");
  expect(() =>
    resolveNativeConfigCompilerBinary({ override: "compiler" })
  ).toThrow("absolute path");
  const original = process.env.HACK_CONFIG_COMPILER_BINARY;
  Reflect.deleteProperty(process.env, "HACK_CONFIG_COMPILER_BINARY");
  try {
    expect(
      resolveNativeConfigCompilerBinary({ executablePath: "/bundle/hack-cli" })
    ).toBe("/bundle/hack-config-compiler");
  } finally {
    restoreEnv("HACK_CONFIG_COMPILER_BINARY", original);
  }
});

test("missing compiler fails with fixed actionable output", async () => {
  await expect(
    compileNativeConfig({ input: INPUT, binary: join(directory, "absent") })
  ).rejects.toThrow("Install its matching bundle");
});

test("checks version before sending authored input", async () => {
  const receipt = join(directory, "compile-was-called");
  const binary = await fixture(
    `if (process.argv[2] === '--protocol') { console.log('{"transport_version":99}'); } else { await Bun.write(${JSON.stringify(receipt)}, await Bun.stdin.text()); }`
  );
  await expect(compileNativeConfig({ input: INPUT, binary })).rejects.toThrow(
    "version mismatch"
  );
  expect(await Bun.file(receipt).exists()).toBe(false);
});

test("compiler receives no inherited credentials and forwards profile arguments exactly", async () => {
  const original = process.env.AWS_SECRET_ACCESS_KEY;
  process.env.AWS_SECRET_ACCESS_KEY = "compiler-test-do-not-forward";
  try {
    const binary = await fixture(
      script(
        `const value = ${JSON.stringify(SUCCESS)}; value.plan.received = await Bun.stdin.text(); value.plan.profiles = process.argv.slice(3); value.plan.keys = Object.keys(process.env).sort(); console.log(JSON.stringify(value));`
      )
    );
    const result = await compileNativeConfig({
      input: INPUT,
      binary,
      profiles: ["with spaces", "--unsafe"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("Expected transport success");
    }
    expect(result.plan.received).toBe(new TextDecoder().decode(INPUT));
    expect(result.plan.profiles).toEqual([
      "--profile",
      "with spaces",
      "--profile",
      "--unsafe",
    ]);
    expect(result.plan.keys).toEqual(["PATH"]);
  } finally {
    restoreEnv("AWS_SECRET_ACCESS_KEY", original);
  }
});

test("preserves structured compiler validation failure", async () => {
  const result = {
    transport_version: 1,
    ok: false,
    diagnostics: [
      {
        code: "E_UNKNOWN_FIELD",
        pointer: "/services/web",
        message: "Unsupported field.",
        line: 2,
        column: 3,
      },
    ],
  } as const;
  const binary = await fixture(
    script(
      `console.log(${JSON.stringify(JSON.stringify(result))}); process.exitCode = 1;`
    )
  );
  expect(await compileNativeConfig({ input: INPUT, binary })).toEqual(result);
});

test.each([
  ["invalid JSON", "private-invalid-output", 0],
  [
    "bad plan version",
    JSON.stringify({ ...SUCCESS, plan: { plan_version: 2 } }),
    0,
  ],
  [
    "bad semantic hash",
    JSON.stringify({ ...SUCCESS, semantic_hash: "nope" }),
    0,
  ],
  ["wrong exit", JSON.stringify(SUCCESS), 1],
  [
    "empty diagnostics",
    '{"transport_version":1,"ok":false,"diagnostics":[]}',
    1,
  ],
  [
    "missing location",
    '{"transport_version":1,"ok":false,"diagnostics":[{"code":"x","pointer":"/","message":"private-value"}]}',
    1,
  ],
  ["usage failure", "", 2],
])("rejects %s without echoing compiler output", async (_name, stdout, exit) => {
  const binary = await fixture(
    script(
      `process.stdout.write(${JSON.stringify(stdout)}); process.stderr.write('private-stderr'); process.exitCode = ${exit};`
    )
  );
  const error = await compileNativeConfig({ input: INPUT, binary }).catch(
    (value: unknown) => value
  );
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).not.toContain("private");
});

test("bounds stdout and stderr separately", async () => {
  for (const stream of ["stdout", "stderr"]) {
    const binary = await fixture(
      script(`process.${stream}.write('x'.repeat(9 * 1024 * 1024));`)
    );
    await expect(compileNativeConfig({ input: INPUT, binary })).rejects.toThrow(
      "I/O exceeds its budget"
    );
  }
});

test("times out and reaps a hanging owned compiler", async () => {
  const binary = await fixture("await Bun.sleep(10_000);");
  const children = observeFixtureChildren(binary);
  try {
    await expect(
      compileNativeConfig({ input: INPUT, binary, timeoutMs: 250 })
    ).rejects.toThrow("timed out");
    expect(children.children).toHaveLength(1);
    const child = children.children[0];
    if (!child) {
      throw new Error("Missing real compiler subprocess");
    }
    expect(children.exits.has(child)).toBe(true);
    expect(Number.isInteger(children.exits.get(child))).toBe(true);
    expect(children.exits.get(child)).not.toBe(0);
    expect(child.signalCode).toBe("SIGKILL");
    expect(ownedProcessAbsent(child.pid)).toBe(true);
  } finally {
    children.restore();
  }
});

test("cancellation reaps the compiler and pre-cancel does not spawn", async () => {
  const binary = await fixture("await Bun.sleep(10_000);");
  const children = observeFixtureChildren(binary);
  const signal = AbortSignal.timeout(250);
  try {
    await expect(
      compileNativeConfig({ input: INPUT, binary, signal })
    ).rejects.toThrow("cancelled");
    expect(children.children).toHaveLength(1);
    const child = children.children[0];
    if (!child) {
      throw new Error("Missing real compiler subprocess");
    }
    expect(children.exits.has(child)).toBe(true);
    expect(Number.isInteger(children.exits.get(child))).toBe(true);
    expect(children.exits.get(child)).not.toBe(0);
    expect(child.signalCode).toBe("SIGKILL");
    expect(ownedProcessAbsent(child.pid)).toBe(true);
    await expect(
      compileNativeConfig({ input: INPUT, binary, signal })
    ).rejects.toThrow("cancelled");
    expect(children.children).toHaveLength(1);
  } finally {
    children.restore();
  }
});

test("input reads require a bounded regular file", async () => {
  const path = join(directory, "project.json");
  await Bun.write(path, INPUT);
  expect(await readNativeConfigInput({ path })).toEqual(INPUT);
  await Bun.write(path, new Uint8Array(NATIVE_CONFIG_INPUT_LIMIT + 1));
  await expect(readNativeConfigInput({ path })).rejects.toThrow(
    "bounded regular file"
  );
  await mkdir(join(directory, "folder"));
  await expect(
    readNativeConfigInput({ path: join(directory, "folder") })
  ).rejects.toThrow("bounded regular file");
  await expect(
    readNativeConfigInput({ path: join(directory, "absent") })
  ).rejects.toThrow("Cannot read");
  await expect(
    compileNativeConfig({
      input: new Uint8Array(NATIVE_CONFIG_INPUT_LIMIT + 1),
      binary: path,
    })
  ).rejects.toThrow("input budget");
});
