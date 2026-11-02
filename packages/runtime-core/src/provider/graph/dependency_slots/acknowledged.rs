//! A completed current-boot cleanup may strand a reservation if later archival
//! fails. Exact retirement and ACK authority come from the caller, not this file.
use super::*;
use std::ffi::CString;

struct Paths<'a> {
    directory: &'a Path,
    home: &'a Path,
    canonical_home: &'a Path,
    history: &'a Path,
}

struct HomePin<'a> {
    alias: &'a Path,
    target: &'a Path,
    alias_id: (u64, u64),
    target_id: (u64, u64),
}
impl<'a> HomePin<'a> {
    fn capture(alias: &'a Path, target: &'a Path) -> Result<Self, CandidateError> {
        let a = fs::symlink_metadata(alias).map_err(|_| refused())?;
        let t = fs::symlink_metadata(target).map_err(|_| refused())?;
        let pin = Self {
            alias,
            target,
            alias_id: (a.dev(), a.ino()),
            target_id: (t.dev(), t.ino()),
        };
        pin.verify()?;
        Ok(pin)
    }
    fn verify(&self) -> Result<(), CandidateError> {
        let a = fs::symlink_metadata(self.alias).map_err(|_| refused())?;
        let t = fs::symlink_metadata(self.target).map_err(|_| refused())?;
        state::check_private_directory(self.target)?;
        // SAFETY: geteuid has no parameters or side effects.
        if !a.file_type().is_symlink()
            || a.uid() != unsafe { libc::geteuid() }
            || a.nlink() != 1
            || (a.dev(), a.ino()) != self.alias_id
            || !t.is_dir()
            || (t.dev(), t.ino()) != self.target_id
            || fs::read_link(self.alias).map_err(|_| refused())? != self.target
        {
            return Err(refused());
        }
        Ok(())
    }
}
struct Selection<'a> {
    owner: &'a str,
    run: &'a str,
    boot: &'a str,
    process: &'a ProcessIdentity,
    slots: BTreeSet<u8>,
    expected: &'a str,
    capacity: u8,
}

fn validate(record: &Record, selected: &Selection<'_>, home: &Path) -> Result<(), CandidateError> {
    if !valid(record, selected.owner, selected.capacity)
        || record.run != selected.run
        || record.boot != selected.boot
        || record.process != *selected.process
        || record.slots.values().copied().collect::<BTreeSet<_>>() != selected.slots
        || fingerprint(record)? != selected.expected
        || identity::alive(record.process.pid)?
    {
        return Err(refused());
    }
    // Even a matching stale socket is retained: this operation moves only the
    // record after ordinary cleanup already closed every recorded listener.
    for slot in record.slots.values() {
        if !absent(&socket(home, *slot))? {
            return Err(refused());
        }
    }
    Ok(())
}

fn rename_exclusive(source: &Path, destination: &Path) -> Result<(), CandidateError> {
    let source = CString::new(source.as_os_str().as_encoded_bytes()).map_err(|_| refused())?;
    let destination =
        CString::new(destination.as_os_str().as_encoded_bytes()).map_err(|_| refused())?;
    // SAFETY: both C strings remain valid during this macOS call. RENAME_EXCL
    // atomically refuses an occupied target; no existing evidence is replaced.
    if unsafe { libc::renamex_np(source.as_ptr(), destination.as_ptr(), libc::RENAME_EXCL) } != 0 {
        return Err(refused());
    }
    Ok(())
}

fn sync_directory(path: &Path, expected: (u64, u64)) -> Result<(), CandidateError> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_DIRECTORY)
        .open(path)
        .map_err(|_| refused())?;
    let m = file.metadata().map_err(|_| refused())?;
    if (m.dev(), m.ino()) != expected || !m.is_dir() {
        return Err(refused());
    }
    file.sync_all().map_err(state::io)
}

fn archive(
    paths: Paths<'_>,
    selected: Selection<'_>,
    verify: &dyn Fn() -> Result<(), CandidateError>,
) -> Result<(), CandidateError> {
    verify()?;
    state::check_private_directory(paths.directory)?;
    state::check_private_directory(paths.history)?;
    let home = HomePin::capture(paths.home, paths.canonical_home)?;
    let directory_metadata = fs::symlink_metadata(paths.directory).map_err(|_| refused())?;
    let history_metadata = fs::symlink_metadata(paths.history).map_err(|_| refused())?;
    let parents = [
        (directory_metadata.dev(), directory_metadata.ino()),
        (history_metadata.dev(), history_metadata.ino()),
    ];
    let verify_paths = || {
        home.verify()?;
        for (path, expected) in [paths.directory, paths.history].into_iter().zip(parents) {
            state::check_private_directory(path)?;
            let m = fs::symlink_metadata(path).map_err(|_| refused())?;
            if (m.dev(), m.ino()) != expected {
                return Err(refused());
            }
        }
        Ok(())
    };
    records(paths.directory, selected.owner, selected.capacity)?;
    let source = paths.directory.join(format!("{}.json", selected.run));
    let target = paths.history.join(format!(
        "dependency-reservation-retired-{}.json",
        selected.expected
    ));
    if !absent(&source.with_extension("pending"))? || !absent(&target.with_extension("pending"))? {
        return Err(refused());
    }
    if absent(&source)? {
        // A retry must find the exact retained record; ordinary absence is not
        // authority and a new same-run reservation is never adopted.
        let (record, bytes, id) = read_with_identity(&target)?;
        verify_paths()?;
        validate(&record, &selected, paths.canonical_home)?;
        verify()?;
        verify_paths()?;
        for (path, expected) in [paths.directory, paths.history].into_iter().zip(parents) {
            sync_directory(path, expected)?;
        }
        let (again, current, current_id) = read_with_identity(&target)?;
        if again != record || current != bytes || current_id != id || !absent(&source)? {
            return Err(refused());
        }
        validate(&again, &selected, paths.canonical_home)?;
        return Ok(());
    }
    if !absent(&target)? {
        return Err(refused());
    }
    let (record, bytes, id) = read_with_identity(&source)?;
    verify_paths()?;
    validate(&record, &selected, paths.canonical_home)?;
    verify()?;
    let (again, current, current_id) = read_with_identity(&source)?;
    verify_paths()?;
    if again != record || current != bytes || current_id != id {
        return Err(refused());
    }
    validate(&again, &selected, paths.canonical_home)?;
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(&source)
        .map_err(|_| refused())?;
    let m = file.metadata().map_err(|_| refused())?;
    if !m.is_file() || (m.dev(), m.ino()) != id || m.nlink() != 1 {
        return Err(refused());
    }
    file.sync_all().map_err(state::io)?;
    verify()?;
    // The provider/publication locks stay held. Recheck the selected inode after
    // the final external fence, including tests that replace it at that window.
    let (again, current, current_id) = read_with_identity(&source)?;
    verify_paths()?;
    if again != record || current != bytes || current_id != id {
        return Err(refused());
    }
    validate(&again, &selected, paths.canonical_home)?;
    rename_exclusive(&source, &target)?;
    sync_directory(paths.history, parents[1])?;
    sync_directory(paths.directory, parents[0])?;
    let (retained, retained_bytes, retained_id) = read_with_identity(&target)?;
    verify_paths()?;
    if retained != record || retained_bytes != bytes || retained_id != id || !absent(&source)? {
        return Err(refused());
    }
    validate(&retained, &selected, paths.canonical_home)?;
    verify()?;
    verify_paths()?;
    let (again, current, current_id) = read_with_identity(&target)?;
    if again != record || current != bytes || current_id != id || !absent(&source)? {
        return Err(refused());
    }
    validate(&again, &selected, paths.canonical_home)
}

/// Caller holds the provider and retired-publisher locks and supplies an exact
/// current ACK fence. No socket, graph receipt, named data or sibling is changed.
pub(in crate::provider::graph) fn archive_acknowledged(
    candidate: &Candidate,
    receipt: &Receipt,
    boot: &str,
    process: &ProcessIdentity,
    expected: &str,
    verify: &dyn Fn() -> Result<(), CandidateError>,
) -> Result<(), CandidateError> {
    let owner = state::Owner::load(candidate)?;
    if receipt.phase != "stopped-data-retained" || receipt.owner != owner.token {
        return Err(refused());
    }
    let directory = root(candidate);
    let history = super::super::directory(candidate, &receipt.run)?;
    let canonical_home = candidate.state_root.join("run/smolvm/home");
    let slots = receipt
        .relay_startup
        .as_ref()
        .ok_or_else(refused)?
        .services
        .values()
        .flat_map(|service| service.bindings.values().map(|binding| binding.slot))
        .collect();
    archive(
        Paths {
            directory: &directory,
            home: &owner.short_home,
            canonical_home: &canonical_home,
            history: &history,
        },
        Selection {
            owner: &owner.token,
            run: &receipt.run,
            boot,
            process,
            slots,
            expected,
            capacity: owner.dependency_sockets.ok_or_else(refused)?.slots,
        },
        verify,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::Cell, os::unix::fs::PermissionsExt, process::Command};

    struct Fixture {
        _root: super::super::super::tests::Fixture,
        directory: PathBuf,
        home: PathBuf,
        canonical_home: PathBuf,
        history: PathBuf,
        record: Record,
        expected: String,
    }
    impl Fixture {
        fn new() -> Self {
            let root = super::super::super::tests::Fixture::new();
            let directory = root.0.join("assignments");
            let canonical_home = root.0.join("home");
            let home = PathBuf::from(format!(
                "/private/tmp/hkdr-{}",
                &format!(
                    "{:x}",
                    Sha256::digest(root.0.as_os_str().as_encoded_bytes())
                )[..16]
            ));
            let history = root.0.join("graph");
            for path in [&directory, &canonical_home, &history] {
                state::private_directory(path).unwrap();
            }
            std::os::unix::fs::symlink(&canonical_home, &home).unwrap();
            let mut child = Command::new("/bin/sleep").arg("30").spawn().unwrap();
            let process = identity::observe(child.id() as i32).unwrap();
            child.kill().unwrap();
            child.wait().unwrap();
            let record = Record {
                version: 1,
                owner: "a".repeat(32),
                boot: "b".repeat(36),
                run: "1".repeat(32),
                token: "c".repeat(32),
                process,
                slots: BTreeMap::from([(0, 0)]),
                sockets: BTreeMap::from([(0, (1, 2))]),
            };
            state::write(&directory.join(format!("{}.json", record.run)), &record).unwrap();
            let expected = fingerprint(&record).unwrap();
            Self {
                _root: root,
                directory,
                home,
                canonical_home,
                history,
                record,
                expected,
            }
        }
        fn source(&self) -> PathBuf {
            self.directory.join(format!("{}.json", self.record.run))
        }
        fn target(&self) -> PathBuf {
            self.history.join(format!(
                "dependency-reservation-retired-{}.json",
                self.expected
            ))
        }
        fn archive(
            &self,
            verify: &dyn Fn() -> Result<(), CandidateError>,
        ) -> Result<(), CandidateError> {
            archive(
                Paths {
                    directory: &self.directory,
                    home: &self.home,
                    canonical_home: &self.canonical_home,
                    history: &self.history,
                },
                Selection {
                    owner: &self.record.owner,
                    run: &self.record.run,
                    boot: &self.record.boot,
                    process: &self.record.process,
                    slots: BTreeSet::from([0]),
                    expected: &self.expected,
                    capacity: 2,
                },
                verify,
            )
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_file(&self.home).unwrap();
        }
    }

    #[test]
    fn exact_dead_claim_is_retained_with_same_bytes_inode_and_sibling() {
        let fixture = Fixture::new();
        let before = fs::read(fixture.source()).unwrap();
        let m = fs::symlink_metadata(fixture.source()).unwrap();
        let mut sibling = fixture.record.clone();
        sibling.run = "2".repeat(32);
        sibling.slots = BTreeMap::from([(0, 1)]);
        sibling.sockets = BTreeMap::from([(1, (1, 3))]);
        let path = fixture.directory.join(format!("{}.json", sibling.run));
        state::write(&path, &sibling).unwrap();
        let sibling_before = fs::read(&path).unwrap();
        fixture.archive(&|| Ok(())).unwrap();
        assert!(!fixture.source().exists());
        assert_eq!(fs::read(fixture.target()).unwrap(), before);
        let retained = fs::symlink_metadata(fixture.target()).unwrap();
        assert_eq!((retained.dev(), retained.ino()), (m.dev(), m.ino()));
        assert_eq!(fs::read(path).unwrap(), sibling_before);
        fixture.archive(&|| Ok(())).unwrap();
    }

    #[test]
    fn mismatched_process_boot_slots_and_live_owner_refuse() {
        let fixture = Fixture::new();
        let base = &fixture.record;
        let selected = Selection {
            owner: &base.owner,
            run: &base.run,
            boot: &base.boot,
            process: &base.process,
            slots: BTreeSet::from([0]),
            expected: &fixture.expected,
            capacity: 2,
        };
        for change in ["process", "boot", "slots", "run", "token", "live"] {
            let mut changed = base.clone();
            match change {
                "process" => changed.process.start_micros += 1,
                "boot" => changed.boot = "d".repeat(36),
                "slots" => changed.slots.insert(0, 1).map(|_| ()).unwrap(),
                "run" => changed.run = "9".repeat(32),
                "token" => changed.token = "9".repeat(32),
                "live" => changed.process = identity::observe(std::process::id() as i32).unwrap(),
                _ => unreachable!(),
            }
            assert!(
                validate(&changed, &selected, &fixture.home).is_err(),
                "{change}"
            );
        }
        let live = identity::observe(std::process::id() as i32).unwrap();
        let mut changed = base.clone();
        changed.process = live.clone();
        let expected = fingerprint(&changed).unwrap();
        let live_selection = Selection {
            process: &live,
            expected: &expected,
            ..selected
        };
        assert!(validate(&changed, &live_selection, &fixture.home).is_err());
        assert!(fixture.source().exists());
    }

    #[test]
    fn every_socket_pending_record_and_occupied_history_is_preserved() {
        use std::os::unix::net::UnixListener;
        for reason in ["socket", "pending", "history"] {
            let fixture = Fixture::new();
            let before = fs::read(fixture.source()).unwrap();
            let path = match reason {
                "socket" => socket(&fixture.home, 0),
                "pending" => fixture.source().with_extension("pending"),
                "history" => fixture.target(),
                _ => unreachable!(),
            };
            let listener = if reason == "socket" {
                Some(UnixListener::bind(&path).unwrap())
            } else {
                fs::write(&path, b"foreign or partial").unwrap();
                fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
                None
            };
            let id = fs::symlink_metadata(&path).unwrap();
            assert!(fixture.archive(&|| Ok(())).is_err(), "{reason}");
            assert_eq!(fs::read(fixture.source()).unwrap(), before);
            let after = fs::symlink_metadata(path).unwrap();
            assert_eq!((id.dev(), id.ino()), (after.dev(), after.ino()));
            drop(listener);
        }
    }

    #[test]
    fn failed_fences_preserve_claim_or_allow_exact_post_move_retry() {
        for fault in 1..=4 {
            let fixture = Fixture::new();
            let before = fs::read(fixture.source()).unwrap();
            let calls = Cell::new(0);
            assert!(
                fixture
                    .archive(&|| {
                        calls.set(calls.get() + 1);
                        if calls.get() == fault {
                            Err(refused())
                        } else {
                            Ok(())
                        }
                    })
                    .is_err(),
                "fence {fault}"
            );
            if fault < 4 {
                assert_eq!(fs::read(fixture.source()).unwrap(), before);
                assert!(!fixture.target().exists());
            } else {
                assert!(!fixture.source().exists());
                assert_eq!(fs::read(fixture.target()).unwrap(), before);
            }
            fixture.archive(&|| Ok(())).unwrap();
            assert_eq!(fs::read(fixture.target()).unwrap(), before);
        }
    }

    #[test]
    fn same_bytes_replacement_and_late_history_collision_refuse() {
        for replacement in ["source", "history", "socket"] {
            let fixture = Fixture::new();
            let before = fs::read(fixture.source()).unwrap();
            let calls = Cell::new(0);
            let displaced = fixture.history.join("displaced.json");
            assert!(
                fixture
                    .archive(&|| {
                        calls.set(calls.get() + 1);
                        if calls.get() == 3 {
                            match replacement {
                                "source" => {
                                    fs::rename(fixture.source(), &displaced).unwrap();
                                    fs::write(fixture.source(), &before).unwrap();
                                    fs::set_permissions(
                                        fixture.source(),
                                        fs::Permissions::from_mode(0o600),
                                    )
                                    .unwrap();
                                }
                                "history" => {
                                    fs::write(fixture.target(), b"foreign").unwrap();
                                }
                                "socket" => {
                                    fs::write(socket(&fixture.home, 0), b"foreign").unwrap();
                                }
                                _ => unreachable!(),
                            }
                        }
                        Ok(())
                    })
                    .is_err(),
                "{replacement}"
            );
            assert_eq!(fs::read(fixture.source()).unwrap(), before);
            if replacement == "history" {
                assert_eq!(fs::read(fixture.target()).unwrap(), b"foreign");
            }
            if replacement == "source" {
                assert_eq!(fs::read(displaced).unwrap(), before);
            }
            if replacement == "socket" {
                assert_eq!(fs::read(socket(&fixture.home, 0)).unwrap(), b"foreign");
            }
        }
    }

    #[test]
    fn alias_home_and_reservation_parent_replacement_refuse_before_release() {
        for replacement in ["alias", "home", "assignments", "history"] {
            let fixture = Fixture::new();
            let before = fs::read(fixture.source()).unwrap();
            let calls = Cell::new(0);
            let displaced = fixture._root.0.join("displaced");
            assert!(
                fixture
                    .archive(&|| {
                        calls.set(calls.get() + 1);
                        if calls.get() == 3 {
                            match replacement {
                                "alias" => {
                                    fs::rename(&fixture.home, &displaced).unwrap();
                                    std::os::unix::fs::symlink(
                                        &fixture.canonical_home,
                                        &fixture.home,
                                    )
                                    .unwrap();
                                }
                                "home" => {
                                    fs::rename(&fixture.canonical_home, &displaced).unwrap();
                                    state::private_directory(&fixture.canonical_home).unwrap();
                                }
                                "assignments" => {
                                    fs::rename(&fixture.directory, &displaced).unwrap();
                                    state::private_directory(&fixture.directory).unwrap();
                                    fs::write(fixture.source(), &before).unwrap();
                                    fs::set_permissions(
                                        fixture.source(),
                                        fs::Permissions::from_mode(0o600),
                                    )
                                    .unwrap();
                                }
                                "history" => {
                                    fs::rename(&fixture.history, &displaced).unwrap();
                                    state::private_directory(&fixture.history).unwrap();
                                }
                                _ => unreachable!(),
                            }
                        }
                        Ok(())
                    })
                    .is_err(),
                "{replacement}"
            );
            assert_eq!(fs::read(fixture.source()).unwrap(), before);
            assert!(!fixture.target().exists());
        }
    }

    #[test]
    fn retry_and_final_success_recheck_retained_record_after_external_fence() {
        for retry in [false, true] {
            let fixture = Fixture::new();
            let before = fs::read(fixture.source()).unwrap();
            if retry {
                fixture.archive(&|| Ok(())).unwrap();
            }
            let calls = Cell::new(0);
            let displaced = fixture.history.join("original.json");
            assert!(
                fixture
                    .archive(&|| {
                        calls.set(calls.get() + 1);
                        if calls.get() == if retry { 2 } else { 4 } {
                            fs::rename(fixture.target(), &displaced).unwrap();
                            fs::write(fixture.target(), &before).unwrap();
                            fs::set_permissions(
                                fixture.target(),
                                fs::Permissions::from_mode(0o600),
                            )
                            .unwrap();
                        }
                        Ok(())
                    })
                    .is_err(),
                "retry={retry}"
            );
            assert_eq!(fs::read(fixture.target()).unwrap(), before);
            assert_eq!(fs::read(displaced).unwrap(), before);
            assert!(!fixture.source().exists());
        }
    }
}
