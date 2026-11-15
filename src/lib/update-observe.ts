/**
 * Read-only update check for any install kind (HACK-2218 R14).
 *
 * One bounded GitHub releases read; no download, prompt, install, PATH lookup,
 * registry write, daemon or engine contact. Missing evidence is reported as
 * `null` with a closed `reason`, never as "up to date".
 */
import { lstat } from "node:fs/promises";
import { isAbsolute, join, sep } from "node:path";
import { isRecord } from "./guards.ts";
import { buildVersionReport } from "./version-report.ts";

const RELEASES_API = "https://api.github.com/repos/hack-dance/hack/releases";
const FETCH_TIMEOUT_MS = 10_000;
/** GitHub's maximum page size; the check never reads a second page. */
const NEXT_LIST_PAGE_SIZE = 100;
const HOMEBREW_UPGRADE = ["brew", "upgrade", "hack-dance/tap/hack"] as const;

const LEADING_V = /^v/;
const VERSION_PATTERN =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-next\.(0|[1-9]\d*))?$/;

type VersionReport = Awaited<ReturnType<typeof buildVersionReport>>;

export type UpdateCheckInstallKind =
  | VersionReport["install_kind"]
  | "candidate";

/** Why `latest` or `available` is unknown; `null` when both are known. */
export type UpdateCheckReason =
  | "network-unavailable"
  | "release-unavailable"
  | "version-unrecognized";

export type UpdateCheckReport = {
  readonly current: string;
  readonly channel: VersionReport["channel"];
  readonly latest: string | null;
  readonly available: boolean | null;
  readonly install_kind: UpdateCheckInstallKind;
  /** argv to run in a terminal; `null` when there is no update or no known path. */
  readonly upgrade_command: readonly string[] | null;
  readonly reason: UpdateCheckReason | null;
};

type ParsedVersion = {
  readonly core: readonly [number, number, number];
  /** `null` for a release; the `-next.N` number for a candidate. */
  readonly next: number | null;
};

/** Stable `X.Y.Z` and candidate `X.Y.Z-next.N` only; anything else is unrecognized. */
export function parseUpdateVersion(raw: string): ParsedVersion | null {
  const match = VERSION_PATTERN.exec(raw.trim());
  if (!match) {
    return null;
  }
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    next: match[4] === undefined ? null : Number(match[4]),
  };
}

/** Semver order for these two forms: `X.Y.Z-next.N` sorts before `X.Y.Z`. */
export function compareUpdateVersions(
  a: ParsedVersion,
  b: ParsedVersion
): number {
  for (let index = 0; index < 3; index++) {
    const delta = (a.core[index] ?? 0) - (b.core[index] ?? 0);
    if (delta !== 0) {
      return Math.sign(delta);
    }
  }
  if (a.next === b.next) {
    return 0;
  }
  if (a.next === null) {
    return 1;
  }
  if (b.next === null) {
    return -1;
  }
  return Math.sign(a.next - b.next);
}

type ReadFailure = "network-unavailable" | "release-unavailable";

type LatestOutcome =
  | {
      readonly ok: true;
      readonly version: string;
      /**
       * Whether "nothing newer" can be reported. The list is ordered by
       * creation, not version. A page that is not full is the whole list; a
       * full page holding the running version's own release holds everything
       * created after it. Accepted false negative (documented): a newer release
       * created before the running one and pushed off a full page is missed.
       */
      readonly settled: boolean;
    }
  | { readonly ok: false; readonly reason: ReadFailure };

async function readJson(opts: {
  readonly fetch: typeof fetch;
  readonly url: string;
}): Promise<
  | { readonly ok: true; readonly json: unknown }
  | { readonly ok: false; readonly reason: ReadFailure }
> {
  let response: Response;
  try {
    response = await opts.fetch(opts.url, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "hack-cli",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: "network-unavailable" };
  }
  if (!response.ok) {
    return { ok: false, reason: "release-unavailable" };
  }
  const json: unknown = await response.json().catch(() => undefined);
  return json === undefined
    ? { ok: false, reason: "release-unavailable" }
    : { ok: true, json };
}

function releaseVersion(entry: unknown): string | null {
  if (!isRecord(entry) || entry.draft === true) {
    return null;
  }
  const tag = entry.tag_name;
  if (typeof tag !== "string" || parseUpdateVersion(tag) === null) {
    return null;
  }
  return tag.trim().replace(LEADING_V, "");
}

/**
 * Stable: GitHub's latest release, which excludes prereleases and drafts.
 * Next: the newest `-next.N` release with the running CLI's major version
 * on the first page of the release list.
 */
async function resolveLatest(opts: {
  readonly fetch: typeof fetch;
  readonly channel: "stable" | "next";
  readonly current: ParsedVersion;
}): Promise<LatestOutcome> {
  if (opts.channel === "stable") {
    const read = await readJson({
      fetch: opts.fetch,
      url: `${RELEASES_API}/latest`,
    });
    if (!read.ok) {
      return read;
    }
    const version = releaseVersion(read.json);
    return version !== null && parseUpdateVersion(version)?.next === null
      ? { ok: true, version, settled: true }
      : { ok: false, reason: "release-unavailable" };
  }
  const read = await readJson({
    fetch: opts.fetch,
    url: `${RELEASES_API}?per_page=${NEXT_LIST_PAGE_SIZE}`,
  });
  if (!read.ok) {
    return read;
  }
  if (!Array.isArray(read.json)) {
    return { ok: false, reason: "release-unavailable" };
  }
  let best: { version: string; parsed: ParsedVersion } | null = null;
  let includesCurrent = false;
  for (const entry of read.json) {
    const version = releaseVersion(entry);
    const parsed = version === null ? null : parseUpdateVersion(version);
    if (
      version === null ||
      parsed === null ||
      parsed.next === null ||
      parsed.core[0] !== opts.current.core[0]
    ) {
      continue;
    }
    includesCurrent ||= compareUpdateVersions(parsed, opts.current) === 0;
    if (best === null || compareUpdateVersions(parsed, best.parsed) > 0) {
      best = { version, parsed };
    }
  }
  return best === null
    ? { ok: false, reason: "release-unavailable" }
    : {
        ok: true,
        version: best.version,
        settled: read.json.length < NEXT_LIST_PAGE_SIZE || includesCurrent,
      };
}

/**
 * The `hack-next` launcher of the channel root running this CLI, or `null`.
 * The launcher exports the same marker for every root, so the root comes from
 * the native executor it pinned: `<root>/versions/<current>/bundle/hack-native`.
 * A Compose-backend launch carries no root and gets no command.
 */
async function candidateLauncher(opts: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly current: string;
}): Promise<string | null> {
  // Only `hack-next` has the standalone manager; other candidate launchers
  // (such as a bundle's `hack-v5`) forward every argument to the CLI.
  if ((opts.env.HACK_CANDIDATE_ENTRYPOINT ?? "").trim() !== "hack-next") {
    return null;
  }
  const executor = (opts.env.HACK_NATIVE_BINARY ?? "").trim();
  const suffix = join("versions", opts.current, "bundle", "hack-native");
  if (!(isAbsolute(executor) && executor.endsWith(`${sep}${suffix}`))) {
    return null;
  }
  const root = executor.slice(0, -suffix.length - 1);
  const launcher = join(root, "bin", "hack-next");
  const info = await lstat(launcher).catch(() => null);
  return info?.isFile() ? launcher : null;
}

/** A supported, self-contained upgrade path for this install, or `null`. */
async function upgradeCommand(opts: {
  readonly installKind: UpdateCheckInstallKind;
  readonly channel: VersionReport["channel"];
  readonly current: string;
  readonly latest: string;
  readonly binaryPath: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}): Promise<readonly string[] | null> {
  if (opts.installKind === "candidate") {
    const launcher = await candidateLauncher({
      env: opts.env,
      current: opts.current,
    });
    return launcher === null
      ? null
      : [launcher, "--manager", "upgrade", "--version", opts.latest];
  }
  if (opts.channel !== "stable") {
    // `hack update` and Homebrew install the latest stable release only.
    return null;
  }
  if (opts.installKind === "homebrew") {
    return [...HOMEBREW_UPGRADE];
  }
  if (opts.installKind === "standalone") {
    return [opts.binaryPath, "update"];
  }
  return null;
}

export async function observeUpdate(opts: {
  readonly version: string;
  readonly executable: string;
  readonly compiled: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
}): Promise<UpdateCheckReport> {
  const identity = await buildVersionReport({
    version: opts.version,
    executable: opts.executable,
    compiled: opts.compiled,
  });
  const installKind: UpdateCheckInstallKind =
    (opts.env.HACK_CANDIDATE_ENTRYPOINT ?? "").trim() === ""
      ? identity.install_kind
      : "candidate";
  const unknown = (reason: UpdateCheckReason): UpdateCheckReport => ({
    current: identity.version,
    channel: identity.channel,
    latest: null,
    available: null,
    install_kind: installKind,
    upgrade_command: null,
    reason,
  });
  // Only stable and `-next.N` versions have a release feed to compare with.
  const current = parseUpdateVersion(identity.version);
  if (current === null || identity.channel === "prerelease") {
    return unknown("version-unrecognized");
  }
  const latest = await resolveLatest({
    fetch: opts.fetch ?? fetch,
    channel: identity.channel,
    current,
  });
  if (!latest.ok) {
    return unknown(latest.reason);
  }
  const target = parseUpdateVersion(latest.version);
  const available =
    target === null ? null : compareUpdateVersions(current, target) < 0;
  if (available === false && !latest.settled) {
    // A newer release may sit beyond the one page read: unknown, not current.
    return unknown("release-unavailable");
  }
  return {
    current: identity.version,
    channel: identity.channel,
    latest: latest.version,
    available,
    install_kind: installKind,
    upgrade_command:
      available === true
        ? await upgradeCommand({
            installKind,
            channel: identity.channel,
            current: identity.version,
            latest: latest.version,
            binaryPath: identity.binary_path,
            env: opts.env,
          })
        : null,
    reason: available === null ? "version-unrecognized" : null,
  };
}
