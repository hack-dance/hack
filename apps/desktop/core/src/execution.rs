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
    "XDG_CONFIG_HOME",
    "DOCKER_CONTEXT",
    "DOCKER_HOST",
    "DOCKER_CONFIG",
    "HACK_NATIVE_HOME",
    "HACK_NATIVE_BINARY",
    "HACK_GLOBAL_CONFIG_PATH",
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
        // The CLI places the systemd user unit under an absolute
        // XDG_CONFIG_HOME and ignores a relative one (XDG spec); keep the same
        // selection so setup checks and installs the user's actual unit.
        if let Some(dir) = get("XDG_CONFIG_HOME").filter(|d| Path::new(d).is_absolute()) {
            entries.push((
                "XDG_CONFIG_HOME".into(),
                normalized(Path::new(dir)).to_string_lossy().into_owned(),
            ));
        }
        // Native runtime selectors decide which runtime native reads and
        // actions address; the CLI requires absolute paths.
        // HACK_GLOBAL_CONFIG_PATH selects managed DNS domains and the proxy
        // bind address for checks and repairs alike.
        for key in [
            "HACK_NATIVE_HOME",
            "HACK_NATIVE_BINARY",
            "HACK_GLOBAL_CONFIG_PATH",
        ] {
            if let Some(path) = get(key) {
                if !Path::new(path).is_absolute() {
                    return Err(format!("{key} must be absolute; hand-off refused"));
                }
                entries.push((
                    key.into(),
                    normalized(Path::new(path)).to_string_lossy().into_owned(),
                ));
            }
        }
        // Docker selectors decide which engine Compose checks and repairs
        // address. Keep validated ones; refuse anything else rather than
        // silently falling back to the default engine.
        if let Some(context) = get("DOCKER_CONTEXT") {
            if !context
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
            {
                return Err("Unsupported DOCKER_CONTEXT; hand-off refused".into());
            }
            entries.push(("DOCKER_CONTEXT".into(), context.into()));
        }
        if let Some(config) = get("DOCKER_CONFIG") {
            if !Path::new(config).is_absolute() {
                return Err("DOCKER_CONFIG must be absolute; hand-off refused".into());
            }
            entries.push((
                "DOCKER_CONFIG".into(),
                normalized(Path::new(config)).to_string_lossy().into_owned(),
            ));
        }
        if let Some(host) = get("DOCKER_HOST") {
            let supported = match host.split_once("://") {
                Some(("unix", path)) => Path::new(path).is_absolute(),
                Some(("tcp" | "ssh", rest)) => !rest.is_empty(),
                _ => false,
            };
            if !supported || host.chars().any(char::is_whitespace) {
                return Err("Unsupported DOCKER_HOST; hand-off refused".into());
            }
            entries.push(("DOCKER_HOST".into(), host.into()));
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
    /// The same context with `PATH` reduced to directories no other user can
    /// change; with none left, the context's system default PATH applies.
    pub fn with_controlled_path(&self) -> Result<Self, String> {
        let kept = self
            .value("PATH")
            .map(|p| crate::doctor_plugins::controlled_path_entries(p).join(":"))
            .unwrap_or_default();
        let mut values = self.entries.clone();
        values.retain(|(key, _)| key != "PATH");
        if !kept.is_empty() {
            values.push(("PATH".into(), kept));
        }
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
        let mut runner = CliRunner::verified(program).with_clean_env();
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
