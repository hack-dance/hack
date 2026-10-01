//! Test-only pre-host-boot projection for an exact dead, previously bound claim.
//! The journal and guest observations remain real; this is not a physical reboot.
use super::*;

pub(in crate::provider::graph) fn synthesize(
    candidate: &Candidate,
    receipt: &Receipt,
    expected_process: &ProcessIdentity,
    rebind: DeviceRebind,
    host_boot_micros: u64,
) -> Result<(), CandidateError> {
    let _lease = state::Lock::acquire_existing(&candidate.state_root.join("run/smolvm"))?;
    let owner = state::Owner::load(candidate)?;
    let graph = super::super::directory(candidate, &receipt.run)?;
    let graph_bytes =
        super::super::host_pin_recovery::read_raw(&graph.join("state.json"), 4 * 1024 * 1024)?;
    if receipt.phase != "ready-observed"
        || receipt.owner != owner.token
        || owner.phase != "running"
        || owner.storage.as_ref().map(|disk| disk.device) != Some(rebind.current)
        || rebind.old == rebind.current
        || host_boot_micros <= 1
        || graph_bytes != serde_json::to_vec_pretty(receipt).map_err(|_| refused())?
    {
        return Err(refused());
    }
    let values = records(
        &root(candidate),
        &owner.token,
        owner.dependency_sockets.map_or(0, |intent| intent.slots),
    )?;
    let record = values
        .iter()
        .find(|r| r.run == receipt.run)
        .ok_or_else(refused)?;
    // SAFETY: geteuid has no arguments or side effects.
    identity::verify(
        &record.process,
        expected_process,
        &expected_process.executable,
        unsafe { libc::geteuid() },
    )?;
    let slots = receipt
        .relay_startup
        .as_ref()
        .ok_or_else(refused)?
        .services
        .values()
        .flat_map(|service| service.bindings.values().map(|binding| binding.slot))
        .collect::<BTreeSet<_>>();
    if owner.previous_guest_boot_id.as_deref() != Some(record.boot.as_str())
        || owner.guest_boot_id.as_deref() == Some(record.boot.as_str())
        || record.slots.values().copied().collect::<BTreeSet<_>>() != slots
        || record.sockets.len() != record.slots.len()
        || record.process.start_micros < host_boot_micros
        || identity::alive(record.process.pid)?
    {
        return Err(refused());
    }
    let path = root(candidate).join(format!("{}.json", receipt.run));
    let (again, bytes, id) = read_with_identity(&path)?;
    if &again != record || !absent(&path.with_extension("pending"))? {
        return Err(refused());
    }
    // Preflight every actual socket before translating only its recorded device.
    // A replaced path, live listener or incomplete binding is never fabricated.
    for slot in record.slots.values() {
        let path = socket(&owner.short_home, *slot);
        let metadata = fs::symlink_metadata(&path).map_err(|_| refused())?;
        if !metadata.file_type().is_socket()
            || metadata.uid() != record.process.uid
            || metadata.mode() & 0o7777 != 0o600
            || metadata.nlink() != 1
            || record.sockets.get(slot) != Some(&(metadata.dev(), metadata.ino()))
            || metadata.dev() != rebind.current
        {
            return Err(refused());
        }
        crate::provider::relay_owner::publication::dead::no_listener(&path)?;
    }
    let mut projected = record.clone();
    projected.process.start_micros = host_boot_micros - 1;
    for identity in projected.sockets.values_mut() {
        identity.0 = rebind.old;
    }
    // Preserve PID/UID/executable, owner/run/token/boot, slots and socket inodes.
    let (same, same_bytes, same_id) = read_with_identity(&path)?;
    if same != *record || same_bytes != bytes || same_id != id {
        return Err(refused());
    }
    state::write(&path, &projected)?;
    // Exercise the unchanged production inspector before historical retirement.
    inspect_legacy(candidate, &receipt.run, rebind, host_boot_micros)?.ok_or_else(refused)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::state::Owner;
    use serde_json::json;
    use std::os::unix::{fs::PermissionsExt, net::UnixListener};

    struct Fixture {
        root: super::super::super::tests::Fixture,
        candidate: Candidate,
        owner: Owner,
        receipt: Receipt,
        record: Record,
        rebind: DeviceRebind,
        host_boot: u64,
    }
    impl Fixture {
        fn new() -> Self {
            let root = super::super::super::tests::Fixture::new();
            let candidate = Candidate::discover(&root.0).unwrap();
            let provider = candidate.state_root.join("run/smolvm");
            state::private_directory(&provider.join("home")).unwrap();
            drop(state::Lock::acquire(&provider).unwrap());
            let token = super::super::super::probes::token().unwrap();
            let short_home = Path::new("/private/tmp").join(format!("hkl-{}", &token[..12]));
            std::os::unix::fs::symlink(provider.join("home"), &short_home).unwrap();
            let current = fs::metadata(provider.join("home")).unwrap().dev();
            let owner: Owner = serde_json::from_value(json!({
                "version":1,"checkout":candidate.checkout,"token":token,
                "machine":format!("hack-{}",&token[..12]),"short_home":short_home,
                "created":true,"phase":"running","process":null,
                "dependency_sockets":{"slots":3},
                "storage":{"device":current,"inode":1,"bytes":1,"uuid":"synthetic"},
                "overlay":null,"guest_boot_id":"d".repeat(36),
                "previous_guest_boot_id":"b".repeat(36),"daemon_pid":null,
                "daemon_start":null,"rootfs_digest":null
            }))
            .unwrap();
            state::write(&provider.join("owner.json"), &owner).unwrap();
            let host_boot =
                crate::provider::lifecycle::host_filesystem::host_boot_micros().unwrap();
            let mut process = identity::observe(std::process::id() as i32).unwrap();
            process.pid = i32::MAX;
            assert!(!identity::alive(process.pid).unwrap());
            let mut record = Record {
                version: 1,
                owner: token,
                boot: "b".repeat(36),
                run: "a".repeat(32),
                token: "c".repeat(32),
                process,
                slots: BTreeMap::from([(0, 0), (1, 1)]),
                sockets: BTreeMap::new(),
            };
            for slot in 0..3 {
                let path = socket(&short_home, slot);
                let listener = UnixListener::bind(&path).unwrap();
                fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
                let m = fs::symlink_metadata(&path).unwrap();
                if slot < 2 {
                    record.sockets.insert(slot, (m.dev(), m.ino()));
                }
                drop(listener);
            }
            state::private_directory(&super::super::root(&candidate)).unwrap();
            state::write(
                &super::super::root(&candidate).join(format!("{}.json", record.run)),
                &record,
            )
            .unwrap();
            let mut sibling = record.clone();
            sibling.run = "e".repeat(32);
            sibling.slots = BTreeMap::from([(0, 2)]);
            let m = fs::symlink_metadata(socket(&short_home, 2)).unwrap();
            sibling.sockets = BTreeMap::from([(2, (m.dev(), m.ino()))]);
            state::write(
                &super::super::root(&candidate).join(format!("{}.json", sibling.run)),
                &sibling,
            )
            .unwrap();
            let receipt: Receipt = serde_json::from_value(json!({
                "version":1,"run":record.run,"owner":owner.token,"namespace":"c".repeat(64),
                "plan_id":"d".repeat(64),"phase":"ready-observed","readiness":{},"resources":{},
                "relay_startup":{"guest_root":null,"control_root":"/private/fixture-control",
                    "artifact":"f".repeat(64),"services":{"web":{"generation":"a".repeat(32),
                        "phase":"released","started_at":null,"bindings":{
                            "default":{"slot":0,"port":25252,"process":null},
                            "second":{"slot":1,"port":25253,"process":null}}}}}
            }))
            .unwrap();
            let graph = super::super::super::directory(&candidate, &record.run).unwrap();
            state::private_directory(&graph).unwrap();
            state::write(&graph.join("state.json"), &receipt).unwrap();
            fs::write(graph.join("dependency-rebind.json"), b"unchanged journal").unwrap();
            Self {
                root,
                candidate,
                owner,
                receipt,
                record,
                rebind: DeviceRebind {
                    old: current + 1,
                    current,
                },
                host_boot,
            }
        }
        fn path(&self) -> PathBuf {
            super::super::root(&self.candidate).join(format!("{}.json", self.record.run))
        }
        fn project(&self) -> Result<(), CandidateError> {
            synthesize(
                &self.candidate,
                &self.receipt,
                &self.record.process,
                self.rebind,
                self.host_boot,
            )
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let expected = self.candidate.state_root.join("run/smolvm/home");
            assert_eq!(fs::read_link(&self.owner.short_home).unwrap(), expected);
            fs::remove_file(&self.owner.short_home).unwrap();
            assert!(self.root.0.exists());
        }
    }

    #[test]
    fn projects_every_selected_socket_and_only_prior_boot_fields() {
        let fixture = Fixture::new();
        let sibling =
            super::super::root(&fixture.candidate).join(format!("{}.json", "e".repeat(32)));
        let sibling_before = fs::read(&sibling).unwrap();
        let graph =
            super::super::super::directory(&fixture.candidate, &fixture.record.run).unwrap();
        let graph_before = fs::read(graph.join("state.json")).unwrap();
        fixture.project().unwrap();
        let mut expected = fixture.record.clone();
        expected.process.start_micros = fixture.host_boot - 1;
        for id in expected.sockets.values_mut() {
            id.0 = fixture.rebind.old;
        }
        assert_eq!(read(&fixture.path()).unwrap(), expected);
        assert_eq!(fs::read(sibling).unwrap(), sibling_before);
        assert_eq!(fs::read(graph.join("state.json")).unwrap(), graph_before);
        assert_eq!(
            fs::read(graph.join("dependency-rebind.json")).unwrap(),
            b"unchanged journal"
        );
    }

    #[test]
    fn production_inspector_still_refuses_current_boot_and_device_mismatches() {
        let fixture = Fixture::new();
        let inspect = || {
            inspect_legacy(
                &fixture.candidate,
                &fixture.record.run,
                fixture.rebind,
                fixture.host_boot,
            )
        };
        assert_eq!(inspect().unwrap_err().code, "host_pin_recovery");
        fixture.project().unwrap();
        let projected: Record = read(&fixture.path()).unwrap();
        for case in 0..3 {
            let mut changed: Record = projected.clone();
            let code = if case == 0 {
                changed.process.start_micros = fixture.host_boot;
                "host_pin_recovery"
            } else {
                let id = changed.sockets.get_mut(&1).unwrap();
                if case == 1 {
                    id.0 = fixture.rebind.current;
                } else {
                    id.1 += 1;
                }
                "dependency_reservation"
            };
            state::write(&fixture.path(), &changed).unwrap();
            let before = fs::read(fixture.path()).unwrap();
            assert_eq!(inspect().unwrap_err().code, code);
            assert_eq!(fs::read(fixture.path()).unwrap(), before);
            assert!(socket(&fixture.owner.short_home, 0).exists());
            assert!(socket(&fixture.owner.short_home, 1).exists());
        }
    }

    #[test]
    fn setup_refuses_changed_schema_identity_and_live_listener_before_writing() {
        for case in 0..7 {
            let fixture = Fixture::new();
            let path = fixture.path();
            let mut record = fixture.record.clone();
            let mut live = None;
            match case {
                0 => record.owner = "0".repeat(32),
                1 => record.boot = "0".repeat(36),
                2 => record.sockets.get_mut(&1).unwrap().1 += 1,
                3 => record.process = identity::observe(std::process::id() as i32).unwrap(),
                4 => {
                    fs::remove_file(socket(&fixture.owner.short_home, 1)).unwrap();
                    live = Some(UnixListener::bind(socket(&fixture.owner.short_home, 1)).unwrap());
                    fs::set_permissions(
                        socket(&fixture.owner.short_home, 1),
                        fs::Permissions::from_mode(0o600),
                    )
                    .unwrap();
                    let m = fs::symlink_metadata(socket(&fixture.owner.short_home, 1)).unwrap();
                    record.sockets.insert(1, (m.dev(), m.ino()));
                }
                6 => record.process.executable = PathBuf::from("/tmp/unrelated-executable"),
                _ => {}
            }
            state::write(&path, &record).unwrap();
            if case == 5 {
                let mut invalid = serde_json::to_value(&record).unwrap();
                invalid["unknown"] = json!(true);
                state::write(&path, &invalid).unwrap();
            }
            let before = fs::read(&path).unwrap();
            assert!(fixture.project().is_err());
            assert_eq!(fs::read(path).unwrap(), before);
            drop(live);
        }
    }
}
