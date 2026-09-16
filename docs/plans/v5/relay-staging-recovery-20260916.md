# Recover interrupted relay executable staging

Guest relay startup now records `preparing` under the per-slot lock before creating its allocation.
It records `launching` only after executable verification and immediately before forking. A stop
that acquires the lock while the committed phase is still `preparing` therefore has evidence that
no relay fork was authorized. It records `discarding`, validates the staging allocation, then records
`discarded` before reporting stop completion. The existing host `stopped` receipt still precedes
allocation removal and slot release.

Staging cleanup requires the exact private owner marker and no published socket. Only the owner
file and optional `relay`/`relay.pending` files are allowed. Executable files must be private,
singly linked regular files, at most 256 KiB, with the expected construction permissions. Extra
files, including hidden files and process/socket receipts, cause refusal before deletion. A missing
allocation is safe in this pre-fork phase; an existing directory without its owner marker remains
ambiguous. Only reconstructible executable bytes are removed, never application data.

A retry can resume `discarding` or `discarded`. The monotonic slot fence continues to reject old
start/stop/remove requests after reuse. Legacy serial-zero allocations retain their earlier
conservative behavior. A launch already in `launching` still requires the existing verified
process/executable/socket cleanup path; missing process identity is not treated as a staged cache.

## Live qualification

Evidence: `.hack-local/review/wu07/relay-staging-1789578954611296000/`.
Candidate SHA-256: `6b32c5285efd7cfd3af608a48c9ff3ca08e726dec3b6d7eb6bb62a2b2a4534bf`.

The fixture killed its own startup CLI after committed host intent, then sent a truncated compressed
payload through the actual guest staging script. Decompression failed after writing known partial
executable bytes. The guest fence remained `preparing`; no process receipt, complete executable or
socket existed. This is a truncated-transfer control, not a claim that a guest shell was killed
at every possible instruction boundary.

An injected unexpected file made release refuse while preserving both that file and the partial
executable byte-for-byte. After removing only the verified test file, release completed in the same
VM boot, removed the allocation and freed the slot. A delayed old start was refused. A fresh relay
then served HTTP through the same slot and released normally. The application remained running.
No allocation directories remained; the slot fence still had two files and occupied 4 KiB of guest
tmpfs according to `du`.

The broader cancellation, active cleanup, interrupted-stop, ownership-marker and generation controls
also passed. All 17 admission watchdog samples passed. Final graph cleanup, archive/export
reconciliation, VM shutdown and reboot/down passed; protected global Hack configuration was
unchanged. The run's retained fault-injection journal was subsequently exported through the supported
offline CLI, leaving no occupied source recovery slots and reusing the existing verified export.

A small ordering model checked nine distinct states without a safety violation. Allowing staged
retirement after launch authorization produced the expected live-process counterexample. An abstract
four-state mapping of the truncated transfer and retirement also passed with a next-transition check.
These models assume the guest lock and recorded phase rules; they do not prove filesystem behavior.
Models and logs are retained in `.hack-local/relay-staging-model/` and used an explicit Java toolchain,
two workers and a 512 MiB heap without changing global selection.

Default/all-feature Rust suites, strict Clippy, default release build, repository typecheck/check/test
(940 CLI passes, five skips), shell syntax and documentation/privacy checks passed. No comparative
application performance benchmark was added by this unit.

## Remaining boundaries

Partial fence publication still refuses further effects. Missing owner identity, interruption after
owner removal but before final directory removal, and ambiguous process/socket publication after
fork still need dedicated recovery controls. An owned VM restart remains the conservative fallback
for those cases; the command does not restart it automatically. Loopback/TLS routing and actual
application parity remain open.
