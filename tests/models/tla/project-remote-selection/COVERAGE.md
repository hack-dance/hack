# Compose remote teardown

The model tracks one startup, a runtime record, a container label, a different
saved preference, configuration removal, and one peer. A failed startup clears
the record and can leave a labelled container. A declared remote project
refuses restart before hooks. Down uses the label, then the record, while the
target is declared. Label-based recovery preserves a failed Compose result when no owned regular containers can be
identified. One-offs do not block recovery, while foreign regular peers do.

TLC 1.7.4 explored 137 distinct states. The saved-choice control violates
`TeardownUsesStartedTarget` in `Teardown` with `started = "none"`,
`record = "none"` and `hook = "live"`. The ownership control violates
`RecoveryRequiresOwnership` in `Teardown` with `declared = FALSE`,
`peer = "foreign"`, `label = "local"` and `stop = "owned"`.

Three more controls fail `NoGuessedEmpty`, `ActiveLabelWins`, and
`RenamedBindingCanRecover`. The final teardown states respectively report
`stop = "empty"` without a label, omit the hook target despite an active
`live` label, and preserve failure despite an owned label and renamed binding.

The CLI fixture covers restart admission, recovery with the config removed,
missing interpolation with an unlabelled one-off, and refusal for a foreign
peer. The model assumes accurate Docker observations and excludes races after
peer enumeration, real network removal and filesystem durability. The stopped
save checks Docker under the writer lock. Startup can begin between that check
and publication. In that ordering the new preference is pending.

[State chart](state.svg) · [Mermaid source](state.mmd)
