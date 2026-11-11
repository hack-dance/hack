# Getting started

Complete [Install](install.md) first. These steps use the default Docker Compose
backend. For the native backend (beta), read
[Try the native backend](native/try-it.md) after this page.

## Initialize one project

From a repository you own:

```sh
cd your-project
hack init
```

Review the generated `.hack/` files before starting anything. Keep configuration in
git and keep the secret key and local state out of it. For an existing Compose
project, custom domains or agent-assisted setup, follow
[Project setup](guides/init-project.md).

## Start, inspect and stop

```sh
hack up --detach
hack open
hack ps
hack logs --no-follow --tail 50
```

Expected: the declared services start, `open` prints or opens the instance URL,
and `ps` shows service state. Visit the app and run its own health check. A URL or
a running container alone does not prove the app works. If startup fails, read the
error and run `hack doctor` before trying again.

```sh
hack down
```

Stop releases project-owned runtime processes. It does not delete application
data or prune shared caches. [Run and inspect](guides/run-project.md) covers
selected services and log history.

## Next

- [Core concepts](../core.md) explains projects, services and instances.
- [Work on another branch](guides/parallel-work.md) runs a second instance beside the first.
- [Agent handoff](agent-handoff.md) gives a coding agent the same documentation.
