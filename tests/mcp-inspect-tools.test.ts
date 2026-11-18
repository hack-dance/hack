import { afterEach, expect, test } from "bun:test";
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
import { join, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { parseCliArgv, resolveCommand } from "../src/cli/command.ts";
import { CLI_SPEC } from "../src/cli/spec.ts";
import {
  MCP_ENV_OUTPUT_WITHHELD_MESSAGE,
  projectEnvKeys,
} from "../src/mcp/inspect-projections.ts";
import { MCP_OUTPUT_LIMIT_BYTES } from "../src/mcp/output-budget.ts";
import {
  buildEnvExplainArgs,
  buildExecArgs,
  createMcpServer,
  MCP_INPUT_CEILINGS,
} from "../src/mcp/server.ts";

// ---------------------------------------------------------------------------
// HACK-1133: exec, doctor, env.explain, env.keys and instances MCP tools.
//
// Every fixture is a temp root with its own HOME, HACK_HOME and registry. The
// hack binary is a stub selected by HACK_MCP_COMMAND: it records its argv and
// replays a scripted response per command, so no Docker/OrbStack socket, agent
// client config, keychain or real home directory is touched.
// ---------------------------------------------------------------------------

type ScriptedResponse = {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
};

/** Keyed by the command word, or `env <subcommand>`. */
type ScriptedResponses = Readonly<Record<string, ScriptedResponse>>;

type StubInvocation = {
  readonly args: readonly string[];
  readonly noInteractive: string | null;
};

type InspectFixture = {
  readonly root: string;
  readonly repo: string;
  readonly client: Client;
  readonly script: (responses: ScriptedResponses) => Promise<void>;
  readonly invocations: () => Promise<readonly StubInvocation[]>;
  readonly auditLog: string;
};

type FixtureOptions = {
  /** Session cwd relative to the fixture root (default: the demo repo). */
  readonly cwdName?: string;
  /** Extra registrations, repo roots relative to the fixture root. */
  readonly extraProjects?: readonly { name: string; repoRoot: string }[];
};

const fixtureClients: Client[] = [];
const fixtureRoots: string[] = [];

afterEach(async () => {
  await Promise.all(fixtureClients.splice(0).map((mcp) => mcp.close()));
  await Promise.all(
    fixtureRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true }))
  );
});

function registryRow(opts: { readonly name: string; readonly repo: string }) {
  return {
    id: opts.name,
    createdAt: "2026-01-01T00:00:00Z",
    name: opts.name,
    repoRoot: opts.repo,
    projectDirName: ".hack",
    projectDir: join(opts.repo, ".hack"),
  };
}

async function writeProject(opts: {
  readonly repo: string;
  readonly name: string;
}): Promise<void> {
  await mkdir(join(opts.repo, ".hack"), { recursive: true });
  await writeFile(
    join(opts.repo, ".hack", "docker-compose.yml"),
    "services: {}\n"
  );
  await writeFile(
    join(opts.repo, ".hack", "hack.config.json"),
    JSON.stringify({ name: opts.name })
  );
}

async function startFixture(
  opts: FixtureOptions = {}
): Promise<InspectFixture> {
  // realpath: macOS tmpdir is a symlink; the registry stores canonical roots.
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "hack-mcp-inspect-"))
  );
  fixtureRoots.push(root);
  const repo = join(root, "repo");
  const state = join(root, "state");
  const registryDir = join(root, "registry");
  await writeProject({ repo, name: "demo" });
  await mkdir(registryDir);
  const extra = opts.extraProjects ?? [];
  for (const entry of extra) {
    await writeProject({ repo: join(root, entry.repoRoot), name: entry.name });
  }
  await writeFile(
    join(registryDir, "projects.json"),
    JSON.stringify({
      version: 1,
      projects: [
        registryRow({ name: "demo", repo }),
        ...extra.map((entry) =>
          registryRow({ name: entry.name, repo: join(root, entry.repoRoot) })
        ),
      ],
    })
  );
  let cwd = repo;
  if (opts.cwdName !== undefined) {
    cwd = join(root, opts.cwdName);
    await mkdir(cwd, { recursive: true });
  }
  const argvLog = join(root, "argv.jsonl");
  const responsesPath = join(root, "responses.json");
  await writeFile(responsesPath, "{}");
  const stub = join(root, "hack-stub");
  await writeFile(
    stub,
    [
      `#!${process.execPath}`,
      'import { appendFileSync, readFileSync } from "node:fs";',
      "const args = Bun.argv.slice(2);",
      `appendFileSync(${JSON.stringify(argvLog)}, \`\${JSON.stringify({ args, noInteractive: process.env.HACK_NO_INTERACTIVE ?? null })}\\n\`);`,
      `const responses = JSON.parse(readFileSync(${JSON.stringify(responsesPath)}, "utf8"));`,
      'const key = args[0] === "env" ? `env ${args[1]}` : args[0];',
      'const response = responses[key] ?? { stdout: "{\\"ok\\":true}\\n" };',
      'process.stdout.write(response.stdout ?? "");',
      'process.stderr.write(response.stderr ?? "");',
      "process.exitCode = response.exitCode ?? 0;",
    ].join("\n")
  );
  await chmod(stub, 0o755);
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: root,
    HACK_HOME: state,
    HACK_GLOBAL_CONFIG_PATH: join(registryDir, "config.json"),
    HACK_MCP_COMMAND: stub,
  };
  Reflect.deleteProperty(env, "HACK_NO_INTERACTIVE");
  const server = createMcpServer({ cwd, env });
  const client = new Client({ name: "hack-mcp-inspect", version: "1" });
  fixtureClients.push(client);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    root,
    repo,
    client,
    auditLog: join(state, "mcp-audit.log"),
    script: async (responses) => {
      await writeFile(responsesPath, JSON.stringify(responses));
    },
    invocations: async () => {
      if (!(await Bun.file(argvLog).exists())) {
        return [];
      }
      return (await readFile(argvLog, "utf8"))
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as StubInvocation);
    },
  };
}

type ToolPayload = {
  readonly ok: boolean;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly command: string;
  readonly data?: unknown;
  readonly spawned?: false;
  readonly error?: { code: string; reason: string; message: string };
};

async function call(opts: {
  readonly fixture: InspectFixture;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}): Promise<{
  readonly isError: unknown;
  readonly payload: ToolPayload;
  readonly serialized: string;
}> {
  const result = await opts.fixture.client.callTool({
    name: opts.name,
    arguments: opts.arguments,
  });
  return {
    isError: result.isError,
    payload: result.structuredContent as ToolPayload,
    serialized: JSON.stringify(result),
  };
}

// ---------------------------------------------------------------------------
// hack.project.exec
// ---------------------------------------------------------------------------

test("exec targets the running container with hack exec and ends hack options with --", async () => {
  const fixture = await startFixture();
  const exec = await call({
    fixture,
    name: "hack.project.exec",
    arguments: {
      projectName: "demo",
      branch: "feature/x",
      profiles: ["tools"],
      workdir: "/srv/app dir",
      service: "api",
      cmd: ["sh", "-c", "--help", "--branch", "other", "--version"],
      timeoutMs: 5000,
    },
  });
  expect(exec.isError).toBeUndefined();
  expect(exec.payload).toMatchObject({
    ok: true,
    data: { limits: { timeoutMs: 5000, outputBytes: MCP_OUTPUT_LIMIT_BYTES } },
  });
  const run = await call({
    fixture,
    name: "hack.project.run",
    arguments: { projectName: "demo", service: "api", cmd: ["true"] },
  });
  expect(run.payload.ok).toBe(true);
  expect(await fixture.invocations()).toEqual([
    {
      args: [
        "exec",
        "--project=demo",
        "--branch=feature/x",
        "--profile=tools",
        "--workdir=/srv/app dir",
        "--",
        "api",
        "sh",
        "-c",
        "--help",
        "--branch",
        "other",
        "--version",
      ],
      noInteractive: "1",
    },
    // run stays a separate tool and a separate hack command.
    {
      args: ["run", "--project=demo", "--", "api", "true"],
      noInteractive: "1",
    },
  ]);
});

test("exec echoes the default timeout and the shared output bound", async () => {
  const fixture = await startFixture();
  const exec = await call({
    fixture,
    name: "hack.project.exec",
    arguments: { service: "api", cmd: ["true"] },
  });
  expect(exec.payload).toMatchObject({
    ok: true,
    data: {
      limits: { timeoutMs: 120_000, outputBytes: MCP_OUTPUT_LIMIT_BYTES },
    },
  });
  // No selection: the session cwd is the demo project, so no project flag.
  expect((await fixture.invocations()).map((entry) => entry.args)).toEqual([
    ["exec", "--", "api", "true"],
  ]);
});

test("hack's own parser reads exec child flags as container argv", () => {
  const argv = buildExecArgs({
    projectArgs: ["--project=demo"],
    service: "api",
    cmd: ["node", "--version", "--branch", "other", "--help"],
  });
  const parsed = parseCliArgv(CLI_SPEC, argv);
  expect(parsed.values.version).toBeUndefined();
  expect(parsed.values.help).toBeUndefined();
  expect(parsed.values.branch).toBeUndefined();
  expect(parsed.values.project).toBe("demo");
  const resolved = resolveCommand(CLI_SPEC, parsed.positionals);
  expect(resolved.command?.name).toBe("exec");
  expect(resolved.remainingPositionals).toEqual([
    "api",
    "node",
    "--version",
    "--branch",
    "other",
    "--help",
  ]);
});

const MARKER = "-REFUSED-VALUE-MARKER";

type RefusedCall = {
  readonly label: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
};

const refusedCalls: readonly RefusedCall[] = [
  {
    label: "exec missing cmd",
    name: "hack.project.exec",
    arguments: { projectName: "demo", service: "api" },
  },
  {
    label: "exec empty cmd",
    name: "hack.project.exec",
    arguments: { projectName: "demo", service: "api", cmd: [] },
  },
  {
    label: "exec leading-dash service",
    name: "hack.project.exec",
    arguments: { projectName: "demo", service: MARKER, cmd: [MARKER] },
  },
  {
    label: "exec empty service",
    name: "hack.project.exec",
    arguments: { projectName: "demo", service: "", cmd: ["true"] },
  },
  {
    label: "exec leading-dash branch",
    name: "hack.project.exec",
    arguments: { service: "api", cmd: ["true"], branch: MARKER },
  },
  {
    label: "exec leading-dash profile",
    name: "hack.project.exec",
    arguments: { service: "api", cmd: ["true"], profiles: [MARKER] },
  },
  ...[0, -1, 1.5, MCP_INPUT_CEILINGS.timeoutMs + 1].map((timeoutMs) => ({
    label: `exec timeoutMs=${timeoutMs}`,
    name: "hack.project.exec",
    arguments: { service: "api", cmd: ["true"], timeoutMs },
  })),
  {
    label: "doctor leading-dash branch",
    name: "hack.project.doctor",
    arguments: { branch: MARKER },
  },
  {
    label: "explain missing key",
    name: "hack.project.env.explain",
    arguments: {},
  },
  {
    label: "explain leading-dash key",
    name: "hack.project.env.explain",
    arguments: { key: MARKER },
  },
  {
    label: "explain key with assignment",
    name: "hack.project.env.explain",
    arguments: { key: "TOKEN=ZQXMARKERVALUE" },
  },
  {
    label: "explain dotted key",
    name: "hack.project.env.explain",
    arguments: { key: "api.ZQXMARKERKEY" },
  },
  {
    label: "explain unknown target",
    name: "hack.project.env.explain",
    arguments: { key: "PORT", target: "ZQXMARKERTARGET" },
  },
  {
    label: "explain leading-dash env",
    name: "hack.project.env.explain",
    arguments: { key: "PORT", env: MARKER },
  },
  {
    label: "keys leading-dash service",
    name: "hack.project.env.keys",
    arguments: { service: MARKER },
  },
];

test("invalid exec, doctor and env inputs are typed refusals that never spawn or audit", async () => {
  const fixture = await startFixture();
  for (const refused of refusedCalls) {
    const result = await call({
      fixture,
      name: refused.name,
      arguments: refused.arguments,
    });
    expect({ label: refused.label, isError: result.isError }).toEqual({
      label: refused.label,
      isError: true,
    });
    expect(result.payload).toMatchObject({
      ok: false,
      spawned: false,
      command: "",
      exitCode: 1,
      stdout: "",
      error: { code: "E_USAGE", reason: "invalid_arguments" },
    });
    // Closed diagnostics: the rejected value is never echoed back.
    expect(result.serialized).not.toContain(MARKER);
    expect(result.serialized).not.toContain("ZQXMARKER");
  }
  expect(await fixture.invocations()).toEqual([]);
  expect(await Bun.file(fixture.auditLog).exists()).toBe(false);
});

// ---------------------------------------------------------------------------
// hack.project.doctor
// ---------------------------------------------------------------------------

const DOCTOR_REPORT = {
  ok: true,
  data: {
    checks: [{ id: "bun", status: "ok", detail: "found", durationMs: 1 }],
    summary: [],
    counts: { ok: 1, warn: 0, error: 0 },
  },
};

test("doctor runs doctor --json only, selecting a named project by path", async () => {
  const fixture = await startFixture();
  await fixture.script({
    doctor: { stdout: `${JSON.stringify(DOCTOR_REPORT)}\n` },
  });
  const named = await call({
    fixture,
    name: "hack.project.doctor",
    arguments: { projectName: "demo", branch: "feature/x" },
  });
  expect(named.isError).toBeUndefined();
  expect(named.payload).toMatchObject({ ok: true, data: DOCTOR_REPORT });
  // Repair and migration inputs are not in the schema; they are dropped
  // before argv construction and can never reach the child.
  const repair = await call({
    fixture,
    name: "hack.project.doctor",
    arguments: {
      fix: true,
      migrateEnvConfig: true,
      domainMigration: "apply",
      nativeRunMapping: "repair",
    },
  });
  expect(repair.payload.ok).toBe(true);
  const invocations = await fixture.invocations();
  expect(invocations.map((entry) => entry.args)).toEqual([
    ["doctor", `--path=${fixture.repo}`, "--branch=feature/x", "--json"],
    ["doctor", "--json"],
  ]);
  for (const entry of invocations) {
    expect(entry.noInteractive).toBe("1");
    expect(entry.args.join(" ")).not.toMatch(
      /--fix|--migrate|--domain-migration|--native-|--accept-legacy/
    );
  }
});

test("doctor reports failing checks as ok:false while keeping the parsed report", async () => {
  const fixture = await startFixture();
  const failing = {
    ok: true,
    data: { ...DOCTOR_REPORT.data, counts: { ok: 0, warn: 0, error: 1 } },
  };
  await fixture.script({
    doctor: { stdout: `${JSON.stringify(failing)}\n`, exitCode: 1 },
  });
  const result = await call({
    fixture,
    name: "hack.project.doctor",
    arguments: { path: "." },
  });
  expect(result.isError).toBe(true);
  expect(result.payload).toMatchObject({
    ok: false,
    exitCode: 1,
    data: failing,
  });
  expect((await fixture.invocations()).map((entry) => entry.args)).toEqual([
    ["doctor", `--path=${fixture.repo}`, "--json"],
  ]);
});

// ---------------------------------------------------------------------------
// hack.project.env.explain / hack.project.env.keys
// ---------------------------------------------------------------------------

const SECRET_CANARY = "zqx-secret-canary-7731";

const EXPLAIN_PAYLOAD = {
  key: "DATABASE_URL",
  available: true,
  secret: true,
  format: "project_env_config_v1",
  environment: "dev",
  requested_scope: "api",
  effective_scope: "api",
  target: "compose",
  delivered_to: ["compose"],
  source: "project_env_config",
  precedence: [".hack/hack.env.default.yaml", ".hack/hack.env.dev.yaml"],
};

test("env.explain forwards only allowlisted metadata and withholds child output", async () => {
  const fixture = await startFixture();
  await fixture.script({
    "env explain": {
      stdout: `${JSON.stringify({
        ...EXPLAIN_PAYLOAD,
        value: SECRET_CANARY,
        debug: { resolved: SECRET_CANARY },
      })}\n`,
      stderr: `resolved ${SECRET_CANARY}\n`,
    },
  });
  const result = await call({
    fixture,
    name: "hack.project.env.explain",
    arguments: {
      projectName: "demo",
      env: "dev",
      service: "api",
      target: "compose",
      key: "DATABASE_URL",
    },
  });
  expect(result.isError).toBeUndefined();
  expect(result.payload).toMatchObject({
    ok: true,
    stdout: "",
    stderr: "",
    data: EXPLAIN_PAYLOAD,
  });
  expect(result.serialized).not.toContain(SECRET_CANARY);
  expect((await fixture.invocations()).map((entry) => entry.args)).toEqual([
    [
      "env",
      "explain",
      "--project=demo",
      "--env=dev",
      "--service=api",
      "--target=compose",
      "--json",
      "--",
      "DATABASE_URL",
    ],
  ]);
});

test("hack's own parser reads the env.explain key as the explain positional", () => {
  const parsed = parseCliArgv(
    CLI_SPEC,
    buildEnvExplainArgs({ projectArgs: [], key: "_PORT" })
  );
  expect(parsed.values.json).toBe(true);
  const resolved = resolveCommand(CLI_SPEC, parsed.positionals);
  expect(resolved.command?.name).toBe("explain");
  expect(resolved.remainingPositionals).toEqual(["_PORT"]);
});

test("a failed env call returns fixed stderr and never the child's output", async () => {
  const fixture = await startFixture();
  const failure = {
    stdout: `partial ${SECRET_CANARY}\n`,
    stderr: `YAML parse error near: TOKEN: ${SECRET_CANARY}\n`,
    exitCode: 1,
  };
  await fixture.script({ "env explain": failure, "env list": failure });
  for (const [name, args] of [
    ["hack.project.env.explain", { key: "TOKEN" }],
    ["hack.project.env.keys", {}],
  ] as const) {
    const result = await call({ fixture, name, arguments: args });
    expect(result.isError).toBe(true);
    expect(result.payload).toMatchObject({
      ok: false,
      exitCode: 1,
      stdout: "",
      stderr: MCP_ENV_OUTPUT_WITHHELD_MESSAGE,
      data: null,
    });
    expect(result.serialized).not.toContain(SECRET_CANARY);
  }
  expect(await fixture.invocations()).toHaveLength(2);
});

const ENV_LIST_PAYLOAD = {
  project: "demo",
  env_selection: {
    requested: null,
    default: null,
    effective: "dev",
    overlay_path: "/repo/.hack/hack.env.dev.yaml",
    overlay_exists: true,
  },
  format: "project_env_config_v1",
  scopes: ["global", "api"],
  selected_scope: "global",
  storage: { local_plaintext: { path: "/repo/.hack/.env", exists: true } },
  warnings: [{ kind: "shadowed", key: "PORT", message: SECRET_CANARY }],
  vars: [
    {
      key: "PORT",
      required: false,
      source: "plain_env",
      services: null,
      resolved_from: "project_env_config",
      storage: { kind: "plaintext", location: SECRET_CANARY },
      value: SECRET_CANARY,
    },
    {
      key: "API_TOKEN",
      required: true,
      source: "keychain",
      services: ["api"],
      resolved_from: "project_env_config",
      value: SECRET_CANARY,
    },
    { key: `bad key ${SECRET_CANARY}`, source: "plain_env", value: "x" },
    "not-a-row",
  ],
  missing_required: ["API_TOKEN"],
  materialized: { PORT: SECRET_CANARY },
  materialized_keys: ["PORT"],
};

const ENV_KEYS_DATA = {
  format: "project_env_config_v1",
  environment: "dev",
  selected_scope: "global",
  scopes: ["global", "api"],
  keys: [
    {
      key: "PORT",
      secret: false,
      required: false,
      source: "plain_env",
      resolved_from: "project_env_config",
      services: null,
    },
    {
      key: "API_TOKEN",
      secret: true,
      required: true,
      source: "keychain",
      resolved_from: "project_env_config",
      services: ["api"],
    },
  ],
  missing_required: ["API_TOKEN"],
};

test("env.keys lists key metadata only and never requests or returns values", async () => {
  const fixture = await startFixture();
  await fixture.script({
    "env list": {
      stdout: `${JSON.stringify(ENV_LIST_PAYLOAD)}\n`,
      stderr: `warning: ${SECRET_CANARY}\n`,
    },
  });
  const result = await call({
    fixture,
    name: "hack.project.env.keys",
    arguments: { path: ".", env: "dev", showSecrets: true },
  });
  expect(result.isError).toBeUndefined();
  expect(result.payload).toMatchObject({
    ok: true,
    stdout: "",
    stderr: "",
  });
  expect(result.payload.data).toEqual(ENV_KEYS_DATA);
  expect(result.serialized).not.toContain(SECRET_CANARY);
  const invocations = await fixture.invocations();
  expect(invocations.map((entry) => entry.args)).toEqual([
    ["env", "list", `--path=${fixture.repo}`, "--env=dev", "--json"],
  ]);
  expect(invocations[0]?.args).not.toContain("--show-secrets");
});

test("negative control: the scripted env payload does carry values that a raw tool returns", async () => {
  // The projection itself is what removes values from the payload ...
  expect(JSON.stringify(ENV_LIST_PAYLOAD)).toContain(SECRET_CANARY);
  expect(JSON.stringify(projectEnvKeys(ENV_LIST_PAYLOAD))).not.toContain(
    SECRET_CANARY
  );
  // ... and the same stub output reaches a raw-forwarding tool unchanged, so
  // the env tools' absence of the canary is not a stub or transport artifact.
  const fixture = await startFixture();
  await fixture.script({
    projects: { stdout: `${JSON.stringify(ENV_LIST_PAYLOAD)}\n` },
  });
  const raw = await call({
    fixture,
    name: "hack.projects.list",
    arguments: {},
  });
  expect(raw.serialized).toContain(SECRET_CANARY);
});

// ---------------------------------------------------------------------------
// hack.project.instances
// ---------------------------------------------------------------------------

function runtime(opts: {
  readonly project: string;
  readonly services: Record<string, readonly string[]>;
}) {
  return {
    project: opts.project,
    working_dir: "/repo",
    services: Object.entries(opts.services).map(([service, states]) => ({
      service,
      containers: states.map((state, index) => ({
        id: `${service}-${index}`,
        state,
        labels: { secretish: "label" },
        mounts: [{ source: "/host/path" }],
      })),
    })),
  };
}

const PROJECTS_PAYLOAD = {
  runtime_ok: true,
  projects: [
    {
      name: "other",
      runtime: runtime({ project: "other", services: { web: ["running"] } }),
      branch_runtime: [],
    },
    {
      name: "demo",
      runtime: runtime({
        project: "demo",
        services: { api: ["running"], db: ["running", "exited"] },
      }),
      branch_runtime: [
        {
          branch: "feature-x",
          runtime: runtime({
            project: "demo--feature-x",
            services: { api: ["exited"] },
          }),
        },
        { branch: "broken", runtime: null },
      ],
    },
  ],
};

test("instances lists the default and branch instances of the selected project", async () => {
  const fixture = await startFixture();
  await fixture.script({
    projects: { stdout: `${JSON.stringify(PROJECTS_PAYLOAD)}\n` },
  });
  const result = await call({
    fixture,
    name: "hack.project.instances",
    arguments: { projectName: "Demo" },
  });
  expect(result.isError).toBeUndefined();
  expect(result.payload.data).toEqual({
    project: "demo",
    found: true,
    runtime_ok: true,
    instances: [
      {
        branch: null,
        compose_project: "demo",
        working_dir: "/repo",
        services: [
          { service: "api", containers: 1, running: 1 },
          { service: "db", containers: 2, running: 1 },
        ],
      },
      {
        branch: "feature-x",
        compose_project: "demo--feature-x",
        working_dir: "/repo",
        services: [{ service: "api", containers: 1, running: 0 }],
      },
    ],
  });
  expect(result.serialized).not.toContain("/host/path");
  expect((await fixture.invocations()).map((entry) => entry.args)).toEqual([
    ["projects", "--json", "--project=demo"],
  ]);
});

test("instances resolves paths and the session cwd to the deepest registration", async () => {
  const fixture = await startFixture({
    extraProjects: [{ name: "inner", repoRoot: "repo/packages/inner" }],
  });
  await mkdir(join(fixture.repo, "src"), { recursive: true });
  await fixture.script({
    projects: { stdout: `${JSON.stringify(PROJECTS_PAYLOAD)}\n` },
  });
  const fromCwd = await call({
    fixture,
    name: "hack.project.instances",
    arguments: {},
  });
  const fromSubdir = await call({
    fixture,
    name: "hack.project.instances",
    arguments: { path: "src" },
  });
  const nested = await call({
    fixture,
    name: "hack.project.instances",
    arguments: { repoRoot: resolve(fixture.repo, "packages/inner") },
  });
  expect(fromCwd.payload.data).toMatchObject({ project: "demo", found: true });
  expect(fromSubdir.payload.data).toMatchObject({
    project: "demo",
    found: true,
  });
  // "inner" is registered but absent from the runtime listing.
  expect(nested.payload.data).toEqual({
    project: "inner",
    found: false,
    runtime_ok: true,
    instances: [],
  });
  expect((await fixture.invocations()).map((entry) => entry.args)).toEqual([
    ["projects", "--json", "--project=demo"],
    ["projects", "--json", "--project=demo"],
    ["projects", "--json", "--project=inner"],
  ]);
});

test("instances refuses unregistered or ambiguous selections before spawning", async () => {
  const fixture = await startFixture({
    cwdName: "outside",
    extraProjects: [
      { name: "twin-a", repoRoot: "shared" },
      { name: "twin-b", repoRoot: "shared" },
    ],
  });
  const cases = [
    { arguments: {}, reason: "no_project_context" },
    { arguments: { path: "." }, reason: "path_not_registered" },
    { arguments: { path: "missing-dir" }, reason: "path_not_found" },
    {
      arguments: { path: join(fixture.root, "shared") },
      reason: "ambiguous_project",
    },
    { arguments: { projectName: "absent" }, reason: "project_not_found" },
    { arguments: { projectName: "%%%" }, reason: "invalid_project_name" },
    {
      arguments: { projectName: "demo", path: "." },
      reason: "conflicting_project_selection",
    },
  ] as const;
  for (const entry of cases) {
    const result = await call({
      fixture,
      name: "hack.project.instances",
      arguments: entry.arguments,
    });
    expect({ reason: entry.reason, isError: result.isError }).toEqual({
      reason: entry.reason,
      isError: true,
    });
    expect(result.payload).toMatchObject({
      ok: false,
      spawned: false,
      error: { reason: entry.reason },
    });
    expect(result.serialized).not.toContain(fixture.root);
  }
  expect(await fixture.invocations()).toEqual([]);
  expect(await Bun.file(fixture.auditLog).exists()).toBe(false);
});

// ---------------------------------------------------------------------------
// Discovery and documentation contract
// ---------------------------------------------------------------------------

const READ_ONLY = { readOnlyHint: true, openWorldHint: false };
const DESTRUCTIVE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

test("tools/list annotates inspection tools read-only and exec destructive", async () => {
  const fixture = await startFixture();
  const listed = await fixture.client.listTools();
  const byName = new Map(listed.tools.map((tool) => [tool.name, tool]));
  const expectations = [
    ["hack.project.exec", DESTRUCTIVE, ["service", "cmd"]],
    ["hack.project.doctor", READ_ONLY, []],
    ["hack.project.env.explain", READ_ONLY, ["key"]],
    ["hack.project.env.keys", READ_ONLY, []],
    ["hack.project.instances", READ_ONLY, []],
  ] as const;
  for (const [name, annotations, required] of expectations) {
    const tool = byName.get(name);
    expect({ name, annotations: tool?.annotations }).toMatchObject({
      name,
      annotations,
    });
    expect(tool?.inputSchema.required ?? []).toEqual([...required]);
  }
  const doctor = byName.get("hack.project.doctor");
  expect(Object.keys(doctor?.inputSchema.properties ?? {}).sort()).toEqual([
    "branch",
    "path",
    "projectName",
    "repoRoot",
  ]);
  const keys = byName.get("hack.project.env.keys");
  expect(Object.keys(keys?.inputSchema.properties ?? {})).not.toContain(
    "showSecrets"
  );
  expect(
    byName.get("hack.project.env.explain")?.inputSchema.properties?.key
  ).toMatchObject({ type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]*$" });
});

test("docs/reference/mcp-tools.md documents every listed tool and its annotation class", async () => {
  const fixture = await startFixture();
  const listed = await fixture.client.listTools();
  const doc = await readFile(
    resolve(import.meta.dir, "../docs/reference/mcp-tools.md"),
    "utf8"
  );
  const rows = new Map(
    doc
      .split("\n")
      .filter((line) => line.startsWith("| `hack."))
      .map((line) => {
        const cells = line.split("|").map((cell) => cell.trim());
        return [cells[1]?.replaceAll("`", "") ?? "", cells[2] ?? ""] as const;
      })
  );
  const classOf = (annotations: unknown): string => {
    const value = annotations as {
      readOnlyHint?: boolean;
      destructiveHint?: boolean;
    };
    if (value.readOnlyHint) {
      return "read-only";
    }
    return value.destructiveHint ? "destructive" : "additive";
  };
  expect([...rows.keys()].sort()).toEqual(
    listed.tools.map((tool) => tool.name).sort()
  );
  for (const tool of listed.tools) {
    expect({ name: tool.name, class: rows.get(tool.name) }).toEqual({
      name: tool.name,
      class: classOf(tool.annotations),
    });
  }
});
