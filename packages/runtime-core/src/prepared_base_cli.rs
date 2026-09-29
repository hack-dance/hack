//! `runtime prepared-base build|verify|status|remove`. Parse completely before any effect.
use hack_runtime_core::{CandidateError, provider::Profile};
use std::path::PathBuf;

/// One prepared-base store command.
#[derive(Debug, PartialEq, Eq)]
pub enum Command {
    Build {
        store: Option<PathBuf>,
        profile: Profile,
        base_id: Option<String>,
    },
    Verify {
        store: Option<PathBuf>,
        base_id: String,
    },
    Status {
        store: Option<PathBuf>,
        profile: Profile,
    },
    Remove {
        store: Option<PathBuf>,
        base_id: String,
    },
}

fn invalid() -> CandidateError {
    CandidateError::new(
        "invalid_arguments",
        "Use runtime prepared-base build --profile research|development [--base-id ID], verify --base-id ID, status --profile research|development, or remove --base-id ID; each with optional absolute --store PATH (required outside an installed home) and --json.",
    )
}

pub fn parse(action: &str, args: &[&str]) -> Result<Command, CandidateError> {
    let mut store = None;
    let mut profile = None;
    let mut base_id = None;
    let mut json = false;
    let mut args = args.iter();
    while let Some(key) = args.next() {
        match *key {
            "--store" if store.is_none() => {
                let path = PathBuf::from(args.next().ok_or_else(invalid)?);
                if !path.is_absolute() {
                    return Err(invalid());
                }
                store = Some(path);
            }
            "--profile" if profile.is_none() => {
                profile = Some(match args.next().copied() {
                    Some("research") => Profile::Research,
                    Some("development") => Profile::Development,
                    _ => return Err(invalid()),
                });
            }
            "--base-id" if base_id.is_none() => {
                base_id = Some(args.next().ok_or_else(invalid)?.to_string());
            }
            "--json" if !json => json = true,
            _ => return Err(invalid()),
        }
    }
    Ok(match (action, profile, base_id) {
        ("build", Some(profile), base_id) => Command::Build {
            store,
            profile,
            base_id,
        },
        ("verify", None, Some(base_id)) => Command::Verify { store, base_id },
        ("status", Some(profile), None) => Command::Status { store, profile },
        ("remove", None, Some(base_id)) => Command::Remove { store, base_id },
        _ => return Err(invalid()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_action_requires_exactly_its_inputs() {
        assert_eq!(
            parse("build", &["--profile", "development", "--json"]).unwrap(),
            Command::Build {
                store: None,
                profile: Profile::Development,
                base_id: None,
            }
        );
        assert_eq!(
            parse("verify", &["--store", "/private/store", "--base-id", "b-1"]).unwrap(),
            Command::Verify {
                store: Some(PathBuf::from("/private/store")),
                base_id: "b-1".into(),
            }
        );
        for (action, args) in [
            ("build", &["--base-id", "b-1"][..]),
            ("verify", &["--profile", "research", "--base-id", "b-1"][..]),
            ("status", &[][..]),
            ("remove", &["--profile", "research"][..]),
            (
                "build",
                &["--profile", "research", "--store", "relative"][..],
            ),
            ("build", &["--profile", "research", "--json", "--json"][..]),
            ("delete", &["--base-id", "b-1"][..]),
        ] {
            assert!(parse(action, args).is_err(), "{action} {args:?}");
        }
    }
}
