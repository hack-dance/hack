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
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { parseCliArgv, resolveCommand } from "../src/cli/command.ts";
import { CLI_SPEC } from "../src/cli/spec.ts";
import {
  buildRunArgs,
  createMcpServer,
  MCP_INPUT_CEILINGS,
  MCP_REFUSALS,
  MCP_UNKNOWN_TOOL_MESSAGE,
  type McpRefusalReason,
} from "../src/mcp/server.ts";
import { testIntegration } from "./helpers/ci.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

let tempDir: string | null = null;
let client: Client | null = null;

afterEach(async () => {
  if (client) {
    try {
      await client.close();
    } catch {
      // Ignore cleanup errors.
    }
    client = null;
  }

  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

testIntegration(
  "mcp server lists the local-first hack tools",
  { timeout: 20_000 },
  async () => {
    const mcp = await startMcpClient();
    const tools = await mcp.listTools();
    const names = tools.tools.map((tool) => tool.name);

    expect(names).toContain("hack.projects.list");
    expect(names).toContain("hack.project.status");
    expect(names).toContain("hack.project.logs.tail");
    expect(names).toContain("hack.project.open");
    expect(names).toContain("hack.project.init");
    expect(names).not.toContain("hack.linear.status");
  }
);

testIntegration(
  "hack.projects.list returns structured data",
  { timeout: 20_000 },
  async () => {
    const mcp = await startMcpClient();
    const result = await mcp.callTool({
      name: "hack.projects.list",
      arguments: {},
    });

    const structured = result.structuredContent as {
      ok: boolean;
      data?: unknown;
    };

    expect(result.isError).toBeUndefined();
    expect(structured.ok).toBe(true);
    expect(structured.data).toEqual({ projects: [{ name: "demo" }] });
  }
);

testIntegration(
  "hack.project.init returns a successful tool result",
  { timeout: 20_000 },
  async () => {
    const mcp = await startMcpClient();
    const repoRoot = join(tempDir ?? "/tmp", "demo-repo");
    await mkdir(repoRoot, { recursive: true });
    const result = await mcp.callTool({
      name: "hack.project.init",
      arguments: {
        path: repoRoot,
      },
    });

    const structured = result.structuredContent as {
      ok: boolean;
      data?: unknown;
    };

    expect(result.isError).toBeUndefined();
    expect(structured.ok).toBe(true);
  }
);

async function startMcpClient(): Promise<Client> {
  tempDir = await mkdtemp(join(tmpdir(), "hack-mcp-"));
  const homeDir = join(tempDir, "home");
  await mkdir(homeDir, { recursive: true });

  const stubPath = join(tempDir, "hack-stub");
  await writeFile(stubPath, buildHackStubScript());
  await chmod(stubPath, 0o755);

  const repoRoot = resolve(import.meta.dir, "..");

  const transport = new StdioClientTransport({
    command: "bun",
    args: ["index.ts", "mcp", "serve"],
    cwd: repoRoot,
    env: privateCliEnv({
      root: tempDir,
      home: homeDir,
      env: { HACK_MCP_COMMAND: stubPath },
    }),
    stderr: "pipe",
  });

  const mcp = new Client({ name: "hack-cli-tests", version: "0.0.0" });
  await mcp.connect(transport);
  client = mcp;
  return mcp;
}

function buildHackStubScript(): string {
  return [
    "#!/usr/bin/env bun",
    "const args = Bun.argv.slice(2)",
    'const cmd = args[0] ?? ""',
    'if (cmd === "projects") {',
    '  console.log(JSON.stringify({ projects: [{ name: "demo" }] }))',
    "  process.exit(0)",
    "}",
    'if (cmd === "ps") {',
    '  console.log(JSON.stringify({ services: [{ name: "deps", status: "running" }] }))',
    "  process.exit(0)",
    "}",
    'if (cmd === "logs") {',
    "  console.log(JSON.stringify({ events: [] }))",
    "  process.exit(0)",
    "}",
    'if (cmd === "open") {',
    '  console.log(JSON.stringify({ url: "https://demo.hack", target: "project" }))',
    "  process.exit(0)",
    "}",
    'if (cmd === "init") {',
    "  console.log(JSON.stringify({ ok: true }))",
    "  process.exit(0)",
    "}",
    'console.error(`unexpected command: ${args.join(" ")}`)',
    "process.exit(1)",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// In-process argv and contract checks (HACK-1133 / HACK-1134). A stub hack
// binary records every argv it receives plus the child's interactivity env;
// the session writes its audit log under the fixture's HACK_HOME.
// ---------------------------------------------------------------------------

const contractClients: Client[] = [];
const contractRoots: string[] = [];

afterEach(async () => {
  await Promise.all(contractClients.splice(0).map((mcp) => mcp.close()));
  await Promise.all(
    contractRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true }))
  );
});

type ContractFixture = {
  readonly client: Client;
  readonly argvLog: string;
  readonly auditLog: string;
};

type RegistryEntryFixture = {
  readonly id: string;
  readonly name: string;
  readonly repoRoot: string;
};

type ContractFixtureOptions = {
  /** Extra registry rows beside the registered `demo` project. */
  readonly extraProjects?: readonly RegistryEntryFixture[];
  /** Session cwd relative to the fixture root (default: the demo repo). */
  readonly cwdName?: string;
};

type StubInvocation = {
  readonly args: readonly string[];
  readonly noInteractive: string | null;
};

async function startContractFixture(
  opts: ContractFixtureOptions = {}
): Promise<ContractFixture & { readonly root: string }> {
  const root = await mkdtemp(join(tmpdir(), "hack-mcp-contract-"));
  contractRoots.push(root);
  const project = join(root, "repo");
  const projectDir = join(project, ".hack");
  const state = join(root, "state");
  const registryDir = join(root, "registry");
  await mkdir(projectDir, { recursive: true });
  await mkdir(registryDir);
  await writeFile(join(projectDir, "docker-compose.yml"), "services: {}\n");
  await writeFile(
    join(projectDir, "hack.config.json"),
    JSON.stringify({ name: "demo" })
  );
  await writeFile(
    join(registryDir, "projects.json"),
    JSON.stringify({
      version: 1,
      projects: [
        {
          id: "demo",
          createdAt: "2026-01-01T00:00:00Z",
          name: "demo",
          repoRoot: project,
          projectDirName: ".hack",
          projectDir,
        },
        ...(opts.extraProjects ?? []).map((entry) => ({
          id: entry.id,
          createdAt: "2026-01-01T00:00:00Z",
          name: entry.name,
          repoRoot: join(root, entry.repoRoot),
          projectDirName: ".hack",
          projectDir: join(root, entry.repoRoot, ".hack"),
        })),
      ],
    })
  );
  let cwd = project;
  if (opts.cwdName !== undefined) {
    cwd = join(root, opts.cwdName);
    await mkdir(cwd, { recursive: true });
  }
  const argvLog = join(root, "argv.jsonl");
  const stub = join(root, "hack-stub");
  await writeFile(
    stub,
    [
      `#!${process.execPath}`,
      'import { appendFileSync } from "node:fs";',
      "const args = Bun.argv.slice(2);",
      `appendFileSync(${JSON.stringify(argvLog)}, \`\${JSON.stringify({ args, noInteractive: process.env.HACK_NO_INTERACTIVE ?? null })}\\n\`);`,
      "console.log(JSON.stringify({ ok: true }));",
    ].join("\n")
  );
  await chmod(stub, 0o755);
  // The server runs HACK_MCP_COMMAND with this env. No runner variable, such
  // as HACK_NO_INTERACTIVE, reaches the stub unless the server sets it.
  const env: Record<string, string | undefined> = privateCliEnv({
    root,
    home: root,
    env: {
      HACK_HOME: state,
      HACK_GLOBAL_CONFIG_PATH: join(registryDir, "config.json"),
      HACK_MCP_COMMAND: stub,
    },
  });
  const server = createMcpServer({ cwd, env });
  const client = new Client({ name: "hack-mcp-contract", version: "1" });
  contractClients.push(client);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, argvLog, auditLog: join(state, "mcp-audit.log"), root };
}

async function readStubInvocations(
  argvLog: string
): Promise<readonly StubInvocation[]> {
  if (!(await Bun.file(argvLog).exists())) {
    return [];
  }
  return (await readFile(argvLog, "utf8"))
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as StubInvocation);
}

test("hack.project.run ends hack options with -- and passes child flags intact", async () => {
  const fixture = await startContractFixture();
  const result = await fixture.client.callTool({
    name: "hack.project.run",
    arguments: {
      projectName: "demo",
      branch: "feature/x",
      profiles: ["tools", "extra"],
      workdir: "/srv/app dir",
      service: "api",
      cmd: ["node", "--version", "--branch", "other"],
    },
  });
  expect(result.isError).toBeUndefined();
  expect(result.structuredContent).toMatchObject({
    ok: true,
    data: { limits: { timeoutMs: 120_000 } },
  });
  expect(await readStubInvocations(fixture.argvLog)).toEqual([
    {
      args: [
        "run",
        "--project=demo",
        "--branch=feature/x",
        "--profile=tools,extra",
        "--workdir=/srv/app dir",
        "--",
        "api",
        "node",
        "--version",
        "--branch",
        "other",
      ],
      noInteractive: "1",
    },
  ]);
});

test("hack's own parser never reads run child flags as hack options", () => {
  const argv = buildRunArgs({
    projectArgs: ["--project=demo"],
    service: "api",
    cmd: ["node", "--version", "--branch", "other"],
  });
  const parsed = parseCliArgv(CLI_SPEC, argv);
  expect(parsed.values.version).toBeUndefined();
  expect(parsed.values.branch).toBeUndefined();
  expect(parsed.values.project).toBe("demo");
  const resolved = resolveCommand(CLI_SPEC, parsed.positionals);
  expect(resolved.command?.name).toBe("run");
  expect(resolved.remainingPositionals).toEqual([
    "api",
    "node",
    "--version",
    "--branch",
    "other",
  ]);
});

test("spawning tools force a non-interactive child and echo effective limits", async () => {
  const markerBefore = process.env.HACK_NO_INTERACTIVE;
  const fixture = await startContractFixture();
  const tail = await fixture.client.callTool({
    name: "hack.project.logs.tail",
    arguments: { projectName: "demo", maxEvents: 5, maxMs: 1000, tail: 3 },
  });
  expect(tail.structuredContent).toMatchObject({
    ok: true,
    data: { limits: { tail: 3, maxEvents: 5, maxMs: 1000 } },
  });
  const snapshot = await fixture.client.callTool({
    name: "hack.project.logs.snapshot",
    arguments: {
      projectName: "demo",
      services: ["api", "worker"],
      query: '{app="x"} |= "-y"',
    },
  });
  expect(snapshot.structuredContent).toMatchObject({
    ok: true,
    data: { limits: { tail: null } },
  });
  const ceiling = await fixture.client.callTool({
    name: "hack.project.run",
    arguments: {
      projectName: "demo",
      service: "api",
      timeoutMs: MCP_INPUT_CEILINGS.timeoutMs,
    },
  });
  expect(ceiling.structuredContent).toMatchObject({
    ok: true,
    data: { limits: { timeoutMs: MCP_INPUT_CEILINGS.timeoutMs } },
  });
  const invocations = await readStubInvocations(fixture.argvLog);
  expect(invocations.map((entry) => entry.args)).toEqual([
    ["logs", "--project=demo", "--json", "--tail=3"],
    [
      "logs",
      "--project=demo",
      "--json",
      "--no-follow",
      '--query={app="x"} |= "-y"',
      "--services=api,worker",
    ],
    ["run", "--project=demo", "--", "api"],
  ]);
  expect(invocations.map((entry) => entry.noInteractive)).toEqual([
    "1",
    "1",
    "1",
  ]);
  // The child env is a copy: the server process env is never mutated.
  expect(process.env.HACK_NO_INTERACTIVE).toBe(markerBefore);
});

const REFUSED_MARKER = "-REFUSED-VALUE-MARKER";

type RefusedCall = {
  readonly label: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
};

const LIMIT_PROBES = [0, -1, 1.5] as const;

function limitProbes(opts: {
  readonly name: string;
  readonly field: keyof typeof MCP_INPUT_CEILINGS;
  readonly base: Record<string, unknown>;
}): RefusedCall[] {
  return [...LIMIT_PROBES, MCP_INPUT_CEILINGS[opts.field] + 1].map((value) => ({
    label: `${opts.name} ${opts.field}=${value}`,
    name: opts.name,
    arguments: { ...opts.base, [opts.field]: value },
  }));
}

const refusedCalls: readonly RefusedCall[] = [
  {
    label: "run leading-dash service",
    name: "hack.project.run",
    arguments: { projectName: "demo", service: REFUSED_MARKER },
  },
  {
    label: "run empty service",
    name: "hack.project.run",
    arguments: { projectName: "demo", service: "" },
  },
  {
    label: "run missing service",
    name: "hack.project.run",
    arguments: { projectName: "demo" },
  },
  {
    label: "run leading-dash branch",
    name: "hack.project.run",
    arguments: { projectName: "demo", service: "api", branch: REFUSED_MARKER },
  },
  {
    label: "status empty branch",
    name: "hack.project.status",
    arguments: { projectName: "demo", branch: "" },
  },
  {
    label: "up leading-dash profile",
    name: "hack.project.up",
    arguments: { projectName: "demo", profiles: [REFUSED_MARKER] },
  },
  {
    label: "down empty profile",
    name: "hack.project.down",
    arguments: { projectName: "demo", profiles: [""] },
  },
  {
    label: "snapshot leading-dash service",
    name: "hack.project.logs.snapshot",
    arguments: { projectName: "demo", service: REFUSED_MARKER },
  },
  {
    label: "snapshot leading-dash services entry",
    name: "hack.project.logs.snapshot",
    arguments: { projectName: "demo", services: ["api", REFUSED_MARKER] },
  },
  {
    label: "open leading-dash target",
    name: "hack.project.open",
    arguments: { projectName: "demo", target: REFUSED_MARKER },
  },
  ...limitProbes({
    name: "hack.project.logs.tail",
    field: "tail",
    base: { projectName: "demo" },
  }),
  ...limitProbes({
    name: "hack.project.logs.tail",
    field: "maxEvents",
    base: { projectName: "demo" },
  }),
  ...limitProbes({
    name: "hack.project.logs.tail",
    field: "maxMs",
    base: { projectName: "demo" },
  }),
  ...limitProbes({
    name: "hack.project.logs.snapshot",
    field: "tail",
    base: { projectName: "demo" },
  }),
  ...limitProbes({
    name: "hack.project.run",
    field: "timeoutMs",
    base: { projectName: "demo", service: "api" },
  }),
];

test("invalid identifiers and limits are typed refusals that never spawn or audit", async () => {
  const fixture = await startContractFixture();
  for (const call of refusedCalls) {
    const result = await fixture.client.callTool({
      name: call.name,
      arguments: call.arguments,
    });
    expect({ label: call.label, isError: result.isError }).toEqual({
      label: call.label,
      isError: true,
    });
    expect(result.structuredContent).toMatchObject({
      ok: false,
      spawned: false,
      command: "",
      exitCode: 1,
      stdout: "",
      error: { code: "E_USAGE" },
    });
    // Closed diagnostics: the rejected value is never echoed back.
    expect(JSON.stringify(result)).not.toContain(REFUSED_MARKER);
  }
  expect(await readStubInvocations(fixture.argvLog)).toEqual([]);
  expect(await Bun.file(fixture.auditLog).exists()).toBe(false);
});

test("project resolution refusals carry existing codes and never spawn", async () => {
  const fixture = await startContractFixture();
  const unknown = await fixture.client.callTool({
    name: "hack.project.down",
    arguments: { projectName: "missing-project" },
  });
  expect(unknown.structuredContent).toMatchObject({
    ok: false,
    spawned: false,
    error: { code: "E_PROJECT_NOT_FOUND", reason: "project_not_found" },
  });
  const ambiguous = await fixture.client.callTool({
    name: "hack.project.run",
    arguments: { projectName: "demo", path: ".", service: "api" },
  });
  expect(ambiguous.structuredContent).toMatchObject({
    ok: false,
    spawned: false,
    stderr: "Use only one of projectName, repoRoot, or path.",
    error: {
      code: "E_USAGE",
      reason: "conflicting_project_selection",
      message: "Use only one of projectName, repoRoot, or path.",
    },
  });
  expect(await readStubInvocations(fixture.argvLog)).toEqual([]);
  expect(await Bun.file(fixture.auditLog).exists()).toBe(false);
});

/**
 * Lowercase alphanumeric so project-name normalization keeps it intact; any
 * echo of caller input (or of registry values it selected) would expose it.
 */
const CANARY = "zqxcanary4821";

type CanaryRefusal = {
  readonly reason: McpRefusalReason;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
  readonly fixture?: ContractFixtureOptions;
};

const canaryRefusals: readonly CanaryRefusal[] = [
  {
    reason: "invalid_arguments",
    name: "hack.project.run",
    arguments: { projectName: "demo", service: `-${CANARY}`, cmd: [CANARY] },
  },
  {
    reason: "conflicting_project_selection",
    name: "hack.project.status",
    arguments: { projectName: CANARY, path: `/nonexistent/${CANARY}` },
  },
  {
    reason: "invalid_project_name",
    name: "hack.project.status",
    arguments: { projectName: `%%%${"!".repeat(3)}%%%` },
  },
  {
    reason: "project_not_found",
    name: "hack.project.status",
    arguments: { projectName: CANARY },
  },
  {
    reason: "ambiguous_project",
    name: "hack.project.status",
    arguments: { projectName: CANARY },
    fixture: {
      extraProjects: [
        { id: `${CANARY}-a`, name: CANARY, repoRoot: `${CANARY}-a` },
        { id: `${CANARY}-b`, name: CANARY, repoRoot: `${CANARY}-b` },
      ],
    },
  },
  {
    reason: "ambiguous_project",
    name: "hack.project.status",
    arguments: { projectName: "idclash" },
    fixture: {
      extraProjects: [
        { id: CANARY, name: "idclash", repoRoot: `${CANARY}-a` },
        { id: CANARY, name: "idclash-twin", repoRoot: `${CANARY}-b` },
      ],
    },
  },
  {
    reason: "path_not_found",
    name: "hack.project.status",
    arguments: { path: `/nonexistent/${CANARY}` },
  },
  {
    reason: "path_not_registered",
    name: "hack.project.logs.snapshot",
    arguments: { path: ".", service: "api" },
    fixture: { cwdName: CANARY },
  },
  {
    reason: "no_project_context",
    name: "hack.project.status",
    arguments: {},
    fixture: { cwdName: CANARY },
  },
  {
    reason: "init_path_required",
    name: "hack.project.init",
    arguments: { name: CANARY, devHost: `${CANARY}.hack` },
  },
];

test("every typed refusal is value-free: fixed message, closed reason, no canary", async () => {
  const covered = new Set<McpRefusalReason>();
  for (const refusal of canaryRefusals) {
    const fixture = await startContractFixture(refusal.fixture);
    const result = await fixture.client.callTool({
      name: refusal.name,
      arguments: refusal.arguments,
    });
    const expected = MCP_REFUSALS[refusal.reason];
    const structured = result.structuredContent as {
      readonly stderr: string;
      readonly error: { readonly message: string };
    };
    expect({ reason: refusal.reason, isError: result.isError }).toEqual({
      reason: refusal.reason,
      isError: true,
    });
    expect(structured).toMatchObject({
      ok: false,
      spawned: false,
      command: "",
      stdout: "",
      error: { code: expected.code, reason: refusal.reason },
    });
    if (refusal.reason === "invalid_arguments") {
      expect(structured.error.message).toStartWith(
        "Invalid arguments: service."
      );
    } else {
      expect(structured.error.message).toBe(expected.message);
    }
    expect(structured.stderr).toBe(structured.error.message);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(CANARY);
    expect(serialized).not.toContain("%%%");
    expect(serialized).not.toContain(fixture.root);
    expect(await readStubInvocations(fixture.argvLog)).toEqual([]);
    expect(await Bun.file(fixture.auditLog).exists()).toBe(false);
    covered.add(refusal.reason);
  }
  const coveredReasons: readonly string[] = [...covered].sort();
  expect(coveredReasons).toEqual(Object.keys(MCP_REFUSALS).sort());
});

test("an unknown tool keeps the in-band isError shape without echoing its name", async () => {
  const fixture = await startContractFixture();
  const result = await fixture.client.callTool({
    name: `hack.${CANARY}`,
    arguments: { projectName: CANARY },
  });
  expect(result).toEqual({
    content: [{ type: "text", text: MCP_UNKNOWN_TOOL_MESSAGE }],
    isError: true,
  });
  expect(MCP_UNKNOWN_TOOL_MESSAGE).toBe("MCP error -32602: Tool not found");
  expect(JSON.stringify(result)).not.toContain(CANARY);
  expect(await readStubInvocations(fixture.argvLog)).toEqual([]);
});

const READ_ONLY = { readOnlyHint: true, openWorldHint: false };
const ADDITIVE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};
const DESTRUCTIVE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

test("tools/list publishes names, annotations and required inputs for every tool", async () => {
  const fixture = await startContractFixture();
  const listed = await fixture.client.listTools();
  expect(
    listed.tools.map((tool) => ({
      name: tool.name,
      annotations: tool.annotations,
      required: tool.inputSchema.required ?? [],
    }))
  ).toEqual([
    {
      name: "hack.projects.list",
      annotations: { title: "List hack projects", ...READ_ONLY },
      required: [],
    },
    {
      name: "hack.project.status",
      annotations: { title: "Project status", ...READ_ONLY },
      required: [],
    },
    {
      name: "hack.project.up",
      annotations: { title: "Start project", ...ADDITIVE },
      required: [],
    },
    {
      name: "hack.project.down",
      annotations: { title: "Stop project", ...DESTRUCTIVE },
      required: [],
    },
    {
      name: "hack.project.restart",
      annotations: { title: "Restart project", ...ADDITIVE },
      required: [],
    },
    {
      name: "hack.project.run",
      annotations: {
        title: "Run command in service container",
        ...DESTRUCTIVE,
      },
      required: ["service"],
    },
    {
      name: "hack.project.logs.snapshot",
      annotations: { title: "Snapshot logs", ...READ_ONLY },
      required: [],
    },
    {
      name: "hack.project.logs.tail",
      annotations: { title: "Tail logs", ...READ_ONLY },
      required: [],
    },
    {
      name: "hack.project.open",
      annotations: { title: "Resolve project URL", ...READ_ONLY },
      required: [],
    },
    {
      name: "hack.project.init",
      annotations: { title: "Initialize project", ...DESTRUCTIVE },
      required: [],
    },
    {
      name: "hack.project.exec",
      annotations: {
        title: "Exec command in running service",
        ...DESTRUCTIVE,
      },
      required: ["service", "cmd"],
    },
    {
      name: "hack.project.doctor",
      annotations: { title: "Diagnose project setup", ...READ_ONLY },
      required: [],
    },
    {
      name: "hack.project.env.explain",
      annotations: { title: "Explain env key", ...READ_ONLY },
      required: ["key"],
    },
    {
      name: "hack.project.env.keys",
      annotations: { title: "List env keys", ...READ_ONLY },
      required: [],
    },
    {
      name: "hack.project.instances",
      annotations: { title: "List project instances", ...READ_ONLY },
      required: [],
    },
    {
      name: "hack.project.target",
      annotations: { title: "Inspect project target", ...READ_ONLY },
      required: [],
    },
  ]);
  const run = listed.tools.find((tool) => tool.name === "hack.project.run");
  expect(run?.inputSchema.properties?.timeoutMs).toMatchObject({
    type: "integer",
    exclusiveMinimum: 0,
    maximum: MCP_INPUT_CEILINGS.timeoutMs,
  });
  expect(run?.inputSchema.properties?.service).toMatchObject({
    type: "string",
    pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]*$",
  });
  expect(run?.outputSchema?.properties).toHaveProperty("spawned");
  expect(run?.outputSchema?.properties).toHaveProperty("error");
});
