//! Requests to the live Compose-file graph owner. Never launch another owner.
use super::*;

/// The frontend's review of the complete Compose file, before service selection.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CombinedInput {
    plan_id: String,
    normalized_sha256: String,
    // Older append frames still decode so the owner can return a version reply.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    compose: Option<transport::PrivateText>,
}

impl CombinedInput {
    pub fn new(plan: &str, normalized: &str, bytes: &[u8]) -> Result<Self, CandidateError> {
        Ok(Self {
            plan_id: plan.to_owned(),
            normalized_sha256: normalized.to_owned(),
            compose: Some(transport::PrivateText::from_bytes(bytes)?),
        })
    }

    pub(in crate::provider::graph) fn valid(&self) -> bool {
        super::super::hex(&self.plan_id, 64) && super::super::hex(&self.normalized_sha256, 64)
    }

    pub(in crate::provider::graph) fn review(&self) -> Option<(&str, &str, &[u8])> {
        Some((
            &self.plan_id,
            &self.normalized_sha256,
            self.compose.as_ref()?.as_bytes(),
        ))
    }
}
use crate::project::{NormalizedComposeOptions, PlanOptions, execution::Condition};
use crate::provider::managed_environment::{self, Managed};
use serde::{Deserialize, Serialize};
use std::{net::Shutdown, os::fd::AsFd, path::PathBuf};

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
    combined: Option<CombinedInput>,
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

pub(super) fn refuse_legacy_append(
    stream: &mut std::os::unix::net::UnixStream,
    request: &WireRequest,
) -> bool {
    if request.version != 1 || request.extend.is_none() {
        return false;
    }
    let refusal = CandidateError::new(
        "graph_append_protocol_version",
        "Appending services requires a CLI with native append protocol v2 (5.0.0-next.26 or later).",
    );
    let _ = transport::write(
        stream,
        &owner_failure(&request.run, &refusal),
        Duration::from_secs(1),
    );
    true
}

/// Forward normalized input and optional private delivery to the exact live owner.
/// A lost reply never retries the start.
pub fn request(
    candidate: &Candidate,
    options: super::super::NormalizedRunOptions<'_>,
    generation: &str,
    combined: Option<CombinedInput>,
    slots: &BTreeMap<String, super::super::RouteSlot>,
    managed: Option<&Managed>,
) -> Result<Value, CandidateError> {
    if !super::super::hex(generation, 64)
        || combined.as_ref().is_some_and(|input| !input.valid())
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
        combined,
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
    let signals = signals::Events::new_descriptor(stream.as_fd())?;
    signals.watch_frontend()?;
    if let Some(managed) = managed {
        managed.remaining()?;
    }
    if signals.pending() {
        return Err(CandidateError::new(
            "graph_cancelled",
            "Targeted start was cancelled before dispatch.",
        ));
    }
    transport::write_extension(
        &stream,
        &WireRequest {
            cancel_append: false,
            version: 2,
            run: run.into(),
            remove_data: None,
            restore: None,
            job: None,
            refresh_dependencies: None,
            extend: Some(extend),
        },
        Duration::from_secs(5),
    )?;
    let deadline = Instant::now() + options.run.timeout + Duration::from_secs(10);
    if matches!(
        signals.wait_until(Some(deadline))?,
        signals::Wake::Signal | signals::Wake::FrontendExit
    ) {
        // Request EOF tells the owner to roll back. Keep the read half open
        // for the reply from this exact append, even if commit won the race.
        stream.shutdown(Shutdown::Write).map_err(|_| refused())?;
    }
    let reply: Value = transport::read(
        &mut stream,
        deadline.saturating_duration_since(Instant::now()),
        256 * 1024,
    )?;
    if reply["code"] == "graph_cancelled" && reply["run"] != run {
        return Err(refused());
    }
    validate_owner_response(reply.clone(), run).map_err(|mut error| {
        // The pinned same-user owner only emits compile-time fixed messages.
        if error.cause_code.is_some()
            && reply["run"] == run
            && let Some(message) = reply["message"].as_str()
            && (1..=300).contains(&message.len())
            && message.bytes().all(|byte| (0x20..=0x7e).contains(&byte))
        {
            error.message = message.to_owned();
            error.message_fixed = true;
        }
        error
    })
}

pub(super) fn owner_failure(run: &str, error: &CandidateError) -> Value {
    let mut reply = json!({"ok":false,"run":run,"code":error.code});
    if error.message_fixed {
        reply["message"] = json!(error.message);
    } else if error.code == "bridge_capacity_exhausted" {
        reply["message"] = json!(
            "The running native pool has insufficient free application bridge sockets for the selected services. No services were started."
        );
    }
    reply
}

pub(super) fn handle(
    candidate: &Candidate,
    runtime: &mut HostRelayRuntime,
    publishers: &mut publishers::Publishers,
    signals: &signals::Events,
    run: &str,
    request: ExtendRequest,
    server: StartupServer,
) -> Result<Value, CandidateError> {
    let timeout = Duration::from_secs(request.timeout_seconds);
    if timeout.is_zero() || timeout > Duration::from_secs(600) {
        return Err(refused());
    }
    if request
        .combined
        .as_ref()
        .is_some_and(|input| !input.valid())
    {
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
    runtime.set_startup_requests(Some(Box::new(server)));
    runtime.set_startup_cancellation(Some(signals::startup_pending));
    runtime.early_publications = Some(publishers::EarlyPublications::new(&slots, deadline));
    let result = super::super::extend::run(
        candidate,
        super::super::extend::Selection {
            options,
            generation: &request.generation,
            combined: request.combined,
            managed: super::super::ManagedInput {
                values: managed.as_ref().map_or(&values, Managed::values),
                files: managed.as_ref().map_or(&files, Managed::files),
            },
            deadline,
        },
        runtime,
    );
    runtime.set_startup_cancellation(None);
    runtime.set_startup_requests(None);
    if let Some(mut early) = runtime.early_publications.take() {
        let reap = publishers.reap_resumed(&early.resumed, signals);
        if !early.rolled_back
            || early
                .publishers
                .reap_after_cleanup(signals, Instant::now() + Duration::from_secs(5))
                .is_err()
        {
            // A refused append can still own children if rollback was uncertain.
            publishers.absorb(early.publishers, signals)?;
        }
        reap?;
    }
    let started = result?;
    Ok(
        json!({"ok":true,"run":run,"phase":started.receipt.phase,"receipt":started.receipt,"started":started.services,"changed":started.changed}),
    )
}
