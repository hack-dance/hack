mod graph_cli;
mod interactive_exec_cli;
mod log_follow_cli;
mod normalized_cli;
mod prepared_base_cli;
mod runtime_setup_cli;
mod runtime_up_cli;
mod source_watch_retry;
use hack_runtime_core::provider::{AfterForcedStop, LiveRuns, RuntimeStatus};
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
  hack-local project source-size --project <directory> --json
  hack-local project sync-source --project <directory> --file <compose.yaml> --expect-plan <sha256> [--watch] [--reconcile] [--duration-seconds <seconds>] [--json]
  hack-local project sync-status --project <directory> --file <compose.yaml> [--json]
  hack-local project capture --project <directory> --file <compose.yaml> --expect-plan <sha256> [--profile <name>] [--json]
  hack-local project publish-source --project <directory> --file <compose.yaml> --expect-plan <sha256> [--profile <name>] [--reconcile] [--json]
  hack-local project verify-source --project <directory> --file <compose.yaml> --expect-plan <sha256> [--profile <name>] [--json]
  hack-local graph run|restart|restore --project <directory> --file <compose.yaml> --expect-plan <sha256> --run-id <32-hex> --ready <service=started|healthy|completed>... [--source-revision <sha256>] [--live-source] [--profile <name>] [--timeout-seconds <seconds>] [--json]
  hack-local graph inspect|status|observe|reconcile|archive|export|reconcile-export|prune --run-id <32-hex> [--json]
  hack-local graph cleanup --run-id <32-hex> [--remove-data] [--json]
  hack-local graph clear-failure-after-started --run-id <32-hex> [--json]
  hack-local service serve [--idle-seconds <1..86400>] [--drain-seconds <1..60>] [--notify-fd <3..1023>]
      (exit 0 after idle, stop or SIGTERM/SIGINT/SIGHUP; 2 on an error; 3 after a drain that ran out of time)
  hack-local service status|stop
  hack-local graph native plan --source-file <absolute-v2-native-source.json> [--json]
  hack-local graph native run|serve --source-file <absolute-v2-native-source.json> --expect-review <64-hex> [--environment-stdin] [--timeout-seconds <1..300>] [--json]
  hack-local graph native inspect|cleanup --run-id <32-hex> [--json]
  hack-local graph native control --run-id <32-hex> --action status|observe|cleanup [--json]
  hack-local graph inspect-shutdown-rebase --run-id <32-hex> [--json]
  hack-local graph recover-shutdown-rebase --run-id <32-hex> --expect-selection <64-hex> [--json]
  hack-local graph recover-cleanup --run-id <32-hex> --expect-receipt <sha256> [--json]
  hack-local graph recover-live-owner --run-id <32-hex> --expect-receipt <sha256> [--json]
  hack-local graph retire-recovered-publisher --run-id <32-hex> --expect-owner <32-hex> [--json]
  hack-local graph retire-acknowledged-publisher --run-id <32-hex> --expect-owner <32-hex> --expect-receipt <64-hex> --expect-publisher <64-hex> [--json]
  hack-local graph inspect-missing-publication-lock --run-id <32-hex> [--json]
  hack-local graph retire-missing-publication-lock --run-id <32-hex> --expect-selection <64-hex> --accept-quiesced-candidate-home [--json]
  hack-local graph release-acknowledged-dependencies --run-id <32-hex> --expect-owner <32-hex> --expect-receipt <64-hex> --expect-publisher <64-hex> --expect-reservation <64-hex> [--json]
  hack-local graph inspect-host-pin-recovery --run-id <32-hex> [--json]
  hack-local graph recover-host-pins --run-id <32-hex> --expect-selection <64-hex> --accept-legacy-device-rebind [--json]
  hack-local graph inspect-absent-publication-cleanup --run-id <32-hex> --original-owner-file <private-json> --host-inspection-file <private-json> [--json]
  hack-local graph recover-absent-publication-cleanup --run-id <32-hex> --original-owner-file <private-json> --host-inspection-file <private-json> --expect-selection <64-hex> --retain-data --accept-unpinned-post-reboot [--json]
  hack-local graph inspect-source-device-rebind --run-id <32-hex> [--json]
  hack-local graph inspect-cache-quarantine --run-id <32-hex> --volume <logical-volume> --path <declared-relative-directory> [--json]
  hack-local graph quarantine-cache --run-id <32-hex> --volume <logical-volume> --path <declared-relative-directory> --expect-selection <64-hex> [--json]
  hack-local graph resolve-cache-quarantine --run-id <32-hex> --volume <logical-volume> --path <declared-relative-directory> --expect-selection <64-hex> [--json]
  hack-local graph recover-source-device-rebind --run-id <32-hex> --expect-selection <64-hex> --accept-legacy-device-rebind [--json]
  hack-local graph logs --run-id <32-hex> --service <name> [--tail <1..1000>] [--json]
  hack-local graph logs-follow --run-id <32-hex> --service <name> --expect-owner <32-hex> --expect-plan <64-hex> --expect-namespace <64-hex> [--native] [--tail <0..1000>] [--since <unix-seconds>] [--timestamps] [--from-start] [--expect-container <64-hex>] [--selection-only] (frontend lifetime pipe on stdin)
  hack-local graph exec --run-id <32-hex> --service <name> [--workdir /path] [--timeout-seconds <1..120>] [--json] -- <program> [args...]
  hack-local graph dependency-plan --dependencies <reviewed.json> [--json]
  hack-local graph dependency-check --host-pid <pid> --host-port <port> [--json]
  hack-local graph dependency-reservations [--json]
  hack-local graph recover-dependency-reservation --run-id <32-hex> --expect-reservation <sha256> [--json]
  hack-local graph dependency-discover --host-port <port> --executable <absolute-path> [--json]
  hack-local graph dependency-discover --host-port <port> --ancestor-pid <pid> [--json]
  hack-local graph serve --project <directory> --file <compose.yaml> --expect-plan <sha256> --run-id <32-hex> --ready <service=started|healthy|completed>... --dependencies <reviewed.json> --expect-dependencies <sha256> [--source-revision <sha256>] [--live-source] [--profile <name>] [--timeout-seconds <seconds>] [--json]
  hack-local graph owner-status --run-id <32-hex> [--json]
  hack-local graph refresh-dependencies --run-id <32-hex> [--json]
  hack-local graph storage-inventory [--json]
  hack-local runtime probe [--json]
  hack-local runtime publication-hostnames [--json]
  hack-local runtime hostname-authority --socket <path> [--json]
  hack-local runtime recover-hostname-authority --socket <path> --expect-sha256 <sha256> [--json]
  hack-local runtime managed-hostname-authority [--json]
  hack-local runtime recover-quiescent-https --expect-owner <64-hex> --expect-configuration <64-hex> --expect-frontend-pid <pid> --json
  hack-local runtime archive-previous-boot-shared-https --run-id <32-hex> --expect-owner-generation <32-hex> --expect-lease-id <32-hex> --expect-attempt <32-hex> --expect-owner <32-hex> --expect-namespace <64-hex> --expect-plan <64-hex> --json
  hack-local runtime recover-quiescent-https --expect-owner <64-hex> --expect-configuration <64-hex> --expect-frontend-pid <pid> --accept-legacy-device-rebind <run:witness-sha:socket-dev:socket-ino:lock-dev:lock-ino> --json
  hack-local runtime inspect-host-listener --pid <pid> --port <loopback-port> --executable <absolute-path> [--peer-port <open-client-port>] [--json]
  hack-local runtime serve-managed-hostnames [--certificate-name-limit <1..4096> [--caddy-admin-socket <path>]] (owner pipe on stdin)
  hack-local runtime certificate-admission [--json]
  hack-local runtime guest-disk-usage [--json]
  hack-local runtime disk-usage [--scope all|runtime|build|evidence|artifacts|image-archives] [--max-entries <1..1000000>] [--json]
  hack-local runtime stop-hostname-authority --socket <path> --expect-sha256 <sha256> [--json]
  hack-local runtime serve-hostnames --socket <private-unix-path> (owner pipe on stdin)
  hack-local runtime lookup-hostname --hostname <name> [--json]
  hack-local runtime publication-recovery [--json]
  hack-local runtime recover-publications --expect-sha256 <sha256> [--json]
  hack-local runtime dependency-socket-recovery [--json]
  hack-local runtime quiescent-dependency-socket-recovery [--json]
  hack-local runtime recover-quiescent-dependency-sockets --expect-sha256 <hash> [--json]
  hack-local runtime recover-dependency-sockets --expect-sha256 <sha256> [--json]
  hack-local runtime bridge-recovery [--json]
  hack-local runtime export-bridge-recovery --slot <1..8> --expect-sha256 <sha256> [--json]
  hack-local runtime engine-info [--json]
  hack-local graph reserve-bridge --run-id <32-hex> --service <name> --slot <index> --expect-generation <sha256> [--json]
  hack-local graph serve ... [--route-slot <service=index|auto>]...
  hack-local graph serve|serve-restore ... [--auto-dependency-slots]
  hack-local graph serve|serve-restore ... [--report-started]
  hack-local graph start-bridge --run-id <32-hex> --slot <index> --expect-reservation <32-hex> [--json]
  hack-local graph publish-bridge --run-id <32-hex> --slot <index> --expect-reservation <32-hex> (--port <loopback-port> | --unix [--hostname <name>]...)
  hack-local graph unpublish-bridge --run-id <32-hex> --expect-reservation <32-hex> [--json]
  hack-local graph release-bridge --run-id <32-hex> --slot <index> --expect-reservation <32-hex> [--json]
  hack-local graph bridges|reconcile-bridges --run-id <32-hex> [--json]
  hack-local runtime probe|up --profile research|development [--json]
  hack-local runtime up --profile research|development [--bridge-sockets <1..32> | --minimum-bridge-sockets <1..32>] [--dependency-sockets <1..32> | --minimum-dependency-sockets <1..32>] [--json]
  hack-local runtime up --profile development --project-share <exact-project-root> --unfiltered-source [--json]
  hack-local runtime check-project-share --project-share <exact-project-root> --unfiltered-source --json
  hack-local runtime project-share add --project-share <exact-project-root> --unfiltered-source --json
  hack-local runtime project-share remove --project-share <absolute-recorded-root> --json
  hack-local graph serve|run ... --shared-source
  hack-local runtime prepare --archive <pinned-smolvm.tar.gz>
  hack-local runtime setup [--accept-downloads] [--no-interactive] [--json]
  hack-local runtime setup --archive <pinned-smolvm.tar.gz> --engine-archive <pinned-docker.tgz> --network-tools-directory <private-pinned-apks> [--builder <pinned-docker-buildx>] [--json]
  hack-local runtime prepare-engine --archive <pinned-docker.tgz>
  hack-local runtime prepare-builder --archive <pinned-docker-buildx>
  hack-local runtime prepare-network-tools --directory <private-pinned-apk-directory>
  hack-local runtime up --profile research|development --prepared-base prefer|require [--prepared-base-store <absolute-private-store>] [--json]
  hack-local runtime prepared-base build --profile research|development [--base-id <id>] [--store <absolute-private-store>] [--json]
  hack-local runtime prepared-base verify --base-id <id> [--store <absolute-private-store>] [--json]
  hack-local runtime prepared-base status --profile research|development [--store <absolute-private-store>] [--json]
  hack-local runtime prepared-base remove --base-id <id> [--store <absolute-private-store>] [--json]
  hack-local runtime admit-image --reference <[registry/]repository[:tag][@sha256:digest]|sha256:image-id> --json [IMAGE-POLICY]
  hack-local runtime build-image --request <private-0600-request.json> --json
  hack-local runtime reclaim-build-images [--best-effort] --json
  hack-local runtime retain-build-bases --json [IMAGE-POLICY]
  hack-local runtime ensure-image --reference <[registry/]repository[:tag]|[registry/]repository@sha256:digest|sha256:image-id> [--emulation native|prefer-native|amd64] --json [IMAGE-POLICY]
  hack-local runtime cache-image --reference REF [--emulation native|prefer-native|amd64] --json [IMAGE-POLICY]
  hack-local runtime image-tag-status --json [REFERENCE...]
  hack-local runtime up ... --amd64-emulation [--json]
  hack-local runtime resolve-image --reference <[registry/]repository[:tag]> --json [IMAGE-POLICY]
  hack-local runtime fetch-image --reference <[registry/]repository@sha256:digest> --archive <new-flat-image.tar> [--json] [IMAGE-POLICY]
  hack-local runtime load-image --archive <flat-image.tar> --sha256 <archive-hash> --image-id <sha256:config-hash> [IMAGE-POLICY]
    IMAGE-POLICY: [--image-budget-mib N] [--image-cache-mib N] [--allow-local-registry [http://]host[:port]]... [--docker-config <absolute-dir>]
  hack-local runtime network internet --json
  hack-local runtime up --profile development --internet --json
  hack-local runtime network extend --allow-host <hostname> [--allow-host <hostname>] --json
  hack-local runtime up|status|down|recover [--json]
  hack-local runtime down --force [--json]
  hack-local runtime temp-aliases [--fix [--include-unverified-volumes]] --json
  hack-local runtime repair-provider-tree [--json]
  hack-local runtime host-filesystem-recovery [--json]
  hack-local runtime recover-host-filesystem --expect-sha256 <sha256> --accept-legacy-device-rebind [--json]
  hack-local node serve|status|inspect
  hack-local node request <versioned-json>
  hack-local --version
  hack-local --help

Project commands and graph run/serve/serve-restore/source-compatibility/restart/restore accept --branch <canonical-lowercase-dns-label> to select an isolated namespace; omit it for the legacy project namespace. Carry the same selector through review, source publication, and graph admission.
Normalized public input for project plan/capture/publish-source/verify-source and graph run/serve/serve-restore: --normalized-file <path> --expect-original <sha256> --expect-namespace <sha256>. Sync/enroll/restart/restore do not accept it. Stopped normalized graphs use graph restore-selection --run-id RUN --json, then graph serve-restore with the same run/plan, --expect-generation, and fresh serve dependency/environment/route selections.
Build with: ./scripts/build-hack-local.sh
Native graph commands require native-config-plan and are a bounded image-only prerequisite with an owned outbound project network. Foreground serve/control require macOS; ordinary frontend startup remains a separate gate.
Runtime commands affect only the candidate pool. Graph commands support a bounded pinned-image subset; full project up/exec/down remains unimplemented.
The installed hack and its state are never used as a fallback.";

fn main() {
    hack_runtime_core::raise_open_file_limit();
    #[cfg(target_os = "macos")]
    if std::env::args_os().nth(1).as_deref()
        == Some(std::ffi::OsStr::new("--internal-publication-child"))
    {
        hack_runtime_core::timings::exit(
            if hack_runtime_core::provider::publication::run_publication_child().is_ok() {
                0
            } else {
                1
            },
        );
    }
    if let Some(argument) = std::env::args_os()
        .nth(1)
        .and_then(|value| value.into_string().ok())
    {
        hack_runtime_core::timings::enable_argument(&argument);
    }
    // `service serve` sets itself up before anything else can fail or wait:
    // core dumps off, stop signals routed, the starter's notify descriptor
    // taken, then the closed environment. From here on every refusal reaches
    // the starter as one line, and no exit can block on a write.
    if serve_requested() {
        prepare_serve();
    }
    let result = hack_runtime_core::timings::measure_candidate(
        hack_runtime_core::timings::Step::RuntimeDispatch,
        None,
        |_| run(),
    );
    hack_runtime_core::timings::shutdown();
    if let Err(error) = result {
        let line = serde_json::to_string(&error).expect("error is serializable");
        if SERVING.load(std::sync::atomic::Ordering::SeqCst) {
            // A refusal the starter has not heard yet goes to it now. Then no
            // write that could block stands between this and the exit.
            if let Some(file) = early_notify().take() {
                let refused = serde_json::json!({"refused": {"code": error.code}});
                let _ = hack_runtime_core::service::notify(&file, &refused);
            }
            // With a starter waiting, nothing more is written: no write to
            // stderr (a full pipe, a stalled file) can be bounded without
            // changing a descriptor others share. Run by hand, it says why.
            if !STARTER.load(std::sync::atomic::Ordering::SeqCst) {
                eprintln!("{line}");
            }
            // SAFETY: _exit ends the process at once; nothing here relies on cleanup.
            unsafe { libc::_exit(2) }
        }
        // Keep errors structured even before a connection to a runtime exists.
        eprintln!("{line}");
        hack_runtime_core::timings::exit(2);
    }
}

/// Set when `service serve` was given a `--notify-fd`: a starter waits on it.
static STARTER: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// Set once `main` has recognised `service serve`.
static SERVING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// What `prepare_serve` found, for the `serve` arm.
static EARLY_FAILURE: std::sync::Mutex<Option<CandidateError>> = std::sync::Mutex::new(None);
/// The starter's notify descriptor until something writes its one line.
static EARLY_NOTIFY: std::sync::Mutex<Option<std::fs::File>> = std::sync::Mutex::new(None);

fn early_notify() -> std::sync::MutexGuard<'static, Option<std::fs::File>> {
    EARLY_NOTIFY.lock().unwrap_or_else(|p| p.into_inner())
}

/// Where `service serve` stands in the raw arguments, if that is the command:
/// only at the command position, after the optional leading timings argument,
/// `--candidate-root <dir>` and `--step-store <dir>`. The same words inside
/// another command's arguments (a forwarded command, say) are not it.
fn serve_position(arguments: &[std::ffi::OsString]) -> Option<usize> {
    let mut at = 1;
    if arguments
        .get(at)
        .and_then(|argument| argument.to_str())
        .is_some_and(|value| value.starts_with(hack_runtime_core::timings::REQUEST_PREFIX))
    {
        at += 1;
    }
    if arguments.get(at)? != "--candidate-root" {
        return None;
    }
    at += 2;
    if arguments
        .get(at)
        .is_some_and(|argument| argument == "--step-store")
    {
        at += 2;
    }
    (arguments.get(at)? == "service" && arguments.get(at + 1)? == "serve").then_some(at)
}

/// Whether the raw arguments ask for `service serve`.
fn serve_requested() -> bool {
    serve_position(&std::env::args_os().collect::<Vec<_>>()).is_some()
}

/// The `service serve` prelude, before argument checks can refuse. The notify
/// descriptor is claimed before this process opens any descriptor of its own
/// (the signal channel is a socket pair), so a number the starter left closed
/// can never turn out to be ours.
fn prepare_serve() {
    SERVING.store(true, std::sync::atomic::Ordering::SeqCst);
    let core = disable_core_dumps();
    let arguments: Vec<std::ffi::OsString> = std::env::args_os().collect();
    let after_serve = serve_position(&arguments).map_or(arguments.len(), |at| at + 2);
    let reserved = arguments
        .get(1)
        .and_then(|argument| argument.to_str())
        .and_then(hack_runtime_core::timings::requested_fd);
    let rest = &arguments[after_serve..];
    // `--notify-fd` anywhere after `serve`, with or without a usable value,
    // means a starter is waiting: its exit never writes to stderr.
    if let Some(at) = rest.iter().position(|argument| argument == "--notify-fd") {
        STARTER.store(true, std::sync::atomic::Ordering::SeqCst);
        if let Some(value) = rest.get(at + 1).and_then(|value| value.to_str()) {
            *early_notify() = notify_descriptor(value, reserved);
        }
    }
    let failure = core
        .and_then(|()| hack_runtime_core::service::install_stop_signals())
        .err();
    *EARLY_FAILURE.lock().unwrap_or_else(|p| p.into_inner()) = failure;
    keep_closed_environment();
}

fn installed_entrypoint() -> bool {
    cfg!(feature = "installed-candidate") && env!("CARGO_BIN_NAME") == "hack-native"
}

/// The prepared-base request for `runtime up`: an explicit store, or the installed home's
/// `prepared-bases` directory (outside its `.hack-local`, so pool resets never touch it).
/// Development checkouts require an explicit store rather than writing into the source tree.
fn prepared_base_request(
    candidate: &Candidate,
    mode: hack_runtime_core::provider::prepared_start::Mode,
    store: Option<&Path>,
) -> Result<hack_runtime_core::provider::prepared_start::Request, CandidateError> {
    Ok(hack_runtime_core::provider::prepared_start::Request {
        mode,
        store: prepared_base_store(candidate, store)?,
    })
}

fn prepared_base_store(
    candidate: &Candidate,
    store: Option<&Path>,
) -> Result<std::path::PathBuf, CandidateError> {
    match store {
        Some(store) => Ok(store.to_path_buf()),
        None if candidate.channel == "installed-candidate" => {
            Ok(candidate.checkout.join("prepared-bases"))
        }
        None => Err(CandidateError::new(
            "invalid_arguments",
            "A development checkout needs an explicit absolute prepared-base store.",
        )),
    }
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
        .skip_while(|argument| {
            argument
                .to_str()
                .is_some_and(|value| value.starts_with(hack_runtime_core::timings::REQUEST_PREFIX))
        })
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
    let all: Vec<&str> = arguments[2..].iter().map(String::as_str).collect();
    // HACK-2461: an optional `--step-store <dir>` follows the candidate root.
    let command: Vec<&str> = hack_runtime_core::store::take_step_store_argument(&all)?.to_vec();
    if matches!(
        command.as_slice(),
        ["runtime", "temp-aliases", "--json"]
            | ["runtime", "temp-aliases", "--fix", "--json"]
            | [
                "runtime",
                "temp-aliases",
                "--fix",
                "--include-unverified-volumes",
                "--json"
            ]
    ) {
        return print_json(&hack_runtime_core::provider::temp_aliases::sweep(
            command.contains(&"--fix"),
            command.contains(&"--include-unverified-volumes"),
        ));
    }
    // `service serve` takes its notify descriptor first, before this process
    // opens anything else or anything else can fail, so every later refusal
    // (root resolution and discovery included) reaches its starter as a line.
    let mut serving = match command.as_slice() {
        ["service", "serve", rest @ ..] => {
            // `main` already disabled core dumps, routed stop signals, took the
            // notify descriptor and cleared the environment; report what failed.
            let serving = Some(service_serve_arguments(rest)?);
            if let Some(error) = EARLY_FAILURE
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .take()
            {
                return Err(error);
            }
            #[cfg(feature = "service-test-hooks")]
            if rest.contains(&"--test-pause-before-discovery") {
                test_pause_until_signalled();
            }
            serving
        }
        _ => None,
    };
    // First-use observation/setup must work before installed-home discovery:
    // an absent home is an ordinary installation state, not provider_state.
    if installed_entrypoint() {
        let home = Path::new(&arguments[1]);
        match command.as_slice() {
            ["runtime", "setup", "inspect", "--json", "--quiescence"] => {
                return print_json(
                    &hack_runtime_core::provider::setup::inspect_home_quiescence(home)?,
                );
            }
            ["runtime", "setup", "inspect", "--json"] => {
                return print_json(&hack_runtime_core::provider::setup::inspect_home(home)?);
            }
            ["runtime", "setup", arguments @ ..] => {
                runtime_setup_cli::run_home(home, arguments)?;
                hack_runtime_core::provider::temp_aliases::sweep(true, false);
                return Ok(());
            }
            _ => {}
        }
    }
    let requested = resolve_candidate_root(Path::new(&arguments[1]))?;
    // `runtime down [--force] [--json]`, plain or forced (HACK-2477).
    if let Some(live) = runtime_down_form(command.as_slice()) {
        let candidate = discover_candidate(&requested)?;
        let result = runtime_down(&candidate, live)?;
        report_interrupted_runs(&candidate, &result);
        print_json(&result)?;
        return Ok(());
    }
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
        ["service", "serve", ..] => {
            // A failure here returns to `main`, which tells the starter.
            let candidate = discover_candidate(&requested)?;
            let Serving { idle, drain } = serving
                .take()
                .expect("service serve arguments are parsed before dispatch");
            let notify = early_notify().take();
            let served = hack_runtime_core::service::serve(
                &candidate.state_root,
                hack_runtime_core::service::Options {
                    idle,
                    drain,
                    signals: true,
                },
                notify,
            );
            // A drain that ran out of time keeps both locks for a worker that
            // may still run. Exit now, with nothing in between (no message, no
            // flush that a full stderr or stdout could block): the kernel then
            // ends that worker and frees the locks, so the next client can
            // start a service. The exit code says what happened.
            if matches!(&served, Err(error) if error.code == "service_drain_timeout") {
                // SAFETY: _exit ends the process at once; nothing here relies on cleanup.
                unsafe { libc::_exit(SERVICE_DRAIN_TIMEOUT_EXIT) }
            }
            served?;
        }
        ["service", action @ ("status" | "stop")] => {
            let candidate = discover_candidate(&requested)?;
            let op = if *action == "status" {
                "service.status"
            } else {
                "service.retire"
            };
            let answer =
                hack_runtime_core::service::call(&candidate.state_root, op, serde_json::json!({}));
            // Two stops at once: the second may reach the service while it
            // drains and lose its connection. With the socket already gone that
            // is a service that is stopping or stopped, not an I/O failure.
            let answer = match answer {
                // The service refused this stop because it is already stopping:
                // what `stop` asked for is under way.
                Err(error)
                    if *action == "stop"
                        && error.code == "service_refused"
                        && error.message.starts_with("E_SERVICE_DRAINING:") =>
                {
                    Ok(serde_json::json!({
                        "schema": "hack.runtime.service.retire.v1",
                        "draining": true,
                    }))
                }
                Err(error)
                    if *action == "stop"
                        && error.code == "service_closed"
                        && hack_runtime_core::service::paths(&candidate.state_root)
                            .socket
                            .symlink_metadata()
                            .is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound) =>
                {
                    Err(CandidateError::new(
                        "service_absent",
                        "No runtime service is serving this home; it was already stopping.",
                    ))
                }
                other => other,
            };
            print_json(&answer?)?;
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
                hack_runtime_core::timings::exit(2);
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
        ["graph", "logs-follow", arguments @ ..] => {
            log_follow_cli::command(&discover_candidate(&requested)?, arguments)?;
        }
        ["graph", "exec-interactive", arguments @ ..] => {
            let code = interactive_exec_cli::command(&discover_candidate(&requested)?, arguments)?;
            hack_runtime_core::timings::exit(code);
        }
        ["graph", "interactive-sessions", arguments @ ..] => {
            interactive_exec_cli::sessions(&discover_candidate(&requested)?, arguments)?;
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
                    hack_runtime_core::timings::exit(i32::try_from(code).unwrap_or(1));
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
        [
            "runtime",
            "check-project-share",
            "--project-share",
            project,
            "--unfiltered-source",
            "--json",
        ] => {
            let share =
                hack_runtime_core::provider::ProjectShareIntent::approve(Path::new(project), true)?;
            print_json(&hack_runtime_core::provider::check_project_share(
                &discover_candidate(&requested)?,
                &share,
            )?)?;
        }
        [
            "runtime",
            "project-share",
            "add",
            "--project-share",
            project,
            "--unfiltered-source",
            "--json",
        ] => {
            print_json(&hack_runtime_core::provider::add_project_share(
                &discover_candidate(&requested)?,
                Path::new(project),
                true,
            )?)?;
        }
        [
            "runtime",
            "project-share",
            "add",
            "--project-share",
            project,
            "--unfiltered-source",
            "--stop-idle-pool",
            "--json",
        ] => {
            print_json(
                &hack_runtime_core::provider::add_project_share_stopping_idle_pool(
                    &discover_candidate(&requested)?,
                    Path::new(project),
                )?,
            )?;
        }
        [
            "runtime",
            "project-share",
            "remove",
            "--project-share",
            project,
            "--json",
        ] => {
            print_json(&hack_runtime_core::provider::remove_project_share(
                &discover_candidate(&requested)?,
                Path::new(project),
            )?)?;
        }
        ["runtime", "up", arguments @ ..]
            if arguments.contains(&"--bridge-sockets")
                || arguments.contains(&"--minimum-bridge-sockets")
                || arguments.contains(&"--dependency-sockets")
                || arguments.contains(&"--minimum-dependency-sockets")
                || arguments.contains(&"--allow-host")
                || arguments.contains(&"--internet")
                || arguments.contains(&"--project-share")
                || arguments.contains(&"--unfiltered-source")
                || arguments.contains(&"--prepared-base")
                || arguments.contains(&"--amd64-emulation") =>
        {
            let options = runtime_up_cli::parse(arguments)?;
            let share = options
                .project_share
                .as_deref()
                .map(|project| {
                    hack_runtime_core::provider::ProjectShareIntent::approve(project, true)
                })
                .transpose()?;
            let candidate = discover_candidate(&requested)?;
            let retained = options
                .retained
                .as_ref()
                .map(|(run, selection)| (run.as_str(), selection.as_str()));
            let sockets = hack_runtime_core::provider::SocketRequests {
                bridges: options.bridges,
                minimum_bridges: options.minimum_bridges,
                dependencies: options.dependencies,
                minimum_dependencies: options.minimum_dependencies,
            };
            let request = options
                .prepared
                .as_ref()
                .map(|(mode, store)| prepared_base_request(&candidate, *mode, store.as_deref()))
                .transpose()?;
            let started = if request.is_some() || options.amd64_emulation {
                hack_runtime_core::provider::up_with_prepared_base(
                    &candidate,
                    options.profile,
                    sockets,
                    options.network,
                    share,
                    hack_runtime_core::provider::prepared_start::Start {
                        retained,
                        prepared: request.as_ref(),
                        amd64_emulation: options.amd64_emulation,
                    },
                )
            } else {
                hack_runtime_core::provider::up_with_socket_requests(
                    &candidate,
                    options.profile,
                    sockets,
                    options.network,
                    share,
                    retained,
                )
            };
            let started = started?;
            sweep_running_pool(&started.phase, started.process_alive);
            print_json(&started)?;
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
                print_json(&provider::probe_with_profile(&candidate, profile)?)?;
            } else {
                let started = provider::up_with_profile(&candidate, profile)?;
                sweep_running_pool(&started.phase, started.process_alive);
                print_json(&started)?;
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
        #[cfg(target_os = "macos")]
        [
            "runtime",
            "archive-previous-boot-shared-https",
            "--run-id",
            run,
            "--expect-owner-generation",
            generation,
            "--expect-lease-id",
            lease,
            "--expect-attempt",
            attempt,
            "--expect-owner",
            owner,
            "--expect-namespace",
            namespace,
            "--expect-plan",
            plan,
            "--json",
        ] => {
            print_json(
                &hack_runtime_core::provider::shared_https_recovery::archive(
                    &discover_candidate(&requested)?,
                    hack_runtime_core::provider::shared_https_recovery::ArchiveSelection {
                        run,
                        owner_generation: generation,
                        lease_id: lease,
                        attempt,
                        owner,
                        namespace,
                        plan,
                    },
                )?,
            )?;
        }
        [
            "runtime",
            "recover-quiescent-https",
            "--expect-owner",
            owner,
            "--expect-configuration",
            configuration,
            "--expect-frontend-pid",
            pid,
            "--json",
        ] => {
            print_json(&hack_runtime_core::provider::https_recovery::recover(
                &discover_candidate(&requested)?,
                owner,
                configuration,
                pid.parse().map_err(|_| {
                    CandidateError::new("invalid_arguments", "Expected a positive frontend PID.")
                })?,
            )?)?;
        }
        [
            "runtime",
            "recover-quiescent-https",
            "--expect-owner",
            owner,
            "--expect-configuration",
            configuration,
            "--expect-frontend-pid",
            pid,
            "--accept-legacy-device-rebind",
            selection,
            "--json",
        ] => {
            print_json(
                &hack_runtime_core::provider::https_recovery::recover_legacy_device_rebind(
                    &discover_candidate(&requested)?,
                    owner,
                    configuration,
                    pid.parse().map_err(|_| {
                        CandidateError::new(
                            "invalid_arguments",
                            "Expected a positive frontend PID.",
                        )
                    })?,
                    selection,
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
        ["runtime", "inspect-host-listener", rest @ ..] => {
            let _candidate = discover_candidate(&requested)?;
            let (pid, port, executable, peer_port) = match rest {
                ["--pid", pid, "--port", port, "--executable", executable]
                | [
                    "--pid",
                    pid,
                    "--port",
                    port,
                    "--executable",
                    executable,
                    "--json",
                ] => (pid, port, executable, None),
                [
                    "--pid",
                    pid,
                    "--port",
                    port,
                    "--executable",
                    executable,
                    "--peer-port",
                    peer_port,
                    "--json",
                ] => (pid, port, executable, Some(peer_port)),
                _ => return Err(CandidateError::new("invalid_arguments", HELP)),
            };
            let pid = pid.parse::<i32>().map_err(|_| {
                CandidateError::new("invalid_arguments", "Invalid host listener PID.")
            })?;
            let port = port.parse::<u16>().map_err(|_| {
                CandidateError::new("invalid_arguments", "Invalid host listener port.")
            })?;
            let inspected = match peer_port {
                Some(peer_port) => {
                    let peer_port = peer_port.parse::<u16>().map_err(|_| {
                        CandidateError::new("invalid_arguments", "Invalid host peer port.")
                    })?;
                    hack_runtime_core::provider::host_endpoint::inspect_listener_peer(
                        pid,
                        port,
                        Path::new(executable),
                        peer_port,
                    )?
                }
                None => hack_runtime_core::provider::host_endpoint::inspect_listener(
                    pid,
                    port,
                    Path::new(executable),
                )?,
            };
            print_json(&inspected)?;
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
                None,
            )?;
        }
        [
            "runtime",
            "serve-managed-hostnames",
            "--certificate-name-limit",
            limit,
            "--caddy-admin-socket",
            admin,
        ] => {
            let limit = limit.parse::<usize>().map_err(|_| {
                CandidateError::new("certificate_admission", "Invalid certificate name limit.")
            })?;
            hack_runtime_core::provider::hostname_authority::managed::serve_with_certificate_limit(
                &discover_candidate(&requested)?,
                Some(limit),
                Some(std::path::Path::new(admin)),
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
        ["runtime", "quiescent-dependency-socket-recovery"]
        | ["runtime", "quiescent-dependency-socket-recovery", "--json"] => {
            print_json(
                &hack_runtime_core::provider::quiescent_dependency_socket_recovery::inspect(
                    &discover_candidate(&requested)?,
                )?,
            )?;
        }
        [
            "runtime",
            "recover-quiescent-dependency-sockets",
            "--expect-sha256",
            hash,
        ]
        | [
            "runtime",
            "recover-quiescent-dependency-sockets",
            "--expect-sha256",
            hash,
            "--json",
        ] => {
            print_json(
                &hack_runtime_core::provider::quiescent_dependency_socket_recovery::recover(
                    &discover_candidate(&requested)?,
                    hash,
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
        [
            "runtime",
            "prepared-base",
            action @ ("build" | "verify" | "status" | "remove"),
            arguments @ ..,
        ] => {
            let command = prepared_base_cli::parse(action, arguments)?;
            let candidate = discover_candidate(&requested)?;
            match command {
                prepared_base_cli::Command::Build {
                    store,
                    profile,
                    base_id,
                } => print_json(&hack_runtime_core::provider::build_prepared_base(
                    &candidate,
                    &prepared_base_store(&candidate, store.as_deref())?,
                    profile,
                    base_id.as_deref(),
                )?)?,
                prepared_base_cli::Command::Verify { store, base_id } => {
                    print_json(&hack_runtime_core::provider::verify_prepared_base(
                        &candidate,
                        &prepared_base_store(&candidate, store.as_deref())?,
                        &base_id,
                    )?)?
                }
                prepared_base_cli::Command::Status { store, profile } => {
                    print_json(&hack_runtime_core::provider::prepared_base_status(
                        &candidate,
                        &prepared_base_store(&candidate, store.as_deref())?,
                        profile,
                    )?)?
                }
                prepared_base_cli::Command::Remove { store, base_id } => {
                    hack_runtime_core::provider::remove_prepared_base(
                        &prepared_base_store(&candidate, store.as_deref())?,
                        &base_id,
                    )?;
                    print_json(&serde_json::json!({ "removed": base_id }))?
                }
            }
        }
        ["runtime", "setup", "inspect", "--json"] => {
            print_json(&hack_runtime_core::provider::setup::inspect_candidate(
                &discover_candidate(&requested)?,
            )?)?;
        }
        ["runtime", "setup", arguments @ ..] => {
            runtime_setup_cli::run(&discover_candidate(&requested)?, arguments)?;
            hack_runtime_core::provider::temp_aliases::sweep(true, false);
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
        ["runtime", "prepare-builder", "--archive", archive] => {
            print_json(&hack_runtime_core::provider::prepare_builder(
                &discover_candidate(&requested)?,
                Path::new(archive),
            )?)?;
        }
        ["runtime", "ensure-images", "--json", flags @ ..] => {
            use std::io::Read;
            let mut input = Vec::new();
            std::io::stdin()
                .take(65_537)
                .read_to_end(&mut input)
                .map_err(|_| {
                    CandidateError::new("invalid_arguments", "Cannot read the image batch.")
                })?;
            let jobs: Vec<(
                String,
                hack_runtime_core::provider::image_platform::PlatformPolicy,
            )> = serde_json::from_slice(&input)
                .map_err(|_| CandidateError::new("invalid_arguments", "Invalid image batch."))?;
            if input.len() > 65_536 || jobs.len() > 64 {
                return Err(CandidateError::new(
                    "invalid_arguments",
                    "Image batch exceeds its input bound.",
                ));
            }
            print_json(&hack_runtime_core::provider::image_ensure::ensure_batch(
                &discover_candidate(&requested)?,
                &jobs,
                &image_policy(flags)?,
            )?)?;
        }
        [
            "runtime",
            command @ ("ensure-image" | "cache-image"),
            "--reference",
            reference,
            "--json",
            policy @ ..,
        ] => {
            image_for_command(&requested, command, reference, "native", policy)?;
        }
        [
            "runtime",
            command @ ("ensure-image" | "cache-image"),
            "--reference",
            reference,
            "--emulation",
            emulation,
            "--json",
            policy @ ..,
        ] => {
            image_for_command(&requested, command, reference, emulation, policy)?;
        }
        [
            "runtime",
            "image-tag-status",
            "--present",
            "--json",
            references @ ..,
        ] => {
            print_json(&hack_runtime_core::provider::image_ensure::present_tags(
                &discover_candidate(&requested)?,
                references,
            )?)?;
        }
        ["runtime", "image-tag-status", "--json", references @ ..] => {
            print_json(&hack_runtime_core::provider::image_ensure::tag_status(
                &discover_candidate(&requested)?,
                references,
            )?)?;
        }
        [
            "runtime",
            "build-image",
            "--request",
            request,
            "--bases",
            "--json",
        ] => {
            print_json(&hack_runtime_core::provider::image_build::build_bases(
                Path::new(request),
            )?)?;
        }
        ["runtime", "build-image", "--request", request, "--json"] => {
            // Build output streams to stderr; only the result is printed on stdout.
            print_json(&hack_runtime_core::provider::image_build::build_image(
                &discover_candidate(&requested)?,
                Path::new(request),
            )?)?;
        }
        ["runtime", "retain-build-bases", "--json", policy @ ..] => {
            print_json(&hack_runtime_core::provider::image_build::retain::run(
                &discover_candidate(&requested)?,
                image_policy(policy)?,
            )?)?;
        }
        ["runtime", "reclaim-build-images", "--best-effort", "--json"] => {
            // Never fails: a refusal is reported as `skipped`, for callers such as `up`.
            print_json(
                &hack_runtime_core::provider::image_build::reclaim::reclaim_build_images_best_effort(
                    &discover_candidate(&requested)?,
                ),
            )?;
        }
        ["runtime", "reclaim-build-images", "--json"] => {
            print_json(
                &hack_runtime_core::provider::image_build::reclaim::reclaim_build_images(
                    &discover_candidate(&requested)?,
                )?,
            )?;
        }
        [
            "runtime",
            "admit-image",
            "--reference",
            reference,
            "--json",
            policy @ ..,
        ] => {
            // Pure: no candidate discovery, network, credentials or runtime effects.
            print_json(&hack_runtime_core::provider::registry_image::admit(
                reference,
                &image_policy(policy)?,
            )?)?;
        }
        [
            "runtime",
            "resolve-image",
            "--reference",
            reference,
            "--json",
            policy @ ..,
        ] => {
            print_json(&hack_runtime_core::provider::registry_image::resolve(
                reference,
                &image_policy(policy)?,
            )?)?;
        }
        [
            "runtime",
            "fetch-image",
            "--reference",
            reference,
            "--archive",
            archive,
            rest @ ..,
        ] => {
            let policy = image_policy(rest.strip_prefix(&["--json"]).unwrap_or(rest))?;
            print_json(&hack_runtime_core::provider::registry_image::acquire(
                reference,
                Path::new(archive),
                &policy,
                policy.archive_limit,
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
            policy @ ..,
        ] => {
            print_json(&hack_runtime_core::provider::load_image_with(
                &discover_candidate(&requested)?,
                Path::new(archive),
                digest,
                image,
                &image_policy(policy)?,
            )?)?;
        }
        ["runtime", "host-filesystem-recovery"]
        | ["runtime", "host-filesystem-recovery", "--json"] => {
            print_json(&hack_runtime_core::provider::host_filesystem::inspect(
                &discover_candidate(&requested)?,
            )?)?;
        }
        [
            "runtime",
            "recover-host-filesystem",
            "--expect-sha256",
            hash,
            "--accept-legacy-device-rebind",
        ]
        | [
            "runtime",
            "recover-host-filesystem",
            "--expect-sha256",
            hash,
            "--accept-legacy-device-rebind",
            "--json",
        ] => {
            print_json(&hack_runtime_core::provider::host_filesystem::recover(
                &discover_candidate(&requested)?,
                hash,
            )?)?;
        }
        ["runtime", "repair-provider-tree"] | ["runtime", "repair-provider-tree", "--json"] => {
            print_json(&hack_runtime_core::provider::repair_provider_trees(
                &discover_candidate(&requested)?,
            )?)?;
        }
        ["runtime", action] | ["runtime", action, "--json"] => {
            let candidate = discover_candidate(&requested)?;
            let result = match *action {
                "up" => hack_runtime_core::provider::up(&candidate),
                "status" => hack_runtime_core::provider::status(&candidate),
                "recover" => hack_runtime_core::provider::recover(&candidate),
                _ => return Err(CandidateError::new("unsupported_command", HELP)),
            }?;
            report_interrupted_runs(&candidate, &result);
            if *action == "up" {
                sweep_running_pool(&result.phase, result.process_alive);
            }
            print_json(&result)?;
        }
        _ => return Err(CandidateError::new("unsupported_command", HELP)),
    }
    Ok(())
}

/// `runtime down [--force]`. Typed by hand, a refusal also says on stderr which runs
/// keep the pool in use and how to stop it anyway (HACK-2477); the structured error
/// follows as usual.
fn runtime_down(candidate: &Candidate, live: LiveRuns) -> Result<RuntimeStatus, CandidateError> {
    hack_runtime_core::provider::down(candidate, live).inspect_err(|error| {
        if let Some(line) = live_runs_refusal_line(error, |run| {
            hack_runtime_core::provider::after_forced_stop(candidate, run)
        }) {
            eprintln!("{line}");
        }
    })
}

/// The stderr line of a `runtime down` refused over live runs (HACK-2477); `None` for
/// any other error. The ids are the `live_runs` of `runtime status`. It names, for each
/// run, what recovers it after `--force` (HACK-2715), from `kind`.
fn live_runs_refusal_line(
    error: &CandidateError,
    kind: impl Fn(&str) -> AfterForcedStop,
) -> Option<String> {
    if error.code != "runtime_down_live_runs" {
        return None;
    }
    let runs = error
        .refusals
        .as_ref()
        .map(|refusals| refusals.live_runs.clone())
        .unwrap_or_default();
    Some(format!(
        "Did not stop the native runtime: project runs are running in it ({}). Run hack down in each project first (hack down --recover for a run whose hack up has exited), or runtime down --force to stop it under them. After --force: {}",
        runs.join(", "),
        forced_stop_plan(&runs, kind)
    ))
}

/// For each run stopped (or about to be stopped) with the pool, the command that brings
/// it back in its project, grouped by [`AfterForcedStop`] (HACK-2715). Names a command
/// only where it works; a run nothing recovers from a stopped pool is said to need
/// `hack down` before the pool stops.
fn forced_stop_plan(runs: &[String], kind: impl Fn(&str) -> AfterForcedStop) -> String {
    let group = |wanted: AfterForcedStop| {
        runs.iter()
            .filter(|run| kind(run) == wanted)
            .cloned()
            .collect::<Vec<_>>()
            .join(", ")
    };
    let mut parts = Vec::new();
    let up = group(AfterForcedStop::HackUp);
    if !up.is_empty() {
        parts.push(format!(
            "hack up in its project recovers {up} (Compose) with its data kept"
        ));
    }
    let cleanup = group(AfterForcedStop::ExplicitCleanup);
    if !cleanup.is_empty() {
        parts.push(format!(
            "hack up does not recover {cleanup} (a Compose run caught starting or stopping): once its owner has exited, the explicit dead-owner cleanup (graph recover-cleanup, native-candidate guide) clears it while the pool is stopped, data kept"
        ));
    }
    let native = group(AfterForcedStop::HackDownThenUp);
    if !native.is_empty() {
        parts.push(format!(
            "hack down, then hack up, in its project recovers {native} (native-authored) with its data kept"
        ));
    }
    let unrecorded = group(AfterForcedStop::HackDownUnlessUnrecorded);
    if !unrecorded.is_empty() {
        parts.push(format!(
            "hack down in its project clears {unrecorded} (a native-authored start caught mid-way), data kept, only if no container or network whose create it never recorded is present; if one is, hack down refuses and keeps it, and no command clears it yet"
        ));
    }
    let stranded = group(AfterForcedStop::StopFirst);
    if !stranded.is_empty() {
        parts.push(format!(
            "nothing recovers {stranded} from a stopped pool (a native-authored run with persistent data, a live source, a custom network or a managed environment, a Compose run caught restoring or restarting, or an unreadable receipt): its data is kept, but stop it with hack down in its project before the pool stops"
        ));
    }
    format!("{}.", parts.join("; "))
}

/// What a `runtime down` command does with live runs: refuse (plain) or stop the pool
/// under them (`--force`, before or after `--json`). `None` for any other command.
fn runtime_down_form(arguments: &[&str]) -> Option<LiveRuns> {
    match arguments {
        ["runtime", "down"] | ["runtime", "down", "--json"] => Some(LiveRuns::Refuse),
        ["runtime", "down", "--force"]
        | ["runtime", "down", "--force", "--json"]
        | ["runtime", "down", "--json", "--force"] => Some(LiveRuns::Interrupt),
        _ => None,
    }
}

/// Typed by hand: say what stopped with the pool and what brings each run back
/// (HACK-2456, HACK-2715).
fn report_interrupted_runs(candidate: &Candidate, result: &RuntimeStatus) {
    if let Some(line) = interrupted_runs_line(result, |run| {
        hack_runtime_core::provider::after_forced_stop(candidate, run)
    }) {
        eprintln!("{line}");
    }
}

fn interrupted_runs_line(
    result: &RuntimeStatus,
    kind: impl Fn(&str) -> AfterForcedStop,
) -> Option<String> {
    if let Some(runs) = result
        .interrupted_runs
        .as_ref()
        .filter(|runs| !runs.is_empty())
    {
        Some(format!(
            "Stopped the native runtime while {} project run(s) were running; their containers stopped with it and their data is kept. To start the runtime again and recover them: {}{}",
            runs.len(),
            forced_stop_plan(runs, kind),
            interrupted_owners_note(result.interrupted_owners.as_ref())
        ))
    } else if result.interrupted_runs_unknown {
        Some(
            "Stopped the native runtime. Its graph runs could not be read, so any that were running are not listed; hack up in a Compose project, or hack down then hack up in a native-authored one, recovers a ready run when its receipt can be read."
                .to_owned(),
        )
    } else {
        None
    }
}

/// What the interrupted native owners did after the forced stop (HACK-2715 review round
/// 2), per run; empty when none was running.
fn interrupted_owners_note(
    owners: Option<&hack_runtime_core::provider::InterruptedOwners>,
) -> String {
    let Some(owners) = owners else {
        return String::new();
    };
    let mut note = String::new();
    if !owners.exited.is_empty() {
        note.push_str(&format!(
            " The native owner of {} noticed the stop and exited, keeping its run for hack down.",
            owners.exited.join(", ")
        ));
    }
    if !owners.running.is_empty() {
        note.push_str(&format!(
            " The native owner of {} was still running when this command stopped waiting; hack down in its project asks it to stop (that needs no running pool) and recovers the run.",
            owners.running.join(", ")
        ));
    }
    note
}

fn sweep_running_pool(phase: &str, process_alive: Option<bool>) {
    if phase == "running" && process_alive == Some(true) {
        hack_runtime_core::provider::temp_aliases::sweep(true, false);
    }
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
        "source-size",
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
    let mut branch = None;
    let mut file = None;
    let mut expected = None;
    let mut profiles = Vec::new();
    let mut start_managed_services = Vec::new();
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
            "--branch" if branch.is_none() => {
                hack_runtime_core::validate_branch(value)?;
                branch = Some(*value);
            }
            "--file" if file.is_none() => file = Some(*value),
            "--expect-plan" if expected.is_none() => expected = Some(*value),
            "--profile" if profiles.len() < 64 => profiles.push((*value).to_owned()),
            "--start-managed-service"
                if *action == "plan"
                    && start_managed_services.len() < project::MAX_COMPOSE_SERVICES =>
            {
                start_managed_services.push((*value).to_owned());
            }
            _ => return Err(CandidateError::new("invalid_arguments", HELP)),
        }
    }
    let source = Path::new(
        source.ok_or_else(|| CandidateError::new("invalid_arguments", "--project is required."))?,
    );
    if *action == "source-size" {
        if !json || branch.is_some() || file.is_some() || expected.is_some() || !profiles.is_empty()
        {
            return Err(CandidateError::new("invalid_arguments", HELP));
        }
        // Metadata only: no content is read and no state is written.
        let preview = candidate.plan(source)?;
        return print_json(&project::source_budget::report(&preview.source)?);
    }
    if *action == "status" {
        if file.is_some() || expected.is_some() || !profiles.is_empty() {
            return Err(CandidateError::new("invalid_arguments", HELP));
        }
        let status = project::status_with_branch(candidate, source, branch)?;
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
        branch,
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
        let mut report = normalized_cli::review(candidate, options, normalized.as_ref())?;
        project::review_start_delivery(&mut report, &start_managed_services)?;
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
                    println!(
                        "  depends on {dependency}: {}{}",
                        detail.condition,
                        if detail.required { "" } else { " (optional)" }
                    );
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
            // A human review that reports errors fails like `compose config` does.
            // JSON keeps exit 0: the report is the result, and its consumers read
            // `diagnostics` and `enrollment_compatible` (Hack plans original input
            // that normalization later adapts).
            plan_text_result(&report.plan.diagnostics)?;
        }
    }
    Ok(())
}

/// Text-mode `project plan` exits non-zero when any diagnostic is an error.
fn plan_text_result(
    diagnostics: &[hack_runtime_core::project::Diagnostic],
) -> Result<(), CandidateError> {
    if diagnostics
        .iter()
        .any(|finding| finding.severity == "error")
    {
        return Err(CandidateError::new(
            "plan_diagnostics",
            "The project plan reported error diagnostics; review them above.",
        ));
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
                branch: options.branch,
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

fn image_for_command(
    requested: &Path,
    command: &str,
    reference: &str,
    emulation: &str,
    flags: &[&str],
) -> Result<(), CandidateError> {
    use hack_runtime_core::provider::{image_ensure, image_platform::PlatformPolicy};

    let emulation = PlatformPolicy::parse(emulation).ok_or_else(|| {
        CandidateError::new(
            "invalid_arguments",
            "Use emulation native, prefer-native or amd64.",
        )
    })?;
    let candidate = discover_candidate(requested)?;
    let policy = image_policy(flags)?;
    let result = if command == "cache-image" {
        image_ensure::cache(&candidate, reference, &policy, emulation)?
    } else {
        image_ensure::ensure_with(&candidate, reference, &policy, emulation)?
    };
    print_json(&result)
}

fn image_policy(
    flags: &[&str],
) -> Result<hack_runtime_core::provider::image_policy::ImagePolicy, CandidateError> {
    hack_runtime_core::provider::image_policy::ImagePolicy::from_flags(flags)
}

/// The exit code of a service whose drain ran out of time.
const SERVICE_DRAIN_TIMEOUT_EXIT: i32 = 3;

/// A parsed `service serve`. Its notify descriptor stays in `EARLY_NOTIFY`
/// until `serve` takes it, so `main` can always refuse through it.
struct Serving {
    idle: std::time::Duration,
    drain: std::time::Duration,
}

/// Private input will pass through the service; keep it out of core dumps.
fn disable_core_dumps() -> Result<(), CandidateError> {
    let none = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: a valid rlimit value; lowering a limit needs no privilege.
    if unsafe { libc::setrlimit(libc::RLIMIT_CORE, &none) } != 0 {
        return Err(CandidateError::new(
            "service_core_limit",
            "Could not disable core dumps for the runtime service.",
        ));
    }
    Ok(())
}

/// The service keeps only the closed environment (PATH, HOME, TMPDIR, USER,
/// LOGNAME), whatever its starter passed, so nothing it runs later inherits
/// more. Called while this process is still single-threaded.
fn keep_closed_environment() {
    const KEEP: [&str; 5] = ["PATH", "HOME", "TMPDIR", "USER", "LOGNAME"];
    let others: Vec<std::ffi::OsString> = std::env::vars_os()
        .map(|(name, _)| name)
        .filter(|name| !KEEP.iter().any(|keep| name == keep))
        .collect();
    for name in others {
        // SAFETY: no other thread exists yet to read the environment.
        unsafe { std::env::remove_var(name) };
    }
}

/// `service serve [--idle-seconds <1..86400>] [--drain-seconds <1..60>] [--notify-fd <3..1023>]`.
/// Each option at most once. `main` took the notify descriptor already; a
/// `--notify-fd` it could not use is an argument error like any other.
fn service_serve_arguments(arguments: &[&str]) -> Result<Serving, CandidateError> {
    let invalid = || {
        CandidateError::new(
            "invalid_arguments",
            "Use service serve [--idle-seconds <1..86400>] [--drain-seconds <1..60>] [--notify-fd <3..1023>], each at most once.",
        )
    };
    let mut serving = Serving {
        idle: std::time::Duration::from_secs(300),
        drain: hack_runtime_core::service::DEFAULT_DRAIN,
    };
    let mut seen: Vec<&str> = Vec::new();
    let mut rest = arguments;
    loop {
        match rest {
            [] => break,
            #[cfg(feature = "service-test-hooks")]
            ["--test-pause-before-discovery", tail @ ..] => {
                rest = tail;
                continue;
            }
            [flag, value, tail @ ..] => {
                if seen.contains(flag) {
                    return Err(invalid());
                }
                seen.push(flag);
                match *flag {
                    "--idle-seconds" => {
                        serving.idle = value
                            .parse()
                            .ok()
                            .filter(|s| (1..=86_400).contains(s))
                            .map(std::time::Duration::from_secs)
                            .ok_or_else(invalid)?
                    }
                    "--drain-seconds" => {
                        serving.drain = value
                            .parse()
                            .ok()
                            .filter(|s| (1..=60).contains(s))
                            .map(std::time::Duration::from_secs)
                            .ok_or_else(invalid)?
                    }
                    "--notify-fd" if early_notify().is_some() => {}
                    _ => return Err(invalid()),
                }
                rest = tail;
            }
            [_] => return Err(invalid()),
        }
    }
    Ok(serving)
}

/// Test only: report on stderr that the stop-signal handlers are in place,
/// then wait (at most 30 s) for a stop signal before discovery begins.
#[cfg(feature = "service-test-hooks")]
fn test_pause_until_signalled() {
    eprintln!("paused before discovery");
    let started = std::time::Instant::now();
    while !hack_runtime_core::service::stop_signal_received()
        && started.elapsed() < std::time::Duration::from_secs(30)
    {
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
}

/// Take the starter's notify descriptor: a FIFO or a socket (the transports the
/// bounded notify write supports), open for writing, made close-on-exec, never
/// the descriptor the timings collector owns. `None` if it is unusable.
fn notify_descriptor(value: &str, reserved: Option<i32>) -> Option<std::fs::File> {
    let fd: i32 = value.parse().ok().filter(|fd| (3..=1023).contains(fd))?;
    if Some(fd) == reserved {
        return None;
    }
    hack_runtime_core::service::notify_kind(fd)?;
    // SAFETY: F_GETFL only queries the descriptor's status flags.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || !matches!(flags & libc::O_ACCMODE, libc::O_WRONLY | libc::O_RDWR) {
        return None;
    }
    // SAFETY: F_SETFD on a descriptor just checked to be open.
    if unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } != 0 {
        return None;
    }
    // SAFETY: an open descriptor the starter handed over for this one line; owned here.
    Some(unsafe { <std::fs::File as std::os::fd::FromRawFd>::from_raw_fd(fd) })
}

fn print_json(value: &impl Serialize) -> Result<(), CandidateError> {
    println!(
        "{}",
        serde_json::to_string_pretty(value)
            .map_err(|error| { CandidateError::new("serialization_failed", error.to_string()) })?
    );
    Ok(())
}

#[cfg(test)]
mod usage_tests {
    #[test]
    fn the_usage_names_the_report_started_flag() {
        assert!(
            super::HELP.contains("hack-local graph serve|serve-restore ... [--report-started]")
        );
    }
    /// HACK-2477: every `runtime down` form, in either flag order, and nothing else.
    #[test]
    fn runtime_down_is_plain_or_forced_in_either_flag_order() {
        use super::{LiveRuns, runtime_down_form};
        for (arguments, expected) in [
            (&["runtime", "down"][..], Some(LiveRuns::Refuse)),
            (&["runtime", "down", "--json"][..], Some(LiveRuns::Refuse)),
            (
                &["runtime", "down", "--force"][..],
                Some(LiveRuns::Interrupt),
            ),
            (
                &["runtime", "down", "--force", "--json"][..],
                Some(LiveRuns::Interrupt),
            ),
            (
                &["runtime", "down", "--json", "--force"][..],
                Some(LiveRuns::Interrupt),
            ),
            (&["runtime", "down", "--force", "--force"][..], None),
            (&["runtime", "down", "--json", "--json"][..], None),
            (&["runtime", "down", "--forced"][..], None),
            (&["runtime", "down", "--json", "--force", "x"][..], None),
            (&["runtime", "up", "--force"][..], None),
            (&["runtime", "status", "--json"][..], None),
        ] {
            assert_eq!(runtime_down_form(arguments), expected, "{arguments:?}");
        }
        assert!(super::HELP.contains("hack-local runtime down --force [--json]"));
    }

    /// HACK-2477: the stderr line of a refusal names every live run, the plain and the
    /// `--recover` way out, and `--force`; other errors print nothing of it.
    #[test]
    fn a_live_runs_refusal_names_its_runs_and_the_ways_out() {
        use super::{AfterForcedStop, CandidateError, live_runs_refusal_line};
        let runs = vec!["a".repeat(32), "b".repeat(32)];
        let refused = CandidateError::new("runtime_down_live_runs", "x").with_live_runs(runs);
        let line = live_runs_refusal_line(&refused, |_| AfterForcedStop::HackUp).unwrap();
        assert!(line.contains(&format!("({}, {})", "a".repeat(32), "b".repeat(32))));
        for named in ["hack down", "hack down --recover", "runtime down --force"] {
            assert!(line.contains(named), "{named}");
        }
        for other in [
            "runtime_down_runs_unreadable",
            "process_identity_unavailable",
        ] {
            assert!(
                live_runs_refusal_line(&CandidateError::new(other, "x"), |_| {
                    AfterForcedStop::HackUp
                })
                .is_none()
            );
        }
    }

    /// HACK-2715 review round 2: the forced stop's line names, per run, whether its native
    /// owner exited or was still running, and says nothing when no owner was running.
    #[test]
    fn the_forced_stop_names_what_each_interrupted_owner_did() {
        use super::interrupted_owners_note;
        use hack_runtime_core::provider::InterruptedOwners;
        assert_eq!(interrupted_owners_note(None), "");
        let (exited, running) = ("a".repeat(32), "b".repeat(32));
        let note = interrupted_owners_note(Some(&InterruptedOwners {
            exited: vec![exited.clone()],
            running: vec![running.clone()],
        }));
        assert!(note.contains(&format!(
            "The native owner of {exited} noticed the stop and exited"
        )));
        assert!(note.contains(&format!("The native owner of {running} was still running")));
        assert!(note.contains("hack down in its project asks it to stop"));
        let only_exited = interrupted_owners_note(Some(&InterruptedOwners {
            exited: vec![exited],
            running: vec![],
        }));
        assert!(!only_exited.contains("still running"));
    }

    /// HACK-2715: after `--force`, a ready Compose run comes back with `hack up`, one caught
    /// starting or stopping with the explicit dead-owner cleanup, a native-authored one with
    /// `hack down` then `hack up`, and a run nothing recovers from a stopped pool is named
    /// as such instead of being promised a recovery. Each run is named once, under its own
    /// command.
    #[test]
    fn the_forced_stop_plan_names_the_command_that_works_for_each_run() {
        use super::{AfterForcedStop, CandidateError, forced_stop_plan, live_runs_refusal_line};
        let (compose, native, stranded, starting, unrecorded) = (
            "a".repeat(32),
            "b".repeat(32),
            "c".repeat(32),
            "d".repeat(32),
            "e".repeat(32),
        );
        let kind = |run: &str| match run.as_bytes()[0] {
            b'a' => AfterForcedStop::HackUp,
            b'b' => AfterForcedStop::HackDownThenUp,
            b'd' => AfterForcedStop::ExplicitCleanup,
            b'e' => AfterForcedStop::HackDownUnlessUnrecorded,
            _ => AfterForcedStop::StopFirst,
        };
        let runs = vec![
            compose.clone(),
            native.clone(),
            stranded.clone(),
            starting.clone(),
            unrecorded.clone(),
        ];
        let plan = forced_stop_plan(&runs, kind);
        assert!(plan.contains(&format!(
            "hack up in its project recovers {compose} (Compose)"
        )));
        assert!(plan.contains(&format!(
            "hack down, then hack up, in its project recovers {native} (native-authored)"
        )));
        assert!(plan.contains(&format!("nothing recovers {stranded} from a stopped pool")));
        assert!(plan.contains(&format!("hack up does not recover {starting}")));
        assert!(plan.contains("graph recover-cleanup"));
        assert!(plan.contains(&format!(
            "hack down in its project clears {unrecorded} (a native-authored start caught mid-way)"
        )));
        for run in [&compose, &native, &stranded, &starting, &unrecorded] {
            assert_eq!(plan.matches(run.as_str()).count(), 1, "{run}");
        }
        // A native-authored run is never promised that hack up alone recovers it.
        let only_native = forced_stop_plan(std::slice::from_ref(&native), kind);
        assert!(!only_native.contains("hack up in its project recovers"));
        assert!(!only_native.contains("nothing recovers"));
        // HACK-2715 review round 2 (L3): a mid-start run with an unrecorded member is
        // not promised hack down, then hack up; the line says what hack down does.
        let only_unrecorded = forced_stop_plan(std::slice::from_ref(&unrecorded), kind);
        assert!(
            !only_unrecorded.contains("then hack up"),
            "{only_unrecorded}"
        );
        assert!(only_unrecorded.contains("hack down refuses and keeps it"));
        let refused = CandidateError::new("runtime_down_live_runs", "x").with_live_runs(runs);
        let line = live_runs_refusal_line(&refused, kind).unwrap();
        assert!(line.ends_with(&plan), "{line}");
    }
}
