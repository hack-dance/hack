# Legacy Compose adoption

The private `acquireLegacyComposeAdoptionBinding` API verifies the existing
Compose instance and named data volumes. That acquisition remains read-only.
The separate explicit `hack config adopt` owner can switch a qualified stopped
instance to native authored selection while retaining its original resources.
`hack config adopt --dry-run` reports field provenance, compiler admission and
existing-resource counts without writing private state or active inputs. Neither
path copies data, creates replacement volumes, relabels resources or changes engines.

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
request container environment or image configuration. Execution admission also
compares Compose configuration hashes from the saved static source with the
engine-created `com.docker.compose.config-hash` label on each original container.
Those private digests never enter reports, authored files or resource labels.

Only counts, a version and `adoption: not_performed` enter the public result.
Frozen non-enumerable `assertFresh` and `resolveBinding` methods retain source
freshness and exact private identities. Callers must pass the current checkout
selection to either method. Private returned binding facts must never enter logs,
public reports, engine labels or unrelated receipts. Cancellation and failures
use fixed redacted messages and the existing bounded child/process-group owner.

## Explicit stopped transition

The separate private `openLegacyComposeAdoptedGenerationStore` owns versioned
legacy-backed generations under `.hack/.internal/legacy-compose-adoption-v1`.
Preparation self-acquires the same bounded source and resource binding, validates
the private candidate in memory with the matching compiler, and synchronizes
immutable source copies, candidate and binding before committing its receipt.
Public claims contain status and counts; private identities and callbacks are
not serialized. Orphan preparations are retained as evidence after a refused
transition. The native version-one receipt and manifest contract is unchanged.

`hack config adopt` requires all original containers stopped. It refuses local,
dotenv or managed-env inputs, linked/separate Git layouts, selected profiles,
unsupported source mappings and changed source/resource ownership. It never
silently stops a running instance. Both authored documents must carry matching
explicit canonical project names. Shell strings, interpolation and unset/empty
ambiguity remain refused; qualified argv, empty entrypoints, static empty values
and authored mount order are retained.

The receipt commits `switching` before either legacy input moves. The owner holds
the exact original inodes and bytes in its private generation, installs the
qualified candidate without overwriting an existing path, records its identity,
and only then commits `active`. Every pathname transition and receipt replacement
is checked and synchronized. Upgraded project discovery refuses pending
publication before it can select ancestor Compose inputs or write legacy files.
An active adopted receipt remains a selection boundary even if its candidate is
removed; missing or edited candidates refuse execution.

The distinct execution owner consumes the saved binding. It never sends these
resources through ordinary native startup, which allocates a different Compose
namespace and native volume names. `up`, `restart` and `down` start, restart and
stop only the original container IDs. `down` retains those containers, their
network and volumes as data anchors. `ps` reports workload names and status;
plain `logs` and `exec` use the verified retained container. Recreation, `run`,
changed instance/overlay/profile selections, routing and host-hook migration are
unsupported. Original legacy objects never receive native nonce labels.

A retained-container mutation is journaled before its engine child starts.
Nonzero exit, cancellation, missing resources or failed postconditions leave it
pending. `hack down --recover` explicitly stops the complete original selection
and clears pending execution only after verified stopped completion. OS signals,
TTY/stdin forwarding, deadlines and process-group cleanup use the existing
shared runner. The store's AbortSignal is a cooperative admission/recheck control;
it does not independently terminate a caller-owned engine callback.

## Rollback and interruption recovery

After the original containers are stopped, `hack config adopt --rollback`
journals `rolling-back`, holds the installed candidate and restores both exact
legacy originals. Link-before-unlink restoration cannot overwrite another file;
a known two-link intermediate is recoverable. The owner verifies original
resources before committing `rolled-back`. No volume or container is removed.
Conflicting external bytes, invalid private files or lost bindings refuse and
retain recovery evidence instead of overwriting edits.

`hack config adopt --recover` explicitly recovers a proven dead same-boot lock
and completes a pending switch. Add `--rollback` to restore a pending switch or
rollback. Discovery and ordinary operations stay fenced while either transition
is pending. This is cooperative publication, not an atomic freeze of arbitrary
editors or Docker mutations.

Unmodified v4 clients cannot be universally fenced: they ignore future legacy
versions and may select ancestor Compose inputs. Adoption requires the upgraded
selector/launcher boundary. Configuration rollback must restore the held legacy
pair and verify the original data binding before using an older client; installing
an old executable alone is not rollback.

Full NC04 remains open for typed local inheritance, linked-worktree isolation,
advanced lossless mappings, recreation and application migration. Synthetic
probe/interruption tests do not prove live data preservation; actual disposable
engine/data readback and process-kill boundaries require separate acceptance.
