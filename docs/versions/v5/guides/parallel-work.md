# Run a branch or worktree beside main

A project can have more than one running copy. Each copy is an **instance**. A
second copy for another branch is a **branch instance**: it has its own
containers, its own addresses and its own logs, and it runs beside the main one.
On the Compose backend, `hack up` in a linked git worktree starts one, named
after its branch on Compose and for Compose-backed projects on native.

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
worktree needs an explicit `--branch <name>` unless you set `worktree.auto_branch=false` to select the base instance. Stop the instance from its owning
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

The desktop preview's **Changes** tab shows the selected checkout and its Git
branch, with a **Not committed** badge when there are tracked or untracked
changes under `.hack/`. Use **Check again** to refresh after editing files.
The desktop uses your Git exclusions and checks checkout ownership before reading status. External Git filters are disabled for this read.
In the Hack desktop preview, select the project and open **Copies** to see
its checkouts, branches, instance names, and reported runtime state. **Check
again** refreshes the report. An incomplete read keeps any copies Hack could
identify and marks the observation incomplete.

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

For Compose-backed projects on native, an attached linked worktree selects its
branch automatically with `worktree.auto_branch` enabled. Use `--branch` to
override selection. An exact writable source root must be available to the
pool when the workload requires it. Projects the pool was started with can
run together. A running pool refuses an unshared root until it is stopped. See [source sharing](../../guides/native-candidate.md#explicit-writable-development-source).
Authored native configuration uses its [explicit branch selector](https://github.com/hack-dance/hack/blob/next/docs/reference/native-authored-commands.md).
