//! Explicit pool socket options. Parse completely before runtime discovery or mutation.
use hack_runtime_core::{
    CandidateError,
    provider::{BridgeIntent, DependencySocketIntent, NetworkIntent, Profile},
};
use std::path::PathBuf;

pub struct Options {
    pub profile: Profile,
    pub network: Option<NetworkIntent>,
    pub bridges: Option<BridgeIntent>,
    pub dependencies: Option<DependencySocketIntent>,
    pub project_share: Option<PathBuf>,
}

fn invalid() -> CandidateError {
    CandidateError::new(
        "invalid_arguments",
        "Use runtime up --profile research|development with --bridge-sockets and/or --dependency-sockets, each once, repeatable --allow-host HOST, plus optional --json. Direct project sharing requires --profile development --project-share PATH --unfiltered-source together; it exposes the exact project tree without snapshot exclusions.",
    )
}

pub fn parse(args: &[&str]) -> Result<Options, CandidateError> {
    let mut profile = None;
    let mut bridges = None;
    let mut dependencies = None;
    let mut json = false;
    let mut hosts = Vec::new();
    let mut internet = false;
    let mut project_share = None;
    let mut unfiltered_source = false;
    let mut args = args.iter();
    while let Some(key) = args.next() {
        match *key {
            "--project-share" if project_share.is_none() => {
                let path = PathBuf::from(args.next().ok_or_else(invalid)?);
                if !path.is_absolute() {
                    return Err(invalid());
                }
                project_share = Some(path);
            }
            "--unfiltered-source" if !unfiltered_source => unfiltered_source = true,
            "--internet" if !internet => internet = true,
            "--allow-host" => hosts.push(args.next().ok_or_else(invalid)?.to_string()),
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
    let profile = profile.ok_or_else(invalid)?;
    if (internet && !hosts.is_empty())
        || unfiltered_source != project_share.is_some()
        || (project_share.is_some() && profile != Profile::Development)
        || (bridges.is_none()
            && dependencies.is_none()
            && hosts.is_empty()
            && !internet
            && project_share.is_none())
    {
        return Err(invalid());
    }
    let network = if internet {
        Some(NetworkIntent::Internet)
    } else if hosts.is_empty() {
        None
    } else {
        Some(NetworkIntent::approved_hosts(hosts)?)
    };
    Ok(Options {
        network,
        profile,
        bridges,
        dependencies,
        project_share,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn internet_mode_is_explicit_and_conflicts_with_allowlisting() {
        let args = ["--profile", "development", "--internet", "--json"];
        assert_eq!(parse(&args).unwrap().network, Some(NetworkIntent::Internet));
        for suffix in [vec!["--internet"], vec!["--allow-host", "example.com"]] {
            let mut bad = args.to_vec();
            bad.extend(suffix);
            assert!(parse(&bad).is_err());
        }
        assert!(
            parse(&["--profile", "development", "--bridge-sockets", "1"])
                .unwrap()
                .network
                .is_none()
        );
    }
    #[test]
    fn unfiltered_share_requires_explicit_pair_and_development_profile() {
        let good = [
            "--profile",
            "development",
            "--project-share",
            "/fixture/project",
            "--unfiltered-source",
            "--json",
        ];
        assert_eq!(
            parse(&good).unwrap().project_share,
            Some(PathBuf::from("/fixture/project"))
        );
        for args in [
            vec![
                "--profile",
                "development",
                "--project-share",
                "/fixture/project",
            ],
            vec!["--profile", "development", "--unfiltered-source"],
            vec![
                "--profile",
                "research",
                "--project-share",
                "/fixture/project",
                "--unfiltered-source",
            ],
            vec![
                "--profile",
                "development",
                "--project-share",
                "relative",
                "--unfiltered-source",
            ],
            vec![
                "--profile",
                "development",
                "--project-share",
                "/fixture/project",
                "--unfiltered-source",
                "--unfiltered-source",
            ],
            vec![
                "--profile",
                "development",
                "--project-share",
                "/fixture/project",
                "--unfiltered-source",
                "--project-share",
                "/fixture/other",
            ],
        ] {
            assert!(parse(&args).is_err());
        }
    }

    #[test]
    fn approved_hosts_are_explicit_repeatable_and_composable() {
        let options = parse(&[
            "--profile",
            "development",
            "--allow-host",
            "two.example.com",
            "--dependency-sockets",
            "2",
            "--allow-host",
            "one.example.com",
        ])
        .unwrap();
        assert_eq!(
            options.network,
            Some(
                NetworkIntent::approved_hosts(vec![
                    "one.example.com".into(),
                    "two.example.com".into()
                ])
                .unwrap()
            )
        );
        assert!(
            parse(&[
                "--profile",
                "development",
                "--allow-host",
                "one.example.com",
                "--allow-host",
                "one.example.com"
            ])
            .is_err()
        );
    }

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
