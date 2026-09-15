# Automatic idle reclamation, September 15

One guarded run observed the normal ten-minute policy triggering without a manual balloon command.
The 6-GiB development VM inflated to 4912 MiB at 627.2 seconds after fixture setup, then deflated.
A 128-MiB live tmpfs buffer retained its SHA-256 digest. A further 384 MiB was allocated, filled and
checked against its earlier digest. The guest boot identity remained unchanged, and owned teardown
left the VM stopped. All 317 watchdog samples retained normal pressure, unchanged swapouts and at
least 2 GiB estimated host reserve.

Physical footprint immediately before the pulse was 854,607,552 bytes, versus 854,345,408 bytes
after deflation: only 0.25 MiB lower. Footprint had already fallen after releasing the 384-MiB buffer, before
the idle pulse. **This proves the automatic trigger and this fixture's recovery, not an additional
meaningful footprint gain or full application acceptance.** The policy remains unchanged.

The pinned [SmolVM idle implementation](https://github.com/smol-machines/smolvm/blob/f233d46e8cc34e51543c4f463c2cea7622827093/src/agent/launcher.rs#L2300)
samples whole-process CPU every 30 seconds, requires consecutive idle samples below approximately
1% of one core, and pulses about 80% of guest RAM. It rearms after activity exceeds 5% of a core.
Consequently an application's health checks and background work can prevent the idle window;
wall-clock inactivity at the terminal is not sufficient. This run sampled only host process state
and read-only balloon status during the waiting period. No builds or other tests overlapped it.

Evidence: `.hack-local/review/wu07/automatic-idle-1789512315594348000/`, including
`observations.json`, `reuse.json`, `watchdog.json`, `stopped.json` and
`verified-automatic-idle.json`. The runner exited nonzero while writing its final binary hash from
an incorrect path, after its recovery, teardown and protected-input assertions had passed. An
independent analysis verified the retained observations and wrote the qualification result with
the actual executable hash. The runner's metadata path is corrected for subsequent runs; its
original protocol and failed output remain preserved.

The tested executable was
`9151aa76d51729fa9ffce9b44765ab829a1b333b42402708a98c4f9bb5dff31d`.
Open: repeat automatic rearming, application-sized retained working sets, health traffic near the
idle threshold, and real application recovery. Earlier manual balloon graph tests remain separate
evidence; this automatic run did not exercise an application graph or compare against OrbStack.
