//! Offline setup examples, shared by the state CLI and offscreen UI.
use crate::{
    doctor::DoctorRun,
    models::{DoctorCheck, DoctorReport, ProjectsPayload},
    setup::{self, Platform, Report},
};
pub const NAMES: [&str; 4] = ["missing-cli", "partial", "ready", "native-unknown"];
pub fn load(name: &str) -> Option<Report> {
    if !NAMES.contains(&name) {
        return None;
    }
    let native = name == "native-unknown";
    let projects = ProjectsPayload {
        runtime_ok: Some(true),
        projects: if native {
            vec![crate::models::ProjectRow {
                name: "sample".into(),
                repo_root: Some("/work/sample".into()),
                backend: Some("native".into()),
                ..Default::default()
            }]
        } else {
            vec![]
        },
        ..Default::default()
    };
    let machine = DoctorRun::machine(Ok(DoctorReport {
        checks: vec![
            DoctorCheck {
                id: "linux dns route".into(),
                status: "ok".into(),
                detail: "Host DNS configured".into(),
            },
            DoctorCheck {
                id: if name == "partial" {
                    "caddy local ca"
                } else {
                    "local ca trust"
                }
                .into(),
                status: "ok".into(),
                detail: "CA check completed".into(),
            },
        ],
        ..Default::default()
    }));
    let daemon =
        serde_json::json!({"running":name!="partial","service":{"installed":name!="partial"}});
    Some(setup::derive(
        if name == "missing-cli" {
            Err("missing")
        } else {
            Ok("5.0.0")
        },
        Some(&projects),
        Some("5.0.0"),
        Some(&daemon),
        &[machine],
        Platform::Linux,
    ))
}
