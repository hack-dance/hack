import { LINUX_SUMS } from "./download.ts";
import {
  BUNDLE_PLATFORMS,
  type BundlePlatform,
  bundleArchiveName,
  composeOnly,
  exact,
  managerAssetName,
  object,
  parseJson,
  requireThat,
} from "./integrity.ts";

/**
 * The release asset that names every platform in a release (HACK-2419).
 *
 * The release-level `prerelease.json` cannot do that. Every published
 * manager, macOS and Linux, reads it with `metadata()`, which requires
 * exactly the keys `schema, version, tag, source_revision, platform` and
 * `platform === "darwin-arm64"`; any other key, value or schema string makes
 * `hack-next --manager install` and `upgrade` refuse the release. So that
 * file keeps its bytes and shape, and its `platform` means "the native
 * bundle's platform, kept for published managers", not "the only platform".
 * Managers select the assets they ask for by name and skip every other
 * asset, so an additional file is invisible to them.
 */
export const PLATFORMS_ASSET = "prerelease-platforms.json";
export const PLATFORMS_SCHEMA = "hack.prerelease-platforms/v1";

export type ReleasePlatform = {
  readonly platform: BundlePlatform;
  /** The backends the platform's bundle runs. */
  readonly backends: readonly ("native" | "compose")[];
  readonly archive: string;
  readonly manager: string;
  /** The release asset that lists the archive's SHA-256. */
  readonly checksums: string;
};

/** The entry for one platform of `version`. */
export function releasePlatform(
  version: string,
  platform: BundlePlatform
): ReleasePlatform {
  return {
    platform,
    backends: composeOnly(platform) ? ["compose"] : ["native", "compose"],
    archive: bundleArchiveName(version, platform),
    manager: managerAssetName(platform),
    checksums: composeOnly(platform) ? LINUX_SUMS : "SHA256SUMS",
  };
}

/** The metadata for a release that ships every bundle platform. */
export function releasePlatforms(opts: {
  readonly version: string;
  readonly sourceRevision: string;
}) {
  return {
    schema: PLATFORMS_SCHEMA,
    version: opts.version,
    tag: `v${opts.version}`,
    source_revision: opts.sourceRevision,
    platforms: BUNDLE_PLATFORMS.map((platform) =>
      releasePlatform(opts.version, platform)
    ),
  } as const;
}

/** The exact bytes of the asset. */
export function renderReleasePlatforms(opts: {
  readonly version: string;
  readonly sourceRevision: string;
}): string {
  return `${JSON.stringify(releasePlatforms(opts), null, 2)}\n`;
}

/**
 * The platforms a set of release asset names actually holds: every platform
 * that has an archive or a manager for `version`, whatever it is called.
 */
export function platformsInAssetSet(
  version: string,
  assetNames: readonly string[]
): string[] {
  const found = new Set<string>();
  const archivePrefix = `hack-${version}-`;
  for (const name of assetNames) {
    const archive = /^(.+)-(?:native|compose)\.tar\.gz$/.exec(
      name.startsWith(archivePrefix) ? name.slice(archivePrefix.length) : ""
    );
    if (archive?.[1]) {
      found.add(archive[1]);
    }
    const manager = /^hack-next-manager-(.+)$/.exec(name);
    if (manager?.[1]) {
      found.add(manager[1]);
    }
  }
  return [...found].sort();
}

/**
 * Refuses a platforms file that does not describe the asset set beside it:
 * the planned version, tag and source revision; exactly the platforms that
 * have an archive or a manager in the set, no fewer and no more; for each,
 * the archive, manager and checksum-file names, each present in the set; and
 * finally the exact bytes this release would render. The caller separately
 * checks each archive's own `prerelease.json`.
 */
export function requireReleasePlatforms(opts: {
  readonly raw: Uint8Array | string;
  readonly version: string;
  readonly sourceRevision: string;
  readonly assetNames: readonly string[];
}) {
  const value = parseJson(opts.raw);
  exact(value, ["schema", "version", "tag", "source_revision", "platforms"]);
  requireThat(
    value.schema === PLATFORMS_SCHEMA &&
      value.version === opts.version &&
      value.tag === `v${opts.version}` &&
      value.source_revision === opts.sourceRevision &&
      Array.isArray(value.platforms),
    "Release platform metadata does not match the planned version, tag and source revision."
  );
  const entries = (value.platforms as unknown[]).map((entry) => {
    const item = object(entry);
    exact(item, ["platform", "backends", "archive", "manager", "checksums"]);
    requireThat(
      typeof item.platform === "string",
      "Malformed release platform entry."
    );
    return item as Record<string, unknown> & { readonly platform: string };
  });
  const listed = entries.map((entry) => entry.platform);
  requireThat(
    new Set(listed).size === listed.length,
    "Release platform metadata lists a platform twice."
  );
  const present = platformsInAssetSet(opts.version, opts.assetNames);
  for (const platform of present) {
    requireThat(
      listed.includes(platform),
      `Release platform metadata does not list ${platform}, which has assets in the release set.`
    );
  }
  for (const platform of listed) {
    requireThat(
      present.includes(platform),
      `Release platform metadata lists ${platform}, which has no archive or manager in the release set.`
    );
  }
  for (const entry of entries) {
    const known = BUNDLE_PLATFORMS.find((name) => name === entry.platform);
    requireThat(
      known,
      `Release platform metadata lists ${entry.platform}, which is not a bundle platform.`
    );
    const expected = releasePlatform(opts.version, known);
    // Field by field, whatever the key order: the message must point at a
    // wrong value. Order and formatting are the final check's business.
    const wrong = (
      ["backends", "archive", "manager", "checksums"] as const
    ).filter(
      (field) =>
        JSON.stringify(entry[field]) !== JSON.stringify(expected[field])
    );
    requireThat(
      wrong.length === 0,
      `Release platform metadata for ${known} does not name its archive, manager, checksum file and backends (wrong: ${wrong.join(", ")}).`
    );
    for (const name of [
      expected.archive,
      expected.manager,
      expected.checksums,
    ]) {
      requireThat(
        opts.assetNames.includes(name),
        `Release platform metadata lists ${name} for ${known}, which is not in the release set.`
      );
    }
  }
  const text =
    typeof opts.raw === "string"
      ? opts.raw
      : new TextDecoder("utf-8", { fatal: true }).decode(opts.raw);
  requireThat(
    text === renderReleasePlatforms(opts),
    "Release platform metadata is not the exact rendering for this release (platform order or formatting)."
  );
}
