//! Audit capabilities omitted by SmolVM's retained running configuration.
use super::state::Owner;
use crate::{Candidate, CandidateError, reject_aliased_state};
use rusqlite::{Connection, OpenFlags};
use serde_json::{Value, json};
use std::{fs, os::unix::fs::MetadataExt, path::Path, time::Duration};

fn invalid() -> CandidateError {
    CandidateError::new(
        "unaudited_provider_config",
        "Persisted provider identity or capabilities differ from the candidate contract.",
    )
}

pub(super) fn verify(candidate: &Candidate, owner: &Owner) -> Result<(), CandidateError> {
    let home = candidate.state_root.join("run/smolvm/home");
    #[cfg(target_os = "macos")]
    let database = home.join("Library/Application Support/smolvm/server/smolvm.db");
    #[cfg(not(target_os = "macos"))]
    let database = home.join(".local/share/smolvm/server/smolvm.db");
    let record = read_database(&database, &owner.machine)?;
    verify_mounts(candidate, owner, &record)?;
    verify_record(
        &record,
        &owner.machine,
        &owner.token,
        owner.application_bridge,
        owner
            .dependency_sockets
            .map(|intent| (intent, owner.short_home.as_path())),
        owner.network.clone(),
    )
}

/// Called only after this process successfully created a machine, before any boot.
pub(super) fn pin_created_network(
    candidate: &Candidate,
    owner: &mut Owner,
) -> Result<(), CandidateError> {
    let home = candidate.state_root.join("run/smolvm/home");
    #[cfg(target_os = "macos")]
    let database = home.join("Library/Application Support/smolvm/server/smolvm.db");
    #[cfg(not(target_os = "macos"))]
    let database = home.join(".local/share/smolvm/server/smolvm.db");
    let record = read_database(&database, &owner.machine)?;
    verify_mounts(candidate, owner, &record)?;
    let network = owner.network.pin(&record)?;
    verify_record(
        &record,
        &owner.machine,
        &owner.token,
        owner.application_bridge,
        owner
            .dependency_sockets
            .map(|intent| (intent, owner.short_home.as_path())),
        network.clone(),
    )?;
    owner.network = network;
    Ok(())
}

fn verify_mounts(
    candidate: &Candidate,
    owner: &Owner,
    record: &Value,
) -> Result<(), CandidateError> {
    let mut mounts = vec![json!([
        super::artifact::engine_root(candidate),
        "/opt/hack-engine",
        true
    ])];
    if let Some(share) = &owner.project_share {
        share.validate_receipt()?;
        mounts.push(share.database_mount());
    }
    if record["mounts"] != json!(mounts) {
        return Err(invalid());
    }
    Ok(())
}

fn metadata(path: &Path) -> Result<fs::Metadata, CandidateError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| invalid())?;
    if !metadata.is_file()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.nlink() != 1
        || metadata.mode() & 0o022 != 0
        || metadata.len() > 16 * 1024 * 1024
    {
        return Err(invalid());
    }
    Ok(metadata)
}

#[cfg(test)]
fn verify_database(
    path: &Path,
    machine: &str,
    token: &str,
    bridge: Option<super::BridgeIntent>,
    dependencies: Option<(super::DependencySocketIntent, &Path)>,
    network: super::NetworkIntent,
) -> Result<(), CandidateError> {
    let record = read_database(path, machine)?;
    verify_record(&record, machine, token, bridge, dependencies, network)
}

fn read_database(path: &Path, machine: &str) -> Result<Value, CandidateError> {
    reject_aliased_state(path.parent().ok_or_else(invalid)?).map_err(|_| invalid())?;
    let before = metadata(path)?;
    for suffix in ["-wal", "-shm", "-journal"] {
        let sidecar = path.with_file_name(format!(
            "{}{suffix}",
            path.file_name()
                .and_then(|s| s.to_str())
                .ok_or_else(invalid)?
        ));
        match fs::symlink_metadata(&sidecar) {
            Ok(_) => {
                metadata(&sidecar)?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(invalid()),
        }
    }
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .map_err(|_| invalid())?;
    connection
        .busy_timeout(Duration::from_millis(200))
        .map_err(|_| invalid())?;
    let mut statement = connection
        .prepare(
            "SELECT substr(name, 1, 129), length(data), substr(data, 1, 65537) FROM vms LIMIT 2",
        )
        .map_err(|_| invalid())?;
    let mut rows = statement.query([]).map_err(|_| invalid())?;
    let row = rows.next().map_err(|_| invalid())?.ok_or_else(invalid)?;
    let name: String = row.get(0).map_err(|_| invalid())?;
    let length: i64 = row.get(1).map_err(|_| invalid())?;
    let bytes: Vec<u8> = row.get(2).map_err(|_| invalid())?;
    if name != machine || !(1..=65536).contains(&length) || bytes.len() as i64 != length {
        return Err(invalid());
    }
    let record: Value = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    if rows.next().map_err(|_| invalid())?.is_some() {
        return Err(invalid());
    }
    let after = metadata(path)?;
    if before.dev() != after.dev() || before.ino() != after.ino() {
        return Err(invalid());
    }
    Ok(record)
}

fn verify_record(
    record: &Value,
    machine: &str,
    token: &str,
    bridge: Option<super::BridgeIntent>,
    dependencies: Option<(super::DependencySocketIntent, &Path)>,
    network: super::NetworkIntent,
) -> Result<(), CandidateError> {
    network.verify(record)?;
    super::dependency_socket::check_capacity(bridge, dependencies.map(|(intent, _)| intent))
        .map_err(|_| invalid())?;
    let mut mappings = super::BridgeIntent::mappings(bridge);
    if let Some((intent, home)) = dependencies {
        super::DependencySocketIntent::new(intent.slots).map_err(|_| invalid())?;
        let values = intent.mappings(home);
        mappings
            .as_array_mut()
            .ok_or_else(invalid)?
            .extend(values.as_array().ok_or_else(invalid)?.iter().cloned());
    }
    if mappings.as_array().ok_or_else(invalid)?.len() > 32 {
        return Err(invalid());
    }
    if record["name"] != machine
        || record["labels"] != json!({"hack-local.owner": token})
        || record["ssh_agent"] != false
        || record["ports"] != json!([])
        || record["published_sockets"] != mappings
    {
        return Err(invalid());
    }
    for field in [
        "staged_mounts",
        "remote_volumes",
        "init",
        "env",
        "entrypoint",
        "cmd",
    ] {
        if record[field] != json!([]) {
            return Err(invalid());
        }
    }
    // These optional fields are omitted or null in the pinned default record.
    if record
        .get("secret_refs")
        .is_some_and(|value| value != &json!({}))
    {
        return Err(invalid());
    }
    for field in ["image", "workdir", "user", "health_cmd"] {
        if !record[field].is_null() {
            return Err(invalid());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{PermissionsExt, symlink};
    fn verify_isolated_record(
        record: &Value,
        machine: &str,
        token: &str,
        bridge: Option<super::super::BridgeIntent>,
    ) -> Result<(), CandidateError> {
        verify_record(
            record,
            machine,
            token,
            bridge,
            None,
            super::super::NetworkIntent::Isolated,
        )
    }
    fn verify_isolated_database(
        path: &Path,
        machine: &str,
        token: &str,
        bridge: Option<super::super::BridgeIntent>,
    ) -> Result<(), CandidateError> {
        verify_database(
            path,
            machine,
            token,
            bridge,
            None,
            super::super::NetworkIntent::Isolated,
        )
    }
    fn fixture() -> Value {
        json!({"name":"owned","labels":{"hack-local.owner":"token"},"ssh_agent":false,
            "network":false,"ports":[],
            "published_sockets":[],"staged_mounts":[],"remote_volumes":[],"init":[],"env":[],"entrypoint":[],"cmd":[]})
    }
    #[test]
    fn mounted_dependencies_require_exact_isolated_owned_mapping() {
        let bridge = Some(super::super::BridgeIntent::new(1).unwrap());
        let dependency = super::super::DependencySocketIntent::new(1).unwrap();
        let home = Path::new("/private/tmp/hkl-owned");
        let mut record = fixture();
        record["published_sockets"] = json!([
            {"direction":"expose","guest_path":"/run/hack-local/bridge-00.sock"},
            {"direction":"mount","host_path":"/private/tmp/hkl-owned/dependency-00.sock","guest_path":"/run/hack-dependencies/dependency-00.sock"}
        ]);
        let verify = |record: &Value| {
            verify_record(
                record,
                "owned",
                "token",
                bridge,
                Some((dependency, home)),
                super::super::NetworkIntent::Isolated,
            )
        };
        verify(&record).unwrap();
        for (field, value) in [
            ("direction", json!("expose")),
            ("host_path", json!("/private/tmp/foreign.sock")),
            ("guest_path", json!("/run/foreign.sock")),
        ] {
            let mut changed = record.clone();
            changed["published_sockets"][1][field] = value;
            assert!(verify(&changed).is_err());
        }
        let mut changed = record.clone();
        changed["network"] = json!(true);
        assert!(verify(&changed).is_err());
        assert!(verify_isolated_record(&record, "owned", "token", bridge).is_err());
        record["published_sockets"].as_array_mut().unwrap().pop();
        assert!(verify(&record).is_err());
    }
    #[test]
    fn refuses_implicit_network_activation_before_boot() {
        let original = fixture();
        verify_isolated_record(&original, "owned", "token", None).unwrap();
        for (field, value) in [
            ("network", json!(true)),
            ("ports", json!([[18080, 8080]])),
            ("allowed_cidrs", json!(["100.96.0.1/32"])),
            ("dns_filter_hosts", json!(["private-sentinel.invalid"])),
        ] {
            let mut record = original.clone();
            record[field] = value;
            let error = verify_isolated_record(&record, "owned", "token", None).unwrap_err();
            assert_eq!(error.code, "unaudited_provider_config");
            assert!(!error.message.contains("private-sentinel"));
        }
        for field in ["network", "ports"] {
            let mut record = original.clone();
            record.as_object_mut().unwrap().remove(field);
            assert!(verify_isolated_record(&record, "owned", "token", None).is_err());
        }
        for field in ["allowed_cidrs", "dns_filter_hosts"] {
            let mut record = original.clone();
            record[field] = Value::Null;
            verify_isolated_record(&record, "owned", "token", None).unwrap();
            record[field] = json!([]);
            assert!(verify_isolated_record(&record, "owned", "token", None).is_err());
        }
    }
    #[test]
    #[ignore = "requires a freshly captured private pinned-provider record"]
    fn pinned_provider_default_record_preserves_network_isolation() {
        let path = std::env::var("HACK_TEST_PROVIDER_RECORD").unwrap();
        let record: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        verify_isolated_record(&record, "probe", "synthetic-owner", None).unwrap();
        for (field, value) in [
            ("network", json!(true)),
            ("ports", json!([[18080, 8080]])),
            ("allowed_cidrs", json!(["100.96.0.1/32"])),
            ("dns_filter_hosts", json!(["synthetic.invalid"])),
        ] {
            let mut changed = record.clone();
            changed[field] = value;
            assert!(verify_isolated_record(&changed, "probe", "synthetic-owner", None).is_err());
        }
    }
    #[test]
    #[ignore = "requires a freshly captured private pinned-provider gateway record"]
    fn pinned_provider_gateway_record_matches_owned_intent() {
        let path = std::env::var("HACK_TEST_PROVIDER_GATEWAY_RECORD").unwrap();
        let record: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        verify_record(
            &record,
            "probe",
            "synthetic-owner",
            None,
            None,
            super::super::NetworkIntent::HostGateway,
        )
        .unwrap();
        assert!(verify_isolated_record(&record, "probe", "synthetic-owner", None).is_err());
        let mut altered = record;
        altered["allowed_cidrs"] = json!(["0.0.0.0/0"]);
        assert!(
            verify_record(
                &altered,
                "probe",
                "synthetic-owner",
                None,
                None,
                super::super::NetworkIntent::HostGateway
            )
            .is_err()
        );
    }

    #[test]
    fn refuses_hidden_capabilities_and_foreign_identity() {
        verify_isolated_record(&fixture(), "owned", "token", None).unwrap();
        for field in [
            "published_sockets",
            "staged_mounts",
            "remote_volumes",
            "init",
            "env",
            "entrypoint",
            "cmd",
            "secret_refs",
            "image",
            "workdir",
            "user",
            "health_cmd",
            "network_backend",
            "network_name",
            "dns",
            "ssh_agent",
            "name",
            "labels",
        ] {
            let mut record = fixture();
            record[field] = json!("private-sentinel");
            let error = verify_isolated_record(&record, "owned", "token", None).unwrap_err();
            assert_eq!(error.code, "unaudited_provider_config");
            assert!(!error.message.contains("private-sentinel"));
        }
        let mut socket = fixture();
        socket["published_sockets"] =
            json!([{"direction":"expose", "guest_path":"/run/foreign.sock", "host_path":null}]);
        assert!(verify_isolated_record(&socket, "owned", "token", None).is_err());
        let mut ssh = fixture();
        ssh["ssh_agent"] = json!(true);
        assert!(verify_isolated_record(&ssh, "owned", "token", None).is_err());
        for field in ["published_sockets", "ssh_agent", "labels"] {
            let mut record = fixture();
            record.as_object_mut().unwrap().remove(field);
            assert!(verify_isolated_record(&record, "owned", "token", None).is_err());
        }
    }
    #[test]
    fn bridge_mapping_must_exactly_match_durable_intent() {
        let intent = Some(super::super::BridgeIntent::new(2).unwrap());
        let mut record = fixture();
        record["published_sockets"] = json!([
            {"direction":"expose","guest_path":"/run/hack-local/bridge-00.sock"},
            {"direction":"expose","guest_path":"/run/hack-local/bridge-01.sock"}
        ]);
        verify_isolated_record(&record, "owned", "token", intent).unwrap();
        assert!(verify_isolated_record(&record, "owned", "token", None).is_err());
        for case in 0..5 {
            let mut changed = record.clone();
            match case {
                0 => changed["published_sockets"][0]["direction"] = json!("mount"),
                1 => changed["published_sockets"][0]["host_path"] = json!("/tmp/foreign.sock"),
                2 => changed["published_sockets"][0]["guest_path"] = json!("/run/foreign.sock"),
                3 => {
                    changed["published_sockets"].as_array_mut().unwrap().pop();
                }
                _ => changed["published_sockets"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!({})),
            }
            assert!(verify_isolated_record(&changed, "owned", "token", intent).is_err());
        }
    }
    #[test]
    fn database_requires_one_bounded_owned_record_and_safe_files() {
        let root = std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .join(format!("hack-config-audit-{}", std::process::id()));
        fs::create_dir(&root).unwrap();
        let path = root.join("smolvm.db");
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch("CREATE TABLE vms(name TEXT PRIMARY KEY, data BLOB NOT NULL)")
            .unwrap();
        let insert = |name: &str, bytes: Vec<u8>| {
            connection
                .execute(
                    "INSERT OR REPLACE INTO vms VALUES (?1, ?2)",
                    rusqlite::params![name, bytes],
                )
                .unwrap();
        };
        let original = serde_json::to_vec(&fixture()).unwrap();
        connection.execute_batch("PRAGMA journal_mode=WAL").unwrap();
        insert("owned", original.clone());
        verify_isolated_database(&path, "owned", "token", None).unwrap();
        assert!(verify_isolated_database(&path, "foreign", "token", None).is_err());
        insert("extra", original.clone());
        assert!(verify_isolated_database(&path, "owned", "token", None).is_err());
        connection
            .execute("DELETE FROM vms WHERE name='extra'", [])
            .unwrap();
        for bytes in [vec![b'x'; 65537], b"broken".to_vec()] {
            insert("owned", bytes);
            assert!(verify_isolated_database(&path, "owned", "token", None).is_err());
        }
        insert("owned", original);
        fs::set_permissions(&path, fs::Permissions::from_mode(0o666)).unwrap();
        assert!(verify_isolated_database(&path, "owned", "token", None).is_err());
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        connection
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE")
            .unwrap();
        let alias = root.join("alias.db");
        symlink(&path, &alias).unwrap();
        assert!(verify_isolated_database(&alias, "owned", "token", None).is_err());
        let sidecar = root.join("smolvm.db-wal");
        symlink(&path, &sidecar).unwrap();
        assert!(verify_isolated_database(&path, "owned", "token", None).is_err());
        fs::remove_file(sidecar).unwrap();
        verify_isolated_database(&path, "owned", "token", None).unwrap();
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }
}
