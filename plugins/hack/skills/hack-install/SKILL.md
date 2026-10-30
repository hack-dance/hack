---
name: hack-install
description: Install, upgrade, or roll back Hack; diagnose a missing CLI or plugin MCP launch failure; select stable versus a native prerelease without mixing their runtime state. Use hack-init for project configuration and hack-remote for a fresh remote host or Codex Cloud.
---

# Install and select Hack

Complete the requested installation and verify the exact executable. The plugin
provides instructions; the separate, opt-in `hack-mcp` plugin provides a local MCP
connection. Installing either does not install Hack, Docker, a native provider,
DNS, or certificate trust.

## Identify the target

Read the repository instructions and establish the machine, OS/architecture,
checkout and requested channel. Inspect `command -v hack` and `hack --version`.
For an existing candidate root, inspect its owned schema before choosing and
invoking its verified absolute launcher/manager as described below. A source checkout's
package version does not identify a published native bundle. Keep the selected
absolute executable for subsequent commands; examples below use its usual name.
Do not replace a working stable installation just to try v5.

## Stable

On a Homebrew host, use the official formula `hack-dance/tap/hack`. Inspect
`brew info hack-dance/tap/hack` before an authorized install or upgrade; use
`brew install hack-dance/tap/hack` or `brew upgrade hack-dance/tap/hack` as
appropriate. Run Homebrew as the user, never with sudo.

For another supported host, read the installation instructions in the Hack
repository (see Further reading) and inspect the official release's platform
assets. Pin a release for reproducible setup, save and review its installer,
and follow its documented verification. Do not guess asset names or run an
unreviewed download through a shell. Managed containers use the slim path in
`hack-remote`; slim mode does not provision a full container runtime.

## Native prerelease alongside stable

Read the candidate installation guide (see Further reading) and inspect the actual
installed channel schema and selected release's published asset inventory. Do not
infer channel layout from a skill version, a package version, or the presence of a
launcher alone. Read the owned channel's `.channel.json` without modifying it.
A source checkout is not evidence that installer assets have been published.
Native candidate packages support Apple Silicon macOS, not arbitrary Linux hosts.

### Standalone v2 channel

For `hack.prerelease-install/v2`, keep the verified absolute executable
`<verified-root>/bin/hack-next` as `candidate` below. The default root is
`$HOME/.hack-next`; a separately selected root must use its own verified path.
Use the installed launcher, never a Python manager path:

```sh
"$candidate" --manager status
"$candidate" --version
"$candidate" --manager upgrade --version 5.0.0-next.N
"$candidate" --manager rollback
"$candidate" --manager stable
```

The upgrade version must be an explicit existing published candidate. Inspect its
assets and compatibility before choosing it. Version selection does not imply
manager replacement: replacing a different compiled manager requires a reviewed
predecessor digest. Do not invent one or bypass a refusal.

A bootstrap child shell cannot change the caller's PATH. For a verified default
root, the one explicit current-shell step is:

```sh
export PATH="$HOME/.hack-next/bin:$PATH"
```

For a custom root, add that verified root's `bin` instead. Then `hack-next`
is the normal candidate command. Preserve the selected absolute executable for
subsequent verification and MCP selection; do not alias stable `hack` globally
or overwrite an existing custom command.

### New Python-free installation

Pin an actual published `5.0.0-next.N` release and inspect its API asset list.
Require `hack-next-install.sh`, `hack-next-manager-darwin-arm64`, and
`INSTALLER-SHA256SUMS` beside the native archive, `prerelease.json`, and
archive `SHA256SUMS`. Save and review the bootstrap from that release's actual
asset URL; its embedded version and manager digest must match the selected assets.
Keep HTTPS/redirect restrictions, hashes, archive validation and structural
signature verification. Ad-hoc signatures are not Developer ID origin proof.

If the selected release lacks these assets and the user requires Python-free
installation, report that the Python-free route is unavailable for that release.
Do not silently install Python, invent a bootstrap URL or v5 Homebrew formula,
or present next.5 as already shipping the new standalone assets. A checkout's
packaging implementation does not make its release URLs available.

### Legacy v1 channel (optional advanced path)

For `hack.prerelease-install/v1`, preserve the existing Python manager, receipt,
homes and any pending journal. Use only that channel's historically reviewed legacy
manager if the user explicitly accepts the legacy Python-dependent path and Python
is already available. Its advanced operation is `python3 <verified-legacy-root>/manager.py
--root <verified-legacy-root> status` (or its documented upgrade/rollback/stable).
This is not the standalone v2 command and is not the Python-free install route.
Never point it at a v2 root, migrate layouts implicitly, or change a legacy root
with the standalone bootstrap. Select an explicit separate root for the new layout.
Unknown or malformed schemas require inspection; do not guess a manager command.

Before upgrade or rollback, stop the selected candidate's projects with its
ordinary retained-data shutdown and stop its owned native runtime as documented.
"hack-next update" is not the upgrade path. Do not remove locks, rewrite receipts,
prune volumes, or bypass pending-journal, active-launch or ownership refusals.
New versions get fresh homes; selection does not migrate application data.
After rollback, verify retained application data through the restored runtime.
Python-free installer evidence does not establish that every optional setup or
runtime feature is Python-free. DNS/TLS activation and feature prerequisites are
separate setup and readiness gates; preserve their native approvals.

## Plugin and MCP selection

The `hack-mcp` server and the Claude hook run `hack` from the client process's PATH.
They do not automatically follow `hack-next`. Prefer the explicit selected CLI
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
`doctor` using that executable. Complete a requested start with service health,
an actual app request, and an appropriate log check. A successful install or MCP
listing alone does not prove app readiness. Keep local HTTPS trust prompts native;
browser access is a separate check from a successful CLI HTTPS request.

## Further reading

- [Hack repository and releases](https://github.com/hack-dance/hack)
- [Candidate installation guide](https://github.com/hack-dance/hack/blob/next/docs/guides/candidate-install.md)
