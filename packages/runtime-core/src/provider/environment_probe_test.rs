//! Synthetic-only qualification of stdin delivery. This does not enable managed credentials.
use super::lifecycle::OwnedGuest;
use crate::{Candidate, CandidateError};
use base64::{Engine, engine::general_purpose::STANDARD};
use std::{fs, io::Read, path::Path};

#[test]
#[ignore = "Manual owned development VM; explicit HACK_LOCAL_TEST_ROOT and external watchdog"]
fn stdin_payload_uses_tmpfs_without_console_or_error_reflection() {
    let root = std::env::var("HACK_LOCAL_TEST_ROOT").expect("explicit candidate root");
    let candidate = Candidate::discover(Path::new(&root)).unwrap();
    let guest = OwnedGuest::connect(&candidate).unwrap();
    let mut random = [0u8; 32];
    fs::File::open("/dev/urandom")
        .unwrap()
        .read_exact(&mut random)
        .unwrap();
    let token: String = random[..16].iter().map(|b| format!("{b:02x}")).collect();
    let value: String = random[16..].iter().map(|b| format!("{b:02x}")).collect();
    let label = format!("hack-env-probe-{token}");
    let payload = format!("synthetic-only-{value}\n'\"$NOT_EXPANDED\\\n");
    // The public label is deliberately logged as an argv positive control; payload is stdin only.
    let created = guest.execute(
        r#"
ulimit -c 0
umask 077
awk '/^SwapTotal:/ { found=1; if ($2 != 0) bad=1 } END { exit (!found || bad) }' /proc/meminfo || exit 60
if test -f /proc/swaps; then test "$(wc -l < /proc/swaps)" -eq 1 || exit 61; fi
root="/run/$1"
test ! -e "$root"
test ! -L "$root"
mkdir "$root" || exit 62
mount -t tmpfs -o size=65536,mode=0700,nosuid,nodev,noexec "$1" "$root" || exit 63
test "$(findmnt -n -o FSTYPE --mountpoint "$root")" = tmpfs || exit 64
test "$(findmnt -n -o SOURCE --mountpoint "$root")" = "$1" || exit 65
cat > "$root/value"
chmod 400 "$root/value"
printf 'staged\n'
"#,
        &[&label],
        Some(&payload),
    );
    // If staging is uncertain, retain it for the outer owned-VM shutdown rather than infer success.
    assert!(
        created.as_ref().is_ok_and(|output| output == "staged\n"),
        "synthetic staging failed: {}",
        created.err().map(|e| e.message).unwrap_or_default()
    );
    let checked = (|| -> Result<(), CandidateError> {
        let output = guest.execute(
            r#"
ulimit -c 0
root="/run/$1"
test ! -L "$root"
test "$(findmnt -n -o FSTYPE --mountpoint "$root")" = tmpfs
test "$(findmnt -n -o SOURCE --mountpoint "$root")" = "$1"
test "$(stat -c %u:%g:%a "$root")" = 0:0:700
test "$(stat -c %u:%g:%a "$root/value")" = 0:0:400
cmp - "$root/value"
printf 'verified\n'
"#,
            &[&label],
            Some(&payload),
        )?;
        if output != "verified\n" {
            return Err(CandidateError::new(
                "environment_probe",
                "Unexpected synthetic receipt.",
            ));
        }
        let failure = guest
            .execute("cat >&2; exit 23", &[], Some(&payload))
            .err()
            .ok_or_else(|| {
                CandidateError::new("environment_probe", "Failure control unexpectedly passed.")
            })?;
        let serialized = serde_json::to_string(&failure).unwrap();
        if failure.code != "guest_command_failed"
            || serialized.contains(&value)
            || serialized.contains(&STANDARD.encode(&payload))
        {
            return Err(CandidateError::new(
                "environment_probe",
                "Failure redaction control failed.",
            ));
        }
        Ok(())
    })();
    let cleaned = guest.execute(
        r#"
root="/run/$1"
test ! -L "$root"
test "$(findmnt -n -o FSTYPE --mountpoint "$root")" = tmpfs
test "$(findmnt -n -o SOURCE --mountpoint "$root")" = "$1"
umount "$root"
rmdir "$root"
test ! -e "$root"
printf 'removed\n'
"#,
        &[&label],
        None,
    );
    assert!(
        cleaned.as_ref().is_ok_and(|output| output == "removed\n"),
        "owned tmpfs cleanup failed"
    );
    assert!(
        checked.is_ok(),
        "synthetic delivery or failure control failed"
    );
    let logs = candidate
        .state_root
        .join("run/smolvm")
        .join("home")
        .join("Library/Caches/smolvm/vms");
    let mut found_control = false;
    for entry in fs::read_dir(logs).unwrap() {
        let path = entry.unwrap().path().join("agent-console.log");
        if !path.exists() {
            continue;
        }
        let file = fs::File::open(&path).unwrap();
        assert!(
            file.metadata().unwrap().len() <= 8 * 1024 * 1024,
            "console audit budget exceeded"
        );
        let mut bytes = Vec::new();
        file.take(8 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .unwrap();
        assert!(
            bytes.len() <= 8 * 1024 * 1024,
            "console grew beyond audit budget"
        );
        let text = String::from_utf8_lossy(&bytes);
        found_control |= text.contains(&label);
        assert!(
            !text.contains(&format!("{:?}", payload.as_bytes())),
            "debug byte array appeared in console"
        );
        assert!(
            !text.contains(&value),
            "synthetic stdin appeared in console"
        );
        assert!(
            !text.contains(&STANDARD.encode(&payload)),
            "encoded stdin appeared in console"
        );
    }
    assert!(found_control, "console positive control was not observed");
}
