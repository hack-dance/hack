//! Explicit terminal hand-off. No shell interpolation, existing panes or passwords.
//! `CommandSpec` is authored by the app, never constructed from a CLI fix string.
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::{
    ffi::OsString,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandSpec {
    pub program: String,
    pub args: Vec<String>,
}

/// Availability supplied by the check that owns a command. A runnable or
/// copyable spec is authored argv bound to the checked execution context.
/// Never construct it by parsing a CLI hint or a previously quoted string.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CommandAvailability {
    Ready(CommandSpec),
    CopyOnly(CommandSpec),
    Blocked(String),
    VersionMismatch(String),
}

/// Width and placement of the equal Run/Copy buttons.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandControlSize {
    /// Standalone command box on a setup step.
    Standard,
    /// Inline actions on a Doctor finding or machine row.
    Compact,
}

/// Props for a command control and its drawer session.
#[derive(Debug, Clone)]
pub struct CommandControl {
    /// Stable, window-unique ID for this action, including its target.
    pub id: String,
    /// Short, display-only command, e.g. `hack global install`.
    pub label: String,
    /// Drawer title, e.g. `Terminal` or `Fix all · 2 of 4`.
    pub title: String,
    pub availability: CommandAvailability,
    pub size: CommandControlSize,
    /// Project root when the check targets a project. Otherwise runs at HOME.
    pub cwd: Option<PathBuf>,
    /// Allows the drawer to show the password guidance when sudo prompts.
    pub expects_password: bool,
}

/// The PTY process outcome. A zero code still requires a fresh check.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CommandExit {
    Code(i32),
    Signal(i32),
    StatusUnavailable,
    LaunchFailed(String),
}
impl CommandSpec {
    /// All arguments are quoted independently, including the executable.
    pub fn display(&self) -> Result<String, String> {
        std::iter::once(&self.program)
            .chain(&self.args)
            .map(|s| quote(s))
            .collect::<Result<Vec<_>, _>>()
            .map(|v| v.join(" "))
    }

    /// Render the same command with a working directory for shell hand-off.
    pub fn display_in(&self, cwd: Option<&Path>) -> Result<String, String> {
        let command = self.display()?;
        let Some(cwd) = cwd else {
            return Ok(command);
        };
        let directory = cwd
            .to_str()
            .filter(|_| cwd.is_absolute())
            .ok_or("Command directory must be an absolute UTF-8 path")?;
        Ok(format!("cd {} && {command}", quote(directory)?))
    }
}
pub fn quote(s: &str) -> Result<String, String> {
    if s.is_empty() || s.chars().any(char::is_control) {
        return Err("Empty arguments or control characters are not supported".into());
    }
    Ok(format!("'{}'", s.replace('\'', "'\\''")))
}
#[derive(Debug, Clone, Copy)]
pub enum Platform {
    Mac,
    Linux,
}
/// Injectable OS boundary. A fake records argv; tests never open a real terminal.
pub trait Launcher {
    fn launch(&self, program: &Path, args: &[OsString]) -> Result<(), String>;
}
pub struct SystemLauncher;
impl Launcher for SystemLauncher {
    fn launch(&self, program: &Path, args: &[OsString]) -> Result<(), String> {
        // The shared spawn boundary closes every unlisted descriptor on macOS,
        // so the launcher cannot inherit a pipe or file another thread has
        // not yet marked close-on-exec. `launch_command` cleared the
        // environment, so the boundary must not rebuild it from the parent.
        let mut child = crate::process::spawn_with(
            &mut launch_command(program, args, |key| std::env::var_os(key)),
            false,
            false,
        )
        .map_err(|e| e.to_string())?;
        // Terminal launchers can wait for the new terminal to close. Reap our
        // child without blocking GPUI, and never signal the terminal itself.
        // On macOS the boundary always pipes stdout/stderr: discard them so a
        // talkative launcher can never block on a full pipe.
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        std::thread::spawn(move || {
            let errors = std::thread::spawn(move || discard(stderr));
            discard(stdout);
            let _ = errors.join();
            let _ = child.wait();
        });
        Ok(())
    }
}
fn discard(output: Option<impl std::io::Read>) {
    if let Some(mut output) = output {
        let _ = std::io::copy(&mut output, &mut std::io::sink());
    }
}
/// UI routing metadata only, separate from the checked CLI context embedded in
/// the script. Never pass the app's credential/wrapper environment to a terminal.
const LAUNCH_ENV: &[&str] = &[
    "HOME",
    "PATH",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XDG_RUNTIME_DIR",
    "XDG_CURRENT_DESKTOP",
    "DBUS_SESSION_BUS_ADDRESS",
];
fn launch_command(
    program: &Path,
    args: &[OsString],
    environment: impl Fn(&str) -> Option<OsString>,
) -> std::process::Command {
    let mut command = std::process::Command::new(program);
    command
        .env_clear()
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    for key in LAUNCH_ENV {
        if let Some(value) = environment(key) {
            command.env(
                key,
                if *key == "PATH" {
                    crate::runner::sanitize_path(&value)
                } else {
                    value
                },
            );
        }
    }
    command
}

/// A private, one-use script. Drop cleans failed/unlaunched handoffs. After a
/// successful launch the script owns cleanup via EXIT/HUP/INT/TERM traps. If the
/// terminal never executes it, the private OS temp directory can remain.
pub struct Script {
    path: PathBuf,
    handed_off: bool,
}
impl Script {
    pub fn create(temp_root: &Path, spec: &CommandSpec) -> Result<Self, String> {
        Self::create_in(temp_root, spec, None)
    }

    /// Hand off the checked working directory along with argv.
    pub fn create_in(
        temp_root: &Path,
        spec: &CommandSpec,
        cwd: Option<&Path>,
    ) -> Result<Self, String> {
        let command = spec.display_in(cwd)?;
        if !temp_root.is_absolute() || temp_root.to_str().is_none() {
            return Err("Terminal temp root must be an absolute UTF-8 path".into());
        }
        // Use the validated canonical root from here on: an alias path could
        // be replaced after validation.
        let temp_root = &safe_temp_root(temp_root)?;
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos();
        let dir = temp_root.join(format!("hack-terminal-{}-{nonce}", std::process::id()));
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&dir)
            .map_err(|e| e.to_string())?;
        let script = Self {
            path: dir.join("setup.command"),
            handed_off: false,
        };
        let cleanup = format!(
            "/bin/rm -f -- {}; /bin/rmdir -- {}",
            quote(&script.path.to_string_lossy())?,
            quote(&dir.to_string_lossy())?
        );
        let text = format!(
            "#!/bin/sh\ntrap {} EXIT\ntrap 'exit 130' HUP INT TERM\nprintf '%s\\n' {} 'Press Enter to run this command, or close this window to cancel.'\nIFS= read -r answer || exit 1\n{command}\nresult=$?\nprintf 'Command finished (exit %s). Press Enter to close.\\n' \"$result\"\nIFS= read -r answer || :\nexit \"$result\"\n",
            quote(&cleanup)?,
            quote(&command)?
        );
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o700)
            .open(&script.path)
            .map_err(|e| e.to_string())?;
        file.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
        // Preserve executable mode even under a restrictive umask.
        file.set_permissions(std::fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
        Ok(script)
    }
    pub fn path(&self) -> &Path {
        &self.path
    }
    /// Linux requires a discovered absolute xdg-terminal-exec path; absent means
    /// Copy command. macOS opens the .command in a new window of the system
    /// Terminal bundle, in the background.
    pub fn open(
        self,
        platform: Platform,
        linux_terminal: Option<&Path>,
        launcher: &dyn Launcher,
    ) -> Result<(), String> {
        self.open_with(
            platform,
            linux_terminal,
            Path::new(MAC_TERMINAL_APP),
            launcher,
        )
    }
    /// `open` with the macOS Terminal bundle path supplied (a test seam). The
    /// bundle is passed to `open -a` by path, never by application name, so
    /// another account cannot register a competing "Terminal" that would run
    /// as this user before the script's Enter prompt.
    pub fn open_with(
        mut self,
        platform: Platform,
        linux_terminal: Option<&Path>,
        mac_terminal: &Path,
        launcher: &dyn Launcher,
    ) -> Result<(), String> {
        let (program, args) = match platform {
            Platform::Mac => (
                Path::new("/usr/bin/open"),
                vec![
                    "-g".into(),
                    "-a".into(),
                    system_bundle(mac_terminal)?.into_os_string(),
                    self.path.as_os_str().into(),
                ],
            ),
            Platform::Linux => {
                let p = linux_terminal
                    .filter(|p| p.is_absolute())
                    .ok_or("xdg-terminal-exec unavailable; use Copy command")?;
                (p, vec![self.path.as_os_str().into()])
            }
        };
        launcher.launch(program, &args)?;
        self.handed_off = true;
        Ok(())
    }
}
impl Drop for Script {
    fn drop(&mut self) {
        if !self.handed_off {
            let _ = std::fs::remove_file(&self.path);
            if let Some(p) = self.path.parent() {
                let _ = std::fs::remove_dir(p);
            }
        }
    }
}
/// The system Terminal bundle (sealed system volume on supported macOS).
pub const MAC_TERMINAL_APP: &str = "/System/Applications/Utilities/Terminal.app";

/// The bundle must be a real directory at exactly this path (no symlink),
/// owned by root and not writable by group or others, with the same rule for
/// every directory above it. Otherwise the hand-off fails closed to Copy.
fn system_bundle(bundle: &Path) -> Result<PathBuf, String> {
    use std::os::unix::fs::MetadataExt;
    const REFUSED: &str = "The system Terminal app is unavailable; use Copy command";
    let real = std::fs::canonicalize(bundle).map_err(|_| REFUSED.to_owned())?;
    if real != bundle || !std::fs::metadata(&real).is_ok_and(|m| m.is_dir()) {
        return Err(REFUSED.into());
    }
    for dir in real.ancestors() {
        let ok = std::fs::metadata(dir).is_ok_and(|m| m.uid() == 0 && m.mode() & 0o022 == 0);
        if !ok || !crate::doctor_acl::controlled(dir) {
            return Err(REFUSED.into());
        }
    }
    Ok(real)
}

/// Another user must not be able to rename the private script directory
/// out of `root` and substitute a script before the terminal runs it. The
/// root must be owned by this user and not writable by group or others, or
/// owned by root and either not writable by others or sticky (as `/tmp` is);
/// every directory above it follows the same rule, and ACLs may not grant
/// changes (Doctor's ACL check).
fn safe_temp_root(root: &Path) -> Result<PathBuf, String> {
    use std::os::unix::fs::MetadataExt;
    const REFUSED: &str =
        "The temporary directory can be changed by other users; terminal hand-off refused";
    // SAFETY: getuid has no preconditions and cannot fail.
    let uid = unsafe { libc::getuid() };
    let real = std::fs::canonicalize(root).map_err(|_| REFUSED.to_owned())?;
    if !std::fs::metadata(&real).is_ok_and(|m| m.is_dir()) {
        return Err(REFUSED.into());
    }
    for dir in real.ancestors() {
        let Ok(meta) = std::fs::metadata(dir) else {
            return Err(REFUSED.into());
        };
        let writable_by_others = meta.mode() & 0o022 != 0;
        let sticky = meta.mode() & 0o1000 != 0;
        let ok = (meta.uid() == uid && !writable_by_others)
            || (meta.uid() == 0 && (!writable_by_others || sticky));
        if !ok || !crate::doctor_acl::controlled(dir) {
            return Err(REFUSED.into());
        }
    }
    Ok(real)
}

/// Discover only the Linux adapter; never fall back to typing into a pane.
/// It runs as this user before any confirmation, so it must pass the same
/// ownership, write and `#!` interpreter rules as the CLI (no env form);
/// otherwise the app offers Copy only.
pub fn linux_adapter() -> Option<PathBuf> {
    adapter_on(std::env::var_os("PATH").as_deref())
}

fn adapter_on(path: Option<&std::ffi::OsStr>) -> Option<PathBuf> {
    let found = crate::runner::resolve_on_path("xdg-terminal-exec", path)?;
    // SAFETY: getuid has no preconditions and cannot fail.
    let uid = unsafe { libc::getuid() };
    crate::source::trusted_tool_path(&found, uid, false)
        .filter(|real| crate::source::trusted_interpreter(real, uid, 4, false))
        .map(|_| found)
}

#[cfg(test)]
mod launch_tests {
    use super::*;
    #[test]
    fn linux_adapter_must_be_in_a_trusted_location() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!(
            "terminal-adapter-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let bin = root.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        let adapter = bin.join("xdg-terminal-exec");
        std::fs::write(&adapter, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&adapter, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(adapter_on(Some(bin.as_os_str())), Some(adapter.clone()));
        std::fs::write(&adapter, "#!/usr/bin/env sh\n").unwrap();
        assert_eq!(adapter_on(Some(bin.as_os_str())), None, "env form refused");
        std::fs::write(&adapter, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o777)).unwrap();
        assert_eq!(
            adapter_on(Some(bin.as_os_str())),
            None,
            "writable directory refused"
        );
        let _ = std::fs::remove_dir_all(root);
    }
    #[test]
    fn launcher_reads_only_authored_ui_metadata_without_forwarding_app_environment() {
        let queried = std::cell::RefCell::new(Vec::new());
        let command = launch_command(
            Path::new("/fake/terminal"),
            &["/private/setup.command".into()],
            |key| {
                queried.borrow_mut().push(key.to_owned());
                Some("fixture".into())
            },
        );
        assert_eq!(queried.borrow().len(), LAUNCH_ENV.len());
        assert!(
            queried
                .borrow()
                .iter()
                .all(|key| LAUNCH_ENV.contains(&key.as_str()))
        );
        assert!(command.get_envs().all(|(key, _)| {
            LAUNCH_ENV
                .iter()
                .any(|allowed| key == std::ffi::OsStr::new(allowed))
        }));
        assert_eq!(
            command.get_program(),
            std::ffi::OsStr::new("/fake/terminal")
        );
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            vec![std::ffi::OsStr::new("/private/setup.command")]
        );
    }
}
