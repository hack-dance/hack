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
