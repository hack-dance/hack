//! Guard: no libtest test in the desktop workspace builds the real GPUI
//! platform.
//!
//! libtest runs each test on a worker thread. On macOS the real platform
//! must be created on the main thread, so a libtest test that builds it
//! panics there ("Mac platform not created on main thread") while passing
//! on Linux. Tests that need the real platform (real fonts, the headless
//! renderer) belong in a `harness = false` target that runs them on the
//! main thread, as `render.rs` does. Everything else uses GPUI's test
//! platform, with `NoopTextSystem` where a text system is needed.
//!
//! This scans source text, so it is a tripwire, not a proof: it catches the
//! calls that construct the platform, written the way this workspace writes
//! them.

use std::path::{Path, PathBuf};

/// Calls that construct the real platform, or a part of it that needs the
/// main thread.
const FORBIDDEN: &[&str] = &[
    "current_platform(",
    "current_headless_renderer",
    "application()",
    "Application::new(",
    "MacPlatform",
];

#[test]
fn no_libtest_test_builds_the_real_platform() {
    let workspace = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("the desktop workspace")
        .to_path_buf();
    // This file names the calls it looks for.
    let itself = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/main_thread.rs");
    let mut found = Vec::new();
    let mut scanned = 0;
    for krate in crates(&workspace) {
        let own_main = main_thread_targets(&krate);
        for file in rust_files(&krate) {
            let rel = file.strip_prefix(&krate).expect("under the crate");
            if file == itself || own_main.iter().any(|t| t == rel) {
                continue;
            }
            let text = std::fs::read_to_string(&file).expect("read a source file");
            if !runs_under_libtest(rel, &text) {
                continue;
            }
            scanned += 1;
            for (n, line) in text.lines().enumerate() {
                let code = line.split("//").next().unwrap_or("");
                for call in FORBIDDEN {
                    if code.contains(call) {
                        found.push(format!(
                            "{}:{}: {call}",
                            file.strip_prefix(&workspace).unwrap_or(&file).display(),
                            n + 1
                        ));
                    }
                }
            }
        }
    }
    assert!(scanned > 0, "the guard scanned no test sources");
    assert!(
        found.is_empty(),
        "libtest tests build the real platform, which panics off the main thread on macOS; \
         use NoopTextSystem, or move them to a `harness = false` target:\n{}",
        found.join("\n")
    );
}

/// The workspace's member crates: each directory with its own Cargo.toml.
fn crates(workspace: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = std::fs::read_dir(workspace)
        .expect("read the workspace")
        .filter_map(|e| Some(e.ok()?.path()))
        .filter(|p| p.join("Cargo.toml").is_file() && p.join("src").is_dir())
        .collect();
    out.sort();
    out
}

/// The paths of a crate's `harness = false` test targets.
fn main_thread_targets(krate: &Path) -> Vec<PathBuf> {
    let manifest = std::fs::read_to_string(krate.join("Cargo.toml")).expect("read Cargo.toml");
    let mut out = Vec::new();
    for block in manifest.split("[[test]]").skip(1) {
        let block = block.split("\n[").next().unwrap_or(block);
        let value = |key: &str| {
            block.lines().find_map(|l| {
                let (k, v) = l.split_once('=')?;
                (k.trim() == key).then(|| v.trim().trim_matches('"').to_owned())
            })
        };
        if value("harness").as_deref() != Some("false") {
            continue;
        }
        let path = value("path").or_else(|| value("name").map(|n| format!("tests/{n}.rs")));
        if let Some(path) = path {
            out.push(PathBuf::from(path));
        }
    }
    out
}

/// Whether libtest compiles this file into a test binary: anything under
/// `tests/`, and any other source that declares a test.
fn runs_under_libtest(rel: &Path, text: &str) -> bool {
    rel.starts_with("tests") || text.contains("#[test]") || text.contains("#[cfg(test)]")
}

fn rust_files(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for entry in std::fs::read_dir(&d).expect("read a directory").flatten() {
            let path = entry.path();
            if path.is_dir() {
                if path.file_name().is_some_and(|n| n != "target") {
                    stack.push(path);
                }
            } else if path.extension().is_some_and(|e| e == "rs") {
                out.push(path);
            }
        }
    }
    out
}

#[test]
fn the_guard_reads_harness_false_targets() {
    let krate = Path::new(env!("CARGO_MANIFEST_DIR"));
    assert_eq!(
        main_thread_targets(krate),
        vec![PathBuf::from("tests/render.rs")]
    );
}
