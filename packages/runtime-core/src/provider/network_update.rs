//! Explicit stopped-pool policy extension. The journal owns both sides of the
//! provider/owner commit; ordinary startup cannot cross an unfinished update.
use super::{
    NetworkIntent, config_audit, identity, lifecycle, process,
    state::{self, Owner},
};
use crate::{Candidate, CandidateError, reject_aliased_state};
use rusqlite::{Connection, OpenFlags, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    fs::{self, File, OpenOptions},
    os::{
        fd::AsRawFd,
        unix::fs::{MetadataExt, OpenOptionsExt},
    },
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

fn refused() -> CandidateError {
    CandidateError::new(
        "network_update",
        "Stopped network extension is incomplete or its owned inputs changed; repeat the same extension only after resolving ownership.",
    )
}
fn root(candidate: &Candidate) -> PathBuf {
    candidate.state_root.join("run/smolvm")
}
fn database(candidate: &Candidate) -> PathBuf {
    #[cfg(target_os = "macos")]
    let relative = "home/Library/Application Support/smolvm/server/smolvm.db";
    #[cfg(not(target_os = "macos"))]
    let relative = "home/.local/share/smolvm/server/smolvm.db";
    root(candidate).join(relative)
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Journal {
    version: u32,
    requested: Vec<String>,
    database_identity: (u64, u64),
    owner_before: Value,
    owner_after: Value,
    record_before: Value,
    record_after: Value,
}

pub(super) fn require_complete(candidate: &Candidate) -> Result<(), CandidateError> {
    for name in ["network-update.json", "network-update.pending"] {
        match fs::symlink_metadata(root(candidate).join(name)) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            _ => return Err(refused()),
        }
    }
    Ok(())
}
fn file_identity(path: &Path) -> Result<(u64, u64), CandidateError> {
    let m = fs::symlink_metadata(path).map_err(|_| refused())?;
    if m.len() > 16 * 1024 * 1024
        || !m.is_file()
        || m.nlink() != 1
        || m.uid() != unsafe { libc::geteuid() }
        || m.mode() & 0o022 != 0
    {
        return Err(refused());
    }
    Ok((m.dev(), m.ino()))
}
fn stopped(candidate: &Candidate, owner: &Owner) -> Result<File, CandidateError> {
    if ![
        "stopped",
        "stopped-before-engine",
        "stopped-after-engine-failure",
        "recovered-unclean",
        "failed-boot-stopped",
    ]
    .contains(&owner.phase.as_str())
        || !owner.created
        || owner.storage.is_none()
        || owner.overlay.is_none()
        || owner
            .process
            .as_ref()
            .map(|p| identity::alive(p.pid))
            .transpose()?
            .unwrap_or(true)
    {
        return Err(refused());
    }
    let retained = owner.process.as_ref().ok_or_else(refused)?;
    if lifecycle::recorded_process(candidate, owner)? != *retained {
        return Err(refused());
    }
    super::graph::verify_owner_registry(candidate, owner)?;
    lifecycle::verify_disks(candidate, owner)?;
    let directory = owner.real_data_dir(candidate)?;
    let path = directory.join("vm.lock");
    let expected = file_identity(&path)?;
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(&path)
        .map_err(|_| refused())?;
    let m = lock.metadata().map_err(|_| refused())?;
    if (m.dev(), m.ino()) != expected {
        return Err(refused());
    }
    // SAFETY: the live owned file descriptor remains held through both commits.
    if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err(refused());
    }
    let handles = process::capture(
        process::clean_command(Path::new("/usr/sbin/lsof"))
            .args(["-n", "-P", "-t", "--"])
            .arg(directory.join("storage.raw"))
            .arg(directory.join("overlay.raw")),
        Duration::from_secs(5),
    )?;
    if handles.status.code() != Some(1) || !handles.stdout.is_empty() || !handles.stderr.is_empty()
    {
        return Err(refused());
    }
    Ok(lock)
}
fn merged(
    before: &NetworkIntent,
    requested: &[String],
    addresses: &[String],
) -> Result<NetworkIntent, CandidateError> {
    let NetworkIntent::ApprovedHosts { hosts, cidrs } = before else {
        return Err(refused());
    };
    let mut names: BTreeSet<_> = hosts.iter().cloned().collect();
    names.extend(requested.iter().cloned());
    let mut new_cidrs = cidrs.clone();
    for address in addresses {
        if !new_cidrs.contains(address) {
            new_cidrs.push(address.clone());
        }
    }
    let value = NetworkIntent::ApprovedHosts {
        hosts: names.into_iter().collect(),
        cidrs: new_cidrs,
    };
    value.validate()?;
    Ok(value)
}
fn resolve(hosts: &[String]) -> Result<Vec<String>, CandidateError> {
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut addresses = BTreeSet::new();
    for host in hosts {
        let budget = deadline
            .saturating_duration_since(Instant::now())
            .min(Duration::from_secs(5));
        if budget.is_zero() {
            return Err(refused());
        }
        let output = process::capture(
            process::clean_command(Path::new("/usr/bin/dscacheutil"))
                .args(["-q", "host", "-a", "name", host]),
            budget,
        )?;
        if !output.status.success() || output.stdout.len() >= 65536 || !output.stderr.is_empty() {
            return Err(refused());
        }
        let text = std::str::from_utf8(&output.stdout).map_err(|_| refused())?;
        let resolved = parse_addresses(text)?;
        addresses.extend(resolved);
    }
    Ok(addresses.into_iter().collect())
}
fn parse_addresses(text: &str) -> Result<Vec<String>, CandidateError> {
    let mut addresses = BTreeSet::new();
    for line in text.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        if !["ip_address", "ipv6_address"].contains(&key.trim()) {
            continue;
        }
        let ip: std::net::IpAddr = value.trim().parse().map_err(|_| refused())?;
        addresses.insert(format!("{ip}/{}", if ip.is_ipv4() { 32 } else { 128 }));
    }
    if addresses.is_empty() {
        return Err(refused());
    }
    let result: Vec<_> = addresses.into_iter().collect();
    NetworkIntent::ApprovedHosts {
        hosts: vec!["validation.example".into()],
        cidrs: result.clone(),
    }
    .validate()?;
    Ok(result)
}
fn owner_value(owner: &Owner) -> Result<Value, CandidateError> {
    serde_json::to_value(owner).map_err(|_| refused())
}
fn plan(
    owner: &Owner,
    record: Value,
    requested: Vec<String>,
    addresses: Vec<String>,
    database_identity: (u64, u64),
) -> Result<Journal, CandidateError> {
    let network = merged(&owner.network, &requested, &addresses)?;
    let mut owner_after = owner_value(owner)?;
    owner_after["network"] = serde_json::to_value(&network).map_err(|_| refused())?;
    let NetworkIntent::ApprovedHosts { hosts, cidrs } = &network else {
        return Err(refused());
    };
    let mut record_after = record.clone();
    record_after["dns_filter_hosts"] = json!(hosts);
    record_after["allowed_cidrs"] = json!(cidrs);
    Ok(Journal {
        version: 1,
        requested,
        database_identity,
        owner_before: owner_value(owner)?,
        owner_after,
        record_before: record,
        record_after,
    })
}
fn validate(j: &Journal) -> Result<(Owner, Owner), CandidateError> {
    let before: Owner = serde_json::from_value(j.owner_before.clone()).map_err(|_| refused())?;
    let after: Owner = serde_json::from_value(j.owner_after.clone()).map_err(|_| refused())?;
    NetworkIntent::approved_hosts(j.requested.clone())?;
    let NetworkIntent::ApprovedHosts { cidrs, .. } = &after.network else {
        return Err(refused());
    };
    let expected = plan(
        &before,
        j.record_before.clone(),
        j.requested.clone(),
        cidrs.clone(),
        j.database_identity,
    )?;
    if j.version != 1
        || expected.owner_after != j.owner_after
        || expected.record_after != j.record_after
    {
        return Err(refused());
    }
    before.network.verify(&j.record_before)?;
    after.network.verify(&j.record_after)?;
    Ok((before, after))
}
fn validate_sides(j: &Journal, owner: &Value, record: &Value) -> Result<(), CandidateError> {
    if (owner != &j.owner_before && owner != &j.owner_after)
        || (record != &j.record_before && record != &j.record_after)
        || (j.owner_before != j.owner_after
            && owner == &j.owner_after
            && record == &j.record_before)
    {
        return Err(refused());
    }
    Ok(())
}
fn verify_record_process(owner: &Owner, record: &Value) -> Result<(), CandidateError> {
    let process = owner.process.as_ref().ok_or_else(refused)?;
    if record["pid"] != json!(process.pid)
        || record["pid_start_time"] != json!(process.start_micros)
    {
        return Err(refused());
    }
    Ok(())
}
fn apply_database(path: &Path, machine: &str, j: &Journal) -> Result<(), CandidateError> {
    if file_identity(path)? != j.database_identity {
        return Err(refused());
    }
    // Existing audited schema only. No CREATE, replacement, or unrelated row writes.
    let mut connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .map_err(|_| refused())?;
    connection
        .busy_timeout(Duration::from_millis(200))
        .map_err(|_| refused())?;
    connection
        .pragma_update(None, "synchronous", "FULL")
        .map_err(|_| refused())?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| refused())?;
    let count: i64 = transaction
        .query_row("SELECT count(*) FROM vms", [], |r| r.get(0))
        .map_err(|_| refused())?;
    let bytes: Vec<u8> = transaction
        .query_row(
            "SELECT substr(data,1,65537) FROM vms WHERE name=?1",
            [machine],
            |r| r.get(0),
        )
        .map_err(|_| refused())?;
    if count != 1 || bytes.len() > 65536 {
        return Err(refused());
    }
    let current: Value = serde_json::from_slice(&bytes).map_err(|_| refused())?;
    if current != j.record_before && current != j.record_after {
        return Err(refused());
    }
    if file_identity(path)? != j.database_identity {
        return Err(refused());
    }
    if current == j.record_before {
        let bytes = serde_json::to_vec(&j.record_after).map_err(|_| refused())?;
        if bytes.len() > 65536 {
            return Err(refused());
        }
        let changed = transaction
            .execute(
                "UPDATE vms SET data=?1 WHERE name=?2",
                rusqlite::params![bytes, machine],
            )
            .map_err(|_| refused())?;
        if changed != 1 {
            return Err(refused());
        }
    }
    transaction.commit().map_err(|_| refused())?;
    if file_identity(path)? != j.database_identity {
        return Err(refused());
    }
    Ok(())
}
/// Extend an existing stopped approved-host pool without restarting or replacing disks.
/// Repeating the same request reconciles only the journal's exact before/after states.
pub fn extend_network(
    candidate: &Candidate,
    mut hosts: Vec<String>,
) -> Result<Value, CandidateError> {
    hosts.sort();
    NetworkIntent::approved_hosts(hosts.clone())?;
    reject_aliased_state(&root(candidate))?;
    let _lock = state::Lock::acquire(&root(candidate))?;
    let owner = Owner::load(candidate)?;
    let _vm_lock = stopped(candidate, &owner)?;
    let path = root(candidate).join("network-update.json");
    let db = database(candidate);
    let record = config_audit::read_database(&db, &owner.machine)?;
    verify_record_process(&owner, &record)?;
    let j: Journal = match fs::symlink_metadata(&path) {
        Ok(_) => {
            file_identity(&path)?;
            state::read(&path)?
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            require_complete(candidate)?;
            config_audit::verify_value(candidate, &owner, &record)?;
            let NetworkIntent::ApprovedHosts {
                hosts: existing, ..
            } = &owner.network
            else {
                return Err(refused());
            };
            let added: Vec<_> = hosts
                .iter()
                .filter(|h| !existing.contains(h))
                .cloned()
                .collect();
            let j = plan(
                &owner,
                record.clone(),
                hosts.clone(),
                resolve(&added)?,
                file_identity(&db)?,
            )?;
            state::write(&path, &j)?;
            j
        }
        Err(_) => return Err(refused()),
    };
    let (before, after) = validate(&j)?;
    let current_owner = owner_value(&owner)?;
    if j.requested != hosts
        || (current_owner != j.owner_before && current_owner != j.owner_after)
        || (record != j.record_before && record != j.record_after)
    {
        return Err(refused());
    }
    validate_sides(&j, &current_owner, &record)?;
    config_audit::verify_value(candidate, &before, &j.record_before)?;
    config_audit::verify_value(candidate, &after, &j.record_after)?;
    if owner_value(&Owner::load(candidate)?)? != current_owner {
        return Err(refused());
    }
    lifecycle::verify_disks(candidate, &owner)?;
    apply_database(&db, &owner.machine, &j)?;
    config_audit::verify_value(
        candidate,
        &after,
        &config_audit::read_database(&db, &owner.machine)?,
    )?;
    lifecycle::verify_disks(candidate, &owner)?;
    // A fully written interrupted owner staging file is removable only if exact.
    let pending = root(candidate).join("owner.pending");
    match fs::symlink_metadata(&pending) {
        Ok(_) => {
            file_identity(&pending)?;
            let staged: Value = state::read(&pending)?;
            if staged != j.owner_after {
                return Err(refused());
            }
            fs::remove_file(&pending).map_err(|_| refused())?;
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(refused()),
    }
    if owner_value(&Owner::load(candidate)?)? != current_owner {
        return Err(refused());
    }
    if current_owner != j.owner_after {
        after.save(candidate)?;
    }
    config_audit::verify(candidate, &Owner::load(candidate)?)?;
    fs::remove_file(&path).map_err(|_| refused())?;
    File::open(root(candidate))
        .and_then(|f| f.sync_all())
        .map_err(|_| refused())?;
    Ok(
        json!({"kind":"network_extended", "owner":owner.token, "machine":owner.machine, "network":after.network, "restarted":false, "disks_preserved":true}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture {
        directory: PathBuf,
        db: PathBuf,
        journal: Journal,
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.directory);
        }
    }
    fn fixture() -> Fixture {
        let directory = std::env::temp_dir().join(format!(
            "network-update-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&directory).unwrap();
        let directory = fs::canonicalize(directory).unwrap();
        let db = directory.join("provider.db");
        let connection = Connection::open(&db).unwrap();
        connection
            .execute(
                "CREATE TABLE vms(name TEXT PRIMARY KEY, data BLOB NOT NULL)",
                [],
            )
            .unwrap();
        let record = json!({"name":"fixture", "network":true,"network_backend":"virtio-net",
            "allowed_cidrs":["1.1.1.1/32"],"dns_filter_hosts":["registry.example.com"],"unrelated":{"preserved":true}});
        connection
            .execute(
                "INSERT INTO vms VALUES('fixture', ?1)",
                [serde_json::to_vec(&record).unwrap()],
            )
            .unwrap();
        drop(connection);
        let owner: Owner = serde_json::from_value(json!({
            "version":1,"checkout":"/fixture","token":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","machine":"fixture",
            "short_home":"/fixture","created":true,"phase":"stopped","process":null,
            "storage":null,"overlay":null,"guest_boot_id":null,"daemon_pid":null,"daemon_start":null,"rootfs_digest":null,
            "network":{"approved-hosts":{"hosts":["registry.example.com"],"cidrs":["1.1.1.1/32"]}}
        })).unwrap();
        let journal = plan(
            &owner,
            record,
            vec!["packages.example.com".into()],
            vec!["8.8.8.8/32".into()],
            file_identity(&db).unwrap(),
        )
        .unwrap();
        Fixture {
            directory,
            db,
            journal,
        }
    }
    #[test]
    fn interrupted_sides_resume_exact_transaction_and_preserve_other_fields() {
        let f = fixture();
        validate(&f.journal).unwrap();
        validate_sides(
            &f.journal,
            &f.journal.owner_before,
            &f.journal.record_before,
        )
        .unwrap();
        let path = f.directory.join("journal.json");
        state::write(&path, &f.journal).unwrap();
        let saved: Journal = state::read(&path).unwrap();
        apply_database(&f.db, "fixture", &saved).unwrap();
        let current = config_audit::read_database(&f.db, "fixture").unwrap();
        assert_eq!(current, saved.record_after);
        assert_eq!(current["unrelated"], saved.record_before["unrelated"]);
        validate_sides(&saved, &saved.owner_before, &current).unwrap();
        // Crash after database commit, then after owner commit: neither repeats an effect.
        apply_database(&f.db, "fixture", &saved).unwrap();
        validate_sides(&saved, &saved.owner_after, &current).unwrap();
        assert!(validate_sides(&saved, &saved.owner_after, &saved.record_before).is_err());
        let mut changed = saved.owner_before.clone();
        changed["phase"] = json!("running");
        assert!(validate_sides(&saved, &changed, &current).is_err());
    }
    #[test]
    fn foreign_record_extra_row_and_replaced_database_refuse_without_writes() {
        let f = fixture();
        let connection = Connection::open(&f.db).unwrap();
        let mut changed = f.journal.record_before.clone();
        changed["unrelated"] = json!(false);
        connection
            .execute(
                "UPDATE vms SET data=?1",
                [serde_json::to_vec(&changed).unwrap()],
            )
            .unwrap();
        assert!(apply_database(&f.db, "fixture", &f.journal).is_err());
        assert_eq!(
            config_audit::read_database(&f.db, "fixture").unwrap(),
            changed
        );
        connection
            .execute(
                "UPDATE vms SET data=?1",
                [serde_json::to_vec(&f.journal.record_before).unwrap()],
            )
            .unwrap();
        connection
            .execute("INSERT INTO vms VALUES('foreign', ?1)", [b"{}".as_slice()])
            .unwrap();
        assert!(apply_database(&f.db, "fixture", &f.journal).is_err());
        connection
            .execute("DELETE FROM vms WHERE name='foreign'", [])
            .unwrap();
        drop(connection);
        let replacement = f.directory.join("replacement.db");
        fs::copy(&f.db, &replacement).unwrap();
        fs::rename(&replacement, &f.db).unwrap();
        assert!(apply_database(&f.db, "fixture", &f.journal).is_err());
    }
    #[test]
    fn journal_cannot_change_other_owner_or_record_fields_or_remove_pins() {
        let mut f = fixture();
        f.journal.owner_after["machine"] = json!("foreign");
        assert!(validate(&f.journal).is_err());
        f.journal.owner_after["machine"] = json!("fixture");
        f.journal.record_after["unrelated"] = json!(false);
        assert!(validate(&f.journal).is_err());
        f.journal.record_after["unrelated"] = f.journal.record_before["unrelated"].clone();
        f.journal.owner_after["network"]["approved-hosts"]["cidrs"] = json!(["8.8.8.8/32"]);
        assert!(validate(&f.journal).is_err());
    }
    #[test]
    fn dns_parsing_refuses_empty_private_metadata_subnets_and_malformed_answers() {
        assert_eq!(parse_addresses("name: packages.example.com\nip_address: 8.8.8.8\nip_address: 8.8.8.8\nipv6_address: 2606:4700::6810:922\n").unwrap().len(), 2);
        for text in [
            "",
            "name: empty.example",
            "ip_address: 127.0.0.1",
            "ip_address: 169.254.169.254",
            "ip_address: 10.0.0.1",
            "ipv6_address: ::1",
            "ipv6_address: fc00::1",
            "ip_address: 8.8.8.0/24",
            "ip_address: broken",
        ] {
            assert!(parse_addresses(text).is_err());
        }
    }
    #[test]
    fn only_approved_hosts_can_extend_and_duplicates_refuse() {
        assert!(
            merged(
                &NetworkIntent::Isolated,
                &["packages.example.com".into()],
                &["8.8.8.8/32".into()]
            )
            .is_err()
        );
        assert!(NetworkIntent::approved_hosts(vec!["packages.example.com".into(); 2]).is_err());
        let f = fixture();
        let (before, _) = validate(&f.journal).unwrap();
        let no_change = merged(&before.network, &["registry.example.com".into()], &[]).unwrap();
        assert_eq!(no_change, before.network);
    }
    #[test]
    fn unfinished_or_aliased_journal_fences_startup() {
        let f = fixture();
        let mut candidate = Candidate::discover(Path::new(env!("CARGO_MANIFEST_DIR"))).unwrap();
        candidate.state_root = f.directory.clone();
        fs::create_dir_all(root(&candidate)).unwrap();
        require_complete(&candidate).unwrap();
        for name in ["network-update.json", "network-update.pending"] {
            let path = root(&candidate).join(name);
            fs::write(&path, b"incomplete").unwrap();
            assert!(require_complete(&candidate).is_err());
            fs::remove_file(&path).unwrap();
            std::os::unix::fs::symlink("missing", &path).unwrap();
            assert!(require_complete(&candidate).is_err());
            fs::remove_file(path).unwrap();
        }
    }
    #[test]
    fn database_process_must_match_retained_identity_even_when_state_is_running() {
        let f = fixture();
        let (mut owner, _) = validate(&f.journal).unwrap();
        owner.process = Some(identity::ProcessIdentity {
            pid: 123,
            start_micros: 456,
            uid: 0,
            executable: "/fixture".into(),
        });
        let mut record = json!({"state":"running", "pid":123,"pid_start_time":456});
        verify_record_process(&owner, &record).unwrap();
        record["pid_start_time"] = json!(457);
        assert!(verify_record_process(&owner, &record).is_err());
        record["pid_start_time"] = json!(456);
        record["pid"] = Value::Null;
        assert!(verify_record_process(&owner, &record).is_err());
    }
    #[test]
    fn running_or_missing_process_and_live_retained_process_refuse_before_effects() {
        let f = fixture();
        let candidate = Candidate::discover(Path::new(env!("CARGO_MANIFEST_DIR"))).unwrap();
        let (mut owner, _) = validate(&f.journal).unwrap();
        let disk = identity::DiskIdentity {
            device: 1,
            inode: 1,
            bytes: 1,
            uuid: "fixture".into(),
        };
        owner.storage = Some(disk.clone());
        owner.overlay = Some(disk);
        assert!(stopped(&candidate, &owner).is_err());
        owner.process = Some(identity::ProcessIdentity {
            pid: std::process::id() as i32,
            start_micros: 1,
            uid: 0,
            executable: "/fixture".into(),
        });
        assert!(stopped(&candidate, &owner).is_err());
        owner.phase = "running".into();
        assert!(stopped(&candidate, &owner).is_err());
        assert_eq!(
            config_audit::read_database(&f.db, "fixture").unwrap(),
            f.journal.record_before
        );
    }
}
