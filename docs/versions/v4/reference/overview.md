# Reference and contracts

Start with the [CLI overview](../../cli.md) to choose a command and the
[generated command reference](../../reference/cli.md) for usage and flags. [Command and output contracts](command-contracts.md) adds the deeper leaf sections, complete public flag inventory and command-specific JSON/log records.
Read [Run and inspect](../guides/run-project.md) for a task sequence rather than
using a flag list as an installation guide.

A command being listed is not proof that every backend accepts it. Read the
selected version's runtime limits alongside examples. Help's global flags and a
parent command table are distinct from complete leaf-command option coverage.

## Environment and lifecycle configuration

[Environment and secrets](../../env.md), [Lifecycle](../../lifecycle.md) and
[Architecture](../../architecture.md) explain the project configuration model.
Do not infer schema defaults or cloud-provider support from a similarly named
field in another version.

## Agent interface

The [CLI reference](../../reference/cli.md) and [integrations](../../integrations.md)
provide the v4 consumer interface. Public MCP implementation is preserved at the
[pinned source revision](https://github.com/hack-dance/hack/tree/91b14bf0abb17602142425de0d02628a3e8a2615/src/mcp).
Later v5 compiler schemas and MCP reference pages are not substitutes for the v4
contract. This archived corpus has no generated complete API/type catalog.

## Field references

[Configuration fields](configuration-fields.md) lists the version-specific project JSON, environment YAML and branch registry. [MCP fields and results](mcp-fields.md) lists every registered tool's input declarations, result fields and log event types.

## Coverage limits

This first versioned pass preserves generated command documentation and separates
public contracts from internal implementation types. Some deeper subcommands lack
full generated usage/options sections. Dedicated per-flag and configuration-field
coverage remains an explicit follow-up; neither a parent table nor a linked source
file counts as a complete prose API specification. No internal DTO is promoted to
a supported public API by appearing in the repository.
