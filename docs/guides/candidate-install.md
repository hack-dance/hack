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
adapter, owner, backend and content-addressed manifest, the config compiler and its
schemas, and the Linux ARM64 storage root witness with its byte manifest. The
installer requires each of these groups to be complete or absent. It installs the
witness `0500` and its manifest `0600` beside `hack-native`, which is where authored
persistent mounts resolve them, and checks that the manifest matches the witness
bytes and the bundle's source revision. The witness runs only inside the Linux guest,
so it has no macOS signature; its checksums pin it. A reviewed source checkout can instead use
`python3 scripts/install-prerelease.py install --version 5.0.0-next.1`. There is no
latest-version lookup or automatic updater.

By default installation creates a private, current-user-owned mode-`0700`
`~/.hack-next` directory. Each immutable version directory contains a complete
bundle, its own `native-home`, and its own `cli-home`. An installation receipt binds
the bundle hashes and both homes' filesystem identities. Installation leaves stable
Homebrew `hack`, its links, and `~/.hack` untouched; only an explicit
[Compose test](#test-both-backends) uses your own Hack home. No shell profile or
PATH is edited.

Run the candidate explicitly:

```sh
"$HOME/.hack-next/bin/hack-next" --version
"$HOME/.hack-next/bin/hack-next" ps --path /absolute/project
python3 "$HOME/.hack-next/manager.py" --root "$HOME/.hack-next" status
```

By default `hack-next` uses the native backend. It selects the adjacent verified
native executor and the selected version's private native and CLI homes. These
settings override inherited installation selectors, including `HACK_NATIVE_BINARY`,
`HACK_NATIVE_HOME`, `HACK_HOME` and `HACK_GLOBAL_CONFIG_PATH`. To run the same
verified candidate on the Compose backend, set `HACK_RUNTIME_BACKEND=compose`; see
[Test both backends](#test-both-backends). Any other non-empty value refuses before
the candidate starts. Explicit native project adaptation,
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
retains the existing refusal on both backends; use the channel manager's explicit
upgrade command.

## Test both backends

The same selected candidate can run on either backend. You do not need to call the
bundled `hack-cli` directly or create a private `HACK_HOME` to test Compose.

| Backend | Command | Hack home | Routing, DNS and TLS |
| --- | --- | --- | --- |
| Native (default) | `"$HOME/.hack-next/bin/hack-next" up --path /absolute/project` | The version's private `cli-home` and `native-home` | The candidate's native routing, set up through [native candidate preparation](native-candidate.md) |
| Compose | `HACK_RUNTIME_BACKEND=compose "$HOME/.hack-next/bin/hack-next" up --path /absolute/project` | Your own `HACK_HOME` (default `~/.hack`) and `HACK_GLOBAL_CONFIG_PATH` | Your existing global Caddy, CoreDNS and local CA |

With `HACK_RUNTIME_BACKEND=compose`, `hack-next` verifies the selected bundle as
usual and then runs its `hack-cli` on the Compose backend. It keeps your Hack home,
so `https://<project>.hack` routes, container DNS and CA trust use the global
services that `hack global install` already set up. It removes `HACK_NATIVE_BINARY`
and `HACK_NATIVE_HOME` so native selections cannot reach Compose children. The
candidate's private homes are not used. Compose `up` still uses the configurable
Compose startup budget; a cold image build can need a larger
`HACK_COMPOSE_STARTUP_TIMEOUT_MS`.

Compose testing shares state with stable Hack:

- The candidate reads and writes the same project registry, global configuration
  and project `.hack/` files as stable `hack`. Stable v4 uses an older registry
  lock protocol, so do not run stable `hack` and the candidate against the same
  home at the same time. Stop one before you start the other, including the
  stable `hackd` daemon; see
  [Stop stable hackd before a Compose run](#stop-stable-hackd-before-a-compose-run).
- `hack-next` does not set up the shared global services for you. Install or
  change them with stable `hack global` commands before the candidate run.
- Both backends write generated files under the project's `.hack/.internal/`.
  Keep that directory out of Git; see
  [Keep `.hack/.internal/` out of Git](#keep-hackinternal-out-of-git).
- To test Compose in isolation instead, set `HACK_HOME` to a separate private
  directory. That home has no global services, so routing, container DNS and CA
  trust are not tested.

Leave `HACK_RUNTIME_BACKEND` unset, or set it to `native`, to return to the native
default. A shell that exported `HACK_RUNTIME_BACKEND=compose` for other work also
selects Compose for `hack-next`; unset it before native testing.

Backend selection needs the current channel manager. The manager released with
`5.0.0-next.3` through `5.0.0-next.5` always selects native, and ignores
`HACK_RUNTIME_BACKEND=compose`. Run the reviewed `upgrade-manager` operation below
once to receive backend selection. This works for every retained bundle, including
`5.0.0-next.5`. Candidate CLIs from `5.0.0-next.5` and earlier refuse `update` only
on the native backend; do not run `hack-next update` on Compose with those bundles.

The bundled `hack-v5` entrypoint follows the same rule for manual bundles:
unset selects native and requires `HACK_NATIVE_HOME`; `compose` needs no native
home and uses your own Hack home.

### Stop stable hackd before a Compose run

A Compose candidate run uses the same `~/.hack` as stable Hack, so the stable
`hackd` daemon must not run while the candidate does. Stopping it once is not
enough: stable `hack global up` (v4.2.0) starts `hackd` again whenever it is
stopped, because the stable `daemon.autoStart` setting is on by default. Stable
`hack doctor --fix` (v4.2.0) also starts a stopped `hackd`: it asks first in a
terminal, and starts it without asking in a non-interactive run. Other
stable commands that talk to `hackd` can also start it again. Newer candidate
builds turn off daemon autostart in `hack-next` and the bundled `hack-v5`
entrypoint, so the candidate does not start the stable `hackd` on its own, not
even from a candidate `global up`, `global install` or `doctor --fix`. A
candidate `hack doctor --fix` skips its `hackd` repair without asking, in a
terminal or not, and prints the reason and the command to run yourself, such as
`hack daemon start`. That command runs the stable CLI, so do not run it during a
Compose candidate run. Older candidate bundles can start `hackd`, so use this
order with every bundle.

Use this order:

```sh
hack global up                  # stable: global services up; also restarts hackd
hack doctor                     # stable, optional: run any doctor or --fix here
hack daemon stop                # stable: stop hackd after global up and doctor
pgrep -fl "hack daemon start"   # must print nothing
HACK_RUNTIME_BACKEND=compose "$HOME/.hack-next/bin/hack-next" up --path /absolute/project
```

1. Run stable `hack global up` first, so the global Caddy and CoreDNS services run.
2. If you want a stable `hack doctor` or `hack doctor --fix` check, run it now,
   before you stop `hackd`. After you stop `hackd`, do not run stable
   `hack doctor --fix` again: it asks "Start hackd now?" in a terminal and
   starts `hackd` without asking in a non-interactive run.
3. Then run stable `hack daemon stop`.
4. Then check with `pgrep -fl "hack daemon start"`. If it lists a process, a
   stable `hackd` is still running, usually one that its per-user launchd
   service (`dance.hack.hackd`) started again. Run stable `hack daemon uninstall`
   to unload that service and remove its plist, or run
   `launchctl bootout "gui/$(id -u)/dance.hack.hackd"` to unload it only. Then run
   `hack daemon stop` again and repeat the check. Do not start the candidate until
   the check prints nothing. If you uninstalled the service, run stable
   `hack daemon install` after the candidate run to restore it.

Run no stable `hack` command against the same `~/.hack` while the candidate run
is active, including `hack global`, `hack status`, `hack doctor` and project
commands. Any of them can start `hackd` again or take the older registry lock.
When you finish, stop the candidate graph with
`HACK_RUNTIME_BACKEND=compose "$HOME/.hack-next/bin/hack-next" down --path /absolute/project`,
then use stable `hack` again. Stable `hack global up` or `hack daemon start`
starts `hackd` again when you need it.

### Keep `.hack/.internal/` out of Git

Do not commit a project's `.hack/.internal/` directory. It holds generated,
machine-local files, such as `.hack/.internal/compose.override.yml`, and Hack
rewrites them when project commands such as `up` run. Newer generators, including
candidate bundles, can write different content into those files than older ones.
If a project tracks `.hack/.internal/`, every run of a newer generator leaves its
working tree dirty, and switching between stable Hack and the candidate can make
the files change back and forth.

Hack's committed `.hack/.gitignore` already ignores `.internal/`, but an ignore
rule does not untrack files that are already committed. Before a candidate run,
run stable `hack doctor` in the project. Its generated-files check lists any
tracked `.hack/.internal/` paths. `hack doctor --fix` removes them from the Git
index with `git rm --cached` and keeps the files on disk; commit that removal.
See [ignore rules](../env.md#ignore-rules-committed-hackgitignore).

## Upgrade and return to a retained candidate

Shared MCP, config compiler and storage witness packages need the matching
retained installation manager. Older channels
keep their original `manager.py`; running a newer installer against that root does
not update it. The newer installer refuses such an upgrade when its own bytes differ
from the retained manager, before publishing a version or changing selection. The
older manager itself refuses the newer layout as foreign files.

To update a reviewed predecessor manager, including the managers shipped with
`5.0.0-next.1`, `5.0.0-next.2` and `5.0.0-next.3` through `5.0.0-next.5`, review
the newer installer from the tag you are upgrading to, then run that saved file
explicitly. For example, before upgrading a
`5.0.0-next.2` channel to `5.0.0-next.3`:

```sh
curl --fail --location --proto '=https' --proto-redir '=https' --tlsv1.2 \
  https://raw.githubusercontent.com/hack-dance/hack/v5.0.0-next.3/scripts/install-prerelease.py \
  --output hack-next-install.py
less hack-next-install.py
python3 hack-next-install.py --root "$HOME/.hack-next" upgrade-manager
python3 "$HOME/.hack-next/manager.py" --root "$HOME/.hack-next" status
python3 "$HOME/.hack-next/manager.py" --root "$HOME/.hack-next" upgrade --version 5.0.0-next.3
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
It accepts old flat bundles, MCP and compiler bundles, and new storage witness
bundles, so rollback to an earlier retained version still works. This operation does not
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
