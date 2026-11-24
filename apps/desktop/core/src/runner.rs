//! Runs `hack ... --json` as the user, with a timeout.
//!
//! Contract:
//! - Each command runs in its own process group. On timeout the whole group
//!   is killed (SIGKILL) and reaped, so no `docker compose` child outlives it.
//! - stdout is parsed as JSON. The CLI result envelope (`{ok,data}` /
//!   `{ok:false,error}`) is unwrapped; raw objects are returned as they are.
//! - stderr is kept (last 8 KB) only for error messages; it is never parsed.
//! - `HACK_NO_INTERACTIVE=1` is always set: the app never answers prompts.

use crate::process::Child;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
    mpsc,
};
use std::thread;
use std::time::{Duration, Instant};

use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::models::{CliError, LogEvent};

const STDERR_KEEP: usize = 8 * 1024;
/// Most stdout kept from one command; more is an error (`OutputTooLarge`),
/// never silently parsed half-way. Far above any real `--json` result.
pub const MAX_STDOUT: usize = 64 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq)]
pub enum RunError {
    /// The `hack` executable was not found.
    NotFound,
    Spawn(String),
    Timeout {
        after: Duration,
    },
    /// The CLI returned an error envelope.
    Cli(CliError),
    /// Non-zero exit without an error envelope.
    Exit {
        code: Option<i32>,
        stderr: String,
    },
    /// stdout was not the JSON we expected.
    BadJson {
        error: String,
        stdout_head: String,
    },
}

impl std::fmt::Display for RunError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound => write!(f, "hack was not found on PATH"),
            Self::Spawn(e) => write!(f, "could not run hack: {e}"),
            Self::Timeout { after } => write!(f, "hack did not answer within {after:?}"),
            Self::Cli(e) => write!(f, "{}: {}", e.code, e.message),
            Self::Exit { code, stderr } => {
                write!(f, "hack exited with {code:?}: {}", stderr.trim())
            }
            Self::BadJson { error, .. } => write!(f, "unexpected output from hack: {error}"),
        }
    }
}

type VerifyProgram = fn(&Path) -> Result<(), RunError>;

#[derive(Debug, Clone)]
pub struct CliRunner {
    program: PathBuf,
    env: Vec<(String, String)>,
    cwd: Option<PathBuf>,
    /// `on_path` found no executable: spawn reports `NotFound`.
    missing: bool,
    /// How long a timed-out command gets after SIGTERM before SIGKILL.
    term_grace: Duration,
    /// Remove inherited variables that make interpreters load code.
    strip_startup: bool,
    /// Start every child from an empty environment plus `env` only.
    clear_env: bool,
    /// Refuse to run `program` unless no other user can change it or the
    /// directories above it ([`Self::verified`]).
    verify: Option<VerifyProgram>,
    /// The name [`Self::on_path`] searched for; [`Self::rediscover`] searches
    /// for it again.
    path_name: Option<String>,
    /// What the last [`Self::rediscover`] found, shared by every clone of an
    /// [`Self::on_path`] runner, so a CLI setup finds (installed since
    /// launch, or another one) is the one every read and action runs.
    pinned: Option<std::sync::Arc<std::sync::Mutex<Pin>>>,
}

/// What a switchable runner runs, shared by its clones.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
enum Pin {
    /// Nothing chosen since launch: the program found then, if any.
    #[default]
    Launch,
    /// Selected, or found and checked by [`CliRunner::rediscover`].
    Program(PathBuf),
    /// The last [`CliRunner::rediscover`] found nothing usable: run
    /// nothing, never the (unchecked) program found at launch or the
    /// selected one it refused. `candidate` is the explicit program it
    /// refused, which the next rediscovery checks again (a runner created
    /// by name searches PATH again instead).
    Refused { candidate: Option<PathBuf> },
}

impl CliRunner {
    fn pin(&self) -> Option<std::sync::MutexGuard<'_, Pin>> {
        self.pinned.as_ref().map(|slot| {
            slot.lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
        })
    }

    /// The pin now, for a later [`Self::settle_pin`].
    fn pin_now(&self) -> Option<Pin> {
        self.pin().map(|p| p.clone())
    }

    /// Record a rediscovery's outcome only if the pin is still what it was
    /// when the rediscovery began: a selection made meanwhile wins, and is
    /// never overwritten (or refused) by a check of the previous program.
    fn settle_pin(&self, seen: Option<&Pin>, next: Pin) {
        if let (Some(seen), Some(mut pin)) = (seen, self.pin())
            && *pin == *seen
        {
            *pin = next;
        }
    }
}

/// The selected CLI, refused when another user could change it.
fn trusted_cli(program: &Path) -> Result<(), RunError> {
    if std::fs::symlink_metadata(program).is_err() {
        return Err(RunError::NotFound);
    }
    // SAFETY: getuid has no preconditions and cannot fail.
    let uid = unsafe { libc::getuid() };
    crate::source::trusted_tool_path(program, uid, false)
        .filter(|real| crate::source::trusted_interpreter(real, uid, 4, false))
        .map(|_| ())
        .ok_or_else(|| {
            RunError::Spawn(
                "the selected hack is in a location other users can change; it was not run".into(),
            )
        })
}

/// Inherited variables that make a shell or language runtime load and run
/// code at startup, or preload libraries. Doctor's tool runs remove them.
pub const INTERPRETER_STARTUP_VARS: &[&str] = &[
    "BASH_ENV",
    "ENV",
    "SHELLOPTS",
    "BASHOPTS",
    "PS4",
    "ZDOTDIR",
    "PERL5OPT",
    "PERL5LIB",
    "PERLLIB",
    // Debugger code, used by a script started with a bare `-d`.
    "PERL5DB",
    "PYTHONSTARTUP",
    "PYTHONPATH",
    "PYTHONHOME",
    // Selects the user site directory, whose `usercustomize` Python imports
    // at startup. Doctor runs also set `PYTHONNOUSERSITE=1`.
    "PYTHONUSERBASE",
    // Library root, executable and virtual-environment selection: each can
    // move where Python imports its standard library and `site` from.
    "PYTHONPLATLIBDIR",
    "PYTHONEXECUTABLE",
    "__PYVENV_LAUNCHER__",
    "RUBYOPT",
    "RUBYLIB",
    // A Gemfile RubyGems evaluates at start-up, and the gem repositories
    // and Bundler Gemfile a Ruby tool loads gems from.
    "RUBYGEMS_GEMDEPS",
    "GEM_HOME",
    "GEM_PATH",
    "BUNDLE_GEMFILE",
    "NODE_OPTIONS",
    "NODE_PATH",
    // The Hack CLI is a Bun-compiled binary: these make its runtime preload
    // code (the same set the CLI removes before re-executing itself).
    "BUN_OPTIONS",
    "BUN_BE_BUN",
];

/// Every variable with one of these prefixes is removed too: all dynamic
/// loader controls (`LD_*`, `DYLD_*`, including versioned and fallback search
/// paths), exported Bash functions, and Bun runtime configuration and
/// inspector settings.
pub const INTERPRETER_STARTUP_PREFIXES: &[&str] =
    &["LD_", "DYLD_", "BASH_FUNC_", "BUN_CONFIG_", "BUN_INSPECT"];

fn is_startup_var(name: &std::ffi::OsStr) -> bool {
    let bytes = name.as_encoded_bytes();
    INTERPRETER_STARTUP_VARS
        .iter()
        .any(|v| bytes == v.as_bytes())
        || INTERPRETER_STARTUP_PREFIXES
            .iter()
            .any(|p| bytes.starts_with(p.as_bytes()))
}

/// Default grace after SIGTERM. The CLI forwards SIGTERM to the detached
/// subprocess groups it owns (for example a Compose build) and waits for
/// them; SIGKILL alone would orphan those and kill the CLI's own timer.
pub const TERM_GRACE: Duration = Duration::from_secs(15);

impl CliRunner {
    /// Run `program` (normally `hack`, resolved through PATH).
    #[must_use]
    pub fn new(program: impl Into<PathBuf>) -> Self {
        Self {
            program: program.into(),
            env: vec![("HACK_NO_INTERACTIVE".into(), "1".into())],
            cwd: None,
            missing: false,
            term_grace: TERM_GRACE,
            strip_startup: false,
            clear_env: false,
            verify: None,
            path_name: None,
            pinned: None,
        }
    }

    /// Run `program` (absolute), switchable later with [`Self::select`]:
    /// every clone follows. The app's own runner is one of these.
    #[must_use]
    pub fn selectable(program: impl Into<PathBuf>) -> Self {
        let program = program.into();
        let mut runner = Self::new(program.clone());
        runner.pinned = Some(std::sync::Arc::new(std::sync::Mutex::new(Pin::Program(
            program,
        ))));
        runner
    }

    /// No usable CLI: every command reports `NotFound` and nothing is
    /// started, until [`Self::select`] or setup's [`Self::rediscover`]
    /// gives it one.
    #[must_use]
    pub fn unavailable(name: &str) -> Self {
        let mut runner = Self::new(name);
        runner.missing = true;
        // Setup's recheck searches PATH for it again (`rediscover`).
        runner.path_name = Some(name.into());
        runner.pinned = Some(std::sync::Arc::default());
        runner
    }

    /// This runner's settings with another (absolute) program, not switchable.
    #[must_use]
    pub fn with_program(&self, program: &Path) -> Self {
        Self {
            program: program.to_path_buf(),
            missing: false,
            pinned: None,
            ..self.clone()
        }
    }

    /// This runner with its current program fixed: later [`Self::select`]
    /// calls do not change it. One read uses one of these throughout.
    #[must_use]
    pub fn fixed(&self) -> Self {
        let program = self.current_program();
        Self {
            program: program.clone().unwrap_or_else(|| self.program.clone()),
            missing: program.is_none(),
            pinned: None,
            ..self.clone()
        }
    }

    /// Run `program` from now on, in this runner and every clone of it. A
    /// runner that is not [`Self::selectable`] (or [`Self::on_path`]) is
    /// unchanged.
    pub fn select(&self, program: &Path) {
        if let Some(mut pin) = self.pin() {
            *pin = Pin::Program(program.to_path_buf());
        }
    }

    /// The executable to start now: the selected one, else `program`
    /// (`None` when [`Self::on_path`] found nothing, or when the last
    /// [`Self::rediscover`] refused what it found).
    fn current_program(&self) -> Option<PathBuf> {
        match self.pin().as_deref() {
            Some(Pin::Program(p)) => Some(p.clone()),
            Some(Pin::Refused { .. }) => None,
            Some(Pin::Launch) | None => (!self.missing).then(|| self.program.clone()),
        }
    }

    /// Run the absolute `program` only after checking that no other user
    /// can change it or the directories above it (setup and its fixes).
    #[must_use]
    pub fn verified(program: impl Into<PathBuf>) -> Self {
        let mut runner = Self::new(program);
        runner.verify = Some(trusted_cli);
        runner
    }

    /// Start every child from an empty environment plus the variables
    /// given with [`Self::with_env`] (a checked execution context).
    #[must_use]
    pub fn with_clean_env(mut self) -> Self {
        self.clear_env = true;
        self
    }

    /// The executable this runner starts: checked when it is
    /// [`Self::verified`], found on `PATH` when created by name.
    ///
    /// # Errors
    /// `NotFound`, or `Spawn` for a verified CLI others can change.
    pub fn resolve_program(&self) -> Result<PathBuf, RunError> {
        let program = self.program_path().ok_or(RunError::NotFound)?;
        if let Some(verify) = self.verify {
            verify(&program)?;
        }
        Ok(program)
    }

    /// Search `PATH` again (the runner's own `PATH` when it sets one) for
    /// the program this runner was created for by name ([`Self::on_path`]),
    /// or check its explicit program, and return it only when no other user
    /// can change it. Setup's explicit recheck uses this,
    /// so a CLI installed since the app started is found.
    ///
    /// # Errors
    /// `NotFound`, or `Spawn` for a CLI in a location others can change.
    pub fn rediscover(&self) -> Result<PathBuf, RunError> {
        let Some(name) = &self.path_name else {
            // Created with an explicit program: that is the one to check,
            // the selected one included, even after it was refused.
            let seen = self.pin_now();
            let candidate = match &seen {
                Some(Pin::Program(p)) => Some(p.clone()),
                Some(Pin::Refused { candidate }) => candidate.clone(),
                Some(Pin::Launch) | None => None,
            };
            let Some(candidate) = candidate else {
                return self
                    .resolve_program()
                    .and_then(|p| trusted_cli(&p).map(|()| p));
            };
            let checked = trusted_cli(&candidate).map(|()| candidate.clone());
            self.settle_pin(
                seen.as_ref(),
                match &checked {
                    Ok(p) => Pin::Program(p.clone()),
                    Err(_) => Pin::Refused {
                        candidate: Some(candidate),
                    },
                },
            );
            return checked;
        };
        let seen = self.pin_now();
        let found = resolve_on_path(name, self.effective_env("PATH").as_deref())
            .ok_or(RunError::NotFound)
            .and_then(|p| trusted_cli(&p).map(|()| p));
        self.settle_pin(
            seen.as_ref(),
            match &found {
                Ok(p) => Pin::Program(p.clone()),
                Err(_) => Pin::Refused { candidate: None },
            },
        );
        found
    }

    /// Change the SIGTERM-to-SIGKILL grace for timed-out commands.
    #[must_use]
    pub fn with_term_grace(mut self, grace: Duration) -> Self {
        self.term_grace = grace;
        self
    }

    /// Find `name` on `PATH` and run it by absolute path.
    ///
    /// Only absolute `PATH` entries are searched: an empty or relative entry
    /// (such as `.`) would resolve against the working directory, which may
    /// differ from the user's checkout for machine checks. When nothing is
    /// found the runner reports `NotFound` without
    /// spawning anything.
    #[must_use]
    pub fn on_path(name: &str) -> Self {
        let path = std::env::var_os("PATH");
        let mut r = match resolve_on_path(name, path.as_deref()) {
            Some(p) => Self::new(p),
            None => {
                let mut r = Self::new(name);
                r.missing = true;
                r
            }
        };
        r.path_name = Some(name.into());
        r.pinned = Some(std::sync::Arc::default());
        r
    }

    /// Run every command from `dir` (for checks that must run outside any
    /// project, such as the machine-level doctor run).
    #[must_use]
    pub fn with_cwd(mut self, dir: impl Into<PathBuf>) -> Self {
        self.cwd = Some(dir.into());
        self
    }

    /// Add an environment variable for every command (tests use this for
    /// a temporary `HACK_HOME`).
    #[must_use]
    pub fn with_env(mut self, key: &str, value: &str) -> Self {
        self.env.push((key.into(), value.into()));
        self
    }

    /// Effective selector without reading any configuration or secret value.
    /// Remove inherited interpreter startup and preload variables
    /// ([`INTERPRETER_STARTUP_VARS`] and exported Bash functions) from every
    /// child, so a tool script cannot be made to load code from the
    /// environment.
    #[must_use]
    pub fn without_interpreter_startup(mut self) -> Self {
        self.strip_startup = true;
        self
    }

    /// The absolute executable this runner would start, without starting it.
    pub(crate) fn program_path(&self) -> Option<PathBuf> {
        let program = self.current_program()?;
        if program.is_absolute() {
            return Some(program);
        }
        let name = program.to_str()?;
        resolve_on_path(name, self.env_value("PATH").as_deref())
    }

    pub(crate) fn env_value(&self, key: &str) -> Option<std::ffi::OsString> {
        self.effective_env(key)
    }

    /// The value `key` has for this runner's children: set with
    /// [`Self::with_env`], else inherited (never with a clean environment).
    pub fn effective_env(&self, key: &str) -> Option<std::ffi::OsString> {
        self.env
            .iter()
            .rev()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.into())
            .or_else(|| {
                if self.clear_env {
                    None
                } else {
                    std::env::var_os(key)
                }
            })
    }

    #[cfg(test)]
    fn command(&self, args: &[&str], path: Option<&Path>, program: &Path) -> Command {
        self.command_io(args, path, program, false)
    }

    /// [`Self::command`], with stdin a pipe when `input` (a value the
    /// caller writes, see [`Self::run_raw_with_input`]), else empty.
    fn command_io(
        &self,
        args: &[&str],
        path: Option<&Path>,
        program: &Path,
        input: bool,
    ) -> Command {
        use std::os::unix::process::CommandExt;
        let mut cmd = Command::new(program);
        cmd.args(args);
        if let Some(p) = path {
            cmd.arg("--path").arg(p);
        }
        if self.clear_env {
            cmd.env_clear();
        }
        // Children (and their own children, such as `docker` run by
        // `hack doctor`) get a PATH with only absolute entries: an empty or
        // relative entry would resolve against the working directory.
        if let Some(path) = self.effective_env("PATH") {
            cmd.env("PATH", sanitize_path(&path));
        }
        for (k, v) in &self.env {
            if k == "PATH" {
                continue; // set above, sanitized
            }
            cmd.env(k, v);
        }
        if self.strip_startup {
            for key in INTERPRETER_STARTUP_VARS {
                cmd.env_remove(key);
            }
            // Prefix matches cover inherited and runner-set names alike. Only
            // names are read here, never values.
            let inherited = std::env::vars_os().map(|(key, _)| key);
            let authored = self.env.iter().map(|(key, _)| key.into());
            for key in inherited.chain(authored) {
                if is_startup_var(&key) {
                    cmd.env_remove(key);
                }
            }
            // Python skips the user site directory (and its `usercustomize`)
            // whatever its default location.
            cmd.env("PYTHONNOUSERSITE", "1");
        }
        if let Some(dir) = &self.cwd {
            cmd.current_dir(dir);
        }
        cmd.stdin(if input { Stdio::piped() } else { Stdio::null() })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0);
        cmd
    }

    fn spawn(&self, args: &[&str], path: Option<&Path>) -> Result<Child, RunError> {
        self.spawn_io(args, path, false)
    }

    fn spawn_io(&self, args: &[&str], path: Option<&Path>, input: bool) -> Result<Child, RunError> {
        let program = self.current_program().ok_or(RunError::NotFound)?;
        if let Some(verify) = self.verify {
            verify(&program)?;
        }
        // ETXTBSY: the executable was just written (a fresh upgrade, or a test
        // script whose write descriptor a concurrent fork still holds). Retry
        // briefly instead of reporting a spawn failure.
        let mut attempt = 0;
        loop {
            match crate::process::spawn_with(
                &mut self.command_io(args, path, &program, input),
                !self.clear_env,
                input,
            ) {
                Ok(c) => return Ok(c),
                Err(e) if e.raw_os_error() == Some(libc::ETXTBSY) && attempt < 20 => {
                    attempt += 1;
                    thread::sleep(Duration::from_millis(10));
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    return Err(RunError::NotFound);
                }
                Err(e) => return Err(RunError::Spawn(e.to_string())),
            }
        }
    }

    /// Run and return raw stdout, stderr tail and exit code.
    ///
    /// # Errors
    /// `NotFound`, `Spawn` or `Timeout`.
    pub fn run_raw(
        &self,
        args: &[&str],
        path: Option<&Path>,
        timeout: Duration,
    ) -> Result<(String, String, Option<i32>), RunError> {
        self.run_inner(args, path, Some(timeout))
    }

    /// [`Self::run_raw`] with `input` written to the command's stdin, which
    /// is then closed. For a value the CLI reads with `--value-stdin`: it
    /// never appears in argv or the environment. Nothing here keeps or
    /// prints `input`.
    ///
    /// # Errors
    /// `NotFound`, `Spawn` or `Timeout`.
    pub fn run_raw_with_input(
        &self,
        args: &[&str],
        path: Option<&Path>,
        timeout: Duration,
        input: &[u8],
    ) -> Result<(String, String, Option<i32>), RunError> {
        self.run_io(args, path, Some(timeout), Some(input))
    }

    /// Run with no deadline from the app: wait until the command exits and
    /// its output pipes close. For lifecycle commands, whose timeouts the
    /// CLI owns; terminating them from outside can orphan the detached
    /// build subprocesses the CLI starts.
    ///
    /// # Errors
    /// Any [`RunError`] except `Timeout`.
    pub fn run_json_to_completion<T: DeserializeOwned>(
        &self,
        args: &[&str],
        path: Option<&Path>,
    ) -> Result<T, RunError> {
        let (stdout, stderr, code) = self.run_inner(args, path, None)?;
        let value = parse_result(&stdout, &stderr, code)?;
        serde_json::from_value(value).map_err(|e| RunError::BadJson {
            error: e.to_string(),
            stdout_head: head(&stdout),
        })
    }

    fn run_inner(
        &self,
        args: &[&str],
        path: Option<&Path>,
        timeout: Option<Duration>,
    ) -> Result<(String, String, Option<i32>), RunError> {
        self.run_io(args, path, timeout, None)
    }

    fn run_io(
        &self,
        args: &[&str],
        path: Option<&Path>,
        timeout: Option<Duration>,
        input: Option<&[u8]>,
    ) -> Result<(String, String, Option<i32>), RunError> {
        // The timeout counts from before the spawn: starting the program can
        // itself take time (an ETXTBSY retry, or macOS checking a new
        // executable on first launch). A caller that budgets `timeout` plus
        // the SIGTERM grace gets an end by `deadline + term_grace`: the grace
        // is cut to what is left of that. Limit: a spawn that itself blocks
        // past that point cannot be interrupted, and the call ends when the
        // spawn returns and the group is killed.
        let deadline = timeout.map(|t| (Instant::now() + t, t));
        let term_grace = self.term_grace;
        let grace_left =
            move |d: Instant| (d + term_grace).saturating_duration_since(Instant::now());
        let mut child = self.spawn_io(args, path, input.is_some())?;
        // Written on its own thread so a child that does not read cannot
        // block this one; closing the pipe ends the input. A child that
        // exits early makes the write fail (EPIPE), which is not an error.
        let writer = match (input, child.stdin.take()) {
            (Some(bytes), Some(stdin)) => {
                let bytes = bytes.to_vec();
                let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
                let stop = cancel.clone();
                let (done, written) = mpsc::channel::<()>();
                let handle = thread::spawn(move || {
                    write_cancellable(stdin, &bytes, &stop);
                    let _ = done.send(());
                });
                Some((
                    WriterGuard {
                        handle: Some(handle),
                        cancel,
                    },
                    written,
                ))
            }
            _ => None,
        };
        let out = read_all(child.stdout.take(), Keep::Head(MAX_STDOUT));
        let err = read_all(child.stderr.take(), Keep::Tail(STDERR_KEEP));
        let status = loop {
            match child.try_wait() {
                Ok(Some(s)) => break s,
                Ok(None) if deadline.is_some_and(|(d, _)| Instant::now() >= d) => {
                    let grace = deadline.map_or(self.term_grace, |(d, _)| grace_left(d));
                    terminate_group(&mut child, grace);
                    let after = deadline.map_or(Duration::ZERO, |(_, t)| t);
                    return Err(RunError::Timeout { after });
                }
                Ok(None) => thread::sleep(Duration::from_millis(10)),
                Err(e) => return Err(RunError::Spawn(e.to_string())),
            }
        };
        // A deadline also covers draining: a descendant that keeps a pipe
        // open after `hack` exits must not hold the caller past the timeout.
        // Without a deadline, wait for the pipes to close.
        let drain = |rx: &mpsc::Receiver<Drained>, child: &mut Child| match deadline {
            Some((d, t)) => {
                let left = d.saturating_duration_since(Instant::now());
                rx.recv_timeout(left).map_err(|_| {
                    terminate_group(child, grace_left(d));
                    RunError::Timeout { after: t }
                })
            }
            None => rx
                .recv()
                .map_err(|_| RunError::Spawn("output reader stopped".into())),
        };
        let stdout = drain(&out, &mut child)?;
        let stderr = drain(&err, &mut child)?;
        if let Some(e) = stdout.error.as_ref().or(stderr.error.as_ref()) {
            return Err(RunError::Spawn(format!(
                "reading the command's output failed: {e}"
            )));
        }
        if stdout.overflow {
            return Err(RunError::BadJson {
                error: format!("output larger than {MAX_STDOUT} bytes"),
                stdout_head: head(&stdout.text),
            });
        }
        // The command has exited, but a descendant may still hold its stdin
        // without reading, which blocks the write. The deadline covers that
        // too: past it, the group ends, its end of the pipe closes, and the
        // write fails.
        if let Some((guard, written)) = writer {
            let finished = match deadline {
                Some((d, t)) => {
                    let left = d.saturating_duration_since(Instant::now());
                    written.recv_timeout(left).map_err(|_| {
                        // A reader outside the group (its own session) can
                        // keep the pipe open after the group ends: the
                        // writer stops on its own when told.
                        guard.cancel();
                        terminate_group(&mut child, grace_left(d));
                        RunError::Timeout { after: t }
                    })
                }
                None => written
                    .recv()
                    .map_err(|_| RunError::Spawn("input writer stopped".into())),
            };
            drop(guard);
            finished?;
        }
        Ok((stdout.text, stderr.text, status.code()))
    }

    /// Run a `--json` command and deserialize its (unwrapped) result.
    ///
    /// # Errors
    /// Any [`RunError`].
    pub fn run_json<T: DeserializeOwned>(
        &self,
        args: &[&str],
        path: Option<&Path>,
        timeout: Duration,
    ) -> Result<T, RunError> {
        let (stdout, stderr, code) = self.run_raw(args, path, timeout)?;
        let value = parse_result(&stdout, &stderr, code)?;
        serde_json::from_value(value).map_err(|e| RunError::BadJson {
            error: e.to_string(),
            stdout_head: head(&stdout),
        })
    }

    /// Run a HACK-2218 command with a required envelope and payload schema.
    /// Legacy JSON commands continue to use `run_json`.
    pub fn run_schema_json<T: DeserializeOwned>(
        &self,
        args: &[&str],
        path: Option<&Path>,
        timeout: Duration,
        schema: &str,
    ) -> Result<T, RunError> {
        let (stdout, stderr, code) = self.run_raw(args, path, timeout)?;
        let value = parse_schema_result(&stdout, &stderr, code, schema)?;
        serde_json::from_value(value).map_err(|e| RunError::BadJson {
            error: e.to_string(),
            stdout_head: head(&stdout),
        })
    }

    /// Read the running CLI version through the schema-tagged JSON contract.
    ///
    /// # Errors
    /// Any [`RunError`], including an unsupported or missing schema.
    pub fn version(&self, timeout: Duration) -> Result<String, RunError> {
        #[derive(serde::Deserialize)]
        struct Version {
            version: String,
        }
        let report: Version =
            self.run_schema_json(&["version", "--json"], None, timeout, "hack.version.v1")?;
        if report.version.is_empty() {
            return Err(RunError::BadJson {
                error: "empty version".into(),
                stdout_head: String::new(),
            });
        }
        Ok(report.version)
    }

    /// Start a long-running ndjson stream (`hack logs --json ...`).
    ///
    /// # Errors
    /// `NotFound` or `Spawn`.
    pub fn stream_logs(&self, args: &[&str], path: Option<&Path>) -> Result<LogStream, RunError> {
        let mut child = self.spawn(args, path)?;
        // Diagnostics must not fill the stderr pipe and block ndjson output.
        // Drain concurrently with a bounded tail, as for finite CLI reads.
        let stderr = read_all(child.stderr.take(), Keep::Tail(STDERR_KEEP));
        let stdout = child.stdout.take();
        // Never block on the UI: the CLI ignores stdout backpressure and
        // would otherwise buffer output in its own process without a bound.
        let (tx, rx) = mpsc::sync_channel(STREAM_QUEUE);
        let skipped = Arc::new(AtomicU64::new(0));
        let reader_skipped = skipped.clone();
        let reader = thread::spawn(move || {
            let mut diagnostics = String::new();
            let Some(stdout) = stdout else {
                return diagnostics;
            };
            let mut r = BufReader::new(stdout);
            while let Some((line, cut)) = read_bounded_line(&mut r, MAX_RAW_LINE) {
                if line.trim().is_empty() {
                    continue;
                }
                // A record cut at MAX_RAW_LINE is no longer valid JSON: show
                // a visible marker instead of dropping it silently.
                let mut event = if cut {
                    oversized_record_event()
                } else {
                    match serde_json::from_str::<LogEvent>(&line) {
                        Ok(event) if !event.kind.is_empty() => event,
                        _ => {
                            append_diagnostic(&mut diagnostics, &line);
                            LogEvent {
                                kind: "notice".into(),
                                message: Some(line),
                                ..LogEvent::default()
                            }
                        }
                    }
                };
                // Cap before queueing, so the queue's memory is bounded too.
                cap_event(&mut event);
                match tx.try_send(event) {
                    Ok(()) => {}
                    Err(mpsc::TrySendError::Full(_)) => {
                        reader_skipped.fetch_add(1, Ordering::Relaxed);
                    }
                    Err(mpsc::TrySendError::Disconnected(_)) => break,
                }
            }
            diagnostics
        });
        Ok(LogStream {
            child,
            rx: Some(rx),
            reader: Some(reader),
            skipped,
            stderr,
            stdout_diagnostics: String::new(),
            stderr_diagnostics: None,
            reaped: false,
        })
    }
}

/// Keep only a bounded UTF-8 diagnostic tail, including pretty JSON fragments.
fn append_diagnostic(text: &mut String, line: &str) {
    text.push_str(line);
    text.push('\n');
    if text.len() > STDERR_KEEP {
        let mut cut = text.len() - STDERR_KEEP;
        while !text.is_char_boundary(cut) {
            cut += 1;
        }
        *text = text[cut..].to_owned();
    }
}

/// Events queued between the reader thread and the UI.
pub const STREAM_QUEUE: usize = 1024;
/// Cap for the top-level `message` of an event (notices, errors).
pub const MAX_NOTICE_BYTES: usize = 4 * 1024;
/// Cap for every other short text field (kind, timestamps, service, ...).
pub const MAX_FIELD_BYTES: usize = 256;
/// Upper bound on the text one queued event retains after `cap_event`:
/// the log message, the notice message and eight short fields.
pub const MAX_EVENT_BYTES: usize =
    crate::logs::MAX_LINE_BYTES + MAX_NOTICE_BYTES + 8 * MAX_FIELD_BYTES;
/// Upper bound on queued text: `STREAM_QUEUE * MAX_EVENT_BYTES` (~70 MiB).
pub const MAX_QUEUED_BYTES: usize = STREAM_QUEUE * MAX_EVENT_BYTES;

/// Bound every text field an event retains, so one event never holds more
/// than `MAX_EVENT_BYTES` (cut on a character boundary into a new, small
/// string). A capped log message marks its entry truncated.
fn cap_event(e: &mut LogEvent) {
    fn cap(s: &mut String, max: usize) -> bool {
        if s.len() <= max {
            return false;
        }
        let mut keep = max;
        while !s.is_char_boundary(keep) {
            keep -= 1;
        }
        *s = s[..keep].to_owned();
        true
    }
    fn cap_opt(s: &mut Option<String>, max: usize) {
        if let Some(v) = s.as_mut() {
            cap(v, max);
        }
    }
    cap(&mut e.kind, MAX_FIELD_BYTES);
    cap_opt(&mut e.ts, MAX_FIELD_BYTES);
    cap_opt(&mut e.backend, MAX_FIELD_BYTES);
    cap_opt(&mut e.reason, MAX_FIELD_BYTES);
    cap_opt(&mut e.message, MAX_NOTICE_BYTES);
    if let Some(entry) = e.entry.as_mut() {
        cap_opt(&mut entry.service, MAX_FIELD_BYTES);
        cap_opt(&mut entry.stream, MAX_FIELD_BYTES);
        cap_opt(&mut entry.timestamp, MAX_FIELD_BYTES);
        cap_opt(&mut entry.level, MAX_FIELD_BYTES);
        if cap(&mut entry.message, crate::logs::MAX_LINE_BYTES) {
            entry.truncated = Some(true);
        }
    }
}

/// Text bytes an event retains (for the bound's test).
#[cfg(test)]
fn event_bytes(e: &LogEvent) -> usize {
    let o = |s: &Option<String>| s.as_ref().map_or(0, String::len);
    e.kind.len()
        + o(&e.ts)
        + o(&e.backend)
        + o(&e.reason)
        + o(&e.message)
        + e.entry.as_ref().map_or(0, |x| {
            x.message.len() + o(&x.service) + o(&x.stream) + o(&x.timestamp) + o(&x.level)
        })
}

/// Longest raw ndjson line read; the rest of a longer line is skipped.
pub const MAX_RAW_LINE: usize = 1024 * 1024;

/// Read one `\n`-terminated line, keeping at most `max` bytes of it.
/// `None` at end of input (or on a read error).
fn read_bounded_line<R: BufRead>(r: &mut R, max: usize) -> Option<(String, bool)> {
    let mut buf = Vec::new();
    let mut saw_any = false;
    let mut cut = false;
    loop {
        let chunk = r.fill_buf().ok()?;
        if chunk.is_empty() {
            return saw_any.then(|| (String::from_utf8_lossy(&buf).into_owned(), cut));
        }
        saw_any = true;
        let (take, done) = match chunk.iter().position(|b| *b == b'\n') {
            Some(i) => (i, true),
            None => (chunk.len(), false),
        };
        let room = max.saturating_sub(buf.len());
        cut |= take > room;
        buf.extend_from_slice(&chunk[..take.min(room)]);
        r.consume(if done { take + 1 } else { take });
        if done {
            return Some((String::from_utf8_lossy(&buf).into_owned(), cut));
        }
    }
}

/// Shown in place of a record longer than `MAX_RAW_LINE`.
fn oversized_record_event() -> LogEvent {
    LogEvent {
        kind: "log".into(),
        entry: Some(crate::models::LogEntry {
            service: None,
            message: format!(
                "[a log record over {} KB was dropped by the app; use Copy command to read it in a terminal]",
                MAX_RAW_LINE / 1024
            ),
            stream: None,
            timestamp: None,
            level: Some("warn".into()),
            truncated: Some(true),
        }),
        ..LogEvent::default()
    }
}

/// One poll of a stream: up to `max` events, and the exit code once the
/// process has exited **and** retained events have been delivered. Queue
/// overflow is discarded and reported separately in `skipped`.
#[derive(Debug, Default)]
pub struct StreamPoll {
    pub events: Vec<LogEvent>,
    pub exit: Option<Option<i32>>,
    /// Events discarded while the UI queue was full since the previous poll.
    pub skipped: u64,
}

/// A running log stream. Drop retries group cleanup for at most two seconds,
/// then detaches a reader still held open by a descendant outside that group.
pub struct LogStream {
    child: Child,
    /// `None` only while dropping (see `Drop`).
    rx: Option<mpsc::Receiver<LogEvent>>,
    reader: Option<thread::JoinHandle<String>>,
    skipped: Arc<AtomicU64>,
    stderr: mpsc::Receiver<Drained>,
    stdout_diagnostics: String,
    stderr_diagnostics: Option<Drained>,
    /// `poll` observed the exit and reaped the child: its PID (and group id)
    /// may now belong to another process, so Drop must not signal it.
    reaped: bool,
}

impl LogStream {
    /// Events received so far, without blocking.
    pub fn drain(&self) -> Vec<LogEvent> {
        self.rx
            .as_ref()
            .map(|rx| rx.try_iter().collect())
            .unwrap_or_default()
    }

    /// Wait up to `timeout` for the next event.
    pub fn next_timeout(&self, timeout: Duration) -> Option<LogEvent> {
        self.rx.as_ref()?.recv_timeout(timeout).ok()
    }

    /// Up to `max` queued events. `exit` is set only when the reader has
    /// reached end of output and the queue is empty; overflow is reported
    /// separately. Its inner value is `None` when a signal ended the process.
    pub fn poll(&mut self, max: usize) -> StreamPoll {
        // Checked before draining: once the reader is done, nothing new
        // arrives, so an under-full batch means the queue is exhausted.
        let reader_done = self
            .reader
            .as_ref()
            .is_none_or(thread::JoinHandle::is_finished);
        let mut events: Vec<LogEvent> = self
            .rx
            .as_ref()
            .map(|rx| rx.try_iter().take(max).collect())
            .unwrap_or_default();
        let mut exit = if reader_done && events.len() < max {
            if let Some(reader) = self.reader.take() {
                self.stdout_diagnostics = reader.join().unwrap_or_default();
            }
            let status = self.child.try_wait().ok().flatten();
            self.reaped |= status.is_some();
            status.map(|s| s.code())
        } else {
            None
        };
        if exit.is_some() && self.stderr_diagnostics.is_none() {
            match self.stderr.try_recv() {
                Ok(diagnostics) => self.stderr_diagnostics = Some(diagnostics),
                Err(mpsc::TryRecvError::Empty) => exit = None,
                Err(mpsc::TryRecvError::Disconnected) => {}
            }
        }
        if let Some(code) = exit.filter(|code| *code != Some(0)) {
            let stderr = self
                .stderr_diagnostics
                .as_ref()
                .map_or("", |d| d.text.as_str());
            let reason = match parse_result(&self.stdout_diagnostics, stderr, code) {
                Err(RunError::Cli(error)) => error.message,
                _ if !stderr.trim().is_empty() => stderr.trim().to_owned(),
                _ => self.stdout_diagnostics.trim().to_owned(),
            };
            if !reason.is_empty() {
                let mut event = LogEvent {
                    kind: "error".into(),
                    message: Some(reason),
                    ..LogEvent::default()
                };
                cap_event(&mut event);
                events.push(event);
            }
        }
        StreamPoll {
            events,
            exit,
            skipped: self.skipped.swap(0, Ordering::Relaxed),
        }
    }
}

impl Drop for LogStream {
    fn drop(&mut self) {
        // Disconnect before signalling the owned process group and joining.
        drop(self.rx.take());
        if self.reaped {
            // Already reaped by `poll`, which also joined the reader.
            return;
        }
        signal_kill_group(&mut self.child);
        if let Some(r) = self.reader.take() {
            // A group signal can race a descendant fork on macOS. Keep the
            // leader unreaped while retrying, preserving ownership of its PID
            // and catching late members of the same process group.
            let until = Instant::now() + Duration::from_secs(2);
            while !r.is_finished() && Instant::now() < until {
                thread::sleep(Duration::from_millis(20));
                signal_kill_group(&mut self.child);
            }
            // A descendant may have left our group while keeping stdout open.
            // Detach that reader rather than block the dropping UI thread.
            if r.is_finished() {
                let _ = r.join();
            }
        }
        let _ = self.child.wait();
    }
}

#[must_use]
pub fn exit_description(code: Option<i32>) -> String {
    code.map_or_else(|| "killed by signal".into(), |code| format!("exit {code}"))
}

/// Which part of a pipe to keep while draining it.
#[derive(Clone, Copy)]
enum Keep {
    /// The first `n` bytes; anything beyond marks the output as too large.
    Head(usize),
    /// Only the last `n` bytes (a rolling window).
    Tail(usize),
}

/// What a drained pipe yielded.
struct Drained {
    text: String,
    overflow: bool,
    /// A read failed before end of file: the output is incomplete.
    error: Option<String>,
}

/// Read a pipe to EOF on a thread, keeping memory bounded the whole time
/// (a lifecycle command can run for hours and print without limit).
fn read_all<R: Read + Send + 'static>(r: Option<R>, keep: Keep) -> mpsc::Receiver<Drained> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut buf: Vec<u8> = Vec::new();
        let mut overflow = false;
        let mut error = None;
        if let Some(mut r) = r {
            let mut chunk = [0u8; 16 * 1024];
            loop {
                let n = match r.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(n) => n,
                    // A signal interrupted the read; nothing was lost.
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(e) => {
                        error = Some(e.to_string());
                        break;
                    }
                };
                match keep {
                    Keep::Head(max) => {
                        let room = max.saturating_sub(buf.len());
                        buf.extend_from_slice(&chunk[..n.min(room)]);
                        overflow |= n > room;
                    }
                    Keep::Tail(max) => {
                        buf.extend_from_slice(&chunk[..n]);
                        if buf.len() > max {
                            let cut = buf.len() - max;
                            buf.drain(..cut);
                        }
                    }
                }
            }
        }
        let _ = tx.send(Drained {
            text: String::from_utf8_lossy(&buf).into_owned(),
            overflow,
            error,
        });
    });
    rx
}

/// Used when no absolute `PATH` entry remains: an empty `PATH` would make
/// a shell search its working directory.
pub const FALLBACK_PATH: &str = "/usr/local/bin:/usr/bin:/bin";

/// `PATH` with empty and relative entries removed; never empty.
#[must_use]
pub fn sanitize_path(path: &std::ffi::OsStr) -> std::ffi::OsString {
    let kept = std::env::join_paths(std::env::split_paths(path).filter(|d| d.is_absolute()))
        .unwrap_or_default();
    if kept.is_empty() {
        std::ffi::OsString::from(FALLBACK_PATH)
    } else {
        kept
    }
}

/// Search absolute `PATH` entries for an executable regular file `name`.
#[must_use]
pub fn resolve_on_path(name: &str, path: Option<&std::ffi::OsStr>) -> Option<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    if name.contains('/') {
        let p = PathBuf::from(name);
        return p.is_absolute().then_some(p);
    }
    std::env::split_paths(path?)
        .filter(|dir| dir.is_absolute())
        .map(|dir| dir.join(name))
        .find(|p| {
            std::fs::metadata(p).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        })
}

/// Ask the process group to stop (SIGTERM), give the CLI `grace` to retire
/// the subprocesses it owns, then SIGKILL whatever is left of the group and
/// reap. Returns only once the direct child has exited.
/// The stdin writer of one run. Dropping it, on every exit path including
/// early returns (a leader timeout, a failed drain), stops the writer and
/// waits for it, so no thread keeps the input or the pipe after the call.
struct WriterGuard {
    handle: Option<thread::JoinHandle<()>>,
    cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl WriterGuard {
    fn cancel(&self) {
        self.cancel.store(true, std::sync::atomic::Ordering::SeqCst);
    }
}

impl Drop for WriterGuard {
    fn drop(&mut self) {
        // A finished writer ignores this; a blocked one stops within a poll.
        self.cancel();
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

/// Write `bytes` to a child's stdin, then close it. The descriptor is made
/// non-blocking and the write waits in short polls, so `cancel` stops it even
/// when a reader holds the pipe open without reading (a descendant in
/// another process group). Errors (the reader went away) end the write.
fn write_cancellable<W>(mut stdin: W, bytes: &[u8], cancel: &std::sync::atomic::AtomicBool)
where
    W: std::io::Write + std::os::fd::AsRawFd,
{
    let fd = stdin.as_raw_fd();
    // SAFETY: fd is the live write end this function owns through `stdin`.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return;
    }
    let mut off = 0;
    while off < bytes.len() && !cancel.load(std::sync::atomic::Ordering::SeqCst) {
        match stdin.write(&bytes[off..]) {
            Ok(0) => return,
            Ok(n) => off += n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                let mut pfd = libc::pollfd {
                    fd,
                    events: libc::POLLOUT,
                    revents: 0,
                };
                // SAFETY: one valid pollfd for a live descriptor; 50 ms bound.
                unsafe { libc::poll(&mut pfd, 1, 50) };
            }
            Err(_) => return,
        }
    }
    // `stdin` drops here: closing it ends the input.
}

fn terminate_group(child: &mut Child, grace: Duration) {
    if let Ok(pid) = i32::try_from(child.id()) {
        // SAFETY: plain syscall on the group we created with process_group(0).
        unsafe {
            libc::kill(-pid, libc::SIGTERM);
        }
    }
    let until = Instant::now() + grace;
    while Instant::now() < until {
        if matches!(child.try_wait(), Ok(Some(_))) {
            break;
        }
        thread::sleep(Duration::from_millis(20));
    }
    kill_group(child);
}

fn kill_group(child: &mut Child) {
    if let Ok(pid) = i32::try_from(child.id()) {
        // SAFETY: plain syscall on the group we created with process_group(0).
        unsafe {
            libc::kill(-pid, libc::SIGKILL);
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(test)]
thread_local! {
    /// Group signals sent by this thread (tests prove a reaped stream sends none).
    static GROUP_SIGNALS: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
}

/// Only for the log-drop path, which has not reaped its child. Avoid
/// Child::kill here: its status check may reap and release the PID reservation.
fn signal_kill_group(child: &mut Child) {
    #[cfg(test)]
    GROUP_SIGNALS.with(|n| n.set(n.get() + 1));
    if let Ok(pid) = i32::try_from(child.id()) {
        // SAFETY: plain syscall on the group we created with process_group(0).
        unsafe {
            libc::kill(-pid, libc::SIGKILL);
            libc::kill(pid, libc::SIGKILL);
        }
    }
}

fn head(s: &str) -> String {
    s.chars().take(200).collect()
}

/// Unwrap the CLI result envelope, or return a raw object as is.
///
/// # Errors
/// `Cli` for an error envelope, `Exit` for a non-zero exit with no JSON,
/// `BadJson` for unparsable stdout.
pub fn parse_result(stdout: &str, stderr: &str, code: Option<i32>) -> Result<Value, RunError> {
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return Err(RunError::Exit {
            code,
            stderr: stderr.to_owned(),
        });
    }
    let value: Value = match serde_json::from_str(trimmed) {
        Ok(v) => v,
        Err(e) if code == Some(0) => {
            return Err(RunError::BadJson {
                error: e.to_string(),
                stdout_head: head(stdout),
            });
        }
        Err(_) => {
            return Err(RunError::Exit {
                code,
                stderr: stderr.to_owned(),
            });
        }
    };
    match value.get("ok").and_then(Value::as_bool) {
        Some(false) => {
            let err = value
                .get("error")
                .cloned()
                .and_then(|e| match e {
                    Value::String(message) => Some(CliError {
                        code: "E_UNEXPECTED".into(),
                        message,
                        detail: None,
                    }),
                    other => serde_json::from_value::<CliError>(other).ok(),
                })
                .unwrap_or_else(|| CliError {
                    code: "E_UNEXPECTED".into(),
                    message: head(stdout),
                    detail: None,
                });
            Err(RunError::Cli(err))
        }
        Some(true) if value.get("data").is_some() => Ok(value["data"].clone()),
        // Raw objects. Some commands (doctor, env list) exit 1 on findings
        // but still print a full report, which the app wants.
        _ => Ok(value),
    }
}

/// Strict parser for the envelope contracts migrated by HACK-2238 (changed after next.17).
/// A nonzero result can never be accepted as successful data.
pub fn parse_schema_result(
    stdout: &str,
    stderr: &str,
    code: Option<i32>,
    schema: &str,
) -> Result<Value, RunError> {
    let invalid = || RunError::BadJson {
        error: format!("expected CLI envelope with schema {schema}"),
        stdout_head: head(stdout),
    };
    let value: Value = serde_json::from_str(stdout).map_err(|_| invalid())?;
    if value.as_object().is_none_or(|object| object.len() != 2) {
        return Err(invalid());
    }
    match value.get("ok").and_then(Value::as_bool) {
        Some(false) if code.is_some_and(|code| code != 0) => {
            let error = value.get("error").ok_or_else(invalid)?;
            if !error
                .get("code")
                .and_then(Value::as_str)
                .is_some_and(|code| {
                    code.strip_prefix("E_").is_some_and(|suffix| {
                        !suffix.is_empty()
                            && suffix.bytes().all(|byte| {
                                byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_'
                            })
                    })
                })
                || error.get("message").and_then(Value::as_str).is_none()
            {
                return Err(invalid());
            }
            parse_result(stdout, stderr, code)
        }
        Some(true) if code == Some(0) => {
            let data = value.get("data").ok_or_else(invalid)?;
            if data.get("schema").and_then(Value::as_str) != Some(schema) {
                return Err(invalid());
            }
            Ok(data.clone())
        }
        _ => Err(invalid()),
    }
}

/// `hack v5.0.0` / `5.0.0-next.3` → the version string.
#[must_use]
pub fn parse_version(text: &str) -> Option<String> {
    text.split_whitespace()
        .map(|w| w.trim_start_matches('v'))
        .find(|w| w.chars().next().is_some_and(|c| c.is_ascii_digit()) && w.contains('.'))
        .map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fake `hack` in a fresh temp dir: a shell script with a fixed body.
    struct FakeHack {
        dir: PathBuf,
    }

    impl FakeHack {
        fn new(body: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "hack-desktop-runner-{}-{}",
                std::process::id(),
                rand_suffix()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            let p = dir.join("hack");
            crate::test_support::script(
                &p,
                format!(
                    "#!/bin/sh\nif [ \"$1\" = __warmup ]; then echo '{{}}'; exit 0; fi\n{body}\n"
                ),
            );
            let fake = Self { dir };
            // Keep macOS first-launch scanning outside product timeouts.
            fake.runner()
                .run_json::<Value>(&["__warmup"], None, Duration::from_secs(60))
                .expect("fake CLI warmup");
            fake
        }
        fn runner(&self) -> CliRunner {
            CliRunner::new(self.dir.join("hack"))
                .with_env("HACK_HOME", &self.dir.to_string_lossy())
                .with_env("HOME", &self.dir.to_string_lossy())
                .with_env("HACK_DAEMON_AUTOSTART_DISABLE", "1")
        }
    }

    impl Drop for FakeHack {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn rand_suffix() -> u128 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    }

    const T: Duration = Duration::from_secs(5);

    /// A slow start (here an ETXTBSY retry while another descriptor still
    /// has the program open for writing) counts against the timeout, and
    /// the SIGTERM grace is cut so the call ends by `timeout + grace`.
    #[cfg(target_os = "linux")]
    #[test]
    fn the_timeout_includes_the_time_spent_starting_the_program() {
        let fake = FakeHack::new("trap '' TERM\nwhile :; do sleep 0.05; done");
        let program = fake.dir.join("hack");
        // Below the spawn's ETXTBSY retry window, past the deadline.
        let hold = Duration::from_millis(180);
        let writer = std::fs::OpenOptions::new()
            .append(true)
            .open(&program)
            .unwrap();
        let release = std::thread::spawn(move || {
            std::thread::sleep(hold);
            drop(writer);
        });
        let (timeout, grace) = (Duration::from_millis(60), Duration::from_millis(300));
        // The program must ignore SIGTERM from its first instruction, or the
        // signal sent right after the late spawn ends it before its trap is
        // set. An ignored disposition is inherited through exec, so ignore it
        // here for the call (nextest runs each test in its own process).
        // SAFETY: setting a disposition to SIG_IGN and back is async-signal-safe.
        let previous = unsafe { libc::signal(libc::SIGTERM, libc::SIG_IGN) };
        let started = Instant::now();
        let result =
            fake.runner()
                .with_term_grace(grace)
                .run_raw(&["doctor", "--json"], None, timeout);
        let took = started.elapsed();
        // SAFETY: restores the disposition saved above.
        unsafe { libc::signal(libc::SIGTERM, previous) };
        release.join().unwrap();
        assert!(
            matches!(result, Err(RunError::Timeout { .. })),
            "{result:?}"
        );
        // Ends by timeout + grace (360 ms) plus scheduling. A full grace
        // after the late spawn takes 480 ms; a timeout counted from the
        // spawn, 540 ms.
        assert!(
            took < timeout + grace + Duration::from_millis(80),
            "took {took:?} for a {timeout:?} timeout and {grace:?} grace"
        );
    }

    #[test]
    fn unwraps_envelope() {
        let f = FakeHack::new(
            r#"echo '{"ok":true,"data":{"action":"up","project":"p","services":{"failed":["api"]}}}'"#,
        );
        let r: crate::models::LifecycleResult =
            f.runner().run_json(&["up", "--json"], None, T).unwrap();
        assert_eq!(r.services.failed, vec!["api"]);
    }

    #[test]
    fn error_envelope_becomes_cli_error() {
        let f = FakeHack::new(
            r#"echo '{"ok":false,"error":{"code":"E_DOCKER_UNAVAILABLE","message":"down"}}'; exit 1"#,
        );
        let r = f.runner().run_json::<Value>(&["up"], None, T);
        assert_eq!(
            r,
            Err(RunError::Cli(CliError {
                code: "E_DOCKER_UNAVAILABLE".into(),
                message: "down".into(),
                detail: None,
            }))
        );
    }

    #[test]
    fn raw_object_with_nonzero_exit_is_kept() {
        let f = FakeHack::new(r#"echo '{"checks":[{"id":"x","status":"error"}]}'; exit 1"#);
        let r: crate::models::DoctorReport = f.runner().run_json(&["doctor"], None, T).unwrap();
        assert_eq!(r.attention_count(), 1);
    }

    #[test]
    fn input_goes_to_stdin_never_argv_or_env() {
        let f = FakeHack::new(
            r#"printf '{"args":"%s","stdin":"%s","env":"%s"}' "$*" "$(cat)" "$(env | grep -c SENTINEL_VALUE)""#,
        );
        let (out, _, code) = f
            .runner()
            .run_raw_with_input(
                &["env", "add", "K", "--value-stdin"],
                None,
                T,
                b"SENTINEL_VALUE",
            )
            .unwrap();
        assert_eq!(code, Some(0));
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["stdin"], "SENTINEL_VALUE");
        assert_eq!(v["args"], "env add K --value-stdin");
        assert_eq!(v["env"], "0");
        // Without input, stdin is empty.
        let (out, _, _) = f.runner().run_raw(&["x"], None, T).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["stdin"], "");
    }

    #[test]
    fn a_descendant_holding_stdin_cannot_hold_the_write_past_the_deadline() {
        // The command exits at once; a descendant keeps stdin open and never
        // reads, and the input is larger than any pipe buffer.
        // POSIX gives a background job /dev/null as stdin before explicit
        // redirections (dash does), so stdin is saved on fd 3 first.
        let f = FakeHack::new("exec 3<&0\nsleep 120 <&3 >/dev/null 2>&1 &\nexit 0");
        let started = Instant::now();
        let input = vec![b'x'; 1 << 20];
        let r = f
            .runner()
            .with_term_grace(Duration::from_millis(100))
            .run_raw_with_input(
                &["env", "add", "K", "--value-stdin"],
                None,
                Duration::from_secs(2),
                &input,
            );
        assert!(matches!(r, Err(RunError::Timeout { .. })), "{r:?}");
        assert!(
            started.elapsed() < Duration::from_secs(30),
            "ended at the deadline, not when the descendant did"
        );
    }

    #[test]
    fn a_reader_outside_the_group_cannot_hold_the_write_past_the_deadline() {
        // The descendant starts its own session (outside the group the
        // runner ends) and holds stdin without reading.
        let f = FakeHack::new(
            "exec 3<&0\nif command -v setsid >/dev/null; then setsid sleep 6 <&3 >/dev/null 2>&1 & else perl -e 'use POSIX; POSIX::setsid(); sleep 6' <&3 >/dev/null 2>&1 & fi\nexit 0",
        );
        let started = Instant::now();
        let input = vec![b'x'; 1 << 20];
        let r = f
            .runner()
            .with_term_grace(Duration::from_millis(100))
            .run_raw_with_input(
                &["env", "add", "K", "--value-stdin"],
                None,
                Duration::from_secs(1),
                &input,
            );
        assert!(matches!(r, Err(RunError::Timeout { .. })), "{r:?}");
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "ended near the deadline, not when the reader did ({:?})",
            started.elapsed()
        );
    }

    #[test]
    fn a_leader_timeout_also_stops_the_stdin_writer() {
        // The leader outlives the deadline, and a reader in its own session
        // holds stdin without reading: the early timeout return must still
        // stop the writer rather than leave it polling.
        let f = FakeHack::new(
            "exec 3<&0\nif command -v setsid >/dev/null; then setsid sleep 6 <&3 >/dev/null 2>&1 & else perl -e 'use POSIX; POSIX::setsid(); sleep 6' <&3 >/dev/null 2>&1 & fi\nexec 3<&-\nsleep 30 </dev/null",
        );
        // Threads of this process (nextest runs each test in its own).
        #[cfg(target_os = "linux")]
        let threads = || std::fs::read_dir("/proc/self/task").map_or(0, Iterator::count);
        #[cfg(target_os = "linux")]
        let before = threads();
        let started = Instant::now();
        let input = vec![b'x'; 1 << 20];
        let r = f
            .runner()
            .with_term_grace(Duration::from_millis(100))
            .run_raw_with_input(
                &["env", "add", "K", "--value-stdin"],
                None,
                Duration::from_secs(1),
                &input,
            );
        assert!(matches!(r, Err(RunError::Timeout { .. })), "{r:?}");
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "returned at the deadline ({:?})",
            started.elapsed()
        );
        // The writer is gone, not left polling while the reader in its own
        // session still holds the pipe.
        #[cfg(target_os = "linux")]
        {
            let until = Instant::now() + Duration::from_secs(2);
            while threads() > before && Instant::now() < until {
                thread::sleep(Duration::from_millis(20));
            }
            assert!(threads() <= before, "a thread outlived the call");
        }
    }

    #[test]
    fn passes_path_and_no_interactive() {
        let f = FakeHack::new(r#"printf '{"args":"%s","ni":"%s"}' "$*" "$HACK_NO_INTERACTIVE""#);
        let v: Value = f
            .runner()
            .run_json(&["ps", "--json"], Some(Path::new("/work/p")), T)
            .unwrap();
        assert_eq!(v["args"], "ps --json --path /work/p");
        assert_eq!(v["ni"], "1");
    }

    /// Evidence that `pid` has exited: `kill(pid, 0)` fails, or (Linux only)
    /// `/proc` shows a zombie. An unreadable `/proc` is no evidence.
    fn process_gone(pid: i32) -> bool {
        // SAFETY: signal 0 only checks existence.
        if unsafe { libc::kill(pid, 0) } != 0 {
            return true;
        }
        if cfg!(target_os = "linux") {
            return std::fs::read_to_string(format!("/proc/{pid}/stat"))
                .is_ok_and(|s| s.contains(") Z "));
        }
        false
    }

    /// A scheduling allowance, not a product latency target. Completion of
    /// Drop proves its reader join finished; process checks prove retirement.
    fn completes<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> T {
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            let _ = tx.send(work());
        });
        rx.recv_timeout(Duration::from_secs(60))
            .expect("process cleanup did not complete within the test deadline")
    }

    fn assert_retired(pid: i32) {
        assert!(!process_gone(i32::try_from(std::process::id()).unwrap()));
        let deadline = Instant::now() + Duration::from_secs(60);
        while !process_gone(pid) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        assert!(process_gone(pid), "process {pid} survived cleanup");
    }

    #[test]
    fn timeout_kills_the_process_group() {
        // The child spawns a grandchild that would outlive a plain kill.
        // The timeout leaves room for a slow first start of a new script
        // (macOS scans freshly written executables); `ready` tells a slow
        // start apart from a runner failure.
        let f = FakeHack::new(
            "echo ready > \"$HACK_HOME/ready\"\nsleep 300 &\necho $! > \"$HACK_HOME/grandchild\"\nwait",
        );
        let runner = f.runner();
        let r = completes(move || {
            runner
                .with_term_grace(Duration::from_millis(500))
                .run_json::<Value>(&["up"], None, Duration::from_secs(2))
        });
        assert!(matches!(r, Err(RunError::Timeout { .. })), "{r:?}");
        assert!(f.dir.join("ready").exists(), "the fake CLI never started");
        let pid: i32 = std::fs::read_to_string(f.dir.join("grandchild"))
            .expect("grandchild pid written")
            .trim()
            .parse()
            .unwrap();
        assert_retired(pid);
    }

    #[test]
    fn timeout_covers_a_descendant_holding_the_pipe() {
        // `hack` exits at once, but a background child keeps stdout open.
        let f = FakeHack::new("sleep 300 &\necho $! > \"$HACK_HOME/grandchild\"\necho '{}'");
        let runner = f.runner();
        let r =
            completes(move || runner.run_json::<Value>(&["x"], None, Duration::from_millis(300)));
        assert!(matches!(r, Err(RunError::Timeout { .. })), "{r:?}");
        let pid = std::fs::read_to_string(f.dir.join("grandchild"))
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        assert_retired(pid);
    }

    /// HACK-2334: a CLI found on PATH at launch is not checked then. Once
    /// setup's rediscovery refuses what it finds, no clone may fall back
    /// to that launch-time program; a later accepted discovery or an
    /// explicit selection runs again.
    #[test]
    fn a_refused_rediscovery_never_falls_back_to_the_program_found_at_launch() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!(
            "hack-desktop-refused-{}-{}",
            std::process::id(),
            rand_suffix()
        ));
        let bin = root.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        let marker = root.join("ran");
        let hack = bin.join("hack");
        crate::test_support::script(
            &hack,
            format!("#!/bin/sh\n: > '{}'\necho '{{}}'\n", marker.display()),
        );
        // `on_path` as it is when the process PATH had this `hack` at
        // launch (built here so the test never searches the real PATH).
        let mut runner = CliRunner::new(&hack);
        runner.path_name = Some("hack".into());
        runner.pinned = Some(std::sync::Arc::default());
        let runner = runner.with_env("PATH", bin.to_str().unwrap());
        let clone = runner.clone();
        assert_eq!(clone.resolve_program().unwrap(), hack, "positive control");
        // Another user can now replace it: rediscovery refuses it ...
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o777)).unwrap();
        assert!(matches!(runner.rediscover(), Err(RunError::Spawn(_))));
        // ... and nothing, in any clone, runs the launch-time program.
        for r in [&runner, &clone] {
            assert!(matches!(r.resolve_program(), Err(RunError::NotFound)));
            assert!(r.run_raw(&["x"], None, T).is_err());
            assert!(r.fixed().run_raw(&["x"], None, T).is_err(), "fixed too");
        }
        assert!(!marker.exists(), "the refused CLI never ran");
        // Trusted again: an accepted rediscovery runs it.
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(runner.rediscover().unwrap(), hack);
        clone
            .run_raw(&["x"], None, T)
            .expect("runs after an accepted rediscovery");
        assert!(marker.exists());
        // An explicit selection after a refusal runs as well.
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o777)).unwrap();
        assert!(runner.rediscover().is_err());
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        runner.select(&hack);
        assert_eq!(clone.resolve_program().unwrap(), hack);
        let _ = std::fs::remove_dir_all(root);
    }

    /// The chooser's runner (`selectable`): a selected CLI that rediscovery
    /// refuses is not run by any clone, and the next rediscovery checks the
    /// same program again, so trusting it again brings it back.
    #[test]
    fn a_refused_selected_cli_is_not_run_until_it_is_trusted_again() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!(
            "hack-desktop-refused-sel-{}-{}",
            std::process::id(),
            rand_suffix()
        ));
        let bin = root.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        let marker = root.join("ran");
        let hack = bin.join("hack");
        crate::test_support::script(
            &hack,
            format!("#!/bin/sh\n: > '{}'\necho '{{}}'\n", marker.display()),
        );
        let runner = CliRunner::selectable(&hack);
        let clone = runner.clone();
        assert_eq!(runner.rediscover().unwrap(), hack, "positive control");
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o777)).unwrap();
        assert!(matches!(runner.rediscover(), Err(RunError::Spawn(_))));
        for r in [&runner, &clone] {
            assert!(matches!(r.resolve_program(), Err(RunError::NotFound)));
            assert!(r.run_raw(&["x"], None, T).is_err());
            assert!(r.fixed().run_raw(&["x"], None, T).is_err(), "fixed too");
        }
        assert!(!marker.exists(), "the refused CLI never ran");
        // Still refused while it stays changeable by others.
        assert!(runner.rediscover().is_err());
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(
            runner.rediscover().unwrap(),
            hack,
            "checked again, accepted"
        );
        clone
            .run_raw(&["x"], None, T)
            .expect("runs once trusted again");
        assert!(marker.exists());
        let _ = std::fs::remove_dir_all(root);
    }

    /// A rediscovery that finishes after the user selected another CLI
    /// leaves that selection alone, whether its own check passed or failed.
    #[test]
    fn a_selection_made_during_a_rediscovery_is_kept() {
        let a = PathBuf::from("/example/a/hack");
        let b = PathBuf::from("/example/b/hack");
        for next in [
            Pin::Program(a.clone()),
            Pin::Refused {
                candidate: Some(a.clone()),
            },
        ] {
            let runner = CliRunner::selectable(&a);
            let clone = runner.clone();
            // The check of A began here ...
            let seen = runner.pin_now();
            // ... the user picks B meanwhile ...
            clone.select(&b);
            // ... and the check of A completes.
            runner.settle_pin(seen.as_ref(), next);
            assert_eq!(runner.current_program(), Some(b.clone()), "B stays");
        }
        // Unchanged meanwhile: the outcome is recorded.
        let runner = CliRunner::selectable(&a);
        let seen = runner.pin_now();
        runner.settle_pin(seen.as_ref(), Pin::Refused { candidate: Some(a) });
        assert_eq!(runner.current_program(), None);
    }

    #[test]
    fn clean_environment_reaches_the_child_on_every_platform() {
        // The Apple spawn boundary builds the child environment itself, so a
        // clean runner must say so explicitly; env_clear alone is not visible.
        assert!(
            std::env::var_os("HOME").is_some(),
            "precondition: parent HOME"
        );
        let f = FakeHack::new(r#"printf '%s|%s' "${HOME-unset}" "${HACK_HOME-unset}""#);
        let (inherited, _, code) = f.runner().run_raw(&["x"], None, T).unwrap();
        assert_eq!(code, Some(0));
        assert!(
            !inherited.starts_with("unset|"),
            "positive control: {inherited}"
        );
        // Only HACK_HOME is authored here, so HOME must not reach the child.
        let (clean, _, code) = CliRunner::new(f.dir.join("hack"))
            .with_env("HACK_HOME", &f.dir.to_string_lossy())
            .with_clean_env()
            .run_raw(&["x"], None, T)
            .unwrap();
        assert_eq!(code, Some(0));
        assert_eq!(clean, format!("unset|{}", f.dir.to_string_lossy()));
    }

    #[test]
    fn path_discovery_is_pinned_and_untrusted_locations_never_run() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!(
            "hack-desktop-pin-{}-{}",
            std::process::id(),
            rand_suffix()
        ));
        let (early, late) = (root.join("early"), root.join("late"));
        for dir in [&early, &late] {
            std::fs::create_dir_all(dir).unwrap();
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let marker = root.join("ran");
        let fake = |dir: &std::path::Path| {
            crate::test_support::script(
                &dir.join("hack"),
                format!("#!/bin/sh\n: > '{}'\necho '{{}}'\n", marker.display()),
            );
        };
        fake(&late);
        let path = format!("{}:{}", early.display(), late.display());
        // `on_path` as it is when the process PATH has no `hack`, so the
        // test never resolves (or runs) a CLI installed on this machine;
        // discovery then searches only the runner's own PATH.
        let mut runner = CliRunner::new("hack");
        runner.missing = true;
        runner.path_name = Some("hack".into());
        runner.pinned = Some(std::sync::Arc::default());
        let runner = runner.with_env("PATH", &path);
        let clone = runner.clone();
        assert!(matches!(runner.resolve_program(), Err(RunError::NotFound)));
        assert_eq!(runner.rediscover().unwrap(), late.join("hack"));
        assert_eq!(clone.resolve_program().unwrap(), late.join("hack"));
        // A CLI added later to an earlier PATH directory is not picked up by
        // ordinary reads (clones share the pin) ...
        fake(&early);
        assert_eq!(clone.resolve_program().unwrap(), late.join("hack"));
        // Doctor swaps PATH for its private tool wrappers on a fixed runner,
        // which keeps the pinned CLI instead of searching the new PATH.
        assert_eq!(
            runner
                .fixed()
                .with_env("PATH", early.to_str().unwrap())
                .resolve_program()
                .unwrap(),
            late.join("hack")
        );
        // ... only by an explicit rediscovery, which validates it first.
        assert_eq!(runner.rediscover().unwrap(), early.join("hack"));
        std::fs::set_permissions(&early, std::fs::Permissions::from_mode(0o777)).unwrap();
        let _ = std::fs::remove_file(&marker);
        assert!(matches!(runner.rediscover(), Err(RunError::Spawn(_))));
        assert!(
            runner.run_raw(&["x"], None, T).is_err(),
            "no pin remains after a refused discovery"
        );
        assert!(!marker.exists(), "an untrusted CLI never runs");
        // A trusted CLI script whose interpreter another user can replace,
        // or that uses env with the ordinary PATH, is refused too.
        std::fs::set_permissions(&early, std::fs::Permissions::from_mode(0o755)).unwrap();
        let shared = root.join("shared");
        std::fs::create_dir(&shared).unwrap();
        std::fs::set_permissions(&shared, std::fs::Permissions::from_mode(0o777)).unwrap();
        std::fs::copy("/bin/sh", shared.join("interp")).unwrap();
        for shebang in [
            shared.join("interp").display().to_string(),
            "/usr/bin/env sh".into(),
        ] {
            std::fs::remove_file(early.join("hack")).unwrap();
            crate::test_support::script(
                &early.join("hack"),
                format!("#!{shebang}\n: > '{}'\n", marker.display()),
            );
            assert!(
                matches!(runner.rediscover(), Err(RunError::Spawn(_))),
                "{shebang}"
            );
            assert!(!marker.exists());
        }
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn interpreter_startup_variables_never_reach_doctor_children() {
        // A run-time check with variables SIP-protected macOS shells keep;
        // loader (DYLD_*) variables are checked on the Command below.
        let f = FakeHack::new(
            r#"printf '%s|%s|%s|%s' "${BASH_ENV-unset}" "${NODE_OPTIONS-unset}" "${PYTHONUSERBASE-unset}" "${PYTHONNOUSERSITE-unset}""#,
        );
        let runner = f
            .runner()
            .with_env("BASH_ENV", "/example/startup")
            .with_env("NODE_OPTIONS", "--require=/example/preload")
            .with_env("PYTHONUSERBASE", "/example/userbase")
            .with_env("PYTHONNOUSERSITE", "");
        let (seen, _, _) = runner.run_raw(&["x"], None, T).unwrap();
        assert_eq!(
            seen, "/example/startup|--require=/example/preload|/example/userbase|",
            "positive control"
        );
        let (stripped, _, _) = runner
            .without_interpreter_startup()
            .run_raw(&["x"], None, T)
            .unwrap();
        assert_eq!(stripped, "unset|unset|unset|1");
    }

    #[test]
    fn loader_and_function_prefixes_are_removed_from_the_command() {
        let names = [
            "DYLD_VERSIONED_LIBRARY_PATH",
            "DYLD_FALLBACK_LIBRARY_PATH",
            "LD_AUDIT",
            "BASH_FUNC_x%%",
            "BUN_OPTIONS",
            "BUN_BE_BUN",
            "BUN_CONFIG_REGISTRY",
            "BUN_INSPECT_CONNECT_TO",
        ];
        let mut runner = CliRunner::new("/example/hack");
        for name in names {
            runner = runner.with_env(name, "/example/value");
        }
        let removed = |runner: &CliRunner| {
            let command = runner.command(&["x"], None, &runner.program.clone());
            names
                .iter()
                .filter(|name| {
                    command
                        .get_envs()
                        .any(|(key, value)| key == std::ffi::OsStr::new(name) && value.is_none())
                })
                .count()
        };
        assert_eq!(removed(&runner), 0, "positive control: set, not removed");
        assert_eq!(removed(&runner.without_interpreter_startup()), names.len());
    }

    #[test]
    fn library_and_gem_selectors_are_removed_from_the_command() {
        let names = [
            "PYTHONUSERBASE",
            "PYTHONPLATLIBDIR",
            "PYTHONEXECUTABLE",
            "__PYVENV_LAUNCHER__",
            "PERL5DB",
            "RUBYGEMS_GEMDEPS",
            "GEM_HOME",
            "GEM_PATH",
            "BUNDLE_GEMFILE",
        ];
        let mut runner = CliRunner::new("/example/hack");
        for name in names {
            runner = runner.with_env(name, "/example/value");
        }
        let removed = |runner: &CliRunner| {
            let command = runner.command(&["x"], None, &runner.program.clone());
            names
                .iter()
                .filter(|name| {
                    command
                        .get_envs()
                        .any(|(key, value)| key == std::ffi::OsStr::new(name) && value.is_none())
                })
                .count()
        };
        assert_eq!(removed(&runner), 0, "positive control: set, not removed");
        assert_eq!(removed(&runner.without_interpreter_startup()), names.len());
    }

    #[test]
    fn flood_finishes_without_ui_drain_and_reports_bounded_loss() {
        let total = STREAM_QUEUE + 10_000;
        let f = FakeHack::new(&format!(
            "i=0; while [ $i -lt {total} ]; do echo '{{\"type\":\"log\",\"entry\":{{\"message\":\"flood\"}}}}'; i=$((i+1)); done"
        ));
        let mut stream = f.runner().stream_logs(&["logs"], None).unwrap();
        let deadline = Instant::now() + T;
        // No receiver calls: both the child and reader must finish even
        // though the UI has consumed nothing and the queue is full.
        while !stream.reader.as_ref().unwrap().is_finished() {
            assert!(Instant::now() < deadline, "reader blocked on UI queue");
            thread::sleep(Duration::from_millis(5));
        }
        while stream.child.try_wait().unwrap().is_none() {
            assert!(Instant::now() < deadline, "writer blocked on stdout");
            thread::sleep(Duration::from_millis(5));
        }
        let poll = stream.poll(STREAM_QUEUE + 1);
        assert_eq!(poll.events.len(), STREAM_QUEUE);
        assert_eq!(poll.skipped, 10_000);
        assert!(poll.events.iter().map(event_bytes).sum::<usize>() <= MAX_QUEUED_BYTES);
        assert_eq!(
            stream.poll(STREAM_QUEUE + 1).skipped,
            0,
            "count delivered once"
        );
    }

    fn failed_stream_banner(body: &str) -> String {
        let f = FakeHack::new(body);
        let mut stream = f.runner().stream_logs(&["logs"], None).unwrap();
        let mut model = crate::logs::LogsModel::default();
        model.start(true);
        let deadline = Instant::now() + T;
        loop {
            let poll = stream.poll(100);
            for event in poll.events {
                model.apply(&event);
            }
            if let Some(code) = poll.exit {
                model.exited(code);
                return model.banner().unwrap();
            }
            assert!(Instant::now() < deadline, "stream did not exit");
            thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn pretty_failure_envelope_reaches_the_banner_with_human_status() {
        let banner = failed_stream_banner(
            r#"cat <<'JSON'
{
  "ok": false,
  "error": {
    "code": "E_PROJECT_NOT_FOUND",
    "message": "No project found at /work/missing"
  }
}
JSON
exit 1"#,
        );
        assert!(
            banner.contains("No project found at /work/missing (exit 1)"),
            "{banner}"
        );
        assert!(!banner.contains("Some("));
    }

    #[test]
    fn stderr_failure_reason_reaches_the_banner_and_diagnostics_are_bounded() {
        let banner = failed_stream_banner("echo 'docker executable unavailable' >&2; exit 127");
        assert!(
            banner.contains("docker executable unavailable (exit 127)"),
            "{banner}"
        );
        let mut diagnostics = String::new();
        for _ in 0..100 {
            append_diagnostic(&mut diagnostics, &"é".repeat(STDERR_KEEP));
            assert!(diagnostics.len() <= STDERR_KEEP);
            assert!(diagnostics.capacity() <= STDERR_KEEP * 2);
        }
        assert_eq!(exit_description(None), "killed by signal");
    }

    #[test]
    fn log_stream_drains_stderr_without_blocking_stdout() {
        let f = FakeHack::new(
            "head -c 2097152 /dev/zero >&2; echo '{\"type\":\"log\",\"entry\":{\"message\":\"after diagnostics\"}}'",
        );
        let s = f.runner().stream_logs(&["logs"], None).unwrap();
        let event = s.next_timeout(T).expect("stderr must not block stdout");
        assert_eq!(event.entry.unwrap().message, "after diagnostics");
    }

    #[test]
    fn log_stream_reports_exit_only_after_every_line() {
        // Many lines, then exit 3: the exit must not be reported while lines
        // are still queued or unread, even with a small batch size.
        let f = FakeHack::new(
            "i=0; while [ $i -lt 300 ]; do echo \"{\\\"type\\\":\\\"log\\\",\\\"entry\\\":{\\\"message\\\":\\\"l$i\\\"}}\"; i=$((i+1)); done; echo '{\"type\":\"end\",\"reason\":\"eof\"}'; exit 3",
        );
        let mut s = f.runner().stream_logs(&["logs"], None).unwrap();
        let mut got = 0;
        let mut exit = None;
        for _ in 0..500 {
            let p = s.poll(7);
            got += p.events.len();
            if let Some(code) = p.exit {
                exit = Some(code);
                break;
            }
            thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(got, 301, "every line and the end event delivered first");
        assert_eq!(exit, Some(Some(3)));
    }

    #[test]
    fn dropping_a_stream_after_poll_reaped_it_sends_no_signal() {
        let f = FakeHack::new("echo '{\"type\":\"end\",\"reason\":\"eof\"}'");
        let mut s = f.runner().stream_logs(&["logs"], None).unwrap();
        let deadline = Instant::now() + Duration::from_secs(60);
        while s.poll(64).exit.is_none() {
            assert!(Instant::now() < deadline, "stream never reported its exit");
            thread::sleep(Duration::from_millis(20));
        }
        let before = GROUP_SIGNALS.with(std::cell::Cell::get);
        drop(s);
        assert_eq!(
            GROUP_SIGNALS.with(std::cell::Cell::get),
            before,
            "a reaped PID may be reused; Drop must not signal it"
        );
    }

    #[test]
    fn dropping_a_stream_with_a_full_queue_does_not_hang() {
        // Far more lines than STREAM_QUEUE, never polled: overflow is
        // discarded. Drop must join the reader and retire its child.
        let f = FakeHack::new(
            "i=0; while [ $i -lt 20000 ]; do echo '{\"type\":\"heartbeat\"}'; i=$((i+1)); done; exec sleep 300",
        );
        let s = f.runner().stream_logs(&["logs"], None).unwrap();
        thread::sleep(Duration::from_millis(500));
        let pid = i32::try_from(s.child.id()).unwrap();
        assert!(
            !process_gone(pid),
            "positive control: stream child is alive"
        );
        completes(move || drop(s));
        assert_retired(pid);
    }

    #[test]
    fn oversized_records_leave_a_visible_marker() {
        let f = FakeHack::new(&format!(
            "printf '{{\"type\":\"log\",\"entry\":{{\"message\":\"'; head -c {} /dev/zero | tr '\\0' x; printf '\"}}}}\\n'; echo '{{\"type\":\"log\",\"entry\":{{\"message\":\"after\"}}}}'",
            MAX_RAW_LINE + 1000
        ));
        let s = f.runner().stream_logs(&["logs"], None).unwrap();
        let a = s.next_timeout(T).expect("marker");
        let b = s.next_timeout(T).expect("next event");
        let marker = a.entry.unwrap();
        assert_eq!(marker.truncated, Some(true));
        assert!(marker.message.contains("dropped by the app"));
        assert_eq!(b.entry.unwrap().message, "after");
    }

    #[test]
    fn queued_events_are_capped_before_send() {
        let big = "x".repeat(crate::logs::MAX_LINE_BYTES * 3);
        let mut e = LogEvent {
            kind: big.clone(),
            ts: Some(big.clone()),
            backend: Some(big.clone()),
            reason: Some(big.clone()),
            message: Some(big.clone()),
            entry: Some(crate::models::LogEntry {
                service: Some(big.clone()),
                message: big.clone(),
                stream: Some(big.clone()),
                timestamp: Some(big.clone()),
                level: Some(big),
                truncated: None,
            }),
        };
        cap_event(&mut e);
        assert!(event_bytes(&e) <= MAX_EVENT_BYTES, "{}", event_bytes(&e));
        let entry = e.entry.as_ref().unwrap();
        assert_eq!(entry.message.len(), crate::logs::MAX_LINE_BYTES);
        assert!(entry.message.capacity() < crate::logs::MAX_LINE_BYTES + 1024);
        assert_eq!(entry.truncated, Some(true));
        assert_eq!(e.message.as_ref().unwrap().len(), MAX_NOTICE_BYTES);
        assert_eq!(entry.timestamp.as_ref().unwrap().len(), MAX_FIELD_BYTES);
        assert_eq!(e.reason.as_ref().unwrap().len(), MAX_FIELD_BYTES);
        const { assert!(MAX_QUEUED_BYTES < 80 * 1024 * 1024) };
    }

    #[test]
    fn bounded_line_reader_skips_the_tail_of_huge_lines() {
        let data = format!("{}\nnext\n", "x".repeat(50));
        let mut r = std::io::BufReader::with_capacity(8, data.as_bytes());
        assert_eq!(
            read_bounded_line(&mut r, 10).unwrap(),
            ("x".repeat(10), true)
        );
        assert_eq!(
            read_bounded_line(&mut r, 10).unwrap(),
            ("next".into(), false)
        );
        assert!(read_bounded_line(&mut r, 10).is_none());
    }

    #[test]
    fn path_lookup_ignores_relative_entries() {
        let f = FakeHack::new("echo '{}'");
        let dir = f.dir.to_string_lossy().into_owned();
        // A relative entry that would resolve to the fake via the cwd.
        let rel = std::ffi::OsString::from(format!(".:{dir}"));
        assert_eq!(
            resolve_on_path("hack", Some(&rel)),
            Some(f.dir.join("hack"))
        );
        let only_rel = std::ffi::OsString::from(".:relative/bin:");
        assert_eq!(resolve_on_path("hack", Some(&only_rel)), None);
        assert_eq!(resolve_on_path("hack", None), None);
        assert_eq!(
            resolve_on_path("./hack", Some(&rel)),
            None,
            "relative names refused"
        );
    }

    #[test]
    fn child_path_drops_empty_and_relative_entries() {
        let p = std::ffi::OsString::from(".::bin:/usr/bin:./x:/bin");
        assert_eq!(sanitize_path(&p), std::ffi::OsString::from("/usr/bin:/bin"));
        // All relative or empty: a non-empty trusted fallback, never "".
        for bad in [".::relative/bin:", "", ":", "."] {
            assert_eq!(
                sanitize_path(std::ffi::OsStr::new(bad)),
                std::ffi::OsString::from(FALLBACK_PATH),
                "{bad:?}"
            );
        }
        // And the child really receives an all-absolute PATH.
        let f = FakeHack::new(r#"printf '{"p":"%s"}' "$PATH""#);
        let v: Value = f.runner().run_json(&["x"], None, T).unwrap();
        let got = v["p"].as_str().unwrap();
        assert!(
            got.split(':').all(|e| e.starts_with('/')),
            "child PATH {got:?}"
        );
    }

    #[test]
    fn a_runner_that_found_nothing_never_spawns() {
        let mut r = CliRunner::new("hack");
        r.missing = true;
        assert_eq!(
            r.run_json::<Value>(&["x"], None, T),
            Err(RunError::NotFound)
        );
    }

    #[test]
    fn timeout_sends_sigterm_first_so_the_cli_can_retire_its_children() {
        // `wait` on a background job is interrupted at once by a trapped
        // signal in every POSIX shell; a foreground `sleep` loop is not
        // portable for this. `ready` separates a slow start from a failure.
        let f = FakeHack::new(
            r#"trap 'echo term > "$HACK_HOME/got"; exit 0' TERM
echo ready > "$HACK_HOME/ready"
sleep 300 &
wait $!"#,
        );
        // A full-grace regression must exceed the generous completion bound.
        let runner = f.runner();
        let r = completes(move || {
            runner
                .with_term_grace(Duration::from_secs(300))
                .run_json::<Value>(&["up"], None, Duration::from_secs(2))
        });
        assert!(matches!(r, Err(RunError::Timeout { .. })), "{r:?}");
        assert!(f.dir.join("ready").exists(), "the fake CLI never started");
        assert!(f.dir.join("got").exists(), "SIGTERM reached the CLI");
    }

    #[test]
    fn a_cli_ignoring_sigterm_is_killed_after_the_grace() {
        let f = FakeHack::new(
            "echo $$ > \"$HACK_HOME/pid\"\ntrap '' TERM\nwhile :; do sleep 0.05; done",
        );
        let runner = f.runner();
        let r = completes(move || {
            runner
                .with_term_grace(Duration::from_millis(300))
                .run_json::<Value>(&["up"], None, Duration::from_millis(200))
        });
        assert!(matches!(r, Err(RunError::Timeout { .. })), "{r:?}");
        let pid = std::fs::read_to_string(f.dir.join("pid"))
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        assert_retired(pid);
    }

    #[test]
    fn run_to_completion_waits_past_any_short_deadline() {
        // Takes longer than a short timeout would allow, and still succeeds.
        let f = FakeHack::new("sleep 1; echo '{\"ok\":true,\"data\":{\"action\":\"up\"}}'");
        let started = Instant::now();
        let r: Value = f.runner().run_json_to_completion(&["up"], None).unwrap();
        assert_eq!(r["action"], "up");
        assert!(started.elapsed() >= Duration::from_millis(900));
    }

    /// A reader that replays scripted results.
    struct Scripted(std::collections::VecDeque<std::io::Result<Vec<u8>>>);

    impl Read for Scripted {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            match self.0.pop_front() {
                None => Ok(0),
                Some(Err(e)) => Err(e),
                Some(Ok(bytes)) => {
                    buf[..bytes.len()].copy_from_slice(&bytes);
                    Ok(bytes.len())
                }
            }
        }
    }

    #[test]
    fn interrupted_reads_are_retried_and_other_errors_reported() {
        use std::io::{Error, ErrorKind};
        let r = Scripted(
            vec![
                Err(Error::from(ErrorKind::Interrupted)),
                Ok(b"{\"ok\":".to_vec()),
                Err(Error::from(ErrorKind::Interrupted)),
                Ok(b"true}".to_vec()),
            ]
            .into(),
        );
        let d = read_all(Some(r), Keep::Head(1024)).recv().unwrap();
        assert_eq!(d.text, "{\"ok\":true}");
        assert!(d.error.is_none());

        let r = Scripted(
            vec![
                Ok(b"{\"ok\":true".to_vec()),
                Err(Error::new(ErrorKind::BrokenPipe, "gone")),
            ]
            .into(),
        );
        let d = read_all(Some(r), Keep::Head(1024)).recv().unwrap();
        assert!(d.error.is_some(), "a failed read is not end of file");
    }

    #[test]
    fn pipes_are_drained_within_bounded_memory() {
        // 2 MiB to stderr: only the last STDERR_KEEP bytes are retained.
        let f = FakeHack::new(
            "head -c 2097152 /dev/zero | tr '\\0' e >&2\nprintf 'TAIL' >&2\necho '{}'",
        );
        let (out, err, code) = f.runner().run_raw(&["x"], None, T).unwrap();
        assert_eq!(code, Some(0));
        assert_eq!(out.trim(), "{}");
        assert!(err.len() <= STDERR_KEEP, "{}", err.len());
        assert!(err.ends_with("TAIL"));
        // Head keeping stops at the cap and flags the overflow.
        let rx = read_all(Some(&b"abcdef"[..]), Keep::Head(4));
        let d = rx.recv().unwrap();
        assert_eq!(d.text, "abcd");
        assert!(d.overflow);
    }

    #[test]
    fn missing_binary_is_not_found() {
        let r = CliRunner::new("/nonexistent/hack").run_json::<Value>(&["x"], None, T);
        assert_eq!(r, Err(RunError::NotFound));
    }

    #[test]
    fn bad_json_is_reported() {
        let f = FakeHack::new("echo 'not json'");
        assert!(matches!(
            f.runner().run_json::<Value>(&["x"], None, T),
            Err(RunError::BadJson { .. })
        ));
    }

    #[test]
    fn version_parsing() {
        assert_eq!(parse_version("hack v4.3.0\n").as_deref(), Some("4.3.0"));
        assert_eq!(
            parse_version("5.0.0-next.3").as_deref(),
            Some("5.0.0-next.3")
        );
        assert_eq!(parse_version("hack"), None);
        let f = FakeHack::new(
            r#"echo '{"ok":true,"data":{"schema":"hack.version.v1","version":"5.0.0"}}'"#,
        );
        assert_eq!(f.runner().version(T).unwrap(), "5.0.0");
    }

    #[test]
    fn log_stream_parses_ndjson_and_stops_on_drop() {
        // Establish the pipe-holding descendant before publishing events. If
        // sleep starts after the last event, drop can race that fork rather
        // than exercise cleanup of an already-running process group.
        let f = FakeHack::new(
            r#"sleep 300 &
echo $! > "$HACK_HOME/holder"
echo '{"type":"start","backend":"compose"}'
echo '{"type":"log","entry":{"service":"api","message":"hi"}}'
echo 'plain text'
wait $!"#,
        );
        let s = f.runner().stream_logs(&["logs", "--json"], None).unwrap();
        let mut got = Vec::new();
        while got.len() < 3 {
            got.push(s.next_timeout(T).expect("event"));
        }
        assert_eq!(got[0].kind, "start");
        assert_eq!(got[1].entry.as_ref().unwrap().message, "hi");
        assert_eq!(got[2].message.as_deref(), Some("plain text"));
        let pid = i32::try_from(s.child.id()).unwrap();
        let holder: i32 = std::fs::read_to_string(f.dir.join("holder"))
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        assert!(!process_gone(holder), "pipe holder is alive");
        assert!(
            !process_gone(pid),
            "positive control: stream child is alive"
        );
        assert!(
            !s.reader.as_ref().unwrap().is_finished(),
            "reader awaits EOF"
        );
        completes(move || drop(s));
        assert_retired(pid);
        assert_retired(holder);
    }

    #[test]
    #[ignore = "subprocess fixture for log_stream_drop_is_bounded_with_an_escaped_writer"]
    fn escaped_log_pipe_helper() {
        // SAFETY: this fixture subprocess leaves its parent's group so the
        // parent can test a writer that its owned-group signal cannot reach.
        assert_eq!(unsafe { libc::setpgid(0, 0) }, 0);
        let path = std::env::var("HACK_TEST_ESCAPED_LOG_PID").unwrap();
        std::fs::write(path, std::process::id().to_string()).unwrap();
        println!("escaped-ready");
        thread::sleep(Duration::from_secs(30));
    }

    #[test]
    fn log_stream_drop_is_bounded_with_an_escaped_writer() {
        struct EscapedWriter(i32);
        impl Drop for EscapedWriter {
            fn drop(&mut self) {
                // SAFETY: PID supplied only by our fixture subprocess, which
                // remains alive until this guard retires it.
                unsafe { libc::kill(self.0, libc::SIGKILL) };
            }
        }
        let executable = std::env::current_exe().unwrap();
        let quoted = executable.to_string_lossy().replace('\'', "'\\''");
        let f = FakeHack::new(&format!(
            "'{quoted}' --exact runner::tests::escaped_log_pipe_helper --ignored --nocapture &\nwait $!"
        ));
        let pid_file = f.dir.join("escaped.pid");
        let runner = f
            .runner()
            .with_env("HACK_TEST_ESCAPED_LOG_PID", &pid_file.to_string_lossy());
        let s = runner.stream_logs(&["logs", "--json"], None).unwrap();
        loop {
            let event = s.next_timeout(T).expect("escaped writer ready");
            if event.message.as_deref() == Some("escaped-ready") {
                break;
            }
        }
        let escaped = EscapedWriter(std::fs::read_to_string(pid_file).unwrap().parse().unwrap());
        let t = Instant::now();
        drop(s);
        assert!(t.elapsed() < Duration::from_secs(5));
        // The fixture still holds stdout: bounded return did not require EOF.
        // SAFETY: signal zero only checks our still-owned fixture process.
        assert_eq!(unsafe { libc::kill(escaped.0, 0) }, 0);
        drop(escaped);
    }
}
