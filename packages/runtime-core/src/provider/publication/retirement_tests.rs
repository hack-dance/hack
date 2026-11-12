//! Portable registry-commit regressions; all writes stay in the owned temp checkout.
use super::*;
use std::{
    cell::Cell,
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT: AtomicU64 = AtomicU64::new(0);

#[test]
fn legacy_entry_has_no_exit_proof_and_changed_proof_is_rejected() {
    let fixture = Fixture::new();
    let mut entry = fixture.entry.clone();
    let legacy = serde_json::to_value(&entry).unwrap();
    assert!(legacy.get("reaped").is_none());
    assert!(
        serde_json::from_value::<Entry>(legacy)
            .unwrap()
            .reaped
            .is_none()
    );
    entry.reaped = Some(entry.process.clone());
    assert!(entry_gone(&entry).unwrap());
    entry.reaped.as_mut().unwrap().start_micros += 1;
    let entries = BTreeMap::from([(entry.reservation.clone(), entry.clone())]);
    assert!(validate(&entries, &entry.owner).is_err());
}

struct Fixture {
    candidate: Candidate,
    entry: Entry,
}
impl Fixture {
    fn new() -> Self {
        let serial = NEXT.fetch_add(1, Ordering::Relaxed);
        let base = std::env::temp_dir().join(format!(
            "publication-retirement-{}-{serial}",
            std::process::id()
        ));
        fs::DirBuilder::new().mode(0o700).create(&base).unwrap();
        let candidate = Candidate::discover(&base).unwrap();
        let mut child = Command::new("/bin/sleep").arg("30").spawn().unwrap();
        let pid = child.id() as i32;
        child.kill().unwrap();
        child.wait().unwrap();
        // Registry reconciliation requires observed PID absence, not a live
        // native birth lookup. Synthetic immutable fields keep this portable;
        // macOS publisher-stop and VM tests qualify native identity proofs.
        let process = identity::ProcessIdentity {
            pid,
            start_micros: 1,
            // SAFETY: geteuid takes no arguments and has no preconditions.
            uid: unsafe { libc::geteuid() },
            executable: PathBuf::new(),
        };
        let mut entry = Entry {
            owner: "a".repeat(32),
            run: "b".repeat(32),
            reservation: format!("{:016x}{serial:016x}", std::process::id()),
            slot: 0,
            port: 3000,
            unix: false,
            hostnames: vec![],
            token: "c".repeat(32),
            process,
            digest: "d".repeat(64),
            directory: None,
            binary: None,
            reaped: None,
        };
        entry.process.executable = directory(&entry).join("publisher");
        assert!(!directory(&entry).exists());
        Self { candidate, entry }
    }

    fn interrupt(&self, before: &BTreeMap<String, Entry>, after: &BTreeMap<String, Entry>) {
        save(&self.candidate, before).unwrap();
        // Exercise the production writer through its sync, then interrupt before
        // rename. The committed registry still records the already retired entry.
        assert!(save_before_rename(&self.candidate, after, &|| Err(error())).is_err());
        assert!(load(&self.candidate, &self.entry.owner).is_err());
        assert!(root(&self.candidate).join("state.pending").exists());
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.candidate.checkout).unwrap();
    }
}

#[test]
fn retirement_resumes_synced_removal_before_loading_and_preserves_other_runs() {
    let fixture = Fixture::new();
    let entry = &fixture.entry;
    let mut other = entry.clone();
    other.run = "e".repeat(32);
    other.reservation = "f".repeat(32);
    other.slot = 1;
    other.port = 3001;
    other.process.executable = directory(&other).join("publisher");
    let before = BTreeMap::from([
        (entry.reservation.clone(), entry.clone()),
        (other.reservation.clone(), other.clone()),
    ]);
    let after = BTreeMap::from([(other.reservation.clone(), other)]);
    fixture.interrupt(&before, &after);
    let calls = Cell::new(0);
    let recovered = retirement_entries(&fixture.candidate, &entry.owner, &|| {
        calls.set(calls.get() + 1);
        Ok(())
    })
    .unwrap();
    assert!(recovered == after);
    assert_eq!(calls.get(), 3);
    assert!(!root(&fixture.candidate).join("state.pending").exists());
    assert!(load(&fixture.candidate, &entry.owner).unwrap() == after);
}

#[test]
fn retirement_reconciliation_retains_both_journals_when_effect_fence_refuses() {
    for refusal_at in [1, 2] {
        let fixture = Fixture::new();
        let entry = &fixture.entry;
        let before = BTreeMap::from([(entry.reservation.clone(), entry.clone())]);
        fixture.interrupt(&before, &BTreeMap::new());
        let registry = root(&fixture.candidate);
        let committed = fs::read(registry.join("state.json")).unwrap();
        let pending = fs::read(registry.join("state.pending")).unwrap();
        let calls = Cell::new(0);
        assert!(
            retirement_entries(&fixture.candidate, &entry.owner, &|| {
                calls.set(calls.get() + 1);
                if calls.get() == refusal_at {
                    Err(CandidateError::new(
                        "recovery_fence_changed",
                        "Evidence changed.",
                    ))
                } else {
                    Ok(())
                }
            })
            .is_err()
        );
        assert_eq!(fs::read(registry.join("state.json")).unwrap(), committed);
        assert_eq!(fs::read(registry.join("state.pending")).unwrap(), pending);
    }
}

#[test]
fn retirement_reconciliation_refuses_live_process_changed_entry_and_malformed_pending() {
    for variant in ["live", "changed", "malformed"] {
        let mut fixture = Fixture::new();
        if variant == "live" {
            fixture.entry.process.pid = std::process::id() as i32;
        }
        let entry = &fixture.entry;
        let before = BTreeMap::from([(entry.reservation.clone(), entry.clone())]);
        let mut after = BTreeMap::new();
        if variant == "changed" {
            let mut changed = entry.clone();
            changed.token = "e".repeat(32);
            after.insert(changed.reservation.clone(), changed);
        }
        fixture.interrupt(&before, &after);
        let registry = root(&fixture.candidate);
        if variant == "malformed" {
            fs::write(registry.join("state.pending"), b"partial").unwrap();
        }
        let committed = fs::read(registry.join("state.json")).unwrap();
        let pending = fs::read(registry.join("state.pending")).unwrap();
        assert!(retirement_entries(&fixture.candidate, &entry.owner, &|| Ok(())).is_err());
        assert_eq!(fs::read(registry.join("state.json")).unwrap(), committed);
        assert_eq!(fs::read(registry.join("state.pending")).unwrap(), pending);
    }
}

#[test]
fn next13_writer_registry_keeps_exact_legacy_shape_without_reaped_authority() {
    let fixture = Fixture::new();
    let mut entries: BTreeMap<String, Entry> = serde_json::from_str(include_str!(
        "../../../../../tests/fixtures/native-next13/publishers.json"
    ))
    .unwrap();
    let entry = entries.values_mut().next().unwrap();
    assert!(entry.reaped.is_none());
    entry.process = fixture.entry.process.clone();
    entry.directory = None;
    entry.binary = None;
    // Volatile executable scope follows the old record's reservation.
    entry.process.executable = directory(entry).join("publisher");
    let owner = entry.owner.clone();
    validate(&entries, &owner).unwrap();
    save(&fixture.candidate, &entries).unwrap();
    assert!(
        load(&fixture.candidate, &owner)
            .unwrap()
            .values()
            .all(|entry| entry.reaped.is_none())
    );
}

#[test]
fn live_publisher_probe_does_not_wait_for_another_process_provider_lease() {
    use std::io::{BufRead, BufReader};
    use std::process::Stdio;
    let fixture = Fixture::new();
    let mut holder = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "provider::publication::retirement_tests::lease_holder_probe",
            "--nocapture",
        ])
        .env("HACK_PUBLISHER_LEASE_PROBE", &fixture.candidate.state_root)
        .env("HOME", &fixture.candidate.checkout)
        .env("XDG_CONFIG_HOME", &fixture.candidate.checkout)
        .env("XDG_CACHE_HOME", &fixture.candidate.checkout)
        .env("XDG_STATE_HOME", &fixture.candidate.checkout)
        .env("HACK_DAEMON_AUTOSTART_DISABLE", "1")
        .env("HACK_NO_INTERACTIVE", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let output = holder.stdout.take().unwrap();
    let mut reader = BufReader::new(output);
    let mut line = String::new();
    loop {
        assert!(reader.read_line(&mut line).unwrap() > 0);
        if line.contains("lease-held") {
            break;
        }
        line.clear();
    }
    let mut live = Command::new("/bin/sleep").arg("30").spawn().unwrap();
    let start = std::time::Instant::now();
    let pending = child_exit_pending(&live);
    #[cfg(target_os = "macos")]
    let reap = reap_child(
        &fixture.candidate,
        &fixture.entry.owner,
        &fixture.entry.run,
        &fixture.entry.reservation,
        &mut live,
        &mut None,
    );
    let elapsed = start.elapsed();
    // Stop only these retained children, including on a failed assertion below.
    live.kill().unwrap();
    live.wait().unwrap();
    drop(holder.stdin.take());
    assert!(holder.wait().unwrap().success());
    assert!(!pending.unwrap());
    #[cfg(target_os = "macos")]
    assert!(reap.unwrap().is_none());
    assert!(elapsed < std::time::Duration::from_secs(1));
}

#[test]
fn lease_holder_probe() {
    let Some(root) = std::env::var_os("HACK_PUBLISHER_LEASE_PROBE") else {
        return;
    };
    let _lock = state::Lock::acquire(&PathBuf::from(root).join("run/smolvm")).unwrap();
    println!("lease-held");
    std::io::stdout().flush().unwrap();
    let mut poll = libc::pollfd {
        fd: 0,
        events: libc::POLLIN,
        revents: 0,
    };
    // SAFETY: valid writable poll entry. The parent owns stdin, and this helper
    // releases its lease after at most ten seconds even if the parent fails.
    assert!(unsafe { libc::poll(&mut poll, 1, 10_000) } > 0);
    std::io::stdin().read_to_end(&mut Vec::new()).unwrap();
}
