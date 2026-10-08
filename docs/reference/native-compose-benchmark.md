# Native authored Compose overhead benchmark

`scripts/benchmark-native-compose.py` compares native authored configuration with
legacy Hack configuration and authored Compose, using the **same frozen CLI** and
Docker engine. It is a bounded CLI/configuration experiment. It does not measure
application throughput, container CPU, shared VM CPU/memory, or gains from replacing
Docker. No results have been qualified merely by adding this harness.

Preview the protocol without creating files, invoking a candidate, or calling Docker:

```sh
python3 scripts/benchmark-native-compose.py
```

Run offline failure/accounting controls without Docker:

```sh
python3 -m unittest discover -s tests/python -p test_native_compose_benchmark.py
```

Actual trials require a separately qualified compiled CLI and companion compiler,
their exact SHA-256 hashes and qualified source revision. Reserve the Docker test
slot before starting: the flag acknowledges coordination; it cannot detect every
other engine user. There must be no competing stateful tests. The harness requires
an existing local Unix Docker endpoint, cached `oven/bun:1.4.2-slim`, and the exact
already-running proxy with curl. By default that proxy must expose standard HTTP
port 80. The explicit fixture mode below accepts a separately qualified proxy with
no published ports. The harness does not pull images, start/repair global services,
publish an admin endpoint, or change DNS/trust.
Existing distroless proxies require a separately authorized setup refresh; see the
native routing prerequisites. A missing capability refuses the run.

```sh
python3 scripts/benchmark-native-compose.py --run --exclusive-docker-slot \
  --cli /absolute/qualified/hack \
  --compiler /absolute/qualified/hack-config-compiler \
  --cli-sha256 <qualified-cli-sha256> \
  --compiler-sha256 <qualified-compiler-sha256> \
  --qualified-source-sha <qualified-source-commit> \
  --output-root /absolute/private-parent/new-experiment
```

The output parent must already be owned, private, and outside a Git checkout; the
new experiment directory must not exist. Raw captures, synthetic project files,
native receipts and JSON samples stay there with private access. The harness keeps
them as evidence, including on failure. Global proxy JSON is consumed in memory and
is never included in captures or reports. No host credentials are fixture inputs.

## Optional proxy fixture without published ports

Pass `--proxy-fixture-receipt /absolute/private-parent/proxy-receipt.json` only after
separate fixture setup and qualification. Preview still performs no file reads or
engine calls when this option is present. The benchmark never creates or retires
the proxy; its owner must retire it after verified workload and route absence.

The closed version-one receipt contains these fields:

| Field | Qualified value |
| --- | --- |
| `fixture_version`, `phase` | `1`, `qualified` |
| `engine_id`, `docker_endpoint` | Exact engine ID and the pinned local Unix endpoint |
| `proxy_id`, `image_id`, `started_at` | Full container ID, cached image ID and observed start identity |
| `owner_token`, `proxy_name` | Random 32-character hexadecimal token and `nc03-overhead-proxy-<token>` |
| `network_id` | Full ID of the retained existing `hack-dev` network |
| `ca_sha256` | SHA-256 of the live root certificate's DER bytes |
| `canary` | Only `hostname: canary-<token>.benchmark.invalid` and a random hexadecimal `marker` |

The receipt must be a stable, owned, regular file with mode 0600, one link and at
most 64 KiB. Its canonical parent must be owned with mode 0700. Unsafe ancestry,
symlinks, changed named inodes/content or extra receipt fields refuse the run.
The `qualified` field records completed setup; writing it alone does not qualify
a fixture. Setup must verify the actual cached Alpine proxy image, its public CA
and fixed HTTPS canary before handing over the receipt.

The proxy must be the unique running `hack-dev-proxy`/`caddy` selector, have the exact
random `io.hack.benchmark.proxy-owner` label, run without privilege or published
ports, and attach only to the retained `hack-dev` network. Both explicit port
bindings and dynamic runtime host bindings must be absent; `PublishAllPorts` must
be false. Its sole bind mount is
read-only `/var/run/docker.sock`. Both `/data` and `/config` must be tmpfs with exact
options `rw,noexec,nosuid,nodev,mode=700`; there are no host data/config directories
or anonymous volumes to leave behind. This avoids root-owned host files during
Linux cleanup. It does not impose a new workload resource limit.

Every application GET/POST uses the same fixed in-proxy curl oracle in both lanes.
It connects to `http://127.0.0.1:80/` with the synthetic Host header and literal marker.
Curl configuration files, proxies and redirects are disabled; curl has a three-second
deadline, the subprocess a five-second ceiling, and the response a 4096-byte budget.
The exact engine/proxy/image/start/network/mount/CA binding is checked before and
after the request. A failed probe never falls back to host ingress. Preflight also
checks the fixed HTTPS canary against the pinned public root at
`/data/caddy/pki/authorities/local/root.crt`; it does not read private keys or install
trust. The existing host-port-80 mode remains available without this receipt.

## Matched workload and sequence

Both lanes use the same cached image ID, Bun app/initializer commands, health check,
init setting, explicit no-restart policy, SIGTERM/five-second grace, writable
persistent volume, and application dependency on successful initializer exit.
There are no installs, builds, host mounts, resource caps or application credentials.
Both use a shared isolated `HACK_HOME` with daemon autostart disabled.

Each paired project uses the same random HTTP origin through the verified existing
proxy. Requests connect directly to loopback with that Host header, either from
the host or the qualified proxy namespace; no host DNS or TLS setup is needed.
Lanes execute sequentially, with verified route/container/network
absence before their peer starts. Cohorts contain one and two projects: at most
four workload containers run simultaneously, including initializer jobs.

An untimed complete up/down cycle seeds each lane's own persistent marker and warms
the paths. Eight paired rounds per cohort alternate which lane runs first. Each
lane performs warm up, ps, exec reading the marker, restart, and down. The same
independent oracle requires a healthy web container, initializer exit zero, live
Caddy route to the exact owned web IP/port, HTTP result and retained marker. Restart
must produce a new application boot identity. Volume name/creation identity and
data must survive warm starts/restarts/down. The observed image/process/health/
resource/mount policy must match across lanes; ownership labels, default-network
identities and physical volume names necessarily differ. A mismatch stops the
comparison rather than normalizing it away.

Native startup waits for readiness and ownership proof. Legacy startup may return
earlier. Consequently lifecycle CLI-exit wall time is diagnostic only; common
ready/retired wall time is the lifecycle comparison gate. `ps` JSON shapes differ:
native includes owned jobs, while legacy may list only live services. Each must
identify the exact healthy web workload, and the common engine oracle separately
checks the completed initializer. Native ownership, compilation, journals and live
route proof remain in its timed command. They must not be disabled to obtain a win.

## Metrics and predeclared gates

Each command records wall seconds and `wait4` user/system CPU of the CLI and
terminated descendants it reaped, following the existing prepared-base benchmark
pattern. It excludes Docker daemon/Caddy/app container work and the independent
observer. In fixture mode the observer's `docker exec curl` and CA reads are also
outside CLI-tree CPU accounting. They remain in `ready_wall_s` equally for both
lanes. That metric runs from CLI launch through the common oracle, including its
HTTP/engine observations. Cohort totals sum sequential project operations.
Reported child `ru_maxrss` is OS accounting, not simultaneous process-tree RSS or
container memory; do not add those quantities together.

All eight pairs must pass correctness, matched policy and final cleanup. Failed,
flagged, missing or duplicate samples cannot be replaced or treated as zero. Keep
their evidence; a new experiment needs a deliberate new run. Start/end and
one-second in-flight host observations flag competing native builds, load above
half the host CPU count, memory pressure or unavailable observations. Gaps over
five seconds invalidate admission. The observer itself introduces some host work.

Regression gates apply to each action/cohort, with native minus legacy paired
median deltas:

| Metric | ps/exec allowance | up/restart/down allowance |
| --- | --- | --- |
| CLI-tree CPU | greater of 50 ms or 25% of legacy median | greater of 250 ms or 25% |
| Comparable wall | greater of 100 ms or 15% | greater of 500 ms or 15% of ready/retired wall |

Comparable wall p95 may increase by at most the greater of 750 ms or 30% of legacy
p95. At eight samples the nearest-rank p95 is the maximum; it is not a stable tail
estimate. Baseline median absolute deviation above the greater of 20 ms or 20%
marks that metric inconclusive. Report medians, paired deltas, dispersion, all raw
samples and ratios together. A passing regression budget is not evidence of an
improvement; any apparent gain remains specific to this workload and boundary.

The experiment has a 30-minute overall deadline, 90-second command ceilings,
45-second common readiness ceilings, and a two-MiB captured-output budget. These
bound the harness rather than changing product workload resource limits. Executable
fingerprints are checked before commands and after measured action blocks; no mixed
binary comparison qualifies. A host/kernel syscall stuck in an uninterruptible
state is outside hard real-time guarantees.

## Cleanup and remaining qualification

Before later warm up, restart, down and cleanup effects, the harness verifies the
exact project/random owner on containers, every selected default network and data
volume, and any same-name resource even when its project label differs. Unknown
resources refuse before the CLI mutation. Known retained volume creation identity
must still match. These observations do not atomically lock Docker; the exclusive
test slot and the candidate's own effect-time proof remain prerequisites.

Cleanup verifies exact project and random owner labels before CLI stop/recovery,
checks workload containers and fixture networks are absent, confirms live route
absence and retained storage, then removes only the exact owned disposable volume.
It does not prune images, shared ingress, proxy data, user projects or other volumes.
Uncertain interrupted engine children, unknown ownership or failed cleanup retain
the fixture/claims for explicit recovery and fail qualification. Test captures and
private runtime journals remain on disk intentionally; no deletion of the evidence
directory is implied. Cached images remain shared and are not reclaimed by this run.

Source/offline gates cannot prove Docker inspect compatibility, routing admission,
or actual timing. The optional fixture's actual tmpfs/mount representation and
retirement also require engine acceptance. Before trials, qualify the exact compiled
CLI/compiler and proxy image, then run this protocol in the reserved slot. Until actual matched acceptance
and cleanup pass, `summary.json` must not be presented as product parity or v5
performance evidence.
