mod graph_cli;
mod normalized_cli;
mod runtime_up_cli;
mod source_watch_retry;
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
  hack-local graph run|restart|restore --project <directory> --file <compose.yaml> --expect-plan <sha256> --run-id <32-hex> --ready <service=started|healthy|completed>... [--source-revision <sha256>] [--live-source] [--profile <name>] [--timeout-seconds <seconds>] [--json]
  hack-local graph inspect|reconcile|archive|export|reconcile-export|prune --run-id <32-hex> [--json]
  hack-local graph cleanup --run-id <32-hex> [--remove-data] [--json]
  hack-local graph recover-cleanup --run-id <32-hex> --expect-receipt <sha256> [--json]
  hack-local graph retire-recovered-publisher --run-id <32-hex> --expect-owner <32-hex> [--json]
  hack-local graph logs --run-id <32-hex> --service <name> [--tail <1..1000>] [--json]
  hack-local graph exec --run-id <32-hex> --service <name> [--workdir /path] [--timeout-seconds <1..120>] [--json] -- <program> [args...]
  hack-local graph dependency-plan --dependencies <reviewed.json> [--json]
  hack-local graph serve --project <directory> --file <compose.yaml> --expect-plan <sha256> --run-id <32-hex> --ready <service=started|healthy|completed>... --dependencies <reviewed.json> --expect-dependencies <sha256> [--source-revision <sha256>] [--live-source] [--profile <name>] [--timeout-seconds <seconds>] [--json]
  hack-local graph owner-status --run-id <32-hex> [--json]
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
  hack-local runtime dependency-socket-recovery [--json]
  hack-local runtime recover-dependency-sockets --expect-sha256 <sha256> [--json]
  hack-local runtime bridge-recovery [--json]
  hack-local runtime export-bridge-recovery --slot <1..8> --expect-sha256 <sha256> [--json]
  hack-local runtime engine-info [--json]
  hack-local graph reserve-bridge --run-id <32-hex> --service <name> --slot <index> --expect-generation <sha256> [--json]
  hack-local graph serve ... [--route-slot <service=index>]...
  hack-local graph start-bridge --run-id <32-hex> --slot <index> --expect-reservation <32-hex> [--json]
  hack-local graph publish-bridge --run-id <32-hex> --slot <index> --expect-reservation <32-hex> (--port <loopback-port> | --unix [--hostname <name>]...)
  hack-local graph unpublish-bridge --run-id <32-hex> --expect-reservation <32-hex> [--json]
  hack-local graph release-bridge --run-id <32-hex> --slot <index> --expect-reservation <32-hex> [--json]
  hack-local graph bridges|reconcile-bridges --run-id <32-hex> [--json]
  hack-local runtime probe|up --profile research|development [--json]
  hack-local runtime up --profile research|development [--bridge-sockets <1..32>] [--dependency-sockets <1..32>] [--json]
  hack-local runtime up --profile development --project-share <exact-project-root> --unfiltered-source [--json]
  hack-local graph serve|run ... --shared-source
  hack-local runtime prepare --archive <pinned-smolvm.tar.gz>
  hack-local runtime prepare-engine --archive <pinned-docker.tgz>
  hack-local runtime prepare-network-tools --directory <private-pinned-apk-directory>
  hack-local runtime ensure-image --reference <namespace/repository[:tag]|namespace/repository@sha256:digest> --json
  hack-local runtime resolve-image --reference <namespace/repository[:tag]> --json
  hack-local runtime fetch-image --reference <namespace/repository@sha256:digest> --archive <new-flat-image.tar> [--json]
  hack-local runtime load-image --archive <flat-image.tar> --sha256 <archive-hash> --image-id <sha256:config-hash>
  hack-local runtime network internet --json
  hack-local runtime up --profile development --internet --json
  hack-local runtime network extend --allow-host <hostname> [--allow-host <hostname>] --json
  hack-local runtime up|status|down|recover [--json]
  hack-local node serve|status|inspect
  hack-local node request <versioned-json>
  hack-local --version
  hack-local --help

Normalized public input for project plan/capture/publish-source/verify-source and graph run/serve/serve-restore: --normalized-file <path> --expect-original <sha256> --expect-namespace <sha256>. Sync/enroll/restart/restore do not accept it. Stopped normalized graphs use graph restore-selection --run-id RUN --json, then graph serve-restore with the same run/plan, --expect-generation, and fresh serve dependency/environment/route selections.
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

fn installed_entrypoint() -> bool {
    cfg!(feature = "installed-candidate") && env!("CARGO_BIN_NAME") == "hack-native"
}

fn discover_candidate(root: &Path) -> Result<Candidate, CandidateError> {
    if installed_entrypoint() {
        Candidate::discover_installed(root)
    } else {
        Candidate::discover(root)
    }
}

fn resolve_candidate_root(root: &Path) -> Result<std::path::PathBuf, CandidateError> {
    if installed_entrypoint() {
        // Do not inspect the build checkout: release executables must survive its removal.
        return Ok(Candidate::discover_installed(root)?.checkout);
    }
    let compiled_checkout = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let requested = root
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
    Ok(requested)
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
            "Supply --candidate-root explicitly, or use the matching candidate launcher.",
        ));
    }
    let requested = resolve_candidate_root(Path::new(&arguments[1]))?;
    let command: Vec<&str> = arguments[2..].iter().map(String::as_str).collect();
    match command.as_slice() {
        [] | ["--help"] | ["help"] => {
            println!(
                "{}",
                if installed_entrypoint() {
                    HELP.replace("Build with: ./scripts/build-hack-local.sh", "Opt-in installed candidate; explicit private --candidate-root is required.").replace("hack-local", "hack-native")
                } else {
                    HELP.to_owned()
                }
            )
        }
        ["--version"] => println!(
            "{} {CANDIDATE_VERSION} (runtime-core {})",
            if installed_entrypoint() {
                "hack-native"
            } else {
                "hack-local"
            },
            env!("CARGO_PKG_VERSION")
        ),
        ["info"] | ["info", "--json"] => {
            let candidate = discover_candidate(&requested)?;
            if command.contains(&"--json") {
                print_json(&candidate)?;
            } else {
                println!(
                    "{} {} — {}",
                    if installed_entrypoint() {
                        "hack-native"
                    } else {
                        "hack-local"
                    },
                    candidate.version,
                    candidate.checkpoint
                );
                println!("Candidate root: {}", candidate.checkout.display());
                println!("Executable: {}", candidate.executable.display());
                println!("Candidate state: {}", candidate.state_root.display());
                println!("Runtime lifecycle: experimental; live qualification pending");
                println!("Graph execution: bounded experimental subset; info contacts no provider");
            }
        }
        ["plan", "--project", project] | ["plan", "--project", project, "--json"] => {
            let candidate = discover_candidate(&requested)?;
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
            let candidate = discover_candidate(&requested)?;
            hack_runtime_core::node::serve(
                &hack_runtime_core::node::root(&candidate),
                &candidate.executable,
                &candidate.checkout,
            )?;
        }
        ["node", "inspect"] => {
            let candidate = discover_candidate(&requested)?;
            let mut store = hack_runtime_core::node::Store::inspect(
                &hack_runtime_core::node::root(&candidate),
            )?;
            print_json(&store.handle(
                &hack_runtime_core::node::Request::Status { version: 1 },
                unsafe { libc::geteuid() },
            )?)?;
        }
        ["node", "status"] => {
            let candidate = discover_candidate(&requested)?;
            print_json(&hack_runtime_core::node::call(
                &hack_runtime_core::node::root(&candidate),
                &hack_runtime_core::node::Request::Status { version: 1 },
            )?)?;
        }
        ["node", "request", json] => {
            let candidate = discover_candidate(&requested)?;
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
            let candidate = discover_candidate(&requested)?;
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
            let candidate = discover_candidate(&requested)?;
            let result = graph_cli::command(&candidate, arguments)?;
            print_json(&result)?;
            if arguments
                .first()
                .is_some_and(|action| ["exec", "run-service"].contains(action))
            {
                let code = result["exit_code"].as_i64().ok_or_else(|| {
                    CandidateError::new("graph_exec_result", "Missing service command exit status.")
                })?;
                if code != 0 {
                    std::process::exit(i32::try_from(code).unwrap_or(1));
                }
            }
        }
        ["project", arguments @ ..] => {
            project_command(&discover_candidate(&requested)?, arguments)?;
        }
        ["runtime", "network", "internet", "--json"] => {
            print_json(&hack_runtime_core::provider::enable_internet(
                &discover_candidate(&requested)?,
            )?)?;
        }
        ["runtime", "network", "extend", arguments @ ..] => {
            let mut hosts = Vec::new();
            let mut rest = arguments;
            while let ["--allow-host", host, tail @ ..] = rest {
                hosts.push((*host).to_owned());
                rest = tail;
            }
            if hosts.is_empty() || rest != ["--json"] {
                return Err(CandidateError::new(
                    "network_update",
                    "Expected runtime network extend --allow-host HOST [--allow-host HOST] --json.",
                ));
            }
            print_json(&hack_runtime_core::provider::extend_network(
                &discover_candidate(&requested)?,
                hosts,
            )?)?;
        }
        ["runtime", "up", arguments @ ..]
            if arguments.contains(&"--bridge-sockets")
                || arguments.contains(&"--dependency-sockets")
                || arguments.contains(&"--allow-host")
                || arguments.contains(&"--internet")
                || arguments.contains(&"--project-share")
                || arguments.contains(&"--unfiltered-source") =>
        {
            let options = runtime_up_cli::parse(arguments)?;
            let share = options
                .project_share
                .as_deref()
                .map(|project| {
                    hack_runtime_core::provider::ProjectShareIntent::approve(project, true)
                })
                .transpose()?;
            print_json(&hack_runtime_core::provider::up_with_project_share(
                &discover_candidate(&requested)?,
                options.profile,
                options.bridges,
                options.dependencies,
                options.network,
                share,
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
            let candidate = discover_candidate(&requested)?;
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
                    &discover_candidate(&requested)?,
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
                    &discover_candidate(&requested)?,
                    std::path::Path::new(socket),
                    hash,
                )?,
            )?;
        }
        ["runtime", "managed-hostname-authority"]
        | ["runtime", "managed-hostname-authority", "--json"] => {
            print_json(
                &hack_runtime_core::provider::hostname_authority::managed::inspect(
                    &discover_candidate(&requested)?,
                )?,
            )?;
        }
        ["runtime", "guest-disk-usage"] | ["runtime", "guest-disk-usage", "--json"] => {
            print_json(&hack_runtime_core::provider::guest_storage::inspect(
                &discover_candidate(&requested)?,
            )?)?;
        }
        ["runtime", "disk-usage", rest @ ..] => {
            print_json(&hack_runtime_core::provider::storage_usage::inspect_args(
                &discover_candidate(&requested)?,
                rest,
            )?)?;
        }
        ["runtime", "certificate-admission"] | ["runtime", "certificate-admission", "--json"] => {
            print_json(
                &hack_runtime_core::provider::hostname_authority::certificates::inspect(
                    &discover_candidate(&requested)?,
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
                &discover_candidate(&requested)?,
                Some(limit),
            )?;
        }
        ["runtime", "serve-managed-hostnames"] => {
            hack_runtime_core::provider::hostname_authority::managed::serve(&discover_candidate(
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
                    &discover_candidate(&requested)?,
                    std::path::Path::new(socket),
                    hash,
                )?,
            )?;
        }
        ["runtime", "serve-hostnames", "--socket", socket] => {
            hack_runtime_core::provider::hostname_authority::serve(
                &discover_candidate(&requested)?,
                std::path::Path::new(socket),
            )?;
        }
        ["runtime", "lookup-hostname", "--hostname", name]
        | ["runtime", "lookup-hostname", "--hostname", name, "--json"] => {
            print_json(&hack_runtime_core::provider::publication::lookup_hostname(
                &discover_candidate(&requested)?,
                name,
            )?)?;
        }
        ["runtime", "publication-hostnames"] | ["runtime", "publication-hostnames", "--json"] => {
            print_json(&hack_runtime_core::provider::publication::inspect_claims(
                &discover_candidate(&requested)?,
            )?)?;
        }
        ["runtime", "publication-recovery"] | ["runtime", "publication-recovery", "--json"] => {
            print_json(
                &hack_runtime_core::provider::publication::recovery::inspect(&discover_candidate(
                    &requested,
                )?)?,
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
                    &discover_candidate(&requested)?,
                    hash,
                )?,
            )?;
        }
        ["runtime", "dependency-socket-recovery"]
        | ["runtime", "dependency-socket-recovery", "--json"] => {
            print_json(
                &hack_runtime_core::provider::dependency_socket_recovery::inspect(
                    &discover_candidate(&requested)?,
                )?,
            )?;
        }
        [
            "runtime",
            "recover-dependency-sockets",
            "--expect-sha256",
            hash,
        ]
        | [
            "runtime",
            "recover-dependency-sockets",
            "--expect-sha256",
            hash,
            "--json",
        ] => {
            print_json(
                &hack_runtime_core::provider::dependency_socket_recovery::recover(
                    &discover_candidate(&requested)?,
                    hash,
                )?,
            )?;
        }
        ["runtime", "bridge-recovery"] | ["runtime", "bridge-recovery", "--json"] => {
            print_json(
                &hack_runtime_core::provider::graph::inspect_bridge_recovery(&discover_candidate(
                    &requested,
                )?)?,
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
                &discover_candidate(&requested)?,
                slot,
                hash,
            )?)?;
        }
        ["runtime", "engine-info"] | ["runtime", "engine-info", "--json"] => {
            print_json(&hack_runtime_core::provider::engine_info(
                &discover_candidate(&requested)?,
            )?)?;
        }
        ["runtime", "probe"] | ["runtime", "probe", "--json"] => {
            print_json(&hack_runtime_core::provider::probe(&discover_candidate(
                &requested,
            )?)?)?;
        }
        ["runtime", "prepare", "--archive", archive] => {
            print_json(&hack_runtime_core::provider::prepare(
                &discover_candidate(&requested)?,
                Path::new(archive),
            )?)?;
        }
        ["runtime", "prepare-network-tools", "--directory", directory] => {
            print_json(&hack_runtime_core::provider::prepare_network_tools(
                &discover_candidate(&requested)?,
                Path::new(directory),
            )?)?;
        }
        ["runtime", "prepare-engine", "--archive", archive] => {
            print_json(&hack_runtime_core::provider::prepare_engine(
                &discover_candidate(&requested)?,
                Path::new(archive),
            )?)?;
        }
        [
            "runtime",
            "ensure-image",
            "--reference",
            reference,
            "--json",
        ] => {
            print_json(&hack_runtime_core::provider::image_ensure::ensure(
                &discover_candidate(&requested)?,
                reference,
            )?)?;
        }
        [
            "runtime",
            "resolve-image",
            "--reference",
            reference,
            "--json",
        ] => {
            print_json(&hack_runtime_core::provider::registry_image::resolve(
                reference,
            )?)?;
        }
        [
            "runtime",
            "fetch-image",
            "--reference",
            reference,
            "--archive",
            archive,
        ]
        | [
            "runtime",
            "fetch-image",
            "--reference",
            reference,
            "--archive",
            archive,
            "--json",
        ] => {
            print_json(&hack_runtime_core::provider::registry_image::acquire(
                reference,
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
                &discover_candidate(&requested)?,
                Path::new(archive),
                digest,
                image,
            )?)?;
        }
        ["runtime", action] | ["runtime", action, "--json"] => {
            let candidate = discover_candidate(&requested)?;
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
    let (arguments, normalized_selection) = normalized_cli::extract(
        arguments,
        ["plan", "capture", "publish-source", "verify-source"].contains(action),
    )?;
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
    let normalized = normalized_selection
        .as_ref()
        .map(|selection| selection.load())
        .transpose()?;
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
        let report = normalized_cli::review(candidate, options, normalized.as_ref())?;
        return print_json(&hack_runtime_core::provider::sync_status(
            candidate,
            &report.plan.namespace,
        )?);
    }
    if *action == "sync-source" {
        return sync_source_command(candidate, options, expected, watch, reconcile, duration);
    }
    if ["capture", "publish-source", "verify-source"].contains(action) {
        let report = normalized_cli::review(candidate, options, normalized.as_ref())?;
        if expected != Some(report.plan_id.as_str()) {
            return Err(CandidateError::new(
                "stale_plan",
                "Capture requires the current --expect-plan review ID.",
            ));
        }
        let snapshot = capture_plan_source(&report.plan)?;
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
        let report = normalized_cli::review(candidate, options, normalized.as_ref())?;
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

/// Capture the reviewed artifact shape identically for immutable publication and
/// mutable synchronization, including excluded-volume mountpoint placeholders.
fn capture_plan_source(
    plan: &hack_runtime_core::project::PlanData,
) -> Result<hack_runtime_core::project::snapshot::Snapshot, CandidateError> {
    hack_runtime_core::project::snapshot::capture_plan(plan)
}

#[cfg(test)]
mod source_capture_tests;

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
        capture_plan_source(&report.plan)
    };
    let started = Instant::now();
    let snapshot = capture(&report)?;
    let live_contract =
        match project::live_source::Contract::from_plan(&report.plan, snapshot.receipt()) {
            Ok(contract) => Some(contract),
            Err(error) if watch => return Err(error),
            // Capture-only projects can retain unsupported execution diagnostics.
            // Legacy apply still refuses updates when a live graph needs review.
            Err(_) => None,
        };
    let first = match &live_contract {
        Some(contract) => session.apply_reviewed(&snapshot, reconcile, contract)?,
        None => session.apply(&snapshot, reconcile)?,
    };
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
        let completed = source_watch_retry::run(deadline, || {
            let report = make_plan()?;
            let snapshot = capture(&report)?;
            live_contract
                .as_ref()
                .expect("watch contract established before initial apply")
                .verify(&report.plan, snapshot.receipt())?;
            let reviewed_contract =
                project::live_source::Contract::from_plan(&report.plan, snapshot.receipt())?;
            if snapshot.receipt().revision == revision {
                return Ok(source_watch_retry::Attempt::Complete(None));
            }
            match session.try_apply_reviewed(&snapshot, &reviewed_contract, deadline)? {
                None => Ok(source_watch_retry::Attempt::Busy),
                Some(receipt) => Ok(source_watch_retry::Attempt::Complete(Some((
                    receipt,
                    snapshot.receipt().revision.clone(),
                )))),
            }
        })?;
        let Some((receipt, next_revision)) = completed else {
            continue;
        };
        revision = next_revision;
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
