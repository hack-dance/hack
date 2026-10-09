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
Dotenv inputs, symlinks, competing input families and source changes refuse.
Canonical managed-env layers require the version 3 path below; the bounded typed
local mapping uses version 4 and preserves the effective legacy selection.
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
An admitted typed local file selects version 4; existing versions 1–3 keep their
wire shapes and their original local-input refusal.
One static project-owned custom bridge selects resource binding version 3.
Without dependency or health declarations it retains private manifest and
receipt version 6; the closed started/exec-health intersection selects version
10. Both owners refuse generated managed sources, typed local inputs, jobs and
unqualified network shapes. Other receipt versions do not gain this combined
authority; older readers refuse version 10 rather than reinterpret its binding.
Exactly two static project-owned named bridges select private manifest and
receipt version 11 with resource binding version 5. Every bridge declares an
explicit `internal` policy, uses the local bridge driver, and has at least one
closed service attachment. The owner binds each original bridge ID, creation
record, policy, configured bridge IDs and endpoint aliases, and complete live
member inventory. It rechecks those identities before retained effects and
final publication; stopped endpoints may omit aliases but must retain the exact
configured bridge IDs. Default, external, ingress, third-party and additional
bridges, as well as generated sources, health dependencies, jobs and other
unqualified family intersections, still refuse. This version keeps the original
containers and volumes; it does not silently replace either original bridge.
Any later newly created native generation needs its own explicit topology and
data acceptance. Earlier receipt versions retain their narrower authority.

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

The version 5 retained owner, and version 10 when combined with the static
owned bridge, support the closed started/explicit exec-healthy subset above
without recreating containers. They journal the whole original
selection, starts exact original IDs in dependency order, and waits for an
authored healthy edge before starting its dependent. A started edge does not
wait for health; final successful startup still requires every explicit probe
to be healthy. Stop uses reverse dependency order; restart stops in reverse
order before starting through the same readiness gates. Partial graph selection
refuses before a journal or effect. The same ordering applies to explicit
`config adopt --stop` and interrupted stop recovery.

Each effect rechecks the held source, original resource and receipt authority.
Versions 5 and 10 require one finite operation deadline; all source, configuration and
resource reacquisitions use its remaining clock, including final verification.
Fresh bounded original-ID observations and the shared process runner use one
operation deadline and cancellation owner. Failure, drift, cancellation or
unverified final readiness retains the pending journal; only explicit verified
stop recovery can clear it. These rechecks do not freeze external editors or
the engine atomically. Public output remains field/count/status metadata;
capabilities and authored probe arguments are private. Prior versions 1–4 keep
their existing execution behavior, and older upgraded owners refuse version 5
before engine/key reads. Unmodified older launchers still require the previously
documented upgrade boundary. Version 5 does not authorize completed jobs;
container recreation remains unsupported.

The distinct version 7 receipt and manifest support explicitly mapped completion
jobs in a static authored pair with the original default bridge and binding version
1. Names, full container IDs, source/configuration hashes and volume witnesses stay
unchanged. Generated/managed inputs, typed locals, profiles, custom networks, routes
and host hooks remain refused for this family before resource effects or value
acquisition. Jobs require no health check and a disabled observed restart policy
(`no` or the daemon's empty spelling), with zero retries; authored restart omission
stays omitted. Version 6 is reserved for its
separate static-network work and grants no job authority.

Start and restart capture each job's prior daemon `StartedAt` immediately before
an admitted exact-ID start. The successful child and a fresh nonzero UTC timestamp
at nanosecond precision, followed by exited status and exit zero, are required
before starting dependents. Fast jobs need not be observed running. Old exit zero,
equivalent timestamp spellings, unknown facts or a fresh nonzero exit cannot satisfy
completion. The real ordered adapter alone can issue a private one-use completion
bound to this invocation's candidate, resource binding, source capability and
deadline. Injected schedulers, numeric zero, cloned or replayed completions cannot
clear the pending journal. Final publication reacquires all exact workload facts
and rechecks source, receipt, original ownership and the same deadline.

Stop and `down --recover` stop only the original IDs in reverse dependency order;
they never replay jobs. A failed start, cancellation, changed inputs or uncertain
postcondition preserves pending. Restart is an explicit new forward attempt on the
same IDs. Stopped rollback retains data and restores the held legacy pair. These
cooperative daemon observations do not prove hostile-engine resistance, clock
authentication or exactly-once business effects. The finite offline job model and
synthetic owner tests are separate from the required maintained two-worktree SQL,
interruption and cleanup acceptance.

An ordered observer or scheduler refusal can add a fixed
`legacy_adoption_refusal: {stage, reason}` to the JSON error detail. The category
identifies the rejecting boundary without exposing daemon output, resource IDs,
SQL or environment values. It does not assert which effect occurred; other
ownership failures keep the existing fixed generic error.

The maintained `native-compose-adoption-dependency-worktrees` selector exercises
an explicit exec-healthy edge and a short started edge whose target has no health
probe. It uses two original SQL volumes and checks actual ordered ID starts,
unchanged-source partial stop recovery, active-candidate raw drift refusal and
same-identity byte repair, separate rollback and
exact owned cleanup. It requires the current compiled CLI and companion compiler;
it does not qualify completed jobs or container recreation.

## Retained basic builds

The distinct version 9 owner handles existing basic build-only services with
qualified named data volumes and the existing default bridge. Context, relative
Dockerfile and target use the closed import mapping, with current local files
additionally verified. A service must omit `pull_policy`: explicit `build`
requires builder execution and cannot be satisfied by starting an old image.
The owner never builds, pulls, creates a container or substitutes an image during
the format switch or retained execution. Explicit rebuild/recreation requests
refuse. Image-only binding APIs and versions 1–5 retain their prior contracts.
Versions for custom networks, completed jobs and retained files are separate;
their combinations with this first build proof refuse, as do profiles, readiness,
managed/generated inputs, typed locals and literal-dollar build paths.
Pure preview can map a qualified custom bridge alongside a basic build; retained
build adoption refuses that intersection before opening context files, including
inactive workloads.

Included context files, the Dockerfile, optional root and Dockerfile-specific
ignore files, and their safe filesystem identities are privately pinned. The
names-only private env/local layout refusal precedes the context walk and is
rechecked afterwards; known private material added mid-walk is never opened as
an included file. A Dockerfile-specific ignore file takes precedence, while presence and bytes of
both files remain bound. The pinned `@balena/dockerignore` Moby port handles only
the qualified case-sensitive grammar: literal normalized paths, `!` negation,
bare `**`, blank lines and comments. Other globs, escapes, BOMs and ambiguous
paths refuse. Every possible adopted-owned path must be excluded by the effective
rules, including Git markers, `.hack/.internal`, `.hack/.branch` and the switched
authored files. Excluded subtrees are not read. Parent negations include
descendants: `**` followed by `!.hack` does not isolate future private outputs.
Such a context refuses unless later literal exclusions close those paths.
Root and `.hack` contexts can qualify through these exact exclusions.

The maintained `native-compose-adoption-build-worktrees` acceptance explicitly
requires Buildx's default Docker driver, `DOCKER_BUILDKIT=1` and
`compose build --builder default` for fixture bootstrap. It never creates or
bootstraps a separate builder. Its private fixed-stage evidence retains the
complete fatal-decoded synthetic COPY reply before applying the unchanged file
and hash oracle. This separates builder qualification from source/image guards;
it does not infer which builder caused an earlier failure or prove cache ownership.

One acquisition is limited to 16 builds, depth 32, 256 captured entries, 4096
directory names, 16 MiB of bytes and a 48 KiB private proof; the existing stable
file owner also limits each file to 1 MiB. Included byte, identity or mode changes,
included additions/removals, ignore presence changes and unsafe paths refuse.
Same-inode exact byte repair can restore a saved proof; it does not repair a
strict prepared authored-source timestamp or make editor races atomic.

The selected read-only Compose query supplies each original image reference.
Container IDs and birth, image IDs and birth, and current tag resolution must
match the privately saved observation, along with the existing config hashes,
mounts, network identity and volume creation identities. No image environment,
command or layer contents are read. These facts attest the current retained
image and current included source separately; they do not establish which source
historically built that image. Missing images or retargeted tags refuse before
effects. No image ownership for removal is granted by this proof.

Preparation, dry-run and saved execution use the same closed owner. Public output
contains field provenance and counts, never context hashes, image references or
private capabilities. Version 9 requires a finite remaining mutation deadline,
the whole original selection and the existing signal/process-group owner.
Starts, stops and recovery consume original IDs; source or image drift retains
pending evidence. Rollback restores the exact original authored inputs after
verified stop and keeps their original data. Older upgraded owners that know
only versions 1–5 refuse the new proof; this is not a universal old-launcher
fence. Current Moby/BuildKit ignore parity and maintained two-worktree SQL,
image/ID/birth, recovery and rollback acceptance qualify this slice separately
from pure preview and synthetic model controls. Full NC04 remains open.

The maintained `native-compose-adoption-build-worktrees` scenario requires
explicit selection. It bootstraps two disposable Postgres images, checks the
complete `COPY .` projection for root/Dockerfile-specific and default `.hack`
contexts, and then permits only captured metadata queries and journaled original-ID
starts/stops. Format switch and saved consumption cannot reach a builder. Its
source and candidate drift controls retain pending ownership, preserve the other
worktree's SQL row, and restore both original configurations through rollback.
Exact fixture image removal requires its captured new ID/birth, sole tag, fixture
label, unchanged daemon and no remaining container references. A local final
image may expose one digest for that exact repository and captured image ID;
other digest aliases refuse. The fixture privately journals the exact new
image graph after each bootstrap build. Only fixture-labelled, untagged parents
on its complete chain to the captured original base qualify for disposal, in
child-before-parent order with nonforce `image rm --no-prune`. A builder exposing
no parent qualifies only its single final object. Unexplained new images, foreign
labels or references retain the failed fixture. Full original image inventory
and tags must be restored; inventory bounds are not relaxed for new objects.
General builder cache is retained; cache reclamation and historical image-from-source provenance remain
unqualified. Fixture source/model checks alone do not establish live builder or
data-preservation acceptance.

The version 4 typed-local slice reads optional `.hack/hack.local.json` at the
selected checkout and verified inherited primary in the same issued private source
acquisition. It accepts only `schema_version: 1` and an optional `environment`
container with `default_overlay`; an empty environment container inherits, explicit
`null` selects base, and a canonical string selects that overlay. The existing Rust
compiler resolves project, primary and checkout precedence. The final selection
must equal the actual legacy default; adoption does not silently apply a different
local selection. Unsupported routing, open, host-binding or other fields refuse
even when a later layer would shadow them. Ordinary import preview still refuses
typed locals. Existing inheritance opt-out, CI and slim exclusions omit primary
acquisition rather than reading an excluded scope.

The private projection version 2 proof binds local presence, raw bytes, device/inode,
mode, link count and owner alongside the existing Git-family and ordered generated
source proofs. In-flight reads also check timestamp stability. Saved execution and
rollback recheck without keys or decryption; an exact byte repair on the same safe
inode can restore a saved proof, while replacement, addition or removal refuses.
Public provenance contains document roles, field pointers, positions and mapping
status; local selections and digests remain private. Older upgraded owners refuse
version 4. This does not extend the selector guard to unmodified old launchers or
make editor races atomic. Original generated bytes, Compose configuration hashes,
resource IDs and named data volumes must remain unchanged. Synthetic and compiled
controls qualify this mapping separately from a maintained live typed-local SQL
adoption/recovery/rollback gate.

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

The selected Compose bridge must match its project and logical labels, immutable
ID, local bridge driver, internal policy and creation timestamp. Versions 6 and 10
require one explicitly named, project-owned, non-default bridge with one
explicit attachment per service and static, unique aliases. Every retained
original must configure that exact network ID; active endpoint membership must
exactly match the running originals. Its active endpoint aliases must equal
the authored aliases plus the original container and service names.
Stopped originals remain bound through their configured network IDs even though
Docker removes their active endpoints. A stopped owned-bridge endpoint may expose
no aliases, but cannot acquire a different configured network ID. This transient
running state is not saved in the resource binding. Other authored network
policies remain unsupported. Version 11 applies the same exact per-bridge proof
to two distinct original named bridges, checking each complete live member set
and each service's closed one-or-two-bridge attachment and aliases. Neither a
shared network ID nor a partial member observation can stand in for the other
bridge. Engine ID, resource inventories and source
bytes are rechecked, and acquisition compares two complete private observations.
The Docker routing environment is captured for later comparison. Queries never
request container environment or full image configuration; version 9 additionally
reads the minimal image reference, ID and birth described above. This retained-resource authority
keeps the original bridge and container IDs through stop, saved restart,
recovery and rollback; it does not authorize a later newly created native
generation to take over those identities. That transition needs a separate
topology and data acceptance proof.
Execution admission also
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

`hack config adopt` requires all original containers stopped. It refuses unsupported typed local
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
broader typed local inheritance, recreation and application migration.

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
