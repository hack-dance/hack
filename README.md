<p align="center">
  <img alt="Hack" src="./apps/macos/512@2x.png" width="160" />
</p>

# Hack

Hack runs your whole project on your own machine, and runs every project, branch
and git worktree side by side, each at its own HTTPS address.

- **One command starts a repository.** `hack up` starts the services, loads the
  settings and secrets, and serves the project at `https://myapp.hack.local`.
- **Every worktree gets its own running copy.** Its own containers, addresses and
  logs, so three branches, or three coding agents, can each run and test the app
  at once.
- **Nothing is hosted.** The setup is a small `.hack/` folder committed with the
  code. There is no account and no service to sign in to.

```bash
cd myapp && hack up --detach      # → https://myapp.hack.local
hack open                         # open it in the browser
hack logs --pretty                # follow the logs

git worktree add ../myapp-fix -b fix-login
cd ../myapp-fix && hack up --detach
# → https://fix-login.myapp.hack.local, while myapp keeps running

hack down                         # stop this copy; data is kept
```

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./docs/assets/readme/instances.dark.svg" />
  <source media="(prefers-color-scheme: light)" srcset="./docs/assets/readme/instances.light.svg" />
  <img alt="A main checkout and two git worktrees each start their own Hack instance, and each instance has its own HTTPS address" src="./docs/assets/readme/instances.light.svg" />
</picture>

Each checkout of the repository starts its own instance. Each instance has its own
containers and its own address, so none of them wait for another to stop.

## Install

```bash
brew tap hack-dance/tap
brew install hack-dance/tap/hack
```

Or without Homebrew:

```bash
curl -fsSL \
  https://github.com/hack-dance/hack/releases/latest/download/hack-install.sh \
  | bash
```

This installs the stable v4 line. This README describes v5, which is in prerelease
and installs beside v4; see [versions](#versions-and-backends). In v4, new projects
get `https://myapp.hack` instead of `https://myapp.hack.local`, and a few things
below arrive with v5: the separate `hack-mcp` plugin, the eight-skill `hack` plugin
and the doctor's checks for slow settings. v4's plugin has two skills and bundles
the MCP server, and v4's `hack setup` commands write `AGENTS.md` and `CLAUDE.md`
sections and Cursor rules.

## Why it exists

Running one project locally is easy. Running many is not:

- Two projects both want port 3000.
- A repo you have not opened in a month takes an afternoon to start again.
- Secrets sit in `.env` files that people pass around in chat.
- To test a pull request, you have to stop the branch you were working on.

Coding agents made the last one a daily problem. A git worktree gives each agent
its own copy of the files. It does not give it a running app. Copy the same `.env`
into three worktrees and all three want the same ports and the same database, so
an agent either cannot start the app or tests against another branch's server.

Hack treats these as one problem. It manages the project's whole environment, not
only its ports. A project has one identity, and Hack uses it to route
`api.myapp.hack.local`, decrypt the project's secrets, start its helper processes,
label its logs, and keep its instances apart.

| The job | A common workaround | With Hack |
| --- | --- | --- |
| Two branches at once | a second clone and changed ports | an instance per branch; a git worktree gets one automatically |
| Local addresses with trusted HTTPS | mkcert, `/etc/hosts` edits, a list of ports | `https://myapp.hack.local`, certificate authority trusted once |
| Secrets and settings | `.env` files passed around | encrypted values committed with the repo |
| "How do I run this?" | a README, a Makefile and asking a teammate | the `.hack/` folder and `hack up` |
| Tunnels, single sign-on, proxies | scripts left running in a terminal tab | processes the project declares; `hack down` stops them |
| Logs | terminal scrollback, gone on restart | saved history: `hack logs --loki --since 2h` |
| A script or agent driving the project | parsing terminal output | `--json` results; newer ones carry stable error codes |

## What you get

**Many projects and branches, each at a real HTTPS address.**

- Every project gets an address such as `https://myapp.hack.local`. Each service
  gets its own, such as `api.myapp.hack.local`. The certificates are trusted on
  your machine once `hack global install` has run.
- `hack up --branch review` starts a second instance of the same project with its
  own addresses. In a linked git worktree, `hack up` does this without the flag
  and names the instance after the branch. A detached worktree needs
  `--branch <name>`.
- An instance has its own containers, so each one has its own database container.
  Instances still share anything outside them: an external database, a
  bind-mounted folder, the same credentials. Hack separates what runs; it is not a
  security boundary.
- `.hack.gy` alias hosts cover OAuth providers that reject local domains.

See [core concepts](docs/core.md) and
[worktrees and watchers](docs/guides/development-runtime-safety.md).

**Settings and secrets that travel with the repo.**

- Settings live in committed YAML files. Each secret is encrypted on its own, so
  the file is safe to commit.
- One key, kept out of git, decrypts them. Linked worktrees share it, and CI passes
  it as `HACK_ENV_SECRET_KEY`.
- Overlays hold the values that differ, for example for `qa`, and a worktree can
  keep local overrides that are not committed.
- `hack env list` shows names and whether each is set, never values. Reading a
  value takes an explicit `hack env get KEY`.
- `hack host exec` runs a command on your machine with the project's settings
  loaded, so scripts do not need `.env` files.

See [env and secrets](docs/env.md).

**Start, stop and inspect the whole project.**

- `hack up`, `hack down` and `hack restart` start and stop the project, including
  the tunnels, proxies and other helper processes it declares.
- `hack logs` follows logs or searches saved history.
- `hack doctor` checks your setup and proposes specific repairs. It also reports
  settings that make a project slow, such as a container image built for another
  processor or a file watcher that polls.
- `hack session` keeps a project's terminal workspace alive when you close the
  terminal or reconnect over SSH.

See [lifecycle](docs/lifecycle.md) and [sessions](docs/sessions.md).

## How it fits together

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./docs/assets/readme/project.dark.svg" />
  <source media="(prefers-color-scheme: light)" srcset="./docs/assets/readme/project.light.svg" />
  <img alt="Your machine, shared local routing, and project services in the selected engine" src="./docs/assets/readme/project.light.svg" />
</picture>

The `hack` command reads the project's `.hack/` folder and starts its services
through Docker Compose. One shared local proxy gives every instance its names and
HTTPS, with local DNS helpers for the names and Caddy for the certificates. An
optional daemon, `hackd`, caches project state so status commands answer quickly.
Compose is the default way to run services; the native VM is an opt-in beta,
described under [versions and backends](#versions-and-backends).

## First run

You need a running Docker-compatible engine with Docker Compose.

```bash
hack global install        # once per machine: DNS, TLS, proxy
cd /path/to/project
hack init                  # generates .hack/; review it before starting
hack up --detach
hack open
```

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./docs/assets/readme/first-run.dark.svg" />
  <source media="(prefers-color-scheme: light)" srcset="./docs/assets/readme/first-run.light.svg" />
  <img alt="Numbered interactions between you, Hack, the Compose engine and the browser" src="./docs/assets/readme/first-run.light.svg" />
</picture>

After global setup, `hack init` writes config, `hack up --detach` starts services
that the shared proxy routes, `hack open` opens HTTPS, `hack logs` streams output
until Ctrl-C, and `hack down` stops services while keeping data.

If something looks wrong, run `hack doctor` and read what it reports. Then run
`hack doctor --fix` to apply the repairs you accept.
[Getting started](docs/guides/getting-started.md) walks through each step.

## Core commands

```bash
hack up --detach                     # start the project (hack down stops it)
hack restart                         # restart the project or selected services
hack status                          # what is running across projects
hack logs --pretty                   # tail logs (or: hack logs <service>)
hack open                            # open the project URL
hack exec api -- bun test            # run inside a running service
hack run api -- bun db:migrate       # one-off container command
hack env list                        # env names and layers (no values)
hack host exec --scope api -- bun db:seed   # host command with injected env
hack up --branch review              # parallel branch instance
hack dev                             # run .hack/dev.json beside your installed build
hack session start myapp             # persistent tmux workspace
hack doctor                          # diagnose setup
```

Run a command from the project's folder, or from anywhere with `--project <name>`.
`hack help` lists the commands by group. The [CLI overview](docs/cli.md) explains
which one to use.

## Working with coding agents

A coding agent that can run shell commands can use Hack as it is. Give it a
worktree, and `hack up` there gives it a running copy of the project that it can
open, test and read logs from without touching anyone else's.

- Many commands accept `--json`. Newer outputs share one envelope with stable
  error codes; older ones keep their published shapes. `--no-interactive` avoids
  prompts. See [machine-readable output](docs/reference/machine-readable-output.md).
- v5 does not write `AGENTS.md` or `CLAUDE.md` sections, Cursor rules or global
  skill copies on its own. Everything below is optional.
- The `hack` plugin gives Codex, Claude Code and Cursor eight Hack skills through
  the client's own plugin manager. The separate `hack-mcp` plugin is for clients
  without shell access.
- `hack init --with claude|codex` and `hack agent onboard` hand project setup to an
  agent.

```bash
codex plugin marketplace add hack-dance/hack && codex plugin add hack@hack-dance
# or, in Claude Code:
claude plugin marketplace add hack-dance/hack --sparse .claude-plugin plugins/hack plugins/hack-mcp
claude plugin install hack@hack-dance
```

When several people or agents share a machine, agree who starts and stops each
instance. See [agent integrations](docs/integrations.md).

## Versions and backends

**Stable is v4.** It runs services through Docker Compose and installs from
Homebrew or the release installer above.

**v5 is in prerelease.** It keeps the same commands and the same `.hack/` folder
and replaces the runtime layer underneath. Docker Compose stays the default. The
current prerelease is `5.0.0-next.22`. Prerelease builds install beside stable
Hack through the separate `hack-next` channel and do not change the stable
install. Read
[what's new in v5](docs/guides/v5-release-notes.md),
[upgrade to v5](docs/guides/upgrade-to-v5.md) and
[install a prerelease](docs/guides/candidate-install.md). The `next` branch holds
v5 work; `main` holds the stable line.

**Native backend (beta, Apple Silicon macOS).** A second way to run the same
project. Hack runs the project's containers in a Linux VM, without Docker Desktop
or OrbStack. Preparing that VM is a separate step today. Your `.hack/` folder and
your commands stay the same. It is opt-in and ships only through `hack-next`.

- It runs a whole multi-service Compose project: start, stop, restart, logs for
  every service and `hack open`.
- It supports part of what Compose supports. When a project needs something
  outside that part, Hack refuses and names the feature.
- One project runs in a native pool at a time.
- A worktree gets its own instance automatically only on Compose. On native,
  pass `--branch <name>`, which needs a prepared source share.
- Native data does not carry over when you move to a new prerelease, and it does
  not move between backends.
- We have published no speed, memory or battery comparison with Compose. Do not
  assume it is faster or lighter.

Read the [overview](docs/native/README.md), [try it](docs/native/try-it.md), or
check [what works and known limits](docs/native/limits.md).

**Single project file (experimental).** Hack ships an experimental compiler for a
bounded subset of a planned `.hack/hack.project.json` format. A successful compile
is validation of the file. It does not change how existing projects run, and
projects run from their `.hack/` Compose setup today. See
[native configuration validation](docs/reference/native-config-compiler.md).

**Managed environments (advanced).** The environment is committed with the repo,
so another machine or a cloud agent environment can reuse it. That machine still
needs a compatible container runtime and whatever else the project requires, and
it gets the secret key from its own secret store. A slim image,
`hackdance/hack:slim`, is built for this. See
[managed environments](docs/guides/codex-managed-environments.md).

## What Hack is not

- **Not a hosted service.** There are no accounts, teams or dashboards.
- **Not a sandbox.** Hack runs your project; it does not confine what an agent or
  a process may touch. Use your agent's own sandbox for that.
- **Not a deploy tool.** It is for the machine you develop on.

The command-line tool is the supported product. The remote, gateway, node and
dispatch commands and the macOS app in this repository are unsupported, and setup
does not use them. An unsupported desktop app preview lives under `apps/desktop`
and is not part of a release yet.

## Documentation

Start with [Getting started](docs/guides/getting-started.md) or the
[documentation index](docs/README.md). The public site is
[hack.foo](https://hack.foo); its source lives in [`site/`](site/README.md).

- [CLI overview](docs/cli.md) and the [generated command reference](docs/reference/cli.md)
- [Env and secrets](docs/env.md) · [Lifecycle](docs/lifecycle.md) · [Sessions](docs/sessions.md)
- [Agent integrations](docs/integrations.md) · [Agent-first setup](docs/guides/agent-first-setup.md)

## Contributing

See [AGENTS.md](AGENTS.md) for how to build, test and propose changes.

Contributor notes for the native runtime, including how a provider pin is
qualified, are in the [runtime core README](packages/runtime-core/README.md).

## License

See [LICENSE](./LICENSE).
