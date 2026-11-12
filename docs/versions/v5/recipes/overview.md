# Recipes

The commands and configuration on this page were audited against `v5.0.0-next.15`.
The execution notes retain their original scope; the examples were not rerun with
the pinned binary.

Step-by-step setups for using Hack with other tools and for everyday
workflows. Each recipe has a complete project under
[`examples/recipes`](https://github.com/hack-dance/hack/tree/278aeb1cee5b136d7bae0ddfcd5f3741e9579524/examples/recipes) or
[`examples/configs`](https://github.com/hack-dance/hack/tree/278aeb1cee5b136d7bae0ddfcd5f3741e9579524/examples/configs), and each page says what was
tested and what was not.

They all use the supported building blocks: lifecycle hooks and processes,
managed env and overlays, `hack run`, `hack exec` and `hack host exec`. They
run on the default Compose backend.

## Other tools

- [Sign in to another CLI at startup](cli-sign-in.md): a hook signs in to a
  deploy or edge platform CLI and hands the token to your services.
- [Expose a local service through a tunnel](tunnels.md): a public URL for
  webhooks and OAuth callbacks, started and stopped with the project.
- [Use a remote database](remote-database.md): a proxy as a lifecycle
  process, one overlay per database, and guard rails for production.

## Everyday workflows

- [Run database migrations](migrations.md): by hand, on every start, and per
  branch instance.
- [Switch between environments](environments.md): development, QA and
  production-like settings with env overlays.
- [Install dependencies in a deps service](deps-service.md): install inside
  the container, once, into a shared volume.
- [Dependency directories and caches](dependency-directories.md): where
  `node_modules`, build output and caches live, and the native backend's
  differences.
- [Clean up](cleanup.md): branch instances, worktrees, orphaned containers,
  volumes and stale `node_modules`.

## Copy-paste setups

- [Config examples](config-examples.md): complete `.hack/` setups for a web
  app with Postgres, an API with a worker and a queue, a monorepo, a Python
  app, a static site, and a dev server on your machine.

## When something goes wrong

- [Common pitfalls](common-pitfalls.md): small, easy-to-hit problems and
  what to do instead.
- Run `hack doctor` and follow its advice.
