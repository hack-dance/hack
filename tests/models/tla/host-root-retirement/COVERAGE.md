# Host root retirement

`PreserveReferences` checks that the selected inode is never quarantined or
removed while it is live, recoverable, or of unknown reference status. The
negative control permits planning while an archive is still recoverable and
reaches `Quarantined` with that reference intact.

| Action | Runtime boundary |
| --- | --- |
| Acquire | `retire_pruned` acquires the publication gate and selected root locks before the provider lease. |
| Prune | `retention::prune_with` commits the consumed marker and removes the archive. `verify_pruned` refuses until active and archived receipts are absent. |
| Plan | `write_plan` publishes the selected directory, lock, and entry identities before any host move. |
| Move | `move_exclusive` renames the selected root without replacing a quarantine entry. |
| Remove | `retire` checks the quarantined inode and removes only its selected entries, with retries accepting entries already removed. |
| Crash / Replace | Retry reacquires leases and checks original and quarantined identities. A replacement fails the identity check. |

One original root, four initial reference states, one replacement, and
repeatable lease loss. TLC explores 18 distinct states with no fairness.
The model abstracts filesystem operations and assumes cooperative lock users,
a durable consumed marker, and a correctly derived selection. Linux tests in
`host_root_retirement::tests` cover both sides of plan commit, rename, partial
unlink and directory removal, with held-lock and replacement controls. They do
not qualify the provider lease or actual macOS guest recovery.

[Mermaid state chart](../../../../docs/diagrams/host-root-retirement.mmd)
