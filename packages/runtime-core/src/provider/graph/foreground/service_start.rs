//! Requests to the live Compose-file graph owner. Never launch another owner.
use super::*;
use crate::project::{NormalizedComposeOptions, PlanOptions, execution::Condition};
use crate::provider::managed_environment::{self, Managed};
use serde::{Deserialize, Serialize};
use std::{os::unix::net::UnixStream, path::PathBuf};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ExtendRequest {
    generation: String,
    project: PathBuf,
    file: PathBuf,
    branch: Option<String>,
    profiles: Vec<String>,
    namespace: String,
    original_hash: String,
    plan: String,
    compose: transport::PrivateText,
    environment: Option<transport::PrivateText>,
    source_revision: Option<String>,
    shared_source: bool,
    readiness: BTreeMap<String, Condition>,
    routes: BTreeSet<String>,
    timeout_seconds: u64,
}

impl ExtendRequest {
    pub(super) fn has_routes(&self) -> bool {
        !self.routes.is_empty()
    }
}

/// Forward normalized input and optional private delivery to the exact live owner.
/// A lost reply never retries the start.
pub fn request(
    candidate: &Candidate,
    options: super::super::NormalizedRunOptions<'_>,
    generation: &str,
    slots: &BTreeMap<String, super::super::RouteSlot>,
    managed: Option<&Managed>,
) -> Result<Value, CandidateError> {
    if !super::super::hex(generation, 64)
        || options.run.timeout.is_zero()
        || options.run.timeout > Duration::from_secs(600)
        || slots
            .values()
            .any(|slot| *slot != super::super::RouteSlot::Auto)
    {
        return Err(refused());
    }
    let run = options.run.run_id;
    let plan = options.run.expected_plan;
    let selection = options.compose;
    let extend = ExtendRequest {
        generation: generation.into(),
        project: selection.project.into(),
        file: selection.compose_file.into(),
        branch: selection.branch.map(str::to_owned),
        profiles: selection.profiles.to_vec(),
        namespace: selection.expected_namespace.into(),
        original_hash: selection.expected_compose_sha256.into(),
        plan: plan.into(),
        compose: transport::PrivateText::from_bytes(selection.compose_bytes)?,
        environment: managed
            .map(|input| transport::PrivateText::from_bytes(&input.forward(plan, run)?))
            .transpose()?,
        source_revision: options.run.source_revision.map(str::to_owned),
        shared_source: options.run.shared_source,
        readiness: options.run.readiness.clone(),
        routes: slots.keys().cloned().collect(),
        timeout_seconds: options.run.timeout.as_secs(),
    };
    let pin = transport::Pin::load(candidate, run)?;
    let mut stream = pin.connect()?;
    if let Some(managed) = managed {
        managed.remaining()?;
    }
    transport::write(
        &mut stream,
        &WireRequest {
            version: 1,
            run: run.into(),
            remove_data: None,
            restore: None,
            job: None,
            refresh_dependencies: None,
            extend: Some(extend),
        },
        Duration::from_secs(5),
    )?;
    let reply: Value = transport::read(
        &mut stream,
        options.run.timeout + Duration::from_secs(10),
        256 * 1024,
    )?;
    validate_owner_response(reply, run)
}

pub(super) fn handle(
    candidate: &Candidate,
    runtime: &mut HostRelayRuntime,
    publishers: &mut publishers::Publishers,
    signals: &signals::Events,
    run: &str,
    request: ExtendRequest,
    stream: &UnixStream,
) -> Result<Value, CandidateError> {
    let timeout = Duration::from_secs(request.timeout_seconds);
    if timeout.is_zero() || timeout > Duration::from_secs(600) {
        return Err(refused());
    }
    let managed = request
        .environment
        .as_ref()
        .map(|input| managed_environment::receive_forwarded(input.as_bytes(), &request.plan, run))
        .transpose()?;
    let values = BTreeMap::new();
    let files = super::super::ManagedFiles::new();
    let deadline = managed.as_ref().map_or_else(
        || Instant::now() + timeout,
        |input| input.deadline().min(Instant::now() + timeout),
    );
    let slots = request
        .routes
        .iter()
        .map(|name| (name.clone(), super::super::RouteSlot::Auto))
        .collect();
    let empty = BTreeMap::new();
    let options = super::super::NormalizedRunOptions {
        run: RunOptions {
            live_source: false,
            shared_source: request.shared_source,
            release_initializer_cache: BTreeSet::new(),
            routing_enrolled: !request.routes.is_empty(),
            loopback_ports: true,
            project: PlanOptions {
                project: &request.project,
                branch: request.branch.as_deref(),
                compose_file: &request.file,
                profiles: &request.profiles,
            },
            expected_plan: &request.plan,
            source_revision: request.source_revision.as_deref(),
            non_secret_values: &empty,
            readiness: &request.readiness,
            run_id: run,
            timeout,
        },
        compose: NormalizedComposeOptions {
            project: &request.project,
            branch: request.branch.as_deref(),
            expected_namespace: &request.namespace,
            compose_file: &request.file,
            expected_compose_sha256: &request.original_hash,
            compose_bytes: request.compose.as_bytes(),
            profiles: &request.profiles,
        },
    };
    transport::peer(stream)?;
    runtime.set_startup_cancellation(Some(signals::startup_pending));
    runtime.early_publications = Some(publishers::EarlyPublications::new(&slots, deadline));
    let result = super::super::extend::run(
        candidate,
        super::super::extend::Selection {
            options,
            generation: &request.generation,
            managed: super::super::ManagedInput {
                values: managed.as_ref().map_or(&values, Managed::values),
                files: managed.as_ref().map_or(&files, Managed::files),
            },
            deadline,
        },
        runtime,
    );
    runtime.set_startup_cancellation(None);
    if let Some(early) = runtime.early_publications.take() {
        // Even a refused append may own live children. Keep those with the
        // original owner so down and publisher exit handling see the same set.
        publishers.absorb(early.publishers, signals)?;
    }
    let receipt = result?;
    Ok(json!({"ok":true,"run":run,"phase":receipt.phase,"receipt":receipt}))
}
