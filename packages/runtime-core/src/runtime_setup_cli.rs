//! Setup's one consent prompt precedes every filesystem and network effect.
use hack_runtime_core::{Candidate, CandidateError, provider::setup};
use std::{
    io::{self, BufRead, IsTerminal, Read, Write},
    path::Path,
};

pub fn run(candidate: &Candidate, arguments: &[&str]) -> Result<(), CandidateError> {
    run_with_reuse(candidate, arguments, setup::reuse_existing)
}

fn run_with_reuse(
    candidate: &Candidate,
    arguments: &[&str],
    reuse: impl FnOnce(&Candidate) -> Result<Option<serde_json::Value>, CandidateError>,
) -> Result<(), CandidateError> {
    let options = parse(arguments)?;
    if let Some(result) = reuse(candidate)? {
        println!(
            "{}",
            serde_json::to_string(&result).expect("setup result is serializable")
        );
        return Ok(());
    }
    let pins = setup::pins()?;
    let interactive = !options.no_interactive
        && io::stdin().is_terminal()
        && io::stderr().is_terminal()
        && !truthy_env(std::env::var("HACK_NO_INTERACTIVE").ok().as_deref());
    if interactive && !cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        return Err(CandidateError::new(
            "unsupported_host",
            "Native setup requires Apple Silicon macOS.",
        ));
    }
    if let Some((archive, engine, packages)) = options.offline {
        let result = setup::run(
            candidate,
            Some(setup::OfflineInputs {
                archive: Path::new(archive),
                engine_archive: Path::new(engine),
                network_tools: Path::new(packages),
            }),
            false,
        )?;
        println!(
            "{}",
            serde_json::to_string(&result).expect("setup result is serializable")
        );
        return Ok(());
    }
    eprintln!("Pinned native runtime files (exact compressed byte lengths):");
    for pin in &pins {
        let url = reqwest::Url::parse(&pin.url)
            .map_err(|_| CandidateError::new("setup_pin_invalid", "Invalid URL."))?;
        eprintln!(
            "  {}: {} bytes; source {}; SHA-256 {}",
            pin.name()?,
            pin.size_bytes,
            url.host_str().unwrap_or(""),
            pin.archive_sha256
        );
        if !pin.redirect_hosts.is_empty() {
            eprintln!(
                "    allowed redirect hosts: {}",
                pin.redirect_hosts.join(", ")
            );
        }
    }
    eprintln!(
        "Private download cache: {}",
        setup::download_directory(candidate).display()
    );
    eprintln!(
        "Install destination: {}",
        candidate.state_root.join("providers").display()
    );
    setup::consent(options.accept, interactive, || {
        eprint!("Download and prepare these pinned files? [y/N] ");
        io::stderr()
            .flush()
            .map_err(|_| CandidateError::new("setup_prompt", "Cannot display confirmation."))?;
        let mut answer = String::new();
        io::stdin()
            .lock()
            .take(32)
            .read_line(&mut answer)
            .map_err(|_| CandidateError::new("setup_prompt", "Cannot read confirmation."))?;
        Ok(matches!(
            answer.trim().to_ascii_lowercase().as_str(),
            "y" | "yes"
        ))
    })?;
    let result = setup::run(candidate, None, true)?;
    println!(
        "{}",
        serde_json::to_string(&result).expect("setup result is serializable")
    );
    Ok(())
}

fn truthy_env(value: Option<&str>) -> bool {
    matches!(
        value.unwrap_or("").trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

#[derive(Default)]
struct Options<'a> {
    accept: bool,
    no_interactive: bool,
    offline: Option<(&'a str, &'a str, &'a str)>,
}
fn parse<'a>(arguments: &[&'a str]) -> Result<Options<'a>, CandidateError> {
    let invalid = || {
        CandidateError::new(
            "invalid_arguments",
            "runtime setup accepts --accept-downloads, --no-interactive, --json; offline setup needs --archive, --engine-archive and --network-tools-directory together.",
        )
    };
    let mut options = Options::default();
    let (mut archive, mut engine, mut packages) = (None, None, None);
    let mut seen = std::collections::BTreeSet::new();
    let mut args = arguments.iter();
    while let Some(flag) = args.next() {
        if !seen.insert(*flag) {
            return Err(invalid());
        }
        match *flag {
            "--accept-downloads" => options.accept = true,
            "--no-interactive" => options.no_interactive = true,
            "--json" => {}
            "--archive" => archive = args.next().copied(),
            "--engine-archive" => engine = args.next().copied(),
            "--network-tools-directory" => packages = args.next().copied(),
            _ => return Err(invalid()),
        }
        if matches!(
            *flag,
            "--archive" | "--engine-archive" | "--network-tools-directory"
        ) && [archive, engine, packages]
            .into_iter()
            .flatten()
            .any(|v| v.starts_with("--"))
        {
            return Err(invalid());
        }
    }
    options.offline = match (archive, engine, packages) {
        (None, None, None)
            if !seen.contains("--archive")
                && !seen.contains("--engine-archive")
                && !seen.contains("--network-tools-directory") =>
        {
            None
        }
        (Some(a), Some(e), Some(p)) if !options.accept => Some((a, e, p)),
        _ => return Err(invalid()),
    };
    Ok(options)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn truthy_environment_matches_frontend_and_reuse_precedes_consent() {
        for value in ["1", "true", " YES ", "On", "TRUE"] {
            assert!(truthy_env(Some(value)));
        }
        for value in ["", "0", "false", "off", "unknown"] {
            assert!(!truthy_env(Some(value)));
        }
        assert!(!truthy_env(None));
        let root = std::env::temp_dir().canonicalize().unwrap();
        let candidate = Candidate::discover(&root).unwrap();
        let mut verified = false;
        run_with_reuse(&candidate, &["--no-interactive"], |_| {
            verified = true;
            Ok(Some(serde_json::json!({"status": "reused"})))
        })
        .unwrap();
        assert!(verified);
    }
    #[test]
    fn noninteractive_cli_requires_explicit_consent_before_writes() {
        struct Cleanup(std::path::PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let root = std::env::temp_dir().canonicalize().unwrap().join(format!(
            "setup-cli-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&root).unwrap();
        let _cleanup = Cleanup(root.clone());
        let candidate = Candidate::discover(&root).unwrap();
        assert_eq!(
            run(&candidate, &["--no-interactive"]).unwrap_err().code,
            "E_INTERACTIVE_REQUIRED"
        );
        assert!(!candidate.state_root.exists());
        #[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
        {
            assert_eq!(
                run(&candidate, &["--no-interactive", "--accept-downloads"])
                    .unwrap_err()
                    .code,
                "unsupported_host"
            );
            assert!(!candidate.state_root.exists());
        }
    }
    #[test]
    fn strict_options_and_complete_offline_set() {
        assert!(
            parse(&["--no-interactive", "--accept-downloads"])
                .unwrap()
                .accept
        );
        assert!(
            parse(&[
                "--archive",
                "/input/provider",
                "--engine-archive",
                "/input/engine",
                "--network-tools-directory",
                "/input/packages"
            ])
            .unwrap()
            .offline
            .is_some()
        );
        for args in [
            vec!["--archive"],
            vec!["--archive", "--json"],
            vec!["--json", "--json"],
            vec!["--unknown"],
            vec!["--archive", "/input/provider"],
        ] {
            assert!(parse(&args).is_err(), "{args:?}");
        }
    }
}
