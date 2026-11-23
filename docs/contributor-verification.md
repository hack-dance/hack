# Contributor verification notes

Use these notes with [the repository checks](../AGENTS.md#verification). Match
the test to the public operation whose behavior is changing.

- For CLI output, capture complete parent stdout and stderr. Replay printed
  recovery commands through each supported shell and the source CLI from the
  original directory; correct quoting alone does not prove parser acceptance.
- For subprocess tests, count checks and child invocations separately. Give
  interpolated source and destination variables different names. Cover both an
  immediate child signal and an interrupt after readiness, checking the result
  envelope and absence of delayed child effects.
- Exercise Docker teardown diagnostics with real containers when changing them,
  including short service grace periods and explicit zero. At timeout boundaries,
  check both premature termination and overruns; mutate the call site separately
  from any shared constant.
- Qualify readiness with a live wrong responder as well as an absent service.
  A TLS fixture should serve only the selected hostname so another accepted name
  cannot hide incorrect SNI.
- For cache-hit claims, use the normal entry point with a counting, refusing
  upstream and independently observe the local resource. For invalidation, change
  a real key input and independently remove the comparison and its caller.
- For lock and cleanup changes, exercise contention through the outer operation,
  probe acquired leases independently between requests, and include nested live
  consumers. Test ownership predicates independently. If observation uses an alias
  but deletion uses the real path, keep the target live while the alias is absent.
- Crash tests should interrupt each durable publisher and each successful deletion,
  then retry the exact operation in a fresh process. Include rename-before-unlink
  recovery; successful in-process rollback does not prove crash recovery.
- Record a nonzero executed test count for platform-gated checks. Give concurrent
  worktrees and mutation builds separate output directories. Serialize checkout-writing
  builds with checkout-write checks, or use separate worktrees. Set fixture umasks
  explicitly when testing private state, while retaining tests of refused modes.

Formal models and helper tests complement implementation tests. Break the relevant
branch through the composed entry point to establish that the implementation
regression detects the failure the model describes.
