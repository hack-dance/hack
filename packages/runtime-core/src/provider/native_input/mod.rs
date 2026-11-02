//! Native preparation provenance, separate from Compose graph ownership and enrollment.
//! No provider consumes these artifacts yet. They never authorize runtime effects.
mod storage;
use super::{environment::PendingEnvironment, private_deadline::Deadline};
use crate::{
    CandidateError,
    project::native::{self, CompileOptions, ManagedValues, NativeInputs, ReviewIdentity},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, time::Instant};
pub(in crate::provider) use storage::read_file;
pub use storage::{load, publish};

const MAX_ARTIFACT_BYTES: usize = 8192;
const IDENTITY_DOMAIN: &[u8] = b"hack.native-graph-review/v1\0";

/// Explicit caller-selected project/branch namespace and fresh attempt ID.
/// Selection must come from the candidate's project namespace, never a Compose hash.
#[derive(Clone, Copy)]
pub struct Scope<'a> {
    pub namespace: &'a str,
    pub run: &'a str,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum InputKind {
    Native,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Provenance {
    version: u32,
    kind: InputKind,
    namespace: String,
    run: String,
    input: ReviewIdentity,
}

/// Hash-only native review. This is not normalized Compose provenance or provider ownership.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Review {
    provenance: Provenance,
    review_id: String,
}

fn refused() -> CandidateError {
    CandidateError::new(
        "native_input_refused",
        "Native provenance requires its explicit version/kind, bounded compiler identity and exact project/run selection; values omitted.",
    )
}
fn stale() -> CandidateError {
    CandidateError::new(
        "native_input_stale",
        "Fresh native compiler input differs from the reviewed native provenance; private delivery was not prepared.",
    )
}
fn artifact_refused() -> CandidateError {
    CandidateError::new(
        "native_input_artifact",
        "Native preparation artifact is missing, unsafe, interrupted or changed; retained evidence was not repaired or adopted.",
    )
}
fn hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn valid_scope(scope: Scope<'_>) -> bool {
    hex(scope.namespace, 64) && hex(scope.run, 32)
}
fn valid_profiles(profiles: &[String]) -> bool {
    profiles.len() <= 64
        && profiles.iter().all(|profile| {
            !profile.is_empty() && profile.len() <= 256 && !profile.chars().any(char::is_control)
        })
        && profiles.windows(2).all(|pair| pair[0] < pair[1])
        && serde_json::to_vec(profiles).is_ok_and(|bytes| bytes.len() <= 4096)
}
fn identity(provenance: &Provenance) -> Result<String, CandidateError> {
    let bytes = serde_json::to_vec(provenance).map_err(|_| refused())?;
    if bytes.len() > MAX_ARTIFACT_BYTES {
        return Err(refused());
    }
    let mut hash = Sha256::new();
    hash.update(IDENTITY_DOMAIN);
    hash.update(bytes);
    Ok(format!("{:x}", hash.finalize()))
}
impl Review {
    pub(crate) fn new(scope: Scope<'_>, input: ReviewIdentity) -> Result<Self, CandidateError> {
        let provenance = Provenance {
            version: 1,
            kind: InputKind::Native,
            namespace: scope.namespace.into(),
            run: scope.run.into(),
            input,
        };
        let review = Self {
            review_id: identity(&provenance)?,
            provenance,
        };
        review.validate(scope)?;
        Ok(review)
    }
    pub(crate) fn validate(&self, scope: Scope<'_>) -> Result<(), CandidateError> {
        let provenance = &self.provenance;
        let input = &provenance.input;
        if !valid_scope(scope)
            || provenance.version != 1
            || provenance.namespace != scope.namespace
            || provenance.run != scope.run
            || ![
                &input.semantic_hash,
                &input.local_resolution_hash,
                &input.environment_policy_hash,
            ]
            .iter()
            .all(|hash| hex(hash, 64))
            || !valid_profiles(&input.selected_profiles)
            || !hex(&self.review_id, 64)
            || identity(provenance)? != self.review_id
        {
            return Err(refused());
        }
        Ok(())
    }
    pub fn review_id(&self) -> &str {
        &self.review_id
    }
    pub fn compiler_identity(&self) -> &ReviewIdentity {
        &self.provenance.input
    }
    pub(crate) fn scope(&self) -> Scope<'_> {
        Scope {
            namespace: &self.provenance.namespace,
            run: &self.provenance.run,
        }
    }
}

/// Recompile public metadata with the owning compiler. No credential acquisition or state effects.
pub fn review(
    request: &[u8],
    profiles: &[String],
    scope: Scope<'_>,
) -> Result<Review, CandidateError> {
    if !valid_scope(scope) {
        return Err(refused());
    }
    Review::new(scope, native::review(request, profiles)?)
}

pub struct PrepareOptions<'a> {
    pub compile: CompileOptions<'a>,
    pub scope: Scope<'a>,
    pub expected_review: &'a Review,
    /// Ingress deadline; compilation/preparation/conversion can shorten it, never renew it.
    pub deadline: Instant,
}

/// Ephemeral private preparation; deliberately without Debug/Serialize or mutable input access.
/// No guest staging, source/image admission, provider creation or receipt ownership is implied.
pub struct Prepared {
    review: Review,
    inputs: NativeInputs,
    environments: BTreeMap<String, PendingEnvironment>,
    deadline: Deadline,
}
// Ensure all copied selected values are erased on success and every preparation error.
// The caller retains ownership of the original input map.
struct SelectedValues(ManagedValues);
impl Drop for SelectedValues {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        for values in self.0.values_mut() {
            for value in values.values_mut() {
                value.zeroize();
            }
        }
    }
}
impl Prepared {
    pub fn review(&self) -> &Review {
        &self.review
    }
    pub fn inputs(&self) -> &NativeInputs {
        &self.inputs
    }
    pub fn remaining(&self) -> Result<Instant, CandidateError> {
        self.deadline.to_instant()
    }
    pub(in crate::provider) fn private_services(&self) -> std::collections::BTreeSet<String> {
        self.environments.keys().cloned().collect()
    }
    /// Transfer once; a future consumer must retain the deadline and recheck effect admission.
    pub fn into_parts(
        self,
    ) -> Result<(NativeInputs, BTreeMap<String, PendingEnvironment>), CandidateError> {
        self.remaining()?;
        Ok((self.inputs, self.environments))
    }
}

pub fn prepare(options: PrepareOptions<'_>) -> Result<Prepared, CandidateError> {
    options.expected_review.validate(options.scope)?;
    let deadline = Deadline::from_instant(options.deadline)?;
    let inputs = native::compile(options.compile)?;
    finish_prepare(options.scope, options.expected_review, deadline, inputs)
}

pub(crate) fn prepare_frontend(
    options: PrepareOptions<'_>,
    hooks: &native::FrontendHooks,
) -> Result<Prepared, CandidateError> {
    options.expected_review.validate(options.scope)?;
    let deadline = Deadline::from_instant(options.deadline)?;
    let inputs = native::compile_frontend(options.compile, hooks)?;
    finish_prepare(options.scope, options.expected_review, deadline, inputs)
}

fn finish_prepare(
    scope: Scope<'_>,
    expected_review: &Review,
    deadline: Deadline,
    mut inputs: native::NativeInputs,
) -> Result<Prepared, CandidateError> {
    let private = SelectedValues(std::mem::take(&mut inputs.managed_environment));
    let fresh = Review::new(scope, inputs.review_identity())?;
    deadline.to_instant()?;
    if &fresh != expected_review {
        return Err(stale());
    }
    if !private.0.is_empty() && !cfg!(feature = "environment-launcher") {
        return Err(CandidateError::new(
            "environment_launcher_disabled",
            "Build with environment-launcher for private input delivery.",
        ));
    }
    let mut environments = BTreeMap::new();
    for (name, values) in &private.0 {
        let pending = PendingEnvironment::until(name, values, deadline.to_instant()?)?;
        environments.insert(name.clone(), pending);
    }
    deadline.to_instant()?;
    Ok(Prepared {
        review: fresh,
        inputs,
        environments,
        deadline,
    })
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum ArtifactKind {
    NativeGraphPreparation,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Phase {
    Prepared,
}

/// Distinct v2 native preparation evidence. Never a Compose v1 graph receipt or enrollment.
/// Contains hashes/selection only; no values, argv, authored text or renewal timestamps.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Receipt {
    version: u32,
    kind: ArtifactKind,
    phase: Phase,
    review: Review,
}
impl Receipt {
    pub fn review(&self) -> &Review {
        &self.review
    }
    fn validate(&self, scope: Scope<'_>, expected: &Review) -> Result<(), CandidateError> {
        self.review.validate(scope)?;
        expected.validate(scope)?;
        if self.version != 2 || &self.review != expected {
            return Err(artifact_refused());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;
