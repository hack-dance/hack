# Statecharts and checked lifecycle boundaries

Reviewed upstream guidance on 2026-10-28:

- [TLA+ AgentSkills](https://github.com/tlaplus/AgentSkills): analyze source before
  abstraction, update Init/Next/UNCHANGED/type invariants when adding variables,
  and expose intermediate program counters when splitting an action.
- [TLC stable releases](https://github.com/tlaplus/tlaplus/releases/latest): use the
  checksum-pinned stable artifact, not a milestone or an unreviewed nightly.
- [Apalache bounded checking](https://apalache-mc.org/docs/apalache/running.html):
  state the symbolic bound and supported subset; passing one checker is not proof
  of compatibility with another or of unbounded liveness.
- [Statechart regions](https://statecharts.dev/what-is-a-statechart.html): parallel
  regions represent independent active states, not sequential approval steps.

Use a statechart to review state, event, guard and effect names against source and
TLA actions. Show unknown/retained/error states, not only a happy path. An async
request is not its completed effect: split issued, acknowledged, durable and
retired states where crashes or competing owners can distinguish them. Keep stale
callbacks and timeout/cancellation outcomes visible.

Do not collapse a lost reader, EOF, exited child and absent process group into
"done". Do not use a history transition to recover ownership. Treat stop/cleanup
as privileged effects requiring current scope, incarnation and durable evidence.
Mark unsupported states and compatibility transitions instead of deleting them.

A release coverage row must connect property -> model action -> implementation
boundary -> executable regression -> actual checker/artifact evidence. Document
finite domains, fairness and atomicity assumptions; add reachability witnesses and
discriminating negative controls. A diagram is not executable evidence and a model
pass is not runtime, durability, resource, upgrade or application acceptance.
