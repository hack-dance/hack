# Opt-in dependency initializer protocol

Ordinary dependency-cache labels select a volume; they do not serialize installers
or certify its contents. `hack.dependencies.cache-protocol: locked-v1` opts one
initializer into a stricter, cooperative protocol. Adopt it only for an immutable
dependency payload. Keep worktree-specific source generation in a separate,
always-run step with its own output directory.

```yaml
services:
  install:
    image: your-pinned-installer-image
    platform: linux/arm64
    entrypoint: []
    command: ["sh", "/source/install-dependencies.sh"]
    labels:
      hack.dependencies.cache-volume: dependencies
      hack.dependencies.lockfiles: bun.lock
      hack.dependencies.runtime-files: package.json,scripts/install-dependencies.sh
      hack.dependencies.cache-protocol: locked-v1
      hack.dependencies.cache-generation: "0"
      hack.dependencies.cache-verify: '["test", "-s", "/deps/expected-output"]'
    volumes:
      - ../scripts:/source:ro
      - dependencies:/deps
  app:
    image: your-application-image
    depends_on:
      install:
        condition: service_completed_successfully
    volumes:
      - dependencies:/deps:ro
volumes:
  dependencies: {}
```

Replace the example commands, output check, image and platform with your actual
installer contract. Pin the image by digest. The initializer needs `/bin/sh`,
`flock`, `cmp`, `env`, `sleep`, `mkdir` and `mv`, and permission to write the cache root. Hack
generates and mounts a read-only wrapper; it preserves the explicit command argv.
Inherited image entrypoints, string commands, multiple writers for one volume,
external/named volumes, Compose indirection (`include`, `extends`, `volumes_from`)
and unresolved runtime configuration are unsupported. Replacing the initializer
argv through `hack run` is rejected before cache access.
Do not change the generated files under `.hack/.internal` yourself.

This first version runs initializer and verifier with a clean environment:
`PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin` and `HOME=/tmp`.
It does not forward image, host, branch or Hack overlay variables. Explicit
initializer `environment` and `env_file` settings are refused. Credential- or
environment-dependent installers are therefore not supported by this protocol yet;
retain their existing setup instead of opting in. This prevents untracked runtime
environment changes from producing different payloads under one ready marker.

The initializer must run synchronously, keep the inherited lock descriptor open,
and write only its declared payload. It must not background writers or alter the
protocol's `.hack-dependency-cache-v1` metadata. The output verifier must be
synchronous and return nonzero unless the complete payload is usable. A trivial
file check is only an example: verify the real required dependencies and generated
artifacts. All consumers must directly require successful initializer completion
and mount this volume read-only. This is a cooperative contract, not a sandbox
against malicious commands or out-of-band volume writers.

## State and recovery

During detached startup and restart, Hack observes opted-in initializers and
reports `waiting`, `installing`, `verifying`, `ready`, or `failed` on stderr.
`waiting` means waiting for the shared-cache lock; Compose's own output describes
container launch. `ready` describes the dependency payload, not application
readiness. JSON command output remains on stdout.

Observation uses a project-filtered Docker event stream and bounded initializer
log streams only while Compose startup runs. It accepts fixed protocol phase
records and discards other installer output. Progress is diagnostic: unavailable
observation does not change Compose's result or startup budget. Ordinary,
non-opted-in installers retain their existing Compose output.
Very short-lived phases can finish before observation attaches. Phase records are
cooperative diagnostics, not independent proof of payload or application health.

The wrapper waits up to 60 seconds for a kernel-managed exclusive lock. It never
unlinks the lock or steals it based on age. It records an attempt before running
the initializer, then runs the verifier. Only two successful exits allow an
identity-bound readiness marker to be renamed into place. A matching ready marker
skips this explicitly declared initializer; it does not skip other services or
certify worktree-specific generation.

Give a separate generation service its own per-instance output volume. Both that
service and the application must directly depend on successful initializer
completion and mount dependencies read-only; the application should also depend
on successful generation. Generation-only source inputs should not change the
dependency fingerprint. Verify regeneration through full startup/restart or run
the generator explicitly: scoped commands and a one-off `hack run` may skip
dependencies, so they are not an unconditional generation hook.

An unsuccessful or interrupted attempt has no valid ready marker. Subsequent
starts refuse to reuse or mutate that incomplete generation. Diagnose the failure,
then increment `hack.dependencies.cache-generation` in the tracked Compose file
and rerun `hack up --detach`. This selects a fresh cache volume; failed and existing
ready generations are retained. Do not delete protocol markers to force reuse.
Already-running containers retain their original mounts until restarted.

The fingerprint includes the protocol, generation, initializer argv, verifier
and working directory along with the normal cache inputs.
It still does not resolve mutable image tags, inspect arbitrary build contexts or
fully evaluate later Compose overrides. Include relevant source inputs explicitly;
do not override protected mounts, gates, commands or environment after validation.

The atomic rename publishes **readiness**, not an atomic replacement of the entire
dependency directory. The protocol does not claim power-loss durability, external
writer protection or correctness of an inadequate verifier. The first implementation
also does not reclaim old generations automatically. See the
[CLI cache and startup documentation](../cli.md#dependency-bootstrap-integrity).
