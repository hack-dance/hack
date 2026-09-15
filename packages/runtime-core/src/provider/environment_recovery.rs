//! Immutable, value-free allocation intent. Recovery grants cleanup, never renewed delivery.
use super::{environment::EnvironmentLease, lifecycle::OwnedGuest, state};
use crate::{Candidate, CandidateError};
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Intent {
    version: u32,
    service: String,
    slot: String,
    incarnation: String,
    boot: String,
}
fn error() -> CandidateError {
    CandidateError::new(
        "environment_recovery",
        "Environment cleanup requires valid, matching allocation intent; no values are restored.",
    )
}
fn root(candidate: &Candidate) -> PathBuf {
    candidate.state_root.join("run/environment-leases")
}
fn valid_slot(slot: &str) -> bool {
    let Some(rest) = slot.strip_prefix("hack-env-lease-") else {
        return false;
    };
    rest.is_ascii()
        && rest.len() == 69
        && uuid(&rest[..36])
        && rest.as_bytes()[36] == b'-'
        && hex(&rest[37..], 32)
}
fn hex(value: &str, len: usize) -> bool {
    value.len() == len
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                c == b'-'
            } else {
                c.is_ascii_digit() || (b'a'..=b'f').contains(&c)
            }
        })
}
fn validate(intent: &Intent, slot: &str) -> Result<(), CandidateError> {
    if intent.version != 1
        || intent.slot != slot
        || !valid_slot(slot)
        || !uuid(&intent.boot)
        || !slot.starts_with(&format!("hack-env-lease-{}-", intent.boot))
        || !hex(&intent.incarnation, 32)
        || !super::environment::name(&intent.service)
    {
        return Err(error());
    }
    Ok(())
}
pub(super) fn record(
    candidate: &Candidate,
    lease: &EnvironmentLease,
) -> Result<(), CandidateError> {
    let directory = root(candidate);
    state::private_directory(&directory)?;
    for (index, entry) in fs::read_dir(&directory).map_err(state::io)?.enumerate() {
        entry.map_err(state::io)?;
        if index >= 4095 {
            return Err(error());
        }
    }
    let intent = Intent {
        version: 1,
        service: lease.service.clone(),
        slot: lease.slot.clone(),
        incarnation: lease.incarnation.clone(),
        boot: lease.boot.clone(),
    };
    validate(&intent, &lease.slot)?;
    let path = directory.join(format!("{}.json", lease.slot));
    match fs::symlink_metadata(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        _ => return Err(error()),
    }
    state::write(&path, &intent)
}
fn read(
    candidate: &Candidate,
    slot: &str,
    incarnation: &str,
    lease: Option<&EnvironmentLease>,
) -> Result<Intent, CandidateError> {
    if !valid_slot(slot) {
        return Err(error());
    }
    let directory = root(candidate);
    state::check_private_directory(&directory)?;
    let path = directory.join(format!("{slot}.json"));
    let pending = path.with_extension("pending");
    let present = |path: &std::path::Path| match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(state::io(e)),
    };
    let committed = present(&path)?;
    let has_pending = present(&pending)?;
    if committed && has_pending {
        return Err(error());
    }
    let intent: Intent = state::read_bounded(if has_pending { &pending } else { &path }, 2048)?;
    validate(&intent, slot)?;
    if intent.incarnation != incarnation {
        return Err(error());
    }
    if let Some(lease) = lease {
        if lease.service != intent.service
            || lease.boot != intent.boot
            || lease.incarnation != intent.incarnation
        {
            return Err(error());
        }
    }
    // Promote only a complete, validated initial intent. Never delete retained pending state.
    if has_pending {
        fs::rename(&pending, &path).map_err(state::io)?;
        fs::File::open(&directory)
            .and_then(|f| f.sync_all())
            .map_err(state::io)?;
    }
    Ok(intent)
}
/// Lists intent-file IDs, including retired slots. Contents are validated when retiring; this is
/// neither a live-lease inventory nor authorization to automatically retire every entry.
pub fn recorded_slots(candidate: &Candidate) -> Result<Vec<String>, CandidateError> {
    let directory = root(candidate);
    crate::reject_aliased_state(&directory)?;
    if !directory.try_exists().map_err(state::io)? {
        return Ok(Vec::new());
    }
    state::check_private_directory(&directory)?;
    let mut slots = std::collections::BTreeSet::new();
    for (index, entry) in fs::read_dir(directory).map_err(state::io)?.enumerate() {
        if index >= 4096 {
            return Err(error());
        }
        let name = entry
            .map_err(state::io)?
            .file_name()
            .into_string()
            .map_err(|_| error())?;
        let slot = name
            .strip_suffix(".json")
            .or_else(|| name.strip_suffix(".pending"))
            .ok_or_else(error)?;
        if !valid_slot(slot) {
            return Err(error());
        }
        slots.insert(slot.into());
    }
    Ok(slots.into_iter().collect())
}
/// Explicitly retires a recorded allocation. It may still be live: the caller must own its lifecycle.
/// Same-boot partial tmpfs allocations are removable. An older boot permits only absent/empty,
/// unmounted directories. Foreign incarnations, symlinks and unexpected mounts are refused.
pub fn retire_recorded(candidate: &Candidate, slot: &str) -> Result<(), CandidateError> {
    let guest = OwnedGuest::connect_cleanup(candidate)?;
    retire(candidate, &guest, slot, None)
}
pub(super) fn retire(
    candidate: &Candidate,
    guest: &OwnedGuest<'_>,
    slot: &str,
    lease: Option<&EnvironmentLease>,
) -> Result<(), CandidateError> {
    let intent = read(candidate, slot, guest.incarnation(), lease)?;
    let mode = if intent.boot == guest.boot_id() {
        "same"
    } else {
        "old"
    };
    let result = guest.execute_cleanup(RETIRE, &[slot, mode])?;
    if result != "environment-removed-v1\n" {
        return Err(error());
    }
    Ok(())
}
const RETIRE: &str = r#"
(
set -eu
root="/run/$1"
test ! -L "$root"
if test ! -e "$root"; then exit 0; fi
test -d "$root"
test "$(stat -c %u:%g:%a "$root")" = 0:0:700
if mountpoint -q "$root"; then
 test "$2" = same
 test "$(findmnt -n -o FSTYPE --mountpoint "$root")" = tmpfs
 test "$(findmnt -n -o SOURCE --mountpoint "$root")" = "$1"
 umount "$root"
fi
rmdir "$root"
) >/dev/null 2>&1
printf 'environment-removed-v1\n'
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        os::unix::fs::OpenOptionsExt,
    };
    struct Fixture(Candidate);
    impl Fixture {
        fn new() -> Self {
            let mut bytes = [0; 16];
            fs::File::open("/dev/urandom")
                .unwrap()
                .read_exact(&mut bytes)
                .unwrap();
            let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
            let path = std::env::temp_dir()
                .canonicalize()
                .unwrap()
                .join(format!("hack-env-recovery-{token}"));
            state::private_directory(&path).unwrap();
            let candidate = Candidate::discover(&path).unwrap();
            state::private_directory(&root(&candidate)).unwrap();
            Self(candidate)
        }
        fn intent(&self) -> Intent {
            let boot = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".to_string();
            Intent {
                version: 1,
                service: "web".into(),
                slot: format!("hack-env-lease-{boot}-{}", "a".repeat(32)),
                boot,
                incarnation: "b".repeat(32),
            }
        }
        fn pending(&self, bytes: &[u8], slot: &str) -> PathBuf {
            let path = root(&self.0).join(format!("{slot}.pending"));
            fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&path)
                .unwrap()
                .write_all(bytes)
                .unwrap();
            path
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0.checkout).unwrap();
        }
    }
    #[test]
    fn complete_pending_intent_is_promoted_without_values_or_reallocation() {
        let fixture = Fixture::new();
        let intent = fixture.intent();
        let bytes = serde_json::to_vec(&intent).unwrap();
        let pending = fixture.pending(&bytes, &intent.slot);
        assert_eq!(
            recorded_slots(&fixture.0).unwrap().as_slice(),
            std::slice::from_ref(&intent.slot)
        );
        let loaded = read(&fixture.0, &intent.slot, &intent.incarnation, None).unwrap();
        assert_eq!(loaded.service, "web");
        assert!(!pending.exists());
        assert_eq!(fs::read(pending.with_extension("json")).unwrap(), bytes);
    }
    #[test]
    fn partial_foreign_conflicting_and_aliased_intents_are_retained() {
        for case in 0..4 {
            let fixture = Fixture::new();
            let intent = fixture.intent();
            let bytes = if case == 0 {
                b"{\"version\":".to_vec()
            } else {
                serde_json::to_vec(&intent).unwrap()
            };
            let pending = fixture.pending(&bytes, &intent.slot);
            let committed = pending.with_extension("json");
            if case == 2 {
                fs::write(&committed, b"foreign").unwrap();
            }
            if case == 3 {
                std::os::unix::fs::symlink("missing-target", &committed).unwrap();
            }
            let owner = if case == 1 {
                "c".repeat(32)
            } else {
                intent.incarnation.clone()
            };
            assert!(read(&fixture.0, &intent.slot, &owner, None).is_err());
            assert_eq!(fs::read(&pending).unwrap(), bytes);
        }
    }
    #[test]
    fn malformed_or_mismatched_slot_identity_cannot_address_state() {
        let fixture = Fixture::new();
        let mut intent = fixture.intent();
        for slot in [
            "../outside".to_string(),
            format!("hack-env-lease-{}", "é".repeat(35)),
            format!("hack-env-lease-{}x", "a".repeat(68)),
        ] {
            assert!(read(&fixture.0, &slot, &intent.incarnation, None).is_err());
        }
        intent.boot = "cccccccc-cccc-4ccc-8ccc-cccccccccccc".into();
        fixture.pending(&serde_json::to_vec(&intent).unwrap(), &intent.slot);
        assert!(read(&fixture.0, &intent.slot, &intent.incarnation, None).is_err());
    }
    #[test]
    #[ignore = "Manual recovery phase two after owned VM restart; external watchdog required"]
    fn prior_boot_intents_retire_empty_directories_without_restoring_values() {
        let path = std::env::var("HACK_LOCAL_TEST_ROOT").expect("explicit candidate root");
        let candidate = Candidate::discover(std::path::Path::new(&path)).unwrap();
        let slots = recorded_slots(&candidate).unwrap();
        assert!(!slots.is_empty());
        for slot in slots {
            {
                let guest = OwnedGuest::connect_cleanup(&candidate).unwrap();
                let intent = read(&candidate, &slot, guest.incarnation(), None).unwrap();
                assert_ne!(
                    intent.boot,
                    guest.boot_id(),
                    "phase two requires a fresh guest boot"
                );
                guest
                    .execute("test ! -e \"/run/$1/values.json\"", &[&slot], None)
                    .unwrap();
            }
            retire_recorded(&candidate, &slot).unwrap();
            retire_recorded(&candidate, &slot).unwrap();
        }
        let guest = OwnedGuest::connect_cleanup(&candidate).unwrap();
        let inventory = guest
            .execute(
                r#"
for root in /run/hack-env-lease-*; do
 test -d "$root" || continue
 test ! -L "$root" || continue
 slot=${root##*/}; suffix=${slot#hack-env-lease-}
 test "${#suffix}" -eq 32 || continue
 case "$suffix" in *[!0-9a-f]*) continue;; esac
 if mountpoint -q "$root"; then continue; fi
 printf '%s ' "$slot"
 stat -c '%u:%g:%a:%Y' "$root"
done
"#,
                &[],
                None,
            )
            .unwrap();
        println!("legacy-empty-candidates:\n{inventory}");
    }

    #[test]
    #[ignore = "Explicit manifest of approved legacy fixture directories and owned VM watchdog required"]
    fn retire_approved_empty_legacy_fixture_directories() {
        let path = std::env::var("HACK_LOCAL_TEST_ROOT").expect("explicit candidate root");
        let manifest =
            std::env::var("HACK_LOCAL_LEGACY_MANIFEST").expect("explicit approved legacy manifest");
        let entries: Vec<(String, u64)> =
            serde_json::from_slice(&fs::read(manifest).unwrap()).unwrap();
        assert!(!entries.is_empty() && entries.len() <= 32);
        let candidate = Candidate::discover(std::path::Path::new(&path)).unwrap();
        let guest = OwnedGuest::connect_cleanup(&candidate).unwrap();
        for (slot, modified) in entries {
            assert!(
                slot.strip_prefix("hack-env-lease-")
                    .is_some_and(|s| hex(s, 32))
            );
            assert_eq!(
                guest
                    .execute(
                        r#"
(
set -eu
root="/run/$1"
test ! -L "$root"
test -d "$root"
test "$(stat -c %u:%g:%a:%Y "$root")" = "0:0:700:$2"
if mountpoint -q "$root"; then exit 1; fi
rmdir "$root"
) >/dev/null 2>&1
printf 'legacy-empty-removed\n'
"#,
                        &[&slot, &modified.to_string()],
                        None
                    )
                    .unwrap(),
                "legacy-empty-removed\n"
            );
        }
    }
}
