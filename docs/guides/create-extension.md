# Create an extension

This page is part of [Extensions & reference](../reference.md).
Start with [Core docs](../core.md) if you are learning `hack`, or use [Beta workflows](../beta.md)
if you are here because of remote/control-plane features.

Extensions add commands and configuration without bloating the core CLI.

## Layout (current)

Built-in extensions live under `src/control-plane/extensions/<name>/` and export an
`extension.ts` that returns the manifest + commands.

## Minimal example

1) Create a folder:

```
src/control-plane/extensions/my-extension/
  extension.ts
```

2) Export a definition. The manifest has no `name` field — `id`, `version`, `scopes`, and
   `cliNamespace` are required, and `summary` is the only optional field:

```ts
import type { ExtensionDefinition } from "../types.ts"

export const extension: ExtensionDefinition = {
  manifest: {
    id: "dance.hack.my-extension",
    version: "0.1.0",
    scopes: ["project"],
    cliNamespace: "myext",
    summary: "Example extension"
  },
  commands: [
    {
      name: "hello",
      summary: "Print a greeting",
      scope: "project",
      handler: async ({ ctx, args }) => {
        ctx.logger.info({ message: `Hello from ${ctx.projectName ?? "unknown"}` })
        return 0
      }
    }
  ]
}
```

This mirrors the real tickets extension (`src/control-plane/extensions/tickets/extension.ts`):

```ts
export const TICKETS_EXTENSION: ExtensionDefinition = {
  manifest: {
    id: "dance.hack.tickets",
    version: "0.1.0",
    scopes: ["project"],
    cliNamespace: "tickets",
    summary: "Git-backed tickets and runs",
  },
  commands: TICKETS_COMMANDS,
};
```

`scopes` is a list of `"global" | "project"` and drives what the CLI suggests when the extension is
disabled: a `global`-only extension gets a `hack config set --global ...` enable hint, otherwise the
hint targets the project config (`hack config set ...`).

Command handlers receive `args: readonly string[]` alongside `ctx` — extensions are responsible for
parsing their own flags out of `args`; there is no shared flag-parsing layer yet.

`ExtensionCommandContext` (the `ctx` passed to every handler) exposes:

- `cwd` — current working directory
- `logger` — structured logger
- `project` — resolved project context, if any
- `projectId` / `projectName` — convenience accessors for the current project
- `controlPlaneConfig` — the loaded control-plane config

3) Register it in `src/control-plane/extensions/builtins.ts`.

4) Enable it in config:

```bash
hack config set --global 'controlPlane.extensions["dance.hack.my-extension"].enabled' true
```

(Use the non-`--global` form to enable per-project instead, if `scopes` includes `"project"`.)

5) Verify it's wired up:

```bash
hack x list
hack x myext help
```

### Advanced: commands that must run before the extension is enabled

Set `allowWhenDisabled: true` on a command (for example a `setup` command) to let it run even while
the extension itself is disabled — this is how tickets' `hack x tickets setup` can enable the
extension as its first step. See `src/commands/tickets.ts` for the pattern.

## Planned improvements

- Co-locate docs + agent rules with the extension implementation.
- Command spec metadata (args/options) for auto-help + agent hints.
