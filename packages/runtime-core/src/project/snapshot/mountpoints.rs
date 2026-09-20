//! Derived empty mount targets are part of the immutable artifact, never host source edits.
use super::*;
use crate::project::PlanData;
use std::path::PathBuf;

fn refused() -> CandidateError {
    problem(
        "source_mountpoint",
        "Reviewed source mountpoints are invalid or conflict with selected source entries.",
    )
}
fn relative(path: &Path) -> Result<String, CandidateError> {
    if path.as_os_str().is_empty()
        || path
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err(refused());
    }
    let text = path.to_str().ok_or_else(refused)?;
    if text.len() > 4096 || text.chars().any(char::is_control) {
        return Err(refused());
    }
    Ok(text.into())
}
fn required(plan: &PlanData, entries: &[ContentEntry]) -> Result<BTreeSet<String>, CandidateError> {
    let mut required = BTreeSet::new();
    for service in plan.services.values().filter(|s| s.active) {
        for volume in service.mounts.iter().filter(|m| m.kind == "volume") {
            let target = Path::new(&volume.target);
            if !target.is_absolute()
                || target
                    .components()
                    .any(|c| matches!(c, Component::ParentDir))
            {
                return Err(refused());
            }
            let parent = service
                .mounts
                .iter()
                .filter(|m| m.target != volume.target && target.starts_with(&m.target))
                .max_by_key(|m| Path::new(&m.target).components().count());
            let Some(bind) = parent.filter(|m| m.kind == "bind") else {
                continue;
            };
            if bind.source != "."
                && !entries
                    .iter()
                    .any(|entry| entry.path == bind.source && entry.kind == "directory")
            {
                return Err(refused());
            }
            let suffix = target.strip_prefix(&bind.target).map_err(|_| refused())?;
            let source = if bind.source == "." {
                PathBuf::from(suffix)
            } else {
                Path::new(&bind.source).join(suffix)
            };
            relative(&source)?;
            for directory in source.ancestors().filter(|p| !p.as_os_str().is_empty()) {
                required.insert(relative(directory)?);
                if required.len() > 512 {
                    return Err(refused());
                }
            }
        }
    }
    Ok(required)
}
impl ContentRevision {
    /// Refuse missing/conflicting nested mount targets before container effects.
    pub fn verify_mountpoints(&self, plan: &PlanData) -> Result<(), CandidateError> {
        self.validate()?;
        if self.selection_sha256 != plan.source_selection.metadata_sha256 {
            return Err(refused());
        }
        for path in required(plan, &self.entries)? {
            if !self
                .entries
                .iter()
                .any(|entry| entry.path == path && entry.kind == "directory")
            {
                return Err(refused());
            }
        }
        Ok(())
    }
}
impl Snapshot {
    /// Add only empty directories derived from reviewed active mounts. Ignored local
    /// directory contents are neither read nor copied; the host checkout is unchanged.
    pub fn with_mountpoints(mut self, plan: &PlanData) -> Result<Self, CandidateError> {
        self.receipt.validate()?;
        if self.receipt.selection_sha256 != plan.source_selection.metadata_sha256 {
            return Err(refused());
        }
        let mountpoints = required(plan, &self.receipt.entries)?;
        let mut entries: BTreeMap<_, _> = self
            .receipt
            .entries
            .into_iter()
            .zip(self.files)
            .map(|(entry, bytes)| (entry.path.clone(), (entry, bytes)))
            .collect();
        for path in mountpoints {
            if let Some((entry, _)) = entries.get(&path) {
                if entry.kind != "directory" {
                    return Err(refused());
                }
            } else {
                entries.insert(
                    path.clone(),
                    (
                        ContentEntry {
                            path,
                            kind: "directory".into(),
                            executable: false,
                            bytes: 0,
                            sha256: None,
                            link_target: None,
                        },
                        Vec::new(),
                    ),
                );
            }
        }
        (self.receipt.entries, self.files) = entries.into_values().unzip();
        self.receipt.revision = format!(
            "{:x}",
            Sha256::digest(
                serde_json::to_vec(&(1_u32, &self.receipt.entries)).map_err(|_| refused())?
            )
        );
        self.receipt.verify_mountpoints(plan)?;
        Ok(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        Candidate,
        project::{self, PlanOptions},
    };
    use std::{fs, os::unix::fs::symlink};
    struct Fixture(PathBuf);
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn fixture() -> (Fixture, PlanData) {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let root = std::env::temp_dir().canonicalize().unwrap().join(format!(
            "hack-mountpoints-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::create_dir(root.join("candidate")).unwrap();
        fs::create_dir(root.join("project")).unwrap();
        let project = root.join("project");
        fs::write(project.join(".gitignore"), "node_modules/\n").unwrap();
        fs::create_dir(project.join("node_modules")).unwrap();
        fs::write(
            project.join("node_modules/private-excluded"),
            "excluded-content",
        )
        .unwrap();
        fs::write(project.join("file"), "selected").unwrap();
        symlink("file", project.join("alias")).unwrap();
        fs::write(project.join("compose.yaml"),"services:\n  web:\n    image: fixture\n    volumes:\n      - .:/app:ro\n      - deps:/app/node_modules\nvolumes:\n  deps: {}\n").unwrap();
        let candidate = Candidate::discover(&root.join("candidate")).unwrap();
        let plan = project::plan(
            &candidate,
            PlanOptions {
                project: &project,
                compose_file: Path::new("compose.yaml"),
                profiles: &[],
            },
        )
        .unwrap()
        .plan;
        (Fixture(root), plan)
    }
    fn capture(plan: &PlanData) -> Snapshot {
        super::super::capture(
            &plan.source,
            &BTreeSet::new(),
            &plan.source_selection.metadata_sha256,
        )
        .unwrap()
    }
    #[test]
    fn excluded_mountpoint_is_attested_without_copying_ignored_contents_or_host_writes() {
        let (fixture, plan) = fixture();
        let before = capture(&plan);
        let original = before.receipt().revision.clone();
        assert!(before.receipt().verify_mountpoints(&plan).is_err());
        let snapshot = before.with_mountpoints(&plan).unwrap();
        assert_ne!(snapshot.receipt().revision, original);
        assert_eq!(
            snapshot.receipt().selection_sha256,
            plan.source_selection.metadata_sha256
        );
        assert!(
            snapshot
                .receipt()
                .entries
                .iter()
                .any(|e| e.path == "node_modules" && e.kind == "directory")
        );
        assert!(
            !snapshot
                .receipt()
                .entries
                .iter()
                .any(|e| e.path.contains("private-excluded"))
        );
        let bytes = snapshot.archive().unwrap();
        let mut archive = tar::Archive::new(bytes.as_slice());
        assert!(archive.entries().unwrap().any(|e| {
            let e = e.unwrap();
            e.path().unwrap() == Path::new("node_modules") && e.header().entry_type().is_dir()
        }));
        assert_eq!(
            fs::read(fixture.0.join("project/node_modules/private-excluded")).unwrap(),
            b"excluded-content"
        );
        assert_eq!(capture(&plan).receipt().revision, original);
        let mut changed = plan.clone();
        changed.services.get_mut("web").unwrap().mounts[1].target = "/app/other/cache".into();
        let other = capture(&changed).with_mountpoints(&changed).unwrap();
        assert_ne!(snapshot.receipt().revision, other.receipt().revision);
        assert!(!fixture.0.join("project/other").exists());
    }
    #[test]
    fn writable_declarations_can_publish_immutable_mountpoint_skeletons() {
        let (_fixture, mut plan) = fixture();
        plan.services.get_mut("web").unwrap().mounts[0].read_only = false;
        let snapshot = capture(&plan).with_mountpoints(&plan).unwrap();
        snapshot.receipt().verify_mountpoints(&plan).unwrap();
        assert!(
            snapshot
                .receipt()
                .entries
                .iter()
                .any(|entry| entry.path == "node_modules" && entry.kind == "directory")
        );
        assert!(
            !snapshot
                .receipt()
                .entries
                .iter()
                .any(|entry| entry.path.contains("private-excluded"))
        );
    }
    #[test]
    fn selected_file_symlink_and_escape_conflicts_refuse() {
        let (_fixture, plan) = fixture();
        for target in [
            "/app/file",
            "/app/file/child",
            "/app/alias",
            "/app/alias/child",
            "/app/../escape",
        ] {
            let mut changed = plan.clone();
            changed.services.get_mut("web").unwrap().mounts[1].target = target.into();
            assert!(
                capture(&plan).with_mountpoints(&changed).is_err(),
                "{target}"
            );
        }
        let mut excluded = plan.clone();
        excluded.services.get_mut("web").unwrap().mounts[0].source = "node_modules".into();
        assert!(capture(&plan).with_mountpoints(&excluded).is_err());
        let mut changed = plan.clone();
        changed.services.get_mut("web").unwrap().active = false;
        let before = capture(&plan);
        let revision = before.receipt().revision.clone();
        assert_eq!(
            before
                .with_mountpoints(&changed)
                .unwrap()
                .receipt()
                .revision,
            revision
        );
    }
}
