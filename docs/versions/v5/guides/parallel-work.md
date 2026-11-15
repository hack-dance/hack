# Work on another branch

Stale terminal-session cleanup preserves configuration and environment inputs
that current resolution reads. When configuration cannot be verified, automatic
cleanup skips removal rather than guessing which files are unused.

Start from a configured repository. Read
[Worktrees and watchers](../../guides/development-runtime-safety.md) before choosing
shared or isolated files.

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

A separate branch instance does not isolate external databases, shared
bind-mounted files or credentials. Coordinate with people and agents: name the
checkout and branch, assign service and file ownership, and keep one owner for
lifecycle operations against an instance.

On the native backend, branch selection is explicit (`--branch`) and needs the
prepared source share described in [the native reference](../../guides/native-candidate.md#explicit-writable-development-source).
