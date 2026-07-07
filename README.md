<p align="center">
  <img alt="Hack" src="./apps/macos/512@2x.png" width="160" />
</p>

# Hack

One command runs the whole project — services, env, secrets, TLS, logs — at its own
local HTTPS URL. Every project on your machine, all at once, none of them colliding.

```bash
cd any-repo && hack up
# → https://myapp.hack is live, TLS trusted, env injected
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

**A real URL for every project.** `https://myapp.hack`, with per-service subdomains
like `api.myapp.hack` and locally-trusted certificates. No ports to remember, no
collisions, and OAuth-friendly alias hosts when a provider rejects `.hack`.

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

**Built for agents.** `hack init --with claude|codex` hands setup to an agent.
Machine surfaces are first-class: `--json` envelopes with stable error codes,
`--no-interactive`, and agent instructions that sync themselves into
AGENTS.md/CLAUDE.md, Cursor rules, and Codex skills.

## More than ports

Hack gets compared to local-domain tools like portless. Portless names your ports.
Hack runs your project — the URL is just the front door.

A project isn't running until *all* of it is running, and every slice beyond the
URL usually means another tool, another script, another README section:

| The job | The usual duct tape | With hack |
| --- | --- | --- |
| Local domains + trusted TLS | portless, mkcert, `/etc/hosts` edits | `https://myapp.hack`, CA trusted once |
| Secrets & env | Doppler, `.env` files in Slack | encrypted values committed with the repo |
| "How do I run this" | README + Makefile + tribal knowledge | `.hack/` config + `hack up` |
| Tunnels, SSO, proxies | ad-hoc shell scripts in a terminal tab | declared lifecycle processes, cleaned up on `down` |
| Logs | terminal scrollback, gone on restart | persisted history: `hack logs --loki --since 2h` |
| Parallel branches | a second clone and port surgery | branch instances; worktrees isolate automatically |
| Workspaces | hand-rolled tmux setups | `hack session` |

Each row is a tool you don't install or a script you don't maintain. And the
pieces compose because they share one model of the project: the same identity that
routes `api.myapp.hack` also decrypts its secrets, starts its tunnels, labels its
logs, and namespaces its branch instances. That's why none of it needs glue code.

## Your environment, anywhere

Remote coding environments — Codex, Claude Code, Cursor, your own sandboxes — all
stall on the same problem: someone has to hand-build the project's environment
inside the box. Services, env, secrets, startup order. It's manual, it drifts, and
it has to be redone for every project and every platform.

A hack project has already done this work. The environment is committed with the
repo and isolated by design, so it runs the same on a teammate's laptop, in CI, or
inside an agent's sandbox. Install hack, pass `HACK_ENV_SECRET_KEY`, run `hack up`.
That is the entire setup — make a repo portable once and every environment,
human or machine, gets it for free.

There's a slim container image (`hackdance/hack:slim`) built for exactly this; see
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

## Quick start

```bash
hack global install        # once per machine: DNS, TLS, proxy
cd /path/to/project
hack init                  # or: hack init --with claude
hack up --detach
hack open
```

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

## Learn more

- [Docs index](./docs/README.md) — concepts, guides, and reference
- [CLI overview](./docs/cli.md) and the [generated command reference](./docs/reference/cli.md)
- [Env & secrets](./docs/env.md) · [Lifecycle](./docs/lifecycle.md) · [Sessions](./docs/sessions.md)
- [Agent-first setup](./docs/guides/agent-first-setup.md)

A slim macOS companion app shows project status and quick actions; the CLI stays the
source of truth. Optional extensions and container images are covered in the docs.
Remote/gateway/node/dispatch commands are source-available but unsupported
experimental — hidden behind `hack help --all`.

## License

See [LICENSE](./LICENSE).
