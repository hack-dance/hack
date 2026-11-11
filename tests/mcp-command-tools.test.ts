import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { parseCliArgv, resolveCommand } from "../src/cli/command.ts";
import { CLI_SPEC } from "../src/cli/spec.ts";
import {
  buildCommandControlArgs,
  buildCommandStartArgs,
  parseCommandReadOutput,
} from "../src/mcp/command-tools.ts";
import { createMcpServer } from "../src/mcp/server.ts";

// ---------------------------------------------------------------------------
// HACK-2085: hack.project.command.start|read|inspect|cancel, in-process client.
// The hack binary is a stub (HACK_MCP_COMMAND) that records argv and the
// caller variable and replays a scripted stdout, so no process, journal or
// Docker endpoint is involved; the CLI side has its own tests.
// ---------------------------------------------------------------------------

const COMMAND_ID = "cmd_abcdefghijklmnopqrstuvwxyz";
const roots: string[] = [];
const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function startFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hack-mcp-cmd-")));
  roots.push(root);
  const repo = join(root, "repo");
  await mkdir(join(repo, ".hack"), { recursive: true });
  await writeFile(join(repo, ".hack", "docker-compose.yml"), "services: {}\n");
  await writeFile(
    join(repo, ".hack", "hack.config.json"),
    JSON.stringify({ name: "demo" })
  );
  const state = join(root, "state");
  const argvLog = join(root, "argv.jsonl");
  const responses = join(root, "responses.json");
  await writeFile(responses, "{}");
  const stub = join(root, "hack-stub");
  await writeFile(
    stub,
    [
      `#!${process.execPath}`,
      'import { appendFileSync, readFileSync } from "node:fs";',
      "const args = Bun.argv.slice(2);",
      `appendFileSync(${JSON.stringify(argvLog)}, \`\${JSON.stringify({ args, caller: process.env.HACK_COMMAND_CALLER ?? null })}\\n\`);`,
      `const table = JSON.parse(readFileSync(${JSON.stringify(responses)}, "utf8"));`,
      'const key = args[0] === "commands" ? `commands ${args[1]}` : args[0];',
      'const response = table[key] ?? { stdout: "" };',
      'process.stdout.write(response.stdout ?? "");',
      "process.exitCode = response.exitCode ?? 0;",
    ].join("\n")
  );
  await chmod(stub, 0o755);
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: root,
    HACK_HOME: state,
    HACK_GLOBAL_CONFIG_PATH: join(root, "config.json"),
    HACK_MCP_COMMAND: stub,
  };
  const server = createMcpServer({ cwd: repo, env });
  const client = new Client({ name: "hack-mcp-command-tools", version: "1" });
  clients.push(client);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    auditLog: join(state, "mcp-audit.log"),
    script: async (
      table: Record<string, { stdout: string; exitCode?: number }>
    ) => await writeFile(responses, JSON.stringify(table)),
    invocations: async (): Promise<
      { args: string[]; caller: string | null }[]
    > =>
      (await Bun.file(argvLog).exists())
        ? (await readFile(argvLog, "utf8"))
            .split("\n")
            .filter((line) => line.length > 0)
            .map((line) => JSON.parse(line))
        : [],
  };
}

type Payload = {
  ok: boolean;
  stdout: string;
  data?: Record<string, unknown>;
  spawned?: false;
  error?: { code: string; reason: string; message: string };
};

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>
) {
  const result = await client.callTool({ name, arguments: args });
  return {
    isError: result.isError === true,
    payload: result.structuredContent as Payload,
  };
}

describe("background command MCP tools", () => {
  test("are listed with read-only reads and destructive start and cancel", async () => {
    const fixture = await startFixture();
    const { tools } = await fixture.client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    expect(byName.get("hack.project.command.start")?.annotations).toMatchObject(
      { destructiveHint: true, readOnlyHint: false }
    );
    expect(
      byName.get("hack.project.command.cancel")?.annotations
    ).toMatchObject({ destructiveHint: true });
    expect(byName.get("hack.project.command.read")?.annotations).toMatchObject({
      readOnlyHint: true,
    });
    expect(
      byName.get("hack.project.command.inspect")?.annotations
    ).toMatchObject({ readOnlyHint: true });
    expect(byName.get("hack.project.command.start")?.description).toContain(
      "keeps running"
    );
    expect(byName.get("hack.project.command.start")?.description).toContain(
      "partial"
    );
  });

  test("start runs exec --detach with a fenced argv, passes the session caller and returns the envelope data", async () => {
    const fixture = await startFixture();
    await fixture.script({
      exec: {
        stdout: `${JSON.stringify({ ok: true, data: { commandId: COMMAND_ID, cursor: `${COMMAND_ID}:abcdefgh:0`, state: "accepted" } })}\n`,
      },
    });
    const result = await call(fixture.client, "hack.project.command.start", {
      operation: "exec",
      service: "api",
      cmd: ["--branch", "other", "npm", "test"],
      requestKey: "req-1",
      stallAfterMs: 0,
    });
    expect(result.isError).toBe(false);
    expect(result.payload.ok).toBe(true);
    expect(result.payload.stdout).toBe("");
    expect(result.payload.data).toMatchObject({
      commandId: COMMAND_ID,
      state: "accepted",
    });
    const [invocation] = await fixture.invocations();
    expect(invocation?.args).toEqual([
      "exec",
      "--detach",
      "--json",
      "--request-key=req-1",
      "--stall-after-ms=0",
      "--",
      "api",
      "--branch",
      "other",
      "npm",
      "test",
    ]);
    expect(invocation?.caller).toMatch(/^mcp:[0-9a-f-]{36}$/);
    expect(await readFile(fixture.auditLog, "utf8")).toContain(
      "hack.project.command.start"
    );
  });

  test("a CLI error envelope keeps its registered code", async () => {
    const fixture = await startFixture();
    await fixture.script({
      run: {
        stdout: `${JSON.stringify({ ok: false, error: { code: "E_ADMISSION_LIMIT", message: "busy" } })}\n`,
        exitCode: 1,
      },
    });
    const result = await call(fixture.client, "hack.project.command.start", {
      operation: "run",
      service: "api",
      cmd: [],
      requestKey: "req-2",
    });
    expect(result.isError).toBe(true);
    expect(result.payload.error).toEqual({
      code: "E_ADMISSION_LIMIT",
      reason: "command_error",
      message: "busy",
    });
  });

  test("read caps waitMs at 30000, defaults to 25000, is not audited and returns events with a cursor", async () => {
    const fixture = await startFixture();
    const refused = await call(fixture.client, "hack.project.command.read", {
      commandId: COMMAND_ID,
      waitMs: 30_001,
    });
    expect(refused.payload.spawned).toBe(false);
    expect(refused.payload.error?.code).toBe("E_USAGE");
    const event = {
      v: 1,
      seq: 2,
      type: "command.output",
      payload: { stream: "stdout", offset: 0, length: 3, text: "hi\n" },
    };
    const end = {
      type: "read.end",
      reason: "ended",
      nextCursor: `${COMMAND_ID}:abcdefgh:3`,
      state: "ended",
      gap: false,
      timedOut: false,
      ended: true,
      outcome: "failed",
      exitCode: 3,
    };
    await fixture.script({
      "commands read": {
        stdout: `${JSON.stringify(event)}\n${JSON.stringify(end)}\n`,
      },
    });
    const result = await call(fixture.client, "hack.project.command.read", {
      commandId: COMMAND_ID,
      after: `${COMMAND_ID}:abcdefgh:1`,
    });
    expect(result.payload.ok).toBe(true);
    expect(result.payload.data).toMatchObject({
      events: [event],
      nextCursor: `${COMMAND_ID}:abcdefgh:3`,
      ended: true,
      outcome: "failed",
      exitCode: 3,
      limits: { waitMs: 25_000 },
    });
    const invocations = await fixture.invocations();
    expect(invocations.at(-1)?.args).toEqual([
      "commands",
      "read",
      `--after=${COMMAND_ID}:abcdefgh:1`,
      "--wait-ms=25000",
      "--json",
      "--",
      COMMAND_ID,
    ]);
    expect(await Bun.file(fixture.auditLog).exists()).toBe(false);
  });

  test("inspect is not audited; cancel is", async () => {
    const fixture = await startFixture();
    const envelope = `${JSON.stringify({ ok: true, data: { commandId: COMMAND_ID } })}\n`;
    await fixture.script({
      "commands show": { stdout: envelope },
      "commands cancel": { stdout: envelope },
    });
    expect(
      (
        await call(fixture.client, "hack.project.command.inspect", {
          commandId: COMMAND_ID,
        })
      ).payload.ok
    ).toBe(true);
    expect(await Bun.file(fixture.auditLog).exists()).toBe(false);
    expect(
      (
        await call(fixture.client, "hack.project.command.cancel", {
          commandId: COMMAND_ID,
        })
      ).payload.ok
    ).toBe(true);
    expect(await readFile(fixture.auditLog, "utf8")).toContain(
      "hack.project.command.cancel"
    );
  });

  test("a malformed command id is refused before any spawn", async () => {
    const fixture = await startFixture();
    const result = await call(fixture.client, "hack.project.command.inspect", {
      commandId: "../../etc",
    });
    expect(result.payload.spawned).toBe(false);
    expect(await fixture.invocations()).toEqual([]);
  });
});

describe("argv contracts", () => {
  test("start and control argv parse as the intended CLI command", () => {
    const start = buildCommandStartArgs({
      operation: "exec",
      projectArgs: ["--project=demo"],
      branch: "feature",
      requestKey: "k",
      timeoutMs: 5000,
      capture: "metadata",
      service: "api",
      cmd: ["--json"],
    });
    const parsedStart = parseCliArgv(CLI_SPEC, start);
    // The child's `--json` stays in the command; hack's own flags parse.
    expect(parsedStart.values.detach).toBe(true);
    expect(parsedStart.values.requestKey).toBe("k");
    expect(parsedStart.values.timeoutMs).toBe(5000);
    const resolved = resolveCommand(CLI_SPEC, parsedStart.positionals);
    expect(resolved.command?.name).toBe("exec");
    expect(resolved.remainingPositionals).toEqual(["api", "--json"]);
    for (const action of ["read", "show", "cancel"] as const) {
      const args = buildCommandControlArgs({
        action,
        commandId: COMMAND_ID,
        projectArgs: ["--path=/tmp"],
        waitMs: 0,
      });
      const parsed = parseCliArgv(CLI_SPEC, args);
      const command = resolveCommand(CLI_SPEC, parsed.positionals);
      expect(command.path.map((spec) => spec.name)).toEqual([
        "commands",
        action,
      ]);
      expect(command.remainingPositionals).toEqual([COMMAND_ID]);
    }
  });

  test("read output parsing", () => {
    expect(parseCommandReadOutput("not json\n")).toBeNull();
    expect(
      parseCommandReadOutput(
        `${JSON.stringify({ ok: false, error: { code: "E_COMMAND_NOT_FOUND", message: "x" } })}\n`
      )
    ).toEqual({
      ok: false,
      error: { code: "E_COMMAND_NOT_FOUND", message: "x" },
    });
  });
});
