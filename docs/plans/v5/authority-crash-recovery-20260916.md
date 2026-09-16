# Explicit hostname authority crash recovery

The foreground hostname authority now fsyncs a private, bounded identity receipt
before reporting readiness. The receipt binds checkout, process identity, parent
directory and socket inode. Orderly owner-pipe EOF removes only its original socket
and receipt. A replaced socket is preserved together with the receipt.

`runtime hostname-authority --socket PATH --json` reports the receipt fingerprint
and process presence. Presence is not a claim that the recorded process identity
is still serving. `runtime recover-hostname-authority --socket PATH
--expect-sha256 HASH --json` requires that exact receipt and an absent recorded PID.
It never signals a process, removes a replacement socket, or touches publications,
guest volumes or certificates. PID reuse conservatively refuses recovery.

Recovery serializes on the receipt and rechecks its bytes and inode before cleanup.
Both paths already absent is an idempotent no-op, not historical cleanup proof.
Receipts are private regular files with one link and at most 4096 bytes. Unknown,
partial, aliased, malformed or mismatched ownership remains a refusal. Startup
refuses occupied receipts. A crash before the durable receipt exists remains an
explicit gap; this is not a complete pre-bind write-ahead ownership protocol.

The actual-child contract covers live-owner refusal, abrupt death, wrong hash,
foreign socket preservation, malformed receipt preservation, exact dead-owner
recovery, idempotent absence, and old-hash refusal against a fresh authority at the
same path. Owner EOF and bounded transport regressions remain covered.

Managed singleton/supervisor integration, early-startup crash recovery, certificate
permission/retention and actual-app parity remain open. This command does not
activate global routing or trust, and makes no overall performance comparison.

## Live qualification

Evidence: `.hack-local/review/wu07/authority-recovery-1789592086758266000/`,
isolated ARM64 VM candidate SHA-256
`1d5bb123d6c04d51394006aefa53c4fff6854d954943758ee210631456190ef5`.
The recorded `protocol.py` is the exact isolated experiment. Required local gates
passed: default/all-feature Rust tests and strict Clippy, default release build,
Bun typecheck/check/test (940 pass, 5 skip), and CLI reference generation.

With an actual managed application publication and scoped TLS proxy running:

- Live-owner recovery refused; killing/reaping the authority denied TLS requests.
- Wrong fingerprint refused, exact recovery removed both original files, and a
  repeated recovery was an absence no-op.
- Restarting the authority at the same path restored verified TLS through the
  unchanged proxy. The original publisher and persistent application token survived.
- The old fingerprint refused against the new live authority.
- Existing publication conflict, identity fault, rebind, VM restart/data preservation
  and graph cleanup controls passed. Final owner EOF removed socket and receipt;
  the proxy, private CA/home and fixture were cleaned up, graph evidence was
  archived/exported/reconciled, and the VM reported stopped. Global protected
  executable/configuration hashes were unchanged.

All 14 watchdog samples had normal pressure, unchanged swapouts and the required
headroom. For 100 sequential fresh Unix HTTP lookups, median was 0.355 ms and p95
0.399 ms; authority RSS ended at 8016 KiB and displayed CPU remained 0.04 seconds
through a three-second idle interval. The same run's 25 CLI lookup invocations had
9.459 ms median and 9.960 ms p95. These are bounded lookup measurements, not an
end-to-end application benchmark or a Compose/OrbStack comparison.
