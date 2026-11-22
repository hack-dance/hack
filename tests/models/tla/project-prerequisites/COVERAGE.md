# Compose sign-in prerequisites

This model covers one prerequisite in one CLI invocation. `CheckPass` and
`CheckFails` model the observed exit status or missing/timeout outcome of
`checkPrerequisite`. The first failure can offer login only on an interactive
text invocation. `Decide` models `confirmLogin`. `Login` models the login exit
status. Successful login returns to a fresh check. The `allowed` outcome
lets the command advance to its hooks.

`CheckedBeforeHooks` requires a passing check. The negative configuration removes
the recheck and should find a login that reaches `allowed` without a pass.
`LoginRequiresConsent` requires an affirmative answer. This finite model leaves
out subprocess containment, check output, per-invocation deduplication, timing
and external credential changes. There is no durable pass cache.

[State chart](state.svg) · [Mermaid source](state.mmd)
