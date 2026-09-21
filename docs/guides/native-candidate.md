# Opt-in native candidate bundle

`hack-native` is an experimental Apple Silicon macOS executor installed alongside
Hack's supported CLI. It does not replace `hack`, select a Docker context, migrate
projects, or install DNS or trust. Its graph commands support a bounded subset;
this bundle is not application parity or release qualification.

Build with the repository's pinned Rust 1.97.1 and Zig 0.15.2 toolchain, Python 3,
and the Rust `aarch64-unknown-linux-musl` standard library already installed. The
build refuses missing prerequisites; it does not install toolchains:

```sh
mise exec -- scripts/build-native-candidate.sh /absolute/new/hack-native-bundle
```

The destination must not exist. The bundle contains `hack-native`, the static Linux
ARM64 `hack-relay-guest`, provider pins, this guide, and `SHA256SUMS`. The relay uses
the committed guest Cargo lockfile and Zig linker wrapper, with a separate build
target directory. Packaging verifies its ELF architecture and absence of an
interpreter or shared-library requirements before publishing the bundle. It contains no provider installation, runtime
state, project data, or credentials. It can be copied outside the source checkout;
Rust, Zig, Bun and the checkout are not needed to run the resulting executable.
Host system utilities and the pinned provider remain runtime prerequisites.
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
uncertain: the command may still run, and Hack does not replay it. Exec inherits the
container's static environment; private values delivered only to the service's
launcher are not automatically available to an exec command. This is not yet normal
`hack exec` parity. Neither command persists application output in runtime receipts;
output can contain sensitive application values and should be handled accordingly.

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

Normalized enrollment, source sync, live source, restart, restore, and owner restore
are not supported. Their explicit normalization flags or recorded normalized
execution identity are refused; the executor does not silently reuse the original
file's different configuration. Use immutable source publication and a fresh run
for this bounded path. Source exclusions and runtime ownership checks remain in
force. Existing commands without these flags keep their file-based behavior.

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
A project with no admitted mapping reports not started. Foreground whole-project
`hack up` additionally requires `HACK_NATIVE_SHARED_SOURCE=1`: it exposes the exact
project tree, including ignored files, with each mount's declared write mode. Use
an explicitly prepared candidate home and the binary from a complete native bundle.
It acquires public images, privately supplies managed environment values, runs
lifecycle hooks, and publishes the run mapping after native readiness. Ctrl-C waits
for owned cleanup and removes the mapping only after confirming cleanup; named
volumes are retained. The VM remains available until explicit runtime shutdown.

This initial foreground path does not support detached/JSON startup, selected
services or external networks. Routed services and host dependencies require the
explicit native selections described below. Existing
`hack.dependencies.*` cache declarations publish the reviewed source snapshot and
require successful initializer completion before dependent services start. Cache
initializers receive immutable source mounts and writable named cache volumes;
workspace installs that write elsewhere still require explicit volume mappings. Event Agent requires further integration and is not yet supported by this
normal command. `down`, `restart`, `run` and `exec` still refuse native selection;
there is no silent fallback to the stable runtime. An uncertain shutdown retains
its mapping and evidence for recovery; do not delete managed state to retry.

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

New native foreground pools remain isolated unless `HACK_NATIVE_ALLOW_HOSTS`
is explicitly set to a comma-separated list of at most 32 unique lowercase DNS
names, for example `registry.npmjs.org,example.com`. Wildcards, IP addresses, local
names, whitespace, trailing dots and empty entries are refused before lifecycle
hooks. The provider permits each selected domain and its subdomains, including
TTL-learned public addresses; this is not a URL, port or exact-host-only policy.
The provider retains its private, loopback and metadata-address restrictions.
Selection is passed to native pool admission without implicit widening. Omitting
the variable requests no new egress capability. Package downloads can redirect to
a different domain: GitHub Packages uses `npm.pkg.github.com` for metadata and
`pkg-npm.githubusercontent.com` for tarballs. Approve both when the project uses
that registry; reaching its metadata endpoint alone does not verify installation.

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
labels. It reserves bridge capacity for declared routed services before pool
startup and enrolls only active routes from native review. Each routed service
must already declare a matching `healthcheck.x-hack-http`; command healthchecks
and missing probes are not replaced or inferred. Native review still validates
hostnames, ports, networks and labels. Foreground graph ownership supervises and
retires Unix route publishers. Without explicit HTTPS selection, this enrollment does not start a hostname authority
or Caddy HTTPS server. It never installs trust, configures DNS, or widens an existing pool.

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

The probe pins its TCP connection to loopback independently of SNI and Host.
Failed HTTPS verification reports a reviewed TLS/transport error code or
`VERIFICATION_TIMEOUT_HANDSHAKE` / `VERIFICATION_TIMEOUT_RESPONSE`, without peer values. Unknown errors use
`TLS_OR_TRANSPORT_ERROR`. Startup saves the project run mapping only after these
checks succeed. Confirmed graph cleanup preserves the original startup error. If final
inspection or cleanup cannot be confirmed, the error instead reports retained-state
uncertainty alongside the sanitized startup diagnostic. Any published mapping remains
intact; inspect owned runtime and bridge state before retrying. A native cleanup
error code is included when available, without its raw output or message.

### Explicit cleanup after a dead foreground owner

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
a relay acknowledgement or permit ordinary restore of the old enrolled graph;
start a fresh graph in the same pool after cleanup. Missing or replaced foreground
evidence, pending graph journals, unfinished explicit page-cache release, changed
inventories, another boot rollover, and unsupported prior cleanup enrollment
refuse. Preserve these files and use the reported reconciliation path rather than
editing receipts. Receipt-only export/prune still requires its existing relay
acknowledgement. Runtime restart and actual cleanup remain explicit operations.

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
