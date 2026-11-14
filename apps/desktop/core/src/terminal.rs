//! Explicit terminal hand-off. No shell interpolation, existing panes or passwords.
//! `CommandSpec` is authored by the app, never constructed from a CLI fix string.
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::{
    ffi::OsString,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone)]
pub struct CommandSpec {
    pub program: String,
    pub args: Vec<String>,
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
        let mut child = std::process::Command::new(program)
            .args(args)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|e| e.to_string())?;
        // Terminal launchers can wait for the new terminal to close. Reap our
        // child without blocking GPUI, and never signal the terminal itself.
        std::thread::spawn(move || {
            let _ = child.wait();
        });
        Ok(())
    }
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
        let command = spec.display()?;
        if !temp_root.is_absolute() || temp_root.to_str().is_none() {
            return Err("Terminal temp root must be an absolute UTF-8 path".into());
        }
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
    /// Copy command. macOS opens the .command in a new Terminal window, background.
    pub fn open(
        mut self,
        platform: Platform,
        linux_terminal: Option<&Path>,
        launcher: &dyn Launcher,
    ) -> Result<(), String> {
        let (program, args) = match platform {
            Platform::Mac => (
                Path::new("/usr/bin/open"),
                vec![
                    "-g".into(),
                    "-a".into(),
                    "Terminal".into(),
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
/// Discover only the Linux adapter; never fall back to typing into a pane.
pub fn linux_adapter() -> Option<PathBuf> {
    crate::runner::resolve_on_path("xdg-terminal-exec", std::env::var_os("PATH").as_deref())
}
