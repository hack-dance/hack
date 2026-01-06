# Global settings

Global settings live at `~/.hack/hack.config.json`. Use the CLI instead of editing by hand:

```bash
hack config get --global controlPlane.gateway.allowWrites
hack config set --global controlPlane.gateway.allowWrites true
```

Common settings:

- `controlPlane.gateway.bind` (default `127.0.0.1`)
- `controlPlane.gateway.port` (default `7788`)
- `controlPlane.gateway.allowWrites` (default `false`)
- `controlPlane.extensions["dance.hack.cloudflare"].config.hostname`

Gateway enablement is project-scoped; `hack gateway enable` updates the project config and
starts the global gateway server when at least one project opts in.
