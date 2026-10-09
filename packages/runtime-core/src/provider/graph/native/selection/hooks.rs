//! Private frontend hook-owner admission. No command or value crosses this wire.
use super::*;
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Pin {
    path: PathBuf,
    dev: u64,
    ino: u64,
    sha256: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    version: u32,
    kind: String,
    role: String,
    run: String,
    project: PathBuf,
    branch: Option<String>,
    semantic_hash: String,
    owner: Pin,
    pid: u32,
    uid: u32,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Owner {
    version: u32,
    kind: String,
    run: String,
    project: PathBuf,
    branch: Option<String>,
    selection: String,
    pid: u32,
    uid: u32,
}
#[derive(Clone)]
pub(super) struct Permit {
    pin: Pin,
    owner: Pin,
    parent: PathBuf,
    parent_content: Content,
    pin_snapshot: Document,
    owner_snapshot: Document,
    semantic: String,
    pid: u32,
}
fn uid() -> u32 {
    // SAFETY: getuid takes no pointers and returns the caller's kernel-owned identity.
    unsafe { libc::getuid() }
}
fn parent_pid() -> u32 {
    // SAFETY: getppid takes no pointers and returns the caller's kernel-owned parent PID.
    (unsafe { libc::getppid() }) as u32
}
fn private(path: &Path, pin: &Pin) -> Result<(Document, String), CandidateError> {
    let observed = fs::symlink_metadata(path).map_err(|_| refused())?;
    if path != pin.path
        || observed.uid() != uid()
        || observed.mode() & 0o777 != 0o600
        || observed.len() > 8192
    {
        return Err(refused());
    }
    let (snapshot, text) = document(path, true)?;
    let snapshot = snapshot.ok_or_else(refused)?;
    if snapshot.content != Content::of(&observed)
        || fs::symlink_metadata(path).map_err(|_| refused())?.uid() != uid()
        || snapshot.content.identity.device != pin.dev
        || snapshot.content.identity.inode != pin.ino
        || format!(
            "{:x}",
            Sha256::digest(text.as_ref().ok_or_else(refused)?.as_bytes())
        ) != pin.sha256
    {
        return Err(refused());
    }
    Ok((snapshot, text.ok_or_else(refused)?))
}
impl Permit {
    pub(super) fn read(
        source: &Path,
        source_input: &SourceInput,
        execution: bool,
    ) -> Result<Self, CandidateError> {
        let pin = source_input.hook_permit.clone().ok_or_else(refused)?;
        let parent = source_input
            .project
            .join(".hack/.internal/native-authored-runs");
        directory(&parent)?;
        let parent_meta = fs::symlink_metadata(&parent).map_err(|_| refused())?;
        if parent_meta.uid() != uid()
            || parent_meta.mode() & 0o777 != 0o700
            || source != parent.join(format!("{}.source.json", source_input.run))
            || pin.path
                != parent.join(format!(
                    "{}.hook-{}-permit.json",
                    source_input.run,
                    if execution
                        || pin.path.file_name().is_some_and(|name| name
                            .to_string_lossy()
                            .ends_with(".hook-execution-permit.json"))
                    {
                        "execution"
                    } else {
                        "preflight"
                    }
                ))
        {
            return Err(refused());
        }
        let source_meta = fs::symlink_metadata(source).map_err(|_| refused())?;
        if !source_meta.is_file()
            || source_meta.uid() != uid()
            || source_meta.mode() & 0o777 != 0o600
            || source_meta.nlink() != 1
        {
            return Err(refused());
        }
        let (pin_snapshot, text) = private(&pin.path, &pin)?;
        let input: Input = serde_json::from_str(&text).map_err(|_| refused())?;
        let branch = serde_json::to_vec(&source_input.branch).map_err(|_| refused())?;
        let key = format!("{:x}", Sha256::digest(&branch));
        if input.version != 1
            || input.kind != "native-authored-finite-hook-permit"
            || (if execution {
                input.role != "execution"
            } else {
                !["preflight", "execution"].contains(&input.role.as_str())
            })
            || pin.path
                != parent.join(format!(
                    "{}.hook-{}-permit.json",
                    source_input.run, input.role
                ))
            || input.run != source_input.run
            || input.project != source_input.project
            || input.branch != source_input.branch
            || !super::super::hex(&input.semantic_hash, 64)
            || input.uid != uid()
            || input.pid != parent_pid()
            || input.owner.path != parent.join(format!("{key}.hooks.json"))
        {
            return Err(refused());
        }
        let (owner_snapshot, text) = private(&input.owner.path, &input.owner)?;
        let owner: Owner = serde_json::from_str(&text).map_err(|_| refused())?;
        if owner.version != 1
            || owner.kind != "native-authored-hook-owner"
            || owner.run != input.run
            || owner.project != input.project
            || owner.branch != input.branch
            || owner.pid != input.pid
            || owner.uid != input.uid
            || !super::super::hex(&owner.selection, 64)
        {
            return Err(refused());
        }
        let permit = Self {
            pin,
            owner: input.owner,
            parent,
            parent_content: Content::of(&parent_meta),
            pin_snapshot,
            owner_snapshot,
            semantic: input.semantic_hash,
            pid: input.pid,
        };
        permit.verify()?;
        Ok(permit)
    }
    pub(super) fn verify(&self) -> Result<(), CandidateError> {
        // Directory children legitimately accumulate. Its identity/owner/mode, not mtime, is stable.
        directory(&self.parent)?;
        let current = fs::symlink_metadata(&self.parent).map_err(|_| refused())?;
        if Identity::of(&current) != self.parent_content.identity
            || current.uid() != uid()
            || current.mode() != self.parent_content.mode
            || parent_pid() != self.pid
        {
            return Err(refused());
        }
        if private(&self.pin.path, &self.pin)?.0 != self.pin_snapshot
            || private(&self.owner.path, &self.owner)?.0 != self.owner_snapshot
        {
            return Err(refused());
        }
        Ok(())
    }
    pub(super) fn capability(&self) -> native::FrontendHooks {
        native::FrontendHooks::verified(self.semantic.clone())
    }
}
