use std::{env, path::PathBuf, process::Command};
fn main() {
    println!("cargo:rerun-if-changed=guest/environment-launcher.zig");
    if env::var_os("CARGO_FEATURE_ENVIRONMENT_LAUNCHER").is_none() {
        return;
    }
    let version = Command::new("zig")
        .arg("version")
        .output()
        .expect("environment-launcher requires Zig 0.15.2");
    assert!(
        version.status.success() && version.stdout == b"0.15.2\n",
        "environment-launcher requires Zig 0.15.2"
    );
    let output = PathBuf::from(env::var_os("OUT_DIR").unwrap()).join("environment-launcher");
    let status = Command::new("zig")
        .args([
            "build-exe",
            "guest/environment-launcher.zig",
            "-target",
            "aarch64-linux-musl",
            "-O",
            "ReleaseSmall",
            "-fstrip",
        ])
        .arg("--cache-dir")
        .arg(output.parent().unwrap().join("zig-cache"))
        .arg(format!("-femit-bin={}", output.display()))
        .status()
        .expect("launch Zig");
    assert!(status.success(), "guest environment launcher build failed");
}
