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
- Health checks are the same on both backends. Postgres and Redis use
  `start_interval: 250ms` and a 10 s steady interval; the routed `web` and `api` have
  no command check, since native probes routes itself. The Postgres check uses TCP
  so a fresh volume waits for the final server. Use Docker Engine 25 or later for
  the Compose lane so both lanes can use the same startup cadence. Both dev servers
  run with `init: true` and a 2 s stop grace period.
- `legacy/docker-compose.v1.yml`: the fixture before Nov 2026, only for reproducing
  earlier results (with `--legacy-readiness`). See the benchmark's notes in
  [Runtime performance diagnostics](../../../docs/performance.md#runtime-footprint-benchmark).

Copy the directory somewhere outside the repository before running it: both backends
write state under `.hack/`, and the install task writes `web/node_modules`.
See [Runtime performance diagnostics](../../../docs/performance.md#runtime-footprint-benchmark).
