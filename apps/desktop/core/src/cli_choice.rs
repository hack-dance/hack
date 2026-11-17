//! Which Hack CLI the app runs (HACK-2283).
//!
//! Stable Hack is `hack` on PATH. A prerelease channel installs beside it as
//! `hack-next` (on PATH, or `~/.hack-next/bin/hack-next`), and each of its
//! versions keeps its own home, hackd and registry. The app runs one CLI at
//! a time and reads the hackd that CLI reports, so it must know which CLI
//! that is: it discovers both kinds, uses the one the user chose (saved in
//! the app's own settings, never an environment variable), else stable,
//! else the prerelease, and offers the other.
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
}

impl Choice {
    /// Discover installs from this process's PATH and home, and apply the
    /// saved choice.
    #[must_use]
    pub fn load() -> Self {
        let home = std::env::var_os("HOME").map(PathBuf::from);
        let installs = discover(
            std::env::var_os("PATH").as_deref(),
            home.as_deref(),
            trusted,
        );
        let saved = settings_path().and_then(|p| read_saved(&p));
        Self::pick(installs, saved.as_deref())
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
        Self { installs, selected }
    }

    /// The installs the app could switch to.
    pub fn others(&self) -> impl Iterator<Item = &Install> {
        self.installs
            .iter()
            .filter(move |i| Some(*i) != self.selected.as_ref())
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

/// Every install found, stable first, each once (by canonical path).
/// `is_trusted` decides whether a found file may be offered.
pub fn discover(
    path_env: Option<&std::ffi::OsStr>,
    home: Option<&Path>,
    is_trusted: impl Fn(&Path) -> bool,
) -> Vec<Install> {
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
    for (name, channel, path) in candidates {
        let real = std::fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
        if seen.contains(&real) || !is_trusted(&path) {
            continue;
        }
        seen.push(real);
        out.push(Install {
            name,
            channel,
            path,
        });
    }
    out
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
        let found = discover(Some(bin.as_os_str()), Some(&home), |_| true);
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
        let only = Choice::pick(discover(None, Some(&home), |_| true), None);
        assert_eq!(only.selected.unwrap().channel, Channel::Prerelease);
        assert!(discover(None, Some(&home), |_| false).is_empty());
        std::fs::remove_dir_all(&t).unwrap();
    }

    #[test]
    fn the_same_file_on_path_and_in_the_channel_is_listed_once() {
        let t = tree("dedupe");
        let home = t.join("home");
        let next = home.join(".hack-next/bin/hack-next");
        exe(&next);
        let found = discover(
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
