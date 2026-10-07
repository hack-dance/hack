# Install a native prerelease alongside stable Hack

Native prereleases are opt-in Apple Silicon macOS bundles identified by
`5.0.0-next.N`, with a positive number and no leading zero. Install a specific
published GitHub prerelease. Download the installer from that same explicit tag
over HTTPS, review the saved file, then run it locally:

```sh
curl --fail --location --proto '=https' --proto-redir '=https' --tlsv1.2 \
  https://raw.githubusercontent.com/hack-dance/hack/v5.0.0-next.1/scripts/install-prerelease.py \
  --output hack-next-install.py
less hack-next-install.py
python3 hack-next-install.py install --version 5.0.0-next.1
```

The installer needs Python 3.9 or newer and macOS `codesign`; it does not need Bun,
Rust, Zig, or a source checkout at runtime. The bundle includes the compiled normal
CLI, native executor, Linux guest relay, launcher, provider pins, documentation,
version metadata, and checksums. Newer bundles also include an optional shared MCP
adapter, owner, backend and content-addressed manifest. A reviewed source checkout can instead use
`python3 scripts/install-prerelease.py install --version 5.0.0-next.1`. There is no
latest-version lookup or automatic updater.

By default installation creates a private, current-user-owned mode-`0700`
`~/.hack-next` directory. Each immutable version directory contains a complete
bundle, its own `native-home`, and its own `cli-home`. An installation receipt binds
the bundle hashes and both homes' filesystem identities. Stable Homebrew `hack`,
its links, and `~/.hack` are untouched. No shell profile or PATH is edited.

Run the candidate explicitly:

```sh
"$HOME/.hack-next/bin/hack-next" --version
"$HOME/.hack-next/bin/hack-next" ps --path /absolute/project
python3 "$HOME/.hack-next/manager.py" --root "$HOME/.hack-next" status
```

`hack-next` selects the adjacent verified native executor and the selected version's
private native and CLI homes. These settings override inherited installation
selectors, including `HACK_GLOBAL_CONFIG_PATH`. Explicit native project adaptation,
dependency, AWS profile, routing, and source-sharing settings still reach the CLI.
Arguments, standard input and output, exit codes, and signals reach the selected
candidate. Concurrent observation and stop commands can accompany a foreground
candidate command; selecting another bundle refuses while any launcher is active.

Every invocation verifies the retained bundle bytes and receipts again. MCP's
nested identity uses digests from that same verification pass; it does not reread
the same executable or reuse a previous invocation's trust result. Download and
archive code loads only when installing software. Strict signature verification
checks all bundled macOS binaries in one bounded `codesign` invocation and refuses
any failed or unavailable check. These reductions preserve retained-version
validation and the selection lock. Apply the
reviewed `upgrade-manager` operation below to an older installation to receive
manager changes; upgrading a bundle alone retains the original manager.

Provider setup and actual application acceptance remain separate steps. Installation
does not install the provider, boot a VM, enroll a project, move volumes, or activate
system DNS or trust. Follow [native candidate preparation](native-candidate.md)
using the selected bundle and its `native-home`. Candidate `hack-next update`
retains the existing refusal; use the channel manager's explicit upgrade command.

## Upgrade and return to a retained candidate

Shared MCP packages need the matching retained installation manager. Older channels
keep their original `manager.py`; running a newer installer against that root does
not update it. The newer installer refuses an MCP upgrade when its own bytes differ
from the retained manager, before publishing a version or changing selection.

To update a reviewed predecessor manager, including the original flat-layout
manager shipped with `5.0.0-next.1`, review a newer installer containing
`upgrade-manager`, then run that saved file explicitly:

```sh
python3 /absolute/reviewed/install-prerelease.py --root "$HOME/.hack-next" upgrade-manager
python3 "$HOME/.hack-next/manager.py" --root "$HOME/.hack-next" status
```

Stop every retained version's graphs and runtime first, using the commands below
with that version's paths. Manager upgrade takes the channel's exclusive lock,
refuses active launchers, and applies the existing quiescence checks to every
retained version. It recognizes exact reviewed predecessor bytes and the standard
launcher; custom or changed code, modified receipts, changed home identities, and
aliased paths are refused. It preserves the launcher, installed bundles, home
identities, and the selected/previous versions. The original manager and receipt
remain in a private staging directory for inspection. Repeating the command with
the already installed manager is a no-op.

After this step, use the retained manager for ordinary bundle upgrades and rollback.
It accepts both old flat bundles and new MCP bundles. This operation does not
enroll MCP clients or migrate application data. For an unsupported manager, keep
the existing channel and use a fresh root such as `--root "$HOME/.hack-next-mcp"`;
do not edit its receipt to force adoption.

Stop each candidate graph with its ordinary retained-data shutdown, then stop that
version's owned runtime through the native executor. For the default installation
of `5.0.0-next.1`:

```sh
"$HOME/.hack-next/bin/hack-next" down --path /absolute/project
"$HOME/.hack-next/versions/5.0.0-next.1/bundle/hack-native" \
  --candidate-root "$HOME/.hack-next/versions/5.0.0-next.1/native-home" \
  runtime down --json
python3 "$HOME/.hack-next/manager.py" --root "$HOME/.hack-next" \
  upgrade --version 5.0.0-next.2
```

Upgrade requires a strictly newer version. Before and immediately before switching,
the manager verifies the selected bundle and receipts, asks that executor for
`runtime status --json`, requires an explicitly stopped runtime, confirms the
supported `runtime down --json` under the executor's ownership lock, and checks
status again. A running, failed, timed-out, malformed, or ambiguous observation
refuses selection. An uninitialized runtime is accepted only when its native home
is completely empty; unexplained leftover state requires inspection through its
owning CLI. The manager never treats a missing PID or a failed command as idle.

Every new version starts with **fresh native and CLI homes**. Prepare its provider
and application explicitly. Upgrading selects software; it does not copy or migrate
the previous candidate's VM, project registry, volumes, environment store, or data.
The previous bundle and homes remain in place.

After stopping the newly selected candidate in the same way, return to the previous
retained version and its original homes:

```sh
python3 "$HOME/.hack-next/manager.py" --root "$HOME/.hack-next" rollback
"$HOME/.hack-next/bin/hack-next" --version
```

Both the current and target candidate must pass the same quiescence checks. Use
`rollback --version 5.0.0-next.1` to select another already registered retained
version. Read back a saved application marker after restoring its owned runtime
before claiming application rollback worked. Bundle selection alone does not prove
application or provider compatibility.

## Return to stable Hack

Stop the selected graphs and runtime, then deselect the candidate:

```sh
python3 "$HOME/.hack-next/manager.py" --root "$HOME/.hack-next" stable
hack --version
```

Use your existing stable `hack` command and stable projects. `hack-next` reports
that no candidate is selected after this operation. All candidate bundles and
homes are retained. Candidate settings are confined to launcher children, so the
launcher does not leave exports in your shell. If you previously exported native
selectors manually, unset `HACK_RUNTIME_BACKEND`, `HACK_NATIVE_BINARY`,
`HACK_NATIVE_HOME`, `HACK_HOME`, and `HACK_GLOBAL_CONFIG_PATH` before running stable
Hack. This is software selection and coexistence, not conversion of native v5 VM
application data into the stable Docker runtime.

## Verification, isolated installs, and interruption

The network path accepts only the explicit tag in `hack-dance/hack` on GitHub.
GitHub must classify it as a published prerelease. The exact archive name is
`hack-VERSION-darwin-arm64-native.tar.gz`; the separate `prerelease.json` and outer
`SHA256SUMS` release assets must agree with it. HTTPS and official download hosts
are required, including redirects. Metadata binds the version, tag, full source
revision, and platform before extraction. The official tag reference must point
directly to that exact commit; moved, annotated, or malformed references refuse
installation before downloading the archive. The archive digest, every inner file
digest, exact payload inventory, and all macOS executable signatures are verified
before activation. An ad-hoc signature checks code integrity; it is not Apple
notarization or publisher authentication. The official pinned release and its
checksums remain the source identity boundary.

For a private qualification installation, use an explicit canonical root whose
parent already exists. On macOS, use `/private/tmp` rather than the `/tmp` symlink.
A root must be empty or already belong to this manager; foreign paths, symlink
components, hard-linked payloads, changed receipts, and archive links, duplicate
entries, or traversal are rejected. A reviewed local archive can be installed with
an independently obtained expected digest:

```sh
python3 scripts/install-prerelease.py --root /absolute/private/new-install \
  install --version 5.0.0-next.1 \
  --archive /absolute/reviewed/hack-5.0.0-next.1-darwin-arm64-native.tar.gz \
  --sha256 EXPECTED_ARCHIVE_SHA256
```

Run that installation's `bin/hack-next` and pass the same `--root` to its manager.
Repeating an installation of the selected unchanged version is idempotent. Status,
launch, upgrade, and rollback revalidate the installed bundle, homes, and receipts.

Selection changes commit by one atomic receipt replacement. A failed extraction,
checksum, signature, quiescence check, or interrupted pointer replacement preserves
the earlier selection. Interrupted staging directories and a complete bundle
published before an interrupted pointer switch are retained for inspection and
never adopted automatically. The selected prior bundle remains usable when its
own receipt is unchanged. A later attempt refuses to overwrite the uncommitted
version. Preserve the evidence and inspect it before an authorized cleanup; the
manager has no automatic pruning or receipt-repair command.

Manager upgrades change two files: `manager.py` and its hash in `.channel.json`.
The manager first saves and syncs both versions and publishes an owned upgrade
journal. While that journal exists, both the original and newer managers refuse
ordinary launch, status, and selection commands. An interrupted upgrade can
therefore temporarily make the channel unavailable, while its selection and data
remain intact. Rerun `upgrade-manager` with the **same saved reviewed installer** to
verify the journal, staged bytes, receipts, selection and stopped runtimes, then
finish the upgrade. Recovery refuses changed or ambiguous state. Do not remove the
journal or staging directory by hand. A failure before journal publication leaves
the original manager usable; a completed upgrade removes the journal and retains
the original bytes for inspection. This does not automatically downgrade the
manager when rolling back a candidate bundle.
