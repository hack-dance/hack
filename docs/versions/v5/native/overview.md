# Native backend (beta)

The native backend is a second way for Hack to run your project. It is a beta for
Apple Silicon Macs. Docker Compose is still the default, and nothing changes for a
project unless you choose native for it.

## What it is

Hack needs something to run your services in. Today that is Docker Compose, which
needs a Docker app running on your machine.

With the native backend, Hack does that job itself. It starts a small Linux virtual
machine on your Mac and runs your services inside it. Hack owns that machine: it
starts it, checks it, and cleans up after it.

Your project stays the same. The `.hack/` folder, the commands (`hack up`,
`hack down`, `hack logs`) and your env and secrets are the same on both backends.

## What it is not

- **Not the default.** Compose runs your project unless you select native.
- **Not in stable Hack.** It ships only through the separate `hack-next` channel.
  The stable release archives and the Homebrew formula do not contain it.
- **Not for every platform.** It runs on Apple Silicon macOS only. Intel Macs,
  Linux and Windows use Compose.
- **Not a full replacement for Compose yet.** It supports a limited set of commands
  and Compose features. See [what works and known limits](limits.md).
- **Not a migration.** Trying native does not convert your project or move your
  data. Your stable setup is left alone.
- **Not proven faster or lighter.** We have not published measurements, so we make
  no speed or resource claims.

## Why try it

- **No Docker app to run.** You do not need Docker Desktop or another Docker engine
  running on the Mac for a native project.
- **Safe to try.** `hack-next` installs beside stable Hack with its own files. It
  does not edit your PATH, your stable `hack`, or `~/.hack`.
- **Careful with your data.** Every run has one owner. Hack records what it creates
  before it creates it, and confirms cleanup instead of assuming it.
- **Clear refusals.** When a project uses something native does not support, Hack
  says so before it starts anything. It names the feature and changes nothing. It
  never falls back to Docker without telling you.
- **Preview first.** `hack config validate` and `hack config plan` check a project
  for native without starting it.

## Who should try it

Try it if you use an Apple Silicon Mac, you are comfortable testing beta software,
and you have a project you can afford to break. Start with a disposable project
and synthetic data.

Stay on Compose if you need every Compose feature, you work on Linux or an Intel
Mac, or the project holds data you cannot lose.

## Where to go next

1. [Try it](try-it.md): install, run one project on native, and switch back.
2. [What works and known limits](limits.md).
3. [Reference](reference.md): the detailed pages, by topic.
