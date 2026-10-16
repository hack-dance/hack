# Develop Hack using Hack

Run portable checks in the opt-in `toolchain` service. The host needs Hack and a
working container runtime; Bun, Rust, Java and TLC are installed inside the image.
`mise.toml` pins the language tools and also supports an optional native mise setup.
`.tool-versions` retains matching Bun/Node/Zig pins for existing asdf consumers.
The Dockerfile pins mise and TLC with SHA256 checks. Debian packages receive the
updates available at build time; this is not a fully reproducible OS snapshot.

From the repository root:

```sh
hack run --profile toolchain toolchain -- models
hack run --profile toolchain toolchain -- test tests/tla-result.test.ts
hack run --profile toolchain toolchain -- test
hack run --profile toolchain toolchain -- check
hack run --profile toolchain toolchain -- rust
hack run --profile toolchain toolchain -- rust-check
hack run --profile toolchain toolchain -- build
hack run --profile toolchain toolchain -- exec bun index.ts --help
```

During CLI development, use the current branch's `./dist/hack` as the outer command
after `bun run build`. The inner `bun index.ts` exercises source from the mounted
checkout. The installed CLI is a bootstrap path, not evidence of candidate behavior.
Compose checks the image build on every run and reuses unchanged build layers.
Changing the Dockerfile or tool pins therefore rebuilds through the same command.
The service is a one-shot task, not an idle development daemon.

The Linux `node_modules`, compiled CLI `dist`, Rust registry, and `/build` outputs
use separate named volumes. They do not overwrite native build outputs. The build
task compiles from `/app/dist` so Bun 1.3.9 stages on the output filesystem; a
cross-device fallback from the host bind mount can otherwise emit an invalid binary
despite a successful compiler exit. The task also executes the result to verify it.
Dependency installation
uses the frozen lockfile and is serialized with test commands sharing that volume.
Each branch instance gets its own volumes today. Lockfile-compatible cross-worktree
reuse and bounded eviction remain follow-up work; do not claim this solves retention.
No Docker socket, user home, SSH agent, or credential directory is mounted. The
checkout is writable for normal development, so commands can edit source files.
The build context allows only the toolchain files and mise config, excluding project
secrets and runtime state. Preserve Hack-generated `.gitignore` entries.

Use host-native qualification for macOS Hypervisor/SmolVM/libkrun behavior, routing
and trust, idle reclamation, and full-runtime resource measurements. A Linux unit
suite or container benchmark does not establish those properties. Portable benchmark
commands can run through `toolchain exec`; record the image, architecture, CPU/memory
limits and whether measurements include the outer runtime. Nested Docker scenarios
need a separate isolated runtime fixture and are not enabled by this service.

The Linux container runs as root. Tests requiring macOS or an unprivileged chmod
failure are explicitly skipped there and must pass on the native host. This keeps
the container result distinct from full host acceptance.
