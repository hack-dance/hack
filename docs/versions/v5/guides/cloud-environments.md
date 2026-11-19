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
curl --resolve 'hello.hack:443:127.0.0.1' 'https://hello.hack/'
```

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
