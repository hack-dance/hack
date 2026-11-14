//! Offline proposed R14/R17 examples. Never invoke a process or use a real home.
use crate::upgrade::*;
pub const NAMES: &[&str] = &[
    "availability-unknown",
    "available",
    "checking",
    "blocked",
    "ready",
    "snapshotting",
    "incomplete",
    "applying",
    "unknown",
    "restarting",
    "done",
    "failed",
    "rolling-back",
    "restored",
];
pub fn report() -> Report {
    Report {
        report_version: 1,
        host_probes: "enabled".into(),
        ready: true,
        machine: vec![Finding {
            id: "daemon".into(),
            status: "ok".into(),
            summary: "Daemon matches the CLI".into(),
            args: None,
            action: None,
        }],
        projects: vec![Project {
            name: "sample".into(),
            root: "/example/project".into(),
            state: "live".into(),
            findings: vec![Finding {
                id: "env-format".into(),
                status: "warn".into(),
                summary: "Review environment file names before migration".into(),
                args: Some(vec![
                    "env".into(),
                    "migrate".into(),
                    "--path".into(),
                    "/example/project".into(),
                ]),
                action: None,
            }],
        }],
        registry: Registry {
            state: "valid".into(),
            total: 1,
            live: 1,
            missing: vec![],
            unreadable: vec![],
            unchecked: vec![],
            rejected: 0,
        },
        blockers: vec![],
        incomplete: vec![],
        plan: vec![
            Step {
                id: "snapshot".into(),
                scope: "machine".into(),
                why: "Save files before making changes".into(),
                args: Some(vec!["upgrade".into(), "snapshot".into()]),
                action: None,
            },
            Step {
                id: "env-format".into(),
                scope: "sample".into(),
                why: "Migrate environment files in sample".into(),
                args: Some(vec![
                    "env".into(),
                    "migrate".into(),
                    "--path".into(),
                    "/example/project".into(),
                ]),
                action: None,
            },
        ],
    }
}
pub fn snapshot() -> Snapshot {
    Snapshot {
        status: "created".into(),
        id: Some("example-snapshot".into()),
        manifest_path: Some("/example/snapshots/example-snapshot/manifest.json".into()),
        complete: Some(true),
        gaps: Some(vec![]),
    }
}
pub fn load(name: &str) -> Option<Flow> {
    let state = match name {
        "availability-unknown" => State::AvailabilityUnknown,
        "available" => State::Available,
        "checking" => State::Checking,
        "blocked" => State::Blocked,
        "ready" => State::Ready,
        "snapshotting" => State::Snapshotting,
        "incomplete" => State::Incomplete,
        "applying" => State::Applying,
        "unknown" => State::Unknown,
        "restarting" => State::Restarting,
        "done" => State::Done,
        "failed" => State::Failed,
        "rolling-back" => State::RollingBack,
        "restored" => State::Restored,
        _ => return None,
    };
    let mut flow = Flow {
        state,
        target: Some(Target {
            version: "5.1.0".into(),
            cli_program: "/example/bin/hack".into(),
            install_kind: "homebrew".into(),
            available: true,
        }),
        observation: Observation {
            cli_program: "/example/bin/hack".into(),
            cli: Some("5.0.0".into()),
            app: Some("5.0.0".into()),
            daemon: Some("5.0.0".into()),
            report: Some(report()),
        },
        ..Flow::default()
    };
    flow.busy = matches!(
        state,
        State::Checking | State::Snapshotting | State::Restarting | State::RollingBack
    );
    if state == State::AvailabilityUnknown {
        flow.target = None;
    }
    if matches!(state, State::Available | State::Checking) {
        flow.observation.report = None;
    }
    if state == State::Blocked {
        let r = flow.observation.report.as_mut()?;
        r.ready = false;
        r.blockers.push(ScopedFinding {
            scope: "sample".into(),
            id: "env-key".into(),
            summary: "The environment key cannot be checked".into(),
        });
    }
    if !matches!(
        state,
        State::Available
            | State::Checking
            | State::Blocked
            | State::Snapshotting
            | State::AvailabilityUnknown
    ) {
        flow.snapshot = Some(snapshot());
    }
    if state == State::Incomplete {
        let s = flow.snapshot.as_mut()?;
        s.complete = Some(false);
        s.gaps = Some(vec![Gap {
            name: "sample".into(),
            reason: "Checkout could not be read".into(),
        }]);
    }
    if matches!(
        state,
        State::Applying
            | State::Unknown
            | State::Restarting
            | State::Done
            | State::Failed
            | State::RollingBack
    ) {
        flow.previous = Some(report());
    }
    if state == State::Done {
        let r = flow.observation.report.as_mut()?;
        r.plan.clear();
        r.projects[0].findings[0].status = "ok".into();
        flow.observation.cli = Some("5.1.0".into());
        flow.observation.app = Some("5.1.0".into());
        flow.observation.daemon = Some("5.1.0".into());
    }
    if state == State::Failed {
        flow.message = Some("The installed app version still differs. Files were saved; check versions again or restore files.".into());
    }
    if state == State::Restored {
        flow.rolled_back(Rollback {
            status: "restored".into(),
            message: None,
            results: vec![RestoredFile {
                path: "/example/project/.hack/hack.env.json".into(),
                status: "restored".into(),
                kept_as: Some("/example/project/.hack/hack.env.json.kept".into()),
                message: None,
            }],
        });
    }
    Some(flow)
}
