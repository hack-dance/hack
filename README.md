<p align="center">
  <img alt="Hack" src="./apps/macos/512@2x.png" width="160" />
</p>

# Hack

Run every project on your machine at once, each at its own local HTTPS URL.

```bash
cd any-repo && hack up
# → https://myapp.hack is live, TLS trusted, env injected
```

Local development breaks down when one machine runs many things. Two projects fight
over port 3000. A repo you haven't touched in a month needs an afternoon of
archaeology to start. Secrets live in `.env` files passed around in Slack. Testing a
PR means tearing down the branch you were working on.

Hack fixes this by giving each repo a small committed config (`.hack/`) and running
it against shared local infrastructure — Docker Compose for services, Caddy for DNS
and trusted TLS. Nothing is hosted. Your machine is the platform.

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

Hack gets compared to local-domain tools like portless. Stable URLs are one slice.
A project isn't running until *all* of it is running, and every other slice usually
means another tool, another script, another README section:

| The job | The usual duct tape | With hack |
| --- | --- | --- |
| Local domains + trusted TLS | portless, mkcert, `/etc/hosts` edits | `https://myapp.hack`, CA trusted once |
| Secrets & env | Doppler, `.env` files in Slack | encrypted values committed with the repo |
| "How do I run this" | README + Makefile + tribal knowledge | `.hack/` config + `hack up` |
| Tunnels, SSO, proxies | ad-hoc shell scripts in a terminal tab | declared lifecycle processes, cleaned up on `down` |
| Logs | terminal scrollback, gone on restart | persisted history: `hack logs --loki --since 2h` |
| Parallel branches | a second clone and port surgery | branch instances; worktrees isolate automatically |
| Workspaces | hand-rolled tmux setups | `hack session` |

Each row is a tool you don't install or a script you don't maintain. The pieces
compose because they share one model of the project — the same config that names
your URL also resolves your env, starts your tunnels, and labels your logs.

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
source of truth. Runtime container images (`hackdance/hack:latest`, `:slim`) and
optional extensions are covered in the docs. Remote/gateway/node/dispatch commands
are source-available but unsupported experimental — hidden behind `hack help --all`.

## License

See [LICENSE](./LICENSE).
