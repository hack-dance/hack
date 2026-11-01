# Prepare a project for the native candidate

Start with [Install](../install.md), [Native preparation](native-candidate.md) and [Getting started](../getting-started.md). Select the explicit next.6 launcher and prepare its provider pool, image and private home before starting an application.

For ordinary Compose initialization, select v4 in the documentation version selector. Its init/detached-start recipe is not the v5 native setup procedure.

## Inspect existing inputs

Determine whether the project uses authored native configuration, legacy Compose input or an already adopted instance. Installing a native candidate does not migrate resources or data.

[Authored schema fields](../reference/authored-schema-fields.md) describes native document shapes. [Authored commands](../../reference/native-authored-commands.md) defines the narrower executable subset. Schema validity alone does not establish runtime admission.

For existing Compose data, read [Native config import](../../reference/native-config-import.md) before considering conversion or adoption. Preview reports are not permission to stop containers or change ownership.

## Start only the prepared workflow

Follow [Getting started](../getting-started.md) for foreground startup, saved-run status, finite service logs and owned shutdown. Use the same selected launcher and project on every step. Verify the application endpoint and its own health checks.

If diagnosis reports a problem, inspect the specific failure and its documented repair contract. Do not apply generic doctor repairs, detached Compose examples or inferred branch behavior to an authored-native run.

## Optional agent assistance

[Explicit agent setup](agent-first-setup.md) explains how to hand off a scoped project task. Use the CLI and versioned documentation directly, or separately review the optional skills/MCP interface in [Integrations](../integrations.md). Project setup does not require instruction-file writes, primer hooks, guidance sync or automatic skill updates.
