use super::*;
use crate::{
    project::native::{CompileOptions, ManagedValues},
    provider::{graph::native::configuration, native_input},
};
use serde_json::json;
use std::{
    os::unix::fs::{DirBuilderExt, PermissionsExt},
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};

const RUN: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const OWNER: &str = "cccccccccccccccccccccccccccccccc";
const BOOT: &str = "12345678-abcd-abcd-abcd-123456789abc";
struct Fixture {
    base: std::path::PathBuf,
    candidate: Candidate,
    root: std::path::PathBuf,
    receipt: Receipt,
}
impl Fixture {
    fn new() -> Self {
        Self::with_run(RUN)
    }
    fn with_run(run: &str) -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let base = fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!(
                "native-tool-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
        fs::DirBuilder::new().mode(0o700).create(&base).unwrap();
        let candidate = Candidate::discover(&base).unwrap();
        let request = serde_json::to_vec(&json!({"request_version":1,"project":json!({"schema_version":1,"name":"fixture","services":{"web":{"image":format!("sha256:{}","d".repeat(64))}}}).to_string(),"env_metadata":{"metadata_version":1,"overlay":null,"overlay_exists":false,"workloads":{"web":{}},"inactive_scopes":[]}})).unwrap();
        let namespace = "a".repeat(64);
        let scope = native_input::Scope {
            namespace: &namespace,
            run,
        };
        let review = native_input::review(&request, &[], scope).unwrap();
        let prepared = native_input::prepare(native_input::PrepareOptions {
            compile: CompileOptions {
                request: &request,
                profiles: &[],
                managed_values: &ManagedValues::new(),
            },
            scope,
            expected_review: &review,
            deadline: Instant::now() + Duration::from_secs(30),
        })
        .unwrap();
        let mut receipt =
            Receipt::preparing(&configuration(&prepared, OWNER).unwrap(), OWNER, BOOT).unwrap();
        let data_owner = "9".repeat(32);
        receipt.data.insert("database".into(), serde_json::from_value(json!({"binding":{"scope":{"namespace":namespace,"storage":"database","owner":data_owner},"guest":{"owner":OWNER,"boot_id":BOOT,"storage":{"device":0,"inode":21,"bytes":128,"uuid":"11111111-2222-3333-4444-555555555555"}},"policy":{"driver":"local","scope":"local","options":{}}},"state":{"status":"enrolled","volume":{"name":format!("hkp-{namespace}-{data_owner}-database"),"created_at":"2026-10-08T00:00:01Z","directory":{"device":0,"inode":42}}}})).unwrap());
        receipt.data_mounts.insert(
            "web".into(),
            vec![crate::project::native::StorageMount {
                storage: "database".into(),
                target: "/data".into(),
                read_only: false,
            }],
        );
        let mut value = serde_json::to_value(&receipt).unwrap();
        value["version"] = json!(4);
        value["data_tool"] = json!({"version":1,"artifact":"a".repeat(64),"bytes":8192,"root":{"device":0,"inode":1},"helper":{"device":0,"inode":2}});
        let receipt = serde_json::from_value(value).unwrap();
        let root = journal::reserve(&candidate, &receipt).unwrap();
        Self {
            base,
            candidate,
            root,
            receipt,
        }
    }
    fn issued(&self, port: &mut Fake) -> Installed {
        reopen_with(&self.candidate, &self.receipt, port).unwrap()
    }
    // Test-only representation of a future separate archival owner. Production
    // exposes no receipt withdrawal and cannot retire while Removed retains data.
    fn withdraw(&self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.base).unwrap();
    }
}
#[derive(Default)]
struct Fake {
    lifetime: guest_tool::Lifetime,
    checks: usize,
    reads: usize,
    removals: usize,
    invocations: usize,
    fail_check: Option<usize>,
    bad_identity: bool,
    inspect_error: bool,
    remove_error: bool,
    malformed_remove: bool,
    invoke_error: bool,
    removed: bool,
    during_inspect: Option<Box<dyn FnOnce()>>,
    during_check: Option<(usize, Box<dyn FnOnce()>)>,
}
impl Port for Fake {
    fn lifetime(&self) -> &guest_tool::Lifetime {
        &self.lifetime
    }
    fn check(&mut self, guest: &GuestIdentity) -> Result<(), CandidateError> {
        if guest.owner != OWNER || guest.boot_id != BOOT || guest.storage.inode != 21 {
            return Err(refused());
        }
        self.checks += 1;
        if self
            .during_check
            .as_ref()
            .is_some_and(|(at, _)| *at == self.checks)
        {
            let (_, change) = self.during_check.take().unwrap();
            change();
        }
        if self.fail_check == Some(self.checks) {
            Err(refused())
        } else {
            Ok(())
        }
    }
    fn inspect(&mut self, installed: &Installed) -> Result<String, CandidateError> {
        assert!(
            installed.run == RUN
                && installed.owner == OWNER
                && installed.reference.artifact == "a".repeat(64)
                && installed.reference.bytes == 8192
        );
        self.reads += 1;
        if let Some(change) = self.during_inspect.take() {
            change();
        }
        if self.inspect_error || self.removed {
            return Err(refused());
        }
        Ok(if self.bad_identity {
            "0:1:0:3\n"
        } else {
            "0:1:0:2\n"
        }
        .into())
    }
    fn remove(&mut self, _: &Installed) -> Result<String, CandidateError> {
        self.removals += 1;
        if self.remove_error {
            return Err(refused());
        }
        self.removed = true;
        Ok(if self.malformed_remove {
            "retired\n"
        } else {
            "0:1:0:2\nretired\n"
        }
        .into())
    }
    fn invoke(&mut self, _: &Installed, input: &str, seed: bool) -> Result<String, CandidateError> {
        self.invocations += 1;
        assert_eq!(
            helper::Request::parse(input.as_bytes()).unwrap().is_seed(),
            seed
        );
        if self.invoke_error {
            return Err(refused());
        }
        Ok(if seed { "seeded\n" } else { "verified\n" }.into())
    }
}
#[test]
fn saved_reopen_is_read_only_and_requires_complete_same_guest_reference() {
    let f = Fixture::new();
    let mut port = Fake::default();
    let installed = f.issued(&mut port);
    assert_eq!((port.reads, port.removals), (1, 0));
    verify(&installed, &mut port).unwrap();
    assert_eq!((port.reads, port.removals), (2, 0));
    for field in ["root", "helper"] {
        let mut receipt = f.receipt.clone();
        let mut value = serde_json::to_value(receipt.data_tool.as_ref().unwrap()).unwrap();
        value[field] = serde_json::Value::Null;
        receipt.data_tool = Some(serde_json::from_value(value).unwrap());
        assert!(reopen_with(&f.candidate, &receipt, &mut Fake::default()).is_err());
    }
    let mut foreign = f.receipt.clone();
    foreign.boot = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee".into();
    assert!(reopen_with(&f.candidate, &foreign, &mut Fake::default()).is_err());
}
#[test]
fn changed_or_unknown_guest_observation_never_issues_a_handle_or_effect() {
    let f = Fixture::new();
    for mut port in [
        Fake {
            bad_identity: true,
            ..Fake::default()
        },
        Fake {
            inspect_error: true,
            ..Fake::default()
        },
        Fake {
            fail_check: Some(2),
            ..Fake::default()
        },
    ] {
        assert!(reopen_with(&f.candidate, &f.receipt, &mut port).is_err());
        assert_eq!(port.removals, 0);
    }
}
#[test]
fn byte_identical_receipt_replacement_during_transport_refuses() {
    let f = Fixture::new();
    let path = f.root.join("state.json");
    let bytes = fs::read(&path).unwrap();
    let replacement = f.root.join("substitute");
    fs::write(&replacement, &bytes).unwrap();
    fs::set_permissions(&replacement, fs::Permissions::from_mode(0o600)).unwrap();
    let mut port = Fake {
        during_inspect: Some(Box::new(move || fs::rename(replacement, path).unwrap())),
        ..Fake::default()
    };
    assert!(reopen_with(&f.candidate, &f.receipt, &mut port).is_err());
    assert_eq!(port.removals, 0);
}
#[test]
fn changed_bytes_pending_and_replaced_parent_refuse_live_handle() {
    for change in 0..3 {
        let f = Fixture::new();
        let mut port = Fake::default();
        let installed = f.issued(&mut port);
        match change {
            0 => {
                let mut receipt = f.receipt.clone();
                receipt.phase = Phase::Stopped;
                journal::save(&f.root, &receipt).unwrap();
            }
            1 => fs::write(f.root.join("state.pending"), b"uncertain").unwrap(),
            _ => {
                fs::rename(&f.root, f.root.with_extension("old")).unwrap();
                fs::DirBuilder::new().mode(0o700).create(&f.root).unwrap();
                fs::copy(
                    f.root.with_extension("old").join("state.json"),
                    f.root.join("state.json"),
                )
                .unwrap();
            }
        }
        assert!(verify(&installed, &mut port).is_err());
        assert_eq!(port.reads, 1);
        assert_eq!(port.removals, 0);
    }
}
#[test]
fn every_saved_phase_including_removed_keeps_its_data_verifier() {
    for phase in [
        Phase::Preparing,
        Phase::ReadyObserved,
        Phase::FailedRetained,
        Phase::StopIntent,
        Phase::Stopped,
        Phase::RemovalIntent,
        Phase::Removed,
    ] {
        let mut f = Fixture::new();
        f.receipt.phase = phase.clone();
        if phase == Phase::Removed {
            for resource in f.receipt.resources.values_mut() {
                resource.phase = "removed".into();
            }
        } else if phase == Phase::ReadyObserved {
            for (index, resource) in f.receipt.resources.values_mut().enumerate() {
                resource.id = Some(format!("{index:064x}"));
                resource.phase = if resource.kind == crate::provider::graph::Kind::Network {
                    "created"
                } else {
                    "started"
                }
                .into();
            }
        }
        journal::save(&f.root, &f.receipt).unwrap();
        let mut port = Fake::default();
        let installed = f.issued(&mut port);
        assert!(retire_with(installed, &f.candidate, &mut port).is_err());
        assert_eq!((port.reads, port.removals), (1, 0));
        assert!(f.root.join("state.json").exists());
    }
}
#[test]
fn consumed_retirement_uses_exact_identity_once_only_after_dependency_withdrawal() {
    let f = Fixture::new();
    let mut port = Fake::default();
    let installed = f.issued(&mut port);
    f.withdraw();
    retire_with(installed, &f.candidate, &mut port).unwrap();
    assert_eq!((port.reads, port.removals), (2, 1));
    assert!(reopen_with(&f.candidate, &f.receipt, &mut port).is_err());
}
#[test]
fn unknown_or_malformed_removal_has_no_followup_probe_or_retry() {
    for malformed in [false, true] {
        let f = Fixture::new();
        let mut port = Fake::default();
        let installed = f.issued(&mut port);
        f.withdraw();
        port.remove_error = !malformed;
        port.malformed_remove = malformed;
        let before = port.checks;
        assert!(retire_with(installed, &f.candidate, &mut port).is_err());
        assert_eq!((port.checks - before, port.reads, port.removals), (3, 2, 1));
        assert!(reopen_with(&f.candidate, &f.receipt, &mut port).is_err());
    }
}
#[test]
fn final_revocation_and_new_dependency_before_removal_refuse_without_effect() {
    let f = Fixture::new();
    let mut port = Fake::default();
    let installed = f.issued(&mut port);
    f.withdraw();
    port.fail_check = Some(port.checks + 3);
    assert!(retire_with(installed, &f.candidate, &mut port).is_err());
    assert_eq!(port.removals, 0);
    let f = Fixture::new();
    let mut port = Fake::default();
    let installed = f.issued(&mut port);
    f.withdraw();
    let root = f.root.clone();
    let receipt = f.receipt.clone();
    port.during_inspect = Some(Box::new(move || {
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        journal::save(&root, &receipt).unwrap();
    }));
    assert!(retire_with(installed, &f.candidate, &mut port).is_err());
    assert_eq!(port.removals, 0);
}

#[test]
fn final_freshness_callback_cannot_replace_receipt_or_add_retirement_dependency() {
    let f = Fixture::new();
    let pending = f.root.join("state.pending");
    let mut port = Fake {
        during_check: Some((
            3,
            Box::new(move || fs::write(pending, b"uncertain").unwrap()),
        )),
        ..Fake::default()
    };
    assert!(reopen_with(&f.candidate, &f.receipt, &mut port).is_err());
    assert_eq!((port.reads, port.removals), (1, 0));

    let f = Fixture::new();
    let mut port = Fake::default();
    let installed = f.issued(&mut port);
    f.withdraw();
    let root = f.root.clone();
    let receipt = f.receipt.clone();
    port.during_check = Some((
        port.checks + 3,
        Box::new(move || {
            fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
            journal::save(&root, &receipt).unwrap();
        }),
    ));
    assert!(retire_with(installed, &f.candidate, &mut port).is_err());
    assert_eq!(port.removals, 0);
}

#[test]
fn other_graph_alias_and_unknown_inventory_refuse_but_unrelated_helper_is_retained() {
    for case in 0..3 {
        let f = Fixture::new();
        let mut port = Fake::default();
        let installed = f.issued(&mut port);
        f.withdraw();
        let mut other = Fixture::with_run("dddddddddddddddddddddddddddddddd");
        if case == 1 {
            fs::DirBuilder::new()
                .mode(0o700)
                .create(f.root.parent().unwrap().join("unknown"))
                .unwrap();
        }
        if case == 2 {
            let reference = other.receipt.data_tool.as_mut().unwrap();
            reference.root.as_mut().unwrap().inode = 3;
            reference.helper.as_mut().unwrap().inode = 4;
        }
        let other_root = journal::reserve(&f.candidate, &other.receipt).unwrap();
        let result = retire_with(installed, &f.candidate, &mut port);
        assert_eq!(result.is_ok(), case == 2);
        assert_eq!(port.removals, usize::from(case == 2));
        assert!(other_root.join("state.json").exists());
    }
}

#[test]
fn changed_guest_disk_and_second_issued_handle_cannot_authorize_retirement() {
    let mut f = Fixture::new();
    let mut data = serde_json::to_value(&f.receipt.data["database"]).unwrap();
    data["binding"]["guest"]["storage"]["inode"] = json!(22);
    f.receipt
        .data
        .insert("database".into(), serde_json::from_value(data).unwrap());
    journal::save(&f.root, &f.receipt).unwrap();
    let mut port = Fake::default();
    assert!(reopen_with(&f.candidate, &f.receipt, &mut port).is_err());
    assert_eq!((port.reads, port.removals), (0, 0));

    let f = Fixture::new();
    let mut port = Fake::default();
    let first = f.issued(&mut port);
    let second = f.issued(&mut port);
    f.withdraw();
    retire_with(first, &f.candidate, &mut port).unwrap();
    assert!(retire_with(second, &f.candidate, &mut port).is_err());
    assert_eq!(port.removals, 1);
}

fn request(seed: bool) -> helper::Request {
    helper::Request::bound(
        &format!("hkp-{}-{}-database", "a".repeat(64), "9".repeat(32)),
        seed,
        helper::Root {
            device: 0,
            inode: 42,
            uid: 0,
            gid: 0,
        },
        &format!("user.hack.storage.{}", "d".repeat(64)),
        &"e".repeat(64),
    )
    .unwrap()
}
#[test]
fn last_invoke_callback_cannot_change_saved_admission_before_read_or_seed() {
    for seed in [false, true] {
        let f = Fixture::new();
        let mut port = Fake::default();
        let installed = f.issued(&mut port);
        invoke(&installed, &mut port, request(seed)).unwrap();
        assert_eq!(port.invocations, 1);
        let pending = f.root.join("state.pending");
        port.during_check = Some((
            port.checks + 4,
            Box::new(move || fs::write(pending, b"uncertain").unwrap()),
        ));
        assert!(invoke(&installed, &mut port, request(seed)).is_err());
        assert_eq!(port.invocations, 1);
    }
}
#[test]
fn ambiguous_retirement_without_guest_deletion_revokes_every_preissued_handle() {
    let f = Fixture::new();
    let mut port = Fake::default();
    let first = f.issued(&mut port);
    let second = f.issued(&mut port);
    f.withdraw();
    port.remove_error = true;
    assert!(retire_with(first, &f.candidate, &mut port).is_err());
    assert!(!port.removed); // exact reviewer counterexample: files never disappeared
    let reads = port.reads;
    assert!(retire_with(second, &f.candidate, &mut port).is_err());
    assert_eq!((port.reads, port.removals), (reads, 1));
}
#[test]
fn foreign_provider_lease_and_unknown_invocation_never_gain_late_admission() {
    let f = Fixture::new();
    let mut original = Fake::default();
    let installed = f.issued(&mut original);
    let mut foreign = Fake::default();
    assert!(verify(&installed, &mut foreign).is_err());
    assert!(invoke(&installed, &mut foreign, request(true)).is_err());
    assert_eq!(
        (foreign.reads, foreign.invocations, foreign.removals),
        (0, 0, 0)
    );
    original.invoke_error = true;
    let reads = original.reads;
    assert!(invoke(&installed, &mut original, request(true)).is_err());
    assert_eq!((original.reads, original.invocations), (reads + 1, 1));
    assert!(verify(&installed, &mut original).is_err());
    assert_eq!(original.reads, reads + 1);
    f.withdraw();
    assert!(retire_with(installed, &f.candidate, &mut foreign).is_err());
    assert_eq!((foreign.reads, foreign.removals), (0, 0));
}

#[test]
fn active_transport_use_prevents_retirement_and_uncertainty_revokes_the_run() {
    let f = Fixture::new();
    let mut port = Fake::default();
    let first = f.issued(&mut port);
    let second = f.issued(&mut port);
    let active = first.lifetime.enter(port.lifetime(), RUN).unwrap();
    f.withdraw();
    assert!(retire_with(first, &f.candidate, &mut port).is_err());
    assert_eq!(port.removals, 0);
    active.complete();
    retire_with(second, &f.candidate, &mut port).unwrap();
    assert_eq!(port.removals, 1);

    let uncertain = guest_tool::Lifetime::default();
    drop(uncertain.enter(&uncertain, RUN).unwrap());
    assert!(uncertain.check(&uncertain, RUN).is_err());
    assert!(uncertain.retire(&uncertain, RUN).is_err());
}

#[test]
fn lease_binds_one_run_before_transport_without_a_cross_lease_run_budget() {
    let f = Fixture::new();
    let other = Fixture::with_run("eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");
    let mut port = Fake::default();
    let first = f.issued(&mut port);
    let reads = port.reads;
    assert!(reopen_with(&other.candidate, &other.receipt, &mut port).is_err());
    assert_eq!((port.reads, port.invocations, port.removals), (reads, 0, 0));
    // A completed use does not clear the binding. Its original sibling remains
    // usable even after a different run was refused on the same lease.
    verify(&first, &mut port).unwrap();
    f.issued(&mut port);
    assert!(
        port.lifetime
            .check(port.lifetime(), other.receipt.review.scope().run)
            .is_err()
    );
    assert!(
        port.lifetime
            .retire(port.lifetime(), other.receipt.review.scope().run)
            .is_err()
    );
    verify(&first, &mut port).unwrap();

    let original = guest_tool::Lifetime::default();
    original.check(&original, RUN).unwrap(); // installation admission also binds
    assert!(
        original
            .enter(&original, other.receipt.review.scope().run)
            .is_err()
    );
    original.enter(&original, RUN).unwrap().complete();
    original.retire(&original, RUN).unwrap();
    assert!(original.check(&original, RUN).is_err());
    assert!(
        original
            .check(&original, other.receipt.review.scope().run)
            .is_err()
    );
    // Independent operation leases have independent authority; retiring more
    // than the removed map ceiling cannot exhaust a process-wide run budget.
    for index in 0..128 {
        let lifetime = guest_tool::Lifetime::default();
        let run = format!("{index:032x}");
        lifetime.check(&lifetime, &run).unwrap();
        lifetime.enter(&lifetime, &run).unwrap().complete();
        lifetime.retire(&lifetime, &run).unwrap();
        assert!(lifetime.enter(&lifetime, &run).is_err());
    }
}
