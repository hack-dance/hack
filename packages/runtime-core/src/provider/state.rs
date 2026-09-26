//! Private state ownership and nonblocking operation serialization.
use crate::{Candidate, CandidateError, reject_aliased_state};
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

pub fn io(error: std::io::Error) -> CandidateError {
    CandidateError::new("provider_state", error.to_string())
}

pub fn private_directory(path: &Path) -> Result<(), CandidateError> {
    reject_aliased_state(path)?;
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)
        .map_err(io)?;
    check_private_directory(path)
}

pub fn check_private_directory(path: &Path) -> Result<(), CandidateError> {
    reject_aliased_state(path)?;
    let metadata = fs::metadata(path).map_err(io)?;
    // SAFETY: geteuid has no preconditions.
    if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o077 != 0 {
        return Err(CandidateError::new(
            "foreign_state",
            "Provider directory must be owned by this user and mode 0700.",
        ));
    }
    Ok(())
}

pub struct Lock(File);
impl Lock {
    /// Identity of the retained descriptor, for callers fencing pathname replacement.
    #[cfg(target_os = "macos")]
    pub(crate) fn identity(&self) -> Result<(u64, u64), CandidateError> {
        let metadata = self.0.metadata().map_err(io)?;
        Ok((metadata.dev(), metadata.ino()))
    }

    pub fn acquire(root: &Path) -> Result<Self, CandidateError> {
        private_directory(root)?;
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(root.join("operation.lock"))
            .map_err(io)?;
        Self::from_file(file)
    }

    /// Observe existing state without initializing a directory or lock file.
    #[cfg(target_os = "macos")]
    pub fn acquire_existing(root: &Path) -> Result<Self, CandidateError> {
        check_private_directory(root)?;
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(root.join("operation.lock"))
            .map_err(io)?;
        Self::from_file(file)
    }

    fn from_file(file: File) -> Result<Self, CandidateError> {
        let m = file.metadata().map_err(io)?;
        if !m.is_file()
            || m.nlink() != 1
            || m.uid() != unsafe { libc::geteuid() }
            || m.mode() & 0o077 != 0
        {
            return Err(CandidateError::new(
                "foreign_state",
                "Unsafe operation lock.",
            ));
        }
        // SAFETY: file is a live owned descriptor; flock does not retain pointers.
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(CandidateError::new(
                "provider_busy",
                "Another candidate operation holds the provider lock.",
            ));
        }
        Ok(Self(file))
    }
}
impl Drop for Lock {
    fn drop(&mut self) {
        unsafe {
            libc::flock(self.0.as_raw_fd(), libc::LOCK_UN);
        }
    }
}

pub fn read<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, CandidateError> {
    read_bounded(path, 1024 * 1024)
}

pub fn read_bounded<T: serde::de::DeserializeOwned>(
    path: &Path,
    limit: u64,
) -> Result<T, CandidateError> {
    let mut f = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(io)?;
    let m = f.metadata().map_err(io)?;
    if !m.is_file()
        || m.len() > limit
        || m.nlink() != 1
        || m.uid() != unsafe { libc::geteuid() }
        || m.mode() & 0o077 != 0
    {
        return Err(CandidateError::new(
            "foreign_state",
            "Unsafe or oversized provider receipt.",
        ));
    }
    let mut bytes = Vec::new();
    std::io::Read::by_ref(&mut f)
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(io)?;
    if bytes.len() as u64 > limit {
        return Err(CandidateError::new(
            "foreign_state",
            "Provider receipt grew beyond its limit.",
        ));
    }
    serde_json::from_slice(&bytes).map_err(|_| {
        CandidateError::new(
            "invalid_receipt",
            "Invalid provider receipt; refusing adoption.",
        )
    })
}

pub fn write(path: &Path, value: &impl Serialize) -> Result<(), CandidateError> {
    let temporary = path.with_extension("pending");
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|e| CandidateError::new("invalid_receipt", e.to_string()))?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temporary)
        .map_err(io)?;
    file.write_all(&bytes).map_err(io)?;
    file.sync_all().map_err(io)?;
    fs::rename(&temporary, path).map_err(io)?;
    File::open(path.parent().expect("receipt parent"))
        .map_err(io)?
        .sync_all()
        .map_err(io)?;
    Ok(())
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ReclamationPolicy {
    pub enabled: bool,
    pub idle_minutes: Option<u64>,
}
impl Default for ReclamationPolicy {
    fn default() -> Self {
        Self {
            enabled: true,
            idle_minutes: Some(10),
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Owner {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_share: Option<super::ProjectShareIntent>,
    #[serde(default)]
    pub network: super::NetworkIntent,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub application_bridge: Option<super::BridgeIntent>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dependency_sockets: Option<super::DependencySocketIntent>,
    pub version: u32,
    pub checkout: PathBuf,
    pub token: String,
    pub machine: String,
    pub short_home: PathBuf,
    pub created: bool,
    pub phase: String,
    pub process: Option<super::identity::ProcessIdentity>,
    pub storage: Option<super::identity::DiskIdentity>,
    pub overlay: Option<super::identity::DiskIdentity>,
    pub guest_boot_id: Option<String>,
    #[serde(default)]
    pub previous_guest_boot_id: Option<String>,
    pub daemon_pid: Option<u32>,
    pub daemon_start: Option<u64>,
    pub rootfs_digest: Option<String>,
    #[serde(default)]
    pub profile: super::Profile,
    #[serde(default)]
    pub reclamation: Option<ReclamationPolicy>,
}
impl Owner {
    pub fn load(candidate: &Candidate) -> Result<Self, CandidateError> {
        let root = candidate.state_root.join("run/smolvm");
        reject_aliased_state(&root)?;
        let owner: Self = read(&root.join("owner.json"))?;
        owner.network.validate()?;
        if let Some(share) = &owner.project_share {
            share.validate_receipt()?;
        }
        if owner.created
            && matches!(&owner.network, super::NetworkIntent::ApprovedHosts { cidrs, .. } if cidrs.is_empty())
        {
            return Err(CandidateError::new(
                "unaudited_provider_config",
                "Created pool is missing its pinned egress addresses.",
            ));
        }
        if owner
            .application_bridge
            .is_some_and(|bridge| super::BridgeIntent::new(bridge.slots).is_err())
            || owner
                .dependency_sockets
                .is_some_and(|intent| super::DependencySocketIntent::new(intent.slots).is_err())
            || super::dependency_socket::check_capacity(
                owner.application_bridge,
                owner.dependency_sockets,
            )
            .is_err()
            || owner.version != 1
            || owner.checkout != candidate.checkout
            || owner.token.len() != 32
            || !owner.token.bytes().all(|b| b.is_ascii_hexdigit())
            || owner.machine != format!("hack-{}", &owner.token[..12])
            || owner.short_home
                != Path::new("/private/tmp").join(format!("hkl-{}", &owner.token[..12]))
        {
            return Err(CandidateError::new(
                "foreign_state",
                "Provider owner identity does not match this checkout.",
            ));
        }
        // The only permitted alias is an exact, receipt-bound short HOME for Unix sockets.
        let alias = fs::symlink_metadata(&owner.short_home).map_err(io)?;
        if !alias.file_type().is_symlink()
            || alias.uid() != unsafe { libc::geteuid() }
            || fs::read_link(&owner.short_home).map_err(io)? != root.join("home")
        {
            return Err(CandidateError::new(
                "foreign_state",
                "Short provider HOME alias was replaced.",
            ));
        }
        check_private_directory(&root.join("home"))?;
        Ok(owner)
    }
    #[cfg(all(test, target_os = "macos"))]
    pub fn create(
        candidate: &Candidate,
        profile: super::Profile,
        application_bridge: Option<super::BridgeIntent>,
        network: super::NetworkIntent,
    ) -> Result<Self, CandidateError> {
        Self::create_with_dependencies(candidate, profile, application_bridge, network, None)
    }
    #[cfg(all(test, target_os = "macos"))]
    pub fn create_with_dependencies(
        candidate: &Candidate,
        profile: super::Profile,
        application_bridge: Option<super::BridgeIntent>,
        network: super::NetworkIntent,
        dependency_sockets: Option<super::DependencySocketIntent>,
    ) -> Result<Self, CandidateError> {
        Self::create_with_project_share(
            candidate,
            profile,
            application_bridge,
            network,
            dependency_sockets,
            None,
        )
    }
    pub fn create_with_project_share(
        candidate: &Candidate,
        profile: super::Profile,
        application_bridge: Option<super::BridgeIntent>,
        network: super::NetworkIntent,
        dependency_sockets: Option<super::DependencySocketIntent>,
        project_share: Option<super::ProjectShareIntent>,
    ) -> Result<Self, CandidateError> {
        if let Some(share) = &project_share {
            share.validate()?;
        }
        super::dependency_socket::check_capacity(application_bridge, dependency_sockets)?;
        let root = candidate.state_root.join("run/smolvm");
        let owner_path = root.join("owner.json");
        if owner_path.try_exists().map_err(io)? {
            return Self::load(candidate);
        }
        for name in ["home", "tmp", "docker-config"] {
            private_directory(&root.join(name))?;
        }
        if fs::read_dir(root.join("home"))
            .map_err(io)?
            .next()
            .is_some()
        {
            return Err(CandidateError::new(
                "foreign_state",
                "Unclaimed provider home is not empty.",
            ));
        }
        let mut bytes = [0_u8; 16];
        File::open("/dev/urandom")
            .map_err(io)?
            .read_exact(&mut bytes)
            .map_err(io)?;
        let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        let owner = Self {
            project_share,
            network,
            profile,
            application_bridge,
            dependency_sockets,
            version: 1,
            checkout: candidate.checkout.clone(),
            machine: format!("hack-{}", &token[..12]),
            short_home: Path::new("/private/tmp").join(format!("hkl-{}", &token[..12])),
            token,
            created: false,
            phase: "initializing".into(),
            process: None,
            storage: None,
            overlay: None,
            guest_boot_id: None,
            previous_guest_boot_id: None,
            reclamation: None,
            daemon_pid: None,
            daemon_start: None,
            rootfs_digest: None,
        };
        // Persist the intended alias before its first external effect. Collisions are never adopted.
        owner.save(candidate)?;
        std::os::unix::fs::symlink(root.join("home"), &owner.short_home).map_err(|_| {
            CandidateError::new(
                "socket_alias_collision",
                "Cannot exclusively create short provider alias; receipt retained for inspection.",
            )
        })?;
        if owner
            .data_dir()
            .join("agent.sock")
            .as_os_str()
            .as_encoded_bytes()
            .len()
            >= 104
        {
            return Err(CandidateError::new(
                "socket_path_too_long",
                "Provider socket exceeds macOS path budget.",
            ));
        }
        Ok(owner)
    }
    pub fn real_data_dir(&self, candidate: &Candidate) -> Result<PathBuf, CandidateError> {
        let relative = self
            .data_dir()
            .strip_prefix(&self.short_home)
            .expect("provider descendant")
            .to_owned();
        let path = candidate.state_root.join("run/smolvm/home").join(relative);
        reject_aliased_state(&path)?;
        Ok(path)
    }
    pub fn save(&self, candidate: &Candidate) -> Result<(), CandidateError> {
        write(&candidate.state_root.join("run/smolvm/owner.json"), self)
    }
    pub fn begin_boot(&mut self) -> Option<String> {
        self.previous_guest_boot_id = self
            .guest_boot_id
            .take()
            .or(self.previous_guest_boot_id.take());
        self.daemon_pid = None;
        self.daemon_start = None;
        self.previous_guest_boot_id.clone()
    }
    pub fn data_dir(&self) -> PathBuf {
        use sha2::{Digest, Sha256};
        let hash = format!("{:x}", Sha256::digest(self.machine.as_bytes()));
        self.short_home
            .join("Library/Caches/smolvm/vms")
            .join(&hash[..16])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    #[test]
    fn interrupted_restart_retains_previous_boot_without_reusing_daemon_identity() {
        let mut owner: Owner = serde_json::from_value(serde_json::json!({
            "version":1, "checkout":"/fixture", "token":"fixture", "machine":"fixture",
            "short_home":"/fixture", "created":true, "phase":"stopped", "process":null,
            "storage":null, "overlay":null, "guest_boot_id":"previous-boot",
            "daemon_pid":42, "daemon_start":99, "rootfs_digest":null
        }))
        .unwrap();
        assert!(owner.reclamation.is_none());
        assert!(owner.dependency_sockets.is_none());
        assert!(
            serde_json::to_value(&owner)
                .unwrap()
                .get("dependency_sockets")
                .is_none()
        );
        owner.reclamation = Some(ReclamationPolicy::default());
        assert_eq!(owner.begin_boot().as_deref(), Some("previous-boot"));
        assert!(owner.guest_boot_id.is_none());
        assert!(owner.daemon_pid.is_none());
        assert!(owner.daemon_start.is_none());
        let mut restored: Owner =
            serde_json::from_slice(&serde_json::to_vec(&owner).unwrap()).unwrap();
        assert_eq!(restored.reclamation, Some(ReclamationPolicy::default()));
        assert_eq!(restored.begin_boot().as_deref(), Some("previous-boot"));
        // A later successful boot becomes the predecessor on the next restart.
        restored.guest_boot_id = Some("next-boot".into());
        assert_eq!(restored.begin_boot().as_deref(), Some("next-boot"));
    }
    fn fixture() -> PathBuf {
        let mut random = [0_u8; 16];
        File::open("/dev/urandom")
            .unwrap()
            .read_exact(&mut random)
            .unwrap();
        let name: String = random.iter().map(|b| format!("{b:02x}")).collect();
        let path = std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .join(format!("hack-provider-test-{name}"));
        private_directory(&path).unwrap();
        path
    }
    #[test]
    fn concurrent_operations_are_rejected_and_dropping_the_holder_releases_lock() {
        let root = fixture();
        let first = Lock::acquire(&root).unwrap();
        assert!(matches!(Lock::acquire(&root),Err(e) if e.code == "provider_busy"));
        drop(first);
        assert!(Lock::acquire(&root).is_ok());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn symlink_and_hardlink_receipts_are_not_read() {
        let root = fixture();
        let foreign = root.join("foreign.json");
        write(&foreign, &serde_json::json!({"owner":"foreign"})).unwrap();
        let link = root.join("owner.json");
        std::os::unix::fs::symlink(&foreign, &link).unwrap();
        assert!(read::<serde_json::Value>(&link).is_err());
        fs::remove_file(&link).unwrap();
        fs::hard_link(&foreign, &link).unwrap();
        assert!(matches!(read::<serde_json::Value>(&link),Err(e) if e.code == "foreign_state"));
        assert_eq!(
            fs::read_to_string(&foreign).unwrap(),
            "{\n  \"owner\": \"foreign\"\n}"
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn interrupted_receipt_is_preserved_and_prevents_another_write() {
        let root = fixture();
        let path = root.join("owner.json");
        write(&path, &serde_json::json!({"phase":"running"})).unwrap();
        fs::write(path.with_extension("pending"), b"partial").unwrap();
        assert!(write(&path, &serde_json::json!({"phase":"stopped"})).is_err());
        assert_eq!(
            read::<serde_json::Value>(&path).unwrap()["phase"],
            "running"
        );
        assert_eq!(
            fs::read(path.with_extension("pending")).unwrap(),
            b"partial"
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn permissive_provider_directory_is_rejected_without_chmod() {
        let root = fixture();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(
            check_private_directory(&root).unwrap_err().code,
            "foreign_state"
        );
        assert_eq!(fs::metadata(&root).unwrap().mode() & 0o777, 0o755);
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn profile_changes_refuse_before_admission_and_legacy_owners_remain_research() {
        let root = fixture();
        let candidate = Candidate::discover(&root).unwrap();
        let directory = candidate.state_root.join("run/smolvm");
        let lock = Lock::acquire(&directory).unwrap();
        let owner = Owner::create(
            &candidate,
            super::super::Profile::Research,
            None,
            super::super::NetworkIntent::Isolated,
        )
        .unwrap();
        let receipt = directory.join("owner.json");
        let mut legacy: serde_json::Value = read(&receipt).unwrap();
        legacy.as_object_mut().unwrap().remove("profile");
        write(&receipt, &legacy).unwrap();
        let before = fs::read(&receipt).unwrap();
        assert_eq!(
            Owner::load(&candidate).unwrap().profile,
            super::super::Profile::Research
        );
        assert_eq!(
            super::super::up_with_profile(&candidate, super::super::Profile::Development)
                .unwrap_err()
                .code,
            "profile_conflict"
        );
        assert_eq!(fs::read(&receipt).unwrap(), before);
        assert!(!directory.join("admission.json").exists());
        fs::remove_file(&owner.short_home).unwrap();
        drop(lock);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn network_intent_is_durable_and_legacy_conflicts_do_not_write_state() {
        use super::super::{NetworkIntent, Profile};
        let root = fixture();
        let candidate = Candidate::discover(&root).unwrap();
        let directory = candidate.state_root.join("run/smolvm");
        let lock = Lock::acquire(&directory).unwrap();
        let owner = Owner::create(
            &candidate,
            Profile::Research,
            None,
            NetworkIntent::HostGateway,
        )
        .unwrap();
        assert_eq!(
            Owner::load(&candidate).unwrap().network,
            NetworkIntent::HostGateway
        );
        let receipt = directory.join("owner.json");
        let before = fs::read(&receipt).unwrap();
        assert_eq!(
            super::super::up_with_capabilities(
                &candidate,
                Profile::Research,
                None,
                Some(NetworkIntent::Isolated)
            )
            .unwrap_err()
            .code,
            "network_conflict"
        );
        assert_eq!(fs::read(&receipt).unwrap(), before);
        assert!(!directory.join("admission.json").exists());
        let mut legacy: serde_json::Value = read(&receipt).unwrap();
        legacy.as_object_mut().unwrap().remove("network");
        write(&receipt, &legacy).unwrap();
        assert_eq!(
            Owner::load(&candidate).unwrap().network,
            NetworkIntent::Isolated
        );
        let before = fs::read(&receipt).unwrap();
        assert_eq!(
            super::super::up_with_capabilities(
                &candidate,
                Profile::Research,
                None,
                Some(NetworkIntent::HostGateway)
            )
            .unwrap_err()
            .code,
            "network_conflict"
        );
        assert_eq!(fs::read(&receipt).unwrap(), before);
        assert!(!directory.join("admission.json").exists());
        fs::remove_file(&owner.short_home).unwrap();
        drop(lock);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn bridge_intent_is_durable_and_conflicts_do_not_write_state() {
        let root = fixture();
        let candidate = Candidate::discover(&root).unwrap();
        let directory = candidate.state_root.join("run/smolvm");
        let lock = Lock::acquire(&directory).unwrap();
        let intent = super::super::BridgeIntent::new(2).unwrap();
        let mut owner = Owner::create(
            &candidate,
            super::super::Profile::Research,
            Some(intent),
            super::super::NetworkIntent::Isolated,
        )
        .unwrap();
        assert_eq!(
            Owner::load(&candidate).unwrap().application_bridge,
            Some(intent)
        );
        let before = fs::read(directory.join("owner.json")).unwrap();
        assert_eq!(
            super::super::up_with_bridge(
                &candidate,
                super::super::Profile::Research,
                Some(super::super::BridgeIntent::new(1).unwrap())
            )
            .unwrap_err()
            .code,
            "bridge_conflict"
        );
        assert_eq!(fs::read(directory.join("owner.json")).unwrap(), before);
        assert!(!directory.join("admission.json").exists());
        owner.application_bridge = Some(super::super::BridgeIntent { slots: 0 });
        owner.save(&candidate).unwrap();
        assert_eq!(Owner::load(&candidate).unwrap_err().code, "foreign_state");
        fs::remove_file(&owner.short_home).unwrap();
        drop(lock);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn dependency_intent_conflicts_refuse_before_admission_and_preserve_state() {
        let root = fixture();
        let candidate = Candidate::discover(&root).unwrap();
        let directory = candidate.state_root.join("run/smolvm");
        let lock = Lock::acquire(&directory).unwrap();
        let intent = super::super::DependencySocketIntent::new(2).unwrap();
        let mut owner = Owner::create_with_dependencies(
            &candidate,
            super::super::Profile::Research,
            None,
            super::super::NetworkIntent::Isolated,
            Some(intent),
        )
        .unwrap();
        assert_eq!(
            Owner::load(&candidate).unwrap().dependency_sockets,
            Some(intent)
        );
        let before = fs::read(directory.join("owner.json")).unwrap();
        assert_eq!(
            super::super::up_with_sockets(
                &candidate,
                super::super::Profile::Research,
                None,
                Some(super::super::DependencySocketIntent::new(1).unwrap())
            )
            .unwrap_err()
            .code,
            "dependency_socket_conflict"
        );
        assert_eq!(
            super::super::up_with_sockets(
                &candidate,
                super::super::Profile::Research,
                Some(super::super::BridgeIntent::new(32).unwrap()),
                Some(intent)
            )
            .unwrap_err()
            .code,
            "dependency_socket"
        );
        assert_eq!(fs::read(directory.join("owner.json")).unwrap(), before);
        assert!(!directory.join("admission.json").exists());
        owner.dependency_sockets = Some(super::super::DependencySocketIntent { slots: 0 });
        owner.save(&candidate).unwrap();
        assert_eq!(Owner::load(&candidate).unwrap_err().code, "foreign_state");
        fs::remove_file(&owner.short_home).unwrap();
        drop(lock);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn replaced_short_alias_cannot_be_adopted() {
        let root = fixture();
        let candidate = Candidate::discover(&root).unwrap();
        let _lock = Lock::acquire(&candidate.state_root.join("run/smolvm")).unwrap();
        let owner = Owner::create(
            &candidate,
            super::super::Profile::Research,
            None,
            super::super::NetworkIntent::Isolated,
        )
        .unwrap();
        assert!(Owner::load(&candidate).is_ok());
        fs::remove_file(&owner.short_home).unwrap();
        let foreign = root.join("foreign");
        private_directory(&foreign).unwrap();
        std::os::unix::fs::symlink(&foreign, &owner.short_home).unwrap();
        assert_eq!(Owner::load(&candidate).unwrap_err().code, "foreign_state");
        assert_eq!(fs::read_dir(&foreign).unwrap().count(), 0);
        fs::remove_file(&owner.short_home).unwrap();
        drop(_lock);
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn foreign_checkout_cannot_adopt_an_owner_record() {
        let root = fixture();
        let candidate = Candidate::discover(&root).unwrap();
        let _lock = Lock::acquire(&candidate.state_root.join("run/smolvm")).unwrap();
        let mut owner = Owner::create(
            &candidate,
            super::super::Profile::Research,
            None,
            super::super::NetworkIntent::Isolated,
        )
        .unwrap();
        owner.checkout = root.join("other");
        owner.save(&candidate).unwrap();
        assert_eq!(Owner::load(&candidate).unwrap_err().code, "foreign_state");
        fs::remove_file(&owner.short_home).unwrap();
        drop(_lock);
        fs::remove_dir_all(root).unwrap();
    }
}
