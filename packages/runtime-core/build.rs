use std::{env, path::PathBuf, process::Command};
fn main() {
    println!("cargo:rerun-if-changed=guest/stream-relay.c");
    if env::var_os("CARGO_FEATURE_NATIVE_STREAM_RELAY").is_some() {
        build_stream_relay();
    }
    println!("cargo:rerun-if-changed=guest/http-probe.c");
    if env::var_os("CARGO_FEATURE_NATIVE_HTTP_PROBE").is_some() {
        build_http_probe();
    }
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

fn build_stream_relay() {
    let version = Command::new("zig")
        .arg("version")
        .output()
        .expect("native-stream-relay requires Zig 0.15.2");
    assert!(
        version.status.success() && version.stdout == b"0.15.2\n",
        "native-stream-relay requires Zig 0.15.2"
    );
    let out = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    for (program, flags, output) in [
        (
            "zig",
            vec![
                "cc",
                "-target",
                "aarch64-linux-musl",
                "-Os",
                "-static",
                "-s",
            ],
            "stream-relay",
        ),
        ("cc", vec!["-std=c11", "-O2"], "stream-relay-host"),
    ] {
        let status = Command::new(program)
            .args(flags)
            .args(["-Wall", "-Wextra", "-Werror", "guest/stream-relay.c", "-o"])
            .arg(out.join(output))
            .status()
            .expect("build stream relay");
        assert!(status.success(), "stream relay build failed");
    }
}

fn build_http_probe() {
    let version = Command::new("zig")
        .arg("version")
        .output()
        .expect("native-http-probe requires Zig 0.15.2");
    assert!(
        version.status.success() && version.stdout == b"0.15.2\n",
        "native-http-probe requires Zig 0.15.2"
    );
    let out = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    let result = Command::new("zig")
        .args([
            "cc",
            "-target",
            "aarch64-linux-musl",
            "-Os",
            "-static",
            "-s",
            "-Wall",
            "-Wextra",
            "-Werror",
            "guest/http-probe.c",
            "-o",
        ])
        .arg(out.join("http-probe"))
        .status()
        .expect("build guest HTTP probe");
    assert!(result.success(), "guest HTTP probe build failed");
    // The same POSIX source runs locally for adversarial network and process tests.
    let result = Command::new("cc")
        .args([
            "-std=c11",
            "-O2",
            "-Wall",
            "-Wextra",
            "-Werror",
            "guest/http-probe.c",
            "-o",
        ])
        .arg(out.join("http-probe-host"))
        .status()
        .expect("build host HTTP probe test driver");
    assert!(result.success(), "host HTTP probe build failed");
}
