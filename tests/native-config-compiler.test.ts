import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compileNativeConfig,
  NATIVE_CONFIG_INPUT_LIMIT,
  readNativeConfigInput,
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
  const pidPath = join(directory, "pid");
  const binary = await fixture(
    script(
      `await Bun.write(${JSON.stringify(pidPath)}, String(process.pid)); await Bun.sleep(10000);`
    )
  );
  await expect(
    compileNativeConfig({ input: INPUT, binary, timeoutMs: 250 })
  ).rejects.toThrow("timed out");
  const pid = Number(await Bun.file(pidPath).text());
  expect(() => process.kill(pid, 0)).toThrow();
});

test("cancellation reaps the compiler and pre-cancel does not spawn", async () => {
  const pidPath = join(directory, "pid");
  const binary = await fixture(
    script(
      `await Bun.write(${JSON.stringify(pidPath)}, String(process.pid)); await Bun.sleep(10000);`
    )
  );
  const signal = AbortSignal.timeout(250);
  await expect(
    compileNativeConfig({ input: INPUT, binary, signal })
  ).rejects.toThrow("cancelled");
  const pid = Number(await Bun.file(pidPath).text());
  expect(() => process.kill(pid, 0)).toThrow();
  await rm(pidPath);
  await expect(
    compileNativeConfig({ input: INPUT, binary, signal })
  ).rejects.toThrow("cancelled");
  expect(await Bun.file(pidPath).exists()).toBe(false);
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
