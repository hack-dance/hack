import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  inspectTarget,
  parseTargetInspectEnvelope,
  TARGET_REFUSALS,
  type TargetInspectEnvelope,
  targetRefusalEnvelope,
} from "../src/lib/target-inspect.ts";
import { buildTargetInspectArgs, createMcpServer } from "../src/mcp/server.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

// ---------------------------------------------------------------------------
// HACK-1144 / WU31: paired CLI and MCP fixtures for the read-only target
// inspector. Every case runs the source CLI directly AND through the MCP tool
// (whose child is the same source CLI), and both envelopes must be identical
// apart from the observation time. The fixture is a private temp root: its own
// HOME, HACK_HOME, registry and Git repositories. No Docker/OrbStack socket,
// keychain, real home or client config is touched; the CLI child gets an
// isolated Docker client config that selects no engine.
// ---------------------------------------------------------------------------

const CLI_ENTRY = resolve(import.meta.dir, "..", "index.ts");
const CASE_TIMEOUT_MS = 120_000;

type Fixture = {
  readonly root: string;
  readonly state: string;
  readonly alpha: string;
  readonly beta: string;
  readonly client: Client;
  /** MCP client whose CLI command is a stub that prints `fake-envelope.json`. */
  readonly stubClient: Client;
  readonly cliEnv: Record<string, string>;
  /** Registry bytes and mtime exactly as written before any CLI run. */
  readonly registryText: string;
  readonly registryMtimeMs: number;
};

let fixture: Fixture;

function gitEnv(home: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
}

function runGit(opts: {
  readonly cwd: string;
  readonly home: string;
  readonly args: readonly string[];
}): string {
  const result = Bun.spawnSync(["git", "-C", opts.cwd, ...opts.args], {
    env: gitEnv(opts.home),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${opts.args.join(" ")} failed: ${result.stderr.toString()}`
    );
  }
  return result.stdout.toString();
}

async function writeProject(opts: {
  readonly repo: string;
  readonly name: string;
  readonly services: readonly string[];
  readonly config?: Readonly<Record<string, unknown>>;
}): Promise<void> {
  await mkdir(join(opts.repo, ".hack"), { recursive: true });
  const services = opts.services
    .map((service) => `  ${service}:\n    image: busybox\n`)
    .join("");
  await writeFile(
    join(opts.repo, ".hack", "docker-compose.yml"),
    `services:\n${services}`
  );
  await writeFile(
    join(opts.repo, ".hack", "hack.config.json"),
    `${JSON.stringify({ name: opts.name, ...opts.config })}\n`
  );
}

/** Larger than the inspector's 4 MiB bound on one generation input. */
const OVERSIZED_INPUT_BYTES = 4 * 1024 * 1024 + 1024;

function registryRow(opts: {
  readonly id: string;
  readonly name: string;
  readonly repo: string;
  readonly worktrees?: readonly { path: string; branch: string | null }[];
}) {
  return {
    id: opts.id,
    name: opts.name,
    repoRoot: opts.repo,
    projectDirName: ".hack",
    projectDir: join(opts.repo, ".hack"),
    createdAt: "2026-01-01T00:00:00.000Z",
    ...(opts.worktrees
      ? {
          worktrees: opts.worktrees.map((entry) => ({
            ...entry,
            lastSeenAt: "2026-01-01T00:00:00.000Z",
          })),
        }
      : {}),
  };
}

beforeAll(async () => {
  // realpath: the macOS tmpdir is a symlink; the registry stores real roots.
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "hack-target-inspect-"))
  );
  const home = join(root, "user-home");
  const state = join(root, "state");
  await mkdir(home, { recursive: true });
  await mkdir(state, { recursive: true });

  // Project alpha: a Git checkout with two linked worktrees.
  const alpha = join(root, "alpha");
  await writeProject({ repo: alpha, name: "alpha", services: ["api", "web"] });
  runGit({ cwd: alpha, home, args: ["init", "-q", "-b", "main"] });
  runGit({ cwd: alpha, home, args: ["add", "-A"] });
  runGit({ cwd: alpha, home, args: ["commit", "-q", "-m", "fixture"] });
  runGit({
    cwd: alpha,
    home,
    args: ["worktree", "add", "-q", "-b", "feature/login", "../alpha-login"],
  });
  runGit({
    cwd: alpha,
    home,
    args: ["worktree", "add", "-q", "--detach", "../alpha-detached"],
  });

  // Project beta: an independent, non-Git project.
  const beta = join(root, "beta");
  await writeProject({ repo: beta, name: "beta", services: ["db"] });

  // Two independent checkouts that share a name (never merged or renamed).
  await writeProject({
    repo: join(root, "gamma-one"),
    name: "gamma",
    services: ["api"],
  });
  await writeProject({
    repo: join(root, "gamma-two"),
    name: "gamma",
    services: ["api"],
  });

  // A registration whose checkout was moved away.
  const moved = join(root, "moved");
  await writeProject({ repo: moved, name: "moved", services: ["api"] });

  // A project with a configured default env overlay.
  const delta = join(root, "delta");
  await writeProject({
    repo: delta,
    name: "delta",
    services: ["api"],
    config: { env: { default_overlay: "staging" } },
  });

  // One checkout owned by two registrations (a corrupt registry).
  const shared = join(root, "shared");
  await writeProject({ repo: shared, name: "shared", services: ["api"] });

  // Unregistered projects with malformed or oversized Hack inputs.
  const brokenConfig = join(root, "broken-config");
  await writeProject({ repo: brokenConfig, name: "broken", services: ["api"] });
  await writeFile(join(brokenConfig, ".hack", "hack.config.json"), '{"name":');
  const brokenCompose = join(root, "broken-compose");
  await writeProject({
    repo: brokenCompose,
    name: "broken",
    services: ["api"],
  });
  await writeFile(
    join(brokenCompose, ".hack", "docker-compose.yml"),
    "services: [unclosed\n"
  );
  const listCompose = join(root, "list-compose");
  await writeProject({ repo: listCompose, name: "listed", services: ["api"] });
  await writeFile(
    join(listCompose, ".hack", "docker-compose.yml"),
    "services:\n  - api\n"
  );
  const oversized = join(root, "oversized");
  await writeProject({ repo: oversized, name: "oversized", services: ["api"] });
  await writeFile(
    join(oversized, ".hack", "docker-compose.yml"),
    `services:\n  api:\n    image: busybox\n#${"x".repeat(OVERSIZED_INPUT_BYTES)}\n`
  );
  // Unreadable inputs: a directory where the Compose file belongs, and a
  // Compose file with no read permission. Their OS errors carry the path.
  const dirCompose = join(root, "dir-compose");
  await writeProject({ repo: dirCompose, name: "dir", services: ["api"] });
  await rm(join(dirCompose, ".hack", "docker-compose.yml"));
  await mkdir(join(dirCompose, ".hack", "docker-compose.yml"));
  const lockedCompose = join(root, "locked-compose");
  await writeProject({
    repo: lockedCompose,
    name: "locked",
    services: ["api"],
  });
  await chmod(join(lockedCompose, ".hack", "docker-compose.yml"), 0o000);
  // Faults the shared project input guards raise before any input is read:
  // an unparseable legacy adoption receipt, and a project directory the
  // inspector cannot search (its mode is dropped inside the test).
  const adoptionUnsafe = join(root, "adoption-unsafe");
  await writeProject({
    repo: adoptionUnsafe,
    name: "adopt",
    services: ["api"],
  });
  const adoptionState = join(
    adoptionUnsafe,
    ".hack",
    ".internal",
    "legacy-compose-adoption-v1"
  );
  await mkdir(adoptionState, { recursive: true, mode: 0o700 });
  await writeFile(join(adoptionState, "receipt.json"), "{not json", {
    mode: 0o600,
  });
  await writeProject({
    repo: join(root, "unsearchable"),
    name: "unsearchable",
    services: ["api"],
  });
  // Native and legacy inputs side by side (a conflicting project family).
  const nativeConflict = join(root, "native-conflict");
  await writeProject({
    repo: nativeConflict,
    name: "native",
    services: ["api"],
  });
  await writeFile(join(nativeConflict, ".hack", "hack.project.json"), "{}\n");
  // A regular file where the project directory belongs.
  const fileProjectDir = join(root, "file-project-dir");
  await mkdir(fileProjectDir, { recursive: true });
  await writeFile(join(fileProjectDir, ".hack"), "not a directory\n");
  // A valid .hack project whose legacy .dev input directory cannot be checked:
  // a regular file where .dev belongs, and a .dev directory whose mode is
  // dropped inside the test.
  const devFile = join(root, "dev-file");
  await writeProject({ repo: devFile, name: "devfile", services: ["api"] });
  await writeFile(join(devFile, ".dev"), "not a directory\n");
  const devLocked = join(root, "dev-locked");
  await writeProject({ repo: devLocked, name: "devlocked", services: ["api"] });
  await mkdir(join(devLocked, ".dev"), { recursive: true });

  await mkdir(join(root, "outside"), { recursive: true });

  await writeFile(
    join(state, "projects.json"),
    `${JSON.stringify({
      version: 1,
      projects: [
        registryRow({
          id: "alpha",
          name: "alpha",
          repo: alpha,
          worktrees: [
            { path: join(root, "alpha-login"), branch: "feature/login" },
          ],
        }),
        registryRow({ id: "beta", name: "beta", repo: beta }),
        registryRow({
          id: "gamma-1",
          name: "gamma",
          repo: join(root, "gamma-one"),
        }),
        registryRow({
          id: "gamma-2",
          name: "gamma",
          repo: join(root, "gamma-two"),
        }),
        registryRow({ id: "moved", name: "moved", repo: moved }),
        registryRow({ id: "delta", name: "delta", repo: delta }),
        registryRow({ id: "shared-a", name: "shared-a", repo: shared }),
        registryRow({ id: "shared-b", name: "shared-b", repo: shared }),
      ],
    })}\n`
  );
  await rm(moved, { recursive: true, force: true });
  const registryText = await readFile(join(state, "projects.json"), "utf8");
  const registryMtimeMs = (await stat(join(state, "projects.json"))).mtimeMs;

  const wrapper = join(root, "hack-source-cli");
  await writeFile(
    wrapper,
    `#!/bin/sh\nexec '${process.execPath}' '${CLI_ENTRY}' "$@"\n`
  );
  await chmod(wrapper, 0o755);

  const cliEnv = privateCliEnv({ root, env: { HACK_HOME: state } });
  const mcpEnv = privateCliEnv({
    root,
    env: { HACK_HOME: state, HACK_MCP_COMMAND: wrapper },
  });
  const server = createMcpServer({ cwd: alpha, env: mcpEnv });
  const client = new Client({ name: "hack-target-inspect", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  // A stub CLI that prints whatever envelope a test stores, so the MCP
  // adapter's re-validation can be observed against drifted output.
  const stub = join(root, "hack-stub-cli");
  await writeFile(
    stub,
    `#!/bin/sh\ncat '${join(root, "fake-envelope.json")}'\n`
  );
  await chmod(stub, 0o755);
  const stubState = join(root, "stub-state");
  await mkdir(stubState, { recursive: true });
  const stubServer = createMcpServer({
    cwd: alpha,
    env: privateCliEnv({
      root,
      env: { HACK_HOME: stubState, HACK_MCP_COMMAND: stub },
    }),
  });
  const stubClient = new Client({ name: "hack-target-stub", version: "1" });
  const [stubClientTransport, stubServerTransport] =
    InMemoryTransport.createLinkedPair();
  await stubServer.connect(stubServerTransport);
  await stubClient.connect(stubClientTransport);

  fixture = {
    root,
    state,
    alpha,
    beta,
    client,
    stubClient,
    cliEnv,
    registryText,
    registryMtimeMs,
  };
}, CASE_TIMEOUT_MS);

afterAll(async () => {
  await fixture?.client.close();
  await fixture?.stubClient.close();
  if (fixture?.root) {
    await rm(fixture.root, { recursive: true, force: true });
  }
}, CASE_TIMEOUT_MS);

type ToolInput = {
  readonly projectName?: string;
  readonly path?: string;
  readonly branch?: string;
  readonly service?: string;
  readonly env?: string;
  readonly expectGeneration?: string;
};

type McpPayload = {
  readonly ok: boolean;
  readonly exitCode: number;
  readonly stdout: string;
  readonly command: string;
  readonly spawned?: false;
  readonly data?: unknown;
  readonly error?: { readonly reason: string };
};

async function runCli(input: ToolInput): Promise<{
  readonly exitCode: number;
  readonly envelope: unknown;
}> {
  const proc = Bun.spawn(
    [process.execPath, CLI_ENTRY, ...buildTargetInspectArgs(input)],
    {
      cwd: fixture.alpha,
      env: fixture.cliEnv,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const [stdout, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  return { exitCode, envelope: JSON.parse(stdout) as unknown };
}

async function runMcp(input: ToolInput): Promise<McpPayload> {
  const result = await fixture.client.callTool({
    name: "hack.project.target",
    arguments: input,
  });
  return result.structuredContent as McpPayload;
}

/** Drop the only intentionally nondeterministic field. */
function comparable(envelope: unknown): unknown {
  const parsed = parseTargetInspectEnvelope(envelope);
  if (!parsed) {
    return { invalid: envelope };
  }
  if (!parsed.ok) {
    return parsed;
  }
  const { observed_at: _observedAt, ...data } = parsed.data;
  return { ok: true, data };
}

/** Run one case on both surfaces and require the same answer. */
async function inspectBoth(input: ToolInput): Promise<TargetInspectEnvelope> {
  const cli = await runCli(input);
  const mcp = await runMcp(input);
  const parsed = parseTargetInspectEnvelope(cli.envelope);
  if (!parsed) {
    throw new Error(`CLI envelope off contract: ${JSON.stringify(cli)}`);
  }
  expect(comparable(mcp.data)).toEqual(comparable(cli.envelope));
  expect(mcp.ok).toBe(parsed.ok);
  expect(mcp.exitCode).toBe(cli.exitCode);
  expect(cli.exitCode).toBe(parsed.ok ? 0 : 1);
  // The MCP tool never pre-resolves selection: every case spawned the CLI.
  expect(mcp.spawned).toBeUndefined();
  expect(mcp.stdout).toBe("");
  return parsed;
}

function expectRefusal(
  envelope: TargetInspectEnvelope,
  reason: keyof typeof TARGET_REFUSALS
): void {
  expect(envelope).toEqual(targetRefusalEnvelope({ reason }));
}

function okData(envelope: TargetInspectEnvelope) {
  if (!envelope.ok) {
    throw new Error(`expected a target, got ${JSON.stringify(envelope)}`);
  }
  return envelope.data;
}

describe("paired CLI/MCP target fixtures", () => {
  test(
    "the session checkout resolves to the primary default instance",
    async () => {
      const data = okData(await inspectBoth({}));
      expect(data.selector).toEqual({
        kind: "cwd",
        branch_explicit: false,
        env_explicit: false,
        expected_generation: null,
      });
      expect(data.project).toEqual({
        name: "alpha",
        registration: { id: "alpha", name: "alpha", match: "root" },
        project_dir: join(fixture.alpha, ".hack"),
      });
      expect(data.checkout).toEqual({
        root: fixture.alpha,
        kind: "primary",
        git_branch: "main",
      });
      expect(data.instance).toEqual({
        branch: null,
        source: "default",
        compose_project: "alpha",
      });
      expect(data.services).toEqual(["api", "web"]);
      expect(data.service).toBeNull();
      expect(data.env).toEqual({ overlay: null, source: "base" });
      expect(data.authority).toBe("none");
      expect(data.runtime).toEqual({ observed: false, reason: "not_probed" });
    },
    CASE_TIMEOUT_MS
  );

  test(
    "a second project is selected by name without leaking the first",
    async () => {
      const data = okData(await inspectBoth({ projectName: "beta" }));
      expect(data.selector.kind).toBe("project");
      expect(data.project.registration).toEqual({
        id: "beta",
        name: "beta",
        match: "root",
      });
      expect(data.checkout).toEqual({
        root: fixture.beta,
        kind: "not_git",
        git_branch: null,
      });
      expect(data.instance.compose_project).toBe("beta");
      expect(data.services).toEqual(["db"]);
    },
    CASE_TIMEOUT_MS
  );

  test(
    "a linked worktree selects its own branch instance, not the primary",
    async () => {
      const data = okData(
        await inspectBoth({ path: join(fixture.root, "alpha-login") })
      );
      expect(data.project.registration).toEqual({
        id: "alpha",
        name: "alpha",
        match: "worktree",
      });
      expect(data.checkout).toEqual({
        root: join(fixture.root, "alpha-login"),
        kind: "linked",
        git_branch: "feature/login",
      });
      expect(data.instance).toEqual({
        branch: "feature-login",
        source: "worktree",
        compose_project: "alpha--feature-login",
      });
    },
    CASE_TIMEOUT_MS
  );

  test(
    "an explicit instance wins and the Git branch is reported unchanged",
    async () => {
      const data = okData(
        await inspectBoth({
          path: join(fixture.root, "alpha-login"),
          branch: "review",
          service: "api",
        })
      );
      expect(data.selector.branch_explicit).toBe(true);
      expect(data.checkout.git_branch).toBe("feature/login");
      expect(data.instance).toEqual({
        branch: "review",
        source: "explicit",
        compose_project: "alpha--review",
      });
      expect(data.service).toEqual({ name: "api" });
      const branches = runGit({
        cwd: fixture.alpha,
        home: join(fixture.root, "user-home"),
        args: ["branch", "--list", "--format=%(refname:short)"],
      });
      expect(branches.trim().split("\n").sort()).toEqual([
        "feature/login",
        "main",
      ]);
    },
    CASE_TIMEOUT_MS
  );

  test(
    "an explicit instance is slugged like 'hack up --branch'",
    async () => {
      // `hack up --branch Feature/X` targets <base>--feature-x.
      const data = okData(
        await inspectBoth({ projectName: "alpha", branch: "Feature/X" })
      );
      expect(data.instance).toEqual({
        branch: "feature-x",
        source: "explicit",
        compose_project: "alpha--feature-x",
      });
      expect(data.checkout.git_branch).toBe("main");
    },
    CASE_TIMEOUT_MS
  );

  test(
    "env selection: project default, explicit overlay and base agree",
    async () => {
      const byDefault = okData(await inspectBoth({ projectName: "delta" }));
      expect(byDefault.selector.env_explicit).toBe(false);
      expect(byDefault.env).toEqual({
        overlay: "staging",
        source: "project_default",
      });

      const explicit = okData(
        await inspectBoth({ projectName: "delta", env: "preview" })
      );
      expect(explicit.selector.env_explicit).toBe(true);
      expect(explicit.env).toEqual({ overlay: "preview", source: "explicit" });

      const base = okData(
        await inspectBoth({ projectName: "delta", env: "base" })
      );
      expect(base.selector.env_explicit).toBe(true);
      expect(base.env).toEqual({ overlay: null, source: "base" });
    },
    CASE_TIMEOUT_MS
  );

  test(
    "malformed or oversized Hack inputs are refused, not reported empty",
    async () => {
      expectRefusal(
        await inspectBoth({ path: join(fixture.root, "broken-config") }),
        "config_parse_failed"
      );
      expectRefusal(
        await inspectBoth({ path: join(fixture.root, "broken-compose") }),
        "compose_parse_failed"
      );
      expectRefusal(
        await inspectBoth({
          path: join(fixture.root, "broken-compose"),
          service: "api",
        }),
        "compose_parse_failed"
      );
      expectRefusal(
        await inspectBoth({ path: join(fixture.root, "list-compose") }),
        "compose_parse_failed"
      );
      expectRefusal(
        await inspectBoth({ path: join(fixture.root, "oversized") }),
        "generation_input_too_large"
      );
    },
    CASE_TIMEOUT_MS
  );

  test(
    "an unreadable input is a closed refusal without the OS message or path",
    async () => {
      const path = join(fixture.root, "dir-compose");
      expectRefusal(await inspectBoth({ path }), "input_unreadable");
      const cli = await runCli({ path });
      expect(JSON.stringify(cli.envelope)).not.toContain(fixture.root);
      expect(JSON.stringify(cli.envelope)).not.toContain("EISDIR");
    },
    CASE_TIMEOUT_MS
  );

  // Root reads a mode-000 file, so the permission fault cannot be produced.
  test.skipIf(process.getuid?.() === 0)(
    "a permission-denied input is a closed refusal without the OS message",
    async () => {
      const path = join(fixture.root, "locked-compose");
      expectRefusal(await inspectBoth({ path }), "input_permission_denied");
      const cli = await runCli({ path });
      expect(JSON.stringify(cli.envelope)).not.toContain(fixture.root);
      expect(JSON.stringify(cli.envelope)).not.toContain("EACCES");
    },
    CASE_TIMEOUT_MS
  );

  test(
    "project input guard refusals are closed refusals, not detail-less errors",
    async () => {
      // An unsafe legacy adoption state used to escape as a detail-less
      // E_CONFIG_INVALID, which the adapter turned into data: null.
      expectRefusal(
        await inspectBoth({ path: join(fixture.root, "adoption-unsafe") }),
        "adoption_state_unsafe"
      );
      expectRefusal(
        await inspectBoth({ path: join(fixture.root, "native-conflict") }),
        "project_inputs_unsupported"
      );
      // A file where `.hack` belongs is an input access failure.
      expectRefusal(
        await inspectBoth({ path: join(fixture.root, "file-project-dir") }),
        "input_unreadable"
      );
    },
    CASE_TIMEOUT_MS
  );

  // Root can search a mode-000 directory, so this fault cannot be produced.
  test.skipIf(process.getuid?.() === 0)(
    "an unsearchable project directory is a closed refusal without the path",
    async () => {
      const path = join(fixture.root, "unsearchable");
      const projectDir = join(path, ".hack");
      await chmod(projectDir, 0o000);
      try {
        expectRefusal(await inspectBoth({ path }), "adoption_state_unsafe");
        const cli = await runCli({ path });
        expect(JSON.stringify(cli.envelope)).not.toContain(fixture.root);
        expect(JSON.stringify(cli.envelope)).not.toContain("EACCES");
      } finally {
        await chmod(projectDir, 0o755);
      }
    },
    CASE_TIMEOUT_MS
  );

  test(
    "a .dev file beside a valid .hack is a closed refusal without the path",
    async () => {
      // The input presence check used to escape as a detail-less E_UNEXPECTED.
      expectRefusal(
        await inspectBoth({ path: join(fixture.root, "dev-file") }),
        "input_unreadable"
      );
      const cli = await runCli({ path: join(fixture.root, "dev-file") });
      expect(JSON.stringify(cli.envelope)).not.toContain(fixture.root);
      expect(JSON.stringify(cli.envelope)).not.toContain("ENOTDIR");
    },
    CASE_TIMEOUT_MS
  );

  // Root can search a mode-000 directory, so this fault cannot be produced.
  test.skipIf(process.getuid?.() === 0)(
    "an unsearchable .dev beside a valid .hack is a closed refusal without the path",
    async () => {
      const path = join(fixture.root, "dev-locked");
      const devDir = join(path, ".dev");
      await chmod(devDir, 0o000);
      try {
        expectRefusal(await inspectBoth({ path }), "input_permission_denied");
        const cli = await runCli({ path });
        expect(JSON.stringify(cli.envelope)).not.toContain(fixture.root);
        expect(JSON.stringify(cli.envelope)).not.toContain("EACCES");
      } finally {
        await chmod(devDir, 0o755);
      }
    },
    CASE_TIMEOUT_MS
  );

  test(
    "two registrations that own one checkout are refused as ambiguous",
    async () => {
      expectRefusal(
        await inspectBoth({ path: join(fixture.root, "shared") }),
        "ambiguous_project"
      );
      expectRefusal(
        await inspectBoth({ projectName: "shared-a" }),
        "ambiguous_project"
      );
    },
    CASE_TIMEOUT_MS
  );

  test(
    "conflicting selectors are refused identically",
    async () => {
      expectRefusal(
        await inspectBoth({ projectName: "alpha", path: fixture.beta }),
        "conflicting_selectors"
      );
    },
    CASE_TIMEOUT_MS
  );

  test(
    "closed project, instance and service refusals agree on both surfaces",
    async () => {
      expectRefusal(
        await inspectBoth({ projectName: "gamma" }),
        "ambiguous_project"
      );
      expectRefusal(
        await inspectBoth({ projectName: "moved" }),
        "registered_root_missing"
      );
      expectRefusal(
        await inspectBoth({ projectName: "zeta" }),
        "project_not_found"
      );
      expectRefusal(
        await inspectBoth({ path: join(fixture.root, "alpha-detached") }),
        "detached_checkout"
      );
      expectRefusal(
        await inspectBoth({ path: join(fixture.root, "outside") }),
        "no_project_context"
      );
      expectRefusal(
        await inspectBoth({ path: join(fixture.root, "absent") }),
        "path_not_found"
      );
      expectRefusal(
        await inspectBoth({ projectName: "alpha", service: "nope" }),
        "service_not_found"
      );
    },
    CASE_TIMEOUT_MS
  );

  test(
    "a stale generation is refused; source edits keep the generation",
    async () => {
      const first = okData(await inspectBoth({ projectName: "beta" }));
      const generation = first.generation.id;

      // An ordinary source edit does not invalidate the target.
      await writeFile(join(fixture.beta, "app.ts"), "export const x = 1;\n");
      const unchanged = okData(
        await inspectBoth({ projectName: "beta", expectGeneration: generation })
      );
      expect(unchanged.generation.id).toBe(generation);
      expect(unchanged.selector.expected_generation).toBe(generation);

      // A Hack config edit does.
      await writeFile(
        join(fixture.beta, ".hack", "hack.config.json"),
        `${JSON.stringify({ name: "beta", dev_host: "beta.hack" })}\n`
      );
      const stale = await inspectBoth({
        projectName: "beta",
        expectGeneration: generation,
      });
      const current = okData(await inspectBoth({ projectName: "beta" }));
      expect(current.generation.id).not.toBe(generation);
      expect(stale).toEqual(
        targetRefusalEnvelope({
          reason: "stale_generation",
          observedGeneration: current.generation.id,
        })
      );
    },
    CASE_TIMEOUT_MS
  );

  test(
    "both surfaces refuse a malformed instance selector before resolution",
    async () => {
      const cli = await runCli({ branch: "-x" });
      expect(cli.exitCode).toBe(1);
      expect(cli.envelope).toEqual(
        targetRefusalEnvelope({ reason: "invalid_selector" })
      );
      // MCP validates the same grammar at its input boundary: no child runs.
      const mcp = await runMcp({ branch: "-x" });
      expect(mcp.ok).toBe(false);
      expect(mcp.spawned).toBe(false);
      expect(mcp.error?.reason).toBe("invalid_arguments");
    },
    CASE_TIMEOUT_MS
  );

  test(
    "inspection writes nothing: no registry, state or Git change",
    async () => {
      // The baseline is the registry as beforeAll wrote it, not as it is now:
      // every earlier paired case already ran the CLI (directly and through
      // MCP) against this HACK_HOME, so a last-seen touch made by any of them
      // would already be in a baseline read here and go unnoticed.
      const registryPath = join(fixture.state, "projects.json");
      const worktreesBefore = runGit({
        cwd: fixture.alpha,
        home: join(fixture.root, "user-home"),
        args: ["worktree", "list", "--porcelain"],
      });
      await runCli({ projectName: "alpha", branch: "fresh-instance" });
      await runCli({ path: join(fixture.root, "alpha-login") });
      expect(await readFile(registryPath, "utf8")).toBe(fixture.registryText);
      expect((await stat(registryPath)).mtimeMs).toBe(fixture.registryMtimeMs);
      // Only the registry and the MCP audit log exist in the state dir.
      expect((await readdir(fixture.state)).sort()).toEqual([
        "mcp-audit.log",
        "projects.json",
      ]);
      expect(await readdir(join(fixture.alpha, ".hack"))).toEqual(
        expect.not.arrayContaining([".branch", ".internal"])
      );
      expect(
        runGit({
          cwd: fixture.alpha,
          home: join(fixture.root, "user-home"),
          args: ["worktree", "list", "--porcelain"],
        })
      ).toBe(worktreesBefore);
    },
    CASE_TIMEOUT_MS
  );
});

describe("MCP adapter re-validation", () => {
  async function stubbedData(envelope: unknown): Promise<unknown> {
    await writeFile(
      join(fixture.root, "fake-envelope.json"),
      JSON.stringify(envelope)
    );
    const result = await fixture.stubClient.callTool({
      name: "hack.project.target",
      arguments: {},
    });
    const payload = result.structuredContent as McpPayload;
    expect(payload.stdout).toBe("");
    return payload.data;
  }

  test(
    "drifted CLI output is never passed to MCP callers",
    async () => {
      // Off-contract success data becomes null.
      expect(
        await stubbedData({
          ok: true,
          data: { schema: "hack.target.v0", provisional: true, leak: "x" },
        })
      ).toBeNull();
      // Foreign fields around a valid refusal are dropped.
      const refusal = targetRefusalEnvelope({ reason: "service_not_found" });
      if (refusal.ok) {
        throw new Error("expected a refusal envelope");
      }
      expect(
        await stubbedData({
          ...refusal,
          leak: "x",
          error: { ...refusal.error, leak: "x" },
        })
      ).toEqual(refusal);
      // A refusal whose message no longer matches its reason becomes null.
      expect(
        await stubbedData({
          ...refusal,
          error: { ...refusal.error, message: "drifted text" },
        })
      ).toBeNull();
      // A detail-less fault outside the catalogue carries free OS text.
      expect(
        await stubbedData({
          ok: false,
          error: {
            code: "E_UNEXPECTED",
            message: "EACCES: permission denied, open '/x/.hack/y.yml'",
          },
        })
      ).toBeNull();
      // Success data that claims authority or a runtime observation.
      const valid = await validSuccessEnvelope();
      expect(await stubbedData(valid)).toEqual(valid);
      expect(
        await stubbedData({
          ok: true,
          data: { ...valid.data, authority: "owner" },
        })
      ).toBeNull();
    },
    CASE_TIMEOUT_MS
  );
});

/** A real success envelope from the inspector, for validator mutations. */
async function validSuccessEnvelope(): Promise<{
  readonly ok: true;
  readonly data: Record<string, unknown>;
}> {
  const result = await inspectTarget({
    cwd: fixture.root,
    registryPath: join(fixture.state, "projects.json"),
    selector: { path: fixture.beta },
  });
  if (!result.ok) {
    throw new Error(`expected a target, got ${JSON.stringify(result)}`);
  }
  return { ok: true, data: { ...result.data } };
}

describe("target inspector domain", () => {
  test("a config change during the read is refused, not snapshotted", async () => {
    const result = await inspectTarget({
      cwd: fixture.root,
      registryPath: join(fixture.state, "projects.json"),
      selector: { path: fixture.beta },
      afterResolve: async () => {
        await writeFile(
          join(fixture.beta, ".hack", "docker-compose.yml"),
          "services:\n  db:\n    image: postgres\n"
        );
      },
    });
    expect(result).toEqual(
      targetRefusalEnvelope({ reason: "generation_changed_during_read" })
    );
  });

  test("the MCP argv carries every selector as one --name=value token", () => {
    // The paired cases build the direct CLI argv with this same helper, so a
    // dropped selector would change both sides alike. Pin the argv literally.
    expect(
      buildTargetInspectArgs({
        projectName: "alpha",
        path: "/x",
        branch: "feature/login",
        service: "api",
        env: "staging",
        expectGeneration: "cfg-v0:0123456789abcdef0123456789abcdef",
      })
    ).toEqual([
      "project",
      "target",
      "--json",
      "--project=alpha",
      "--path=/x",
      "--branch=feature/login",
      "--service=api",
      "--env=staging",
      "--expect-generation=cfg-v0:0123456789abcdef0123456789abcdef",
    ]);
    expect(buildTargetInspectArgs({})).toEqual(["project", "target", "--json"]);
  });

  test("selectors are validated before any project lookup", async () => {
    const registryPath = join(fixture.state, "projects.json");
    for (const selector of [
      { project: "a=b" },
      { branch: "--all" },
      { service: "a b" },
      { env: "X=secret" },
      { expectGeneration: "cfg-v0:zz" },
      { path: "" },
    ]) {
      expect(
        await inspectTarget({ cwd: fixture.root, registryPath, selector })
      ).toEqual(targetRefusalEnvelope({ reason: "invalid_selector" }));
    }
  });

  test("refusal text never repeats caller input", () => {
    for (const spec of Object.values(TARGET_REFUSALS)) {
      expect(spec.message).not.toMatch(
        /gamma|alpha|beta|zeta|secret|tmp|feature/
      );
    }
  });

  test("the adapter validator rejects drifted or foreign envelopes", () => {
    const refusal = targetRefusalEnvelope({ reason: "service_not_found" });
    expect(parseTargetInspectEnvelope(refusal)).toEqual(refusal);
    const drift = (patch: Record<string, unknown>) => ({
      ok: false,
      error: {
        ...TARGET_REFUSALS.service_not_found,
        detail: {
          reason: "service_not_found",
          stage: "service",
          retry: "fix_selector",
          provisional: true,
          ...patch,
        },
      },
    });
    expect(parseTargetInspectEnvelope(drift({ reason: "other" }))).toBeNull();
    expect(
      parseTargetInspectEnvelope(drift({ retry: "reinspect" }))
    ).toBeNull();
    expect(
      parseTargetInspectEnvelope(
        drift({
          observed_generation: "cfg-v0:0123456789abcdef0123456789abcdef",
        })
      )
    ).toBeNull();
    expect(
      parseTargetInspectEnvelope({
        ok: false,
        error: { code: "E_NOT_A_CODE", message: "x" },
      })
    ).toBeNull();
    // The message and code must be the reason's own fixed values.
    if (refusal.ok) {
      throw new Error("expected a refusal envelope");
    }
    expect(
      parseTargetInspectEnvelope({
        ...refusal,
        error: { ...refusal.error, message: "The service is missing." },
      })
    ).toBeNull();
    expect(
      parseTargetInspectEnvelope({
        ...refusal,
        error: { ...refusal.error, code: "E_USAGE" },
      })
    ).toBeNull();
    expect(
      parseTargetInspectEnvelope({
        ok: true,
        data: { schema: "hack.target.v1" },
      })
    ).toBeNull();
  });

  test("the adapter validator only passes parser E_USAGE without detail", () => {
    const usage = {
      ok: false,
      error: { code: "E_USAGE", message: "Unknown option '--x'." },
    };
    expect<unknown>(parseTargetInspectEnvelope(usage)).toEqual(usage);
    for (const code of ["E_UNEXPECTED", "E_PERMISSION", "E_CONFIG_INVALID"]) {
      expect(
        parseTargetInspectEnvelope({
          ok: false,
          error: { code, message: "EISDIR: illegal operation on a directory" },
        })
      ).toBeNull();
    }
  });

  test("the adapter validator refuses data that claims authority or readiness", async () => {
    const valid = await validSuccessEnvelope();
    expect<unknown>(parseTargetInspectEnvelope(valid)).toEqual(valid);
    const patched = (patch: Record<string, unknown>) =>
      parseTargetInspectEnvelope({
        ok: true,
        data: { ...valid.data, ...patch },
      });
    expect(patched({ authority: "owner" })).toBeNull();
    expect(patched({ authority: undefined })).toBeNull();
    expect(
      patched({ runtime: { observed: true, reason: "not_probed" } })
    ).toBeNull();
    expect(
      patched({ runtime: { observed: false, reason: "probed" } })
    ).toBeNull();
    expect(patched({ runtime: null })).toBeNull();
  });
});
