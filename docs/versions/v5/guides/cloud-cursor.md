# Cursor cloud agents

> **Not run yet.** This page follows the provider's documentation as read on
> 2026-11-18 ([setup](https://cursor.com/docs/cloud-agent/setup),
> [builds](https://cursor.com/docs/cloud-agent/builds)). The recipe below was
> written before v5 published a Linux archive, so its install line uses a
> `hack` binary you supply. `5.0.0-next.24` publishes Linux x86_64 and arm64
> archives with the Compose backend: you can install the prerelease as
> described in [Install](../install.md) instead. Neither way has been run here.
> See [Any Linux machine with Docker](cloud-linux-docker.md#steps).

Cloud agents run in Ubuntu VMs. Cursor documents a Docker setup in a
`.cursor/environment.json` Dockerfile. A Build keeps the disk, including
Docker's data directory, so pulled images survive between agents. Processes do
not.

## Files to commit

`.cursor/environment.json`:

```json
{
  "build": { "dockerfile": "Dockerfile", "context": ".." },
  "install": "sudo service docker start && hack config set --global proxy.bind_address 127.0.0.1 && HACK_RUNTIME_BACKEND=compose hack global install --no-interactive",
  "start": "sudo service docker start && HACK_RUNTIME_BACKEND=compose hack up --detach --no-interactive --json"
}
```

`.cursor/Dockerfile`: the parts of Cursor's documented Docker recipe that matter
here (a Docker engine and the Compose plugin, `fuse-overlayfs` as the storage
driver, legacy iptables, and a sudo user in the `docker` group), using Ubuntu's
own Docker packages, then `hack`. The binary is committed gzipped as
`.hack-bin/hack.gz`, because GitHub refuses files over 100 MB:

```dockerfile
FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git sudo gzip docker.io docker-compose-v2 fuse-overlayfs iptables tmux \
 && rm -rf /var/lib/apt/lists/*
RUN update-alternatives --set iptables /usr/sbin/iptables-legacy \
 && update-alternatives --set ip6tables /usr/sbin/ip6tables-legacy
RUN mkdir -p /etc/docker && printf '{"storage-driver":"fuse-overlayfs"}\n' > /etc/docker/daemon.json
COPY .hack-bin/hack.gz /tmp/hack.gz
RUN gunzip -c /tmp/hack.gz > /usr/local/bin/hack && chmod 0755 /usr/local/bin/hack && rm /tmp/hack.gz
RUN (id ubuntu >/dev/null 2>&1 || useradd -m -s /bin/bash ubuntu) \
 && echo 'ubuntu ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/ubuntu \
 && usermod -aG docker ubuntu
USER ubuntu
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
