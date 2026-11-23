/**
 * Homepage copy, the version eyebrow and the install commands it shows.
 *
 * The headline and description are shared with the site metadata in
 * `app/layout.tsx`, so the page and its `<title>`/description cannot drift.
 */

/** The headline as the page sets it: one line per entry. */
export const taglineLines = [
  "Hack on your project,",
  "not your setup",
] as const;

export const tagline = taglineLines.join(" ");

/**
 * The description in the three parts the page sets apart: the middle sentence
 * is emphasised. The metadata uses them joined.
 */
export const descriptionParts = {
  lead: "One command starts your API, your database and the tunnel to staging, and catches the sign-in you forgot.",
  emphasis: "Every branch gets its own running copy.",
  tail: "One config, any machine. Docker optional.",
} as const;

export const description = [
  descriptionParts.lead,
  descriptionParts.emphasis,
  descriptionParts.tail,
].join(" ");

const prereleaseLabel = /\(next\.(\d+)\)$/;

/**
 * The release tag the v5 docs are pinned to, from the manifest label
 * (`v5 (next.16)` gives `v5.0.0-next.16`).
 *
 * The homepage must show the same installer as the pinned install page. A label
 * this cannot read (for example a stable `v5.0.0`) throws, so the build fails
 * until the homepage install block is updated for that channel; it never falls
 * back to a guessed command.
 */
export function prereleaseTag(label: string): string {
  const number = prereleaseLabel.exec(label)?.[1];
  if (number === undefined) {
    throw new Error(
      `Homepage install block cannot read a prerelease from the v5 label: ${label}`
    );
  }
  return `v5.0.0-next.${number}`;
}

/**
 * The prerelease install steps from the v5 install page: download the installer
 * from an exact release, read it, then run it.
 */
export function installCommand(tag: string): string {
  return [
    "curl --fail --location --proto '=https' --proto-redir '=https' --tlsv1.2 \\",
    `  https://github.com/hack-dance/hack/releases/download/${tag}/hack-next-install.sh \\`,
    "  --output hack-next-install.sh",
    "less hack-next-install.sh",
    "sh hack-next-install.sh",
  ].join("\n");
}

/** The stable install command, as the root README and the v4 install page give it. */
export const stableInstallCommand = "brew install hack-dance/tap/hack";

const stableVersion = /^\d+\.\d+\.\d+$/;

/**
 * The stable release tag from the root `package.json` version (`4.3.1` gives
 * `v4.3.1`). The root package carries the stable line until 5.0.0 ships.
 *
 * A version with a prerelease or build suffix is not a stable release, so it
 * gives `undefined` and the page shows only the prerelease.
 */
export function stableTag(version: string): string | undefined {
  return stableVersion.test(version) ? `v${version}` : undefined;
}

/** The GitHub release page for a tag. */
export function releaseUrl(tag: string): string {
  return `https://github.com/hack-dance/hack/releases/tag/${tag}`;
}
