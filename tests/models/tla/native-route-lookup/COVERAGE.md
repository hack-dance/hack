# Native HTTPS route lookup

`LiveRouteAllowed` checks that a fixed live route for A is never denied while a
separate project B claims, stages, or retires its publication.
`AllowMatchesOpenedClaim` checks that an allowed lookup selected the same
live claim in both committed snapshots. The finite model explores one stable
owner, one A route that can be replaced or retired once, one B reservation and
two descriptor opens for one A lookup. B can cycle through all three changes
while the lookup is in progress. TLC exhausts 498 distinct states.

| Model action | Runtime boundary |
| --- | --- |
| `StageSibling` | Under the provider lease, `stage_launch`, `release_entries`, and `retire_run` preserve other reservations while writing and syncing `state.pending`. This file is private to writers and recovery. |
| `CommitSibling` | `state::write_before_rename` atomically names the new `state.json`. An open descriptor still reads the previous complete file. |
| `ChangeSelected` | Retirement or replacement of the inspected run's claim makes it absent or unequal in a subsequent snapshot. This models the visible commit only. |
| `OpenCommitted` | `publication::observe_hostname_claim` reads the committed registry before and after verifying the selected publisher. The hostname path uses `state::read_committed` for the registry and for the owner receipt. |
| `ReadFirst` and `ReadSecond` | The lookup checks the selected entry, verifies the publisher and endpoint, then compares the owner token and exact reservation across snapshots. It verifies the process once more before returning the route. |

The legacy pending-journal and detached-descriptor controls both violate
`LiveRouteAllowed`. Skipping the comparison fails `AllowMatchesOpenedClaim`
after the selected route changes. The reachability control witnesses B retiring
after the second lookup opens B's staged snapshot. The Rust regressions use real
pending journals and renames, including 6,144 lookups during 128 sibling cycles.
They also check refusal after the selected claim changes. The fixture supplies
publisher liveness and a stable owner token. A separate descriptor regression
exercises the old link-count refusal and the new read after replacement.

The model assumes serialized cooperative writers, an immutable open inode,
and a valid owner and live publisher for the original claim. An interrupted
update can leave B's journal in place while reads continue. Recovery eligibility, directory-sync
durability, changing owner identity, OS process checks, and real Caddy/TLS/VM
traffic need separate evidence. The model does not assert that a lookup
eventually completes.

`lookup_port` and `observed_run_ports` still use the settled registry. An
unrelated write can affect their readiness observation. Already-bound
loopback forwarding does not look up the hostname registry for each connection.

[State chart](../../../../docs/diagrams/native-route-lookup.svg) ·
[Source](../../../../docs/diagrams/native-route-lookup.mmd)
