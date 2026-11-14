# Standalone lifecycle supervisor

This private crate builds `hack-lifecycle-supervisor`, an internal host-process
owner for Linux and macOS. It has no dependency on runtime-core, a terminal
multiplexer, Python, or a shell wrapper. Authored shell commands can still
explicitly select a shell in their argv.

The first slice is exercised by a fake caller. It does not select a new CLI runner
or install the executable. See [the protocol, state model and delivery gates](../../docs/lifecycle-supervisor.md).

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

`run` must be spawned as a fresh child without the caller making it a process-group
leader. The supervisor calls `setsid` itself and detaches its standard descriptors
after the framed ready receipt. `stop` and `status` are finite framed requests.
Frames, not pipe closure, delimit delivery. The per-command guard publishes kernel
identity before executing authored argv and retains ownership after the project
supervisor dies. A killed guard with surviving session members is an unknown
ownership state: retry and unsafe stop are refused. A command that creates another
session with `setsid` leaves this ownership boundary and is unsupported.

The caller supplies a fresh ownership token and an existing private instance root.
No command/environment is persisted. Log output is unredacted and mode 0600.
There is no PTY: stdin is null and stdout/stderr are pipes.
