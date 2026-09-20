//! Explicit normalized configuration through admission; bytes and values stay in memory.
use super::*;
use crate::project::{NormalizedComposeOptions, inputs::ScopedExecutionInputs};
use std::time::Instant;

/// Carries the frontend's reviewed input alongside ordinary graph ownership/readiness.
/// The project/file/profiles must agree across both options. Plan, source publication,
/// and admission must all use this same input; file-based replay is not a substitute.
pub struct NormalizedRunOptions<'a> {
    pub run: RunOptions<'a>,
    pub compose: NormalizedComposeOptions<'a>,
}

/// Hash-only provenance. Normalized configuration and managed values are never journaled.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NormalizedInputIdentity {
    pub namespace: String,
    pub original_compose_sha256: String,
    pub normalized_compose_sha256: String,
}
impl NormalizedInputIdentity {
    pub(super) fn valid(&self, namespace: &str) -> bool {
        self.namespace == namespace
            && [
                &self.namespace,
                &self.original_compose_sha256,
                &self.normalized_compose_sha256,
            ]
            .iter()
            .all(|v| hex(v, 64))
    }
}

pub(super) fn replay_refused() -> CandidateError {
    error(
        "graph_normalized_replay",
        "Normalized graph restart/restore requires explicit normalized-input recovery, which is not implemented. Inspect or clean up this owned run; retained data is not removed.",
    )
}
pub(super) fn require_file_replay(receipt: &Receipt) -> Result<(), CandidateError> {
    if receipt.normalized_input.is_some() {
        return Err(replay_refused());
    }
    Ok(())
}

/// Pure review/compilation for frontend preflight before constructing a relay owner.
/// Startup repeats this check; callers cannot substitute cached executable inputs.
/// Managed values remain separated from public engine configuration.
pub fn compile_normalized_inputs(
    candidate: &Candidate,
    options: &NormalizedRunOptions<'_>,
    managed: &BTreeMap<String, BTreeMap<String, String>>,
) -> Result<ScopedExecutionInputs, CandidateError> {
    if options.run.live_source {
        return Err(error(
            "graph_normalized_live_source",
            "Normalized graphs require immutable source publication; live-source replay is not supported.",
        ));
    }
    let run = &options.run;
    let compose = &options.compose;
    if run.project.project != compose.project
        || run.project.compose_file != compose.compose_file
        || run.project.profiles != compose.profiles
    {
        return Err(error(
            "graph_normalized_selection",
            "Normalized graph input must match the selected project, original Compose base and profiles.",
        ));
    }
    project::inputs::compile_scoped_normalized(
        candidate,
        *compose,
        run.expected_plan,
        run.non_secret_values,
        managed,
    )
}

/// Fresh attempt using normalized bytes, with an ingress-anchored private-input deadline.
/// Source snapshots must come from the normalized plan's source selection. No restart
/// or restore support is implied; those operations retain data and refuse explicitly.
pub fn run_normalized(
    candidate: &Candidate,
    options: NormalizedRunOptions<'_>,
    managed: &BTreeMap<String, BTreeMap<String, String>>,
    deadline: Instant,
) -> Result<Receipt, CandidateError> {
    run_until(candidate, options, managed, deadline, None)
}

#[cfg(target_os = "macos")]
pub fn run_normalized_with_host_dependencies_until(
    candidate: &Candidate,
    options: NormalizedRunOptions<'_>,
    runtime: &mut HostRelayRuntime,
    managed: &BTreeMap<String, BTreeMap<String, String>>,
    deadline: Instant,
) -> Result<Receipt, CandidateError> {
    run_until(candidate, options, managed, deadline, Some(runtime))
}

fn run_until(
    candidate: &Candidate,
    options: NormalizedRunOptions<'_>,
    managed: &BTreeMap<String, BTreeMap<String, String>>,
    deadline: Instant,
    startup: Option<&mut dyn startup::Driver>,
) -> Result<Receipt, CandidateError> {
    if let Some(driver) = startup.as_ref() {
        driver.check_cancelled()?;
    }
    check_environment_deadline(deadline)?;
    let compiled = compile_normalized_inputs(candidate, &options, managed)?;
    if !compiled.managed_environment.is_empty() && !cfg!(feature = "environment-launcher") {
        return Err(error(
            "environment_launcher_disabled",
            "Build with environment-launcher for private input delivery.",
        ));
    }
    let environments = compiled
        .managed_environment
        .iter()
        .map(|(name, values)| {
            super::super::environment::PendingEnvironment::until(name, values, deadline)
                .map(|v| (name.clone(), v))
        })
        .collect::<Result<BTreeMap<_, _>, _>>()?;
    let identity = NormalizedInputIdentity {
        namespace: compiled.executable.review.plan.namespace.clone(),
        original_compose_sha256: options.compose.expected_compose_sha256.into(),
        normalized_compose_sha256: compiled.executable.review.plan.compose_sha256.clone(),
    };
    check_environment_deadline(deadline)?;
    run_inputs(
        candidate,
        options.run,
        compiled.executable,
        environments,
        startup,
        Some(identity),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::path::Path;

    #[test]
    fn normalized_receipt_cannot_be_replayed_as_original() {
        let mut receipt: Receipt = serde_json::from_value(json!({"version":1,"run":"a".repeat(32),"owner":"b".repeat(32),"namespace":"c".repeat(64),"plan_id":"d".repeat(64),"phase":"ready","readiness":{},"resources":{}})).unwrap();
        assert!(require_file_replay(&receipt).is_ok());
        receipt.normalized_input = Some(NormalizedInputIdentity {
            namespace: receipt.namespace.clone(),
            original_compose_sha256: "e".repeat(64),
            normalized_compose_sha256: "f".repeat(64),
        });
        let bytes = serde_json::to_vec(&receipt).unwrap();
        let reloaded: Receipt = serde_json::from_slice(&bytes).unwrap();
        assert!(
            reloaded
                .normalized_input
                .as_ref()
                .unwrap()
                .valid(&receipt.namespace)
        );
        assert!(
            !reloaded
                .normalized_input
                .as_ref()
                .unwrap()
                .valid(&"a".repeat(64))
        );
        assert_eq!(
            require_file_replay(&reloaded).unwrap_err().code,
            "graph_normalized_replay"
        );
        assert_eq!(bytes, serde_json::to_vec(&reloaded).unwrap());
    }

    #[test]
    fn admission_rejects_mismatched_review_and_original_before_provider_effects() {
        let root = std::env::temp_dir().join(format!("hkg-normalized-{}", std::process::id()));
        fs::create_dir(&root).unwrap();
        let result = std::panic::catch_unwind(|| {
            let project = root.join("project");
            let checkout = root.join("candidate");
            fs::create_dir(&project).unwrap();
            fs::create_dir(&checkout).unwrap();
            let original = "services:\n  web:\n    image: alpine:3.21\n";
            fs::write(project.join("compose.yml"), original).unwrap();
            let candidate = Candidate::discover(&checkout).unwrap();
            let namespace = candidate.plan(&project).unwrap().namespace;
            let hash = format!("{:x}", Sha256::digest(original));
            let normalized =
                b"services:\n  web:\n    image: alpine:3.21\n    command: [echo, normalized]\n";
            let compose = NormalizedComposeOptions {
                project: &project,
                expected_namespace: &namespace,
                compose_file: Path::new("compose.yml"),
                expected_compose_sha256: &hash,
                compose_bytes: normalized,
                profiles: &[],
            };
            let review = project::plan_normalized(&candidate, compose).unwrap();
            let values = BTreeMap::new();
            let readiness = BTreeMap::new();
            let make = || NormalizedRunOptions {
                compose,
                run: RunOptions {
                    live_source: false,
                    shared_source: false,
                    release_initializer_cache: BTreeSet::new(),
                    routing_enrolled: false,
                    project: PlanOptions {
                        project: &project,
                        compose_file: Path::new("compose.yml"),
                        profiles: &[],
                    },
                    expected_plan: &review.plan_id,
                    source_revision: None,
                    non_secret_values: &values,
                    readiness: &readiness,
                    run_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    timeout: Duration::from_secs(1),
                },
            };
            let compiled =
                compile_normalized_inputs(&candidate, &make(), &BTreeMap::new()).unwrap();
            assert_eq!(compiled.executable.review.plan_id, review.plan_id);
            for kind in 0..4 {
                let mut options = make();
                match kind {
                    0 => options.run.expected_plan = "wrong",
                    1 => options.compose.expected_compose_sha256 = "wrong",
                    2 => options.run.project.compose_file = Path::new("other.yml"),
                    _ => options.compose.expected_namespace = "wrong",
                }
                assert!(
                    run_normalized(
                        &candidate,
                        options,
                        &BTreeMap::new(),
                        Instant::now() + Duration::from_secs(10)
                    )
                    .is_err()
                );
                assert!(!candidate.state_root.exists());
            }
        });
        fs::remove_dir_all(&root).unwrap();
        result.unwrap();
    }
}
