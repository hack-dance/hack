# Compose remote teardown hooks

The model tracks the started target, its label and runtime record, and an
inactive backing container left by a switch. Teardown hooks use the active
label, then the runtime record. A pending preference supplies no hook binding.

TLC 1.7.4 explored 11 states. The saved-choice control violates
`TeardownUsesStartedTarget` with `started = "none"` and `hook = "pending"`.
The stale-label control violates `ActiveLabelWins` with `label = "qa"`,
`stale = TRUE` and `hook = "none"`.

The CLI fixture changes the saved preference after startup and removes the
runtime record. The target-selection test covers exited, dead and created
containers alongside an active label. The model assumes the labels and record
belong to the instance and use the same authored binding descriptor. The CLI
fixture also covers config digest drift with both label and record lookup.
Compose container and network shutdown use their normal
paths outside this model.

[State chart](state.svg) · [Mermaid source](state.mmd)
