# GitHub Codespaces and dev containers

> **Dev container: verified on 2026-11-19** with the Dev Container CLI 0.90.0
> on Linux x86_64 and `hack` built from `next` at `6447491b33`.
> `devcontainer up` with the files below started the project with no other
> command. The install step copied in that built binary; no Linux archive was
> published at that time.
>
> **GitHub Codespaces: not run yet.** It reads the same `devcontainer.json`.

## What you need

- A repository with a working `.hack/` folder.
- For Codespaces: a GitHub account that can create codespaces on the repository.
  Locally: Docker and the [Dev Container CLI](https://github.com/devcontainers/cli)
  or an editor that supports dev containers.
- If the project has encrypted values: its key, stored as a secret named
  `HACK_ENV_SECRET_KEY`.

## Files to commit

`.devcontainer/devcontainer.json`:

```json
{
  "name": "hack project",
  "image": "mcr.microsoft.com/devcontainers/base:ubuntu-24.04",
  "features": {
    "ghcr.io/devcontainers/features/docker-in-docker:2": {}
  },
  "remoteUser": "vscode",
  "containerEnv": {
    "HACK_RUNTIME_BACKEND": "compose",
    "HACK_NO_INTERACTIVE": "1"
  },
  "onCreateCommand": "sh .devcontainer/install-hack.sh",
  "postStartCommand": "hack config set --global proxy.bind_address 127.0.0.1 && hack global install --no-interactive && hack up --detach --no-interactive --json"
}
```

The `docker-in-docker` feature gives the container its own Docker Engine and
Compose. `postStartCommand` runs on every start, so the project comes back
after a stop.

`.devcontainer/install-hack.sh` installs `hack`. `5.0.0-next.24` publishes
Linux archives, so the script can install the prerelease as described in
[Install](../install.md); that variant has not been run in a dev container.
The script from the verified run is shown here. It
copies a `hack` binary you built (see
[Any Linux machine with Docker](cloud-linux-docker.md#steps)) and committed as a
gzip file, because GitHub refuses files over 100 MB and the binary is about
160 MB (about 70 MB gzipped). A project that sets `lifecycle.runner` to
`"supervisor"` also needs the build's `hack-lifecycle-supervisor` installed beside
`hack` in `/usr/local/bin`, and a project with lifecycle processes needs `tmux`
(see [Any Linux machine with Docker](cloud-linux-docker.md#what-you-need)); the
script below installs `hack` only:

```sh
#!/bin/sh
# Installs the hack binary committed at .devcontainer/hack-linux-x86_64.gz.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp)
gunzip -c "$here/hack-linux-x86_64.gz" > "$tmp"
chmod 0755 "$tmp"
sudo mv "$tmp" /usr/local/bin/hack
hack --version
```

The key is not in the file. In Codespaces, add `HACK_ENV_SECRET_KEY` as a
Codespaces secret for the repository (**Settings → Secrets and variables →
Codespaces → New repository secret**); Codespaces gives it to the container's
processes, including `postStartCommand`. Locally, the Dev Container CLI does the
same with `--secrets-file`, a JSON file such as
`{"HACK_ENV_SECRET_KEY": "..."}` kept outside the repository with mode 0600.
`devcontainer up` runs the checkout's `onCreateCommand`, `postStartCommand`,
install script and committed binary with that key, so pass `--secrets-file`
only for a checkout you have reviewed (a contributor's branch can change those
files to send the key out). Codespaces does not give repository secrets to a
codespace created from a pull request branch in a fork (see GitHub's
[security in Codespaces](https://docs.github.com/en/codespaces/reference/security-in-github-codespaces#working-with-other-peoples-contributions-and-repositories)).

## Start it

Locally (verified):

```sh
devcontainer up --workspace-folder . --secrets-file ~/secrets/project.json
```

In Codespaces (not run yet): create a codespace on the branch;
`postStartCommand` should start the project.

## Check it

In the container's terminal (use your project's host):

```sh
curl --noproxy hello.hack --resolve hello.hack:443:127.0.0.1 -k https://hello.hack/
```

In the verified run, `devcontainer up` started the project. The key came from `--secrets-file`, the page printed `token-present`,
and the key did not appear in the CLI's output.

## What is different from a laptop

- **Addresses.** The container has no DNS for Hack's names. Use
  `curl --resolve` inside it, or the `hack open` hint, which prints the same
  form. A Codespaces forwarded port (`https://<name>-<port>.app.github.dev`)
  sends its own host name, and Hack's proxy has no route for it yet, so
  forwarding 443 does not show the app.
- **Secrets.** Codespaces secrets are environment variables in the container.
  Anyone with access to the codespace can read them.
- **Persistence.** The `docker-in-docker` feature keeps Docker's data
  (`/var/lib/docker`: images, volumes, stopped containers) in a Docker volume,
  so it survives a stop and a rebuild. A rebuild replaces the container's own
  filesystem and runs `onCreateCommand` again.

## What does not work yet

- The published Linux prerelease has not been run in a dev container; the
  verified `install-hack.sh` uses a binary you supply.
- Browser preview through forwarded ports (see Addresses).
