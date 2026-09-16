# Provider child permissions independent of caller umask

A maintenance boot after the relay identity controls failed `bridge_socket_identity`.
Read-only inspection found the bridge, agent, Docker and control sockets owned by the expected
user but created with mode `0755`. The qualification harness had used caller umask `077`;
the maintenance invocation used ordinary `022`. Provider commands inherited that mask.
The identity audit correctly refused the less-private sockets and stopped the failed boot.
This was a caller-dependent creation-permission defect, not evidence of a socket readiness race.

`process::clean_command` now sets umask `077` in the child immediately before exec. The callback
only invokes the umask syscall; it does not change the multithreaded parent or repair permissions
on existing paths. Existing socket identity refusals remain intact. The child rule applies to
credential-blind provider commands and their descendants, including detached VM helpers.

The focused regression starts an isolated test process, sets its parent mask to `000`, invokes a
clean child, and checks the child's mask is `077` while the parent remains `000`. The global mask
is never changed in the shared test suite. Both focused tests passed.

## Live evidence

Evidence: `.hack-local/review/wu07/provider-umask-1789580051416593000/`.
Optional-feature candidate SHA-256:
`51d889d55cc7c143b8ca25366048c967d02feb65eefe64f7c2e409111544a8a8`.

Every candidate invocation passed through a wrapper setting caller umask `022`. The supported
`runtime recover` accepted the confirmed dead failed boot. Startup, retained provider audit and
reuse succeeded. Independent host metadata readback showed both bridge sockets plus agent,
Docker and control sockets all at `0700`. No socket was manually chmodded or removed.

The previously cleaned fixture from `relay-identity-1789579702123358000` was archived, exported
and reconciled during this boot, closing that retained-receipt follow-up. The full managed relay,
pre-fork staging, cancellation, missing/empty socket receipt and abrupt relay-death controls passed.
Missing process identity and a dead relay without socket identity continued to refuse cleanup until
the harness restored only its exact captured fixture receipts. Those remain unsupported recovery
cases; this permissions fix does not broaden deletion authority.

All 20 resource-watchdog samples passed. Final graph cleanup/archive/export, shutdown, reboot audit
and shutdown passed. Protected global configuration was unchanged. The new test journal was
exported through the offline recovery API, leaving no occupied recovery source slots. This is
functional qualification, not a new application performance comparison.

## Verification

Focused child-mask regression, default/all-feature Rust tests, strict Clippy, default release,
repository typecheck/check/test (940 passes, five skips), changed-document link resolution and
privacy checks passed. Verification logs are retained with the live evidence. No comparative
performance claim is made for the new child setup callback.

## Remaining work

Complete missing process/socket identity and fence-publication recovery controls before normal
loopback publication. Application routing/TLS, scoped QA delivery, full workflow parity, matched
resource benchmarks and safe branch idling remain open. No production or global runtime migration
was performed.
