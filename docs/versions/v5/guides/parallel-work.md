# Work on another branch

Start from a configured repository. Read [worktree behavior](../../guides/development-runtime-safety.md)
for this version before choosing shared or isolated files.

```sh
git worktree add ../project-review -b review-work
cd ../project-review
HACK_RUNTIME_BACKEND=compose "$HOME/.hack-next/bin/hack-next" up --detach
HACK_RUNTIME_BACKEND=compose "$HOME/.hack-next/bin/hack-next" open
HACK_RUNTIME_BACKEND=compose "$HOME/.hack-next/bin/hack-next" ps
```

Linked worktrees normally select a branch instance automatically. Confirm the
selected instance and URL in the output; detached worktrees need an explicit
`--branch` choice. Stop the instance from its owning checkout when finished.
A separate branch environment does not automatically isolate external databases,
shared bind-mounted files or credentials.

Coordinate with people and agents: name the checkout/branch, assign service and
file ownership, and keep one owner for lifecycle operations against an instance.
