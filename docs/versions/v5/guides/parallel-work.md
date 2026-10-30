# Work on another branch

A git worktree separates source edits. The published native command slice does not
automatically infer its namespace from that branch. Prepare the supported source
share and configuration before selecting an explicit namespace:

```sh
git worktree add ../project-review -b review-work
cd ../project-review
"$HOME/.hack-next/bin/hack-next" --branch review-work up
```

Keep that foreground owner open. Inspect and stop the same namespace from another
terminal:

```sh
"$HOME/.hack-next/bin/hack-next" --branch review-work ps
"$HOME/.hack-next/bin/hack-next" --branch review-work down
```

Preparation and project selection must refer to the new checkout. This is not
automatic source-share enrollment. External databases, shared files and credentials
may remain shared. Coordinate a single lifecycle owner with people and agents.
Choose v4 for automatic Compose worktree instances; see the
[native command matrix](../../reference/native-authored-commands.md) for this version.
