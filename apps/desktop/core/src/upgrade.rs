//! Upgrade decisions are pure. Only explicit UI actions call the CLI adapters.
//! R14 target discovery and R17 safe-fix metadata are not available in live mode.
use serde::Deserialize;
use std::path::Path;

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct Finding {
    pub id: String,
    pub status: String,
    pub summary: String,
    pub args: Option<Vec<String>>,
    pub action: Option<String>,
}
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct Step {
    pub id: String,
    pub scope: String,
    pub why: String,
    pub args: Option<Vec<String>>,
    pub action: Option<String>,
}
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct ScopedFinding {
    pub scope: String,
    pub id: String,
    pub summary: String,
}
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct Project {
    pub name: String,
    pub root: String,
    pub state: String,
    pub findings: Vec<Finding>,
}
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct RegistryEntry {
    pub name: String,
    pub root: String,
}
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct Registry {
    pub state: String,
    pub total: usize,
    pub live: usize,
    pub missing: Vec<RegistryEntry>,
    pub unreadable: Vec<RegistryEntry>,
    pub unchecked: Vec<RegistryEntry>,
    pub rejected: usize,
}
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct Report {
    pub report_version: u32,
    pub host_probes: String,
    pub ready: bool,
    pub machine: Vec<Finding>,
    pub projects: Vec<Project>,
    pub registry: Registry,
    pub blockers: Vec<ScopedFinding>,
    pub incomplete: Vec<ScopedFinding>,
    pub plan: Vec<Step>,
}
impl Report {
    pub fn readable(&self) -> bool {
        self.report_version == 1
            && self.host_probes == "enabled"
            && matches!(self.registry.state.as_str(), "valid" | "absent")
            && self.registry.missing.is_empty()
            && self.registry.unreadable.is_empty()
            && self.registry.unchecked.is_empty()
            && self.registry.rejected == 0
            && self.registry.live == self.registry.total
            && self.projects.len() == self.registry.live
            && self.projects.iter().all(|p| {
                p.state == "live" && p.name != "machine" && Path::new(&p.root).is_absolute()
            })
            && self.projects.iter().enumerate().all(|(i, p)| {
                !self.projects[..i]
                    .iter()
                    .any(|q| q.name == p.name || q.root == p.root)
            })
    }
    pub fn ready(&self) -> bool {
        self.readable()
            && self.ready
            && self.blockers.is_empty()
            && self.incomplete.is_empty()
            && self
                .machine
                .iter()
                .chain(self.projects.iter().flat_map(|p| &p.findings))
                .all(|f| matches!(f.status.as_str(), "ok" | "info" | "warn"))
    }
    /// Absence is never proof: match the same scope, checkout and explicit ok id.
    pub fn confirms(&self, step: &Step, before: &Report) -> bool {
        if !self.readable()
            || self.incomplete.iter().any(|f| f.scope == step.scope)
            || self
                .blockers
                .iter()
                .any(|f| f.scope == step.scope && f.id == step.id)
        {
            return false;
        }
        if step.id == "snapshot" && step.scope == "machine" {
            return true; // Proven separately by the admitted snapshot, not a finding.
        }
        let findings = if step.scope == "machine" {
            Some(&self.machine)
        } else {
            let old = before.projects.iter().find(|p| p.name == step.scope);
            old.and_then(|old| {
                self.projects
                    .iter()
                    .find(|p| p.name == old.name && p.root == old.root && p.state == "live")
            })
            .map(|p| &p.findings)
        };
        findings.is_some_and(|fs| {
            let matching: Vec<_> = fs.iter().filter(|f| f.id == step.id).collect();
            matching.len() == 1 && matching[0].status == "ok"
        })
    }
}

/// Proposed R14 evidence. Live adapters currently never produce this value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub version: String,
    pub cli_program: String,
    pub install_kind: String,
    pub available: bool,
}
impl Target {
    pub fn usable(&self, cli: &str) -> bool {
        self.available
            && self.install_kind == "homebrew"
            && self.cli_program == cli
            && Path::new(cli).is_absolute()
            && version(&self.version)
    }
}
fn version(s: &str) -> bool {
    !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || ".-+".contains(c))
        && s.chars().next().is_some_and(|c| c.is_ascii_digit())
}
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Observation {
    pub cli_program: String,
    pub cli: Option<String>,
    pub app: Option<String>,
    pub daemon: Option<String>,
    pub report: Option<Report>,
}
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct Gap {
    pub name: String,
    pub reason: String,
}
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct Snapshot {
    pub status: String,
    pub id: Option<String>,
    pub manifest_path: Option<String>,
    pub complete: Option<bool>,
    pub gaps: Option<Vec<Gap>>,
}
impl Snapshot {
    pub fn manifest(&self) -> Option<&str> {
        if self.status != "created"
            || self.complete != Some(true)
            || !self.gaps.as_ref().is_some_and(Vec::is_empty)
        {
            return None;
        }
        let id = self.id.as_deref()?;
        let manifest = self.manifest_path.as_deref()?;
        let path = Path::new(manifest);
        (path.is_absolute()
            && path.file_name()?.to_str()? == "manifest.json"
            && path.parent()?.file_name()?.to_str()? == id
            && !id.is_empty()
            && id != "."
            && id != ".."
            && !path
                .components()
                .any(|p| matches!(p, std::path::Component::ParentDir))
            && !manifest.chars().any(char::is_control))
        .then_some(manifest)
    }
}
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct RestoredFile {
    pub path: String,
    pub status: String,
    pub kept_as: Option<String>,
    pub message: Option<String>,
}
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct Rollback {
    pub status: String,
    #[serde(default)]
    pub results: Vec<RestoredFile>,
    pub message: Option<String>,
}
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum State {
    #[default]
    AvailabilityUnknown,
    Available,
    Checking,
    Blocked,
    Ready,
    Snapshotting,
    Incomplete,
    Applying,
    Unknown,
    Restarting,
    Done,
    Failed,
    RollingBack,
    Restored,
}
impl State {
    pub fn label(self) -> &'static str {
        match self {
            Self::AvailabilityUnknown => "Update availability unknown",
            Self::Available => "Update available",
            Self::Checking => "Checking readiness…",
            Self::Blocked => "Readiness needs attention",
            Self::Ready => "Readiness checked",
            Self::Snapshotting => "Saving files…",
            Self::Incomplete => "Snapshot incomplete",
            Self::Applying => "Waiting for external commands",
            Self::Unknown => "Could not confirm the upgrade",
            Self::Restarting => "Restarting hackd…",
            Self::Done => "Hack is up to date",
            Self::Failed => "Upgrade needs attention",
            Self::RollingBack => "Restoring files…",
            Self::Restored => "Files restored",
        }
    }
}
#[derive(Debug, Clone, Default)]
pub struct Flow {
    pub state: State,
    pub busy: bool,
    pub target: Option<Target>,
    pub observation: Observation,
    pub snapshot: Option<Snapshot>,
    pub previous: Option<Report>,
    pub rollback: Option<Rollback>,
    pub message: Option<String>,
}
impl Flow {
    pub fn can_snapshot(&self) -> bool {
        !self.busy
            && self.observation.report.as_ref().is_some_and(Report::ready)
            && self.previous.is_none()
    }
    pub fn can_upgrade(&self) -> bool {
        self.can_snapshot()
            && self
                .snapshot
                .as_ref()
                .and_then(Snapshot::manifest)
                .is_some()
            && self
                .target
                .as_ref()
                .is_some_and(|t| t.usable(&self.observation.cli_program))
    }
    pub fn can_rollback(&self) -> bool {
        !self.busy
            && self
                .snapshot
                .as_ref()
                .and_then(Snapshot::manifest)
                .is_some()
    }
    pub fn begin(&mut self, state: State) -> bool {
        let admitted = match state {
            State::Checking => !self.busy,
            State::Snapshotting => self.can_snapshot(),
            State::Applying => self.can_upgrade(),
            State::Restarting => !self.busy && self.previous.is_some(),
            State::RollingBack => self.can_rollback(),
            _ => false,
        };
        if !admitted {
            return false;
        }
        self.busy = true;
        self.state = state;
        self.message = None;
        true
    }
    pub fn checked(&mut self, observation: Observation) {
        self.busy = false;
        self.observation = observation;
        let Some(report) = &self.observation.report else {
            self.state = State::Unknown;
            return;
        };
        if self.previous.is_some() {
            self.state = if self.done() {
                State::Done
            } else {
                State::Unknown
            };
        } else if !report.ready() {
            self.state = State::Blocked;
        } else if self
            .target
            .as_ref()
            .is_some_and(|t| t.usable(&self.observation.cli_program))
        {
            self.state = State::Ready;
        } else {
            self.state = State::AvailabilityUnknown;
        }
    }
    pub fn saved(&mut self, snapshot: Snapshot) {
        self.busy = false;
        self.state = if snapshot.manifest().is_some() {
            if self
                .target
                .as_ref()
                .is_some_and(|t| t.usable(&self.observation.cli_program))
            {
                State::Ready
            } else {
                State::AvailabilityUnknown
            }
        } else {
            State::Incomplete
        };
        self.snapshot = Some(snapshot);
    }
    pub fn handed_off(&mut self) {
        self.busy = false;
        self.previous = self.observation.report.clone();
        self.state = State::Applying;
        self.message = Some("Terminal opened. Run the commands there, then Check again. Opening a terminal does not confirm success.".into());
    }
    pub fn failed(&mut self, message: String) {
        self.busy = false;
        self.state = State::Failed;
        self.message = Some(message);
    }
    pub fn rolled_back(&mut self, result: Rollback) {
        self.busy = false;
        self.state = if result.status == "restored"
            && result.results.iter().all(|r| {
                matches!(
                    r.status.as_str(),
                    "restored" | "already-restored" | "moved-aside"
                )
            }) {
            State::Restored
        } else {
            State::Failed
        };
        self.rollback = Some(result);
        self.previous = None;
        // A restored file set is no longer an upgrade readiness observation.
        self.observation.report = None;
    }
    pub fn done(&self) -> bool {
        let (Some(target), Some(before), Some(after)) =
            (&self.target, &self.previous, &self.observation.report)
        else {
            return false;
        };
        before.ready()
            && target.usable(&self.observation.cli_program)
            && self
                .snapshot
                .as_ref()
                .and_then(Snapshot::manifest)
                .is_some()
            && self.observation.cli.as_deref() == Some(&target.version)
            && self.observation.app.as_deref() == Some(&target.version)
            && self.observation.daemon == self.observation.cli
            && after.ready()
            && after.plan.is_empty()
            && before.plan.iter().all(|step| after.confirms(step, before))
    }
}
/// The only upgrade terminal commands currently authored. No finding text enters here.
pub fn homebrew_commands() -> Vec<crate::terminal::CommandSpec> {
    vec![
        crate::terminal::CommandSpec {
            program: "brew".into(),
            args: vec!["upgrade".into(), "hack".into()],
        },
        crate::terminal::CommandSpec {
            program: "brew".into(),
            args: vec!["upgrade".into(), "--cask".into(), "hack-desktop".into()],
        },
    ]
}
/// Untrusted argv may be copied after quoting, but never passed to terminal Run.
pub fn display_step(cli: &str, args: &[String]) -> Result<String, String> {
    crate::terminal::CommandSpec {
        program: cli.into(),
        args: args.to_vec(),
    }
    .display()
}
