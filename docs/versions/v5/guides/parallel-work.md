# Run a branch or worktree beside main

A project can have more than one running copy. Each copy is an **instance**. A
second copy for another branch is a **branch instance**: it has its own
containers, its own addresses and its own logs, and it runs beside the main one.
On the Compose backend, `hack up` in a linked git worktree starts one, named
after its branch. On native, pass `--branch`.

Start from a configured repository. Read
[Worktrees and watchers](../../guides/development-runtime-safety.md) before choosing
shared or per-worktree files.

```sh
git worktree add ../project-review -b review-work
cd ../project-review
hack up --detach
hack open
hack ps
```

A linked worktree selects a branch instance automatically, named after the branch,
with its own hostnames such as `api.review-work.<project>.hack.local`. A detached
worktree needs an explicit `--branch <name>`. Stop the instance from its owning
checkout when finished.

The desktop app and other `/v1/projects` clients read each branch instance's
original name, owning checkout, hosts and `hack open` URL from the payload
(described under "Branch instance identity" in the repository's
`docs/reference/project-state.md`).

A branch instance never shares a host with the base instance. Every host in a
service's Caddy labels under the project's names (`<project>.hack`,
`<project>.hack.local` and the OAuth alias form such as `<project>.hack.gy`) gets
the branch inserted, whichever of these forms `dev_host` uses. Any other host is
dropped from the branch instance and stays with the base instance; `hack up` on
Docker Compose warns about each one. A label with no host under the project's
names refuses the branch start and names the label. After a Docker Compose
`hack up`, Hack also warns when another running instance lists one of this
instance's hosts; the native backend refuses such a collision instead.

## What a branch instance still shares

A separate branch instance does not isolate external databases, shared
bind-mounted files or credentials. Coordinate with people and agents: name the
checkout and branch, assign service and file ownership, and keep one owner for
lifecycle operations against an instance.

## Cleanup of old terminal sessions

Stale terminal-session cleanup preserves configuration and environment inputs
that current resolution reads. When configuration cannot be verified, automatic
cleanup skips removal rather than guessing which files are unused.

## Native backend

On the native backend, branch selection is explicit (`--branch`) and needs the
prepared source share described in [the native reference](../../guides/native-candidate.md#explicit-writable-development-source).
