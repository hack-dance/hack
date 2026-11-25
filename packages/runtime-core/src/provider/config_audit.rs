//! Audit capabilities omitted by SmolVM's retained running configuration.
use super::PoolLayout;
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
    verify_value(candidate, owner, &record)
}

/// [`verify`] for a stopped pool before its restart repairs translation: it also accepts the
/// one pending transition an interrupted `runtime up --amd64-emulation` leaves, where the
/// receipt already records the intent but the provider has not stored `rosetta` yet. The
/// record must then be exactly this pool's audited configuration without translation. The
/// reverse (a provider with translation the receipt does not record) is still refused, and
/// the strict [`verify`] runs again after `machine update --rosetta` and before boot.
pub(super) fn verify_before_translation_repair(
    candidate: &Candidate,
    owner: &Owner,
) -> Result<(), CandidateError> {
    let home = candidate.state_root.join("run/smolvm/home");
    #[cfg(target_os = "macos")]
    let database = home.join("Library/Application Support/smolvm/server/smolvm.db");
    #[cfg(not(target_os = "macos"))]
    let database = home.join(".local/share/smolvm/server/smolvm.db");
    let record = read_database(&database, &owner.machine)?;
    if owner.amd64_emulation && !record_amd64_emulation(&record)? {
        let mut pending = owner.clone();
        pending.amd64_emulation = false;
        return verify_value(candidate, &pending, &record);
    }
    verify_value(candidate, owner, &record)
}

pub(super) fn verify_value(
    candidate: &Candidate,
    owner: &Owner,
    record: &Value,
) -> Result<(), CandidateError> {
    verify_mounts(candidate, owner, record)?;
    if record_amd64_emulation(record)? != owner.amd64_emulation {
        return Err(invalid());
    }
    verify_record(
        owner.socket_layout,
        record,
        &owner.machine,
        &owner.token,
        owner.application_bridge,
        owner
            .dependency_sockets
            .map(|intent| (intent, owner.short_home.as_path())),
        owner.network.clone(),
    )
}

/// Whether this pool's private provider database records `owner.machine`, for recovering a create
/// that was interrupted before the candidate recorded its outcome. The pool's provider home holds
/// at most this pool's machine, so any other record, or more than one, is refused.
pub(super) fn machine_recorded(
    candidate: &Candidate,
    owner: &Owner,
) -> Result<bool, CandidateError> {
    let home = candidate.state_root.join("run/smolvm/home");
    #[cfg(target_os = "macos")]
    let database = home.join("Library/Application Support/smolvm/server/smolvm.db");
    #[cfg(not(target_os = "macos"))]
    let database = home.join(".local/share/smolvm/server/smolvm.db");
    match fs::symlink_metadata(&database) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(_) => return Err(invalid()),
        Ok(_) => {}
    }
    reject_aliased_state(database.parent().ok_or_else(invalid)?).map_err(|_| invalid())?;
    metadata(&database)?;
    let connection = Connection::open_with_flags(
        &database,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .map_err(|_| invalid())?;
    connection
        .busy_timeout(Duration::from_millis(200))
        .map_err(|_| invalid())?;
    let mut statement = connection
        .prepare("SELECT substr(name, 1, 129) FROM vms LIMIT 2")
        .map_err(|_| invalid())?;
    let names = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|_| invalid())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| invalid())?;
    match names.as_slice() {
        [] => Ok(false),
        [name] if *name == owner.machine => Ok(true),
        _ => Err(invalid()),
    }
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
    if record_amd64_emulation(&record)? != owner.amd64_emulation {
        return Err(invalid());
    }
    let network = owner.network.pin(&record)?;
    verify_record(
        owner.socket_layout,
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

/// SmolVM's stored `rosetta` setting. The pinned default record may omit it (disabled); any
/// value other than a boolean is refused.
fn record_amd64_emulation(record: &Value) -> Result<bool, CandidateError> {
    match record.get("rosetta") {
        None | Some(Value::Null) => Ok(false),
        Some(Value::Bool(value)) => Ok(*value),
        Some(_) => Err(invalid()),
    }
}

/// Whether this pool's stored machine record enables Rosetta translation for its next start.
pub(super) fn recorded_amd64_emulation(
    candidate: &Candidate,
    owner: &Owner,
) -> Result<bool, CandidateError> {
    let home = candidate.state_root.join("run/smolvm/home");
    #[cfg(target_os = "macos")]
    let database = home.join("Library/Application Support/smolvm/server/smolvm.db");
    #[cfg(not(target_os = "macos"))]
    let database = home.join(".local/share/smolvm/server/smolvm.db");
    let record = read_database(&database, &owner.machine)?;
    verify_mounts(candidate, owner, &record)?;
    record_amd64_emulation(&record)
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
    for share in owner.project_shares() {
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
    verify_record(
        PoolLayout::Legacy,
        &record,
        machine,
        token,
        bridge,
        dependencies,
        network,
    )
}

pub(super) fn read_database(path: &Path, machine: &str) -> Result<Value, CandidateError> {
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
    layout: PoolLayout,
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
    let mut mappings = super::BridgeIntent::mappings(layout, bridge);
    if let Some((intent, home)) = dependencies {
        super::DependencySocketIntent::new(intent.slots).map_err(|_| invalid())?;
        let values = intent.mappings(layout, home);
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
    let fields = record.as_object().ok_or_else(invalid)?;
    if fields
        .keys()
        .any(|key| !KNOWN_RECORD_FIELDS.contains(&key.as_str()))
    {
        return Err(invalid());
    }
    for field in INERT_RECORD_FIELDS {
        if !inert(field, record.get(field)) {
            return Err(invalid());
        }
    }
    // Every pool asks for the engine socket on the host (`--docker-socket` at create), so
    // the record must say exactly that.
    if record.get("docker_socket") != Some(&Value::Bool(true)) {
        return Err(invalid());
    }
    // The provider must never restart a pool on its own. The policy stays `never` (absent
    // means the provider default, `never`); the counters and the user-stopped flag are the
    // provider's bookkeeping under that policy.
    match record.get("restart") {
        None | Some(Value::Null) => {}
        Some(Value::Object(restart)) => {
            if !matches!(restart.get("policy"), None | Some(Value::Null))
                && restart.get("policy") != Some(&json!("never"))
            {
                return Err(invalid());
            }
        }
        Some(_) => return Err(invalid()),
    }
    // A pool's disks must reach the host disk before a guest flush returns: clean stop,
    // exact disk identity and recovery assume it. Absent means the provider default, full.
    if !matches!(record.get("disk_durability"), None | Some(Value::Null))
        && record["disk_durability"] != "full"
    {
        return Err(invalid());
    }
    Ok(())
}

/// Machine-record fields SmolVM added after 1.14.3 (in 1.34.1's and 1.35.4's `VmRecord`) that
/// grant a capability, change egress or published ports, record guest ownership on host
/// files, or mark a machine as paused, restored, branched or credentialed.
/// A pool never requests any of them, so each must be absent or at its inert default; any
/// other value means something outside this runtime changed the machine. Bookkeeping the
/// provider writes at every start (`engine_build`, `agent_rootfs_digest`,
/// `agent_rootfs_path`) grants nothing and is not audited, and `disk_durability` has its
/// own full-only rule. Workload stop settings that a pool without a workload never uses are
/// listed too. Three fields have their own rule in `verify_record` instead: `docker_socket`
/// must be `true` (every pool asks for it), `restart` must keep the `never` policy, and
/// `disk_durability` must be `full`. Every field of the pinned record is named in
/// [`KNOWN_RECORD_FIELDS`]; a field that list does not name refuses.
const INERT_RECORD_FIELDS: [&str; 53] = [
    "pause_reason",
    "paused_checkpoint",
    "disks",
    "cache_disk",
    "disk_volumes",
    "block_private",
    "staged_mounts_detached_from",
    "udp_ports",
    "nested_virt",
    "egress_rules",
    "dns_options",
    "shm_size",
    "guest_subnet",
    "detached",
    "keep_identity",
    "stop_on_exit",
    "stop_signal",
    "stop_timeout_secs",
    "credential_policy",
    "external_interceptor_required",
    "mediated_egress_required",
    "credential_placeholders",
    "credentials_supplied_by_api",
    "packed_image_on_storage",
    "source_registry_ref",
    "image_origin",
    "image_origin_digest",
    "checkpoint_head",
    "host_uid_owner",
    // Added in 1.35.x. `recorded_ownership` makes live mounts keep guest file ownership in
    // an extended attribute on host files; `allocated_ports`, `listen_addresses` and
    // `auto_ports` publish guest ports on the host; `switch` joins an inter-VM network;
    // `oci_platform` selects a machine image platform. A pool asks for none of them.
    "recorded_ownership",
    "allocated_ports",
    "listen_addresses",
    "oci_platform",
    "switch",
    "auto_ports",
    // Present since 1.34.1 and never asked for by a pool: a copy-on-write fork base, disks
    // layered on another machine's disks, a fork's environment, and deletion on exit.
    "forkable",
    "golden",
    "fork_env",
    "ephemeral",
    // Also present since 1.34.1 (HACK-2361). `runtime_managed` hands the machine to the
    // provider's runtime-shim reconciliation; `cuda` remotes guest CUDA to a host GPU, with
    // the `cuda_*` fork-pool settings; `source_smolmachine` mounts a `.smolmachine` sidecar
    // instead of the pinned image; the `fork_*` fields and `forkpoint_held` mark a fork
    // lineage; and the `health_*` settings run a workload health check. A pool asks for
    // none of them.
    "runtime_managed",
    "cuda",
    "cuda_fork_pool_size",
    "cuda_vram_limit_mib",
    "cuda_preload_modules",
    "source_smolmachine",
    "fork_generation",
    "fork_lineage_pid_start_time",
    "fork_overlay_owner",
    "forkpoint_held",
    "health_interval_secs",
    "health_timeout_secs",
    "health_retries",
    "health_startup_grace_secs",
];

/// Every field of the pinned SmolVM's `VmRecord` (1.35.4, `src/config.rs`; no field is
/// renamed or flattened). A record key outside this list is a field this runtime has not
/// reviewed, so the record refuses; a pin bump that adds fields must classify each one
/// here and, if it can grant anything, in [`INERT_RECORD_FIELDS`] or a rule of its own.
pub(super) const KNOWN_RECORD_FIELDS: [&str; 96] = [
    "name",
    "created_at",
    "state",
    "pause_reason",
    "paused_checkpoint",
    "pid",
    "pid_start_time",
    "engine_build",
    "cpus",
    "mem",
    "block_io",
    "disk_durability",
    "disks",
    "cache_disk",
    "disk_volumes",
    "block_private",
    "mounts",
    "staged_mounts",
    "recorded_ownership",
    "staged_mounts_detached_from",
    "ports",
    "udp_ports",
    "allocated_ports",
    "listen_addresses",
    "published_sockets",
    "network",
    "gpu",
    "nested_virt",
    "gpu_vram_mib",
    "rosetta",
    "oci_platform",
    "restart",
    "last_exit_code",
    "init",
    "init_completed",
    "remote_volumes",
    "env",
    "secret_refs",
    "workdir",
    "user",
    "storage_gb",
    "overlay_gb",
    "allowed_cidrs",
    "egress_rules",
    "network_backend",
    "dns",
    "dns_options",
    "shm_size",
    "network_name",
    "guest_subnet",
    "switch",
    "image",
    "entrypoint",
    "cmd",
    "labels",
    "health_cmd",
    "health_interval_secs",
    "health_timeout_secs",
    "health_retries",
    "health_startup_grace_secs",
    "ssh_agent",
    "cuda",
    "forkable",
    "detached",
    "keep_identity",
    "stop_on_exit",
    "stop_signal",
    "stop_timeout_secs",
    "cuda_fork_pool_size",
    "cuda_vram_limit_mib",
    "cuda_preload_modules",
    "docker_socket",
    "auto_ports",
    "dns_filter_hosts",
    "credential_policy",
    "external_interceptor_required",
    "mediated_egress_required",
    "credential_placeholders",
    "credentials_supplied_by_api",
    "ephemeral",
    "source_smolmachine",
    "packed_image_on_storage",
    "source_registry_ref",
    "image_origin",
    "image_origin_digest",
    "golden",
    "fork_generation",
    "fork_lineage_pid_start_time",
    "checkpoint_head",
    "agent_rootfs_digest",
    "agent_rootfs_path",
    "fork_overlay_owner",
    "host_uid_owner",
    "forkpoint_held",
    "fork_env",
    "runtime_managed",
];

/// Running-configuration resource fields SmolVM added after 1.14.3 (1.34.1's and 1.35.4's
/// `VmResources`).
/// As with [`INERT_RECORD_FIELDS`], a pool requests none of them.
const INERT_RUNNING_RESOURCES: [&str; 10] = [
    "nested_virt",
    "disks",
    "cache_disk",
    "disk_volumes",
    "block_private",
    "egress_rules",
    "dns_options",
    "shm_size",
    "guest_subnet",
    "switch",
];

/// Refuse a running configuration (`agent.config.json` `resources`) that boots with any
/// capability added since 1.14.3, or without full disk durability.
pub(super) fn verify_running_resources(resources: &Value) -> Result<(), CandidateError> {
    let refused = || {
        CandidateError::new(
            "unaudited_provider_config",
            "Mounts, limits or capabilities differ from the candidate contract.",
        )
    };
    if !resources.is_object() {
        return Err(refused());
    }
    if INERT_RUNNING_RESOURCES
        .iter()
        .any(|field| !inert(field, resources.get(*field)))
    {
        return Err(refused());
    }
    if !matches!(resources.get("disk_durability"), None | Some(Value::Null))
        && resources["disk_durability"] != "full"
    {
        return Err(refused());
    }
    Ok(())
}

/// Absent, null, false, or an empty list or map. `block_private`, `auto_ports` and
/// `credential_policy` are the exceptions: an empty list turns on `--block-private` with no
/// re-opened range, an empty map turns on `--auto-ports` with no port excluded, and an empty
/// credential policy still steers the machine's default network backend, so for them only
/// absent or null is inert.
fn inert(field: &str, value: Option<&Value>) -> bool {
    if matches!(field, "block_private" | "auto_ports" | "credential_policy") {
        return matches!(value, None | Some(Value::Null));
    }
    match value {
        None | Some(Value::Null | Value::Bool(false)) => true,
        Some(Value::Array(items)) => items.is_empty(),
        Some(Value::Object(fields)) => fields.is_empty(),
        Some(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{PermissionsExt, symlink};

    #[test]
    fn an_interrupted_create_is_recognized_only_by_this_pools_own_record() {
        let checkout = std::env::temp_dir().canonicalize().unwrap().join(format!(
            "hack-config-audit-recorded-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            crate::next_test_scratch()
        ));
        fs::create_dir(&checkout).unwrap();
        let candidate = Candidate::discover(&checkout).unwrap();
        let owner: Owner = serde_json::from_value(json!({
            "version": 1, "checkout": "/fixture", "token": "fixture", "machine": "owned",
            "short_home": "/fixture", "created": false, "phase": "creating", "process": null,
            "storage": null, "overlay": null, "guest_boot_id": null, "daemon_pid": null,
            "daemon_start": null, "rootfs_digest": null
        }))
        .unwrap();
        let home = candidate.state_root.join("run/smolvm/home");
        #[cfg(target_os = "macos")]
        let server = home.join("Library/Application Support/smolvm/server");
        #[cfg(not(target_os = "macos"))]
        let server = home.join(".local/share/smolvm/server");
        // No provider database: `machine create` never ran.
        assert!(!machine_recorded(&candidate, &owner).unwrap());
        fs::create_dir_all(&server).unwrap();
        let connection = Connection::open(server.join("smolvm.db")).unwrap();
        connection
            .execute_batch("CREATE TABLE vms(name TEXT PRIMARY KEY, data BLOB NOT NULL)")
            .unwrap();
        assert!(!machine_recorded(&candidate, &owner).unwrap());
        let insert = |name: &str| {
            connection
                .execute(
                    "INSERT INTO vms VALUES (?1, ?2)",
                    rusqlite::params![name, b"{}".to_vec()],
                )
                .unwrap();
        };
        insert("owned");
        assert!(machine_recorded(&candidate, &owner).unwrap());
        insert("foreign");
        assert!(machine_recorded(&candidate, &owner).is_err());
        connection
            .execute("DELETE FROM vms WHERE name='owned'", [])
            .unwrap();
        assert!(machine_recorded(&candidate, &owner).is_err());
        drop(connection);
        fs::remove_dir_all(&checkout).unwrap();
    }
    fn verify_isolated_record(
        record: &Value,
        machine: &str,
        token: &str,
        bridge: Option<super::super::BridgeIntent>,
    ) -> Result<(), CandidateError> {
        verify_record(
            PoolLayout::Legacy,
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
            "network":false,"ports":[],"docker_socket":true,
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
                PoolLayout::Legacy,
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
            PoolLayout::Legacy,
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
                PoolLayout::Legacy,
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
    fn the_engine_socket_must_be_requested_and_the_provider_never_restarts_a_pool() {
        // HACK-2361: every pool asks for `--docker-socket`; the record must say exactly that.
        let plain = fixture();
        verify_isolated_record(&plain, "owned", "token", None).unwrap();
        for value in [
            None,
            Some(json!(false)),
            Some(Value::Null),
            Some(json!("true")),
        ] {
            let mut record = plain.clone();
            match value {
                Some(value) => record["docker_socket"] = value,
                None => {
                    record.as_object_mut().unwrap().remove("docker_socket");
                }
            }
            assert!(verify_isolated_record(&record, "owned", "token", None).is_err());
        }
        // `restart` keeps the `never` policy; its counters are the provider's bookkeeping.
        for restart in [
            Value::Null,
            json!({}),
            json!({"policy":"never","max_retries":0,"max_backoff_secs":0,"restart_count":3,"user_stopped":true}),
        ] {
            let mut record = plain.clone();
            record["restart"] = restart;
            verify_isolated_record(&record, "owned", "token", None).unwrap();
        }
        for restart in [
            json!({"policy":"always"}),
            json!({"policy":"on-failure","max_retries":5}),
            json!({"policy":"unless-stopped"}),
            json!("never"),
        ] {
            let mut record = plain.clone();
            record["restart"] = restart;
            assert!(verify_isolated_record(&record, "owned", "token", None).is_err());
        }
    }
    #[test]
    fn a_record_field_this_runtime_has_not_reviewed_refuses() {
        // Every field the pinned provider writes is named, so a plain record passes ...
        let mut record = fixture();
        verify_isolated_record(&record, "owned", "token", None).unwrap();
        // ... and a field the next pin adds refuses until it is classified here.
        record["teleport"] = json!(false);
        assert!(verify_isolated_record(&record, "owned", "token", None).is_err());
        record.as_object_mut().unwrap().remove("teleport");
        record["engine_build"] = json!("synthetic");
        verify_isolated_record(&record, "owned", "token", None).unwrap();
        // The list names each field once.
        let unique: std::collections::BTreeSet<_> = KNOWN_RECORD_FIELDS.iter().collect();
        assert_eq!(unique.len(), KNOWN_RECORD_FIELDS.len());
        for field in INERT_RECORD_FIELDS {
            assert!(
                KNOWN_RECORD_FIELDS.contains(&field),
                "{field} is not a known field"
            );
        }
    }
    #[test]
    fn capabilities_added_since_the_previous_pin_must_stay_inert() {
        // The fields SmolVM 1.34.1 and 1.35.4 write for a plain create, plus start bookkeeping.
        let mut plain = fixture();
        for (field, value) in [
            ("disk_durability", json!("full")),
            ("nested_virt", Value::Null),
            ("staged_mounts_detached_from", Value::Null),
            ("engine_build", json!("synthetic-build")),
            (
                "agent_rootfs_digest",
                json!(format!("sha256:{}", "0".repeat(64))),
            ),
            ("agent_rootfs_path", json!("/synthetic/rootfs")),
        ] {
            plain[field] = value;
        }
        verify_isolated_record(&plain, "owned", "token", None).unwrap();
        for inert_value in [json!(false), json!([]), json!({}), Value::Null] {
            let mut record = plain.clone();
            for field in INERT_RECORD_FIELDS {
                if !matches!(field, "block_private" | "auto_ports" | "credential_policy") {
                    record[field] = inert_value.clone();
                }
            }
            verify_isolated_record(&record, "owned", "token", None).unwrap();
        }
        // An empty block_private list enables blocking; it is not the inert default.
        let mut blocking = plain.clone();
        blocking["block_private"] = json!([]);
        assert!(verify_isolated_record(&blocking, "owned", "token", None).is_err());
        // An empty auto_ports map publishes every guest listener on the host.
        let mut publishing = plain.clone();
        publishing["auto_ports"] = json!({});
        assert!(verify_isolated_record(&publishing, "owned", "token", None).is_err());
        let mut unset = plain.clone();
        unset["auto_ports"] = Value::Null;
        verify_isolated_record(&unset, "owned", "token", None).unwrap();
        // An empty credential policy still changes the default network backend.
        let mut credentialed = plain.clone();
        credentialed["credential_policy"] = json!({});
        assert!(verify_isolated_record(&credentialed, "owned", "token", None).is_err());
        let mut uncredentialed = plain.clone();
        uncredentialed["credential_policy"] = Value::Null;
        verify_isolated_record(&uncredentialed, "owned", "token", None).unwrap();
        for field in INERT_RECORD_FIELDS {
            for value in [
                json!(true),
                json!("private-sentinel"),
                json!(["private-sentinel"]),
                json!({"private": "sentinel"}),
            ] {
                let mut record = plain.clone();
                record[field] = value;
                let error = verify_isolated_record(&record, "owned", "token", None).unwrap_err();
                assert_eq!(error.code, "unaudited_provider_config", "{field}");
                assert!(!error.message.contains("private-sentinel"));
            }
        }
        for durability in [json!("deferred"), json!(false), json!(["full"])] {
            let mut record = plain.clone();
            record["disk_durability"] = durability;
            assert!(verify_isolated_record(&record, "owned", "token", None).is_err());
        }
        plain.as_object_mut().unwrap().remove("disk_durability");
        verify_isolated_record(&plain, "owned", "token", None).unwrap();
    }

    #[test]
    fn a_running_configuration_with_a_newer_capability_is_refused() {
        let plain = json!({"cpus":2, "memory_mib":2048, "network":false, "gpu":false,
            "gpu_vram_mib":null, "cuda":false, "nested_virt":false, "rosetta":false,
            "storage_gib":4, "overlay_gib":4, "block_io":"sync", "disk_durability":"full",
            "allowed_cidrs":null, "dns":null, "dns_options":[], "shm_size":null});
        verify_running_resources(&plain).unwrap();
        let mut older = plain.clone();
        for field in ["nested_virt", "disk_durability", "dns_options", "shm_size"] {
            older.as_object_mut().unwrap().remove(field);
        }
        verify_running_resources(&older).unwrap();
        for (field, value) in [
            ("nested_virt", json!(true)),
            ("disks", json!([{"path": "/dev/disk9"}])),
            ("cache_disk", json!({"base": "/synthetic"})),
            ("disk_volumes", json!(["/data"])),
            ("block_private", json!([])),
            ("block_private", json!(["10.0.0.0/8"])),
            ("egress_rules", json!([{"cidr": "0.0.0.0/0"}])),
            ("dns_options", json!(["use-vc"])),
            ("shm_size", json!("2g")),
            ("guest_subnet", json!("10.200.0.0/30")),
            ("switch", json!({"name": "synthetic"})),
            ("disk_durability", json!("deferred")),
        ] {
            let mut changed = plain.clone();
            changed[field] = value;
            assert_eq!(
                verify_running_resources(&changed).unwrap_err().code,
                "unaudited_provider_config",
                "{field}"
            );
        }
        assert!(verify_running_resources(&Value::Null).is_err());
    }

    #[test]
    fn stored_rosetta_setting_is_a_closed_boolean_with_a_disabled_default() {
        // The pinned default record stores `rosetta: null`; `machine update --rosetta` stores true.
        let mut record = fixture();
        assert!(!record_amd64_emulation(&record).unwrap());
        record["rosetta"] = Value::Null;
        assert!(!record_amd64_emulation(&record).unwrap());
        record["rosetta"] = json!(false);
        assert!(!record_amd64_emulation(&record).unwrap());
        record["rosetta"] = json!(true);
        assert!(record_amd64_emulation(&record).unwrap());
        for value in [json!("true"), json!(1), json!({})] {
            record["rosetta"] = value;
            assert_eq!(
                record_amd64_emulation(&record).unwrap_err().code,
                "unaudited_provider_config"
            );
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
        let root = crate::unique_test_root(
            &std::env::temp_dir().canonicalize().unwrap(),
            "hack-config-audit",
        );
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
    #[test]
    fn compact_mappings_are_audited_only_in_the_selected_layout() {
        let bridge = Some(crate::provider::BridgeIntent::new(1).unwrap());
        let dependencies = crate::provider::DependencySocketIntent::new(1).unwrap();
        let home = Path::new("/fixture");
        let mut record = fixture();
        record["published_sockets"] = json!([
            {"direction":"expose","guest_path":"/run/hb/00"},
            {"direction":"mount","host_path":"/fixture/dependency-00.sock","guest_path":"/run/hd/00"}
        ]);
        let verify = |layout| {
            verify_record(
                layout,
                &record,
                "owned",
                "token",
                bridge,
                Some((dependencies, home)),
                crate::provider::NetworkIntent::Isolated,
            )
        };
        verify(PoolLayout::CompactV1).unwrap();
        assert!(verify(PoolLayout::Legacy).is_err());
    }
}
