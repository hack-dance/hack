//! Explicit frontend-normalized input. This is a review API, not an execution bypass.
use super::{PlanOptions, PlanReport, plan_input, problem, yaml};
use crate::{Candidate, CandidateError};
use sha2::{Digest, Sha256};
use std::path::Path;

/// A frontend may merge non-secret Compose declarations in memory, preserving
/// the original Compose-relative path base. Values requiring private delivery
/// should remain references and be supplied separately through managed stdin.
///
/// First select `expected_namespace` using `Candidate::plan(project)` and hash the
/// original selected Compose bytes. Then submit the bounded normalized bytes here.
/// The original file must still exist inside the selected project, outside all
/// excluded/credential paths. Neither it nor generated state is written by this API.
///
/// The returned plan fingerprints the supplied bytes and source selection. It is
/// equivalent to `project::plan` when the supplied bytes equal the original input.
/// Retain this explicit input for `inputs::compile_scoped_normalized`; ordinary
/// file-based execution deliberately refuses its plan ID when normalization differs.
#[derive(Clone, Copy)]
pub struct NormalizedComposeOptions<'a> {
    pub project: &'a Path,
    pub expected_namespace: &'a str,
    pub compose_file: &'a Path,
    pub expected_compose_sha256: &'a str,
    pub compose_bytes: &'a [u8],
    pub profiles: &'a [String],
}

pub(super) struct Input<'a> {
    pub bytes: &'a [u8],
    namespace: &'a str,
    original_sha256: &'a str,
}
impl Input<'_> {
    pub(super) fn verify(&self, namespace: &str, original: &[u8]) -> Result<(), CandidateError> {
        if self.bytes.is_empty()
            || self.bytes.len() > yaml::MAX_BYTES
            || self.namespace != namespace
            || self.original_sha256 != format!("{:x}", Sha256::digest(original))
        {
            return Err(problem(
                "normalized_compose_input",
                "Normalized Compose input is oversized or its selected project/original configuration changed; values omitted.",
            ));
        }
        Ok(())
    }
}

pub fn plan_normalized(
    candidate: &Candidate,
    options: NormalizedComposeOptions<'_>,
) -> Result<PlanReport, CandidateError> {
    plan_input(
        candidate,
        PlanOptions {
            project: options.project,
            compose_file: options.compose_file,
            profiles: options.profiles,
        },
        Some(Input {
            bytes: options.compose_bytes,
            namespace: options.expected_namespace,
            original_sha256: options.expected_compose_sha256,
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::{self, PlanOptions};
    use std::{
        fs,
        path::PathBuf,
        sync::atomic::{AtomicUsize, Ordering},
    };
    const ORIGINAL: &str =
        "services:\n  web:\n    image: alpine:3.21\n    volumes: [../src:/app]\n";
    struct Fixture {
        root: PathBuf,
        project: PathBuf,
        candidate: Candidate,
        namespace: String,
        hash: String,
    }
    impl Fixture {
        fn new() -> Self {
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let root = std::env::temp_dir().join(format!(
                "hack-normalized-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&root).unwrap();
            let project = root.join("project");
            fs::create_dir_all(project.join(".hack")).unwrap();
            fs::create_dir(project.join("src")).unwrap();
            fs::write(project.join("src/app.ts"), "public source").unwrap();
            fs::write(project.join(".hack/compose.yml"), ORIGINAL).unwrap();
            let checkout = root.join("candidate");
            fs::create_dir(&checkout).unwrap();
            let candidate = Candidate::discover(&checkout).unwrap();
            let namespace = candidate.plan(&project).unwrap().namespace;
            Self {
                root,
                project,
                candidate,
                namespace,
                hash: format!("{:x}", Sha256::digest(ORIGINAL.as_bytes())),
            }
        }
        fn options<'a>(&'a self, bytes: &'a [u8]) -> NormalizedComposeOptions<'a> {
            NormalizedComposeOptions {
                project: &self.project,
                expected_namespace: &self.namespace,
                compose_file: Path::new(".hack/compose.yml"),
                expected_compose_sha256: &self.hash,
                compose_bytes: bytes,
                profiles: &[],
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.root).unwrap();
        }
    }
    #[test]
    fn identical_input_preserves_plan_and_original_relative_base() {
        let fixture = Fixture::new();
        let normal = project::plan(
            &fixture.candidate,
            PlanOptions {
                project: &fixture.project,
                compose_file: Path::new(".hack/compose.yml"),
                profiles: &[],
            },
        )
        .unwrap();
        let adapted =
            plan_normalized(&fixture.candidate, fixture.options(ORIGINAL.as_bytes())).unwrap();
        assert_eq!(normal.plan_id, adapted.plan_id);
        assert_eq!(
            serde_json::to_value(normal.plan).unwrap(),
            serde_json::to_value(adapted.plan).unwrap()
        );
        assert!(!fixture.candidate.state_root.exists());
    }
    #[test]
    fn changed_input_changes_fingerprint_without_modifying_original() {
        let fixture = Fixture::new();
        let a = plan_normalized(&fixture.candidate, fixture.options(ORIGINAL.as_bytes())).unwrap();
        let changed = ORIGINAL.replace("alpine:3.21", "alpine:3.22");
        let b = plan_normalized(&fixture.candidate, fixture.options(changed.as_bytes())).unwrap();
        assert_ne!(a.plan_id, b.plan_id);
        assert_ne!(a.plan.compose_sha256, b.plan.compose_sha256);
        assert_eq!(a.plan.source, b.plan.source);
        assert_eq!(
            fs::read_to_string(fixture.project.join(".hack/compose.yml")).unwrap(),
            ORIGINAL
        );
    }
    #[test]
    fn project_original_digest_and_size_must_match() {
        let fixture = Fixture::new();
        let mut options = fixture.options(ORIGINAL.as_bytes());
        options.expected_namespace = "wrong";
        assert_eq!(
            plan_normalized(&fixture.candidate, options)
                .unwrap_err()
                .code,
            "normalized_compose_input"
        );
        let mut options = fixture.options(ORIGINAL.as_bytes());
        options.expected_compose_sha256 = "wrong";
        assert!(plan_normalized(&fixture.candidate, options).is_err());
        assert!(
            plan_normalized(
                &fixture.candidate,
                fixture.options(&vec![b'x'; yaml::MAX_BYTES + 1])
            )
            .is_err()
        );
        fs::write(fixture.project.join(".hack/compose.yml"), "services: {}\n").unwrap();
        assert!(plan_normalized(&fixture.candidate, fixture.options(ORIGINAL.as_bytes())).is_err());
    }
    #[test]
    fn escaping_and_excluded_mounts_and_configuration_paths_remain_refused() {
        let fixture = Fixture::new();
        fs::create_dir_all(fixture.project.join(".hack/.internal")).unwrap();
        fs::write(
            fixture.project.join(".hack/.internal/private"),
            "SECRET_CANARY",
        )
        .unwrap();
        fs::write(fixture.project.join(".env"), "TOKEN=SECRET_CANARY").unwrap();
        for mount in [
            "../../outside:/app",
            "../.env:/app/env",
            ".internal/private:/app/private",
        ] {
            let bytes =
                format!("services:\n  web:\n    image: alpine:3.21\n    volumes: ['{mount}']\n");
            assert!(
                plan_normalized(&fixture.candidate, fixture.options(bytes.as_bytes())).is_err()
            );
        }
        for file in [
            fixture.root.join("outside.yml"),
            fixture.project.join(".hack/.internal/private"),
        ] {
            let mut options = fixture.options(ORIGINAL.as_bytes());
            options.compose_file = &file;
            assert!(plan_normalized(&fixture.candidate, options).is_err());
        }
        let adapted =
            plan_normalized(&fixture.candidate, fixture.options(ORIGINAL.as_bytes())).unwrap();
        let text = serde_json::to_string(&adapted).unwrap();
        assert!(!text.contains("SECRET_CANARY"));
        assert!(
            !adapted
                .plan
                .source_selection
                .entries
                .iter()
                .any(|e| e.path == ".env" || e.path.starts_with(".hack/.internal"))
        );
    }
    #[test]
    fn normalized_compilation_uses_reviewed_bytes_and_keeps_private_values_separate() {
        use std::collections::BTreeMap;
        let fixture = Fixture::new();
        let bytes=b"services:\n  web:\n    image: alpine:3.21\n    command: [echo, normalized]\n    environment: [TOKEN]\n";
        let review = plan_normalized(&fixture.candidate, fixture.options(bytes)).unwrap();
        let managed = BTreeMap::from([(
            "web".into(),
            BTreeMap::from([("TOKEN".into(), "PRIVATE_CANARY".into())]),
        )]);
        let compiled = project::inputs::compile_scoped_normalized(
            &fixture.candidate,
            fixture.options(bytes),
            &review.plan_id,
            &BTreeMap::new(),
            &managed,
        )
        .unwrap();
        assert_eq!(
            compiled.executable.services["web"].command,
            Some(vec!["echo".into(), "normalized".into()])
        );
        assert_eq!(
            compiled.managed_environment["web"]["TOKEN"],
            "PRIVATE_CANARY"
        );
        assert!(
            compiled.executable.services["web"]
                .environment
                .iter()
                .all(|value| !value.contains("PRIVATE_CANARY"))
        );
        assert!(
            !serde_json::to_string(&compiled.executable.review)
                .unwrap()
                .contains("PRIVATE_CANARY")
        );
        assert!(
            project::inputs::compile_scoped_normalized(
                &fixture.candidate,
                fixture.options(ORIGINAL.as_bytes()),
                &review.plan_id,
                &BTreeMap::new(),
                &managed
            )
            .is_err()
        );
        assert!(
            project::inputs::compile_scoped(
                &fixture.candidate,
                PlanOptions {
                    project: &fixture.project,
                    compose_file: Path::new(".hack/compose.yml"),
                    profiles: &[]
                },
                &review.plan_id,
                &BTreeMap::new(),
                &managed
            )
            .is_err()
        );
        fs::write(fixture.project.join(".hack/compose.yml"), "services: {}\n").unwrap();
        assert!(
            project::inputs::compile_scoped_normalized(
                &fixture.candidate,
                fixture.options(bytes),
                &review.plan_id,
                &BTreeMap::new(),
                &managed
            )
            .is_err()
        );
    }
    #[test]
    fn changed_original_changes_normalized_review_even_when_normalized_bytes_match() {
        let mut fixture = Fixture::new();
        let bytes = b"services:\n  web:\n    image: alpine:3.22\n";
        let before = plan_normalized(&fixture.candidate, fixture.options(bytes)).unwrap();
        let original = ORIGINAL.replace("alpine:3.21", "alpine:3.23");
        fs::write(fixture.project.join(".hack/compose.yml"), &original).unwrap();
        fixture.hash = format!("{:x}", Sha256::digest(original.as_bytes()));
        let after = plan_normalized(&fixture.candidate, fixture.options(bytes)).unwrap();
        assert_eq!(before.plan.compose_sha256, after.plan.compose_sha256);
        assert_ne!(
            before.plan.original_compose_sha256,
            after.plan.original_compose_sha256
        );
        assert_ne!(before.plan_id, after.plan_id);
    }
    #[test]
    fn malformed_normalized_input_does_not_echo_values() {
        let fixture = Fixture::new();
        let error = plan_normalized(
            &fixture.candidate,
            fixture.options(b"services: [PRIVATE_CANARY\n"),
        )
        .unwrap_err();
        assert!(!error.message.contains("PRIVATE_CANARY"));
    }
    #[test]
    fn removing_original_env_files_or_services_preserves_secret_source_exclusions() {
        let mut fixture = Fixture::new();
        fs::create_dir(fixture.project.join("config")).unwrap();
        fs::write(
            fixture.project.join("config/private-vars.txt"),
            "TOKEN=PRIVATE_FILE_CANARY",
        )
        .unwrap();
        let original = "services:\n  discarded:\n    image: alpine:3.21\n    env_file: ../config/private-vars.txt\n  web:\n    image: alpine:3.21\n";
        fs::write(fixture.project.join(".hack/compose.yml"), original).unwrap();
        fixture.hash = format!("{:x}", Sha256::digest(original.as_bytes()));
        for normalized in [
            b"services:\n  web:\n    image: alpine:3.21\n".as_slice(),
            b"services:\n  discarded:\n    image: alpine:3.21\n  web:\n    image: alpine:3.21\n"
                .as_slice(),
        ] {
            let review = plan_normalized(&fixture.candidate, fixture.options(normalized)).unwrap();
            assert!(
                !review
                    .plan
                    .source_selection
                    .entries
                    .iter()
                    .any(|entry| entry.path == "config/private-vars.txt")
            );
            let snapshot = project::snapshot::capture_plan(&review.plan).unwrap();
            assert!(!snapshot.files().any(|(entry, bytes)| {
                entry.path == "config/private-vars.txt"
                    || bytes
                        .windows(b"PRIVATE_FILE_CANARY".len())
                        .any(|window| window == b"PRIVATE_FILE_CANARY")
            }));
            assert!(
                !serde_json::to_string(&review)
                    .unwrap()
                    .contains("PRIVATE_FILE_CANARY")
            );
        }
    }
}
