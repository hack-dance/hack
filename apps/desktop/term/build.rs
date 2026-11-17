//! Build steps for the `ghostty` feature. Nothing here uses the network.
//!
//! 1. Fail with instructions when the pinned libghostty-vt inputs are not
//!    provisioned locally. The dependency's own build script would
//!    otherwise try to download them; the workspace's `.cargo/config.toml`
//!    already makes that download impossible, and this says what to do
//!    instead. It checks only that the inputs are present: their sha256 is
//!    verified by the provisioning script and by the dependency.
//! 2. Embed the symbols fallback font: read the provisioned file, verify it
//!    against the sha256 pinned here, and copy it to `OUT_DIR` for
//!    `include_bytes!`. A different file fails the build.

use std::env;
use std::path::PathBuf;

const VERSION: &str = "1.0.1";
#[cfg(feature = "ghostty")]
const SYMBOLS_FONT: &str = "SymbolsNerdFontMono-Regular.ttf";
/// Symbols Nerd Font Mono from Nerd Fonts v3.5.1.
#[cfg(feature = "ghostty")]
const SYMBOLS_FONT_SHA256: &str =
    "fe471e538392f51910faab985fa8e192a39dd3426125edd15b71b3680df0e749";
#[cfg(feature = "ghostty")]
const SYMBOLS_FONT_DIR: &str = "nerd-fonts-symbols-3.5.1";

fn fail(problem: &str) -> ! {
    eprintln!(
        "\nhack-desktop-term: the `ghostty` feature builds from local, checksummed\n\
         inputs and never downloads during the build.\n\n\
         problem: {problem}\n\n\
         Provision them once (the only step that uses the network), then export\n\
         what the script prints:\n\n\
         \x20   eval \"$(bash term/scripts/provision-ghostty.sh)\"\n\n\
         See apps/desktop/term/DECISION.md, \"Build and CI\".\n"
    );
    std::process::exit(1);
}

fn set(name: &str) -> Option<PathBuf> {
    env::var_os(name)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

fn main() {
    for var in [
        "GHOSTTY_RELEASE_DIR",
        "GHOSTTY_VT_LIB_DIR",
        "GHOSTTY_SOURCE_DIR",
        "HACK_TERM_SYMBOLS_FONT",
        "ZIG",
    ] {
        println!("cargo:rerun-if-env-changed={var}");
    }
    if env::var_os("CARGO_FEATURE_GHOSTTY").is_none() || env::var_os("DOCS_RS").is_some() {
        return;
    }
    check_ghostty_inputs();
    #[cfg(feature = "ghostty")]
    embed_symbols_font();
}

fn check_ghostty_inputs() {
    // Explicit local overrides the dependency supports; both avoid downloads.
    if set("GHOSTTY_VT_LIB_DIR").is_some() || set("GHOSTTY_SOURCE_DIR").is_some() {
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
    let Some(dir) = set("GHOSTTY_RELEASE_DIR") else {
        fail("GHOSTTY_RELEASE_DIR is not set");
    };
    if let Some(name) = needed.iter().find(|name| !dir.join(name).is_file()) {
        fail(&format!("{} is missing {name}", dir.display()));
    }
    if !apple && set("ZIG").is_none() {
        fail("ZIG is not set (the pinned Zig 0.17.1 from the provisioning script)");
    }
}

/// Copy the provisioned symbols font into `OUT_DIR` after checking that it
/// is exactly the pinned file.
#[cfg(feature = "ghostty")]
fn embed_symbols_font() {
    use sha2::{Digest, Sha256};
    let source = set("HACK_TERM_SYMBOLS_FONT").or_else(|| {
        set("GHOSTTY_RELEASE_DIR").map(|d| d.join(SYMBOLS_FONT_DIR).join(SYMBOLS_FONT))
    });
    let Some(source) = source else {
        fail("HACK_TERM_SYMBOLS_FONT is not set");
    };
    println!("cargo:rerun-if-changed={}", source.display());
    let Ok(bytes) = std::fs::read(&source) else {
        fail(&format!(
            "the symbols font is missing: {} (run the provisioning script again)",
            source.display()
        ));
    };
    let actual = format!("{:x}", Sha256::digest(&bytes));
    if actual != SYMBOLS_FONT_SHA256 {
        fail(&format!(
            "{} has sha256 {actual}, expected {SYMBOLS_FONT_SHA256}",
            source.display()
        ));
    }
    let out = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR")).join(SYMBOLS_FONT);
    if std::fs::write(&out, &bytes).is_err() {
        fail(&format!("could not write {}", out.display()));
    }
}
