<p align="center">
  <img alt="Hack" src="./apps/macos/512@2x.png" width="160" />
</p>

# Hack

Hack is a command-line tool that runs your whole project on your own machine.

One command, `hack up`, starts the project's services, loads its settings and
secrets, and gives it a local web address with working HTTPS. You can run many
projects, and many branches of one project, at the same time. They do not get in
each other's way.

```bash
cd myapp && hack up        # a repository that has a .hack/ folder
# → https://myapp.hack.local is live, TLS trusted, env injected
```

Everything Hack needs to know about a project lives in a small `.hack/` folder that
you commit with the code. Nothing is hosted, and you do not need an account.

## Why it exists

Running one project locally is easy. Running many is not:

- Two projects both want port 3000.
- A repo you have not opened in a month takes an afternoon to start again.
- Secrets sit in `.env` files that people pass around in chat.
- To test a pull request, you have to stop the branch you were working on.

Hack treats these as one problem. It manages the project's whole environment, not
only its ports. A project has one identity. Hack uses it to route
`api.myapp.hack.local`, decrypt the project's secrets, start its helper processes,
label its logs, and keep its branch instances apart. Under the hood it uses Docker
Compose for services and Caddy for local DNS and trusted TLS.

| The job | A common workaround | With Hack |
| --- | --- | --- |
| Local addresses with trusted HTTPS | mkcert, `/etc/hosts` edits, a list of ports | `https://myapp.hack.local`, certificate authority trusted once |
| Two branches at once | a second clone and changed ports | branch instances; git worktrees are separated automatically |
| Secrets and settings | `.env` files passed around | encrypted values committed with the repo |
| "How do I run this?" | a README, a Makefile and asking a teammate | the `.hack/` folder and `hack up` |
| Tunnels, single sign-on, proxies | scripts left running in a terminal tab | processes the project declares; `hack down` stops them |
| Logs | terminal scrollback, gone on restart | saved history: `hack logs --loki --since 2h` |
| Terminal workspaces | hand-made tmux setups | `hack session` |

## Core promises

Hack makes three promises.

**1. Run many projects and branches side by side, each at a real HTTPS hostname.**

- Every project gets an address such as `https://myapp.hack.local`. Each service
  gets its own, such as `api.myapp.hack.local`. The certificates are trusted on
  your machine once `hack global install` has run.
- `hack up --branch review` starts a second copy of the same project with its own
  addresses. In a linked git worktree, `hack up` does this automatically, so you
  can review a pull request while your main checkout keeps running.
- `hack dev` runs a development build of the repository's own app beside the copy
  of that app you have installed, from a committed `.hack/dev.json`.
- Existing `.hack` names and custom domains keep working. `.hack.gy` alias hosts
  cover OAuth providers that reject local domains.

See [core concepts](docs/core.md) and [side-by-side development](docs/dev.md).

**2. Manage project env and secrets safely.**

- Settings live in committed YAML files. Each secret is encrypted on its own, so
  the file is safe to commit.
- One key, kept out of git, decrypts them. Linked worktrees share it, and CI passes
  it as `HACK_ENV_SECRET_KEY`.
- `hack env` reads and writes values without printing secrets.
- `hack host exec` runs a command on your machine with the project's settings
  loaded, so scripts do not need `.env` files.

See [env and secrets](docs/env.md).

**3. Sessions and lifecycle you can trust.**

- `hack up`, `hack down` and `hack restart` start and stop the whole project,
  including the tunnels, proxies and other helper processes it declares.
- `hack logs` follows logs or searches saved history.
- `hack doctor` checks your setup and proposes specific repairs.
- `hack session` keeps a project's terminal workspace alive when you close the
  terminal or reconnect over SSH.

See [lifecycle](docs/lifecycle.md) and [sessions](docs/sessions.md).

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

This installs the stable v4 line. v5 is in prerelease; see
[beta and advanced](#beta-and-advanced).

## First run

You need a running Docker-compatible engine with Docker Compose.

```bash
hack global install        # once per machine: DNS, TLS, proxy
cd /path/to/project
hack init                  # generates .hack/; review it before starting
hack up --detach
hack open
```

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
hack env list                        # resolved env for the project
hack host exec --scope api -- bun db:seed   # host command with injected env
hack up --branch review              # parallel branch instance
hack dev                             # side-by-side development build
hack session start myapp             # persistent tmux workspace
hack doctor                          # diagnose setup
```

Run a command from the project's folder, or from anywhere with `--project <name>`.
`hack help` lists the commands by group. The [CLI overview](docs/cli.md) explains
which one to use.

## Agent integrations (optional)

A coding agent that can run shell commands can use Hack as it is. Commands accept
`--json` for structured results with stable error codes, and `--no-interactive` to
avoid prompts. Nothing else is required, and Hack never writes agent files on its
own. These extras are optional:

- The `hack` plugin gives Codex, Claude Code and Cursor eight Hack skills through
  the client's own plugin manager.
- The separate `hack-mcp` plugin is for clients without shell access.
- `hack init --with claude|codex` and `hack agent onboard` hand project setup to an
  agent.

```bash
codex plugin marketplace add hack-dance/hack && codex plugin add hack@hack-dance
# or, in Claude Code:
claude plugin marketplace add hack-dance/hack --sparse .claude-plugin plugins/hack plugins/hack-mcp
claude plugin install hack@hack-dance
```

See [agent integrations](docs/integrations.md).

## Beta and advanced

Everything above is the supported core. You choose whether to use the items below.

**Native backend (beta, Apple Silicon macOS).** A second way to run the same
project. Hack starts its own Linux virtual machine and runs Docker inside it,
so you do not need Docker Desktop or OrbStack. Your `.hack/` folder and your
commands stay the same. It comes only through the separate `hack-next` channel, not
in the stable archives or the Homebrew formula, and it supports part of what Compose
supports. Docker Compose stays the default. Read the [overview](docs/native/README.md),
[try it](docs/native/try-it.md), or check
[what works and known limits](docs/native/limits.md).

**v5 prereleases.** v5 keeps the same commands and the same project folder.
`5.0.0-next.N` builds install beside stable Hack through `hack-next` and do not
change the stable install. Read [what's new in v5](docs/guides/v5-release-notes.md),
[upgrade to v5](docs/guides/upgrade-to-v5.md) and
[install a prerelease](docs/guides/candidate-install.md). The `next` branch holds v5
work; `main` holds the stable line.

**Managed environments (advanced).** The environment is committed with the repo, so
another machine or a cloud agent sandbox can reuse it. That machine still needs a
compatible container runtime and whatever else the project requires, and it gets
the secret key from its own secret store. A slim image, `hackdance/hack:slim`, is
built for this. See
[managed environments](docs/guides/codex-managed-environments.md).

The command-line tool is the supported product. The remote, gateway, node and
dispatch commands and the macOS app in this repository are unsupported. Setup does
not use them.

## Documentation

Start with [Getting started](docs/guides/getting-started.md) or the
[documentation index](docs/README.md). The public site is
[hack.foo](https://hack.foo); its source lives in [`site/`](site/README.md).

- [CLI overview](docs/cli.md) and the [generated command reference](docs/reference/cli.md)
- [Env and secrets](docs/env.md) · [Lifecycle](docs/lifecycle.md) · [Sessions](docs/sessions.md)
- [Agent integrations](docs/integrations.md) · [Agent-first setup](docs/guides/agent-first-setup.md)

## License

See [LICENSE](./LICENSE).
