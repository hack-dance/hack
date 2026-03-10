import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { isRecord } from "../../../lib/guards.ts";
import type { TicketsGitConfig, TicketsGitRefMode } from "../../sdk/config.ts";
import { stableStringify } from "./util.ts";

const REFS_HEADS_PREFIX_PATTERN = /^refs\/heads\//;
const REFS_PREFIX_PATTERN = /^refs\//;

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
  readonly hasRefDivergence: boolean;
  readonly remoteRefOid?: string;
  readonly legacyRefOid?: string;
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

export function createGitTicketsChannel(opts: {
  readonly projectRoot: string;
  readonly config: TicketsGitConfig;
  readonly logger: {
    info: (input: { message: string }) => void;
    warn: (input: { message: string }) => void;
  };
}): TicketsGitChannel {
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
  const legacyTrackingRef = legacyRemoteRef
    ? `refs/remotes/origin/__legacy__/${branch}`
    : null;
  const remoteName = gitEnabled ? (opts.config.remote ?? "origin").trim() : "";
  const bareIndexLockPath = resolve(bareDir, "index.lock");

  const resolvePushRefForCheckout = (input: {
    readonly checkoutRef: string;
  }): string =>
    resolvePushRefForCheckoutRef({
      checkoutRef: input.checkoutRef,
      remoteRef,
      legacyTrackingRef,
      legacyRemoteRef,
    });

  const runGitDir = async (input: {
    readonly args: readonly string[];
  }): Promise<{
    readonly ok: boolean;
    readonly stdout: string;
    readonly stderr: string;
  }> => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = await runGit({
        cwd: opts.projectRoot,
        args: [
          `--git-dir=${bareDir}`,
          `--work-tree=${worktreeDir}`,
          ...input.args,
        ],
      });
      if (result.ok) {
        return result;
      }

      const message = `${result.stderr}\n${result.stdout}`.trim();
      if (!isGitIndexLockError(message)) {
        return result;
      }

      if (attempt < 3) {
        await Bun.sleep(150 * (attempt + 1));
        continue;
      }

      opts.logger.warn({
        message: `tickets git index.lock blocked ${input.args.join(" ")}; removing stale lock and retrying`,
      });
      try {
        await rm(bareIndexLockPath, { force: true });
      } catch {
        // Best-effort stale lock cleanup; retry will surface a real error if it still exists.
      }
    }

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

  const hasPendingWorktreeChanges = async (): Promise<boolean> => {
    const currentBranch = await runGitDir({
      args: ["branch", "--show-current"],
    });
    if (!currentBranch.ok) {
      return false;
    }
    if (currentBranch.stdout.trim() !== branch) {
      return false;
    }

    const status = await runGitDir({
      args: ["status", "--short"],
    });
    return status.ok && status.stdout.trim().length > 0;
  };

  const resolvePreferredTrackingRef = async (): Promise<string | null> => {
    const tracking = await runGitDir({
      args: ["rev-parse", "--verify", trackingRef],
    });
    if (tracking.ok) {
      return trackingRef;
    }

    if (legacyTrackingRef) {
      const legacy = await runGitDir({
        args: ["rev-parse", "--verify", legacyTrackingRef],
      });
      if (legacy.ok) {
        return legacyTrackingRef;
      }
    }

    return null;
  };

  const hasAheadLocalBranchCommits = async (input: {
    readonly trackingRef: string | null;
  }): Promise<boolean> => {
    if (!input.trackingRef) {
      return false;
    }

    const currentBranch = await runGitDir({
      args: ["branch", "--show-current"],
    });
    if (!currentBranch.ok || currentBranch.stdout.trim() !== branch) {
      return false;
    }

    const ahead = await runGitDir({
      args: ["rev-list", "--count", `${input.trackingRef}..${branch}`],
    });
    if (!ahead.ok) {
      return false;
    }

    return Number.parseInt(ahead.stdout.trim(), 10) > 0;
  };

  const fetchRemoteRefToTracking = async (
    ref: string,
    destinationRef: string
  ): Promise<
    | { readonly ok: true }
    | { readonly ok: false; readonly error: string; readonly missing: boolean }
  > => {
    const fetchArgs = [
      "fetch",
      "--prune",
      "origin",
      `+${ref}:${destinationRef}`,
    ] as const;
    let fetched = await runGitDir({
      args: fetchArgs,
    });
    if (!fetched.ok) {
      const retryableLockFailure = isRetryableTrackingRefLockFailure({
        stderr: fetched.stderr,
        trackingRef: destinationRef,
      });
      if (retryableLockFailure) {
        const deletedTrackingRef = await runGitDir({
          args: ["update-ref", "-d", destinationRef],
        });
        void deletedTrackingRef;
        fetched = await runGitDir({
          args: fetchArgs,
        });
      }
    }
    if (fetched.ok) {
      return { ok: true };
    }
    const message = `${fetched.stderr}\n${fetched.stdout}`.trim();
    if (isMissingRemoteRef(message)) {
      return { ok: false, error: message, missing: true };
    }
    return { ok: false, error: message, missing: false };
  };

  const fetchRemoteRef = async (
    ref: string
  ): Promise<
    | { readonly ok: true }
    | { readonly ok: false; readonly error: string; readonly missing: boolean }
  > => {
    return await fetchRemoteRefToTracking(ref, trackingRef);
  };

  async function checkoutRefAndReset(input: {
    readonly checkoutRef: string;
  }): Promise<
    | { readonly ok: true; readonly pushRef: string }
    | { readonly ok: false; readonly error: string }
  > {
    const rev = await runGitDir({
      args: ["rev-parse", "--verify", input.checkoutRef],
    });
    if (!rev.ok) {
      return { ok: false, error: `git rev-parse failed: ${rev.stderr.trim()}` };
    }
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
      return { ok: false, error: `git reset failed: ${reset.stderr.trim()}` };
    }
    return {
      ok: true,
      pushRef: resolvePushRefForCheckout({ checkoutRef: input.checkoutRef }),
    };
  }

  async function initializeOrphanBranch(): Promise<
    | { readonly ok: true; readonly pushRef: string }
    | { readonly ok: false; readonly error: string }
  > {
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
    return { ok: true, pushRef: remoteRef };
  }

  async function fetchPrimaryCheckoutRef(): Promise<
    | { readonly ok: true; readonly checkoutRef: string }
    | { readonly ok: false; readonly error?: string; readonly missing: boolean }
  > {
    const fetched = await fetchRemoteRef(remoteRef);
    if (!fetched.ok) {
      return fetched.missing
        ? { ok: false, missing: true }
        : {
            ok: false,
            missing: false,
            error: `git fetch failed: ${fetched.error}`,
          };
    }
    if (legacyRemoteRef && legacyTrackingRef) {
      const legacyFetch = await fetchRemoteRefToTracking(
        legacyRemoteRef,
        legacyTrackingRef
      );
      if (!(legacyFetch.ok || legacyFetch.missing)) {
        return {
          ok: false,
          missing: false,
          error: `git fetch failed: ${legacyFetch.error}`,
        };
      }
    }
    return { ok: true, checkoutRef: `origin/${branch}` };
  }

  async function fetchLegacyCheckoutRef(): Promise<
    | { readonly ok: true; readonly checkoutRef: string }
    | { readonly ok: false; readonly error?: string; readonly missing: boolean }
  > {
    if (!legacyRemoteRef) {
      return { ok: false, missing: true };
    }
    const legacyFetch = legacyTrackingRef
      ? await fetchRemoteRefToTracking(legacyRemoteRef, legacyTrackingRef)
      : await fetchRemoteRef(legacyRemoteRef);
    if (legacyFetch.ok) {
      return {
        ok: true,
        checkoutRef: legacyTrackingRef ?? legacyRemoteRef,
      };
    }
    return legacyFetch.missing
      ? { ok: false, missing: true }
      : {
          ok: false,
          missing: false,
          error: `git fetch failed: ${legacyFetch.error}`,
        };
  }

  async function resolveRemoteCheckoutRef(input: {
    readonly remoteUrl: string | null;
  }): Promise<
    | { readonly ok: true; readonly checkoutRef: string }
    | { readonly ok: false; readonly error?: string }
  > {
    if (!input.remoteUrl) {
      return { ok: false };
    }

    const primary = await fetchPrimaryCheckoutRef();
    if (primary.ok) {
      return primary;
    }
    if (primary.error) {
      return { ok: false, error: primary.error };
    }

    const legacy = await fetchLegacyCheckoutRef();
    if (legacy.ok) {
      return legacy;
    }
    return legacy.error ? { ok: false, error: legacy.error } : { ok: false };
  }

  async function checkoutHead(input: {
    readonly remoteUrl: string | null;
  }): Promise<
    | { readonly ok: true; readonly pushRef: string }
    | { readonly ok: false; readonly error: string }
  > {
    await rm(worktreeDir, { recursive: true, force: true });
    await mkdir(worktreeDir, { recursive: true });

    if (input.remoteUrl) {
      const remoteCheckout = await resolveRemoteCheckoutRef({
        remoteUrl: input.remoteUrl,
      });
      if (remoteCheckout.ok) {
        return await checkoutRefAndReset({
          checkoutRef: remoteCheckout.checkoutRef,
        });
      }
      if (remoteCheckout.error) {
        return {
          ok: false,
          error: remoteCheckout.error,
        };
      }
    }

    const localRef = await runGitDir({
      args: ["rev-parse", "--verify", branch],
    });
    if (!localRef.ok) {
      return await initializeOrphanBranch();
    }

    return await checkoutRefAndReset({ checkoutRef: branch });
  }

  async function listLegacyEventPaths(): Promise<
    | { readonly ok: true; readonly paths: readonly string[] }
    | { readonly ok: false; readonly error: string }
  > {
    if (!legacyTrackingRef) {
      return { ok: true, paths: [] };
    }
    const listed = await runGitDir({
      args: [
        "ls-tree",
        "-r",
        "--name-only",
        legacyTrackingRef,
        ".hack/tickets/events",
      ],
    });
    if (!listed.ok) {
      return {
        ok: false,
        error: `git ls-tree failed: ${listed.stderr.trim() || listed.stdout.trim()}`,
      };
    }
    return {
      ok: true,
      paths: listed.stdout
        .split("\n")
        .map((path) => path.trim())
        .filter((path) => path.startsWith(".hack/tickets/events/")),
    };
  }

  async function mergeLegacyEventPath(input: {
    readonly relativePath: string;
  }): Promise<
    | { readonly ok: true; readonly imported: boolean }
    | { readonly ok: false; readonly error: string }
  > {
    if (!legacyTrackingRef) {
      return { ok: true, imported: false };
    }
    const shown = await runGitDir({
      args: ["show", `${legacyTrackingRef}:${input.relativePath}`],
    });
    if (!shown.ok) {
      return {
        ok: false,
        error: `git show failed: ${shown.stderr.trim() || shown.stdout.trim()}`,
      };
    }

    const targetPath = resolve(worktreeDir, input.relativePath);
    const existing = await Bun.file(targetPath)
      .text()
      .catch(() => "");
    const merged = mergeTicketEventLogs({
      existing,
      incoming: shown.stdout,
    });
    if (merged === existing) {
      return { ok: true, imported: false };
    }

    await mkdir(dirname(targetPath), { recursive: true });
    await Bun.write(targetPath, merged);
    return { ok: true, imported: true };
  }

  async function mergeLegacyRefIntoCurrentBranch(input: {
    readonly remoteUrl: string | null;
  }): Promise<
    | { readonly ok: true; readonly imported: boolean }
    | { readonly ok: false; readonly error: string }
  > {
    if (!(input.remoteUrl && legacyRemoteRef && legacyTrackingRef)) {
      return { ok: true, imported: false };
    }

    const fetched = await fetchRemoteRefToTracking(
      legacyRemoteRef,
      legacyTrackingRef
    );
    if (!fetched.ok) {
      if (fetched.missing) {
        return { ok: true, imported: false };
      }
      return { ok: false, error: `git fetch failed: ${fetched.error}` };
    }

    const listed = await listLegacyEventPaths();
    if (!listed.ok) {
      return listed;
    }
    let imported = false;
    for (const relativePath of listed.paths) {
      const merged = await mergeLegacyEventPath({ relativePath });
      if (!merged.ok) {
        return merged;
      }
      imported = imported || merged.imported;
    }

    if (!imported) {
      return { ok: true, imported: false };
    }

    const normalized = await normalizeLogs();
    if (!normalized.ok) {
      return normalized;
    }

    return { ok: true, imported: true };
  }

  const ensureCheckedOut = async (): Promise<
    | {
        readonly ok: true;
        readonly remoteUrl: string | null;
        readonly pushRef: string;
      }
    | { readonly ok: false; readonly error: string }
  > => {
    await ensureDirs();
    await ensureBareRepo();
    await ensureSparseCheckout();
    const { remoteUrl } = await ensureRemote();

    if (await hasPendingWorktreeChanges()) {
      const pushRef =
        refMode === "hidden" && legacyRemoteRef ? legacyRemoteRef : remoteRef;
      return { ok: true, remoteUrl, pushRef };
    }

    const preferredTrackingRef = await resolvePreferredTrackingRef();
    if (
      await hasAheadLocalBranchCommits({ trackingRef: preferredTrackingRef })
    ) {
      const pushRef =
        preferredTrackingRef === legacyTrackingRef && legacyRemoteRef
          ? legacyRemoteRef
          : remoteRef;
      return { ok: true, remoteUrl, pushRef };
    }

    const checkedOut = await checkoutHead({ remoteUrl });
    if (!checkedOut.ok) {
      return checkedOut;
    }

    const migratedLegacy = await mergeLegacyRefIntoCurrentBranch({ remoteUrl });
    if (!migratedLegacy.ok) {
      return migratedLegacy;
    }

    return { ok: true, remoteUrl, pushRef: checkedOut.pushRef };
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

  function groupEventsByPath(
    events: readonly Record<string, unknown>[]
  ): ReadonlyMap<string, Record<string, unknown>[]> {
    const grouped = new Map<string, Record<string, unknown>[]>();
    for (const event of events) {
      const ts =
        typeof event.ts === "number" ? event.ts : Math.floor(Date.now() / 1000);
      const path = resolveEventsPath(ts);
      const list = grouped.get(path) ?? [];
      list.push(event);
      grouped.set(path, list);
    }
    return grouped;
  }

  async function appendEventLogFile(input: {
    readonly path: string;
    readonly events: readonly Record<string, unknown>[];
  }): Promise<void> {
    const existing = await Bun.file(input.path)
      .text()
      .catch(() => "");
    const lines = buildNewTicketEventLines({
      existing,
      events: input.events,
    });
    if (lines.length === 0) {
      return;
    }
    const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    await Bun.write(input.path, `${existing}${prefix}${lines.join("\n")}\n`);
  }

  async function listEventLogFiles(): Promise<string[]> {
    const eventsDir = resolve(worktreeDir, ".hack/tickets/events");
    try {
      return (await readdir(eventsDir))
        .filter((file) => file.endsWith(".jsonl"))
        .sort();
    } catch {
      return [];
    }
  }

  async function normalizeEventLogFile(path: string): Promise<void> {
    const text = await Bun.file(path)
      .text()
      .catch(() => "");
    const normalized = normalizeTicketEventLogText(text);
    if (normalized !== text) {
      await Bun.write(path, normalized);
    }
  }

  async function writeEvents(input: {
    readonly events: readonly Record<string, unknown>[];
  }): Promise<
    { readonly ok: true } | { readonly ok: false; readonly error: string }
  > {
    await mkdir(resolve(worktreeDir, ".hack/tickets/events"), {
      recursive: true,
    });

    for (const [path, events] of groupEventsByPath(input.events)) {
      await appendEventLogFile({ path, events });
    }

    const normalized = await normalizeLogs();
    if (!normalized.ok) {
      return normalized;
    }

    return { ok: true };
  }

  async function readAllWorktreeEvents(): Promise<
    | {
        readonly ok: true;
        readonly events: readonly Record<string, unknown>[];
      }
    | { readonly ok: false; readonly error: string }
  > {
    const eventsDir = resolve(worktreeDir, ".hack/tickets/events");
    const files = await listEventLogFiles();
    if (files.length === 0) {
      return { ok: true, events: [] };
    }

    const events: Record<string, unknown>[] = [];
    for (const file of files) {
      const path = resolve(eventsDir, file);
      const text = await Bun.file(path)
        .text()
        .catch(() => "");
      events.push(...readTicketEventRecords(text));
    }

    return { ok: true, events };
  }

  async function normalizeLogs(): Promise<
    { readonly ok: true } | { readonly ok: false; readonly error: string }
  > {
    const eventsDir = resolve(worktreeDir, ".hack/tickets/events");
    const files = await listEventLogFiles();
    if (files.length === 0) {
      return { ok: true };
    }

    for (const file of files) {
      await normalizeEventLogFile(resolve(eventsDir, file));
    }

    return { ok: true };
  }

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

  function buildHiddenRefRejectedError(message: string): string {
    return `git push failed: ${message}\nRemote rejected hidden refs. Set controlPlane.tickets.git.refMode to "heads" to use a branch ref.`;
  }

  async function replayEventsAfterRefresh(input: {
    readonly remoteUrl: string | null;
    readonly pendingEvents?: readonly Record<string, unknown>[];
  }): Promise<
    | {
        readonly ok: true;
        readonly pushRef: string;
      }
    | { readonly ok: false; readonly error: string }
  > {
    const replayEvents = input.pendingEvents
      ? { ok: true as const, events: input.pendingEvents }
      : await readAllWorktreeEvents();
    if (!replayEvents.ok) {
      return replayEvents;
    }

    const checkedOut = await checkoutHead({ remoteUrl: input.remoteUrl });
    if (!checkedOut.ok) {
      return checkedOut;
    }

    if (replayEvents.events.length > 0) {
      const wrote = await writeEvents({ events: replayEvents.events });
      if (!wrote.ok) {
        return wrote;
      }
    }

    const committed = await commitAll("tickets: retry");
    if (!committed.ok) {
      return committed;
    }

    return {
      ok: true,
      pushRef: checkedOut.pushRef,
    };
  }

  async function pushWithRetry(input: {
    readonly remoteUrl: string | null;
    readonly pushRef: string;
    readonly pendingEvents?: readonly Record<string, unknown>[];
  }): Promise<
    | { readonly ok: true; readonly didPush: boolean }
    | { readonly ok: false; readonly error: string }
  > {
    if (!input.remoteUrl) {
      return { ok: true, didPush: false };
    }

    const push = await runGitDir({
      args: ["push", "origin", `${localBranchRef}:${input.pushRef}`],
    });
    if (push.ok) {
      return { ok: true, didPush: true };
    }

    const pushMessage = `${push.stderr}\n${push.stdout}`.trim();
    if (refMode === "hidden" && isHiddenRefRejected(pushMessage)) {
      return {
        ok: false,
        error: buildHiddenRefRejectedError(pushMessage),
      };
    }

    opts.logger.warn({
      message: `git push failed, retrying after fetch: ${pushMessage}`,
    });
    const replayed = await replayEventsAfterRefresh({
      remoteUrl: input.remoteUrl,
      pendingEvents: input.pendingEvents,
    });
    if (!replayed.ok) {
      return replayed;
    }

    const retry = await runGitDir({
      args: ["push", "origin", `${localBranchRef}:${replayed.pushRef}`],
    });
    if (!retry.ok) {
      const retryMessage = `${retry.stderr}\n${retry.stdout}`.trim();
      if (refMode === "hidden" && isHiddenRefRejected(retryMessage)) {
        return {
          ok: false,
          error: buildHiddenRefRejectedError(retryMessage),
        };
      }
      return { ok: false, error: `git push failed: ${retryMessage}` };
    }

    return { ok: true, didPush: true };
  }

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

  const resolveRefOid = async (ref: string): Promise<string | null> => {
    const resolved = await runGitDir({
      args: ["rev-parse", "--verify", ref],
    });
    if (!resolved.ok) {
      return null;
    }
    const oid = resolved.stdout.trim();
    return oid.length > 0 ? oid : null;
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
    const remoteRefOid = await resolveRefOid(trackingRef);
    const legacyRefOid =
      hasLegacyRef && legacyTrackingRef
        ? await resolveRefOid(legacyTrackingRef)
        : null;
    const hasRefDivergence =
      hasLegacyRef &&
      remoteRefOid !== null &&
      legacyRefOid !== null &&
      remoteRefOid !== legacyRefOid;

    return {
      ok: true,
      health: {
        branch,
        refMode,
        remoteRef,
        legacyRef: legacyRemoteRef ?? undefined,
        remote: checkedOut.remoteUrl ? remoteName : undefined,
        hasLegacyRef,
        hasRefDivergence,
        remoteRefOid: remoteRefOid ?? undefined,
        legacyRefOid: legacyRefOid ?? undefined,
        hasNonTicketFiles: nonTicketPaths.length > 0,
        nonTicketPaths,
      },
    };
  };

  async function createRepairBranch(input: {
    readonly repairBranch: string;
  }): Promise<
    { readonly ok: true } | { readonly ok: false; readonly error: string }
  > {
    const orphan = await runGitDir({
      args: ["checkout", "--orphan", input.repairBranch],
    });
    if (!orphan.ok) {
      return {
        ok: false,
        error: `git checkout --orphan failed: ${orphan.stderr.trim()}`,
      };
    }
    const renamed = await runGitDir({
      args: ["branch", "-M", input.repairBranch, branch],
    });
    if (!renamed.ok) {
      return {
        ok: false,
        error: `git branch -M failed: ${renamed.stderr.trim()}`,
      };
    }
    return { ok: true };
  }

  async function pruneLegacyRemoteRef(input: {
    readonly pruneLegacyRef: boolean;
    readonly remoteUrl: string | null;
  }): Promise<{
    readonly didPruneLegacy: boolean;
    readonly pruneError?: string;
  }> {
    if (!(input.pruneLegacyRef && legacyRemoteRef && input.remoteUrl)) {
      return { didPruneLegacy: false };
    }
    const prunedLegacy = await runGitDir({
      args: ["push", "origin", `:${legacyRemoteRef}`],
    });
    if (!prunedLegacy.ok) {
      return {
        didPruneLegacy: false,
        pruneError: `${prunedLegacy.stderr}\n${prunedLegacy.stdout}`.trim(),
      };
    }
    if (legacyTrackingRef) {
      await runGitDir({
        args: ["update-ref", "-d", legacyTrackingRef],
      });
    }
    return { didPruneLegacy: true };
  }

  async function repair(input: {
    readonly pruneLegacyRef: boolean;
  }): Promise<TicketsGitRepairResult> {
    const checkedOut = await ensureCheckedOut();
    if (!checkedOut.ok) {
      return checkedOut;
    }

    const repairBranch = `${branch}-repair`;
    const created = await createRepairBranch({ repairBranch });
    if (!created.ok) {
      return created;
    }

    const pruned = await pruneWorktreeToTickets();
    if (!pruned.ok) {
      return pruned;
    }

    const committed = await commitAll("tickets: repair");
    if (!committed.ok) {
      return committed;
    }

    const pushed = await pushWithRetry({
      remoteUrl: checkedOut.remoteUrl,
      pushRef: checkedOut.pushRef,
    });
    if (!pushed.ok) {
      return pushed;
    }

    const legacyPrune = await pruneLegacyRemoteRef({
      pruneLegacyRef: input.pruneLegacyRef,
      remoteUrl: checkedOut.remoteUrl,
    });

    return {
      ok: true,
      didCommit: committed.didCommit,
      didPush: pushed.didPush,
      didPruneLegacy: legacyPrune.didPruneLegacy,
      ...(legacyPrune.pruneError ? { pruneError: legacyPrune.pruneError } : {}),
    };
  }

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
      pushRef: checkedOut.pushRef,
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

    const pushed = await pushWithRetry({
      remoteUrl: checkedOut.remoteUrl,
      pushRef: checkedOut.pushRef,
    });
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
    env: {
      ...process.env,
      ...resolveTicketGitIdentityEnv(),
    },
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { ok: exitCode === 0, stdout, stderr };
}

function resolveTicketGitIdentityEnv(): Record<string, string> {
  const authorName =
    readOptionalEnv("GIT_AUTHOR_NAME") ??
    readOptionalEnv("GIT_COMMITTER_NAME") ??
    "hack tickets";
  const authorEmail =
    readOptionalEnv("GIT_AUTHOR_EMAIL") ??
    readOptionalEnv("GIT_COMMITTER_EMAIL") ??
    "tickets@hack.local";
  const committerName = readOptionalEnv("GIT_COMMITTER_NAME") ?? authorName;
  const committerEmail = readOptionalEnv("GIT_COMMITTER_EMAIL") ?? authorEmail;
  return {
    GIT_AUTHOR_NAME: authorName,
    GIT_AUTHOR_EMAIL: authorEmail,
    GIT_COMMITTER_NAME: committerName,
    GIT_COMMITTER_EMAIL: committerEmail,
  };
}

function readOptionalEnv(key: string): string | null {
  const value = process.env[key];
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseTicketEventRecord(
  value: unknown
): Record<string, unknown> | null {
  if (!isRecord(value)) {
    return null;
  }
  const eventId = typeof value.eventId === "string" ? value.eventId.trim() : "";
  const ts = typeof value.ts === "number" ? value.ts : Number.NaN;
  if (!(eventId && Number.isFinite(ts))) {
    return null;
  }
  return value;
}

function readTicketEventRecords(text: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const parsed = parseTicketEventRecord(safeJsonParse(trimmed));
    if (parsed) {
      events.push(parsed);
    }
  }
  return events;
}

function sortTicketEventRecords(events: Record<string, unknown>[]): void {
  events.sort((left, right) => {
    const leftTs = typeof left.ts === "number" ? (left.ts as number) : 0;
    const rightTs = typeof right.ts === "number" ? (right.ts as number) : 0;
    if (leftTs !== rightTs) {
      return leftTs - rightTs;
    }
    const leftId =
      typeof left.eventId === "string" ? (left.eventId as string) : "";
    const rightId =
      typeof right.eventId === "string" ? (right.eventId as string) : "";
    return leftId.localeCompare(rightId);
  });
}

function dedupeTicketEventRecords(
  events: readonly Record<string, unknown>[]
): Record<string, unknown>[] {
  const seen = new Set<string>();
  const deduped: Record<string, unknown>[] = [];
  for (const event of events) {
    const eventId =
      typeof event.eventId === "string" ? event.eventId.trim() : "";
    if (!(eventId && !seen.has(eventId))) {
      continue;
    }
    seen.add(eventId);
    deduped.push(event);
  }
  return deduped;
}

function formatTicketEventRecords(
  events: readonly Record<string, unknown>[]
): string {
  const next = events.map((event) => stableStringify(event)).join("\n");
  return next ? `${next}\n` : "";
}

function buildNewTicketEventLines(input: {
  readonly existing: string;
  readonly events: readonly Record<string, unknown>[];
}): string[] {
  const existingIds = new Set<string>();
  for (const event of readTicketEventRecords(input.existing)) {
    const eventId =
      typeof event.eventId === "string" ? event.eventId.trim() : "";
    if (eventId) {
      existingIds.add(eventId);
    }
  }

  const lines: string[] = [];
  for (const event of input.events) {
    const parsed = parseTicketEventRecord(event);
    const eventId =
      parsed && typeof parsed.eventId === "string" ? parsed.eventId.trim() : "";
    if (!(parsed && eventId && !existingIds.has(eventId))) {
      continue;
    }
    lines.push(stableStringify(parsed));
  }
  return lines;
}

function normalizeTicketEventLogText(text: string): string {
  const parsed = dedupeTicketEventRecords(readTicketEventRecords(text));
  sortTicketEventRecords(parsed);
  return formatTicketEventRecords(parsed);
}

function mergeTicketEventLogs(input: {
  readonly existing: string;
  readonly incoming: string;
}): string {
  const parsed = dedupeTicketEventRecords([
    ...readTicketEventRecords(input.existing),
    ...readTicketEventRecords(input.incoming),
  ]);
  sortTicketEventRecords(parsed);
  return formatTicketEventRecords(parsed);
}

function isRetryableTrackingRefLockFailure(input: {
  readonly stderr: string;
  readonly trackingRef: string;
}): boolean {
  const message = input.stderr.toLowerCase();
  return (
    message.includes("cannot lock ref") &&
    message.includes(input.trackingRef.toLowerCase()) &&
    message.includes("expected")
  );
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
  return trimmed
    .replace(REFS_HEADS_PREFIX_PATTERN, "")
    .replace(REFS_PREFIX_PATTERN, "");
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

function isGitIndexLockError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("index.lock") && normalized.includes("file exists")
  );
}

export const __testOnly = {
  mergeTicketEventLogs,
  resolvePushRefForCheckoutRef,
};

function resolvePushRefForCheckoutRef(input: {
  readonly checkoutRef: string;
  readonly remoteRef: string;
  readonly legacyTrackingRef?: string | null;
  readonly legacyRemoteRef?: string | null;
}): string {
  if (
    input.legacyTrackingRef &&
    input.legacyRemoteRef &&
    input.checkoutRef === input.legacyTrackingRef
  ) {
    return input.legacyRemoteRef;
  }
  return input.remoteRef;
}
