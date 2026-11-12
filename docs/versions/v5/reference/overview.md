# Reference and contracts

[Global settings](../../guides/global-settings.md) covers machine-wide settings,
including the proxy's `proxy.bind_address` option.

Start with the [CLI overview](../../cli.md) to choose a command and the
[generated command reference](../../reference/cli.md) for usage and flags.
[Command and output contracts](command-contracts.md) adds the deeper leaf sections,
the public flag inventory and command-specific JSON and log records. A command
being listed is not proof that every backend accepts it; the native backend
supports a bounded subset described in
[Native authored commands](../../reference/native-authored-commands.md).

## Configuration

[Environment and secrets](../../env.md), [Lifecycle](../../lifecycle.md) and
[Architecture](../../architecture.md) explain the project configuration model.
[Configuration fields](configuration-fields.md) lists the project JSON, environment
YAML and branch registry fields.

For the native backend, the config compiler publishes a
[project schema](https://github.com/hack-dance/hack/blob/4e51bc3f8119e154f49e040e606b6ed7f727d6d3/packages/config-compiler/generated/hack.project.schema.json)
and a [local override schema](https://github.com/hack-dance/hack/blob/4e51bc3f8119e154f49e040e606b6ed7f727d6d3/packages/config-compiler/generated/hack.local.schema.json).
[Authored schema fields](authored-schema-fields.md) lists every declared property.
Schema membership defines document shape; runtime admission is checked separately.
[Native config import](../../reference/native-config-import.md) covers previewing
and adopting existing Compose configuration.

## Agent interfaces

[MCP tools](../../reference/mcp-tools.md) specifies the public tool annotations,
inputs and results of `hack mcp serve`. [MCP logs](../../reference/mcp-logs.md)
explains finite cutoffs and cursor behavior. [MCP fields and results](mcp-fields.md)
lists every registered tool's declarations. Internal runtime protocols are not
public MCP APIs. [Agent integrations](../integrations.md) is the setup path.

## Reports

[Project and env reports](project-env-reports.md) details the inventory, metadata,
env-list and restart-wrapper projections. [Diagnostic reports](diagnostic-reports.md)
lists the doctor, update and host telemetry types.

## Provenance

Field inventories on this site were audited against the `5.0.0-next.5` source and
carry that label; the generated command reference and runtime guides follow the
pinned release shown in each page's footer. Retired hosted, dashboard and Tickets
surfaces and the unsupported gateway, node and dispatch commands are not public
APIs and are omitted from the published command reference.
