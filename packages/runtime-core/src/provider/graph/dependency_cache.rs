//! Immutable cache identity. This module grants neither volume creation nor deletion authority.
use crate::{
    CandidateError,
    project::{PlanData, snapshot::ContentRevision},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Component, Path, PathBuf},
};

fn refused() -> CandidateError {
    CandidateError::new(
        "graph_dependency_cache",
        "Dependency cache identity or declared inputs could not be verified; values omitted.",
    )
}
fn hex(v: &str) -> bool {
    v.len() == 64
        && v.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn hash(value: &impl Serialize) -> Result<String, CandidateError> {
    let bytes = zeroize::Zeroizing::new(serde_json::to_vec(value).map_err(|_| refused())?);
    Ok(format!("{:x}", Sha256::digest(bytes.as_slice())))
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct CacheBinding {
    pub scope: String,
    pub fingerprint: String,
    pub image: String,
}
impl CacheBinding {
    pub fn name(&self) -> String {
        format!("hack-cache-v5-{}", self.fingerprint)
    }
    pub fn valid(&self) -> bool {
        hex(&self.scope)
            && hex(&self.fingerprint)
            && self.image.strip_prefix("sha256:").is_some_and(hex)
    }
    pub fn labels(&self, owner: &str, logical: &str) -> Value {
        json!({"io.hack-local.owner":owner,"io.hack-local.kind":"dependency-cache","io.hack-local.cache-scope":self.scope,"io.hack-local.cache-fingerprint":self.fingerprint,"io.hack-local.cache-volume":logical,"io.hack-local.cache-image":self.image})
    }
}
fn selected(manifest: &ContentRevision, path: &str) -> Result<Option<Value>, CandidateError> {
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
        Some(entry) if entry.kind == "file" => Ok(Some(
            json!({"sha256":entry.sha256,"executable":entry.executable,"bytes":entry.bytes}),
        )),
        _ => Err(refused()),
    }
}
pub fn resolve(
    plan: &PlanData,
    manifest: &ContentRevision,
    scope: &str,
    executable: &BTreeMap<String, crate::project::inputs::ServiceInputs>,
) -> Result<BTreeMap<String, CacheBinding>, CandidateError> {
    manifest.validate().map_err(|_| refused())?;
    if !hex(scope)
        || !hex(&plan.compose_sha256)
        || manifest.selection_sha256 != plan.source_selection.metadata_sha256
    {
        return Err(refused());
    }
    let mut result = BTreeMap::new();
    for (name, service) in plan.services.iter().filter(|(_, s)| s.active) {
        let Some(declaration) = &service.dependency_cache else {
            continue;
        };
        let public = executable.get(name).ok_or_else(refused)?;
        let image = service
            .image
            .as_ref()
            .filter(|s| s.strip_prefix("sha256:").is_some_and(hex))
            .ok_or_else(refused)?;
        if declaration.lockfiles.is_empty()
            || declaration.lockfiles.len() > 32
            || declaration.runtime_files.len() > 32
            || !plan.volumes.contains_key(&declaration.volume)
            || !service
                .mounts
                .iter()
                .any(|m| m.kind == "volume" && m.source == declaration.volume)
        {
            return Err(refused());
        }
        let mut inputs = BTreeMap::new();
        let mut present = 0;
        for path in &declaration.lockfiles {
            let entry = selected(manifest, path)?;
            if entry.is_some() {
                present += 1;
            } else if declaration.lockfiles_explicit {
                return Err(refused());
            }
            if inputs.insert(format!("lock:{path}"), entry).is_some() {
                return Err(refused());
            }
        }
        if present == 0 {
            return Err(refused());
        }
        for path in &declaration.runtime_files {
            if inputs
                .insert(format!("runtime:{path}"), selected(manifest, path)?)
                .is_some()
            {
                return Err(refused());
            }
        }
        // Compose digest binds actual argv text (the plan's argv representation is redacted).
        // Script content belongs in explicitly declared runtime files; whole source revisions
        // would prevent compatible branches with unrelated source changes from sharing.
        let base_fingerprint = hash(&(
            "hack-dependency-cache-v1",
            scope,
            &declaration.volume,
            image,
            &plan.compose_sha256,
            &plan.registry,
            declaration,
            &inputs,
            &public.command,
            &public.entrypoint,
            &public.environment,
            &public.user,
            &public.extra_hosts,
            &service.working_dir,
        ))?;
        // Include the whole shared-volume layout, not only initializer mounts.
        // Keep historical cache keys unchanged when no subpath is requested.
        let layout = plan
            .services
            .iter()
            .filter(|(_, s)| s.active)
            .flat_map(|(name, s)| {
                s.mounts
                    .iter()
                    .filter(|m| m.kind == "volume" && m.source == declaration.volume)
                    .map(move |m| (name, &m.target, &m.subpath, m.read_only))
            })
            .collect::<Vec<_>>();
        let fingerprint = if layout.iter().any(|(_, _, subpath, _)| subpath.is_some()) {
            hash(&("hack-cache-volume-subpaths-v1", base_fingerprint, layout))?
        } else {
            base_fingerprint
        };
        let binding = CacheBinding {
            scope: scope.into(),
            fingerprint,
            image: image.clone(),
        };
        if result
            .get(&declaration.volume)
            .is_some_and(|existing| existing != &binding)
        {
            return Err(refused());
        }
        result.insert(declaration.volume.clone(), binding);
    }
    Ok(result)
}

fn owned_directory(path: &Path) -> Result<PathBuf, CandidateError> {
    if !path.is_absolute() {
        return Err(refused());
    }
    let mut checked = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                if !checked.pop() {
                    return Err(refused());
                }
            }
            Component::CurDir => {}
            _ => {
                checked.push(component.as_os_str());
                if fs::symlink_metadata(&checked)
                    .map_err(|_| refused())?
                    .file_type()
                    .is_symlink()
                {
                    return Err(refused());
                }
            }
        }
    }
    let metadata = fs::symlink_metadata(&checked).map_err(|_| refused())?;
    // SAFETY: geteuid has no arguments or memory contract.
    if !metadata.is_dir() || metadata.uid() != unsafe { libc::geteuid() } {
        return Err(refused());
    }
    Ok(checked)
}
fn metadata_text(path: &Path) -> Result<String, CandidateError> {
    let mut file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|_| refused())?;
    let metadata = file.metadata().map_err(|_| refused())?;
    // SAFETY: geteuid has no arguments or memory contract.
    if !metadata.is_file()
        || metadata.nlink() != 1
        || metadata.len() > 4096
        || metadata.uid() != unsafe { libc::geteuid() }
    {
        return Err(refused());
    }
    let mut bytes = Vec::new();
    file.by_ref()
        .take(4097)
        .read_to_end(&mut bytes)
        .map_err(|_| refused())?;
    if bytes.len() as u64 != metadata.len() {
        return Err(refused());
    }
    let value = String::from_utf8(bytes).map_err(|_| refused())?;
    let value = value.strip_suffix('\n').unwrap_or(&value);
    if value.is_empty() || value.chars().any(char::is_control) {
        return Err(refused());
    }
    Ok(value.to_owned())
}
/// Uses bounded Git metadata only; never invokes Git or reads configuration/credentials.
pub fn scope(project: &Path) -> Result<String, CandidateError> {
    let project = owned_directory(project)?;
    let dotgit = project.join(".git");
    let metadata = match fs::symlink_metadata(&dotgit) {
        Ok(metadata) => Some(metadata),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => return Err(refused()),
    };
    let common = match metadata {
        None => project,
        Some(metadata) if metadata.is_dir() => owned_directory(&dotgit)?,
        Some(metadata) if metadata.is_file() => {
            let text = metadata_text(&dotgit)?;
            let gitdir = text.strip_prefix("gitdir: ").ok_or_else(refused)?;
            let gitdir = owned_directory(&project.join(gitdir))?;
            let common = metadata_text(&gitdir.join("commondir"))?;
            let common = owned_directory(&gitdir.join(common))?;
            if !gitdir.starts_with(common.join("worktrees")) {
                return Err(refused());
            }
            let backlink = metadata_text(&gitdir.join("gitdir"))?;
            if Path::new(&backlink) != dotgit {
                return Err(refused());
            }
            common
        }
        _ => return Err(refused()),
    };
    let metadata = fs::metadata(&common).map_err(|_| refused())?;
    hash(&(
        "hack-dependency-cache-scope-v1",
        common,
        metadata.dev(),
        metadata.ino(),
    ))
}

#[cfg(test)]
mod tests {
    use super::super::tests::Fixture;
    use super::*;
    use crate::Candidate;
    use crate::project::{self, PlanOptions, snapshot};
    use std::{collections::BTreeSet, os::unix::fs::symlink};

    fn prepared() -> (Fixture, Fixture, PlanData, ContentRevision) {
        let source = Fixture::new();
        let home = Fixture::new();
        fs::write(source.0.join("bun.lock"), "lock-v1").unwrap();
        fs::write(source.0.join("package.json"), "{}").unwrap();
        let compose = json!({"services":{"deps":{"image":format!("sha256:{}","a".repeat(64)),"volumes":["deps:/deps"],"entrypoint":["/bin/install"],"labels":{"hack.dependencies.cache-volume":"deps","hack.dependencies.lockfiles":"bun.lock","hack.dependencies.runtime-files":"package.json,optional.json","hack.dependencies.bootstrap":"true"}}},"volumes":{"deps":{}}});
        fs::write(source.0.join("compose.yaml"), compose.to_string()).unwrap();
        let candidate = Candidate::discover(&home.0).unwrap();
        let plan = project::plan(
            &candidate,
            PlanOptions {
                project: &source.0,
                compose_file: Path::new("compose.yaml"),
                profiles: &[],
            },
        )
        .unwrap()
        .plan;
        let snapshot = snapshot::capture(
            &source.0,
            &BTreeSet::new(),
            &plan.source_selection.metadata_sha256,
        )
        .unwrap();
        (source, home, plan, snapshot.receipt().clone())
    }
    fn executable(plan: &PlanData) -> BTreeMap<String, crate::project::inputs::ServiceInputs> {
        plan.services
            .keys()
            .map(|name| {
                (
                    name.clone(),
                    crate::project::inputs::ServiceInputs {
                        command: None,
                        entrypoint: Some(vec!["/bin/install".into()]),
                        environment: vec!["MODE=public".into()],
                        user: Some("1001:1002".into()),
                        extra_hosts: BTreeMap::new(),
                        health_test: None,
                    },
                )
            })
            .collect()
    }
    fn resolve(
        plan: &PlanData,
        manifest: &ContentRevision,
        scope: &str,
    ) -> Result<BTreeMap<String, CacheBinding>, CandidateError> {
        super::resolve(plan, manifest, scope, &executable(plan))
    }
    fn resign(manifest: &mut ContentRevision) {
        manifest.entries.sort_by(|a, b| a.path.cmp(&b.path));
        manifest.total_bytes = manifest.entries.iter().map(|e| e.bytes).sum();
        manifest.revision = match manifest.schema_version {
            1 => hash(&(1_u32, &manifest.entries)),
            2 => hash(&(2_u32, &manifest.selection_sha256, &manifest.entries)),
            _ => panic!("unknown fixture manifest version"),
        }
        .unwrap();
    }
    #[test]
    fn subpath_layout_changes_cache_identity_without_compose_digest_shortcut() {
        let (_source, _home, mut plan, manifest) = prepared();
        let original = resolve(&plan, &manifest, &"a".repeat(64)).unwrap();
        plan.services.get_mut("deps").unwrap().mounts[0].subpath = Some("workspaces/one".into());
        let first = resolve(&plan, &manifest, &"a".repeat(64)).unwrap();
        assert_ne!(original, first);
        plan.services.get_mut("deps").unwrap().mounts[0].subpath = Some("workspaces/two".into());
        assert_ne!(first, resolve(&plan, &manifest, &"a".repeat(64)).unwrap());
    }

    #[test]
    fn identities_bind_inputs_image_scope_and_declared_missing_files() {
        let (_source, _home, plan, manifest) = prepared();
        let scope = "a".repeat(64);
        let baseline = resolve(&plan, &manifest, &scope).unwrap();
        let binding = &baseline["deps"];
        assert!(binding.valid());
        assert_eq!(binding.name().len(), 78);
        assert_eq!(
            binding.labels("owner", "deps")["io.hack-local.kind"],
            "dependency-cache"
        );
        assert_ne!(
            baseline,
            resolve(&plan, &manifest, &"b".repeat(64)).unwrap()
        );
        for path in ["bun.lock", "package.json"] {
            let mut changed = manifest.clone();
            changed
                .entries
                .iter_mut()
                .find(|e| e.path == path)
                .unwrap()
                .sha256 = Some("c".repeat(64));
            resign(&mut changed);
            assert_ne!(baseline, resolve(&plan, &changed, &scope).unwrap());
        }
        let mut present = manifest.clone();
        present.entries.push(snapshot::ContentEntry {
            path: "optional.json".into(),
            kind: "file".into(),
            executable: false,
            bytes: 0,
            sha256: Some("d".repeat(64)),
            link_target: None,
        });
        resign(&mut present);
        assert_ne!(baseline, resolve(&plan, &present, &scope).unwrap());
        let mut unrelated = manifest.clone();
        unrelated.entries.push(snapshot::ContentEntry {
            path: "unrelated.txt".into(),
            kind: "file".into(),
            executable: false,
            bytes: 0,
            sha256: Some("e".repeat(64)),
            link_target: None,
        });
        resign(&mut unrelated);
        assert_eq!(baseline, resolve(&plan, &unrelated, &scope).unwrap());
        let mut dynamic = plan.clone();
        dynamic
            .services
            .get_mut("deps")
            .unwrap()
            .entrypoint
            .as_mut()
            .unwrap()
            .arguments[0]
            .environment_references
            .push("INSTALLER".into());
        assert_eq!(baseline, resolve(&dynamic, &manifest, &scope).unwrap());
        for field in [
            "command",
            "entrypoint",
            "environment",
            "user",
            "extra_hosts",
        ] {
            let mut values = executable(&dynamic);
            let value = values.get_mut("deps").unwrap();
            match field {
                "command" => value.command = Some(vec!["--new".into()]),
                "entrypoint" => value.entrypoint = Some(vec!["/bin/other".into()]),
                "environment" => value.environment.push("PUBLIC_VARIANT=changed".into()),
                "user" => value.user = Some("1002:1003".into()),
                _ => {
                    value
                        .extra_hosts
                        .insert("registry.example".into(), "host-gateway".into());
                }
            }
            assert_ne!(
                baseline,
                super::resolve(&dynamic, &manifest, &scope, &values).unwrap()
            );
        }
        assert!(super::resolve(&plan, &manifest, &scope, &BTreeMap::new()).is_err());
        let mut changed = plan.clone();
        changed.services.get_mut("deps").unwrap().image =
            Some(format!("sha256:{}", "e".repeat(64)));
        assert_ne!(baseline, resolve(&changed, &manifest, &scope).unwrap());
        changed = plan.clone();
        changed.compose_sha256 = "f".repeat(64);
        assert_ne!(baseline, resolve(&changed, &manifest, &scope).unwrap());
        changed = plan.clone();
        let mut other = changed.services["deps"].clone();
        other.dependency_cache.as_mut().unwrap().bootstrap = false;
        changed.services.insert("other".into(), other);
        assert!(resolve(&changed, &manifest, &scope).is_err());
        changed
            .services
            .get_mut("other")
            .unwrap()
            .dependency_cache
            .as_mut()
            .unwrap()
            .bootstrap = true;
        assert_eq!(baseline, resolve(&changed, &manifest, &scope).unwrap());
    }
    #[test]
    fn missing_lockfiles_and_symlink_inputs_refuse() {
        let (_source, _home, mut plan, mut manifest) = prepared();
        let scope = "a".repeat(64);
        manifest.entries.retain(|e| e.path != "bun.lock");
        resign(&mut manifest);
        assert!(resolve(&plan, &manifest, &scope).is_err());
        plan.services
            .get_mut("deps")
            .unwrap()
            .dependency_cache
            .as_mut()
            .unwrap()
            .lockfiles_explicit = false;
        assert!(resolve(&plan, &manifest, &scope).is_err());
        manifest.entries.push(snapshot::ContentEntry {
            path: "bun.lock".into(),
            kind: "symlink".into(),
            executable: false,
            bytes: 0,
            sha256: None,
            link_target: Some("package.json".into()),
        });
        resign(&mut manifest);
        assert!(resolve(&plan, &manifest, &scope).is_err());
    }
    #[test]
    fn linked_worktrees_share_scope_but_independent_repositories_do_not() {
        let primary = Fixture::new();
        let linked = Fixture::new();
        let other = Fixture::new();
        fs::create_dir(primary.0.join(".git")).unwrap();
        fs::create_dir(other.0.join(".git")).unwrap();
        let metadata = primary.0.join(".git/worktrees/linked");
        fs::create_dir_all(&metadata).unwrap();
        fs::write(
            linked.0.join(".git"),
            format!("gitdir: {}\n", metadata.display()),
        )
        .unwrap();
        fs::write(metadata.join("commondir"), "../..\n").unwrap();
        fs::write(
            metadata.join("gitdir"),
            format!("{}\n", linked.0.join(".git").display()),
        )
        .unwrap();
        assert_eq!(scope(&primary.0).unwrap(), scope(&linked.0).unwrap());
        assert_ne!(scope(&primary.0).unwrap(), scope(&other.0).unwrap());
        fs::remove_file(metadata.join("commondir")).unwrap();
        symlink("../../HEAD", metadata.join("commondir")).unwrap();
        assert!(scope(&linked.0).is_err());
        let plain = Fixture::new();
        assert_eq!(scope(&plain.0).unwrap(), scope(&plain.0).unwrap());
    }
}
