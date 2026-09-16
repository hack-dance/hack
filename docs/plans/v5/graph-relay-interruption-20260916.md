# Relay interruption controls and remaining cancellation gap

The subsequent [same-boot cancellation implementation](relay-cancellation-20260916.md) closes
the pre-launch case below for new intents. This report preserves the original finding.

Real CLI termination now qualifies two committed intent boundaries in the isolated ARM64 pool.
The fixture starts a child CLI, watches its exact reservation in the committed registry, and kills
only that child after observing the requested phase. Both child exit statuses were `-9`.
No committed receipt was edited to simulate a crash.

At `stopping`, a subsequent release completed successfully and preserved the running application.
A fresh reservation and relay then served HTTP through the same slot. The usual generation,
ownership-marker, pending-journal and active-cleanup controls also passed.

At `starting`, repeated start refused rather than replaying the operation. Release refused and
retained intent. A guest-side inventory subsequently found neither the allocation directory nor
the relay socket. After owned VM down/up, the changed boot identity allowed retirement of the old
reservation and complete graph cleanup. Final slot inspection was empty. This proves safe refusal
and new-boot recovery; it does not prove same-boot cancellation of an unlaunched request.

Evidence: `.hack-local/review/wu07/graph-relay-crash-1789576799202580000/`.
Candidate SHA-256: `b6c825b983f8118b8d47b490d08bad244155af98883a196921d98231e8ed7b64`.
The saved protocol, `interrupted-start.json`, `interrupted-stop.json`,
`interrupted-start-guest.json` and release/cleanup receipts identify the actual boundaries.
All 20 admission-watchdog samples passed; protected global configuration stayed unchanged. Graph
cleanup, archive/export reconciliation, final listener shutdown and an additional VM reboot/down
passed. The experiment finished stopped. No new performance comparison was performed.

An earlier fixture attempt tried to restore after explicit data removal and correctly hit
`graph_restore_refused`; owned cleanup and VM shutdown completed. The corrected control archives
the completed graph and uses a fresh graph for the startup crash. A subsequent diagnostic repeat
confirmed the absent guest allocation without changing the candidate.

## Next implementation: cancel an unlaunched request without restarting the pool

The missing allocation cannot by itself authorize freeing the slot: a delayed old guest request
might still arrive. A cancellation mechanism must exclude that future effect before cleanup can
claim success. Add bounded per-slot guest state with durable monotonic launch identity and guest
operation serialization. A cancelled or superseded launch must be refused even if it arrives after
host cleanup, a new reservation or a later start. Do not simply treat a missing PID/file as absence
of pending work, or retain an unbounded tombstone per attempt.

Acceptance requires same-boot release of the demonstrated pre-allocation interruption, with the
application and other branch instances preserved. Controls must cover delayed old launch after
cancellation, a newer allocation reusing the slot, interruption during binary staging and process
identity publication, stop/removal retry, replaced owner/process/socket evidence and VM restart.
Keep process signaling tied to the verified executable and pidfd. Ambiguous or foreign evidence
must retain the allocation rather than cause deletion. Track retained files/bytes over repeated
cycles to prove that the cancellation mechanism itself does not accumulate indefinitely.

Until that mechanism is implemented and qualified, an uncertain early startup may still require
an explicit owned VM restart. Later guest-side crash windows and unhealthy-but-running target
policy also remain open before normal route publication.
