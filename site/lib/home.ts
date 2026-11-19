/**
 * Homepage copy and the install command it shows.
 *
 * The headline and description are shared with the site metadata in
 * `app/layout.tsx`, so the page and its `<title>`/description cannot drift.
 */

export const tagline = "Run every project, branch and worktree at once";

export const description =
  "Run your whole project locally. Every project, branch and git worktree runs side by side at its own HTTPS address.";

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
