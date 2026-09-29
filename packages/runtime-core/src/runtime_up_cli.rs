//! Explicit pool socket options. Parse completely before runtime discovery or mutation.
use hack_runtime_core::{
    CandidateError,
    provider::{
        BridgeIntent, DependencySocketIntent, NetworkIntent, Profile, prepared_start::Mode,
    },
};
use std::path::PathBuf;

pub struct Options {
    pub profile: Profile,
    pub network: Option<NetworkIntent>,
    pub bridges: Option<BridgeIntent>,
    pub minimum_bridges: Option<BridgeIntent>,
    pub dependencies: Option<DependencySocketIntent>,
    pub minimum_dependencies: Option<DependencySocketIntent>,
    pub project_share: Option<PathBuf>,
    pub retained: Option<(String, String)>,
    /// `--prepared-base MODE` and optional `--prepared-base-store ABS` for a fresh pool.
    pub prepared: Option<(Mode, Option<PathBuf>)>,
}

fn invalid() -> CandidateError {
    CandidateError::new(
        "invalid_arguments",
        "Use runtime up --profile research|development with --bridge-sockets or --minimum-bridge-sockets, and/or --dependency-sockets or --minimum-dependency-sockets, each once, repeatable --allow-host HOST, plus optional --json. Direct project sharing requires --profile development --project-share PATH --unfiltered-source together; it exposes the exact project tree without snapshot exclusions. A fresh pool may request a prepared base with --prepared-base prefer|require and optional absolute --prepared-base-store PATH.",
    )
}

pub fn parse(args: &[&str]) -> Result<Options, CandidateError> {
    let mut profile = None;
    let mut bridges = None;
    let mut minimum_bridges = None;
    let mut dependencies = None;
    let mut minimum_dependencies = None;
    let mut json = false;
    let mut hosts = Vec::new();
    let mut internet = false;
    let mut project_share = None;
    let mut unfiltered_source = false;
    let mut retained_run = None;
    let mut retained_selection = None;
    let mut prepared = None;
    let mut prepared_store = None;
    let mut args = args.iter();
    while let Some(key) = args.next() {
        match *key {
            "--expect-retained-run" if retained_run.is_none() => {
                retained_run = Some(args.next().ok_or_else(invalid)?.to_string());
            }
            "--expect-retained-selection" if retained_selection.is_none() => {
                retained_selection = Some(args.next().ok_or_else(invalid)?.to_string());
            }
            "--project-share" if project_share.is_none() => {
                let path = PathBuf::from(args.next().ok_or_else(invalid)?);
                if !path.is_absolute() {
                    return Err(invalid());
                }
                project_share = Some(path);
            }
            "--prepared-base" if prepared.is_none() => {
                prepared = Some(
                    args.next()
                        .and_then(|mode| Mode::parse(mode))
                        .ok_or_else(invalid)?,
                );
            }
            "--prepared-base-store" if prepared_store.is_none() => {
                let path = PathBuf::from(args.next().ok_or_else(invalid)?);
                if !path.is_absolute() {
                    return Err(invalid());
                }
                prepared_store = Some(path);
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
            "--bridge-sockets" if bridges.is_none() && minimum_bridges.is_none() => {
                let count = args.next().ok_or_else(invalid)?;
                bridges = Some(BridgeIntent::new(count.parse().map_err(|_| invalid())?)?);
            }
            "--minimum-bridge-sockets" if minimum_bridges.is_none() && bridges.is_none() => {
                let count = args.next().ok_or_else(invalid)?;
                minimum_bridges = Some(BridgeIntent::new(count.parse().map_err(|_| invalid())?)?);
            }
            "--dependency-sockets" if dependencies.is_none() && minimum_dependencies.is_none() => {
                let count = args.next().ok_or_else(invalid)?;
                dependencies = Some(DependencySocketIntent::new(
                    count.parse().map_err(|_| invalid())?,
                )?);
            }
            "--minimum-dependency-sockets"
                if minimum_dependencies.is_none() && dependencies.is_none() =>
            {
                let count = args.next().ok_or_else(invalid)?;
                minimum_dependencies = Some(DependencySocketIntent::new(
                    count.parse().map_err(|_| invalid())?,
                )?);
            }
            _ => return Err(invalid()),
        }
    }
    let profile = profile.ok_or_else(invalid)?;
    let retained = match (retained_run, retained_selection) {
        (None, None) => None,
        (Some(run), Some(selection))
            if run.len() == 32
                && selection.len() == 64
                && run
                    .bytes()
                    .chain(selection.bytes())
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                && project_share.is_some()
                && profile == Profile::Development =>
        {
            Some((run, selection))
        }
        _ => return Err(invalid()),
    };
    if (internet && !hosts.is_empty())
        || (prepared_store.is_some() && prepared.is_none())
        || unfiltered_source != project_share.is_some()
        || (project_share.is_some() && profile != Profile::Development)
        || (bridges.is_none()
            && minimum_bridges.is_none()
            && dependencies.is_none()
            && minimum_dependencies.is_none()
            && hosts.is_empty()
            && !internet
            && project_share.is_none()
            && prepared.is_none())
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
        minimum_bridges,
        dependencies,
        minimum_dependencies,
        project_share,
        retained,
        prepared: prepared.map(|mode| (mode, prepared_store)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prepared_base_composes_with_minimum_dependency_capacity() {
        let options = parse(&[
            "--profile",
            "development",
            "--minimum-dependency-sockets",
            "2",
            "--prepared-base",
            "require",
        ])
        .unwrap();
        assert_eq!(options.minimum_dependencies.unwrap().slots, 2);
        assert_eq!(options.dependencies, None);
        assert_eq!(options.prepared, Some((Mode::Require, None)));
    }

    #[test]
    fn prepared_base_is_an_explicit_mode_with_an_optional_absolute_store() {
        let options = parse(&["--profile", "development", "--prepared-base", "prefer"]).unwrap();
        assert_eq!(options.prepared, Some((Mode::Prefer, None)));
        let options = parse(&[
            "--profile",
            "research",
            "--minimum-bridge-sockets",
            "1",
            "--prepared-base",
            "require",
            "--prepared-base-store",
            "/private/store",
        ])
        .unwrap();
        assert_eq!(
            options.prepared,
            Some((Mode::Require, Some(PathBuf::from("/private/store"))))
        );
        for args in [
            &["--profile", "development", "--prepared-base", "off"][..],
            &[
                "--profile",
                "development",
                "--prepared-base-store",
                "/private/store",
            ][..],
            &[
                "--profile",
                "development",
                "--prepared-base",
                "prefer",
                "--prepared-base-store",
                "relative",
            ][..],
            &[
                "--profile",
                "development",
                "--prepared-base",
                "prefer",
                "--prepared-base",
                "require",
            ][..],
        ] {
            assert!(parse(args).is_err(), "{args:?}");
        }
    }

    #[test]
    fn minimum_dependency_capacity_requires_one_unambiguous_bounded_selection() {
        let base = [
            "--profile",
            "development",
            "--minimum-dependency-sockets",
            "4",
        ];
        let options = parse(&base).unwrap();
        assert_eq!(
            options.minimum_dependencies,
            Some(DependencySocketIntent::new(4).unwrap())
        );
        assert_eq!(options.dependencies, None);
        for suffix in [
            vec!["--dependency-sockets", "4"],
            vec!["--minimum-dependency-sockets", "4"],
        ] {
            let mut args = base.to_vec();
            args.extend(suffix);
            assert!(parse(&args).is_err());
        }
        assert!(
            parse(&[
                "--profile",
                "development",
                "--dependency-sockets",
                "4",
                "--minimum-dependency-sockets",
                "1"
            ])
            .is_err()
        );
        for count in ["0", "33", "-1", "invalid"] {
            assert!(
                parse(&[
                    "--profile",
                    "development",
                    "--minimum-dependency-sockets",
                    count
                ])
                .is_err()
            );
        }
        assert!(parse(&["--profile", "development", "--minimum-dependency-sockets"]).is_err());
        let mut both = base.to_vec();
        both.extend(["--minimum-bridge-sockets", "8"]);
        let options = parse(&both).unwrap();
        assert_eq!(options.minimum_bridges.unwrap().slots, 8);
        assert_eq!(options.minimum_dependencies.unwrap().slots, 4);
    }

    #[test]
    fn minimum_bridge_capacity_is_bounded_and_exclusive_with_exact_selection() {
        let base = ["--profile", "development", "--minimum-bridge-sockets", "4"];
        let options = parse(&base).unwrap();
        assert_eq!(options.minimum_bridges, Some(BridgeIntent::new(4).unwrap()));
        assert_eq!(options.bridges, None);
        for suffix in [
            vec!["--bridge-sockets", "4"],
            vec!["--minimum-bridge-sockets", "4"],
        ] {
            let mut args = base.to_vec();
            args.extend(suffix);
            assert!(parse(&args).is_err());
        }
        assert!(
            parse(&[
                "--profile",
                "development",
                "--bridge-sockets",
                "4",
                "--minimum-bridge-sockets",
                "1",
            ])
            .is_err()
        );
        for count in ["0", "33", "-1", "invalid"] {
            assert!(
                parse(&[
                    "--profile",
                    "development",
                    "--minimum-bridge-sockets",
                    count
                ])
                .is_err()
            );
        }
        assert!(parse(&["--profile", "development", "--minimum-bridge-sockets"]).is_err());
    }

    #[test]
    fn retained_selection_requires_one_exact_paired_development_share() {
        let run = "a".repeat(32);
        let selection = "b".repeat(64);
        let base = [
            "--profile",
            "development",
            "--project-share",
            "/fixture",
            "--unfiltered-source",
        ];
        let mut args = base.to_vec();
        args.extend([
            "--expect-retained-run",
            &run,
            "--expect-retained-selection",
            &selection,
        ]);
        assert_eq!(
            parse(&args).unwrap().retained,
            Some((run.clone(), selection.clone()))
        );
        for suffix in [
            vec!["--expect-retained-run", &run],
            vec!["--expect-retained-selection", &selection],
            vec![
                "--expect-retained-run",
                "bad",
                "--expect-retained-selection",
                &selection,
            ],
            vec![
                "--expect-retained-run",
                &run,
                "--expect-retained-selection",
                "bad",
            ],
            vec![
                "--expect-retained-run",
                &run,
                "--expect-retained-run",
                &run,
                "--expect-retained-selection",
                &selection,
            ],
        ] {
            let mut bad = base.to_vec();
            bad.extend(suffix);
            assert!(parse(&bad).is_err());
        }
        assert!(
            parse(&[
                "--profile",
                "development",
                "--internet",
                "--expect-retained-run",
                &run,
                "--expect-retained-selection",
                &selection
            ])
            .is_err()
        );
    }

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
