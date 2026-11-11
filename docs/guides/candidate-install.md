# Install a native prerelease alongside stable Hack

The native backend is a beta for Apple Silicon macOS. It is not part of stable
`hack`: the `hack-next` channel installs it, and neither the stable release archives
nor the Homebrew formula contain it. Its current limits are listed under
[candidate capability limits](prereleases.md#candidate-capability-limits).

v5 prereleases are opt-in Apple Silicon macOS bundles identified by `5.0.0-next.N`,
with a positive number and no leading zero. After a stable v5 release, candidates
move to the next line, such as `5.1.0-next.N`; see
[versions and artifacts](prereleases.md#versions-and-artifacts). Each release ships
a shell bootstrap, `hack-next-install.sh`, that installs a standalone manager and
that release's bundle into a private channel root. Download the bootstrap from the
exact release tag over HTTPS, review it, then run it:

```sh
curl --fail --location --proto '=https' --proto-redir '=https' --tlsv1.2 \
  https://github.com/hack-dance/hack/releases/download/v5.0.0-next.13/hack-next-install.sh \
  --output hack-next-install.sh
less hack-next-install.sh
sh hack-next-install.sh
```

The bootstrap pins its manager checksum and release version; it does not look up a
mutable latest release. It needs only system tools such as `curl`, `shasum` and
`codesign`, not Python, Bun or a source checkout. The bundle includes the compiled
CLI, the native executor, the Linux guest relay, the launcher, provider pins, the
config compiler and its schemas, the storage witness and checksums; the installer
requires each group to be complete or absent and verifies every macOS binary's
signature before selecting the bundle.

Installation creates a private, current-user-owned `~/.hack-next` directory. Each
immutable version directory holds a complete bundle, its own `native-home` and its
own `cli-home`, bound by an installation receipt. Stable Homebrew `hack`, its links
and `~/.hack` are untouched; no shell profile or PATH entry is edited. Only an
explicit [Compose test](#test-both-backends) uses your own Hack home.

Run the candidate explicitly:

```sh
"$HOME/.hack-next/bin/hack-next" --version
"$HOME/.hack-next/bin/hack-next" ps --path /absolute/project
"$HOME/.hack-next/bin/hack-next" --manager status
```

By default `hack-next` uses the native backend with the selected version's private
native and CLI homes, overriding inherited selectors such as `HACK_NATIVE_BINARY`,
`HACK_NATIVE_HOME`, `HACK_HOME` and `HACK_GLOBAL_CONFIG_PATH`. To run the same
verified candidate on Compose, set `HACK_RUNTIME_BACKEND=compose`; any other
non-empty value refuses before the candidate starts. Explicit native project
adaptation, dependency, routing and source-sharing settings still reach the CLI, as
do the committed `.hack/native/adaptation.json` and the per-machine
`~/.config/hack/native/<project>/settings.json`
([native settings files](native-candidate.md#native-settings-files)).

Every invocation re-verifies the retained bundle bytes and receipts, and strict
signature verification checks all bundled macOS binaries. Download and archive code
loads only when installing software. Concurrent observation and stop commands can
accompany a foreground candidate command; selecting another bundle refuses while
any launcher is active.

## Test both backends

The same selected candidate can run on either backend. You do not need to call the
bundled `hack-cli` directly or create a private `HACK_HOME` to test Compose.

| Backend | Command | Hack home | Routing, DNS and TLS |
| --- | --- | --- | --- |
| Native (default) | `"$HOME/.hack-next/bin/hack-next" up --path /absolute/project` | The version's private `cli-home` and `native-home` | The candidate's native routing, set up through [native candidate preparation](native-candidate.md) |
| Compose | `HACK_RUNTIME_BACKEND=compose "$HOME/.hack-next/bin/hack-next" up --path /absolute/project` | Your own `HACK_HOME` (default `~/.hack`) and `HACK_GLOBAL_CONFIG_PATH` | Your existing global Caddy, CoreDNS and local CA |

On the native backend, every project root and linked worktree uses the version's
one `native-home`, so they share one VM pool and one HTTPS router, as Compose
projects share one Docker VM and the global Caddy. A root joins the pool while the
pool is stopped; see [one pool, several project roots](native-candidate.md#explicit-writable-development-source).

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

## Upgrade, roll back and return to stable

The standalone manager runs through the launcher:

```sh
"$HOME/.hack-next/bin/hack-next" --manager status
"$HOME/.hack-next/bin/hack-next" --manager upgrade --version 5.0.0-next.NEWER
"$HOME/.hack-next/bin/hack-next" --manager rollback --version 5.0.0-next.OLDER
"$HOME/.hack-next/bin/hack-next" --manager stable
"$HOME/.hack-next/bin/hack-next" --manager upgrade-manager
```

`NEWER` and `OLDER` stand for prerelease numbers: `upgrade` takes a version newer than
the selected one, and `rollback` takes an older version you already installed.

Stop every retained version's graphs and runtime first. Version changes take the
channel's exclusive lock, refuse active launchers and apply quiescence checks to
every retained version. `upgrade` installs and selects a newer bundle while keeping
the previous one; `rollback` selects a retained older bundle. Each version keeps its
own homes, so switching software does not migrate application data, and an older
candidate that refuses state written by a newer one is not a successful rollback.
`stable` deselects the candidate: `hack-next` then reports that no candidate is
selected, all bundles and homes are retained, and your stable `hack` is unchanged.

A bundle whose layout the installed manager does not understand needs a newer
manager first. The installed manager cannot fetch one: `upgrade-manager` installs
the executable it is run from. Download the standalone manager from the target
release, verify it against that release's `INSTALLER-SHA256SUMS`, then run that
file against your channel root:

```sh
dir=$(mktemp -d) && cd "$dir" &&
curl --fail --location --proto '=https' --proto-redir '=https' --tlsv1.2 \
  https://github.com/hack-dance/hack/releases/download/v5.0.0-next.13/hack-next-manager-darwin-arm64 \
  --output hack-next-manager-darwin-arm64 &&
curl --fail --location --proto '=https' --proto-redir '=https' --tlsv1.2 \
  https://github.com/hack-dance/hack/releases/download/v5.0.0-next.13/INSTALLER-SHA256SUMS \
  --output INSTALLER-SHA256SUMS &&
grep '[ *]hack-next-manager-darwin-arm64$' INSTALLER-SHA256SUMS > manager.sha256 &&
shasum -a 256 --check manager.sha256 &&
codesign --verify --strict hack-next-manager-darwin-arm64 &&
chmod 0700 hack-next-manager-darwin-arm64 &&
./hack-next-manager-darwin-arm64 --root "$HOME/.hack-next" upgrade-manager
```

Run it as one command. Every step is joined with `&&`, so a failed download, a
missing or mismatched checksum, or a failed signature check stops before the
manager runs. The work happens in a new private temporary directory.

The upgrade takes the channel lock, refuses active launchers, recognizes only
reviewed predecessor managers and the standard launcher, and keeps every installed
bundle, home and selection. A reviewed local archive can be installed with an
independently obtained digest through `--archive /path` and `--sha256 DIGEST` on
`install` or `upgrade`.

Selection changes commit by one atomic receipt replacement. A failed download,
checksum, signature or quiescence check, or an interrupted replacement, preserves
the previous selection. Old or foreign roots refuse; do not delete or rewrite a
root to bypass ownership checks. If you previously exported native selectors in
your shell, unset `HACK_RUNTIME_BACKEND`, `HACK_NATIVE_BINARY`, `HACK_NATIVE_HOME`,
`HACK_HOME` and `HACK_GLOBAL_CONFIG_PATH` before running stable Hack.

The [prerelease channel guide](prereleases.md) covers versioning, platform support
and publication gates; [the native backend guide](native-candidate.md) covers
provider preparation and the supported command subset.
