<p align="center">
  <img alt="Hack" src="./apps/macos/512@2x.png" width="160" />
</p>

# Hack

Hack runs a whole project on your machine — services, env, secrets, TLS and logs —
from a small committed `.hack/` folder, at its own local HTTPS hostname. Many
projects and branches run at the same time without colliding. Hack is a local CLI:
nothing is hosted and no account is needed.

```bash
cd any-repo && hack up
# → https://myapp.hack.local is live, TLS trusted, env injected
```

## Why it exists

Local development breaks down when one machine runs many things. Two projects fight
over port 3000. A repo you haven't touched in a month needs an afternoon of
archaeology to start. Secrets live in `.env` files passed around in chat. Testing a
PR means tearing down the branch you were working on.

Hack treats these as one problem. The unit is the project's whole environment, not
its ports: a committed `.hack/` config running on shared local infrastructure,
Docker Compose for services and Caddy for DNS and trusted TLS. The same project
identity routes `api.myapp.hack.local`, decrypts its secrets, starts its helpers,
labels its logs and namespaces its branch instances, so none of it needs glue code.

| The job | The usual duct tape | With Hack |
| --- | --- | --- |
| Local domains and trusted TLS | mkcert, `/etc/hosts` edits, port lists | `https://myapp.hack.local`, CA trusted once |
| Parallel branches | a second clone and port surgery | branch instances; worktrees isolate automatically |
| Secrets and env | `.env` files passed around | encrypted values committed with the repo |
| "How do I run this" | README, Makefile and tribal knowledge | `.hack/` config and `hack up` |
| Tunnels, SSO, proxies | ad-hoc scripts in a terminal tab | declared lifecycle processes, stopped on `hack down` |
| Logs | terminal scrollback, gone on restart | persisted history: `hack logs --loki --since 2h` |
| Workspaces | hand-rolled tmux setups | `hack session` |

## Core promises

**1. Run many projects and branches side by side, each at a real HTTPS hostname.**
Every project gets `https://myapp.hack.local`, per-service subdomains such as
`api.myapp.hack.local`, and locally trusted certificates. `hack up --branch review`
starts a second instance of the same project with its own hostnames, and in a
linked git worktree `hack up` becomes a branch instance automatically, so you can
review a PR while your main checkout keeps running. `hack dev` runs a repository's
own side-by-side development build from a committed `.hack/dev.json`. Existing
`.hack` names and custom domains keep working, and `.hack.gy` alias hosts cover
OAuth providers that reject local domains.
See [core concepts](docs/core.md) and [side-by-side development](docs/dev.md).

**2. Manage project env and secrets safely.** Values live in committed YAML and
secrets are encrypted per value, so the file is safe to commit. One gitignored key
decrypts them; linked worktrees inherit it and CI passes `HACK_ENV_SECRET_KEY`.
`hack env` reads and writes values without printing secrets, and
`hack host exec` runs a host command with the project's env injected instead of
reading `.env` files. See [env and secrets](docs/env.md).

**3. Sessions and lifecycle you can trust.** `hack up`, `hack down` and
`hack restart` start and stop the whole project, including the tunnels, proxies and
other host helpers it declares. `hack logs` tails or queries persisted history,
`hack doctor` diagnoses setup and proposes specific repairs, and `hack session`
keeps a project workspace alive across terminal restarts and SSH reconnects. See
[lifecycle](docs/lifecycle.md) and [sessions](docs/sessions.md).

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

When something looks wrong, run `hack doctor`, read the diagnosis, then
`hack doctor --fix` for the repairs you accept.
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

Every command works from the repo root, or anywhere with `--project <name>`.
`hack help` lists the commands by group; the
[CLI overview](docs/cli.md) explains which one to use.

## Agent integrations (optional)

An agent with shell access can use Hack directly: commands take `--json` for
structured results with stable error codes and `--no-interactive` to avoid prompts.
Nothing else is required, and Hack never writes agent files on its own.

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

Everything above is the supported core. The items below are opt-in.

**Native backend (beta, Apple Silicon macOS).** v5 adds a backend that runs
explicitly prepared projects without Docker. It ships only through the separate
`hack-next` channel, not in the stable archives or the Homebrew formula. It supports
a bounded command subset and is qualified project by project. Docker Compose stays
the default backend. See [installing it](docs/guides/candidate-install.md), its
[limits](docs/guides/prereleases.md#candidate-capability-limits) and
[the native backend guide](docs/guides/native-candidate.md).

**v5 prereleases.** v5 keeps the same CLI and project model. `5.0.0-next.N` builds
install beside stable Hack through `hack-next` and do not touch the stable
executable. Read [what's new in v5](docs/guides/v5-release-notes.md),
[upgrade to v5](docs/guides/upgrade-to-v5.md) and
[install a prerelease](docs/guides/candidate-install.md). The `next` branch holds v5
work; `main` holds the stable line.

**Managed environments (advanced).** Because the environment is committed with the
repo, another machine or a cloud agent sandbox can reuse it. The host still needs a
compatible container runtime and the project's prerequisites, and the secret key
arrives through that host's secret store. A slim image, `hackdance/hack:slim`, is
built for this. See
[managed environments](docs/guides/codex-managed-environments.md).

The CLI is the supported product. Remote, gateway, node and dispatch commands and
the macOS app in this repository are unsupported and are not part of setup.

## Documentation

Start with [Getting started](docs/guides/getting-started.md) or the
[documentation index](docs/README.md). The public site is
[hack.foo](https://hack.foo); its source lives in [`site/`](site/README.md).

- [CLI overview](docs/cli.md) and the [generated command reference](docs/reference/cli.md)
- [Env and secrets](docs/env.md) · [Lifecycle](docs/lifecycle.md) · [Sessions](docs/sessions.md)
- [Agent integrations](docs/integrations.md) · [Agent-first setup](docs/guides/agent-first-setup.md)

## License

See [LICENSE](./LICENSE).
