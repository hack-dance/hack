# September 14, 2026 — Immutable source-backed graphs

The bounded graph driver now runs services from a verified source publication. The live M3
SQLite/web/check fixture passed initial readiness, an owned VM shutdown/restart, and compute
recreation around retained data. This completes a source-delivery slice of WU07, not Event Agent
application acceptance or build/reload support.

## Contract

`graph run|restart|restore` accepts `--source-revision <sha256>` when the reviewed Compose plan
contains read-only project source mounts. Fresh runs require the current acknowledged revision.
The driver loads its publication receipt, checks the source selection against the reviewed plan,
and verifies guest publication ownership, manifest/content, verifier digest and immutable modes
before allocating resources. It resolves mounts to that publication, never to a host bind path.
The graph receipt records revision, archive digest and selection digest before creation.

Restart and restore require the same publication binding and unchanged plan. Normal VM restart
preserves the owned provider identity and published tree; this was exercised live. Foreign
incarnations still refuse. Old graph receipts omit the new optional field and round-trip unchanged.
Missing source does not prevent owned cleanup, and cleanup does not delete source publications.

Selected regular files and directories are supported. Writable mounts, excluded paths, symlink
mount roots, and subdirectory mounts containing symlinks refuse. The full selected tree can retain
its verified internal links. Build execution, writable outputs, managed environment delivery,
arbitrary source changes during restore, and live reload remain unimplemented contracts.

## Live verification

The fixture uses three source files executed by the pinned Bun image, one internal network and
one named SQLite volume. Each service requests 0.5 CPU, 256 MiB RAM, 64 PIDs and 64 MiB shared
memory, with a read-only root. The source tree is mounted read-only at `/app`; init proves writes
fail and the excluded non-secret `.env` fixture is absent. Web serves the source marker and a
database-generated random token. Check validates 200 HTTP responses after each lifecycle stage.

| Control | Observed result |
| --- | --- |
| Missing publication before initial run | `source_not_published`; no graph intent or container |
| Foreign publication namespace | `foreign_source_publication`; no graph intent or container |
| Altered archive digest | Guest verification refused; no graph intent or container |
| Fresh source-backed graph | Init completed, web healthy, 200 checks completed |
| Clean owned VM down/up, then graph restart | Same container identities, source binding and database token; a second check result |
| Ordinary cleanup, publication temporarily absent | Restore refused; committed graph receipt unchanged, no restore history or recreated container |
| Publication restored, explicit graph restore | New container identities, same source binding and database token; 200 checks completed |
| Explicit data cleanup and archive | All graph containers, network and volume absent; evidence archived |

Final state is a stopped candidate VM with no live provider process. Host pressure remained normal,
swapouts unchanged and the watchdog's estimated cache headroom above 2 GiB. Protected captured
application inputs, global Hack configuration and installed binary hashes were unchanged. Source
publications, sync state and evidence remain retained; this is not a disk-reclamation result.

The full Rust suite has **125 passing tests**, with 13 opt-in tests excluded. New regressions cover
source selection, mount filtering and engine configuration, legacy receipt serialization and
changed-binding refusal. Rustfmt, all-target clippy and the release build pass locally. Repository
Bun typecheck/check/test gates also pass using matching Turbo cache entries; they are not fresh
TypeScript test executions. CLI-reference regeneration has no diff, and privacy/link checks pass. These checks
do not establish hosted CI, packaging or release readiness. No performance comparison was run in
this checkpoint; prior benchmark/resource cohorts retain their original scope.

## Evidence and follow-ups

The final controlled run is `.hack-local/review/wu05/source-graph-1789419695661468000/`, containing
the frozen protocol, calls, readiness/identity receipts, check output, watchdog, protected hashes
and final stopped-state evidence. Binary SHA-256:
`04d277a4f3b022fee1355229d36a76abafe706c904da75c789122fc0ebbbbd1e`.
Protocol SHA-256: `6d3cb53dd2e80427cacc0b98e1732a7c12b99f8e18ffa6acb87e75b3b88184f1`.

The earlier `source-graph-1789419590780706000` attempt reached restart but its harness tried to
decode two retained check-log records as one JSON value. Its failure and successful cleanup are
retained. The corrected harness requires exactly two matching records after restart, and one after
fresh creation. `source-graph-1789419622742589000` passed the lifecycle sequence; the final run added
the missing-publication restore control. No failed attempt is counted as a completed sequence.

Next application work is a bounded build/output contract, managed environment delivery and source
update/reload behavior. The real 14-service Event Agent plan still requires compatibility work;
the eight-service driver limit, unresolved mounts and external routing/ownership declarations are
not waived by this source-backed fixture. See the [work-unit ledger](work-units.md) and
[real-project checkpoints](real-project-checkpoints.md).
