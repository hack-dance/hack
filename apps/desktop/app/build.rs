//! Turns on `cfg(hack_terminal)`, the terminal panel, when it is built: always
//! on macOS (the app's dependency on hack-desktop-term is unconditional
//! there), and elsewhere with the `terminal` feature. The code checks this
//! cfg, not the feature, so a macOS build never depends on a flag.

fn main() {
    println!("cargo::rustc-check-cfg=cfg(hack_terminal)");
    let macos = std::env::var("CARGO_CFG_TARGET_OS").is_ok_and(|os| os == "macos");
    if macos || std::env::var_os("CARGO_FEATURE_TERMINAL").is_some() {
        println!("cargo::rustc-cfg=hack_terminal");
    }
}
