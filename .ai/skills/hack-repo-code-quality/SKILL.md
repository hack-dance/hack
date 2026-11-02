---
name: hack-repo-code-quality
description: Apply Hack CLI TypeScript and Rust runtime quality rules when changing code, APIs, persistence, or OS boundaries.
---

# Code quality and boundaries

Use this guide for code, API, persistence and runtime changes. The repository's
Biome/Ultracite and compiler configuration own formatting and diagnostics; do not
copy formatting rules from another repository or mass-reformat unrelated files.

## TypeScript

- Keep strict types. Parse untrusted JSON, config, subprocess output and persisted
  state as `unknown`, then validate once at the boundary. Avoid `any`, non-null
  assertions and casts that bypass validation; document narrow justified exceptions.
- Prefer named option objects for calls with several similar arguments, immutable
  validated inputs, explicit error outcomes, and focused helpers over command-handler
  growth. Reuse Bun APIs and established patterns rather than adding parallel stacks.
- Separate decisions from I/O. Inject clocks, process runners or filesystem seams
  where needed to exercise failure and concurrency, without designing a generic
  framework for a single call site.
- Await owned work and propagate failures. Bound subprocess time, output and retries;
  preserve stdin/TTY, signal, process-group and exit-code behavior for CLI operations.
- Use TSDoc for public contracts; explain non-obvious invariants and failure modes
  in internal stateful code. Comments should explain obligations, not narrate syntax.

## Rust candidate

- Use the root mise toolchain and locked Cargo dependencies. Run rustfmt and Clippy
  with warnings denied; use rustdoc for public contracts and explain ownership and
  platform assumptions. Keep `Result` errors contextual and inspectable.
- Avoid panic/unwrap/expect on recoverable runtime inputs. Test-only assertions or
  proven internal invariants can use them with clear scope. Do not suppress a lint
  broadly when a local correction or documented platform exception suffices.
- Prefer safe APIs. Existing libc/FFI requires some `unsafe`: keep it in the smallest
  boundary and document pointer validity, descriptor ownership, lifetimes, layout,
  locking and platform assumptions as applicable. Do not claim a safe signature alone
  proves those preconditions. Use RAII for owned descriptors, locks and children.
- Preserve default-feature builds as well as relevant feature combinations. An
  all-feature pass can hide a broken default path; Linux cannot validate macOS FFI.
- CLI/adapters should call the owning state machine rather than reproduce admission,
  recovery or cleanup decisions in a second language. Validate versioned boundary
  contracts and retain compatibility/refusal tests when their shape changes.

## State, resources and documentation

Keep read-only observation separate from mutation. Identify the durable owner and
all writers before changing locking, admission, cancellation or cleanup. Recheck
identity at the effect boundary; a PID, path, zero reference count or old receipt
alone does not authorize killing a process or deleting data.

For persistence, name commit and recovery points. Preserve atomic publication,
required synchronization, bounded input/state and interruption recovery. Tests should
include malformed/stale inputs and the failure window the change addresses. A
mocked error proves handling; a real process-kill test proves only its tested boundary.

Update affected docs, schema, fixtures and compatibility notes in the same change.
Do not require unrelated architecture documents to change merely to satisfy a list.
For models, keep the implementation mapping and omitted behavior explicit; follow
the [verification skill](../hack-repo-verify/SKILL.md). Profiling must establish a hot path before
an optimization trades clarity, compatibility or recovery for speed.
