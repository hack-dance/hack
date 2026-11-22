# Compose sign-in prerequisites

This model covers one prerequisite in one CLI invocation. `CheckPass` and
`CheckFails` model the observed exit status or missing/timeout outcome of
`checkPrerequisite`. The first failure can offer login only on an interactive
text invocation. `Decide` models `confirmLogin`. `Login` models the login exit
status. Successful login returns to a fresh check. The `allowed` outcome
lets the command advance to its hooks.

`CheckedBeforeHooks` requires a passing check. The negative configuration removes
the recheck and should find a login that reaches `allowed` without a pass.
`LoginRequiresConsent` requires an affirmative answer. `TimeoutRequiresGroupStop` requires the `Timeout` → `StopGroup` sequence before
returning the timeout refusal. `StopGroup` abstracts sending SIGKILL to the
owned process group. The regression exercises a real descendant. The model
leaves out OS delivery, escaped processes, check output, per-invocation
deduplication, timing and external credential changes. There is no durable pass cache.

[State chart](state.svg) · [Mermaid source](state.mmd)
