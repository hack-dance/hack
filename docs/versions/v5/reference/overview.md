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

## Public authored configuration schemas

The pinned compiler publishes [project schema](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/packages/config-compiler/generated/hack.project.schema.json)
and [local override schema](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/packages/config-compiler/generated/hack.local.schema.json).
[Authored schema fields](authored-schema-fields.md) lists every declared property and variant. These define document shapes and types. Semantic validation, supported runtime
features and admission checks are separate; schema membership alone does not
establish that the native backend can execute a feature.

## MCP interface

[MCP tools](../../reference/mcp-tools.md) specifies public tool annotations,
inputs, command translation and results. [MCP logs](../../reference/mcp-logs.md)
explains finite cutoffs, cursor behavior and backend failures. Use those contracts
when integrating an agent; internal runtime protocols are not public MCP APIs.

## Field references

[Configuration fields](configuration-fields.md) lists the version-specific project JSON, environment YAML and branch registry. [MCP fields and results](mcp-fields.md) lists every registered tool's input declarations, result fields and log event types.

[Project and env reports](project-env-reports.md) details the owned inventory, metadata, raw env-list and restart-wrapper projections. Raw CLI env reports are not value-free MCP projections.

[Diagnostic reports](diagnostic-reports.md) lists the owned doctor, update and host telemetry types, plus the public candidate-report wrappers where present. Private compiler Plan internals are excluded.

[Historical agent compatibility](agent-compatibility.md) records retiring instruction-management availability at next.5 without promoting it as onboarding. [Explicit agent interfaces](../integrations.md) is the recommended setup path.

## Coverage limits

This first versioned pass preserves generated command documentation and separates
public contracts from internal implementation types. Some deeper subcommands lack
full generated usage/options sections. Dedicated per-flag and configuration-field
coverage remains an explicit follow-up; neither a parent table nor a linked source
file counts as a complete prose API specification. No internal DTO is promoted to
a supported public API by appearing in the repository.
