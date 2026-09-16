# Private guest storage inventory

`runtime guest-disk-usage --json` observes images, containers, volumes and build
cache through the verified private engine. It requires an already-running owned
pool and does not start one. The observer verifies native guest identity around the
bounded request, verifies the pinned engine version/platform, and uses the existing
private Unix transport with no proxies, redirects or retries.

The pinned engine's `/v1.53/system/df?verbose=true` response uses `ImageUsage`,
`ContainerUsage`, `VolumeUsage` and `BuildCacheUsage` summaries. A live discovery
against the stopped-then-explicitly-started isolated pool established this shape;
the older flat `LayersSize/Images/Volumes` layout is not silently assumed. Discovery
evidence is `.hack-local/review/wu07/guest-storage-discovery-1789594862699272000/`.
Only response shape/numeric metadata was retained, and the pool was stopped afterward.
The [Docker Engine API reference](https://docs.docker.com/reference/api/engine/version/v1.53/)
is the upstream interface reference; the pinned live response is the qualification
source for this implementation.

The report exposes category counts and engine byte estimates, plus allowlisted
image/container/cache identifiers and volume names, sizes and container-reference
counts. Commands, labels, tags, mount paths and network metadata are omitted.
Missing or `-1` item size/reference measurements remain unknown rather than becoming
zero. Empty engine summaries use their zero-value counts. Missing categories,
duplicate identifiers, count/item mismatches and malformed values refuse a report.
Each category is limited to 4096 items, and the underlying response is capped at
4 MiB with a ten-second request timeout.

Engine-reported reclaimable bytes are observations, not cleanup authority. A volume
with zero container references may be retained in a graph receipt for later restore;
this command does not yet classify those retained references. Similarly, images can
remain intentionally cached even when no current container references them. Image
layers, container root filesystems and guest/host allocated blocks overlap and must
not be added as if they were independent exclusive byte counts. Results are not an
atomic snapshot of a changing engine.

The command performs only GET requests and does not invoke prune, remove volumes,
retire graph receipts or alter the configured retention policy. WU12 still requires
joining this inventory to durable graph/branch ownership and reservations before
proposing safe retirement. Cache completeness, active installer ownership, branch
reuse and evidence/export retention remain separate requirements.

## Live qualification

Evidence: `.hack-local/review/wu07/guest-storage-1789595196844768000/`.
Isolated candidate SHA-256:
`607cff4f45d081e608f02e57eb002ec5059b797e564728a6991251708f0189a4`.
The exact recorded protocol compares every category's count, total-byte estimate
and reclaimable-byte estimate with a separate direct engine GET in five lifecycle
states. No proxy, authority or application credentials were needed for this fixture.

| State | Containers | Data volumes | Data volume container references | Data volume bytes |
| --- | ---: | ---: | ---: | ---: |
| Before graph | 0 | 0 | — | — |
| Running | 2 | 1 | 1 | 36 |
| Compute removed, data retained | 0 | 1 | 0 | 36 |
| Restored | 2 | 1 | 1 | 36 |
| Explicit owned data cleanup | 0 | 0 | — | — |

The retained volume was reported as reclaimable by the engine while its graph
still needed it. Restore reused it and returned the original synthetic data token.
That is a concrete counterexample to treating zero engine references or reclaimable
bytes as permission to prune. The single pinned image (252,443,579 engine bytes)
was also intentionally retained and reused, including when the engine classified
its bytes as reclaimable with no containers.

Calling the command while stopped refused and left the pool stopped. Five live
reports matched the direct engine summaries; owned-volume cleanup and graph
archive/export/reconcile passed. All six watchdog samples met pressure/swap/headroom
requirements. The VM ended stopped and protected global hashes were unchanged.
Source/evidence inputs remain retained; no generic image, volume or host-file prune
was executed. No performance comparison follows from these inventory observations.

Required default/all-feature Rust tests, strict Clippy, release build and Bun
checks passed (940 tests pass, 5 skip), along with CLI reference generation. Parser
regressions verify omission of command/label/path sentinels, unknown usage values,
missing categories, inconsistent counts and duplicate IDs. The actual application
plan refresh in `.hack-local/review/wu07/guest-storage-application-1789595228207084000/`
remains 14 services, 22 errors and two warnings with unchanged source/config and
dirty-state fingerprints. Application startup, credentials, reload, terminals,
route translation and matched resource parity remain open.
