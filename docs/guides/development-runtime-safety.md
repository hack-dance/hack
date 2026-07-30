# Development runtime safety

Hack's development defaults must preserve hot reload without manufacturing host-wide CPU, memory,
or storage pressure. This guide records the runtime contract added after the 2026-07-30
OrbStack/Next investigation.

## Root cause and scope

The generated Compose path used to inject both `CHOKIDAR_USEPOLLING=true` and
`WATCHPACK_POLLING=true` into every discovered service. The injection was unconditional: Next and
non-Next services, small repos and bind-mounted monorepos, and runtimes with working native file
notifications all received the same polling policy. In the observed Apple Silicon workload,
polling combined with an unnecessary `linux/amd64` override and multi-gigabyte persistent `.next`
volumes. The result was sustained emulation/watcher CPU, very high cumulative writes, and a large
set of stopped branch containers and cache volumes.

The bounded comparison removed those project-level overrides without changing application code:
the Next 16 development server ran as native arm64, hot reload remained available through native
notifications, and idle container CPU settled near zero. A slow-filesystem warning remained for the
`.next` volume, which identifies storage as a latency factor but does not justify forcing polling.

Hack owns only two parts of that failure chain:

1. generated Compose defaults must not impose polling;
2. lifecycle targeting and optional cache cleanup must not silently abandon branch-owned resources.

Image platform selection and application health-check cadence remain explicit project configuration.
Hack does not rewrite them.

## File watching contract

Generated services rely on the container runtime's native file notifications. Hack does not add
Chokidar or Watchpack polling variables. A project can still set either variable on an individual
service when a measured runtime requires it:

```yaml
services:
  web:
    environment:
      CHOKIDAR_USEPOLLING: "true"
      WATCHPACK_POLLING: "750"
```

Keep polling service-scoped and measure CPU plus write activity after enabling it. Next's local
development guidance notes that Docker filesystem access on macOS and Windows can be slower than
host-local development; OrbStack likewise documents that bind mounts cross the macOS boundary
while named volumes remain on the Linux side. Those storage tradeoffs are separate from watcher
correctness.

## Branch rename contract

An implicit `hack down` in a linked worktree uses Docker's Compose labels and exact
`com.docker.compose.project.working_dir` evidence:

- no owned runtime: use the current sanitized Git branch, preserving normal behavior;
- exactly one owned runtime: target it, including when it is Created or stopped and the Git branch
  now has a different name;
- multiple owned runtimes: fail before Compose mutation and require `--branch <name>`;
- explicit `--branch`: always target that branch without inference;
- detached HEAD: continue to require an explicit branch;
- primary checkout: continue to target the base instance by default.

Canonical checkout paths prevent one worktree from stopping a sibling's runtime.

## Disposable `.next` cleanup contract

Ordinary `hack down` preserves every named volume. `hack down --prune-caches` is a narrow,
confirmation-gated addition for Next build caches. It removes only exact volume names observed on
the target containers at a mount whose final path segment is `.next`, then independently verifies
the volume's Compose project and logical-volume labels.

Runtime inventory mount records now expose the Docker volume `name` separately from `source`
(the engine storage path), so callers can inspect the same removal identity without guessing.

The cleanup intentionally excludes:

- bind mounts;
- database, Redis, application-upload, and dependency destinations;
- external or unlabeled volumes;
- volumes owned by another Compose project or checkout;
- loose volume-name matches.

Use `--yes` only after reviewing the same project-scoped evidence. Hack does not provide a broad
cache-prune command in this change because Docker volume names alone cannot distinguish disposable
build output from durable application data.

## Doctor boundary

This change does not add threshold-based doctor warnings for CPU, stopped-instance counts, volume
size, or `linux/amd64` on arm64. Those signals can be legitimate and require image/platform or
workload context that static configuration cannot prove. The generated-polling regression tests,
branch-ownership resolution, and confirmation-gated cleanup are deterministic; policy guesses are
left out of doctor until Hack can make them equally actionable.

## References

- [Next.js local development](https://nextjs.org/docs/app/guides/local-development)
- [Next.js Turbopack reference](https://nextjs.org/docs/app/api-reference/turbopack)
- [OrbStack volumes and mounts](https://docs.orbstack.dev/docker/file-sharing)
- [OrbStack efficiency](https://docs.orbstack.dev/efficiency)
