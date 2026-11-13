#!/usr/bin/env bun
/**
 * Provider pin watch (HACK-2078). Reads `packages/runtime-core/provider-pins.json` and, for
 * each pinned component, lists the upstream releases newer than its pin and the published
 * security advisories whose vulnerable range contains the pinned version. It keeps one
 * issue, labelled `provider-pin-watch` and opened by this workflow's bot, titled "Provider
 * pins behind upstream", with the delta table; that issue carries the `security` label
 * exactly while an advisory affects a pinned version. It never changes a pin: a bump is
 * qualified by hand (see "How a provider pin bump is qualified" in
 * packages/runtime-core/README.md).
 *
 * Release notes are classified by keyword as a reading list only; for SmolVM that includes
 * the provider interfaces the native runtime passes or reads. The `security` label comes
 * from advisories, never from keywords.
 *
 * `--dry-run` prints the issue body and the planned writes and writes nothing. Needs
 * GITHUB_TOKEN (reads; `issues: write` to file the issue) and GITHUB_REPOSITORY.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const ISSUE_TITLE = "Provider pins behind upstream";
export const WATCH_LABEL = "provider-pin-watch";
export const SECURITY_LABEL = "security";
/** The workflow's `GITHUB_TOKEN` acts as this user; only its issue is ever adopted. */
export const BOT_LOGIN = "github-actions[bot]";
/**
 * Advisories reviewed and judged not to affect how this runtime uses the component, each with
 * its reason. They are listed in the issue as ignored and never set the label or keep the
 * issue open. Add an entry only after reading the advisory; remove it when the pin moves.
 */
export const IGNORED_ADVISORIES: Readonly<Record<string, string>> = {};

/** Paging bound for releases; reaching it is reported in the issue. */
const MAX_RELEASE_PAGES = 10;

export interface Category {
  name: string;
  pattern: RegExp;
}

const SECURITY_NOTES: Category = {
  name: "security notes",
  pattern:
    /\b(security|vulnerab\w*|advisor(y|ies)|CVE-\d{4}-\d+|RUSTSEC-\d{4}-\d+|GHSA-[0-9a-z-]+)\b/i,
};

/**
 * Provider interfaces the native runtime passes or reads. A SmolVM release note naming one
 * needs a look before the next bump. Tests keep this list and the runtime source in step
 * in both directions.
 */
export const SMOLVM_INTERFACES: readonly string[] = [
  "machine create",
  "machine start",
  "machine stop",
  "machine update",
  "machine delete",
  "machine exec",
  "--name",
  "--label",
  "--cpus",
  "--mem",
  "--storage",
  "--overlay",
  "--volume",
  "--docker-socket",
  "--mount-socket",
  "--expose-socket",
  "--rosetta",
  "--net",
  "--net-backend",
  "--allow-cidr",
  "--allow-host",
  "--force",
  "SMOLVM_AGENT_ROOTFS",
  "SMOLVM_DISK_TRIM",
  "SMOLVM_EGRESS_FLOOR",
  "SMOLVM_BALLOON_RECLAIM",
  "SMOLVM_IDLE_RECLAIM",
  "agent.config.json",
  "smolvm.db",
];

const SMOLVM_CATEGORIES: readonly Category[] = [
  SECURITY_NOTES,
  { name: "libkrun/libkrunfw", pattern: /\blibkrun(fw)?\b/i },
  { name: "vsock", pattern: /\bvsock\b/i },
  { name: "virtiofs", pattern: /\bvirtio-?fs\b/i },
  {
    name: "balloon/reclaim",
    pattern: /\b(balloon|reclaim\w*|free[- ]page)\b/i,
  },
  {
    name: "disk/template/trim",
    pattern: /\b(disks?|templates?|trim|fstrim|discard)\b/i,
  },
  {
    name: "agent protocol",
    pattern: /\b(agent protocol|protocol version|agent rootfs)\b/i,
  },
];

/** A pinned component, where its releases and advisories are published, and what to watch. */
export interface Component {
  key: string;
  label: string;
  repository: string;
  /** Release tag for a version, e.g. `v1.34.1` or `docker-v29.5.2`. */
  tagPrefix: string;
  categories: readonly Category[];
  interfaces: readonly string[];
}

export const COMPONENTS: readonly Component[] = [
  {
    key: "smolvm",
    label: "SmolVM",
    repository: "smol-machines/smolvm",
    tagPrefix: "v",
    categories: SMOLVM_CATEGORIES,
    interfaces: SMOLVM_INTERFACES,
  },
  {
    key: "docker",
    label: "Docker engine",
    repository: "moby/moby",
    tagPrefix: "docker-v",
    categories: [SECURITY_NOTES],
    interfaces: [],
  },
  {
    key: "buildx",
    label: "BuildKit client (buildx)",
    repository: "docker/buildx",
    tagPrefix: "v",
    categories: [SECURITY_NOTES],
    interfaces: [],
  },
];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Categories and watched interfaces a release note of `component` mentions. */
export function classify(component: Component, notes: string): string[] {
  const found = component.categories
    .filter((category) => category.pattern.test(notes))
    .map((category) => category.name);
  for (const name of component.interfaces) {
    if (new RegExp(`(^|[^\\w-])${escapeRegExp(name)}(?![\\w-])`).test(notes)) {
      found.push(`\`${name}\``);
    }
  }
  return found;
}

export type Version = [number, number, number];

/** `[major, minor, patch]` of a stable release tag with this prefix, else null. */
export function parseTag(tag: string, prefix: string): Version | null {
  const match = new RegExp(
    `^${escapeRegExp(prefix)}(\\d+)\\.(\\d+)\\.(\\d+)$`
  ).exec(tag);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compare(a: readonly number[], b: readonly number[]): number {
  for (let index = 0; index < 3; index++) {
    const difference = (a[index] as number) - (b[index] as number);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

/**
 * A version as advisories write it: an optional `v`, one to three numeric parts (missing parts
 * are zero), and any pre-release or build suffix ignored. `null` otherwise.
 */
function rangeVersion(text: string): Version | null {
  const match =
    /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+][0-9A-Za-z.+-]*)?$/.exec(
      text.trim()
    );
  return match
    ? [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)]
    : null;
}

/** One range item: `A - B`, `28.2.x`, a comparator (`< 1.2.3`), or a bare version. */
function rangeItem(version: Version, item: string): boolean | null {
  const span = /^(\S+)\s+-\s+(\S+)$/.exec(item);
  if (span) {
    const low = rangeVersion(span[1] as string);
    const high = rangeVersion(span[2] as string);
    return low && high
      ? compare(version, low) >= 0 && compare(version, high) <= 0
      : null;
  }
  const wildcard = /^v?(\d+)(?:\.(\d+))?\.[xX*]$/.exec(item);
  if (wildcard) {
    return (
      version[0] === Number(wildcard[1]) &&
      (wildcard[2] === undefined || version[1] === Number(wildcard[2]))
    );
  }
  const match = /^(<=|>=|<|>|=)?\s*(.+)$/.exec(item);
  const bound = match ? rangeVersion(match[2] as string) : null;
  if (!(match && bound)) {
    return null;
  }
  const order = compare(version, bound);
  return {
    "<": order < 0,
    "<=": order <= 0,
    ">": order > 0,
    ">=": order >= 0,
    "=": order === 0,
  }[(match[1] ?? "=") as "<" | "<=" | ">" | ">=" | "="];
}

/**
 * Whether `version` is inside a GitHub advisory `vulnerable_version_range`. Comma-separated
 * comparators must all hold (`>= 1.0.0, < 1.2.3`); a list that also holds spans, wildcards or
 * bare versions (`28.2.x, 28.3.0` or `<= 25.0.18, 26.0.0 - 29.8.1`) is a list of
 * alternatives. `null` when the range cannot be read.
 */
export function inRange(version: Version, range: string): boolean | null {
  const items = range.split(",").map((item) => item.trim());
  if (items.length === 0 || items.some((item) => item === "")) {
    return null;
  }
  const results = items.map((item) => rangeItem(version, item));
  if (results.some((result) => result === null)) {
    return null;
  }
  const comparators = items.every((item) => /^(<=|>=|<|>)/.test(item));
  if (!comparators) {
    return results.some((result) => result === true);
  }
  // A comparator list no version satisfies (`<= v25.0.18, > v26.0.0`) was meant as
  // alternatives or is malformed: it cannot be read either way.
  return satisfiable(items) ? results.every((result) => result === true) : null;
}

interface Bound {
  bound: Version;
  strict: boolean;
}

/** The tighter of two bounds: the larger lower bound, or the smaller upper bound. */
function tighter(current: Bound | null, next: Bound, lower: boolean): Bound {
  if (current === null) {
    return next;
  }
  const order = compare(next.bound, current.bound) * (lower ? 1 : -1);
  return order > 0 || (order === 0 && next.strict) ? next : current;
}

/** Whether some version satisfies every comparator of an all-comparator list. */
function satisfiable(items: string[]): boolean {
  let low: Bound | null = null;
  let high: Bound | null = null;
  for (const item of items) {
    const match = /^(<=|>=|<|>)\s*(.+)$/.exec(item);
    const bound = match ? rangeVersion(match[2] as string) : null;
    if (!(match && bound)) {
      return false;
    }
    const operator = match[1] as string;
    const next = { bound, strict: !operator.endsWith("=") };
    if (operator.startsWith(">")) {
      low = tighter(low, next, true);
    } else {
      high = tighter(high, next, false);
    }
  }
  if (!(low && high)) {
    return true;
  }
  const order = compare(low.bound, high.bound);
  return order < 0 || (order === 0 && !low.strict && !high.strict);
}

/** The lower bounds a range names: `>`/`>=` comparators, span starts and wildcard lines. */
function lowerBounds(range: string): Version[] {
  const bounds: Version[] = [];
  for (const item of range.split(",").map((part) => part.trim())) {
    const span = /^(\S+)\s+-\s+\S+$/.exec(item);
    const lower = /^>=?\s*(.+)$/.exec(item);
    const wildcard = /^v?(\d+)(?:\.(\d+))?\.[xX*]$/.exec(item);
    const bound = span
      ? rangeVersion(span[1] as string)
      : lower
        ? rangeVersion(lower[1] as string)
        : wildcard
          ? ([Number(wildcard[1]), Number(wildcard[2] ?? 0), 0] as Version)
          : null;
    if (bound) {
      bounds.push(bound);
    }
  }
  return bounds;
}

/**
 * Whether `version` has the fix an advisory lists for its release line (`29.9.3`,
 * `>= 28.5.1, >= 29.1.1`, `v0.38.1+`). A fix on the pin's own minor line decides; otherwise
 * fixes on its major line must all be reached. With no fix on the pin's line, it must be at
 * or above every listed fix, and at least one of them at or above every lower bound of the
 * vulnerable `range`: a fix on an older backport line (`v25.0.19` for `> v26.0.0`) never
 * clears a newer pin. Unreadable fixed versions are not a fix.
 */
export function patched(
  version: Version,
  patchedVersions: string | null,
  range = ""
): boolean {
  if (!patchedVersions) {
    return false;
  }
  const parsed = patchedVersions.split(",").map((item) =>
    rangeVersion(
      item
        .trim()
        .replace(/^>=\s*/, "")
        .replace(/\+$/, "")
    )
  );
  if (parsed.length === 0 || parsed.some((bound) => bound === null)) {
    return false;
  }
  const bounds = parsed as Version[];
  const reached = (fixes: Version[]) =>
    fixes.every((bound) => compare(version, bound) >= 0);
  const minorLine = bounds.filter(
    (bound) => bound[0] === version[0] && bound[1] === version[1]
  );
  if (minorLine.length > 0) {
    return reached(minorLine);
  }
  const majorLine = bounds.filter((bound) => bound[0] === version[0]);
  if (majorLine.length > 0) {
    return reached(majorLine);
  }
  const lowers = lowerBounds(range);
  return (
    reached(bounds) &&
    bounds.some((bound) => lowers.every((lower) => compare(bound, lower) >= 0))
  );
}

export interface Release {
  tag_name: string;
  published_at: string | null;
  html_url: string;
  prerelease: boolean;
  draft: boolean;
  body: string | null;
}

export interface Advisory {
  ghsa_id: string;
  html_url: string;
  severity: string;
  summary: string;
  vulnerabilities: {
    vulnerable_version_range: string | null;
    patched_versions: string | null;
  }[];
}

export interface AffectingAdvisory {
  id: string;
  url: string;
  severity: string;
  summary: string;
  patched: string;
  /** `false` when the range could not be read and the pin may be affected. */
  certain: boolean;
}

/**
 * Published advisories whose vulnerable range contains `pinned` for any listed package and
 * whose fixed versions it has not reached. Advisories whose range cannot be read are listed
 * as uncertain; only certain ones set the `security` label.
 */
export function affecting(
  pinned: Version,
  advisories: Advisory[]
): AffectingAdvisory[] {
  const found: AffectingAdvisory[] = [];
  for (const advisory of advisories) {
    const results = advisory.vulnerabilities.map((entry) => ({
      result:
        entry.vulnerable_version_range === null
          ? null
          : inRange(pinned, entry.vulnerable_version_range),
      fixed: patched(
        pinned,
        entry.patched_versions,
        entry.vulnerable_version_range ?? ""
      ),
      patched: entry.patched_versions ?? "",
    }));
    const hit = results.find((entry) => entry.result === true && !entry.fixed);
    const unknown = results.find(
      (entry) => entry.result === null && !entry.fixed
    );
    const match = hit ?? unknown;
    if (match && !(advisory.ghsa_id in IGNORED_ADVISORIES)) {
      found.push({
        id: advisory.ghsa_id,
        url: advisory.html_url,
        severity: advisory.severity,
        summary: advisory.summary,
        patched: match.patched,
        certain: hit !== undefined,
      });
    }
  }
  return found;
}

export interface Delta {
  component: Component;
  pinned: string;
  releases: { tag: string; date: string; url: string; categories: string[] }[];
  advisories: AffectingAdvisory[];
  /** The release listing stopped at its paging bound before reaching the pin. */
  truncated: boolean;
}

/** Stable releases newer than the pinned version, oldest first, classified; and advisories. */
export function delta(
  component: Component,
  pinned: string,
  releases: Release[],
  advisories: Advisory[] = [],
  truncated = false
): Delta {
  const base = parseTag(`${component.tagPrefix}${pinned}`, component.tagPrefix);
  if (!base) {
    throw new Error(
      `${component.key}: pinned version ${pinned} is not major.minor.patch`
    );
  }
  const newer = releases
    .filter((release) => !(release.prerelease || release.draft))
    .map((release) => ({
      release,
      version: parseTag(release.tag_name, component.tagPrefix),
    }))
    .filter(
      (entry): entry is { release: Release; version: Version } =>
        entry.version !== null && compare(entry.version, base) > 0
    )
    .sort((a, b) => compare(a.version, b.version));
  return {
    component,
    pinned,
    releases: newer.map(({ release }) => ({
      tag: release.tag_name,
      date: (release.published_at ?? "").slice(0, 10),
      url: release.html_url,
      categories: classify(component, release.body ?? ""),
    })),
    advisories: affecting(base, advisories),
    truncated,
  };
}

/**
 * Upstream text in our public issue: one table cell, no mentions or issue references (`@` and
 * `#` get a zero-width joiner), no HTML, images, inline links or code spans.
 */
export const cell = (value: string) =>
  value
    .replace(/[|\n\r`<>]/g, " ")
    .replace(/!\[/g, "[")
    .replace(/\]\(/g, "] (")
    .replace(/[@#]/g, "$&\u200d");

/** A link only to GitHub, by an ID of the expected form; otherwise the bare, cleaned text. */
export function link(label: string, url: string, pattern: RegExp): string {
  const text = cell(label);
  return pattern.test(label) && /^https:\/\/github\.com\/[\w./%-]+$/.test(url)
    ? `[${text}](${url})`
    : text;
}

const GHSA = /^GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}$/;
const TAG = /^[\w.-]+$/;

function advisoryRows(entry: Delta): string[] {
  if (entry.advisories.length === 0) {
    return [];
  }
  return [
    "",
    "| Advisory | Severity | Fixed in | Summary |",
    "| --- | --- | --- | --- |",
    ...entry.advisories.map((advisory) => {
      const severity = advisory.certain
        ? advisory.severity
        : `${advisory.severity} (range not understood; read it)`;
      return `| ${link(advisory.id, advisory.url, GHSA)} | ${cell(severity)} | ${cell(advisory.patched) || "?"} | ${cell(advisory.summary).slice(0, 120)} |`;
    }),
  ];
}

function releaseRows(entry: Delta): string[] {
  if (entry.releases.length === 0) {
    return [];
  }
  return [
    "",
    "| Release | Date | Notes mention |",
    "| --- | --- | --- |",
    ...entry.releases.map((release) => {
      const mentions =
        release.categories.length > 0
          ? release.categories.join(", ")
          : "nothing watched";
      return `| ${link(release.tag, release.url, TAG)} | ${cell(release.date)} | ${mentions} |`;
    }),
  ];
}

function componentSection(entry: Delta): string[] {
  const truncated = entry.truncated
    ? [
        "",
        `The release listing stopped at ${MAX_RELEASE_PAGES} pages; releases on later pages were not read and may be missing.`,
      ]
    : [];
  return [
    "",
    `### ${entry.component.label} (${entry.component.repository})`,
    ...advisoryRows(entry),
    ...truncated,
    ...releaseRows(entry),
  ];
}

/** The issue body: a summary per component, affecting advisories, and newer releases. */
export function renderBody(
  deltas: Delta[],
  checkedAt: string,
  availability: readonly PinAvailability[] = []
): string {
  const lines = [
    `Checked ${checkedAt} against \`packages/runtime-core/provider-pins.json\`. This issue is`,
    "updated by the weekly provider pin watch and never changes a pin. To bump, follow",
    '"How a provider pin bump is qualified" in `packages/runtime-core/README.md`.',
    "",
    "| Component | Pinned | Latest stable | Releases behind | Advisories affecting the pin |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const entry of deltas) {
    const latest =
      entry.releases.at(-1)?.tag ??
      `${entry.component.tagPrefix}${entry.pinned}`;
    const behind = `${entry.releases.length}${entry.truncated ? "+" : ""}`;
    const certain = entry.advisories.filter((advisory) => advisory.certain);
    const unread = entry.advisories.length - certain.length;
    const advised = `${certain.length}${unread > 0 ? ` (+${unread} to read)` : ""}`;
    lines.push(
      `| ${entry.component.label} | ${entry.pinned} | ${latest} | ${behind} | ${advised} |`
    );
  }
  for (const entry of deltas) {
    if (entry.releases.length > 0 || entry.advisories.length > 0) {
      lines.push(...componentSection(entry));
    }
  }
  const ignored = Object.entries(IGNORED_ADVISORIES);
  if (availability.length > 0) {
    lines.push(
      "",
      "### Pinned download availability",
      "",
      "HEAD checks only; archive acceptance still requires the pinned hash and exact length.",
      "",
      "| File | Source host | Availability |",
      "| --- | --- | --- |",
      ...availability.map(
        (file) =>
          `| ${cell(file.name)} | ${cell(file.host)} | ${cell(file.problem ?? "available")} |`
      )
    );
  }
  if (ignored.length > 0) {
    lines.push(
      "",
      "Reviewed and ignored advisories (`IGNORED_ADVISORIES` in `scripts/provider-pin-watch.ts`):",
      "",
      ...ignored.map(([id, reason]) => `- ${cell(id)}: ${cell(reason)}`)
    );
  }
  lines.push(
    "",
    "Keyword matches are a reading list, not a verdict: read each flagged note and its linked",
    "changes before the next bump. The `security` label follows published advisories whose",
    "vulnerable range contains a pinned version."
  );
  return `${lines.join("\n")}\n`;
}

export function readPins(path: string): Map<string, string> {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  const pins = new Map<string, string>();
  for (const component of COMPONENTS) {
    const entry = (value as Record<string, unknown>)[component.key];
    const version = (entry as Record<string, unknown> | undefined)?.version;
    if (typeof version !== "string") {
      throw new Error(`provider-pins.json has no ${component.key}.version`);
    }
    pins.set(component.key, version);
  }
  return pins;
}

export interface PinnedFile {
  url: string;
  redirectHosts: readonly string[];
  sizeBytes: number;
}

/** All downloadable pins, including guest packages that have no release feed. */
export function readPinnedFiles(path: string): PinnedFile[] {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!(isRecord(value) && Array.isArray(value.network_tools))) {
    throw new Error("Invalid provider download pins.");
  }
  return [value.smolvm, value.docker, value.buildx, ...value.network_tools].map(
    (pin) => {
      if (
        !isRecord(pin) ||
        typeof pin.url !== "string" ||
        typeof pin.size_bytes !== "number" ||
        !Number.isSafeInteger(pin.size_bytes) ||
        pin.size_bytes <= 0 ||
        !Array.isArray(pin.redirect_hosts) ||
        !pin.redirect_hosts.every((host: unknown) => typeof host === "string")
      ) {
        throw new Error("Invalid pinned URL or redirect hosts.");
      }
      const url = new URL(pin.url);
      if (
        url.protocol !== "https:" ||
        url.port ||
        url.username ||
        url.password ||
        url.hash
      ) {
        throw new Error(
          "Pinned URLs require HTTPS with no alternate authority."
        );
      }
      return {
        url: pin.url,
        redirectHosts: pin.redirect_hosts,
        sizeBytes: pin.size_bytes,
      };
    }
  );
}

export interface PinAvailability {
  name: string;
  host: string;
  problem: string | null;
  kind: "available" | "no_longer_served" | "transient" | "invalid";
}

function pinnedUrlAllowed(url: URL, source: URL, pin: PinnedFile): boolean {
  return (
    url.protocol === "https:" &&
    !url.port &&
    !url.username &&
    !url.password &&
    !url.hash &&
    (url.hostname === source.hostname ||
      pin.redirectHosts.includes(url.hostname))
  );
}

function pinRequest(confirmation: boolean, signal: AbortSignal): RequestInit {
  return {
    method: confirmation ? "GET" : "HEAD",
    headers: confirmation
      ? {
          "cache-control": "no-cache",
          range: "bytes=0-0",
          "accept-encoding": "identity",
        }
      : undefined,
    redirect: "manual",
    signal,
  };
}

function pinFailure(
  problem: string,
  kind: "invalid" | "no_longer_served",
  confirmation: boolean
): Pick<PinAvailability, "problem" | "kind"> {
  return {
    problem: confirmation ? `Length confirmation failed: ${problem}` : problem,
    kind: confirmation ? "transient" : kind,
  };
}

async function pinnedUrlProblem(
  pin: PinnedFile,
  fetcher: typeof fetch,
  signal = AbortSignal.timeout(30_000),
  firstMismatch?: string
): Promise<Pick<PinAvailability, "problem" | "kind">> {
  const source = new URL(pin.url);
  let url = source;
  // A failed confirmation cannot establish a repeated length mismatch. Only
  // a successful one-byte 206 below may confirm it and return `invalid`.
  const failure = (
    problem: string,
    kind: "invalid" | "no_longer_served"
  ): Pick<PinAvailability, "problem" | "kind"> =>
    pinFailure(problem, kind, firstMismatch !== undefined);
  try {
    for (let redirects = 0; redirects <= 5; redirects++) {
      if (!pinnedUrlAllowed(url, source, pin)) {
        return failure(
          "redirect refused (host or scheme not pinned)",
          "invalid"
        );
      }
      const response = await fetcher(
        url,
        pinRequest(firstMismatch !== undefined, signal)
      );
      if (firstMismatch !== undefined && response.status === 206) {
        return await pinnedRangeProblem(pin, response, firstMismatch);
      }
      await response.body?.cancel();
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location || redirects === 5) {
          return failure("redirect missing or limit exceeded", "invalid");
        }
        url = new URL(location, url);
        continue;
      }
      if (firstMismatch !== undefined) {
        return failure(
          `HTTP ${response.status}; one-byte range unavailable, recheck next run`,
          "invalid"
        );
      }
      if (response.status === 404 || response.status === 410) {
        return failure(
          `HTTP ${response.status}: upstream no longer serves this pinned file`,
          "no_longer_served"
        );
      }
      if (response.status !== 200) {
        return {
          problem: `HTTP ${response.status} (transient failure)`,
          kind: "transient",
        };
      }
      return await pinnedLengthProblem(
        pin,
        fetcher,
        signal,
        response.headers.get("content-length")
      );
    }
  } catch {
    return {
      problem: "request timed out or failed (transient failure)",
      kind: "transient",
    };
  }
  return failure("redirect limit exceeded", "invalid");
}

async function pinnedLengthProblem(
  pin: PinnedFile,
  fetcher: typeof fetch,
  signal: AbortSignal,
  length: string | null
): Promise<Pick<PinAvailability, "problem" | "kind">> {
  if (length === null) {
    return {
      problem: "Content-Length unavailable; exact size not checked",
      kind: "transient",
    };
  }
  if (!/^\d+$/.test(length) || Number(length) !== pin.sizeBytes) {
    // HEAD metadata may be stale. A one-byte GET independently reports the
    // total from the original pinned URL under the same deadline/policy.
    // A nonnumeric HEAD can be cleared by the pin's size, but cannot corroborate
    // a different GET total as a confirmed mismatch.
    return await pinnedUrlProblem(pin, fetcher, signal, length);
  }
  return { problem: null, kind: "available" };
}

async function pinnedRangeProblem(
  pin: PinnedFile,
  response: Response,
  firstLength: string
): Promise<Pick<PinAvailability, "problem" | "kind">> {
  const transient = {
    problem: "One-byte range did not confirm the HEAD length; recheck next run",
    kind: "transient",
  } as const;
  const reader = response.body?.getReader();
  try {
    const range = response.headers
      .get("content-range")
      ?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
    const total = Number(range?.[3]);
    if (
      !(range && Number.isSafeInteger(total)) ||
      total <= 0 ||
      Number(range[1]) !== 0 ||
      Number(range[2]) !== 0 ||
      response.headers.get("content-length") !== "1" ||
      ![null, "identity"].includes(response.headers.get("content-encoding")) ||
      !reader
    ) {
      return transient;
    }
    // At most one payload byte and EOF. A server ignoring Range is cancelled
    // before this helper; neither a whole archive nor an endless stream is read.
    const byte = await reader.read();
    if (
      byte.done ||
      byte.value.byteLength !== 1 ||
      !(await reader.read()).done
    ) {
      return transient;
    }
    if (total === pin.sizeBytes) {
      return { problem: null, kind: "available" };
    }
    if (!/^\d+$/.test(firstLength) || total !== Number(firstLength)) {
      return transient;
    }
    return {
      problem: `Content-Length differs from pinned size_bytes (${pin.sizeBytes}); confirmed by one-byte GET`,
      kind: "invalid",
    };
  } finally {
    if (reader) {
      await reader.cancel();
      reader.releaseLock();
    }
  }
}

/** Bounded, unauthenticated HEAD and optional one-byte GET requests. Never download archives or forward the
 * GitHub API token; only original/pin-listed HTTPS hosts may receive a request. */
export async function checkPinnedUrls(
  pins: readonly PinnedFile[],
  fetcher: typeof fetch = fetch
): Promise<PinAvailability[]> {
  const results: PinAvailability[] = [];
  for (const pin of pins) {
    const source = new URL(pin.url);
    results.push({
      name: source.pathname.split("/").at(-1) ?? "pinned file",
      host: source.hostname,
      ...(await pinnedUrlProblem(pin, fetcher)),
    });
  }
  return results;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function list(value: unknown, what: string): Record<string, unknown>[] {
  if (!(Array.isArray(value) && value.every(isRecord))) {
    throw new Error(`Unexpected ${what} response from the GitHub API.`);
  }
  return value;
}

const text = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

function release(value: Record<string, unknown>): Release | null {
  const tag = text(value.tag_name);
  return tag === null
    ? null
    : {
        tag_name: tag,
        published_at: text(value.published_at),
        html_url: text(value.html_url) ?? "",
        prerelease: value.prerelease === true,
        draft: value.draft === true,
        body: text(value.body),
      };
}

function advisory(value: Record<string, unknown>): Advisory | null {
  const id = text(value.ghsa_id);
  if (id === null || !Array.isArray(value.vulnerabilities)) {
    return null;
  }
  return {
    ghsa_id: id,
    html_url: text(value.html_url) ?? "",
    severity: text(value.severity) ?? "unknown",
    summary: text(value.summary) ?? "",
    vulnerabilities: value.vulnerabilities.filter(isRecord).map((entry) => ({
      vulnerable_version_range: text(entry.vulnerable_version_range),
      patched_versions: text(entry.patched_versions),
    })),
  };
}

export interface WatchIssue {
  number: number;
  state: string;
  stateReason: string | null;
}

/** Minimal GitHub REST client; every call is bounded and fails on an unexpected status. */
export class GitHub {
  readonly token: string;
  readonly fetcher: typeof fetch;

  constructor(token: string, fetcher: typeof fetch = fetch) {
    this.token = token;
    this.fetcher = fetcher;
  }

  async request(
    method: string,
    path: string,
    body?: unknown,
    ok: number[] = [200]
  ): Promise<{ status: number; value: unknown }> {
    const response = await this.fetcher(`https://api.github.com${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${this.token}`,
        "x-github-api-version": "2022-11-28",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!ok.includes(response.status)) {
      throw new Error(`${method} ${path}: HTTP ${response.status}`);
    }
    const body_ = await response.text();
    return { status: response.status, value: body_ ? JSON.parse(body_) : null };
  }

  /** Every listed release of the component's repository, up to the paging bound. */
  async releases(
    component: Component
  ): Promise<{ releases: Release[]; truncated: boolean }> {
    const releases: Release[] = [];
    // The listing is ordered by creation, not by version: a maintenance release below the
    // pin can precede newer releases, so no tag ends the scan. Every page is read up to the
    // cap (the watched repositories have a few hundred releases); `delta` keeps the newer ones.
    for (let page = 1; page <= MAX_RELEASE_PAGES; page++) {
      const { value } = await this.request(
        "GET",
        `/repos/${component.repository}/releases?per_page=100&page=${page}`
      );
      const raw = list(value, "releases");
      releases.push(
        ...raw.map(release).filter((entry): entry is Release => entry !== null)
      );
      if (raw.length < 100) {
        return { releases, truncated: false };
      }
    }
    console.warn(
      `${component.repository}: release listing stopped at ${MAX_RELEASE_PAGES} pages; older pages were not read.`
    );
    return { releases, truncated: true };
  }

  /** Published repository security advisories (one page of 100). */
  async advisories(component: Component): Promise<Advisory[]> {
    const { value } = await this.request(
      "GET",
      `/repos/${component.repository}/security-advisories?state=published&per_page=100`
    );
    const raw = list(value, "security advisories");
    if (raw.length >= 100) {
      console.warn(
        `${component.repository}: 100 advisories returned; older ones were not read.`
      );
    }
    return raw
      .map(advisory)
      .filter((entry): entry is Advisory => entry !== null);
  }

  /**
   * The watch's own issue: labelled `provider-pin-watch` and opened by the workflow's bot,
   * open or closed, oldest first. An issue anyone else opened is never adopted.
   */
  async findIssue(repository: string): Promise<WatchIssue | null> {
    const { value } = await this.request(
      "GET",
      `/repos/${repository}/issues?labels=${WATCH_LABEL}&creator=${encodeURIComponent(BOT_LOGIN)}&state=all&sort=created&direction=asc&per_page=100`
    );
    for (const issue of list(value, "issues")) {
      const user = isRecord(issue.user) ? text(issue.user.login) : null;
      if (
        typeof issue.number === "number" &&
        issue.title === ISSUE_TITLE &&
        issue.pull_request === undefined &&
        user === BOT_LOGIN
      ) {
        return {
          number: issue.number,
          state: text(issue.state) ?? "open",
          stateReason: text(issue.state_reason),
        };
      }
    }
    return null;
  }
}

export interface Plan {
  action: "create" | "update" | "close" | "none";
  body: string;
  /** Whether the issue should carry the `security` label after this run. */
  security: boolean;
}

/**
 * What to do with the one issue. An issue a maintainer closed as not planned stays closed
 * until a new advisory affects a pin or a pinned URL returns 404/410. Transient
 * failures never create or reopen an issue by themselves.
 */
export function plan(
  deltas: Delta[],
  existing: WatchIssue | null,
  checkedAt: string,
  availability: readonly PinAvailability[] = []
): Plan {
  // An advisory whose range cannot be read is listed but never keeps the issue open.
  const unavailable = availability.some(
    (file) => file.kind === "no_longer_served"
  );
  const invalid = availability.some((file) => file.kind === "invalid");
  const transient = availability.some((file) => file.kind === "transient");
  const behind =
    unavailable ||
    invalid ||
    deltas.some(
      (entry) =>
        entry.releases.length > 0 ||
        entry.advisories.some((advisory) => advisory.certain)
    );
  const security = deltas.some((entry) =>
    entry.advisories.some((advisory) => advisory.certain)
  );
  const body = renderBody(deltas, checkedAt, availability);
  if (!behind) {
    return {
      action:
        existing?.state === "open" ? (transient ? "update" : "close") : "none",
      body,
      security: false,
    };
  }
  if (
    existing?.state === "closed" &&
    existing.stateReason === "not_planned" &&
    !security &&
    !unavailable
  ) {
    return { action: "none", body, security };
  }
  return { action: existing ? "update" : "create", body, security };
}

async function ensureLabel(
  github: GitHub,
  repository: string,
  name: string,
  color: string,
  description: string
): Promise<void> {
  // 422: the label already exists.
  await github.request(
    "POST",
    `/repos/${repository}/labels`,
    { name, color, description },
    [201, 422]
  );
}

/** Apply `next` to the issue. Labels are added and removed one by one, never replaced. */
export async function apply(
  github: GitHub,
  repository: string,
  existing: WatchIssue | null,
  next: Plan
): Promise<void> {
  if (next.action === "none") {
    return;
  }
  await ensureLabel(
    github,
    repository,
    WATCH_LABEL,
    "5319e7",
    "Tracked by the provider pin watch"
  );
  if (next.security) {
    await ensureLabel(
      github,
      repository,
      SECURITY_LABEL,
      "b60205",
      "Security advisory or fix"
    );
  }
  if (next.action === "create" || existing === null) {
    await github.request(
      "POST",
      `/repos/${repository}/issues`,
      {
        title: ISSUE_TITLE,
        body: next.body,
        labels: next.security ? [WATCH_LABEL, SECURITY_LABEL] : [WATCH_LABEL],
      },
      [201]
    );
    return;
  }
  await github.request(
    "PATCH",
    `/repos/${repository}/issues/${existing.number}`,
    next.action === "close"
      ? { body: next.body, state: "closed", state_reason: "completed" }
      : { body: next.body, state: "open" },
    [200]
  );
  if (next.security) {
    await github.request(
      "POST",
      `/repos/${repository}/issues/${existing.number}/labels`,
      { labels: [SECURITY_LABEL] },
      [200]
    );
  } else {
    // 404: the issue does not carry the label.
    await github.request(
      "DELETE",
      `/repos/${repository}/issues/${existing.number}/labels/${SECURITY_LABEL}`,
      undefined,
      [200, 404]
    );
  }
}

export async function main(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
  fetcher: typeof fetch = fetch
): Promise<number> {
  const dryRun = argv.includes("--dry-run") || env.PIN_WATCH_DRY_RUN === "true";
  const token = env.GITHUB_TOKEN;
  const repository = env.GITHUB_REPOSITORY;
  if (!(token && repository && /^[\w.-]+\/[\w.-]+$/.test(repository))) {
    console.error(
      "GITHUB_TOKEN and GITHUB_REPOSITORY (owner/name) are required."
    );
    return 64;
  }
  const github = new GitHub(token, fetcher);
  const pinPath = resolve(
    import.meta.dir,
    "../packages/runtime-core/provider-pins.json"
  );
  const pins = readPins(pinPath);
  const availability = await checkPinnedUrls(readPinnedFiles(pinPath), fetcher);
  const deltas: Delta[] = [];
  for (const component of COMPONENTS) {
    const pinned = pins.get(component.key) as string;
    const { releases, truncated } = await github.releases(component);
    deltas.push(
      delta(
        component,
        pinned,
        releases,
        await github.advisories(component),
        truncated
      )
    );
  }
  const existing = await github.findIssue(repository);
  const next = plan(
    deltas,
    existing,
    new Date().toISOString().slice(0, 10),
    availability
  );
  console.log(next.body);
  console.log(
    `Action: ${next.action}${existing ? ` (issue #${existing.number})` : ""}; security label: ${next.security ? "on" : "off"}${dryRun ? " (dry run: nothing written)" : ""}`
  );
  if (!dryRun) {
    await apply(github, repository, existing, next);
  }
  return 0;
}

if (import.meta.main) {
  process.exit(await main(Bun.argv.slice(2)));
}
