# Native file input planning

The experimental pure compiler accepts named file configs and file secrets.
`config validate` normalizes their declarations, while `config plan` reports
selected file grants using managed-env metadata. Neither operation reads file
material, decrypts values or establishes backend admission.

```json
{
  "configs": { "settings": { "file": "config/settings.bin" } },
  "secrets": { "token": { "env_ref": "TOKEN" } },
  "services": {
    "reader": {
      "image": "example/reader:1",
      "environment": { "TOKEN": { "unset": true } },
      "mounts": [
        { "config": "settings", "target": "/etc/reader/settings", "access": "read-only" },
        { "secret": "token", "target": "/run/secrets/token", "access": "read-only", "mode": "0444" }
      ]
    }
  }
}
```

This fragment belongs in a project with `schema_version: 1` and a project name.
Configs use a project-relative `file`. Secrets use exactly one project-relative
`file` or managed `env_ref`; there is no inline content, template, caller env source,
arbitrary scope, external resource or driver. File paths anchor the verified current
checkout, independently of cwd, `.hack` and `source.root`. A linked worktree selects
its own file rather than inheriting a primary checkout's source file.

Each grant has one source tag, an explicit absolute file target and explicit
`access`. Mode defaults to `0444` and accepts four octal digits from `0000` through
`0777`. Optional numeric `uid` and `gid` preserve ownership intent. The compiler
validates every declaration and workload, including disabled profiles and unused
resources. Unknown names, malformed source choices, invalid paths or permissions,
duplicate normalized targets and file targets overlapping another mount refuse.
The root target `/` cannot serve as a file.

Managed file grants are separate from environment delivery. An `env_ref` binds to
the selected workload's managed baseline using the existing scope, overlay and
verified worktree metadata. An authored env `unset` prevents ordinary env delivery
while preserving that separate file reference. A missing or tombstoned baseline
entry makes the file plan incomplete; a literal or default env value cannot restore
the missing file authority. Empty managed values remain present values; material
delivery must preserve them as zero-byte files without adding a newline.

The public `file_plan` contains references and selected metadata only. Its
`complete` flag and diagnostics are independent of `environment_plan`; `config plan`
fails if either plan is incomplete. Private bytes, decryption results, material paths
and content-derived fingerprints do not belong in this report or its semantic hash.
The CLI negotiates `file_plan_version: 1` before sending authored file intent and
checks that sources, grants, permission intent and managed metadata were preserved.
An older compiler refuses even an empty file namespace.

The experimental Compose path maps selected grants to private read-only bind files
for whole-project `up` and `restart`. A successful file plan alone grants no
execution authority: delivery requires the live generation mutation, selected
managed owner and exact material projection. The native graph adapter continues to
refuse raw file namespace presence, including empty definitions and inactive
grants, before private value copies. Neither path falls back to another backend.

The host snapshot path remains read-only mode `0444` with no UID/GID override.
New or explicitly recreated containers with read-only `0400`/`0600` grants or
numeric ownership use a separate VM material owner. Other modes, writable access,
one-off `run`, and builds combined with file inputs remain refused. File-backed
Compose config/secret mounts do not implement portable ownership remapping, so
emitting ignored attributes would not satisfy this contract. See the
[Compose long-syntax contract](https://docs.docker.com/reference/compose-file/services/#secrets).
This transport does not change retained adoption policy or permissions on an
original config or secret file.
The VM owner pins the selected image's user and inherited labels before creating
material. An omitted image user has Docker's empty-user default, `0:0`; a present
user value is validated without empty-value coercion. Omitted volumes and labels
mean no image-declared volumes or inherited labels. Present malformed values and
nonempty image volume declarations refuse before VM resource creation.
Private snapshot ownership, freshness, exact bind
projection, interruption recovery and verified cleanup have separate source and
synthetic engine qualification boundaries. See the
[Compose renderer boundary](native-compose-renderer.md) and
[generation recovery contract](native-compose-generation.md).

The filesystem owner acquires only compiler-selected grants under the
actual generation mutation lease. It keeps the checkout, source parents and leaf
files open and rechecks their identities around bounded reads. The aggregate input
bound is 1 MiB. Secret files require mode 0400 or 0600; config files and source
parents must not be group/world writable. Empty and binary bytes remain exact.
Managed references resolve through the existing env owner, independently of
authored env delivery, without reading caller env or introducing encryption.
Before hooks receive symbolic planning inputs without file reads or staging. After
known before-hook completion, Hack reacquires the same compiler selection and
managed owner before reading file bytes. Hooks may create the selected source file;
changing selection or unsupported permission intent refuses delivery. All authored
build/file combinations, including inactive workloads, refuse before private reads.

Snapshots use owned 0700 directories outside the checkout, exclusive 0444 files,
0600 metadata and exact read-only binds with `create_host_path: false`. A private
generated extension anchors the root receipt, snapshot, manifest and file identities.
The bind projection encodes literal dollar signs once for Compose interpolation;
filesystem paths and the stored reference remain raw. Saved document checks require
those exact encoded binds and reject interpolation in additional mounts, including
extra binds into the private material root.
Public plans, logs and CLI receipts contain no values, private paths or content
digests. Copied identities, reservations or handles cannot mint mutation authority;
closing the mutation revokes that authority and awaits its owned work.
The material root is under the canonical global runtime directory, outside
the checkout and build context. If that global home is missing, Hack creates only
its 0700 leaf beneath an existing, held, owned and safe parent. Existing safe homes
retain their mode; symlink, unsafe, foreign-owned or replaced directories refuse.
Hack does not create an authored source or an
absent bind path to make admission pass. The private generated document also binds
the exact Docker engine. Before and after delivery, fixed bounded read-only queries
verify that each file container has the exact source, target and read-only mount.
Existing mounts of the material root or its ancestors refuse before staging writes
members; retained descendant snapshots stay independent. The root fence repeats
before spawning, together with immutable member/projection and ownership checks.
Any extra mount overlapping the snapshot, including an unrelated container's mount
of an ancestor directory, refuses readiness or retirement. The observation has a configured phase deadline
and aggregate private output budget.

A fixed-inode append journal separates effects-possible, known child reaping,
retirement intent, each member unlink and the final retired marker. Unarmed rollback
requires the original live attempt. Armed material cannot retire merely because
containers disappeared: the original live attempt must have recorded verified child
completion, and hooks must be known. Saved stop checks exact immutable references
and fresh owned-container and global snapshot-mount absence on the saved engine,
without authored reads or decryption. Natural Compose child exit qualifies reaping
only after its owned process group is absent. Cancellation, timeout or surviving
descendants never infer a reaping receipt from container absence. A missing
member before retirement intent refuses; a missing member after exact intent permits
retry, while replacement always refuses. Old material retires before generation
handoff, and the pending generation remains until the finalizer and fresh ownership,
full current file/member/mount readiness, engine and pending checks pass. A failed finalizer retains the exact recovery
reference, including a crash or drift after member unlink but before the stopped
receipt. Repeating verified stop can finish an exact already-retired journal.

Closing a material owner does not delete snapshots. Interrupted preparation before
generation publication conservatively retains its directory; this slice does not
scan or adopt orphan snapshots. An interrupted journal write that cannot be parsed
also retains material. Unknown hooks or an armed journal without original-attempt
reaping remain retained after `down --recover`; this slice has no interface for
clearing that uncertainty. It does not reconstruct a lost generation from an orphan
snapshot. Compiler/filesystem/process controls with strict Docker stand-ins do not
establish actual container delivery; compiled synthetic engine acceptance remains
a separate gate.

Each saved stop also synchronizes a `stop-armed` record before Compose. Only that
live stop attempt may append `stop-reaped` after natural exit and owned-group
absence. A prior unknown stop cannot be handed off to a later invocation, even if
another `down --recover` succeeds and no snapshot binds remain. Owned stop remains
available; the exact pending reference and material remain retained. Stop records
can append after retirement intent or the retired marker, so a retry cannot lose
this boundary during partial deletion or the retirement/receipt crash gap.
After durable arming, cancellation and the configured deadline are checked again
after fresh ownership checks and synchronously at the actual spawn boundary,
including terminal setup. An interrupted arm retains its exact pending reference
without launching a later child or inferring reaping from engine absence.

The VM client preserves the selected `docker` command name for multiplexer clients
while checking that its physical executable and selection remain unchanged.
The VM path requires an explicit eligible local Unix Docker selection and already
cached workload images plus `oven/bun:1.4.2-slim`. It neither pulls nor builds an
image. Images declaring volumes and workload pull policy `always` refuse. Hack
pins each physical workload image and its original `Config.User`; it does not
rewrite the app command or user. An omitted grant UID/GID defaults to `0:0` only
when that pinned image has exactly empty `Config.User`. Other image users require
both explicit numeric grant IDs; no passwd or group inference is performed.

Under the existing material lease, Hack synchronizes a separate VM intent and
creates one fresh local volume. A fixed short-lived writer receives bounded
private stdin, exclusively creates opaque members, sets permissions on these new
copies and synchronizes them. Original sources and host copies keep their modes.
A random witness, stat/hash/stat observations and selected-owner reads bind the
private volume incarnation. Protected members must actually refuse a distinct
UID's read with `EACCES`.

One readonly observer container remains with the generation. It has no network,
ports, restart policy or idle polling: it waits on stdin, and runs fixed commands
only for admission, readiness and retirement. Its readonly volume and exact
daemon-native single-file binds must identify the same members. Before app
creation, actual observer reads must satisfy ownership and distinct-UID denial,
and a privileged write open on the projected file must return `EROFS`. Failure
refuses app startup; there is no host-bind fallback. The app receives only its
exact granted readonly files, never a mount of the material parent. This adds a
private observer and volume per generation; it makes no resource-reduction claim.

A separate fixed-inode journal arms every guest observation before exec. Unknown
writer or observation results retain material and never earn deletion. Only the
host owner's known-child or unarmed-rollback journal can issue VM retirement.
Fresh same-engine checks bind the exact volume, observer, members and all current
consumers. Retirement stops and nonforce-removes that exact observer, proves full
consumer absence, then nonforce-removes the singleton owned volume. If interruption
loses the observer witness while its volume remains, a later invocation retains
the volume rather than deleting from its name and birth alone. Saved owned stop
remains possible with a valid unknown-observation journal; retirement stays refused.

Offline emitted-program and fake-engine controls do not establish provider support.
Actual owner/nonowner access, readonly write refusal, ungranted isolation and full
lifecycle/recovery qualification remain separate gates for this VM transport.
