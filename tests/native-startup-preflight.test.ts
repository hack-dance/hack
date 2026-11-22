import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type WorkerMode = "framed" | "older" | "crash" | "context";

const client = new URL(
  "../src/backends/native-runtime-client.ts",
  import.meta.url
).pathname;

async function runPreflight(mode: WorkerMode) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "hack-startup-preflight-"))
  );
  try {
    await mkdir(join(root, "different-cwd"));
    const binary = join(root, "runtime");
    const launches = join(root, "launches");
    const frontend = join(root, "frontend.ts");
    await Bun.write(
      binary,
      `#!${process.execPath}
import { appendFileSync, readSync, writeSync } from "node:fs";
appendFileSync(${JSON.stringify(launches)}, "x");
const value = Object.keys(process.env).sort();
const error = { code: "registry_image", message: "Reference refused." };
if (process.argv.includes("preflight")) {
  const header = Buffer.alloc(4);
  function read(buffer) {
    let offset = 0;
    while (offset < buffer.length) {
      const size = readSync(0, buffer, offset, buffer.length - offset, null);
      if (size === 0) return false;
      offset += size;
    }
    return true;
  }
  if (${JSON.stringify(mode)} === "older") {
    console.error(JSON.stringify({code: "unsupported_command"}));
    process.exit(2);
  }
  const hello = Buffer.from('{"version":1}');
  header.writeUInt32BE(hello.length);
  writeSync(1, header);
  writeSync(1, hello);
  while (read(header)) {
    const request = Buffer.alloc(header.readUInt32BE());
    if (!read(request)) process.exit(2);
    const { id, intent, cwd, step_store } = JSON.parse(request);
    if (${JSON.stringify(mode)} === "context") {
      const reply = Buffer.from(JSON.stringify({id, value: [cwd, step_store]}));
      header.writeUInt32BE(reply.length);
      writeSync(1, header);
      writeSync(1, reply);
      continue;
    }
    if (${JSON.stringify(mode)} === "crash" && intent.reference === "broken") {
      console.error(JSON.stringify(error));
      process.exit(2);
    }
    const reply = Buffer.from(JSON.stringify(intent.reference === "broken" ? {id, error} : {id, value}));
    header.writeUInt32BE(reply.length);
    writeSync(1, header);
    writeSync(1, reply);
  }
} else if (${JSON.stringify(mode)} === "context") {
  const index = process.argv.indexOf("--step-store");
  console.log(JSON.stringify([process.cwd(), index < 0 ? null : process.argv[index + 1]]));
} else if (process.argv.includes("broken")) {
  console.error(JSON.stringify(error));
  process.exit(2);
} else {
  console.log(JSON.stringify(value));
}
`
    );
    await chmod(binary, 0o700);
    await Bun.write(
      frontend,
      `import { invokeNativeRuntime, nativeStartupPreflight } from ${JSON.stringify(client)};
const [binary, projectRoot] = process.argv.slice(2);
const runtime = { binary, home: projectRoot };
const session = nativeStartupPreflight({ runtime });
const result = [];
try {
  for (const invoke of [invokeNativeRuntime, session.invoke]) {
    for (const reference of ["alpine", "busybox", "broken"]) {
      if (${JSON.stringify(mode)} === "context") {
        process.env.HACK_STEP_STORE = reference === "busybox" ? "on" : "off";
        if (reference === "busybox") await Bun.sleep(1200);
      }
      try {
        result.push(await invoke({
          runtime, cwd: ${JSON.stringify(mode)} === "context" && reference === "busybox"
            ? projectRoot + "/different-cwd" : projectRoot,
          args: ["runtime", "admit-image", "--reference", reference, "--json"],
          timeoutMs: ${JSON.stringify(mode)} === "context" && reference === "broken"
            ? 600001 : (${JSON.stringify(mode)} === "context" ? 1000 : undefined),
        }));
      } catch (error) {
        result.push({ message: error.message, code: error.nativeCode ?? error.code, native: error.nativeMessage });
      }
    }
  }
} finally {
  await session.close();
}
console.log(JSON.stringify(result));
`
    );
    const run = Bun.spawn([process.execPath, frontend, binary, root], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        HOME: root,
        TMPDIR: root,
        USER: "fixture",
        LOGNAME: "fixture",
        DOCKER_HOST: "unix:///nonexistent",
        HACK_HOME: root,
        HACK_DAEMON_AUTOSTART_DISABLE: "1",
        HACK_NO_INTERACTIVE: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exit, stdout, stderr] = await Promise.all([
      run.exited,
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(exit).toBe(0);
    const replies: unknown[] = JSON.parse(stdout);
    return { replies, launches: await Bun.file(launches).text() };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
test("the preflight client closes the environment and preserves runtime failure rendering", async () => {
  const { replies, launches } = await runPreflight("framed");
  expect(replies.slice(0, 3)).toEqual(replies.slice(3));
  expect(replies[0]).toEqual(["HOME", "LOGNAME", "PATH", "TMPDIR", "USER"]);
  expect(replies[2]).toEqual({
    message:
      "Native runtime request failed (registry_image); inspect owned state before retrying.",
    code: "registry_image",
  });
  expect(launches).toBe("xxxx");
});

test("an older runtime refuses negotiation before any staged operation is sent", async () => {
  const { replies, launches } = await runPreflight("older");
  expect(replies.slice(0, 3)).toEqual(replies.slice(3));
  expect(launches).toBe("xxxxxxx");
});

test("a crash after negotiation keeps the one-shot diagnostic without replaying", async () => {
  const { replies, launches } = await runPreflight("crash");
  expect(replies.slice(0, 3)).toEqual(replies.slice(3));
  expect(launches).toBe("xxxx");
});

test("each staged request carries its working directory and current step-store setting", async () => {
  const { replies, launches } = await runPreflight("context");
  expect(replies.slice(0, 3)).toEqual(replies.slice(3));
  expect(replies[0]).toEqual([expect.any(String), null]);
  expect(replies[1]).toEqual([
    expect.stringMatching(/different-cwd$/),
    expect.stringMatching(/store$/),
  ]);
  expect(replies[2]).toMatchObject({ code: "E_CONFIG_INVALID" });
  expect(launches).toBe("xxx");
});
