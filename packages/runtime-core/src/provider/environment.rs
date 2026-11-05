//! Experimental graph-scoped ephemeral delivery; credential acquisition remains caller-owned.
use super::lifecycle::OwnedGuest;
use crate::{Candidate, CandidateError};
use std::{
    collections::BTreeMap,
    fs::File,
    io::Read,
    time::{Duration, Instant},
};

/// Encoded values occupy at most half of each fixed 64 KiB tmpfs allocation.
pub const MAX_ENVIRONMENT_PAYLOAD: usize = 32 * 1024;
pub const MAX_ENVIRONMENT_KEYS: usize = 256;
const MAX_LIFETIME: Duration = Duration::from_secs(300);
/// Maximum managed services in one graph/envelope; the aggregate input budget still applies.
pub const MAX_MANAGED_SERVICES: usize = 32;
/// Shared guest capacity, not a promise that the runtime admits this many containers.
pub const MAX_CONCURRENT_ALLOCATIONS: usize = 512;
/// Per-allocation tmpfs ceiling: all slots together cap payload filesystems at 32 MiB.
pub const ALLOCATION_BYTES: usize = 64 * 1024;
/// Private file members staged in one service allocation.
pub const MAX_ENVIRONMENT_FILES: usize = 4;
/// Decoded bytes of one private file member. Encoded values plus every file member of a
/// service share `MAX_ENVIRONMENT_PAYLOAD`, so the payload, at most four page-rounded
/// files and the two control files stay inside one `ALLOCATION_BYTES` tmpfs.
pub const MAX_ENVIRONMENT_FILE_BYTES: usize = 16 * 1024;
const MAX_FILE_TARGET: usize = 1024;
/// Container paths that a private file may neither replace nor shadow.
const RESERVED_FILE_ROOTS: [&str; 5] = ["/proc", "/sys", "/dev", "/run", "/var/run"];

/// Runs under the caller's retained runtime mutation lease. Uncertain paths consume capacity.
pub(super) fn preflight_capacity(
    guest: &OwnedGuest<'_>,
    requested: usize,
) -> Result<(), CandidateError> {
    guest.require_allocation()?;
    if !(1..=MAX_MANAGED_SERVICES).contains(&requested) {
        return Err(error("environment_capacity"));
    }
    super::environment_recovery::preflight_records(guest.candidate(), requested)?;
    let prefix = format!("/run/hack-env-lease-{}", guest.boot_id());
    let result = guest.execute(
        &format!("{CAPACITY_FUNCTION}\n{CAPACITY}"),
        &[
            &prefix,
            &requested.to_string(),
            &MAX_CONCURRENT_ALLOCATIONS.to_string(),
        ],
        None,
    );
    if !result
        .as_ref()
        .is_ok_and(|v| v == "environment-capacity-v1\n")
    {
        return Err(error("environment_capacity"));
    }
    Ok(())
}

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

/// Absolute, normalized container path for a private file bind. Reserved runtime roots,
/// relative components and control characters are refused; no host path is involved.
pub(crate) fn file_target(value: &str) -> bool {
    value.len() > 1
        && value.len() <= MAX_FILE_TARGET
        && value.starts_with('/')
        && value
            .bytes()
            .all(|c| (b' '..=b'~').contains(&c) && c != b'\\')
        && value[1..]
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
        && !RESERVED_FILE_ROOTS
            .iter()
            .any(|root| value == *root || within(value, root))
}
/// True when `path` is strictly below directory `parent` (both absolute, normalized).
pub(crate) fn within(path: &str, parent: &str) -> bool {
    parent == "/"
        || path
            .strip_prefix(parent)
            .is_some_and(|rest| rest.starts_with('/'))
}

/// One private file member: bytes live only in zeroized memory until staged mode 0400 in
/// the service allocation, then bind-mounted read-only at `target` for the container's
/// lifetime. Intentionally lacks Debug and Serialize; the name and target are public.
#[derive(Clone)]
pub struct ManagedFile {
    name: String,
    target: String,
    content: zeroize::Zeroizing<Vec<u8>>,
}
impl ManagedFile {
    /// Validates the member name (allocation-local file name), the container target and
    /// the size bound. Errors name no value.
    pub fn new(
        name: &str,
        target: &str,
        content: zeroize::Zeroizing<Vec<u8>>,
    ) -> Result<Self, CandidateError> {
        if !self::name(name)
            || !file_target(target)
            || content.is_empty()
            || content.len() > MAX_ENVIRONMENT_FILE_BYTES
        {
            return Err(error("environment_file"));
        }
        Ok(Self {
            name: name.into(),
            target: target.into(),
            content,
        })
    }
    pub fn name(&self) -> &str {
        &self.name
    }
    pub fn target(&self) -> &str {
        &self.target
    }
    pub(crate) fn content(&self) -> &[u8] {
        &self.content
    }
}
/// Service-scoped private file members.
pub type ManagedFiles = BTreeMap<String, Vec<ManagedFile>>;
/// Borrowed private delivery input: service-scoped values and file members. Neither
/// part is Debug or Serialize; this is a parameter bundle, not a durable record.
#[derive(Clone, Copy)]
pub struct ManagedInput<'a> {
    pub values: &'a BTreeMap<String, BTreeMap<String, String>>,
    pub files: &'a ManagedFiles,
}

/// Intentionally lacks Debug/Serialize. Lifetime begins at preparation, not at delivery.
pub struct PendingEnvironment {
    service: String,
    payload: zeroize::Zeroizing<String>,
    /// Whether the process is wrapped by the private launcher. A files-only service
    /// keeps its own entrypoint; the staged `values.json` is then an unused `{}`.
    wraps: bool,
    files: Vec<ManagedFile>,
    uid: u32,
    gid: u32,
    deadline: Instant,
}
/// An in-memory handle, not a durable receipt or native provider lease.
/// Expiry blocks verification/use; explicit removal or VM shutdown reclaims the tmpfs.
pub struct EnvironmentLease {
    pub(super) graph: Option<super::environment_recovery::GraphBinding>,
    #[cfg(feature = "native-config-plan")]
    pub(super) native: Option<super::native_environment::Binding>,
    pub(super) service: String,
    pub(super) uid: u32,
    pub(super) gid: u32,
    pub(super) slot: String,
    pub(super) incarnation: String,
    pub(super) boot: String,
    /// Value-free `(member name, container target)` pairs staged in this allocation.
    files: Vec<(String, String)>,
    wraps: bool,
    deadline: Instant,
}
enum Binding {
    Compose(Option<super::environment_recovery::GraphBinding>),
    #[cfg(feature = "native-config-plan")]
    Native(super::native_environment::Binding),
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
    /// Whether launcher admission (absolute entrypoint, CMD health) applies.
    pub(super) fn wraps_process(&self) -> bool {
        self.wraps
    }
    /// Public container targets of this service's private file members.
    pub(super) fn file_targets(&self) -> Vec<&str> {
        self.files.iter().map(ManagedFile::target).collect()
    }

    pub fn new(
        service: &str,
        values: &BTreeMap<String, String>,
        lifetime: Duration,
    ) -> Result<Self, CandidateError> {
        if lifetime.is_zero() || lifetime > MAX_LIFETIME {
            return Err(error("environment_input"));
        }
        let deadline = Instant::now()
            .checked_add(lifetime)
            .ok_or_else(|| error("environment_input"))?;
        Self::until(service, values, deadline)
    }

    /// Prepare against the caller's exact deadline; serialization never renews it.
    pub fn until(
        service: &str,
        values: &BTreeMap<String, String>,
        deadline: Instant,
    ) -> Result<Self, CandidateError> {
        Self::until_with_files(service, values, &[], deadline)
    }

    /// Prepare values plus private file members. Values may be empty only when at least
    /// one file exists; file names and targets are unique, targets never nest, and the
    /// encoded values plus all file bytes share `MAX_ENVIRONMENT_PAYLOAD`.
    pub fn until_with_files(
        service: &str,
        values: &BTreeMap<String, String>,
        files: &[ManagedFile],
        deadline: Instant,
    ) -> Result<Self, CandidateError> {
        let valid_deadline = || {
            deadline
                .checked_duration_since(Instant::now())
                .is_some_and(|left| !left.is_zero() && left <= MAX_LIFETIME)
        };
        if !valid_deadline() {
            return Err(error("environment_expired"));
        }
        if !name(service)
            || (values.is_empty() && files.is_empty())
            || values.len() > MAX_ENVIRONMENT_KEYS
            || files.len() > MAX_ENVIRONMENT_FILES
        {
            return Err(error("environment_input"));
        }
        for (index, file) in files.iter().enumerate() {
            if files[..index].iter().any(|other| {
                other.name == file.name
                    || other.target == file.target
                    || within(&other.target, &file.target)
                    || within(&file.target, &other.target)
            }) {
                return Err(error("environment_file"));
            }
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
            if bytes > MAX_ENVIRONMENT_PAYLOAD {
                return Err(error("environment_budget"));
            }
        }
        for file in files {
            bytes = bytes
                .checked_add(file.content.len())
                .ok_or_else(|| error("environment_budget"))?;
            if bytes > MAX_ENVIRONMENT_PAYLOAD {
                return Err(error("environment_budget"));
            }
        }
        let payload = zeroize::Zeroizing::new(
            serde_json::to_string(values).map_err(|_| error("environment_input"))?,
        );
        let file_bytes: usize = files.iter().map(|file| file.content.len()).sum();
        if payload.len() + file_bytes > MAX_ENVIRONMENT_PAYLOAD {
            return Err(error("environment_budget"));
        }
        if !valid_deadline() {
            return Err(error("environment_expired"));
        }
        Ok(Self {
            service: service.into(),
            payload,
            wraps: !values.is_empty(),
            files: files.to_vec(),
            uid: 0,
            gid: 0,
            deadline,
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
        self.stage_binding(guest, Binding::Compose(graph))
    }
    #[cfg(feature = "native-config-plan")]
    pub(super) fn stage_native(
        self,
        guest: &OwnedGuest<'_>,
        binding: super::native_environment::Binding,
    ) -> Result<EnvironmentLease, CandidateError> {
        self.stage_binding(guest, Binding::Native(binding))
    }
    fn stage_binding(
        self,
        guest: &OwnedGuest<'_>,
        binding: Binding,
    ) -> Result<EnvironmentLease, CandidateError> {
        guest.require_allocation()?;
        remaining(self.deadline)?;
        preflight_capacity(guest, 1)?;
        remaining(self.deadline)?;
        let candidate = guest.candidate();
        let mut random = [0u8; 16];
        File::open("/dev/urandom")
            .and_then(|mut f| f.read_exact(&mut random))
            .map_err(|_| error("environment_identity"))?;
        let token: String = random.iter().map(|b| format!("{b:02x}")).collect();
        #[cfg(feature = "native-config-plan")]
        let native = match &binding {
            Binding::Native(binding) => Some(binding.clone()),
            _ => None,
        };
        #[cfg(feature = "native-config-plan")]
        let graph = match binding {
            Binding::Compose(graph) => graph,
            #[cfg(feature = "native-config-plan")]
            Binding::Native(_) => None,
        };
        #[cfg(not(feature = "native-config-plan"))]
        let Binding::Compose(graph) = binding;
        // Built before the lease takes ownership of the service name.
        let (layout, input) = self.staging_input();
        let lease = EnvironmentLease {
            graph,
            #[cfg(feature = "native-config-plan")]
            native,
            uid: self.uid,
            gid: self.gid,
            service: self.service,
            slot: format!("hack-env-lease-{}-{token}", guest.boot_id()),
            incarnation: guest.incarnation().into(),
            boot: guest.boot_id().into(),
            files: self
                .files
                .iter()
                .map(|file| (file.name.clone(), file.target.clone()))
                .collect(),
            wraps: self.wraps,
            deadline: self.deadline,
        };
        #[cfg(feature = "native-config-plan")]
        if lease.native.is_some() {
            super::native_environment::record(candidate, guest, &lease)?;
        } else {
            super::environment_recovery::record(candidate, &lease)?;
        }
        #[cfg(not(feature = "native-config-plan"))]
        super::environment_recovery::record(candidate, &lease)?;
        let seconds = remaining(lease.deadline)?;
        let result = guest.execute(
            &format!("{CAPACITY_FUNCTION}\n{FILES_FUNCTION}\n{STAGE}"),
            &[
                &lease.slot,
                &lease.service,
                &seconds.to_string(),
                &lease.uid.to_string(),
                &lease.gid.to_string(),
                &MAX_CONCURRENT_ALLOCATIONS.to_string(),
                &ALLOCATION_BYTES.to_string(),
                &MAX_ENVIRONMENT_PAYLOAD.to_string(),
                &layout,
            ],
            Some(&input),
        );
        if !result
            .as_ref()
            .is_ok_and(|value| value == "environment-staged-v1\n")
        {
            // Identity-checked removal also handles a partially written payload. Never expose output.
            let _ = lease.remove_with_guest(guest);
            return Err(CandidateError::new(
                "environment_stage_uncertain",
                format!(
                    "Environment staging uncertain; cleanup intent {} retained. Values and guest output omitted.",
                    lease.slot
                ),
            ));
        }
        if remaining(lease.deadline).is_err() {
            let _ = lease.remove_with_guest(guest);
            return Err(error("environment_expired"));
        }
        Ok(lease)
    }
}
impl PendingEnvironment {
    /// Guest staging input. Without files it is exactly the values payload (the original
    /// layout). With files, `layout` names the values byte length and, per member,
    /// `name:encoded-length:decoded-length`; stdin is the payload followed by each
    /// member's standard base64 text. Lengths and names are public; bytes never reach argv.
    fn staging_input(&self) -> (String, zeroize::Zeroizing<String>) {
        use base64::Engine as _;
        if self.files.is_empty() {
            return (String::new(), self.payload.clone());
        }
        let encoded = |file: &ManagedFile| {
            zeroize::Zeroizing::new(base64::engine::general_purpose::STANDARD.encode(&file.content))
        };
        let mut layout = self.payload.len().to_string();
        let mut capacity = self.payload.len();
        for file in &self.files {
            let text = encoded(file);
            capacity += text.len();
            layout.push_str(&format!(
                " {}:{}:{}",
                file.name,
                text.len(),
                file.content.len()
            ));
        }
        let mut input = zeroize::Zeroizing::new(String::with_capacity(capacity));
        input.push_str(&self.payload);
        for file in &self.files {
            input.push_str(&encoded(file));
        }
        (layout, input)
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
        let names = self
            .files
            .iter()
            .map(|(name, _)| name.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        let result = guest.execute(
            VERIFY,
            &[
                &self.slot,
                &self.service,
                &self.uid.to_string(),
                &self.gid.to_string(),
                &MAX_ENVIRONMENT_PAYLOAD.to_string(),
                &names,
                &MAX_ENVIRONMENT_FILE_BYTES.to_string(),
            ],
            None,
        )?;
        if result != "environment-verified-v1\n" {
            return Err(error("environment_verification"));
        }
        remaining(self.deadline)?;
        Ok(format!("/run/{}/values.json", self.slot))
    }
    /// Read-only binds for this allocation's verified file members, as
    /// `(guest source, container target)`. Call only after `verified_path_with_guest`.
    pub(super) fn file_mounts(&self) -> Vec<(String, String)> {
        self.files
            .iter()
            .map(|(name, target)| (format!("/run/{}/files/{name}", self.slot), target.clone()))
            .collect()
    }
    /// Whether the container process is wrapped by the private launcher.
    pub(super) fn wraps_process(&self) -> bool {
        self.wraps
    }
    /// Cleanup is permitted after expiry and is retry-safe for an absent slot on the same boot.
    pub fn remove(&self, candidate: &Candidate) -> Result<(), CandidateError> {
        let guest = self.guest(candidate, true)?;
        self.remove_with_guest(&guest)
    }
    pub(super) fn remove_with_guest(&self, guest: &OwnedGuest<'_>) -> Result<(), CandidateError> {
        self.matches_guest(guest)?;
        #[cfg(feature = "native-config-plan")]
        if self.native.is_some() {
            return super::native_environment::retire(
                guest.candidate(),
                guest,
                &self.slot,
                Some(self),
            );
        }
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
const CAPACITY_FUNCTION: &str = r#"
capacity_check() {
  case "$2" in ''|*[!0-9]*) return 1;; esac
  case "$3" in ''|*[!0-9]*) return 1;; esac
  test "$2" -gt 0
  test "$2" -le "$3"
  available=$(($3 - $2))
  count=0
  for path in "$1"-*; do
    if test -e "$path" || test -L "$path"; then
      count=$((count + 1))
      test "$count" -le "$available"
    fi
  done
}
"#;
// Reads exactly the declared byte counts with single-byte `dd` reads, so no tool can
// consume a later member. Each member decodes from base64, must match its decoded length,
// and becomes mode 0400 for the container owner inside a root-only 0700 directory.
// Trailing input refuses. Names are validated here as well as in Rust.
const FILES_FUNCTION: &str = r#"
stage_files() {
  set -f
  stage_root=$1
  stage_owner=$2
  set -- $3
  case "$1" in ''|*[!0-9]*) return 1;; esac
  dd bs=1 count="$1" of="$stage_root/values.json" 2>/dev/null
  test "$(($(wc -c < "$stage_root/values.json")))" = "$1"
  shift
  test "$#" -ge 1
  test "$#" -le 4
  mkdir -m 700 "$stage_root/files"
  for stage_entry in "$@"; do
    stage_name=${stage_entry%%:*}
    stage_rest=${stage_entry#*:}
    stage_encoded=${stage_rest%%:*}
    stage_size=${stage_rest#*:}
    case "$stage_name" in ''|[!A-Za-z0-9]*|*[!A-Za-z0-9._-]*) return 1;; esac
    case "$stage_encoded" in ''|*[!0-9]*) return 1;; esac
    case "$stage_size" in ''|*[!0-9]*) return 1;; esac
    stage_file="$stage_root/files/$stage_name"
    test ! -e "$stage_file"
    test ! -L "$stage_file"
    dd bs=1 count="$stage_encoded" 2>/dev/null | base64 -d > "$stage_file"
    test "$(($(wc -c < "$stage_file")))" = "$stage_size"
    chmod 400 "$stage_file"
    chown "$stage_owner" "$stage_file"
  done
  test "$(($(dd bs=1 count=1 2>/dev/null | wc -c)))" = 0
}
"#;
const CAPACITY: &str = r#"
(
set -eu
capacity_check "$1" "$2" "$3"
) >/dev/null 2>&1
printf 'environment-capacity-v1\n'
"#;
const STAGE: &str = r#"
(
set -eu
ulimit -c 0
umask 077
awk '/^SwapTotal:/ { found=1; if ($2 != 0) bad=1 } END { exit (!found || bad) }' /proc/meminfo
capacity_check "/run/${1%-*}" 1 "$6"
root="/run/$1"
test ! -e "$root"
test ! -L "$root"
mkdir "$root"
mount -t tmpfs -o "size=$7,mode=0700,nosuid,nodev,noexec" "$1" "$root"
test "$(findmnt -n -o FSTYPE --mountpoint "$root")" = tmpfs
test "$(findmnt -n -o SOURCE --mountpoint "$root")" = "$1"
printf '%s' "$2" > "$root/service"
now=$(cut -d. -f1 /proc/uptime)
printf '%s' "$((now + $3))" > "$root/expires"
if test -z "$9"; then
 cat > "$root/values.json"
else
 stage_files "$root" "$4:$5" "$9"
fi
test "$(stat -c %s "$root/values.json")" -le "$8"
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
test "$(stat -c %s "$root/values.json")" -le "$5"
if test -n "$6"; then
 test ! -L "$root/files"
 test -d "$root/files"
 test "$(stat -c %u:%g:%a "$root/files")" = 0:0:700
 set -f
 count=0
 for name in $6; do
  count=$((count + 1))
  test ! -L "$root/files/$name"
  test -f "$root/files/$name"
  test "$(stat -c %u:%g:%a:%h "$root/files/$name")" = "$3:$4:400:1"
  test "$(stat -c %s "$root/files/$name")" -le "$7"
 done
 test "$(ls -A "$root/files" | wc -l)" -eq "$count"
else
 test ! -e "$root/files"
 test ! -L "$root/files"
fi
) >/dev/null 2>&1
printf 'environment-verified-v1\n'
"#;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn capacity_scan_bounds_batches_and_counts_uncertain_current_boot_paths() {
        use std::{fs, os::unix::fs::symlink, path::PathBuf, process::Command};
        struct Directory(PathBuf);
        impl Drop for Directory {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = Directory(
            std::env::temp_dir()
                .canonicalize()
                .unwrap()
                .join(format!("hack-env-capacity-{}-{nonce}", std::process::id())),
        );
        fs::create_dir(&directory.0).unwrap();
        let prefix = directory.0.join("hack-env-lease-current-boot");
        let script = format!("{CAPACITY_FUNCTION}\n{CAPACITY}");
        let check = |requested: &str, accepted: bool| {
            let output = Command::new("/bin/sh")
                .args([
                    "-eu",
                    "-c",
                    &script,
                    "capacity",
                    prefix.to_str().unwrap(),
                    requested,
                    &MAX_CONCURRENT_ALLOCATIONS.to_string(),
                ])
                .output()
                .unwrap();
            assert_eq!(output.status.success(), accepted);
            assert!(output.stderr.is_empty());
            assert_eq!(
                output.stdout,
                if accepted {
                    b"environment-capacity-v1\n".as_slice()
                } else {
                    b""
                }
            );
        };
        check("12", true);
        for requested in ["0", "513", "bad"] {
            check(requested, false);
        }
        fs::write(directory.0.join("hack-env-lease-other-boot-held"), b"").unwrap();
        for n in 0..500 {
            fs::write(
                directory.0.join(format!("hack-env-lease-current-boot-{n}")),
                b"",
            )
            .unwrap();
        }
        check("12", true);
        symlink(
            "absent-target",
            directory.0.join("hack-env-lease-current-boot-dangling"),
        )
        .unwrap();
        check("12", false);
        check("11", true);
        fs::create_dir(directory.0.join("hack-env-lease-current-boot-partial")).unwrap();
        check("11", false);
        check("10", true);
        for n in 502..512 {
            fs::write(
                directory.0.join(format!("hack-env-lease-current-boot-{n}")),
                b"",
            )
            .unwrap();
        }
        check("1", false);
        assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 513);
        fs::remove_file(directory.0.join("hack-env-lease-current-boot-511")).unwrap();
        check("1", true);
    }
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

    fn member(name: &str, target: &str, bytes: &[u8]) -> ManagedFile {
        ManagedFile::new(name, target, zeroize::Zeroizing::new(bytes.to_vec())).unwrap()
    }
    #[test]
    fn file_members_validate_names_targets_and_size_without_values() {
        let content = || zeroize::Zeroizing::new(b"synthetic-file-canary".to_vec());
        for (name, target) in [
            ("", "/config/a.json"),
            ("../a", "/config/a.json"),
            (".hidden", "/config/a.json"),
            ("a/b", "/config/a.json"),
            ("a", "relative"),
            ("a", "/"),
            ("a", "/run/a"),
            ("a", "/var/run/a"),
            ("a", "/proc"),
            ("a", "/dev/a"),
            ("a", "/sys/a"),
            ("a", "/config/../a"),
            ("a", "/config/./a"),
            ("a", "/config//a"),
            ("a", "/config/a/"),
            ("a", "/config/a\\b"),
            ("a", "/config/a\nb"),
        ] {
            let error = ManagedFile::new(name, target, content()).err().unwrap();
            assert_eq!(error.code, "environment_file");
            assert!(!error.message.contains("synthetic-file-canary"));
        }
        assert!(ManagedFile::new("a", "/config/a", zeroize::Zeroizing::new(Vec::new())).is_err());
        assert!(
            ManagedFile::new(
                "a",
                "/config/a",
                zeroize::Zeroizing::new(vec![b'x'; MAX_ENVIRONMENT_FILE_BYTES + 1])
            )
            .is_err()
        );
        let largest = ManagedFile::new(
            "a.json",
            "/srv/app/.config/tool/credential file.json",
            zeroize::Zeroizing::new(vec![b'x'; MAX_ENVIRONMENT_FILE_BYTES]),
        )
        .unwrap();
        assert_eq!(
            largest.target(),
            "/srv/app/.config/tool/credential file.json"
        );
        assert!(ManagedFile::new("a", "/runner/a", content()).is_ok());
        assert!(ManagedFile::new("a", "/varrun/a", content()).is_ok());
    }
    #[test]
    fn file_preparation_admits_files_only_services_and_bounds_the_shared_budget() {
        let deadline = Instant::now() + Duration::from_secs(60);
        let empty = BTreeMap::new();
        let values = BTreeMap::from([("TOKEN".into(), "synthetic-only".into())]);
        let one = [member("adc.json", "/config/adc.json", b"{\"type\":\"x\"}")];
        let files_only =
            PendingEnvironment::until_with_files("proxy", &empty, &one, deadline).unwrap();
        assert!(!files_only.wraps_process());
        assert_eq!(files_only.file_targets(), vec!["/config/adc.json"]);
        assert_eq!(&*files_only.payload, "{}");
        let both = PendingEnvironment::until_with_files("web", &values, &one, deadline).unwrap();
        assert!(both.wraps_process());
        let plain = PendingEnvironment::until("web", &values, deadline).unwrap();
        assert!(plain.wraps_process() && plain.file_targets().is_empty());
        assert_eq!(
            PendingEnvironment::until_with_files("web", &empty, &[], deadline)
                .err()
                .unwrap()
                .code,
            "environment_input"
        );
        let five: Vec<_> = (0..5)
            .map(|n| member(&format!("f{n}"), &format!("/config/f{n}"), b"x"))
            .collect();
        assert!(PendingEnvironment::until_with_files("web", &empty, &five[..4], deadline).is_ok());
        assert!(PendingEnvironment::until_with_files("web", &empty, &five, deadline).is_err());
        for pair in [
            [
                member("a", "/config/a", b"x"),
                member("a", "/config/b", b"x"),
            ],
            [
                member("a", "/config/a", b"x"),
                member("b", "/config/a", b"x"),
            ],
            [member("a", "/config", b"x"), member("b", "/config/b", b"x")],
            [
                member("a", "/config/b/c", b"x"),
                member("b", "/config/b", b"x"),
            ],
        ] {
            assert_eq!(
                PendingEnvironment::until_with_files("web", &empty, &pair, deadline)
                    .err()
                    .unwrap()
                    .code,
                "environment_file"
            );
        }
        let half = MAX_ENVIRONMENT_FILE_BYTES;
        let full = [
            member("a", "/config/a", &vec![b'x'; half]),
            member("b", "/config/b", &vec![b'x'; half - 2]),
        ];
        assert!(PendingEnvironment::until_with_files("web", &empty, &full, deadline).is_ok());
        let error = PendingEnvironment::until_with_files("web", &values, &full, deadline)
            .err()
            .unwrap();
        assert_eq!(error.code, "environment_budget");
        assert!(
            PendingEnvironment::until_with_files(
                "web",
                &empty,
                &one,
                Instant::now() - Duration::from_secs(1)
            )
            .is_err()
        );
    }
    #[test]
    fn staging_input_keeps_the_original_layout_without_files() {
        let deadline = Instant::now() + Duration::from_secs(60);
        let values = BTreeMap::from([("TOKEN".into(), "synthetic-only".into())]);
        let plain = PendingEnvironment::until("web", &values, deadline).unwrap();
        let (layout, input) = plain.staging_input();
        assert!(layout.is_empty());
        assert_eq!(&*input, &*plain.payload);
        let files = [
            member(
                "a.json",
                "/config/a.json",
                b"{\"k\":\"synthetic-file-canary\"}",
            ),
            member("b", "/config/b", &[0, 255, 10, 13]),
        ];
        let staged =
            PendingEnvironment::until_with_files("web", &values, &files, deadline).unwrap();
        let (layout, input) = staged.staging_input();
        assert_eq!(
            layout,
            format!("{} a.json:40:29 b:8:4", staged.payload.len())
        );
        assert!(!layout.contains("synthetic"));
        assert!(input.starts_with(&*staged.payload));
        assert!(!input[staged.payload.len()..].contains("synthetic-file-canary"));
    }
    /// Runs the guest member-staging function on the host shell against a scratch root.
    /// `stat -c` is avoided there so the same body runs on macOS and the Linux guest.
    fn stage_members(layout: &str, input: &[u8]) -> (bool, std::path::PathBuf) {
        use std::{
            io::Write,
            process::{Command, Stdio},
        };
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .join(format!("hack-env-files-{}-{nonce}", std::process::id()));
        std::fs::create_dir(&root).unwrap();
        let owner = format!("{}:{}", unsafe { libc::geteuid() }, unsafe {
            libc::getegid()
        });
        let script = format!(
            "{FILES_FUNCTION}\n(\nset -eu\nstage_files \"$1\" \"$2\" \"$3\"\n) >/dev/null 2>&1\nprintf 'staged\\n'\n"
        );
        let mut child = Command::new("/bin/sh")
            .args([
                "-eu",
                "-c",
                &script,
                "stage",
                root.to_str().unwrap(),
                &owner,
                layout,
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(input).unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(output.stderr.is_empty());
        (output.stdout == b"staged\n", root)
    }
    #[test]
    fn member_staging_reads_exact_lengths_and_refuses_malformed_input() {
        use std::os::unix::fs::PermissionsExt;
        let deadline = Instant::now() + Duration::from_secs(60);
        let values = BTreeMap::from([("TOKEN".into(), "synthetic-only".into())]);
        let binary: Vec<u8> = (0..=255).collect();
        let files = [
            member(
                "a.json",
                "/config/a.json",
                b"{\"k\":\"synthetic-file-canary\"}\n",
            ),
            member("b.bin", "/config/b.bin", &binary),
        ];
        let staged =
            PendingEnvironment::until_with_files("web", &values, &files, deadline).unwrap();
        let (layout, input) = staged.staging_input();
        let (ok, root) = stage_members(&layout, input.as_bytes());
        assert!(ok);
        assert_eq!(
            std::fs::read(root.join("values.json")).unwrap(),
            staged.payload.as_bytes()
        );
        assert_eq!(
            std::fs::read(root.join("files/a.json")).unwrap(),
            b"{\"k\":\"synthetic-file-canary\"}\n"
        );
        assert_eq!(std::fs::read(root.join("files/b.bin")).unwrap(), binary);
        for name in ["files/a.json", "files/b.bin"] {
            let mode = std::fs::metadata(root.join(name))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o400);
        }
        let directory = std::fs::metadata(root.join("files"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(directory & 0o777, 0o700);
        let _ = std::fs::set_permissions(
            root.join("files/a.json"),
            std::fs::Permissions::from_mode(0o600),
        );
        let _ = std::fs::set_permissions(
            root.join("files/b.bin"),
            std::fs::Permissions::from_mode(0o600),
        );
        std::fs::remove_dir_all(&root).unwrap();
        let bytes = input.as_bytes();
        let decoded = files[0].content().len();
        let payload = staged.payload.len();
        for (layout, input) in [
            // Trailing, truncated and corrupted input.
            (layout.clone(), [bytes, b"x"].concat()),
            (layout.clone(), bytes[..bytes.len() - 1].to_vec()),
            (
                layout.replacen(&format!(":{decoded} "), &format!(":{} ", decoded + 1), 1),
                bytes.to_vec(),
            ),
            // Unsafe or missing names and lengths.
            (layout.replacen("a.json", "../a", 1), bytes.to_vec()),
            (layout.replacen("a.json", ".a", 1), bytes.to_vec()),
            (format!("{payload}"), bytes[..payload].to_vec()),
            (
                format!("x {}", &layout[layout.find(' ').unwrap() + 1..]),
                bytes.to_vec(),
            ),
            (
                format!("{payload} a:1:1 b:1:1 c:1:1 d:1:1 e:1:1"),
                bytes.to_vec(),
            ),
        ] {
            let (ok, root) = stage_members(&layout, &input);
            assert!(!ok, "{layout}");
            for name in ["files/a.json", "files/b.bin", "files/a", "files/b"] {
                let _ = std::fs::set_permissions(
                    root.join(name),
                    std::fs::Permissions::from_mode(0o600),
                );
            }
            std::fs::remove_dir_all(&root).unwrap();
        }
    }
    #[test]
    fn absolute_preparation_preserves_exact_deadline_and_rejects_expiry() {
        let values = BTreeMap::from([("TOKEN".into(), "synthetic-only".into())]);
        let deadline = Instant::now() + Duration::from_secs(30);
        let first = PendingEnvironment::until("web", &values, deadline).unwrap();
        let second = PendingEnvironment::until("worker", &values, deadline).unwrap();
        assert_eq!(first.deadline, deadline);
        assert_eq!(second.deadline, deadline);
        for invalid in [
            Instant::now() - Duration::from_secs(1),
            Instant::now() + Duration::from_secs(301),
        ] {
            assert_eq!(
                PendingEnvironment::until("web", &values, invalid)
                    .err()
                    .unwrap()
                    .code,
                "environment_expired"
            );
        }
        let before = Instant::now();
        let relative = PendingEnvironment::new("web", &values, Duration::from_secs(30)).unwrap();
        assert!(relative.deadline >= before + Duration::from_secs(30));
        assert!(relative.deadline <= Instant::now() + Duration::from_secs(30));
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
            BTreeMap::from([("TOKEN".into(), "\n".repeat(MAX_ENVIRONMENT_PAYLOAD / 2))]),
        ] {
            assert!(PendingEnvironment::new("web", &values, Duration::from_secs(60)).is_err());
        }
        assert!(PendingEnvironment::new("web", &good, Duration::ZERO).is_err());
        assert!(PendingEnvironment::new("web", &good, Duration::from_secs(301)).is_err());
        assert!(PendingEnvironment::new("web", &good, Duration::from_secs(60)).is_ok());
    }
    #[test]
    fn application_sized_environment_preserves_fixed_allocation_budget() {
        let mut values: BTreeMap<String, String> = (0..256)
            .map(|n| (format!("APP_KEY_{n}"), "synthetic-value".repeat(4)))
            .collect();
        let prepared = PendingEnvironment::new("web", &values, Duration::from_secs(60)).unwrap();
        assert!(prepared.payload.len() > 8192);
        assert_eq!(
            serde_json::from_str::<BTreeMap<String, String>>(&prepared.payload).unwrap(),
            values
        );
        assert!(prepared.payload.len() + 3 * 4096 <= ALLOCATION_BYTES);
        values.insert("ONE_TOO_MANY".into(), "synthetic".into());
        assert!(PendingEnvironment::new("web", &values, Duration::from_secs(60)).is_err());
        let mut exact = BTreeMap::from([("K".into(), "x".repeat(MAX_ENVIRONMENT_PAYLOAD - 8))]);
        let prepared = PendingEnvironment::new("web", &exact, Duration::from_secs(60)).unwrap();
        assert_eq!(prepared.payload.len(), MAX_ENVIRONMENT_PAYLOAD);
        exact.get_mut("K").unwrap().push('x');
        assert!(PendingEnvironment::new("web", &exact, Duration::from_secs(60)).is_err());
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
