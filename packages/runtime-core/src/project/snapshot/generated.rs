//! Materialize reviewed public declarations independently of ignored host bytes.
use super::*;
use crate::project::{PlanData, generated};

fn entry(path: &str, content: &str) -> ContentEntry {
    ContentEntry {
        path: path.into(),
        kind: "file".into(),
        executable: false,
        bytes: content.len() as u64,
        sha256: Some(format!("{:x}", Sha256::digest(content.as_bytes()))),
        link_target: None,
    }
}

impl ContentRevision {
    pub fn verify_generated(&self, plan: &PlanData) -> Result<(), CandidateError> {
        self.validate()?;
        generated::validate_plan(plan)?;
        if self.selection_sha256 != plan.source_selection.metadata_sha256 {
            return Err(generated::refused());
        }
        for (path, content) in &plan.generated_files {
            let expected = entry(path, content);
            if !self.entries.contains(&expected) {
                return Err(generated::refused());
            }
        }
        Ok(())
    }
}

impl Snapshot {
    /// No host path is read: an ignored local file is neither copied nor changed.
    /// Selected files and virtual mount directories cannot be replaced.
    pub fn with_generated(mut self, plan: &PlanData) -> Result<Self, CandidateError> {
        self.receipt.validate()?;
        generated::validate_plan(plan)?;
        if self.receipt.selection_sha256 != plan.source_selection.metadata_sha256 {
            return Err(generated::refused());
        }
        if plan.generated_files.is_empty() {
            return Ok(self);
        }
        let mut entries: BTreeMap<_, _> = self
            .receipt
            .entries
            .into_iter()
            .zip(self.files)
            .map(|(entry, bytes)| (entry.path.clone(), (entry, bytes)))
            .collect();
        for (path, content) in &plan.generated_files {
            if entries.contains_key(path) {
                return Err(generated::refused());
            }
            let generated = entry(path, content);
            self.receipt.total_bytes = self
                .receipt
                .total_bytes
                .checked_add(generated.bytes)
                .ok_or_else(generated::refused)?;
            entries.insert(path.clone(), (generated, content.as_bytes().to_vec()));
        }
        (self.receipt.entries, self.files) = entries.into_values().unzip();
        self.receipt.revision = revision_hash(
            self.receipt.schema_version,
            &self.receipt.selection_sha256,
            &self.receipt.entries,
        )?;
        self.receipt.verify_generated(plan)?;
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
    use std::{fs, path::PathBuf};
    struct Fixture(PathBuf);
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn fixture() -> (Fixture, PlanData) {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let root = std::env::temp_dir().canonicalize().unwrap().join(format!(
            "hack-generated-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::create_dir(root.join("candidate")).unwrap();
        let source = root.join("project");
        fs::create_dir(&source).unwrap();
        fs::write(source.join(".gitignore"), "next-env.d.ts\n.env\n").unwrap();
        fs::write(source.join("next-env.d.ts"), "excluded-canary").unwrap();
        fs::write(source.join(".env"), "excluded-credential-canary").unwrap();
        fs::write(source.join("compose.yaml"), "x-hack-generated-files:\n  next-env.d.ts: public declaration\nservices:\n  web:\n    image: example\n    volumes: [.:/app:ro]\n").unwrap();
        let candidate = Candidate::discover(&root).unwrap();
        let plan = project::plan(
            &candidate,
            PlanOptions {
                project: &source,
                compose_file: Path::new("compose.yaml"),
                profiles: &[],
            },
        )
        .unwrap()
        .plan;
        (Fixture(root), plan)
    }
    #[test]
    fn generated_bytes_ignore_host_leaf_and_are_attested() {
        let (_fixture, plan) = fixture();
        let snapshot = super::super::capture_plan(&plan).unwrap();
        snapshot.receipt().verify_generated(&plan).unwrap();
        let (_, bytes) = snapshot
            .files()
            .find(|(e, _)| e.path == "next-env.d.ts")
            .unwrap();
        assert_eq!(bytes, b"public declaration");
        assert_eq!(
            fs::read(plan.source.join("next-env.d.ts")).unwrap(),
            b"excluded-canary"
        );
        assert!(
            !snapshot
                .files()
                .any(|(_, b)| b.windows(6).any(|w| w == b"canary"))
        );
        let mut changed = snapshot.receipt().clone();
        changed.entries.retain(|e| e.path != "next-env.d.ts");
        assert!(changed.verify_generated(&plan).is_err());
        let mut changed_plan = plan.clone();
        changed_plan
            .generated_files
            .insert("next-env.d.ts".into(), "changed".into());
        assert!(snapshot.receipt().verify_generated(&changed_plan).is_err());
    }
    #[test]
    fn refuses_selected_collisions_and_mount_masking() {
        let (_fixture, mut plan) = fixture();
        plan.generated_files.clear();
        plan.generated_files
            .insert("compose.yaml".into(), "replacement".into());
        assert!(generated::validate_plan(&plan).is_err());
        plan.generated_files.clear();
        plan.generated_files
            .insert("next-env.d.ts".into(), "public".into());
        let mut mount = plan.services["web"].mounts[0].clone();
        mount.kind = "volume".into();
        mount.source = "cache".into();
        mount.target = "/app/next-env.d.ts".into();
        plan.services.get_mut("web").unwrap().mounts.push(mount);
        assert!(generated::validate_plan(&plan).is_err());
    }
}
