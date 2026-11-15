//! Non-secret execution context shared by checked CLI reads and terminal fixes.
//! No environment enumeration: only these authored keys may cross the boundary.
use crate::{runner::CliRunner, terminal::CommandSpec};
use serde::Serialize;
use std::path::{Component, Path, PathBuf};
const KEYS: &[&str] = &[
    "HOME",
    "HACK_HOME",
    "PATH",
    "HACK_RUNTIME_BACKEND",
    "HACK_LAUNCHD_DISABLE",
    "HACK_SYSTEMD_DISABLE",
    "HACK_DAEMON_AUTOSTART_DISABLE",
    "XDG_RUNTIME_DIR",
];
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ExecutionContext {
    entries: Vec<(String, String)>,
}
impl ExecutionContext {
    pub fn capture(runner: &CliRunner) -> Result<Self, String> {
        let mut values = Vec::new();
        for key in KEYS {
            if let Some(value) = runner.effective_env(key) {
                let value = value
                    .into_string()
                    .map_err(|_| format!("{key} is not UTF-8; hand-off unavailable"))?;
                values.push(((*key).to_owned(), value));
            }
        }
        Self::from_values(&values)
    }
    /// Public fixture/adapter seam. Unknown keys are refused, never forwarded.
    pub fn from_values(values: &[(String, String)]) -> Result<Self, String> {
        if values
            .iter()
            .any(|(k, v)| !KEYS.contains(&k.as_str()) || v.chars().any(char::is_control))
        {
            return Err("Unsupported execution context; use documented terminal setup".into());
        }
        let get = |key: &str| {
            values
                .iter()
                .rev()
                .find(|(k, _)| k == key)
                .map(|(_, v)| v.trim())
                .filter(|v| !v.is_empty())
        };
        let home = get("HOME").ok_or("HOME is unavailable; hand-off refused")?;
        if !Path::new(home).is_absolute() {
            return Err("HOME must be absolute; hand-off refused".into());
        }
        let home = normalized(Path::new(home));
        let hack = match get("HACK_HOME") {
            Some(p) if Path::new(p).is_absolute() => normalized(Path::new(p)),
            Some(_) => return Err("HACK_HOME must be absolute; hand-off refused".into()),
            None => home.join(".hack"),
        };
        let path = crate::runner::sanitize_path(std::ffi::OsStr::new(
            get("PATH").unwrap_or("/usr/bin:/bin"),
        ))
        .into_string()
        .map_err(|_| "PATH is not UTF-8")?;
        let mut entries = vec![
            ("HOME".into(), home.to_string_lossy().into_owned()),
            ("PATH".into(), path),
        ];
        // Keep an absent override absent: candidate launchers may choose a
        // private default home. Both reads and hand-offs see the same absence.
        if get("HACK_HOME").is_some() {
            entries.push(("HACK_HOME".into(), hack.to_string_lossy().into_owned()));
        }
        if let Some(backend) = get("HACK_RUNTIME_BACKEND") {
            if !["compose", "native"].contains(&backend) {
                return Err("Unsupported backend context; hand-off refused".into());
            }
            entries.push(("HACK_RUNTIME_BACKEND".into(), backend.into()));
        }
        for key in ["HACK_LAUNCHD_DISABLE", "HACK_SYSTEMD_DISABLE"] {
            entries.push((
                key.into(),
                if get(key) == Some("1") { "1" } else { "0" }.into(),
            ));
        }
        // Observers and fixes never opt into incidental daemon autostart.
        entries.push(("HACK_DAEMON_AUTOSTART_DISABLE".into(), "1".into()));
        if let Some(dir) = get("XDG_RUNTIME_DIR") {
            if !Path::new(dir).is_absolute() {
                return Err("XDG_RUNTIME_DIR must be absolute; hand-off refused".into());
            }
            entries.push(("XDG_RUNTIME_DIR".into(), dir.into()));
        }
        Ok(Self { entries })
    }
    /// Preserve the checked home/program context while selecting an authored
    /// backend for observations and fixes belonging exclusively to that backend.
    pub fn with_backend(&self, backend: &str) -> Result<Self, String> {
        let mut values = self.entries.clone();
        values.retain(|(key, _)| key != "HACK_RUNTIME_BACKEND");
        values.push(("HACK_RUNTIME_BACKEND".into(), backend.into()));
        Self::from_values(&values)
    }
    pub fn value(&self, key: &str) -> Option<&str> {
        self.entries
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    }
    pub fn install_refusal(&self) -> Option<&'static str> {
        if self.value("HACK_LAUNCHD_DISABLE") == Some("1") {
            return Some("Login-service installation is disabled by the launchd guard");
        }
        if self.value("HACK_SYSTEMD_DISABLE") == Some("1") {
            return Some("Login-service installation is disabled by the systemd guard");
        }
        if self.value("HACK_HOME").is_some()
            && self.value("HACK_HOME").map(PathBuf::from)
                != self.value("HOME").map(|h| Path::new(h).join(".hack"))
        {
            return Some("This isolated Hack home does not own the login service");
        }
        None
    }
    /// Compose with a single spec or each authored spec in Upgrade's sequence.
    /// env -i prevents a terminal login environment from selecting another home,
    /// backend or guard. Every assignment remains an independently quoted argv.
    pub fn bind(&self, spec: &CommandSpec) -> Result<CommandSpec, String> {
        if !Path::new(&spec.program).is_absolute() {
            return Err("A checked absolute CLI executable is required".into());
        }
        spec.display()?;
        let mut args = vec!["-i".into()];
        args.extend(self.entries.iter().map(|(k, v)| format!("{k}={v}")));
        args.push(spec.program.clone());
        args.extend(spec.args.clone());
        Ok(CommandSpec {
            program: "/usr/bin/env".into(),
            args,
        })
    }
    /// Bound runner for all reads/actions: pinned program, clean environment,
    /// and only this non-secret allowlist (plus the runner's no-prompt guard).
    pub fn runner(&self, program: &str) -> Result<CliRunner, String> {
        if !Path::new(program).is_absolute() {
            return Err("A checked absolute CLI executable is required".into());
        }
        let mut runner = CliRunner::new(program).with_clean_env();
        for (k, v) in &self.entries {
            runner = runner.with_env(k, v);
        }
        Ok(runner)
    }
}
fn normalized(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}
