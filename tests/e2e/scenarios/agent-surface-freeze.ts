import { mkdir } from "node:fs/promises";
import { join, relative } from "node:path";

import {
  createMonorepoFixture,
  diffFileHashes,
  type FileHashSnapshot,
  HOME_CLIENT_ROOTS,
  type MonorepoFixture,
  REPO_GUIDANCE_ROOTS,
  seedHomeClientSentinels,
  seedRepoGuidanceSentinels,
  snapshotFileHashes,
} from "../fixture.ts";
import {
  type CliResult,
  expect,
  expectExit,
  runCommand,
  type Scenario,
  type ScenarioContext,
} from "../harness.ts";

const FREEZE_TIMEOUT_MS = 240_000;
const RUNS_PER_COMMAND = 2;

/**
 * Exit codes accepted for one ordinary command, per run. A wrong code means
 * the command did not exercise its real path (usage error, crash), so a
 * byte-identical tree would prove nothing.
 */
type FreezeCommand = {
  readonly label: string;
  readonly fixture: "project" | "handoff";
  readonly args: readonly string[];
  readonly codes: readonly [readonly number[], readonly number[]];
};

/**
 * Default flows covered by the freeze. `init --auto` refuses an existing
 * .hack/ on its second run (exit 1); `--with codex` instead hands off the
 * onboarding prompt for the existing setup (exit 0). `doctor` exits 1 for the
 * unreachable Docker and missing global install, and `--fix` runs only its
 * Docker-free remediations (see `freezeEnv`). `setup sync --check` exits 1
 * because the customized guidance is reported as preserved; it must not
 * repair it. Refresh-only `setup sync --all-scopes` (HACK-1132) exits 0: every
 * seeded file is customized or lacks a Hack section, so nothing is refreshed
 * and nothing missing is created.
 */
const FREEZE_COMMANDS: readonly FreezeCommand[] = [
  {
    label: "init --auto",
    fixture: "project",
    args: ["init", "--auto"],
    codes: [[0], [1]],
  },
  {
    label: "init --auto --with codex",
    fixture: "handoff",
    args: ["init", "--auto", "--with", "codex"],
    codes: [[0], [0]],
  },
  {
    label: "agent prime",
    fixture: "project",
    args: ["agent", "prime"],
    codes: [[0], [0]],
  },
  {
    label: "agent prime --check",
    fixture: "project",
    args: ["agent", "prime", "--check"],
    codes: [[0], [0]],
  },
  {
    label: "agent onboard",
    fixture: "project",
    args: ["agent", "onboard"],
    codes: [[0], [0]],
  },
  {
    label: "agent patterns",
    fixture: "project",
    args: ["agent", "patterns"],
    codes: [[0], [0]],
  },
  {
    label: "doctor --json",
    fixture: "project",
    args: ["doctor", "--json"],
    codes: [
      [0, 1],
      [0, 1],
    ],
  },
  {
    label: "doctor --fix --no-interactive",
    fixture: "project",
    args: ["doctor", "--fix", "--no-interactive"],
    codes: [
      [0, 1],
      [0, 1],
    ],
  },
  {
    label: "setup sync --check",
    fixture: "project",
    args: ["setup", "sync", "--check"],
    codes: [[1], [1]],
  },
  {
    label: "setup sync --all-scopes",
    fixture: "project",
    args: ["setup", "sync", "--all-scopes"],
    codes: [[0], [0]],
  },
];

type FreezeState = {
  readonly ctx: ScenarioContext;
  readonly env: Readonly<Record<string, string>>;
  readonly roots: readonly string[];
  readonly fixtures: Readonly<
    Record<FreezeCommand["fixture"], MonorepoFixture>
  >;
  readonly baseline: FileHashSnapshot;
};

/**
 * Negative control for agent guidance writes (HACK-1124, HACK-1132,
 * HACK-1155): default setup, onboarding, agent and doctor flows leave an
 * isolated HOME's client config and a repo's customized guidance
 * byte-identical, twice in a row. An explicit `setup agents` export is the
 * positive control: it changes only its documented target.
 *
 * Every call overrides HOME and HACK_HOME with scenario temp dirs; the
 * contributor's real HOME is never read or written.
 */
export const agentSurfaceFreezeScenario: Scenario = {
  name: "agent-surface-freeze",
  tier: "local",
  summary:
    "default flows leave isolated-HOME client config and repo guidance byte-identical",
  run: async (ctx) => {
    const home = join(ctx.tempRoot, "home");
    await mkdir(home, { recursive: true });
    const seededHome = await seedHomeClientSentinels({ home });
    const project = await createMonorepoFixture({
      parentDir: ctx.tempRoot,
      withHackConfig: false,
    });
    const handoff = await createMonorepoFixture({
      parentDir: ctx.tempRoot,
      withHackConfig: false,
    });
    const seededRepo = [
      ...(await seedRepoGuidanceSentinels({ root: project.root })),
      ...(await seedRepoGuidanceSentinels({ root: handoff.root })),
    ];

    const roots = [
      ...HOME_CLIENT_ROOTS.map((root) => join(home, root)),
      ...REPO_GUIDANCE_ROOTS.map((root) => join(project.root, root)),
      ...REPO_GUIDANCE_ROOTS.map((root) => join(handoff.root, root)),
    ];
    const baseline = await snapshotFileHashes({ roots });
    const missing = [...seededHome, ...seededRepo].filter(
      (path) => !baseline.get(path)?.startsWith("sha256:")
    );
    expect({
      that: missing.length === 0,
      message: `baseline snapshot is missing seeded sentinels: ${missing.join(", ")}`,
    });

    const state: FreezeState = {
      ctx,
      env: freezeEnv({ ctx, home }),
      roots,
      fixtures: { project, handoff },
      baseline,
    };

    try {
      for (const command of FREEZE_COMMANDS) {
        for (let run = 0; run < RUNS_PER_COMMAND; run += 1) {
          await runFrozenCommand({ state, command, run });
        }
      }
      await runPositiveControl({ state });
    } finally {
      // `doctor --fix` starts hackd under the isolated HACK_HOME; never let it
      // outlive the scenario. `daemon stop` exits 0 whether or not it ran.
      const stop = await ctx.cli({
        args: ["daemon", "stop"],
        cwd: project.root,
        env: state.env,
      });
      if (stop.timedOut || stop.exitCode !== 0) {
        ctx.retainFixtures("isolated hackd stop failed");
      }
    }
  },
};

/**
 * Per-call env: isolated HOME + HACK_HOME, Docker pointed at a socket that
 * does not exist (local tier: no Docker side effects even when the host runs
 * Docker), and a stub Mutagen path so `doctor --fix` never downloads.
 */
function freezeEnv(opts: {
  readonly ctx: ScenarioContext;
  readonly home: string;
}): Readonly<Record<string, string>> {
  return {
    HOME: opts.home,
    HACK_HOME: opts.ctx.hackHome,
    DOCKER_HOST: `unix://${join(opts.ctx.tempRoot, "no-docker.sock")}`,
    HACK_MUTAGEN_PATH: join(opts.ctx.tempRoot, "no-mutagen"),
  };
}

async function runFrozenCommand(opts: {
  readonly state: FreezeState;
  readonly command: FreezeCommand;
  readonly run: number;
}): Promise<void> {
  const { state, command } = opts;
  const fixture = state.fixtures[command.fixture];
  const label = `${command.label} (run ${opts.run + 1})`;
  const result = await state.ctx.cli({
    args: command.args,
    cwd: fixture.root,
    env: state.env,
    timeoutMs: FREEZE_TIMEOUT_MS,
  });
  expectExit({
    result,
    codes: command.codes[opts.run] ?? [],
    message: `${label} should exercise its real path`,
  });
  await expectFrozen({ state, label, result });
  state.ctx.log(`${label}: exit ${result.exitCode}, guidance unchanged`);
}

async function expectFrozen(opts: {
  readonly state: FreezeState;
  readonly label: string;
  readonly result: CliResult;
}): Promise<void> {
  const diff = diffFileHashes({
    before: opts.state.baseline,
    after: await snapshotFileHashes({ roots: opts.state.roots }),
  });
  expect({
    that:
      diff.changed.length === 0 &&
      diff.added.length === 0 &&
      diff.removed.length === 0,
    message: `${opts.label} wrote agent client or guidance surfaces: changed=[${diff.changed.join(", ")}] added=[${diff.added.join(", ")}] removed=[${diff.removed.join(", ")}]`,
    result: opts.result,
  });
  for (const fixture of Object.values(opts.state.fixtures)) {
    const unexpected = (await gitStatusPaths({ root: fixture.root })).filter(
      (line) => !line.path.startsWith(".hack/")
    );
    expect({
      that: unexpected.length === 0,
      message: `${opts.label} left tracked or untracked changes outside .hack/ in ${fixture.name}: ${unexpected.map((line) => line.raw).join(", ")}`,
      result: opts.result,
    });
  }
}

/**
 * Positive control: the explicit AGENTS.md export must write exactly
 * AGENTS.md, proving the hash and git-status probes can see a real write.
 */
async function runPositiveControl(opts: {
  readonly state: FreezeState;
}): Promise<void> {
  const { state } = opts;
  const project = state.fixtures.project;
  const target = join(project.root, "AGENTS.md");
  const result = await state.ctx.cli({
    args: ["setup", "agents", "--agents-md"],
    cwd: project.root,
    env: state.env,
  });
  expectExit({
    result,
    codes: [0],
    message: "explicit setup agents --agents-md should succeed",
  });
  const diff = diffFileHashes({
    before: state.baseline,
    after: await snapshotFileHashes({ roots: state.roots }),
  });
  expect({
    that:
      diff.changed.length === 1 &&
      diff.changed[0] === target &&
      diff.added.length === 0 &&
      diff.removed.length === 0,
    message: `explicit setup agents --agents-md should change only ${target}: changed=[${diff.changed.join(", ")}] added=[${diff.added.join(", ")}] removed=[${diff.removed.join(", ")}]`,
    result,
  });
  const outside = (await gitStatusPaths({ root: project.root })).filter(
    (line) => !line.path.startsWith(".hack/")
  );
  expect({
    that:
      outside.length === 1 &&
      outside[0]?.path === relative(project.root, target),
    message: `explicit export should leave only AGENTS.md modified outside .hack/: ${outside.map((line) => line.raw).join(", ")}`,
    result,
  });
  state.ctx.log("positive control: setup agents --agents-md changed AGENTS.md");
}

type StatusLine = { readonly raw: string; readonly path: string };

/** Porcelain v1 entries, including every untracked file. */
async function gitStatusPaths(opts: {
  readonly root: string;
}): Promise<readonly StatusLine[]> {
  const status = await runCommand({
    argv: [
      "git",
      "-C",
      opts.root,
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ],
    cwd: opts.root,
  });
  expectExit({
    result: status,
    codes: [0],
    message: "git status should succeed in the fixture",
  });
  return status.stdout
    .split("\n")
    .filter((line) => line.length > 3)
    .map((raw) => ({ raw, path: raw.slice(3) }));
}
