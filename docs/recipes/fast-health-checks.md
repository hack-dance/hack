# Fast, correct health checks and shutdown

Three Compose settings decide how long `hack up` waits for a healthy dependency
and how long `hack down` waits for a dev server to stop. Every project in
[Config examples](config-examples.md) and the other recipes uses them.

## Requirements

`start_interval` needs Docker Engine 25.0 or later and Docker Compose 2.20.2 or
later. Hack's Compose backend uses your own engine and Compose; check them with
`docker version` and `docker compose version`. An older engine does not use
`start_interval`, so it checks at the steady `interval` from the start.

The native backend's engine is pinned to a newer version and passes these
settings through for services without a route. A routed service's command
health check is replaced by a route probe on native (see
[Native candidate](../guides/native-candidate.md)). `hack config import` does not
convert `start_period` or `start_interval` yet
([Native config import](../reference/native-config-import.md)).

## Start quickly: `start_period` and `start_interval`

Without a start interval, the engine runs a health check for the first time one
full `interval` after the container starts, then once every `interval`. A
service that waits on `condition: service_healthy` waits at least that long,
even when the dependency was ready after half a second. With `interval: 2s`,
every start pays about two seconds for each level of healthy dependencies.

`start_period` is a startup grace period: failed checks in it do not count
towards `retries`. `start_interval` is the time between checks during that
period, including the wait before the first check: with the settings below, the
first check runs about 250 milliseconds after the container starts. The first
successful check ends the start period and marks the service healthy, and the
engine then checks at the steady `interval`.

```yaml
    healthcheck:
      test: ["CMD", "pg_isready", "-U", "app", "-d", "app"]
      start_period: 30s     # time the service may take to start
      start_interval: 250ms # check this often until it is healthy
      interval: 10s         # then check this often
      timeout: 3s
      retries: 3
```

Set both. Compose refuses `start_interval` without `start_period`. Make
`start_period` longer than the slowest start you expect; a check that still
fails after it counts towards `retries`. A steady `interval` of 10 seconds or more
keeps the check from costing CPU for the rest of the session; a dependency that
fails later is still reported within about `interval × retries`.

## Stop quickly: `init` and `stop_grace_period`

`hack down` asks each container to stop with `SIGTERM` and waits
`stop_grace_period` (10 seconds by default) before it kills it. A program that
runs as the container's first process (PID 1) gets no default signal handling
from Linux, so a dev server or `sleep infinity` that does not handle `SIGTERM`
itself ignores it and the stop takes the full 10 seconds.

```yaml
  web:
    image: oven/bun:1.4.4-slim
    init: true             # a small init process passes SIGTERM to the server
    stop_grace_period: 2s  # and kills it if it is still running after 2s
    command: ["bun", "run", "dev"]
```

Use them for dev servers, watchers and stand-in services. Leave databases on the
default grace period: Postgres and Redis handle `SIGTERM` themselves and may need
the time to write their data safely.

## Before and after

The same two-service project (Postgres with a health check, and a Bun server
that waits for it) on Docker Engine 29.9.2 and Compose 5.6.1 on Linux, eight
interleaved runs of each version, on a busy machine (load average 17 to 37 on
20 cores), so treat the `up` numbers as estimates:

| | `interval: 2s`, no `init` | settings above |
| --- | --- | --- |
| `docker compose up -d`, median | 4.3 s | 3.3 s |
| `docker compose down`, median | 13.6 s | 1.9 s |

On macOS, Hack's own four-service benchmark fixture spent 2.3 s of a 5.7 s
warm start waiting for the first health check at `interval: 2s`.

## Sources

- Dockerfile reference, [`HEALTHCHECK`](https://docs.docker.com/reference/dockerfile/#healthcheck):
  the first check runs `interval` after the container starts; `--start-interval`
  needs Docker Engine 25.0 or later.
- Compose specification, [`healthcheck`](https://github.com/compose-spec/compose-spec/blob/main/workload_spec.md#healthcheck)
  (`start_interval` since Compose 2.20.2), [`init`](https://github.com/compose-spec/compose-spec/blob/main/container_spec.md#init)
  and [`stop_grace_period`](https://github.com/compose-spec/compose-spec/blob/main/container_spec.md#stop_grace_period).
- The engine's health monitor uses `start_interval` for every check while the
  container is starting, the first one included
  ([moby v25.0.0 `daemon/health.go`](https://github.com/moby/moby/blob/v25.0.0/daemon/health.go)).
- Docker Compose refuses `start_interval` without `start_period`
  ([moby/moby#48874](https://github.com/moby/moby/issues/48874)).
