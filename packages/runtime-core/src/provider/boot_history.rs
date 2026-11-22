//! Bounded history of a pool's earlier guest boots.
//!
//! `owner.json` keeps only the current and the previous guest boot id, and
//! `Owner::begin_boot` drops the older one on every new boot. Dead-owner recovery
//! needs the raw id of the boot a run belongs to (its host relay evidence is keyed by
//! it), so each boot first records the ids it is about to supersede here.
//!
//! The sidecar is bound to the pool's owner token: a file for another token (an
//! earlier pool at the same state root) is treated as empty and replaced on the next
//! record. It never grants authority by itself; every recovery still matches its own
//! receipt evidence against one of these boots and never accepts the current one.
//!
//! Failure policy: an unreadable or invalid sidecar never blocks a boot (recording
//! replaces it), but reading it for recovery fails closed.
use super::state::{self, Owner};
use crate::{Candidate, CandidateError};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Earlier boots kept, newest first.
const LIMIT: usize = 16;
const VERSION: u32 = 1;

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct History {
    version: u32,
    owner: String,
    boots: Vec<String>,
}

fn path(state_root: &Path) -> PathBuf {
    state_root.join("run/smolvm/boot-history.json")
}

fn invalid() -> CandidateError {
    CandidateError::new(
        "invalid_receipt",
        "Invalid pool boot history; refusing recovery from an earlier boot.",
    )
}

/// The recorded boots for `owner`, newest first. Absent, or recorded for another
/// owner token: empty. Unreadable or invalid: an error.
fn load(state_root: &Path, owner: &str) -> Result<Vec<String>, CandidateError> {
    let path = path(state_root);
    match std::fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(state::io(error)),
        Ok(_) => {}
    }
    let history: History = state::read_bounded(&path, 64 * 1024)?;
    if history.version != VERSION
        || history.boots.len() > LIMIT
        || history.boots.iter().any(|boot| !valid_boot(boot))
    {
        return Err(invalid());
    }
    if history.owner != owner {
        return Ok(Vec::new());
    }
    Ok(history.boots)
}

fn valid_boot(boot: &str) -> bool {
    !boot.is_empty() && boot.len() <= 128 && !boot.bytes().any(|b| b.is_ascii_control())
}

fn push_unique(boots: &mut Vec<String>, boot: &str) {
    if !boots.iter().any(|known| known == boot) {
        boots.push(boot.to_owned());
    }
}

/// Record the boots a new boot is about to supersede. Call it before
/// `Owner::begin_boot`, which drops the older id. A `None` or empty boot is never
/// recorded. An unreadable or invalid sidecar is replaced, never a reason to refuse.
pub(crate) fn record(candidate: &Candidate, owner: &Owner) -> Result<(), CandidateError> {
    record_at(&candidate.state_root, owner)
}

fn record_at(state_root: &Path, owner: &Owner) -> Result<(), CandidateError> {
    let known = load(state_root, &owner.token);
    let mut boots = Vec::new();
    for boot in [&owner.guest_boot_id, &owner.previous_guest_boot_id]
        .into_iter()
        .flatten()
        .filter(|boot| valid_boot(boot))
    {
        push_unique(&mut boots, boot);
    }
    for boot in known.as_deref().unwrap_or_default() {
        push_unique(&mut boots, boot);
    }
    boots.truncate(LIMIT);
    let present = std::fs::symlink_metadata(path(state_root)).is_ok();
    // Nothing to record and nothing to replace, or the valid history is unchanged.
    if (boots.is_empty() && !present) || known.as_ref().is_ok_and(|known| *known == boots) {
        return Ok(());
    }
    // The caller (`start_pool`, just before `begin_boot`) holds the pool's startup
    // lease, which serializes boots, so a leftover pending file is an interrupted
    // write of this sidecar, not a concurrent one.
    match std::fs::remove_file(path(state_root).with_extension("pending")) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
            return Err(state::io(error));
        }
        _ => {}
    }
    state::write(
        &path(state_root),
        &History {
            version: VERSION,
            owner: owner.token.clone(),
            boots,
        },
    )
}

/// Add `boot`, an earlier boot that a dead owner's recovery matched from the run's own
/// evidence rather than from this history (a run stranded before the history existed,
/// whose bridge slots still name its boot), so the recovery's later steps (resume,
/// publisher retirement, bridge cleanup) find it here like any recorded boot. It goes
/// first: only membership matters, and the next boot keeps it ahead of older entries.
///
/// Called under the provider lease before the recovery writes its intent. A boot needs
/// a stopped pool, and stopping it takes that lease, so no `record` runs meanwhile.
/// The current boot is never added; an invalid history refuses (recovery fails closed).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn adopt(candidate: &Candidate, owner: &Owner, boot: &str) -> Result<(), CandidateError> {
    adopt_at(&candidate.state_root, owner, boot)
}

fn adopt_at(state_root: &Path, owner: &Owner, boot: &str) -> Result<(), CandidateError> {
    if !valid_boot(boot) || owner.guest_boot_id.as_deref() == Some(boot) {
        return Err(invalid());
    }
    let known = load(state_root, &owner.token)?;
    if known.iter().any(|known| known == boot)
        || owner.previous_guest_boot_id.as_deref() == Some(boot)
    {
        return Ok(());
    }
    let mut boots = vec![boot.to_owned()];
    boots.extend(known);
    boots.truncate(LIMIT);
    match std::fs::remove_file(path(state_root).with_extension("pending")) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
            return Err(state::io(error));
        }
        _ => {}
    }
    state::write(
        &path(state_root),
        &History {
            version: VERSION,
            owner: owner.token.clone(),
            boots,
        },
    )
}

/// The earlier boots of this pool a dead owner's run may belong to: the previous boot
/// (when recorded), then the sidecar's entries, deduplicated, never the current boot.
/// An unreadable or invalid sidecar is an error (recovery fails closed).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn earlier_boots(
    candidate: &Candidate,
    owner: &Owner,
) -> Result<Vec<String>, CandidateError> {
    earlier_boots_at(&candidate.state_root, owner)
}

fn earlier_boots_at(state_root: &Path, owner: &Owner) -> Result<Vec<String>, CandidateError> {
    let recorded = load(state_root, &owner.token)?;
    let mut boots = Vec::new();
    for boot in owner
        .previous_guest_boot_id
        .iter()
        .chain(recorded.iter())
        .filter(|boot| valid_boot(boot))
    {
        push_unique(&mut boots, boot);
    }
    boots.retain(|boot| owner.guest_boot_id.as_deref() != Some(boot.as_str()));
    Ok(boots)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    struct Root(PathBuf);
    impl Drop for Root {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn root() -> Root {
        let mut random = [0_u8; 16];
        std::fs::File::open("/dev/urandom")
            .unwrap()
            .read_exact(&mut random)
            .unwrap();
        let name: String = random.iter().map(|b| format!("{b:02x}")).collect();
        let path = std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .join(format!("hack-boot-history-test-{name}"));
        state::private_directory(&path.join("run/smolvm")).unwrap();
        Root(path)
    }
    fn owner(token: &str, current: Option<&str>, previous: Option<&str>) -> Owner {
        serde_json::from_value(serde_json::json!({
            "version":1, "checkout":"/fixture", "token":token, "machine":"fixture",
            "short_home":"/fixture", "created":true, "phase":"running", "process":null,
            "storage":null, "overlay":null, "guest_boot_id":current,
            "previous_guest_boot_id":previous, "daemon_pid":null, "daemon_start":null,
            "rootfs_digest":null
        }))
        .unwrap()
    }
    /// One boot: record, then supersede exactly as the lifecycle does.
    fn boot(root: &Path, owner: &mut Owner, next: &str) {
        record_at(root, owner).unwrap();
        owner.begin_boot();
        owner.guest_boot_id = Some(next.into());
    }
    fn stored(root: &Path) -> serde_json::Value {
        serde_json::from_slice(&std::fs::read(path(root)).unwrap()).unwrap()
    }

    #[test]
    fn records_superseded_boots_newest_first_and_never_the_current_boot() {
        let root = root();
        let mut pool = owner("token", Some("b1"), None);
        boot(&root.0, &mut pool, "b2");
        boot(&root.0, &mut pool, "b3");
        boot(&root.0, &mut pool, "b4");
        assert_eq!(pool.previous_guest_boot_id.as_deref(), Some("b3"));
        assert_eq!(
            stored(&root.0),
            serde_json::json!({"version":1,"owner":"token","boots":["b3","b2","b1"]})
        );
        assert_eq!(
            earlier_boots_at(&root.0, &pool).unwrap(),
            ["b3", "b2", "b1"]
        );
        // The current boot is excluded even if a sidecar names it.
        state::write(
            &path(&root.0),
            &History {
                version: 1,
                owner: "token".into(),
                boots: vec!["b4".into(), "b2".into()],
            },
        )
        .unwrap();
        assert_eq!(earlier_boots_at(&root.0, &pool).unwrap(), ["b3", "b2"]);
    }

    /// A run stranded before the history existed: its boot is adopted once, first,
    /// and then found by every later step exactly like a recorded boot.
    #[test]
    fn adopts_a_proven_earlier_boot_once_and_never_the_current_boot() {
        let root = root();
        let mut pool = owner("token", Some("b1"), None);
        boot(&root.0, &mut pool, "b2");
        boot(&root.0, &mut pool, "b3");
        adopt_at(&root.0, &pool, "b0").unwrap();
        assert_eq!(
            earlier_boots_at(&root.0, &pool).unwrap(),
            ["b2", "b0", "b1"]
        );
        let once = std::fs::read(path(&root.0)).unwrap();
        // Already known (recorded, adopted or previous): unchanged.
        adopt_at(&root.0, &pool, "b0").unwrap();
        adopt_at(&root.0, &pool, "b1").unwrap();
        adopt_at(&root.0, &pool, "b2").unwrap();
        assert_eq!(std::fs::read(path(&root.0)).unwrap(), once);
        // The current boot and an invalid id are refused without a write.
        assert!(adopt_at(&root.0, &pool, "b3").is_err());
        assert!(adopt_at(&root.0, &pool, "").is_err());
        assert_eq!(std::fs::read(path(&root.0)).unwrap(), once);
        // The next boot keeps it.
        boot(&root.0, &mut pool, "b4");
        assert!(earlier_boots_at(&root.0, &pool).unwrap().contains(&"b0".to_owned()));
    }

    #[test]
    fn adoption_refuses_an_invalid_history_and_starts_one_for_a_new_owner() {
        let root = root();
        let pool = owner("token", Some("b2"), Some("b1"));
        std::fs::write(path(&root.0), b"not json").unwrap();
        assert!(adopt_at(&root.0, &pool, "b0").is_err());
        assert_eq!(std::fs::read(path(&root.0)).unwrap(), b"not json");
        state::write(
            &path(&root.0),
            &History {
                version: 1,
                owner: "other".into(),
                boots: vec!["x1".into()],
            },
        )
        .unwrap();
        adopt_at(&root.0, &pool, "b0").unwrap();
        assert_eq!(
            stored(&root.0),
            serde_json::json!({"version":1,"owner":"token","boots":["b0"]})
        );
    }

    #[test]
    fn deduplicates_and_keeps_at_most_the_bound() {
        let root = root();
        let mut pool = owner("token", Some("b0"), None);
        for index in 1..=40 {
            boot(&root.0, &mut pool, &format!("b{index}"));
        }
        let boots = earlier_boots_at(&root.0, &pool).unwrap();
        assert_eq!(boots.len(), LIMIT);
        assert_eq!(boots.first().map(String::as_str), Some("b39"));
        assert_eq!(boots.last().map(String::as_str), Some("b24"));
        // A further record adds the current boot at the front and drops the oldest;
        // repeating it changes nothing.
        record_at(&root.0, &pool).unwrap();
        let once = std::fs::read(path(&root.0)).unwrap();
        record_at(&root.0, &pool).unwrap();
        assert_eq!(once, std::fs::read(path(&root.0)).unwrap());
        let after = stored(&root.0);
        assert_eq!(after["boots"].as_array().unwrap().len(), LIMIT);
        assert_eq!(after["boots"][0], "b40");
        assert_eq!(after["boots"][1], "b39");
        let mut seen = std::collections::BTreeSet::new();
        assert!(
            after["boots"]
                .as_array()
                .unwrap()
                .iter()
                .all(|b| seen.insert(b.as_str().unwrap().to_owned()))
        );
    }

    #[test]
    fn never_records_a_missing_or_empty_boot() {
        let root = root();
        let mut pool = owner("token", None, None);
        record_at(&root.0, &pool).unwrap();
        assert!(std::fs::symlink_metadata(path(&root.0)).is_err());
        pool.guest_boot_id = Some(String::new());
        pool.previous_guest_boot_id = Some(String::new());
        record_at(&root.0, &pool).unwrap();
        assert!(std::fs::symlink_metadata(path(&root.0)).is_err());
        // A guestless boot keeps the earlier boot as previous (`begin_boot` unchanged).
        let mut pool = owner("token", Some("b1"), None);
        boot(&root.0, &mut pool, "unused");
        pool.guest_boot_id = None;
        record_at(&root.0, &pool).unwrap();
        pool.begin_boot();
        assert_eq!(pool.previous_guest_boot_id.as_deref(), Some("b1"));
        assert_eq!(stored(&root.0)["boots"], serde_json::json!(["b1"]));
    }

    #[test]
    fn another_owner_token_is_ignored_and_replaced() {
        let root = root();
        let mut old = owner("old-token", Some("x1"), None);
        boot(&root.0, &mut old, "x2");
        let mut pool = owner("token", Some("b1"), None);
        assert!(earlier_boots_at(&root.0, &pool).unwrap().is_empty());
        boot(&root.0, &mut pool, "b2");
        assert_eq!(
            stored(&root.0),
            serde_json::json!({"version":1,"owner":"token","boots":["b1"]})
        );
        assert_eq!(earlier_boots_at(&root.0, &pool).unwrap(), ["b1"]);
    }

    #[test]
    fn invalid_history_never_blocks_a_boot_but_fails_recovery() {
        for bytes in [
            b"not json".as_slice(),
            br#"{"version":1,"owner":"token","boots":["b0"],"extra":true}"#,
            br#"{"version":2,"owner":"token","boots":[]}"#,
            br#"{"version":1,"owner":"token","boots":[""]}"#,
        ] {
            let root = root();
            let file = path(&root.0);
            std::fs::write(&file, bytes).unwrap();
            std::fs::set_permissions(&file, std::os::unix::fs::PermissionsExt::from_mode(0o600))
                .unwrap();
            // A leftover interrupted write does not block the boot either.
            std::fs::write(file.with_extension("pending"), b"partial").unwrap();
            let pool = owner("token", Some("b1"), Some("b0"));
            assert!(earlier_boots_at(&root.0, &pool).is_err());
            record_at(&root.0, &pool).unwrap();
            assert_eq!(
                stored(&root.0),
                serde_json::json!({"version":1,"owner":"token","boots":["b1","b0"]})
            );
            let mut next = pool;
            next.begin_boot();
            next.guest_boot_id = Some("b2".into());
            assert_eq!(earlier_boots_at(&root.0, &next).unwrap(), ["b1", "b0"]);
        }
    }

    #[test]
    fn previous_boot_counts_without_a_sidecar() {
        let root = root();
        let pool = owner("token", Some("b2"), Some("b1"));
        assert_eq!(earlier_boots_at(&root.0, &pool).unwrap(), ["b1"]);
        let same = owner("token", Some("b1"), Some("b1"));
        assert!(earlier_boots_at(&root.0, &same).unwrap().is_empty());
    }
}
