# GitHub Codespaces and dev containers

> **Dev container: verified on 2026-11-19** with the Dev Container CLI 0.90.0
> on Linux x86_64 and `hack` built from `next` at `95ea63e497`.
> `devcontainer up` with the files below started the project with no other
> command. The install step copied in that built binary, since v5 has no Linux
> release yet.
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
  "onCreateCommand": "bash .devcontainer/install-hack.sh",
  "postStartCommand": "hack global install --no-interactive && hack up --detach --no-interactive --json"
}
```

The `docker-in-docker` feature gives the container its own Docker Engine and
Compose. `postStartCommand` runs on every start, so the project comes back
after a stop. `.devcontainer/install-hack.sh` installs `hack` into the image;
until a Linux release exists it has to place a `hack` binary you built (see
[Any Linux machine with Docker](cloud-linux-docker.md#steps)).

The key is not in the file. In Codespaces, add `HACK_ENV_SECRET_KEY` as a
Codespaces secret for the repository (**Settings → Secrets and variables →
Codespaces → New repository secret**); Codespaces gives it to the container's
processes, including `postStartCommand`. Locally, the Dev Container CLI does the
same with `--secrets-file`, a JSON file such as
`{"HACK_ENV_SECRET_KEY": "..."}` kept outside the repository with mode 0600.

## The one command

Locally:

```sh
devcontainer up --workspace-folder . --secrets-file ~/secrets/project.json
```

In Codespaces: create a codespace on the branch. `postStartCommand` starts the
project.

## Check it

In the container's terminal (use your project's host):

```sh
curl --resolve hello.hack:443:127.0.0.1 -k https://hello.hack/
```

On 2026-11-18 a cold `devcontainer up` (with image pulls) took 82 seconds, and
after the container was stopped, `devcontainer up` brought the project back in
5 seconds. On 2026-11-19, with the base images already pulled, it took 24
seconds. In both runs the key came from `--secrets-file`, the page printed
`token-present`, and the key did not appear in the CLI's output.

## What is different from a laptop

- **Addresses.** The container has no DNS for Hack's names. Use
  `curl --resolve` inside it, or the `hack open` hint, which prints the same
  form. A Codespaces forwarded port (`https://<name>-<port>.app.github.dev`)
  sends its own host name, and Hack's proxy has no route for it yet, so
  forwarding 443 does not show the app.
- **Secrets.** Codespaces secrets are environment variables in the container.
  Anyone with access to the codespace can read them.
- **Persistence.** Images and volumes live in the container's Docker data and
  survive a stop. A rebuild starts over and runs `onCreateCommand` again.

## What does not work yet

- No published Linux install, so `install-hack.sh` needs a binary you supply.
- Browser preview through forwarded ports (see Addresses).
