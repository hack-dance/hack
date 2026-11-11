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

// Exercise the production process adapter in a real foreground group. The fake
// Linux and macOS signal semantics are qualified separately; retain macOS CI coverage.
// runtime owns a real TCP publisher: interrupting that child independently makes
// cleanup unconfirmed, just as the native publisher's private stop would be lost.
test.each([
  { restore: false, label: "up" },
  { restore: true, label: "restart" },
])("group Ctrl-C preserves publisher until confirmed cleanup ($label)", async ({
  restore,
}) => {
  const root = await mkdtemp(join(tmpdir(), "native-group-stop-"));
  roots.push(root);
  const publisher = join(root, "publisher.ts");
  const runtime = join(root, "runtime.ts");
  const binary = join(root, "runtime");
  const launcher = join(root, "launcher.ts");
  const receipt = join(root, "cleanup.json");
  await writeFile(
    publisher,
    `
    process.on("SIGINT", () => process.exit(91));
    process.on("SIGTERM", () => process.exit(92));
    const deadline = setTimeout(() => process.exit(96), 12000);
    const server = Bun.serve({ hostname:"127.0.0.1", port:0, fetch:() => new Response("ready") });
    console.log(server.port);
    if ((await Bun.stdin.text()) !== "stop") process.exit(93);
    await server.stop(true);
    clearTimeout(deadline);
  `
  );
  await writeFile(
    runtime,
    `
    import { writeFile } from "node:fs/promises";
    const publisher = Bun.spawn([process.execPath, ${JSON.stringify(publisher)}], {stdin:"pipe",stdout:"pipe",stderr:"inherit"});
    let stop;
    const stopped = new Promise(resolve => stop = resolve);
    const deadline = setTimeout(() => stop(), 10000);
    process.on("SIGTERM", () => stop());
    process.on("SIGINT", () => process.exit(94));
    const reader = publisher.stdout.getReader();
    const first = await reader.read();
    const port = Number(new TextDecoder().decode(first.value).trim());
    reader.releaseLock();
    console.log(JSON.stringify({kind:"graph_foreground_ready",run:"${"a".repeat(32)}"}));
    await stopped;
    clearTimeout(deadline);
    publisher.stdin.write("stop");
    publisher.stdin.end();
    const exit = await publisher.exited;
    await writeFile(${JSON.stringify(receipt)}, JSON.stringify({exit,port,action:process.argv.includes("serve-restore") ? "restart" : "up"}));
    process.exit(exit === 0 ? 0 : 95);
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
  await writeFile(
    launcher,
    `
    import { serveNativeProjectGraph } from ${JSON.stringify(adapter)};
    import { readFile } from "node:fs/promises";
    const controller = new AbortController();
    process.on("SIGINT", () => controller.abort());
    try { await serveNativeProjectGraph({
      runtime:{binary:${JSON.stringify(binary)},home:${JSON.stringify(root)}},
      projectRoot:${JSON.stringify(root)},run:"${"a".repeat(32)}",args:[],
      restore:${restore},startupTimeoutMs:5000,signal:controller.signal,
      onReady:async () => console.log("ready"),
    }); } catch(error) { if (!controller.signal.aborted) throw error; }
    // The real frontend also checks cleanup independently after interruption.
    const proof = JSON.parse(await readFile(${JSON.stringify(receipt)}, "utf8"));
    process.exit(proof.exit === 0 ? 130 : 95);
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
    process.kill(-child.pid, "SIGINT");
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
    expect(exit).toBe(130);
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
