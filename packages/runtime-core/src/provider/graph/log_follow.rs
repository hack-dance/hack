//! Following observes an admitted graph; it never takes a provider or graph lease.
use crate::{Candidate, CandidateError};

/// Exact saved frontend selection. No source, environment or replay authority.
pub struct LogFollowOptions<'a> {
    pub run: &'a str,
    pub service: &'a str,
    pub owner: &'a str,
    pub plan: &'a str,
    pub namespace: &'a str,
    pub tail: u16,
    pub since: Option<u64>,
    pub native: bool,
}
impl LogFollowOptions<'_> {
    pub fn validate(&self) -> Result<(), CandidateError> {
        if !super::hex(self.run, 32)
            || !super::hex(self.owner, 32)
            || !super::hex(self.plan, 64)
            || !super::hex(self.namespace, 64)
            || !(1..=1000).contains(&self.tail)
            || self.service.is_empty()
            || self.service.len() > 128
            || !self
                .service
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
        {
            return Err(changed());
        }
        Ok(())
    }
}
pub(super) fn changed() -> CandidateError {
    CandidateError::new(
        "native_log_selection_changed",
        "Native log selection changed or is unavailable; no runtime state was changed.",
    )
}

/// Stream only an immutable selected container, through the already owned relay.
/// Stopped/removed selection ends normally; transport loss is not cleanup proof.
pub fn follow_logs(
    candidate: &Candidate,
    options: &LogFollowOptions<'_>,
) -> Result<(), CandidateError> {
    options.validate()?;
    #[cfg(target_os = "macos")]
    {
        if options.native {
            #[cfg(feature = "native-config-plan")]
            return super::native::follow_logs(candidate, options);
            #[cfg(not(feature = "native-config-plan"))]
            return Err(changed());
        }
        imported(candidate, options)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = candidate;
        Err(CandidateError::new(
            "native_log_platform",
            "Native log following requires macOS.",
        ))
    }
}

#[cfg(target_os = "macos")]
fn imported(candidate: &Candidate, options: &LogFollowOptions<'_>) -> Result<(), CandidateError> {
    use super::*;
    let observer = super::super::engine::Observer::connect(candidate)?;
    let load_selected = || {
        let (receipt, root) = load_at(
            directory(candidate, options.run)?,
            options.run,
            observer.incarnation(),
        )?;
        super::startup::require_dependency_rebind_complete(&root, &receipt)?;
        let pending = match root.join("state.pending").symlink_metadata() {
            Ok(_) => true,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            Err(_) => return Err(changed()),
        };
        if receipt.owner != options.owner
            || receipt.plan_id != options.plan
            || receipt.namespace != options.namespace
            || pending
        {
            return Err(changed());
        }
        Ok(receipt)
    };
    let receipt = load_selected()?;
    let resource = receipt
        .resources
        .get(&format!("container:{}", options.service))
        .ok_or_else(changed)?;
    if resource.kind != Kind::Container || resource.key != options.service {
        return Err(changed());
    }
    let container = resource
        .id
        .as_deref()
        .filter(|id| hex(id, 64))
        .ok_or_else(changed)?;
    let state = || {
        // Stay on this exact admitted ID, never reselect from an advancing journal.
        // Cleanup may publish state.pending and retire the journal while we read.
        match observer.get(&format!("/v1.53/containers/{container}/json")) {
            Ok(value) => {
                verify_resource_identity(&receipt, resource, &value)?;
                Ok(Some(value))
            }
            Err(error) if error.code == "engine_not_found" => Ok(None),
            Err(error) => Err(error),
        }
    };
    let initial = state()?.ok_or_else(changed)?;
    let generation = initial["State"]["StartedAt"].clone();
    super::super::engine::log_follow::follow(
        &observer,
        container,
        options.service,
        options.tail,
        options.since,
        || {
            observer.guest().verify()?;
            validate_state(state()?, &generation)
        },
    )
}

#[cfg(any(target_os = "macos", test))]
pub(super) fn validate_state(
    value: Option<serde_json::Value>,
    generation: &serde_json::Value,
) -> Result<bool, CandidateError> {
    let Some(value) = value else {
        return Ok(false);
    };
    let tty = value["Config"]["Tty"].as_bool().ok_or_else(changed)?;
    if tty {
        return Err(CandidateError::new(
            "native_log_tty_unsupported",
            "Native log following does not support a service configured with TTY.",
        ));
    }
    if !generation
        .as_str()
        .is_some_and(|g| !g.is_empty() && g.len() <= 64)
    {
        return Err(changed());
    }
    if value["State"]["StartedAt"] != *generation {
        return Err(CandidateError::new(
            "native_log_container_restarted",
            "Selected container restarted; start a new log follower for its current generation.",
        ));
    }
    value["State"]["Running"].as_bool().ok_or_else(changed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn stopped_absent_restarted_and_tty_are_distinct() {
        let generation = json!("2026-01-01T00:00:00Z");
        let mut state =
            json!({"Config":{"Tty":false}, "State":{"StartedAt": generation, "Running":true}});
        assert!(validate_state(Some(state.clone()), &generation).unwrap());
        state["State"]["Running"] = json!(false);
        assert!(!validate_state(Some(state.clone()), &generation).unwrap());
        assert!(!validate_state(None, &generation).unwrap());
        state["State"]["StartedAt"] = json!("2026-01-02T00:00:00Z");
        assert_eq!(
            validate_state(Some(state.clone()), &generation)
                .unwrap_err()
                .code,
            "native_log_container_restarted"
        );
        state["Config"]["Tty"] = json!(true);
        assert_eq!(
            validate_state(Some(state.clone()), &generation)
                .unwrap_err()
                .code,
            "native_log_tty_unsupported"
        );
        state["Config"]["Tty"] = json!(null);
        assert_eq!(
            validate_state(Some(state), &generation).unwrap_err().code,
            "native_log_selection_changed"
        );
    }
}
