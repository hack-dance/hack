import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readLinesFromStream } from "../src/ui/lines.ts";

const fixtures: Array<{
  root: string;
  proc: Bun.Subprocess;
  childPid?: number;
}> = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    fixture.proc.kill("SIGKILL");
    await fixture.proc.exited;
    if (fixture.childPid) {
      try {
        process.kill(-fixture.childPid, "SIGKILL");
      } catch {
        /* already stopped */
      }
      try {
        process.kill(fixture.childPid, "SIGKILL");
      } catch {
        /* already stopped */
      }
    }
    await rm(fixture.root, { recursive: true, force: true });
  }
});

async function waitFor(check: () => boolean | Promise<boolean>): Promise<void> {
  const end = Date.now() + 6000;
  while (!(await check())) {
    if (Date.now() >= end) {
      throw new Error("Timed out waiting for MCP fixture");
    }
    await Bun.sleep(20);
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function startFixture(
  opts: {
    tool?: string;
    args?: Record<string, unknown>;
    output?: "stdout" | "stderr";
  } = {}
) {
  const root = await mkdtemp(join(tmpdir(), "hack-mcp-lifetime-"));
  await mkdir(join(root, ".hack"));
  await writeFile(
    join(root, ".hack", "hack.config.json"),
    JSON.stringify({ name: "lifetime-fixture" })
  );
  await writeFile(join(root, ".hack", "docker-compose.yml"), "services: {}\n");
  const stub = join(root, "command");
  const pidFile = join(root, "child.pid");
  await writeFile(
    stub,
    `#!${process.execPath}\nprocess.on("SIGTERM", () => {});\nawait Bun.write(${JSON.stringify(pidFile)}, String(process.pid));\nsetInterval(() => {}, 1000);\n${opts.output ? `process.${opts.output}.write("x".repeat(9 * 1024 * 1024));` : ""}\n`
  );
  await chmod(stub, 0o755);
  const proc = Bun.spawn(
    [
      process.execPath,
      resolve(import.meta.dir, "..", "index.ts"),
      "mcp",
      "serve",
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        HOME: root,
        HACK_HOME: join(root, ".hack"),
        HACK_GLOBAL_CONFIG_PATH: join(root, "global", "hack.config.json"),
        HACK_MCP_COMMAND: stub,
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    }
  );
  const fixture = { root, proc, childPid: undefined as number | undefined };
  fixtures.push(fixture);
  const messages: Array<{
    id?: number;
    result?: {
      isError?: boolean;
      structuredContent?: {
        stdout?: string;
        stderr?: string;
        data?: unknown;
        outputTruncated?: boolean;
        ok?: boolean;
      };
    };
  }> = [];
  const drain = (async () => {
    for await (const line of readLinesFromStream(proc.stdout)) {
      messages.push(JSON.parse(line));
    }
  })();
  const send = async (message: object) => {
    proc.stdin.write(`${JSON.stringify(message)}\n`);
    await proc.stdin.flush();
  };
  await send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "lifetime-fixture", version: "1" },
    },
  });
  await waitFor(() => messages.some((item) => item.id === 1));
  await send({ jsonrpc: "2.0", method: "notifications/initialized" });
  await send({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: opts.tool ?? "hack.projects.list",
      arguments: opts.args ?? {},
    },
  });
  await waitFor(async () => {
    const text = await readFile(pidFile, "utf8").catch(() => "");
    fixture.childPid = Number(text) || undefined;
    return fixture.childPid !== undefined;
  });
  return { fixture, send, messages, drain };
}

test("MCP cancellation stops its command and keeps the session usable", async () => {
  const { fixture, send, messages } = await startFixture();
  expect(alive(fixture.childPid ?? 0)).toBe(true);
  await send({
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId: 2, reason: "fixture cancelled" },
  });
  await waitFor(() => !alive(fixture.childPid ?? 0));
  expect(fixture.proc.exitCode).toBeNull();
  await send({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
  await waitFor(() => messages.some((item) => item.id === 3));
}, 15_000);

test("MCP stdin EOF stops an in-flight command and exits", async () => {
  const { fixture, drain } = await startFixture();
  await fixture.proc.stdin.end();
  await Bun.sleep(100);
  // Clients may escalate an EOF shutdown with SIGTERM while cleanup is draining.
  fixture.proc.kill("SIGTERM");
  await waitFor(() => fixture.proc.exitCode !== null);
  expect(alive(fixture.childPid ?? 0)).toBe(false);
  expect(await fixture.proc.exited).toBe(0);
  await drain;
}, 15_000);

test("MCP log-tail cancellation stops its command", async () => {
  const { fixture, send } = await startFixture({
    tool: "hack.project.logs.tail",
  });
  await send({
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId: 2 },
  });
  await waitFor(() => !alive(fixture.childPid ?? 0));
  expect(fixture.proc.exitCode).toBeNull();
}, 15_000);

test("MCP log-tail timeout stops a command that ignores SIGTERM and returns a result", async () => {
  const { fixture, messages } = await startFixture({
    tool: "hack.project.logs.tail",
    args: { maxMs: 1000 },
  });
  await waitFor(() => messages.some((item) => item.id === 2));
  expect(messages.find((item) => item.id === 2)).toMatchObject({
    result: { structuredContent: { data: { stop_reason: "timeout" } } },
  });
  expect(alive(fixture.childPid ?? 0)).toBe(false);
  expect(fixture.proc.exitCode).toBeNull();
}, 15_000);

test("MCP graceful server termination stops its in-flight command", async () => {
  const { fixture, drain } = await startFixture();
  fixture.proc.kill("SIGTERM");
  await waitFor(() => fixture.proc.exitCode !== null);
  expect(alive(fixture.childPid ?? 0)).toBe(false);
  await drain;
}, 15_000);

for (const tool of ["hack.projects.list", "hack.project.logs.tail"]) {
  for (const output of ["stdout", "stderr"] as const) {
    test(`${tool} bounds oversized ${output} and remains usable`, async () => {
      const { fixture, send, messages } = await startFixture({ tool, output });
      await waitFor(() => messages.some((item) => item.id === 2));
      const result = messages.find((item) => item.id === 2)?.result;
      expect(result?.isError).toBe(true);
      expect(result?.structuredContent?.outputTruncated).toBe(true);
      expect(result?.structuredContent?.ok).toBe(false);
      expect(result?.structuredContent?.data).toBeUndefined();
      expect(result?.structuredContent?.stderr).toContain(
        "8 MiB capture limit"
      );
      const captured =
        (result?.structuredContent?.stdout ?? "") +
        (result?.structuredContent?.stderr ?? "");
      expect(captured.length).toBeLessThan(8 * 1024 * 1024 + 200);
      expect(alive(fixture.childPid ?? 0)).toBe(false);
      await send({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
      await waitFor(() => messages.some((item) => item.id === 3));
    }, 15_000);
  }
}
