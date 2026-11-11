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
  https://github.com/hack-dance/hack/releases/download/v5.0.0-next.12/hack-next-install.sh \
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
version. This step is manual today. Follow the provider setup steps in
[the native reference](../guides/native-candidate.md#manual-candidate-upgrade-and-rollback).

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

Native `up` runs in the foreground and holds the project until you stop it. From a
second terminal:

```sh
"$HOME/.hack-next/bin/hack-next" ps --path /absolute/project
"$HOME/.hack-next/bin/hack-next" logs api --no-follow --path /absolute/project
"$HOME/.hack-next/bin/hack-next" down --path /absolute/project
```

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
