import { resolve } from "node:path";

import { readTextFile, writeTextFileIfChanged } from "../../../lib/fs.ts";

export type TicketsRepoGitignoreStatus = "present" | "missing" | "error";
export type TicketsRepoTrackedStatus =
  | "clean"
  | "tracked"
  | "unavailable"
  | "error";
export type TicketsRepoGitignoreFixStatus =
  | "created"
  | "updated"
  | "noop"
  | "error";
export type TicketsRepoUntrackStatus =
  | "removed"
  | "noop"
  | "skipped"
  | "unavailable"
  | "error";

export type TicketsRepoState = {
  readonly gitignore: {
    readonly status: TicketsRepoGitignoreStatus;
    readonly path: string;
    readonly message?: string;
  };
  readonly tracked: {
    readonly status: TicketsRepoTrackedStatus;
    readonly message?: string;
  };
};

export type TicketsRepoFix = {
  readonly gitignore: {
    readonly status: TicketsRepoGitignoreFixStatus;
    readonly path: string;
    readonly message?: string;
  };
  readonly untrack: {
    readonly status: TicketsRepoUntrackStatus;
    readonly message?: string;
  };
};

const GITIGNORE_ENTRY = ".hack/tickets/";
const GITIGNORE_HEADER = "# hack tickets";

export async function checkTicketsRepoState(opts: {
  readonly projectRoot: string;
}): Promise<TicketsRepoState> {
  const gitignorePath = resolve(opts.projectRoot, ".gitignore");
  const gitignoreText = await readTextFile(gitignorePath);

  const gitignoreStatus: TicketsRepoState["gitignore"] = resolveGitignoreStatus(
    {
      gitignoreText,
      gitignorePath,
    }
  );

  const tracked = await runGit({
    cwd: opts.projectRoot,
    args: ["ls-files", "-z", "--", ".hack/tickets"],
  });

  if (!tracked.ok) {
    const message = formatGitError(tracked);
    if (isNotGitRepo(message)) {
      return {
        gitignore: gitignoreStatus,
        tracked: { status: "unavailable", message },
      };
    }

    return {
      gitignore: gitignoreStatus,
      tracked: { status: "error", message },
    };
  }

  const isTracked = tracked.stdout.length > 0;
  return {
    gitignore: gitignoreStatus,
    tracked: { status: isTracked ? "tracked" : "clean" },
  };
}

export async function ensureTicketsGitignore(opts: {
  readonly projectRoot: string;
}): Promise<TicketsRepoFix["gitignore"]> {
  const path = resolve(opts.projectRoot, ".gitignore");
  const existing = await readTextFile(path);

  if (existing !== null && hasGitignoreEntry({ content: existing })) {
    return { status: "noop", path };
  }

  const next = buildGitignoreContent({ existing });
  const result = await writeTextFileIfChanged(path, next);
  if (!result.changed) {
    return { status: "noop", path };
  }

  return { status: existing === null ? "created" : "updated", path };
}

export async function untrackTicketsRepo(opts: {
  readonly projectRoot: string;
}): Promise<TicketsRepoFix["untrack"]> {
  const listed = await runGit({
    cwd: opts.projectRoot,
    args: ["ls-files", "-z", "--", ".hack/tickets"],
  });

  if (!listed.ok) {
    const message = formatGitError(listed);
    if (isNotGitRepo(message)) {
      return { status: "unavailable", message };
    }
    return { status: "error", message };
  }

  if (listed.stdout.length === 0) {
    return { status: "noop" };
  }

  const removed = await runGit({
    cwd: opts.projectRoot,
    args: ["rm", "-r", "--cached", "--", ".hack/tickets"],
  });

  if (!removed.ok) {
    return { status: "error", message: formatGitError(removed) };
  }

  return { status: "removed" };
}

function resolveGitignoreStatus(opts: {
  readonly gitignoreText: string | null;
  readonly gitignorePath: string;
}): TicketsRepoState["gitignore"] {
  if (opts.gitignoreText === null) {
    return { status: "missing", path: opts.gitignorePath };
  }
  if (hasGitignoreEntry({ content: opts.gitignoreText })) {
    return { status: "present", path: opts.gitignorePath };
  }
  return { status: "missing", path: opts.gitignorePath };
}

function hasGitignoreEntry(opts: { readonly content: string }): boolean {
  return opts.content
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 && !line.startsWith("#") && !line.startsWith("!")
    )
    .some(
      (line) =>
        line === ".hack/tickets" ||
        line === ".hack/tickets/" ||
        line.startsWith(".hack/tickets/")
    );
}

function buildGitignoreContent(opts: {
  readonly existing: string | null;
}): string {
  const trimmed = (opts.existing ?? "").trimEnd();
  const addition = `${GITIGNORE_HEADER}\n${GITIGNORE_ENTRY}`;
  if (!trimmed) {
    return `${addition}\n`;
  }
  return `${trimmed}\n\n${addition}\n`;
}

function isNotGitRepo(message: string): boolean {
  return message.toLowerCase().includes("not a git repository");
}

function formatGitError(result: {
  readonly stdout: string;
  readonly stderr: string;
}): string {
  return `${result.stderr}\n${result.stdout}`.trim() || "git command failed";
}

async function runGit(opts: {
  readonly cwd: string;
  readonly args: readonly string[];
}): Promise<{
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}> {
  try {
    const proc = Bun.spawn(["git", ...opts.args], {
      cwd: opts.cwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    return { ok: exitCode === 0, stdout, stderr };
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Failed to run git";
    return { ok: false, stdout: "", stderr: message };
  }
}
