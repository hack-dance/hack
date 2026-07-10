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

## Extensions & legacy compatibility

- [Extensions](./extensions.md)
- [Creating an extension](./guides/create-extension.md)
- [Integrations](./integrations.md)
- [Tickets migration reference (deprecated compatibility surface)](./guides/tickets.md)
- [SDK](./sdk.md)

## Experimental / beta

- [Beta workflows](./beta.md)
- [Experimental remote docs](./gateway.md) — remote/gateway/node/dispatch are unsupported experimental surfaces, hidden from default help behind `hack help --all` and warn on use; see the product-boundary notes in `src/agents/instruction-source.ts`
- [Gateway API](./gateway-api.md)
- [Supervisor](./supervisor.md)
