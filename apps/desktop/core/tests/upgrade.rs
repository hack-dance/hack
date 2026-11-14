use hack_desktop_core::{upgrade::*, upgrade_fixtures as fixtures};

#[test]
fn done_requires_all_fresh_evidence_and_explicit_previous_steps() {
    let good = fixtures::load("done").unwrap();
    assert!(good.done());
    for kind in 0..13 {
        let mut flow = good.clone();
        let report = flow.observation.report.as_mut().unwrap();
        match kind {
            0 => flow.observation.cli = None,
            1 => flow.observation.app = Some("5.0.0".into()),
            2 => flow.observation.daemon = Some("5.0.0".into()),
            3 => report.ready = false,
            4 => report.plan = fixtures::report().plan,
            5 => report.projects.clear(),
            6 => report.projects[0].findings.clear(),
            7 => report.projects[0].state = "unreadable".into(),
            8 => report.incomplete.push(ScopedFinding {
                scope: "sample".into(),
                id: "env-format".into(),
                summary: "not checked".into(),
            }),
            9 => report.registry.unchecked.push(RegistryEntry {
                name: "sample".into(),
                root: "/example/project".into(),
            }),
            10 => report.projects[0].root = "/example/other".into(),
            11 => report.projects[0].findings[0].status = "info".into(),
            12 => flow.observation.cli_program = "/other/hack".into(),
            _ => unreachable!(),
        }
        assert!(!flow.done(), "invalid evidence case {kind}");
    }
}
#[test]
fn snapshots_refused_incomplete_or_invalid_cannot_authorize_any_effect() {
    for kind in 0..8 {
        let mut flow = fixtures::load("ready").unwrap();
        let s = flow.snapshot.as_mut().unwrap();
        match kind {
            0 => s.status = "refused".into(),
            1 => s.complete = Some(false),
            2 => s.complete = None,
            3 => s.gaps = None,
            4 => {
                s.gaps = Some(vec![Gap {
                    name: "sample".into(),
                    reason: "unchecked".into(),
                }])
            }
            5 => s.manifest_path = Some("relative/manifest.json".into()),
            6 => s.manifest_path = Some("/example/other/manifest.json".into()),
            7 => s.manifest_path = Some("/example/../example-snapshot/manifest.json".into()),
            _ => unreachable!(),
        }
        assert!(!flow.can_upgrade());
        assert!(!flow.can_rollback());
    }
}
#[test]
fn unknown_discovery_allows_readiness_but_never_upgrade() {
    let mut flow = fixtures::load("availability-unknown").unwrap();
    assert!(flow.can_snapshot());
    assert!(!flow.can_upgrade());
    flow.saved(fixtures::snapshot());
    assert!(!flow.can_upgrade());
    flow.target = fixtures::load("ready").unwrap().target;
    assert!(flow.can_upgrade());
    flow.handed_off();
    assert_eq!(flow.state, State::Applying);
    assert!(!flow.done());
    let observation = flow.observation.clone();
    flow.checked(observation);
    assert_eq!(flow.state, State::Unknown);
}
#[test]
fn rollback_restores_files_only_and_clears_readiness() {
    let mut flow = fixtures::load("ready").unwrap();
    flow.rolled_back(Rollback {
        status: "incomplete".into(),
        results: vec![RestoredFile {
            path: "/example/file".into(),
            status: "conflict".into(),
            kept_as: Some("/example/file.kept".into()),
            message: Some("File changed".into()),
        }],
        message: None,
    });
    assert_eq!(flow.state, State::Failed);
    assert!(!flow.can_upgrade());
    assert_eq!(
        flow.rollback.unwrap().results[0].kept_as.as_deref(),
        Some("/example/file.kept")
    );
}
#[test]
fn authored_homebrew_sequence_and_quoted_untrusted_display() {
    let commands = homebrew_commands();
    assert_eq!(commands[0].display().unwrap(), "'brew' 'upgrade' 'hack'");
    assert_eq!(
        commands[1].display().unwrap(),
        "'brew' 'upgrade' '--cask' 'hack-desktop'"
    );
    assert_eq!(
        display_step("/example/hack", &["$(touch nope);'".into()]).unwrap(),
        "'/example/hack' '$(touch nope);'\\'''"
    );
}
#[test]
fn each_fixture_is_offline_and_busy_is_singleflight() {
    for name in fixtures::NAMES {
        let mut flow = fixtures::load(name).unwrap();
        flow.busy = false;
        assert!(flow.begin(State::Checking));
        assert!(!flow.begin(State::Snapshotting));
        assert!(!flow.can_upgrade());
        assert!(!flow.can_rollback());
    }
}

#[test]
fn pure_effect_admission_rejects_unknown_target_and_incomplete_snapshot() {
    let mut unknown = fixtures::load("availability-unknown").unwrap();
    assert!(!unknown.begin(State::Applying));
    assert!(!unknown.begin(State::RollingBack));
    assert!(!unknown.begin(State::Restarting));
    assert!(unknown.begin(State::Snapshotting));
    let mut incomplete = fixtures::load("incomplete").unwrap();
    assert!(!incomplete.begin(State::Applying));
    assert!(!incomplete.begin(State::RollingBack));
}
#[test]
fn duplicate_scope_and_contradictory_findings_stay_unknown() {
    let good = fixtures::load("done").unwrap();
    let mut f = good.clone();
    let r = f.observation.report.as_mut().unwrap();
    r.projects.push(r.projects[0].clone());
    r.registry.total += 1;
    r.registry.live += 1;
    assert!(!f.done());
    let mut f = good;
    f.observation.report.as_mut().unwrap().machine[0].status = "blocker".into();
    assert!(!f.done());
}
