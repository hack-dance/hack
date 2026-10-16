mod graph_cli;
use hack_runtime_core::{CANDIDATE_VERSION, Candidate, CandidateError};
use serde::Serialize;
use std::path::Path;

const HELP: &str =
    "Hack local v5 candidate (source sync and immutable jobs in development)

Usage:
  hack-local info [--json]
  hack-local plan --project <directory> [--json]
  hack-local project plan --project <directory> --file <compose.yaml> [--profile <name>] [--json]
  hack-local project enroll --project <directory> --file <compose.yaml> --expect-plan <sha256> [--profile <name>] [--json]
  hack-local project status --project <directory> [--json]
  hack-local project sync-source --project <directory> --file <compose.yaml> --expect-plan <sha256> [--watch] [--reconcile] [--duration-seconds <seconds>] [--json]
  hack-local project sync-status --project <directory> --file <compose.yaml> [--json]
  hack-local project capture --project <directory> --file <compose.yaml> --expect-plan <sha256> [--profile <name>] [--json]
  hack-local project publish-source --project <directory> --file <compose.yaml> --expect-plan <sha256> [--profile <name>] [--reconcile] [--json]
  hack-local project verify-source --project <directory> --file <compose.yaml> --expect-plan <sha256> [--profile <name>] [--json]
  hack-local graph run|restart|restore --project <directory> --file <compose.yaml> --expect-plan <sha256> --run-id <32-hex> --ready <service=started|healthy|completed>... [--source-revision <sha256>] [--profile <name>] [--timeout-seconds <seconds>] [--json]
  hack-local graph inspect|reconcile|archive|export|reconcile-export|prune --run-id <32-hex> [--json]
  hack-local graph cleanup --run-id <32-hex> [--remove-data] [--json]
  hack-local graph storage-inventory [--json]
  hack-local runtime probe [--json]
  hack-local runtime publication-hostnames [--json]
  hack-local runtime hostname-authority --socket <path> [--json]
  hack-local runtime recover-hostname-authority --socket <path> --expect-sha256 <sha256> [--json]
  hack-local runtime managed-hostname-authority [--json]
  hack-local runtime serve-managed-hostnames [--certificate-name-limit <1..4096>] (owner pipe on stdin)
  hack-local runtime certificate-admission [--json]
  hack-local runtime guest-disk-usage [--json]
  hack-local runtime disk-usage [--scope all|runtime|build|evidence|artifacts] [--max-entries <1..1000000>] [--json]
  hack-local runtime stop-hostname-authority --socket <path> --expect-sha256 <sha256> [--json]
  hack-local runtime serve-hostnames --socket <private-unix-path> (owner pipe on stdin)
  hack-local runtime lookup-hostname --hostname <name> [--json]
  hack-local runtime publication-recovery [--json]
  hack-local runtime recover-publications --expect-sha256 <sha256> [--json]
  hack-local runtime bridge-recovery [--json]
  hack-local runtime export-bridge-recovery --slot <1..8> --expect-sha256 <sha256> [--json]
  hack-local runtime engine-info [--json]
  hack-local graph reserve-bridge --run-id <32-hex> --service <name> --slot <index> --expect-generation <sha256> [--json]
  hack-local graph start-bridge --run-id <32-hex> --slot <index> --expect-reservation <32-hex> [--json]
  hack-local graph publish-bridge --run-id <32-hex> --slot <index> --expect-reservation <32-hex> (--port <loopback-port> | --unix [--hostname <name>]...)
  hack-local graph unpublish-bridge --run-id <32-hex> --expect-reservation <32-hex> [--json]
  hack-local graph release-bridge --run-id <32-hex> --slot <index> --expect-reservation <32-hex> [--json]
  hack-local graph bridges|reconcile-bridges --run-id <32-hex> [--json]
  hack-local runtime probe|up --profile research|development [--json]
  hack-local runtime up --profile research|development --bridge-sockets <1..32> [--json]
  hack-local runtime prepare --archive <pinned-smolvm.tar.gz>
  hack-local runtime prepare-engine --archive <pinned-docker.tgz>
  hack-local runtime load-image --archive <flat-image.tar> --sha256 <archive-hash> --image-id <sha256:config-hash>
  hack-local runtime up|status|down|recover [--json]
  hack-local node serve|status|inspect
  hack-local node request <versioned-json>
  hack-local --version
  hack-local --help

Build with: ./scripts/build-hack-local.sh
Runtime commands affect only the candidate pool. Graph commands support a bounded pinned-image subset; full project up/exec/down remains unimplemented.
The installed hack and its state are never used as a fallback.";

fn main() {
    if let Err(error) = run() {
        // Keep errors structured even before a connection to a runtime exists.
        eprintln!(
            "{}",
            serde_json::to_string(&error).expect("error is serializable")
        );
        std::process::exit(2);
    }
}

fn run() -> Result<(), CandidateError> {
    let arguments: Vec<String> = std::env::args_os()
        .skip(1)
        .map(|argument| {
            argument.into_string().map_err(|_| {
                CandidateError::new("unsupported_path", "Arguments must be valid UTF-8.")
            })
        })
        .collect::<Result<_, _>>()?;
    if arguments.len() < 2 || arguments[0] != "--candidate-root" {
        return Err(CandidateError::new(
            "missing_candidate_root",
            "Use the checkout's hack-local launcher.",
        ));
    }
    let compiled_checkout = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let requested = Path::new(&arguments[1])
        .canonicalize()
        .map_err(|error| CandidateError::new("invalid_candidate_root", error.to_string()))?;
    let compiled = compiled_checkout
        .canonicalize()
        .map_err(|error| CandidateError::new("invalid_candidate_root", error.to_string()))?;
    if requested != compiled {
        return Err(CandidateError::new(
            "checkout_mismatch",
            "This binary was built for a different checkout. Build this checkout's candidate.",
        ));
    }
    let command: Vec<&str> = arguments[2..].iter().map(String::as_str).collect();
    match command.as_slice() {
        [] | ["--help"] | ["help"] => println!("{HELP}"),
        ["--version"] => println!(
            "hack-local {CANDIDATE_VERSION} (runtime-core {})",
            env!("CARGO_PKG_VERSION")
        ),
        ["info"] | ["info", "--json"] => {
            let candidate = Candidate::discover(&requested)?;
            if command.contains(&"--json") {
                print_json(&candidate)?;
            } else {
                println!(
                    "hack-local {} — {}",
                    candidate.version, candidate.checkpoint
                );
                println!("Checkout: {}", candidate.checkout.display());
                println!("Executable: {}", candidate.executable.display());
                println!("Candidate state: {}", candidate.state_root.display());
                println!("Runtime lifecycle: experimental; live qualification pending");
                println!("Graph execution: bounded experimental subset; info contacts no provider");
            }
        }
        ["plan", "--project", project] | ["plan", "--project", project, "--json"] => {
            let candidate = Candidate::discover(&requested)?;
            let plan = candidate.plan(Path::new(project))?;
            if command.contains(&"--json") {
                print_json(&plan)?;
            } else {
                println!("Read-only candidate workspace preview");
                println!("Source: {}", plan.source.display());
                println!(
                    "Provider intent: {} (not qualified by this command)",
                    plan.provider_intent
                );
                println!(
                    "Workspace state: {}",
                    plan.planned_paths.workspace_state.display()
                );
                println!("No configuration loaded, files changed, or runtime started.");
                println!("Next checkpoint: {}", plan.next_checkpoint);
            }
        }
        ["node", "serve"] => {
            let candidate = Candidate::discover(&requested)?;
            hack_runtime_core::node::serve(
                &hack_runtime_core::node::root(&candidate),
                &candidate.executable,
                &candidate.checkout,
            )?;
        }
        ["node", "inspect"] => {
            let candidate = Candidate::discover(&requested)?;
            let mut store = hack_runtime_core::node::Store::inspect(
                &hack_runtime_core::node::root(&candidate),
            )?;
            print_json(&store.handle(
                &hack_runtime_core::node::Request::Status { version: 1 },
                unsafe { libc::geteuid() },
            )?)?;
        }
        ["node", "status"] => {
            let candidate = Candidate::discover(&requested)?;
            print_json(&hack_runtime_core::node::call(
                &hack_runtime_core::node::root(&candidate),
                &hack_runtime_core::node::Request::Status { version: 1 },
            )?)?;
        }
        ["node", "request", json] => {
            let candidate = Candidate::discover(&requested)?;
            let request: hack_runtime_core::node::Request = serde_json::from_str(json)
                .map_err(|e| CandidateError::new("invalid_request", e.to_string()))?;
            use hack_runtime_core::node::Request;
            let request = match &request {
                Request::Submit { mutation, .. }
                | Request::SubmitSource { mutation, .. }
                | Request::ReconcileSource { mutation, .. }
                | Request::Cancel { mutation, .. }
                    if mutation.request_digest.is_empty() =>
                {
                    request.seal()?
                }
                _ => request,
            };
            let response = hack_runtime_core::node::call(
                &hack_runtime_core::node::root(&candidate),
                &request,
            )?;
            print_json(&response)?;
            if response["ok"] == false {
                std::process::exit(2);
            }
        }
        ["__job_supervisor", state, id] => {
            let candidate = Candidate::discover(&requested)?;
            let state = Path::new(state)
                .canonicalize()
                .map_err(|e| CandidateError::new("invalid_node_root", e.to_string()))?;
            if !state.starts_with(&candidate.state_root) {
                return Err(CandidateError::new(
                    "invalid_node_root",
                    "Supervisor state must be checkout-local.",
                ));
            }
            hack_runtime_core::node::supervise(
                &state,
                &candidate.executable,
                &candidate.checkout,
                id,
            )?;
        }
        ["__job_fixture", fixture] => {
            hack_runtime_core::node::fixture(fixture)?;
        }
        ["graph", arguments @ ..] => {
            let candidate = Candidate::discover(&requested)?;
            print_json(&graph_cli::command(&candidate, arguments)?)?;
        }
        ["project", arguments @ ..] => {
            project_command(&Candidate::discover(&requested)?, arguments)?;
        }
        [
            "runtime",
            "up",
            "--profile",
            profile,
            "--bridge-sockets",
            count,
        ]
        | [
            "runtime",
            "up",
            "--profile",
            profile,
            "--bridge-sockets",
            count,
            "--json",
        ] => {
            use hack_runtime_core::provider::{self, BridgeIntent, Profile};
            let profile = match *profile {
                "research" => Profile::Research,
                "development" => Profile::Development,
                _ => {
                    return Err(CandidateError::new(
                        "invalid_arguments",
                        "Profile must be research or development.",
                    ));
                }
            };
            let slots = count.parse::<u8>().map_err(|_| {
                CandidateError::new(
                    "bridge_capacity",
                    "Bridge capacity must be between 1 and 32 sockets.",
                )
            })?;
            print_json(&provider::up_with_bridge(
                &Candidate::discover(&requested)?,
                profile,
                Some(BridgeIntent::new(slots)?),
            )?)?;
        }
        ["runtime", action @ ("probe" | "up"), "--profile", profile]
        | [
            "runtime",
            action @ ("probe" | "up"),
            "--profile",
            profile,
            "--json",
        ] => {
            use hack_runtime_core::provider::{self, Profile};
            let profile = match *profile {
                "research" => Profile::Research,
                "development" => Profile::Development,
                _ => {
                    return Err(CandidateError::new(
                        "invalid_arguments",
                        "Profile must be research or development.",
                    ));
                }
            };
            let candidate = Candidate::discover(&requested)?;
            if *action == "probe" {
                print_json(&provider::admission::probe_for(
                    &candidate.checkout,
                    profile,
                )?)?;
            } else {
                print_json(&provider::up_with_profile(&candidate, profile)?)?;
            }
        }
        ["runtime", "hostname-authority", "--socket", socket]
        | [
            "runtime",
            "hostname-authority",
            "--socket",
            socket,
            "--json",
        ] => {
            print_json(
                &hack_runtime_core::provider::hostname_authority::ownership::inspect(
                    &Candidate::discover(&requested)?,
                    std::path::Path::new(socket),
                )?,
            )?;
        }
        [
            "runtime",
            "recover-hostname-authority",
            "--socket",
            socket,
            "--expect-sha256",
            hash,
        ]
        | [
            "runtime",
            "recover-hostname-authority",
            "--socket",
            socket,
            "--expect-sha256",
            hash,
            "--json",
        ] => {
            print_json(
                &hack_runtime_core::provider::hostname_authority::ownership::recover(
                    &Candidate::discover(&requested)?,
                    std::path::Path::new(socket),
                    hash,
                )?,
            )?;
        }
        ["runtime", "managed-hostname-authority"]
        | ["runtime", "managed-hostname-authority", "--json"] => {
            print_json(
                &hack_runtime_core::provider::hostname_authority::managed::inspect(
                    &Candidate::discover(&requested)?,
                )?,
            )?;
        }
        ["runtime", "guest-disk-usage"] | ["runtime", "guest-disk-usage", "--json"] => {
            print_json(&hack_runtime_core::provider::guest_storage::inspect(
                &Candidate::discover(&requested)?,
            )?)?;
        }
        ["runtime", "disk-usage", rest @ ..] => {
            print_json(&hack_runtime_core::provider::storage_usage::inspect_args(
                &Candidate::discover(&requested)?,
                rest,
            )?)?;
        }
        ["runtime", "certificate-admission"] | ["runtime", "certificate-admission", "--json"] => {
            print_json(
                &hack_runtime_core::provider::hostname_authority::certificates::inspect(
                    &Candidate::discover(&requested)?,
                )?,
            )?;
        }
        [
            "runtime",
            "serve-managed-hostnames",
            "--certificate-name-limit",
            limit,
        ] => {
            let limit = limit.parse::<usize>().map_err(|_| {
                CandidateError::new("certificate_admission", "Invalid certificate name limit.")
            })?;
            hack_runtime_core::provider::hostname_authority::managed::serve_with_certificate_limit(
                &Candidate::discover(&requested)?,
                Some(limit),
            )?;
        }
        ["runtime", "serve-managed-hostnames"] => {
            hack_runtime_core::provider::hostname_authority::managed::serve(&Candidate::discover(
                &requested,
            )?)?;
        }
        [
            "runtime",
            "stop-hostname-authority",
            "--socket",
            socket,
            "--expect-sha256",
            hash,
        ]
        | [
            "runtime",
            "stop-hostname-authority",
            "--socket",
            socket,
            "--expect-sha256",
            hash,
            "--json",
        ] => {
            print_json(
                &hack_runtime_core::provider::hostname_authority::ownership::stop(
                    &Candidate::discover(&requested)?,
                    std::path::Path::new(socket),
                    hash,
                )?,
            )?;
        }
        ["runtime", "serve-hostnames", "--socket", socket] => {
            hack_runtime_core::provider::hostname_authority::serve(
                &Candidate::discover(&requested)?,
                std::path::Path::new(socket),
            )?;
        }
        ["runtime", "lookup-hostname", "--hostname", name]
        | ["runtime", "lookup-hostname", "--hostname", name, "--json"] => {
            print_json(&hack_runtime_core::provider::publication::lookup_hostname(
                &Candidate::discover(&requested)?,
                name,
            )?)?;
        }
        ["runtime", "publication-hostnames"] | ["runtime", "publication-hostnames", "--json"] => {
            print_json(&hack_runtime_core::provider::publication::inspect_claims(
                &Candidate::discover(&requested)?,
            )?)?;
        }
        ["runtime", "publication-recovery"] | ["runtime", "publication-recovery", "--json"] => {
            print_json(
                &hack_runtime_core::provider::publication::recovery::inspect(
                    &Candidate::discover(&requested)?,
                )?,
            )?;
        }
        ["runtime", "recover-publications", "--expect-sha256", hash]
        | [
            "runtime",
            "recover-publications",
            "--expect-sha256",
            hash,
            "--json",
        ] => {
            print_json(
                &hack_runtime_core::provider::publication::recovery::recover(
                    &Candidate::discover(&requested)?,
                    hash,
                )?,
            )?;
        }
        ["runtime", "bridge-recovery"] | ["runtime", "bridge-recovery", "--json"] => {
            print_json(
                &hack_runtime_core::provider::graph::inspect_bridge_recovery(
                    &Candidate::discover(&requested)?,
                )?,
            )?;
        }
        [
            "runtime",
            "export-bridge-recovery",
            "--slot",
            slot,
            "--expect-sha256",
            hash,
        ]
        | [
            "runtime",
            "export-bridge-recovery",
            "--slot",
            slot,
            "--expect-sha256",
            hash,
            "--json",
        ] => {
            let slot = slot.parse::<u8>().map_err(|_| {
                CandidateError::new("invalid_arguments", "Recovery slot must be 1..8.")
            })?;
            print_json(&hack_runtime_core::provider::graph::export_bridge_recovery(
                &Candidate::discover(&requested)?,
                slot,
                hash,
            )?)?;
        }
        ["runtime", "engine-info"] | ["runtime", "engine-info", "--json"] => {
            print_json(&hack_runtime_core::provider::engine_info(
                &Candidate::discover(&requested)?,
            )?)?;
        }
        ["runtime", "probe"] | ["runtime", "probe", "--json"] => {
            print_json(&hack_runtime_core::provider::probe(&Candidate::discover(
                &requested,
            )?)?)?;
        }
        ["runtime", "prepare", "--archive", archive] => {
            print_json(&hack_runtime_core::provider::prepare(
                &Candidate::discover(&requested)?,
                Path::new(archive),
            )?)?;
        }
        ["runtime", "prepare-engine", "--archive", archive] => {
            print_json(&hack_runtime_core::provider::prepare_engine(
                &Candidate::discover(&requested)?,
                Path::new(archive),
            )?)?;
        }
        [
            "runtime",
            "load-image",
            "--archive",
            archive,
            "--sha256",
            digest,
            "--image-id",
            image,
        ] => {
            print_json(&hack_runtime_core::provider::load_image(
                &Candidate::discover(&requested)?,
                Path::new(archive),
                digest,
                image,
            )?)?;
        }
        ["runtime", action] | ["runtime", action, "--json"] => {
            let candidate = Candidate::discover(&requested)?;
            let result = match *action {
                "up" => hack_runtime_core::provider::up(&candidate),
                "status" => hack_runtime_core::provider::status(&candidate),
                "down" => hack_runtime_core::provider::down(&candidate),
                "recover" => hack_runtime_core::provider::recover(&candidate),
                _ => return Err(CandidateError::new("unsupported_command", HELP)),
            }?;
            print_json(&result)?;
        }
        _ => return Err(CandidateError::new("unsupported_command", HELP)),
    }
    Ok(())
}

fn project_command(candidate: &Candidate, arguments: &[&str]) -> Result<(), CandidateError> {
    use hack_runtime_core::project::{self, PlanOptions};
    let Some((action, arguments)) = arguments.split_first() else {
        return Err(CandidateError::new("unsupported_command", HELP));
    };
    if ![
        "plan",
        "enroll",
        "status",
        "capture",
        "publish-source",
        "verify-source",
        "sync-source",
        "sync-status",
    ]
    .contains(action)
    {
        return Err(CandidateError::new("unsupported_command", HELP));
    }
    let mut source = None;
    let mut file = None;
    let mut expected = None;
    let mut profiles = Vec::new();
    let mut json = false;
    let mut watch = false;
    let mut reconcile = false;
    let mut duration = None;
    let mut index = 0;
    while index < arguments.len() {
        let option = arguments[index];
        index += 1;
        if option == "--json" && !json {
            json = true;
            continue;
        }
        if option == "--watch" && !watch && *action == "sync-source" {
            watch = true;
            continue;
        }
        if option == "--reconcile"
            && !reconcile
            && ["sync-source", "publish-source"].contains(action)
        {
            reconcile = true;
            continue;
        }
        let value = arguments
            .get(index)
            .ok_or_else(|| CandidateError::new("invalid_arguments", HELP))?;
        index += 1;
        match option {
            "--duration-seconds" if duration.is_none() && *action == "sync-source" => {
                duration = Some(
                    value
                        .parse::<u64>()
                        .ok()
                        .filter(|n| (1..=86400).contains(n))
                        .ok_or_else(|| {
                            CandidateError::new(
                                "invalid_arguments",
                                "Watch duration must be 1 to 86400 seconds.",
                            )
                        })?,
                );
            }
            "--project" if source.is_none() => source = Some(*value),
            "--file" if file.is_none() => file = Some(*value),
            "--expect-plan" if expected.is_none() => expected = Some(*value),
            "--profile" if profiles.len() < 64 => profiles.push((*value).to_owned()),
            _ => return Err(CandidateError::new("invalid_arguments", HELP)),
        }
    }
    let source = Path::new(
        source.ok_or_else(|| CandidateError::new("invalid_arguments", "--project is required."))?,
    );
    if *action == "status" {
        if file.is_some() || expected.is_some() || !profiles.is_empty() {
            return Err(CandidateError::new("invalid_arguments", HELP));
        }
        let status = project::status(candidate, source)?;
        if json {
            print_json(&status)?;
        } else {
            println!("{} — project execution is not implemented", status.state);
        }
        return Ok(());
    }
    let file = Path::new(file.ok_or_else(|| {
        CandidateError::new(
            "invalid_arguments",
            "Select one Compose file with --file; .env and implicit override files are not loaded.",
        )
    })?);
    let options = PlanOptions {
        project: source,
        compose_file: file,
        profiles: &profiles,
    };
    if duration.is_some() && !watch {
        return Err(CandidateError::new(
            "invalid_arguments",
            "--duration-seconds requires --watch.",
        ));
    }
    if *action == "sync-status" {
        if expected.is_some() {
            return Err(CandidateError::new("invalid_arguments", HELP));
        }
        let report = project::plan(candidate, options)?;
        return print_json(&hack_runtime_core::provider::sync_status(
            candidate,
            &report.plan.namespace,
        )?);
    }
    if *action == "sync-source" {
        return sync_source_command(candidate, options, expected, watch, reconcile, duration);
    }
    if ["capture", "publish-source", "verify-source"].contains(action) {
        let report = project::plan(candidate, options)?;
        if expected != Some(report.plan_id.as_str()) {
            return Err(CandidateError::new(
                "stale_plan",
                "Capture requires the current --expect-plan review ID.",
            ));
        }
        let environment_files = report
            .plan
            .services
            .values()
            .flat_map(|service| service.environment_files.iter().cloned())
            .collect();
        let snapshot = project::snapshot::capture(
            &report.plan.source,
            &environment_files,
            &report.plan.source_selection.metadata_sha256,
        )?;
        if ["publish-source", "verify-source"].contains(action) {
            let publish = if reconcile {
                hack_runtime_core::provider::reconcile_source_publication
            } else {
                hack_runtime_core::provider::publish_source
            };
            let receipt = publish(candidate, &report.plan.namespace, &snapshot)?;
            if *action == "verify-source" {
                print_json(&hack_runtime_core::provider::verify_source(
                    candidate, &receipt,
                )?)?;
            } else {
                print_json(&receipt)?;
            }
            return Ok(());
        }
        if json {
            print_json(snapshot.receipt())?;
        } else {
            println!(
                "Captured {} bytes as {} in memory; no runtime transfer or job started.",
                snapshot.receipt().total_bytes,
                snapshot.receipt().revision
            );
        }
        return Ok(());
    }
    if *action == "enroll" {
        let expected = expected.ok_or_else(|| {
            CandidateError::new(
                "invalid_arguments",
                "--expect-plan must match a reviewed project plan ID.",
            )
        })?;
        let receipt = project::enroll(candidate, options, expected)?;
        if json {
            print_json(&receipt)?;
        } else {
            println!("Enrolled candidate plan {}", receipt.plan_id);
            println!(
                "Private metadata receipt saved. No project files or runtime resources changed."
            );
        }
    } else {
        if expected.is_some() {
            return Err(CandidateError::new("invalid_arguments", HELP));
        }
        let report = project::plan(candidate, options)?;
        if json {
            print_json(&report)?;
        } else {
            println!("Compose review {}", report.plan_id);
            println!(
                "{} services; {} active; {} source entries",
                report.plan.services.len(),
                report.plan.services.values().filter(|s| s.active).count(),
                report.plan.source_selection.entries.len()
            );
            println!(
                "Enrollment compatible: {}; prior enrollment: {}",
                report.plan.enrollment_compatible, report.enrollment_diff.state
            );
            for (name, service) in &report.plan.services {
                println!(
                    "\n{name}: {}",
                    if service.active {
                        "active"
                    } else {
                        "profile disabled"
                    }
                );
                if let Some(image) = &service.image {
                    println!("  image: {image}");
                }
                if let Some(build) = &service.build {
                    println!("  build: {} using {}", build.context, build.dockerfile);
                }
                for (dependency, detail) in &service.dependencies {
                    println!("  depends on {dependency}: {}", detail.condition);
                }
                for mount in &service.mounts {
                    println!(
                        "  {} {} -> {} ({})",
                        mount.kind,
                        mount.source,
                        mount.target,
                        if mount.read_only {
                            "read only"
                        } else {
                            "read/write"
                        }
                    );
                }
                for port in &service.ports {
                    let published = port
                        .published
                        .map(|p| p.to_string())
                        .unwrap_or_else(|| "allocate later".into());
                    println!(
                        "  port: declared {}:{published} -> proposed {}:{published} -> {}/{}",
                        port.declared_host_ip, port.proposed_host_ip, port.target, port.protocol
                    );
                }
                if !service.environment.is_empty() {
                    println!(
                        "  environment names: {} (values redacted/unresolved)",
                        service
                            .environment
                            .keys()
                            .cloned()
                            .collect::<Vec<_>>()
                            .join(", ")
                    );
                }
                if !service.environment_files.is_empty() {
                    println!(
                        "  environment files: {} (not read; excluded from source)",
                        service.environment_files.join(", ")
                    );
                }
                for command in [&service.command, &service.entrypoint]
                    .into_iter()
                    .flatten()
                {
                    println!(
                        "  {}: {} arguments; review {}",
                        command.form,
                        command.arguments.len(),
                        command.review_field
                    );
                }
                if service.healthcheck.is_some() {
                    println!("  healthcheck: explicitly declared; command values redacted");
                }
                println!(
                    "  limits: cpus={}, memory_bytes={}, pids={}",
                    service
                        .limits
                        .cpus
                        .map(|v| v.to_string())
                        .unwrap_or_else(|| "not declared".into()),
                    service
                        .limits
                        .memory_bytes
                        .map(|v| v.to_string())
                        .unwrap_or_else(|| "not declared".into()),
                    service
                        .limits
                        .pids
                        .map(|v| v.to_string())
                        .unwrap_or_else(|| "not declared".into())
                );
            }
            println!("\nSource policy: {}", report.plan.source_selection.policy);
            println!(
                "{} excluded paths; full source inventory is available with --json.",
                report.plan.source_selection.excluded_paths.len()
            );
            println!(
                "Enrollment creates: {}",
                candidate
                    .state_root
                    .join("run/workspaces")
                    .join(&report.plan.namespace)
                    .join("enrollment.json")
                    .display()
            );
            for finding in &report.plan.diagnostics {
                println!(
                    "{} [{}] {}: {}",
                    finding.severity, finding.code, finding.field, finding.message
                );
            }
            println!(
                "Literal command/environment/metadata values are redacted. Review their fields in the selected Compose file."
            );
            println!(
                "Planning has no effects. Enrollment saves metadata only; project execution remains gated."
            );
        }
    }
    Ok(())
}

fn sync_source_command(
    candidate: &Candidate,
    options: hack_runtime_core::project::PlanOptions<'_>,
    expected: Option<&str>,
    watch: bool,
    reconcile: bool,
    duration: Option<u64>,
) -> Result<(), CandidateError> {
    use hack_runtime_core::{project, provider};
    use std::time::{Duration, Instant};
    let make_plan = || {
        project::plan(
            candidate,
            project::PlanOptions {
                project: options.project,
                compose_file: options.compose_file,
                profiles: options.profiles,
            },
        )
    };
    let report = make_plan()?;
    if expected != Some(report.plan_id.as_str()) {
        return Err(CandidateError::new(
            "stale_plan",
            "Source synchronization requires the current --expect-plan review ID.",
        ));
    }
    let namespace = report.plan.namespace.clone();
    let source = report.plan.source.clone();
    let watcher = if watch {
        Some(project::watcher::SourceWatcher::new(&source)?)
    } else {
        None
    };
    let mut session = provider::SyncSession::open(candidate, &namespace, &source)?;
    let capture = |report: &project::PlanReport| {
        if report.plan.namespace != namespace || report.plan.source != source {
            return Err(CandidateError::new(
                "source_changed",
                "Source identity changed while watching.",
            ));
        }
        let environment_files = report
            .plan
            .services
            .values()
            .flat_map(|service| service.environment_files.iter().cloned())
            .collect();
        project::snapshot::capture(
            &source,
            &environment_files,
            &report.plan.source_selection.metadata_sha256,
        )
    };
    let started = Instant::now();
    let snapshot = capture(&report)?;
    let first = session.apply(&snapshot, reconcile)?;
    print_sync_event(&first, watch, started.elapsed().as_millis(), false)?;
    let mut revision = snapshot.receipt().revision.clone();
    drop(snapshot);
    let Some(watcher) = watcher else {
        return Ok(());
    };
    let deadline = duration.map(|seconds| Instant::now() + Duration::from_secs(seconds));
    loop {
        let timeout = deadline
            .map(|d| d.saturating_duration_since(Instant::now()))
            .unwrap_or(Duration::from_secs(3600));
        if timeout.is_zero() {
            return Ok(());
        }
        let Some(change) = watcher.wait(timeout)? else {
            if deadline.is_some() {
                return Ok(());
            }
            continue;
        };
        let started = Instant::now();
        let report = make_plan()?;
        let snapshot = capture(&report)?;
        if snapshot.receipt().revision == revision {
            continue;
        }
        let receipt = session.apply(&snapshot, false)?;
        revision = snapshot.receipt().revision.clone();
        print_sync_event(
            &receipt,
            true,
            started.elapsed().as_millis(),
            change.reconcile_required,
        )?;
    }
}

fn print_sync_event(
    receipt: &hack_runtime_core::provider::SyncReceipt,
    watching: bool,
    total_millis: u128,
    native_rescan: bool,
) -> Result<(), CandidateError> {
    println!("{}", serde_json::to_string(&serde_json::json!({ "sync": receipt, "watching": watching, "total_millis": total_millis, "native_rescan": native_rescan }))
        .map_err(|_| CandidateError::new("serialization_failed", "Cannot encode source acknowledgement."))?);
    Ok(())
}

fn print_json(value: &impl Serialize) -> Result<(), CandidateError> {
    println!(
        "{}",
        serde_json::to_string_pretty(value)
            .map_err(|error| { CandidateError::new("serialization_failed", error.to_string()) })?
    );
    Ok(())
}
