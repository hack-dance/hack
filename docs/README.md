# Docs

This directory contains the public documentation for `hack`.

The docs are split into three areas so the default path stays on core local workflows.

## Choose a path

### [Core docs](core.md)

Use this path for the main product story:

- local project setup
- isolated runtime orchestration
- stable local hostnames
- env and secret management
- lifecycle hooks
- persistent sessions

Start here if you want to understand and use `hack` without remote or beta complexity by default.

### [Beta workflows](beta.md)

Use this path when you intentionally want remote and control-plane features:

- gateway exposure
- remote nodes
- remote execution
- remote supervisor jobs

Beta material stays accessible, but it is explicitly labeled and separated from the default path.

### [Extensions & reference](reference.md)

Use this path for:

- full command reference
- extension configuration and authoring
- tickets and integrations
- gateway API and SDK details

This section is easy to find, but it does not lead the product story.

## Quick links

- New to `hack`: [Core docs](core.md)
- Ready for remote workflows: [Beta workflows](beta.md)
- Looking for command or API details: [Extensions & reference](reference.md)
- Need the bucket definitions: [Docs information architecture](docs-ia.md)

## Repo notes

- Specs remain in `SPECS/` as working notes
- Root scripts orchestrate workspace tasks through Turbo
- Package-local commands remain available via `bun run --cwd <workspace> <script>`
