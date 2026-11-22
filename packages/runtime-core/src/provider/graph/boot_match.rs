//! Which earlier boot of the pool a dead owner's run belongs to.
//!
//! Recovery used to assume the immediate predecessor boot. It now selects, from the
//! pool's earlier boots (`provider::boot_history::earlier_boots`), the one boot the
//! receipt's own evidence names: its `relay_cleanup` marker (runtime and boot digests
//! of `host_relay::context`), its `relay_startup.control_root` (derived from the raw
//! boot id), or an interrupted one-off job's recorded boot. Zero or several matches
//! refuse, and the current boot is never a candidate.
#[cfg(target_os = "macos")]
use super::*;

/// The single candidate other than `current` that `matches`; `None` when no candidate
/// or more than one distinct candidate matches.
pub(super) fn unique<'a>(
    candidates: &'a [String],
    current: &str,
    matches: impl Fn(&str) -> bool,
) -> Option<&'a str> {
    let mut found: Option<&str> = None;
    for boot in candidates
        .iter()
        .filter(|boot| !boot.is_empty() && boot.as_str() != current)
    {
        if matches(boot) {
            if found.is_some_and(|known| known != boot) {
                return None;
            }
            found = Some(boot);
        }
    }
    found
}

/// The earlier boot this receipt's evidence names, if exactly one does. An unreadable
/// one-off journal is an error, as in the recovery that consumes it.
#[cfg(target_os = "macos")]
pub(super) fn receipt_boot(
    candidate: &Candidate,
    root: &std::path::Path,
    receipt: &Receipt,
    earlier: &[String],
    current: &str,
) -> Result<Option<String>, CandidateError> {
    let path = root.join("one-off.json");
    let one_off = match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(state::io(error)),
        Ok(_) => Some(state::read::<one_off::JobIntent>(&path)?.boot),
    };
    Ok(unique(earlier, current, |boot| {
        let marker = receipt.relay_cleanup.as_ref().is_some_and(|marker| {
            marker.valid()
                && host_relay::context(&receipt.owner, boot).is_ok_and(|context| {
                    marker.boot == context.boot && marker.runtime == context.runtime
                })
        });
        let control_root = receipt.relay_startup.as_ref().is_some_and(|startup| {
            startup::receipt_control_root(&candidate.state_root, receipt, boot)
                .is_ok_and(|expected| startup.control_root == expected)
        });
        marker || control_root || one_off.as_deref() == Some(boot)
    })
    .map(str::to_owned))
}

#[cfg(test)]
mod tests {
    use super::unique;

    fn boots(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    #[test]
    fn selects_an_older_boot_when_only_it_matches() {
        let earlier = boots(&["b3", "b2", "b1"]);
        assert_eq!(unique(&earlier, "b4", |boot| boot == "b1"), Some("b1"));
        assert_eq!(unique(&earlier, "b4", |boot| boot == "b3"), Some("b3"));
    }

    #[test]
    fn refuses_no_match_several_matches_and_the_current_boot() {
        let earlier = boots(&["b3", "b2", "b1"]);
        assert_eq!(unique(&earlier, "b4", |_| false), None);
        assert_eq!(unique(&earlier, "b4", |boot| boot != "b2"), None);
        // A candidate list that names the current boot never selects it.
        let with_current = boots(&["b4", "b3"]);
        assert_eq!(unique(&with_current, "b4", |boot| boot == "b4"), None);
        assert_eq!(
            unique(&with_current, "b4", |boot| boot == "b4" || boot == "b3"),
            Some("b3")
        );
        assert_eq!(unique(&boots(&["", "b1"]), "b2", |_| true), Some("b1"));
        assert_eq!(unique(&[], "b1", |_| true), None);
    }

    #[test]
    fn a_repeated_candidate_is_one_match() {
        let earlier = boots(&["b2", "b1", "b2"]);
        assert_eq!(unique(&earlier, "b3", |boot| boot == "b2"), Some("b2"));
    }
}
