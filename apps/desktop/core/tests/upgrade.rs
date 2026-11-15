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

#[test]
fn unreadable_or_relative_cli_never_admits_snapshot_or_upgrade() {
    let mut flow = fixtures::load("ready").unwrap();
    flow.observation.cli = None;
    assert!(!flow.can_snapshot());
    assert!(!flow.can_upgrade());
    flow.observation.cli = Some("5.0.0".into());
    flow.observation.cli_program = "hack".into();
    assert!(!flow.can_snapshot());
    assert!(!flow.can_upgrade());
}

/// The CLI's own v2 output: grouped steps cover several checkouts.
fn v2() -> Report {
    #[derive(serde::Deserialize)]
    struct Envelope {
        data: Report,
    }
    serde_json::from_str::<Envelope>(include_str!("fixtures/upgrade/check-v2.json"))
        .unwrap()
        .data
}
fn resolved(before: &Report) -> Report {
    let mut after = before.clone();
    after.plan.clear();
    for p in &mut after.projects {
        for f in &mut p.findings {
            f.status = "ok".into();
        }
    }
    after
}
#[test]
fn grouped_steps_confirm_only_when_every_covered_checkout_is_explicitly_ok() {
    let before = v2();
    assert!(before.ready());
    let after = resolved(&before);
    for step in &before.plan {
        assert!(after.confirms(step, &before), "{}", step.id);
    }
    let step = &before.plan[2];
    for kind in 0..6 {
        let mut after = resolved(&before);
        match kind {
            0 => after.projects[1]
                .findings
                .retain(|f| f.id != "ignore-rules"),
            1 => after.projects[2].state = "unreadable".into(),
            2 => after.projects[0].root = "/example/moved".into(),
            3 => after.incomplete.push(ScopedFinding {
                scope: "beta".into(),
                id: "env-key".into(),
                summary: "not checked".into(),
            }),
            4 => {
                let f = after.projects[2].findings[3].clone();
                after.projects[2].findings.push(f);
            }
            5 => after.projects[1].findings[3].status = "warn".into(),
            _ => unreachable!(),
        }
        assert!(!after.confirms(step, &before), "case {kind}");
    }
    // A missing target in the earlier report is never evidence either.
    let mut short = before.clone();
    short.projects.retain(|p| p.name != "gamma");
    assert!(!after.confirms(step, &short));
}
#[test]
fn grouped_fix_confirms_the_finding_it_was_built_from() {
    let mut before = v2();
    let key = before.projects[0]
        .findings
        .iter_mut()
        .find(|f| f.id == "env-key")
        .unwrap();
    key.status = "warn".into();
    key.apply_fix = Some("env-key-permissions".into());
    let mut step = before.plan[2].clone();
    step.id = "env-key-permissions".into();
    step.scope = "alpha".into();
    step.count = 1;
    step.targets.truncate(1);
    before.plan.push(step.clone());
    assert!(before.readable());
    let after = resolved(&before);
    assert!(after.confirms(&step, &before));
    let mut still_weak = after.clone();
    still_weak.projects[0]
        .findings
        .iter_mut()
        .find(|f| f.id == "env-key")
        .unwrap()
        .status = "warn".into();
    assert!(!still_weak.confirms(&step, &before));
}
#[test]
fn contradictory_grouped_plan_steps_make_the_report_unreadable() {
    let good = v2();
    for kind in 0..6 {
        let mut r = good.clone();
        let step = &mut r.plan[1];
        match kind {
            0 => step.count = 3,
            1 => step.scope = "alpha".into(),
            2 => step.targets[1] = step.targets[0].clone(),
            3 => step.targets[0].root = "/example/elsewhere".into(),
            4 => step.targets[0].scope = "delta".into(),
            5 => {
                step.targets.clear();
                step.count = 0;
            }
            _ => unreachable!(),
        }
        assert!(!r.readable(), "case {kind}");
        assert!(!r.ready(), "case {kind}");
    }
}
