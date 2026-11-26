use super::*;
use crate::provider::state;
use serde_json::json;

fn verifier_spec() -> MachineSpec {
    MachineSpec {
        cpus: 1,
        memory_mib: 1024,
        storage_gib: 4,
        overlay_gib: 4,
        engine_share: None,
        amd64_translation: false,
        project_shares: Vec::new(),
        network: crate::provider::NetworkIntent::Isolated,
        exposed_sockets: Vec::new(),
        mounted_sockets: Vec::new(),
    }
}

#[test]
fn verifier_creation_preserves_the_command_without_engine_or_shares() {
    assert_eq!(
        create_arguments("fixture", "owner", &verifier_spec()).unwrap(),
        [
            "machine",
            "create",
            "--name",
            "fixture",
            "--label",
            "hack-local.owner=owner",
            "--cpus",
            "1",
            "--mem",
            "1024",
            "--storage",
            "4",
            "--overlay",
            "4"
        ]
    );
}

#[test]
fn pool_creation_preserves_flag_order_and_socket_directions() {
    let mut candidate = Candidate::discover(Path::new(env!("CARGO_MANIFEST_DIR"))).unwrap();
    candidate.state_root = "/fixture/state".into();
    // Canonicalize the temporary root before approving a share (notably /var on macOS).
    let project = std::fs::canonicalize(std::env::temp_dir())
        .unwrap()
        .join(format!(
            "backend-share-{}-{}",
            std::process::id(),
            crate::next_test_scratch(),
        ));
    struct Remove(std::path::PathBuf);
    impl Drop for Remove {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    state::private_directory(&project).unwrap();
    let _remove = Remove(project.clone());
    std::fs::write(project.join("package.json"), "{}").unwrap();
    let share = crate::provider::ProjectShareIntent::approve(&project, true).unwrap();
    let project_volume = format!("{}:{}:rw", project.display(), share.guest_path);
    let engine_volume = format!(
        "{}:/opt/hack-engine:ro",
        artifact::engine_root(&candidate).display()
    );
    let owner: Owner = serde_json::from_value(json!({
        "version":1, "checkout":"/fixture", "token":"owner", "machine":"fixture",
        "short_home":"/fixture/sockets", "created":false, "phase":"creating", "process":null,
        "storage":null, "overlay":null, "guest_boot_id":null,
        "daemon_pid":null, "daemon_start":null, "rootfs_digest":null,
        "amd64_emulation":true, "network":"internet", "project_share":share,
        "application_bridge":{"slots":1}, "dependency_sockets":{"slots":1}
    }))
    .unwrap();
    let spec = crate::provider::lifecycle::pool_spec(
        &candidate,
        &owner,
        crate::provider::Profile::Research,
    );
    assert_eq!(
        create_arguments("fixture", "owner", &spec).unwrap(),
        [
            "machine",
            "create",
            "--name",
            "fixture",
            "--label",
            "hack-local.owner=owner",
            "--cpus",
            "2",
            "--mem",
            "2048",
            "--storage",
            "4",
            "--overlay",
            "4",
            "--docker-socket",
            "--volume",
            &engine_volume,
            "--rosetta",
            "--volume",
            &project_volume,
            "--net",
            "--net-backend",
            "virtio-net",
            "--expose-socket",
            "/run/hack-local/bridge-00.sock",
            "--mount-socket",
            "/fixture/sockets/dependency-00.sock:/run/hack-dependencies/dependency-00.sock"
        ]
    );
}

#[test]
fn provider_command_enforces_strict_floor_for_public_egress_modes() {
    let candidate = Candidate::discover(Path::new(env!("CARGO_MANIFEST_DIR"))).unwrap();
    let mut owner: Owner = serde_json::from_value(json!({
        "version":1,"checkout":"/fixture","token":"fixture","machine":"fixture",
        "short_home":"/fixture","created":true,"phase":"stopped","process":null,
        "storage":null,"overlay":null,"guest_boot_id":null,
        "daemon_pid":null,"daemon_start":null,"rootfs_digest":null
    }))
    .unwrap();
    for intent in [
        crate::provider::NetworkIntent::Isolated,
        crate::provider::NetworkIntent::HostGateway,
        crate::provider::NetworkIntent::Internet,
        crate::provider::NetworkIntent::approved_hosts(vec!["registry.example.com".into()])
            .unwrap(),
    ] {
        let approved = matches!(
            &intent,
            crate::provider::NetworkIntent::ApprovedHosts { .. }
                | crate::provider::NetworkIntent::Internet
        );
        owner.network = intent;
        // The same constructor supplies normal start, re-start after stop,
        // recovery and exec. Inspect argv/env only; never spawn a provider.
        for action in ["create", "start", "stop", "exec"] {
            let mut cmd = command(&candidate, &owner);
            cmd.args(["machine", action, "--name", &owner.machine]);
            let env: std::collections::BTreeMap<_, _> = cmd.get_envs().collect();
            assert_eq!(
                env.get(std::ffi::OsStr::new("SMOLVM_EGRESS_FLOOR"))
                    .copied()
                    .flatten(),
                approved.then_some(std::ffi::OsStr::new("strict"))
            );
            for override_name in [
                "SMOLVM_EGRESS_ALLOW_PRIVATE",
                "SMOLVM_ALLOW_HOST_LOOPBACK",
                "SMOLVM_PUBLISH_ADDR",
            ] {
                assert!(!env.contains_key(std::ffi::OsStr::new(override_name)));
            }
        }
    }
}

#[test]
fn provider_command_disables_trim_despite_ambient_override() {
    let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "provider::lifecycle::backend::smolvm_cli::tests::provider_command_uses_recorded_reclamation_policy",
                "--nocapture",
            ])
            .env("SMOLVM_DISK_TRIM", "1")
            .output()
            .unwrap();
    assert!(output.status.success());
    assert!(String::from_utf8_lossy(&output.stdout).contains("provider-trim-disabled"));
}

#[test]
fn provider_command_uses_recorded_reclamation_policy() {
    println!("provider-trim-disabled");
    let candidate = Candidate::discover(Path::new(env!("CARGO_MANIFEST_DIR"))).unwrap();
    let mut owner: Owner = serde_json::from_value(json!({
        "version":1, "checkout":"/fixture", "token":"fixture", "machine":"fixture",
        "short_home":"/fixture", "created":true, "phase":"stopped", "process":null,
        "storage":null, "overlay":null, "guest_boot_id":null,
        "daemon_pid":null, "daemon_start":null, "rootfs_digest":null
    }))
    .unwrap();
    for policy in [
        state::ReclamationPolicy::default(),
        state::ReclamationPolicy {
            enabled: false,
            idle_minutes: None,
        },
    ] {
        owner.reclamation = Some(policy);
        let cmd = command(&candidate, &owner);
        let env: std::collections::BTreeMap<_, _> = cmd.get_envs().collect();
        assert_eq!(
            env[std::ffi::OsStr::new("SMOLVM_DISK_TRIM")],
            Some(std::ffi::OsStr::new("0"))
        );
        assert_eq!(
            env[std::ffi::OsStr::new("SMOLVM_BALLOON_RECLAIM")],
            Some(std::ffi::OsStr::new(if policy.enabled { "1" } else { "0" }))
        );
        assert_eq!(
            env[std::ffi::OsStr::new("SMOLVM_IDLE_RECLAIM")],
            Some(std::ffi::OsStr::new(if policy.enabled { "2" } else { "0" }))
        );
    }
}

#[test]
fn a_failed_provider_command_keeps_the_error_process_run_gives_it() {
    let shell = |script: &str| {
        let mut command = std::process::Command::new("/bin/sh");
        command.args(["-c", script]);
        command
    };
    for script in [
        "echo out; echo 'Error: machine not found' >&2; exit 3",
        "exit 1",
        "i=0; while [ $i -lt 600 ]; do echo 'warning: filler filler filler' >&2; i=$((i+1)); done; exit 2",
    ] {
        let expected = process::run(&mut shell(script), Duration::from_secs(20)).unwrap_err();
        let output = process::capture(&mut shell(script), Duration::from_secs(20)).unwrap();
        let built = failed_provider_command(&output);
        assert_eq!(built.code, expected.code, "{script}");
        assert_eq!(built.message, expected.message, "{script}");
        assert_eq!(built.message_fixed, expected.message_fixed);
    }
}

#[test]
fn provider_command_turns_notifications_off_only_for_a_recorded_choice() {
    let candidate = Candidate::discover(Path::new(env!("CARGO_MANIFEST_DIR"))).unwrap();
    let fixture = json!({
        "version":1, "checkout":"/fixture", "token":"fixture", "machine":"fixture",
        "short_home":"/fixture", "created":true, "phase":"stopped", "process":null,
        "storage":null, "overlay":null, "guest_boot_id":null,
        "daemon_pid":null, "daemon_start":null, "rootfs_digest":null
    });
    // A receipt written before this field existed keeps the provider's notifications.
    let mut owner: Owner = serde_json::from_value(fixture.clone()).unwrap();
    assert_eq!(owner.hot_reload, None);
    let switch = std::ffi::OsStr::new(crate::provider::hot_reload::PROVIDER_SWITCH);
    assert!(
        command(&candidate, &owner)
            .get_envs()
            .all(|(name, _)| name != switch)
    );
    // A boot that keeps them writes nothing new into the receipt.
    assert!(
        serde_json::to_value(&owner)
            .unwrap()
            .get("hot_reload")
            .is_none()
    );
    use crate::provider::hot_reload::{Choice, Reason};
    for (enabled, reason) in [
        (false, Reason::LargeShare),
        (false, Reason::Setting),
        (true, Reason::Setting),
    ] {
        owner.hot_reload = Some(Choice {
            enabled,
            reason,
            limit: 100_000,
        });
        let cmd = command(&candidate, &owner);
        let env: std::collections::BTreeMap<_, _> = cmd.get_envs().collect();
        // Forced on is recorded for the user's sake and starts the provider as usual.
        assert_eq!(
            env.get(switch).copied(),
            (!enabled).then_some(Some(std::ffi::OsStr::new("1")))
        );
        let saved = serde_json::to_value(&owner).unwrap();
        assert_eq!(serde_json::from_value::<Owner>(saved).unwrap(), owner);
    }
}

/// These assignments type-check the actual trait and implementation, without forging
/// tokens or invoking a provider. Removing either token makes this regression fail to
/// compile: Rust has no optional method arguments or arity overloads.
#[test]
fn backend_effects_require_consumed_admission_tokens() {
    fn trait_signatures<B: VmBackend>() {
        let _: fn(&B, &MachineSpec, FreshCreate) -> Result<(), CandidateError> = B::create;
        let _: fn(&B, StartPermit) -> Result<identity::ProcessIdentity, CandidateError> = B::start;
    }
    trait_signatures::<SmolvmCli<'_>>();
    fn implementation_signatures<'a>()
    -> fn(&SmolvmCli<'a>, StartPermit) -> Result<identity::ProcessIdentity, CandidateError> {
        let _: fn(&SmolvmCli<'a>, &MachineSpec, FreshCreate) -> Result<(), CandidateError> =
            SmolvmCli::<'a>::create;
        SmolvmCli::<'a>::start
    }
    let _ = implementation_signatures();
}

#[test]
fn recorded_identity_preserves_native_start_time_and_provider_executable() {
    let candidate = Candidate::discover(Path::new(env!("CARGO_MANIFEST_DIR"))).unwrap();
    for text in ["123\n456", "123\n456\n", "123\r\n456\r\n"] {
        let recorded = parse_recorded_process(&candidate, text).unwrap();
        assert_eq!(recorded.pid, 123);
        assert_eq!(recorded.start_micros, 456);
        assert_eq!(recorded.uid, unsafe { libc::geteuid() });
        assert_eq!(recorded.executable, binary(&candidate));
    }
}

#[test]
fn invalid_identity_records_preserve_exact_refusals() {
    let candidate = Candidate::discover(Path::new(env!("CARGO_MANIFEST_DIR"))).unwrap();
    for (records, message) in [
        (
            vec!["", "123", "pid\n456", "123\nstart", "2147483648\n456"],
            "SmolVM PID record must include native start time.",
        ),
        (
            vec!["123\n0", "123\n456\nextra", "123\n456\n\n"],
            "Ambiguous SmolVM PID record.",
        ),
    ] {
        for record in records {
            let error = parse_recorded_process(&candidate, record).unwrap_err();
            assert_eq!(error.code, "process_identity_unavailable");
            assert_eq!(error.message, message);
        }
    }
}
