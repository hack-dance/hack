//! Graph mounts resolve only through an exact immutable publication, never host paths.
use super::*;
use crate::project::{PlanData, snapshot::ContentRevision};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SourceBinding {
    pub revision: String,
    pub archive_sha256: String,
    pub selection_sha256: String,
}
impl SourceBinding {
    pub(super) fn valid(&self) -> bool {
        [&self.revision, &self.archive_sha256, &self.selection_sha256]
            .iter()
            .all(|v| hex(v, 64))
    }
}
pub(super) struct Inputs {
    pub binding: SourceBinding,
    pub paths: BTreeMap<String, String>,
}

fn mounts(plan: &PlanData) -> impl Iterator<Item = &project::MountPlan> {
    plan.services
        .values()
        .filter(|s| s.active)
        .flat_map(|s| &s.mounts)
        .filter(|m| m.kind == "bind")
}

pub(super) fn requested(plan: &PlanData, revision: Option<&str>) -> Result<(), CandidateError> {
    if mounts(plan).next().is_some() != revision.is_some() || revision.is_some_and(|r| !hex(r, 64))
    {
        return Err(error(
            "graph_source_required",
            "Read-only source mounts require an explicit 64-hex published source revision; graphs without source mounts must omit it.",
        ));
    }
    Ok(())
}

fn paths(
    plan: &PlanData,
    manifest: &ContentRevision,
) -> Result<BTreeMap<String, String>, CandidateError> {
    manifest.validate()?;
    if manifest.selection_sha256 != plan.source_selection.metadata_sha256 {
        return Err(error(
            "graph_source_selection",
            "Published source selection differs from the reviewed plan.",
        ));
    }
    let root = format!(
        "/storage/hack-source/{}/{}/tree",
        plan.namespace, manifest.revision
    );
    let mut paths = BTreeMap::new();
    for mount in mounts(plan) {
        if !mount.read_only
            || (mount.source != "."
                && manifest.entries.iter().any(|entry| {
                    entry.kind == "symlink" && entry.path.starts_with(&format!("{}/", mount.source))
                }))
            || (mount.source != "."
                && !manifest.entries.iter().any(|entry| {
                    entry.path == mount.source
                        && matches!(entry.kind.as_str(), "file" | "directory")
                }))
        {
            return Err(error(
                "graph_source_mount",
                "Source mounts must be read-only selected regular files or directories; excluded paths, symlink roots and subdirectories containing symlinks are refused.",
            ));
        }
        paths.insert(
            mount.source.clone(),
            if mount.source == "." {
                root.clone()
            } else {
                format!("{root}/{}", mount.source)
            },
        );
    }
    Ok(paths)
}

pub(super) fn prepare(
    candidate: &Candidate,
    engine: &Engine<'_>,
    plan: &PlanData,
    revision: Option<&str>,
) -> Result<Option<Inputs>, CandidateError> {
    requested(plan, revision)?;
    let Some(revision) = revision else {
        return Ok(None);
    };
    let publication = super::super::source_transfer::load(candidate, &plan.namespace, revision)?;
    let paths = paths(plan, &publication.manifest)?;
    super::super::source_transfer::verify_published(engine.guest(), &publication)?;
    Ok(Some(Inputs {
        binding: SourceBinding {
            revision: revision.into(),
            archive_sha256: publication.archive_sha256,
            selection_sha256: publication.manifest.selection_sha256,
        },
        paths,
    }))
}

pub(super) fn unchanged(source: &Option<Inputs>, receipt: &Receipt) -> Result<(), CandidateError> {
    if source.as_ref().map(|s| &s.binding) != receipt.source.as_ref() {
        return Err(error(
            "graph_source_changed",
            "Restart and restore must retain the exact accepted source publication.",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::BTreeSet, path::Path};

    #[test]
    fn selected_mounts_are_bound_to_manifest_and_read_only_config() {
        let fixture = super::super::tests::Fixture::new();
        let home = super::super::tests::Fixture::new();
        let candidate = Candidate::discover(&home.0).unwrap();
        fs::create_dir(fixture.0.join("app")).unwrap();
        fs::write(fixture.0.join("app/main.js"), "console.log('source')").unwrap();
        fs::write(fixture.0.join(".env"), "EXCLUDED=fixture").unwrap();
        std::os::unix::fs::symlink("main.js", fixture.0.join("app/link.js")).unwrap();
        let document = json!({"services":{"web":{"image":format!("sha256:{}", "a".repeat(64)),"read_only":true,"network_mode":"none","volumes":[".:/app:ro"],"entrypoint":["/usr/local/bin/bun","/app/app/main.js"]}}});
        fs::write(
            fixture.0.join("compose.yaml"),
            serde_json::to_vec(&document).unwrap(),
        )
        .unwrap();
        let options = || PlanOptions {
            project: &fixture.0,
            compose_file: Path::new("compose.yaml"),
            profiles: &[],
        };
        let review = project::plan(&candidate, options()).unwrap();
        let snapshot = project::snapshot::capture(
            &fixture.0,
            &BTreeSet::new(),
            &review.plan.source_selection.metadata_sha256,
        )
        .unwrap();
        let manifest = snapshot.receipt();
        let paths = super::paths(&review.plan, manifest).unwrap();
        assert!(paths["."].ends_with(&format!("/{}/tree", manifest.revision)));
        assert!(requested(&review.plan, None).is_err());
        assert!(requested(&review.plan, Some("invalid")).is_err());
        requested(&review.plan, Some(&manifest.revision)).unwrap();
        let source = Inputs {
            binding: SourceBinding {
                revision: manifest.revision.clone(),
                archive_sha256: "b".repeat(64),
                selection_sha256: manifest.selection_sha256.clone(),
            },
            paths,
        };
        let inputs =
            project::inputs::compile(&candidate, options(), &review.plan_id, &BTreeMap::new())
                .unwrap();
        let prepared = config::prepare(
            inputs,
            &BTreeMap::from([("web".into(), Condition::Started)]),
            &"a".repeat(32),
            &"b".repeat(32),
            Some(&source),
        )
        .unwrap();
        assert_eq!(
            prepared.configs["web"]["HostConfig"]["Mounts"][0],
            json!({"Type":"bind","Source":source.paths["."],"Target":"/app","ReadOnly":true,"BindOptions":{"Propagation":"rprivate"}})
        );
        for name in [".env", "app/link.js", "app", "../escape"] {
            let mut plan = review.plan.clone();
            plan.services.get_mut("web").unwrap().mounts[0].source = name.into();
            assert_eq!(
                super::paths(&plan, manifest).unwrap_err().code,
                "graph_source_mount"
            );
        }
        let mut plan = review.plan.clone();
        plan.services.get_mut("web").unwrap().mounts[0].source = "app/main.js".into();
        assert!(super::paths(&plan, manifest).is_ok());
        plan.services.get_mut("web").unwrap().mounts[0].read_only = false;
        assert!(super::paths(&plan, manifest).is_err());
        plan.source_selection.metadata_sha256 = "c".repeat(64);
        assert_eq!(
            super::paths(&plan, manifest).unwrap_err().code,
            "graph_source_selection"
        );
        assert!(!candidate.state_root.exists());
    }

    #[test]
    fn source_receipts_preserve_legacy_bytes_and_refuse_changed_binding() {
        let value = json!({"version":1,"run":"a".repeat(32),"owner":"b".repeat(32),"namespace":"c".repeat(64),"plan_id":"d".repeat(64),"phase":"ready-observed","readiness":{},"resources":{}});
        let mut receipt: Receipt = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(&receipt).unwrap(), value);
        let binding = SourceBinding {
            revision: "a".repeat(64),
            archive_sha256: "b".repeat(64),
            selection_sha256: "c".repeat(64),
        };
        let mut source = Some(Inputs {
            binding: binding.clone(),
            paths: BTreeMap::new(),
        });
        assert!(unchanged(&source, &receipt).is_err());
        receipt.source = Some(binding);
        unchanged(&source, &receipt).unwrap();
        assert!(unchanged(&None, &receipt).is_err());
        source.as_mut().unwrap().binding.archive_sha256 = "d".repeat(64);
        assert!(unchanged(&source, &receipt).is_err());
        let decoded: Receipt =
            serde_json::from_value(serde_json::to_value(&receipt).unwrap()).unwrap();
        assert_eq!(decoded.source, receipt.source);
    }
}
