# Run a project on another machine or in a cloud agent sandbox

The `.hack/` folder you commit with your code is everything Hack needs to run the
project, so the same folder and the same `hack up` work on your laptop, on
another machine, or inside a cloud agent's sandbox. Hack does not provide the
machine or the sandbox, and it adds no isolation: it runs inside whatever you
give it, with that environment's rules for Docker, secrets, network and
persistence.

On Linux, Hack's Compose runtime needs a Docker Engine the user can reach, and
Docker Compose v2. v5 has no Linux release yet (the prerelease installer
supports Apple Silicon macOS only), so every page below starts from a `hack`
binary you supply.

## Pick your environment

Each page says at the top whether it was run, when, and with which build.

| Environment | Status | Page |
| --- | --- | --- |
| Any Linux machine with Docker | Verified 2026-11-19 (`next` at `95ea63e497`) | [Any Linux machine with Docker](cloud-linux-docker.md) |
| Dev containers (local) | Verified 2026-11-19 (`next` at `95ea63e497`) | [Codespaces and dev containers](cloud-dev-containers.md) |
| GitHub Codespaces | Not run yet | [Codespaces and dev containers](cloud-dev-containers.md) |
| Claude Code on the web | Not run yet | [Claude Code on the web](cloud-claude-code.md) |
| Cursor cloud agents | Not run yet | [Cursor cloud agents](cloud-cursor.md) |
| boat.dev | Not run yet | [boat.dev](cloud-boat.md) |
| Daytona | Not run yet | [Daytona](cloud-daytona.md) |
| OpenAI Codex cloud | Not run yet; Docker not documented | [Codex cloud](cloud-codex.md) |

Not covered: Google Jules (read-only since 2026-11-11, closing 2026-12-31) and
Cube Computer (closing 2026-12-20). Other sandboxes that document a Docker
daemon include E2B, Modal (VM runtime), Vercel Sandbox, Cloudflare Sandbox and
Coder. They have no page yet.

## What is the same everywhere

- **Secrets:** give the project key as the environment variable
  `HACK_ENV_SECRET_KEY` through the environment's secret settings. Several
  providers offer "secrets" that only reach the network proxy and give programs
  a placeholder. Those cannot decrypt anything, so use the plain
  environment-variable kind. Never commit the key or bake it into an image or
  snapshot.
- **Addresses:** most sandboxes have no DNS for Hack's names. The app still
  runs, and Hack's proxy answers on the machine's ports 80 and 443. Check it from
  inside with `curl --resolve`, as
  [Reaching the app without local DNS](#reaching-the-app-without-local-dns)
  shows.
- **Provider preview URLs and forwarded ports** send their own host name. Hack's
  proxy has no route for it yet, so they do not show the app.
- **Keep the proxy on loopback:** every recipe runs
  `hack config set --global proxy.bind_address 127.0.0.1` before
  `hack global install`. Without it, Hack's proxy listens on every interface,
  and anyone who can reach the machine's ports 80 and 443 can open the app,
  query Hack's log store (Loki, whose API has no authentication) and reach the
  Grafana log viewer's sign-in page, which keeps its default admin password
  unless you change it. Leave it unset only if you want that
  exposure and protect it yourself.
- **Persistence:** running containers do not survive a sandbox stop or a
  snapshot restore. Run `hack up` from the environment's start hook.

For env-only use without containers (resolving values, running host commands),
see [Managed environments](https://github.com/hack-dance/hack/blob/next/docs/guides/codex-managed-environments.md).
Deploying an app to a hosting service is a different workflow: Hack does not
translate project configuration into a deployment.

## Reaching the app without local DNS

Hack's addresses (`https://<project>.hack`) need local DNS. On Linux, Hack sets
it up only through systemd-resolved, which most containers and cloud sandboxes
do not run, so the name has no address there. The app still runs, and Hack's
proxy answers on this machine's ports 80 and 443. `hack open` then warns and
prints the address with a command that needs no DNS, for example:

```sh
curl --resolve 'hello.hack:443:127.0.0.1' 'https://hello.hack/'
```

Where the environment sets an HTTPS proxy (`HTTPS_PROXY`, common in sandboxes),
add `--noproxy hello.hack` so curl sends the request to this machine and not to
the proxy.

The command sends the request to the address the proxy publishes on, read from
Hack's proxy Compose file (`~/.hack/caddy/docker-compose.yml`): loopback by
default, or the address `proxy.bind_address` had when `hack global install`
last rendered that file. When the file cannot be read, the hint shows
`<address>` instead of guessing. It is offered only for the proxy's own ports
(80 and 443).

For `https`, run `hack global trust` once and load the host trust env file it
prints (`~/.hack/caddy/pki/caddy-host-trust-env.sh`). That part needs no sudo;
the system trust store steps it lists do. Where no program can open a URL
(no `xdg-open`, as on most servers and sandboxes), `hack open` prints only the
URL on stdout, its notes on stderr, and exits 0. `hack doctor` reports a missing Bun as a warning for the
compiled CLI, which does not need it.

## When `hack up` cannot start the project here

On the Compose backend, `hack up` checks the machine after the project's
`up.before` hooks (which may start the engine or create a network) and before it
pulls an image or starts a container. The checks select the engine the same way
Compose does, so a project's `DOCKER_HOST`, `DOCKER_CONTEXT` or SSH agent applies.
When something is missing, it stops with one line that says what and what to do
(the `--json` envelope carries the same `code` and `message`):

| Code | What it means | What to do |
| --- | --- | --- |
| `E_DOCKER_UNAVAILABLE` "This machine has no `docker` command…" | No Docker CLI on PATH. | Install Docker Engine and Docker Compose v2, or turn on the environment's Docker option. An environment that cannot run a container engine cannot start the project with Hack. |
| `E_PERMISSION` "Permission denied connecting to the Docker engine…" | Docker runs, but this user cannot open its socket. | Add the user to the `docker` group and start a new login session, or select a usable engine with `docker context use`. |
| `E_DOCKER_UNAVAILABLE` "The Docker engine is not reachable…" | The CLI is there, but no engine answers (not started, or `DOCKER_HOST` points elsewhere). | Start the engine (in a container sandbox, `dockerd` must already run or be started by the environment's setup), then retry. |
| `E_DOCKER_UNAVAILABLE` "…Hack needs the Docker Compose v2 plugin" | `docker compose version` fails. | Install the Compose plugin (`docker-compose-v2` or `docker-compose-plugin` on Ubuntu and Debian). |
| `E_GLOBAL_INFRA_DOWN` "This project joins Hack's shared network hack-dev…" | A service that this `up` starts joins Hack's shared network, and `hack global install` has not run on this Docker engine yet. | Run `hack global install` once. Creating the network and starting the proxy need no sudo; its DNS and certificate trust steps can ask for it and can be skipped. |
| `E_ENV_KEY_MISSING` "Missing project env key at …" | The project has encrypted values and this checkout has no key. | Provide the same key as `HACK_ENV_SECRET_KEY` through the environment's secret settings, or copy `.hack.secret.key` from a checkout that has it. A new key cannot decrypt existing values. |
