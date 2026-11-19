# Claude Code on the web

> **Not run yet.** This page follows the provider's documentation as read on
> 2026-11-18 ([cloud environments](https://code.claude.com/docs/en/cloud-environments)).
> v5 has no Linux release yet, so the install line needs a `hack` binary you
> supply; see [Any Linux machine with Docker](cloud-linux-docker.md#steps).

Each cloud session is an Ubuntu 24.04 x86_64 VM that runs as root, with
`docker`, `dockerd` and `docker compose` installed. The default network
allowlist includes Docker Hub, `ghcr.io` and GitHub release downloads.

## Set up the environment

Open the environment selector (the first control under the message box on the
new-session screen at claude.ai/code), choose **New environment**, and fill in:

**Environment variables:** add `HACK_ENV_SECRET_KEY=...` as an ordinary
environment variable. The dialog warns that anyone who uses the environment can
read these values, and it suggests a *network secret* instead. A network secret
never reaches the VM, though, and gives programs only a placeholder that cannot
decrypt anything. So for this key the environment variable is the only kind that
works; use a non-production key.

**Network access:** the default **Limited** with **Allow package managers**
already covers Docker Hub, `ghcr.io` and GitHub release downloads.

**Setup script** (optional; it runs once, before the environment's variables are
set, and its result is cached): pre-pull large images so new sessions have them.

**Session hook** in the repository's `.claude/settings.json`. It runs on every
session start and resume, also in local sessions, so the script exits at once
outside the cloud. It installs `hack` from a path in the repository (until a
Linux release exists) and starts the project:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume",
        "hooks": [
          {
            "type": "command",
            "command": "sh \"$CLAUDE_PROJECT_DIR\"/.claude/hack-up.sh",
            "timeout": 600
          }
        ]
      }
    ]
  }
}
```

`.claude/hack-up.sh`:

```sh
#!/bin/sh
# Cloud sessions only; local sessions keep their own Hack setup.
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
set -eu
cd "$CLAUDE_PROJECT_DIR"
command -v hack >/dev/null || { gunzip -c .hack-bin/hack.gz > /usr/local/bin/hack && chmod 0755 /usr/local/bin/hack; }
pgrep -x dockerd >/dev/null || (dockerd >/var/log/dockerd.log 2>&1 &)
for i in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done
export HACK_RUNTIME_BACKEND=compose
hack config set --global proxy.bind_address 127.0.0.1
hack global install --no-interactive
hack up --detach --no-interactive --json
```

## Check it

Ask the session to run (with your project's host):

```sh
curl --noproxy hello.hack --resolve hello.hack:443:127.0.0.1 -k https://hello.hack/
```

## Expected differences

- No DNS for Hack's names in the VM: use `curl --resolve`, as above.
- No preview URL is documented. Check the app from inside the session.
- Running containers do not survive a paused or reclaimed VM. The session hook
  starts them again.

## Not known yet

Whether `dockerd` already runs at session start, and whether the VM allows
binding ports 80 and 443. The first run should record both. Hooks do not run in
sessions with several repositories; start one repository per session.
