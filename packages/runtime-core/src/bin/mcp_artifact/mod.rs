//! Side-effect-free capability report for candidate bundle assembly.
use std::ffi::OsString;

pub(super) fn describe(args: &[OsString], role: &str) -> bool {
    if args.len() != 1 || args[0] != "--mcp-artifact-info" {
        return false;
    }
    let platform = match std::env::consts::OS {
        "macos" => "darwin",
        value => value,
    };
    let architecture = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        value => value,
    };
    println!(
        "{{\"schemaVersion\":1,\"role\":\"{role}\",\"startupProtocol\":2,\"wireProtocol\":1,\"platform\":\"{platform}\",\"architecture\":\"{architecture}\"}}"
    );
    true
}
