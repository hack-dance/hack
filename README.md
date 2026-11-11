<p align="center">
  <img alt="Hack" src="./apps/macos/512@2x.png" width="160" />
</p>

# Hack

One command runs the whole project — services, env, secrets, TLS, logs — at its own
local HTTPS URL. Every project on your machine, all at once, none of them colliding.

```bash
cd any-repo && hack up
# → https://myapp.hack.local is live, TLS trusted, env injected
```

Local development breaks down when one machine runs many things. Two projects fight
over port 3000. A repo you haven't touched in a month needs an afternoon of
archaeology to start. Secrets live in `.env` files passed around in Slack. Testing a
PR means tearing down the branch you were working on.

Hack's bet is that these aren't separate problems. Project isolation isn't port
management — it's the whole environment, isolated together, or it isn't isolation.
So the environment is the unit: a small committed config (`.hack/`) running on
shared local infrastructure — Docker Compose for services, Caddy for DNS and
trusted TLS. Nothing is hosted. Your machine is the platform.

## What you get

**A real URL for every project.** New projects get `https://myapp.hack.local`, with
per-service subdomains like `api.myapp.hack.local` and locally-trusted certificates.
No ports to remember, no collisions, and OAuth-friendly `.hack.gy` alias hosts when a
provider rejects `.hack.local`. Existing `.hack` names and custom domains keep working.

**`hack up` is the whole answer to "how do I run this repo".** Services, env,
lifecycle hooks, and host-side helpers (tunnels, SSO, proxies) are declared in
`.hack/` and committed. Anyone who clones the repo — teammate or agent — is one
command from a running environment.

**Env that travels with the repo.** Values live in committed YAML; secrets are
encrypted per-value, so they're safe to commit. One gitignored key decrypts them —
linked worktrees inherit it automatically, CI passes `HACK_ENV_SECRET_KEY`. Scripts
get injected env through `hack host exec` instead of reading `.env` files.

**Parallel everything.** Branch instances run side by side with their own URLs. In a
linked git worktree, `hack up` automatically becomes a separate instance named after
the branch — review a PR while your main checkout keeps running.

**Built for agents.** `hack init --with claude|codex` hands setup to an agent, and
`hack agent onboard` prints an onboarding prompt for an existing repo. Machine
surfaces are first-class: `--json` envelopes with stable error codes and
`--no-interactive`. The optional `hack` plugin gives Codex, Claude Code and Cursor
eight Hack skills through the client's own plugin manager, without writing into your
repository. Clients without shell access can add the separate `hack-mcp` plugin.
See [agent integrations](docs/integrations.md).

## More than ports

Hack gets compared to local-domain tools like portless. Portless names your ports.
Hack runs your project — the URL is just the front door.

A project isn't running until *all* of it is running, and every slice beyond the
URL usually means another tool, another script, another README section:

| The job | The usual duct tape | With hack |
| --- | --- | --- |
| Local domains + trusted TLS | portless, mkcert, `/etc/hosts` edits | `https://myapp.hack.local`, CA trusted once |
| Secrets & env | Doppler, `.env` files in Slack | encrypted values committed with the repo |
| "How do I run this" | README + Makefile + tribal knowledge | `.hack/` config + `hack up` |
| Tunnels, SSO, proxies | ad-hoc shell scripts in a terminal tab | declared lifecycle processes, cleaned up on `down` |
| Logs | terminal scrollback, gone on restart | persisted history: `hack logs --loki --since 2h` |
| Parallel branches | a second clone and port surgery | branch instances; worktrees isolate automatically |
| Workspaces | hand-rolled tmux setups | `hack session` |

Each row is a tool you don't install or a script you don't maintain. And the
pieces compose because they share one model of the project: the same identity that
routes `api.myapp.hack.local` also decrypts its secrets, starts its tunnels, labels its
logs, and namespaces its branch instances. That's why none of it needs glue code.

## Your environment, anywhere

Remote coding environments — Codex, Claude Code, Cursor, your own sandboxes — all
stall on the same problem: someone has to hand-build the project's environment
inside the box. A hack project has already done this work. The environment is
committed with the repo and isolated by design, so teammates and agents reuse the
same definition. Each host still needs a compatible container runtime and the
project's prerequisites; the secret key arrives through that host's secret store.
There's a slim container image (`hackdance/hack:slim`) built for exactly this. See
[managed environments](./docs/guides/codex-managed-environments.md).

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
[v5 status](#v5-status) below.

## Quick start

```bash
hack global install        # once per machine: DNS, TLS, proxy
cd /path/to/project
hack init                  # or: hack init --with claude
hack up --detach
hack open
```

Using a coding agent? Install the optional `hack` plugin for its skills:

```bash
codex plugin marketplace add hack-dance/hack && codex plugin add hack@hack-dance
# or, in Claude Code:
claude plugin marketplace add hack-dance/hack --sparse .claude-plugin plugins/hack plugins/hack-mcp
claude plugin install hack@hack-dance
```

In Cursor, install Hack from Customize. Add `hack-mcp` only for a client without
shell access.

When something looks wrong:

```bash
hack doctor
hack doctor --fix
```

## Everyday commands

```bash
hack status                          # what's running
hack logs --pretty                   # tail logs (or: hack logs <service>)
hack exec api -- bun test            # run inside a running service
hack run api -- bun db:migrate       # one-off container command
hack host exec --scope api -- bun db:seed   # host command with injected env
hack up --branch review              # parallel branch instance
hack session start myapp             # persistent tmux workspace
hack down
```

Every command works from the repo root, or anywhere with `--project <name>`.

## v5 status

v5 keeps the same CLI and project model. Docker Compose stays the default backend.
New in v5: an opt-in native backend for Apple Silicon macOS that runs prepared
projects without Docker, a config compiler, `hack dev` for side-by-side builds, and
stricter, safer command and env handling. Hosted accounts, the web dashboard, Hack
Tickets, built-in GitHub/Linear integrations and automatic agent instruction
injection are retired.

Prereleases (`5.0.0-next.N`) install beside stable Hack through the separate
`hack-next` channel. Read [Upgrade to v5](docs/guides/upgrade-to-v5.md), the
[prerelease channel](docs/guides/prereleases.md) and
[installing a prerelease](docs/guides/candidate-install.md). The `next` branch holds
v5 work; `main` holds the stable line.

## Documentation

Start with [Getting started](docs/guides/getting-started.md) or the
[documentation index](docs/README.md). The public site is
[hack.foo](https://hack.foo); its source lives in [`site/`](site/README.md).

- [CLI overview](./docs/cli.md) and the [generated command reference](./docs/reference/cli.md)
- [Env & secrets](./docs/env.md) · [Lifecycle](./docs/lifecycle.md) · [Sessions](./docs/sessions.md)
- [Agent-first setup](./docs/guides/agent-first-setup.md) · [Agent integrations](./docs/integrations.md)

The CLI is the supported product. The retained macOS app and the
remote/gateway/node/dispatch commands are unsupported and are not part of setup.

## License

See [LICENSE](./LICENSE).
