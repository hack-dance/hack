# Create an extension

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

2) Export a definition:

```ts
import type { ExtensionDefinition } from "../types.ts"

export const extension: ExtensionDefinition = {
  manifest: {
    id: "dance.hack.my-extension",
    name: "My Extension",
    summary: "Example extension",
    cliNamespace: "myext"
  },
  commands: [
    {
      name: "hello",
      summary: "Print a greeting",
      scope: "project",
      handler: async ({ ctx }) => {
        ctx.logger.info({ message: `Hello from ${ctx.projectName ?? "unknown"}` })
        return 0
      }
    }
  ]
}
```

3) Register it in `src/control-plane/extensions/builtins.ts`.

4) Enable it in config:

```bash
hack config set --global 'controlPlane.extensions["dance.hack.my-extension"].enabled' true
```

## Planned improvements

- Co-locate docs + agent rules with the extension implementation.
- Command spec metadata (args/options) for auto-help + agent hints.
