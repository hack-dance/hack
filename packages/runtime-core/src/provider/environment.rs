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
pub(super) fn name(value: &str) -> bool {
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
    uid: u32,
    gid: u32,
    deadline: Instant,
}
/// An in-memory handle, not a durable receipt or native provider lease.
/// Expiry blocks verification/use; explicit removal or VM shutdown reclaims the tmpfs.
pub struct EnvironmentLease {
    pub(super) graph: Option<super::environment_recovery::GraphBinding>,
    pub(super) service: String,
    pub(super) uid: u32,
    pub(super) gid: u32,
    pub(super) slot: String,
    pub(super) incarnation: String,
    pub(super) boot: String,
    deadline: Instant,
}
impl PendingEnvironment {
    pub(super) fn with_identity(mut self, uid: u32, gid: u32) -> Self {
        self.uid = uid;
        self.gid = gid;
        self
    }

    pub(super) fn service(&self) -> &str {
        &self.service
    }

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
            uid: 0,
            gid: 0,
            deadline: Instant::now() + lifetime,
        })
    }
    pub fn stage(self, candidate: &Candidate) -> Result<EnvironmentLease, CandidateError> {
        remaining(self.deadline)?;
        let guest = OwnedGuest::connect(candidate)?;
        self.stage_with_guest(&guest)
    }
    /// Borrows the graph engine's mutation guard; never reacquires or releases its lock.
    pub(super) fn stage_with_guest(
        self,
        guest: &OwnedGuest<'_>,
    ) -> Result<EnvironmentLease, CandidateError> {
        self.stage_bound(guest, None)
    }
    pub(super) fn stage_bound(
        self,
        guest: &OwnedGuest<'_>,
        graph: Option<super::environment_recovery::GraphBinding>,
    ) -> Result<EnvironmentLease, CandidateError> {
        guest.require_allocation()?;
        remaining(self.deadline)?;
        let candidate = guest.candidate();
        let mut random = [0u8; 16];
        File::open("/dev/urandom")
            .and_then(|mut f| f.read_exact(&mut random))
            .map_err(|_| error("environment_identity"))?;
        let token: String = random.iter().map(|b| format!("{b:02x}")).collect();
        let lease = EnvironmentLease {
            graph,
            uid: self.uid,
            gid: self.gid,
            service: self.service,
            slot: format!("hack-env-lease-{}-{token}", guest.boot_id()),
            incarnation: guest.incarnation().into(),
            boot: guest.boot_id().into(),
            deadline: self.deadline,
        };
        super::environment_recovery::record(candidate, &lease)?;
        let seconds = remaining(lease.deadline)?;
        let result = guest.execute(
            STAGE,
            &[
                &lease.slot,
                &lease.service,
                &seconds.to_string(),
                &lease.uid.to_string(),
                &lease.gid.to_string(),
            ],
            Some(&self.payload),
        );
        if !result
            .as_ref()
            .is_ok_and(|value| value == "environment-staged-v1\n")
        {
            // Identity-checked removal also handles a partially written payload. Never expose output.
            let _ =
                super::environment_recovery::retire(candidate, guest, &lease.slot, Some(&lease));
            return Err(CandidateError::new(
                "environment_stage_uncertain",
                format!(
                    "Environment staging uncertain; cleanup intent {} retained. Values and guest output omitted.",
                    lease.slot
                ),
            ));
        }
        if remaining(lease.deadline).is_err() {
            let _ =
                super::environment_recovery::retire(candidate, guest, &lease.slot, Some(&lease));
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
    fn guest<'a>(
        &self,
        candidate: &'a Candidate,
        cleanup: bool,
    ) -> Result<OwnedGuest<'a>, CandidateError> {
        let guest = if cleanup {
            OwnedGuest::connect_cleanup(candidate)?
        } else {
            OwnedGuest::connect(candidate)?
        };
        self.matches_guest(&guest)?;
        Ok(guest)
    }
    /// Revalidates the lease before exposing its guest file path. Callers must not cache this as authority.
    pub fn verified_path(&self, candidate: &Candidate) -> Result<String, CandidateError> {
        remaining(self.deadline)?;
        let guest = self.guest(candidate, false)?;
        self.verified_path_with_guest(&guest, &self.service)
    }
    /// The service selected by the caller must match; a path alone is not delivery authority.
    pub(super) fn verified_path_with_guest(
        &self,
        guest: &OwnedGuest<'_>,
        service: &str,
    ) -> Result<String, CandidateError> {
        guest.require_allocation()?;
        self.matches_guest(guest)?;
        if service != self.service {
            return Err(error("environment_service"));
        }
        remaining(self.deadline)?;
        let result = guest.execute(
            VERIFY,
            &[
                &self.slot,
                &self.service,
                &self.uid.to_string(),
                &self.gid.to_string(),
            ],
            None,
        )?;
        if result != "environment-verified-v1\n" {
            return Err(error("environment_verification"));
        }
        remaining(self.deadline)?;
        Ok(format!("/run/{}/values.json", self.slot))
    }
    /// Cleanup is permitted after expiry and is retry-safe for an absent slot on the same boot.
    pub fn remove(&self, candidate: &Candidate) -> Result<(), CandidateError> {
        let guest = self.guest(candidate, true)?;
        self.remove_with_guest(&guest)
    }
    pub(super) fn remove_with_guest(&self, guest: &OwnedGuest<'_>) -> Result<(), CandidateError> {
        self.matches_guest(guest)?;
        super::environment_recovery::retire(guest.candidate(), guest, &self.slot, Some(self))
    }
    fn matches_guest(&self, guest: &OwnedGuest<'_>) -> Result<(), CandidateError> {
        if guest.incarnation() != self.incarnation || guest.boot_id() != self.boot {
            return Err(error("environment_boot_changed"));
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
chown "$4:$5" "$root/expires" "$root/values.json"
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
 if test "$name" = service; then
  test "$(stat -c %u:%g:%a:%h "$root/$name")" = 0:0:400:1
 else
  test "$(stat -c %u:%g:%a:%h "$root/$name")" = "$3:$4:400:1"
 fi
done
test "$(cat "$root/service")" = "$2"
test "$(cut -d. -f1 /proc/uptime)" -lt "$(cat "$root/expires")"
test "$(stat -c %s "$root/values.json")" -le 8192
) >/dev/null 2>&1
printf 'environment-verified-v1\n'
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
    fn engine_guard_handoff_preserves_lock_scope_and_cleanup_authority() {
        use super::super::{engine::Engine, environment_recovery::recorded_slots};
        let root = std::env::var("HACK_LOCAL_TEST_ROOT").expect("explicit candidate root");
        let candidate = Candidate::discover(std::path::Path::new(&root)).unwrap();
        let values =
            BTreeMap::from([("TOKEN".into(), "synthetic-guard-only\n'\"$UNCHANGED".into())]);
        let pending = || PendingEnvironment::new("web", &values, Duration::from_secs(120)).unwrap();
        let engine = Engine::connect(&candidate).unwrap();
        assert_eq!(
            pending().stage(&candidate).err().unwrap().code,
            "provider_busy"
        );
        let lease = pending().stage_with_guest(engine.guest()).unwrap();
        let result = (|| -> Result<(), CandidateError> {
            let path = lease.verified_path_with_guest(engine.guest(), "web")?;
            assert_eq!(
                lease
                    .verified_path_with_guest(engine.guest(), "worker")
                    .err()
                    .unwrap()
                    .code,
                "environment_service"
            );
            let output = engine.guest().execute(
                "(cmp - \"$1\") >/dev/null 2>&1 || exit 1; printf 'matched\\n'",
                &[&path],
                Some(&serde_json::to_string(&values).unwrap()),
            )?;
            assert_eq!(output, "matched\n");
            engine.request(reqwest::Method::GET, "/v1.53/info", None)?;
            assert_eq!(
                OwnedGuest::connect_cleanup(&candidate).err().unwrap().code,
                "provider_busy"
            );
            Ok(())
        })();
        lease.remove_with_guest(engine.guest()).unwrap();
        lease.remove_with_guest(engine.guest()).unwrap();
        assert_eq!(
            OwnedGuest::connect(&candidate).err().unwrap().code,
            "provider_busy"
        );
        result.unwrap();
        // Retain one allocation to exercise removal under cleanup-only admission.
        let lease = pending().stage_with_guest(engine.guest()).unwrap();
        drop(engine);
        let cleanup = Engine::connect_cleanup(&candidate).unwrap();
        let before = recorded_slots(&candidate).unwrap();
        assert_eq!(
            pending()
                .stage_with_guest(cleanup.guest())
                .err()
                .unwrap()
                .code,
            "cleanup_only"
        );
        assert_eq!(
            lease
                .verified_path_with_guest(cleanup.guest(), "web")
                .err()
                .unwrap()
                .code,
            "cleanup_only"
        );
        assert_eq!(recorded_slots(&candidate).unwrap(), before);
        lease.remove_with_guest(cleanup.guest()).unwrap();
        lease.remove_with_guest(cleanup.guest()).unwrap();
        assert_eq!(
            OwnedGuest::connect(&candidate).err().unwrap().code,
            "provider_busy"
        );
        drop(cleanup);
        // Dropping the owning engine, rather than any borrowed delivery operation, releases the lock.
        OwnedGuest::connect_cleanup(&candidate).unwrap();
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
            assert!(
                super::super::environment_recovery::recorded_slots(&candidate)
                    .unwrap()
                    .iter()
                    .any(|slot| overflow.message.contains(slot))
            );
            assert!(!overflow.message.contains("synthetic-lease-only"));
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
    #[test]
    #[ignore = "Manual recovery phase one; owned VM and external watchdog required"]
    fn interrupted_allocations_are_retired_from_immutable_intent() {
        use super::super::environment_recovery::{recorded_slots, retire_recorded};
        let root = std::env::var("HACK_LOCAL_TEST_ROOT").expect("explicit candidate root");
        let candidate = Candidate::discover(std::path::Path::new(&root)).unwrap();
        let values = BTreeMap::from([("TOKEN".into(), "synthetic-recovery-only".into())]);
        for case in 0..6 {
            let lease = PendingEnvironment::new("web", &values, Duration::from_secs(120))
                .unwrap()
                .stage(&candidate)
                .unwrap();
            let slot = lease.slot.clone();
            drop(lease);
            if case != 0 {
                let guest = OwnedGuest::connect(&candidate).unwrap();
                let script = match case {
                    1 => "rm \"$root/service\" \"$root/expires\" \"$root/values.json\"",
                    2 => "umount \"$root\"",
                    3 => "umount \"$root\"; printf fixture > \"$root/unexpected\"",
                    4 => {
                        "umount \"$root\"; mount -t tmpfs -o mode=0700,size=65536 environment-foreign-test \"$root\""
                    }
                    _ => "umount \"$root\"; rmdir \"$root\"; ln -s /tmp \"$root\"",
                };
                guest.execute(&format!("root=\"/run/$1\"; test \"$(findmnt -n -o SOURCE --mountpoint \"$root\")\" = \"$1\"; {script}"), &[&slot], None).unwrap();
            }
            if case >= 3 {
                assert!(
                    retire_recorded(&candidate, &slot).is_err(),
                    "foreign state must be retained"
                );
                let guest = OwnedGuest::connect_cleanup(&candidate).unwrap();
                let repair = match case {
                    3 => "test \"$(cat \"$root/unexpected\")\" = fixture; rm \"$root/unexpected\"",
                    4 => {
                        "test \"$(findmnt -n -o SOURCE --mountpoint \"$root\")\" = environment-foreign-test; umount \"$root\""
                    }
                    _ => "test -L \"$root\"; test \"$(readlink \"$root\")\" = /tmp; rm \"$root\"",
                };
                guest
                    .execute(&format!("root=\"/run/$1\"; {repair}"), &[&slot], None)
                    .unwrap();
            }
            retire_recorded(&candidate, &slot).unwrap();
            retire_recorded(&candidate, &slot).unwrap();
        }
        {
            let guest = OwnedGuest::connect(&candidate).unwrap();
            let unknown = format!("hack-env-lease-{}-{}", guest.boot_id(), "f".repeat(32));
            guest
                .execute("umask 077; mkdir \"/run/$1\"", &[&unknown], None)
                .unwrap();
            drop(guest);
            assert!(retire_recorded(&candidate, &unknown).is_err());
            let guest = OwnedGuest::connect_cleanup(&candidate).unwrap();
            guest
                .execute("test -d \"/run/$1\"; rmdir \"/run/$1\"", &[&unknown], None)
                .unwrap();
        }
        // Leave one real allocation for an actual VM restart; no handle survives into phase two.
        let lease = PendingEnvironment::new("web", &values, Duration::from_secs(120))
            .unwrap()
            .stage(&candidate)
            .unwrap();
        assert!(recorded_slots(&candidate).unwrap().contains(&lease.slot));
        let record = std::fs::read_to_string(
            candidate
                .state_root
                .join("run/environment-leases")
                .join(format!("{}.json", lease.slot)),
        )
        .unwrap();
        assert!(!record.contains("synthetic-recovery-only"));
        assert!(!record.contains("TOKEN"));
    }
}
