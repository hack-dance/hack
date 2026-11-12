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
    | "normal"
    | "idle"
    | "blocked"
    | "broken"
    | "slow"
    | "error"
    | "malformed"
) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "native-log-process-"))
  );
  const binary = join(root, "runtime");
  const frontend = join(root, "frontend.ts");
  const wire = JSON.stringify({
    version: 1,
    kind: "native-log-chunk",
    service: "web-2",
    container,
    stream: "stderr",
    data: Buffer.from("2026-01-01T00:00:00Z hello\n").toString("base64"),
  });
  await writeFile(
    binary,
    `#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
const root = process.argv[3];
writeFileSync(root + "/args", JSON.stringify(process.argv.slice(2)));
writeFileSync(root + "/ready", String(process.pid));
if (${JSON.stringify(mode)} === "error") { console.error(JSON.stringify({code:"native_log_tty_unsupported",message:"Fixture refusal."})); process.exit(2); }
if (${JSON.stringify(mode)} === "malformed") { console.log("invalid-wire"); process.exit(0); }
if (${JSON.stringify(mode)} !== "idle") { console.log(${JSON.stringify(wire)}); }
if (["normal", "slow"].includes(${JSON.stringify(mode)})) { process.exit(0); }
process.stdin.on("end", () => { writeFileSync(root + "/leash-ended", "yes"); process.exit(0); });
process.stdin.resume();
setTimeout(() => process.exit(91), 5000);
`
  );
  await chmod(binary, 0o700);
  await writeFile(
    frontend,
    `
import { Writable } from "node:stream";
import { writeFileSync } from "node:fs";
import { followNativeLogs } from ${JSON.stringify(modulePath)};
const mode = ${JSON.stringify(mode)};
const output = new Writable({ write(chunk, encoding, callback) {
  if (String(chunk).includes('"type":"log"')) {
    if (mode === "blocked") { writeFileSync(${JSON.stringify(join(root, "blocked"))}, "yes"); return; }
    if (mode === "broken") { callback(Object.assign(new Error("Consumer closed"), {code:"EPIPE"})); return; }
    if (mode === "slow") { setTimeout(() => process.stdout.write(chunk, callback), 5500); return; }
  }
  process.stdout.write(chunk, callback);
} });
const code = await followNativeLogs({ runtime: { binary: ${JSON.stringify(binary)}, home: ${JSON.stringify(root)} }, cwd: ${JSON.stringify(root)}, selection: ${JSON.stringify(selection)}, service: "web-2", tail: 12, since: "2026-01-01T00:00:00Z", json: true, project: "fixture", branch: "topic", stdout: output });
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
    expect(errors).toBe("");
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
      reason: "eof",
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
      "--tail",
      "12",
      "--native",
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

test("slow output after reader exit keeps the remaining log and end events", async () => {
  const f = await fixture("slow");
  try {
    const output = await new Response(f.child.stdout).text();
    expect(await f.child.exited).toBe(0);
    expect(await new Response(f.child.stderr).text()).toBe("");
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
    expect(events[1].reason).toBe("exit:1");
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
