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

  const checkoutBranchFromRef = async (input: {
    readonly checkoutRef: string;
  }): Promise<
    | { readonly ok: true; readonly pushRef: string }
    | { readonly ok: false; readonly error: string }
  > => {
    const rev = await runGitDir({
      args: ["rev-parse", "--verify", input.checkoutRef],
    });
    if (!rev.ok) {
      return { ok: false, error: "" };
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
      return {
        ok: false,
        error: `git reset failed: ${reset.stderr.trim()}`,
      };
    }

    return {
      ok: true,
      pushRef: resolvePushRefForCheckout({ checkoutRef: input.checkoutRef }),
    };
  };

  const resolveRemoteCheckoutPlan = async (input: {
    readonly remoteUrl: string | null;
  }): Promise<{
    readonly checkoutRef?: string;
    readonly fetchFailure: string | null;
    readonly allowFetchFailureFallback: boolean;
  }> => {
    if (!input.remoteUrl) {
      return { fetchFailure: null, allowFetchFailureFallback: true };
    }

    const fetched = await fetchRemoteRef(remoteRef);
    if (fetched.ok) {
      const fetchFailure =
        legacyRemoteRef && legacyTrackingRef
          ? await resolveLegacyFetchFailure({
              ref: legacyRemoteRef,
              trackingRef: legacyTrackingRef,
            })
          : null;
      return {
        checkoutRef: `origin/${branch}`,
        fetchFailure,
        allowFetchFailureFallback: false,
      };
    }

    if (fetched.missing) {
      return legacyRemoteRef
        ? await resolveLegacyRemoteCheckoutPlan()
        : { fetchFailure: null, allowFetchFailureFallback: true };
    }

    return {
      fetchFailure: `git fetch failed: ${fetched.error}`,
      allowFetchFailureFallback: true,
    };
  };

  const resolveLegacyFetchFailure = async (input: {
    readonly ref: string;
    readonly trackingRef: string;
  }): Promise<string | null> => {
    const legacyFetch = await fetchRemoteRefToTracking(
      input.ref,
      input.trackingRef
    );
    if (legacyFetch.ok || legacyFetch.missing) {
      return null;
    }
    return `git fetch failed: ${legacyFetch.error}`;
  };

  const resolveLegacyRemoteCheckoutPlan = async (): Promise<{
    readonly checkoutRef?: string;
    readonly fetchFailure: string | null;
    readonly allowFetchFailureFallback: boolean;
  }> => {
    if (!legacyRemoteRef) {
      return { fetchFailure: null, allowFetchFailureFallback: true };
    }

    const legacyFetch = legacyTrackingRef
      ? await fetchRemoteRefToTracking(legacyRemoteRef, legacyTrackingRef)
      : await fetchRemoteRef(legacyRemoteRef);
    if (legacyFetch.ok) {
      return {
        checkoutRef: legacyTrackingRef ?? `origin/${branch}`,
        fetchFailure: null,
        allowFetchFailureFallback: true,
      };
    }
    if (legacyFetch.missing) {
      return { fetchFailure: null, allowFetchFailureFallback: true };
    }
    return {
      fetchFailure: `git fetch failed: ${legacyFetch.error}`,
      allowFetchFailureFallback: false,
    };
  };

  const initializeOrphanTicketsBranch = async (): Promise<
    | { readonly ok: true; readonly pushRef: string }
    | { readonly ok: false; readonly error: string }
  > => {
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
  };

  const checkoutLocalBranch = async (input: {
    readonly pushRef: string;
  }): Promise<
    | { readonly ok: true; readonly pushRef: string }
    | { readonly ok: false; readonly error: string }
  > => {
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

    return { ok: true, pushRef: input.pushRef };
  };

  const checkoutHead = async (input: {
    readonly remoteUrl: string | null;
    readonly allowFetchFailureFallback: boolean;
  }): Promise<
    | { readonly ok: true; readonly pushRef: string }
    | { readonly ok: false; readonly error: string }
  > => {
    await rm(worktreeDir, { recursive: true, force: true });
    await mkdir(worktreeDir, { recursive: true });

    const remotePlan = await resolveRemoteCheckoutPlan(input);
    if (remotePlan.checkoutRef) {
      const remoteCheckout = await checkoutBranchFromRef({
        checkoutRef: remotePlan.checkoutRef,
      });
      if (remoteCheckout.ok) {
        return remoteCheckout;
      }
      if (remoteCheckout.error) {
        return remoteCheckout;
      }
    }

    const localRef = await runGitDir({
      args: ["rev-parse", "--verify", branch],
    });
    if (!localRef.ok) {
      if (remotePlan.fetchFailure) {
        return { ok: false, error: remotePlan.fetchFailure };
      }
      return await initializeOrphanTicketsBranch();
    }

    const preferredTrackingRef = await resolvePreferredTrackingRef();
    const localFallback = resolveLocalCheckoutFallback({
      fetchFailure: remotePlan.fetchFailure,
      allowFetchFailureFallback:
        input.allowFetchFailureFallback && remotePlan.allowFetchFailureFallback,
      preferredTrackingRef,
      remoteRef,
      legacyTrackingRef,
      legacyRemoteRef,
    });
    if (!localFallback.ok) {
      return localFallback;
    }

    return await checkoutLocalBranch({ pushRef: localFallback.pushRef });
  };

  const mergeLegacyRefIntoCurrentBranch = async (input: {
    readonly remoteUrl: string | null;
  }): Promise<
    | { readonly ok: true; readonly imported: boolean }
    | { readonly ok: false; readonly error: string }
  > => {
    if (!(input.remoteUrl && legacyRemoteRef && legacyTrackingRef)) {
      return { ok: true, imported: false };
    }

    const fetched = await fetchRemoteRefToTracking(
      legacyRemoteRef,
      legacyTrackingRef
    );
    if (!fetched.ok) {
      return resolveLegacyImportFetchResult({
        missing: fetched.missing,
        error: fetched.error,
      });
    }

    const legacyPaths = await listLegacyEventPaths({
      runGitDir,
      legacyTrackingRef,
    });
    if (!legacyPaths.ok) {
      return legacyPaths;
    }

    const imported = await importLegacyEventPaths({
      legacyPaths: legacyPaths.paths,
      legacyTrackingRef,
      runGitDir,
      worktreeDir,
    });
    if (!imported.ok) {
      return imported;
    }

    if (!imported.imported) {
      return { ok: true, imported: false };
    }

    const normalized = await normalizeLogs();
    if (!normalized.ok) {
      return normalized;
    }

    return { ok: true, imported: true };
  };

  const ensureCheckedOut = async (input: {
    readonly allowFetchFailureFallback: boolean;
  }): Promise<
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

    const checkedOut = await checkoutHead({
      remoteUrl,
      allowFetchFailureFallback: input.allowFetchFailureFallback,
    });
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

  const writeEvents = async (input: {
    readonly events: readonly Record<string, unknown>[];
  }): Promise<
    { readonly ok: true } | { readonly ok: false; readonly error: string }
  > => {
    await mkdir(resolve(worktreeDir, ".hack/tickets/events"), {
      recursive: true,
    });

    const grouped = groupEventsByPath({
      events: input.events,
      resolveEventsPath,
    });

    for (const [path, events] of grouped) {
      const existing = await Bun.file(path)
        .text()
        .catch(() => "");
      const existingIds = collectEventIds(existing);
      const lines = serializeNewEvents({
        events,
        existingIds,
      });

      if (lines.length > 0) {
        await Bun.write(path, appendJsonLines({ existing, lines }));
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
    const files = await listJsonlFiles(eventsDir);
    if (!files) {
      return { ok: true };
    }

    for (const file of files) {
      const path = resolve(eventsDir, file);
      const text = await Bun.file(path)
        .text()
        .catch(() => "");
      const normalized = normalizeEventLogText(text);
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
    readonly pushRef: string;
    readonly pendingEvents?: readonly Record<string, unknown>[];
  }): Promise<
    | { readonly ok: true; readonly didPush: boolean }
    | { readonly ok: false; readonly error: string }
  > => {
    if (!input.remoteUrl) {
      return { ok: true, didPush: false };
    }

    const push = await pushTicketsRef({
      runGitDir,
      localBranchRef,
      pushRef: input.pushRef,
    });
    if (push.ok) {
      return { ok: true, didPush: true };
    }

    const pushError = buildPushFailureMessage({
      message: `${push.stderr}\n${push.stdout}`.trim(),
      refMode,
    });
    if (pushError.rejectedHiddenRef) {
      return {
        ok: false,
        error: pushError.message,
      };
    }

    opts.logger.warn({
      message: `git push failed, retrying after fetch: ${pushError.message}`,
    });

    const checkedOut = await checkoutHead({
      remoteUrl: input.remoteUrl,
      allowFetchFailureFallback: false,
    });
    if (!checkedOut.ok) {
      return checkedOut;
    }

    const wrote = await writePendingEventsIfAny({
      pendingEvents: input.pendingEvents,
      writeEvents,
    });
    if (!wrote.ok) {
      return wrote;
    }

    const committed = await commitAll("tickets: retry");
    if (!committed.ok) {
      return committed;
    }

    const retry = await pushTicketsRef({
      runGitDir,
      localBranchRef,
      pushRef: checkedOut.pushRef,
    });
    if (!retry.ok) {
      const retryError = buildPushFailureMessage({
        message: `${retry.stderr}\n${retry.stdout}`.trim(),
        refMode,
      });
      if (retryError.rejectedHiddenRef) {
        return {
          ok: false,
          error: retryError.message,
        };
      }
      return { ok: false, error: retryError.message };
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
    const checkedOut = await ensureCheckedOut({
      allowFetchFailureFallback: true,
    });
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

  const repair = async (input: {
    readonly pruneLegacyRef: boolean;
  }): Promise<TicketsGitRepairResult> => {
    const checkedOut = await ensureCheckedOut({
      allowFetchFailureFallback: false,
    });
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

    const pushed = await pushWithRetry({
      remoteUrl: checkedOut.remoteUrl,
      pushRef: checkedOut.pushRef,
    });
    if (!pushed.ok) {
      return pushed;
    }

    const pruneResult = await pruneLegacyRemoteRef({
      pruneLegacyRef: input.pruneLegacyRef,
      legacyRemoteRef,
      legacyTrackingRef,
      remoteUrl: checkedOut.remoteUrl,
      runGitDir,
    });

    return {
      ok: true,
      didCommit: committed.didCommit,
      didPush: pushed.didPush,
      didPruneLegacy: pruneResult.didPruneLegacy,
      ...(pruneResult.pruneError ? { pruneError: pruneResult.pruneError } : {}),
    };
  };

  const appendEvents = async (input: {
    readonly events: readonly Record<string, unknown>[];
  }): Promise<
    { readonly ok: true } | { readonly ok: false; readonly error: string }
  > => {
    const checkedOut = await ensureCheckedOut({
      allowFetchFailureFallback: false,
    });
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
    const checkedOut = await ensureCheckedOut({
      allowFetchFailureFallback: false,
    });
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
      const checkedOut = await ensureCheckedOut({
        allowFetchFailureFallback: true,
      });
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

function mergeTicketEventLogs(input: {
  readonly existing: string;
  readonly incoming: string;
}): string {
  return appendJsonLines({
    existing: "",
    lines: collectNormalizedEventLines([input.existing, input.incoming]),
  });
}

async function listLegacyEventPaths(input: {
  readonly runGitDir: (input: { readonly args: readonly string[] }) => Promise<{
    readonly ok: boolean;
    readonly stdout: string;
    readonly stderr: string;
  }>;
  readonly legacyTrackingRef: string;
}): Promise<
  | { readonly ok: true; readonly paths: string[] }
  | { readonly ok: false; readonly error: string }
> {
  const listed = await input.runGitDir({
    args: [
      "ls-tree",
      "-r",
      "--name-only",
      input.legacyTrackingRef,
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

async function importLegacyEventPaths(input: {
  readonly legacyPaths: readonly string[];
  readonly legacyTrackingRef: string;
  readonly runGitDir: (input: { readonly args: readonly string[] }) => Promise<{
    readonly ok: boolean;
    readonly stdout: string;
    readonly stderr: string;
  }>;
  readonly worktreeDir: string;
}): Promise<
  | { readonly ok: true; readonly imported: boolean }
  | { readonly ok: false; readonly error: string }
> {
  let imported = false;

  for (const relativePath of input.legacyPaths) {
    const shown = await input.runGitDir({
      args: ["show", `${input.legacyTrackingRef}:${relativePath}`],
    });
    if (!shown.ok) {
      return {
        ok: false,
        error: `git show failed: ${shown.stderr.trim() || shown.stdout.trim()}`,
      };
    }

    const targetPath = resolve(input.worktreeDir, relativePath);
    const existing = await Bun.file(targetPath)
      .text()
      .catch(() => "");
    const merged = mergeTicketEventLogs({
      existing,
      incoming: shown.stdout,
    });
    if (merged === existing) {
      continue;
    }

    await mkdir(dirname(targetPath), { recursive: true });
    await Bun.write(targetPath, merged);
    imported = true;
  }

  return { ok: true, imported };
}

async function pushTicketsRef(input: {
  readonly runGitDir: (input: { readonly args: readonly string[] }) => Promise<{
    readonly ok: boolean;
    readonly stdout: string;
    readonly stderr: string;
  }>;
  readonly localBranchRef: string;
  readonly pushRef: string;
}): Promise<{
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}> {
  return await input.runGitDir({
    args: ["push", "origin", `${input.localBranchRef}:${input.pushRef}`],
  });
}

async function writePendingEventsIfAny(input: {
  readonly pendingEvents?: readonly Record<string, unknown>[];
  readonly writeEvents: (input: {
    readonly events: readonly Record<string, unknown>[];
  }) => Promise<
    { readonly ok: true } | { readonly ok: false; readonly error: string }
  >;
}): Promise<
  { readonly ok: true } | { readonly ok: false; readonly error: string }
> {
  if (!(input.pendingEvents && input.pendingEvents.length > 0)) {
    return { ok: true };
  }
  return await input.writeEvents({ events: input.pendingEvents });
}

function buildPushFailureMessage(input: {
  readonly message: string;
  readonly refMode: TicketsGitRefMode;
}): {
  readonly message: string;
  readonly rejectedHiddenRef: boolean;
} {
  if (input.refMode === "hidden" && isHiddenRefRejected(input.message)) {
    return {
      message: `git push failed: ${input.message}\nRemote rejected hidden refs. Set controlPlane.tickets.git.refMode to "heads" to use a branch ref.`,
      rejectedHiddenRef: true,
    };
  }

  return {
    message: `git push failed: ${input.message}`,
    rejectedHiddenRef: false,
  };
}

async function pruneLegacyRemoteRef(input: {
  readonly pruneLegacyRef: boolean;
  readonly legacyRemoteRef: string | null;
  readonly legacyTrackingRef: string | null;
  readonly remoteUrl: string | null;
  readonly runGitDir: (input: { readonly args: readonly string[] }) => Promise<{
    readonly ok: boolean;
    readonly stdout: string;
    readonly stderr: string;
  }>;
}): Promise<{
  readonly didPruneLegacy: boolean;
  readonly pruneError?: string;
}> {
  if (!(input.pruneLegacyRef && input.legacyRemoteRef && input.remoteUrl)) {
    return { didPruneLegacy: false };
  }

  const prunedLegacy = await input.runGitDir({
    args: ["push", "origin", `:${input.legacyRemoteRef}`],
  });
  if (!prunedLegacy.ok) {
    return {
      didPruneLegacy: false,
      pruneError: `${prunedLegacy.stderr}\n${prunedLegacy.stdout}`.trim(),
    };
  }

  if (input.legacyTrackingRef) {
    await input.runGitDir({
      args: ["update-ref", "-d", input.legacyTrackingRef],
    });
  }

  return { didPruneLegacy: true };
}

async function listJsonlFiles(eventsDir: string): Promise<string[] | null> {
  try {
    return (await readdir(eventsDir))
      .filter((f) => f.endsWith(".jsonl"))
      .sort();
  } catch {
    return null;
  }
}

function groupEventsByPath(input: {
  readonly events: readonly Record<string, unknown>[];
  readonly resolveEventsPath: (tsSeconds: number) => string;
}): Map<string, Record<string, unknown>[]> {
  const grouped = new Map<string, Record<string, unknown>[]>();
  for (const event of input.events) {
    const ts =
      typeof event.ts === "number"
        ? (event.ts as number)
        : Math.floor(Date.now() / 1000);
    const path = input.resolveEventsPath(ts);
    const list = grouped.get(path) ?? [];
    list.push(event);
    grouped.set(path, list);
  }
  return grouped;
}

function collectEventIds(text: string): Set<string> {
  const ids = new Set<string>();
  for (const line of text.split("\n")) {
    const value = parseTicketEventLine(line);
    if (value && typeof value.eventId === "string") {
      ids.add(value.eventId);
    }
  }
  return ids;
}

function serializeNewEvents(input: {
  readonly events: readonly Record<string, unknown>[];
  readonly existingIds: ReadonlySet<string>;
}): string[] {
  const lines: string[] = [];
  for (const event of input.events) {
    const id = typeof event.eventId === "string" ? event.eventId : "";
    if (!id || input.existingIds.has(id)) {
      continue;
    }
    lines.push(stableStringify(event));
  }
  return lines;
}

function appendJsonLines(input: {
  readonly existing: string;
  readonly lines: readonly string[];
}): string {
  if (input.lines.length === 0) {
    return input.existing;
  }
  const prefix =
    input.existing.length > 0 && !input.existing.endsWith("\n") ? "\n" : "";
  return `${input.existing}${prefix}${input.lines.join("\n")}\n`;
}

function normalizeEventLogText(text: string): string {
  const lines = collectNormalizedEventLines([text]);
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

function collectNormalizedEventLines(texts: readonly string[]): string[] {
  const events = collectUniqueTicketEvents(texts);
  return events.map((event) => stableStringify(event));
}

function collectUniqueTicketEvents(
  texts: readonly string[]
): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const text of texts) {
    appendUniqueTicketEvents({
      text,
      seen,
      events,
    });
  }
  events.sort(compareTicketEvents);
  return events;
}

function appendUniqueTicketEvents(input: {
  readonly text: string;
  readonly seen: Set<string>;
  readonly events: Record<string, unknown>[];
}): void {
  for (const line of input.text.split("\n")) {
    const event = parseTicketEventLine(line);
    if (!event) {
      continue;
    }
    const eventId = event.eventId as string;
    if (input.seen.has(eventId)) {
      continue;
    }
    input.seen.add(eventId);
    input.events.push(event);
  }
}

function parseTicketEventLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  const value = safeJsonParse(trimmed);
  if (!isRecord(value)) {
    return null;
  }
  const eventId = typeof value.eventId === "string" ? value.eventId : "";
  const ts = typeof value.ts === "number" ? value.ts : Number.NaN;
  if (!(eventId && Number.isFinite(ts))) {
    return null;
  }
  return value;
}

function compareTicketEvents(
  a: Record<string, unknown>,
  b: Record<string, unknown>
): number {
  const aTs = typeof a.ts === "number" ? (a.ts as number) : 0;
  const bTs = typeof b.ts === "number" ? (b.ts as number) : 0;
  if (aTs !== bTs) {
    return aTs - bTs;
  }
  const aId = typeof a.eventId === "string" ? (a.eventId as string) : "";
  const bId = typeof b.eventId === "string" ? (b.eventId as string) : "";
  return aId.localeCompare(bId);
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
  resolveLegacyImportFetchResult,
  resolveLocalCheckoutFallback,
  resolvePushRefForCheckoutRef,
};

function resolveLegacyImportFetchResult(input: {
  readonly missing: boolean;
  readonly error: string;
}):
  | { readonly ok: true; readonly imported: false }
  | { readonly ok: false; readonly error: string } {
  if (input.missing) {
    return { ok: true, imported: false };
  }
  return {
    ok: false,
    error: `git fetch failed: ${input.error}`,
  };
}

function resolveLocalCheckoutFallback(input: {
  readonly fetchFailure: string | null;
  readonly allowFetchFailureFallback: boolean;
  readonly preferredTrackingRef: string | null;
  readonly remoteRef: string;
  readonly legacyTrackingRef?: string | null;
  readonly legacyRemoteRef?: string | null;
}):
  | { readonly ok: true; readonly pushRef: string }
  | { readonly ok: false; readonly error: string } {
  if (input.fetchFailure && !input.allowFetchFailureFallback) {
    return { ok: false, error: input.fetchFailure };
  }

  if (!input.preferredTrackingRef) {
    return { ok: true, pushRef: input.remoteRef };
  }

  return {
    ok: true,
    pushRef: resolvePushRefForCheckoutRef({
      checkoutRef: input.preferredTrackingRef,
      remoteRef: input.remoteRef,
      legacyTrackingRef: input.legacyTrackingRef,
      legacyRemoteRef: input.legacyRemoteRef,
    }),
  };
}

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
