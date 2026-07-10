import { addLinkedWorktree, createMonorepoFixture } from "../fixture.ts";
import {
  expect,
  expectExit,
  extractJsonObject,
  runCommand,
  type Scenario,
} from "../harness.ts";
import { downBestEffort, requireDockerPreconditions } from "./docker-shared.ts";

type OpenPayload = { readonly url?: string };
type RuntimeMetadataPayload = {
  readonly branch?: string | null;
  readonly composeProject?: string;
  readonly hosts?: { readonly dev?: string; readonly alias?: string | null };
  readonly services?: Readonly<
    Record<string, { readonly urls?: readonly string[] }>
  >;
};

const BRANCH = "e2e-parallel";
const UP_TIMEOUT_MS = 420_000;

/**
 * Primary checkout and a linked worktree must run simultaneously: the
 * worktree `hack up` defaults to a branch instance with distinct routes and
 * a distinct compose project, so the two checkouts never fight over
 * hostnames or containers. Both are torn down afterwards (finally block).
 */
export const worktreeParallelUpScenario: Scenario = {
  name: "worktree-parallel-up",
  tier: "docker",
  summary: "primary + worktree branch instance run in parallel",
  run: async (ctx) => {
    await requireDockerPreconditions({ ctx });

    const fixture = await createMonorepoFixture({
      parentDir: ctx.tempRoot,
      withHackConfig: true,
    });
    const worktreePath = await addLinkedWorktree({ fixture, branch: BRANCH });

    try {
      const upPrimary = await ctx.cli({
        args: ["up", "--detach"],
        cwd: fixture.root,
        timeoutMs: UP_TIMEOUT_MS,
      });
      expectExit({
        result: upPrimary,
        codes: [0],
        message: "hack up --detach in the primary checkout should succeed",
      });

      const upWorktree = await ctx.cli({
        args: ["up", "--detach"],
        cwd: worktreePath,
        timeoutMs: UP_TIMEOUT_MS,
      });
      expectExit({
        result: upWorktree,
        codes: [0],
        message:
          "hack up --detach in the linked worktree (branch instance) should succeed",
      });

      const primaryUrl = await resolveOpenUrl({ ctx, cwd: fixture.root });
      const worktreeUrl = await resolveOpenUrl({ ctx, cwd: worktreePath });
      expect({
        that: primaryUrl.length > 0 && worktreeUrl.length > 0,
        message: "open --json should resolve URLs for both instances",
      });
      expect({
        that: primaryUrl !== worktreeUrl,
        message: `primary and worktree instances must expose distinct routes (both got "${primaryUrl}")`,
      });
      expect({
        that: worktreeUrl.includes(BRANCH),
        message: `worktree route should carry the branch slug "${BRANCH}", got "${worktreeUrl}"`,
      });

      const primaryMetadata = await readRuntimeMetadata({
        ctx,
        cwd: fixture.root,
      });
      const branchMetadata = await readRuntimeMetadata({
        ctx,
        cwd: worktreePath,
      });
      expect({
        that:
          primaryMetadata?.branch === null &&
          primaryMetadata.hosts?.dev === fixture.devHost &&
          primaryMetadata.services?.api?.urls?.includes(
            `https://api.${fixture.devHost}`
          ) === true,
        message: "primary containers should receive base-instance runtime URLs",
      });
      expect({
        that:
          branchMetadata?.branch === BRANCH &&
          branchMetadata.composeProject === `${fixture.name}--${BRANCH}` &&
          branchMetadata.hosts?.dev === `${BRANCH}.${fixture.devHost}` &&
          branchMetadata.services?.web?.urls?.includes(worktreeUrl) === true &&
          branchMetadata.services?.api?.urls?.includes(
            `https://api.${BRANCH}.${fixture.devHost}`
          ) === true,
        message:
          "branch containers should receive only branch-qualified public runtime URLs",
      });

      const composeLs = await runCommand({
        argv: ["docker", "compose", "ls", "--format", "json"],
        cwd: fixture.root,
      });
      const running = composeLs.stdout;
      expect({
        that: running.includes(fixture.name),
        message: `docker compose ls should show the primary project "${fixture.name}" running`,
      });
      const branchProjectVisible =
        running.includes(`${fixture.name}-${BRANCH}`) ||
        running.includes(BRANCH);
      expect({
        that: branchProjectVisible,
        message: `docker compose ls should show a distinct branch-instance project for "${BRANCH}" while the primary is also running`,
      });

      const primaryProject = fixture.name;
      const branchProject = `${fixture.name}--${BRANCH}`;
      const primaryIdsBefore = await readContainerIds({
        cwd: fixture.root,
        composeProject: primaryProject,
      });
      const branchIdsBefore = await readContainerIds({
        cwd: fixture.root,
        composeProject: branchProject,
      });
      expect({
        that: primaryIdsBefore.length > 0 && branchIdsBefore.length > 0,
        message: "both compose instances should expose running container ids",
      });

      const restartPrimary = await ctx.cli({
        args: ["restart", "--json"],
        cwd: fixture.root,
        timeoutMs: UP_TIMEOUT_MS,
      });
      expectExit({
        result: restartPrimary,
        codes: [0],
        message: "primary checkout restart should succeed",
      });
      const primaryIdsAfter = await readContainerIds({
        cwd: fixture.root,
        composeProject: primaryProject,
      });
      const branchIdsAfter = await readContainerIds({
        cwd: fixture.root,
        composeProject: branchProject,
      });
      expect({
        that:
          primaryIdsAfter.length > 0 &&
          primaryIdsAfter.join(",") !== primaryIdsBefore.join(","),
        message: "primary restart did not replace the primary containers",
        result: restartPrimary,
      });
      expect({
        that: branchIdsAfter.join(",") === branchIdsBefore.join(","),
        message:
          "primary restart changed the linked-worktree branch containers",
        result: restartPrimary,
      });
      const primaryMetadataAfterRestart = await readRuntimeMetadata({
        ctx,
        cwd: fixture.root,
      });
      expect({
        that:
          primaryMetadataAfterRestart?.composeProject === fixture.name &&
          primaryMetadataAfterRestart.services?.api?.urls?.includes(
            `https://api.${fixture.devHost}`
          ) === true,
        message: "primary restart should preserve base-instance runtime URLs",
        result: restartPrimary,
      });

      const downWorktree = await ctx.cli({
        args: ["down"],
        cwd: worktreePath,
        timeoutMs: UP_TIMEOUT_MS,
      });
      expectExit({
        result: downWorktree,
        codes: [0],
        message: "hack down in the worktree should stop the branch instance",
      });
      const downPrimary = await ctx.cli({
        args: ["down"],
        cwd: fixture.root,
        timeoutMs: UP_TIMEOUT_MS,
      });
      expectExit({
        result: downPrimary,
        codes: [0],
        message: "hack down in the primary checkout should succeed",
      });
    } finally {
      await downBestEffort({ ctx, fixture, branches: [BRANCH] });
    }
  },
};

async function readContainerIds(opts: {
  readonly cwd: string;
  readonly composeProject: string;
}): Promise<string[]> {
  const result = await runCommand({
    argv: [
      "docker",
      "ps",
      "--filter",
      `label=com.docker.compose.project=${opts.composeProject}`,
      "--format",
      "{{.ID}}",
    ],
    cwd: opts.cwd,
  });
  if (result.exitCode !== 0) {
    return [];
  }
  return result.stdout
    .split("\n")
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
    .sort((left, right) => left.localeCompare(right));
}

async function resolveOpenUrl(opts: {
  readonly ctx: Parameters<Scenario["run"]>[0];
  readonly cwd: string;
}): Promise<string> {
  const result = await opts.ctx.cli({
    args: ["open", "--json"],
    cwd: opts.cwd,
  });
  expectExit({
    result,
    codes: [0],
    message: `hack open --json failed in ${opts.cwd}`,
  });
  return extractJsonObject<OpenPayload>({ text: result.stdout })?.url ?? "";
}

async function readRuntimeMetadata(opts: {
  readonly ctx: Parameters<Scenario["run"]>[0];
  readonly cwd: string;
}): Promise<RuntimeMetadataPayload | null> {
  const result = await opts.ctx.cli({
    args: ["exec", "web", "--", "printenv", "HACK_RUNTIME_METADATA"],
    cwd: opts.cwd,
  });
  expectExit({
    result,
    codes: [0],
    message: `hack exec should expose runtime metadata in ${opts.cwd}`,
  });
  return extractJsonObject<RuntimeMetadataPayload>({ text: result.stdout });
}
