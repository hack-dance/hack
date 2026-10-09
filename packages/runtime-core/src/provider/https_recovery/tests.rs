use super::*;
use std::{
    cell::Cell,
    os::unix::{fs::PermissionsExt, net::UnixListener},
    time::{SystemTime, UNIX_EPOCH},
};

struct Fixture {
    home: PathBuf,
    root: PathBuf,
    journal: Journal,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.home);
    }
}
fn write(path: &Path, bytes: &[u8]) {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .unwrap();
    file.write_all(bytes).unwrap();
}
fn directory(path: &Path) {
    fs::create_dir(path).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
}
fn fixture() -> Fixture {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let home = PathBuf::from(format!(
        "/private/tmp/hr-{}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    directory(&home);
    let root = home.join("native-https");
    directory(&root);
    directory(&root.join("owner.lock"));
    directory(&root.join("shared-owner"));
    directory(&root.join("shared-owner/leases"));
    let listener = UnixListener::bind(root.join("owner.sock")).unwrap();
    fs::set_permissions(root.join("owner.sock"), fs::Permissions::from_mode(0o600)).unwrap();
    drop(listener);
    let socket = inode(&root.join("owner.sock")).unwrap();
    let lock = inode(&root.join("owner.lock")).unwrap();
    let receipt = serde_json::json!({"version":1,"listener":{"pid":999999,"start_micros":1,"uid":unsafe{libc::geteuid()},"executable":"/unused/caddy","port":18443,"fingerprint":"1".repeat(64)},"caddySha256":"2".repeat(64),"caSha256":"3".repeat(64),"authority":{"pid":999998,"socket":"/private/tmp/unused/route.sock","sha256":"4".repeat(64)},"lock":lock,"owner":{"publicKey":"public-key","dev":socket.dev,"ino":socket.ino}});
    let config = serde_json::json!({"version":1,"ownerGeneration":"5".repeat(32),"binding":{"runtime":{"home":home,"binary":"/unused/native"},"frontend":{"binary":"/unused/frontend","sha256":"6".repeat(64)},"runtimeSha256":"7".repeat(64),"caddyBinary":"/unused/caddy","caddySha256":"2".repeat(64),"certificateNameLimit":256,"httpsPort":18443,"pool":{"owner":"8".repeat(32),"bootId":"12345678-1234-1234-1234-123456789012"}}});
    let receipt = serde_json::to_vec(&receipt).unwrap();
    let config = serde_json::to_vec(&config).unwrap();
    write(&root.join("active-owner.json"), &receipt);
    write(&root.join("shared-owner/configuration.json"), &config);
    for name in [
        "data",
        "data/caddy",
        "data/caddy/pki",
        "data/caddy/pki/authorities",
        "data/caddy/pki/authorities/local",
    ] {
        directory(&root.join(name));
    }
    let ca = root.join("data/caddy/pki/authorities/local/root.crt");
    write(&ca, b"retained certificate bytes");
    let journal = Journal {
        version: 1,
        home: home.clone(),
        parent: inode(&root).unwrap(),
        owner_sha256: digest(&receipt),
        configuration_sha256: digest(&config),
        frontend_pid: 999997,
        legacy_device_rebind: None,
        ca: inode(&ca).unwrap(),
        ca_file_sha256: digest(&fs::read(&ca).unwrap()),
        configuration: inode(&root.join("shared-owner/configuration.json")).unwrap(),
        leases: inode(&root.join("shared-owner/leases")).unwrap(),
        entries: [
            "owner.sock",
            "active-owner.json",
            "shared-owner",
            "owner.lock",
        ]
        .iter()
        .map(|name| Entry {
            name: (*name).into(),
            id: inode(&root.join(name)).unwrap(),
        })
        .collect(),
    };
    Fixture {
        home,
        root,
        journal,
    }
}
fn suffix(f: &Fixture) -> String {
    digest(&serde_json::to_vec(&f.journal).unwrap())
}
fn verify_socket(_: &Receipt, _: &Configuration, socket: &Path) -> Result<(), CandidateError> {
    socket_absent(socket)
}
fn all_original(f: &Fixture) {
    for entry in &f.journal.entries {
        assert_eq!(inode(&f.root.join(&entry.name)).unwrap(), entry.id);
    }
}

#[test]
fn archives_exact_inodes_and_bytes_without_changing_ca_and_retry_is_idempotent() {
    let f = fixture();
    let before = fs::read(f.root.join("active-owner.json")).unwrap();
    archive_under(&f.root, &f.journal, verify_socket).unwrap();
    for entry in &f.journal.entries {
        assert!(absent(&f.root.join(&entry.name)).unwrap());
        assert_eq!(
            inode(&destination(&f.root, &entry.name, &suffix(&f))).unwrap(),
            entry.id
        );
    }
    assert_eq!(
        fs::read(
            f.root
                .join(format!("active-owner.json.retired-{}", suffix(&f)))
        )
        .unwrap(),
        before
    );
    assert_eq!(
        inode(&f.root.join("data/caddy/pki/authorities/local/root.crt")).unwrap(),
        f.journal.ca
    );
    archive_under(&f.root, &f.journal, verify_socket).unwrap();
}
#[test]
fn interruption_at_each_move_resumes_without_losing_original_evidence() {
    for cut in 0..=4 {
        let f = fixture();
        let count = Cell::new(0);
        assert!(
            archive_under(&f.root, &f.journal, |_, _, socket| {
                let n = count.get();
                count.set(n + 1);
                if n == cut {
                    return Err(refused());
                }
                socket_absent(socket)
            })
            .is_err()
        );
        archive_under(&f.root, &f.journal, verify_socket).unwrap();
        for entry in &f.journal.entries {
            assert_eq!(
                inode(&destination(&f.root, &entry.name, &suffix(&f))).unwrap(),
                entry.id
            );
        }
    }
}
#[test]
fn occupied_archive_target_is_never_overwritten() {
    for entry_name in [
        "owner.sock",
        "active-owner.json",
        "shared-owner",
        "owner.lock",
    ] {
        let f = fixture();
        let target = destination(&f.root, entry_name, &suffix(&f));
        write(&target, b"foreign evidence");
        assert!(archive_under(&f.root, &f.journal, verify_socket).is_err());
        all_original(&f);
        assert_eq!(fs::read(&target).unwrap(), b"foreign evidence");
    }
}
#[test]
fn refuses_unknown_shared_files_leases_and_released_generation() {
    for path in [
        "shared-owner/endpoint.json",
        "shared-owner/leases/unknown.json",
        "released-leases/55555555555555555555555555555555",
    ] {
        let f = fixture();
        if path.starts_with("released-leases") {
            directory(&f.root.join("released-leases"));
        }
        write(&f.root.join(path), b"keep");
        assert!(archive_under(&f.root, &f.journal, verify_socket).is_err());
        all_original(&f);
    }
}
#[test]
fn rejects_replaced_config_socket_lock_parent_and_changed_ca() {
    for path in [
        "shared-owner/configuration.json",
        "owner.sock",
        "owner.lock",
        "data/caddy/pki/authorities/local/root.crt",
    ] {
        let f = fixture();
        let p = f.root.join(path);
        fs::rename(&p, p.with_extension("preserved")).unwrap();
        write(&p, b"replacement");
        assert!(archive_under(&f.root, &f.journal, verify_socket).is_err());
    }
    let f = fixture();
    let prior = f.home.join("preserved-parent");
    fs::rename(&f.root, &prior).unwrap();
    directory(&f.root);
    assert!(archive_under(&f.root, &f.journal, verify_socket).is_err());
    assert!(prior.join("active-owner.json").exists());
}
#[test]
fn external_observation_cannot_change_ca_before_first_effect() {
    let f = fixture();
    let ca = f.root.join("data/caddy/pki/authorities/local/root.crt");
    assert!(
        archive_under(&f.root, &f.journal, |_, _, _| {
            fs::write(&ca, b"changed certificate").unwrap();
            Ok(())
        })
        .is_err()
    );
    all_original(&f);
}
#[test]
fn late_foreign_archive_target_is_preserved_before_any_move() {
    let f = fixture();
    let target = destination(&f.root, "owner.sock", &suffix(&f));
    assert!(
        archive_under(&f.root, &f.journal, |_, _, _| {
            write(&target, b"late evidence");
            Ok(())
        })
        .is_err()
    );
    all_original(&f);
    assert_eq!(fs::read(&target).unwrap(), b"late evidence");
}
#[test]
fn rejects_a_live_inherited_unix_listener_at_the_pinned_inode() {
    let f = fixture();
    let stale = f.root.join("owner.sock");
    fs::remove_file(&stale).unwrap();
    let live = UnixListener::bind(&stale).unwrap();
    fs::set_permissions(&stale, fs::Permissions::from_mode(0o600)).unwrap();
    assert!(socket_absent(&stale).is_err());
    drop(live);
    socket_absent(&stale).unwrap();
}
#[test]
fn wildcard_port_probe_refuses_ipv4_and_ipv6_listeners() {
    use ports::observation_diagnostic as diagnostic;

    let ipv4 = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
    diagnostic::clear();
    assert!(port_absent(ipv4.local_addr().unwrap().port()).is_err());
    drop(ipv4);
    let ipv6 = std::net::TcpListener::bind((std::net::Ipv6Addr::LOCALHOST, 0)).unwrap();
    let port = ipv6.local_addr().unwrap().port();
    diagnostic::clear();
    assert!(port_absent(port).is_err());
    drop(ipv6);
    diagnostic::clear();
    port_absent(port).unwrap_or_else(|error| {
        panic!("{error:?}; port_probe={:?}", diagnostic::take());
    });
}

#[test]
fn port_probe_diagnostic_reports_the_owned_ipv4_listener() {
    use ports::observation_diagnostic as diagnostic;

    let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
    diagnostic::clear();
    assert!(port_absent(listener.local_addr().unwrap().port()).is_err());
    assert_eq!(
        diagnostic::take(),
        Some(diagnostic::Facts {
            stage: diagnostic::Stage::Bind,
            wildcard: true,
            family: libc::AF_INET,
            errno: Some(libc::EADDRINUSE),
        })
    );
}

#[test]
fn port_probe_diagnostic_keeps_only_the_first_refusal() {
    use ports::observation_diagnostic as diagnostic;

    diagnostic::clear();
    assert!(diagnostic::take().is_none());
    diagnostic::record(
        diagnostic::Stage::Socket,
        true,
        libc::AF_INET,
        Some(libc::EMFILE),
    );
    diagnostic::record(
        diagnostic::Stage::Bind,
        false,
        libc::AF_INET6,
        Some(libc::EADDRINUSE),
    );
    assert_eq!(
        diagnostic::take(),
        Some(diagnostic::Facts {
            stage: diagnostic::Stage::Socket,
            wildcard: true,
            family: libc::AF_INET,
            errno: Some(libc::EMFILE),
        })
    );
    assert!(diagnostic::take().is_none());
}
#[test]
fn symlinked_configuration_and_wrong_selectors_refuse_before_mutation() {
    let f = fixture();
    let config = f.root.join("shared-owner/configuration.json");
    let target = config.with_extension("original");
    fs::rename(&config, &target).unwrap();
    std::os::unix::fs::symlink(&target, &config).unwrap();
    assert!(archive_under(&f.root, &f.journal, verify_socket).is_err());
    let candidate = Candidate::discover(&f.home).unwrap();
    for (hash, pid) in [(String::from("wrong"), 999997), ("0".repeat(64), 1)] {
        assert!(recover(&candidate, &hash, &f.journal.configuration_sha256, pid).is_err());
    }
    assert!(f.root.join("owner.sock").exists());
}

struct Alias {
    path: PathBuf,
    target: PathBuf,
}
impl Drop for Alias {
    fn drop(&mut self) {
        if fs::read_link(&self.path).ok().as_ref() == Some(&self.target) {
            let _ = fs::remove_file(&self.path);
        }
    }
}
fn complete_fixture() -> (Fixture, Candidate, Alias) {
    let f = fixture();
    let candidate = Candidate::discover(&f.home).unwrap();
    let mut owner = state::Owner::create(
        &candidate,
        super::super::Profile::Research,
        None,
        super::super::NetworkIntent::Isolated,
    )
    .unwrap();
    let alias = Alias {
        path: owner.short_home.clone(),
        target: candidate.state_root.join("run/smolvm/home"),
    };
    owner.guest_boot_id = Some("12345678-1234-1234-1234-123456789012".into());
    owner.save(&candidate).unwrap();
    drop(state::Lock::acquire(&candidate.state_root.join("run/smolvm")).unwrap());
    let binary = f.home.join("tool");
    crate::provider::test_executable::sleeping_executable(&binary);
    fs::set_permissions(&binary, fs::Permissions::from_mode(0o755)).unwrap();
    let hash = executable_hash(&binary).unwrap();
    let path = f.root.join("shared-owner/configuration.json");
    let mut config: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    config["binding"]["runtime"]["binary"] = serde_json::json!(binary);
    config["binding"]["frontend"]["binary"] = serde_json::json!(binary);
    config["binding"]["runtimeSha256"] = serde_json::json!(hash);
    config["binding"]["frontend"]["sha256"] = serde_json::json!(hash);
    config["binding"]["pool"]["owner"] = serde_json::json!(owner.token);
    fs::write(&path, serde_json::to_vec(&config).unwrap()).unwrap();
    let ca = f.root.join("data/caddy/pki/authorities/local/root.crt");
    // DER fingerprint control, not a certificate-chain validation fixture.
    let der = vec![42; 30000];
    let encoded = base64::engine::general_purpose::STANDARD.encode(&der);
    fs::write(
        &ca,
        format!("-----BEGIN CERTIFICATE-----\n{encoded}\n-----END CERTIFICATE-----\n"),
    )
    .unwrap();
    fs::set_permissions(&ca, fs::Permissions::from_mode(0o644)).unwrap();
    let receipt_path = f.root.join("active-owner.json");
    let mut receipt: serde_json::Value =
        serde_json::from_slice(&fs::read(&receipt_path).unwrap()).unwrap();
    receipt["caSha256"] = serde_json::json!(digest(&der));
    receipt["authority"]["socket"] =
        hostname_authority::managed::inspect(&candidate).unwrap()["socket"].clone();
    let free = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
    receipt["listener"]["port"] = serde_json::json!(free.local_addr().unwrap().port());
    drop(free);
    config["binding"]["httpsPort"] = receipt["listener"]["port"].clone();
    fs::write(&path, serde_json::to_vec(&config).unwrap()).unwrap();
    fs::write(&receipt_path, serde_json::to_vec(&receipt).unwrap()).unwrap();
    (f, candidate, alias)
}
fn hashes(f: &Fixture) -> (String, String) {
    (
        digest(&fs::read(f.root.join("active-owner.json")).unwrap()),
        digest(&fs::read(f.root.join("shared-owner/configuration.json")).unwrap()),
    )
}
#[test]
fn full_command_preserves_large_public_mode_ca_and_exact_retry() {
    let (f, candidate, _alias) = complete_fixture();
    let (owner, config) = hashes(&f);
    let ca = f.root.join("data/caddy/pki/authorities/local/root.crt");
    let before = fs::read(&ca).unwrap();
    let id = inode(&ca).unwrap();
    assert_eq!(
        recover(&candidate, &owner, &config, 999997).unwrap()["https_evidence_archived"],
        true
    );
    recover(&candidate, &owner, &config, 999997).unwrap();
    assert_eq!(fs::read(&ca).unwrap(), before);
    assert_eq!(inode(&ca).unwrap(), id);
    assert_eq!(fs::metadata(&ca).unwrap().mode() & 0o777, 0o644);
}
#[test]
fn full_command_refuses_wrong_boot_foreign_authority_unknown_schema_and_live_frontend() {
    for control in ["boot", "authority", "schema", "frontend"] {
        let (f, candidate, _alias) = complete_fixture();
        let config_path = f.root.join("shared-owner/configuration.json");
        let receipt_path = f.root.join("active-owner.json");
        let mut config: serde_json::Value =
            serde_json::from_slice(&fs::read(&config_path).unwrap()).unwrap();
        let mut receipt: serde_json::Value =
            serde_json::from_slice(&fs::read(&receipt_path).unwrap()).unwrap();
        match control {
            "boot" => {
                config["binding"]["pool"]["bootId"] =
                    serde_json::json!("87654321-1234-1234-1234-123456789012")
            }
            "authority" => {
                receipt["authority"]["socket"] =
                    serde_json::json!("/private/tmp/foreign/route.sock")
            }
            "schema" => config["unknown"] = serde_json::json!(true),
            _ => {}
        }
        fs::write(&config_path, serde_json::to_vec(&config).unwrap()).unwrap();
        fs::write(&receipt_path, serde_json::to_vec(&receipt).unwrap()).unwrap();
        let mut child = if control == "frontend" {
            Some(
                std::process::Command::new(f.home.join("tool"))
                    .arg("30")
                    .spawn()
                    .unwrap(),
            )
        } else {
            None
        };
        let (owner, hash) = hashes(&f);
        assert!(recover(&candidate, &owner, &hash, 999997).is_err());
        all_original(&f);
        assert!(
            !names(&f.root)
                .unwrap()
                .iter()
                .any(|p| p.starts_with("recovery-"))
        );
        if let Some(child) = child.as_mut() {
            child.kill().unwrap();
            child.wait().unwrap();
        }
    }
}
#[test]
fn exclusive_port_guards_retain_both_families_across_effects() {
    let free = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
    let port = free.local_addr().unwrap().port();
    drop(free);
    let guards = port_absent(port).unwrap();
    assert!(std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).is_err());
    assert!(std::net::TcpListener::bind((std::net::Ipv6Addr::LOCALHOST, port)).is_err());
    drop(guards);
    port_absent(port).unwrap();
}

#[test]
fn legacy_device_rebind_requires_both_selected_identities_and_preserves_receipt_bytes() {
    let mut f = fixture();
    let p = f.root.join("active-owner.json");
    let mut value: serde_json::Value = serde_json::from_slice(&fs::read(&p).unwrap()).unwrap();
    let current = f.journal.entries[0].id.dev;
    let old = current + 7;
    value["owner"]["dev"] = serde_json::json!(old);
    value["lock"]["dev"] = serde_json::json!(old);
    let bytes = serde_json::to_vec(&value).unwrap();
    fs::write(&p, &bytes).unwrap();
    f.journal.owner_sha256 = digest(&bytes);
    assert!(archive_under(&f.root, &f.journal, verify_socket).is_err());
    all_original(&f);
    let selection = LegacyDeviceRebind::parse(&format!(
        "{}:{}:{}:{}:{}:{}",
        "a".repeat(32),
        "b".repeat(64),
        current,
        f.journal.entries[0].id.ino,
        current,
        f.journal.entries[3].id.ino
    ))
    .unwrap();
    let receipt: Receipt = serde_json::from_slice(&bytes).unwrap();
    assert!(selection.matches(&receipt, old, current));
    assert!(!selection.matches(&receipt, old + 1, current));
    assert!(!selection.matches(&receipt, old, current + 1));
    let mut wrong = selection.clone();
    wrong.lock.ino += 1;
    f.journal.legacy_device_rebind = Some(wrong);
    assert!(archive_under(&f.root, &f.journal, verify_socket).is_err());
    all_original(&f);
    f.journal.legacy_device_rebind = Some(selection.clone());
    archive_under(&f.root, &f.journal, |receipt, _, socket| {
        if !selection.matches(receipt, old, current) {
            return Err(refused());
        }
        socket_absent(socket)
    })
    .unwrap();
    assert_eq!(
        fs::read(destination(&f.root, "active-owner.json", &suffix(&f))).unwrap(),
        bytes
    );
    assert_eq!(
        inode(&destination(&f.root, "owner.sock", &suffix(&f))).unwrap(),
        selection.socket
    );
}

#[test]
fn full_command_refuses_unconfirmed_legacy_witness_before_publishing_journal() {
    let (f, candidate, _alias) = complete_fixture();
    let (owner, config) = hashes(&f);
    let selection = format!(
        "{}:{}:{}:{}:{}:{}",
        "a".repeat(32),
        "b".repeat(64),
        f.journal.entries[0].id.dev,
        f.journal.entries[0].id.ino,
        f.journal.entries[3].id.dev,
        f.journal.entries[3].id.ino
    );
    assert!(recover_legacy_device_rebind(&candidate, &owner, &config, 999997, &selection).is_err());
    all_original(&f);
    assert!(
        !names(&f.root)
            .unwrap()
            .iter()
            .any(|p| p.starts_with("recovery-"))
    );
}

#[test]
fn full_legacy_command_archives_with_real_current_witness_and_exact_retry() {
    let (f, candidate, _alias) = complete_fixture();
    fs::write(f.home.join("compose.yaml"), "services: {}\n").unwrap();
    let share = crate::provider::ProjectShareIntent::approve(&f.home, true).unwrap();
    let mut pool = state::Owner::load(&candidate).unwrap();
    pool.project_share = Some(share.clone());
    pool.save(&candidate).unwrap();
    let run = "a".repeat(32);
    let graphs = candidate.state_root.join("run/graphs");
    directory(&graphs);
    let graph_root = graphs.join(&run);
    directory(&graph_root);
    let graph: crate::provider::graph::Receipt = serde_json::from_value(serde_json::json!({
        "version":1,"run":run,"owner":pool.token,"namespace":"c".repeat(64),"plan_id":"d".repeat(64),
        "phase":"stopped-data-retained","readiness":{},"resources":{},
        "source":{"shared":share,"revision":"e".repeat(64),"archive_sha256":"f".repeat(64),"selection_sha256":"0".repeat(64)}
    })).unwrap();
    write(
        &graph_root.join("state.json"),
        &serde_json::to_vec_pretty(&graph).unwrap(),
    );
    let current = f.journal.entries[0].id.dev;
    let witness = crate::provider::graph::fixture_https_witness(&candidate, &graph, current + 7);
    write(&graph_root.join("source-device-rebind.json"), &witness);
    let p = f.root.join("active-owner.json");
    let mut receipt: serde_json::Value = serde_json::from_slice(&fs::read(&p).unwrap()).unwrap();
    receipt["owner"]["dev"] = serde_json::json!(current + 7);
    receipt["lock"]["dev"] = serde_json::json!(current + 7);
    let before = serde_json::to_vec(&receipt).unwrap();
    fs::write(&p, &before).unwrap();
    let (owner, config) = hashes(&f);
    assert!(recover(&candidate, &owner, &config, 999997).is_err());
    let selection = format!(
        "{run}:{}:{current}:{}:{current}:{}",
        digest(&witness),
        f.journal.entries[0].id.ino,
        f.journal.entries[3].id.ino
    );
    let result =
        recover_legacy_device_rebind(&candidate, &owner, &config, 999997, &selection).unwrap();
    assert_eq!(
        result["qualification"],
        "explicit-legacy-device-migration-original-volume-continuity-unproven"
    );
    assert_eq!(
        recover_legacy_device_rebind(&candidate, &owner, &config, 999997, &selection).unwrap(),
        result
    );
    let journal: Journal = serde_json::from_slice(
        &fs::read(f.root.join(format!("recovery-{owner}-{config}.json"))).unwrap(),
    )
    .unwrap();
    let suffix = digest(&serde_json::to_vec(&journal).unwrap());
    assert_eq!(
        fs::read(destination(&f.root, "active-owner.json", &suffix)).unwrap(),
        before
    );
    for entry in &f.journal.entries {
        assert_eq!(
            inode(&destination(&f.root, &entry.name, &suffix)).unwrap(),
            entry.id
        );
    }
    assert_eq!(
        inode(&f.root.join("data/caddy/pki/authorities/local/root.crt")).unwrap(),
        f.journal.ca
    );
}
