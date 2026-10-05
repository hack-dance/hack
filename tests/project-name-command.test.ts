import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp/server.ts";
import { projectNameFixture } from "./helpers/project-name-fixture.ts";

// The same boundary suite can qualify the current branch's compiled binary.
const cli = process.env.HACK_NAME_TEST_BINARY
  ? [resolve(process.env.HACK_NAME_TEST_BINARY)]
  : [process.execPath, resolve(import.meta.dir, "../index.ts")];
let fixture: Awaited<ReturnType<typeof projectNameFixture>>;
let target: Awaited<ReturnType<typeof fixture.createProject>>;
const clients: Client[] = [];

beforeEach(async () => {
  fixture = await projectNameFixture();
  target = await fixture.createProject("legacy", "my_app");
  await fixture.writeRegistry([target.entry]);
  await writeFile(
    join(target.project.projectDir, "hack.env.default.yaml"),
    JSON.stringify({
      version: 1,
      environment: "default",
      secretsprovider: "project_key",
      values: { global: { SYNTHETIC_NAME_VALUE: "fixture-only" } },
    })
  );
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await rm(fixture.root, { recursive: true, force: true });
});

async function invoke(args: readonly string[], cwd = fixture.root) {
  const child = Bun.spawn([...cli, ...args], {
    cwd,
    env: fixture.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

const selectors: readonly {
  args: string[];
  output: string;
  registers?: boolean;
  sanitizedError?: boolean;
}[] = [
  { args: ["config", "get", "name"], output: "my_app" },
  {
    args: ["project", "owner", "show", "--json"],
    output: '"project_slug": "my-app"',
  },
  { args: ["open", "--json"], output: "https://name-fixture.hack.local" },
  {
    args: ["env", "get", "SYNTHETIC_NAME_VALUE"],
    output: "fixture-only",
    sanitizedError: true,
  },
  {
    args: ["branch", "list"],
    output: "No branches registered",
    registers: true,
  },
];

for (const selector of selectors) {
  test(`real CLI ${selector.args.join(" ")} selects canonical and legacy names`, async () => {
    const before = await readFile(fixture.registryPath, "utf8");
    for (const name of ["my-app", "My_App"]) {
      const result = await invoke([...selector.args, "--project", name]);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain(selector.output);
    }
    if (selector.registers) {
      const registry = JSON.parse(await readFile(fixture.registryPath, "utf8"));
      expect(registry.projects).toEqual([
        expect.objectContaining({ id: target.entry.id, name: "my-app" }),
      ]);
    } else {
      // Reads do not migrate registry metadata or runtime names.
      expect(await readFile(fixture.registryPath, "utf8")).toBe(before);
    }
    expect(await readFile(target.project.composeFile, "utf8")).toContain(
      "name: original_runtime"
    );
  }, 15_000);

  test(`real CLI ${selector.args.join(" ")} refuses ambiguous and invalid names`, async () => {
    const contender = await fixture.createProject("other", "my-app");
    await fixture.writeRegistry([target.entry, contender.entry]);
    const before = await readFile(fixture.registryPath, "utf8");
    for (const name of ["my_app", "my-app", "", "!!!"]) {
      // A valid cwd must not become a fallback when an explicit selector is invalid.
      const result = await invoke(
        [...selector.args, "--project", name],
        target.project.projectRoot
      );
      expect(result.code).not.toBe(0);
      const expected = selector.sanitizedError
        ? "Unable to read env value"
        : name === "" || name === "!!!"
          ? "Invalid --project"
          : "Ambiguous project name";
      if (selector.args.includes("--json")) {
        expect(JSON.parse(result.stdout)).toMatchObject({
          ok: false,
          error: { message: expect.stringContaining(expected) },
        });
      } else {
        expect(result.stderr + result.stdout).toContain(expected);
      }
      expect(result.stdout).not.toContain("fixture-only");
      if (selector.sanitizedError) {
        expect(result.stdout).toBe("");
      }
    }
    expect(await readFile(fixture.registryPath, "utf8")).toBe(before);
  }, 15_000);
}

async function connectMcp() {
  const command = join(fixture.root, "fixture-cli");
  // Spawn the actual current-source CLI (or explicitly selected current build).
  // HACK_MCP_COMMAND is a single executable, not a shell command string.
  await writeFile(
    command,
    `#!${process.execPath}\nconst child = Bun.spawn([...${JSON.stringify(cli)}, ...Bun.argv.slice(2)], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });\nprocess.exit(await child.exited);\n`
  );
  await chmod(command, 0o755);
  const server = createMcpServer({
    cwd: target.project.projectRoot,
    env: { ...fixture.env, HACK_MCP_COMMAND: command },
  });
  const client = new Client({ name: "project-name-boundary", version: "1" });
  clients.push(client);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

test("MCP selectors survive real CLI forwarding and reject aliases with multiple owners", async () => {
  const client = await connectMcp();
  for (const projectName of ["my_app", "my-app", "MY APP"]) {
    const result = await client.callTool({
      name: "hack.project.open",
      arguments: { projectName },
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      ok: true,
      data: { url: "https://name-fixture.hack.local" },
    });
  }
  const contender = await fixture.createProject("other", "my-app");
  await fixture.writeRegistry([target.entry, contender.entry]);
  const before = await readFile(fixture.registryPath, "utf8");
  for (const projectName of ["my_app", "my-app", "", "!!!"]) {
    const result = await client.callTool({
      name: "hack.project.open",
      arguments: { projectName },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      stderr: expect.stringContaining(
        projectName === "" || projectName === "!!!"
          ? "Invalid projectName"
          : "Ambiguous project name"
      ),
    });
  }
  expect(await readFile(fixture.registryPath, "utf8")).toBe(before);
}, 15_000);

async function stubDocker(
  runtime: readonly { name: string; directory: string | null }[]
) {
  const bin = join(fixture.root, "docker");
  const log = join(fixture.root, "docker-calls.jsonl");
  await writeFile(log, "");
  const containers = runtime.map((item, index) => ({
    Id: `synthetic-container-${index}`,
    Config: {
      Labels: {
        "com.docker.compose.project": item.name,
        "com.docker.compose.service": "web",
        "com.docker.compose.project.working_dir": item.directory,
      },
    },
  }));
  await writeFile(
    bin,
    `#!${process.execPath}
import { appendFile } from "node:fs/promises";
const args = Bun.argv.slice(2);
await appendFile(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
const containers = ${JSON.stringify(containers)};
if (args[0] === "ps") {
  for (const container of containers) console.log(JSON.stringify({ ID: container.Id, Names: container.Id, State: "exited" }));
} else if (args[0] === "inspect") {
  console.log(JSON.stringify(containers));
} else if (args[0] !== "rm") {
  process.exit(91);
}
`
  );
  await chmod(bin, 0o755);
  fixture.env.PATH = `${fixture.root}:${fixture.env.PATH ?? ""}`;
  return async () =>
    (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
}

for (const scoped of [false, true]) {
  test(`real prune refuses registry and runtime alias collisions without deleting (scoped=${scoped})`, async () => {
    const second = await fixture.createProject("other", "my-app");
    await fixture.writeRegistry([target.entry, second.entry]);
    await rm(second.project.projectDir, { recursive: true });
    const calls = await stubDocker([
      { name: "my_app", directory: join(fixture.root, "missing", ".hack") },
    ]);
    const before = await readFile(fixture.registryPath, "utf8");
    const result = await invoke([
      "projects",
      "prune",
      "--json",
      ...(scoped ? ["--project", "my-app"] : []),
    ]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("Ambiguous project name") },
    });
    expect(await calls()).toEqual([]);
    expect(await readFile(fixture.registryPath, "utf8")).toBe(before);
  });

  test(`real prune cross-checks runtime alias checkout ownership before any effects (scoped=${scoped})`, async () => {
    await fixture.writeRegistry([{ ...target.entry, name: "my-app" }]);
    // Both registry and container would otherwise be stale-prune candidates.
    await rm(target.project.projectDir, { recursive: true });
    const calls = await stubDocker([
      { name: "my_app", directory: join(fixture.root, "independent", ".hack") },
    ]);
    const before = await readFile(fixture.registryPath, "utf8");
    const result = await invoke([
      "projects",
      "prune",
      "--json",
      ...(scoped ? ["--project", "my-app"] : []),
    ]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("Ambiguous project name") },
    });
    expect((await calls()).map((args) => args[0])).toEqual(["ps", "inspect"]);
    expect(await readFile(fixture.registryPath, "utf8")).toBe(before);
  });

  test(`real prune refuses colliding unregistered runtime names (scoped=${scoped})`, async () => {
    await fixture.writeRegistry([]);
    const calls = await stubDocker([
      {
        name: "my_app",
        directory: join(fixture.root, "first-missing", ".hack"),
      },
      {
        name: "my-app",
        directory: join(fixture.root, "second-missing", ".hack"),
      },
    ]);
    const before = await readFile(fixture.registryPath, "utf8");
    const result = await invoke([
      "projects",
      "prune",
      "--json",
      ...(scoped ? ["--project", "my-app"] : []),
    ]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("Ambiguous project name") },
    });
    expect((await calls()).map((args) => args[0])).toEqual(["ps", "inspect"]);
    expect(await readFile(fixture.registryPath, "utf8")).toBe(before);
  });
}

for (const directoryKind of ["foreign", "missing"] as const) {
  test(`real prune rejects a hidden same-name container with ${directoryKind} ownership`, async () => {
    await fixture.writeRegistry([{ ...target.entry, name: "my-app" }]);
    await rm(target.project.projectDir, { recursive: true });
    const calls = await stubDocker([
      { name: "my_app", directory: target.project.projectDir },
      {
        name: "my_app",
        directory:
          directoryKind === "missing"
            ? null
            : join(fixture.root, "unrelated", ".hack"),
      },
    ]);
    const before = await readFile(fixture.registryPath, "utf8");
    const result = await invoke([
      "projects",
      "prune",
      "--json",
      "--project",
      "my-app",
    ]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("Ambiguous project name") },
    });
    expect((await calls()).map((args) => args[0])).toEqual(["ps", "inspect"]);
    expect(await readFile(fixture.registryPath, "utf8")).toBe(before);
  });
}

for (const checkout of ["primary", "worktree"] as const) {
  test(`real prune permits one alias at the recorded ${checkout}, proving the delete seam is active`, async () => {
    const worktreeRoot = join(fixture.root, "retained-worktree");
    await fixture.writeRegistry([
      {
        ...target.entry,
        name: "my-app",
        ...(checkout === "worktree"
          ? {
              worktrees: [
                {
                  path: worktreeRoot,
                  branch: "feature",
                  lastSeenAt: "2026-01-01T00:00:00Z",
                },
              ],
            }
          : {}),
      },
    ]);
    await rm(target.project.projectDir, { recursive: true });
    const calls = await stubDocker([
      {
        name: checkout === "worktree" ? "my_app--feature" : "my_app",
        directory:
          checkout === "worktree"
            ? join(worktreeRoot, ".hack")
            : target.project.projectDir,
      },
    ]);
    const result = await invoke([
      "projects",
      "prune",
      "--json",
      "--project",
      "my-app",
    ]);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      data: { removedContainerCount: 1 },
    });
    expect((await calls()).at(-1)).toEqual([
      "rm",
      "-f",
      "synthetic-container-0",
    ]);
    expect(
      JSON.parse(await readFile(fixture.registryPath, "utf8")).projects
    ).toEqual([]);
  });
}

test("real prune refuses a grouped live worktree even when the aggregate primary is stale", async () => {
  const liveWorktree = await fixture.createProject("live-worktree", "my_app");
  await fixture.writeRegistry([
    {
      ...target.entry,
      name: "my-app",
      worktrees: [
        {
          path: liveWorktree.project.projectRoot,
          branch: "feature",
          lastSeenAt: "2026-01-01T00:00:00Z",
        },
      ],
    },
  ]);
  await rm(target.project.projectDir, { recursive: true });
  const calls = await stubDocker([
    { name: "my_app", directory: target.project.projectDir },
    { name: "my_app", directory: liveWorktree.project.projectDir },
  ]);
  const before = await readFile(fixture.registryPath, "utf8");
  const result = await invoke([
    "projects",
    "prune",
    "--json",
    "--project",
    "my-app",
  ]);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining("Ambiguous project name") },
  });
  expect((await calls()).map((args) => args[0])).toEqual(["ps", "inspect"]);
  expect(await readFile(fixture.registryPath, "utf8")).toBe(before);
  expect(await readFile(liveWorktree.project.composeFile, "utf8")).toContain(
    "name: original_runtime"
  );
});

for (const directoryKind of ["foreign", "missing"] as const) {
  test(`real prune rejects unregistered same-name containers with ${directoryKind} ownership`, async () => {
    await fixture.writeRegistry([]);
    const calls = await stubDocker([
      { name: "my_app", directory: join(fixture.root, "missing", ".hack") },
      {
        name: "my_app",
        directory:
          directoryKind === "missing" ? null : target.project.projectDir,
      },
    ]);
    const before = await readFile(fixture.registryPath, "utf8");
    const result = await invoke(["projects", "prune", "--json"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("Ambiguous project name") },
    });
    expect((await calls()).map((args) => args[0])).toEqual(["ps", "inspect"]);
    expect(await readFile(fixture.registryPath, "utf8")).toBe(before);
  });
}
