import { afterEach, expect, spyOn, test } from "bun:test";
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
if (process.argv.includes("owner-fail")) { const {appendFileSync}=await import("node:fs"); appendFileSync("attempts","attempt"); console.error(JSON.stringify({code:"graph_owner_recovery",cause_code:"graph_relay_identity",message:"synthetic-secret-diagnostic"})); process.exit(23); }
if (process.argv.includes("owner-unsafe")) { console.error(JSON.stringify({code:"graph_owner_recovery",cause_code:"synthetic-secret-diagnostic",message:"synthetic-secret-diagnostic"})); process.exit(23); }
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

test("bounded native status draining cannot select another action or legacy command", async () => {
  const runtime = {
    home: "/absent-native-status-home",
    binary: "/absent-native-status-binary",
  };
  for (const args of [
    [
      "graph",
      "native",
      "control",
      "--run-id",
      "a".repeat(32),
      "--action",
      "cleanup",
      "--json",
    ],
    [
      "graph",
      "control",
      "--run-id",
      "a".repeat(32),
      "--action",
      "status",
      "--json",
    ],
    [
      "graph",
      "native",
      "control",
      "--run-id",
      "../foreign",
      "--action",
      "status",
      "--json",
    ],
  ]) {
    await expect(
      invokeNativeRuntime({
        runtime,
        cwd: runtime.home,
        args,
        boundNativeStatusDrain: true,
      })
    ).rejects.toThrow("budget");
  }
});

test("native authored read draining admits only exact public plan and inspect requests", async () => {
  const runtime = await fixture();
  for (const args of [
    [
      "graph",
      "native",
      "plan",
      "--source-file",
      join(runtime.home, "source.json"),
      "--json",
    ],
    ["graph", "native", "inspect", "--run-id", "a".repeat(32), "--json"],
  ]) {
    expect(
      await invokeNativeRuntime({
        runtime,
        cwd: runtime.home,
        args,
        boundNativeAuthoredReadDrain: true,
      })
    ).toMatchObject({ args: ["--candidate-root", runtime.home, ...args] });
  }
  const absent = {
    home: "/absent-native-read-home",
    binary: "/absent-native-read-binary",
  };
  for (const args of [
    ["graph", "native", "plan", "--source-file", "relative", "--json"],
    ["graph", "native", "inspect", "--run-id", "../foreign", "--json"],
    ["graph", "native", "cleanup", "--run-id", "a".repeat(32), "--json"],
    ["graph", "inspect", "--run-id", "a".repeat(32), "--json"],
    [
      "graph",
      "native",
      "inspect",
      "--run-id",
      "a".repeat(32),
      "--json",
      "--json",
    ],
  ]) {
    await expect(
      invokeNativeRuntime({
        runtime: absent,
        cwd: absent.home,
        args,
        boundNativeAuthoredReadDrain: true,
      })
    ).rejects.toThrow("budget");
  }
  await expect(
    invokeNativeRuntime({
      runtime: absent,
      cwd: absent.home,
      args: [
        "graph",
        "native",
        "inspect",
        "--run-id",
        "a".repeat(32),
        "--json",
      ],
      privateInput: new Uint8Array([1]),
      boundNativeAuthoredReadDrain: true,
    })
  ).rejects.toThrow("budget");
});

test.each([
  "exit",
  "abort",
] as const)("authored read %s finishes while a descendant retains stdout and stderr", async (mode) => {
  const runtime = await fixture();
  const holding = join(runtime.home, "holding");
  const heartbeat = join(runtime.home, "heartbeat");
  const finished = join(runtime.home, "finished");
  const keeper = `import {writeFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(holding)},'holding');
for(let n=0;n<40;n++){writeFileSync(${JSON.stringify(heartbeat)},String(n));await Bun.sleep(50);}
writeFileSync(${JSON.stringify(finished)},'finished');`;
  await Bun.write(
    runtime.binary,
    `#!${process.execPath}
import {spawn} from 'node:child_process';
spawn(${JSON.stringify(process.execPath)},['--eval',${JSON.stringify(keeper)}],{detached:true,stdio:['ignore',1,2]}).unref();
const deadline=performance.now()+1500;
while(!(await Bun.file(${JSON.stringify(holding)}).exists())&&performance.now()<deadline)await Bun.sleep(10);
if(!(await Bun.file(${JSON.stringify(holding)}).exists()))process.exit(2);
console.log(JSON.stringify({ready:true}));
${mode === "abort" ? "await Bun.sleep(60_000);" : "process.exit(0);"}
`
  );
  const controller = new AbortController();
  const started = performance.now();
  const request = invokeNativeRuntime({
    runtime,
    cwd: runtime.home,
    args: ["graph", "native", "inspect", "--run-id", "a".repeat(32), "--json"],
    timeoutMs: 5000,
    signal: controller.signal,
    boundNativeAuthoredReadDrain: true,
  });
  void request.catch(() => undefined);
  let failed: unknown;
  let completed = false;
  try {
    if (mode === "abort") {
      while (
        !(await Bun.file(holding).exists()) &&
        performance.now() - started < 1500
      ) {
        await Bun.sleep(10);
      }
      expect(await Bun.file(holding).exists()).toBe(true);
      controller.abort();
      await expect(request).rejects.toThrow("canceled");
    } else {
      expect(await request).toEqual({ ready: true });
    }
    expect(performance.now() - started).toBeLessThan(1500);
    expect(await Bun.file(finished).exists()).toBe(false);
    const before = Number(await Bun.file(heartbeat).text());
    await Bun.sleep(150);
    expect(Number(await Bun.file(heartbeat).text())).toBeGreaterThan(before);
  } catch (error: unknown) {
    failed = error;
  } finally {
    controller.abort();
    await request.catch(() => undefined);
    const deadline = performance.now() + 4000;
    while (
      !(await Bun.file(finished).exists()) &&
      performance.now() < deadline
    ) {
      await Bun.sleep(10);
    }
    completed = await Bun.file(finished).exists();
    if (!completed) {
      roots.splice(roots.indexOf(runtime.home), 1);
    }
  }
  if (!completed) {
    throw new AggregateError(
      failed === undefined ? [] : [failed],
      "owned keeper completion is unconfirmed; fixture retained"
    );
  }
  if (failed !== undefined) {
    throw failed;
  }
  expect(await Bun.file(finished).text()).toBe("finished");
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

test("cancellation starts at most one native request and reaps only its owned child", async () => {
  for (const mode of ["before", "running", "timeout"]) {
    const runtime = await fixture();
    const marker = join(runtime.home, "attempts");
    const pidFile = join(runtime.home, "pid");
    await Bun.write(
      runtime.binary,
      `#!${process.execPath}
import { appendFileSync, writeFileSync } from "node:fs";
${mode === "timeout" ? "await Bun.sleep(60_000);" : ""}
appendFileSync(${JSON.stringify(marker)}, "attempt\\n");
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
await Bun.sleep(60_000);
`
    );
    const controller = new AbortController();
    if (mode === "before") {
      controller.abort();
    }
    // Pass through every real spawn; observe only this unique fixture binary.
    const spawn = spyOn(Bun, "spawn");
    let child: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const attempt = invokeNativeRuntime({
        runtime,
        cwd: runtime.home,
        args: ["runtime", "up", "--json"],
        signal: controller.signal,
        timeoutMs: mode === "timeout" ? 250 : 2000,
      });
      void attempt.catch(() => undefined);
      const ownCalls = () =>
        spawn.mock.calls.flatMap(([argv], index) =>
          Array.isArray(argv) && argv[0] === runtime.binary ? [index] : []
        );
      let exited = false;
      if (mode !== "before") {
        expect(ownCalls()).toHaveLength(1);
        const result = spawn.mock.results[ownCalls()[0] ?? -1];
        if (result?.type !== "return") {
          throw new Error("fixture spawn did not return its owned child");
        }
        child = result.value;
        void child.exited.then(() => {
          exited = true;
        });
      }
      if (mode === "running") {
        const deadline = performance.now() + 1500;
        while (
          !(await Bun.file(pidFile).exists()) &&
          performance.now() < deadline
        ) {
          await Bun.sleep(10);
        }
        expect(await Bun.file(pidFile).exists()).toBe(true);
        controller.abort();
      }
      await expect(attempt).rejects.toThrow(
        mode === "timeout" ? "timed out" : "canceled"
      );
      expect(ownCalls()).toHaveLength(mode === "before" ? 0 : 1);
      if (mode === "running") {
        if (!child) {
          throw new Error("running fixture lost its parent-owned child");
        }
        expect(await Bun.file(marker).text()).toBe("attempt\n");
        expect(Number(await Bun.file(pidFile).text())).toBe(child.pid);
      } else {
        expect(await Bun.file(marker).exists()).toBe(false);
        expect(await Bun.file(pidFile).exists()).toBe(false);
      }
      // Timeout deliberately precedes the child marker. Parent identity and exit
      // completion must still prove reaping before the request rejects.
      if (child) {
        expect(exited).toBe(true);
        expect(child.signalCode).toBe("SIGKILL");
        let probeFailure: unknown;
        try {
          process.kill(child.pid, 0);
        } catch (error) {
          probeFailure = error;
        }
        expect(probeFailure).toMatchObject({ code: "ESRCH" });
      }
    } finally {
      spawn.mockRestore();
      if (child?.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await child.exited;
      }
    }
  }
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

test("owner cleanup failures preserve a bounded cause without replay or raw diagnostics", async () => {
  const runtime = await fixture();
  const error = await invokeNativeRuntime({
    runtime,
    cwd: runtime.home,
    args: ["owner-fail"],
  }).catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(NativeRuntimeRequestError);
  expect(error).toMatchObject({
    nativeCode: "graph_owner_recovery",
    nativeCauseCode: "graph_relay_identity",
  });
  expect(String(error)).toContain("graph_owner_recovery: graph_relay_identity");
  expect(String(error)).not.toContain("synthetic-secret-diagnostic");
  expect(await Bun.file(join(runtime.home, "attempts")).text()).toBe("attempt");

  const unsafe = await invokeNativeRuntime({
    runtime,
    cwd: runtime.home,
    args: ["owner-unsafe"],
  }).catch((failure: unknown) => failure);
  expect(unsafe).toBeInstanceOf(NativeRuntimeRequestError);
  expect(unsafe).toMatchObject({
    nativeCode: "graph_owner_recovery",
    nativeCauseCode: undefined,
  });
  expect(String(unsafe)).not.toContain("synthetic-secret-diagnostic");
});

test("stop diagnostics identify admitted services and fixed stages without replaying requests", async () => {
  const runtime = await fixture();
  await Bun.write(
    runtime.binary,
    `#!${process.execPath}
import {appendFileSync} from "node:fs";
appendFileSync("attempts", "attempt");
console.error(await Bun.file("diagnostic.json").text());
process.exit(23);
`
  );
  const diagnostic = {
    code: "graph_owner_recovery",
    cause_code: "engine_protocol",
    message: "synthetic-secret-diagnostic",
    stop_failures: {
      version: 1,
      failures: [
        { service: "web", stage: "timeout" },
        { service: "ws", stage: "connect_timeout" },
      ],
    },
  };
  await Bun.write(
    join(runtime.home, "diagnostic.json"),
    JSON.stringify(diagnostic)
  );
  const error = await invokeNativeRuntime({
    runtime,
    cwd: runtime.home,
    args: ["graph", "cleanup"],
  }).catch((failure: unknown) => failure);
  expect(error).toMatchObject({
    nativeCode: "graph_owner_recovery",
    nativeCauseCode: "engine_protocol",
    nativeStopFailures: diagnostic.stop_failures.failures,
  });
  expect(String(error)).toContain("web (timeout), ws (connect_timeout)");
  expect(String(error)).not.toContain("synthetic-secret-diagnostic");
  expect(await Bun.file(join(runtime.home, "attempts")).text()).toBe("attempt");

  for (const stop_failures of [
    { ...diagnostic.stop_failures, version: 2 },
    ...["\n", "\r", "\u2028", "\u2029"].map((ending) => ({
      version: 1,
      failures: [{ service: `web${ending}`, stage: "timeout" }],
    })),
    { ...diagnostic.stop_failures, extra: "synthetic-secret-diagnostic" },
    {
      version: 1,
      failures: [
        { service: "/private/synthetic-secret-diagnostic", stage: "timeout" },
      ],
    },
    {
      version: 1,
      failures: [{ service: "web", stage: "synthetic-secret-diagnostic" }],
    },
    {
      version: 1,
      failures: [
        {
          service: "web",
          stage: "timeout",
          message: "synthetic-secret-diagnostic",
        },
      ],
    },
    {
      version: 1,
      failures: [
        { service: "web", stage: "timeout" },
        { service: "web", stage: "connect" },
      ],
    },
    {
      version: 1,
      failures: Array.from({ length: 33 }, (_, i) => ({
        service: `web${i}`,
        stage: "timeout",
      })),
    },
  ]) {
    await Bun.write(
      join(runtime.home, "diagnostic.json"),
      JSON.stringify({ ...diagnostic, stop_failures })
    );
    const invalid = await invokeNativeRuntime({
      runtime,
      cwd: runtime.home,
      args: ["graph", "cleanup"],
    }).catch((failure: unknown) => failure);
    expect(invalid).toMatchObject({
      nativeCode: "graph_owner_recovery",
      nativeStopFailures: undefined,
    });
    expect(Bun.inspect(invalid)).not.toContain("synthetic-secret-diagnostic");
  }
  await Bun.write(
    join(runtime.home, "diagnostic.json"),
    JSON.stringify({ ...diagnostic, code: "source_conflict" })
  );
  const unrelated = await invokeNativeRuntime({
    runtime,
    cwd: runtime.home,
    args: ["graph", "cleanup"],
  }).catch((failure: unknown) => failure);
  expect(unrelated).toMatchObject({
    nativeCode: "source_conflict",
    nativeStopFailures: undefined,
  });
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
