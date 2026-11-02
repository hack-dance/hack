# next.6 release contracts

Released version: `5.0.0-next.6`, source
`44aaf5156426dfcbb1c8a189b8e20531e5b95613`. This page records source-reviewed
changes from next.5. The [generated CLI reference](../../reference/cli.md) is now
snapshotted from that release. Registration is not native backend admission.

## Installer and backend selection

[PR525](https://github.com/hack-dance/hack/pull/525) shipped the shell bootstrap and
standalone manager. [Install](../install.md) gives the exact release asset and
Apple Silicon macOS boundary. The [channel environment and run selection](https://github.com/hack-dance/hack/blob/44aaf5156426dfcbb1c8a189b8e20531e5b95613/scripts/installer/channel.ts)
confirm native by default, explicit Compose override, version-private native homes
and retained caller homes for Compose. The bootstrap takes no `install` subcommand
or `--version` flag; its release is embedded in the downloaded shell asset.

## Agent setup shipped, not pending

Merged [PR531](https://github.com/hack-dance/hack/pull/531) removed automatic
instruction injection. Legacy sync/cursor/claude/agents setup paths refuse; the
primer emits a retirement notice. Init no longer writes agent files automatically. Its retained handoff flag explicitly passes an onboarding prompt to a selected agent; it remains outside the default tutorial selection. MCP instruction-writing flags refuse before
configuration effects. [Agent setup in next.6](../guides/agent-setup-v5-branch.md)
documents the two deliberately scoped opt-ins. Existing custom files are preserved.
The plugin manifests select skills only; MCP is a separate optional interface.

## Changed CLI inputs and selectors

- [Command parsing](https://github.com/hack-dance/hack/blob/44aaf5156426dfcbb1c8a189b8e20531e5b95613/src/cli/command.ts) now distinguishes Hack options from passthrough arguments. Put Hack options before the command tail. `exec`/`run` forward the command as argv; a child's `--json`, `--help` or `--version` does not become a Hack flag. A separator before the service still allows that service selector to be parsed.
- [Env selection](https://github.com/hack-dance/hack/blob/44aaf5156426dfcbb1c8a189b8e20531e5b95613/src/cli/env-selection.ts) retains explicit base/overlay validation. Backend and project selection are independent; a private home alone does not select native execution.
- [Project target](https://github.com/hack-dance/hack/blob/44aaf5156426dfcbb1c8a189b8e20531e5b95613/src/commands/project-target.ts) is a read-only provisional inspector with `--path`, `--project`, `--branch`, `--service`, `--env`, `--expect-generation` and `--json`. It describes a Compose target without probing runtime health. It is not a native launcher admission promise.
- [Project task list/inspect](https://github.com/hack-dance/hack/blob/44aaf5156426dfcbb1c8a189b8e20531e5b95613/src/commands/project-task.ts) are read-only provisional recipe discovery. Both take `--path`, `--project`, `--branch`, `--env`, `--expect-generation` and `--json`; inspect requires a task name. Neither executes a recipe. The [task contract](https://github.com/hack-dance/hack/blob/44aaf5156426dfcbb1c8a189b8e20531e5b95613/docs/reference/ax-task-catalog.md) defines admission and refusals.
- [Env hydrate](https://github.com/hack-dance/hack/blob/44aaf5156426dfcbb1c8a189b8e20531e5b95613/src/commands/env.ts) imports piped stdin or `--file`, with `--format env` or `--format json`. Values are not command arguments or printed output. It merges the worktree-local YAML layer atomically; `--env` selects a local overlay. Tracked env files are not written.
- [Setup migration](https://github.com/hack-dance/hack/blob/44aaf5156426dfcbb1c8a189b8e20531e5b95613/src/commands/setup-migrate.ts) is a separate explicit operation. A preview is not permission to overwrite customized client files or broaden the requested client/scope.

Use the refreshed [authored native command matrix](../../reference/native-authored-commands.md)
for foreground startup, saved-run status, finite logs and bounded noninteractive
exec/run. Do not infer `--detach`, following logs, JSON lifecycle output or service
subset support from the Compose command declarations.

## Historical field audits and evidence limits

The detailed next.5 field inventories retain their original source links and
explicit per-page provenance. Their old counts and report shapes are historical;
they are not next.6 coverage totals. Current command declarations and native
support documents take precedence. Exhaustive next.6 diagnostic and nested result
field reconciliation is not established by this docs pass.

Fresh public installation and manager status passed in an isolated fixture without
executing the native payload or MCP backend. Cross-version upgrade and rollback,
initialized data, native application and installed-client acceptance remain open.
A docs build or source audit does not qualify those flows or deploy the site.
