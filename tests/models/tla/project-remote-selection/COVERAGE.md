# Compose remote teardown

The model tracks one startup attempt, its runtime record, an observable
container label, a different saved preference, and the target given to the
teardown hook. A failed startup clears the record and may leave a labelled
container. Teardown uses the observed target, then the record, when available.

TLC 1.7.4 explored eight distinct states with no violations. The negative
control enables the old saved-choice fallback and violates
`TeardownUsesStartedTarget`. Its final state is:

```text
State 4: Teardown
record = "none"
started = "none"
hook = "live"
phase = "done"
saved = "live"
label = "none"
```

The model assumes the label and record belong to this Compose instance.
It does not qualify Docker observation, filesystem durability, or concurrent
publication. The stopped save checks Docker under the writer lock. A startup
can observe the saved state and begin after that check, before publication.
In that ordering the new choice is pending and never a teardown input.

[State chart](state.svg) · [Mermaid source](state.mmd)
