//! Experimental ephemeral delivery primitive. Not wired to graph startup or a credential provider.
use super::lifecycle::OwnedGuest;
use crate::{Candidate, CandidateError};
use std::{
    collections::BTreeMap,
    fs::File,
    io::Read,
    time::{Duration, Instant},
};

const MAX_PAYLOAD: usize = 8192;
const MAX_LIFETIME: Duration = Duration::from_secs(300);

fn error(code: &'static str) -> CandidateError {
    CandidateError::new(
        code,
        "Environment delivery refused; values and guest output omitted.",
    )
}
fn name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c))
        && value.as_bytes()[0].is_ascii_alphanumeric()
}
fn key(value: &str) -> bool {
    let mut bytes = value.bytes();
    bytes
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == b'_')
        && bytes.all(|c| c.is_ascii_alphanumeric() || c == b'_')
}

/// Intentionally lacks Debug/Serialize. Lifetime begins at preparation, not at delivery.
pub struct PendingEnvironment {
    service: String,
    payload: String,
    deadline: Instant,
}
/// An in-memory handle, not a durable receipt or native provider lease.
/// Expiry blocks verification/use; explicit removal or VM shutdown reclaims the tmpfs.
pub struct EnvironmentLease {
    service: String,
    slot: String,
    incarnation: String,
    boot: String,
    deadline: Instant,
}
impl PendingEnvironment {
    pub fn new(
        service: &str,
        values: &BTreeMap<String, String>,
        lifetime: Duration,
    ) -> Result<Self, CandidateError> {
        if !name(service)
            || values.is_empty()
            || values.len() > 64
            || lifetime.is_zero()
            || lifetime > MAX_LIFETIME
        {
            return Err(error("environment_input"));
        }
        // Bound input before allocating its encoded copy. JSON escaping is checked separately.
        let mut bytes = 0usize;
        for (k, v) in values {
            if !key(k) || v.contains('\0') {
                return Err(error("environment_input"));
            }
            bytes = bytes
                .checked_add(k.len())
                .and_then(|n| n.checked_add(v.len()))
                .ok_or_else(|| error("environment_budget"))?;
            if bytes > MAX_PAYLOAD {
                return Err(error("environment_budget"));
            }
        }
        let payload = serde_json::to_string(values).map_err(|_| error("environment_input"))?;
        if payload.len() > MAX_PAYLOAD {
            return Err(error("environment_budget"));
        }
        Ok(Self {
            service: service.into(),
            payload,
            deadline: Instant::now() + lifetime,
        })
    }
    pub fn stage(self, candidate: &Candidate) -> Result<EnvironmentLease, CandidateError> {
        remaining(self.deadline)?;
        let guest = OwnedGuest::connect(candidate)?;
        let mut random = [0u8; 16];
        File::open("/dev/urandom")
            .and_then(|mut f| f.read_exact(&mut random))
            .map_err(|_| error("environment_identity"))?;
        let token: String = random.iter().map(|b| format!("{b:02x}")).collect();
        let lease = EnvironmentLease {
            service: self.service,
            slot: format!("hack-env-lease-{}-{token}", guest.boot_id()),
            incarnation: guest.incarnation().into(),
            boot: guest.boot_id().into(),
            deadline: self.deadline,
        };
        let seconds = remaining(lease.deadline)?;
        let result = guest.execute(
            STAGE,
            &[&lease.slot, &lease.service, &seconds.to_string()],
            Some(&self.payload),
        );
        if !result
            .as_ref()
            .is_ok_and(|value| value == "environment-staged-v1\n")
        {
            // Identity-checked removal also handles a partially written payload. Never expose output.
            let _ = guest.execute(REMOVE, &[&lease.slot, &lease.service], None);
            return Err(error("environment_stage_uncertain"));
        }
        if remaining(lease.deadline).is_err() {
            let _ = guest.execute(REMOVE, &[&lease.slot, &lease.service], None);
            return Err(error("environment_expired"));
        }
        Ok(lease)
    }
}
fn remaining(deadline: Instant) -> Result<u64, CandidateError> {
    // Round down the advisory guest window. The host deadline remains authoritative.
    deadline
        .checked_duration_since(Instant::now())
        .map(|d| d.as_secs())
        .filter(|s| *s > 0)
        .ok_or_else(|| error("environment_expired"))
}
impl EnvironmentLease {
    fn guest<'a>(&self, candidate: &'a Candidate) -> Result<OwnedGuest<'a>, CandidateError> {
        let guest = OwnedGuest::connect(candidate)?;
        if guest.incarnation() != self.incarnation || guest.boot_id() != self.boot {
            return Err(error("environment_boot_changed"));
        }
        Ok(guest)
    }
    /// Revalidates the lease before exposing its guest file path. Callers must not cache this as authority.
    pub fn verified_path(&self, candidate: &Candidate) -> Result<String, CandidateError> {
        remaining(self.deadline)?;
        let guest = self.guest(candidate)?;
        let result = guest.execute(VERIFY, &[&self.slot, &self.service], None)?;
        if result != "environment-verified-v1\n" {
            return Err(error("environment_verification"));
        }
        remaining(self.deadline)?;
        Ok(format!("/run/{}/values.json", self.slot))
    }
    /// Cleanup is permitted after expiry and is retry-safe for an absent slot on the same boot.
    pub fn remove(&self, candidate: &Candidate) -> Result<(), CandidateError> {
        let guest = self.guest(candidate)?;
        let result = guest.execute(REMOVE, &[&self.slot, &self.service], None)?;
        if result != "environment-removed-v1\n" {
            return Err(error("environment_cleanup"));
        }
        Ok(())
    }
}

// No payload is substituted into these scripts or their argv. Both output streams of the body
// are discarded, including failures, before the fixed acknowledgment is emitted.
// Do not put the subshell in an `if` or `||` list: that disables errexit inside its body.
const STAGE: &str = r#"
(
set -eu
ulimit -c 0
umask 077
awk '/^SwapTotal:/ { found=1; if ($2 != 0) bad=1 } END { exit (!found || bad) }' /proc/meminfo
count=0
for path in /run/"${1%-*}"-*; do
  if test -e "$path" || test -L "$path"; then count=$((count + 1)); fi
done
test "$count" -lt 8
root="/run/$1"
test ! -e "$root"
test ! -L "$root"
mkdir "$root"
mount -t tmpfs -o size=65536,mode=0700,nosuid,nodev,noexec "$1" "$root"
test "$(findmnt -n -o FSTYPE --mountpoint "$root")" = tmpfs
test "$(findmnt -n -o SOURCE --mountpoint "$root")" = "$1"
printf '%s' "$2" > "$root/service"
now=$(cut -d. -f1 /proc/uptime)
printf '%s' "$((now + $3))" > "$root/expires"
cat > "$root/values.json"
test "$(stat -c %s "$root/values.json")" -le 8192
chmod 400 "$root/service" "$root/expires" "$root/values.json"
) >/dev/null 2>&1
printf 'environment-staged-v1\n'
"#;
const VERIFY: &str = r#"
(
set -eu
root="/run/$1"
test ! -L "$root"
test "$(findmnt -n -o FSTYPE --mountpoint "$root")" = tmpfs
test "$(findmnt -n -o SOURCE --mountpoint "$root")" = "$1"
test "$(stat -c %u:%g:%a "$root")" = 0:0:700
for name in service expires values.json; do
 test ! -L "$root/$name"
 test -f "$root/$name"
 test "$(stat -c %u:%g:%a:%h "$root/$name")" = 0:0:400:1
done
test "$(cat "$root/service")" = "$2"
test "$(cut -d. -f1 /proc/uptime)" -lt "$(cat "$root/expires")"
test "$(stat -c %s "$root/values.json")" -le 8192
) >/dev/null 2>&1
printf 'environment-verified-v1\n'
"#;
const REMOVE: &str = r#"
(
set -eu
root="/run/$1"
test ! -L "$root"
if test ! -e "$root"; then exit 0; fi
test "$(findmnt -n -o FSTYPE --mountpoint "$root")" = tmpfs
test "$(findmnt -n -o SOURCE --mountpoint "$root")" = "$1"
test "$(cat "$root/service")" = "$2"
umount "$root"
rmdir "$root"
) >/dev/null 2>&1
printf 'environment-removed-v1\n'
"#;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn failed_preflight_stops_before_effects_and_emits_no_receipt() {
        // Stub side effects so the real staging script can safely exercise POSIX errexit locally.
        let script = format!(
            "set -eu\nawk() {{ return 17; }}\nmkdir() {{ :; }}\nmount() {{ exit 99; }}\n{STAGE}"
        );
        let output = std::process::Command::new("/bin/sh")
            .args(["-c", &script, "test", "unit-environment", "web", "60"])
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(17));
        assert!(output.stdout.is_empty());
        assert!(output.stderr.is_empty());
    }

    #[test]
    fn preparation_refuses_invalid_scope_values_and_encoded_overflow() {
        let good = BTreeMap::from([("TOKEN".into(), "synthetic-only".into())]);
        for service in ["", "../web", "web/other", "-web"] {
            assert!(PendingEnvironment::new(service, &good, Duration::from_secs(60)).is_err());
        }
        for values in [
            BTreeMap::new(),
            BTreeMap::from([("BAD=KEY".into(), "x".into())]),
            BTreeMap::from([("TOKEN".into(), "x\0y".into())]),
            BTreeMap::from([("TOKEN".into(), "\n".repeat(5000))]),
        ] {
            assert!(PendingEnvironment::new("web", &values, Duration::from_secs(60)).is_err());
        }
        assert!(PendingEnvironment::new("web", &good, Duration::ZERO).is_err());
        assert!(PendingEnvironment::new("web", &good, Duration::from_secs(301)).is_err());
        assert!(PendingEnvironment::new("web", &good, Duration::from_secs(60)).is_ok());
    }
    #[test]
    fn expired_preparation_refuses_before_runtime_lookup() {
        let mut pending = PendingEnvironment::new(
            "web",
            &BTreeMap::from([("TOKEN".into(), "synthetic-only".into())]),
            Duration::from_secs(60),
        )
        .unwrap();
        pending.deadline = Instant::now();
        let candidate =
            Candidate::discover(std::path::Path::new(env!("CARGO_MANIFEST_DIR"))).unwrap();
        assert_eq!(
            pending.stage(&candidate).err().unwrap().code,
            "environment_expired"
        );
    }
    #[test]
    #[ignore = "Manual owned development VM; HACK_LOCAL_TEST_ROOT and external watchdog required"]
    fn fixed_output_leases_enforce_scope_expiry_budget_and_cleanup() {
        let root = std::env::var("HACK_LOCAL_TEST_ROOT").expect("explicit candidate root");
        let candidate = Candidate::discover(std::path::Path::new(&root)).unwrap();
        let values =
            BTreeMap::from([("TOKEN".into(), "synthetic-lease-only\n'\"$UNCHANGED".into())]);
        let expected = serde_json::to_string(&values).unwrap();
        let mut leases = Vec::new();
        // Keep handles until cleanup, including negative checks; the outer watchdog owns VM shutdown.
        for _ in 0..8 {
            leases.push(
                PendingEnvironment::new("web", &values, Duration::from_secs(120))
                    .unwrap()
                    .stage(&candidate)
                    .unwrap(),
            );
        }
        let result = (|| -> Result<(), CandidateError> {
            let path = leases[0].verified_path(&candidate)?;
            {
                let guest = OwnedGuest::connect(&candidate)?;
                let output = guest.execute(
                    "(cmp - \"$1\") >/dev/null 2>&1 || exit 1; printf 'matched\\n'",
                    &[&path],
                    Some(&expected),
                )?;
                assert_eq!(output, "matched\n");
            }
            let overflow = PendingEnvironment::new("web", &values, Duration::from_secs(120))
                .unwrap()
                .stage(&candidate)
                .err()
                .unwrap();
            assert_eq!(overflow.code, "environment_stage_uncertain");
            leases[0].service = "wrong-service".into();
            assert!(leases[0].verified_path(&candidate).is_err());
            assert!(leases[0].remove(&candidate).is_err());
            leases[0].service = "web".into();
            let boot = leases[0].boot.clone();
            leases[0].boot = "wrong-boot".into();
            assert_eq!(
                leases[0].verified_path(&candidate).err().unwrap().code,
                "environment_boot_changed"
            );
            assert_eq!(
                leases[0].remove(&candidate).err().unwrap().code,
                "environment_boot_changed"
            );
            leases[0].boot = boot;
            // Exercise guest-side expiry independently from the host deadline.
            {
                let guest = OwnedGuest::connect(&candidate)?;
                guest.execute(
                    "(printf 0 > \"/run/$1/expires\") >/dev/null 2>&1",
                    &[&leases[0].slot],
                    None,
                )?;
            }
            assert!(leases[0].verified_path(&candidate).is_err());
            leases[1].deadline = Instant::now();
            assert_eq!(
                leases[1].verified_path(&candidate).err().unwrap().code,
                "environment_expired"
            );
            Ok(())
        })();
        for lease in &leases {
            lease.remove(&candidate).unwrap();
            lease.remove(&candidate).unwrap();
        }
        assert!(result.is_ok(), "lease controls failed");
        let mut positive_control = false;
        let logs = candidate
            .state_root
            .join("run/smolvm")
            .join("home")
            .join("Library/Caches/smolvm/vms");
        for entry in std::fs::read_dir(logs).unwrap() {
            let path = entry.unwrap().path().join("agent-console.log");
            if !path.exists() {
                continue;
            }
            let mut bytes = Vec::new();
            File::open(path)
                .unwrap()
                .take(8 * 1024 * 1024 + 1)
                .read_to_end(&mut bytes)
                .unwrap();
            assert!(bytes.len() <= 8 * 1024 * 1024);
            let text = String::from_utf8_lossy(&bytes);
            positive_control |= text.contains(&leases[0].slot);
            assert!(
                !text.contains("synthetic-lease-only"),
                "payload reflected in console"
            );
            assert!(
                !text.contains(&format!("{:?}", expected.as_bytes())),
                "payload byte vector reflected in console"
            );
        }
        assert!(positive_control, "lease log control missing");
        let guest = OwnedGuest::connect(&candidate).unwrap();
        assert_eq!(guest.execute("for path in /run/\"$1\"*; do if test -e \"$path\" || test -L \"$path\"; then exit 1; fi; done; printf 'empty\\n'", &[&format!("hack-env-lease-{}-", guest.boot_id())], None).unwrap(), "empty\n");
    }
}
