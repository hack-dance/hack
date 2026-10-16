//! Explicit pool socket options. Parse completely before runtime discovery or mutation.
use hack_runtime_core::{
    CandidateError,
    provider::{BridgeIntent, DependencySocketIntent, Profile},
};

pub struct Options {
    pub profile: Profile,
    pub bridges: Option<BridgeIntent>,
    pub dependencies: Option<DependencySocketIntent>,
}

fn invalid() -> CandidateError {
    CandidateError::new(
        "invalid_arguments",
        "Use runtime up --profile research|development with --bridge-sockets and/or --dependency-sockets, each once, plus optional --json.",
    )
}

pub fn parse(args: &[&str]) -> Result<Options, CandidateError> {
    let mut profile = None;
    let mut bridges = None;
    let mut dependencies = None;
    let mut json = false;
    let mut args = args.iter();
    while let Some(key) = args.next() {
        match *key {
            "--json" if !json => json = true,
            "--profile" if profile.is_none() => {
                profile = Some(match args.next().copied() {
                    Some("research") => Profile::Research,
                    Some("development") => Profile::Development,
                    _ => return Err(invalid()),
                });
            }
            "--bridge-sockets" if bridges.is_none() => {
                let count = args.next().ok_or_else(invalid)?;
                bridges = Some(BridgeIntent::new(count.parse().map_err(|_| invalid())?)?);
            }
            "--dependency-sockets" if dependencies.is_none() => {
                let count = args.next().ok_or_else(invalid)?;
                dependencies = Some(DependencySocketIntent::new(
                    count.parse().map_err(|_| invalid())?,
                )?);
            }
            _ => return Err(invalid()),
        }
    }
    if bridges.is_none() && dependencies.is_none() {
        return Err(invalid());
    }
    Ok(Options {
        profile: profile.ok_or_else(invalid)?,
        bridges,
        dependencies,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn combines_distinct_socket_directions_without_order_dependence() {
        for args in [
            vec![
                "--profile",
                "development",
                "--bridge-sockets",
                "2",
                "--dependency-sockets",
                "3",
                "--json",
            ],
            vec![
                "--dependency-sockets",
                "3",
                "--json",
                "--bridge-sockets",
                "2",
                "--profile",
                "development",
            ],
        ] {
            let options = parse(&args).unwrap();
            assert_eq!(options.profile, Profile::Development);
            assert_eq!(options.bridges.unwrap().slots, 2);
            assert_eq!(options.dependencies.unwrap().slots, 3);
        }
        let options = parse(&["--profile", "research", "--dependency-sockets", "1"]).unwrap();
        assert!(options.bridges.is_none());
        assert_eq!(options.profile, Profile::Research);
    }

    #[test]
    fn rejects_ambiguous_or_incomplete_requests_before_effects() {
        for args in [
            vec!["--dependency-sockets", "1"],
            vec!["--profile", "development", "--dependency-sockets"],
            vec!["--profile", "development", "--dependency-sockets", "0"],
            vec!["--profile", "development", "--dependency-sockets", "33"],
            vec![
                "--profile",
                "development",
                "--dependency-sockets",
                "1",
                "--dependency-sockets",
                "2",
            ],
            vec![
                "--profile",
                "development",
                "--bridge-sockets",
                "1",
                "--bridge-sockets",
                "2",
            ],
            vec![
                "--profile",
                "development",
                "--dependency-sockets",
                "1",
                "--profile",
                "research",
            ],
            vec![
                "--profile",
                "development",
                "--dependency-sockets",
                "1",
                "--json",
                "--json",
            ],
            vec![
                "--profile",
                "development",
                "--dependency-sockets",
                "1",
                "--host-socket",
                "/tmp/foreign",
            ],
        ] {
            assert!(parse(&args).is_err(), "{args:?}");
        }
    }
}
