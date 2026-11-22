# Native image build batch

Four distinct build keys, a cap of three, and one upstream interrupt.
`Start` is the authored-order CLI dispatch after its private request is written.
`Fail` settles the failing invocation and captures the first observed error.
`Interrupt` covers user cancellation. Both prevent further dispatch.
`Settle` removes an invocation only after its promise settles. `Return` requires
an empty active set and reports the original outcome. The model assumes each
invocation's promise settles after its owned runtime child exits. Runtime-side
lease and BuildKit settlement, forced termination, and receipts remain the
existing single-build contract and are outside this batch model.

TLC 1.7.4 explored 296 states. The early-return control violated
`NoLiveReturn` and the cancellation-error control violated `FirstOutcome`.
See the [state chart](build-batch.svg) and [Mermaid source](build-batch.mmd).
