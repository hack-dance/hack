//! What a terminal tab is, and how each kind is started.
//!
//! The app owns the PTY and runs the `hack` CLI (or the user's login shell)
//! in it. It never builds an environment and never sees a value: the only
//! variables it sets are the fixed terminal identity ones (`TERM`,
//! `COLORTERM`, `TERM_PROGRAM`), and the only strings it puts in argv are
//! the CLI's subcommands, validated names and a shell name.
//!
//! | Kind | Command (in the project root) |
//! |---|---|
//! | [`SessionKind::ContainerShell`] | `hack exec <service> -- <shell>`, trying `bash` then `sh` |
//! | [`SessionKind::HostShell`] | the user's login shell, started as a login shell (`argv[0]` = `-zsh`) |
//! | [`SessionKind::HostShellWithEnv`] | `hack host shell --env <overlay> --scope <scope>` |
//! | [`SessionKind::Logs`] | a read-only stream; nothing is launched here |
//!
//! Env values for the last kind are resolved and injected by the CLI inside
//! the PTY. Overlay and scope **names** come from a names-only read done by
//! the caller.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

use crate::pty::PtyOptions;

/// The scope name that means "not one service".
pub const GLOBAL_SCOPE: &str = "global";
/// Shells tried in a container, in order.
pub const CONTAINER_SHELLS: [&str; 2] = ["bash", "sh"];

/// What a tab is showing. Names only; never a value.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SessionKind {
    /// A read-only log stream.
    Logs,
    /// A single authored command in the shared bottom drawer.
    Command {
        label: String,
        expects_password: bool,
        project: bool,
    },
    /// A shell inside a running service container.
    ContainerShell { service: String, shell: String },
    /// The user's login shell on the host, in the project root.
    HostShell { shell: String },
    /// A host shell with a project env overlay injected by the CLI.
    HostShellWithEnv {
        shell: String,
        overlay: String,
        scope: String,
        /// Whether `overlay` is the project's default selection.
        is_default: bool,
    },
}

/// How loud a badge is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BadgeTone {
    Neutral,
    /// The session is not what the user gets by default; make it noticeable.
    Warning,
}

/// A short marker shown beside a tab's label.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Badge {
    pub text: String,
    pub tone: BadgeTone,
}

impl SessionKind {
    /// The tab label: `logs`, `api · sh`, `host · zsh`.
    pub fn label(&self) -> String {
        match self {
            Self::Logs => "logs".into(),
            Self::Command { label, .. } => label.clone(),
            Self::ContainerShell { service, shell } => format!("{service} · {shell}"),
            Self::HostShell { shell } | Self::HostShellWithEnv { shell, .. } => {
                format!("host · {shell}")
            }
        }
    }

    /// The env badge, for a host shell with an overlay: `env staging · api`.
    /// The tone is a warning when the overlay is not the default one.
    pub fn badge(&self) -> Option<Badge> {
        let Self::HostShellWithEnv {
            overlay,
            scope,
            is_default,
            ..
        } = self
        else {
            return None;
        };
        Some(Badge {
            text: format!("env {overlay} · {scope}"),
            tone: if *is_default {
                BadgeTone::Neutral
            } else {
                BadgeTone::Warning
            },
        })
    }

    /// Whether the user can type into this session.
    pub fn is_interactive(&self) -> bool {
        !matches!(self, Self::Logs)
    }
}

/// Why a name was refused.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InvalidName(pub &'static str);

impl std::fmt::Display for InvalidName {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "invalid name: {}", self.0)
    }
}

impl std::error::Error for InvalidName {}

/// A service, overlay or scope name that is safe to pass as one CLI
/// argument: it cannot be read as an option and holds no shell syntax.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Name(String);

impl Name {
    pub fn new(name: &str) -> Result<Self, InvalidName> {
        if name.is_empty() {
            return Err(InvalidName("empty"));
        }
        if name.len() > 128 {
            return Err(InvalidName("longer than 128 bytes"));
        }
        let mut chars = name.chars();
        let first = chars.next().unwrap_or('-');
        if !(first.is_ascii_alphanumeric() || first == '_') {
            return Err(InvalidName(
                "must start with a letter, a digit or an underscore",
            ));
        }
        if !chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.')) {
            return Err(InvalidName(
                "only letters, digits, '_', '-' and '.' are allowed",
            ));
        }
        Ok(Self(name.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Which `TERM` a host session announces.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum TermChoice {
    /// `xterm-256color`: understood everywhere, including over ssh and in
    /// containers.
    #[default]
    Xterm256Color,
    /// `xterm-ghostty` when its terminfo entry is installed on this
    /// machine, otherwise `xterm-256color`.
    GhosttyIfPresent,
}

/// The `hack` executable and the project it acts on.
#[derive(Clone, Debug)]
pub struct HackCli {
    pub program: PathBuf,
    pub project_root: PathBuf,
}

/// The user's login shell.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LoginShell {
    pub path: PathBuf,
}

impl LoginShell {
    /// `$SHELL`, else the passwd entry, else `/bin/sh`.
    pub fn detect() -> Self {
        Self::resolve(std::env::var_os("SHELL").as_deref(), passwd_shell)
    }

    /// [`Self::detect`] with its inputs supplied.
    pub fn resolve(env_shell: Option<&OsStr>, passwd: impl FnOnce() -> Option<PathBuf>) -> Self {
        let usable = |p: &PathBuf| p.is_absolute();
        let path = env_shell
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .filter(usable)
            .or_else(|| passwd().filter(usable))
            .unwrap_or_else(|| PathBuf::from("/bin/sh"));
        Self { path }
    }

    /// The shell's name for labels: `zsh` for `/bin/zsh`.
    pub fn name(&self) -> String {
        self.path
            .file_name()
            .map_or_else(|| "sh".into(), |n| n.to_string_lossy().into_owned())
    }

    /// `argv[0]` for a login shell: the name with a leading `-`. This is the
    /// convention `login(1)` and terminal apps use, and every common shell
    /// (sh, bash, zsh, fish, ksh, dash) honours it; flags such as `-l` are
    /// not accepted by all of them.
    pub fn login_arg0(&self) -> OsString {
        format!("-{}", self.name()).into()
    }
}

/// The current user's shell from the passwd database.
fn passwd_shell() -> Option<PathBuf> {
    use std::os::unix::ffi::OsStringExt;
    let mut buf = vec![0 as libc::c_char; 16 * 1024];
    // SAFETY: passwd is plain old data; getpwuid_r fills it and `result`.
    let mut pwd: libc::passwd = unsafe { std::mem::zeroed() };
    let mut result: *mut libc::passwd = std::ptr::null_mut();
    // SAFETY: the buffer and out-pointers are valid for the call.
    let rc = unsafe {
        libc::getpwuid_r(
            libc::getuid(),
            &mut pwd,
            buf.as_mut_ptr(),
            buf.len(),
            &mut result,
        )
    };
    if rc != 0 || result.is_null() || pwd.pw_shell.is_null() {
        return None;
    }
    // SAFETY: on success pw_shell points at a NUL-terminated string in `buf`.
    let shell = unsafe { std::ffi::CStr::from_ptr(pwd.pw_shell) };
    let bytes = shell.to_bytes().to_vec();
    (!bytes.is_empty()).then(|| PathBuf::from(OsString::from_vec(bytes)))
}

/// Directories searched for a compiled terminfo entry.
pub fn terminfo_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(d) = std::env::var_os("TERMINFO").filter(|d| !d.is_empty()) {
        dirs.push(PathBuf::from(d));
    }
    if let Some(home) = std::env::var_os("HOME").filter(|d| !d.is_empty()) {
        dirs.push(Path::new(&home).join(".terminfo"));
    }
    if let Some(list) = std::env::var_os("TERMINFO_DIRS") {
        dirs.extend(std::env::split_paths(&list).filter(|d| !d.as_os_str().is_empty()));
    }
    for d in [
        "/etc/terminfo",
        "/lib/terminfo",
        "/usr/lib/terminfo",
        "/usr/share/terminfo",
        "/usr/local/share/terminfo",
        "/opt/homebrew/share/terminfo",
        "/Applications/Ghostty.app/Contents/Resources/terminfo",
    ] {
        dirs.push(PathBuf::from(d));
    }
    dirs
}

/// Whether a compiled terminfo entry for `term` is in one of `dirs`. Entries
/// live under the first letter (`x/xterm-ghostty`) or, on macOS, its hex
/// code (`78/xterm-ghostty`).
pub fn terminfo_present(term: &str, dirs: &[PathBuf]) -> bool {
    let Some(first) = term.bytes().next() else {
        return false;
    };
    dirs.iter().any(|d| {
        d.join((first as char).to_string()).join(term).is_file()
            || d.join(format!("{first:02x}")).join(term).is_file()
    })
}

fn term_name(choice: TermChoice, dirs: &[PathBuf]) -> &'static str {
    match choice {
        TermChoice::GhosttyIfPresent if terminfo_present("xterm-ghostty", dirs) => "xterm-ghostty",
        _ => "xterm-256color",
    }
}

/// The only variables the app sets for a session: what kind of terminal
/// this is. Everything else is inherited or injected by the CLI.
pub fn terminal_identity(term: &str) -> Vec<(OsString, OsString)> {
    vec![
        ("TERM".into(), term.into()),
        ("COLORTERM".into(), "truecolor".into()),
        ("TERM_PROGRAM".into(), "hack".into()),
    ]
}

/// One way to start a session.
#[derive(Clone, Debug)]
pub struct Launch {
    pub kind: SessionKind,
    pub options: PtyOptions,
}

/// The attempts for one tab, in order. A later attempt is used only when
/// the one before it could not start its program (exit status 126 or 127
/// straight away, before any input): see `terminal::TerminalCore::session`.
#[derive(Clone, Debug)]
pub struct SessionPlan {
    pub attempts: Vec<Launch>,
}

impl SessionPlan {
    /// The kind the tab starts as.
    pub fn kind(&self) -> &SessionKind {
        &self.attempts[0].kind
    }
}

fn base(program: &Path, cwd: &Path, term: &str) -> PtyOptions {
    let mut options = PtyOptions::new(program);
    options.env = terminal_identity(term);
    options.cwd = Some(cwd.to_owned());
    options
}

/// A shell in a running service container: `hack exec <service> -- bash`,
/// then `-- sh` if the image has no bash.
pub fn container_shell(cli: &HackCli, service: &Name) -> SessionPlan {
    let attempts = CONTAINER_SHELLS
        .iter()
        .map(|shell| {
            // Containers rarely carry other terminfo entries.
            let mut options = base(&cli.program, &cli.project_root, "xterm-256color");
            options.args = vec![
                "exec".into(),
                service.as_str().into(),
                "--".into(),
                (*shell).into(),
            ];
            Launch {
                kind: SessionKind::ContainerShell {
                    service: service.as_str().to_owned(),
                    shell: (*shell).to_owned(),
                },
                options,
            }
        })
        .collect();
    SessionPlan { attempts }
}

/// The user's login shell on the host, as an interactive login shell in the
/// project root, so their profile and rc files load as in their terminal.
pub fn host_shell(project_root: &Path, shell: &LoginShell, term: TermChoice) -> SessionPlan {
    let mut options = base(&shell.path, project_root, term_name(term, &terminfo_dirs()));
    options.arg0 = Some(shell.login_arg0());
    SessionPlan {
        attempts: vec![Launch {
            kind: SessionKind::HostShell {
                shell: shell.name(),
            },
            options,
        }],
    }
}

/// A host shell with a project env overlay: `hack host shell --env <overlay>
/// --scope <scope>`. The CLI resolves and injects the values and starts
/// `$SHELL -l`; the app passes names only.
///
/// `shell` labels the tab. The CLI picks the shell itself from `$SHELL` and
/// falls back to `/bin/sh` (not the passwd entry) when it is unset, so pass
/// the same `$SHELL` the session will inherit.
pub fn host_shell_with_env(
    cli: &HackCli,
    shell: &LoginShell,
    overlay: &Name,
    scope: &Name,
    is_default: bool,
    term: TermChoice,
) -> SessionPlan {
    let mut options = base(
        &cli.program,
        &cli.project_root,
        term_name(term, &terminfo_dirs()),
    );
    options.args = vec![
        "host".into(),
        "shell".into(),
        "--env".into(),
        overlay.as_str().into(),
        "--scope".into(),
        scope.as_str().into(),
    ];
    SessionPlan {
        attempts: vec![Launch {
            kind: SessionKind::HostShellWithEnv {
                shell: shell.name(),
                overlay: overlay.as_str().to_owned(),
                scope: scope.as_str().to_owned(),
                is_default,
            },
            options,
        }],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cli() -> HackCli {
        HackCli {
            program: "/opt/hack/bin/hack".into(),
            project_root: "/work/project".into(),
        }
    }

    fn argv(o: &PtyOptions) -> Vec<String> {
        std::iter::once(o.program.to_string_lossy().into_owned())
            .chain(o.args.iter().map(|a| a.to_string_lossy().into_owned()))
            .collect()
    }

    fn env_names(o: &PtyOptions) -> Vec<String> {
        o.env
            .iter()
            .map(|(k, _)| k.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn labels_and_badges_use_names_only() {
        assert_eq!(SessionKind::Logs.label(), "logs");
        assert_eq!(SessionKind::Logs.badge(), None);
        assert!(!SessionKind::Logs.is_interactive());
        let c = SessionKind::ContainerShell {
            service: "api".into(),
            shell: "sh".into(),
        };
        assert_eq!((c.label().as_str(), c.badge()), ("api · sh", None));
        let h = SessionKind::HostShell {
            shell: "zsh".into(),
        };
        assert_eq!((h.label().as_str(), h.badge()), ("host · zsh", None));
        let env = |is_default| SessionKind::HostShellWithEnv {
            shell: "zsh".into(),
            overlay: "staging".into(),
            scope: "api".into(),
            is_default,
        };
        assert_eq!(env(false).label(), "host · zsh");
        assert_eq!(
            env(false).badge(),
            Some(Badge {
                text: "env staging · api".into(),
                tone: BadgeTone::Warning
            }),
            "a non-default overlay is a warning"
        );
        assert_eq!(env(true).badge().unwrap().tone, BadgeTone::Neutral);
    }

    #[test]
    fn names_cannot_be_options_or_shell_syntax() {
        for ok in ["api", "web-1", "db_2", "staging", "global", "a.b", "9lives"] {
            assert!(Name::new(ok).is_ok(), "{ok}");
        }
        for bad in [
            "", "-x", "--env", ".hidden", "a b", "a;b", "a/b", "$(x)", "a\nb", "é", "a=b",
        ] {
            assert!(Name::new(bad).is_err(), "{bad:?}");
        }
        assert!(Name::new(&"a".repeat(129)).is_err());
    }

    #[test]
    fn a_container_shell_runs_hack_exec_with_bash_then_sh() {
        let plan = container_shell(&cli(), &Name::new("api").unwrap());
        let got: Vec<_> = plan.attempts.iter().map(|a| argv(&a.options)).collect();
        assert_eq!(
            got,
            [
                ["/opt/hack/bin/hack", "exec", "api", "--", "bash"],
                ["/opt/hack/bin/hack", "exec", "api", "--", "sh"],
            ]
        );
        assert_eq!(
            plan.attempts[1].kind,
            SessionKind::ContainerShell {
                service: "api".into(),
                shell: "sh".into()
            }
        );
        for a in &plan.attempts {
            assert_eq!(a.options.cwd.as_deref(), Some(Path::new("/work/project")));
            assert_eq!(a.options.arg0, None);
            assert!(
                !a.options.env_clear,
                "the CLI inherits the app's environment"
            );
            assert_eq!(env_names(&a.options), ["TERM", "COLORTERM", "TERM_PROGRAM"]);
        }
    }

    #[test]
    fn a_host_shell_is_the_login_shell_started_as_a_login_shell() {
        let shell = LoginShell {
            path: "/usr/bin/zsh".into(),
        };
        let plan = host_shell(Path::new("/work/project"), &shell, TermChoice::default());
        let [launch] = plan.attempts.as_slice() else {
            panic!("one attempt");
        };
        assert_eq!(
            argv(&launch.options),
            ["/usr/bin/zsh"],
            "no flags, no command"
        );
        assert_eq!(launch.options.arg0.as_deref(), Some(OsStr::new("-zsh")));
        assert_eq!(
            launch.options.cwd.as_deref(),
            Some(Path::new("/work/project"))
        );
        assert_eq!(
            launch.options.env,
            [
                ("TERM".into(), "xterm-256color".into()),
                ("COLORTERM".into(), "truecolor".into()),
                ("TERM_PROGRAM".into(), "hack".into()),
            ] as [(OsString, OsString); 3]
        );
        assert_eq!(
            launch.kind,
            SessionKind::HostShell {
                shell: "zsh".into()
            }
        );
    }

    #[test]
    fn a_host_shell_with_env_passes_names_to_the_cli_and_nothing_else() {
        let shell = LoginShell {
            path: "/bin/zsh".into(),
        };
        let plan = host_shell_with_env(
            &cli(),
            &shell,
            &Name::new("staging").unwrap(),
            &Name::new("api").unwrap(),
            false,
            TermChoice::default(),
        );
        let [launch] = plan.attempts.as_slice() else {
            panic!("one attempt");
        };
        assert_eq!(
            argv(&launch.options),
            [
                "/opt/hack/bin/hack",
                "host",
                "shell",
                "--env",
                "staging",
                "--scope",
                "api"
            ]
        );
        assert_eq!(
            env_names(&launch.options),
            ["TERM", "COLORTERM", "TERM_PROGRAM"]
        );
        assert_eq!(
            launch.kind.badge().map(|b| (b.text, b.tone)),
            Some(("env staging · api".into(), BadgeTone::Warning))
        );
    }

    #[test]
    fn the_login_shell_is_shell_then_passwd_then_sh() {
        let pw = || Some(PathBuf::from("/usr/bin/fish"));
        let r = |env: Option<&str>, pw: Option<PathBuf>| {
            LoginShell::resolve(env.map(OsStr::new), || pw).path
        };
        assert_eq!(r(Some("/bin/zsh"), pw()), Path::new("/bin/zsh"));
        assert_eq!(r(None, pw()), Path::new("/usr/bin/fish"));
        assert_eq!(r(Some(""), pw()), Path::new("/usr/bin/fish"));
        assert_eq!(r(Some("zsh"), pw()), Path::new("/usr/bin/fish"), "relative");
        assert_eq!(r(None, None), Path::new("/bin/sh"));
        let fish = LoginShell {
            path: "/usr/bin/fish".into(),
        };
        assert_eq!(
            (fish.name().as_str(), fish.login_arg0()),
            ("fish", "-fish".into())
        );
        // The real lookup returns something absolute on any machine.
        assert!(LoginShell::detect().path.is_absolute());
    }

    #[test]
    fn xterm_ghostty_is_used_only_when_its_terminfo_is_installed() {
        let dir = crate::testutil::TempHome::new();
        let dirs = vec![dir.path().join("a"), dir.path().join("b")];
        assert!(!terminfo_present("xterm-ghostty", &dirs));
        assert_eq!(
            term_name(TermChoice::GhosttyIfPresent, &dirs),
            "xterm-256color"
        );
        // The first-letter layout.
        std::fs::create_dir_all(dirs[0].join("x")).unwrap();
        std::fs::write(dirs[0].join("x/xterm-ghostty"), b"\x1a\x01").unwrap();
        assert!(terminfo_present("xterm-ghostty", &dirs));
        assert_eq!(
            term_name(TermChoice::GhosttyIfPresent, &dirs),
            "xterm-ghostty"
        );
        assert_eq!(
            term_name(TermChoice::Xterm256Color, &dirs),
            "xterm-256color",
            "the default never switches"
        );
        // The hex layout macOS uses.
        std::fs::create_dir_all(dirs[1].join("78")).unwrap();
        std::fs::write(dirs[1].join("78/xterm-kitty"), b"\x1a\x01").unwrap();
        assert!(terminfo_present("xterm-kitty", &dirs));
        assert!(!terminfo_present("", &dirs));
    }
}
