# Legacy Compose adoption binding

The private `acquireLegacyComposeAdoptionBinding` API verifies the existing
Compose instance and named data volumes before a future explicit format adoption.
It performs read-only Docker queries and source checks. It does not publish a
candidate, change configuration selection, start or stop workloads, create or
copy data, relabel resources, or change engines. There is no adoption CLI yet.

## Authored identity and storage intent

The owner shares the [import preview](native-config-import.md) source acquisition:
the exact `.hack/hack.config.json` and `.hack/docker-compose.yml` pair, bounded
regular files, strict maintained parsing and private original-byte freshness.
Matching explicit canonical names in both documents are required. There is no
caller-supplied resource name, branch override or directory-name fallback.
Local/dotenv inputs, `.git` file layouts, symlinks, competing input families and
source changes refuse under the same rules as preview.

The pure `planLegacyComposeAdoption` prerequisite retains original field pointers
and positions. It reuses all preview mapping refusals, including unknown fields
in inactive profiles, then qualifies only these additional storage fields:

| Original Compose field | Existing binding |
| --- | --- |
| Nonempty top-level `volumes`, with empty/null declarations | Exact existing `<project>_<logical-volume>` name |
| Volume declaration with only a static `name` | That exact existing name, retaining the logical Compose volume label |
| Service short mount `volume:/absolute/path[:ro\|rw]` | Declared named volume, exact canonical container path and read/write mode |
| Long mount with only `type: volume`, `source`, `target`, optional boolean `read_only` | The same existing volume, path and mode |

Every declared volume must be mounted. Duplicate physical names or container
targets, anonymous/bind mounts, interpolation, path normalization, external
volumes, custom drivers/options, volume subpaths and unknown mount fields refuse.
This prerequisite produces a private identity intent, not a native candidate or
compiler acceptance. The default import command still refuses volumes and mounts.

## Existing resource verification

Bounded queries select all resources bearing the exact Compose project label,
plus expected names that could collide. Unrelated resources are not inspected.
Each service must have exactly one ordinary replica with the exact selected
`.hack` working directory and sole original Compose file label. Extra replicas,
one-offs, missing services, different checkouts, generated override files and
native resource markers refuse. Immutable container IDs and observed names are
retained; names are not regenerated for adoption.

Every requested volume must already exist, have matching project and logical
volume labels, and use the local driver with no driver options. Verification
captures its exact name, creation timestamp and mountpoint. The observed container
mount must use that exact name and mountpoint at the authored destination and
mode. Missing volumes refuse; a fresh empty database cannot satisfy this check.
Every volume remains anchored by a retained container ID that references it.
[Docker volume inspection](https://docs.docker.com/reference/cli/docker/volume/inspect/)
exposes names rather than immutable IDs; creation timestamps alone are not a
sufficient ownership token. Docker [refuses removal of a referenced volume](https://docs.docker.com/reference/cli/docker/volume/rm/),
so retaining and rechecking the referencing container IDs matters.

The existing default bridge network must also match its Compose labels, immutable
ID, creation timestamp and complete selected container membership. Other authored
network policies remain unsupported. Engine ID, resource inventories and source
bytes are rechecked, and acquisition compares two complete private observations.
The Docker routing environment is captured for later comparison. Queries never
request container environment, image configuration or arbitrary labels.

Only counts, a version and `adoption: not_performed` enter the public result.
Frozen non-enumerable `assertFresh` and `resolveBinding` methods retain source
freshness and exact private identities. Callers must pass the current checkout
selection to either method. Private returned binding facts must never enter logs,
public reports, engine labels or unrelated receipts. Cancellation and failures
use fixed redacted messages and the existing bounded child/process-group owner.

## Required generation transition

The separate private `openLegacyComposeAdoptedGenerationStore` prepares versioned
legacy-backed generations under `.hack/.internal/legacy-compose-adoption-v1`.
Preparation self-acquires the same bounded raw source and verified resource
binding, validates the private candidate in memory with the matching compiler,
and synchronizes immutable originals, candidate and binding before committing
its receipt. Public results contain only status and counts. Saved leases verify
the original engine, retained container/network IDs and exact data-volume facts
without reading current authored inputs or managed env/key values. This private
store shares the native generation file and lock owner; native version-one receipt
and manifest contracts are unchanged. Prepared generations do not activate a
format change or grant ordinary native namespace/data-creation authority.

The storage candidate shares the existing closed mappings and preserves authored
mount order. Unsupported shell/interpolation/unset and unknown inactive-profile
fields remain complete-conversion refusals. The default read-only import preview
still refuses storage; this private candidate belongs only to explicit adoption.

The [native generation store](native-compose-generation.md) currently allocates a
different project namespace, generated volume names and native owner labels.
It cannot consume this legacy binding. No caller may treat a verified prerequisite
as permission to send legacy resources through ordinary native startup, whose
ownership check permits missing resources for new projects.

An explicit adoption transaction still needs a versioned generation-owner
contract that consumes this binding, preserves the existing backend and data
names without fabricating labels, and repeats source/resource freshness under
its lease before each effect. Atomic configuration publication, old-client
refusal, recovery/rollback, typed local inheritance, linked-worktree isolation,
advanced lossless mappings and actual application/data readback remain NC04
acceptance work. Rechecks are cooperative; they cannot freeze arbitrary external
editors or Docker mutations. Synthetic probe tests do not qualify live adoption.
