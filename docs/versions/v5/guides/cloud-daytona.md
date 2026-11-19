# Daytona

> **Not run yet.** This page follows the provider's documentation as read on
> 2026-11-18 ([snapshots](https://www.daytona.io/docs/en/snapshots/),
> [secrets](https://www.daytona.io/docs/en/secrets/),
> [preview](https://www.daytona.io/docs/en/preview/)). v5 has no Linux release
> yet, so the install line needs a `hack` binary you supply; see
> [Any Linux machine with Docker](cloud-linux-docker.md#steps).

Daytona sandboxes are driven through its API, SDK or CLI. They have no
repository hook. Docker-in-Docker is documented with a Docker-capable snapshot
of at least 2 vCPU and 4 GiB.

## Set up

- **Snapshot** from a Dockerfile: Ubuntu with Docker installed (Daytona's docs
  use the `get.docker.com` script), the Compose plugin, and `hack` in
  `/usr/local/bin`.
- **Create the sandbox** with `HACK_ENV_SECRET_KEY` in `envVars`. Daytona
  *Secrets* give the process a placeholder and cannot decrypt Hack's values.
- **After each start**, run through the CLI or `process.executeCommand`:

```sh
(dockerd >/var/log/dockerd.log 2>&1 &); sleep 3
export HACK_RUNTIME_BACKEND=compose
hack global install --no-interactive
hack up --detach --no-interactive --json
```

## Check it

```sh
curl --resolve hello.hack:443:127.0.0.1 -k https://hello.hack/
```

## Expected differences

- Preview URLs (`https://<port>-<sandbox>.<domain>`) carry their own host name,
  which Hack's proxy has no route for yet.
- Stopping a sandbox keeps its files but not running processes. Run the start
  commands again.
