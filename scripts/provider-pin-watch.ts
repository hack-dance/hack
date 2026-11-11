#!/usr/bin/env bun
/**
 * Provider pin watch (HACK-2078). Reads `packages/runtime-core/provider-pins.json`,
 * lists each pinned component's upstream releases newer than its pin, classifies their
 * notes by the provider interfaces the native runtime depends on, and creates or updates
 * one issue titled "Provider pins behind upstream" with the delta table. The issue is
 * labelled `security` when any note mentions an advisory. It never changes a pin:
 * a bump is qualified by hand (see "How a provider pin bump is qualified" in
 * packages/runtime-core/README.md).
 *
 * `--dry-run` prints the issue body and writes nothing. Network effects need
 * GITHUB_TOKEN (read releases; issues: write to file the issue) and GITHUB_REPOSITORY.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const ISSUE_TITLE = "Provider pins behind upstream";
export const SECURITY_LABEL = "security";

/** A pinned component and where its releases are published. */
export interface Component {
  key: string;
  label: string;
  repository: string;
  /** Release tag for a version, e.g. `v1.34.1` or `docker-v29.5.2`. */
  tagPrefix: string;
}

export const COMPONENTS: readonly Component[] = [
  {
    key: "smolvm",
    label: "SmolVM",
    repository: "smol-machines/smolvm",
    tagPrefix: "v",
  },
  {
    key: "docker",
    label: "Docker engine",
    repository: "moby/moby",
    tagPrefix: "docker-v",
  },
  {
    key: "buildx",
    label: "BuildKit client (buildx)",
    repository: "docker/buildx",
    tagPrefix: "v",
  },
];

/**
 * Provider interfaces the runtime passes or reads. A release note naming one of them
 * needs a look before the next bump. A test checks that each still appears in the
 * runtime source, so a removed interface is dropped here too.
 */
export const WATCHED_INTERFACES: readonly string[] = [
  "--docker-socket",
  "--mount-socket",
  "--expose-socket",
  "--allow-host",
  "--allow-cidr",
  "--net-backend",
  "--rosetta",
  "--volume",
  "--label",
  "--storage",
  "--overlay",
  "SMOLVM_DISK_TRIM",
  "SMOLVM_IDLE_RECLAIM",
  "SMOLVM_BALLOON_RECLAIM",
  "SMOLVM_EGRESS_FLOOR",
  "SMOLVM_AGENT_ROOTFS",
];

export interface Category {
  name: string;
  pattern: RegExp;
}

export const CATEGORIES: readonly Category[] = [
  {
    name: "security advisory",
    pattern:
      /\b(security|advisor(y|ies)|CVE-\d{4}-\d+|RUSTSEC-\d{4}-\d+|GHSA-[0-9a-z-]+)\b/i,
  },
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

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Categories and watched interfaces a release note mentions. */
export function classify(notes: string): string[] {
  const found = CATEGORIES.filter((category) =>
    category.pattern.test(notes)
  ).map((category) => category.name);
  for (const name of WATCHED_INTERFACES) {
    if (new RegExp(`(^|[^\\w-])${escapeRegExp(name)}(?![\\w-])`).test(notes)) {
      found.push(`\`${name}\``);
    }
  }
  return found;
}

/** `[major, minor, patch]` of a stable release tag with this prefix, else null. */
export function parseTag(
  tag: string,
  prefix: string
): [number, number, number] | null {
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

export interface Release {
  tag_name: string;
  published_at: string | null;
  html_url: string;
  prerelease: boolean;
  draft: boolean;
  body: string | null;
}

export interface Delta {
  component: Component;
  pinned: string;
  releases: { tag: string; date: string; url: string; categories: string[] }[];
}

/** Stable releases newer than the pinned version, oldest first, classified. */
export function delta(
  component: Component,
  pinned: string,
  releases: Release[]
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
      (
        entry
      ): entry is { release: Release; version: [number, number, number] } =>
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
      categories: classify(release.body ?? ""),
    })),
  };
}

export function mentionsAdvisory(deltas: Delta[]): boolean {
  return deltas.some((entry) =>
    entry.releases.some((release) =>
      release.categories.includes("security advisory")
    )
  );
}

/** The issue body: a summary line per component and one table row per newer release. */
export function renderBody(deltas: Delta[], checkedAt: string): string {
  const lines = [
    `Checked ${checkedAt} against \`packages/runtime-core/provider-pins.json\`. This issue is`,
    "updated by the weekly provider pin watch and never changes a pin. To bump, follow",
    '"How a provider pin bump is qualified" in `packages/runtime-core/README.md`.',
    "",
    "| Component | Pinned | Latest stable | Releases behind |",
    "| --- | --- | --- | --- |",
  ];
  for (const entry of deltas) {
    const latest =
      entry.releases.at(-1)?.tag ??
      `${entry.component.tagPrefix}${entry.pinned}`;
    lines.push(
      `| ${entry.component.label} | ${entry.pinned} | ${latest} | ${entry.releases.length} |`
    );
  }
  for (const entry of deltas.filter((item) => item.releases.length > 0)) {
    lines.push(
      "",
      `### ${entry.component.label} (${entry.component.repository})`,
      "",
      "| Release | Date | Notes mention |",
      "| --- | --- | --- |"
    );
    for (const release of entry.releases) {
      const mentions =
        release.categories.length > 0
          ? release.categories.join(", ")
          : "nothing watched";
      lines.push(
        `| [${release.tag}](${release.url}) | ${release.date} | ${mentions} |`
      );
    }
  }
  lines.push(
    "",
    "Keyword matches are a reading list, not a verdict: read each flagged note and its linked",
    "changes before the next bump."
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
    const text = await response.text();
    return { status: response.status, value: text ? JSON.parse(text) : null };
  }

  /** Releases, newest first, until one at or below the pin (at most ten pages). */
  async releasesSince(
    component: Component,
    pinned: string
  ): Promise<Release[]> {
    const base = parseTag(
      `${component.tagPrefix}${pinned}`,
      component.tagPrefix
    ) as [number, number, number];
    const releases: Release[] = [];
    for (let page = 1; page <= 10; page++) {
      const { value } = await this.request(
        "GET",
        `/repos/${component.repository}/releases?per_page=100&page=${page}`
      );
      const batch = value as Release[];
      releases.push(...batch);
      const reachedPin = batch.some((release) => {
        const version = parseTag(release.tag_name, component.tagPrefix);
        return version !== null && compare(version, base) <= 0;
      });
      if (batch.length < 100 || reachedPin) {
        break;
      }
    }
    return releases;
  }

  async findIssue(
    repository: string
  ): Promise<{ number: number; state: string } | null> {
    // Closed issues are reused too, so the watch keeps one issue and its history.
    for (let page = 1; page <= 10; page++) {
      const { value } = await this.request(
        "GET",
        `/repos/${repository}/issues?state=all&per_page=100&page=${page}&sort=created&direction=asc`
      );
      const batch = value as {
        number: number;
        state: string;
        title: string;
        pull_request?: unknown;
      }[];
      const found = batch.find(
        (issue) =>
          issue.title === ISSUE_TITLE && issue.pull_request === undefined
      );
      if (found) {
        return { number: found.number, state: found.state };
      }
      if (batch.length < 100) {
        return null;
      }
    }
    return null;
  }
}

export interface Plan {
  action: "create" | "update" | "close" | "none";
  body: string;
  labels: string[];
}

/** What to do with the one issue, given the deltas and whether an issue exists. */
export function plan(
  deltas: Delta[],
  existing: { state: string } | null,
  checkedAt: string
): Plan {
  const behind = deltas.some((entry) => entry.releases.length > 0);
  const body = renderBody(deltas, checkedAt);
  const labels = mentionsAdvisory(deltas) ? [SECURITY_LABEL] : [];
  if (!behind) {
    return {
      action: existing?.state === "open" ? "close" : "none",
      body,
      labels,
    };
  }
  return { action: existing ? "update" : "create", body, labels };
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
  const pins = readPins(
    resolve(import.meta.dir, "../packages/runtime-core/provider-pins.json")
  );
  const deltas: Delta[] = [];
  for (const component of COMPONENTS) {
    const pinned = pins.get(component.key) as string;
    deltas.push(
      delta(component, pinned, await github.releasesSince(component, pinned))
    );
  }
  const existing = await github.findIssue(repository);
  const next = plan(deltas, existing, new Date().toISOString().slice(0, 10));
  console.log(next.body);
  console.log(
    `Action: ${next.action}${next.labels.length ? ` (labels: ${next.labels.join(", ")})` : ""}${dryRun ? " (dry run: nothing written)" : ""}`
  );
  if (dryRun || next.action === "none") {
    return 0;
  }
  if (next.labels.includes(SECURITY_LABEL)) {
    // 422: the label already exists.
    await github.request(
      "POST",
      `/repos/${repository}/labels`,
      {
        name: SECURITY_LABEL,
        color: "b60205",
        description: "Security advisory or fix",
      },
      [201, 422]
    );
  }
  if (next.action === "create") {
    await github.request(
      "POST",
      `/repos/${repository}/issues`,
      { title: ISSUE_TITLE, body: next.body, labels: next.labels },
      [201]
    );
  } else if (existing) {
    await github.request(
      "PATCH",
      `/repos/${repository}/issues/${existing.number}`,
      next.action === "close"
        ? { body: next.body, state: "closed", state_reason: "completed" }
        : {
            body: next.body,
            state: "open",
            ...(next.labels.length ? { labels: next.labels } : {}),
          },
      [200]
    );
  }
  return 0;
}

if (import.meta.main) {
  process.exit(await main(Bun.argv.slice(2)));
}
