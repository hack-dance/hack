import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { isRecord } from "../../../lib/guards.ts";
import type { TicketsGitConfig, TicketsGitRefMode } from "../../sdk/config.ts";
import { stableStringify } from "./util.ts";

export type TicketsGitChannel = {
  readonly ensureCheckedOut: () => Promise<string>;
  readonly appendEvents: (input: {
    readonly events: readonly Record<string, unknown>[];
  }) => Promise<
    { readonly ok: true } | { readonly ok: false; readonly error: string }
  >;
  readonly inspect: () => Promise<TicketsGitInspectResult>;
  readonly repair: (input: {
    readonly pruneLegacyRef: boolean;
  }) => Promise<TicketsGitRepairResult>;
  readonly sync: () => Promise<
    | {
        readonly ok: true;
        readonly branch: string;
        readonly remote?: string;
        readonly didCommit: boolean;
        readonly didPush: boolean;
      }
    | { readonly ok: false; readonly error: string }
  >;
};

export type TicketsGitHealth = {
  readonly branch: string;
  readonly refMode: TicketsGitRefMode;
  readonly remote?: string;
  readonly remoteRef: string;
  readonly legacyRef?: string;
  readonly hasLegacyRef: boolean;
  readonly hasNonTicketFiles: boolean;
  readonly nonTicketPaths: readonly string[];
};

export type TicketsGitInspectResult =
  | { readonly ok: true; readonly health: TicketsGitHealth }
  | { readonly ok: false; readonly error: string };

export type TicketsGitRepairResult =
  | {
      readonly ok: true;
      readonly didCommit: boolean;
      readonly didPush: boolean;
      readonly didPruneLegacy: boolean;
      readonly pruneError?: string;
    }
  | { readonly ok: false; readonly error: string };

export async function createGitTicketsChannel(opts: {
  readonly projectRoot: string;
  readonly config: TicketsGitConfig;
  readonly logger: {
    info: (input: { message: string }) => void;
    warn: (input: { message: string }) => void;
  };
}): Promise<TicketsGitChannel> {
  const ticketsDir = resolve(opts.projectRoot, ".hack/tickets");
  const gitDir = resolve(ticketsDir, "git");
  const bareDir = resolve(gitDir, "bare.git");
  const worktreeDir = resolve(gitDir, "worktree");

  const gitEnabled = opts.config.enabled;
  const refMode: TicketsGitRefMode = opts.config.refMode ?? "hidden";
  const branch = normalizeBranchName(opts.config.branch || "hack/tickets");
  const remoteRef = buildRemoteRef({ branch, refMode });
  const legacyRemoteRef =
    refMode === "hidden" ? buildRemoteRef({ branch, refMode: "heads" }) : null;
  const localBranchRef = `refs/heads/${branch}`;
  const trackingRef = `refs/remotes/origin/${branch}`;
  const remoteName = gitEnabled ? (opts.config.remote ?? "origin").trim() : "";

  const runGitDir = async (input: {
    readonly args: readonly string[];
  }): Promise<{
    readonly ok: boolean;
    readonly stdout: string;
    readonly stderr: string;
  }> => {
    return await runGit({
      cwd: opts.projectRoot,
      args: [
        `--git-dir=${bareDir}`,
        `--work-tree=${worktreeDir}`,
        ...input.args,
      ],
    });
  };

  const resolveRemoteUrl = async (): Promise<string | null> => {
    if (!(gitEnabled && remoteName)) {
      return null;
    }
    const result = await runGit({
      cwd: opts.projectRoot,
      args: ["remote", "get-url", remoteName],
    });
    if (!result.ok) {
      return null;
    }
    const url = result.stdout.trim();
    return url.length > 0 ? url : null;
  };

  const ensureDirs = async () => {
    await mkdir(gitDir, { recursive: true });
    await mkdir(worktreeDir, { recursive: true });
  };

  const ensureBareRepo = async () => {
    try {
      const st = await stat(bareDir);
      if (st.isDirectory()) {
        return;
      }
    } catch {
      // missing, create
    }

    await mkdir(dirname(bareDir), { recursive: true });

    // Important: do NOT `clone --bare` the project.
    // This channel is intended to store *only* `.hack/tickets/**` on a dedicated ref.
    // Cloning the full project makes the tickets repo enormous and causes commits/pushes
    // to include unrelated workspace files.
    const init = await runGit({
      cwd: opts.projectRoot,
      args: ["init", "--bare", bareDir],
    });
    if (!init.ok) {
      throw new Error(
        `Failed to init bare repo: ${init.stderr.trim() || init.stdout.trim()}`
      );
    }
  };

  const ensureSparseCheckout = async (): Promise<void> => {
    // Kept for backward compatibility if the repo ever gains extra paths.
    await mkdir(resolve(bareDir, "info"), { recursive: true });
    await Bun.write(
      resolve(bareDir, "info/sparse-checkout"),
      ".hack/tickets\n"
    );
    await runGitDir({ args: ["config", "core.sparseCheckout", "true"] });
  };

  const ensureRemote = async (): Promise<{
    readonly remoteUrl: string | null;
  }> => {
    if (!(gitEnabled && remoteName)) {
      return { remoteUrl: null };
    }

    const remoteUrl = await resolveRemoteUrl();
    if (!remoteUrl) {
      // biome-ignore lint/suspicious/noEmptyBlockStatements: best-effort cleanup
      await runGitDir({ args: ["remote", "remove", "origin"] }).catch(() => {});
      return { remoteUrl: null };
    }

    const set = await runGitDir({
      args: ["remote", "set-url", "origin", remoteUrl],
    });
    if (!set.ok) {
      await runGitDir({ args: ["remote", "add", "origin", remoteUrl] }).catch(
        // biome-ignore lint/suspicious/noEmptyBlockStatements: best-effort remote setup
        () => {}
      );
    }

    return { remoteUrl };
  };

  const fetchRemoteRef = async (
    ref: string
  ): Promise<
    | { readonly ok: true }
    | { readonly ok: false; readonly error: string; readonly missing: boolean }
  > => {
    const fetched = await runGitDir({
      args: ["fetch", "--prune", "origin", `+${ref}:${trackingRef}`],
    });
    if (fetched.ok) {
      return { ok: true };
    }
    const message = `${fetched.stderr}\n${fetched.stdout}`.trim();
    if (isMissingRemoteRef(message)) {
      return { ok: false, error: message, missing: true };
    }
    return { ok: false, error: message, missing: false };
  };

  const checkoutHead = async (input: {
    readonly remoteUrl: string | null;
  }): Promise<
    { readonly ok: true } | { readonly ok: false; readonly error: string }
  > => {
    await rm(worktreeDir, { recursive: true, force: true });
    await mkdir(worktreeDir, { recursive: true });

    if (input.remoteUrl) {
      let canCheckoutRemote = false;

      const fetched = await fetchRemoteRef(remoteRef);
      if (fetched.ok) {
        canCheckoutRemote = true;
      } else if (fetched.missing && legacyRemoteRef) {
        const legacyFetch = await fetchRemoteRef(legacyRemoteRef);
        if (legacyFetch.ok) {
          canCheckoutRemote = true;
        } else if (!legacyFetch.missing) {
          return { ok: false, error: `git fetch failed: ${legacyFetch.error}` };
        }
      } else if (!fetched.missing) {
        return { ok: false, error: `git fetch failed: ${fetched.error}` };
      }

      if (canCheckoutRemote) {
        const rev = await runGitDir({
          args: ["rev-parse", "--verify", `origin/${branch}`],
        });
        if (rev.ok) {
          const checkout = await runGitDir({
            args: ["checkout", "-B", branch, rev.stdout.trim()],
          });
          if (!checkout.ok) {
            return {
              ok: false,
              error: `git checkout failed: ${checkout.stderr.trim()}`,
            };
          }

          const reset = await runGitDir({ args: ["reset", "--hard"] });
          if (!reset.ok) {
            return {
              ok: false,
              error: `git reset failed: ${reset.stderr.trim()}`,
            };
          }

          return { ok: true };
        }
      }
    }

    const localRef = await runGitDir({
      args: ["rev-parse", "--verify", branch],
    });
    if (!localRef.ok) {
      const orphan = await runGitDir({
        args: ["checkout", "--orphan", branch],
      });
      if (!orphan.ok) {
        return {
          ok: false,
          error: `git checkout --orphan failed: ${orphan.stderr.trim()}`,
        };
      }

      await mkdir(resolve(worktreeDir, ".hack/tickets"), { recursive: true });
      await Bun.write(
        resolve(worktreeDir, ".hack/tickets/README.md"),
        "Tickets ref for hack-cli\n"
      );

      const added = await runGitDir({ args: ["add", "-A"] });
      if (!added.ok) {
        return { ok: false, error: `git add failed: ${added.stderr.trim()}` };
      }
      const committed = await runGitDir({
        args: ["commit", "-m", "init tickets"],
      });
      if (!committed.ok) {
        return {
          ok: false,
          error: `git commit failed: ${committed.stderr.trim()}`,
        };
      }

      return { ok: true };
    }

    const checkout = await runGitDir({ args: ["checkout", branch] });
    if (!checkout.ok) {
      return {
        ok: false,
        error: `git checkout failed: ${checkout.stderr.trim()}`,
      };
    }

    const reset = await runGitDir({ args: ["reset", "--hard"] });
    if (!reset.ok) {
      return { ok: false, error: `git reset failed: ${reset.stderr.trim()}` };
    }

    return { ok: true };
  };

  const ensureCheckedOut = async (): Promise<
    | { readonly ok: true; readonly remoteUrl: string | null }
    | { readonly ok: false; readonly error: string }
  > => {
    await ensureDirs();
    await ensureBareRepo();
    await ensureSparseCheckout();
    const { remoteUrl } = await ensureRemote();

    const checkedOut = await checkoutHead({ remoteUrl });
    if (!checkedOut.ok) {
      return checkedOut;
    }

    return { ok: true, remoteUrl };
  };

  const resolveEventsPath = (tsSeconds: number): string => {
    const d = new Date(tsSeconds * 1000);
    const year = d.getUTCFullYear();
    const month = String(d.getUTCMonth() + 1).padStart(2, "0");
    return resolve(
      worktreeDir,
      `.hack/tickets/events/events-${year}-${month}.jsonl`
    );
  };

  const writeEvents = async (input: {
    readonly events: readonly Record<string, unknown>[];
  }): Promise<
    { readonly ok: true } | { readonly ok: false; readonly error: string }
  > => {
    await mkdir(resolve(worktreeDir, ".hack/tickets/events"), {
      recursive: true,
    });

    const grouped = new Map<string, Record<string, unknown>[]>();
    for (const ev of input.events) {
      const ts =
        typeof ev.ts === "number"
          ? (ev.ts as number)
          : Math.floor(Date.now() / 1000);
      const path = resolveEventsPath(ts);
      const list = grouped.get(path) ?? [];
      list.push(ev);
      grouped.set(path, list);
    }

    for (const [path, events] of grouped) {
      const existing = await Bun.file(path)
        .text()
        .catch(() => "");
      const existingIds = new Set<string>();
      for (const line of existing.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        const parsed = safeJsonParse(trimmed);
        if (isRecord(parsed) && typeof parsed.eventId === "string") {
          existingIds.add(parsed.eventId);
        }
      }

      const lines: string[] = [];
      for (const ev of events) {
        const id = typeof ev.eventId === "string" ? ev.eventId : "";
        if (!id || existingIds.has(id)) {
          continue;
        }
        lines.push(stableStringify(ev));
      }

      if (lines.length > 0) {
        const prefix =
          existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
        await Bun.write(path, `${existing}${prefix}${lines.join("\n")}\n`);
      }
    }

    const normalized = await normalizeLogs();
    if (!normalized.ok) {
      return normalized;
    }

    return { ok: true };
  };

  const normalizeLogs = async (): Promise<
    { readonly ok: true } | { readonly ok: false; readonly error: string }
  > => {
    const eventsDir = resolve(worktreeDir, ".hack/tickets/events");
    let files: string[] = [];
    try {
      files = (await readdir(eventsDir)).filter((f) => f.endsWith(".jsonl"));
    } catch {
      return { ok: true };
    }

    for (const file of files.sort()) {
      const path = resolve(eventsDir, file);
      const text = await Bun.file(path)
        .text()
        .catch(() => "");
      const parsed: Record<string, unknown>[] = [];
      const seen = new Set<string>();

      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        const value = safeJsonParse(trimmed);
        if (!isRecord(value)) {
          continue;
        }
        const eventId = typeof value.eventId === "string" ? value.eventId : "";
        const ts = typeof value.ts === "number" ? value.ts : Number.NaN;
        if (!(eventId && Number.isFinite(ts))) {
          continue;
        }
        if (seen.has(eventId)) {
          continue;
        }
        seen.add(eventId);
        parsed.push(value);
      }

      parsed.sort((a, b) => {
        const aTs = typeof a.ts === "number" ? (a.ts as number) : 0;
        const bTs = typeof b.ts === "number" ? (b.ts as number) : 0;
        if (aTs !== bTs) {
          return aTs - bTs;
        }
        const aId = typeof a.eventId === "string" ? (a.eventId as string) : "";
        const bId = typeof b.eventId === "string" ? (b.eventId as string) : "";
        return aId.localeCompare(bId);
      });

      const next = parsed.map((ev) => stableStringify(ev)).join("\n");
      const normalized = next.length > 0 ? `${next}\n` : "";
      if (normalized !== text) {
        await Bun.write(path, normalized);
      }
    }

    return { ok: true };
  };

  const commitAll = async (
    message: string
  ): Promise<
    | { readonly ok: true; readonly didCommit: boolean }
    | { readonly ok: false; readonly error: string }
  > => {
    const staged = await runGitDir({ args: ["add", "-A"] });
    if (!staged.ok) {
      return { ok: false, error: `git add failed: ${staged.stderr.trim()}` };
    }

    const commit = await runGitDir({ args: ["commit", "-m", message] });
    if (!commit.ok) {
      const msg = `${commit.stderr}\n${commit.stdout}`.trim();
      if (
        msg.includes("nothing to commit") ||
        msg.includes("nothing added to commit")
      ) {
        return { ok: true, didCommit: false };
      }
      return { ok: false, error: `git commit failed: ${msg}` };
    }

    return { ok: true, didCommit: true };
  };

  const pushWithRetry = async (input: {
    readonly remoteUrl: string | null;
    readonly pendingEvents?: readonly Record<string, unknown>[];
  }): Promise<
    | { readonly ok: true; readonly didPush: boolean }
    | { readonly ok: false; readonly error: string }
  > => {
    if (!input.remoteUrl) {
      return { ok: true, didPush: false };
    }

    const push = await runGitDir({
      args: ["push", "origin", `${localBranchRef}:${remoteRef}`],
    });
    if (push.ok) {
      return { ok: true, didPush: true };
    }

    const pushMessage = `${push.stderr}\n${push.stdout}`.trim();
    if (refMode === "hidden" && isHiddenRefRejected(pushMessage)) {
      return {
        ok: false,
        error: `git push failed: ${pushMessage}\nRemote rejected hidden refs. Set controlPlane.tickets.git.refMode to "heads" to use a branch ref.`,
      };
    }

    opts.logger.warn({
      message: `git push failed, retrying after fetch: ${pushMessage}`,
    });

    const checkedOut = await checkoutHead({ remoteUrl: input.remoteUrl });
    if (!checkedOut.ok) {
      return checkedOut;
    }

    if (input.pendingEvents && input.pendingEvents.length > 0) {
      const wrote = await writeEvents({ events: input.pendingEvents });
      if (!wrote.ok) {
        return wrote;
      }
    }

    const committed = await commitAll("tickets: retry");
    if (!committed.ok) {
      return committed;
    }

    const retry = await runGitDir({
      args: ["push", "origin", `${localBranchRef}:${remoteRef}`],
    });
    if (!retry.ok) {
      const retryMessage = `${retry.stderr}\n${retry.stdout}`.trim();
      if (refMode === "hidden" && isHiddenRefRejected(retryMessage)) {
        return {
          ok: false,
          error: `git push failed: ${retryMessage}\nRemote rejected hidden refs. Set controlPlane.tickets.git.refMode to "heads" to use a branch ref.`,
        };
      }
      return { ok: false, error: `git push failed: ${retryMessage}` };
    }

    return { ok: true, didPush: true };
  };

  const listTrackedPaths = async (): Promise<
    | { readonly ok: true; readonly paths: readonly string[] }
    | { readonly ok: false; readonly error: string }
  > => {
    const listed = await runGitDir({ args: ["ls-files", "-z"] });
    if (!listed.ok) {
      return {
        ok: false,
        error: `git ls-files failed: ${listed.stderr.trim()}`,
      };
    }

    const paths = listed.stdout
      .split("\u0000")
      .map((path) => path.trim())
      .filter((path) => path.length > 0);
    return { ok: true, paths };
  };

  const hasRemoteRef = async (ref: string): Promise<boolean> => {
    const remoteUrl = await resolveRemoteUrl();
    if (!remoteUrl) {
      return false;
    }
    const listed = await runGitDir({ args: ["ls-remote", "origin", ref] });
    return listed.ok && listed.stdout.trim().length > 0;
  };

  const pruneWorktreeToTickets = async (): Promise<
    { readonly ok: true } | { readonly ok: false; readonly error: string }
  > => {
    let entries: string[] = [];
    try {
      entries = await readdir(worktreeDir);
    } catch (error: unknown) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to read tickets worktree";
      return { ok: false, error: message };
    }

    for (const entry of entries) {
      if (entry === ".hack" || entry === ".git") {
        continue;
      }
      await rm(resolve(worktreeDir, entry), { recursive: true, force: true });
    }

    const hackDir = resolve(worktreeDir, ".hack");
    try {
      const hackEntries = await readdir(hackDir);
      for (const entry of hackEntries) {
        if (entry === "tickets") {
          continue;
        }
        await rm(resolve(hackDir, entry), { recursive: true, force: true });
      }
    } catch {
      // ignore missing .hack directory
    }

    await mkdir(resolve(worktreeDir, ".hack/tickets"), { recursive: true });
    const readmePath = resolve(worktreeDir, ".hack/tickets/README.md");
    const hasReadme = await Bun.file(readmePath).exists();
    if (!hasReadme) {
      await Bun.write(readmePath, "Tickets ref for hack-cli\n");
    }

    return { ok: true };
  };

  const inspect = async (): Promise<TicketsGitInspectResult> => {
    const checkedOut = await ensureCheckedOut();
    if (!checkedOut.ok) {
      return checkedOut;
    }

    const tracked = await listTrackedPaths();
    if (!tracked.ok) {
      return tracked;
    }

    const nonTicketPaths = tracked.paths.filter(
      (path) => !path.startsWith(".hack/tickets/") && path !== ".hack/tickets"
    );

    const hasLegacyRef = legacyRemoteRef
      ? await hasRemoteRef(legacyRemoteRef)
      : false;

    return {
      ok: true,
      health: {
        branch,
        refMode,
        remoteRef,
        legacyRef: legacyRemoteRef ?? undefined,
        remote: checkedOut.remoteUrl ? remoteName : undefined,
        hasLegacyRef,
        hasNonTicketFiles: nonTicketPaths.length > 0,
        nonTicketPaths,
      },
    };
  };

  const repair = async (input: {
    readonly pruneLegacyRef: boolean;
  }): Promise<TicketsGitRepairResult> => {
    const checkedOut = await ensureCheckedOut();
    if (!checkedOut.ok) {
      return checkedOut;
    }

    const repairBranch = `${branch}-repair`;
    const orphan = await runGitDir({
      args: ["checkout", "--orphan", repairBranch],
    });
    if (!orphan.ok) {
      return {
        ok: false,
        error: `git checkout --orphan failed: ${orphan.stderr.trim()}`,
      };
    }

    const pruned = await pruneWorktreeToTickets();
    if (!pruned.ok) {
      return pruned;
    }

    const renamed = await runGitDir({
      args: ["branch", "-M", repairBranch, branch],
    });
    if (!renamed.ok) {
      return {
        ok: false,
        error: `git branch -M failed: ${renamed.stderr.trim()}`,
      };
    }

    const committed = await commitAll("tickets: repair");
    if (!committed.ok) {
      return committed;
    }

    const pushed = await pushWithRetry({ remoteUrl: checkedOut.remoteUrl });
    if (!pushed.ok) {
      return pushed;
    }

    let didPruneLegacy = false;
    let pruneError: string | undefined;

    if (input.pruneLegacyRef && legacyRemoteRef && checkedOut.remoteUrl) {
      const prunedLegacy = await runGitDir({
        args: ["push", "origin", `:${legacyRemoteRef}`],
      });
      if (prunedLegacy.ok) {
        didPruneLegacy = true;
      } else {
        pruneError = `${prunedLegacy.stderr}\n${prunedLegacy.stdout}`.trim();
      }
    }

    return {
      ok: true,
      didCommit: committed.didCommit,
      didPush: pushed.didPush,
      didPruneLegacy,
      ...(pruneError ? { pruneError } : {}),
    };
  };

  const appendEvents = async (input: {
    readonly events: readonly Record<string, unknown>[];
  }): Promise<
    { readonly ok: true } | { readonly ok: false; readonly error: string }
  > => {
    const checkedOut = await ensureCheckedOut();
    if (!checkedOut.ok) {
      return checkedOut;
    }

    const wrote = await writeEvents({ events: input.events });
    if (!wrote.ok) {
      return wrote;
    }

    const committed = await commitAll("tickets: append events");
    if (!committed.ok) {
      return committed;
    }

    const pushed = await pushWithRetry({
      remoteUrl: checkedOut.remoteUrl,
      pendingEvents: input.events,
    });
    if (!pushed.ok) {
      return pushed;
    }

    return { ok: true };
  };

  const sync = async (): Promise<
    | {
        readonly ok: true;
        readonly branch: string;
        readonly remote?: string;
        readonly didCommit: boolean;
        readonly didPush: boolean;
      }
    | { readonly ok: false; readonly error: string }
  > => {
    const checkedOut = await ensureCheckedOut();
    if (!checkedOut.ok) {
      return checkedOut;
    }

    const normalized = await normalizeLogs();
    if (!normalized.ok) {
      return normalized;
    }

    const committed = await commitAll("tickets: sync");
    if (!committed.ok) {
      return committed;
    }

    const pushed = await pushWithRetry({ remoteUrl: checkedOut.remoteUrl });
    if (!pushed.ok) {
      return pushed;
    }

    return {
      ok: true,
      branch,
      ...(checkedOut.remoteUrl ? { remote: remoteName } : {}),
      didCommit: committed.didCommit,
      didPush: pushed.didPush,
    };
  };

  return {
    ensureCheckedOut: async () => {
      const checkedOut = await ensureCheckedOut();
      if (!checkedOut.ok) {
        throw new Error(checkedOut.error);
      }
      return worktreeDir;
    },
    appendEvents,
    inspect,
    repair,
    sync,
  };
}

async function runGit(opts: {
  readonly cwd: string;
  readonly args: readonly string[];
}): Promise<{
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}> {
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
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isMissingRemoteRef(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("couldn't find remote ref") ||
    (normalized.includes("remote ref") && normalized.includes("not found")) ||
    (normalized.includes("remote branch") && normalized.includes("not found"))
  );
}

function normalizeBranchName(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return "hack/tickets";
  }
  return trimmed.replace(/^refs\/heads\//, "").replace(/^refs\//, "");
}

function buildRemoteRef(opts: {
  readonly branch: string;
  readonly refMode: TicketsGitRefMode;
}): string {
  const branch = normalizeBranchName(opts.branch);
  if (opts.refMode === "heads") {
    return `refs/heads/${branch}`;
  }
  return `refs/${branch}`;
}

function isHiddenRefRejected(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("deny updating a hidden ref") ||
    normalized.includes("deny updating hidden ref") ||
    normalized.includes("update is not allowed") ||
    normalized.includes("remote rejected") ||
    normalized.includes("not a valid ref")
  );
}
