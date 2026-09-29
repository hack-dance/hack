//! Prepared-base store, publication and fresh-pool activation.
//!
//! A prepared base is a pair of expanded disk templates, cloned from a sanitized seed machine's
//! disks, that pinned SmolVM clones into a fresh pool's disks in place of its stock templates.
//! This module owns the parts that need no VM: the versioned receipt, atomic private publication
//! into an explicit store, fresh-pool pin and capacity binding, clone-then-verify activation into
//! a pool's provider `$HOME/.smolvm`, the base-scoped network-tools owner, and recovery of an
//! activation the pool owns.
//!
//! It is deliberately not wired into `lifecycle`. Adoption also needs a seed builder that
//! produces the base in an owned machine, installs network tools under the base-scoped owner,
//! sanitizes and stops it, and publishes it with readback. Until then the receipt's
//! sanitization record is a publisher claim this module requires but cannot verify.
//!
//! Timing (pinned SmolVM 1.14.3): a machine's disks are formatted from the plain templates during
//! its first start (`prepare_for_launch`); `machine create` makes none. Therefore:
//! - [`activate`] must finish before the pool's first start, while its disks do not exist.
//! - The activated templates stay in place through that start. A bound pool verifies them with
//!   [`verify_activated`] where an unbound pool uses `disk_template::verify_expanded`: before the
//!   start and after it, before disk adoption. The stock SmolVM pins refuse a base, and neither
//!   check may be skipped for the other.
//! - [`consume`] removes them only after the first start, once the caller has adopted the disks.
//!   A pool with adopted disks and an `activated` record calls [`consume`], not
//!   [`verify_activated`].
//! - [`recover`] rolls back an unconsumed activation only while the disks do not exist. After the
//!   first start the templates are the evidence the disks came from, so it refuses instead.
//!
//! Locking: every pool operation takes a [`PoolTarget`], which borrows the caller's held provider
//! operation lock for the pool root and is refused unless that lock's file is the root's
//! `operation.lock`. The caller must hold that same lock from activation through the first start,
//! disk verification and adoption, and consumption or recovery, as `lifecycle::up_selected` holds
//! it for a whole `up`; otherwise another operation could observe or change a half-finished
//! activation. The store has no pool lock: concurrent publications of one id are serialized by the
//! no-replace rename, and store retention (WU12) must not remove a base while a pool clones it.
//!
//! Crash consistency: the activation record is replaced by creating `prepared-base.json.pending`
//! exclusively, syncing it and renaming it over the record. Every write commits by that rename
//! before its caller continues, so a leftover pending file means that write never committed and
//! nothing after it happened: the committed record, or its absence, is authoritative. Records are
//! bound to their pool by the pool root's device and inode. The mutating operations reconcile a
//! leftover pending file first and remove it only when it is a private, singly linked regular file
//! owned by this user holding a complete, valid record for this pool that is associated with the
//! committed state: the first intent (`activating`, no clone identities) when nothing is
//! committed, or a later write of the committed activation (same activation, identities only
//! added, state not moved backwards). Anything else is kept and refused as
//! `prepared_base_recovery_required` for manual inspection. Limitation: a write torn by a crash
//! before its sync is such an ambiguous file, so it stops this pool's prepared-base operations
//! until someone inspects and removes it; the committed record stays authoritative meanwhile.
//!
//! Integrity comes only from content digests over actual bytes
//! (`disk_template::content_digest`): computed at publication on the staged clone, and again at
//! activation on the pool's private clone before it is renamed into place. Size, mode, owner,
//! link count and device/inode are ownership evidence, never integrity.
//!
//! Ownership: nothing unowned is adopted, repaired or removed. Publication stages under a fresh
//! nonce and renames the complete directory into place without replacement. Activation records
//! its intent, with a random nonce, before creating files; recovery removes only files at that
//! nonce's temporary paths or whose device and inode the record holds, and removes nothing when
//! any path is unproven. Files are opened without following links and without blocking, and are
//! checked to be regular before any read. Same-user processes that race these checks are out of
//! scope, as for `disk_template`.
use super::disk_template::{self, Check, Template};
use super::{Profile, artifact, network_tools, state};
use crate::CandidateError;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

/// Receipt schema written by [`publish`].
pub const RECEIPT_SCHEMA: &str = "hack.prepared-base/v1";
const ACTIVATION_SCHEMA: &str = "hack.prepared-base-activation/v1";
const PUBLISHED: &str = "published";
const RECEIPT: &str = "receipt.json";
const RECORD_LIMIT: u64 = 64 * 1024;
/// Template file names, in order: storage, then overlay.
pub const TEMPLATES: [&str; 2] = ["storage-template.ext4", "overlay-template.ext4"];
const GIB: u64 = 1024 * 1024 * 1024;
// Paths below a pool root (`run/smolvm` in the lifecycle).
const LOCK: &str = "operation.lock";
const RECORD: &str = "prepared-base.json";
const PENDING: &str = "prepared-base.json.pending";
const TEMPLATE_DIR: &str = "home/.smolvm";

fn error(code: &'static str, message: impl Into<String>) -> CandidateError {
    CandidateError::new(code, message)
}

/// A published base's receipt. Every field is required and unknown fields are refused.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Receipt {
    pub schema: String,
    pub base_id: String,
    pub state: String,
    pub pins: Pins,
    /// Owner of the guest network-tools receipt inside the base; see [`network_tools_owner`].
    pub network_tools_owner: String,
    /// In [`TEMPLATES`] order.
    pub templates: Vec<TemplateRecord>,
    pub sanitization: Sanitization,
}

/// Inputs a base is valid for. A pool binds only when every field equals its own.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Pins {
    pub smolvm_version: String,
    pub smolvm_archive_sha256: String,
    /// The pool's private agent rootfs digest: the overlay is an upper layer over exactly it.
    pub agent_rootfs_sha256: String,
    pub engine_version: String,
    pub engine_sha256: String,
    pub network_tools_identity: String,
    pub storage_gib: u32,
    pub overlay_gib: u32,
}

impl Pins {
    /// This candidate's pins for a pool with `profile` and agent rootfs digest `rootfs_digest`.
    pub fn current(profile: Profile, rootfs_digest: &str) -> Self {
        Self {
            smolvm_version: artifact::VERSION.into(),
            smolvm_archive_sha256: artifact::ARCHIVE_SHA256.into(),
            agent_rootfs_sha256: rootfs_digest.into(),
            engine_version: artifact::ENGINE_VERSION.into(),
            engine_sha256: artifact::ENGINE_SHA256.into(),
            network_tools_identity: network_tools::identity(),
            storage_gib: profile.storage_gib(),
            overlay_gib: profile.overlay_gib(),
        }
    }

    fn capacity_bytes(&self) -> [u64; 2] {
        [
            u64::from(self.storage_gib) * GIB,
            u64::from(self.overlay_gib) * GIB,
        ]
    }
}

/// Expected content of one published template.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TemplateRecord {
    pub name: String,
    pub logical_len: u64,
    pub content_sha256: String,
    /// Data-extent bytes the digest read at publication; bounds the read when a clone is verified.
    pub data_bytes: u64,
}

impl TemplateRecord {
    fn expected(&self) -> Template<'_> {
        Template {
            name: &self.name,
            logical_len: self.logical_len,
            content_sha256: &self.content_sha256,
        }
    }

    /// Read budget for verifying a clone. The budget bounds work; the digest is the integrity
    /// check. Extent reporting follows page-cache state as well as allocation: a dirty page is
    /// reported whole (16 KiB on Apple silicon, four 4 KiB digest blocks), so allow four times
    /// the published bytes plus a fixed margin, never more than the file.
    fn read_budget(&self) -> u64 {
        self.data_bytes
            .saturating_mul(4)
            .saturating_add(16 * 1024 * 1024)
            .min(self.logical_len)
    }
}

/// Publisher claims about the seed machine. They are required, but the host cannot verify
/// them without the seed builder's readback.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Sanitization {
    pub engine_id_removed: bool,
    pub owner_marker_absent: bool,
    pub credentials_absent: bool,
    pub containers: u32,
    pub volumes: u32,
}

impl Sanitization {
    /// The only accepted record.
    pub fn sanitized() -> Self {
        Self {
            engine_id_removed: true,
            owner_marker_absent: true,
            credentials_absent: true,
            containers: 0,
            volumes: 0,
        }
    }
}

/// Guest network-tools receipt owner for a pool: the base-scoped owner once a base is activated
/// (the seed installed the tools under it), otherwise the pool token.
pub fn network_tools_owner(activation: Option<&ActivationRecord>, token: &str) -> String {
    match activation {
        Some(record) if record.state != ActivationState::Activating => {
            base_network_tools_owner(&record.base_id)
        }
        _ => token.into(),
    }
}

fn base_network_tools_owner(base_id: &str) -> String {
    format!("prepared-base:{base_id}")
}

fn valid_base_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        && id.as_bytes()[0] != b'-'
}

fn hex(value: &str, len: usize) -> bool {
    value.len() == len
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

impl Receipt {
    fn validate(&self, base_id: &str) -> Result<(), CandidateError> {
        let invalid = |detail: &str| {
            error(
                "prepared_base_invalid",
                format!("Prepared base {base_id} receipt {detail}."),
            )
        };
        if self.schema != RECEIPT_SCHEMA {
            return Err(invalid("has an unsupported schema"));
        }
        if self.state != PUBLISHED {
            return Err(invalid("is not published"));
        }
        if self.base_id != base_id || !valid_base_id(base_id) {
            return Err(invalid("names a different base"));
        }
        let pins = &self.pins;
        if !hex(&pins.smolvm_archive_sha256, 64)
            || !hex(&pins.agent_rootfs_sha256, 64)
            || !hex(&pins.engine_sha256, 64)
            || !hex(&pins.network_tools_identity, 64)
            || pins.storage_gib == 0
            || pins.overlay_gib == 0
        {
            return Err(invalid("has malformed pins"));
        }
        if self.network_tools_owner != base_network_tools_owner(base_id) {
            return Err(invalid("names a different network-tools owner"));
        }
        if self.templates.len() != TEMPLATES.len()
            || self
                .templates
                .iter()
                .zip(TEMPLATES)
                .zip(pins.capacity_bytes())
                .any(|((record, name), capacity)| {
                    record.name != name
                        || record.logical_len != capacity
                        || !hex(&record.content_sha256, 64)
                        || record.data_bytes > record.logical_len
                })
        {
            return Err(invalid(
                "does not describe both templates at the pinned capacity",
            ));
        }
        if self.sanitization != Sanitization::sanitized() {
            return Err(invalid("does not record a sanitized seed"));
        }
        Ok(())
    }
}

/// A published base whose store layout, ownership and receipt were checked. Content is verified
/// on each pool's private clone by [`activate`].
#[derive(Debug)]
pub struct PublishedBase {
    dir: PathBuf,
    pub receipt: Receipt,
    /// SHA-256 of the receipt bytes, recorded by each activation.
    pub receipt_sha256: String,
}

impl PublishedBase {
    /// Refuse unless the base was built for exactly this pool's capacity and pins.
    pub fn bind(&self, pool: &Pins) -> Result<(), CandidateError> {
        let base = &self.receipt.pins;
        if base.storage_gib != pool.storage_gib || base.overlay_gib != pool.overlay_gib {
            return Err(error(
                "prepared_base_capacity",
                format!(
                    "Prepared base {} is {}/{} GiB; this pool needs {}/{} GiB.",
                    self.receipt.base_id,
                    base.storage_gib,
                    base.overlay_gib,
                    pool.storage_gib,
                    pool.overlay_gib
                ),
            ));
        }
        let fields = [
            ("SmolVM version", &base.smolvm_version, &pool.smolvm_version),
            (
                "SmolVM archive",
                &base.smolvm_archive_sha256,
                &pool.smolvm_archive_sha256,
            ),
            (
                "agent rootfs",
                &base.agent_rootfs_sha256,
                &pool.agent_rootfs_sha256,
            ),
            ("engine version", &base.engine_version, &pool.engine_version),
            ("engine archive", &base.engine_sha256, &pool.engine_sha256),
            (
                "network tools",
                &base.network_tools_identity,
                &pool.network_tools_identity,
            ),
        ];
        if let Some((name, _, _)) = fields.iter().find(|(_, base, pool)| base != pool) {
            return Err(error(
                "prepared_base_pin_mismatch",
                format!(
                    "Prepared base {} was built for a different {name}.",
                    self.receipt.base_id
                ),
            ));
        }
        Ok(())
    }
}

/// Inputs to [`publish`].
pub struct PublishRequest<'a> {
    pub base_id: &'a str,
    pub pins: Pins,
    /// The stopped seed machine's disks, in [`TEMPLATES`] order: storage, then overlay.
    pub sources: [&'a Path; 2],
    pub sanitization: Sanitization,
}

/// Publish a base into `store` (an absolute, private, user-owned directory on the same APFS
/// volume as the sources and the pools that will use it).
///
/// Staging happens in `<store>/.staging-<nonce>`, which readers never consult. Each template is
/// cloned, made read-only, digested and synced; the receipt is written last and synced; then the
/// complete directory is renamed to `<store>/<base_id>` without replacing anything. An error
/// before that rename removes this call's staging directory; a crash leaves it invisible.
pub fn publish(store: &Path, request: &PublishRequest<'_>) -> Result<Receipt, CandidateError> {
    let base_id = request.base_id;
    if !valid_base_id(base_id) {
        return Err(error(
            "prepared_base_invalid",
            "A base id is 1-64 lowercase letters, digits or hyphens and cannot start with a hyphen.",
        ));
    }
    open_store(store)?;
    let target = store.join(base_id);
    if exists(&target)? {
        return Err(error(
            "prepared_base_exists",
            format!("Prepared base {base_id} already exists; it was not changed."),
        ));
    }
    let staging = store.join(format!(".staging-{}", random_hex()?));
    fs::DirBuilder::new()
        .mode(0o700)
        .create(&staging)
        .map_err(state::io)?;
    let published = stage(&staging, request).and_then(|receipt| {
        rename_new(&staging, &target).map_err(|failure| {
            if failure.raw_os_error() == Some(libc::EEXIST) {
                error(
                    "prepared_base_exists",
                    format!(
                        "Prepared base {base_id} was published concurrently; it was not changed."
                    ),
                )
            } else {
                state::io(failure)
            }
        })?;
        Ok(receipt)
    });
    match published {
        Ok(receipt) => {
            sync_dir(store)?;
            Ok(receipt)
        }
        Err(failure) => {
            // This call created the staging directory exclusively, so it owns everything in it.
            let _ = fs::remove_dir_all(&staging);
            Err(failure)
        }
    }
}

fn stage(staging: &Path, request: &PublishRequest<'_>) -> Result<Receipt, CandidateError> {
    if request.sanitization != Sanitization::sanitized() {
        return Err(error(
            "prepared_base_invalid",
            "A base is published only from a sanitized seed.",
        ));
    }
    let mut templates = Vec::with_capacity(TEMPLATES.len());
    for ((name, source), capacity) in TEMPLATES
        .iter()
        .zip(request.sources)
        .zip(request.pins.capacity_bytes())
    {
        let seed = fs::symlink_metadata(source).map_err(state::io)?;
        // SAFETY: geteuid has no preconditions and cannot fail.
        if !seed.is_file()
            || seed.nlink() != 1
            || seed.uid() != unsafe { libc::geteuid() }
            || seed.len() != capacity
        {
            return Err(error(
                "prepared_base_invalid",
                format!(
                    "Seed disk for {name} must be a private, singly linked file at the pinned capacity."
                ),
            ));
        }
        let staged = staging.join(name);
        clone_file(source, &staged)?;
        let file = open_regular(&staged)?;
        file.set_permissions(fs::Permissions::from_mode(0o400))
            .map_err(state::io)?;
        let digest =
            disk_template::content_digest(&file, capacity, capacity)?.ok_or_else(|| {
                error(
                    "prepared_base_digest",
                    "Staged template digest did not complete.",
                )
            })?;
        file.sync_all().map_err(state::io)?;
        templates.push(TemplateRecord {
            name: (*name).into(),
            logical_len: capacity,
            content_sha256: digest.sha256,
            data_bytes: digest.read,
        });
    }
    let receipt = Receipt {
        schema: RECEIPT_SCHEMA.into(),
        base_id: request.base_id.into(),
        state: PUBLISHED.into(),
        pins: request.pins.clone(),
        network_tools_owner: base_network_tools_owner(request.base_id),
        templates,
        sanitization: request.sanitization.clone(),
    };
    receipt.validate(request.base_id)?;
    let bytes = serde_json::to_vec_pretty(&receipt)
        .map_err(|failure| error("prepared_base_invalid", failure.to_string()))?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o400)
        .custom_flags(libc::O_NOFOLLOW)
        .open(staging.join(RECEIPT))
        .map_err(state::io)?;
    file.write_all(&bytes).map_err(state::io)?;
    file.sync_all().map_err(state::io)?;
    sync_dir(staging)?;
    Ok(receipt)
}

/// Open a published base, checking the store, directory layout, ownership and receipt. Template
/// content is not read here; [`activate`] verifies the pool's private clone.
pub fn open_published(store: &Path, base_id: &str) -> Result<PublishedBase, CandidateError> {
    if !valid_base_id(base_id) {
        return Err(error("prepared_base_invalid", "Invalid prepared base id."));
    }
    open_store(store)?;
    let dir = store.join(base_id);
    match fs::symlink_metadata(&dir) {
        Err(failure) if failure.kind() == std::io::ErrorKind::NotFound => {
            return Err(error(
                "prepared_base_missing",
                format!("Prepared base {base_id} is not published."),
            ));
        }
        Err(failure) => return Err(state::io(failure)),
        Ok(metadata) if !metadata.is_dir() => {
            return Err(ownership(base_id, "is not a directory"));
        }
        Ok(_) => {}
    }
    state::check_private_directory(&dir).map_err(|_| ownership(base_id, "is not private"))?;
    let mut entries = fs::read_dir(&dir)
        .map_err(state::io)?
        .map(|entry| entry.map(|entry| entry.file_name()))
        .collect::<Result<Vec<_>, _>>()
        .map_err(state::io)?;
    entries.sort();
    let mut expected: Vec<std::ffi::OsString> =
        TEMPLATES.iter().chain([&RECEIPT]).map(Into::into).collect();
    expected.sort();
    if entries != expected {
        return Err(error(
            "prepared_base_incomplete",
            format!("Prepared base {base_id} does not hold exactly its receipt and two templates."),
        ));
    }
    let bytes = read_private(&dir.join(RECEIPT), RECORD_LIMIT)
        .map_err(|_| ownership(base_id, "has an unsafe receipt"))?;
    let receipt: Receipt = serde_json::from_slice(&bytes).map_err(|_| {
        error(
            "prepared_base_invalid",
            format!("Prepared base {base_id} receipt does not match {RECEIPT_SCHEMA}."),
        )
    })?;
    receipt.validate(base_id)?;
    for record in &receipt.templates {
        let metadata = fs::symlink_metadata(dir.join(&record.name)).map_err(state::io)?;
        // SAFETY: geteuid has no preconditions and cannot fail.
        if !metadata.is_file()
            || metadata.nlink() != 1
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.mode() & 0o077 != 0
            || metadata.len() != record.logical_len
        {
            return Err(ownership(base_id, "has an unsafe or resized template"));
        }
    }
    Ok(PublishedBase {
        dir,
        receipt,
        receipt_sha256: format!("{:x}", Sha256::digest(&bytes)),
    })
}

fn ownership(base_id: &str, detail: &str) -> CandidateError {
    error(
        "prepared_base_ownership",
        format!("Prepared base {base_id} {detail}; it was not used or changed."),
    )
}

/// A pool under its caller's held provider operation lock; see the module's locking contract.
pub struct PoolTarget<'a> {
    /// Provider state root (`run/smolvm`): `operation.lock`, the activation record, and the
    /// provider `$HOME` whose `.smolvm` SmolVM searches for plain templates.
    root: &'a Path,
    lock: &'a state::Lock,
    /// The machine's `storage.raw` and `overlay.raw`; absent until its first start.
    disks: [&'a Path; 2],
}

impl<'a> PoolTarget<'a> {
    /// A target for the pool at `root`, refused unless `lock` is that root's held operation lock.
    /// The borrow keeps the lock held for as long as the target exists.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "lifecycle constructs targets once prepared-base activation is wired"
        )
    )]
    pub(crate) fn new(
        root: &'a Path,
        lock: &'a state::Lock,
        disks: [&'a Path; 2],
    ) -> Result<Self, CandidateError> {
        let target = Self { root, lock, disks };
        target.held()?;
        Ok(target)
    }
}

impl PoolTarget<'_> {
    /// Recheck, at every operation, that the lock is still this pool's and its directories are
    /// private.
    fn held(&self) -> Result<(), CandidateError> {
        state::check_private_directory(self.root)?;
        state::check_private_directory(&self.templates())?;
        if identity_of(&self.root.join(LOCK))? != Some(self.lock.identity()?) {
            return Err(error(
                "prepared_base_lock_required",
                "Prepared-base pool operations need this pool's held provider operation lock.",
            ));
        }
        Ok(())
    }

    fn templates(&self) -> PathBuf {
        self.root.join(TEMPLATE_DIR)
    }

    fn record(&self) -> PathBuf {
        self.root.join(RECORD)
    }

    fn pending(&self) -> PathBuf {
        self.root.join(PENDING)
    }

    fn temporary(&self, nonce: &str, name: &str) -> PathBuf {
        self.templates().join(format!(".prepared-{nonce}-{name}"))
    }

    fn first_start_happened(&self) -> Result<bool, CandidateError> {
        for disk in self.disks {
            if exists(disk)? {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// Device and inode of the pool root, which bind activation records to this pool.
    fn identity(&self) -> Result<(u64, u64), CandidateError> {
        identity_of(self.root)?
            .ok_or_else(|| error("prepared_base_invalid", "The pool root is missing."))
    }
}

/// Where an activation stands, in the only order its writes advance.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ActivationState {
    /// Intent recorded; clones may exist at the nonce's temporary paths.
    Activating,
    /// Verified clones are in place as the pool's plain templates.
    Activated,
    /// The activated templates were removed after the first start.
    Consumed,
}

/// A pool's durable activation record, written before any file is created.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActivationRecord {
    pub schema: String,
    pub base_id: String,
    pub receipt_sha256: String,
    /// Random; names this activation's temporary files.
    pub nonce: String,
    pub state: ActivationState,
    /// Copied from the receipt, so verification does not depend on the store.
    pub templates: Vec<TemplateRecord>,
    /// Device and inode of each clone, recorded before it is renamed into place.
    pub clones: Vec<Option<(u64, u64)>>,
    /// Device and inode of the pool root this record belongs to.
    pub pool: (u64, u64),
}

impl ActivationRecord {
    /// The committed record, if any. An uncommitted pending write is not consulted.
    fn load(target: &PoolTarget<'_>) -> Result<Option<Self>, CandidateError> {
        let path = target.record();
        if !exists(&path)? {
            return Ok(None);
        }
        let record: Self =
            serde_json::from_slice(&read_private(&path, RECORD_LIMIT)?).map_err(|_| malformed())?;
        if !record.valid_for(target)? {
            return Err(malformed());
        }
        Ok(Some(record))
    }

    /// Whether every field is well formed and the record belongs to `target`'s pool.
    fn valid_for(&self, target: &PoolTarget<'_>) -> Result<bool, CandidateError> {
        Ok(self.schema == ACTIVATION_SCHEMA
            && valid_base_id(&self.base_id)
            && hex(&self.receipt_sha256, 64)
            && hex(&self.nonce, 32)
            && self.clones.len() == TEMPLATES.len()
            && self.templates.len() == TEMPLATES.len()
            && self
                .templates
                .iter()
                .zip(TEMPLATES)
                .all(|(template, name)| template.name == name)
            && self.pool == target.identity()?)
    }

    /// Whether `self`, an uncommitted write, can follow `committed`: the same activation, clone
    /// identities only added, and the state not moved backwards.
    fn continues(&self, committed: &Self) -> bool {
        self.base_id == committed.base_id
            && self.receipt_sha256 == committed.receipt_sha256
            && self.nonce == committed.nonce
            && self.templates == committed.templates
            && self.pool == committed.pool
            && self.state >= committed.state
            && committed
                .clones
                .iter()
                .zip(&self.clones)
                .all(|(before, after)| before.is_none() || before == after)
    }
}

fn malformed() -> CandidateError {
    error(
        "prepared_base_invalid",
        "Prepared-base activation record is malformed or belongs to another pool; nothing was changed.",
    )
}

/// Replace the committed record: stage the pending file, then commit it.
fn write_record(target: &PoolTarget<'_>, record: &ActivationRecord) -> Result<(), CandidateError> {
    stage_record(target, record)?;
    commit_record(target)
}

/// Create the pending file exclusively and sync it. On failure this call removes the file it
/// created; a crash leaves it for [`reconcile_pending`].
fn stage_record(target: &PoolTarget<'_>, record: &ActivationRecord) -> Result<(), CandidateError> {
    let bytes = serde_json::to_vec_pretty(record)
        .map_err(|failure| error("prepared_base_invalid", failure.to_string()))?;
    let pending = target.pending();
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&pending)
        .map_err(state::io)?;
    if let Err(failure) = file.write_all(&bytes).and_then(|()| file.sync_all()) {
        let _ = fs::remove_file(&pending);
        return Err(state::io(failure));
    }
    Ok(())
}

/// Rename the staged pending file over the record and sync the pool root.
fn commit_record(target: &PoolTarget<'_>) -> Result<(), CandidateError> {
    let pending = target.pending();
    if let Err(failure) = fs::rename(&pending, target.record()) {
        let _ = fs::remove_file(&pending);
        return Err(state::io(failure));
    }
    sync_dir(target.root)
}

/// Remove a pending record write left by a crash when it is a validated write associated with
/// this pool's committed state; keep and refuse anything else (see the module's crash-consistency
/// contract). Returns whether one was removed.
fn reconcile_pending(target: &PoolTarget<'_>) -> Result<bool, CandidateError> {
    let pending = target.pending();
    if !exists(&pending)? {
        return Ok(false);
    }
    let bytes = read_private(&pending, RECORD_LIMIT).map_err(|_| {
        error(
            "foreign_state",
            format!(
                "{} is not a private regular file of this user; it was not removed.",
                pending.display()
            ),
        )
    })?;
    let kept = |detail: &str| {
        error(
            "prepared_base_recovery_required",
            format!(
                "{} {detail}; it was kept for manual inspection.",
                pending.display()
            ),
        )
    };
    let staged: ActivationRecord = serde_json::from_slice(&bytes)
        .map_err(|_| kept("is not a complete activation record, possibly a torn write"))?;
    if !staged.valid_for(target)? {
        return Err(kept("is not a valid activation record for this pool"));
    }
    let associated = match ActivationRecord::load(target)? {
        None => {
            staged.state == ActivationState::Activating && staged.clones.iter().all(Option::is_none)
        }
        Some(committed) => staged.continues(&committed),
    };
    if !associated {
        return Err(kept("does not continue this pool's committed activation"));
    }
    fs::remove_file(&pending).map_err(state::io)?;
    sync_dir(target.root)?;
    Ok(true)
}

/// Activate `base` for a fresh pool: bind its pins and capacity, then clone each template to a
/// nonce-named temporary file, verify the clone's content against the receipt, and rename it into
/// place as the pool's plain template without replacing anything.
///
/// Fresh means no activation record, no machine disks (the first start has not happened) and no
/// plain template of any origin; any of those refuses without changes. An error after the record
/// is written rolls back this activation's own files; if that also fails the record remains for
/// [`recover`].
pub fn activate(
    base: &PublishedBase,
    pool: &Pins,
    target: &PoolTarget<'_>,
) -> Result<ActivationRecord, CandidateError> {
    target.held()?;
    base.bind(pool)?;
    reconcile_pending(target)?;
    if exists(&target.record())? {
        return Err(error(
            "prepared_base_recovery_required",
            "This pool already has a prepared-base activation; recover or consume it first.",
        ));
    }
    if target.first_start_happened()? {
        return Err(error(
            "prepared_base_not_fresh",
            "This pool's disks already exist, so its first start has formatted them; a base can only seed a fresh pool.",
        ));
    }
    for name in TEMPLATES {
        if exists(&target.templates().join(name))? {
            return Err(error(
                "foreign_state",
                format!("An unowned {name} is already present; it was not adopted or changed."),
            ));
        }
    }
    let mut record = ActivationRecord {
        schema: ACTIVATION_SCHEMA.into(),
        base_id: base.receipt.base_id.clone(),
        receipt_sha256: base.receipt_sha256.clone(),
        nonce: random_hex()?,
        state: ActivationState::Activating,
        templates: base.receipt.templates.clone(),
        clones: vec![None; TEMPLATES.len()],
        pool: target.identity()?,
    };
    write_record(target, &record)?;
    match place(base, target, &mut record) {
        Ok(()) => Ok(record),
        Err(failure) => match rollback(target, &record) {
            Ok(()) => Err(failure),
            Err(_) => Err(error(
                "prepared_base_recovery_required",
                format!(
                    "{} Rolling back the activation also failed; its record was kept for recovery.",
                    failure.message
                ),
            )),
        },
    }
}

fn place(
    base: &PublishedBase,
    target: &PoolTarget<'_>,
    record: &mut ActivationRecord,
) -> Result<(), CandidateError> {
    for (index, template) in base.receipt.templates.iter().enumerate() {
        let temporary = target.temporary(&record.nonce, &template.name);
        clone_file(&base.dir.join(&template.name), &temporary)?;
        let file = open_regular(&temporary)?;
        let metadata = file.metadata().map_err(state::io)?;
        record.clones[index] = Some((metadata.dev(), metadata.ino()));
        write_record(target, record)?;
        // SmolVM clones the template's mode into the machine disk, which must stay writable.
        file.set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(state::io)?;
        check_clone(&temporary, template, record.clones[index])?;
    }
    for template in &base.receipt.templates {
        rename_new(
            &target.temporary(&record.nonce, &template.name),
            &target.templates().join(&template.name),
        )
        .map_err(|failure| {
            if failure.raw_os_error() == Some(libc::EEXIST) {
                error(
                    "foreign_state",
                    format!(
                        "An unowned {} appeared during activation; it was not replaced.",
                        template.name
                    ),
                )
            } else {
                state::io(failure)
            }
        })?;
    }
    sync_dir(&target.templates())?;
    record.state = ActivationState::Activated;
    write_record(target, record)
}

/// Verify one owned clone: its content against the receipt digest, within a read budget derived
/// from publication, and its identity against the activation record.
fn check_clone(
    path: &Path,
    template: &TemplateRecord,
    identity: Option<(u64, u64)>,
) -> Result<(), CandidateError> {
    let digest = |detail: &str| {
        error(
            "prepared_base_digest",
            format!(
                "Activated template {} {detail}; the pool must not use it.",
                template.name
            ),
        )
    };
    match disk_template::check_file(path, &template.expected(), template.read_budget())? {
        Check::Verified => {}
        Check::Missing => return Err(digest("is missing")),
        Check::Refused(reason) => return Err(digest(reason)),
    }
    if identity_of(path)? != identity {
        return Err(digest("is not the clone this activation recorded"));
    }
    Ok(())
}

/// Verify an activated pool's plain templates: each must be the recorded clone with the
/// receipt's content. A bound pool runs this before its first start and after it, before disk
/// adoption, where an unbound pool runs `disk_template::verify_expanded`. Read-only.
pub fn verify_activated(target: &PoolTarget<'_>) -> Result<ActivationRecord, CandidateError> {
    target.held()?;
    let record = ActivationRecord::load(target)?.ok_or_else(|| {
        error(
            "prepared_base_missing",
            "This pool has no prepared-base activation.",
        )
    })?;
    if record.state != ActivationState::Activated {
        return Err(error(
            "prepared_base_recovery_required",
            "Prepared-base activation is not complete and in place.",
        ));
    }
    for (template, identity) in record.templates.iter().zip(&record.clones) {
        check_clone(
            &target.templates().join(&template.name),
            template,
            *identity,
        )?;
    }
    Ok(record)
}

/// After the pool's first start, once the caller has verified and adopted its disks, remove the
/// activated templates so no later start can reuse them. Only files with the recorded identity
/// are removed; already removed ones (an interrupted consumption) are skipped. The record remains
/// as `consumed` for the pool's lifetime.
pub fn consume(target: &PoolTarget<'_>) -> Result<(), CandidateError> {
    target.held()?;
    reconcile_pending(target)?;
    let Some(mut record) = ActivationRecord::load(target)? else {
        return Err(error(
            "prepared_base_missing",
            "This pool has no prepared-base activation.",
        ));
    };
    match record.state {
        ActivationState::Consumed => return Ok(()),
        ActivationState::Activating => {
            return Err(error(
                "prepared_base_recovery_required",
                "Prepared-base activation did not complete; recover it instead.",
            ));
        }
        ActivationState::Activated => {}
    }
    if !target.first_start_happened()? {
        return Err(error(
            "prepared_base_recovery_required",
            "The pool has not started from the activated templates yet; they were kept.",
        ));
    }
    let mut owned = Vec::new();
    for (template, identity) in record.templates.iter().zip(&record.clones) {
        let path = target.templates().join(&template.name);
        match identity_of(&path)? {
            None => {}
            Some(found) if Some(found) == *identity => owned.push(path),
            Some(_) => {
                return Err(error(
                    "foreign_state",
                    format!(
                        "{} is not the activated clone; nothing was removed.",
                        template.name
                    ),
                ));
            }
        }
    }
    for path in owned {
        fs::remove_file(path).map_err(state::io)?;
    }
    sync_dir(&target.templates())?;
    record.state = ActivationState::Consumed;
    write_record(target, &record)
}

/// What [`recover`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Recovery {
    /// No unconsumed activation (after removing any interrupted record write).
    Nothing,
    /// This activation's files and record were removed; the pool is fresh again.
    RolledBack,
}

/// Roll back an unconsumed activation before the pool's first start. Every path is proven owned
/// first (the nonce's temporary paths, or the recorded device and inode); if any is not, nothing
/// is removed. After the first start the activated templates are the evidence the disks came
/// from, so this refuses and leaves them for [`verify_activated`].
pub fn recover(target: &PoolTarget<'_>) -> Result<Recovery, CandidateError> {
    target.held()?;
    reconcile_pending(target)?;
    let Some(record) = ActivationRecord::load(target)? else {
        return Ok(Recovery::Nothing);
    };
    if record.state == ActivationState::Consumed {
        return Ok(Recovery::Nothing);
    }
    if target.first_start_happened()? {
        return Err(error(
            "prepared_base_recovery_required",
            "The pool's disks were formatted from the activated templates; verify them before adoption or recover the failed boot manually. Nothing was removed.",
        ));
    }
    rollback(target, &record)?;
    Ok(Recovery::RolledBack)
}

fn rollback(target: &PoolTarget<'_>, record: &ActivationRecord) -> Result<(), CandidateError> {
    let mut owned = Vec::new();
    for (template, identity) in record.templates.iter().zip(&record.clones) {
        let temporary = target.temporary(&record.nonce, &template.name);
        if let Some(found) = identity_of(&temporary)? {
            // The nonce-named path proves this activation created it; a recorded identity must
            // also match.
            if identity.is_some_and(|recorded| recorded != found) || !owned_file(&temporary)? {
                return Err(unproven(&temporary));
            }
            owned.push(temporary);
        }
        let placed = target.templates().join(&template.name);
        if let Some(found) = identity_of(&placed)? {
            // A plain template is this activation's only if it is the recorded clone.
            if *identity != Some(found) {
                return Err(unproven(&placed));
            }
            owned.push(placed);
        }
    }
    for path in owned {
        fs::remove_file(path).map_err(state::io)?;
    }
    sync_dir(&target.templates())?;
    fs::remove_file(target.record()).map_err(state::io)?;
    sync_dir(target.root)
}

fn unproven(path: &Path) -> CandidateError {
    error(
        "foreign_state",
        format!(
            "{} is not provably owned by this activation; nothing was removed.",
            path.display()
        ),
    )
}

fn owned_file(path: &Path) -> Result<bool, CandidateError> {
    let metadata = fs::symlink_metadata(path).map_err(state::io)?;
    // SAFETY: geteuid has no preconditions and cannot fail.
    Ok(metadata.is_file() && metadata.nlink() == 1 && metadata.uid() == unsafe { libc::geteuid() })
}

fn open_store(store: &Path) -> Result<(), CandidateError> {
    if !store.is_absolute() {
        return Err(error(
            "prepared_base_invalid",
            "The prepared-base store must be an explicit absolute path.",
        ));
    }
    crate::reject_aliased_state(store)?;
    state::check_private_directory(store)
}

fn exists(path: &Path) -> Result<bool, CandidateError> {
    Ok(identity_of(path)?.is_some())
}

fn identity_of(path: &Path) -> Result<Option<(u64, u64)>, CandidateError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => Ok(Some((metadata.dev(), metadata.ino()))),
        Err(failure) if failure.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(failure) => Err(state::io(failure)),
    }
}

/// Open for reading without following a link or blocking (a FIFO or device cannot stall the
/// open), and refuse anything but a regular file before any read.
fn open_regular(path: &Path) -> Result<File, CandidateError> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(state::io)?;
    if !file.metadata().map_err(state::io)?.is_file() {
        return Err(error(
            "foreign_state",
            format!("{} is not a regular file.", path.display()),
        ));
    }
    Ok(file)
}

/// Read a private, singly linked regular file owned by this user, up to `limit` bytes.
fn read_private(path: &Path, limit: u64) -> Result<Vec<u8>, CandidateError> {
    let mut file = open_regular(path)?;
    let metadata = file.metadata().map_err(state::io)?;
    // SAFETY: geteuid has no preconditions and cannot fail.
    if metadata.nlink() != 1
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o077 != 0
        || metadata.len() > limit
    {
        return Err(error("foreign_state", "Unsafe or oversized private file."));
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(state::io)?;
    if bytes.len() as u64 > limit {
        return Err(error(
            "foreign_state",
            "Private file grew beyond its limit.",
        ));
    }
    Ok(bytes)
}

fn sync_dir(path: &Path) -> Result<(), CandidateError> {
    File::open(path)
        .and_then(|dir| dir.sync_all())
        .map_err(state::io)
}

fn random_hex() -> Result<String, CandidateError> {
    let mut bytes = [0_u8; 16];
    File::open("/dev/urandom")
        .and_then(|mut random| random.read_exact(&mut bytes))
        .map_err(state::io)?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[cfg(target_os = "macos")]
fn c_path(path: &Path) -> Result<std::ffi::CString, CandidateError> {
    use std::os::unix::ffi::OsStrExt;
    std::ffi::CString::new(path.as_os_str().as_bytes())
        .map_err(|_| error("prepared_base_invalid", "Path contains a NUL byte."))
}

/// APFS copy-on-write clone of a regular file, never following a symlink at `source` and never
/// replacing `destination`.
#[cfg(target_os = "macos")]
fn clone_file(source: &Path, destination: &Path) -> Result<(), CandidateError> {
    /// `CLONE_NOFOLLOW` from `<sys/clonefile.h>`.
    const CLONE_NOFOLLOW: u32 = 0x0001;
    let (source, destination) = (c_path(source)?, c_path(destination)?);
    // SAFETY: both pointers are valid NUL-terminated strings for the duration of the call, and
    // clonefile retains neither.
    if unsafe { libc::clonefile(source.as_ptr(), destination.as_ptr(), CLONE_NOFOLLOW) } == 0 {
        return Ok(());
    }
    let failure = std::io::Error::last_os_error();
    Err(match failure.raw_os_error() {
        Some(libc::EXDEV | libc::ENOTSUP) => error(
            "prepared_base_unsupported",
            "Prepared bases need the store and the pool on the same APFS volume.",
        ),
        _ => state::io(failure),
    })
}

#[cfg(not(target_os = "macos"))]
fn clone_file(_source: &Path, _destination: &Path) -> Result<(), CandidateError> {
    Err(error(
        "prepared_base_unsupported",
        "Prepared bases are implemented for macOS APFS only.",
    ))
}

/// Rename that fails with `EEXIST` instead of replacing an existing destination.
#[cfg(target_os = "macos")]
fn rename_new(source: &Path, destination: &Path) -> std::io::Result<()> {
    let to_io = |_| std::io::Error::from_raw_os_error(libc::EINVAL);
    let source = c_path(source).map_err(to_io)?;
    let destination = c_path(destination).map_err(to_io)?;
    // SAFETY: both pointers are valid NUL-terminated strings for the duration of the call, and
    // renamex_np retains neither.
    if unsafe { libc::renamex_np(source.as_ptr(), destination.as_ptr(), libc::RENAME_EXCL) } == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(not(target_os = "macos"))]
fn rename_new(_source: &Path, _destination: &Path) -> std::io::Result<()> {
    Err(std::io::Error::from_raw_os_error(libc::ENOTSUP))
}

#[cfg(test)]
mod tests;
