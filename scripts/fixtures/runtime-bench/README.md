# Runtime benchmark fixture

A small project for `scripts/benchmark-runtime-footprint.ts`: a web dev server and an
API on shared source (both `bun --watch`), Postgres with a named volume, and Redis. It is
a measurement workload, not an example of how to set up a project.

- `.hack/docker-compose.yml`: the four services. `web` and `api` are routed.
- `bench.json`: what the benchmark probes (routes, data marker, watched file, tasks,
  I/O paths). Point `--workload` at another descriptor to measure another project.
- `web/`: the dev server, plus a small React entry point with a few common dependencies so
  `bun install` and `bun run build` do real work on the shared mount. The `install on
  volume` task runs the same install in a named volume (`deps`), which shows what keeping
  dependencies off the shared mount is worth on each backend. Compare the later runs of
  the two tasks: by then both use a warm package cache, while the first `install` run
  also downloads the packages.
- `api/`: one Postgres table and one Redis counter.

Copy the directory somewhere outside the repository before running it: both backends
write state under `.hack/`, and the install task writes `web/node_modules`.
See [Runtime performance diagnostics](../../../docs/performance.md#runtime-footprint-benchmark).
