import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { CliContext, CommandArgs } from "../cli/command.ts";
import {
  CliUsageError,
  defineCommand,
  defineOption,
  withHandler,
} from "../cli/command.ts";
import { optJson, optPath, optProject } from "../cli/options.ts";
import { pathExists } from "../lib/fs.ts";
import { findProjectContext, sanitizeProjectSlug } from "../lib/project.ts";
import { resolveRegisteredProjectByName } from "../lib/projects-registry.ts";
import { exec } from "../lib/shell.ts";
import { display } from "../ui/display.ts";
import { logger } from "../ui/logger.ts";

const optBase = defineOption({
  name: "base",
  type: "string",
  long: "--base",
  valueHint: "<ref>",
  description: "Base ref to reset to (for example: origin/main or HEAD)",
} as const);

const optExclude = defineOption({
  name: "exclude",
  type: "string",
  long: "--exclude",
  valueHint: "<a,b,c>",
  description: "Comma-separated git clean exclude patterns",
} as const);

const workspaceSpec = defineCommand({
  name: "workspace",
  summary: "Inspect and repair project workspaces",
  group: "Project",
  options: [],
  positionals: [],
  subcommands: [],
} as const);

const workspaceResetSpec = defineCommand({
  name: "reset",
  summary: "Reset a workspace to a clean base ref while preserving excludes",
  group: "Project",
  options: [optPath, optProject, optBase, optExclude, optJson],
  positionals: [],
  subcommands: [],
} as const);

type WorkspaceResetArgs = CommandArgs<
  typeof workspaceResetSpec.options,
  typeof workspaceResetSpec.positionals
>;

type WorkspaceResetSummary = {
  readonly ok: boolean;
  readonly projectRoot: string;
  readonly baseRef: string;
  readonly checkoutBranch: string | null;
  readonly fetchedRemote: string | null;
  readonly removedGitIndexLock: boolean;
  readonly cleanArgs: readonly string[];
  readonly cleanedPaths: readonly string[];
  readonly preservedExcludes: readonly string[];
  readonly statusBefore: readonly string[];
  readonly statusAfter: readonly string[];
};

type ParsedBaseRef = {
  readonly baseRef: string;
  readonly remote: string | null;
  readonly branch: string | null;
};

export const workspaceCommand = withHandler(
  defineCommand({
    ...workspaceSpec,
    subcommands: [withHandler(workspaceResetSpec, handleWorkspaceReset)],
  } as const),
  async () => {
    await display.panel({
      title: "Workspace commands",
      tone: "info",
      lines: [
        "hack workspace reset --base <ref> [--path <dir>|--project <name>] [--exclude .env,.hack/]",
      ],
    });
    return 0;
  }
);

async function handleWorkspaceReset({
  ctx,
  args,
}: {
  readonly ctx: CliContext;
  readonly args: WorkspaceResetArgs;
}): Promise<number> {
  try {
    const project = await resolveProjectForArgs({
      ctx,
      pathOpt:
        typeof args.options.path === "string" ? args.options.path : undefined,
      projectOpt:
        typeof args.options.project === "string"
          ? args.options.project
          : undefined,
    });
    const baseRef =
      typeof args.options.base === "string" ? args.options.base.trim() : "";
    if (!baseRef) {
      throw new CliUsageError("Missing --base <ref>.");
    }

    const excludes = parseCsv(
      typeof args.options.exclude === "string"
        ? args.options.exclude
        : undefined
    );
    const summary = await resetWorkspace({
      projectRoot: project.projectRoot,
      baseRef,
      excludes,
    });

    if (args.options.json) {
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
      return summary.ok ? 0 : 1;
    }

    await display.kv({
      title: summary.ok ? "Workspace reset complete" : "Workspace reset failed",
      entries: [
        ["project", summary.projectRoot],
        ["base", summary.baseRef],
        ["branch", summary.checkoutBranch ?? ""],
        ["fetched", summary.fetchedRemote ?? ""],
        ["removed index.lock", summary.removedGitIndexLock ? "yes" : "no"],
        ["cleaned paths", String(summary.cleanedPaths.length)],
      ],
    });
    if (!summary.ok) {
      logger.error({
        message:
          summary.statusAfter.length > 0
            ? `Workspace still dirty after reset:\n${summary.statusAfter.join("\n")}`
            : "Workspace reset failed.",
      });
    }
    return summary.ok ? 0 : 1;
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "workspace reset failed";
    logger.error({ message });
    return 1;
  }
}

async function resetWorkspace(input: {
  readonly projectRoot: string;
  readonly baseRef: string;
  readonly excludes: readonly string[];
}): Promise<WorkspaceResetSummary> {
  const parsedBase = parseBaseRef({ value: input.baseRef });
  const lockPath = resolve(input.projectRoot, ".git", "index.lock");
  const removedGitIndexLock = await removeGitIndexLock({
    lockPath,
  });
  const statusBefore = await readStatusLines({
    projectRoot: input.projectRoot,
  });

  let fetchedRemote: string | null = null;
  if (
    parsedBase.remote &&
    (await hasGitRemote({
      projectRoot: input.projectRoot,
      remote: parsedBase.remote,
    }))
  ) {
    await runGitWithLockRecovery({
      projectRoot: input.projectRoot,
      args: ["fetch", parsedBase.remote, "--prune"],
      lockPath,
      context: `git fetch ${parsedBase.remote} --prune`,
    });
    fetchedRemote = parsedBase.remote;
  }

  if (parsedBase.remote && parsedBase.branch) {
    await runGitWithLockRecovery({
      projectRoot: input.projectRoot,
      args: ["checkout", "-B", parsedBase.branch, parsedBase.baseRef],
      lockPath,
      context: `git checkout -B ${parsedBase.branch} ${parsedBase.baseRef}`,
    });
  }

  await runGitWithLockRecovery({
    projectRoot: input.projectRoot,
    args: ["reset", "--hard", parsedBase.baseRef],
    lockPath,
    context: `git reset --hard ${parsedBase.baseRef}`,
  });

  const cleanArgs = ["clean", "-fd", ...buildCleanExcludeArgs(input.excludes)];
  const dryRun = await runGitWithLockRecovery({
    projectRoot: input.projectRoot,
    args: [...cleanArgs, "-n"],
    lockPath,
    context: `git ${[...cleanArgs, "-n"].join(" ")}`,
  });
  const cleanedPaths = parseGitCleanOutput(dryRun.stdout);

  await runGitWithLockRecovery({
    projectRoot: input.projectRoot,
    args: cleanArgs,
    lockPath,
    context: `git ${cleanArgs.join(" ")}`,
  });

  const trackedClean = await isTrackedTreeClean({
    projectRoot: input.projectRoot,
  });
  const remainingUntracked = await listRemainingUntracked({
    projectRoot: input.projectRoot,
    excludes: input.excludes,
    lockPath,
  });
  const statusAfter = await readStatusLines({
    projectRoot: input.projectRoot,
  });

  return {
    ok: trackedClean && remainingUntracked.length === 0,
    projectRoot: input.projectRoot,
    baseRef: parsedBase.baseRef,
    checkoutBranch: parsedBase.branch,
    fetchedRemote,
    removedGitIndexLock,
    cleanArgs,
    cleanedPaths,
    preservedExcludes: [...input.excludes],
    statusBefore,
    statusAfter,
  };
}

async function resolveProjectForArgs(input: {
  readonly ctx: CliContext;
  readonly pathOpt?: string;
  readonly projectOpt?: string;
}) {
  if (input.pathOpt && input.projectOpt) {
    throw new CliUsageError("Use either --path or --project (not both).");
  }

  if (input.projectOpt) {
    const name = sanitizeProjectSlug(input.projectOpt);
    if (!name) {
      throw new CliUsageError("Invalid --project value.");
    }
    const project = await resolveRegisteredProjectByName({ name });
    if (!project) {
      throw new CliUsageError(
        `Unknown project "${name}". Run 'hack init' in that repo (or run 'hack projects' to see registered projects).`
      );
    }
    return project;
  }

  const startDir = input.pathOpt
    ? resolve(input.ctx.cwd, input.pathOpt)
    : input.ctx.cwd;
  const project = await findProjectContext(startDir);
  if (!project) {
    throw new CliUsageError("No .hack/ found. Run: hack init");
  }
  return project;
}

function parseCsv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseBaseRef(input: { readonly value: string }): ParsedBaseRef {
  const baseRef = input.value.trim();
  const slashIndex = baseRef.indexOf("/");
  if (slashIndex <= 0 || slashIndex === baseRef.length - 1) {
    return { baseRef, remote: null, branch: null };
  }
  return {
    baseRef,
    remote: baseRef.slice(0, slashIndex),
    branch: baseRef.slice(slashIndex + 1),
  };
}

function buildCleanExcludeArgs(excludes: readonly string[]): string[] {
  const args: string[] = [];
  for (const exclude of excludes) {
    args.push("-e", exclude);
  }
  return args;
}

function hasGitIndexLockError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("index.lock") &&
    (normalized.includes("file exists") ||
      normalized.includes("another git process seems to be running") ||
      normalized.includes("unable to create"))
  );
}

async function removeGitIndexLock(input: {
  readonly lockPath: string;
}): Promise<boolean> {
  const existed = await pathExists(input.lockPath);
  if (!existed) {
    return false;
  }
  await rm(input.lockPath, { force: true });
  return true;
}

async function runGitWithLockRecovery(input: {
  readonly projectRoot: string;
  readonly args: readonly string[];
  readonly lockPath: string;
  readonly context: string;
}) {
  let result = await exec(["git", "-C", input.projectRoot, ...input.args], {
    stdin: "ignore",
  });
  if (result.exitCode === 0) {
    return result;
  }

  const combined = `${result.stdout}\n${result.stderr}`;
  if (hasGitIndexLockError(combined)) {
    await removeGitIndexLock({ lockPath: input.lockPath });
    result = await exec(["git", "-C", input.projectRoot, ...input.args], {
      stdin: "ignore",
    });
  }

  if (result.exitCode !== 0) {
    const stderr = result.stderr.trim();
    const stdout = result.stdout.trim();
    const detail = stderr || stdout || "command failed";
    throw new Error(`${input.context} failed: ${detail}`);
  }
  return result;
}

async function hasGitRemote(input: {
  readonly projectRoot: string;
  readonly remote: string;
}): Promise<boolean> {
  const result = await exec(
    ["git", "-C", input.projectRoot, "remote", "get-url", input.remote],
    {
      stdin: "ignore",
    }
  );
  return result.exitCode === 0;
}

async function readStatusLines(input: {
  readonly projectRoot: string;
}): Promise<string[]> {
  const result = await exec(
    [
      "git",
      "-C",
      input.projectRoot,
      "status",
      "--porcelain",
      "--untracked-files=all",
    ],
    { stdin: "ignore" }
  );
  if (result.exitCode !== 0) {
    return [];
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean);
}

async function isTrackedTreeClean(input: {
  readonly projectRoot: string;
}): Promise<boolean> {
  const worktree = await exec(
    ["git", "-C", input.projectRoot, "diff", "--quiet", "--exit-code"],
    { stdin: "ignore" }
  );
  if (worktree.exitCode !== 0) {
    return false;
  }
  const index = await exec(
    [
      "git",
      "-C",
      input.projectRoot,
      "diff",
      "--cached",
      "--quiet",
      "--exit-code",
    ],
    { stdin: "ignore" }
  );
  return index.exitCode === 0;
}

async function listRemainingUntracked(input: {
  readonly projectRoot: string;
  readonly excludes: readonly string[];
  readonly lockPath: string;
}): Promise<string[]> {
  const cleanArgs = [
    "clean",
    "-fdn",
    ...buildCleanExcludeArgs(input.excludes),
  ] as const;
  const result = await runGitWithLockRecovery({
    projectRoot: input.projectRoot,
    args: cleanArgs,
    lockPath: input.lockPath,
    context: `git ${cleanArgs.join(" ")}`,
  });
  return parseGitCleanOutput(result.stdout);
}

function parseGitCleanOutput(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      if (line.startsWith("Would remove ")) {
        return [line.slice("Would remove ".length).trim()];
      }
      if (line.startsWith("Removing ")) {
        return [line.slice("Removing ".length).trim()];
      }
      return [];
    });
}
