# Cursor cloud agents

> **Not run yet.** This page follows the provider's documentation as read on
> 2026-11-18 ([setup](https://cursor.com/docs/cloud-agent/setup),
> [builds](https://cursor.com/docs/cloud-agent/builds)). v5 has no Linux release
> yet, so the install line needs a `hack` binary you supply; see
> [Any Linux machine with Docker](cloud-linux-docker.md#steps).

Cloud agents run in Ubuntu VMs. Cursor documents a Docker setup in a
`.cursor/environment.json` Dockerfile. A Build keeps the disk, including
Docker's data directory, so pulled images survive between agents. Processes do
not.

## Files to commit

`.cursor/environment.json`:

```json
{
  "build": { "dockerfile": "Dockerfile", "context": ".." },
  "install": "sudo service docker start && HACK_RUNTIME_BACKEND=compose hack global install --no-interactive",
  "start": "sudo service docker start && HACK_RUNTIME_BACKEND=compose hack up --detach --no-interactive --json"
}
```

`.cursor/Dockerfile`: start from Cursor's documented Docker recipe (Docker CE,
the Compose plugin, `fuse-overlayfs` as the storage driver, legacy iptables, and
a user in the `docker` group), then add `hack`:

```dockerfile
COPY .hack-bin/hack /usr/local/bin/hack
```

**Secret:** in the Cursor dashboard, **Cloud Agents → Secrets**, add
`HACK_ENV_SECRET_KEY` as an *Environment Variable* or *Runtime Secret*. A *Build
Secret* is not visible to the running agent.

**Environment:** in **Cloud Agents → Environments**, create an environment for
the repository and set its **environment.json location** to that repository. A
new environment defaults to **None (skip environment.json)**, which ignores the
file above. Builds use the file from the default branch.

## Check it

Ask the agent to run (with your project's host):

```sh
curl --noproxy hello.hack --resolve hello.hack:443:127.0.0.1 -k https://hello.hack/
```

## Expected differences

- No DNS for Hack's names: use `curl --resolve`.
- Forwarded ports send their own host name, which Hack's proxy has no route for
  yet.

## Not known yet

The VM's CPU architecture and whether systemd-resolved runs. The first run
should record both.
