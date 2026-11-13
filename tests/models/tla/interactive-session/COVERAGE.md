# Interactive session receipt

`Session.tla` exhausts 180 states for one session, original/replacement boot and
at most two start attempts. `NoReplay`, `WriteAhead` and `RetiredWithProof` hold.
The `negative` control enables `ReplayStart` after a crash and must violate
`NoReplay` with `starts = 2`. `eof-retirement` enables retirement on EOF and must
violate `RetiredWithProof` with neither stopped-boot nor container-absence proof.
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
| Attach, EOF, Crash | Owner consumes its fd after SCM_RIGHTS send; terminal EOF or disconnect never withdraws the receipt. Handoff tests preserve early output and close rejected descriptors; process tests cover lost frontend and terminal restoration. |
| StopBoot, RemoveContainer, ReplaceBoot | `finish_absent_locked` publishes exact owner/boot proof before changing phase. `reconcile_observed` requires same boot and owner for container 404. New boot alone is unknown. |
| Retire | Snapshot without holding the store lock during observation; reacquire and compare receipt before removal. Tests cover record advancement during proof and durable stopped-boot proof surviving owner replacement. |

Atomic durable publication abstracts the pending/fsync/rename sequence; filesystem
tests exercise retained and final names but do not simulate power failure. Exact
identity, real Engine observations and the VM absence proof are assumptions.
The model excludes multiple sessions, physical descriptor transfer, terminal job
control and scheduler fairness. There is no eventual-cleanup claim. A normal exec
exit can leave descendants and therefore retains its receipt until exact cleanup.
