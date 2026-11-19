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

On the Compose backend, `hack up` checks the machine before it pulls an image
or starts a container, using the same environment Compose gets (so a project's
`DOCKER_HOST` or `DOCKER_CONTEXT` applies). The shared-network check runs after
the project's `up.before` hooks. When something is missing, it stops with one line that
says what and what to do (the `--json` envelope carries the same `code` and
`message`):

| Code | What it means | What to do |
| --- | --- | --- |
| `E_DOCKER_UNAVAILABLE` "This machine has no `docker` command…" | No Docker CLI on PATH. | Install Docker Engine and Docker Compose v2, or turn on the environment's Docker option. An environment that cannot run a container engine cannot start the project with Hack. |
| `E_PERMISSION` "Permission denied connecting to the Docker engine…" | Docker runs, but this user cannot open its socket. | Add the user to the `docker` group and start a new login session, or select a usable engine with `docker context use`. |
| `E_DOCKER_UNAVAILABLE` "The Docker engine is not reachable…" | The CLI is there, but no engine answers (not started, or `DOCKER_HOST` points elsewhere). | Start the engine (in a container sandbox, `dockerd` must already run or be started by the environment's setup), then retry. |
| `E_DOCKER_UNAVAILABLE` "…Hack needs the Docker Compose v2 plugin" | `docker compose version` fails. | Install the Compose plugin (`docker-compose-v2` or `docker-compose-plugin` on Ubuntu and Debian). |
| `E_GLOBAL_INFRA_DOWN` "This project joins Hack's shared network hack-dev…" | A service that this `up` starts joins Hack's shared network, and `hack global install` has not run on this Docker engine yet. | Run `hack global install` once. Creating the network and starting the proxy need no sudo; its DNS and certificate trust steps can ask for it and can be skipped. |
| `E_ENV_KEY_MISSING` "Missing project env key at …" | The project has encrypted values and this checkout has no key. | Provide the same key as `HACK_ENV_SECRET_KEY` through the environment's secret settings, or copy `.hack.secret.key` from a checkout that has it. A new key cannot decrypt existing values. |
