import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  collectOnboardingContext,
  type OnboardingEntryPoint,
  onboardingContextWithoutInventory,
  renderOnboardingCore,
  renderOnboardingFrame,
} from "../src/agents/onboarding-prompt.ts";
import { createMcpServer } from "../src/mcp/server.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

/**
 * HACK-1137: every onboarding entry point (`hack init --with`,
 * `hack agent onboard`, `hack agent init`, and the `hack-init` MCP prompt)
 * renders `frame.before + core + frame.after`, where the core is byte-identical
 * for the same repo. CLI entry points run as source CLI children with a
 * private environment; the MCP prompt runs in-process over an in-memory
 * transport. No Docker, real HOME, keychain or client config is reached.
 */

const REPO_ROOT = resolve(import.meta.dir, "..");
const INIT_PROMPT_START = "----- hack onboarding prompt -----\n";
const INIT_PROMPT_END = "\n----- end prompt -----\n";

const roots: string[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) {
    await client.close().catch(() => undefined);
  }
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

type Fixture = {
  readonly root: string;
  readonly repo: string;
  readonly home: string;
  readonly emptyPath: string;
};

/**
 * A repo that exercises every corrected inventory signal: `bun.lock` at the
 * root, nested workspaces with their own (conflicting) lockfile, a non-JS
 * runtime two levels down, runtime pins, env files, compose, and DB signals.
 */
async function createFixture(): Promise<Fixture> {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "hack-onboarding-parity-"))
  );
  roots.push(root);
  const repo = join(root, "repo");
  const files: Record<string, string> = {
    "package.json": JSON.stringify(
      {
        name: "parity",
        private: true,
        workspaces: ["apps/*", "packages/*"],
        packageManager: "bun@1.3.9",
        engines: { node: ">=22" },
        scripts: { "db:migrate": "prisma migrate dev" },
      },
      null,
      2
    ),
    "bun.lock": "{}\n",
    ".nvmrc": "22\n",
    ".env.example": "DATABASE_URL=\n",
    "docker-compose.yml": "services:\n  db:\n    image: postgres:16\n",
    "apps/web/package.json": JSON.stringify({
      name: "web",
      scripts: { dev: "vite --port 5173" },
    }),
    "apps/legacy/package.json": JSON.stringify({
      name: "legacy",
      scripts: { start: "node server.js" },
    }),
    "apps/legacy/package-lock.json": "{}\n",
    "packages/ui/package.json": JSON.stringify({ name: "ui" }),
    "services/worker/Cargo.toml": '[package]\nname = "worker"\n',
    "prisma/schema.prisma": "datasource db {}\n",
  };
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(repo, rel);
    await mkdir(dirname(abs), { recursive: true });
    await Bun.write(abs, content);
  }
  const emptyPath = join(root, "empty-path");
  await mkdir(emptyPath, { recursive: true });
  return { root, repo, home: join(root, "home"), emptyPath };
}

async function runCli(
  fixture: Fixture,
  args: readonly string[]
): Promise<string> {
  const child = Bun.spawn([process.execPath, "index.ts", ...args], {
    cwd: REPO_ROOT,
    env: privateCliEnv({
      root: fixture.root,
      home: fixture.home,
      env: {
        HACK_NO_INTERACTIVE: "1",
        // No agent client binary can be found or launched.
        PATH: fixture.emptyPath,
      },
    }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(exitCode, stderr).toBe(0);
  return stdout;
}

async function connectMcp(cwd: string): Promise<Client> {
  const server = createMcpServer({ cwd, env: { HOME: cwd } });
  const client = new Client({ name: "onboarding-parity", version: "0.0.0" });
  clients.push(client);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

async function mcpPrompt(
  client: Client,
  args: Record<string, string>
): Promise<string> {
  const result = await client.getPrompt({ name: "hack-init", arguments: args });
  expect(result.messages).toHaveLength(1);
  const content = result.messages[0]?.content;
  if (content?.type !== "text") {
    throw new Error("Expected text prompt content");
  }
  return content.text;
}

/** The prompt `hack init --with` printed between its fallback markers. */
function extractInitPrompt(stdout: string): string {
  const start = stdout.indexOf(INIT_PROMPT_START);
  const end = stdout.lastIndexOf(INIT_PROMPT_END);
  if (start < 0 || end < start) {
    throw new Error("init --with printed no onboarding prompt");
  }
  return stdout.slice(start + INIT_PROMPT_START.length, end);
}

type EntryOutput = {
  readonly entryPoint: OnboardingEntryPoint;
  readonly text: string;
};

/**
 * Return one issue per entry point whose output is not exactly its own frame
 * around `core`. An empty list is parity.
 */
function parityIssues(opts: {
  readonly core: string;
  readonly outputs: Readonly<Record<string, EntryOutput>>;
}): string[] {
  const issues: string[] = [];
  for (const [label, output] of Object.entries(opts.outputs)) {
    const frame = renderOnboardingFrame({ entryPoint: output.entryPoint });
    if (!output.text.startsWith(frame.before)) {
      issues.push(`${label}: framing prefix differs`);
      continue;
    }
    if (!output.text.endsWith(frame.after)) {
      issues.push(`${label}: framing suffix differs`);
      continue;
    }
    const core = output.text.slice(
      frame.before.length,
      output.text.length - frame.after.length
    );
    if (core !== opts.core) {
      issues.push(`${label}: core differs from the shared builder`);
    }
  }
  return issues;
}

async function expectedCore(repo: string): Promise<string> {
  return renderOnboardingCore({
    context: await collectOnboardingContext({ startDir: repo }),
  });
}

test("every entry point renders the same discovery-first core for the same repo", async () => {
  const fixture = await createFixture();
  const mcp = await connectMcp(fixture.root);

  // Before init: no `.hack/`, so the shared builder picks new-project mode.
  const freshCore = await expectedCore(fixture.repo);
  expect(freshCore).toContain("stand up hack in this repo");
  const fresh: Record<string, EntryOutput> = {
    "agent onboard": {
      entryPoint: { kind: "agent-onboard" },
      text: await runCli(fixture, ["agent", "onboard", "--path", fixture.repo]),
    },
    "agent init": {
      entryPoint: { kind: "agent-init" },
      text: await runCli(fixture, [
        "agent",
        "init",
        "--path",
        fixture.repo,
        "--client",
        "print",
      ]),
    },
    "mcp hack-init (absolute repoRoot)": {
      entryPoint: { kind: "mcp-hack-init" },
      text: await mcpPrompt(mcp, { repoRoot: fixture.repo }),
    },
    "mcp hack-init (relative repoRoot)": {
      entryPoint: { kind: "mcp-hack-init" },
      text: await mcpPrompt(mcp, {
        repoRoot: relative(fixture.root, fixture.repo),
      }),
    },
  };
  expect(parityIssues({ core: freshCore, outputs: fresh })).toEqual([]);

  // `hack init --with` always runs after the scaffold exists.
  const created = extractInitPrompt(
    await runCli(fixture, [
      "init",
      "--auto",
      "--with",
      "claude",
      "--path",
      fixture.repo,
    ])
  );
  const existing = extractInitPrompt(
    await runCli(fixture, [
      "init",
      "--auto",
      "--with",
      "codex",
      "--path",
      fixture.repo,
    ])
  );

  const adoptedCore = await expectedCore(fixture.repo);
  expect(adoptedCore).toContain("adopt the existing hack setup in this repo");
  expect(adoptedCore).not.toBe(freshCore);
  const adopted: Record<string, EntryOutput> = {
    "init --with (scaffolded)": {
      entryPoint: { kind: "init-with", scaffold: "created" },
      text: created,
    },
    "init --with (existing)": {
      entryPoint: { kind: "init-with", scaffold: "existing" },
      text: existing,
    },
    "agent onboard": {
      entryPoint: { kind: "agent-onboard" },
      text: await runCli(fixture, ["agent", "onboard", "--path", fixture.repo]),
    },
    "agent init": {
      entryPoint: { kind: "agent-init" },
      text: await runCli(fixture, [
        "agent",
        "init",
        "--path",
        join(fixture.repo, "apps", "web"),
        "--client",
        "print",
      ]),
    },
    "mcp hack-init": {
      entryPoint: { kind: "mcp-hack-init" },
      text: await mcpPrompt(mcp, {
        repoRoot: fixture.repo,
        // Ignored with repoRoot: the repo decides mode, name and dev host.
        mode: "new-project",
        projectName: "caller-supplied",
        devHost: "caller.example.test",
      }),
    },
  };
  expect(parityIssues({ core: adoptedCore, outputs: adopted })).toEqual([]);
}, 60_000);

test("the shared core carries the corrected inventory and explicit limits", async () => {
  const fixture = await createFixture();
  const core = await expectedCore(fixture.repo);

  const inventoryAt = core.indexOf("## Repo inventory (pre-computed by Hack)");
  const phaseOneAt = core.indexOf("## Phase 1 — Inventory the repo");
  expect(inventoryAt).toBeGreaterThan(0);
  expect(phaseOneAt).toBeGreaterThan(inventoryAt);
  for (const line of [
    `- Root: ${fixture.repo}`,
    "- Workspaces: apps/*, packages/*",
    "- Package managers: bun.lock",
    "- Nested lockfiles: apps/legacy/package-lock.json",
    "- Package manager conflicts: bun, npm",
    "- Non-JS runtimes: rust (services/worker/Cargo.toml)",
    "- Runtime pins: .nvmrc, package.json#engines, package.json#packageManager",
    "- Env files: .env.example",
    "- apps/web (web): dev -> vite --port 5173",
    "Discovery limitations (check these gaps yourself and report the ones that remain):",
    "- Inventory reads file names and manifest keys only; env files, secrets, lockfile contents, and pin values were not read.",
  ]) {
    expect(core).toContain(line);
  }
  // Name-only inventory: pin values and env-file contents never appear.
  expect(core).not.toContain("bun@1.3.9");
  expect(core).not.toContain(">=22");
  expect(core).not.toContain("DATABASE_URL=");
});

test("the hack-init MCP prompt without repoRoot states the missing inventory and keeps its framing", async () => {
  const fixture = await createFixture();
  const mcp = await connectMcp(fixture.repo);

  const text = await mcpPrompt(mcp, {
    mode: "new-project",
    projectName: "demo",
  });
  expect(text).toBe(
    renderOnboardingCore({
      context: onboardingContextWithoutInventory({
        mode: "new-project",
        projectName: "demo",
        reason: "no-repo-root",
      }),
    })
  );
  expect(text).toContain(
    "- Not run: this `hack-init` MCP prompt request named no `repoRoot`."
  );
  // The session cwd is a repo, but without repoRoot nothing is scanned.
  expect(text).not.toContain("Repo context:");
  expect(text).not.toContain(fixture.repo);
});

test("hack-init MCP refusals are closed and never echo the caller's path", async () => {
  const fixture = await createFixture();
  const mcp = await connectMcp(fixture.root);
  const missing = join(fixture.root, "missing-secret-path");

  const error = await mcpPrompt(mcp, { repoRoot: missing }).then(
    () => null,
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(Error);
  const message = error instanceof Error ? error.message : "";
  expect(message).toContain("E_PROJECT_NOT_FOUND: Path not found.");
  expect(message).not.toContain("missing-secret-path");
  expect(message).not.toContain(fixture.root);

  await Bun.write(join(fixture.repo, ".hack", "hack.project.json"), "{}\n");
  const native = await mcpPrompt(mcp, { repoRoot: fixture.repo }).then(
    () => null,
    (caught: unknown) => caught
  );
  const nativeMessage = native instanceof Error ? native.message : "";
  expect(nativeMessage).toContain(
    "E_NATIVE_PROJECT_UNSUPPORTED: hack-init could not inventory the repo."
  );
  expect(nativeMessage).not.toContain(fixture.repo);
});

test("negative control: a drifted entry point fails parity", async () => {
  const fixture = await createFixture();
  const core = await expectedCore(fixture.repo);
  const onboard: OnboardingEntryPoint = { kind: "agent-onboard" };
  const init: OnboardingEntryPoint = { kind: "agent-init" };
  const initFrame = renderOnboardingFrame({ entryPoint: init });

  // The pre-HACK-1137 shape: an entry point that renders the phases without
  // the repo inventory.
  const withoutInventory = renderOnboardingCore({
    context: onboardingContextWithoutInventory({
      mode: "new-project",
      reason: "no-repo-root",
    }),
  });
  // One inventory signal dropped in one path only.
  const droppedSignal = core.replace(
    "- Nested lockfiles: apps/legacy/package-lock.json",
    "- Nested lockfiles: none detected"
  );
  expect(droppedSignal).not.toBe(core);

  expect(
    parityIssues({
      core,
      outputs: {
        aligned: { entryPoint: onboard, text: core },
        "no inventory": { entryPoint: onboard, text: withoutInventory },
        "dropped signal": {
          entryPoint: init,
          text: `${initFrame.before}${droppedSignal}${initFrame.after}`,
        },
        "frame leaked into core": { entryPoint: onboard, text: `x${core}` },
        "frame missing": { entryPoint: init, text: core },
      },
    })
  ).toEqual([
    "no inventory: core differs from the shared builder",
    "dropped signal: core differs from the shared builder",
    "frame leaked into core: core differs from the shared builder",
    "frame missing: framing suffix differs",
  ]);
});

test("entry points reach onboarding text only through the shared builder", async () => {
  // Static drift guard: only the builder module renders inventory or cores,
  // and the MCP prompt alone may render without an inventory.
  const allowed: Readonly<Record<string, readonly string[]>> = {
    "src/agents/onboarding-prompt.ts": [
      "renderInitAssistantInventory",
      "renderOnboardingCore",
      "onboardingContextWithoutInventory",
      "renderOnboardingPrompt",
    ],
    "src/mcp/server.ts": [
      "onboardingContextWithoutInventory",
      "renderOnboardingPrompt",
    ],
    "src/agents/init-assistant.ts": ["renderInitAssistantInventory"],
  };
  const guarded = [
    "renderInitAssistantInventory",
    "renderOnboardingCore",
    "onboardingContextWithoutInventory",
    "renderOnboardingPrompt",
  ];
  const violations: string[] = [];
  for await (const path of new Bun.Glob("src/**/*.ts").scan({
    cwd: REPO_ROOT,
  })) {
    const source = await readFile(join(REPO_ROOT, path), "utf8");
    for (const name of guarded) {
      if (
        new RegExp(`\\b${name}\\b`).test(source) &&
        !allowed[path]?.includes(name)
      ) {
        violations.push(`${path}: ${name}`);
      }
    }
  }
  expect(violations).toEqual([]);

  for (const path of [
    "src/commands/agent.ts",
    "src/commands/project.ts",
    "src/mcp/server.ts",
  ]) {
    const source = await readFile(join(REPO_ROOT, path), "utf8");
    expect(source, path).toContain("buildOnboardingPrompt(");
  }
});
