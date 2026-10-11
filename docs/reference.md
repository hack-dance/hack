# Reference

## CLI & architecture

- [CLI overview](./cli.md) — supported command surface and the running-things decision guide
- [CLI reference (generated, exhaustive)](./reference/cli.md) — every command and flag, rendered from the spec (regenerate: `bun run docs:cli-reference`)
- [Architecture](./architecture.md)
- [Core docs](./core.md)
- [Docs information architecture](./docs-ia.md)

## Environment & sessions

- [Environment model](./env.md)
- [Lifecycle & startup](./lifecycle.md)
- [Sessions](./sessions.md)
- [Agent-first setup](./guides/agent-first-setup.md)

## Native runtime (experimental)

- [Native candidate guide](./guides/native-candidate.md)
- [Native configuration validation](./reference/native-config-compiler.md) — the authored `.hack/hack.project.json` compiler contract
- [Native configuration with Compose](./reference/native-compose-commands.md) — the Compose command owner for authored projects
- [Authored configuration with the native runtime](./reference/native-authored-commands.md) — the explicit native backend command slices and their support matrix

## Extensions

- [Extensions](./extensions.md)
- [Creating an extension](./guides/create-extension.md)
- [Integrations](./integrations.md)
