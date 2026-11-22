# Staged startup preflight

`stopped-pool-startup` covers advisory retained selection, replacement between
checks and effect-time revalidation under the pool lease. Its interleavings
remain available with staged requests. TypeScript sends each request at the
original call site, and the same handlers acquire and release their locks.
Preflight supplies no new authority for boot or restore.

`Preflight.tla` models two serial requests, frontend death between requests
or while one is in flight, and eventual observation of EOF. `Send` corresponds
to receiving one complete frame and entering its handler in
`startup_preflight::run`. `Reply` abstracts completing the handler and releasing
its locks before publishing a response. `EOFObserved` corresponds to the
watchdog observing pipe closure and exiting, which releases process-owned
descriptors. The negative control removes retirement at EOF. Weak fairness
assumes the OS schedules the watchdog and delivers EOF when the sole writer
closes. The installed candidate contract kills the frontend while the runtime
is reading a partial frame. The worker loop test uses a stand-in handler and
a separate process to acquire its lease after the first reply and before the
next request. The model abstracts handler internals, partial
I/O, wall-clock deadlines, diagnostics and provider repair durability.

The positive run explores 13 distinct states. The negative run reaches
`NoOrphan` at `EOFObserved`. [State chart](preflight.svg).
