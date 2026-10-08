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
Typed local settings, dotenv inputs, symlinks, competing input families and source
changes refuse. Canonical managed-env layers require the version 3 path below.
The private adoption owner additionally accepts exact-root linked Git checkouts
verified through the existing bounded Git owner. Separate Git directories and
nested project roots remain outside this linked-checkout slice; ordinary import
preview still refuses `.git` files.

Static linked checkout receipts use private version 2. They bind the raw `.git` pointer,
administrative backlink and common-directory pointer, together with the held Git
administrative, common and primary directory identities. Pointer edits, redirected
paths, replaced directories and lost linkage refuse before publication or engine
effects. These private identities and digests never enter public reports. Existing
static directory checkout receipts retain version 1 and their original wire shape.
Canonical generated-source adoption uses version 3 in either qualified layout.

The static retained-container slice also inspects relevant filenames in the
verified primary checkout when local inheritance is enabled. Managed-env,
dotenv, typed local settings and legacy extra-host aliases refuse without reading
their contents. The existing explicit `inherit_local: false`, CI and slim-runner
exclusions still exclude that primary scope. Inherited inputs added after
preparation refuse publication or later retained-container mutations; they cannot
be silently applied or ignored by a fresh migration. The version 3 owner below
qualifies canonical generated sources and managed layers separately.

A private read-only prerequisite now acquires managed values for a strict legacy
source capability. `LegacyAdoptionManagedEnvAdmission` binds the selected source,
verified inherited primary, overlay, declared scopes and runner exclusions.
`acquireProjectEnvForLegacyAdoption` shares the native owner's bounded raw-layer
acquisition, precedence, tombstones and existing key/decryption owner. Selected
managed syntax uses the strict importer parser and a closed field mapping;
alternate inputs and unknown scopes refuse. Metadata needs no key or decryption,
and values and freshness callbacks must remain private runtime inputs. Neither
raw values nor callbacks enter public reports; only names-only metadata is
serializable. Rechecks detect changed raw bytes
before and after value delivery; they do not freeze editors. These APIs grant no
write or engine authority. The version 3 adoption owner consumes this acquisition
with ordered generated provenance and durable raw-byte rechecks. Its maintained
managed inheritance acceptance remains separate from the static Docker evidence.

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
`.hack` working directory and original Compose file label. Version 3 additionally
requires the exact ordered canonical runtime and managed-env file labels. Extra
replicas, one-offs, missing services, different checkouts, alternate generated
fragments and native resource markers refuse. Immutable container IDs and observed names are
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
ID and creation timestamp. Every retained original must configure that exact
network ID; active endpoint membership must exactly match the running originals.
Stopped originals remain bound through their configured network IDs even though
Docker removes their active endpoints. This transient running state is not saved
in the resource binding. Other authored
network policies remain unsupported. Engine ID, resource inventories and source
bytes are rechecked, and acquisition compares two complete private observations.
The Docker routing environment is captured for later comparison. Queries never
request container environment or image configuration. Execution admission also
compares Compose configuration hashes from the saved ordered sources with the
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

`hack config adopt` requires all original containers stopped. It refuses typed local
settings, dotenv, unverified linked or separate Git layouts, selected profiles,
unsupported source mappings and changed source/resource ownership. It never
silently stops a running instance. Add explicit `--stop` to journal and stop all
verified original IDs before the format switch. `--dry-run --stop` qualifies that
proposed stopped transition without changing containers or files. Both authored documents must carry matching
explicit canonical project names. Implicit shell execution, unpaired-dollar
interpolation and unset/empty ambiguity remain refused; qualified array and
bounded Compose string exec words, explicit empty entrypoints, static empty
values and authored mount order are retained.

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
namespace and native volume names. `up --detach`, `restart` and `down` start, restart and
stop only the original container IDs. `down` retains those containers, their
network and volumes as data anchors. `ps` reports workload names and status;
plain `logs` and `exec` use the verified retained container. Recreation, `run`,
attached startup, changed instance/overlay/profile selections, routing and host-hook migration are
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

A failed or partial prepared stop keeps both legacy originals selected in its
private journal and fences ordinary discovery. `hack config adopt --recover --stop`
rechecks the complete original selection, explicitly retries its stop, and only
then publishes. Changed sources, resources or config hashes refuse recovery.

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

Disposable Compose/PostgreSQL acceptance on macOS verified the original SQL row
after adopted execution and rollback, retained container/network/volume anchors,
an interrupted partial stop, process-killed switch and rollback repair, candidate
edit/removal refusal, exact original-file inode restoration and owned cleanup.
These observed boundaries supplement the synthetic probe/interruption tests.
That static-source acceptance does not qualify version 3 managed inheritance or
the refused mappings, recreation, application migration, or an atomic freeze of
external actors.

The maintained `native-compose-adoption-worktrees` Docker scenario exercises two
real linked checkouts with distinct canonical Compose names, original PostgreSQL
volumes and stored SQL rows. It checks inherited primary local-env refusal before
adoption state, then qualifies the static source pair while that unsupported local
input is withheld. Partial-stop repair, retained-container execution and rollback
must preserve the other checkout's source inodes, bytes, resource IDs and SQL row.
Stopped originals remain bound, and unsupported recreation through `run` refuses.
Cleanup uses only captured, reverified original IDs and volume creation facts.
Failed acceptance retains its disposable sources and isolated home for inspection;
retention alone does not prove engine cleanup succeeded.

Run it with the current compiled CLI and adjacent matching compiler, a Linux
Docker daemon and cached `postgres:17.6-alpine` image:

```sh
HACK_E2E_CLI_BIN=./dist/hack HACK_E2E_DOCKER=1 HACK_E2E_REQUIRE_DOCKER=1 HACK_E2E_KEEP=1 \
  bun tests/e2e/run.ts --only=native-compose-adoption-worktrees
```

This fixture distinguishes static isolation from successful typed inheritance;
its inherited-input refusal does not qualify migration of generated Compose
overrides or managed values. The maintained scenario passed on macOS against a
Linux Docker daemon: both original SQL rows and resource identities survived
partial-stop repair, adopted execution and separate rollback. Exact owned cleanup
and an independent inventory check restored the original engine baseline.
Each later fixture inspection acquires a fresh bounded probe; a probe owner has
one aggregate acquisition deadline and cannot span the entire lifecycle.

Canonical generated-source adoption uses private receipt version 3. It qualifies
the exact ordered base, runtime-metadata and managed-env inputs against the
existing writer projections and the original containers' engine-created
`config_files` and configuration hashes. The managed default/overlay and inherited
primary/current local layers use the existing precedence, tombstones and opt-out
policy. Alternate generated fragments, branch fragments, interpolation inside
managed values and typed local settings remain refused.

Metadata, initial private values and the saved raw-layer revision share one bounded
acquisition. The compiler receives deterministic runtime fallbacks and names-only
managed metadata. The private manifest stores file identity and raw-byte proofs;
it does not copy decrypted managed values. Saved leases, stop repair, publication
and rollback recheck those same layers and original generated files without key
lookup or decryption. They retain the original resource IDs, volumes and generated
files, and preserve both legacy originals for rollback. Raw-byte or selection
drift, unsafe managed-file permissions, generated-file identity changes, and
original-resource drift refuse before a new
effect; drift after an effect retains pending evidence. Rechecks do not freeze
external editors or the engine. Old version 1/2 receipts remain readable; earlier
upgraded owners refuse version 3 through the existing selector boundary.

The version 3 synthetic publication, saved-readback and raw-drift controls are
separate from the earlier static linked Docker qualification. Successful managed
linked adoption, original SQL fidelity, recovery, rollback and exact cleanup still
require maintained live acceptance. Full NC04 remains open for the refused maps,
typed local inheritance, recreation and application migration.

The separate `native-compose-adoption-managed-worktrees` Docker scenario prepares
both linked instances through the existing managed env and canonical override
writers under an isolated home. It checks default/overlay and primary/current
local precedence, service scopes, an encrypted synthetic value, empty values and
tombstones through silent assertions in the original containers. Partial-stop
repair must refuse changed inherited bytes before another stop; after exact
repair, execution and separate rollbacks must preserve both original SQL rows,
resource identities, shared primary inputs and generated files. It shares the
static fixture's exact ownership and daemon checks for cleanup.

Use the same prerequisites and flags as above with
`--only=native-compose-adoption-managed-worktrees`. Registration and synthetic
fixture controls do not establish a live pass.
