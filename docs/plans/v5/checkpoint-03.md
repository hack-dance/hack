# Checkpoint 03: Compose review and enrollment

The candidate can review a bounded Compose project and save the accepted plan in private
candidate state. This checkpoint does not execute services, copy source or load environment values.

## Implemented boundary

`hack-local project plan/enroll/status` exposes a typed service graph, compatibility findings,
source selection, proposed loopback bindings and a redacted enrollment diff. Enrollment requires
the reviewed plan ID, recomputes it under an exclusive lock and publishes a durable receipt.
Repeating the same plan is idempotent. Existing different, foreign or partial receipts are retained
and refused. The WU01 preview cannot authorize enrollment.

The [subset reference](compose-subset.md) lists supported declarations and explicit refusals.
Source identity covers metadata and ignore rules; immutable content identity remains WU06 work.
Known agent state, nested worktrees and credential files are excluded. Arbitrary embedded secrets
are not detectable from metadata. Ownership checks assume cooperative processes under one UID.

## Local verification

On Apple Silicon macOS, Rust/Cargo 1.97.1 built candidate `5.0.0-dev.3` from base commit
`c52e5ac04f63bbbc610f30bd58fa7998c05e51df` plus the uncommitted candidate changes. The exact local
source manifest and executable digest are retained with the private checkpoint evidence.

- Fifty Rust tests passed fresh; the separate manual provider-loss test was ignored locally.
- Rust formatting, Clippy with warnings denied, and the release build passed.
- Regression cases exercise stale plan IDs, incompatible graphs, ownership/locking failures,
  unsafe source paths, ignored trees, hardlinks, unreadable environment files, poisoned host
  configuration, redaction, duplicate YAML keys and bounded alias expansion.
- Repository typecheck, check and test passed using pinned Bun 1.3.9 and cached Turbo results.
  These are local results; hosted CI and native Linux qualification have not run for this change.

WU02's M3 lifecycle evidence belongs to its recorded bundle. Parser/enrollment checks do not
extend that evidence into networked project execution or application-data durability.

## Real-project review

A separate existing application's root Compose file was reviewed and enrolled successfully.
Its two services declare a persistent Redis volume and ports 6379/4040. The plan proposes
127.0.0.1 bindings; no ports or volumes were created. The final source inventory contains
4,537 entries and 164 excluded paths. An initial review exceeded the source-entry budget because
of nested worktrees; fixed agent/worktree exclusions now have regression coverage.

Enrollment, repeated enrollment and status returned the same plan ID and `enrolled-no-runtime`.
Before/after SHA-256 checks matched for the project's Git status, selected Compose file and
installed Hack 4.2.0 executable. Candidate state contains the redacted receipt; the source project
was unchanged. The project's separate generated v4 Compose configuration was neither imported
nor modified. Private JSON reports retain exact plan/source identity and command results.

This proves the selected root Compose file fits the enrollment subset. Images were not pulled,
environment values were not resolved, and services were not started. It is not an application
migration, complete project-Compose compatibility or runtime-performance result.

## Five-minute demo

Build with `./scripts/build-hack-local.sh`. Follow the four project commands in the
[development guide](development.md#wu03-review-and-enroll-a-project), inspecting the human plan
and JSON source exclusions before enrollment. Repeat enrollment with the same ID, then read
status. Changing the Compose file in a disposable fixture makes the old ID fail before state
publication. Do not use a working project's source as the negative mutation fixture.

The next unit is WU04: durable operations, receipts and cancellation. Source synchronization,
real service graphs, published endpoints and performance qualification remain later gates.

## Real-project acceptance correction

The subsequent [real-project attempt](real-project-checkpoints.md) tested Event Agent's actual
14-service Hack configuration. It does not currently plan or run in the candidate. The earlier
root-Compose enrollment and host-fixture results remain component evidence only. Full application
startup, host lifecycle, standard Hack workflows and data-preserving cleanup remain blocked.
Every following checkpoint must repeat and report this real-project gate.
