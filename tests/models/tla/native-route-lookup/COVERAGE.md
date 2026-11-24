# Native HTTPS route lookup

`LiveRouteAllowed` checks that a fixed live route for A is never denied while a
separate project B claims, stages, or retires its publication. The finite model
explores one stable owner, one A route, one B reservation and two descriptor
opens for one A lookup. B can cycle through all three changes while the lookup
is in progress. TLC exhausts 102 distinct states.

| Model action | Runtime boundary |
| --- | --- |
| `StageSibling` | Under the provider lease, `stage_launch`, `release_entries`, and `retire_run` preserve other reservations while writing and syncing `state.pending`. This file is private to writers and recovery. |
| `CommitSibling` | `state::write_before_rename` atomically names the new `state.json`. An open descriptor still reads the previous complete file. |
| `OpenCommitted` | `publication::observe_hostname_claim` reads the committed registry before and after verifying the selected publisher. The hostname path uses `state::read_committed` for the registry and for the owner receipt. |
| `ReadFirst` and `ReadSecond` | The lookup checks the selected entry, verifies the publisher and endpoint, then compares the owner token and exact reservation across snapshots. It verifies the process once more before returning the route. |

The legacy pending-journal and detached-descriptor controls both violate
`LiveRouteAllowed`. The reachability control witnesses B retiring after the
second lookup opens B's staged snapshot. The Rust regressions use real pending
journals and renames, including 6,144 lookups during 128 sibling cycles. They
also check refusal after the selected claim changes. The fixture supplies
publisher liveness and a stable owner token. A separate descriptor regression
exercises the old link-count refusal and the new read after replacement.

The model assumes serialized cooperative writers, an immutable open inode,
and a valid owner and live publisher for A. An interrupted update can leave B's
journal in place while reads continue. Recovery eligibility, directory-sync
durability, changing owner identity, OS process checks, and real Caddy/TLS/VM
traffic need separate evidence. The model does not assert that a lookup
eventually completes.

[State chart](../../../../docs/diagrams/native-route-lookup.svg) ·
[Source](../../../../docs/diagrams/native-route-lookup.mmd)
