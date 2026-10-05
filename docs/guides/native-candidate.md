# Opt-in native candidate bundle

`hack-native` is an experimental Apple Silicon macOS executor installed alongside
Hack's supported CLI. It does not replace `hack`, select a Docker context, migrate
projects, or install DNS or trust automatically. Its graph commands support a
bounded subset;
this bundle is not application parity or release qualification.

Build with the repository's pinned Bun 1.4.2, Rust 1.97.1 and Zig 0.15.2 toolchain, Python 3,
and the Rust `aarch64-unknown-linux-musl` standard library already installed. The
build refuses missing prerequisites; it does not install toolchains:

```sh
mise exec -- scripts/build-native-candidate.sh /absolute/new/hack-native-bundle
```

The destination must not exist. The bundle contains `hack-native`, the static Linux
ARM64 `hack-relay-guest`, compiled normal CLI `hack-cli`, the `hack-v5` entrypoint,
provider pins, this guide, and `SHA256SUMS`. The relay uses
the committed guest Cargo lockfile and Zig linker wrapper, with a separate build
target directory. Packaging verifies its ELF architecture and absence of an
interpreter or shared-library requirements before publishing the bundle. It contains no provider installation, runtime
state, project data, or credentials. It can be copied outside the source checkout;
Rust, Zig, Bun and the checkout are not needed to run the resulting executable.
Host system utilities and the pinned provider remain runtime prerequisites.
For versioned candidate packages, channel rules and publishing gates are described
in the [prerelease guide](https://github.com/hack-dance/hack/blob/next/docs/guides/prereleases.md),
and the separate `hack-next` installation path is described in the
[candidate installer guide](https://github.com/hack-dance/hack/blob/next/docs/guides/candidate-install.md).
The build re-signs the final compiled frontend with a local ad-hoc signature and
strictly verifies both macOS executables before generating checksums. This checks
code integrity; an ad-hoc signature does not establish a publisher identity or
provide Apple notarization. Verify `SHA256SUMS` after copying the complete bundle.
`hack-relay-guest` runs inside the Linux guest, not on macOS. For graph dependency
selections, set `artifact` to this bundled file's absolute path and
`artifact_sha256` to its entry in `SHA256SUMS`; the runtime verifies it again before
delivery. The `native-stream-relay` feature does not replace this dependency relay.

Verify the copied bundle, create a dedicated home, and explicitly select it:

```sh
cd /absolute/copied/hack-native-bundle
shasum -a 256 -c SHA256SUMS
mkdir -m 700 /absolute/private/candidate-home
./hack-native --candidate-root /absolute/private/candidate-home info --json
./hack-native --candidate-root /absolute/private/candidate-home --version
```

The home must already exist, be owned by the current user, and have mode `0700`.
Use its canonical absolute path without symlink components (on macOS, use
`/private/tmp` rather than `/tmp`). Every command requires this explicit home,
including help and version. Its `checkout` field is the historical receipt name
for this stable home; `channel` reports `installed-candidate`. State remains under
`<home>/.hack-local`. Keep this home fixed across binary upgrades: receipts and
child processes bind to its identity. Moving an executable is supported; moving
an active home or adopting another installation's state is not.

Run the normal project CLI through the bundle's `hack-v5` entrypoint:

```sh
export HACK_NATIVE_HOME=/absolute/private/candidate-home
/absolute/copied/hack-native-bundle/hack-v5 ps --path /absolute/project
```

Keep the bundle together and invoke this entrypoint by its full path (do not copy
or symlink only the script). It selects the adjacent executor even if inherited
backend variables select another binary. It preserves arguments, exit codes and
signals through `exec`, and never replaces the installed `hack`. Project-specific
native adaptation, dependency and routing selections remain explicit; this entrypoint
does not prepare a provider or migrate existing projects. An unversioned local
build reports the repository package version. A versioned prerelease build reports
its explicit candidate version and includes source provenance. The `hack-v5`
entrypoint alone does not identify a published release. Unsupported native workflows still
report their existing refusal rather than falling back to Docker.

Native `up` accepts an explicit branch or the branch inferred from a linked Git
worktree when its exact source root can be shared with a fresh or matching pool.
The runtime checks source compatibility before startup hooks; `restart` repeats
this check before stopping the existing graph. A different root in an occupied
pool is refused. This does not dynamically add mounts to a running VM: simultaneous
worktrees with different source roots still require separate pools.

Unfiltered writable source sharing still requires `HACK_NATIVE_SHARED_SOURCE=1`.
An exact repository at `$HOME/.codex/worktrees/<id>/<repo>` is allowed only when
bounded Git registration metadata verifies its worktree root, common directory and
backlink. The enclosing Codex directories are never exported. Sensitive ancestors,
aliases and unsafe ownership or permissions remain refused.

The internal planning path accepts a canonical lowercase DNS-label `--branch`.
It gives each checkout/branch pair a separate enrollment and source namespace;
omitting the selector preserves existing base-instance identities. The frontend
rewrites declared project, service, legacy and OAuth route names after applying
native aliases, then carries the same branch selector through original review,
normalized review, source capture and execution review. Original Compose files
and private environment values are unchanged. Hostnames outside the configured
project bases remain explicit, unchanged claims; normal route collision checks
still apply. A same-checkout branch namespace does not create an isolated source
tree. These planning contracts do not qualify multiple independent source roots
inside one VM pool.

An existing frontend branch mapping may retain a graph admitted before native
branch namespaces. If its current scoped review differs, the frontend first
checks native selection against that exact saved run, owner, namespace and plan:
restore selection for a stopped graph, or authenticated service selection for an
active graph. A native unbranched review of the same canonical project and unchanged
original Compose must then return the saved namespace. Only that retained run
continues with unbranched review and execution arguments and keeps its original
adapted route labels, before branch hostname rewriting. This preserves legacy
source contracts that did not enroll hostname changes. The selected generation,
restore selection and shared-source semantic compatibility are checked again
before admission; mappings, graph receipts and ownership namespaces are not
rewritten. Active legacy restart also rechecks its service, container, boot and
receipt generation after compatibility review, before cleanup eligibility. A
changed selection refuses before stopping the graph. This preflight check does
not make cleanup atomic with that generation; existing ownership and frontend
finalization checks still apply. Fresh and already branch-scoped graphs keep
their normal branch namespace. This compatibility path does not authorize
adopting an unrelated branch or project.

## Manual candidate upgrade and rollback

Manual candidate bundles are selected by their full path. The separate
[prerelease installer](https://github.com/hack-dance/hack/blob/next/docs/guides/candidate-install.md) manages verified versioned selections
with independent homes; it does not migrate runtime data. `hack-v5 update` refuses before discovering an
installed binary or contacting a release server; install a separately reviewed,
complete bundle to change the candidate.

1. Keep the previous complete bundle and its `SHA256SUMS`. Copy the new bundle into
   a separate directory and verify every checksum before using it. A checksum
   failure or incomplete copy is a failed installation; preserve it for inspection.
2. Retain application data with ordinary `down` for each owned graph, confirm its
   foreground owner and host processes have retired, and stop the owned candidate
   runtime. Keep existing bundles in place while any of their child processes live.
3. Select the new bundle's `hack-v5` by its full path with the same canonical
   mode-`0700` `HACK_NATIVE_HOME`. Check its `info` identity and update any explicitly
   selected guest-relay artifact paths to the verified complete bundle. Normal
   frontend `up` validates the retained selection offline, resumes its clean owned
   VM once if stopped, and then repeats live retained-data and restore-generation
   checks. Restore the application and read back a saved data marker before accepting
   the upgrade.
4. For rollback, retain-stop the new candidate in the same way, select the previous
   verified bundle with the same home, and repeat application/data readback. A prior
   binary refusing newer state is an unsupported downgrade, not a successful rollback.
   Preserve that state; do not rewrite receipts or adopt another home's data.

Host cleanup or a reboot can remove the temporary `/private/tmp/hkl-<owner>` HOME
alias while the private candidate home and disks remain intact. Normal commands
report `provider_home_missing`; they do not initialize another pool or recreate the
alias during observation. Explicit `runtime recover --json` can restore only that
absent exact alias, after verifying the receipt-bound dead provider, both recorded
disks, free VM lock, closed disk handles, and no active provider command. Existing
files, directories, foreign links, a live or reused PID, and uncertain ownership
refuse without replacement. Recovery rechecks the receipt before exclusive creation,
then validates socket absence and flushes the disks before recording
`recovered-unclean`. If those final checks fail, it reports
`provider_home_restored_recovery_incomplete`, keeps the exact owned alias and retained
data, and requires inspection before retry. No guest is started by alias recovery.
Interrupted starts without a recorded process or both identified disks remain
outside this repair path.

A physical macOS reboot may also renumber the mounted filesystem device. Strict
disk and source checks still refuse a changed device number; missing-HOME recovery
does not waive them. For an offline **stock pool**, inspect the separate migration:

```sh
./hack-native --candidate-root /absolute/private/candidate-home runtime host-filesystem-recovery --json
./hack-native --candidate-root /absolute/private/candidate-home runtime recover-host-filesystem --expect-sha256 <selection_sha256> --accept-legacy-device-rebind --json
./hack-native --candidate-root /absolute/private/candidate-home runtime recover --json
```

Review the inspection before selecting its hash. This explicit legacy migration
requires an absent recorded provider whose start predates the current host boot,
no active provider commands, exclusive existing operation/VM locks and closed disk
handles. Both disk inodes, sizes and ext4 UUIDs, the exact source path/inode and its
ownership must be unchanged; only one common old-to-new device-number change is
allowed. The inspection is read-only. Publication atomically changes only the
owner's disk and source device numbers, retaining its phase and process record.
Normal commands keep their strict identity checks.

Legacy receipts have no original host boot UUID or filesystem volume UUID. Calendar
timestamps corroborate a reboot, and matching retained file identities constrain
the migration, but neither proves original volume continuity. The opt-in explicitly
accepts that limitation; copied or relocated pools are outside this procedure.
Prepared-base pools and pending owner/network/activation updates require separate
recovery and are refused. A torn owner publication preserves `owner.pending` and
blocks another migration; do not delete or adopt that file manually.

This does not start the VM, restore HOME, retire stale sockets or rewrite historical
graph receipts. Use ordinary recovery afterward. Historical shared-source graphs
retain the prior identity and may require verified cleanup plus a new generation;
successful metadata migration alone does not establish application recovery.

After that explicit provider recovery and one audited VM boot, a retained graph
from the immediately preceding guest boot can still carry old host device numbers
in its publisher, relay-control, and dependency-socket receipts. Inspect and select
one run's host-pin recovery separately:

```sh
./hack-native --candidate-root /absolute/private/candidate-home graph inspect-host-pin-recovery --run-id <run-id> --json
./hack-native --candidate-root /absolute/private/candidate-home graph recover-host-pins --run-id <run-id> --expect-selection <selection_sha256> --accept-legacy-device-rebind --json
./hack-native --candidate-root /absolute/private/candidate-home graph recover-cleanup --run-id <run-id> --expect-receipt <original_receipt_sha256> --json
./hack-native --candidate-root /absolute/private/candidate-home graph retire-recovered-publisher --run-id <run-id> --expect-owner <owner> --json
```

The first command only inspects. The second publishes a private, exact-run
witness before cleanup; it changes no graph, publisher, control, or dependency
receipt. It requires the provider's repaired current disks/source, unchanged
recorded inodes and raw receipts, dead owners whose recorded starts precede the
current physical host boot, refused socket listeners, and the immediate guest
boot transition. It also binds retained volume names and actual labels. Cleanup
and retirement can use the witness only for those selected old pins; ordinary
reads and later publisher generations remain strict. Missing or foreign pins,
active listeners, changed resources, pending journals, or further guest boots
refuse without adopting another run. A completed older cleanup journal is
retained as history and does not itself block a later selected generation.

Legacy receipts do not identify the original APFS volume. This explicit
device-number rebind cannot prove pre-reboot volume continuity. Completing these
commands retains the old run's data and proves cleanup of its dead generation;
it does not migrate `graph.source.shared`, restore the application, establish
route readiness, or claim overall v5 acceptance. Same-run source continuity
requires a separate explicit witness-bound transition after cleanup and
publisher retirement. If macOS removed the foreground or relay-control
directory itself during reboot, this command refuses: the old pin receipts no
longer exist, and absent pathnames cannot stand in for their recorded owner
identities. That case requires a separate selected absence-recovery procedure.

When a **physical host reboot** removed both the deterministic foreground
publication root and this run's relay-control root, inspect the distinct
absence path with the private original provider Owner and its exact
pre-migration host-filesystem inspection:

```sh
./hack-native --candidate-root /absolute/private/candidate-home graph inspect-absent-publication-cleanup --run-id <run-id> --original-owner-file <private-original-owner.json> --host-inspection-file <private-inspection.json> --json
./hack-native --candidate-root /absolute/private/candidate-home graph recover-absent-publication-cleanup --run-id <run-id> --original-owner-file <private-original-owner.json> --host-inspection-file <private-inspection.json> --expect-selection <selection_sha256> --retain-data --accept-unpinned-post-reboot --json
```

Inspection does not create a publication root. A failed selected action can
leave only its private lock reservation; inspection recognizes that exact
lock-only state. Recovery locks the foreground publication before acquiring
the VM lease, then durably records the selected absence before any cleanup.
It retains volumes, verifies the stopped receipt, and records a separate
absent-publisher retirement. Ordinary publication and cleanup cannot infer
ownership from missing paths. The old foreground PID and original physical
volume are not proved by legacy graph receipts; this path requires explicit
acceptance of that post-reboot limitation and refuses a changed boot, present
or foreign publication, stale selection, pending state, or changed resources.
An interrupted recovery can resume only its exact selected intent on the same
host and immediate guest boot. A later successful restore treats this witness
as history; it never grants cleanup of the new generation.

This operation does not change historical shared-source device identity.
Source-mounted projects require the separate selected source-continuity step
before normal same-run restore. The command's stopped/data-retained result is
not proof of application startup or routing.

The frontend project-run mapping also records directory device numbers. If native
inspection succeeds after provider recovery but ordinary project commands refuse
the mapping, inspect the exact instance with the current bundle:

```sh
./hack-v5 doctor --path /absolute/project --branch my-instance --native-run-mapping inspect --json
./hack-v5 doctor --path /absolute/project --branch my-instance --native-run-mapping repair --expect-selection <selectionSha256> --accept-legacy-device-rebind --json
```

Omitting `--branch` uses the same linked-worktree default as project commands;
detached linked worktrees require an explicit instance. Inspection writes nothing.
Repair requires the exact selection and explicit acceptance of unproven original
filesystem volume continuity. It changes only the three scope directory device
numbers, preserving canonical paths, inodes, branch, run, owner, plan, environment
selection, profiles and AWS selector. The selected graph and current project share
must still match native authority. An audit copy retains the original private
mapping. Held locks, pending restart state, substituted directories, stale hashes
and changed native identities refuse publication.

This is a metadata repair, not an app restart: it does not retire sockets, modify
graph history, remove data or establish browser readiness. Doctor's ordinary
`--fix` never applies it. Run the normal project command separately after reviewing
the result; its existing native graph and ownership checks still apply.

Compatibility is qualified for specific bundle hashes and state formats. The
displayed version alone does not establish frontend/executor or downgrade
compatibility. V4 and candidate homes remain separate; this procedure does not
migrate V4 data into the candidate or replace the installed `hack`. DNS, trust and
client configuration are outside this bundle-selection procedure.

Provider setup is separate and explicit. Obtain the exact archives identified in
`provider-pins.json`, then run:

```sh
./hack-native --candidate-root /absolute/private/candidate-home runtime prepare --archive /absolute/smolvm-archive.tar.gz
./hack-native --candidate-root /absolute/private/candidate-home runtime prepare-engine --archive /absolute/docker-archive.tgz
./hack-native --candidate-root /absolute/private/candidate-home runtime prepare-network-tools --directory /absolute/private/pinned-apks
./hack-native --candidate-root /absolute/private/candidate-home runtime probe --json
```

Before startup, network-tool preparation additionally requires all four pinned
Alpine aarch64 APKs in a current-user-owned private directory (mode `0700`), with
regular, singly linked mode-`0600` files. Acquire the matching public package bytes;
the command never downloads packages or accepts substitute versions:

| File | SHA-256 |
| --- | --- |
| `iptables-1.8.10-r3.apk` | `31ab6343f1f3d0fbbf290c4dcf0430b2d08e8073e516e13530dfab25b097d467` |
| `libmnl-1.0.5-r2.apk` | `d15e6313880bdd14959f42c1556b4a810ef4894992ae9f73b148126f0cc6021d` |
| `libnftnl-1.2.6-r0.apk` | `ec1c2b02869fc65bcf7a1105e3a7ac5df1bd9a8bd8b399cb6cf650dd3112c021` |
| `libxtables-1.8.10-r3.apk` | `f0accefde240ece6722479b46cb014d7d2f745af7d796e8eec3ced53571e1088` |

All APKs are validated before candidate state is changed. Installation publishes a
complete private directory atomically; an existing installation is revalidated and
reused without overwriting files. Corrupt installs or interrupted
`network-tools-installing` staging are retained and refused for manual review.
The executor bundle includes no APKs; prepare them explicitly before `runtime up`.
This command changes only host candidate artifacts and does not boot or modify a VM.

Preparation verifies the pinned archive hashes before extraction; SmolVM also
requires its existing signature verification. No fallback to global providers or
v4 state is enabled. Runtime startup is a further explicit operation subject to
host resource admission. Read `--help` for the candidate command surface.

The development profile reserves the declared 32 GiB storage disk and 10 GiB
overlay ceiling plus 16 GiB of host disk space before startup. It reports host
load but does not reject an interactive start solely because unrelated jobs raise
the one-minute load average; memory pressure, thermal state and swapouts remain
admission checks. The research profile keeps its separate 100 GiB disk and host
load qualification envelope.

The normal `hack-runtime-candidate` / `hack-local` development build remains bound
to its source checkout, including when all Cargo features are enabled. Only the
separate `hack-native` binary opts into installed-home discovery. Existing provider
and receipt ownership checks remain in force.

For an existing owned graph, bounded service diagnostics use its run identifier:

```sh
./hack-native --candidate-root /absolute/private/candidate-home graph logs --run-id RUN_ID --service web --tail 200 --json
./hack-native --candidate-root /absolute/private/candidate-home graph exec --run-id RUN_ID --service web --json -- /bin/echo hello
```

Both commands select the current container and recheck its boot, receipt generation
and ownership before reading or executing. Logs include exited services, default to
200 lines (maximum 1,000), and return bounded, UTF-8-lossy text with a truncation flag.
Exec requires a running service and returns Base64 stdout/stderr to preserve arbitrary
bytes, an exit code, and a truncation flag. The CLI also exits with the command's exit
code. Retained exec output is limited to 1 MiB per stream.

Exec is noninteractive: stdin is closed, no TTY is allocated, and arguments are passed
literally without an implicit shell. The default wait is 30 seconds, configurable up
to 120 with `--timeout-seconds`. Timeout or transport failure means completion is
uncertain: the command may still run, and Hack does not replay it. Exec inherits the container's static environment. When the selected service has a
committed private environment attachment on the current boot, it reuses that
service's exact read-only launcher mounts and original expiry. No values are copied
into engine metadata, and exec never renews credentials. With the current launcher,
managed exec resolves a command name such as `bun` against PATH inside the selected
container after applying its environment; an explicit path still runs literally.
Older launcher mounts require a restart before using command names. Changing
overlays is unsupported. Neither command persists application output in runtime
receipts; output can contain sensitive application values and should be handled
accordingly.

## Explicit normalized public Compose input

A frontend can pass a reviewed public Compose document without replacing the
original configuration or relaxing source exclusions. Add all three flags to
`project plan`, `project capture`, `project publish-source`, `project verify-source`,
or fresh `graph run` / `graph serve`:

```text
--normalized-file /absolute/public-normalized.yml
--expect-original <sha256-of-original-compose-bytes>
--expect-namespace <reviewed-workspace-namespace>
```

Keep `--file` pointing to the original Compose file inside the selected project;
relative paths retain that file's directory as their base. Obtain the namespace
from `hack-native --candidate-root HOME plan --project PROJECT --json`. Review the
normalized `project plan` result, then pass that exact `--expect-plan` to capture,
publication, and graph execution. Every operation rechecks the original hash and
namespace. The normalized file must be a nonempty regular file of at most 256 KiB;
symlink files and hardlinked files are refused. Its bytes are retained in memory,
not copied into candidate state. The input is public configuration only: managed
secrets still use the separate `graph serve --environment-stdin` private envelope.

The file-based enrollment, source-sync, `graph restart`, and `graph restore`
commands do not accept normalized input. A stopped normalized graph instead uses
`graph restore-selection --run-id RUN_ID --json`, followed by `graph serve-restore`
with the same run and original input identity, the returned
`--expect-generation`, a freshly reviewed plan, and fresh environment, dependency
and route selections.
Normal foreground `hack restart` performs this selection and retained-data restore.
It verifies the old containers and networks are absent and the retained volumes
still have their recorded identities; it does not silently create replacement data.
When the original Compose file is unchanged, retained startup also selects the
authenticated container image IDs from that stopped graph. Mutable tags are not
resolved again for those services. Missing images still refuse native admission;
this selection never replaces generation, source or resource checks. Changing the
original Compose file uses normal image resolution and the existing compatibility
rules, rather than silently adopting an old image for a new declaration.
For a shared-source graph admitted with a retained compatibility contract, ordinary
source-content edits may change the reviewed plan ID: restart checks the stable
execution, exclusion, mount and dependency-cache inputs before cleanup and again
under the provider lease. The original installer publication and graph ownership
remain pinned. Changed configuration or cache inputs refuse before cleanup;
older receipts without that contract continue to refuse source-edited restart.
Source exclusions and runtime ownership checks remain in force. Existing commands
without normalization flags keep their file-based behavior.

New normalized shared-source graphs also capture a separate hostname-change
contract. A retaining restart can change only the literal hostnames of already
routed services: the service set, upstream ports, TLS settings, probes, commands,
environment declarations, images, mounts, networks and volumes must stay the same.
Both original and normalized Compose declarations are checked; only fingerprints
are retained. Changed dependency-cache inputs still refuse. The old ownership
plan and named data identities remain fixed, while normalized input provenance and
route intent advance together. Returning to the old names requires the same
checks. Existing hostname claims are checked before cleanup and again at publication.
Older receipts without this contract cannot be retrofitted from their redacted
plans and continue to refuse hostname changes.

`doctor --domain-migration apply` remains a file-only operation. It retains old
aliases and does not restart the graph or activate DNS/trust. Run an explicit
retaining restart after reviewing its changes, and separately verify the exact
browser origin. A successful file rollback likewise requires a retaining restart
to change running routes; it does not imply a live migration succeeded.

Graph execution respects the declared container root mode: `read_only: true`
keeps the root read-only, while false or omitted permits a writable container
layer. Removing the owned container discards that layer; use named volumes for
durable data. Source bind mounts still require read-only publication. Writable
container layers do not imply writable source synchronization.

The normal-CLI integration helpers prepare modern environment overlays and
worktree inheritance in memory, with null declarations in public normalized
configuration. An explicit AWS profile adapter can replace the recognized
read-only `${HOME}/.aws:/root/.aws:ro` mount with temporary, service-scoped
credentials. It preserves unrelated mounts and refuses custom credential-file
selectors. Credentials are not written to Compose or the project snapshot, and
are not automatically renewed after expiry. Normal native foreground `hack up`
uses these adapters within the capability limits described below.

## Public image acquisition without Docker

The candidate can fetch a **digest-pinned public Docker Hub image** without Docker,
OrbStack, registry credentials, or a running guest:

```sh
./hack-native --candidate-root /absolute/private/candidate-home runtime fetch-image \
  --reference 'namespace/repository@sha256:REVIEWED_MANIFEST_DIGEST' \
  --archive /absolute/private/new-image.tar
```

For an existing mutable image declaration, resolve it explicitly first:

```sh
./hack-native --candidate-root /absolute/private/candidate-home runtime resolve-image \
  --reference 'namespace/repository:tag' --json
```

Omitting the tag selects `latest`. Resolution returns `pinned_reference`,
`source_digest`, `manifest_digest`, `image_id` and `platform`; it downloads only
bounded metadata and verifies one unambiguous Linux ARM64 image configuration.
Pass the returned **pinned reference** to `fetch-image`, not the original tag.
Resolution creates no archive or runtime state and does not prove that all image
layers fit the importer limits or that the application starts. A missing public
tag/object reports `registry_image_not_found`; no replacement image is selected.

The archive must not already exist. The result reports `source_digest`, the selected
Linux ARM64 `manifest_digest`, config `image_id`, `archive_sha256`, and archive size.
Pass that exact archive, hash and image ID to `runtime load-image` after preparing
the candidate guest. Fetching and importing remain separate operations.

The fetch verifies the pinned index/manifest, the selected ARM64 manifest, every
compressed blob and config digest, and the expanded layer identities. It supports
only gzip layers, at most 128 layers, 256 MiB archived and 2 GiB expanded. HTTPS
requests have a 60-second limit within a 300-second acquisition deadline; redirects
are restricted to known Docker Hub HTTPS blob origins, with no bearer forwarding to
CDNs. It never reads Docker credentials or proxy settings. Mutable tags passed directly to fetch, private
registries, other registries and unsupported platforms fail closed. No implicit
image refresh occurs. Keep the archive only as long as needed for owned imports;
fetch does not install a background cache or cleanup daemon. The complete archive is synced and published without replacing an existing path.
A failed write leaves no final archive; process interruption may retain a hidden
temporary file beside the requested output. A directory-sync failure reports that
a complete archive was published but durability could not be confirmed.

### Explicit writable development source

An isolated development pool can opt into a direct host project mount with
`runtime up --profile development --project-share /absolute/project --unfiltered-source`.
`graph run` and `graph serve` select that mount with `--shared-source`.
This shares the entire approved project, including ignored local files, with guest
read/write access. Filtered source publication remains the default. Do not use the
unfiltered mode for a checkout whose local files must remain hidden from its services.
Only the exact canonical project root is accepted; home/credential directories,
aliased roots, and changes to a retained pool's mount intent are refused.

Shared-source graphs with dependency caches still require a freshly published
source revision. Cache initializer services read that immutable publication through
read-only source mounts; their named cache volumes remain writable. This prevents
concurrent host edits from changing the inputs halfway through installation.
Other services use the direct host mount with their declared read/write mode.
Because virtiofs preserves host ownership, those services receive `DAC_OVERRIDE`
in addition to the otherwise empty capability set. This allows root processes to
access the explicitly shared tree; it does not bypass a read-only mount.
An installer that needs to modify source files is not supported in this mode yet.
Restart after dependency-input changes with a new review and publication.
Moving or deleting a project prevents further activation, but does not prevent
owned runtime teardown. Teardown never removes the shared host tree.

Service CPU and memory limits are optional. Services without an explicit Compose
limit share the admitted VM pool (Docker `NanoCpus: 0` and `Memory: 0`); the VM's
CPU and memory admission bounds remain unchanged. Explicit limits retain per-service
validation and aggregate reservation checks, and graphs remain limited to 32
services. This preserves ordinary Compose omission semantics; it makes no
performance guarantee or claim about fairness between workloads.

### Frontend integration status

Explicit `HACK_RUNTIME_BACKEND=native` with absolute `HACK_NATIVE_BINARY` and
`HACK_NATIVE_HOME` selects native observations for normal `hack ps` and bounded
`hack logs SERVICE --no-follow`. They verify the project/branch run mapping
against the current native graph. Logs do not support following or Loki options.
A project with no admitted mapping reports not started. `hack ps` keeps container
observations separate from the last graph receipt. For a ready foreground graph,
it also checks the live owner: `owner_unconfirmed` means the
owner could not be authenticated, while `runtime_degraded` means its runtime check
failed. Native `exec` and `run` refresh admitted host dependencies once before
command selection and managed environment preparation. They proceed only with
fresh ownership and runtime proof, even if containers still appear running.
Unconfirmed ownership or an incomplete refresh requires inspection and explicit
retaining recovery; command requests are never replayed.
Foreground whole-project `hack up` additionally requires
`HACK_NATIVE_SHARED_SOURCE=1`: it exposes the exact
project tree, including ignored files, with each mount's declared write mode. Use
an explicitly prepared candidate home and the binary from a complete native bundle.
It acquires public images, privately supplies managed environment values, runs
lifecycle hooks, and publishes the run mapping after native readiness. Ctrl-C waits
for owned cleanup and keeps the stopped run mapping and named volumes after
confirming cleanup. The VM remains available until explicit runtime shutdown.

This initial foreground path does not support detached/JSON startup, selected
services or external networks. Routed services and host dependencies require the
explicit native selections described below. Existing
`hack.dependencies.*` cache declarations publish the reviewed source snapshot and
require successful initializer completion before dependent services start. Cache
initializers receive immutable source mounts and writable named cache volumes;
workspace installs that write elsewhere still require explicit volume mappings.
An isolated Event Agent trial reached 14-service native readiness, completed Google
sign-in, and rendered authenticated search results and images over browser-trusted
HTTPS. A normal `restart` kept its run and Redis data after a source edit. This does
not establish every application workflow, crash recovery or comparative performance.
Native `down` requests retaining cleanup from the graph owner and verifies container
absence while keeping the exact run mapping. It then retires that branch's owned host
lifecycle processes before running after hooks. A previously recovered stopped graph
also retires remaining owned host processes without replaying hooks or guest cleanup;
uncertain ownership refuses retirement and leaves the retained mapping intact.
Before capturing live bridge helpers for cleanup, the owner retires an exited
helper only after confirming its current guest boot, run, container, network and
reservation. An interrupted retirement requires a fresh exit observation or an
exact stopped slot fence with the allocation and socket absent. A live, replaced
or unconfirmed helper remains a refusal; named volumes and sibling runs retain
their existing ownership protections.
Successful `down` also requires acknowledgement of the exact frontend attempt
captured before cleanup. Missing, changed or unacknowledged finalization refuses
success even when compute is already stopped; the run mapping and volumes remain
available for explicit recovery. Restart retains its own captured finalization
barrier so its selected dead-frontend recovery can run before replacement startup.
If the foreground owner concurrently retires its tmux session, cleanup accepts a
fresh explicit absence proof. Missing ownership metadata or an unsuccessful query
alone does not prove absence, and retirement preserves any replacement owner's state.
The next ordinary `up` verifies that
stopped receipt and restores the same run and volumes, including when its clean owned
VM has been stopped. It requires the retained frontend's exact finalization to be
acknowledged before hooks, storage preparation, VM startup or shared HTTPS admission.
This observation never recovers an interrupted frontend automatically, and the later
startup ownership check still refuses a concurrent replacement. Offline `graph retained-preflight` returns durable eligibility
only; it never fabricates volume observations or a restore generation. Startup checks
the saved environment, profiles and AWS selector before hooks and binds the exact
owner and receipt selection to `runtime up` with paired `--expect-retained-run` and
`--expect-retained-selection` flags. Native startup holds publication retirement and
revalidates the selection under the provider lease and immediately before boot. After
resume, live inspection must still prove absent compute and present owned volumes;
the existing restore selection pins the current boot and volume identities. Cancellation
or timeout has an uncertain outcome and never replays runtime up or graph restore.
It refuses an active, changed
or uncertain mapping rather than allocating a new data volume. Down hooks resolve
fresh managed host values using the environment selection saved by `up`; hook output goes to stderr with `--json`. A before-hook failure
prevents cleanup; an after-hook failure reports that graph cleanup already completed.
Environment/profile/target changes and cache pruning remain unsupported.

New mappings record the effective overlay name, or explicit `null` for base-only
configuration; no environment values are persisted. New readers accept legacy
mappings with missing selection, but refuse down hooks for those mappings rather
than guessing an overlay. Missing selected overlay files also refuse before cleanup.
Older binaries may reject extended mappings: this is backward state-reading
compatibility, not support for rolling back binaries over new state.
Whole-project foreground `restart` retains the recorded environment, AWS selector,
profiles, run identity and data volumes. It checks development runtime admission
(including disk headroom), reviews the normalized plan, and verifies each selected
host dependency listener before cleanup. For unchanged original Compose input,
active preflight reuses the admitted immutable image IDs, matching retained startup
even if a registry tag has moved. It authenticates the complete live graph through
native service selection and rechecks the same receipt generation, container and
boot after review. Completed initializer services remain eligible. Edited original
input uses ordinary image resolution and compatibility review; image reuse grants
no authority to bypass native source, resource or ownership checks.
Executable selections rediscover the
current listener; fixed-PID selections require a deliberate update when their
listener changes. Preflight remains immediate and does not adopt an unverified
process at the same port.
It saves a pending restart intent and waits for the previous frontend
to confirm graph, HTTPS and lifecycle cleanup before starting its replacement.
Changed selections and unknown legacy startup/finalization records refuse before
cleanup. A failed replacement retains its intent: retry `restart` after resolving
the reported problem; a fresh `up` cannot bypass it. When the saved intent confirms
cleanup, retry independently inspects the exact native run: its journal must be
complete, containers and networks absent, and retained volumes present. A matching
retained frontend mapping may remain; the mapping and intent alone do not prove
cleanup. Retry still reviews the public dependency intent and all source, plan,
environment, network and admission checks. It captures
listener identities after the startup hooks recreate them, rather than requiring
already stopped listeners before those hooks run. An interrupted operation lock
requires ownership inspection rather than automatic removal. Restart does not
implicitly migrate a shared pool's network policy or interrupt other projects.
When an interrupted frontend cannot write that final acknowledgement, an explicit
`restart --recover-frontend --expect-finalization-attempt <32-hex>` can resume
the saved, already-cleaned restart intent. It can also preflight an exact graph
that was stopped before the frontend saved an intent: fresh native observations
must prove absent containers/networks and present retained volumes, and repeat
that proof after review before cleanup. The normal intent, retaining down,
frontend recovery and startup sequence still runs. An active graph keeps its
authenticated service selection and live-listener checks; uncertain observations
cannot select the stopped path. Stopped preflight retains the admitted
image IDs when the original Compose input is unchanged, matching retained startup
instead of resolving mutable tags again. Changed original input keeps normal
image resolution and the existing compatibility checks. New attempts retain their frontend
PID and HTTPS port in the private token. Older v1 attempts additionally require
`--expect-frontend-pid <previously-observed-pid>`; a guessed PID is not recovery
evidence. Recovery requires the exact stopped graph receipt with its volumes
present and containers/networks absent, no managed HTTPS authority or owner
lock, a free recorded HTTPS port, and empty lifecycle state. Legacy recovery
also refuses while another packaged Hack frontend is running. The separate
recovery marker records that the old owner was proved gone; it does not claim
the old frontend ran its finalizers. A live or uncertain owner still refuses,
and no managed state file should be edited to bypass the refusal.
Before restore, the explicit recovery path also retires the exact dead graph
publisher only when its completed dead-owner cleanup receipt, current boot,
retained volumes, absent compute, and host relay cleanup still match. The
publisher's socket and owner record are moved under a durable inode-pinned
journal; interruption between those moves resumes against the same identities.
The backend operation is also available as
`graph retire-recovered-publisher --run-id RUN --expect-owner OWNER --json`.
An ordinary clean restart does not run this recovery operation.
The in-development native `run` path requires a running project started by a
matching candidate. It creates a separate service container with fresh managed
environment values and the admitted image, mounts, dependency cache and network.
It does not publish service ports or aliases. Commands are noninteractive and
bounded to 300 seconds; omitted arguments retain the service's default command.
The CLI returns command output and exit status only after owned job cleanup is
confirmed. There is no automatic command replay or fallback to Compose.

The running-project noninteractive path has a live Event Agent smoke check:
`hack run www -- bun --version` completed after a same-run restart, and a command
exiting 7 returned its stdout and exit status. Both left no job resource and
preserved the healthy parent graph and its volume identities. An
interrupted one-off also completed explicit dead-owner cleanup with data retained.
Closing a live one-off client confirmed exact job removal while the parent remained
`ready-observed`, with the same volumes and healthy HTTPS route.
Stopped-project bootstrap, interactive input, and repeated crash recovery after a
restored one-off remain open. An uncertain shutdown retains its mapping and evidence
for recovery; do not delete managed state to retry.

After starting an owned native pool, `runtime ensure-image --reference REF --json`
resolves a public Docker Hub tag or accepts an explicit digest, reuses the verified
archive cache, and imports through the existing content-ID-checked loader. Tags
are resolved on each call; a warm explicit digest needs no registry request.
The cache is limited to 16 archives and 2 GiB; an incomplete or conflicting entry
requires inspection, and the command never prunes existing data. This command
is a startup building block, not evidence of complete normal `hack up` support.

Explicit Compose `shm_size` supports positive sizes up to 1 GiB, including
`shm_size: 1gb`; omission retains Docker's 64 MiB default. This tmpfs ceiling is
not preallocated memory and is not added again to graph memory reservations.
Actual shared-memory allocation remains constrained by an explicit container
memory cap, when present, and by the admitted VM pool. Restart review preserves
the exact shared-memory setting; zero, malformed and oversized values are refused.


For a project using the recognized read-only AWS home mount, explicit
`HACK_NATIVE_AWS_PROFILE` (and optional `HACK_NATIVE_AWS_REGION`) applies the
service-scoped AWS adapter after the normal login hook. It removes only recognized
AWS mounts/selectors and supplies temporary credentials through private stdin.
Expired or unsupported profiles fail startup; credentials are not persisted or
refreshed automatically. Unrecognized mounts and other unsupported bindings still
refuse admission.

New immutable source captures use manifest schema 2: the revision binds both
selected content and its selection receipt. This prevents an ignored mountpoint
appearing after startup from colliding with an earlier publication containing the
same bytes under a different selection. Existing schema-1 manifests remain
verifiable; they are not rewritten or deleted. Cache keys still derive from their
declared dependency inputs and execution identity.

Normal native foreground startup requests outbound public internet access by
default. Package downloads and external APIs do not require per-host configuration.
This does not publish inbound ports or grant host-service access; the provider's
private, loopback and metadata-address restrictions remain separate.

Set `HACK_NATIVE_ALLOW_HOSTS` only to opt into restricted outbound access: a
comma-separated list of at most 32 unique lowercase DNS names, such as
`registry.npmjs.org,example.com`. Wildcards, IP addresses, local names, whitespace,
trailing dots and empty entries are refused before lifecycle hooks. The provider
permits each selected domain and its subdomains, including TTL-learned public
addresses; this is not a URL, port or exact-host-only policy. Redirect destinations
also need approval in this optional mode.

Existing pools retain their network policy. To change an existing pool to the
normal internet mode, stop its owned runtime and run:

```sh
./bundle/hack-native --candidate-root /absolute/private/candidate-home runtime network internet --json
```

The transition preserves disks and caches and does not start the VM. Remove
`HACK_NATIVE_ALLOW_HOSTS` for subsequent normal foreground starts. Startup refuses
a policy mismatch instead of silently changing an existing pool.

To add an approved host to an existing pool, first stop the owned runtime, then
explicitly extend its policy:

```sh
./bundle/hack-native --candidate-root /absolute/private/candidate-home runtime network extend \
  --allow-host pkg-npm.githubusercontent.com --json
```

This preserves disks and caches and does not start the VM. It supports additive
changes to an existing approved-host policy, not switching an isolated pool to
networked mode or removing hosts. A recorded interrupted transition blocks startup until
the same command reconciles its exact before/after states. Incomplete staging or
foreign changes remain refused for inspection. Include the resulting
complete host list in `HACK_NATIVE_ALLOW_HOSTS` on subsequent foreground starts;
ordinary startup still refuses a different policy.

Normal native foreground startup recognizes the bounded `caddy`,
`caddy.reverse_proxy`, and `caddy.tls` label contract alongside dependency-cache
labels. It requests minimum bridge capacity for declared routed services before pool
startup and enrolls only active routes from native review. A fresh pool creates that
capacity; an existing pool with equal or greater capacity is reused unchanged.
Insufficient capacity refuses startup without resizing or replacing the pool.
The internal `runtime up --minimum-bridge-sockets N` command expresses this
requirement; `--bridge-sockets N` retains its exact-capacity contract. Neither
option promises free slots: graph admission still reserves those separately.
Host dependencies use the equivalent `--minimum-dependency-sockets N` selection;
`--dependency-sockets N` remains exact. Each direction can independently request
an exact capacity or a minimum. The combined physical transport limit still applies
to the pool's actual capacities, including any spare slots. A minimum does not resize
an existing pool or guarantee that enough slots are currently free.
Each routed service
must already declare a matching `healthcheck.x-hack-http`; command healthchecks
and missing probes are not replaced or inferred. Native review still validates
hostnames, ports, networks and labels. Foreground graph ownership supervises and
retires Unix route publishers. Without explicit HTTPS selection, this enrollment does not start a hostname authority
or Caddy HTTPS server. It never installs trust, configures DNS, or widens an existing pool.

The frontend requests `--route-slot SERVICE=auto` for each active route. The
native graph owner selects distinct free ingress slots across the whole pool
under its mutation lock and reserves the complete route set before starting its
route relays or publishers. Slots held by another graph, including slots awaiting
cleanup, remain unavailable. Insufficient capacity refuses the reservation without
publishing a partial route set. Internal callers can still select an exact slot
with `--route-slot SERVICE=N`; a busy slot is refused rather than reassigned.
Retained starts resolve automatic selections again against current ownership.
This allocation does not resize a pool or enable multi-worktree source sharing.
Shared HTTPS lifetime uses separate graph leases.

An empty shared HTTPS configuration left by failed startup is not a released
lease. The experimental source API `archiveEmptyNativeHttpsOwner` can archive
only the explicitly selected generation and configuration digest after proving
the original observed spawner exited, the selected endpoint/port/authority and
publications are absent, and the same pool incarnation remains running. It
preserves configuration bytes/inodes and Caddy data. Current startup and archival
share a short admission lock; uncertain intent publication retains its barriers
for inspection. Older binaries do not honor that lock and must remain quiescent
during this explicit recovery. Changed, active or ambiguous state refuses; this
is neither automatic recovery nor a public CLI command.

A nonempty shared HTTPS owner from the immediately preceding guest boot requires
a separate retaining recovery. The selected graph must already have an exact
current completed dead-owner cleanup proof, a retired publisher, retained volumes
and no compute, bridge, publication or hostname authority. Stop other uses of the
recorded frontend, runtime and Caddy executables first; legacy binaries do not
honor the new admission lock. Recovery refuses a live or uncertain process using
any of these executable paths, including Caddy serving another candidate home.

Explicit `restart --recover-frontend --expect-finalization-attempt ATTEMPT` can
select this transition for its exact v3 finalization lease. The internal native
operation binds every lease field:

```sh
./hack-native --candidate-root /absolute/private/candidate-home runtime archive-previous-boot-shared-https \
  --run-id RUN --expect-owner-generation GENERATION --expect-lease-id LEASE \
  --expect-attempt ATTEMPT --expect-owner OWNER --expect-namespace NAMESPACE \
  --expect-plan PLAN --json
```

The operation holds shared HTTPS admission, retired-publisher protection and the
provider cleanup lease while checking the immediate boot transition, original
executable hashes, owner/lease files, CA and exclusive port availability. It
archives original owner and lease files by same-filesystem rename and signals no
process. A present control socket and parent must match their selected identities
and be inactive; the socket is renamed within its unchanged parent. If both
socket and parent are absent,
that absence must remain true throughout archival, alongside the independent
process, port and graph proofs. A partial or replaced socket path refuses.

An interrupted archive retains its journal and admission barrier. Only the exact
selection with a verified dead recovery process can resume; do not remove lock
files or synthesize missing ownership records. Completion preserves Caddy data,
volumes and original lease evidence. Explicit frontend recovery consumes that
completion as a distinct recovery proof, never as an ordinary live-owner lease
release. Keep other shared HTTPS startup quiescent until frontend finalization
completes. A newer active owner blocks completed-archive replay; this recovery
does not adopt or stop it. Archival alone does not start the application or
establish browser access.

Normal foreground startup also selects `--auto-dependency-slots`. Each graph's
logical dependency groups receive distinct physical pool slots under the provider
lock. The complete assignment is recorded before listeners bind, so concurrent
starts and a crash before binding cannot claim the same capacity. Cleanup verifies
owned graph resources, closes its dependency listeners, and releases its reservation
before reporting success. A sibling graph's reservations and listeners remain owned
by that sibling. Low-level callers without this flag keep exact slot semantics and
must also respect existing reservations.

`graph dependency-reservations --json` inspects the durable claims. A dead owner
that never enrolled a graph can release a coherent claim with
`graph recover-dependency-reservation --run-id RUN --expect-reservation SHA256`.
Recovery verifies the owner is dead and any recorded socket still has its original
identity and no listener. Torn records and sockets without complete ownership
evidence remain unavailable; do not delete them to force allocation. Recovery of an
already enrolled graph requires verified graph cleanup instead.

`HACK_NATIVE_DEPENDENCIES` selects an absolute path to a regular JSON file with
explicit host listeners. The CLI reads it after lifecycle hooks, so a hook can
prepare current listeners before selection. For example:

```json
{
  "version": 1,
  "dependencies": [{
    "service": "web",
    "binding": "search",
    "guest_port": 443,
    "aliases": ["search.example.com"],
    "host_pid": 12345,
    "host_port": 8443
  }]
}
```

Replace the example PID with the actual listener process. Up to 128 service-specific
bindings and eight exact aliases per binding are supported, within 32 listening transports shared with the pool's route bridges.
For a listener started or rotated by a lifecycle hook, replace `host_pid` with
`"host_executable": "/absolute/path/to/the/listener-binary"`. Hack discovers
the current PID after the hooks and again before restart cleanup, requiring one
same-user process with that exact executable and an exclusive IPv4 loopback
listener on `host_port`. It passes the discovered PID to native review without
rewriting the private selection file. The native dependency plan pins the
process and socket generation again before admitting the graph. A missing,
ambiguous, wrong-executable or substituted listener refuses; an already running
graph stays up when restart preflight refuses. Fixed `host_pid` selections remain
supported and carry no permission to follow a replacement process.

Executable selections may also set `"host_supervisor_depth": 2` when a retained
wrapper launches a replaceable session process which launches the listener.
The depth is an integer from 1 through 8 and defaults to 1 (the immediate parent);
it is forbidden with a fixed-PID-only selector. Hack captures exactly that
many ancestry links, pins the final ancestor's PID, native start time, user and
executable, and retains the intermediate executable paths in order. A retry may
replace intermediate processes only beneath that exact live ancestor, with the
same executable chain and user. Native review rechecks the complete bounded
lineage twice; it never searches for a common ancestor or infers a stable wrapper.
Bindings sharing one listening transport must select the same executable, depth
and reviewed ownership policy. A replaced ancestor, changed chain, adopted
listener or inconsistent shared selection refuses before relay grants change.

Startup allows up to 60 seconds total for persistent hooks to create all selected
listeners, with cancellable waits and bounded read-only discovery requests. It
retries only native endpoint-identity refusals; malformed selections and other
failures stop immediately. A listener must pass the complete ownership checks
before any VM or graph effects. Restart preflight does not wait or stop the graph
when its current selection cannot be verified.

For an already ready foreground graph, `graph refresh-dependencies --run-id RUN
--json` asks its authenticated live owner to refresh stale admitted listeners.
With a packaged candidate, invoke it as:

```sh
./hack-native --candidate-root /absolute/private/candidate-home graph refresh-dependencies --run-id RUN_ID --json
```

Only `host_executable` selections can follow a replacement, using the original
executable, host port and unchanged same-user ancestor selected by
`host_supervisor_depth`, retaining the reviewed intermediate executable chain. A matching
executable or port alone is insufficient. Missing or ambiguous listeners,
replaced supervisors, fixed-PID drift and changed ownership refuse. The owner
retains the admitted services, bindings, aliases, guest ports and transport slots;
the request cannot add or edit them. Successful refresh changes affected relay
generations without restarting application containers or replacing volumes.
An unchanged graph returns a verified no-op.

A service declared `completed` that has successfully exited can share those
dependencies with running services. Refresh checks its exact container, image and
original start time, and requires exited state, PID zero, exit code zero and no
dead or OOM state. It journals retirement before revoking every historical binding
and proving the old helpers absent. Its receipt then records `relay_startup` phase
`completed` with no helper process records; it receives no replacement grant or
helper. Running siblings still refresh together. Started/healthy services that
exit, and failed completed jobs, refuse this path. One-off commands retain the
admitted template and create fresh job intent; this state never permits exec in
the stopped container.

When a physical dependency slot is used only by completed jobs, refresh can select
a replacement for later one-off commands under the same executable and ancestry
policy. A separate empty fence requires every old target to be retired, preserves
the exact graph and old generation, and commits the new endpoint before future job
admission. It issues no grant or helper for the completed containers. A later
one-off uses fresh job intent and credentials; old credentials remain revoked.
An interrupted empty fence refuses further admission until ordinary owned cleanup
and restart, and is never retried or replayed automatically.

The rebind journal's optional `completed_services` and per-slot `terminal_only`
fields record terminal retirement and empty fences explicitly. Older journals
without these fields remain readable, but a previous bundle cannot be assumed to
understand the new completed startup phase.
Use the current owning bundle for retaining cleanup and journal archival before
selecting an older bundle; do not substitute an older binary against active state.

If a required startup listener exits with a service declared `started` or
`healthy`, the stopped receipt preserves the owned service name, container ID and
exit observation before cleanup, including exit code zero. A successful
`completed` service is not recorded as a startup failure. This evidence contains
no command, environment or application log values. Older bundles may refuse the
new zero-exit evidence; use the owning bundle for diagnosis and retaining cleanup.

A Docker container can remain `created` with a nonzero error when its first start
fails before a process runs. Retaining shutdown accepts this state only with
verified ownership, no running PID, no pause/restart/dead state and no OOM flag.
The original exit code remains failure evidence; it does not become a successful
application exit or a claim that Hack sent a stop request.

If that failure interrupted enrolled cleanup, the candidate frontend can inspect
and select a separate retaining recovery after the exact native foreground has
exited. The private controls are `graph inspect-interrupted-start-cleanup
--run-id RUN --json` and `graph recover-interrupted-start-cleanup --run-id RUN
--expect-selection SHA256 --retain-data --json`. They require the same guest
boot, exact dead foreground, matching pending coordinator operation, and unchanged
selected resources and retained volumes. The relay publication must either match
its original pinned owner or have both owner and socket absent after foreground
exit. The absent pair is bound to the existing operation lock, unchanged parent
identity and exact selected coordinator owner, process, publication and attempt;
a mixed pair, live process or replaced lock refuses recovery. This is not a
general retry of a coordinator effect. Its own journal records each cleanup step.
Shared dependency caches stay retained, with their original cache bindings and
volume provenance rechecked at effect and completion boundaries.
An uncertain stop is never sent again merely because the container still appears
running. A crash between stop intent and request can therefore require later
terminal evidence before recovery can advance.
Likewise, a pending guest helper, probe or environment deletion advances only
after complete absence is independently verified. An interruption partway through
a guest cleanup script can remain fenced; this control does not replay that
script or guarantee automatic recovery from every internal deletion boundary.

Successful recovery requires independent compute, helper, probe and environment
absence, then current cleanup acknowledgement, exact publisher retirement and
dependency reservation release. The frontend rechecks retained data and completes
its existing finalization contract. It still reports the original startup failure.
If retirement is interrupted after acknowledgement, a bounded native journal hint
prompts fresh inspection of the exact original selection before finishing only
the remaining publisher and reservation transitions. The hint grants no effect
authority, and a stopped graph alone does not establish complete retirement.
Completed recovery journals remain as evidence. A later interrupted startup on
the same retained run cannot reuse that earlier generation's selection: native
recovery reports `graph_interrupted_start_cleanup_stale`. Archiving a completed
journal at the verified restore boundary is a separate follow-up; never remove
the journal manually to enable another recovery.
A component acknowledgement is not application readiness, and this recovery does
not diagnose or fix an upstream engine panic. Changed or incomplete evidence
remains available for inspection; do not remove journals or ownership pins to retry.

Native `hack exec` and `hack run` make this request once with a 180-second frontend
budget before selecting their command or reading managed environment values.
`ps` and `logs` remain observations and do not request refresh. Authenticated relay
traffic reports a stale endpoint to the foreground owner, which attempts bounded
refresh without idle polling. The affected application request can fail; it is
never replayed, and later traffic can use a verified replacement. The explicit
operation is also available before traffic. Refresh does not renew startup
environment allocations. A lost reply or interrupted transition is never replayed.
Partial transitions remain fenced and refuse new admission; inspect owned state and
complete retaining cleanup/restart to rebuild the relays. Ordinary recovery keeps
the run's persistent volumes. Do not delete managed journals or mappings to retry.

Bindings in different services targeting the same pinned host listener can share
a transport slot; authentication, cancellation and expiry remain per binding.
The CLI groups selections by host PID and port in first-appearance order, and
native review requires the complete captured endpoint identities to match.
Multiple bindings within one service retain distinct slots.
Aliases must match the service's declared `extra_hosts` entries targeting
`host-gateway`. No general host-gateway access is enabled. Native dependency review
pins the same-user process and exclusive loopback listener generation, then checks
that identity again during admission. A stale PID, replaced listener, undeclared
alias, extra field, symlink or malformed file refuses admission. This file contains
selection metadata only, never credentials. It does not adopt or stop the selected
host process; lifecycle hooks retain ownership of listeners they launch.
Restart preflight checks those selected listeners before stopping the graph.
Startup admission repeats the check after lifecycle hooks, so a listener that
changes between preflight and startup still refuses without adopting it; the
stopped run and its volumes remain available for a corrected retry.
Selected services receive `init: true` when omitted because the guest relay launcher
requires a reaping init process. An explicit `init: false` is refused, not replaced.

Fresh pools reserve the number of distinct dependency transports from that
selection. Existing pool capacity cannot be silently widened. The selection is copied into the temporary exact-plan
dependency request and removed when foreground startup exits. No durable listener
authority is inferred from a saved selection file. Image-only services omit graph
shared-source mode; active project bind mounts still use the explicit project share.

For projects whose checked-in Compose file needs explicit native health probes,
`HACK_NATIVE_ADAPTATION` selects an absolute JSON file. This leaves the source file
unchanged and preserves its identity in native review. Only the following bounded
adaptations are accepted:

```json
{
  "version": 1,
  "isolatedNetworks": ["hack-dev"],
  "httpProbes": {"web": {"port": 3000, "path": "/health"}},
  "additionalHostnames": {"web": ["web.hack.local"]},
  "additionalHostAliases": {"web": ["host.docker.internal"]},
  "workspaceCache": {
    "volume": "node_modules",
    "root": "/app",
    "workspaces": ["apps/web", "packages/db"]
  }
}
```

Networks must already be declared external; selection explicitly replaces their
connectivity with the owned isolated network. Probes apply only when no existing
healthcheck is present. Additional hostnames append to existing Caddy labels.
Additional host aliases append explicit `host-gateway` declarations and still need
separate pinned dependency selections; they do not enable general host access or
override fixed-address aliases. Conflicts are refused. Choose actual application
health endpoints; a probe is an application readiness contract, not a workaround
for failed startup.

The optional workspace cache layout mounts subdirectories of the existing declared
dependency volume at each workspace's `node_modules`. This allows an installer to
populate nested workspace dependencies while its project source remains read-only.
Every service already consuming the root dependency volume receives the same layout,
including the root mount's read-only setting. Unrelated services are unchanged.
The layout participates in native dependency-cache identity. This shares compatible
workspace installations; it does not implement a cross-project package store or
claim deduplication across different lockfiles.

### Optional prepared base for a fresh pool

A prepared base formats a **new** pool's disks from an independently verified snapshot of a
sanitized seed pool instead of the stock templates. It changes only pool creation: the first pool
in a candidate home, or one recreated during recovery. Existing pools and graph starts inside a
running pool are unchanged. It is off unless selected and is macOS APFS only.

Build and verify a base in a private store on the same volume as the candidate home. The installed
candidate defaults to `<HACK_NATIVE_HOME>/prepared-bases`; pass `--store /absolute/private/store` to
use another:

```sh
./bundle/hack-native --candidate-root /absolute/private/candidate-home runtime prepared-base build --profile development --json
./bundle/hack-native --candidate-root /absolute/private/candidate-home runtime prepared-base verify --base-id BASE_ID --json
./bundle/hack-native --candidate-root /absolute/private/candidate-home runtime prepared-base status --profile development --json
```

`build` boots a disposable seed pool from cloned providers, with no project, sockets, graphs or
credentials. It installs network tools under the base owner, removes per-pool identity and
runtime residue, and publishes the stopped disks. `verify` boots a separate disposable verifier
from the published base and reads both disks before any setup; a base becomes usable only after it
passes. Both need the same host admission as a development pool while they run, and both delete
their disposable machine afterwards. If one is interrupted, `status` lists its work root under
`abandoned_work`, and the next `build` or `verify` removes it before starting, except while a
provider still runs there. `status` also reports each base under `bases`.

Then select it for normal foreground startup:

```sh
export HACK_NATIVE_PREPARED_BASE=prefer   # or require; unset or off disables
export HACK_NATIVE_PREPARED_BASE_STORE=/absolute/private/store   # optional
```

`prefer` uses the newest verified base bound to the pool's provider, engine, network-tools and
capacity pins, and otherwise keeps the stock templates; `runtime status` records the reason.
`require` refuses before creating the pool. An existing pool ignores the selection. Remove a base
with `runtime prepared-base remove --base-id BASE_ID`; a pool never depends on its base after the
first start.

`scripts/accept-native-frontend.py` checks this path end to end for one owned linked worktree.
- It builds and verifies a base, then runs ordinary `hack-v5 up` with `require`, so the frontend
  creates the pool from that base with the worktree as its exact share.
- It checks healthy HTTPS against the home's private Caddy root and writes a `/data` marker.
- It runs `down`, edits the served file on the host, and runs `up` again. It then requires the
  same run in a new container, HTTPS serving exactly the edit, and the marker.
- Finally it disposes of the pool, base, provider alias and fixture with readbacks.

It prints its plan unless `--run` is given and is a correctness check only. On any failure, or
when its `--budget` runs out, it issues no further commands and keeps all state for diagnosis.
The only process it can terminate is one of its own bounded commands, whose direct child
`subprocess.run` kills when its timeout expires; it never signals a foreground or a VM. Ambient
`HACK_NATIVE_*` variables are dropped, so only its declared selections reach the candidate. Its
stand-in controls run with
`python3 -m unittest discover -s tests/python -p test_native_frontend_acceptance.py`.

### Optional native HTTPS frontend

For routed foreground startup, explicitly set all three public selections:
`HACK_NATIVE_CADDY_BINARY` (absolute host Caddy executable),
`HACK_NATIVE_CADDY_SHA256` (its lowercase SHA256), and
`HACK_NATIVE_HTTPS_PORT` (1–65535, including 443). Unrouted graphs do not start
this frontend. The selected process and managed hostname authority belong to the
foreground invocation; unexpected loss aborts the graph and reports failure.
They close after graph cleanup, while private Caddy data and its CA remain under
`<native-home>/native-https/data`. An occupied frontend owner is refused.

The selected port must be available to the current host user. On hosts that restrict
port 443, use an unprivileged test port such as 18443 or separately configure
authorized host forwarding. Startup checks bind permission and leaves existing
listeners untouched; it never elevates privileges automatically.

Startup verifies each reviewed hostname using loopback, SNI, Host, and the private
CA, without relying on DNS or installing system trust. It requests the service's
reviewed native HTTP health path and requires a 2xx response, matching the guest
readiness policy. It does not render `/` merely to verify an alias. The guest
readiness probes remain required; a health response does not establish a usable
browser session. DNS and user-approved trust setup are separate prerequisites for
normal browser access.

With the native backend selected, `hack doctor --json` inspects the active
frontend owner, the exact Caddy listener and root certificate, and macOS
System-keychain trust. A retained root file or an older same-name certificate
does not count as current trust. To check a real app route, pass an exact HTTPS
origin with `--browser-url`; Doctor verifies that hostname over loopback with
the live root, checks that every host DNS answer points at its IPv4 loopback
relay, and reports normal macOS TLS separately. `--browser-result` records
your manual observation for that origin; CLI success alone does not prove a
browser session works.

The native candidate refuses `hack global install`: that command owns the
Docker global stack and could change installed v4 routing. For a dedicated
custom suffix alongside v4, run `hack global dns preview --domain v5.hack.gy`
and then `hack global dns activate --domain v5.hack.gy`. Omit `--domain` to use
the configured global `default_domain`; changing that shared setting also
changes the installed v4 CLI's default. Preview is read-only;
activation shows the exact scoped claim and requires interactive confirmation
and a native administrator prompt. Run it from a terminal; the bounded privileged
steps preserve that terminal's sudo authorization and report the underlying
command failure if a step fails. Before changing files, the candidate checks that
the root-owned Homebrew system launchd job matches the inspected dnsmasq command
and configuration. It restarts that verified job directly through launchctl, so
activation does not need Homebrew metadata downloads as root. Missing, changed or
ambiguous service ownership refuses. It adds one owned dnsmasq include file and
one resolver file pointing the selected suffix to 127.0.0.1, while leaving
the built-in v4 DNS rules intact. An existing or overlapping foreign claim,
uninspected configuration source, or uncertain prior activation refuses.
Activation verifies direct and system DNS and conditionally removes only its
own files if verification fails. To remove this scoped claim, use
`hack global dns deactivate --domain v5.hack.gy`. It requires a matching active
private receipt and unchanged file identities across confirmation, then removes
only those two owned files, restarts dnsmasq and verifies the parent fallback.
The private receipt becomes `inactive` after proof so a later activation can
reuse the suffix. An interrupted activation retains a `pending` receipt; an
interrupted deactivation retains a `removing` receipt. Both refuse automatic
retry until the partial state has been reviewed and explicitly recovered; do
not delete these files or receipts blindly. The built-in `hack`,
`hack.local`, and `hack.gy` roots cannot be claimed wholesale by this command;
a dedicated `v5.hack.gy` subtree is supported when its v4 parent is verified.
Existing project hosts and reviewed routes are not migrated.

DNS activation alone does not prove that an app route, certificate, port 443,
or OAuth redirect is ready. Use `hack doctor --browser-url` for the exact app
origin and test the browser session. Google OAuth requires a separately
registered compatible redirect origin; `.local` may be rejected by the provider.

`hack doctor --fix --browser-url https://your-app.hack.local` can install only
the verified live root after interactive confirmation and the native macOS
administrator prompt. It checks the owner, root and route again after that
prompt and verifies trust after installation. A missing, stale or changed owner
refuses repair. The native `hack global trust` path directs you to this scoped
Doctor command instead of falling back to Docker's exported CA. The native
repair does not set up DNS or a browser's Local Network permission.
Both authorization and installation retain the caller's controlling terminal,
so terminal-scoped sudo authorization remains valid during the bounded repair.

The runtime's read-only `runtime inspect-host-listener --pid PID --port PORT
--executable /absolute/caddy --json` reports the selected same-user loopback
listener identity. The optional `--peer-port PEER_PORT` proves Caddy accepted
that exact still-open TLS socket, including when Caddy enables `SO_REUSEPORT`.
Doctor and native startup use the peer proof before accepting a TLS route.
A PID, file path or listener fingerprint alone is not proof of an owned
frontend or CA.

The probe pins its TCP connection to loopback independently of SNI and Host.
Failed HTTPS verification reports a reviewed TLS/transport error code or
`VERIFICATION_TIMEOUT_HANDSHAKE` / `VERIFICATION_TIMEOUT_RESPONSE`, without peer values. Unknown errors use
`TLS_OR_TRANSPORT_ERROR`. Startup saves the project run mapping only after these
checks succeed. Confirmed graph cleanup preserves the original startup error. If final
inspection or cleanup cannot be confirmed, the error instead reports retained-state
uncertainty alongside the sanitized startup diagnostic. Any published mapping remains
intact; inspect owned runtime and bridge state before retrying. A native cleanup
error code is included when available, without its raw output or message. When a
foreground owner refuses cleanup, the CLI also preserves its bounded cause code
alongside `graph_owner_recovery`; raw owner diagnostics remain omitted. Failed
cleanup is never automatically replayed.

### Explicit cleanup after a dead foreground owner

For a fully ready graph whose foreground owner died while its pool remains on the
same boot, `graph recover-live-owner --run-id RUN --expect-receipt SHA256` selects
only that graph. It requires matching dead foreground and relay-owner identities,
unchanged receipt and resource inventories, and exclusive publication locks. The
operation stops verified guest dependency listeners, removes owned containers and
network resources, retains persistent data, retires stale foreground and relay
publications, and releases the graph's dependency reservation before unlocking the
pool. It does not restart the pool. Pending startup, one-off or dependency
rebind state is refused. A completed dependency refresh is accepted only for the
current boot and exact ready receipt generation, with matching terminal services
and helper markers. After owned absence is independently verified, its journal is
archived before stale publications are retired. An interrupted archive resumes
from the committed cleanup proof and exact journal bytes; it never replays refresh.
Completion records owner-death evidence independently of
the live relay acknowledgement protocol.
When a restored publisher is admitted, older absence-retirement records remain
validated history; the exact current cleanup proof supplies retention authority.

After completion, retained restore can create a fresh owner;
`graph retire-recovered-publisher --run-id RUN --expect-owner OWNER` remains an
idempotent compatibility operation. Interrupted cleanup retains its journal for an
explicit retry with the original receipt hash. A pool boot
change, replaced process or socket evidence, or ambiguous ownership refuses recovery.
The separate previous-boot operation below preserves its existing ownership
requirements.
A graph with completed host-dependency startup and no inbound routes can also use
its exact dead relay publication as the previous-boot proof; an empty bridge
registry alone never grants cleanup authority.
A completed previous-boot or same-boot recovery may remain as historical evidence
after restore.
When its exact stopped receipt remains in bounded restore history, that receipt
must match the completion proof. After history eviction, only a self-consistent
proof for the same graph and a different container generation can be treated as
inert history; the verified truncated history must independently contain a later
stopped generation. This does not establish the evicted completion hash as current
authority. Same-boot history also requires validated listener retirement.
Incomplete, foreign, one-off, conflicting or missing-history records
refuse without modification. Current owner, boot, process, receipt and resource
checks still authorize cleanup independently, including on retries.
A later previous-boot recovery may archive that validated older completion even
after its exact stopped receipt has been evicted. It preserves the original proof
bytes and inode by renaming it; it does not reconstruct an evicted receipt or use
historical evidence as current cleanup authority. Pending or incomplete proofs,
changed graph identities and an unchanged container generation still refuse.
Retention and recovered-publisher retirement prefer a completed previous-boot
proof that matches the exact current stopped receipt. An older same-boot proof
must still pass historical validation; its presence cannot redirect these
operations away from the current proof. Pending, incomplete, malformed or
conflicting same-boot records continue to refuse both operations.
An already completed prior-boot dependency archive is likewise historical
metadata. Restore may leave it untouched after validating its original generation,
boot, journal and exact artifact hashes, with no active or pending journal and an
independently confirmed current retention proof. Eviction of its old stopped
receipt does not require repeating completed archival. First-time or interrupted
archival still requires the exact selected cleanup proof and ownership checks.
The same-boot completion proof does not authorize direct data removal: restore the
graph and use ordinary cleanup for that operation. Native routed recovery has been
qualified with repeated owner crashes, retained data and an unaffected sibling's
HTTPS route; this does not establish normal source-mounted worktree parity.

`graph recover-cleanup --run-id <run> --expect-receipt <sha256>` is a retaining,
explicit two-step recovery for a failed enrolled graph. Select the SHA256 of its
private `state.json` receipt while the owned runtime is confirmed stopped. The
first invocation records the exact receipt, dead foreground owner, and old boot;
it returns `awaiting-runtime-start` without guest effects. After explicit ordinary
`runtime up`, repeat the same command and original receipt hash. Recovery requires
the same pool incarnation and the selected previous boot, removes only verified
owned containers and networks, and retains named volumes and dependency caches.
It neither marks incomplete package caches valid nor replays initializers.

If a foreground owner died after its graph reached `ready-observed` and the pool
has already restarted once, the same explicit command can select recovery on that
immediate successor boot. It requires the retained dead-owner identity, exact receipt
hash, and bridge assignments belonging to the recorded previous boot. The recovery
intent pins those assignments before effects and refuses replacements on retry.
Do not restart again to attempt this path: another boot rollover invalidates the
previous-boot evidence. Old guest helper absence follows the verified boot transition;
it is not recorded as a live helper acknowledgement.

Recovery retains its own durable intent and completion evidence. It does not forge
a relay acknowledgement. A normalized graph can explicitly retire its recovered
publisher and select a fresh foreground restore using the retained data. Missing
or replaced foreground evidence, pending graph journals, unfinished explicit page-cache release, changed
inventories, another boot rollover, and unsupported prior cleanup enrollment
refuse. Preserve these files and use the reported reconciliation path rather than
editing receipts. Receipt-only export/prune still requires its existing relay
acknowledgement. Runtime restart and actual cleanup remain explicit operations.

After recovery completes, explicitly remove that graph's retained data with:

```sh
./hack-native --candidate-root /absolute/private/candidate-home graph cleanup --run-id RUN_ID --remove-data --json
```

This separate destructive request requires the retained dead-owner identity and
completed recovery evidence on the same boot. It also works after explicit
`retire-recovered-publisher`: the archived publisher must match the recovery's exact
owner fingerprint and completed receipt, with unchanged archived record, socket and
lock identities. No application restore is required first. Partial retirement,
missing evidence or another boot still refuses removal. Ordinary acknowledged
cleanup keeps its own authority even when an older recovery record exists.
Before removal it verifies the receipt's ownership labels and journals the current
volume inventory. Retries refuse changed ownership or replacements relative to
that removal inventory. The older recovery receipt does not independently pin a
volume's creation timestamp before the first removal request. An interrupted
removal can resume against its recorded inventory; it does not authorize removal of
another graph's volumes. Recovery alone continues to preserve data. Keep the
recovery evidence until cleanup finishes; deleting it is not a repair.

Private environment delivery preserves the selected numeric image or Compose
`User`, including UID-only values. Docker resolves the application's primary and
supplementary groups from the image; the wrapper does not replace them with group
zero. UID-only private files and relay/probe helpers use group zero as their own
storage/helper metadata, not as the application's identity. Payload files remain
owner-only mode 0400 with exact UID, regular-file, single-link, size, and no-follow
checks. Named users/groups remain unsupported for private delivery and refuse
instead of silently becoming root. An image with no user retains Docker's normal
root default; an explicit Compose numeric user takes precedence.

### Approved-host DNS on pool restart

The pinned Smol provider re-resolves approved hosts at each boot and appends the
results to its retained runtime CIDRs. The candidate accepts at most 512 runtime
entries, including duplicates, only when all original pinned addresses remain
present and every entry is a canonical public IPv4 `/32` or IPv6 `/128` address.
Private, loopback, metadata, broader subnet, missing-pin and oversized results
remain refused. The durable provider database must still match the approved host
list and original CIDRs exactly; restarting does not expand the approved hosts.

This audit trusts fresh DNS resolution by the pinned provider. It does not
independently prove which hostname produced each added address. Existing dynamic
DNS and descendant-host policy semantics remain unchanged.

Native HTTPS startup probes each reviewed alias at its service's reviewed native
HTTP health path. A 2xx response qualifies directly. Redirects (301, 302, 303,
307, 308) qualify only when their chain ends at a verified 2xx response from another
reviewed alias of the same service and health path. Redirect targets must use HTTPS,
port443 or the selected frontend port, and no credentials, query or fragment.
Cycles, external names and cross-service redirects refuse startup. Every request
still connects to loopback with the selected private CA and the alias as SNI/Host;
redirect URLs never select network destinations. Response headers are bounded to
8KiB; malformed headers and duplicate Location fields are refused. Only bounded
headers are parsed and returned; unrelated repeated headers such as Set-Cookie
are allowed.

### Normal native exec

With the same explicit native binary/home selection used for `up`, run
`hack exec --path /absolute/project SERVICE -- /bin/echo hello`. The command targets
the current owned project/branch mapping, preserves binary stdout/stderr and the
command exit code, and never falls back to Compose. It is noninteractive, with a
30-second observation budget; a timeout may leave the command running and is not
retried. `--env` and `--profile` changes are refused. A command name such as `bun`
uses the selected container's PATH; no host PATH or implicit shell is used. Normal
`hack exec` resolves the saved startup overlay and AWS profile again, and delivers
fresh selected-service values through private stdin.
Each request binds the reviewed plan, current container and generation, and has
its own short ingress lifetime. Startup leases and files are not renewed or rewritten.
The allocation is selected from the current container's exact read-only mounts and
checked against its committed current-boot intent. Historical allocations retained
by earlier restores do not compete with this selection; pending, mismatched or
ambiguous mounted allocations are refused.
Legacy mappings without explicit selectors and services with older launcher mounts
refuse before execution; restart with the matching candidate to adopt this path.
Services without managed values use ordinary exec. The native live qualification
of this fresh-delivery path remains separate from its unit and transport tests.


A detached HTTPS helper that fails during startup may retain a generation-bound
`startup-failure.json` beside its owner configuration. The CLI reports only the
reviewed startup stage and an allowlisted native error code; child output, paths
and application values are omitted. If lease cleanup also fails, the original
acquisition diagnostic remains visible alongside the unconfirmed cleanup status.
This record is diagnostic evidence only: it does not acknowledge retirement or
permit a replacement owner. A missing record (including a helper crash before
publication) leaves the cause unknown. Preserve the retained owner and finalization
records for inspection; do not delete them to force another startup.
