//! Stable execution/selection contract for mutable source, not a live graph lease.
//! Current manifests retain their own metadata binding; ordinary content changes
//! must not be compared to the original selection metadata or whole plan ID.
use super::{PlanData, snapshot::ContentRevision};
use crate::CandidateError;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, path::Path};

fn refused() -> CandidateError {
    CandidateError::new(
        "live_source_contract",
        "Live source execution, policy or pinned inputs changed or are invalid; values omitted.",
    )
}
fn hash(value: &impl Serialize) -> Result<String, CandidateError> {
    let bytes = zeroize::Zeroizing::new(serde_json::to_vec(value).map_err(|_| refused())?);
    Ok(format!("{:x}", Sha256::digest(bytes.as_slice())))
}

/// Only public fingerprints are retained. This contract does not authorize
/// workspace mutation, concurrent readers, cache changes or graph recovery.
/// Callers opt in explicitly; ordinary non-watching synchronization is not bound.
/// Resolved execution inputs supplied outside the Compose document are not part
/// of PlanData and require a separate caller-owned binding before live execution.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Contract {
    #[serde(skip)]
    reviewed_revision: Option<String>,
    version: u32,
    execution_sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    hostname_execution_sha256: Option<String>,
    policy_sha256: String,
    cache_inputs_sha256: String,
    mount_roots_sha256: String,
}

impl PartialEq for Contract {
    fn eq(&self, other: &Self) -> bool {
        self.version == other.version
            && self.execution_sha256 == other.execution_sha256
            && self.policy_sha256 == other.policy_sha256
            && self.cache_inputs_sha256 == other.cache_inputs_sha256
            && self.mount_roots_sha256 == other.mount_roots_sha256
    }
}
impl Eq for Contract {}

#[derive(Serialize)]
struct FileIdentity<'a> {
    sha256: &'a Option<String>,
    executable: bool,
    bytes: u64,
}
fn selected<'a>(
    manifest: &'a ContentRevision,
    path: &str,
) -> Result<Option<FileIdentity<'a>>, CandidateError> {
    if path.is_empty()
        || path.len() > 512
        || path.contains(['$', '\\', '\0'])
        || path.chars().any(char::is_control)
        || path
            .split('/')
            .any(|p| p.is_empty() || p == "." || p == "..")
    {
        return Err(refused());
    }
    for ancestor in Path::new(path)
        .ancestors()
        .skip(1)
        .filter(|p| !p.as_os_str().is_empty())
    {
        if manifest
            .entries
            .iter()
            .any(|e| Path::new(&e.path) == ancestor && e.kind != "directory")
        {
            return Err(refused());
        }
    }
    match manifest.entries.iter().find(|e| e.path == path) {
        None => Ok(None),
        Some(entry) if entry.kind == "file" => Ok(Some(FileIdentity {
            sha256: &entry.sha256,
            executable: entry.executable,
            bytes: entry.bytes,
        })),
        _ => Err(refused()),
    }
}

/// Pair a literal-preserving raw-input fingerprint with the complete public plan
/// projection. Dropping Compose hashes from the ordinary redacted plan is unsafe.
fn hostname_execution(plan: &PlanData) -> Result<Option<String>, CandidateError> {
    let Some(raw) = &plan.hostname_change_sha256 else {
        return Ok(None);
    };
    let mut services = plan.services.clone();
    for service in services.values_mut() {
        if let Some(route) = service.routing.as_mut() {
            route.hostnames.clear();
        }
    }
    hash(&(
        "hack-hostname-execution-v1",
        raw,
        plan.schema_version,
        &plan.kind,
        &plan.candidate_root,
        &plan.source,
        &plan.namespace,
        &plan.compose_file,
        &plan.active_profiles,
        services,
        &plan.networks,
        &plan.volumes,
        &plan.registry,
        &plan.generated_files,
        &plan.original_environment_files,
    ))
    .map(Some)
}

impl Contract {
    /// Only a freshly reviewed contract can authorize this exact snapshot. A
    /// deserialized retained fingerprint is comparison evidence, not admission.
    pub fn reviewed_snapshot(&self, manifest: &ContentRevision) -> Result<(), CandidateError> {
        manifest.validate().map_err(|_| refused())?;
        if self.reviewed_revision.as_deref() != Some(&manifest.revision) {
            return Err(refused());
        }
        Ok(())
    }

    /// Pin execution and selection policy, plus dependency-cache inputs. The
    /// manifest must come from the current reviewed plan-aware capture.
    pub fn from_plan(plan: &PlanData, manifest: &ContentRevision) -> Result<Self, CandidateError> {
        manifest.validate().map_err(|_| refused())?;
        if !plan.enrollment_compatible
            || plan.diagnostics.iter().any(|d| d.severity == "error")
            || manifest.selection_sha256 != plan.source_selection.metadata_sha256
        {
            return Err(refused());
        }
        manifest.verify_mountpoints(plan).map_err(|_| refused())?;
        manifest.verify_registry(plan).map_err(|_| refused())?;
        manifest.verify_generated(plan).map_err(|_| refused())?;
        let execution_sha256 = hash(&(
            "hack-live-source-execution-v1",
            plan.schema_version,
            &plan.kind,
            &plan.candidate_root,
            &plan.source,
            &plan.namespace,
            &plan.compose_file,
            &plan.compose_sha256,
            &plan.active_profiles,
            &plan.services,
            &plan.networks,
            &plan.volumes,
            &plan.registry,
        ))?;
        let execution_sha256 = if plan.generated_files.is_empty() {
            execution_sha256
        } else {
            hash(&(
                "hack-live-generated-v1",
                execution_sha256,
                &plan.generated_files,
            ))?
        };
        let policy_sha256 = hash(&(
            "hack-live-source-policy-v1",
            &plan.source_selection.policy,
            &plan.source_selection.identity_kind,
            &plan.source_selection.ignore_files,
            &plan.source_selection.exclusion_rules,
        ))?;
        let mut caches = BTreeMap::new();
        let mut roots = BTreeMap::new();
        for service in plan.services.values().filter(|s| s.active) {
            for mount in service.mounts.iter().filter(|m| m.kind == "bind") {
                let kind = if mount.source == "." {
                    "directory"
                } else {
                    manifest
                        .entries
                        .iter()
                        .find(|e| e.path == mount.source)
                        .filter(|e| matches!(e.kind.as_str(), "file" | "directory"))
                        .map(|e| e.kind.as_str())
                        .ok_or_else(refused)?
                };
                roots.insert(&mount.source, kind);
            }
            let Some(cache) = &service.dependency_cache else {
                continue;
            };
            if cache.lockfiles.is_empty()
                || cache.lockfiles.len() > 32
                || cache.runtime_files.len() > 32
                || !plan.volumes.contains_key(&cache.volume)
                || !service
                    .mounts
                    .iter()
                    .any(|m| m.kind == "volume" && m.source == cache.volume)
            {
                return Err(refused());
            }
            let mut inputs = BTreeMap::new();
            let mut present = false;
            for path in &cache.lockfiles {
                let entry = selected(manifest, path)?;
                present |= entry.is_some();
                if (entry.is_none() && cache.lockfiles_explicit)
                    || inputs.insert(format!("lock:{path}"), entry).is_some()
                {
                    return Err(refused());
                }
            }
            if !present {
                return Err(refused());
            }
            for path in &cache.runtime_files {
                if inputs
                    .insert(format!("runtime:{path}"), selected(manifest, path)?)
                    .is_some()
                {
                    return Err(refused());
                }
            }
            let fingerprint = hash(&(cache, &service.image, &inputs))?;
            if caches
                .insert(&cache.volume, fingerprint.clone())
                .is_some_and(|old| old != fingerprint)
            {
                return Err(refused());
            }
        }
        Ok(Self {
            reviewed_revision: Some(manifest.revision.clone()),
            version: 1,
            execution_sha256,
            hostname_execution_sha256: hostname_execution(plan)?,
            policy_sha256,
            cache_inputs_sha256: hash(&("hack-live-source-cache-inputs-v1", caches))?,
            mount_roots_sha256: hash(&("hack-live-source-mount-roots-v1", roots))?,
        })
    }

    /// Separate opt-in proof for a newly enrolled normalized hostname-only change.
    /// The ordinary execution fingerprint remains strict, including Compose bytes.
    pub(crate) fn verify_hostnames(
        &self,
        plan: &PlanData,
        manifest: &ContentRevision,
    ) -> Result<(), CandidateError> {
        let fresh = Self::from_plan(plan, manifest)?;
        if self.version != fresh.version
            || self.hostname_execution_sha256.is_none()
            || self.hostname_execution_sha256 != fresh.hostname_execution_sha256
            || self.policy_sha256 != fresh.policy_sha256
            || self.cache_inputs_sha256 != fresh.cache_inputs_sha256
            || self.mount_roots_sha256 != fresh.mount_roots_sha256
        {
            return Err(refused());
        }
        Ok(())
    }

    /// Allow ordinary accepted file edits/additions/removals, never execution,
    /// ignore-policy, mount-root or cache-input drift. Does not perform I/O.
    pub fn verify(
        &self,
        plan: &PlanData,
        manifest: &ContentRevision,
    ) -> Result<(), CandidateError> {
        if *self != Self::from_plan(plan, manifest)? {
            return Err(refused());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        Candidate,
        project::{self, PlanOptions, snapshot},
    };
    use std::{
        collections::BTreeSet,
        fs,
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
    };
    static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);
    struct Fixture(PathBuf);
    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }
    fn fixture() -> (Fixture, Candidate, PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "hklive-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        let source = root.join("project");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("app.js"), "initial").unwrap();
        fs::write(source.join("bun.lock"), "lock").unwrap();
        fs::write(source.join("package.json"), "{}").unwrap();
        fs::write(source.join(".gitignore"), "node_modules/\n.npmrc\n").unwrap();
        fs::write(source.join(".npmrc"), "@scope:registry=https://npm.pkg.github.com\n//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}\n").unwrap();
        fs::write(source.join("compose.yaml"), format!("services:\n  deps:\n    image: sha256:{}\n    entrypoint: [/bin/install]\n    labels:\n      hack.dependencies.cache-volume: deps\n      hack.dependencies.runtime-files: package.json,optional.json\n    volumes: [.:/app:ro, deps:/app/node_modules]\nvolumes:\n  deps: {{}}\n", "a".repeat(64))).unwrap();
        let candidate = Candidate::discover(&root).unwrap();
        (Fixture(root), candidate, source)
    }
    fn capture(candidate: &Candidate, source: &Path) -> (project::PlanReport, snapshot::Snapshot) {
        let report = project::plan(
            candidate,
            PlanOptions {
                project: source,
                compose_file: Path::new("compose.yaml"),
                profiles: &[],
            },
        )
        .unwrap();
        let snapshot = snapshot::capture(
            source,
            &BTreeSet::new(),
            &report.plan.source_selection.metadata_sha256,
        )
        .unwrap()
        .with_mountpoints(&report.plan)
        .unwrap()
        .with_registry(&report.plan)
        .unwrap();
        (report, snapshot)
    }
    fn normalized_capture(
        candidate: &Candidate,
        source: &Path,
        value: &serde_json::Value,
    ) -> (project::PlanReport, snapshot::Snapshot) {
        let bytes = serde_json::to_vec(value).unwrap();
        fs::write(source.join("compose.yaml"), &bytes).unwrap();
        let original = format!("{:x}", Sha256::digest(&bytes));
        let namespace = candidate.plan(source).unwrap().namespace;
        let report = project::plan_normalized(
            candidate,
            project::NormalizedComposeOptions {
                project: source,
                compose_file: Path::new("compose.yaml"),
                profiles: &[],
                expected_namespace: &namespace,
                expected_compose_sha256: &original,
                compose_bytes: &bytes,
            },
        )
        .unwrap();
        let snapshot = snapshot::capture_plan(&report.plan).unwrap();
        (report, snapshot)
    }

    #[test]
    fn hostname_contract_preserves_literals_policy_cache_and_roundtrip() {
        let (_fixture, candidate, source) = fixture();
        let mut base =
            super::super::yaml::parse(&fs::read(source.join("compose.yaml")).unwrap()).unwrap();
        base["services"]["web"] = serde_json::json!({
            "image": format!("sha256:{}", "a".repeat(64)),
            "command": ["serve", "original-private-literal"], "environment": {"TOKEN": "private-env-literal"},
            "volumes": [".:/app:ro"], "read_only": true,
            "healthcheck": {"x-hack-http": {"port":3000,"path":"/health","interval_ms":100,"timeout_ms":500,"retries":3,"start_period_ms":0}},
            "labels": {"caddy":"web.hack", "caddy.reverse_proxy":"{{upstreams 3000}}", "caddy.tls":"internal"}
        });
        let (initial, before) = normalized_capture(&candidate, &source, &base);
        let contract = Contract::from_plan(&initial.plan, before.receipt()).unwrap();
        assert!(contract.hostname_execution_sha256.is_some());
        let mut changed = base.clone();
        changed["services"]["web"]["labels"]["caddy"] = "web.hack, web.v5.hack.gy".into();
        let (next, after) = normalized_capture(&candidate, &source, &changed);
        assert!(contract.verify(&next.plan, after.receipt()).is_err());
        contract
            .verify_hostnames(&next.plan, after.receipt())
            .unwrap();
        let current = Contract::from_plan(&next.plan, after.receipt()).unwrap();
        let (rollback, snapshot) = normalized_capture(&candidate, &source, &base);
        current
            .verify_hostnames(&rollback.plan, snapshot.receipt())
            .unwrap();
        let encoded = serde_json::to_string(&current).unwrap();
        assert!(!encoded.contains("private") && !encoded.contains("web.hack"));
        let mut old = serde_json::to_value(&contract).unwrap();
        old.as_object_mut()
            .unwrap()
            .remove("hostname_execution_sha256");
        let legacy: Contract = serde_json::from_value(old).unwrap();
        legacy.verify(&initial.plan, before.receipt()).unwrap();
        assert!(
            legacy
                .verify_hostnames(&next.plan, after.receipt())
                .is_err()
        );
        for (key, value) in [
            (
                "command",
                serde_json::json!(["serve", "different-private-literal"]),
            ),
            ("entrypoint", serde_json::json!(["/bin/other"])),
            (
                "environment",
                serde_json::json!({"TOKEN":"other-private-literal"}),
            ),
            (
                "image",
                serde_json::json!(format!("sha256:{}", "b".repeat(64))),
            ),
            ("working_dir", serde_json::json!("/other")),
            ("volumes", serde_json::json!([".:/different:ro"])),
        ] {
            let mut rejected = changed.clone();
            rejected["services"]["web"][key] = value;
            let (plan, snapshot) = normalized_capture(&candidate, &source, &rejected);
            assert!(
                contract
                    .verify_hostnames(&plan.plan, snapshot.receipt())
                    .is_err(),
                "accepted {key}"
            );
        }
        for (path, content) in [
            ("bun.lock", "different lock"),
            (".gitignore", "node_modules/\n.npmrc\nextra/\n"),
        ] {
            let saved = fs::read(source.join(path)).unwrap();
            fs::write(source.join(path), content).unwrap();
            let (plan, snapshot) = normalized_capture(&candidate, &source, &changed);
            assert!(
                contract
                    .verify_hostnames(&plan.plan, snapshot.receipt())
                    .is_err(),
                "accepted {path}"
            );
            fs::write(source.join(path), saved).unwrap();
        }
    }

    #[test]
    fn content_add_remove_and_excluded_secrets_do_not_freeze_plan_identity() {
        let (_fixture, candidate, source) = fixture();
        let (initial, snapshot) = capture(&candidate, &source);
        let contract = Contract::from_plan(&initial.plan, snapshot.receipt()).unwrap();
        fs::write(source.join("app.js"), "ordinary changed contents").unwrap();
        fs::write(source.join("new.js"), "new module").unwrap();
        fs::write(source.join(".env.new"), "secret-canary").unwrap();
        let (changed, snapshot) = capture(&candidate, &source);
        assert_ne!(initial.plan_id, changed.plan_id);
        assert!(
            !snapshot
                .receipt()
                .entries
                .iter()
                .any(|e| e.path == ".env.new")
        );
        contract.verify(&changed.plan, snapshot.receipt()).unwrap();
        fs::remove_file(source.join("new.js")).unwrap();
        let (changed, snapshot) = capture(&candidate, &source);
        contract.verify(&changed.plan, snapshot.receipt()).unwrap();
        fs::create_dir(source.join("node_modules")).unwrap();
        fs::write(source.join("node_modules/generated.js"), "ignored output").unwrap();
        let replacement = source.parent().unwrap().join("atomic-app.js");
        fs::write(&replacement, "atomic editor save").unwrap();
        fs::rename(replacement, source.join("app.js")).unwrap();
        let (changed, snapshot) = capture(&candidate, &source);
        assert!(
            !snapshot
                .receipt()
                .entries
                .iter()
                .any(|entry| entry.path.starts_with("node_modules/"))
        );
        contract.verify(&changed.plan, snapshot.receipt()).unwrap();
        let encoded = serde_json::to_string(&contract).unwrap();
        assert!(!encoded.contains("GITHUB_TOKEN") && !encoded.contains("app.js"));
    }
    #[test]
    fn reviewed_contract_cannot_be_reused_for_another_snapshot_or_deserialized_admission() {
        let (_fixture, candidate, source) = fixture();
        let (plan, snapshot) = capture(&candidate, &source);
        let contract = Contract::from_plan(&plan.plan, snapshot.receipt()).unwrap();
        contract.reviewed_snapshot(snapshot.receipt()).unwrap();
        let retained: Contract =
            serde_json::from_slice(&serde_json::to_vec(&contract).unwrap()).unwrap();
        assert_eq!(contract, retained);
        assert!(retained.reviewed_snapshot(snapshot.receipt()).is_err());
        fs::write(source.join("app.js"), "ordinary update").unwrap();
        let (plan, next) = capture(&candidate, &source);
        assert!(contract.reviewed_snapshot(next.receipt()).is_err());
        let next_contract = Contract::from_plan(&plan.plan, next.receipt()).unwrap();
        assert_eq!(contract, next_contract);
        next_contract.reviewed_snapshot(next.receipt()).unwrap();
    }
    #[test]
    fn execution_policy_registry_and_cache_input_changes_refuse() {
        for (path, contents) in [
            ("bun.lock", "changed lock"),
            ("package.json", "changed runtime"),
            ("optional.json", "new optional input"),
            ("package-lock.json", "new default lock"),
            (".gitignore", "node_modules/\n.npmrc\nnew-ignore/\n"),
            (".npmrc", "@scope:registry=https://registry.npmjs.org\n"),
        ] {
            let (_fixture, candidate, source) = fixture();
            let (plan, snapshot) = capture(&candidate, &source);
            let contract = Contract::from_plan(&plan.plan, snapshot.receipt()).unwrap();
            fs::write(source.join(path), contents).unwrap();
            let (changed, snapshot) = capture(&candidate, &source);
            assert!(
                contract.verify(&changed.plan, snapshot.receipt()).is_err(),
                "{path}"
            );
        }
        let (_fixture, candidate, source) = fixture();
        let (plan, snapshot) = capture(&candidate, &source);
        let contract = Contract::from_plan(&plan.plan, snapshot.receipt()).unwrap();
        fs::write(
            source.join("compose.yaml"),
            fs::read_to_string(source.join("compose.yaml")).unwrap()
                + "# execution document changed\n",
        )
        .unwrap();
        let (changed, snapshot) = capture(&candidate, &source);
        assert!(contract.verify(&changed.plan, snapshot.receipt()).is_err());
    }
    #[test]
    fn missing_locks_symlink_inputs_and_missing_mount_roots_refuse() {
        let (_fixture, candidate, source) = fixture();
        fs::remove_file(source.join("bun.lock")).unwrap();
        let (plan, snapshot) = capture(&candidate, &source);
        assert!(Contract::from_plan(&plan.plan, snapshot.receipt()).is_err());
        std::os::unix::fs::symlink("app.js", source.join("bun.lock")).unwrap();
        let (plan, snapshot) = capture(&candidate, &source);
        assert!(Contract::from_plan(&plan.plan, snapshot.receipt()).is_err());
        fs::remove_file(source.join("bun.lock")).unwrap();
        fs::write(source.join("bun.lock"), "lock").unwrap();
        let (mut plan, snapshot) = capture(&candidate, &source);
        Contract::from_plan(&plan.plan, snapshot.receipt()).unwrap();
        let cache = plan
            .plan
            .services
            .get_mut("deps")
            .unwrap()
            .dependency_cache
            .as_mut()
            .unwrap();
        cache.lockfiles_explicit = true;
        cache.lockfiles = vec!["bun.lock".into(), "missing.lock".into()];
        assert!(Contract::from_plan(&plan.plan, snapshot.receipt()).is_err());
        let (mut plan, snapshot) = capture(&candidate, &source);
        plan.plan.services.get_mut("deps").unwrap().mounts[0].source = "absent".into();
        assert!(Contract::from_plan(&plan.plan, snapshot.receipt()).is_err());
    }
}
