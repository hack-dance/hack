# boat.dev

> **Not run yet.** This page follows the provider's documentation as read on
> 2026-11-18 ([tools](https://docs.boat.dev/machines/tools.md),
> [setup](https://docs.boat.dev/setup.md)). v5 has no Linux release yet, so the
> install line needs a `hack` binary you supply; see
> [Any Linux machine with Docker](cloud-linux-docker.md#steps).

boat.dev sandboxes are Ubuntu 24.04 x86_64 VMs with passwordless sudo, systemd,
and Docker with Compose installed. Environment secrets arrive as ordinary
environment variables.

## Set up

- **Saved snapshot:** install `hack` to `/usr/local/bin/hack` and run
  `HACK_RUNTIME_BACKEND=compose hack global install --no-interactive` once, so
  the proxy images are in the snapshot.
- **Environment secret:** `HACK_ENV_SECRET_KEY`.
- **Repository setup script:** in the dashboard, **Environment**, under GitHub
  repositories select **Setup** below the repository, then save the environment.
  It runs inside the repository folder, in a login shell, on every create,
  resume and fork:

```sh
export HACK_RUNTIME_BACKEND=compose
hack global install --no-interactive
hack up --detach --no-interactive --json
```

## Check it

From your machine, `boat exec <sandbox> --cwd <repo> '<command>'` runs a command
in the sandbox (the default timeout is 30 seconds):

```sh
curl --resolve hello.hack:443:127.0.0.1 -k https://hello.hack/
```

A VM with systemd-resolved may also resolve Hack's names after
`hack global install` (that step asks for sudo). The first run should record
whether it does.

## Expected differences

- `boat host <port>` gives a public HTTPS address with its own host name, which
  Hack's proxy has no route for yet.
