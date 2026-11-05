//! Engine restart policies for owned Compose-file graph services.
//!
//! A reviewed `restart` value other than `no` lowers to the guest engine's own
//! `HostConfig.RestartPolicy`, so restart timing, backoff, retry counting and the
//! manual-stop rule follow Docker semantics. The admitted policy is recorded on
//! the container resource; that receipt field, never an inspected value alone,
//! authorizes the extra engine states a restarting container can show.
//!
//! Ownership invariants this module keeps:
//! - Stop wins: every owned stop first disarms the engine policy (`update` to
//!   `no`) and then requests an ordinary stop. A pending restart that races the
//!   stop is cancelled by the engine; the caller still requires a fresh terminal
//!   observation with `Restarting == false` before any deletion.
//! - Incarnation identity stays container ID plus `StartedAt`. A restart keeps
//!   the ID and changes `StartedAt`, so every existing incarnation-bound proof
//!   (endpoint generations, relay targets, completed-generation records) refuses
//!   a restarted container instead of silently adopting it. Services whose
//!   publication or delivery is bound to one incarnation (routes, HTTP probes,
//!   host dependencies, managed environment delivery, dependency caches) are
//!   refused at admission until they can republish per incarnation.
use super::{CandidateError, Kind, Resource, error, hex};
use crate::project::{ServicePlan, execution::Condition};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// Docker accepts a signed 32-bit retry count; zero means unbounded.
const MAX_RETRY_COUNT: u32 = i32::MAX as u32;

/// An admitted non-`no` Compose restart policy.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "Encoded", into = "Encoded")]
pub enum RestartPolicy {
    Always,
    UnlessStopped,
    OnFailure {
        /// Zero is Docker's unbounded `on-failure`.
        maximum_retry_count: u32,
    },
}

/// Closed receipt encoding: a retry count exists exactly for `on-failure`.
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Encoded {
    name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    maximum_retry_count: Option<u32>,
}

impl TryFrom<Encoded> for RestartPolicy {
    type Error = &'static str;

    fn try_from(value: Encoded) -> Result<Self, Self::Error> {
        let policy = match (value.name.as_str(), value.maximum_retry_count) {
            ("always", None) => Self::Always,
            ("unless-stopped", None) => Self::UnlessStopped,
            ("on-failure", Some(maximum_retry_count)) => Self::OnFailure {
                maximum_retry_count,
            },
            _ => return Err("invalid restart policy"),
        };
        if !policy.valid() {
            return Err("invalid restart policy");
        }
        Ok(policy)
    }
}

impl From<RestartPolicy> for Encoded {
    fn from(value: RestartPolicy) -> Self {
        let (name, maximum_retry_count) = match value {
            RestartPolicy::Always => ("always", None),
            RestartPolicy::UnlessStopped => ("unless-stopped", None),
            RestartPolicy::OnFailure {
                maximum_retry_count,
            } => ("on-failure", Some(maximum_retry_count)),
        };
        Self {
            name: name.into(),
            maximum_retry_count,
        }
    }
}

impl RestartPolicy {
    /// Parse a reviewed Compose value. `no` is `None`; anything else outside the
    /// Compose grammar is refused rather than defaulted.
    pub(super) fn parse(value: &str) -> Result<Option<Self>, CandidateError> {
        let invalid = || error("graph_restart_policy", "Unsupported restart policy.");
        Ok(Some(match value {
            "no" => return Ok(None),
            "always" => Self::Always,
            "unless-stopped" => Self::UnlessStopped,
            "on-failure" => Self::OnFailure {
                maximum_retry_count: 0,
            },
            other => {
                let count = other
                    .strip_prefix("on-failure:")
                    .filter(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
                    .and_then(|n| n.parse::<u32>().ok())
                    .filter(|n| (1..=MAX_RETRY_COUNT).contains(n))
                    .ok_or_else(invalid)?;
                Self::OnFailure {
                    maximum_retry_count: count,
                }
            }
        }))
    }

    pub(super) fn valid(&self) -> bool {
        match self {
            Self::Always | Self::UnlessStopped => true,
            Self::OnFailure {
                maximum_retry_count,
            } => *maximum_retry_count <= MAX_RETRY_COUNT,
        }
    }

    /// Engine request value. Unconditional policies always carry a zero count.
    pub(super) fn engine(policy: Option<&Self>) -> Value {
        match policy {
            None => json!({"Name":"no"}),
            Some(Self::Always) => json!({"Name":"always","MaximumRetryCount":0}),
            Some(Self::UnlessStopped) => json!({"Name":"unless-stopped","MaximumRetryCount":0}),
            Some(Self::OnFailure {
                maximum_retry_count,
            }) => json!({"Name":"on-failure","MaximumRetryCount":maximum_retry_count}),
        }
    }
}

fn refused(message: &'static str) -> CandidateError {
    error("graph_restart_policy", message)
}

/// The facts admission needs beyond the reviewed service itself.
pub(super) struct Admission<'a> {
    pub service: &'a ServicePlan,
    pub ready: Condition,
    pub managed_environment: bool,
    pub host_dependencies: bool,
}

/// Admit a declared policy for one active service, or refuse it with a fixed,
/// value-free reason. Admission never weakens an incarnation-bound guard: those
/// service classes refuse instead of running without their guard.
pub(super) fn admit(admission: &Admission<'_>) -> Result<Option<RestartPolicy>, CandidateError> {
    let Some(policy) = RestartPolicy::parse(&admission.service.restart)? else {
        return Ok(None);
    };
    let service = admission.service;
    if admission.ready == Condition::Completed && !matches!(policy, RestartPolicy::OnFailure { .. })
    {
        return Err(refused(
            "Completion readiness cannot use an unconditional restart policy.",
        ));
    }
    if service.dependency_cache.is_some() {
        return Err(refused(
            "Dependency cache initializers cannot use an automatic restart policy.",
        ));
    }
    if service.routing.is_some() {
        return Err(refused(
            "Routed services cannot yet use an automatic restart policy: route publication is bound to one container incarnation.",
        ));
    }
    if service
        .healthcheck
        .as_ref()
        .is_some_and(|health| health.native_http.is_some())
    {
        return Err(refused(
            "Native HTTP probes cannot yet use an automatic restart policy: the probe is bound to one container incarnation.",
        ));
    }
    if admission.host_dependencies {
        return Err(refused(
            "Services with host dependencies cannot yet use an automatic restart policy: relays are bound to one container incarnation.",
        ));
    }
    if admission.managed_environment {
        return Err(refused(
            "Services with managed environment delivery cannot yet use an automatic restart policy: delivery is single-incarnation and time-bounded.",
        ));
    }
    Ok(Some(policy))
}

/// Engine `RestartPolicy.Name` of an ownership-verified inspection. Docker
/// reports an omitted policy as an empty name, which means `no`.
fn observed_name(inspected: &Value) -> Result<&str, CandidateError> {
    match inspected["HostConfig"]["RestartPolicy"]["Name"].as_str() {
        Some("") | Some("no") => Ok("no"),
        Some(name @ ("always" | "unless-stopped" | "on-failure")) => Ok(name),
        _ => Err(refused("Owned container restart policy is unknown.")),
    }
}

/// Decide whether an owned container needs its engine policy disarmed before a
/// stop. A policy the receipt never admitted is a foreign change and refuses.
/// Returns the immutable container ID to disarm.
pub(super) fn disarm_target(
    resource: &Resource,
    inspected: &Value,
) -> Result<Option<String>, CandidateError> {
    if resource.kind != Kind::Container {
        return Ok(None);
    }
    let id = inspected["Id"]
        .as_str()
        .filter(|id| hex(id, 64))
        .ok_or_else(|| refused("Owned container identity is missing."))?;
    if resource
        .id
        .as_deref()
        .is_some_and(|recorded| recorded != id)
    {
        return Err(refused("Owned container identity changed."));
    }
    let name = observed_name(inspected)?;
    if name == "no" {
        return Ok(None);
    }
    if resource.restart_policy.is_none() {
        return Err(refused(
            "Owned container has a restart policy this graph never admitted.",
        ));
    }
    Ok(Some(id.into()))
}

/// Require that a fresh observation after disarming shows no engine policy.
pub(super) fn verify_disarmed(inspected: &Value) -> Result<(), CandidateError> {
    if observed_name(inspected)? != "no" {
        return Err(refused(
            "Owned container restart policy was not disarmed; stop was not requested.",
        ));
    }
    Ok(())
}

/// Whether a resource's receipt admits the engine `restarting` state.
pub(super) fn admits_restarting(resource: &Resource) -> bool {
    resource.kind == Kind::Container && resource.restart_policy.is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resource(policy: Option<RestartPolicy>) -> Resource {
        Resource {
            routing: None,
            networks: Some(Vec::new()),
            outbound: false,
            cache: None,
            cache_provenance: None,
            disposable_caches: Vec::new(),
            restart_policy: policy,
            kind: Kind::Container,
            key: "worker".into(),
            name: "hkg-run-container-0".into(),
            id: Some("a".repeat(64)),
            image: Some(format!("sha256:{}", "b".repeat(64))),
            phase: "started".into(),
        }
    }

    fn inspected(name: &str) -> Value {
        json!({"Id":"a".repeat(64),"HostConfig":{"RestartPolicy":{"Name":name,"MaximumRetryCount":0}}})
    }

    #[test]
    fn parses_the_compose_grammar_and_refuses_everything_else() {
        assert_eq!(RestartPolicy::parse("no").unwrap(), None);
        assert_eq!(
            RestartPolicy::parse("always").unwrap(),
            Some(RestartPolicy::Always)
        );
        assert_eq!(
            RestartPolicy::parse("unless-stopped").unwrap(),
            Some(RestartPolicy::UnlessStopped)
        );
        assert_eq!(
            RestartPolicy::parse("on-failure").unwrap(),
            Some(RestartPolicy::OnFailure {
                maximum_retry_count: 0
            })
        );
        assert_eq!(
            RestartPolicy::parse("on-failure:3").unwrap(),
            Some(RestartPolicy::OnFailure {
                maximum_retry_count: 3
            })
        );
        for value in [
            "",
            "No",
            "on-failure:",
            "on-failure:0",
            "on-failure:-1",
            "on-failure:+2",
            "on-failure:2147483648",
            "on-failure: 2",
            "unless_stopped",
        ] {
            assert_eq!(
                RestartPolicy::parse(value).unwrap_err().code,
                "graph_restart_policy",
                "{value}"
            );
        }
    }

    #[test]
    fn engine_values_follow_docker_restart_policy_fields() {
        assert_eq!(RestartPolicy::engine(None), json!({"Name":"no"}));
        assert_eq!(
            RestartPolicy::engine(Some(&RestartPolicy::UnlessStopped)),
            json!({"Name":"unless-stopped","MaximumRetryCount":0})
        );
        assert_eq!(
            RestartPolicy::engine(Some(&RestartPolicy::OnFailure {
                maximum_retry_count: 5
            })),
            json!({"Name":"on-failure","MaximumRetryCount":5})
        );
    }

    #[test]
    fn receipt_encoding_is_closed_and_round_trips() {
        for policy in [
            RestartPolicy::Always,
            RestartPolicy::UnlessStopped,
            RestartPolicy::OnFailure {
                maximum_retry_count: 7,
            },
        ] {
            let value = serde_json::to_value(policy).unwrap();
            assert_eq!(
                serde_json::from_value::<RestartPolicy>(value).unwrap(),
                policy
            );
        }
        assert_eq!(
            serde_json::to_value(RestartPolicy::OnFailure {
                maximum_retry_count: 2
            })
            .unwrap(),
            json!({"name":"on-failure","maximum_retry_count":2})
        );
        for value in [
            json!({"name":"no"}),
            json!({"name":"always","maximum_retry_count":1}),
            json!({"name":"on-failure"}),
            json!({"name":"on-failure","maximum_retry_count":1,"extra":true}),
            json!({"name":"on-failure","maximum_retry_count":2147483648_u64}),
        ] {
            assert!(serde_json::from_value::<RestartPolicy>(value).is_err());
        }
    }

    /// A synthetic internal worker in the real public plan shape.
    fn service(restart: &str) -> ServicePlan {
        serde_json::from_value(json!({"active":true,"profiles":[],"dependencies":{},"mounts":[],
            "environment":{},"environment_files":[],"environment_precedence":"test","ports":[],
            "exposed_ports":[],"networks":["default"],"network_mode":"project-networks","limits":{},
            "read_only":true,"init":false,"restart":restart,"labels":{},
            "healthcheck":{"disabled":false,"test":{"form":"exec","arguments":[],"review_field":"services.worker.healthcheck.test"}}}))
        .unwrap()
    }

    fn admit_with(
        service: &ServicePlan,
        ready: Condition,
        managed_environment: bool,
        host_dependencies: bool,
    ) -> Result<Option<RestartPolicy>, CandidateError> {
        admit(&Admission {
            service,
            ready,
            managed_environment,
            host_dependencies,
        })
    }

    #[test]
    fn admits_docker_policies_for_long_running_and_retrying_one_shot_services() {
        for (value, expected) in [
            ("no", None),
            ("always", Some(RestartPolicy::Always)),
            ("unless-stopped", Some(RestartPolicy::UnlessStopped)),
            (
                "on-failure:4",
                Some(RestartPolicy::OnFailure {
                    maximum_retry_count: 4,
                }),
            ),
        ] {
            for ready in [Condition::Started, Condition::Healthy] {
                assert_eq!(
                    admit_with(&service(value), ready, false, false).unwrap(),
                    expected
                );
            }
        }
        // One-shot jobs keep Docker's retry-until-success semantics.
        assert_eq!(
            admit_with(&service("on-failure"), Condition::Completed, false, false).unwrap(),
            Some(RestartPolicy::OnFailure {
                maximum_retry_count: 0
            })
        );
        for value in ["always", "unless-stopped"] {
            assert_eq!(
                admit_with(&service(value), Condition::Completed, false, false)
                    .unwrap_err()
                    .code,
                "graph_restart_policy"
            );
        }
    }

    #[test]
    fn refuses_incarnation_bound_service_classes_instead_of_dropping_guards() {
        let plain = service("unless-stopped");
        assert!(admit_with(&plain, Condition::Started, true, false).is_err());
        assert!(admit_with(&plain, Condition::Started, false, true).is_err());
        let mut routed = plain.clone();
        routed.routing = Some(
            serde_json::from_value(json!({"hostnames":["worker.example.test"],"port":3000}))
                .unwrap(),
        );
        assert!(admit_with(&routed, Condition::Healthy, false, false).is_err());
        let mut probed = plain.clone();
        probed.healthcheck = Some(
            serde_json::from_value(
                json!({"disabled":false,"native_http":{"port":3000,"path":"/health",
                "interval_ms":100,"timeout_ms":500,"retries":3,"start_period_ms":0}}),
            )
            .unwrap(),
        );
        assert!(admit_with(&probed, Condition::Healthy, false, false).is_err());
        let mut cache = service("on-failure");
        cache.dependency_cache = Some(
            serde_json::from_value(json!({"volume":"deps","lockfiles":["bun.lock"],
                "lockfiles_explicit":true,"runtime_files":[],"bootstrap":true}))
            .unwrap(),
        );
        assert!(admit_with(&cache, Condition::Completed, false, false).is_err());
        // The same classes without a restart policy are unaffected.
        for (mut plan, ready) in [
            (routed, Condition::Healthy),
            (probed, Condition::Healthy),
            (cache, Condition::Completed),
        ] {
            plan.restart = "no".into();
            assert_eq!(admit_with(&plan, ready, true, true).unwrap(), None);
        }
        for error in [
            admit_with(&plain, Condition::Started, true, false).unwrap_err(),
            admit_with(&plain, Condition::Started, false, true).unwrap_err(),
        ] {
            assert_eq!(error.code, "graph_restart_policy");
        }
    }

    #[test]
    fn disarm_requires_receipt_admission_for_any_engine_policy() {
        let admitted = resource(Some(RestartPolicy::UnlessStopped));
        let legacy = resource(None);
        assert_eq!(disarm_target(&legacy, &inspected("no")).unwrap(), None);
        assert_eq!(disarm_target(&legacy, &inspected("")).unwrap(), None);
        assert_eq!(disarm_target(&admitted, &inspected("no")).unwrap(), None);
        assert_eq!(
            disarm_target(&admitted, &inspected("unless-stopped")).unwrap(),
            Some("a".repeat(64))
        );
        // A disarmed policy can differ from the admitted one; any live engine
        // policy on an admitted container is disarmed before the stop.
        assert_eq!(
            disarm_target(&admitted, &inspected("always")).unwrap(),
            Some("a".repeat(64))
        );
        assert_eq!(
            disarm_target(&legacy, &inspected("always"))
                .unwrap_err()
                .code,
            "graph_restart_policy"
        );
        assert!(disarm_target(&admitted, &inspected("sometimes")).is_err());
        assert!(disarm_target(&admitted, &json!({"Id":"a".repeat(64)})).is_err());
        let mut foreign = inspected("always");
        foreign["Id"] = json!("c".repeat(64));
        assert!(disarm_target(&admitted, &foreign).is_err());
    }

    #[test]
    fn disarm_verification_requires_a_fresh_no_policy() {
        assert!(verify_disarmed(&inspected("no")).is_ok());
        assert!(verify_disarmed(&inspected("")).is_ok());
        for name in ["always", "unless-stopped", "on-failure", "other"] {
            assert!(verify_disarmed(&inspected(name)).is_err(), "{name}");
        }
        assert!(verify_disarmed(&json!({})).is_err());
    }
}
