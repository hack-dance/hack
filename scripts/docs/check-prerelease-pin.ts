/** Compare the site's v5 pin with published prereleases; this command is read-only. */
import { resolve } from "node:path";
import { isRecord } from "../../src/lib/guards";
import versions from "./versions.json";

const prereleaseTag = /^v5\.0\.0-next\.(0|[1-9]\d*)$/;
const revision = /^[a-f0-9]{40}$/;

/** Accept GitHub's release list or the page arrays emitted by gh --paginate --slurp. */
export function latestPublishedPrerelease(input: unknown): string {
  if (!Array.isArray(input)) {
    throw new Error("Expected a GitHub release list");
  }
  let latest: { tag: string; number: number } | undefined;
  for (const item of input.flat()) {
    if (
      !isRecord(item) ||
      typeof item.tag_name !== "string" ||
      typeof item.draft !== "boolean" ||
      typeof item.prerelease !== "boolean" ||
      !(item.published_at === null || typeof item.published_at === "string")
    ) {
      throw new Error("Malformed GitHub release metadata");
    }
    if (item.draft || !item.prerelease || item.published_at === null) {
      continue;
    }
    const match = prereleaseTag.exec(item.tag_name);
    if (!match) {
      continue;
    }
    const number = Number(match[1]);
    if (
      !(
        Number.isSafeInteger(number) &&
        Number.isFinite(Date.parse(item.published_at))
      )
    ) {
      throw new Error("Invalid v5 prerelease metadata");
    }
    if (!latest || number > latest.number) {
      latest = { tag: item.tag_name, number };
    }
  }
  if (!latest) {
    throw new Error("No published v5 prerelease found; freshness is unknown");
  }
  return latest.tag;
}

/** A matching label alone is insufficient: the pin must resolve to the release's commit. */
export function assertCurrentPrereleasePin(options: {
  readonly label: string;
  readonly pinnedRevision: string;
  readonly publishedTag: string;
  readonly publishedRevision: string;
}): void {
  const label = /^v5 \(next\.(0|[1-9]\d*)\)$/.exec(options.label);
  if (
    !(
      label &&
      prereleaseTag.test(options.publishedTag) &&
      revision.test(options.pinnedRevision) &&
      revision.test(options.publishedRevision)
    )
  ) {
    throw new Error("Invalid v5 pin or published tag identity");
  }
  const pinnedTag = `v5.0.0-next.${label[1]}`;
  if (pinnedTag !== options.publishedTag) {
    throw new Error(
      `Site pin ${pinnedTag} differs from published ${options.publishedTag}; open a docs re-pin PR`
    );
  }
  if (options.pinnedRevision !== options.publishedRevision) {
    throw new Error(`Site revision does not match ${options.publishedTag}`);
  }
}

async function main(): Promise<void> {
  let releases: unknown;
  try {
    releases = JSON.parse(await Bun.stdin.text());
  } catch {
    throw new Error("Pipe GitHub release-list JSON to stdin");
  }
  const publishedTag = latestPublishedPrerelease(releases);
  const tag = Bun.spawnSync(
    ["git", "rev-parse", "--verify", `${publishedTag}^{commit}`],
    {
      cwd: resolve(import.meta.dir, "../.."),
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    }
  );
  if (tag.exitCode !== 0) {
    throw new Error(`Fetch the published tag ${publishedTag} before checking`);
  }
  assertCurrentPrereleasePin({
    label: versions.v5.label,
    pinnedRevision: versions.v5.revision,
    publishedTag,
    publishedRevision: tag.stdout.toString().trim(),
  });
  console.log(`Site v5 pin matches published ${publishedTag}`);
}

if (import.meta.main) {
  await main();
}
