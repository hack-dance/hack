/** Plugin workflow for selecting and verifying an installed CLI without crossing channels. */
export function renderHackInstallSkill(): string {
  return `---
name: hack-install
description: Install, upgrade, or roll back Hack; diagnose a missing CLI or plugin MCP launch failure; select stable versus a native prerelease without mixing their runtime state. Use hack-init for project configuration and hack-remote for a fresh remote host or Codex Cloud.
---

# Install and select Hack

Complete the requested installation and verify the exact executable. The plugin
provides instructions and a local MCP connection; installing it does not install
Hack, Docker, a native provider, DNS, or certificate trust.

## Identify the target

Read the repository instructions and establish the machine, OS/architecture,
checkout and requested channel. Inspect \`command -v hack\`, \`hack --version\`,
and, if present, \`"$HOME/.hack-next/bin/hack-next" --version\`. A source checkout's
package version does not identify a published native bundle. Keep the selected
absolute executable for subsequent commands; examples below use its usual name.
Do not replace a working stable installation just to try v5.

## Stable

On a Homebrew host, use the official formula \`hack-dance/tap/hack\`. Inspect
\`brew info hack-dance/tap/hack\` before an authorized install or upgrade; use
\`brew install hack-dance/tap/hack\` or \`brew upgrade hack-dance/tap/hack\` as
appropriate. Run Homebrew as the user, never with sudo.

For another supported host, read the installation instructions at
https://github.com/hack-dance/hack and inspect the official release's platform
assets. Pin a release for reproducible setup, save and review its installer,
and follow its documented verification. Do not guess asset names or run an
unreviewed download through a shell. Managed containers use the slim path in
\`hack-remote\`; slim mode does not provision a full container runtime.

## Native prerelease alongside stable

Read https://github.com/hack-dance/hack/blob/next/docs/guides/candidate-install.md
and verify the selected release exists. The current packaged native installer
supports Apple Silicon macOS, not arbitrary Linux cloud hosts. Use an explicit
published \`5.0.0-next.N\` tag and its reviewed \`scripts/install-prerelease.py\`.
It verifies the bundle and installs the separate \`~/.hack-next\` channel. Keep
using \`"$HOME/.hack-next/bin/hack-next"\`; do not alias bare \`hack\` globally.

Inspect selection with:

\`\`\`sh
python3 "$HOME/.hack-next/manager.py" --root "$HOME/.hack-next" status
"$HOME/.hack-next/bin/hack-next" --version
\`\`\`

Before upgrade or rollback, stop the selected candidate's projects with its
ordinary retained-data shutdown and stop its owned native runtime as documented.
Use the channel manager's \`upgrade --version\`, \`rollback\`, or \`stable\`
operation; "hack-next update" is not the upgrade path. Do not remove locks,
rewrite receipts, prune volumes, or bypass a refusal. New versions get fresh
homes; software selection does not migrate application data between runtimes.
After rollback, verify the application's retained data through the restored runtime.

## Plugin and MCP selection

The bundled MCP server and Claude hook run \`hack\` from the client process's PATH.
They do not automatically follow \`hack-next\`. Prefer the explicit selected CLI
when shell access is available. Never use a stable MCP tool to mutate a candidate
project, or infer channel selection from the skill/plugin version.

If MCP is required, configure the client's supported server selection to the
verified executable in a separately scoped integration, and verify its version
and home before using it. Clients can filter inherited shell variables; use the
client's explicit server env settings or a reviewed channel launcher, and verify
the effective target with a read-only tool call. Preserve existing custom arguments and environment;
do not create a second registration alongside an existing one without resolving
which owns the workflow. Restart a fresh client after changing launch settings.
Keep private channel paths out of the portable plugin package.

## Verify the outcome

Report the executable, version, channel and target. Inspect project status and
\`doctor\` using that executable. Complete a requested start with service health,
an actual app request, and an appropriate log check. A successful install or MCP
listing alone does not prove app readiness. Keep local HTTPS trust prompts native;
browser access is a separate check from a successful CLI HTTPS request.
`;
}
