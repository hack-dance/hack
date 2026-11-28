//! Which Hack CLI the app runs (HACK-2283).
//!
//! Stable Hack is `hack` on PATH. A prerelease channel installs beside it as
//! `hack-next` (on PATH, or `~/.hack-next/bin/hack-next`), and each of its
//! versions keeps its own home, hackd and registry. The app runs one CLI at
//! a time and reads the hackd that CLI reports, so it must know which CLI
//! that is: it discovers both kinds and prefers a supported version. A
//! compatible saved choice wins, then stable, then the prerelease.
//!
//! Only installs no other user can change are offered.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Stable or a prerelease channel.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Channel {
    Stable,
    Prerelease,
}

impl Channel {
    #[must_use]
    pub fn label(self) -> &'static str {
        match self {
            Self::Stable => "stable",
            Self::Prerelease => "prerelease",
        }
    }
}

/// One Hack CLI on this machine.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Install {
    /// The command name: `hack` or `hack-next`.
    pub name: String,
    pub channel: Channel,
    /// Absolute path, as found (a launcher, not what it resolves to).
    pub path: PathBuf,
}

/// The installs found and the one the app runs.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Choice {
    pub installs: Vec<Install>,
    pub selected: Option<Install>,
    /// CLIs found but refused: another user can change them.
    pub rejected: Vec<PathBuf>,
    compatible: Vec<PathBuf>,
}

impl Choice {
    /// Discover installs from this process's PATH and home, and apply the
    /// saved choice.
    #[must_use]
    pub fn load() -> Self {
        let home = std::env::var_os("HOME").map(PathBuf::from);
        let (installs, rejected) = discover(
            std::env::var_os("PATH").as_deref(),
            home.as_deref(),
            trusted,
        );
        let saved = settings_path().and_then(|p| read_saved(&p));
        Self {
            rejected,
            ..Self::pick(installs, saved.as_deref()).prefer_supported(|install| {
                crate::runner::CliRunner::new(&install.path)
                    .with_env("HACK_DAEMON_AUTOSTART_DISABLE", "1")
                    .version(std::time::Duration::from_secs(5))
                    .ok()
            })
        }
    }

    /// Keep the normal preference order among compatible installs. If none
    /// qualify, show the first known mismatch before an unreadable install.
    fn prefer_supported(mut self, version: impl Fn(&Install) -> Option<String>) -> Self {
        if self.installs.len() < 2 {
            return self;
        }
        let mut compatible = Vec::new();
        let mut mismatch = None;
        for install in self.selected.iter().chain(self.others()) {
            if let Some(found) = version(install) {
                if crate::setup::supported_cli(&found) {
                    compatible.push(install.path.clone());
                } else {
                    mismatch.get_or_insert(install);
                }
            }
        }
        if let Some(install) = self
            .installs
            .iter()
            .find(|install| Some(&install.path) == compatible.first())
            .or(mismatch)
        {
            self.selected = Some(install.clone());
        }
        self.compatible = compatible;
        self
    }

    /// Choose among `installs`: the saved path when it is still one of them,
    /// else stable, else the first prerelease.
    #[must_use]
    pub fn pick(installs: Vec<Install>, saved: Option<&Path>) -> Self {
        let selected = saved
            .and_then(|s| installs.iter().find(|i| i.path == s))
            .or_else(|| installs.iter().find(|i| i.channel == Channel::Stable))
            .or_else(|| installs.first())
            .cloned();
        Self {
            installs,
            selected,
            rejected: Vec::new(),
            compatible: Vec::new(),
        }
    }

    /// The other installs found on this machine.
    pub fn others(&self) -> impl Iterator<Item = &Install> {
        self.installs
            .iter()
            .filter(move |i| Some(*i) != self.selected.as_ref())
    }

    /// Alternatives with a confirmed, compatible version.
    pub fn compatible_alternatives(&self) -> impl Iterator<Item = &Install> {
        self.others().filter(|i| self.compatible.contains(&i.path))
    }

    /// Select `path` (one of the installs) and save it as the choice.
    ///
    /// # Errors
    /// `path` is not a discovered install, or the settings file could not
    /// be written (the selection still applies for this session).
    pub fn select(&mut self, path: &Path) -> Result<(), String> {
        let install = self
            .installs
            .iter()
            .find(|i| i.path == path)
            .cloned()
            .ok_or_else(|| format!("{} is not a Hack CLI the app found", path.display()))?;
        self.selected = Some(install);
        let file = settings_path().ok_or("no settings folder (HOME is unset)")?;
        write_saved(&file, path).map_err(|e| format!("could not save the choice: {e}"))
    }
}

/// Every install found, stable first, each once (by canonical path), and
/// the files `is_trusted` refused.
pub fn discover(
    path_env: Option<&std::ffi::OsStr>,
    home: Option<&Path>,
    is_trusted: impl Fn(&Path) -> bool,
) -> (Vec<Install>, Vec<PathBuf>) {
    let mut candidates: Vec<(String, Channel, PathBuf)> = Vec::new();
    if let Some(p) = crate::runner::resolve_on_path("hack", path_env) {
        candidates.push(("hack".into(), Channel::Stable, p));
    }
    if let Some(p) = crate::runner::resolve_on_path("hack-next", path_env) {
        candidates.push(("hack-next".into(), Channel::Prerelease, p));
    }
    if let Some(home) = home.filter(|h| h.is_absolute()) {
        let p = home.join(".hack-next/bin/hack-next");
        if p.is_file() {
            candidates.push(("hack-next".into(), Channel::Prerelease, p));
        }
    }
    let mut seen: Vec<PathBuf> = Vec::new();
    let mut out = Vec::new();
    let mut rejected = Vec::new();
    for (name, channel, path) in candidates {
        let real = std::fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
        if seen.contains(&real) {
            continue;
        }
        seen.push(real);
        if !is_trusted(&path) {
            rejected.push(path);
            continue;
        }
        out.push(Install {
            name,
            channel,
            path,
        });
    }
    (out, rejected)
}

/// No other user can change the file or the directories above it.
fn trusted(path: &Path) -> bool {
    // SAFETY: getuid has no preconditions and cannot fail.
    let uid = unsafe { libc::getuid() };
    crate::source::trusted_tool_path(path, uid, false)
        .is_some_and(|real| crate::source::trusted_interpreter(&real, uid, 4, false))
}

/// The app's settings file: `~/Library/Application Support/dance.hack.desktop`
/// on macOS, `$XDG_CONFIG_HOME/hack-desktop` (else `~/.config/hack-desktop`)
/// elsewhere.
#[must_use]
pub fn settings_path() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|h| h.is_absolute())?;
    let dir = if cfg!(target_os = "macos") {
        home.join("Library/Application Support/dance.hack.desktop")
    } else {
        std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .filter(|d| d.is_absolute())
            .unwrap_or_else(|| home.join(".config"))
            .join("hack-desktop")
    };
    Some(dir.join("settings.json"))
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Saved {
    #[serde(default)]
    cli: Option<PathBuf>,
}

/// The saved CLI path, if any.
#[must_use]
pub fn read_saved(file: &Path) -> Option<PathBuf> {
    let text = std::fs::read_to_string(file).ok()?;
    serde_json::from_str::<Saved>(&text).ok()?.cli
}

/// Save `cli` as the choice: a private folder, written atomically.
///
/// # Errors
/// The folder or file could not be written.
pub fn write_saved(file: &Path, cli: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::{DirBuilderExt as _, OpenOptionsExt as _};
    let dir = file
        .parent()
        .ok_or_else(|| std::io::Error::other("settings file has no folder"))?;
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)?;
    let body = serde_json::to_vec_pretty(&Saved {
        cli: Some(cli.to_path_buf()),
    })
    .map_err(std::io::Error::other)?;
    let tmp = dir.join(format!(".settings.{}.tmp", std::process::id()));
    {
        use std::io::Write as _;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&tmp)?;
        f.write_all(&body)?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, file)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt as _;

    fn tree(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("hack-cli-choice-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn exe(path: &Path) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[test]
    fn both_installs_are_found_stable_first_and_the_saved_one_wins() {
        let t = tree("both");
        let bin = t.join("bin");
        exe(&bin.join("hack"));
        let home = t.join("home");
        exe(&home.join(".hack-next/bin/hack-next"));
        let (found, _) = discover(Some(bin.as_os_str()), Some(&home), |_| true);
        assert_eq!(
            found
                .iter()
                .map(|i| (i.name.as_str(), i.channel))
                .collect::<Vec<_>>(),
            [
                ("hack", Channel::Stable),
                ("hack-next", Channel::Prerelease)
            ]
        );
        let default = Choice::pick(found.clone(), None);
        assert_eq!(default.selected.as_ref().unwrap().channel, Channel::Stable);
        assert_eq!(default.others().count(), 1);
        let next = home.join(".hack-next/bin/hack-next");
        let saved = Choice::pick(found.clone(), Some(&next));
        assert_eq!(saved.selected.as_ref().unwrap().path, next);
        // A saved path that is no longer installed falls back to stable.
        let gone = Choice::pick(found, Some(Path::new("/nowhere/hack-next")));
        assert_eq!(gone.selected.unwrap().channel, Channel::Stable);
        std::fs::remove_dir_all(&t).unwrap();
    }

    #[test]
    fn a_prerelease_alone_is_used_and_untrusted_installs_are_never_offered() {
        let t = tree("alone");
        let home = t.join("home");
        exe(&home.join(".hack-next/bin/hack-next"));
        let only = Choice::pick(discover(None, Some(&home), |_| true).0, None);
        assert_eq!(only.selected.unwrap().channel, Channel::Prerelease);
        let (none, rejected) = discover(None, Some(&home), |_| false);
        assert!(none.is_empty());
        assert_eq!(rejected, [home.join(".hack-next/bin/hack-next")]);
        std::fs::remove_dir_all(&t).unwrap();
    }

    #[test]
    fn a_switch_is_offered_only_to_a_confirmed_compatible_install() {
        let stable = Install {
            name: "hack".into(),
            channel: Channel::Stable,
            path: "/bin/hack".into(),
        };
        let next = Install {
            name: "hack-next".into(),
            channel: Channel::Prerelease,
            path: "/bin/hack-next".into(),
        };
        let choice = |stable_version: Option<&str>| {
            Choice::pick(vec![stable.clone(), next.clone()], Some(&next.path)).prefer_supported(
                |install| {
                    if install == &stable {
                        stable_version
                    } else {
                        Some("5.0.0-next.24")
                    }
                    .map(str::to_owned)
                },
            )
        };
        assert_eq!(choice(Some("4.3.1")).compatible_alternatives().count(), 0);
        assert_eq!(choice(None).compatible_alternatives().count(), 0);
        assert_eq!(
            choice(Some("5.0.0"))
                .compatible_alternatives()
                .collect::<Vec<_>>(),
            [&stable],
        );
    }

    #[test]
    fn a_supported_install_wins_and_a_known_mismatch_is_the_fallback() {
        let stable = Install {
            name: "hack".into(),
            channel: Channel::Stable,
            path: "/bin/hack".into(),
        };
        let next = Install {
            name: "hack-next".into(),
            channel: Channel::Prerelease,
            path: "/bin/hack-next".into(),
        };
        let choose =
            |stable_version: Option<&str>, next_version: Option<&str>, saved: Option<&Path>| {
                Choice::pick(vec![stable.clone(), next.clone()], saved)
                    .prefer_supported(|i| {
                        if i == &stable {
                            stable_version
                        } else {
                            next_version
                        }
                        .map(str::to_owned)
                    })
                    .selected
                    .unwrap()
            };
        assert_eq!(choose(Some("4.3.1"), Some("5.0.0-next.24"), None), next);
        assert_eq!(
            choose(Some("4.3.1"), Some("5.0.0-next.24"), Some(&stable.path)),
            next
        );
        assert_eq!(choose(Some("5.0.0"), Some("5.0.0-next.24"), None), stable);
        assert_eq!(
            choose(Some("5.0.0"), Some("5.0.0-next.24"), Some(&next.path)),
            next
        );
        assert_eq!(choose(Some("4.3.1"), None, None), stable);
        assert_eq!(choose(None, Some("6.0.0"), None), next);
    }

    #[test]
    fn the_same_file_on_path_and_in_the_channel_is_listed_once() {
        let t = tree("dedupe");
        let home = t.join("home");
        let next = home.join(".hack-next/bin/hack-next");
        exe(&next);
        let (found, _) = discover(
            Some(next.parent().unwrap().as_os_str()),
            Some(&home),
            |_| true,
        );
        assert_eq!(found.len(), 1);
        std::fs::remove_dir_all(&t).unwrap();
    }

    #[test]
    fn the_choice_is_saved_privately_and_read_back() {
        let t = tree("saved");
        let file = t.join("cfg/hack-desktop/settings.json");
        write_saved(&file, Path::new("/opt/hack-next")).unwrap();
        assert_eq!(
            read_saved(&file).as_deref(),
            Some(Path::new("/opt/hack-next"))
        );
        let mode = std::fs::metadata(&file).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        let dir = std::fs::metadata(file.parent().unwrap())
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(dir, 0o700);
        std::fs::remove_dir_all(&t).unwrap();
    }
}
