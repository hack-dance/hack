//! Explicit bounded application log reads. Output is returned to the caller, never journaled.
use super::{Engine, Kind, Resource, error, hex, inspect_resource, load, service_exec_generation};
use crate::{Candidate, CandidateError};
use serde::Serialize;

pub struct ServiceLogOptions<'a> {
    pub run: &'a str,
    pub service: &'a str,
    pub expected_container: &'a str,
    pub expected_boot: &'a str,
    pub expected_generation: &'a str,
    pub tail: u16,
}

#[derive(Debug, Serialize)]
pub struct ServiceLogResult {
    pub container: String,
    pub stdout: String,
    pub stderr: String,
    pub truncated: bool,
}

#[derive(Debug, Serialize)]
pub struct ServiceSelection {
    pub container: String,
    pub boot: String,
    pub generation: String,
}

/// Select the current immutable identity for a later service operation. The later
/// operation must recheck this selection under its own lease before any effects.
pub fn service_selection(
    candidate: &Candidate,
    run: &str,
    service: &str,
) -> Result<ServiceSelection, CandidateError> {
    let placeholder = "0".repeat(64);
    validate(&ServiceLogOptions {
        run,
        service,
        expected_container: &placeholder,
        expected_boot: "selection",
        expected_generation: &placeholder,
        tail: 1,
    })?;
    let engine = Engine::connect_cleanup(candidate)?;
    let (receipt, root) = load(candidate, &engine, run)?;
    if journal_pending(&root)? {
        return Err(refused());
    }
    let resource = receipt
        .resources
        .get(&format!("container:{service}"))
        .ok_or_else(refused)?;
    if resource.kind != Kind::Container || resource.key != service {
        return Err(refused());
    }
    let container = resource
        .id
        .as_deref()
        .filter(|id| hex(id, 64))
        .ok_or_else(refused)?;
    if inspect_resource(&engine, &receipt, resource)?.is_none() {
        return Err(refused());
    }
    Ok(ServiceSelection {
        container: container.to_owned(),
        boot: engine.guest().boot_id().to_owned(),
        generation: service_exec_generation(&receipt)?,
    })
}

fn refused() -> CandidateError {
    error(
        "graph_service_logs",
        "Service log selection is invalid or changed; inspect the graph before requesting logs again.",
    )
}

fn journal_pending(root: &std::path::Path) -> Result<bool, CandidateError> {
    match root.join("state.pending").symlink_metadata() {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err(refused()),
    }
}

fn validate(options: &ServiceLogOptions<'_>) -> Result<(), CandidateError> {
    if !hex(options.run, 32)
        || !hex(options.expected_container, 64)
        || !hex(options.expected_generation, 64)
        || options.expected_boot.is_empty()
        || options.expected_boot.len() > 128
        || options.expected_boot.bytes().any(|b| b.is_ascii_control())
        || options.service.is_empty()
        || options.service.len() > 128
        || !options
            .service
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
        || !(1..=1000).contains(&options.tail)
    {
        return Err(refused());
    }
    Ok(())
}

fn selected(resource: &Resource, options: &ServiceLogOptions<'_>) -> Result<(), CandidateError> {
    if resource.kind != Kind::Container
        || resource.key != options.service
        || resource.id.as_deref() != Some(options.expected_container)
    {
        return Err(refused());
    }
    Ok(())
}

/// Read an explicitly selected service, including exited services, under the VM lease.
/// Immutable identity and ownership are checked before and after reading. Application
/// logs may contain sensitive values; callers must not persist them as diagnostic receipts.
/// Text is UTF-8-lossy and capped at 16 KiB of JSON text per stream; truncation is explicit.
pub fn service_logs(
    candidate: &Candidate,
    options: &ServiceLogOptions<'_>,
) -> Result<ServiceLogResult, CandidateError> {
    validate(options)?;
    let engine = Engine::connect_cleanup(candidate)?;
    let (receipt, root) = load(candidate, &engine, options.run)?;
    if engine.guest().boot_id() != options.expected_boot
        || service_exec_generation(&receipt)? != options.expected_generation
        || journal_pending(&root)?
    {
        return Err(refused());
    }
    let resource = receipt
        .resources
        .get(&format!("container:{}", options.service))
        .ok_or_else(refused)?;
    selected(resource, options)?;
    if inspect_resource(&engine, &receipt, resource)?.is_none() {
        return Err(refused());
    }
    let (stdout, stderr, truncated) = engine.logs_tail(options.expected_container, options.tail)?;
    if inspect_resource(&engine, &receipt, resource)?.is_none() {
        return Err(refused());
    }
    Ok(ServiceLogResult {
        container: options.expected_container.to_owned(),
        stdout,
        stderr,
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    const RUN: &str = "11111111111111111111111111111111";
    const ID: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    fn options() -> ServiceLogOptions<'static> {
        ServiceLogOptions {
            run: RUN,
            service: "web",
            expected_container: ID,
            expected_boot: "boot",
            expected_generation: ID,
            tail: 200,
        }
    }
    #[test]
    fn invalid_or_unbounded_selection_is_rejected_before_provider_access() {
        for tail in [0, 1001, u16::MAX] {
            assert!(validate(&ServiceLogOptions { tail, ..options() }).is_err());
        }
        for service in ["", "../web", "web/json", "web\n"] {
            assert!(
                validate(&ServiceLogOptions {
                    service,
                    ..options()
                })
                .is_err()
            );
        }
        assert!(
            validate(&ServiceLogOptions {
                expected_container: "web",
                ..options()
            })
            .is_err()
        );
        assert!(
            validate(&ServiceLogOptions {
                expected_generation: "",
                ..options()
            })
            .is_err()
        );
        assert!(validate(&options()).is_ok());
    }
    #[test]
    fn only_recorded_container_identity_is_selected() {
        let mut resource: Resource = serde_json::from_value(serde_json::json!({
            "kind":"container", "key":"web", "name":"owned-web", "id":ID,
            "image":format!("sha256:{ID}"), "phase":"observed"
        }))
        .unwrap();
        assert!(selected(&resource, &options()).is_ok());
        resource.kind = Kind::Network;
        assert!(selected(&resource, &options()).is_err());
        resource.kind = Kind::Container;
        resource.id = None;
        assert!(selected(&resource, &options()).is_err());
        resource.id = Some("b".repeat(64));
        assert!(selected(&resource, &options()).is_err());
    }
}
