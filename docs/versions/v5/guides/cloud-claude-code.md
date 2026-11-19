# Claude Code on the web

> **Not run yet.** This page follows the provider's documentation as read on
> 2026-11-18 ([cloud environments](https://code.claude.com/docs/en/cloud-environments)).
> v5 has no Linux release yet, so the install line needs a `hack` binary you
> supply; see [Any Linux machine with Docker](cloud-linux-docker.md#steps).

Each cloud session is an Ubuntu 24.04 x86_64 VM that runs as root, with
`docker`, `dockerd` and `docker compose` installed. The default network
allowlist includes Docker Hub, `ghcr.io` and GitHub release downloads.

## Set up the environment

**Environment variables** (in the environment's settings): add
`HACK_ENV_SECRET_KEY` as an ordinary environment variable. Do not use a
*network secret*: those never reach the VM, and the process only sees a
placeholder that cannot decrypt anything. Anyone who uses the environment can
read its variables.

**Setup script** (pasted in the environment dialog; it runs once, and its result
is cached):

```sh
#!/bin/sh
set -eu
# Install hack (replace with the Linux release installer once it exists).
install -m 0755 ./.hack-bin/hack /usr/local/bin/hack
pgrep -x dockerd >/dev/null || (dockerd >/var/log/dockerd.log 2>&1 &)
for i in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done
export HACK_RUNTIME_BACKEND=compose
hack global install --no-interactive
```

**Session hook** in the repository's `.claude/settings.json`, which runs on every
session start and resume:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "pgrep -x dockerd >/dev/null || (dockerd >/var/log/dockerd.log 2>&1 &); sleep 3; HACK_RUNTIME_BACKEND=compose hack up --detach --no-interactive --json",
            "timeout": 600
          }
        ]
      }
    ]
  }
}
```

## Check it

Ask the session to run (with your project's host):

```sh
curl --resolve hello.hack:443:127.0.0.1 -k https://hello.hack/
```

## Expected differences

- No DNS for Hack's names in the VM: use `curl --resolve`, as above.
- No preview URL is documented. Check the app from inside the session.
- Running containers do not survive a paused or reclaimed VM. The session hook
  starts them again.

## Not known yet

Whether `dockerd` already runs at session start, and whether the VM allows
binding ports 80 and 443. The first run should record both.
