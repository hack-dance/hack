import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  invokeNativeRuntime,
  NativeRuntimeRequestError,
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
if (process.argv.includes("one-off-fail")) { console.error(JSON.stringify({code:"graph_one_off_failed",cause_code:"graph_one_off_cancelled",message:"synthetic-secret-diagnostic"})); process.exit(23); }
if (process.argv.includes("one-off-unsafe")) { console.error(JSON.stringify({code:"graph_one_off_failed",cause_code:"synthetic-secret-diagnostic",message:"synthetic-secret-diagnostic"})); process.exit(23); }
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

test("native failure preserves only its validated structured code", async () => {
  const runtime = await fixture();
  try {
    await invokeNativeRuntime({
      runtime,
      cwd: runtime.home,
      args: ["structured"],
    });
    throw new Error("expected structured native refusal");
  } catch (error) {
    expect(error).toBeInstanceOf(NativeRuntimeRequestError);
    expect(error).toMatchObject({ nativeCode: "source_conflict" });
    expect(String(error)).not.toContain("synthetic-secret-diagnostic");
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

test("one-off failures expose only a validated owner cause code", async () => {
  const runtime = await fixture();
  await expect(
    invokeNativeRuntime({ runtime, cwd: runtime.home, args: ["one-off-fail"] })
  ).rejects.toThrow("graph_one_off_failed: graph_one_off_cancelled");
  await expect(
    invokeNativeRuntime({
      runtime,
      cwd: runtime.home,
      args: ["one-off-unsafe"],
    })
  ).rejects.toThrow(
    "Native runtime request failed (graph_one_off_failed); inspect owned state before retrying."
  );
});

test("early structured rejection survives a full private-input pipe without replay", async () => {
  const runtime = await fixture();
  const marker = join(runtime.home, "attempts");
  await Bun.write(
    runtime.binary,
    `#!${process.execPath}
import { appendFileSync, closeSync } from "node:fs";
appendFileSync(${JSON.stringify(marker)}, "attempt\\n");
closeSync(0);
await Bun.sleep(20);
console.error(JSON.stringify({code:"graph_budget",message:"synthetic-private-diagnostic"}));
process.exit(23);
`
  );
  let failure = "";
  try {
    await invokeNativeRuntime({
      runtime,
      cwd: runtime.home,
      args: [],
      timeoutMs: 2000,
      privateInput: new TextEncoder().encode(
        "synthetic-private-payload".repeat(10_000)
      ),
    });
  } catch (error) {
    failure = String(error);
  }
  expect(failure).toContain("Native runtime request failed (graph_budget)");
  expect(failure).not.toContain("synthetic-private");
  expect(await Bun.file(marker).text()).toBe("attempt\n");
});

test("exec accepts matching nonzero completion only through its explicit transport contract", async () => {
  const runtime = await fixture();
  const reply = {
    exit_code: 7,
    stdout_base64: "AP8=",
    stderr_base64: "ZXJy",
    truncated: false,
  };
  for (const variant of ["valid", "mismatch", "malformed", "native-error"]) {
    await Bun.write(
      runtime.binary,
      `#!${process.execPath}\nconsole.log(${JSON.stringify(variant === "malformed" ? "not-json" : JSON.stringify({ ...reply, exit_code: variant === "mismatch" ? 8 : 7 }))});\n${variant === "native-error" ? 'console.error(JSON.stringify({code:"graph_service_exec",message:"synthetic-secret"}));' : ""}process.exit(7);`
    );
    const request = {
      runtime,
      cwd: runtime.home,
      args: ["graph", "exec", "--json", "--", "true"],
      serviceExecResponse: true,
    };
    if (variant === "valid") {
      expect(await invokeNativeRuntime(request)).toEqual(reply);
      await expect(
        invokeNativeRuntime({ ...request, serviceExecResponse: false })
      ).rejects.toThrow("request failed");
      await expect(
        invokeNativeRuntime({
          ...request,
          args: ["graph", "cleanup", "--json"],
        })
      ).rejects.toThrow("budget");
    } else {
      await expect(invokeNativeRuntime(request)).rejects.toThrow();
    }
  }
});

test("run-service uses explicit command completion transport without accepting unrelated operations", async () => {
  const runtime = await fixture();
  const reply = {
    job: "a".repeat(32),
    cleanup_confirmed: true,
    exit_code: 19,
    stdout_base64: "AP8=",
    stderr_base64: "",
    truncated: false,
  };
  await Bun.write(
    runtime.binary,
    `#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify(reply))});process.exit(19);`
  );
  const request = {
    runtime,
    cwd: runtime.home,
    serviceExecResponse: true,
    args: ["graph", "run-service", "--json", "--"],
  };
  expect(await invokeNativeRuntime(request)).toEqual(reply);
  await expect(
    invokeNativeRuntime({
      ...request,
      args: ["graph", "run-selection", "--json", "--"],
    })
  ).rejects.toThrow("budget");
});
