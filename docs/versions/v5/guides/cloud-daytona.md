# Daytona

> **Not run yet.** This page follows the provider's documentation as read on
> 2026-11-18 ([snapshots](https://www.daytona.io/docs/en/snapshots/),
> [process execution](https://www.daytona.io/docs/en/process-code-execution/),
> [secrets](https://www.daytona.io/docs/en/secrets/),
> [preview](https://www.daytona.io/docs/en/preview/)). v5 has no Linux release
> yet, so the install line needs a `hack` binary you supply; see
> [Any Linux machine with Docker](cloud-linux-docker.md#steps).

Daytona sandboxes are driven through its API, SDK or CLI. They have no
repository hook. Docker-in-Docker is documented with a Docker-capable snapshot
of at least 2 vCPU and 4 GiB.

## Set up

- **Snapshot** from a Dockerfile: Ubuntu with Docker installed (Daytona's docs
  use `curl -fsSL https://get.docker.com | VERSION=28.3.3 sh -`), the Compose
  plugin, `tmux` if the project has lifecycle processes, and `hack` in
  `/usr/local/bin` (commit the binary gzipped, since
  GitHub refuses files over 100 MB, and unpack it in the Dockerfile:
  `COPY .hack-bin/hack.gz /tmp/` then
  `RUN gunzip -c /tmp/hack.gz > /usr/local/bin/hack && chmod 0755 /usr/local/bin/hack`).
  Build it with the CLI:
  `daytona-v0 snapshot create <name> --dockerfile ./Dockerfile` (the dashboard
  builds image-based snapshots only).
- **Create the sandbox** with `HACK_ENV_SECRET_KEY` in `envVars`. Daytona
  *Secrets* give the process a placeholder and cannot decrypt Hack's values.
- **Clone the project** into the sandbox once (Daytona's Git operations, or
  `git clone` in a command), for example to `~/project`.
- **After each start**, run in the project directory. With the SDK, pass the
  directory and a longer timeout: `process.executeCommand` stops a command after
  10 seconds by default (TypeScript: `executeCommand(command, cwd, env, timeout)`;
  Python: `process.exec(command, cwd=..., timeout=...)`):

```sh
(dockerd >/var/log/dockerd.log 2>&1 &)
for i in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done
export HACK_RUNTIME_BACKEND=compose
hack config set --global proxy.bind_address 127.0.0.1
hack global install --no-interactive
hack up --detach --no-interactive --json
```

  Give it at least 300 seconds: the first run pulls images.

## Check it

```sh
curl --noproxy hello.hack --resolve hello.hack:443:127.0.0.1 -k https://hello.hack/
```

## Expected differences

- Preview URLs (`https://<port>-<sandbox>.<domain>`) carry their own host name,
  which Hack's proxy has no route for yet.
- Stopping a sandbox keeps its files but not running processes. Run the start
  commands again.
