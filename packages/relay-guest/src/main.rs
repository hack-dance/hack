//! Thin guest adapter: all credentials, authentication and records use canonical
//! runtime-core sources. The launcher owns endpoint and descriptor provenance.
#[path = "../../runtime-core/src/error.rs"]
mod error;
pub use error::CandidateError;
#[path = "../../runtime-core/src/provider/private_input.rs"]
mod private_input;
// This shared module also supplies host-only authority/effect APIs. Keep them
// compiled and checked by runtime-core without requiring guest-side callers.
#[allow(dead_code)]
#[path = "../../runtime-core/src/provider/relay_auth.rs"]
pub mod relay_auth;
#[path = "../../runtime-core/src/provider/relay_client.rs"]
pub mod relay_client;
#[path = "../../runtime-core/src/provider/relay_frame.rs"]
pub mod relay_frame;
#[path = "../../runtime-core/src/provider/relay_integrity.rs"]
pub mod relay_integrity;

mod barrier;
mod server;
mod socket;
use std::{
    os::fd::{FromRawFd, OwnedFd},
    time::Duration,
};

const USAGE: &str = "hack-relay-guest --slot <0..31> --application-fd <3..2147483647>\nhack-relay-guest --slot <0..31> --listen-port <1..65535> [--listen-address <slot-loopback>]\nhack-relay-guest --await-release <generation> -- <absolute executable> [args...]\nhack-relay-guest --check-release <generation> -- <absolute executable> [args...]\nRelay credential: one private stdin descriptor. Listener address is 127.0.0.1 or 127.0.0.(slot+2).\n";
mod options;
use options::{Mode, Options, options};
fn credential() -> Result<relay_auth::Credential, CandidateError> {
    // SAFETY: F_GETFD checks that FD0 exists before adopting it exactly once.
    if unsafe { libc::fcntl(0, libc::F_GETFD) } < 0 {
        return Err(CandidateError::new(
            "relay_guest_descriptor",
            "Required inherited descriptor is absent.",
        ));
    }
    // SAFETY: no Stdin handle/duplicate exists; the invocation transfers FD0 ownership.
    let stdin = unsafe { OwnedFd::from_raw_fd(0) };
    relay_auth::Credential::from_private_descriptor(stdin, Duration::from_secs(5))
}
fn run(options: Options) -> Result<(), CandidateError> {
    match options.mode {
        Mode::Listener { address, port } => server::run(options.slot, address, port, credential()?),
        Mode::Application(fd) => {
            // SAFETY: F_GETFD checks a numeric descriptor without taking ownership.
            if unsafe { libc::fcntl(fd, libc::F_GETFD) } < 0 {
                return Err(CandidateError::new(
                    "relay_guest_descriptor",
                    "Required inherited descriptor is absent.",
                ));
            }
            // SAFETY: invocation transfers this checked FD exactly once; the launcher
            // must not retain duplicates that defeat normal EOF.
            let application = socket::application(unsafe { OwnedFd::from_raw_fd(fd) })?;
            let credential = credential()?;
            let transport = socket::connect(options.slot, Duration::from_secs(5))?;
            relay_client::run(
                transport,
                application,
                &credential,
                relay_client::Limits {
                    handshake_timeout: Duration::from_secs(5),
                    idle_timeout: Duration::from_secs(30),
                },
            )?;
            Ok(())
        }
    }
}
fn main() {
    let raw_args: Vec<_> = std::env::args_os().skip(1).collect();
    if raw_args
        .first()
        .is_some_and(|arg| arg == "--await-release" || arg == "--check-release")
    {
        if !barrier::valid(&raw_args) {
            eprint!("{USAGE}");
            std::process::exit(64);
        }
        if barrier::run(&raw_args).is_err() {
            eprintln!("hack-relay-guest: startup release refused");
            std::process::exit(1);
        }
        return;
    }
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args == ["--help"] || args == ["-h"] {
        print!("{USAGE}");
        return;
    }
    let Some(options) = options(&args) else {
        eprint!("{USAGE}");
        std::process::exit(64);
    };
    if run(options).is_err() {
        eprintln!("hack-relay-guest: authenticated connection refused");
        std::process::exit(1);
    }
}
