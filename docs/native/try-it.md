# Try the native backend (beta)

This page takes one project to the native backend and back. You need an Apple
Silicon Mac. Read [what works and known limits](limits.md) first, and use a project
you can afford to break.

Nothing here changes your stable Hack. Stable `hack`, `~/.hack` and your Compose
projects keep working the whole time.

## 1. Install the candidate

The native backend ships in v5 prereleases. Each prerelease has a fixed tag,
`v5.0.0-next.N`. Download the installer from the release you want, read it, then
run it:

```sh
curl --fail --location --proto '=https' --proto-redir '=https' --tlsv1.2 \
  https://github.com/hack-dance/hack/releases/download/v5.0.0-next.16/hack-next-install.sh \
  --output hack-next-install.sh
less hack-next-install.sh
sh hack-next-install.sh
"$HOME/.hack-next/bin/hack-next" --version
```

Everything goes into `~/.hack-next`. The installer does not edit your PATH, start a
virtual machine, or change DNS or certificate trust. Newer prereleases are on the
[releases page](https://github.com/hack-dance/hack/releases). For details, see
[Install a prerelease](../guides/candidate-install.md).

## 2. Prepare the runtime

The native backend needs its virtual machine software set up once per installed
version. Run the explicit setup command; `up` never downloads provider files.

A `hack-next` install keeps each version in its own folder. The two paths you need
are the native program and its private home:

```sh
V=5.0.0-next.16   # the version you installed; `hack-next --manager status` shows it
NATIVE="$HOME/.hack-next/versions/$V/bundle/hack-native"
NATIVE_HOME="$HOME/.hack-next/versions/$V/native-home"
```

```sh
"$NATIVE" --candidate-root "$NATIVE_HOME" runtime setup
```

Setup lists each file, its exact compressed byte length, source host, pinned SHA-256 and
destination, then asks once. It downloads the pinned SmolVM, engine and guest
packages, verifies every hash before preparation, and ends with the development
profile probe. It needs no administrator password or keychain access. Rerun after
an interrupted download to resume or restart safely. A complete matching install
is verified before consent and reused without prompting, downloading or preparing again.

For scripts, use `runtime setup --no-interactive --accept-downloads`. Without
`--accept-downloads`, a noninteractive run needing preparation fails with
`E_INTERACTIVE_REQUIRED`. Complete matching installs need no flag.
Add `--json` for per-file `downloaded`, `resumed`, `reused` or `offline` outcomes and exact
`size_bytes`, `downloaded_bytes` and `reused_bytes` counts, alongside `status` and
`probe`. Offline inputs report zero downloaded bytes. A verified complete
installation reports `status: "reused"` and an empty `files` list: no archive was read.
Connections time out after 15 seconds, each read after 60 seconds, and each file
has a 30-minute overall deadline including redirects. A `setup_pin_unavailable`
error means upstream returned 404 or 410; update Hack or use offline archives.
Setup ignores proxy settings; networks requiring a proxy need the offline form.
This command is available in builds containing the setup feature; older installed
prereleases need the manual alternative below.

### Offline or older builds

Download the exact archives named in `provider-pins.json`, which sits beside
`hack-native` in the bundle. Then download four packages from the Alpine `main`
repository for `aarch64`, with exactly these names. Which Alpine release depends on the
SmolVM version in that `provider-pins.json`:

- SmolVM 1.34.1 or later: Alpine **v3.24**, `iptables-1.8.13-r0.apk`,
  `libmnl-1.0.5-r2.apk`, `libnftnl-1.3.1-r0.apk` and `libxtables-1.8.13-r0.apk`.
- SmolVM 1.14.3 (5.0.0-next.13 and earlier): Alpine **v3.19**, `iptables-1.8.10-r3.apk`,
  `libmnl-1.0.5-r2.apk`, `libnftnl-1.2.6-r0.apk` and `libxtables-1.8.10-r3.apk`.

The same file name in another Alpine release has different bytes and is refused. The
current hashes are in `provider-pins.json` and the table under
[network tool packages](../guides/native-candidate.md#network-tool-packages).

Put them in a folder under your home folder, not under `/tmp`: Hack refuses a path
that passes through a symbolic link, and `/tmp` is one on macOS. Hack also refuses
the packages unless the folder and files are private to you, which is not how a
download leaves them:

```sh
chmod 700 /absolute/private/pinned-apks
chmod 600 /absolute/private/pinned-apks/*.apk
```

With all inputs already on disk, setup can run without any network access:

```sh
"$NATIVE" --candidate-root "$NATIVE_HOME" runtime setup \
  --archive /absolute/smolvm-archive.tar.gz \
  --engine-archive /absolute/docker-archive.tgz \
  --network-tools-directory /absolute/private/pinned-apks
```

The individual manual commands also keep working unchanged, including on older builds:

```sh
"$NATIVE" --candidate-root "$NATIVE_HOME" runtime prepare --archive /absolute/smolvm-archive.tar.gz
"$NATIVE" --candidate-root "$NATIVE_HOME" runtime prepare-engine --archive /absolute/docker-archive.tgz
"$NATIVE" --candidate-root "$NATIVE_HOME" runtime prepare-network-tools --directory /absolute/private/pinned-apks
"$NATIVE" --candidate-root "$NATIVE_HOME" runtime probe --profile development --json
```

Pass `--profile development` to `runtime probe`. Without it the probe checks a
stricter research profile and can report "not admitted" on a Mac that runs projects
fine. The [native reference](../guides/native-candidate.md#manual-candidate-upgrade-and-rollback) explains
each command.

## 3. Check the project

Ask Hack whether the project can run on native before you start it:

```sh
"$HOME/.hack-next/bin/hack-next" doctor --path /absolute/project
```

`hack-next` selects the native backend by default. If the project uses a Compose
feature that native does not support, `doctor` names it. Starting the project would
refuse with `E_NATIVE_PROJECT_UNSUPPORTED` and change nothing. See
[Compose features that stay on Compose](limits.md#compose-features-that-stay-on-compose).

## 4. Run it

```sh
"$HOME/.hack-next/bin/hack-next" up --path /absolute/project
```

Native `up` runs in the foreground and holds the project until you stop it. Add
`-d` to run it in the background instead. From a second terminal, or after `up -d`:

```sh
"$HOME/.hack-next/bin/hack-next" ps --path /absolute/project
"$HOME/.hack-next/bin/hack-next" logs api --no-follow --path /absolute/project
"$HOME/.hack-next/bin/hack-next" down --path /absolute/project
```

Stop the project with `hack down` from another terminal, as above. In
next.16, Ctrl-C may not stop a foreground project cleanly when it publishes
ports. If you already pressed Ctrl-C, run `hack down`, and `hack down --recover` if
it reports that the owner is gone. Next.17 source retries transient retirement
reads and waits for proved cleanup; a second Ctrl-C can request the forced stop.
Unknown cleanup still needs the printed recovery procedure.

Then check the application itself: sign in, load a page that reads data, restart,
and confirm the data is still there. A green status alone does not prove the
application works.

## 5. Switch back to Compose

You have two ways back.

**Use stable Hack.** Run `hack up` in the project as you always did. The native
test did not touch your stable setup.

**Run the same prerelease on Compose.** Set one variable:

```sh
HACK_RUNTIME_BACKEND=compose "$HOME/.hack-next/bin/hack-next" up --path /absolute/project
```

On Compose the prerelease uses your normal Hack home, the same one stable Hack
uses. Do not run both against it at once. Stop the stable daemon first; the order is
in [Stop stable hackd before a Compose run](../guides/candidate-install.md#stop-stable-hackd-before-a-compose-run).

Data does not move between backends. A database you filled on native is not in your
Compose volumes, and the other way round.

## Remove it

Stable Hack never depended on the candidate. To upgrade, roll back or stop using
`hack-next`, see
[Upgrade, roll back and return to stable](../guides/candidate-install.md#upgrade-roll-back-and-return-to-stable).
