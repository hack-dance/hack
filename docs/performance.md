# Runtime performance diagnostics

Use bounded, repeated measurements against the same inventory. Record CLI version,
container IDs, daemon freshness and the workload window. A healthy endpoint is not
evidence that every project is fast. Avoid treating stopped containers, large RSS,
or bind mounts as a cause without measuring the associated work.

## Project listing

```sh
hack projects --json --summary --timings
hack projects --json --summary --timings --no-daemon
hack projects --json --project my-project --timings
hack daemon status --json
```

`--summary` returns project identity and status, service/container/branch/session
counts, and a separate lifecycle host-process count. The default JSON response
retains its full detail contract. Load one project's details with `--project`;
`--summary` cannot be combined with `--details` or `--meta`. Older daemons without
summary support fall back to direct discovery.

`--timings` writes numeric profiling JSON to stderr and preserves JSON stdout.
Phases include current-checkout registration, Docker listing, inspect/cache lookup,
lifecycle discovery, registry reads/updates, project views, optional metadata,
projection and JSON serialization. The measured handler duration excludes CLI
startup and downstream stdout consumption. Daemon reads report request phases and
cache age separately from the last refresh's phases. With older daemons these
server-side timings may be unavailable.

The daemon `/v1/metrics` endpoint includes `last_refresh_phases_ms`,
`last_projects_serialization_ms`, and `last_projects_response_bytes`. These describe
the most recent operations, not an aggregate benchmark. `/v1/projects` accepts
`summary=true` and `profile=true`. A summary and `include_meta=true` are incompatible.
Docker inspection requests only the runtime model's fields; environment values and
container command arguments are not fetched for listing.

## Host commands and container usage

```sh
hack host ps --json
hack usage --project my-project --details --json
hack usage --project my-project --details --watch
```

Host tracking, timeout and persistence semantics are described in [env.md](env.md).
`usage --details` adds individual container CPU, memory, I/O, PID counts and mount
types/locations to JSON, plus a per-container table in human output. The project
filter includes its branch instances. Stats requests exclude stopped containers
and synthetic lifecycle entries. Verified tracked host command trees also appear
in host usage groups; this does not transfer ownership of other processes.

For a deeper, explicit read-only probe from this checkout:

```sh
bun scripts/inspect-container-resources.ts --container <id-or-name>
bun scripts/inspect-container-resources.ts --container <id-or-name> --runtime node
bun scripts/inspect-container-resources.ts --container <id-or-name> --storage
```

The probe reports selected Docker metadata, cgroup memory/current/peak/anonymous
and file counters, OOM events, cumulative CPU, process RSS and inotify watch-entry
counts. It requires Bun or Node inside a running container. Unsupported runtime,
procfs/cgroup access or stopped containers are reported as unavailable; the script
never starts containers. Process enumeration is capped at 128 processes and 4096
file descriptors with a three-second scan budget. The observer's RSS is reported
separately, but its allocation still affects cgroup totals. Watch entries are
counts, not necessarily unique files or proof that watching is expensive. No argv,
environment, application files or output logs are read by the probe.

Compare at least two CPU/memory samples: cumulative counters alone cannot establish
current load or a leak. Inspect anonymous memory, file cache and OOM events before
changing limits. Frequent healthchecks against a full application route can trigger
rendering/database work; use measured request costs to decide whether an application
should provide a cheaper readiness route.

## Watchers and caches

Use mount metadata and actual watch counts before adding volumes or ignore rules.
Measure the same tracked source-file reads on the host and in the container, with
identical file counts and bytes. Repeated reads measure warmed behavior; do not
call the first observed read cold without controlling caches. Do not flush system
caches or write benchmark files into an active source tree as a default diagnostic.
A shared source bind across many services establishes fan-out, not its CPU cost.

## Stopped containers

```sh
hack projects prune --dry-run --json
hack projects prune --project my-project --dry-run --json
```

The preview uses existing registry/runtime ownership and missing-path checks, and
changes nothing. It reports candidates, not proof that their writable data is
safe to discard. A missing working directory might require further review of
worktree ownership or disconnected storage. Existing `projects prune --json`
without `--dry-run` applies cleanup, so use the preview explicitly.

The resource probe's `--storage` option adds writable-layer size and changed-path
prefix counts. Sizes exclude named-volume data and are not exact reclaimed disk
space. Large changes outside declared volume destinations may be application data;
review or preserve them before removal. Successful dependency/setup containers can
legitimately be stopped. Cleanup can recover storage and reduce inventory work;
stopped containers do not execute CPU work. Never infer that broad pruning is a
CPU remedy.
