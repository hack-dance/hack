use super::*;
use std::net::{SocketAddr, TcpListener};

#[test]
fn helper_failure_reports_fixed_stage_and_cause_without_guest_output() {
    for stage in [
        "graph_dependency_rebind_stop",
        "graph_dependency_rebind_launch",
        "graph_dependency_rebind_readiness",
    ] {
        let failure = child_stage::<()>(
            Err(CandidateError::new(
                "relay_private_child",
                "untrusted guest output omitted",
            )),
            stage,
        )
        .unwrap_err();
        assert_eq!(failure.code, stage);
        assert_eq!(failure.cause_code.as_deref(), Some("relay_private_child"));
        assert!(!failure.message.contains("untrusted"));
        child_stage(Ok(()), stage).unwrap();
    }
}

fn process(pid: i32, executable: &str) -> identity::ProcessIdentity {
    identity::ProcessIdentity {
        pid,
        start_micros: 10,
        uid: 501,
        executable: executable.into(),
    }
}
#[test]
fn replacement_requires_original_supervisor_generation_executable_and_user() {
    let supervisor = process(40, "/usr/bin/supervisor");
    let policy = RefreshPolicy {
        executable: "/usr/bin/tunnel".into(),
        host_port: 8443,
        supervisor: supervisor.clone(),
        intermediate_executables: Vec::new(),
    };
    let replacement = process(42, "/usr/bin/tunnel");
    validate_replacement(&policy, &replacement, std::slice::from_ref(&supervisor)).unwrap();
    for parent in [
        identity::ProcessIdentity {
            pid: 41,
            ..supervisor.clone()
        },
        identity::ProcessIdentity {
            start_micros: 11,
            ..supervisor.clone()
        },
        identity::ProcessIdentity {
            uid: 502,
            ..supervisor.clone()
        },
        identity::ProcessIdentity {
            executable: "/usr/bin/other".into(),
            ..supervisor.clone()
        },
    ] {
        assert!(validate_replacement(&policy, &replacement, &[parent]).is_err());
    }
    assert!(
        validate_replacement(
            &policy,
            &process(42, "/usr/bin/other"),
            std::slice::from_ref(&supervisor)
        )
        .is_err()
    );
    assert!(
        validate_replacement(
            &policy,
            &identity::ProcessIdentity {
                uid: 502,
                ..replacement
            },
            std::slice::from_ref(&supervisor)
        )
        .is_err()
    );
    assert!(
        validate_supervisor(
            &process(42, "/usr/bin/tunnel"),
            &process(1, "/sbin/launchd")
        )
        .is_err()
    );
}

#[test]
fn wrapped_policy_rotates_only_intermediate_identities_under_exact_anchor_and_chain() {
    let supervisor = process(40, "/reviewed/wrapper");
    let policy = RefreshPolicy {
        executable: "/reviewed/listener".into(),
        host_port: 8443,
        supervisor: supervisor.clone(),
        intermediate_executables: vec!["/reviewed/aws".into()],
    };
    let replacement = process(42, "/reviewed/listener");
    let rotated = identity::ProcessIdentity {
        start_micros: 20,
        ..process(43, "/reviewed/aws")
    };
    let good = vec![rotated.clone(), supervisor.clone()];
    validate_replacement(&policy, &replacement, &good).unwrap();
    for lineage in [
        vec![],
        vec![supervisor.clone()],
        vec![rotated.clone(), process(41, "/reviewed/wrapper")],
        vec![
            rotated.clone(),
            identity::ProcessIdentity {
                start_micros: 11,
                ..supervisor.clone()
            },
        ],
        vec![process(43, "/other/aws"), supervisor.clone()],
        vec![
            identity::ProcessIdentity {
                uid: 502,
                ..rotated.clone()
            },
            supervisor.clone(),
        ],
        vec![process(42, "/reviewed/aws"), supervisor.clone()],
        vec![rotated.clone(), rotated, supervisor],
    ] {
        assert!(validate_replacement(&policy, &replacement, &lineage).is_err());
    }
    let fingerprint = policy.review_fingerprint().unwrap();
    let mut changed = policy.clone();
    changed.supervisor.start_micros += 1;
    assert_ne!(fingerprint, changed.review_fingerprint().unwrap());
    changed = policy.clone();
    changed.intermediate_executables.clear();
    assert_ne!(fingerprint, changed.review_fingerprint().unwrap());
    changed = policy;
    changed.intermediate_executables[0] = "/other/aws".into();
    assert_ne!(fingerprint, changed.review_fingerprint().unwrap());
}

fn startup(generation: &str, services: &[&str]) -> Startup {
    Startup {
        control_only: false,
        guest_root: Some((1, 1)),
        control_root: "/tmp/unused".into(),
        artifact: "a".repeat(64),
        services: services
            .iter()
            .map(|name| {
                (
                    name.to_string(),
                    Service {
                        generation: "b".repeat(32),
                        phase: Phase::Released,
                        started_at: Some("fixture-start".into()),
                        bindings: BTreeMap::from([(
                            "content".into(),
                            Binding {
                                slot: 0,
                                endpoint_generation: Some(generation.into()),
                                port: 443,
                                aliases: vec!["content.example".into()],
                                process: Some(crate::provider::lifecycle::RelayProcess {
                                    pid: 42,
                                    start: 9,
                                    port: 443,
                                    address: "127.0.0.2".parse().unwrap(),
                                }),
                            },
                        )]),
                    },
                )
            })
            .collect(),
    }
}
fn dependency(
    service: &str,
    endpoint: &HostEndpoint,
    refresh: Option<RefreshPolicy>,
) -> Dependency {
    Dependency {
        service: service.into(),
        binding: "content".into(),
        slot: 0,
        port: 443,
        aliases: vec!["content.example".into()],
        endpoint: endpoint.clone(),
        refresh,
    }
}
fn replace(address: SocketAddr) -> TcpListener {
    let deadline = Instant::now() + Duration::from_secs(1);
    loop {
        match TcpListener::bind(address) {
            Ok(listener) => return listener,
            Err(error)
                if error.kind() == std::io::ErrorKind::AddrInUse && Instant::now() < deadline =>
            {
                std::thread::sleep(Duration::from_millis(1));
            }
            Err(error) => panic!("test listener replacement failed: {error}"),
        }
    }
}
#[test]
fn healthy_fixed_selection_is_noop_and_complete_shared_slot_refreshes_together() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let endpoint = HostEndpoint::capture(std::process::id() as i32, address.port()).unwrap();
    let generation = endpoint.fingerprint().unwrap();
    let startup = startup(&generation, &["web", "search"]);
    let mut dependencies = BTreeMap::from([
        (
            ("web".into(), "content".into()),
            dependency("web", &endpoint, None),
        ),
        (
            ("search".into(), "content".into()),
            dependency("search", &endpoint, None),
        ),
    ]);
    assert!(selections(&dependencies, &startup).unwrap().is_empty());
    let executable = std::env::current_exe().unwrap();
    let policy = RefreshPolicy::capture(&endpoint, &executable, address.port(), 1).unwrap();
    for dependency in dependencies.values_mut() {
        dependency.refresh = Some(policy.clone());
    }
    for kind in 0..3 {
        let mut different = policy.clone();
        match kind {
            0 => different.supervisor.start_micros += 1,
            1 => different
                .intermediate_executables
                .push("/other/parent".into()),
            _ => different.executable = "/other/listener".into(),
        }
        dependencies
            .get_mut(&("web".into(), "content".into()))
            .unwrap()
            .refresh = Some(different);
        assert!(selections(&dependencies, &startup).is_err());
    }
    dependencies
        .get_mut(&("web".into(), "content".into()))
        .unwrap()
        .refresh = Some(policy);
    drop(listener);
    let _replacement = replace(address);
    let selected = selections(&dependencies, &startup).unwrap();
    assert_eq!(selected.len(), 1);
    assert_eq!(selected[0].keys.len(), 2);
    assert_eq!(
        selected[0].expected,
        fingerprint_bytes(&generation).unwrap()
    );
    assert_ne!(selected[0].fingerprint, generation);
    assert_eq!(
        selected[0].endpoint.process_identity().pid,
        std::process::id() as i32
    );
    // A fixed-PID member prevents adopting only part of a shared transport.
    dependencies
        .get_mut(&("web".into(), "content".into()))
        .unwrap()
        .refresh = None;
    assert!(selections(&dependencies, &startup).is_err());
    dependencies.remove(&("web".into(), "content".into()));
    assert!(selections(&dependencies, &startup).is_err());
}
#[test]
fn capture_rejects_different_port_executable_and_unbounded_selection() {
    let first = TcpListener::bind("127.0.0.1:0").unwrap();
    let second = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = HostEndpoint::capture(
        std::process::id() as i32,
        first.local_addr().unwrap().port(),
    )
    .unwrap();
    let executable = std::env::current_exe().unwrap();
    assert!(
        RefreshPolicy::capture(
            &endpoint,
            &executable,
            second.local_addr().unwrap().port(),
            1
        )
        .is_err()
    );
    assert!(
        RefreshPolicy::capture(
            &endpoint,
            Path::new("/usr/bin/true"),
            first.local_addr().unwrap().port(),
            1
        )
        .is_err()
    );
    assert!(RefreshPolicy::capture(&endpoint, &executable, 0, 1).is_err());
    assert!(
        RefreshPolicy::capture(
            &endpoint,
            Path::new("relative"),
            first.local_addr().unwrap().port(),
            1
        )
        .is_err()
    );
    for depth in [0, 9, 255] {
        assert!(
            RefreshPolicy::capture(
                &endpoint,
                &executable,
                first.local_addr().unwrap().port(),
                depth
            )
            .is_err()
        );
    }
}

fn receipt() -> Receipt {
    serde_json::from_value(
        json!({"version":1,"run":"1".repeat(32),"owner":"2".repeat(32),
        "namespace":"fixture","plan_id":"3".repeat(64),"phase":"ready-observed",
        "environment_attached":false,"readiness":{},"resources":{}}),
    )
    .unwrap()
}
#[test]
fn terminal_identity_uses_real_resource_key_and_refuses_unexpected_or_failed_exit() {
    let mut receipt = receipt();
    receipt
        .readiness
        .insert("db-ops".into(), Condition::Completed);
    let resource: Resource = serde_json::from_value(json!({
        "kind":"container","key":"db-ops","name":"owned-db-ops","id":"7".repeat(64),
        "image":"sha256:".to_string()+&"8".repeat(64),"phase":"started"
    }))
    .unwrap();
    receipt
        .resources
        .insert("container:db-ops".into(), resource.clone());
    let service = startup(&"6".repeat(64), &["db-ops"])
        .services
        .remove("db-ops")
        .unwrap();
    let observed = json!({"Id":resource.id,"Image":resource.image,
        "State":{"Status":"exited","Running":false,"Pid":0,"ExitCode":0,"Dead":false,"OOMKilled":false,"StartedAt":"fixture-start"}});
    let generation =
        completed_generation(&receipt, &"9".repeat(32), &resource, &observed, &service).unwrap();
    let mut running = observed.clone();
    running["State"]["Running"] = json!(true);
    assert_eq!(
        generation,
        host_relay::inspected_generation(&receipt, &"9".repeat(32), &resource, &running).unwrap()
    );
    assert!(
        host_relay::inspected_generation(&receipt, &"9".repeat(32), &resource, &observed).is_err()
    );
    for condition in [Condition::Started, Condition::Healthy] {
        receipt.readiness.insert("db-ops".into(), condition);
        assert!(
            completed_generation(&receipt, &"9".repeat(32), &resource, &observed, &service)
                .is_err()
        );
    }
    receipt
        .readiness
        .insert("db-ops".into(), Condition::Completed);
    for (field, value) in [
        ("ExitCode", json!(1)),
        ("Running", json!(true)),
        ("Pid", json!(42)),
        ("Dead", json!(true)),
        ("OOMKilled", json!(true)),
        ("Status", json!("dead")),
        ("StartedAt", json!("different-start")),
        ("ExitCode", Value::Null),
    ] {
        let mut changed = observed.clone();
        changed["State"][field] = value;
        assert!(
            completed_generation(&receipt, &"9".repeat(32), &resource, &changed, &service).is_err(),
            "accepted {field}"
        );
    }
    for field in ["Id", "Image"] {
        let mut changed = observed.clone();
        changed[field] = json!("different-identity");
        assert!(
            completed_generation(&receipt, &"9".repeat(32), &resource, &changed, &service).is_err()
        );
    }
}
#[test]
fn incomplete_journal_blocks_ready_operations_and_is_never_replayed() {
    let root = std::env::temp_dir().canonicalize().unwrap().join(format!(
        "hack-rebind-journal-{}-{}",
        std::process::id(),
        probes::token().unwrap()
    ));
    state::private_directory(&root).unwrap();
    let mut receipt = receipt();
    receipt.relay_startup = Some(startup(&"6".repeat(64), &["web"]));
    let mut journal = RebindJournal {
        version: 1,
        operation: "4".repeat(32),
        run: receipt.run.clone(),
        owner: receipt.owner.clone(),
        boot: "fixture-boot".into(),
        expected_generation: service_exec_generation(&receipt).unwrap(),
        phase: "prepared".into(),
        slots: BTreeMap::from([(
            0,
            JournalSlot {
                before: "5".repeat(64),
                after: "6".repeat(64),
                bindings: vec![("web".into(), "content".into())],
            },
        )]),
        processes: BTreeMap::from([(
            "web".into(),
            BTreeMap::from([(
                "content".into(),
                receipt.relay_startup.as_ref().unwrap().services["web"].bindings["content"]
                    .process
                    .unwrap(),
            )]),
        )]),
        completed_services: BTreeSet::new(),
        completed_generation: None,
    };
    require_complete(&root, &receipt).unwrap();
    fs::write(root.join(JOURNAL).with_extension("pending"), b"interrupted").unwrap();
    assert!(require_complete(&root, &receipt).is_err());
    fs::remove_file(root.join(JOURNAL).with_extension("pending")).unwrap();
    for phase in [
        "prepared",
        "fenced",
        "provisioning",
        "receipt-committed",
        "committed",
        "failed",
    ] {
        journal.phase = phase.into();
        state::write(&root.join(JOURNAL), &journal).unwrap();
        assert_eq!(
            require_complete(&root, &receipt).unwrap_err().code,
            "graph_dependency_rebind_incomplete"
        );
    }
    journal.phase = "completed".into();
    state::write(&root.join(JOURNAL), &journal).unwrap();
    assert!(require_complete(&root, &receipt).is_err());
    journal.completed_generation = Some(service_exec_generation(&receipt).unwrap());
    state::write(&root.join(JOURNAL), &journal).unwrap();
    require_complete(&root, &receipt).unwrap();
    let mut changed = receipt.clone();
    changed
        .relay_startup
        .as_mut()
        .unwrap()
        .services
        .get_mut("web")
        .unwrap()
        .bindings
        .get_mut("content")
        .unwrap()
        .process
        .as_mut()
        .unwrap()
        .start += 1;
    assert!(require_complete(&root, &changed).is_err());
    journal.phase = "cleaned".into();
    state::write(&root.join(JOURNAL), &journal).unwrap();
    assert!(require_complete(&root, &receipt).is_err());
    receipt.phase = "stopped-data-retained".into();
    require_complete(&root, &receipt).unwrap();
    journal.run = "7".repeat(32);
    state::write(&root.join(JOURNAL), &journal).unwrap();
    assert!(require_complete(&root, &receipt).is_err());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn success_response_binds_exact_execution_identity_and_changed_slots() {
    let receipt = receipt();
    for slots in [vec![], vec![0, 2]] {
        assert_eq!(
            response(&receipt, &slots).unwrap(),
            json!({
                "ok":true,"run":receipt.run,"plan":receipt.plan_id,"owner":receipt.owner,
                "namespace":receipt.namespace,"generation":service_exec_generation(&receipt).unwrap(),
                "changed_slots":slots,
            })
        );
    }
}

#[test]
fn exact_owned_cleanup_archives_partial_rebind_and_unblocks_fresh_restore() {
    use std::os::unix::fs::PermissionsExt;
    let root = std::env::temp_dir().canonicalize().unwrap().join(format!(
        "hack-rebind-cleanup-{}-{}",
        std::process::id(),
        probes::token().unwrap()
    ));
    state::private_directory(&root).unwrap();
    let mut original = receipt();
    original.relay_startup = Some(startup(&"6".repeat(64), &["web"]));
    original.resources.insert(
        "container:web".into(),
        serde_json::from_value(json!({
            "kind":"container","key":"web","name":"owned-web","id":"7".repeat(64),
            "image":"sha256:".to_string()+&"8".repeat(64),"phase":"present"
        }))
        .unwrap(),
    );
    let journal = RebindJournal {
        version: 1,
        operation: "4".repeat(32),
        run: original.run.clone(),
        owner: original.owner.clone(),
        boot: "old-boot".into(),
        expected_generation: service_exec_generation(&original).unwrap(),
        phase: "provisioning".into(),
        slots: BTreeMap::from([(
            0,
            JournalSlot {
                before: "5".repeat(64),
                after: "6".repeat(64),
                bindings: vec![("web".into(), "content".into())],
            },
        )]),
        processes: BTreeMap::new(),
        completed_services: BTreeSet::new(),
        completed_generation: None,
    };
    state::write(&root.join(JOURNAL), &journal).unwrap();
    let partial = b"{partial next journal";
    fs::write(root.join("dependency-rebind.pending"), partial).unwrap();
    fs::set_permissions(
        root.join("dependency-rebind.pending"),
        fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    assert!(require_complete(&root, &original).is_err());
    let mut cleaned = original.clone();
    cleaned.phase = "stopped-data-retained".into();
    assert!(archive_after_cleanup(&root, &original, &cleaned, "old-boot").is_err());
    cleaned.resources.get_mut("container:web").unwrap().phase = "absent".into();
    assert!(archive_after_cleanup(&root, &original, &cleaned, "wrong-boot").is_err());
    let mut foreign = cleaned.clone();
    foreign.owner = "9".repeat(32);
    assert!(archive_after_cleanup(&root, &original, &foreign, "old-boot").is_err());
    assert!(root.join(JOURNAL).exists());
    archive_after_cleanup(&root, &original, &cleaned, "old-boot").unwrap();
    let history = root.join(format!(
        "dependency-rebind-history-{}",
        service_exec_generation(&original).unwrap()
    ));
    assert_eq!(
        fs::read(history.join("dependency-rebind.pending")).unwrap(),
        partial
    );
    let proof: Value = state::read(&history.join("proof.json")).unwrap();
    assert_eq!(proof["complete"], true);
    assert_eq!(proof["boot"], "old-boot");
    assert_eq!(
        proof["original_generation"],
        service_exec_generation(&original).unwrap()
    );
    assert_eq!(
        proof["cleaned_generation"],
        service_exec_generation(&cleaned).unwrap()
    );
    assert!(!root.join(JOURNAL).exists());
    require_complete(&root, &cleaned).unwrap();
    let mut restored = original.clone();
    restored
        .relay_startup
        .as_mut()
        .unwrap()
        .services
        .get_mut("web")
        .unwrap()
        .bindings
        .get_mut("content")
        .unwrap()
        .process
        .as_mut()
        .unwrap()
        .start += 1;
    require_complete(&root, &restored).unwrap();
    // Crash after the first archive rename: same cleanup resumes evidence
    // preservation and never interprets pending bytes as an execution intent.
    let mut proof = proof;
    proof["complete"] = json!(false);
    state::write(&history.join("proof.json"), &proof).unwrap();
    fs::rename(history.join(JOURNAL), root.join(JOURNAL)).unwrap();
    archive_after_cleanup(&root, &original, &cleaned, "old-boot").unwrap();
    archive_after_cleanup(&root, &original, &cleaned, "old-boot").unwrap();
    let mut changed = original.clone();
    changed.plan_id = "a".repeat(64);
    assert!(archive_after_cleanup(&root, &changed, &cleaned, "old-boot").is_err());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn terminal_refresh_proofs_do_not_pin_old_helpers_across_owned_restore() {
    let root = std::env::temp_dir().canonicalize().unwrap().join(format!(
        "hack-rebind-terminal-cleanup-{}-{}",
        std::process::id(),
        probes::token().unwrap()
    ));
    state::private_directory(&root).unwrap();
    let mut original = receipt();
    original.relay_startup = Some(startup(&"6".repeat(64), &["web"]));
    let process = original.relay_startup.as_ref().unwrap().services["web"].bindings["content"]
        .process
        .unwrap();
    let journal = RebindJournal {
        version: 1,
        operation: "4".repeat(32),
        run: original.run.clone(),
        owner: original.owner.clone(),
        boot: "old-boot".into(),
        expected_generation: "5".repeat(64),
        phase: "completed".into(),
        completed_services: BTreeSet::new(),
        completed_generation: Some(service_exec_generation(&original).unwrap()),
        slots: BTreeMap::from([(
            0,
            JournalSlot {
                before: "5".repeat(64),
                after: "6".repeat(64),
                bindings: vec![("web".into(), "content".into())],
            },
        )]),
        processes: BTreeMap::from([("web".into(), BTreeMap::from([("content".into(), process)]))]),
    };
    state::write(&root.join(JOURNAL), &journal).unwrap();
    require_complete(&root, &original).unwrap();
    let mut restored = original.clone();
    restored
        .relay_startup
        .as_mut()
        .unwrap()
        .services
        .get_mut("web")
        .unwrap()
        .bindings
        .get_mut("content")
        .unwrap()
        .process
        .as_mut()
        .unwrap()
        .start += 1;
    assert!(require_complete(&root, &restored).is_err());
    let mut cleaned = original.clone();
    cleaned.phase = "stopped-data-retained".into();
    archive_after_cleanup(&root, &original, &cleaned, "old-boot").unwrap();
    require_complete(&root, &restored).unwrap();
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn completed_journal_requires_explicit_terminal_state_and_never_fabricates_helpers() {
    let root = std::env::temp_dir().canonicalize().unwrap().join(format!(
        "hack-rebind-terminal-{}-{}",
        std::process::id(),
        probes::token().unwrap()
    ));
    state::private_directory(&root).unwrap();
    let mut receipt = receipt();
    receipt
        .readiness
        .insert("init".into(), Condition::Completed);
    receipt.relay_startup = Some(startup(&"6".repeat(64), &["web", "init"]));
    let selected = receipt
        .relay_startup
        .as_mut()
        .unwrap()
        .services
        .get_mut("init")
        .unwrap();
    selected.phase = Phase::Completed;
    selected.bindings.get_mut("content").unwrap().process = None;
    assert!(require_complete(&root, &receipt).is_err());
    let journal = RebindJournal {
        version: 1,
        operation: "4".repeat(32),
        run: receipt.run.clone(),
        owner: receipt.owner.clone(),
        boot: "fixture-boot".into(),
        expected_generation: "7".repeat(64),
        phase: "completed".into(),
        slots: BTreeMap::from([(
            0,
            JournalSlot {
                before: "5".repeat(64),
                after: "6".repeat(64),
                bindings: vec![
                    ("web".into(), "content".into()),
                    ("init".into(), "content".into()),
                ],
            },
        )]),
        processes: BTreeMap::from([(
            "web".into(),
            BTreeMap::from([(
                "content".into(),
                receipt.relay_startup.as_ref().unwrap().services["web"].bindings["content"]
                    .process
                    .unwrap(),
            )]),
        )]),
        completed_services: BTreeSet::from(["init".into()]),
        completed_generation: Some(service_exec_generation(&receipt).unwrap()),
    };
    state::write(&root.join(JOURNAL), &journal).unwrap();
    require_complete(&root, &receipt).unwrap();
    for condition in [Condition::Started, Condition::Healthy] {
        let mut changed = receipt.clone();
        changed.readiness.insert("init".into(), condition);
        assert!(require_complete(&root, &changed).is_err());
    }
    for phase in [Phase::Released, Phase::Provisioned, Phase::Prepared] {
        let mut changed = receipt.clone();
        changed
            .relay_startup
            .as_mut()
            .unwrap()
            .services
            .get_mut("init")
            .unwrap()
            .phase = phase;
        assert!(require_complete(&root, &changed).is_err());
    }
    let mut changed = receipt.clone();
    changed
        .relay_startup
        .as_mut()
        .unwrap()
        .services
        .get_mut("web")
        .unwrap()
        .bindings
        .get_mut("content")
        .unwrap()
        .process = None;
    assert!(require_complete(&root, &changed).is_err());
    let mut encoded = serde_json::to_value(&journal).unwrap();
    encoded["processes"]["init"] = encoded["processes"]["web"].clone();
    state::write(&root.join(JOURNAL), &encoded).unwrap();
    assert!(require_complete(&root, &receipt).is_err());
    encoded
        .as_object_mut()
        .unwrap()
        .remove("completed_services");
    encoded["processes"].as_object_mut().unwrap().remove("init");
    state::write(&root.join(JOURNAL), &encoded).unwrap();
    assert!(require_complete(&root, &receipt).is_err());
    // A completed-only operation still has durable intent and must not replay.
    let mut terminal_only = receipt.clone();
    terminal_only
        .relay_startup
        .as_mut()
        .unwrap()
        .services
        .remove("web");
    let mut encoded = serde_json::to_value(journal).unwrap();
    encoded["slots"] = json!({});
    encoded["processes"] = json!({});
    state::write(&root.join(JOURNAL), &encoded).unwrap();
    require_complete(&root, &terminal_only).unwrap();
    for phase in ["prepared", "fenced", "provisioning", "committed", "failed"] {
        encoded["phase"] = json!(phase);
        state::write(&root.join(JOURNAL), &encoded).unwrap();
        assert!(require_complete(&root, &terminal_only).is_err());
    }
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn mixed_completed_binding_retains_metadata_across_noop_and_second_rotation() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let endpoint = HostEndpoint::capture(std::process::id() as i32, address.port()).unwrap();
    let policy = RefreshPolicy::capture(
        &endpoint,
        &std::env::current_exe().unwrap(),
        address.port(),
        1,
    )
    .unwrap();
    let mut startup = startup(&endpoint.fingerprint().unwrap(), &["web", "init"]);
    let completed = startup.services.get_mut("init").unwrap();
    completed.phase = Phase::Completed;
    completed.bindings.get_mut("content").unwrap().process = None;
    let mut dependencies = BTreeMap::from([
        (
            ("web".into(), "content".into()),
            dependency("web", &endpoint, Some(policy.clone())),
        ),
        (
            ("init".into(), "content".into()),
            dependency("init", &endpoint, Some(policy)),
        ),
    ]);
    assert!(selections(&dependencies, &startup).unwrap().is_empty());
    drop(listener);
    let replacement = replace(address);
    let first = selections(&dependencies, &startup).unwrap().remove(0);
    for key in &first.keys {
        dependencies.get_mut(key).unwrap().endpoint = first.endpoint.clone();
        startup
            .services
            .get_mut(&key.0)
            .unwrap()
            .bindings
            .get_mut(&key.1)
            .unwrap()
            .endpoint_generation = Some(first.fingerprint.clone());
    }
    assert!(
        startup.services["init"].bindings["content"]
            .process
            .is_none()
    );
    assert!(selections(&dependencies, &startup).unwrap().is_empty());
    drop(replacement);
    let replacement = replace(address);
    let second = selections(&dependencies, &startup).unwrap().remove(0);
    assert_ne!(first.fingerprint, second.fingerprint);
    assert_eq!(second.keys.len(), 2);
    assert!(
        startup.services["init"].bindings["content"]
            .process
            .is_none()
    );
    startup.services.remove("web");
    dependencies.remove(&("web".into(), "content".into()));
    drop(replacement);
    assert!(selections(&dependencies, &startup).unwrap().is_empty());
    verify_endpoint_generations(&dependencies, &startup).unwrap();
}
