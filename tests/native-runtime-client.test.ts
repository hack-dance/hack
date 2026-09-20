import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  invokeNativeRuntime,
  resolveNativeRuntimeSelection,
} from "../src/backends/native-runtime-client.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true }))
  );
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "hack-native-client-"));
  roots.push(home);
  const binary = join(home, "native");
  await Bun.write(
    binary,
    `#!${process.execPath}
if (process.argv.includes("hang")) await Bun.sleep(60_000);
if (process.argv.includes("structured")) { console.error(JSON.stringify({code:"source_conflict",message:"synthetic-secret-diagnostic"})); process.exit(23); }
if (process.argv.includes("fail")) { console.error("synthetic-secret-diagnostic"); process.exit(23); }
if (process.argv.includes("overflow")) { process.stdout.write("x".repeat(17 * 1024 * 1024)); }
else {
 const input = await Bun.stdin.text();
 console.log(JSON.stringify({ args:process.argv.slice(2), inputBytes:Buffer.byteLength(input), inherited:process.env.HACK_RUNTIME_CLIENT_CANARY ?? null }));
}
`
  );
  await chmod(binary, 0o700);
  return { home, binary };
}

test("native selection is explicit and requires an isolated absolute home", () => {
  expect(resolveNativeRuntimeSelection({})).toBeNull();
  expect(() =>
    resolveNativeRuntimeSelection({ HACK_RUNTIME_BACKEND: "native" })
  ).toThrow();
  expect(() =>
    resolveNativeRuntimeSelection({
      HACK_RUNTIME_BACKEND: "native",
      HACK_NATIVE_BINARY: "hack-native",
      HACK_NATIVE_HOME: "/tmp/home",
    })
  ).toThrow();
  expect(
    resolveNativeRuntimeSelection({
      HACK_RUNTIME_BACKEND: "native",
      HACK_NATIVE_BINARY: "/tmp/hack-native",
      HACK_NATIVE_HOME: "/tmp/home",
    })
  ).toEqual({ binary: "/tmp/hack-native", home: "/tmp/home" });
});

test("managed input uses stdin with EOF and is absent from argv and inherited env", async () => {
  const runtime = await fixture();
  const prior = process.env.HACK_RUNTIME_CLIENT_CANARY;
  process.env.HACK_RUNTIME_CLIENT_CANARY = "synthetic-private-canary";
  try {
    const reply = await invokeNativeRuntime({
      runtime,
      cwd: runtime.home,
      args: ["inspect", "--json"],
      privateInput: new TextEncoder().encode("synthetic-private-canary"),
    });
    expect(reply).toEqual({
      args: ["--candidate-root", runtime.home, "inspect", "--json"],
      inputBytes: 24,
      inherited: null,
    });
    expect(JSON.stringify(reply)).not.toContain("synthetic-private-canary");
  } finally {
    if (prior === undefined) {
      Reflect.deleteProperty(process.env, "HACK_RUNTIME_CLIENT_CANARY");
    } else {
      process.env.HACK_RUNTIME_CLIENT_CANARY = prior;
    }
  }
});

test("failures omit subprocess diagnostics and timeouts are bounded", async () => {
  const runtime = await fixture();
  await expect(
    invokeNativeRuntime({ runtime, cwd: runtime.home, args: ["fail"] })
  ).rejects.toThrow(
    "Native runtime request failed; inspect owned state before retrying."
  );
  await expect(
    invokeNativeRuntime({
      runtime,
      cwd: runtime.home,
      args: ["hang"],
      timeoutMs: 100,
    })
  ).rejects.toThrow("Native runtime request timed out");
});

test("private-input and response bounds reject instead of truncating", async () => {
  const runtime = await fixture();
  await expect(
    invokeNativeRuntime({
      runtime,
      cwd: runtime.home,
      args: [],
      privateInput: new Uint8Array(256 * 1024 + 1),
    })
  ).rejects.toThrow("input or time budget");
  await expect(
    invokeNativeRuntime({ runtime, cwd: runtime.home, args: ["overflow"] })
  ).rejects.toThrow("output budget");
});

test("structured failures expose only a bounded code, never their message", async () => {
  const runtime = await fixture();
  await expect(
    invokeNativeRuntime({ runtime, cwd: runtime.home, args: ["structured"] })
  ).rejects.toThrow(
    "Native runtime request failed (source_conflict); inspect owned state before retrying."
  );
});
