//! Refuses a build that forces SHA-256 into software on a release architecture.
//!
//! `sha2 0.11.1` (`src/sha256.rs`) compiles, for aarch64 and x86_64, both its hardware
//! backend and a software fallback, and picks per process from what the CPU reports. Only a
//! `sha2_backend` or `sha2_256_backend` configuration flag set to `soft` removes the hardware
//! backend. Such a flag reaches every crate of a build through `RUSTFLAGS`, so this crate
//! sees the same flag `sha2` does and stops the build here. The runtime hashes hundreds of
//! megabytes at every boot and stop; in software that is about six times slower on arm64.
//!
//! This holds for the pinned `sha2 = "=0.11.1"`. Read `src/sha256.rs` again before moving
//! that pin: a release that selects its backend another way needs another guard.
#![allow(unexpected_cfgs)]

#[cfg(all(
    any(target_arch = "aarch64", target_arch = "x86_64"),
    any(sha2_backend = "soft", sha2_256_backend = "soft")
))]
compile_error!(
    "sha2 is configured for its software SHA-256 backend (sha2_backend or sha2_256_backend = \"soft\"); \
     remove that flag: this build must be able to use the CPU's SHA-256 instructions"
);
