# Same-boot cancellation of an unlaunched relay

A new relay start now commits a monotonic launch serial alongside its existing durable intent.
The pool counter survives slot release and empty registries; serials cannot wrap, exceed the signed
64-bit guest range or duplicate another active assignment. Older receipts without these fields
remain readable with serial zero and retain their previous conservative recovery behavior.

Each used guest slot has one private lock and one bounded state record in tmpfs. Guest operations
serialize with `flock`; native relays close the inherited lock descriptor rather than retaining it
while serving traffic. Launch records its serial before creating the relay allocation. Stop can cancel a
newer serial that has never acquired launch authority, provided no allocation or socket exists.
The cancelled serial remains recorded after slot release, so a delayed old launch cannot execute.
A later reservation gets a strictly newer serial. Old start, stop and remove requests are rejected
before touching the replacement allocation. Normal stop still verifies executable/process/socket
identity and uses the pidfd shutdown path.

State publication uses one exclusive pending file per slot and atomic rename. Unknown or partial fence state
refuses further effects. Per-slot records remain until VM shutdown; they do not accumulate one
record per attempt. The existing pool capacity bounds the number of slot directories at 32.
This is guest temporary metadata, not a new persistent image or volume cache.

## Live control

Evidence: `.hack-local/review/wu07/relay-fence-1789577492661139000/`.
Candidate SHA-256: `356bc6634abba8ad4ebdc68b10ee265ea1930151d2e4b94602835aa20e021804`.

The fixture killed its own startup CLI after observing committed `starting` intent. Release then
succeeded without VM restart; guest allocation and socket remained absent, and the application
stayed running. Replaying the old guest launch was refused. Four later slot reuses each served
HTTP, refused delayed old start/stop/remove requests, and continued serving HTTP before ordinary
release. Boot identity remained unchanged throughout this sequence.

After every cycle, all relay allocation directories were absent. The used slot retained exactly
two files and `du` reported 4 KiB throughout all four cycles. This measures guest tmpfs allocation,
not unique host disk consumption. There was no increase with the attempt count. Existing active
cleanup, ownership-marker refusal, interrupted-stop retry, generation replacement and host-journal
recovery controls also passed. All 20 admission watchdog samples passed. Final graph cleanup,
archive/export reconciliation, listener shutdown and VM reboot/down passed. Protected Hack global
configuration stayed unchanged. No comparative performance benchmark was added by this unit.

## Ordering checks

A small private TLA+ model checked three generations of one slot: 16 distinct states, no safety
violation. Removing the stale-launch guard produced the expected cancelled-then-late-launch
counterexample. An abstract mapping of cancellation and first slot reuse traversed all eight
recorded states; an invalid late-launch trace was rejected. The replay check additionally requires
an enabled next transition before the trace ends, so a stuck valid prefix cannot count as success.
The counterexample became explicit delayed-request assertions in the live fixture.

These checks cover the ordering rule under serialized guest operations, not every filesystem or
kernel failure. Models, configs, traces and logs are retained in
`.hack-local/relay-fence-model/`. The model helper initially selected Java globally; that unintended
override was removed. Subsequent checks invoked Java explicitly with two workers and a 512 MiB
heap limit, without changing global tool selection.

## Remaining recovery boundaries

The new cancellation path covers a request that has not acquired guest launch authority. A crash
after that authority is recorded but before usable process identity appears can still require
owned VM restart. Partial fence publication, interrupted binary staging, replaced guest evidence
and later socket-publication windows need further controlled recovery work. Ambiguous state is
retained rather than interpreted as a safe-to-delete allocation. Normal host loopback/TLS routing
and real-application qualification remain open.

Repeated fault injection also reached the existing eight-record host recovery limit. It correctly
refused to overwrite evidence and shut the VM down. Eight verified, known fixture-injected journals
were preserved in a manifest-backed private export, then the interrupted fixture was reconciled
and cleaned before this final run. This was isolated fixture maintenance, not a product export API.
Evidence: `.hack-local/review/wu07/relay-fence-1789577361307023000/retention-export/`.
An explicit bounded bridge recovery export/retirement command is now a WU12 follow-up; raising the
limit or silently discarding recovery records is not the remedy.

Default/all-feature Rust tests, strict Clippy, the default release build and repository
typecheck/check/test passed (940 CLI passes, five skips). Focused bridge tests also verified
legacy receipt decoding, counter retention with empty slots, duplicate serial refusal and bounds.
Shell syntax, changed-document links and whitespace/privacy checks passed.
