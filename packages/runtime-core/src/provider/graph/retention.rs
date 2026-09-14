use super::*;
use sha2::{Digest, Sha256};
use std::{
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Component, Path},
};
const EXPORT_LIMIT: u64 = 17 * 1024 * 1024;

pub(super) fn consumed(candidate: &Candidate, run: &str) -> Result<PathBuf, CandidateError> {
    directory(candidate, run)?;
    let parent = candidate.state_root.join("run/graph-consumed");
    if parent.exists() || parent.is_symlink() {
        state::check_private_directory(&parent)?;
    }
    Ok(parent.join(run))
}
fn read_private(path: &Path, limit: u64) -> Result<Vec<u8>, CandidateError> {
    let mut file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(state::io)?;
    let m = file.metadata().map_err(state::io)?;
    if !m.is_file()
        || m.nlink() != 1
        || m.uid() != unsafe { libc::geteuid() }
        || m.mode() & 0o077 != 0
        || m.len() > limit
    {
        return Err(error(
            "graph_retention_file",
            "Unsafe retention evidence file.",
        ));
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(state::io)?;
    if bytes.len() as u64 != m.len() {
        return Err(error("graph_retention_file", "Retention evidence changed."));
    }
    Ok(bytes)
}
pub fn reconcile_export(candidate: &Candidate, run: &str) -> Result<Value, CandidateError> {
    let _engine = Engine::connect_cleanup(candidate)?;
    let archive = archive::path(candidate, run)?;
    state::check_private_directory(&archive)?;
    let parent = candidate.state_root.join("exports/graphs");
    state::private_directory(&parent)?;
    let retained = journal::retain_file(
        &parent,
        &format!("{run}.pending"),
        &format!("{run}-recovery"),
        EXPORT_LIMIT,
    )?;
    Ok(json!({"run":run,"retained":retained,"original_retained":true,"publication_replayed":false}))
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Tombstone {
    version: u32,
    run: String,
    owner: String,
    export_sha256: String,
}

pub fn prune(candidate: &Candidate, run: &str) -> Result<Value, CandidateError> {
    let engine = Engine::connect_cleanup(candidate)?;
    let archive = archive::path(candidate, run)?;
    let target = consumed(candidate, run)?;
    let exports = candidate.state_root.join("exports/graphs");
    state::check_private_directory(&exports)?;
    let bytes = read_private(&exports.join(format!("{run}.tar")), EXPORT_LIMIT)?;
    let digest = format!("{:x}", Sha256::digest(&bytes));
    if target.join("state.json").exists() || target.join("state.json").is_symlink() {
        state::check_private_directory(&target)?;
        let receipt: Tombstone = state::read(&target.join("state.json"))?;
        if receipt.version != 1
            || receipt.run != run
            || receipt.owner != engine.guest().incarnation()
            || receipt.export_sha256 != digest
        {
            return Err(error(
                "graph_prune_identity",
                "Consumed-ID receipt or retained export differs.",
            ));
        }
    } else {
        state::check_private_directory(&archive)?;
        let receipt: Receipt = state::read(&archive.join("state.json"))?;
        if receipt.run != run
            || receipt.phase != "removed"
            || receipt.owner != engine.guest().incarnation()
            || export::bundle(&archive)?.0 != bytes
        {
            return Err(error(
                "graph_prune_export",
                "Verified export must exactly match the removed archive before pruning.",
            ));
        }
        let parent = target.parent().expect("consumed parent");
        state::private_directory(parent)?;
        if fs::read_dir(parent).map_err(state::io)?.take(4096).count() >= 4096 {
            return Err(error(
                "graph_consumed_budget",
                "4096 consumed-ID records are retained; pruning is blocked.",
            ));
        }
        if target.exists() || target.is_symlink() {
            state::check_private_directory(&target)?;
            journal::retain(&target)?;
        } else {
            fs::DirBuilder::new()
                .mode(0o700)
                .create(&target)
                .map_err(state::io)?;
        }
        fs::File::open(parent)
            .map_err(state::io)?
            .sync_all()
            .map_err(state::io)?;
        state::write(
            &target.join("state.json"),
            &Tombstone {
                version: 1,
                run: run.into(),
                owner: engine.guest().incarnation().into(),
                export_sha256: digest.clone(),
            },
        )?;
    }
    if archive.exists() || archive.is_symlink() {
        let mut expected = BTreeMap::new();
        let mut tar = tar::Archive::new(bytes.as_slice());
        for entry in tar.entries().map_err(state::io)?.take(129) {
            let mut entry = entry.map_err(state::io)?;
            let path = entry.path().map_err(state::io)?.to_path_buf();
            if expected.len() >= 128
                || !entry.header().entry_type().is_file()
                || path
                    .components()
                    .any(|c| !matches!(c, Component::Normal(_)))
                || entry.size() > 1024 * 1024
            {
                return Err(error(
                    "graph_prune_export",
                    "Invalid retained export entry.",
                ));
            }
            let mut content = Vec::new();
            entry.read_to_end(&mut content).map_err(state::io)?;
            if expected.insert(path, content).is_some() {
                return Err(error(
                    "graph_prune_export",
                    "Duplicate retained export entry.",
                ));
            }
        }
        let mut remaining = BTreeMap::new();
        export::collect(&archive, &archive, 0, &mut remaining, &mut 0, &mut 128)?;
        if remaining
            .iter()
            .any(|(path, content)| expected.get(path) != Some(content))
        {
            return Err(error(
                "graph_prune_changed",
                "Remaining archive differs from verified export; nothing was deleted.",
            ));
        }
        for (path, content) in remaining {
            let path = archive.join(path);
            if read_private(&path, 1024 * 1024)? != content {
                return Err(error(
                    "graph_prune_changed",
                    "Archive changed during pruning.",
                ));
            }
            fs::remove_file(path).map_err(state::io)?;
        }
        remove_empty(&archive, 0, &mut 128)?;
        fs::File::open(archive.parent().expect("archive parent"))
            .map_err(state::io)?
            .sync_all()
            .map_err(state::io)?;
    }
    Ok(
        json!({"run":run,"archive_absent":true,"export_sha256":digest,"export_retained":true,"consumed_id_retained":true}),
    )
}
fn remove_empty(path: &Path, depth: usize, remaining: &mut usize) -> Result<(), CandidateError> {
    state::check_private_directory(path)?;
    if depth > 3 || *remaining == 0 {
        return Err(error(
            "graph_prune_budget",
            "Directory cleanup exceeds retention budget.",
        ));
    }
    *remaining -= 1;
    for entry in fs::read_dir(path).map_err(state::io)?.take(129) {
        remove_empty(&entry.map_err(state::io)?.path(), depth + 1, remaining)?;
    }
    fs::remove_dir(path).map_err(state::io)
}
