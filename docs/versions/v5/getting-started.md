# Getting started

Complete [Install](install.md) first. These examples use the Compose backend. Use the candidate launcher explicitly, and stop stable Hack processes before sharing its Compose home. Native commands have a separate preparation and support contract.

## Prepare one repository

Use a repository you own. Check its README, toolchain and required services before
starting it. For an existing Compose app, review its Compose files and let
[Project setup](../guides/init-project.md) guide the configuration. For a project
without Compose, initialize Hack and define the services it needs; Hack does not
guess an application deployment from source code alone.

```sh
cd your-project
HACK_RUNTIME_BACKEND=compose "$HOME/.hack-next/bin/hack-next" init
```

Review the generated `.hack/` configuration. Keep keys and local machine state out
of git. Set up shared local routing using the version's Install instructions before
expecting HTTPS URLs to work.

## Start, inspect and stop

```sh
HACK_RUNTIME_BACKEND=compose "$HOME/.hack-next/bin/hack-next" up --detach
HACK_RUNTIME_BACKEND=compose "$HOME/.hack-next/bin/hack-next" open
HACK_RUNTIME_BACKEND=compose "$HOME/.hack-next/bin/hack-next" ps
HACK_RUNTIME_BACKEND=compose "$HOME/.hack-next/bin/hack-next" logs --no-follow --tail 50
```

Expected: the declared services start, `open` finds the instance URL, and `ps`
shows service state. Visit the app and run its normal health check; a URL or a
running container alone does not prove the app works. If startup fails, read its
error and run `HACK_RUNTIME_BACKEND=compose "$HOME/.hack-next/bin/hack-next" doctor` before trying again.

```sh
HACK_RUNTIME_BACKEND=compose "$HOME/.hack-next/bin/hack-next" down
```

Stop releases project-owned runtime processes. It is not an instruction to delete
application data or prune shared caches. See [Run and inspect](guides/run-project.md)
for selected services and log history.

## Native runtime

Native execution needs separate provider, image, source-sharing and routing
preparation plus explicit project adoption. Follow [Native preparation](../guides/native-candidate.md)
and its command support matrix before using that backend. Installing a candidate
does not boot a VM, migrate volumes or prove application compatibility.
