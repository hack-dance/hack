# Use a cloud agent or another host

Choose the execution environment first:

- **Your local machine:** Hack uses that machine's services, configuration and routing.
- **A cloud coding-agent environment:** install and run Hack inside the provider's VM/container, subject to its runtime, persistence, secret and network rules.
- **An existing remote development host:** Hack runs locally on that host; SSH or an agent is transport, not a built-in Hack fleet controller.
- **An application hosting service:** deploying an app to ECS or an agent runtime is a separate workflow. Hack does not translate project configuration into a deployment there.

Use [Managed environments](../../guides/codex-managed-environments.md) for the
version-specific installation contract. Verify OS/CPU architecture, matching
release asset, project toolchain, Docker daemon and Compose (for that runtime),
bind mounts, network access, task-time credentials and startup after snapshot
restore. Installing a CLI does not supply a Docker daemon or laptop certificate
trust. A macOS native bundle does not install on an Ubuntu cloud VM.

## Reaching the app without local DNS

Hack's addresses (`https://<project>.hack`) need local DNS. On Linux, Hack sets
it up only through systemd-resolved, which most containers and cloud sandboxes
do not run, so the name has no address there. The app still runs, and Hack's
proxy answers on this machine's ports 80 and 443. `hack open` then warns and
prints the address with a command that needs no DNS, for example:

```sh
curl --noproxy 'hello.hack' --resolve 'hello.hack:443:127.0.0.1' 'https://hello.hack/'
```

The command sends the request to the address the proxy publishes on, and
`--noproxy` keeps an inherited HTTPS proxy (common in sandboxes) out of it. The
address is read from
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

## Named platform compatibility

These are documentation-based assessments, not successful Hack application tests:

| Platform | Supported prerequisite evidence | Remaining verification |
| --- | --- | --- |
| [Cursor cloud agents](https://cursor.com/docs/cloud-agent) | Provider-managed Ubuntu; inspect current environment/Docker documentation | Nested Docker, mounts, startup and task-time secrets for your app |
| [boat.dev](https://boat.dev) | Provider documents Linux VMs, SSH and Docker | Architecture, matching asset, persistence and app readiness |
| [Google Jules](https://jules.google/docs/environment/) | Managed task VM; use its current tool/setup contract | Secret lifetime, daemon availability and app health |
| [Google Cloud Workstations](https://cloud.google.com/workstations/docs/overview) | Managed workstation environment | Actual image, Docker access and persistent paths |
| code.computer | Exact product documentation could not be retrieved during review | Identity and runtime contract unverified; no setup recipe claimed |
| [Amazon ECS](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/Welcome.html) | App container hosting; Fargate is not a privileged Docker host | No verified Hack deployment adapter or full host-runtime integration |
| Personal fleet | Ordinary CLI installation per compatible existing host | Per-host runtime, access, state and routing qualification |

Use provider-approved secret injection at task time. Do not bake project keys into
images or snapshots. Provider setup scripts, build snapshots and service startup
may have different lifetimes. Test the actual application after every fresh task
or resumed host. Remote/gateway/node/dispatch commands are outside the supported
setup described here.

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
