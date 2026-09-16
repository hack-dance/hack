# Durable publication hostname claims

Managed Unix publication can claim explicit names without changing global DNS,
trust or Caddy configuration:

```sh
./hack-local graph publish-bridge --run-id RUN --slot SLOT --expect-reservation TOKEN --unix --hostname api.feature-x.demo.hack --hostname custom.example.test
./hack-local runtime publication-hostnames --json
```

Claims are part of the existing durable publication intent, written before helper
staging or exec under the provider operation lock. A name is exclusively associated
with the publication's run and reservation. The reservation already identifies the
verified service/generation through managed bridge assignment; no arbitrary target
path is accepted. A new publication cannot take a name held by another record,
even if that publisher died. Verified cleanup must retire the old record first.

Names are ASCII DNS names, lowercased with one optional terminal dot removed. Labels
must be 1–63 characters, use letters/digits/hyphens and have no edge hyphen; the full
name is at most 253 characters. URLs, ports, paths, wildcards, IP addresses and raw
Unicode are refused. Punycode-form names can be supplied explicitly. Duplicate
normalized names are refused and the persisted list is sorted. TCP publication
cannot claim names. Existing records without a hostname list remain compatible.

Admission is bounded to eight names per publication, 128 names across the existing
32-publication cap, and 16 KiB of total hostname text. Registry writes also enforce
the same 64 KiB serialized ceiling used by readers. No certificate issuance is
performed by this command; these limits are not certificate-retention proof.

The inspection result explicitly says `durable-ownership-only`; each entry is
`claimed` and contains the hostname, run, reservation and derived endpoint. It does
not assert process liveness, socket readiness or certificate permission. An authority
must verify those separately before using a claim. Control tokens are not exposed.

Claims remain immutable during complete-journal recovery. Unpublish, bridge release,
graph cleanup and VM down retire them with their publication only after verified
resource cleanup. A mismatched receipt leaves the claim reserved, preventing a new
application from taking it while ownership is unresolved. A stale release for an
old reservation cannot retire a later reservation's claim.

## Verification

Regression coverage includes normalization, malformed names, duplicate names,
per-publication and total-name limits, durable readback, cross-publication conflicts,
and refusal to recover a pending journal that changes an existing claim. Live
controls and final gate results are recorded below.

## Remaining work

The runtime does not yet serve an HTTP hostname authority. Add live publication
verification, owned private transport, authority/proxy process lifecycle and durable
certificate admission/retirement. Existing Compose route labels remain rejected;
branch-name derivation, service aliases and runtime host metadata must be adopted
explicitly before real-app parity. Claim inspection alone must never be used as a
positive TLS or routing health check. No performance improvement is claimed here.

## Completed live qualification

Two healthy services used separate bridge slots. The first publication normalized
`API.Feature-X.Demo.Hack.` to `api.feature-x.demo.hack`; inspection showed its durable
claim. The second service's publication was refused while that name was occupied,
and the first continued serving HTTP. After verified first-publication cleanup,
the second claimed the same name. An old unpublish request for the first reservation
left the second publisher alive and its claim intact.

Actual publisher death followed by a deliberately mismatched frontend receipt kept
the name reserved. Restoring only the fixture's original receipt allowed cleanup.
Explicit unpublish, bridge release, VM down and graph cleanup retired the claims;
reboot/restart preserved the application's token and complete volume record. Final
archive/export and down passed, with an empty publication registry and no pending
journal. All 12 watchdog samples and protected global hashes passed.

Evidence: `.hack-local/review/wu07/hostname-claims-1789589873012684000/`.
Candidate SHA-256: `68c19dded9b3b4269cf938a7eb625178db7da64a729275a0018cc349cc12a2cd`.
Default/all-feature Rust tests, strict Clippy, default native-HTTP release and Bun
typecheck/check/tests passed (940 pass, 5 skip). CLI reference generation completed
without stable-CLI changes. Additional CLI contracts reject URL-valued names,
hostname claims with TCP mode, and hostname flags on unrelated actions.
