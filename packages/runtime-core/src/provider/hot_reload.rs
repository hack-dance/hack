//! Whether a pool boot keeps the provider's host-to-guest change notifications ("hot reload on
//! shared source") for its shared project directories.
//!
//! With notifications on, a host edit under a shared directory reaches the guest in about a
//! tenth of a second: the new content is readable and file watchers in containers fire. The
//! price is paid at boot. Before the guest starts, the pinned provider reads every entry under
//! every mounted host directory to build a baseline, and the launch waits for it (it reads
//! them once more in the background after boot, and nothing after that). For a small tree
//! that is a fraction of a second. For a very large one it takes longer than the provider
//! allows a boot to make no progress (30 seconds), and the start fails.
//!
//! So a boot whose shared project directories hold more than [`ENTRY_LIMIT`] entries starts
//! the provider with its notifications off. The share itself is unchanged: the guest reads and
//! writes the same files. What is lost: file watchers in the guest do not fire for host edits,
//! a changed file can read as its old content for up to about five seconds, and lookups of
//! names that do not exist are no longer cached. `HACK_NATIVE_HOT_RELOAD` overrides the choice
//! in either direction.
//!
//! The choice is made once per boot, immediately before `machine start`, recorded in the owner
//! receipt only when it is not the plain default, and applied to every provider invocation for
//! that pool (see `lifecycle::backend`).

use crate::CandidateError;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// The environment setting: `auto` (the default), `on` or `off`.
pub const SETTING: &str = "HACK_NATIVE_HOT_RELOAD";

/// The provider's own switch. Its presence, with any value, turns the notifications off.
pub const PROVIDER_SWITCH: &str = "SMOL_NO_HOT_RELOAD";

/// Entries (files, directories and links together) a pool's shared project directories may
/// hold before `auto` starts the provider with notifications off.
///
/// Chosen from measurement so the provider's scan before boot stays well inside its 30-second
/// limit: at this size it took 3 to 5 seconds on a cold file cache for installed dependency
/// trees and about 9 seconds for the slowest tree measured. The README section "Hot reload on
/// shared source" has the table.
pub const ENTRY_LIMIT: u64 = 100_000;

/// What forcing notifications on costs a start, for the message. From the same measurement.
const FORCED_COST: &str = "takes seconds for every 100,000 entries and fails the start when it \
                           takes the provider longer than 30 seconds";

/// What the user asked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Setting {
    /// On unless the shared directories hold more than [`ENTRY_LIMIT`] entries.
    Auto,
    On,
    Off,
}

impl Setting {
    /// `None`, the empty string and `auto` select [`Setting::Auto`]. Anything else but `on` and
    /// `off` is refused, so a mistyped value never silently selects a default.
    pub fn parse(value: Option<&str>) -> Result<Self, CandidateError> {
        match value {
            None | Some("" | "auto") => Ok(Self::Auto),
            Some("on") => Ok(Self::On),
            Some("off") => Ok(Self::Off),
            Some(_) => Err(CandidateError::new(
                "hot_reload_setting",
                "HACK_NATIVE_HOT_RELOAD must be auto, on or off.",
            )),
        }
    }

    /// Reads [`SETTING`] from this process's environment.
    pub fn from_environment() -> Result<Self, CandidateError> {
        match std::env::var(SETTING) {
            Ok(value) => Self::parse(Some(&value)),
            Err(std::env::VarError::NotPresent) => Self::parse(None),
            Err(std::env::VarError::NotUnicode(_)) => Self::parse(Some("\u{fffd}")),
        }
    }
}

/// Why a boot's choice differs from the plain default.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Reason {
    /// `auto`, and the shared directories hold more than `limit` entries.
    LargeShare,
    /// `HACK_NATIVE_HOT_RELOAD` was `on` or `off`.
    Setting,
}

/// The owner receipt's record of a boot whose choice is worth telling the user: notifications
/// off, or forced on over shared directories past the limit. A boot that keeps them on a
/// small share records nothing, so the receipt of a small project is unchanged.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Choice {
    /// Whether the provider runs with its notifications.
    pub enabled: bool,
    pub reason: Reason,
    /// The entry limit this boot was judged against.
    pub limit: u64,
}

impl Choice {
    /// True when the provider must be started with [`PROVIDER_SWITCH`].
    pub fn off(choice: Option<Self>) -> bool {
        choice.is_some_and(|choice| !choice.enabled)
    }
}

/// Entries under `roots`, counted only until the count passes `limit`.
///
/// No entry is opened and a link is counted but never followed, so the number of entries
/// visited is bounded by `limit` whatever the trees hold. Entry types normally come from the
/// directory listing itself; a file system that does not supply them costs one metadata lookup
/// per entry. A directory that cannot be listed counts as its own entry and nothing more, and
/// the trees may change while they are counted. The result is exact for an unchanging readable
/// tree when it is at most `limit`; a larger result only says "more than `limit`".
pub fn count(roots: &[&Path], limit: u64) -> u64 {
    let mut seen = 0_u64;
    let mut pending: Vec<PathBuf> = roots.iter().map(|root| root.to_path_buf()).collect();
    while let Some(directory) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            seen += 1;
            if seen > limit {
                return seen;
            }
            if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                pending.push(entry.path());
            }
        }
    }
    seen
}

/// The choice for one boot; `None` is the plain default (notifications on, a small share).
pub fn decide(setting: Setting, roots: &[&Path]) -> Option<Choice> {
    decide_with(setting, roots, ENTRY_LIMIT)
}

fn decide_with(setting: Setting, roots: &[&Path], limit: u64) -> Option<Choice> {
    let large = || count(roots, limit) > limit;
    match setting {
        Setting::Off => Some(Choice {
            enabled: false,
            reason: Reason::Setting,
            limit,
        }),
        Setting::On => large().then_some(Choice {
            enabled: true,
            reason: Reason::Setting,
            limit,
        }),
        Setting::Auto => large().then_some(Choice {
            enabled: false,
            reason: Reason::LargeShare,
            limit,
        }),
    }
}

/// What `runtime up` and `runtime status` report for the pool's last boot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Report {
    /// `on` or `off`.
    pub state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<Reason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u64>,
    /// One sentence for the user; absent for the plain default.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// The report for a recorded choice.
pub fn report(recorded: Option<Choice>) -> Report {
    let Some(choice) = recorded else {
        return Report {
            state: "on",
            reason: None,
            limit: None,
            message: None,
        };
    };
    let message = match (choice.enabled, choice.reason) {
        (false, Reason::LargeShare) => format!(
            "Hot reload on shared source is off for this pool: its shared project directories \
             hold more than {} entries, and the provider reads every one before a start, which \
             can outlast its 30-second limit. Host edits reach the guest after up to about 5 \
             seconds and file watchers there do not fire. Set HACK_NATIVE_HOT_RELOAD=on to \
             force it on, or remove installed dependency directories from the host checkout \
             (`localDirectories` keeps them on the VM disk instead).",
            choice.limit
        ),
        (false, Reason::Setting) => "Hot reload on shared source is off for this pool: \
                                     HACK_NATIVE_HOT_RELOAD=off. Host edits reach the guest \
                                     after up to about 5 seconds and file watchers there do \
                                     not fire."
            .into(),
        (true, _) => format!(
            "Hot reload on shared source is forced on (HACK_NATIVE_HOT_RELOAD=on) although the \
             shared project directories hold more than {} entries: the provider reads every one \
             before each start, which {FORCED_COST}.",
            choice.limit
        ),
    };
    Report {
        state: if choice.enabled { "on" } else { "off" },
        reason: Some(choice.reason),
        limit: Some(choice.limit),
        message: Some(message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tree(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "hack-hot-reload-{}-{}-{name}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    /// `directories` directories of `files` files each, directly under `root`.
    fn fill(root: &Path, directories: usize, files: usize) {
        for directory in 0..directories {
            let path = root.join(format!("d{directory}"));
            fs::create_dir(&path).unwrap();
            for file in 0..files {
                fs::write(path.join(format!("f{file}")), b"x").unwrap();
            }
        }
    }

    /// Prints what the bounded count costs on a real tree, and what an unbounded one would.
    #[test]
    #[ignore = "Measurement helper: set HACK_LOCAL_TEST_COUNT_ROOT to a directory"]
    fn measure_the_count_on_a_real_tree() {
        let root =
            PathBuf::from(std::env::var("HACK_LOCAL_TEST_COUNT_ROOT").expect("explicit root"));
        for limit in [ENTRY_LIMIT, u64::MAX] {
            let started = std::time::Instant::now();
            let seen = count(&[&root], limit);
            println!(
                "count with limit {limit}: {seen} entries seen in {:?}",
                started.elapsed()
            );
        }
    }

    #[test]
    fn the_setting_accepts_three_words_and_refuses_the_rest() {
        assert_eq!(Setting::parse(None).unwrap(), Setting::Auto);
        assert_eq!(Setting::parse(Some("")).unwrap(), Setting::Auto);
        assert_eq!(Setting::parse(Some("auto")).unwrap(), Setting::Auto);
        assert_eq!(Setting::parse(Some("on")).unwrap(), Setting::On);
        assert_eq!(Setting::parse(Some("off")).unwrap(), Setting::Off);
        for refused in ["ON", "true", "1", "0", " off", "auto ", "yes"] {
            let error = Setting::parse(Some(refused)).unwrap_err();
            assert_eq!(error.code, "hot_reload_setting", "{refused:?}");
        }
    }

    #[test]
    fn count_is_exact_up_to_the_limit_and_stops_just_past_it() {
        let root = tree("count");
        fill(&root, 4, 5); // 4 directories + 20 files
        assert_eq!(count(&[&root], 1_000), 24);
        assert_eq!(count(&[&root], 24), 24);
        assert_eq!(count(&[&root], 23), 24);
        // Past the limit the walk ends at once: the result says only "more than the limit".
        assert_eq!(count(&[&root], 10), 11);
        assert_eq!(count(&[&root], 0), 1);
        assert_eq!(count(&[], 10), 0);
        assert_eq!(count(&[&root.join("absent")], 10), 0);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn count_adds_every_root_and_never_follows_a_link() {
        let first = tree("first");
        let second = tree("second");
        let outside = tree("outside");
        fill(&first, 1, 3); // 4
        fill(&second, 2, 2); // 6
        fill(&outside, 5, 5); // 30, reachable only through the link
        std::os::unix::fs::symlink(&outside, first.join("link")).unwrap(); // 1
        std::os::unix::fs::symlink(&first, first.join("d0/loop")).unwrap(); // 1
        assert_eq!(count(&[&first, &second], 1_000), 12);
        for root in [first, second, outside] {
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn auto_turns_notifications_off_only_past_the_limit() {
        let root = tree("decide");
        fill(&root, 2, 4); // 10 entries
        assert_eq!(decide_with(Setting::Auto, &[&root], 10), None);
        assert_eq!(
            decide_with(Setting::Auto, &[&root], 9),
            Some(Choice {
                enabled: false,
                reason: Reason::LargeShare,
                limit: 9
            })
        );
        // The total across the pool's projects is what counts.
        assert_eq!(
            decide_with(Setting::Auto, &[&root, &root], 19),
            Some(Choice {
                enabled: false,
                reason: Reason::LargeShare,
                limit: 19
            })
        );
        assert_eq!(decide_with(Setting::Auto, &[], 0), None);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn an_explicit_setting_wins_over_the_count() {
        let root = tree("explicit");
        fill(&root, 2, 4);
        // Forced on over a large share: kept on, and recorded so the user is told the cost.
        assert_eq!(
            decide_with(Setting::On, &[&root], 1),
            Some(Choice {
                enabled: true,
                reason: Reason::Setting,
                limit: 1
            })
        );
        assert_eq!(decide_with(Setting::On, &[&root], 1_000), None);
        assert!(!Choice::off(decide_with(Setting::On, &[&root], 1)));
        assert!(Choice::off(decide_with(Setting::Off, &[&root], 1_000)));
        assert!(!Choice::off(None));
        assert_eq!(
            decide_with(Setting::Off, &[&root], 1_000),
            Some(Choice {
                enabled: false,
                reason: Reason::Setting,
                limit: 1_000
            })
        );
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn the_report_names_the_state_the_reason_and_what_to_do() {
        assert_eq!(
            serde_json::to_value(report(None)).unwrap(),
            serde_json::json!({"state": "on"})
        );
        let large = report(Some(Choice {
            enabled: false,
            reason: Reason::LargeShare,
            limit: 100_000,
        }));
        assert_eq!(large.state, "off");
        let message = large.message.clone().unwrap();
        assert!(message.contains("more than 100000 entries"), "{message}");
        assert!(message.contains("HACK_NATIVE_HOT_RELOAD=on"), "{message}");
        assert!(message.contains("localDirectories"), "{message}");
        assert!(message.contains("up to about 5 seconds"), "{message}");
        assert_eq!(
            serde_json::to_value(&large).unwrap()["reason"],
            serde_json::json!("large_share")
        );
        let setting = report(Some(Choice {
            enabled: false,
            reason: Reason::Setting,
            limit: 100_000,
        }));
        assert_eq!(
            serde_json::to_value(&setting).unwrap()["reason"],
            serde_json::json!("setting")
        );
        assert!(
            setting
                .message
                .unwrap()
                .contains("HACK_NATIVE_HOT_RELOAD=off")
        );
        let forced = report(Some(Choice {
            enabled: true,
            reason: Reason::Setting,
            limit: 100_000,
        }));
        assert_eq!(forced.state, "on");
        let message = forced.message.unwrap();
        assert!(message.contains("forced on"), "{message}");
        assert!(message.contains("more than 100000 entries"), "{message}");
        assert!(message.contains("30 seconds"), "{message}");
    }

    #[test]
    fn the_recorded_choice_round_trips_and_refuses_unknown_fields() {
        let off = Choice {
            enabled: false,
            reason: Reason::LargeShare,
            limit: 100_000,
        };
        let text = serde_json::to_string(&off).unwrap();
        assert_eq!(
            text,
            r#"{"enabled":false,"reason":"large_share","limit":100000}"#
        );
        assert_eq!(serde_json::from_str::<Choice>(&text).unwrap(), off);
        assert!(
            serde_json::from_str::<Choice>(
                r#"{"enabled":false,"reason":"large_share","limit":1,"x":1}"#
            )
            .is_err()
        );
        assert!(
            serde_json::from_str::<Choice>(r#"{"enabled":false,"reason":"other","limit":1}"#)
                .is_err()
        );
    }
}
