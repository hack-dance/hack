# Any Linux machine with Docker

> **Verified on 2026-11-19** with `hack` built from `next` at `6447491b33`, in
> a fresh Ubuntu 24.04 x86_64 container: a user without sudo, a private Docker
> Engine 29.1.3 with Compose 2.40.3, and a project with one encrypted value.
> The commands below ran as written, except step 1, which copied in the built
> binary. There is no published Linux v5 release yet.

This page is for a machine or sandbox you can open a shell on: a cloud VM, a
CI runner, a container with its own Docker daemon, a remote dev box. The same
`.hack/` folder you use on your laptop brings the project up here. Hack is not
a sandbox. It runs inside whatever machine you give it, with that machine's
isolation.

## What you need

- Linux on x86_64 or arm64.
- A Docker Engine your user can reach, and Docker Compose v2. Check with
  `docker info` and `docker compose version`. Without them Hack stops at once
  and says which one is missing.
- Outbound network access to Docker Hub and the registries your project uses.
- The `hack` command (step 1).
- If the project defines lifecycle processes (`lifecycle.processes`) or
  long-running `up.before` hooks and does not set `lifecycle.runner` to
  `"supervisor"`, `tmux`: Hack runs those processes in a tmux session.
- If the project has encrypted values: its key, which goes in
  `HACK_ENV_SECRET_KEY`.

You do not need sudo, a browser or a desktop.

## Steps

**1. Install `hack`.** v5 has no Linux release yet: the prerelease installer
supports Apple Silicon macOS only. Until there is one, build `hack` from a
`next` commit on a Linux machine (see
[Qualify a fresh Linux host](https://github.com/hack-dance/hack/blob/next/docs/guides/linux-host-qualification.md), which also
needs Rust 1.97.1 and a C compiler), then copy `dist/hack` to
`~/.local/bin/hack`. If the project sets `lifecycle.runner` to `"supervisor"` in
`.hack/hack.config.json`, also copy the matching `dist/hack-lifecycle-supervisor`
from the same build into the same directory: `hack up` looks for it beside the
`hack` executable and refuses to start such a project without it. This step
becomes one install command once a Linux release is published.

**2. Set up Hack's proxy once for this Docker engine.** It creates Hack's shared
networks and starts its proxy and logging containers. It needs no sudo and asks
nothing with `--no-interactive`. The first line keeps the proxy on this
machine's loopback address: without it, the proxy listens on every interface,
and on a machine whose firewall lets in ports 80 and 443, anyone who can reach
it can open your app and query Hack's log store (Loki, whose API has no
authentication), and reach the Grafana log viewer's sign-in page, which keeps
its default admin password unless you change it:

```sh
export HACK_RUNTIME_BACKEND=compose
hack config set --global proxy.bind_address 127.0.0.1
hack global install --no-interactive
```

**3. Start the project:**

If the project has encrypted values, provide `HACK_ENV_SECRET_KEY` through your
environment's secret settings first, so it is already in the environment. Never
type the key on the command line, where it lands in shell history. Then:

```sh
cd your-project
hack up --detach --no-interactive --json
```

`hack up` prints `{"ok": true, ...}` with the started services. If something
is missing it prints one error with a code and what to do; see
[When `hack up` cannot start the project here](cloud-environments.md#when-hack-up-cannot-start-the-project-here).

**4. Check it.** Use the project's host from `.hack/hack.config.json`
(`hello.hack.local` for a fresh project using the default suffix):

```sh
curl --noproxy hello.hack.local --resolve hello.hack.local:443:127.0.0.1 -k https://hello.hack.local/
```

You should see your app's page. `--noproxy` keeps an inherited HTTPS proxy
(common in sandboxes) from receiving the request instead of this machine. In the verified run, the first `global install`
took 33 seconds (it pulls the proxy and logging images) and `up` took 3 seconds.

## What is different from a laptop

- **Addresses.** On Linux, Hack's names (`*.hack`, `*.hack.local`) need
  systemd-resolved, which most containers and sandboxes do not run. The app
  still runs, and Hack's proxy answers on this machine's ports 80 and 443. Use
  `curl --resolve` as above. `hack open` prints the same hint and the URL.
- **HTTPS trust.** To drop `-k`, run `hack global trust --no-interactive` once
  and load the file it prints: `. ~/.hack/caddy/pki/caddy-host-trust-env.sh`.
  That covers curl, Node, Python and git without sudo; the system trust store
  steps it lists need root. This works when Docker is the system engine (a
  root-owned `/var/run/docker.sock` and a `docker` client in a system
  directory), as in the verified run. With rootless Docker or Docker Desktop
  for Linux, Hack cannot confirm which certificate authority the running proxy
  uses and refuses to trust it automatically; keep `-k` for local checks there.
- **Secrets.** Hack decrypts with `HACK_ENV_SECRET_KEY` at `up` time. It writes
  neither the key nor decrypted values to disk (the generated Compose override
  holds only `${NAME}` references). The containers' environment does hold the
  values, as on a laptop.
- **Persistence.** Images, volumes and `~/.hack` live with the Docker engine and
  home directory. When the machine is recreated, run steps 2 and 3 again.

## What does not work here

- No DNS for Hack's names without systemd-resolved (use `--resolve`).
- No native backend: it is Apple Silicon macOS only.
- Without a Docker daemon (and the right to start one) there is no way to run
  the project. `hack up` says so and stops.
