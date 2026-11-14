# Standalone lifecycle supervisor

This private crate builds `hack-lifecycle-supervisor`, an internal host-process
owner for Linux and macOS. It has no dependency on runtime-core, a terminal
multiplexer, Python, or a shell wrapper. Authored shell commands can still
explicitly select a shell in their argv.

The CLI can select this owner with `lifecycle.runner: "supervisor"`; the default
remains `"mux"`. Fake-caller contracts and the real CLI integration have separate
regressions. Distribution packaging remains a separate change. See
[the protocol, state model and delivery gates](../../docs/lifecycle-supervisor.md).

Build and verify from the repository root with the pinned toolchain:

```sh
cargo +1.97.1 fmt --manifest-path packages/lifecycle-supervisor/Cargo.toml --check
cargo +1.97.1 clippy --locked --manifest-path packages/lifecycle-supervisor/Cargo.toml --target-dir .hack-local/target/lifecycle-supervisor --all-targets -- -D warnings
cargo +1.97.1 test --locked --manifest-path packages/lifecycle-supervisor/Cargo.toml --target-dir .hack-local/target/lifecycle-supervisor
cargo +1.97.1 build --locked --release --manifest-path packages/lifecycle-supervisor/Cargo.toml --target-dir .hack-local/target/lifecycle-supervisor
```

Tests create private temporary roots and explicit fake command environments. They
need no network, Docker, user registry or running Hack daemon. Each test owns its
processes and cleans them up. CI runs the same crate on Linux x86_64, macOS arm64,
and macOS x86_64. A cross-target `cargo check` checks compilation only; it does not
qualify platform signal, process identity, output or recovery behavior.

`run` and `serve` must be spawned as fresh children without the caller making them process-group
leader. The supervisor calls `setsid` itself and detaches its standard descriptors
after the framed ready receipt. `serve` accepts later `add` requests through a
private local socket, preserving persistent-hook ordering. `add`, `stop`, and
`status` are finite framed requests.
Frames, not pipe closure, delimit delivery. The per-command guard publishes kernel
identity before executing authored argv and retains ownership after the project
supervisor dies. A killed guard with surviving session members prevents a fresh
launch. Stop can recover that session after validating its recorded boot, leader
birth, UID and SID: TERM, five seconds of grace, then KILL if necessary, with
individual incarnation checks before delivery. A different boot or reused leader
proves the old session absent and never authorizes signaling the replacement.
A command that creates another session with `setsid` leaves this ownership boundary and is unsupported.

The caller supplies a fresh ownership token and an existing private instance root.
No command/environment is persisted. Log output is unredacted and mode 0600.
There is no PTY: stdin is null and stdout/stderr are pipes.

Status returns `liveProcessNames` and `unknownProcessNames` separately from the
persisted `processes[].phase`. A missing/zombie guard with live descendants is
unknown until recovery confirms absence; persisted `running` alone proves nothing.
These are additive version-1 receipt fields; they do not alter state files.

Idle guards poll stdout/stderr and react to SIGCHLD/stop signals. A live direct
child proves work remains without a machine-wide census. After its exit, a 500 ms
fallback session census detects surviving descendants. EOF descriptors leave the poll set. A slow census still
finds descendants whose exit does not generate SIGCHLD for this guard. Stop uses
20 ms confirmation intervals and keeps its five-second TERM grace. Immediate
restart retries the instance lock for at most one second. Command-lock admission
waits at most ten seconds for a previous owner to finish releasing its lock.

The project supervisor passes its launch/stop flock lease to each guard on startup
fd 2. The guard retains it through durable publication and receipt delivery, then
replaces stdio with `/dev/null`. Supervisor death therefore cannot let stop pass an
unpublished guard that might later spawn. Authored children get their own stderr
pipe and never inherit that lease. Startup closes inherited descriptors with Linux
`close_range` or enumeration of actual `/proc/self/fd` / `/dev/fd` entries; its cost
is independent of the descriptor limit. Log flock acquisition and release retry EINTR.

A usable process census is required before authored spawn. Linux preflight rejects
known `hidepid` mounts and requires a readable self identity in the census. An
unreadable process is skipped only after proving its UID is foreign; inaccessible
same-user identities fail closed. Darwin uses the short BSD identity query to
prove a protected process has a foreign UID; failure to establish that also refuses.
A post-launch census error retains the guard and command lock during cleanup.
This is not qualification of hidepid, PID namespaces, sandboxed/filtered process
views, or a process view that silently omits same-user members. Those views remain
unsupported. Same-user hostile receipt mutation and commands escaping their SID
remain outside the contract. Darwin lacks pidfd, so identity recheck and numeric
signal delivery still have a kernel observation/effect interval.

The ignored `idle_guard_cpu_and_wakeup_measurement` fixture samples one guard and
its supervisor for three five-second idle intervals. Linux CPU ticks and voluntary
context switches are process accounting, not hardware wakeup telemetry. Run it
alone with `--ignored --exact idle_guard_cpu_and_wakeup_measurement --nocapture`.
The ignored `million_descriptor_limit_qualification` fixture requires a host hard
RLIMIT_NOFILE of at least 1048576; the ordinary raised-limit fixture uses the host's
available limit. A host refusing that raise does not qualify the million-fd case.

Orphan recovery requires a surviving member whose kernel birth is no later than
the recorded command birth. A reused numeric SID alone never authorizes a signal.
Terminal receipts prove the old guard completed cleanup; uncertain legacy or
newer-member-only sessions remain unknown without effects. See
[resource and qualification boundaries](../../docs/lifecycle-supervisor.md#resource-and-qualification-boundaries)
for offline rotation, Darwin different-UID limits and crash-window qualification.
The ignored idle measurement has a native Darwin variant using proc_pid_rusage
over 60 seconds; its kernel idle/interrupt wakeups differ from Linux context switches.
Descriptor-limit and functional prepublication lease tests run on both platforms.

Deterministic crash checkpoints are available only with the test-hooks feature.
Run cargo test --features test-hooks guard_killed_after_ to exercise both save/spawn
windows. Never enable this feature in shipped/default/release artifacts.
