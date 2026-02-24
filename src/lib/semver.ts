export type Semver = {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
};

const SEMVER_REGEX =
  /^v?(?<major>0|[1-9]\d*)\.(?<minor>0|[1-9]\d*)\.(?<patch>0|[1-9]\d*)/;
const SEMVER_META_SPLIT_REGEX = /[+-]/;

export function parseSemver(raw: string): Semver | null {
  const input = raw.trim();
  if (input.length === 0) {
    return null;
  }

  // Drop pre-release/build metadata if present (e.g. 1.2.3-beta.1+sha).
  const normalized = input.split(SEMVER_META_SPLIT_REGEX)[0] ?? "";
  const match = SEMVER_REGEX.exec(normalized);
  if (!match?.groups) {
    return null;
  }

  const major = Number(match.groups.major);
  const minor = Number(match.groups.minor);
  const patch = Number(match.groups.patch);

  if (
    !(
      Number.isFinite(major) &&
      Number.isFinite(minor) &&
      Number.isFinite(patch)
    )
  ) {
    return null;
  }

  return { major, minor, patch };
}

export function compareSemver(aRaw: string, bRaw: string): number | null {
  const a = parseSemver(aRaw);
  const b = parseSemver(bRaw);
  if (!(a && b)) {
    return null;
  }

  if (a.major !== b.major) {
    return a.major < b.major ? -1 : 1;
  }
  if (a.minor !== b.minor) {
    return a.minor < b.minor ? -1 : 1;
  }
  if (a.patch !== b.patch) {
    return a.patch < b.patch ? -1 : 1;
  }
  return 0;
}

export function isSemverNewer(opts: {
  readonly current: string;
  readonly next: string;
}): boolean | null {
  const cmp = compareSemver(opts.current, opts.next);
  if (cmp === null) {
    return null;
  }
  return cmp === -1;
}
