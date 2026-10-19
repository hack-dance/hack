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
  readonly cliEnv: Record<string, string>;
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
    `${JSON.stringify({ name: opts.name })}\n`
  );
}

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
      ],
    })}\n`
  );
  await rm(moved, { recursive: true, force: true });

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

  fixture = { root, state, alpha, beta, client, cliEnv };
}, CASE_TIMEOUT_MS);

afterAll(async () => {
  await fixture?.client.close();
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
      const registryPath = join(fixture.state, "projects.json");
      const before = await readFile(registryPath, "utf8");
      const beforeStat = await stat(registryPath);
      const worktreesBefore = runGit({
        cwd: fixture.alpha,
        home: join(fixture.root, "user-home"),
        args: ["worktree", "list", "--porcelain"],
      });
      await runCli({ projectName: "alpha", branch: "fresh-instance" });
      await runCli({ path: join(fixture.root, "alpha-login") });
      expect(await readFile(registryPath, "utf8")).toBe(before);
      expect((await stat(registryPath)).mtimeMs).toBe(beforeStat.mtimeMs);
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
    expect(
      parseTargetInspectEnvelope({
        ok: true,
        data: { schema: "hack.target.v1" },
      })
    ).toBeNull();
  });
});
