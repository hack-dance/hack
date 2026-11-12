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
    pub timestamps: bool,
    pub from_start: bool,
    pub native: bool,
    pub selection_only: bool,
    pub expected_container: Option<&'a str>,
}
impl LogFollowOptions<'_> {
    pub fn validate(&self) -> Result<(), CandidateError> {
        if !super::hex(self.run, 32)
            || !super::hex(self.owner, 32)
            || !super::hex(self.plan, 64)
            || !super::hex(self.namespace, 64)
            || self.tail > 1000
            || self
                .expected_container
                .is_some_and(|id| !super::hex(id, 64))
            || (self.from_start && self.since.is_some())
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

#[cfg(any(target_os = "macos", test))]
pub(super) fn since(
    options: &LogFollowOptions<'_>,
    generation: &serde_json::Value,
) -> Result<Option<String>, CandidateError> {
    if options.from_start {
        Ok(Some(
            generation
                .as_str()
                .and_then(crate::provider::engine::log_follow::unix_nanos)
                .ok_or_else(changed)?
                .to_owned(),
        ))
    } else {
        Ok(options.since.map(|value| value.to_string()))
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
        require_ready(
            receipt.phase == "ready-observed",
            receipt.readiness.contains_key(options.service),
        )?;
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
    admit_container(options, container)?;
    if options.selection_only {
        return write_selection(options, container, initial, &generation);
    }
    super::super::engine::log_follow::follow(
        &observer,
        container,
        options.service,
        crate::provider::engine::log_follow::LogOptions {
            tail: options.tail,
            since: crate::provider::graph::log_follow::since(options, &generation)?,
            timestamps: options.timestamps,
        },
        || {
            observer.guest().verify()?;
            validate_state(state()?, &generation)
        },
    )
}

#[cfg(any(target_os = "macos", test))]
pub(super) fn admit_container(
    options: &LogFollowOptions<'_>,
    container: &str,
) -> Result<(), CandidateError> {
    if options
        .expected_container
        .is_some_and(|expected| expected != container)
    {
        return Err(changed());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
pub(super) fn write_selection(
    options: &LogFollowOptions<'_>,
    container: &str,
    initial: serde_json::Value,
    generation: &serde_json::Value,
) -> Result<(), CandidateError> {
    if !validate_state(Some(initial), generation)? {
        return Err(changed());
    }
    // A finite admission read: no log socket and no frontend lifetime watcher.
    use std::io::Write;
    let mut output = std::io::stdout().lock();
    serde_json::to_writer(
        &mut output,
        &serde_json::json!({
            "version": 1, "kind": "native-log-selection",
            "service": options.service, "container": container
        }),
    )
    .map_err(|_| changed())?;
    output
        .write_all(b"\n")
        .and_then(|_| output.flush())
        .map_err(|_| changed())
}

#[cfg(any(target_os = "macos", test))]
pub(super) fn require_ready(ready: bool, selected_service: bool) -> Result<(), CandidateError> {
    if !ready || !selected_service {
        return Err(changed());
    }
    Ok(())
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
    fn admission_requires_ready_graph_and_selected_service() {
        for (ready, service) in [(false, false), (false, true), (true, false)] {
            assert_eq!(
                require_ready(ready, service).unwrap_err().code,
                "native_log_selection_changed"
            );
        }
        require_ready(true, true).unwrap();
    }
    #[test]
    fn zero_tail_selects_only_new_lines() {
        let options = LogFollowOptions {
            run: &"a".repeat(32),
            service: "web",
            owner: &"b".repeat(32),
            plan: &"c".repeat(64),
            namespace: &"d".repeat(64),
            tail: 0,
            since: None,
            timestamps: false,
            from_start: false,
            native: false,
            selection_only: false,
            expected_container: None,
        };
        options.validate().unwrap();
        admit_container(&options, &"e".repeat(64)).unwrap();
        let pinned = LogFollowOptions {
            expected_container: Some(&"e".repeat(64)),
            ..options
        };
        admit_container(&pinned, &"e".repeat(64)).unwrap();
        assert_eq!(
            admit_container(&pinned, &"f".repeat(64)).unwrap_err().code,
            "native_log_selection_changed"
        );
        assert_eq!(
            since(
                &LogFollowOptions {
                    from_start: true,
                    ..options
                },
                &json!("2026-01-01T00:00:00.123456789Z")
            )
            .unwrap(),
            Some("1767225600.123456789".into())
        );
        assert!(
            LogFollowOptions {
                tail: 1001,
                ..options
            }
            .validate()
            .is_err()
        );
    }
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
