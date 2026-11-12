import { expect, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const modulePath = new URL(
  "../src/backends/native-log-follow.ts",
  import.meta.url
).pathname;
const container = "a".repeat(64);
const selection = {
  run: "b".repeat(32),
  owner: "c".repeat(32),
  plan: "d".repeat(64),
  namespace: "e".repeat(64),
  native: true,
  container,
};

async function waitFile(path: string): Promise<string> {
  const until = Date.now() + 4000;
  while (Date.now() < until) {
    try {
      return await readFile(path, "utf8");
    } catch {
      await Bun.sleep(10);
    }
  }
  throw new Error("Fixture did not reach its expected checkpoint");
}

async function fixture(
  mode:
    | "plain"
    | "pipe"
    | "admission"
    | "select-wait"
    | "restart-wait"
    | "output-error"
    | "restart"
    | "restored"
    | "unchanged"
    | "normal"
    | "idle"
    | "blocked"
    | "broken"
    | "slow"
    | "error"
    | "malformed"
    | "flood"
    | "stopped-idle"
    | "long-partial"
) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "native-log-process-"))
  );
  const caseSelection =
    mode === "restored"
      ? { ...selection, native: false, container: undefined }
      : selection;
  const binary = join(root, "runtime");
  const frontend = join(root, "frontend.ts");
  const wire = JSON.stringify({
    version: 2,
    timestamp: mode === "normal" ? "2026-01-01T00:00:00Z" : null,
    kind: "native-log-chunk",
    service: "web-2",
    container,
    stream: "stderr",
    data: Buffer.from("hello\n").toString("base64"),
  });
  await writeFile(
    binary,
    `#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
import { once } from "node:events";
const root = process.argv[3];
writeFileSync(root + "/args", JSON.stringify(process.argv.slice(2)));
writeFileSync(root + "/ready", String(process.pid));
process.stdin.on("end", () => { writeFileSync(root + "/leash-ended", "yes"); process.exit(0); });
process.stdin.resume();
setTimeout(() => process.exit(91), ${mode === "flood" ? 10_000 : 5000});
if (${JSON.stringify(mode)} === "error") { console.error(JSON.stringify({code:"native_log_tty_unsupported",message:"Fixture refusal."})); process.exit(2); }
if (${JSON.stringify(mode)} === "malformed") { console.log("invalid-wire"); process.exit(0); }
if (${JSON.stringify(mode)} === "stopped-idle") {
  const partial = JSON.parse(${JSON.stringify(wire)});
  partial.data = Buffer.from("tail fragment").toString("base64");
  console.log(JSON.stringify(partial));
  console.error(JSON.stringify({code:"native_log_stopped_idle",message:"Stopped without EOF."}));
  process.exit(1);
}
if (${JSON.stringify(mode)} === "long-partial") {
  const chunk = JSON.parse(${JSON.stringify(wire)});
  for (let i = 0; i < 17; i++) {
    chunk.data = Buffer.from("x".repeat(4096)).toString("base64");
    if (!process.stdout.write(JSON.stringify(chunk) + "\\n")) await once(process.stdout, "drain");
  }
  chunk.data = Buffer.from("\\nafter\\nfragment").toString("base64");
  console.log(JSON.stringify(chunk));
  process.exit(0);
}
const selectedWire = JSON.parse(${JSON.stringify(wire)});
if (process.argv.includes("--from-start")) selectedWire.container = "9".repeat(64);
if (${JSON.stringify(mode)} !== "idle") { console.log(JSON.stringify(selectedWire)); }
if (${JSON.stringify(mode)} === "flood") {
  const chunk = JSON.parse(${JSON.stringify(wire)});
  chunk.data = Buffer.from("x".repeat(4095) + "\\n").toString("base64");
  const line = JSON.stringify(chunk) + "\\n";
  for (let count = 1; count <= 4096; count++) {
    if (!process.stdout.write(line)) await once(process.stdout, "drain");
    writeFileSync(root + "/progress", String(count));
  }
  writeFileSync(root + "/offered-all", "yes");
}
if (["normal", "slow", "plain", "restart", "restored", "unchanged", "restart-wait"].includes(${JSON.stringify(mode)})) { process.exit(0); }
`
  );
  await chmod(binary, 0o700);
  await writeFile(
    frontend,
    `
import { Writable } from "node:stream";
import { existsSync, writeFileSync } from "node:fs";
import { followNativeLogs } from ${JSON.stringify(modulePath)};
const mode = ${JSON.stringify(mode)};
let attachments = 0;
const output = new Writable({ write(chunk, encoding, callback) {
  if (mode === "stopped-idle" && String(chunk).includes('"type":"end"')) { setTimeout(() => process.stdout.write(chunk, callback), 300); return; }
  if (String(chunk).includes('"type":"log"')) {
    if (mode === "blocked") { writeFileSync(${JSON.stringify(join(root, "blocked"))}, "yes"); return; }
    if (mode === "flood") {
      const released = () => existsSync(${JSON.stringify(join(root, "drain-output"))});
      if (released()) { callback(); return; }
      writeFileSync(${JSON.stringify(join(root, "blocked"))}, "yes");
      const timer = setInterval(() => { if (released()) { clearInterval(timer); callback(); } }, 10);
      return;
    }
    if (mode === "output-error") { callback(Object.assign(new Error("write failure"), {code:"EIO"})); return; }
    if (mode === "broken") { callback(Object.assign(new Error("Consumer closed"), {code:"EPIPE"})); return; }
    if (mode === "slow") { setTimeout(() => process.stdout.write(chunk, callback), 5500); return; }
  }
  process.stdout.write(chunk, callback);
} });
const code = await followNativeLogs({ runtime: { binary: ${JSON.stringify(binary)}, home: ${JSON.stringify(root)} }, cwd: ${JSON.stringify(root)}, selection: mode === "select-wait" ? async () => { writeFileSync(${JSON.stringify(join(root, "waiting"))}, "yes"); return await new Promise(() => {}); } : mode === "admission" ? async () => { throw new Error("private selection failure"); } : ${JSON.stringify(caseSelection)}, resume: mode === "restart-wait" ? async () => { writeFileSync(${JSON.stringify(join(root, "waiting"))}, "yes"); return await new Promise(() => {}); } : ["restart", "restored", "unchanged"].includes(mode) ? async () => ++attachments === 1 ? { ...${JSON.stringify(caseSelection)}, ...(mode === "restart" ? { run: "f".repeat(32), owner: "a".repeat(32) } : {}), container: mode === "unchanged" ? ${JSON.stringify(container)} : "9".repeat(64) } : null : undefined, service: "web-2", tail: mode === "long-partial" ? 0 : 12, since: "2026-01-01T00:00:00Z", timestamps: mode === "normal", json: !["plain", "pipe"].includes(mode), project: "fixture", branch: "topic", stdout: mode === "pipe" ? process.stdout : output });
process.exit(code);
`
  );
  const child = Bun.spawn([process.execPath, frontend], {
    cwd: root,
    env: {
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: root,
      TMPDIR: root,
      XDG_CONFIG_HOME: root,
      XDG_STATE_HOME: root,
      XDG_CACHE_HOME: root,
      XDG_RUNTIME_DIR: root,
      HACK_DAEMON_AUTOSTART_DISABLE: "1",
      HACK_NO_INTERACTIVE: "1",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 11_000,
  });
  return {
    root,
    child,
    async dispose() {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
      await child.exited;
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("fake runtime receives exact selection and emits Compose-shaped JSON lines", async () => {
  const f = await fixture("normal");
  try {
    const output = await new Response(f.child.stdout).text();
    const errors = await new Response(f.child.stderr).text();
    expect(await f.child.exited).toBe(0);
    expect(errors).toBe("Service web-2 stopped.\n");
    const events = output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events.map((event) => event.type)).toEqual(["start", "log", "end"]);
    expect(events[0]).toMatchObject({
      backend: "native",
      project: "fixture",
      branch: "topic",
      follow: true,
      services: ["web-2"],
    });
    expect(events[1]).toMatchObject({
      type: "log",
      backend: "native",
      ts: "2026-01-01T00:00:00Z",
      project: "fixture",
      branch: "topic",
      entry: {
        source: "native",
        service: "web-2",
        stream: "stderr",
        message: "hello",
        timestamp: "2026-01-01T00:00:00Z",
      },
    });
    expect(events[1].entry.instance).toBeUndefined();
    expect(events[2]).toMatchObject({
      type: "end",
      reason: "native_log_service_stopped",
      backend: "native",
    });
    const args: unknown = JSON.parse(
      await readFile(join(f.root, "args"), "utf8")
    );
    expect(args).toEqual([
      "--candidate-root",
      f.root,
      "graph",
      "logs-follow",
      "--run-id",
      selection.run,
      "--service",
      "web-2",
      "--expect-owner",
      selection.owner,
      "--expect-plan",
      selection.plan,
      "--expect-namespace",
      selection.namespace,
      "--expect-container",
      selection.container,
      "--tail",
      "12",
      "--native",
      "--timestamps",
      "--since",
      "1767225600",
    ]);
  } finally {
    await f.dispose();
  }
});

function expectGone(pid: number) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    expect(error).toMatchObject({ code: "ESRCH" });
    return;
  }
  throw new Error("Owned reader is still present after frontend exit");
}

for (const { mode, signal, code } of [
  { mode: "idle", signal: "SIGINT", code: 130 },
  { mode: "blocked", signal: "SIGINT", code: 130 },
  { mode: "idle", signal: "SIGTERM", code: 143 },
] as const) {
  test(`${signal} reaps the read child while ${mode}`, async () => {
    const f = await fixture(mode);
    try {
      await waitFile(join(f.root, mode === "blocked" ? "blocked" : "ready"));
      const pid = Number(await waitFile(join(f.root, "ready")));
      f.child.kill(signal);
      expect(await f.child.exited).toBe(code);
      expectGone(pid);
    } finally {
      await f.dispose();
    }
  });
}

test("closed consumer ends quietly and reaps its reader", async () => {
  const f = await fixture("broken");
  try {
    const errors = await new Response(f.child.stderr).text();
    expect(await f.child.exited).toBe(0);
    expect(errors).toBe("");
    expectGone(Number(await waitFile(join(f.root, "ready"))));
  } finally {
    await f.dispose();
  }
});

test("a stalled consumer backpressures a real subprocess log flood", async () => {
  const f = await fixture("flood");
  try {
    await waitFile(join(f.root, "blocked"));
    const progress = join(f.root, "progress");
    await waitFile(progress);
    // Allow the finite pipe/stream buffers to fill. The offered output is 16 MiB
    // of decoded payload; a frontend that eagerly drains it fails this check.
    await Bun.sleep(500);
    const first = Number(await readFile(progress, "utf8"));
    await Bun.sleep(500);
    const second = Number(await readFile(progress, "utf8"));
    expect(first).toBeGreaterThan(0);
    expect(second).toBe(first);
    expect(second).toBeLessThan(1024);
    expect(await Bun.file(join(f.root, "offered-all")).exists()).toBe(false);
    // Release the same consumer: the producer must now finish its whole offer,
    // ruling out a stalled fixture as the reason its earlier progress stopped.
    await writeFile(join(f.root, "drain-output"), "yes");
    await waitFile(join(f.root, "offered-all"));
    expect(Number(await readFile(progress, "utf8"))).toBe(4096);
    const pid = Number(await waitFile(join(f.root, "ready")));
    f.child.kill("SIGINT");
    expect(await f.child.exited).toBe(130);
    expectGone(pid);
  } finally {
    await f.dispose();
  }
}, 15_000);

test("slow output after reader exit keeps the remaining log and end events", async () => {
  const f = await fixture("slow");
  try {
    const output = await new Response(f.child.stdout).text();
    expect(await f.child.exited).toBe(0);
    expect(await new Response(f.child.stderr).text()).toBe(
      "Service web-2 stopped.\n"
    );
    expect(
      output
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).type)
    ).toEqual(["start", "log", "end"]);
  } finally {
    await f.dispose();
  }
}, 12_000);

test("named runtime refusal survives the streaming stderr boundary", async () => {
  const f = await fixture("error");
  try {
    const errors = await new Response(f.child.stderr).text();
    expect(await f.child.exited).not.toBe(0);
    expect(errors).toContain("native_log_tty_unsupported");
  } finally {
    await f.dispose();
  }
});

test("frontend refusal preserves its named error and closes the JSON envelope", async () => {
  const f = await fixture("malformed");
  try {
    const output = await new Response(f.child.stdout).text();
    const errors = await new Response(f.child.stderr).text();
    expect(await f.child.exited).not.toBe(0);
    expect(errors).toContain("native_log_wire_invalid");
    const events = output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events.map((event) => event.type)).toEqual(["start", "end"]);
    expect(events[1].reason).toBe("native_log_wire_invalid");
    expectGone(Number(await waitFile(join(f.root, "ready"))));
  } finally {
    await f.dispose();
  }
});

test("frontend SIGKILL closes the lifetime pipe even with an idle reader", async () => {
  const f = await fixture("idle");
  try {
    await waitFile(join(f.root, "ready"));
    f.child.kill("SIGKILL");
    await f.child.exited;
    expect(await waitFile(join(f.root, "leash-ended"))).toBe("yes");
  } finally {
    await f.dispose();
  }
});

test("stopped idle completion is named in stderr and JSON end instead of EOF", async () => {
  const f = await fixture("stopped-idle");
  try {
    const output = await new Response(f.child.stdout).text();
    const errors = await new Response(f.child.stderr).text();
    expect(await f.child.exited).not.toBe(0);
    const events = output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events.map((event) => event.type)).toEqual(["start", "log", "end"]);
    expect(events[1].entry.partial).toBe(true);
    expect(events[1].entry.message).toBe("tail fragment [partial]");
    expect(events[2].reason).toBe("native_log_stopped_idle");
    expect(errors).toContain("native_log_stopped_idle");
    expect(errors).toContain("final tail may be incomplete");
  } finally {
    await f.dispose();
  }
});

test("zero tail reaches runtime and truncation continues through a marked partial entry", async () => {
  const f = await fixture("long-partial");
  try {
    const output = await new Response(f.child.stdout).text();
    const errors = await new Response(f.child.stderr).text();
    expect(await f.child.exited).toBe(0);
    expect(errors).toBe("Service web-2 stopped.\n");
    const args: string[] = JSON.parse(
      await readFile(join(f.root, "args"), "utf8")
    );
    expect(args[args.indexOf("--tail") + 1]).toBe("0");
    const events = output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events.map((event) => event.type)).toEqual([
      "start",
      "log",
      "log",
      "log",
      "end",
    ]);
    expect(events[1].entry.truncated).toBe(true);
    expect(events[1].entry.message).toBe(`${"x".repeat(65_536)} [truncated]`);
    expect(events[2].entry.message).toBe("after");
    expect(events[2].entry.truncated).toBeUndefined();
    expect(events[3].entry.partial).toBe(true);
    expect(events[3].entry.message).toBe("fragment [partial]");
    expect(events[4].reason).toBe("native_log_service_stopped");
  } finally {
    await f.dispose();
  }
});

test("admission failure stays inside one NDJSON session with a named end", async () => {
  const f = await fixture("admission");
  try {
    const events = (await new Response(f.child.stdout).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(await f.child.exited).toBe(1);
    expect(events.map((event) => event.type)).toEqual(["start", "end"]);
    expect(events[1].reason).toBe("native_log_failed");
    expect(await new Response(f.child.stderr).text()).not.toContain(
      "private selection failure"
    );
  } finally {
    await f.dispose();
  }
});

test("plain stderr service output reaches stdout without a service prefix", async () => {
  const f = await fixture("plain");
  try {
    expect(await new Response(f.child.stdout).text()).toBe("hello\n");
    expect(await f.child.exited).toBe(0);
    expect(await new Response(f.child.stderr).text()).toBe(
      "Service web-2 stopped.\n"
    );
  } finally {
    await f.dispose();
  }
});

test("closing a real output pipe reaps an idle reader without another service write", async () => {
  const f = await fixture("pipe");
  try {
    const reader = f.child.stdout.getReader();
    expect((await reader.read()).done).toBe(false);
    const pid = Number(await waitFile(join(f.root, "ready")));
    await reader.cancel();
    reader.releaseLock();
    expect(await f.child.exited).toBe(0);
    expectGone(pid);
    expect(await new Response(f.child.stderr).text()).toBe("");
  } finally {
    await f.dispose();
  }
});

for (const mode of ["restart", "restored"] as const) {
  test(`${mode} keeps one session and emits one marker for the replacement container`, async () => {
    const f = await fixture(mode);
    try {
      const events = (await new Response(f.child.stdout).text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(await f.child.exited).toBe(0);
      expect(events.map((event) => event.type)).toEqual([
        "start",
        "log",
        "notice",
        "log",
        "end",
      ]);
      expect(events[2].reason).toBe("native_log_restarted");
      const args: string[] = JSON.parse(
        await readFile(join(f.root, "args"), "utf8")
      );
      expect(args[args.indexOf("--run-id") + 1]).toBe(
        mode === "restart" ? "f".repeat(32) : selection.run
      );
      expect(args[args.indexOf("--expect-container") + 1]).toBe("9".repeat(64));
      expect(args[args.indexOf("--expect-owner") + 1]).toBe(
        mode === "restart" ? "a".repeat(32) : selection.owner
      );
      expect(args[args.indexOf("--tail") + 1]).toBe("1000");
      expect(args).not.toContain("--since");
      expect(args).toContain("--from-start");
    } finally {
      await f.dispose();
    }
  });
}

test("session refuses an unchanged container before starting a second reader", async () => {
  const f = await fixture("unchanged");
  try {
    const events = (await new Response(f.child.stdout).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(await f.child.exited).toBe(1);
    expect(events.map((event) => event.type)).toEqual(["start", "log", "end"]);
    expect(events[2].reason).toBe("native_log_restart_unavailable");
    expect(
      JSON.parse(await readFile(join(f.root, "args"), "utf8"))
    ).not.toContain("--from-start");
  } finally {
    await f.dispose();
  }
});

for (const extra of [
  ["--tail", "invalid"],
  ["--since"],
  ["--not-a-log-option"],
]) {
  test(`real CLI JSON usage failure leaves stdout empty: ${extra.join(" ")}`, async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        new URL("../index.ts", import.meta.url).pathname,
        "logs",
        "web",
        "--follow",
        "--json",
        ...extra,
      ],
      {
        env: {
          ...process.env,
          HACK_RUNTIME_BACKEND: "native",
          HACK_DAEMON_AUTOSTART_DISABLE: "1",
          HACK_NO_INTERACTIVE: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
      }
    );
    expect(await new Response(child.stdout).text()).toBe("");
    expect(await child.exited).toBe(1);
    const errors = await new Response(child.stderr).text();
    expect(errors).toContain("E_USAGE");
    expect(errors.trim().split("\n")).toHaveLength(1);
  });
}

for (const mode of ["select-wait", "restart-wait"] as const) {
  test(`Ctrl-C interrupts a stalled ${mode} admission`, async () => {
    const f = await fixture(mode);
    try {
      await waitFile(join(f.root, "waiting"));
      f.child.kill("SIGINT");
      expect(await f.child.exited).toBe(130);
    } finally {
      await f.dispose();
    }
  }, 2000);
}
test("non-EPIPE output failure still prints a fixed stderr diagnostic", async () => {
  const f = await fixture("output-error");
  try {
    expect(await f.child.exited).toBe(1);
    expect(await new Response(f.child.stderr).text()).toContain(
      "native_log_failed"
    );
  } finally {
    await f.dispose();
  }
});
