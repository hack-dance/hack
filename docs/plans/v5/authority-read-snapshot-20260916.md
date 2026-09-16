# Hostname lookup during unrelated provider operations

Hostname lookup no longer acquires the global provider operation lock. Writers
continue using that lock. A lookup reads and validates committed publication state,
verifies the selected live publisher, reads the owner and publication registry again,
and requires the complete selected ownership record to match. It then observes the
native process identity once more. A changed owner/claim returns a retryable
`publication_changed` error (HTTP 503 in the authority).

Changes to unrelated records do not invalidate an unchanged selected publication.
Pending journals, malformed state and missing or mismatched resource identity still
refuse. This removes the long lock-held interval from the read path without adopting
uncommitted state or caching a previously successful observation.

The result remains point-in-time. It is not a linearizable promise that the process
will stay alive after the response. A later connection targets the original
reservation-specific Unix endpoint; retirement cannot silently retarget that path
to a different reservation. Request failure during retirement is permitted. Routing
to a replacement application's endpoint under an old observation is not.

## Verification

The regression checks unchanged claims with unrelated map changes and refuses a
changed provider owner, process start identity, hostname list, directory identity
or missing reservation. Live writer-lock and bridge-operation controls are recorded
below.

A small TLA+ control explored the stale-observation/retire/replace/connect ordering.
All 11 states preserve no-wrong-reservation when frontends are reservation-specific.
A deliberately unsafe reusable-frontend variant produces a five-step counterexample:
observe A, retire A, start B, connect through the reused path, receive B. This models
the endpoint identity requirement, not all implementation races or filesystem
semantics. The snapshot checks still require ordinary regression and live evidence.
Private model, configurations and results: `.hack-local/authority-snapshot-model/`.

## Remaining boundaries

A publication journal in progress still causes refusal, including during a brief
unrelated publication write. This unit addresses global lock contention during
unrelated graph operations, not every branch-churn availability case. No automatic
retry, stale-answer cache or journal bypass is introduced. Authority crash recovery,
managed proxy lifecycle, certificate admission/retirement, route-label translation
and real-app parity remain open.

## Completed live qualification

Both direct CLI lookup and persistent authority lookup succeeded while the harness
held the real provider operation lock. A continuous observer made 37 requests while
the second service's bridge was reserved and started; all returned HTTP 200 with
the original publication's reservation. An exclusive test-owned partial publication
journal still refused lookup, preserved the live publisher and retained its bytes;
removing only that fixture restored lookup.

After name reassignment, new lookups and scoped TLS reached the new reservation.
Connecting to the previously captured endpoint failed instead of reaching the new
service. Dead/replaced/partial identity controls and the full VM restart/data
preservation lifecycle passed. Caddy and authority exited, their private home/CA
was removed, and graph cleanup/archive/export/down completed. Final publication
state was empty without a pending journal. All 14 watchdog samples and protected
Hack hashes passed.

Evidence: `.hack-local/review/wu07/authority-snapshot-1789591328416919000/`.
Candidate SHA-256: `e84b5e9793e4708590e012a8ad052b8b632c62f30fd472147796885226a6946f`.
One hundred sequential authority lookups measured 0.364 ms median and 0.396 ms p95;
25 CLI wrapper calls measured 10.56 ms median and 10.84 ms p95. Authority RSS was
7,792 KiB. Displayed cumulative CPU increased from 0.01 to 0.04 seconds during the
100 calls and stayed unchanged over three idle seconds. These short, differently
sized samples establish a lookup baseline, not an overall performance winner or
proof of zero idle CPU. The extra ownership reread is included in this measurement.

Default/all-feature Rust suites, strict Clippy, default native-HTTP release and Bun
typecheck/check/tests passed (940 pass, 5 skip). The next lifecycle unit is durable
authority ownership and abrupt-death recovery; certificate management and complete
branch-churn availability remain separate gates.
