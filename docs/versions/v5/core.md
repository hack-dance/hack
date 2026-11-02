# Native project basics

This v5 corpus describes the published next.6 native candidate. Complete [Install](install.md) and [Native preparation](guides/native-candidate.md), select that candidate's explicit launcher, then follow [Getting started](getting-started.md).

For the stable Compose workflow, select v4 in the documentation version selector. Detached startup, pretty/following logs and Compose lifecycle JSON examples are not the native startup path.

## Project, service and run

A project holds the configuration for its services, jobs and environment. Native execution uses a saved run with explicit ownership and a prepared provider pool. Installing the CLI does not adopt Compose resources or prove application compatibility.

[Authored commands](../reference/native-authored-commands.md) defines the admitted forms. The basic path is whole-project foreground startup, saved-run status and a finite service log snapshot. Keep the foreground owner attached until owned shutdown completes. Do not infer authored-native instance selection from Compose's linked-worktree branch defaults.

## Observe before repairing

Use the selected executable for status and diagnosis. Check the application's health as well as the CLI report. A warning or old timestamp does not authorize mutation.

Choose a repair only after identifying its owning contract in [Getting started](getting-started.md), [Native preparation](guides/native-candidate.md) or [Authored commands](../reference/native-authored-commands.md). There is no general instruction to run every doctor repair.

## Related concepts

- [Project setup](guides/init-project.md)
- [Environment and secrets](../env.md): delivery and backend limits
- [Lifecycle](../lifecycle.md): application hooks and process ownership
- [Command contracts](reference/command-contracts.md): output shapes and backend distinctions
- [Explicit agent setup](guides/agent-first-setup.md)

Env delivery and lifecycle definition freshness remain runtime contracts; they are separate from retiring agent instruction management.
