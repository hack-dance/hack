# Interactive session receipt

`Session.tla` exhausts 459 states for one session, original/replacement boot and
at most two start attempts. `NoReplay`, `WriteAhead` and `RetiredWithProof` hold.
The `negative` control enables `ReplayStart` after a crash and must violate
`NoReplay` with `starts = 2`. `eof-retirement` enables retirement on EOF and must
violate `RetiredWithProof` with no validated-exit, stopped-boot or container-absence proof.
`failed-inspect` retires on a failed inspection and must violate the same invariant.
`wrong-boot` deliberately accepts a replacement boot's stop proof and must fail
the same invariant while the original boot's proof remains false. `StopBoot` is
enabled only for the original boot; `StopReplacement` tracks the other proof
separately. Owner replacement is covered by the Rust exact-binding test, not by
the model, which has no owner variable.

| Model transition | Implementation and regression |
| --- | --- |
| Admit, Record | `interactive_session::admit`, `Intent::record_exec`: pending write, file fsync, rename, directory fsync. Torn pending files do not authorize effects; malformed final records refuse. |
| Withdraw | Only the live `Intent` before create dispatch can withdraw; `known_undispatched_admission_can_withdraw_its_own_intent` preserves another admission. |
| Create, Start | `Engine::interactive_start`: repeated freshness/guest/effect guards; exec ID recorded before exactly one start. Any error after create dispatch retains evidence. |
| Attach, EOF, Crash | Owner consumes its fd after SCM_RIGHTS send; terminal EOF or disconnect alone never withdraws the receipt. Handoff tests preserve early output and close rejected descriptors; process tests cover lost frontend and terminal restoration. |
| StopBoot, RemoveContainer, ReplaceBoot | `finish_absent_locked` publishes exact owner/boot proof before changing phase. `reconcile_observed` requires same boot and owner for container 404. New boot alone is unknown. |
| ExecExitedValidated, InspectFailed | Normal stream closure plus exact Engine exec/container/generation/owner/boot inspection retires silently; explicit reconciliation accepts the same validated exit. Failed inspection retains evidence. `exit_inspection_requires_a_known_status`, `completed_receipt_retirement_is_exact_and_does_not_accumulate` and `explicit_reconciliation_can_clear_a_proven_exit_without_container_removal` cover the boundary. |
| Retire | Snapshot without holding the store lock during observation; reacquire and compare receipt before removal. Tests cover record advancement during proof and durable stopped-boot proof surviving owner replacement. |

Atomic durable publication abstracts the pending/fsync/rename sequence; filesystem
tests exercise retained and final names but do not simulate power failure. Exact
identity, real Engine observations and the VM absence proof are assumptions.
The model excludes multiple sessions, physical descriptor transfer, terminal job
control and scheduler fairness. There is no eventual-cleanup claim. A validated normal exec
exit retires its receipt without making a claim about surviving descendants.
The frontend generates the session correlation UUID before spawn; admission never
overwrites a duplicate and a lost report queries only that UUID. Listing takes no
mutation lock and creates no files. Reconciliation reports remaining IDs after its
bounded pass; there is no eventual-clearing claim.

Descriptor truncation is covered separately by `interactive_handoff` tests. A pure
parser regression preserves Darwin's original ancillary header length while
limiting copied bytes; it rejects the message without reading padding as file
descriptors. The kernel regression receives two or 200 descriptors in an isolated
child and checks that refusal preserves standard streams and sentinel sockets.
Darwin can install rights whose numbers are omitted from a truncated reply; the
short-lived receiver exits to release those rights. The receipt remains uncertain
and no start is replayed. Linux execution does not qualify Darwin's kernel path.


Darwin handshake writes temporarily set O_NONBLOCK on the exclusively owned Engine
socket and restore its exact flags on every send result. The 87 KB blocked-write
deadline and cancellation regressions need hosted macOS Candidate core execution.
The native PTY fixture drains during control/exit waits and verifies restoration
after a separate shell-holder group takes foreground ownership. Linux execution
does not qualify Darwin tty behavior. The guest release build is
`bun run check:native-guest` (Rust 1.97.1, Zig 0.15.2, ARM64 Linux musl), included
in Candidate core and the owner's pre-push gate; it compiles shared path-included
sources and verifies the resulting static ELF. Neither build nor model checks
replace the lead's real-Mac interactive acceptance matrix.
