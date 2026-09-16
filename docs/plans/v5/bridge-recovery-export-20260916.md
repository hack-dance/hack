# Offline bridge recovery export

The candidate can now free one of the eight bridge-journal retention slots only after preserving
and verifying its exact evidence. These pool-level commands work with the VM stopped:

```text
hack-local runtime bridge-recovery --json
hack-local runtime export-bridge-recovery --slot <1..8> --expect-sha256 <digest> --json
```

Inspection returns slot numbers, expected export digests and byte counts, without journal contents.
Export requires that digest. Both commands verify the checkout's provider owner and acquire the
existing provider operation lock; neither connects to the guest or starts the VM. They operate
only on the selected retained recovery directory, not the active assignment registry or its
pending journal. Active recovery still uses `graph reconcile-bridges` after capacity is available.

The private JSON export contains the exact journal and retention-metadata bytes, plus provider
ownership. Its filename is the SHA-256 of those serialized bytes. Source metadata must match the
journal's byte count and digest. Symlinks, hardlinks, public files, extra entries, invalid metadata
and changed bytes are refused. Exported contents are evidence only, never runtime replay authority.

An export is published and synchronized before source files can be removed. Each remaining file
must exactly match the verified export immediately before removal; only the two expected files
and then the empty selected directory are removed. An interrupted removal can resume against the
complete export. Inspection marks incomplete source records as partial and requires the original
expected digest to continue. Repeating a completed export is safe; identical records reuse the
same immutable export instead of accumulating duplicates.

A complete matching pending export can finish publication. An incomplete pending export is first
preserved byte-for-byte through bounded recovery retention, then rebuilt from verified source
bytes. An invalid or changed published export is never replaced. Failure to preserve evidence
blocks removal.

## Bounds and remaining work

Each export is at most 512 KiB. The export area admits at most 128 entries before new publication
is blocked; existing verified exports can still retire duplicates at that limit. Interrupted
export evidence uses at most eight recovery directories and counts toward that entry budget.
This is a bounded evidence store, not permission to silently delete old records. Longer-term
external archival and reviewed retirement of retained exports remain WU12 work.

No persistent application volumes, runtime processes, bridge sockets or application configuration
are changed by export. This closes the supported export path that the isolated fault-injection
fixtures previously had to perform manually. It does not resolve later guest-startup crash windows
or establish application parity/performance against Compose.

## Qualification

The stopped qualification pool contained two retained fault-injection journals. A wrong expected
digest was refused and both records stayed unchanged. Export retired both records into one
826-byte immutable artifact; repeated calls succeeded without recreating source slots or adding
archives. Provider ownership, active bridge registry and protected global Hack configuration
remained unchanged. VM status stayed stopped with the same boot identity throughout.
Evidence: `.hack-local/review/wu12/bridge-export-1789578417067629000/`.

The final candidate separately exercised an interrupted-retirement fixture made from that known
export: inspection reported a partial record without inventing a new digest, export resumed with
the original digest, and the source disappeared while the single archive stayed byte-identical.
Evidence: `.hack-local/review/wu12/bridge-export-partial-1789578602671552000/`.
Final optional candidate SHA-256: `b1b2c39961de3e68064ec0468323d20431c21517266faca89c450edc13ed1fa2`.

Default/all-feature Rust suites, strict Clippy, release build and repository typecheck/check/test
passed (940 CLI passes, five skips). After partial-record diagnostics and resumed-export sync
were tightened, focused all-feature export tests, Clippy and release build passed again, followed
by the final offline control above. Tests cover mismatched/unsafe evidence, deduplication, partial
retirement, incomplete/complete pending export recovery, and full-capacity preservation. CLI
reference generation and changed-document links/whitespace/privacy checks passed. No VM or
application performance comparison was performed.
