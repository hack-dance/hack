# Getting started

Complete [Install](install.md) first. These examples use the Compose runtime in v4.2.4. Verify `hack version` before using the archived command reference.

## Prepare one repository

Use a repository you own. Check its README, toolchain and required services before
starting it. For an existing Compose app, review its Compose files and let
[Project setup](../guides/init-project.md) guide the configuration. For a project
without Compose, initialize Hack and define the services it needs; Hack does not
guess an application deployment from source code alone.

```sh
cd your-project
hack init
```

Review the generated `.hack/` configuration. Keep keys and local machine state out
of git. Set up shared local routing using the version's Install instructions before
expecting HTTPS URLs to work.

## Start, inspect and stop

```sh
hack up --detach
hack open
hack ps
hack logs --no-follow --tail 50
```

Expected: the declared services start, `open` finds the instance URL, and `ps`
shows service state. Visit the app and run its normal health check; a URL or a
running container alone does not prove the app works. If startup fails, read its
error and run `hack doctor` before trying again.

```sh
hack down
```

Stop releases project-owned runtime processes. It is not an instruction to delete
application data or prune shared caches. See [Run and inspect](guides/run-project.md)
for selected services and log history.

