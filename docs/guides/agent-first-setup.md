# Agent-first setup

Let a coding agent (Claude Code, Codex) stand a project up under hack — or adopt an
existing setup — instead of doing it by hand. One canonical onboarding prompt drives
every entry point below; the content lives in the CLI, so it is always current for
your installed version.

Every entry point calls the same builder with the same repo inventory. For the same
repo, `hack init --with`, `hack agent onboard`, `hack agent init`, and the
`hack-init` MCP prompt (with `repoRoot`) produce byte-identical prompt content; each
adds at most a fixed framing line. The mode follows the repo: `existing-project`
when `.hack/` exists (project name and dev host come from its config),
`new-project` otherwise.

## Entry points (same prompt, four ways in)

| You have | Use |
| --- | --- |
| A fresh repo + an agent CLI installed | `hack init --with claude\|codex\|both` |
| An existing hack project | `hack agent onboard` (prints the prompt) |
| An agent session with the `hack` plugin installed | `/hack-init` |
| A no-shell client with Hack MCP explicitly installed (`hack-mcp` plugin or `hack setup mcp`) | the `hack-init` MCP prompt |

## New repo: `hack init --with`

```bash
cd /path/to/repo
hack init --auto --with claude   # or codex, or both
```

- Runs the normal init, then launches the agent CLI interactively with the full
  onboarding prompt (`claude "<prompt>"` / `codex "<prompt>"`).
- If the agent CLI is not on PATH, the prompt is printed with copy-paste
  instructions instead.
- The handoff always runs after `.hack/` exists, so the prompt is in
  existing-project mode. A framing line says whether this run scaffolded `.hack/`
  or found it already present and skipped init.
- With `--no-interactive` (or `HACK_NO_INTERACTIVE=1`, or no TTY) nothing is
  spawned — the prompt is always printed.

## Existing project: `hack agent onboard`

```bash
hack agent onboard          # prints the onboarding prompt for this project
hack agent onboard | pbcopy # copy it for any agent session
```

The prompt starts with a pre-computed repo inventory and picks up the project name
and dev host from `.hack/hack.config.json` when present.

The `hack-init` MCP prompt takes an optional `repoRoot` argument (relative paths
resolve against the MCP server's working directory). With `repoRoot` it returns the
same content as `hack agent onboard` for that repo and ignores the `mode`,
`projectName`, and `devHost` arguments. Without it the server scans nothing, uses
those arguments (default `existing-project`), and the prompt states that no
inventory was run.

## Agent-side skill: `/hack-init`

The optional `hack` plugin ships a thin `hack-init` skill; install the plugin
through your client's plugin manager (see
[Optional native plugins](../integrations.md#optional-native-plugins)). The skill
tells the agent to run `hack agent onboard` and follow the printed prompt. Without
shell access it fetches the `hack-init` MCP prompt only when a Hack MCP server, such
as the opt-in `hack-mcp` plugin, is installed; otherwise it reports that blocker.
The content stays in the CLI, so the skill fetches guidance matching the installed
CLI.

A client that cannot use the plugin can export the same skill into a chosen scope as
an explicit opt-in (`hack setup claude` or `hack setup codex`). Onboarding itself
never installs it.

## MCP request lifetime

`hack mcp serve` ties command execution to the requesting client. Cancelling a tool
request stops its command; the session remains available for later requests. Closing
client stdin or gracefully stopping the server cancels in-flight commands. Command
and log-tail timeouts also terminate the owned command group, escalating after two
seconds when graceful termination does not finish. Cancellation does not roll back
completed operations or delete persistent project data. These controls do not reduce
the number of servers for clients that remain connected.

MCP command results capture at most 8 MiB of combined stdout/stderr bytes before
text decoding. For tools other than the log tools, exceeding the budget stops the
command and returns an error with `outputTruncated: true`; parsed `data` is omitted
so a prefix cannot masquerade as a complete result. The log tools
(`hack.project.logs.tail` and `hack.project.logs.snapshot`) use the same budget,
but reaching it is a cutoff: the result is `ok: true` with `outputTruncated: true`,
`data.cutoff` set to the `bytes` bound, and the events parsed before the cut. See
[MCP logs contract](../reference/mcp-logs.md). Run the equivalent CLI command when
full output is needed. The budget bounds captured bytes, not total process memory
or JSON response size.

The [MCP tool contract](../reference/mcp-tools.md) lists every tool with its
annotations, inputs, the CLI command it runs and its result shape.

Each MCP session captures its launch working directory and environment. Project
registry selection, command execution and audit-file locations use that snapshot;
later sessions do not replace the state of an existing session. The standard stdio
entry still starts one process per connected client.

## What the prompt covers

1. Inventory — package manager, services, ports, backing services, and required
   variable names. Preserve the existing credential flow without copying secrets.
   Lockfiles (`bun.lock`, legacy `bun.lockb`, pnpm, yarn, npm) are checked at the
   root and in workspace packages; lockfiles from different package managers are a
   conflict to resolve, not something to delete. Non-JS manifests (Cargo, Go,
   Python, Ruby, Elixir, .NET) and runtime pins (`.nvmrc`, `.tool-versions`,
   `mise.toml`, `engines`, `packageManager`) are noted by name.
2. Setup — resume from an existing `.hack/` config at the first failing phase, then
   configure the requested container or host workflow, routing, and managed env
   injection. Full containerization, backing-services-only, and toolchain-only are
   all valid shapes; none requires an always-on app service. Verify replacements
   before removing any old env files.
3. Platform nuances — isolate Linux native dependencies from host installs when
   needed, using the locked install for the repo's package manager
   (`bun install --frozen-lockfile`, `pnpm install --frozen-lockfile`,
   `yarn install --immutable`, `npm ci`). A lockfile failure is diagnosed, not
   bypassed. The optional `hack.dependencies.cache-volume` /
   `hack.dependencies.lockfiles` labels and the opt-in
   [`locked-v1` protocol](dependency-cache-protocol.md) cover cache sharing. Reuse
   existing tooling; add an ops container only when justified.
4. Running things — choose `hack run`, `hack exec`, or `hack host exec` for the target.
5. Verification — check expected long-running services, successful one-shot exits,
   actual routed URLs with normal TLS verification, and the requested host workflow.
   Confirm persistent data survives `hack down` / `hack up` and setup reruns.
   Preserve native trust approvals, ownership, and destructive-cleanup gates.
   Unrelated optional integration warnings do not block completion.

The ground rules tell the agent not to create or modify `AGENTS.md`, `CLAUDE.md`,
rule files, or repository skill copies unless asked. Onboarding configures the
runtime; it does not install agent instructions. The agent also reports the
discovery limits it hit: a missing agent client (the prompt was printed instead of
launched), a non-interactive run, the inventory's remaining discovery limitations,
or a `hack-init` MCP prompt request without `repoRoot`, which defaults to
existing-project mode without a repo inventory.

The pre-computed inventory comes before the phases in every entry point. It reads
file names and manifest keys only, never env-file contents, lockfile contents or
pin values. It ends with a list of discovery limitations, such as conflicting
package managers or non-JS services whose entrypoints were not inferred.

## Partial adoption (backing services only)

Choose the shape that fits the requested workflow. Hack can run only the backing
services — postgres, temporal, redis, and similar — while app dev servers (`bun
dev`, `dotnet watch`, `vite`) stay on the host.

**When to choose it:**
- Heavy native toolchains (.NET, large native builds) develop faster on the host
  than in a container.
- The hot-path dev server (the one you restart constantly) benefits from host-native
  file watching, debuggers, or hot reload that containers make slower or flakier.
- The team already has a working host-based dev workflow and containerizing it is
  not worth the churn.

**What hack still gives you in this shape:**
- Stable hostnames and TLS for HTTP services and admin UIs via Caddy. Raw database
  protocols use their configured host ports or container-network addresses.
- Branch instances for the containerized services (`--branch <name>`), even though
  the host-run app processes are not branch-isolated on their own.
- Managed environment configuration and secret injection. Commit only non-secret
  values; use the configured secret backend for credentials.
- Lifecycle hooks (`startup`/`lifecycle` in `.hack/hack.config.json`) for host-side
  setup — tunnels, SSO bootstrap — that would otherwise be ad-hoc terminal steps.

**How to wire it:**
- Define only the backing services in `.hack/docker-compose.yml`; add Caddy labels
  where a stable hostname is useful (databases usually don't need one — connect by
  container port — but admin UIs, queues, or shared services often do).
- Give host dev servers their connection info via `hack host exec --scope <svc> --
  <cmd>` (injects the resolved env without touching `.env` files) without exposing secret values.
- App URLs can stay on plain `localhost:<port>` for the fast path, or get promoted
  to a routed compose service later if you want a stable `*.hack` hostname for them
  too — the two are not mutually exclusive and can be migrated incrementally.

**Tradeoffs vs full containerization:**
- No single `hack up` brings up the whole stack for a newcomer — they still need to
  start the host dev servers themselves (document that step).
- Host-run app processes are not branch-isolated by hack; running two branches side
  by side means varying ports/env per worktree yourself.

Partial adoption is a valid end state, not an incomplete migration — do not treat it
as something to "finish" into full containerization unless the tradeoffs above
actually bite.

## Toolchain-only adoption

Hack can also manage only pinned tools and dependency caches. Define one-shot tool
services behind a Compose profile and run them with
`hack run --profile <profile> <service> -- <cmd>`. No app service needs to stay up.
This repository's own `toolchain` service is an example: see
[Develop Hack using Hack](../../.hack/README.md).

## Copy-paste bootstrap

Paste this into a fresh Claude Code / Codex session started at the repo root:

```text
Set this repository up to run under the hack CLI. Run `hack agent onboard`
(pass --no-interactive to hack commands) and follow the printed onboarding
prompt for the requested scope. Preserve native approvals, existing credential
flows, runtime ownership, and publishing gates. If the CLI is missing, report
that blocker and continue independent setup work. Verify the chosen services
and host workflows, and distinguish reachability from certificate trust.
```
