import { expect, test } from "bun:test";
import { chmod, lstat, mkdtemp, rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";

test("socket is private before chmod without changing later file permissions", async () => {
  const root = await mkdtemp("/tmp/hack-bind-");
  await chmod(root, 0o700);
  let child: Bun.Subprocess | undefined;
  try {
    const spawned = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "fixtures/mcp/private-bind.ts"),
        root,
        process.env.HACK_MCP_READINESS_SOURCE_ROOT ??
          join(import.meta.dir, ".."),
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" }
    );
    child = spawned;
    const [stdout, stderr, code] = await Promise.all([
      new Response(spawned.stdout).text(),
      new Response(spawned.stderr).text(),
      spawned.exited,
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(stdout).toContain("private-before-chmod; mask-restored");
    expect(await lstat(join(root, "mcp.sock")).catch(() => null)).toBeNull();
  } finally {
    if (child?.exitCode === null) {
      child.kill("SIGKILL");
    }
    await child?.exited;
    await rm(root, { recursive: true, force: true });
  }
});

async function waitUntil(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check() && Date.now() < deadline) {
    await Bun.sleep(10);
  }
  expect(check()).toBe(true);
}

for (const mode of ["commit", "fail", "disconnect", "oversize"] as const) {
  test(`sessions wait for ownership publication (${mode})`, async () => {
    const root = await mkdtemp("/tmp/hack-pub-");
    await chmod(root, 0o700);
    const sourceRoot =
      process.env.HACK_MCP_READINESS_SOURCE_ROOT ?? join(import.meta.dir, "..");
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "fixtures/mcp/publication-barrier.ts"),
        root,
        sourceRoot,
        mode,
      ],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" }
    );
    let output = "";
    const consume = (async () => {
      const reader = child.stdout.getReader();
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        output += new TextDecoder().decode(chunk.value);
      }
      reader.releaseLock();
    })();
    let socket: Socket | undefined;
    let overflow: Socket | undefined;
    let recovery: Socket | undefined;
    let recoveryData = "";
    try {
      await waitUntil(() => output.includes("bound\n"));
      socket = createConnection(join(root, "mcp.sock"));
      let data = "";
      let closed = false;
      socket.on("error", () => undefined);
      // Remote EOF ends this protocol; discard any locally queued rejected input.
      socket.once("end", () => socket?.destroy());
      socket.on("data", (chunk) => {
        data += chunk.toString();
      });
      socket.on("close", () => {
        closed = true;
      });
      await new Promise<void>((resolve) => socket?.once("connect", resolve));
      socket.write(
        `${JSON.stringify({ hack_mcp: 1, cwd: root, env: { SYNTHETIC: "private" } })}\n`
      );
      await Bun.sleep(150);
      expect(data).toBe("");
      overflow = createConnection(join(root, "mcp.sock"));
      let overflowClosed = false;
      overflow.on("error", () => undefined);
      overflow.on("close", () => {
        overflowClosed = true;
      });
      await waitUntil(() => overflowClosed);
      if (mode === "disconnect") {
        socket.destroy();
        await waitUntil(() => closed);
      }
      if (mode === "oversize") {
        socket.write(Buffer.alloc(256 * 1024 + 2));
        await waitUntil(() => closed);
        recovery = createConnection(join(root, "mcp.sock"));
        recovery.on("error", () => undefined);
        recovery.once("end", () => recovery?.destroy());
        recovery.on("data", (chunk) => {
          recoveryData += chunk.toString();
        });
        await new Promise<void>((resolve) =>
          recovery?.once("connect", resolve)
        );
        recovery.write(
          `${JSON.stringify({ hack_mcp: 1, cwd: root, env: {} })}\n`
        );
        expect(recoveryData).toBe("");
      }
      child.stdin.end();
      if (mode === "commit") {
        await waitUntil(() => data.includes('"ready":true'));
        await waitUntil(() => output.includes("ready\n"));
        socket.end();
      } else {
        await waitUntil(() => closed);
        expect(data).toBe("");
        if (mode === "oversize") {
          // Readiness proves the rejected connection no longer occupies the only slot.
          await waitUntil(() => recoveryData.includes('"ready":true'));
          recovery?.end();
        }
      }
      await waitUntil(() => child.exitCode !== null);
      expect(child.exitCode).toBe(mode === "fail" ? 1 : 0);
      await consume;
      expect(await lstat(join(root, "mcp.sock")).catch(() => null)).toBeNull();
      expect(
        await lstat(join(root, ".mcp-owner")).catch(() => null)
      ).toBeNull();
    } finally {
      socket?.destroy();
      overflow?.destroy();
      recovery?.destroy();
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
      await child.exited;
      await consume;
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("runner handles SIGTERM during publication without announcing readiness", async () => {
  const root = await mkdtemp("/tmp/hack-pub-stop-");
  await chmod(root, 0o700);
  const sourceRoot =
    process.env.HACK_MCP_READINESS_SOURCE_ROOT ?? join(import.meta.dir, "..");
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "fixtures/mcp/publication-barrier.ts"),
      root,
      sourceRoot,
      "signal",
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" }
  );
  const reader = child.stdout.getReader();
  let output = "";
  try {
    while (!output.includes("bound\n")) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      output += new TextDecoder().decode(chunk.value);
    }
    expect(output).toContain("bound\n");
    child.kill("SIGTERM");
    await Bun.sleep(30);
    child.stdin.end();
    await waitUntil(() => child.exitCode !== null);
    expect(child.exitCode).toBe(0);
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      output += new TextDecoder().decode(chunk.value);
    }
    expect(output).toBe("bound\n");
    expect(await lstat(join(root, "mcp.sock")).catch(() => null)).toBeNull();
    expect(await lstat(join(root, ".mcp-owner")).catch(() => null)).toBeNull();
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
    await child.exited;
    reader.releaseLock();
    await rm(root, { recursive: true, force: true });
  }
}, 7000);
