import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

// Exercise the production frontend adapter with a minimal owner. Real native
// publisher/group/control semantics run separately in Rust with stream-relay-host.
test.each([
  { restore: false, label: "up", signal: "SIGINT", code: 130 },
  { restore: true, label: "restart", signal: "SIGINT", code: 130 },
  { restore: false, label: "up", signal: "SIGHUP", code: 129 },
  { restore: true, label: "restart", signal: "SIGHUP", code: 129 },
])("group $signal requests explicit owner cleanup ($label)", async ({
  restore,
  signal,
  code,
}) => {
  const root = await mkdtemp(join(tmpdir(), "native-group-stop-"));
  roots.push(root);
  const runtime = join(root, "runtime.ts");
  const binary = join(root, "runtime");
  const launcher = join(root, "launcher.ts");
  const receipt = join(root, "cleanup.json");
  await writeFile(
    runtime,
    `
    import { writeFile } from "node:fs/promises";
    let stop;
    const stopped = new Promise(resolve => stop = resolve);
    const deadline = setTimeout(() => stop(), 10000);
    process.on("SIGTERM", () => stop());
    process.on("SIGINT", () => process.exit(94));
    process.on("SIGHUP", () => process.exit(94));
    const server = Bun.serve({hostname:"127.0.0.1",port:0,fetch:()=>new Response("ready")});
    const port = server.port;
    console.log(JSON.stringify({kind:"graph_foreground_ready",run:"${"a".repeat(32)}"}));
    await stopped;
    clearTimeout(deadline);
    await server.stop(true);
    await writeFile(${JSON.stringify(receipt)}, JSON.stringify({exit:0,port,action:process.argv.includes("serve-restore") ? "restart" : "up"}));
  `
  );
  await writeFile(
    binary,
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(runtime)} "$@"\n`
  );
  await chmod(binary, 0o700);
  const adapter = new URL(
    "../src/backends/native-project-process.ts",
    import.meta.url
  ).pathname;
  const stopSignals = new URL(
    "../src/backends/native-project-foreground-stop.ts",
    import.meta.url
  ).pathname;
  await writeFile(
    launcher,
    `
    import { serveNativeProjectGraph } from ${JSON.stringify(adapter)};
    import { readFile } from "node:fs/promises";
    import { nativeForegroundStopSignals } from ${JSON.stringify(stopSignals)};
    const stop = nativeForegroundStopSignals({});
    const controller = stop.controller;
    try { await serveNativeProjectGraph({
      runtime:{binary:${JSON.stringify(binary)},home:${JSON.stringify(root)}},
      projectRoot:${JSON.stringify(root)},run:"${"a".repeat(32)}",args:[],
      restore:${restore},startupTimeoutMs:5000,signal:controller.signal,
      onReady:async () => console.log("ready"),
    }); } catch(error) { if (!controller.signal.aborted) throw error; }
    // The real frontend also checks cleanup independently after interruption.
    const proof = JSON.parse(await readFile(${JSON.stringify(receipt)}, "utf8"));
    stop.dispose();
    process.exit(proof.exit === 0 ? stop.interruptedExit() : 95);
  `
  );
  const child = Bun.spawn([process.execPath, launcher], {
    cwd: root,
    env: {
      ...privateCliEnv({ root }),
      HOME: root,
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_STATE_HOME: join(root, "state"),
      XDG_CACHE_HOME: join(root, "cache"),
      HACK_DAEMON_AUTOSTART_DISABLE: "1",
      HACK_NO_INTERACTIVE: "1",
    },
    detached: true,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reader = child.stdout.getReader();
    const line = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("launcher readiness timed out")),
          8000
        );
      }),
    ]);
    clearTimeout(timer);
    reader.releaseLock();
    expect(new TextDecoder().decode(line.value).trim()).toBe("ready");
    // The negative PID is essential: signaling only the launcher hid this bug.
    process.kill(-child.pid, signal as NodeJS.Signals);
    const exit = await Promise.race([
      child.exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("owned cleanup timed out")),
          8000
        );
      }),
    ]);
    const errors = await new Response(child.stderr).text();
    expect(errors).toBe("");
    expect(exit).toBe(code);
    const proof = JSON.parse(await readFile(receipt, "utf8"));
    expect(proof.exit).toBe(0);
    expect(proof.action).toBe(restore ? "restart" : "up");
    await expect(fetch(`http://127.0.0.1:${proof.port}`)).rejects.toThrow();
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
  }
}, 20_000);
