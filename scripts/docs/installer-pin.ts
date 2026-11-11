const installerDownload =
  /(releases\/download\/)([^/\s]+)(\/(?:hack-next-install\.sh|hack-next-manager-darwin-arm64|INSTALLER-SHA256SUMS))(?=$|[\s"'`\\?#<)&])/g;
const installerVersion = /^V=(5\.0\.0-next\.\d+)\b/gm;
const prereleaseTag = /^v5\.0\.0-next\.\d+$/;

/** Align prerelease examples while leaving other channels for validation to reject. */
export function pinInstallerExamples(options: {
  readonly text: string;
  readonly tag: string;
}): string {
  return options.text
    .replace(installerDownload, (match, prefix, tag, artifact) =>
      prereleaseTag.test(tag) ? `${prefix}${options.tag}${artifact}` : match
    )
    .replace(installerVersion, `V=${options.tag.slice(1)}`);
}

/** Check every installer example, including URLs that name a different release channel. */
export function assertPinnedInstallers(options: {
  readonly text: string;
  readonly tag: string;
  readonly source: string;
}): void {
  const tags = [
    ...Array.from(
      options.text.matchAll(installerDownload),
      (match) => match[2]
    ),
    ...Array.from(
      options.text.matchAll(installerVersion),
      (match) => `v${match[1]}`
    ),
  ];
  for (const tag of tags) {
    if (tag !== options.tag) {
      throw new Error(
        `${options.source} installs ${tag}, not the pinned ${options.tag}`
      );
    }
  }
}
