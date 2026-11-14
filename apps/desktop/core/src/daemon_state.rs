//! Observations and explicit CLI actions for DESIGN sections 5 and 6.
//! This module never owns a daemon process, login unit or always-on policy.
use crate::daemon::DaemonClient;
use crate::models::{Autostart, AutostartGlobal, DaemonStatus};
use crate::runner::{CliRunner, RunError};
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DaemonAction {
    Start,
    Restart,
    Install,
}
impl DaemonAction {
    #[must_use]
    pub fn verb(self) -> &'static str {
        match self {
            Self::Start => "start",
            Self::Restart => "restart",
            Self::Install => "install",
        }
    }
    #[must_use]
    pub fn label(self) -> &'static str {
        match self {
            Self::Start => "Start hackd",
            Self::Restart => "Restart hackd",
            Self::Install => "Install login service",
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct Observation {
    pub cli_version: Option<String>,
    pub status: Option<DaemonStatus>,
    pub socket_version: Option<String>,
    pub error: Option<String>,
    pub cli_missing: bool,
}
impl Observation {
    #[must_use]
    pub fn tone(&self) -> crate::state::Tone {
        use crate::state::Tone;
        if self
            .status
            .as_ref()
            .and_then(|s| s.service.as_ref())
            .is_some_and(|s| s.unit_stale == Some(true))
            || matches!((&self.cli_version, &self.socket_version), (Some(c), Some(d)) if c != d)
        {
            return Tone::Warn;
        }
        match self.status.as_ref().map(|s| s.status.as_str()) {
            Some("running") if self.error.is_none() => Tone::Ok,
            Some("starting") => Tone::Busy,
            Some("incompatible" | "stale") => Tone::Warn,
            _ => Tone::Idle,
        }
    }

    #[must_use]
    pub fn label(&self) -> String {
        if self
            .status
            .as_ref()
            .and_then(|s| s.service.as_ref())
            .is_some_and(|s| s.unit_stale == Some(true))
        {
            return "Login service is out of date".into();
        }
        if let (Some(cli), Some(daemon)) = (&self.cli_version, &self.socket_version)
            && cli != daemon
        {
            return format!("hackd v{daemon}, CLI v{cli}");
        }
        let Some(s) = &self.status else {
            return "hackd status unknown".into();
        };
        if s.stale == Some(true) {
            return "hackd stopped unexpectedly".into();
        }
        match s.status.as_str() {
            "running" => "hackd running".into(),
            "starting" => "hackd starting…".into(),
            "incompatible" => "hackd incompatible".into(),
            "stopped" => match s.service.as_ref().and_then(|s| s.installed) {
                Some(true) => "hackd stopped (login service installed)".into(),
                Some(false) => "hackd off (login service not installed)".into(),
                None => "hackd stopped (login service unknown)".into(),
            },
            _ => "hackd status unknown".into(),
        }
    }
    #[must_use]
    pub fn actions(&self) -> Vec<DaemonAction> {
        if self.cli_missing || self.cli_version.is_none() {
            return vec![];
        }
        let mut actions = vec![];
        let mismatch =
            matches!((&self.cli_version, &self.socket_version), (Some(c), Some(d)) if c != d);
        if mismatch {
            actions.push(DaemonAction::Restart);
        }
        let Some(s) = &self.status else {
            return actions;
        };
        if s.running == Some(false) && matches!(s.status.as_str(), "stopped" | "stale") {
            actions.push(DaemonAction::Start);
        }
        if s.status == "incompatible" && !mismatch {
            actions.push(DaemonAction::Restart);
        }
        if s.service
            .as_ref()
            .is_some_and(|s| s.installed == Some(false) || s.unit_stale == Some(true))
        {
            actions.push(DaemonAction::Install);
        }
        actions
    }
    #[must_use]
    pub fn detail(&self) -> Option<String> {
        let mut parts = self.error.clone().into_iter().collect::<Vec<_>>();
        if let Some(s) = &self.status {
            parts.extend(s.issue.clone());
            parts.extend(s.stale_reason.clone());
            if let Some(unit) = &s.service {
                parts.extend(unit.unit_stale_reason.clone());
                parts.extend(unit.next_step.clone());
            }
            if let Some(next) = &s.next_step
                && !parts.contains(next)
            {
                parts.push(next.clone());
            }
        }
        (!parts.is_empty()).then(|| parts.join(" · "))
    }
}

/// Read raw JSON even on exit 1: an unhealthy report is still evidence.
#[must_use]
pub fn observe(runner: &CliRunner, socket: Option<&DaemonClient>) -> Observation {
    let mut o = Observation::default();
    match runner.version(Duration::from_secs(5)) {
        Ok(v) => o.cli_version = Some(v),
        Err(e) => {
            o.cli_missing = e == RunError::NotFound;
            o.error = Some(e.to_string());
            return o;
        }
    }
    match runner.run_raw(
        &["daemon", "status", "--json", "--no-interactive"],
        None,
        Duration::from_secs(15),
    ) {
        Ok((out, _, Some(0 | 1))) => match serde_json::from_str(&out)
            .map_err(|e| e.to_string())
            .and_then(DaemonStatus::from_value)
        {
            Ok(s) => o.status = Some(s),
            Err(e) => o.error = Some(e),
        },
        Ok((_, _, code)) => o.error = Some(format!("daemon status exited with {code:?}")),
        Err(e) => {
            if e == RunError::NotFound {
                o.cli_missing = true;
                o.cli_version = None;
            }
            o.error = Some(e.to_string());
        }
    }
    if let Some(socket) = socket {
        match socket.status() {
            Ok(s) if !s.version.is_empty() => o.socket_version = Some(s.version),
            Ok(_) => o.error = Some("socket status has no version".into()),
            Err(e) => {
                if o.status.as_ref().is_some_and(|s| s.running == Some(true)) {
                    o.error = Some(e.to_string());
                }
            }
        }
    }
    o
}

/// One non-admin command. Its exit is not an observed state.
/// # Errors
/// Spawn, exit or timeout failure; caller must obtain a fresh observation.
pub fn act(runner: &CliRunner, action: DaemonAction) -> Result<(), RunError> {
    let (_, stderr, code) = runner.run_raw(
        &["daemon", action.verb(), "--no-interactive"],
        None,
        Duration::from_secs(120),
    )?;
    if code != Some(0) {
        return Err(RunError::Exit { code, stderr });
    }
    Ok(())
}

#[derive(Debug, Clone, Default)]
pub struct DaemonModel {
    pub observed: Observation,
    pub busy: Option<DaemonAction>,
    pub action_error: Option<String>,
}
impl DaemonModel {
    /// Reject overlap and unavailable actions at the effect boundary.
    pub fn begin(&mut self, action: DaemonAction) -> bool {
        self.begin_with_recovery(action, None)
    }
    /// The project reader can prove a recovery action before daemon status
    /// answers. Both affordances use this same gate through their fresh reads.
    pub fn begin_with_recovery(
        &mut self,
        action: DaemonAction,
        recovery: Option<crate::source::DaemonRecovery>,
    ) -> bool {
        let recovery_action = recovery.map(|r| match r {
            crate::source::DaemonRecovery::Start => DaemonAction::Start,
            crate::source::DaemonRecovery::Restart => DaemonAction::Restart,
        });
        if self.busy.is_some()
            || self.observed.cli_missing
            || (!self.observed.actions().contains(&action) && recovery_action != Some(action))
        {
            return false;
        }
        self.busy = Some(action);
        self.action_error = None;
        true
    }
    /// Failure retains evidence; timeout discards it until a fresh read.
    pub fn finished(&mut self, result: &Result<(), RunError>) {
        if let Err(e) = result {
            self.action_error = Some(e.to_string());
            if e == &RunError::NotFound {
                self.observed.cli_missing = true;
            }
            if matches!(e, RunError::Timeout { .. }) {
                self.observed.status = None;
                self.observed.socket_version = None;
            }
        }
    }
    /// Keep the gate held through the post-action read. Failed reads cannot
    /// turn a successful command into a claimed running/stopped state.
    pub fn refreshed(&mut self, observation: Observation) {
        if observation.status.is_none() && self.action_error.is_some() {
            self.observed.error = observation.error;
            self.observed.cli_missing = observation.cli_missing;
        } else {
            self.observed = observation;
        }
        self.busy = None;
    }
}

/// R12 is proposed: consume observations, never invent a command or policy.
#[must_use]
pub fn always_on(
    a: Option<&Autostart>,
    global: Option<&AutostartGlobal>,
    daemon: &Observation,
) -> String {
    let mut lines = vec![];
    if let Some(a) = a {
        lines.push(match a.state.as_str() {
            "off" => "Always-on off".into(),
            "on" => "Always-on on".into(),
            "paused" if a.paused_reason.as_deref() == Some("manual_stop") => {
                "Paused until you start it".into()
            }
            "paused" => "Always-on paused".into(),
            "starting" => "Always-on starting…".into(),
            "needs_attention" => format!(
                "Always-on stopped trying after {} failures (limit: {}). Failed services: {}",
                a.failures
                    .count
                    .map_or_else(|| "unknown".into(), |n| n.to_string()),
                a.max_failures
                    .map_or_else(|| "unknown".into(), |n| n.to_string()),
                a.failures
                    .failed_services
                    .as_ref()
                    .map_or_else(|| "unknown".into(), |s| s.join(", "))
            ),
            _ => "Always-on state unknown (needs R12b)".into(),
        });
    } else {
        lines.push("Always-on state unknown (needs R12b)".into());
    }
    if let Some(g) = global {
        if g.paused.is_none() {
            lines.push("Global pause unknown (needs R12b)".into());
        }
        if g.paused == Some(true) {
            lines.push("Always-on paused for all projects".into());
        }
        if let Some(login) = &g.login_run
            && login.in_progress == Some(true)
        {
            lines.push(match (&login.started, &login.pending, &login.failed) {
                (Some(s), Some(p), Some(f)) => format!(
                    "At login: started {}, pending {}, failed {}",
                    s.len(),
                    p.len(),
                    f.len()
                ),
                _ => "At login: starting projects (progress unknown)".into(),
            });
        }
    }
    if daemon
        .status
        .as_ref()
        .and_then(|s| s.service.as_ref())
        .and_then(|s| s.installed)
        == Some(false)
    {
        lines.push("Needs hack daemon install".into());
    } else if global.and_then(|g| g.service_ready) != Some(true) {
        lines.push("Login service readiness unknown or unavailable (needs R12b)".into());
    }
    lines.push("Read-only: needs R12a/R12b capability; no always-on commands run".into());
    lines.join(" · ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn every_daemon_fixture_and_missing_always_on_metadata() {
        use crate::fixtures::{Fixture, daemon_observation};
        for f in Fixture::ALL {
            let o = daemon_observation(f);
            if f == Fixture::CliMissing {
                assert!(o.actions().is_empty());
            }
        }
        let stale = daemon_observation(Fixture::DaemonStaleUnit);
        assert!(stale.label().contains("out of date"));
        assert!(stale.actions().contains(&DaemonAction::Install));
        let mismatch = daemon_observation(Fixture::DaemonMismatch);
        assert!(mismatch.actions().contains(&DaemonAction::Restart));
        assert!(mismatch.label().contains("4.3.0"));
        assert!(
            daemon_observation(Fixture::DaemonStarting)
                .actions()
                .is_empty()
        );
        let unknown = always_on(None, None, &Observation::default());
        assert!(unknown.contains("unknown"));
        assert!(unknown.contains("R12a/R12b"));
        let partial: Autostart =
            serde_json::from_value(json!({"state":"needs_attention"})).unwrap();
        let text = always_on(Some(&partial), None, &Observation::default());
        assert!(text.contains("unknown failures"));
        assert!(text.contains("services: unknown"));
        for (f, expected) in [
            (Fixture::AlwaysOff, "off"),
            (Fixture::AlwaysOn, "on"),
            (Fixture::AlwaysPaused, "Paused until you start it"),
            (Fixture::AlwaysAttention, "3 failures (limit: 3)"),
            (Fixture::AlwaysGlobalPaused, "paused for all"),
            (Fixture::AlwaysLogin, "started 2, pending 2"),
            (Fixture::AlwaysNoLogin, "Needs hack daemon install"),
        ] {
            let p = crate::fixtures::project(f);
            let text = always_on(
                p.projects[0].autostart.as_ref(),
                p.autostart_global.as_ref(),
                &daemon_observation(f),
            );
            assert!(text.contains(expected), "{f:?}: {text}");
        }
    }

    #[test]
    fn fake_cli_retains_exit_one_report_and_reads_after_command_exit() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!(
            "desktop-daemon-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&dir).unwrap();
        let program = dir.join("hack");
        std::fs::write(
            &program,
            r#"#!/bin/sh
[ "$HACK_DAEMON_AUTOSTART_DISABLE" = 1 ] || exit 9
[ "$HOME" = "$HACK_HOME" ] || exit 9
case "$1 $2" in
  '--version ') echo 'hack v5.0.0' ;;
  'daemon status')
    if [ -f "$HACK_HOME/started" ]; then
      echo '{"status":"running","running":true,"service":{"installed":true}}'
    else
      echo '{"status":"stopped","running":false,"service":{}}'; exit 1
    fi ;;
  'daemon start') [ "$3" = --no-interactive ] || exit 8; : > "$HACK_HOME/started" ;;
  *) exit 7 ;;
esac
"#,
        )
        .unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
        let runner = CliRunner::new(program)
            .with_env("HOME", &dir.to_string_lossy())
            .with_env("HACK_HOME", &dir.to_string_lossy())
            .with_env("PATH", &dir.to_string_lossy())
            .with_env("HACK_DAEMON_AUTOSTART_DISABLE", "1");
        // Inject a private socket; never consult the user's daemon.
        let socket_dir = std::path::PathBuf::from(format!(
            "/tmp/dda-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .subsec_nanos()
        ));
        std::fs::create_dir(&socket_dir).unwrap();
        std::fs::set_permissions(&socket_dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        let sock = socket_dir.join("status.sock");
        let listener = std::os::unix::net::UnixListener::bind(&sock).unwrap();
        let server = std::thread::spawn(move || {
            use std::io::{Read, Write};
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut buf = [0; 1024];
            let n = stream.read(&mut buf).unwrap();
            assert!(
                std::str::from_utf8(&buf[..n])
                    .unwrap()
                    .starts_with("GET /v1/status ")
            );
            let body = r#"{"status":"ok","version":"4.3.0"}"#;
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            )
            .unwrap();
        });
        let mismatched = observe(
            &runner,
            Some(&DaemonClient::new(&sock, Duration::from_secs(1))),
        );
        assert!(mismatched.actions().contains(&DaemonAction::Restart));
        server.join().unwrap();
        std::fs::remove_dir_all(socket_dir).unwrap();
        let initial = observe(&runner, None);
        assert_eq!(initial.status.as_ref().unwrap().running, Some(false));
        assert_eq!(
            initial
                .status
                .as_ref()
                .unwrap()
                .service
                .as_ref()
                .unwrap()
                .installed,
            None
        );
        let mut m = DaemonModel {
            observed: initial,
            ..Default::default()
        };
        assert!(m.begin(DaemonAction::Start));
        let result = act(&runner, DaemonAction::Start);
        assert_eq!(result, Ok(()));
        m.finished(&result);
        assert_eq!(m.observed.status.as_ref().unwrap().running, Some(false));
        m.refreshed(observe(&runner, None));
        assert_eq!(m.observed.status.as_ref().unwrap().running, Some(true));
        assert!(m.busy.is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn missing_is_not_false_and_stale_unit_requires_evidence() {
        assert!(DaemonStatus::from_value(json!({})).is_err());
        assert!(DaemonStatus::from_value(json!({"status":"stopped", "running":true})).is_err());
        let s = DaemonStatus::from_value(json!({"status":"stopped", "running":false,"service":{}}))
            .unwrap();
        assert_eq!(s.service.as_ref().unwrap().installed, None);
        let o = Observation {
            cli_version: Some("5".into()),
            status: Some(s),
            ..Default::default()
        };
        assert!(!o.actions().contains(&DaemonAction::Install));
        assert!(o.label().contains("unknown"));
        assert!(
            DaemonStatus::from_value(
                json!({"status":"stopped","running":false,"service":{"installed":"false"}})
            )
            .is_err()
        );
        let unfamiliar = Observation {
            status: Some(
                DaemonStatus::from_value(json!({"status":"future","running":false})).unwrap(),
            ),
            ..o
        };
        assert!(unfamiliar.actions().is_empty());
    }
    #[test]
    fn single_action_failure_and_timeout() {
        let mut m = DaemonModel {
            observed: Observation {
                cli_version: Some("5".into()),
                status: Some(
                    DaemonStatus::from_value(json!({"status":"stopped","running":false})).unwrap(),
                ),
                ..Default::default()
            },
            ..Default::default()
        };
        assert!(m.begin(DaemonAction::Start));
        assert!(!m.begin(DaemonAction::Start));
        m.finished(&Err(RunError::Exit {
            code: Some(1),
            stderr: "failed".into(),
        }));
        assert!(m.observed.label().contains("stopped"));
        assert!(m.action_error.is_some());
        m.refreshed(Observation {
            error: Some("read failed".into()),
            ..Default::default()
        });
        assert!(m.observed.status.is_some());
        assert!(m.begin(DaemonAction::Start));
        m.finished(&Err(RunError::Timeout {
            after: Duration::from_secs(1),
        }));
        assert!(m.observed.status.is_none());
        assert!(m.busy.is_some());
        m.refreshed(Observation {
            error: Some("read failed".into()),
            ..Default::default()
        });
        assert!(m.observed.status.is_none());
    }
}
