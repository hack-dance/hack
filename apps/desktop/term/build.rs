//! Guard for the `ghostty` feature: fail with instructions when the pinned
//! libghostty-vt inputs are not provisioned locally.
//!
//! The dependency's own build script would otherwise try to download them.
//! The workspace's `.cargo/config.toml` already makes that download
//! impossible; this guard says what to do instead. It checks only that the
//! inputs are present. Their sha256 is verified by the provisioning script
//! and again by the dependency's build script.

use std::env;
use std::path::Path;

const VERSION: &str = "1.0.1";

fn main() {
    for var in [
        "GHOSTTY_RELEASE_DIR",
        "GHOSTTY_VT_LIB_DIR",
        "GHOSTTY_SOURCE_DIR",
        "ZIG",
    ] {
        println!("cargo:rerun-if-env-changed={var}");
    }
    if env::var_os("CARGO_FEATURE_GHOSTTY").is_none() || env::var_os("DOCS_RS").is_some() {
        return;
    }
    // Explicit local overrides the dependency supports; both avoid downloads.
    let set = |name: &str| env::var_os(name).is_some_and(|v| !v.is_empty());
    if set("GHOSTTY_VT_LIB_DIR") || set("GHOSTTY_SOURCE_DIR") {
        return;
    }
    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let apple = matches!(target_os.as_str(), "macos" | "ios");
    let needed: &[String] = &if apple {
        vec![format!("ghostty-vt-{VERSION}.xcframework.zip")]
    } else {
        vec![
            format!("libghostty-vt-{VERSION}.tar.gz"),
            format!("libghostty-vt-{VERSION}-deps.tar.gz"),
        ]
    };
    let problem = match env::var_os("GHOSTTY_RELEASE_DIR").filter(|v| !v.is_empty()) {
        None => Some("GHOSTTY_RELEASE_DIR is not set".to_owned()),
        Some(dir) => needed
            .iter()
            .find(|name| !Path::new(&dir).join(name).is_file())
            .map(|name| format!("{} is missing {name}", Path::new(&dir).display())),
    };
    let zig_problem = (!apple && problem.is_none() && !set("ZIG"))
        .then(|| "ZIG is not set (the pinned Zig 0.17.1 from the provisioning script)".to_owned());
    if let Some(problem) = problem.or(zig_problem) {
        eprintln!(
            "\nhack-desktop-term: the `ghostty` feature builds libghostty-vt {VERSION} from\n\
             local, checksummed inputs and never downloads during the build.\n\n\
             problem: {problem}\n\n\
             Provision them once (the only step that uses the network), then export\n\
             what the script prints:\n\n\
             \x20   eval \"$(bash term/scripts/provision-ghostty.sh)\"\n\n\
             See apps/desktop/term/DECISION.md, \"Build and CI\".\n"
        );
        std::process::exit(1);
    }
}
