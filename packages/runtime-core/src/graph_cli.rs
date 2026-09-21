#[cfg(target_os = "macos")]
mod environment;
mod normalized;
#[cfg(target_os = "macos")]
mod relay;
#[cfg(test)]
mod restore_tests;
mod routes;
mod service_io;
use hack_runtime_core::{
    Candidate, CandidateError,
    project::{PlanOptions, execution::Condition},
    provider::graph,
};
use serde_json::Value;
use std::{collections::BTreeMap, path::Path, time::Duration};
fn invalid() -> CandidateError {
    CandidateError::new(
        "graph_arguments",
        "Use graph run|restart|restore with --project, --file, --expect-plan, --run-id and --ready service=started|healthy|completed, plus --source-revision for source mounts; fresh run/serve may explicitly select --release-initializer-cache service for quiescent guest page/dentry cache release (package contents retained); explicit --live-source binds directory mounts to that initial acknowledged workspace revision; inspect/reconcile/cleanup/archive/export/reconcile-export/prune require --run-id. Cleanup alone may use --remove-data. Foreground serve additionally requires --dependencies and --expect-dependencies and accepts explicit --environment-stdin and --route-slot service=index for reviewed local routes; dependency-plan requires --dependencies; owner-status requires --run-id. Fresh foreground owner-restore requires exactly --run-id, --expect-plan, --expect-generation and --environment-stdin, plus optional --json. Bridge reservation requires --run-id, --service, --slot and --expect-generation; start/release require --run-id, --slot and --expect-reservation. bridges/reconcile-bridges require --run-id. Foreground publish-bridge requires --run-id, --slot, --expect-reservation and exactly one of --port or --unix (no --json); --unix accepts up to eight --hostname claims; unpublish-bridge requires --run-id and --expect-reservation.",
    )
}
pub fn command(candidate: &Candidate, args: &[&str]) -> Result<Value, CandidateError> {
    let Some((action, args)) = args.split_first() else {
        return Err(invalid());
    };
    if ["logs", "exec", "exec-selection"].contains(action) {
        return service_io::command(candidate, action, args);
    }
    let (arguments, normalized_selection) =
        crate::normalized_cli::extract(args, ["run", "serve", "serve-restore"].contains(action))?;
    let args = arguments.as_slice();
    if *action == "owner-restore" {
        let options = restore_options(args)?;
        #[cfg(target_os = "macos")]
        {
            use std::os::fd::{FromRawFd, OwnedFd};
            // All flags and identities are validated before stdin ownership moves.
            // SAFETY: F_GETFD checks validity without taking ownership.
            if unsafe { libc::fcntl(0, libc::F_GETFD) } < 0 {
                return Err(CandidateError::new(
                    "graph_environment_input",
                    "Private environment input was refused.",
                ));
            }
            // SAFETY: this explicit one-shot operation transfers checked stdin;
            // the private receiver validates descriptor type, bounds and EOF.
            let managed = environment::receive(
                unsafe { OwnedFd::from_raw_fd(0) },
                options.plan,
                options.run,
            )?;
            return graph::foreground::restore_request(
                candidate,
                options.run,
                options.plan,
                options.generation,
                &managed,
            );
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (options.run, options.plan, options.generation);
            return Err(CandidateError::new(
                "unsupported_host",
                "Foreground graph restore requires macOS.",
            ));
        }
    }
    if *action == "dependency-plan" {
        let path = match *args {
            ["--dependencies", path] | ["--dependencies", path, "--json"] => Path::new(path),
            _ => return Err(invalid()),
        };
        #[cfg(target_os = "macos")]
        {
            return relay::plan(path);
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = path;
            return Err(CandidateError::new(
                "unsupported_host",
                "Graph dependency ownership requires macOS.",
            ));
        }
    }
    if *action == "storage-inventory" {
        return if args.is_empty() || *args == ["--json"] {
            graph::storage_inventory(candidate)
        } else {
            Err(invalid())
        };
    }
    if ![
        "run",
        "serve",
        "serve-restore",
        "restore-selection",
        "owner-status",
        "restart",
        "restore",
        "inspect",
        "reconcile",
        "cleanup",
        "recover-cleanup",
        "archive",
        "export",
        "reconcile-export",
        "prune",
        "reserve-bridge",
        "release-bridge",
        "start-bridge",
        "publish-bridge",
        "unpublish-bridge",
        "bridges",
        "reconcile-bridges",
    ]
    .contains(action)
    {
        return Err(invalid());
    }
    let mut singles = BTreeMap::new();
    let mut readiness = BTreeMap::new();
    let mut route_slots = BTreeMap::new();
    let mut release_initializer_cache = std::collections::BTreeSet::new();
    let mut profiles = Vec::new();
    let mut remove_data = false;
    let mut environment_stdin = false;
    let mut live_source = false;
    let mut shared_source = false;
    let mut json = false;
    let mut unix = false;
    let mut hostnames = Vec::new();
    let mut index = 0;
    while index < args.len() {
        let key = args[index];
        index += 1;
        if key == "--shared-source" {
            if shared_source
                || live_source
                || !["run", "serve", "serve-restore", "restart", "restore"].contains(action)
            {
                return Err(invalid());
            }
            shared_source = true;
            continue;
        }
        if key == "--live-source" {
            if live_source
                || shared_source
                || !["run", "serve", "serve-restore", "restart", "restore"].contains(action)
            {
                return Err(invalid());
            }
            live_source = true;
            continue;
        }
        if key == "--environment-stdin" {
            if environment_stdin || !["serve", "serve-restore"].contains(action) {
                return Err(invalid());
            }
            environment_stdin = true;
            continue;
        }
        if key == "--unix" {
            if unix || *action != "publish-bridge" {
                return Err(invalid());
            }
            unix = true;
            continue;
        }
        if key == "--json" {
            if json {
                return Err(invalid());
            }
            json = true;
            continue;
        }
        if key == "--remove-data" {
            if remove_data || *action != "cleanup" {
                return Err(invalid());
            }
            remove_data = true;
            continue;
        }
        let value = *args.get(index).ok_or_else(invalid)?;
        index += 1;
        if key == "--release-initializer-cache" && ["run", "serve"].contains(action) {
            if release_initializer_cache.len() >= 32
                || value.is_empty()
                || value.len() > 64
                || !value
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
                || !release_initializer_cache.insert(value.to_owned())
            {
                return Err(invalid());
            }
        } else if key == "--route-slot" && ["serve", "serve-restore"].contains(action) {
            routes::insert(&mut route_slots, value)?;
        } else if key == "--hostname" && *action == "publish-bridge" {
            if hostnames.len() >= 8 {
                return Err(invalid());
            }
            hostnames.push(
                hack_runtime_core::provider::publication::normalize_hostname(value)
                    .map_err(|_| invalid())?,
            );
        } else if key == "--ready"
            && ["run", "serve", "serve-restore", "restart", "restore"].contains(action)
        {
            let (service, condition) = value.split_once('=').ok_or_else(invalid)?;
            let condition = match condition {
                "started" => Condition::Started,
                "healthy" => Condition::Healthy,
                "completed" => Condition::Completed,
                _ => return Err(invalid()),
            };
            if readiness.insert(service.to_owned(), condition).is_some() {
                return Err(invalid());
            }
        } else if key == "--profile"
            && ["run", "serve", "serve-restore", "restart", "restore"].contains(action)
        {
            profiles.push(value.to_owned());
        } else if ([
            "reserve-bridge",
            "release-bridge",
            "start-bridge",
            "publish-bridge",
        ]
        .contains(action)
            && key == "--slot")
            || (*action == "reserve-bridge" && ["--service", "--expect-generation"].contains(&key))
            || ([
                "release-bridge",
                "start-bridge",
                "publish-bridge",
                "unpublish-bridge",
            ]
            .contains(action)
                && key == "--expect-reservation")
            || (*action == "publish-bridge" && key == "--port")
            || (["serve", "serve-restore"].contains(action)
                && ["--dependencies", "--expect-dependencies"].contains(&key))
            || (*action == "serve-restore" && key == "--expect-generation")
            || (*action == "recover-cleanup" && key == "--expect-receipt")
            || key == "--run-id"
            || (["run", "serve", "serve-restore", "restart", "restore"].contains(action)
                && [
                    "--project",
                    "--file",
                    "--expect-plan",
                    "--source-revision",
                    "--timeout-seconds",
                ]
                .contains(&key))
        {
            if singles.insert(key, value).is_some() {
                return Err(invalid());
            }
        } else {
            return Err(invalid());
        }
    }
    if live_source && normalized_selection.is_some() {
        return Err(CandidateError::new(
            "normalized_live_source_unsupported",
            "Normalized graphs currently require immutable source; live source is not supported.",
        ));
    }
    if live_source && !singles.contains_key("--source-revision") {
        return Err(invalid());
    }
    let run = *singles.get("--run-id").ok_or_else(invalid)?;
    let encode = |v| {
        serde_json::to_value(v)
            .map_err(|_| CandidateError::new("graph_output", "Cannot encode graph receipt."))
    };
    match *action {
        "restore-selection" => {
            #[cfg(target_os = "macos")]
            {
                graph::foreground::restore_selection(candidate, run)
            }
            #[cfg(not(target_os = "macos"))]
            {
                Err(invalid())
            }
        }
        "reserve-bridge" => serde_json::to_value(graph::reserve_bridge(
            candidate,
            graph::ReserveBridgeOptions {
                run,
                service: singles.get("--service").copied().ok_or_else(invalid)?,
                slot: singles
                    .get("--slot")
                    .ok_or_else(invalid)?
                    .parse()
                    .map_err(|_| invalid())?,
                expected_generation: singles
                    .get("--expect-generation")
                    .copied()
                    .ok_or_else(invalid)?,
            },
        )?)
        .map_err(|_| invalid()),
        "publish-bridge" => {
            if json || unix == singles.contains_key("--port") || (!unix && !hostnames.is_empty()) {
                return Err(invalid());
            }
            graph::publish_bridge(
                candidate,
                run,
                singles
                    .get("--slot")
                    .ok_or_else(invalid)?
                    .parse()
                    .map_err(|_| invalid())?,
                singles
                    .get("--expect-reservation")
                    .copied()
                    .ok_or_else(invalid)?,
                singles
                    .get("--port")
                    .map(|value| value.parse().map_err(|_| invalid()))
                    .transpose()?,
                &hostnames,
            )?;
            unreachable!("successful publication replaces the foreground process")
        }
        "unpublish-bridge" => {
            hack_runtime_core::provider::publication::unpublish(
                candidate,
                run,
                singles
                    .get("--expect-reservation")
                    .copied()
                    .ok_or_else(invalid)?,
            )?;
            Ok(serde_json::json!({"run":run,"unpublished":true}))
        }
        "start-bridge" => serde_json::to_value(graph::start_bridge(
            candidate,
            run,
            singles
                .get("--slot")
                .ok_or_else(invalid)?
                .parse()
                .map_err(|_| invalid())?,
            singles
                .get("--expect-reservation")
                .copied()
                .ok_or_else(invalid)?,
        )?)
        .map_err(|_| invalid()),
        "release-bridge" => graph::release_bridge(
            candidate,
            run,
            singles
                .get("--slot")
                .ok_or_else(invalid)?
                .parse()
                .map_err(|_| invalid())?,
            singles
                .get("--expect-reservation")
                .copied()
                .ok_or_else(invalid)?,
        ),
        "bridges" => graph::inspect_bridges(candidate, run),
        "reconcile-bridges" => graph::reconcile_bridges(candidate, run),
        "prune" => graph::prune(candidate, run),
        "reconcile-export" => graph::reconcile_export(candidate, run),
        "inspect" => serde_json::to_value(graph::inspect(candidate, run)?)
            .map_err(|_| CandidateError::new("graph_output", "Cannot encode graph snapshot.")),
        "export" => serde_json::to_value(graph::export(candidate, run)?)
            .map_err(|_| CandidateError::new("graph_output", "Cannot encode graph export.")),
        "archive" => encode(graph::archive(candidate, run)?),
        "reconcile" => encode(graph::reconcile(candidate, run)?),
        "owner-status" => {
            #[cfg(target_os = "macos")]
            {
                graph::foreground::request(candidate, run, None)
            }
            #[cfg(not(target_os = "macos"))]
            {
                Err(CandidateError::new(
                    "unsupported_host",
                    "Graph dependency ownership requires macOS.",
                ))
            }
        }
        "recover-cleanup" => {
            let expected = *singles.get("--expect-receipt").ok_or_else(invalid)?;
            #[cfg(target_os = "macos")]
            {
                graph::recover_cleanup(candidate, run, expected)
            }
            #[cfg(not(target_os = "macos"))]
            {
                let _ = expected;
                Err(invalid())
            }
        }
        "cleanup" => {
            #[cfg(target_os = "macos")]
            if graph::inspect(candidate, run)?
                .receipt
                .relay_startup
                .is_some()
            {
                return graph::foreground::cleanup_request(candidate, run, remove_data);
            }
            encode(graph::cleanup(candidate, run, remove_data)?)
        }
        _ => {
            let project = *singles.get("--project").ok_or_else(invalid)?;
            let file = *singles.get("--file").ok_or_else(invalid)?;
            let expected = *singles.get("--expect-plan").ok_or_else(invalid)?;
            let timeout = singles
                .get("--timeout-seconds")
                .map(|s| s.parse::<u64>().map_err(|_| invalid()))
                .transpose()?
                .unwrap_or(30);
            let values = BTreeMap::new();
            let options = graph::RunOptions {
                routing_enrolled: !route_slots.is_empty(),
                project: PlanOptions {
                    project: Path::new(project),
                    compose_file: Path::new(file),
                    profiles: &profiles,
                },
                expected_plan: expected,
                source_revision: singles.get("--source-revision").copied(),
                live_source,
                shared_source,
                release_initializer_cache,
                non_secret_values: &values,
                readiness: &readiness,
                run_id: run,
                timeout: Duration::from_secs(timeout),
            };
            if let Some(selection) = &normalized_selection {
                let input = selection.load()?;
                let compose = input.options(PlanOptions {
                    project: options.project.project,
                    compose_file: options.project.compose_file,
                    profiles: options.project.profiles,
                });
                return normalized::command(
                    candidate,
                    action,
                    graph::NormalizedRunOptions {
                        run: options,
                        compose,
                    },
                    &singles,
                    &route_slots,
                    environment_stdin,
                );
            }
            if *action == "serve-restore" {
                return Err(invalid());
            }
            if *action == "serve" {
                #[cfg(target_os = "macos")]
                {
                    // Refuse stale or non-executable input before constructing relay owners.
                    // Graph execution still recompiles at its own admission boundary.
                    let managed = if environment_stdin {
                        use std::os::fd::{FromRawFd, OwnedFd};
                        // SAFETY: F_GETFD checks descriptor validity without taking ownership.
                        if unsafe { libc::fcntl(0, libc::F_GETFD) } < 0 {
                            return Err(CandidateError::new(
                                "graph_environment_input",
                                "Private environment input was refused.",
                            ));
                        }
                        // SAFETY: the explicit flag transfers checked stdin ownership once.
                        // The receiver validates its type, byte budget and EOF.
                        Some(environment::receive(
                            unsafe { OwnedFd::from_raw_fd(0) },
                            expected,
                            run,
                        )?)
                    } else {
                        None
                    };
                    let plan_options = PlanOptions {
                        project: options.project.project,
                        compose_file: options.project.compose_file,
                        profiles: options.project.profiles,
                    };
                    let inputs = if let Some(managed) = &managed {
                        hack_runtime_core::project::inputs::compile_scoped(
                            candidate,
                            plan_options,
                            expected,
                            options.non_secret_values,
                            managed.values(),
                        )?
                        .executable
                    } else {
                        hack_runtime_core::project::inputs::compile(
                            candidate,
                            plan_options,
                            expected,
                            options.non_secret_values,
                        )?
                    };
                    if let Some(managed) = &managed {
                        managed.remaining()?;
                    }
                    let runtime = relay::runtime(
                        candidate,
                        Path::new(singles.get("--dependencies").copied().ok_or_else(invalid)?),
                        expected,
                        singles
                            .get("--expect-dependencies")
                            .copied()
                            .ok_or_else(invalid)?,
                        &inputs,
                        run,
                    )?;
                    return encode(if let Some(managed) = &managed {
                        graph::foreground::serve_with_routes(
                            candidate,
                            options,
                            runtime,
                            managed.values(),
                            managed.deadline(),
                            &route_slots,
                        )?
                    } else {
                        graph::foreground::serve_with_routes(
                            candidate,
                            options,
                            runtime,
                            &BTreeMap::new(),
                            std::time::Instant::now() + Duration::from_secs(120),
                            &route_slots,
                        )?
                    });
                }
                #[cfg(not(target_os = "macos"))]
                {
                    return Err(CandidateError::new(
                        "unsupported_host",
                        "Graph dependency ownership requires macOS.",
                    ));
                }
            }
            encode(if *action == "run" {
                graph::run(candidate, options)?
            } else if *action == "restore" {
                graph::restore(candidate, options)?
            } else {
                graph::restart(candidate, options)?
            })
        }
    }
}

struct RestoreOptions<'a> {
    run: &'a str,
    plan: &'a str,
    generation: &'a str,
}
fn restore_options<'a>(args: &[&'a str]) -> Result<RestoreOptions<'a>, CandidateError> {
    let mut run = None;
    let mut plan = None;
    let mut generation = None;
    let mut environment = false;
    let mut json = false;
    let mut arguments = args.iter().copied();
    while let Some(flag) = arguments.next() {
        match flag {
            "--run-id" if run.is_none() => run = Some(arguments.next().ok_or_else(invalid)?),
            "--expect-plan" if plan.is_none() => plan = Some(arguments.next().ok_or_else(invalid)?),
            "--expect-generation" if generation.is_none() => {
                generation = Some(arguments.next().ok_or_else(invalid)?)
            }
            "--environment-stdin" if !environment => environment = true,
            "--json" if !json => json = true,
            _ => return Err(invalid()),
        }
    }
    let options = RestoreOptions {
        run: run.ok_or_else(invalid)?,
        plan: plan.ok_or_else(invalid)?,
        generation: generation.ok_or_else(invalid)?,
    };
    let valid = |value: &str, length: usize| {
        value.len() == length
            && value
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    };
    if !environment
        || !valid(options.run, 32)
        || !valid(options.plan, 64)
        || !valid(options.generation, 64)
    {
        return Err(invalid());
    }
    Ok(options)
}
