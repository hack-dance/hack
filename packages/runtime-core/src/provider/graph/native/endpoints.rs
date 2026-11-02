//! Native receipt adapter for captured guest endpoint observations, without effects.
use super::super::endpoints::{EndpointIdentity, GuestEndpoint, resolve_owned_attached};
use super::*;
use sha2::{Digest, Sha256};

/// Captured inputs only. The caller owns current receipt/source/data authentication,
/// Engine ownership, cancellation and freshness across awaits. A decoded receipt or
/// this observation cannot authorize bridge reservation, publication or value delivery.
pub struct ObserveOptions<'a> {
    pub receipt: &'a Receipt,
    pub boot: &'a str,
    pub service: &'a str,
    pub port: u16,
    pub container: &'a Value,
    /// Exactly the selected service's declared network keys and their inspections.
    pub networks: &'a BTreeMap<String, Option<Value>>,
}

fn invalid() -> CandidateError {
    error(
        "native_endpoint_identity",
        "Native guest endpoint differs from its ready receipt or captured owned resources; values omitted.",
    )
}

/// Observe one running service's primary guest destination and complete attachment
/// generation. This pure function performs no I/O and makes no reachability claim.
/// It does not create a frontend permit or relax unsupported endpoint intent.
pub fn observe(opts: ObserveOptions<'_>) -> Result<GuestEndpoint, CandidateError> {
    let receipt = opts.receipt;
    let scope = receipt.review.scope();
    receipt
        .validate(scope.run, &receipt.owner)
        .map_err(|_| invalid())?;
    let resource = receipt
        .resources
        .get(&format!("container:{}", opts.service))
        .ok_or_else(invalid)?;
    let declared = resource.networks.as_ref().ok_or_else(invalid)?;
    let expected: BTreeSet<_> = declared
        .iter()
        .map(|key| format!("network:{key}"))
        .collect();
    if receipt.phase != Phase::ReadyObserved
        || receipt.boot != opts.boot
        || resource.kind != Kind::Container
        || resource.phase != "started"
        || resource.image.as_deref() != opts.container["Image"].as_str()
        || opts.container["Name"]
            .as_str()
            .map(|name| name.strip_prefix('/').unwrap_or(name))
            != Some(resource.name.as_str())
        || expected.len() != declared.len()
        || expected.iter().ne(opts.networks.keys())
        || opts.networks.values().any(Option::is_none)
        || !running_ready(receipt, opts.service, opts.container)?
    {
        return Err(invalid());
    }
    for (key, value) in opts.networks {
        let network = receipt.resources.get(key).ok_or_else(invalid)?;
        let value = value.as_ref().ok_or_else(invalid)?;
        if network.phase != "created"
            || value["Driver"] != "bridge"
            || value["Internal"] != !network.outbound
        {
            return Err(invalid());
        }
    }
    // Only admitted immutable identity is hashed: lifecycle phases, failure and
    // terminal observations are intentionally excluded. No source bytes or values
    // leave this boundary. The native domain cannot collide with legacy generations.
    let resources: BTreeMap<_, _> = receipt
        .resources
        .iter()
        .map(|(key, resource)| {
            (
                key,
                json!([
                    resource.kind,
                    resource.key,
                    resource.name,
                    resource.id,
                    resource.image,
                    resource.networks,
                    resource.outbound
                ]),
            )
        })
        .collect();
    let binding = format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&json!([
                receipt.review,
                receipt.readiness,
                receipt.source,
                receipt.data,
                receipt.data_mounts,
                receipt.data_tool,
                receipt.topology,
                resources
            ]))
            .map_err(|_| invalid())?
        )
    );
    resolve_owned_attached(
        opts.container,
        opts.networks,
        opts.port,
        &receipt.resources,
        &EndpointIdentity {
            domain: "hack-native-endpoint-v1",
            owner: &receipt.owner,
            run: scope.run,
            review: &binding,
            boot: opts.boot,
            service: opts.service,
        },
        |resource| labels(&receipt.owner, &receipt.review, resource),
    )
}

fn running_ready(receipt: &Receipt, service: &str, value: &Value) -> Result<bool, CandidateError> {
    let state = &value["State"];
    if state["Running"].as_bool() != Some(true)
        || ["Paused", "Restarting", "Dead", "OOMKilled"]
            .iter()
            .any(|key| state[key].as_bool() != Some(false))
    {
        return Ok(false);
    }
    let observed = observation(value).map_err(|_| invalid())?;
    Ok(match receipt.readiness.get(service) {
        Some(Condition::Started) => matches!(
            observed,
            Observation::Running {
                health: Health::None | Health::Starting | Health::Healthy,
            }
        ),
        Some(Condition::Healthy) => {
            observed
                == Observation::Running {
                    health: Health::Healthy,
                }
        }
        // A completed job cannot be a running endpoint, even if its ID is retained.
        _ => false,
    })
}

#[cfg(test)]
mod tests;
