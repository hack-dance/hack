//! Explicit noninteractive user commands. Output may contain secrets and is never journaled.
use super::*;
use base64::Engine as _;
use sha2::{Digest, Sha256};

pub struct ServiceExecOptions<'a> {
    pub run: &'a str,
    pub service: &'a str,
    pub expected_container: &'a str,
    pub expected_boot: &'a str,
    pub expected_generation: &'a str,
    pub argv: &'a [String],
    pub workdir: Option<&'a str>,
    /// Bounds transport observation, not the lifetime of the user command.
    pub timeout: Duration,
}

#[derive(Serialize)]
pub struct ServiceExecResult {
    pub exit_code: i32,
    pub stdout_base64: String,
    pub stderr_base64: String,
    pub truncated: bool,
}

/// Bind an explicit service operation to the exact reviewed graph receipt.
pub fn service_exec_generation(receipt: &Receipt) -> Result<String, CandidateError> {
    let bytes = serde_json::to_vec(receipt).map_err(|_| refused())?;
    Ok(format!("{:x}", crate::Hex(Sha256::digest(bytes))))
}

fn refused() -> CandidateError {
    error(
        "graph_service_exec",
        "Service exec requires a current ready graph, exact container and boot identities, bounded argv, and noninteractive input.",
    )
}

/// Fresh values arrived for a service whose exact container started without
/// private environment delivery: its env changed after `up` (HACK-2740). Exec
/// never attaches delivery to a running container; only a fresh start applies
/// the change. The check is per service: another service's delivery (the
/// run-wide `environment_attached` bit) does not count, only the selected
/// container's own payload mount.
#[cfg_attr(
    not(all(target_os = "macos", feature = "environment-launcher")),
    allow(dead_code)
)]
fn started_with_environment(attached: bool, mounted: Option<&str>) -> Result<(), CandidateError> {
    if attached && mounted.is_some() {
        Ok(())
    } else {
        Err(environment_changed())
    }
}

#[cfg_attr(
    not(all(target_os = "macos", feature = "environment-launcher")),
    allow(dead_code)
)]
fn environment_changed() -> CandidateError {
    error(
        "graph_service_exec_environment_changed",
        "The service has env values that this run did not start with, for example after hack env set. Run hack down, then hack up, to start with them. No command was started.",
    )
}

fn validate(options: &ServiceExecOptions<'_>) -> Result<(), CandidateError> {
    if !hex(options.run, 32)
        || !hex(options.expected_container, 64)
        || !hex(options.expected_generation, 64)
        || options.expected_boot.is_empty()
        || options.expected_boot.len() > 128
        || options.service.is_empty()
        || options.service.len() > 128
        || !options
            .service
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
        || options.argv.is_empty()
        || options.argv.len() > 256
        || options.argv[0].is_empty()
        || options
            .argv
            .iter()
            .any(|s| s.contains('\0') || s.len() > 16 * 1024)
        || options.argv.iter().map(String::len).sum::<usize>() > 64 * 1024
        || options
            .workdir
            .is_some_and(|p| !p.starts_with('/') || p.contains('\0') || p.len() > 4096)
        || options.timeout < Duration::from_millis(1)
        || options.timeout > Duration::from_secs(300)
    {
        return Err(refused());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
pub(super) fn interactive(
    candidate: &Candidate,
    options: &ServiceExecOptions<'_>,
    console_size: [u16; 2],
    session: &str,
    managed: Option<&crate::provider::managed_environment::Managed>,
    live: &dyn Fn() -> Result<(), CandidateError>,
) -> Result<crate::provider::engine::interactive_exec::Attached, CandidateError> {
    use crate::provider::interactive_session::{Backend, Binding};
    use std::time::Instant;
    validate(options)?;
    live()?;
    let deadline = Instant::now() + options.timeout;
    // The lease wait (HACK-2669) counts against this deadline and checks the
    // frontend's liveness before every attempt.
    let engine = Engine::connect_command_until(candidate, deadline, live)?;
    let (receipt, root) = load(candidate, &engine, options.run)?;
    super::startup::require_dependency_rebind_complete(&root, &receipt)?;
    let pending = root
        .join("state.pending")
        .try_exists()
        .map_err(|_| refused())?;
    let resource = binding(&receipt, engine.guest().boot_id(), pending, options)?;
    let container = inspect_resource(&engine, &receipt, resource)?.ok_or_else(refused)?;
    let generation = container["State"]["StartedAt"]
        .as_str()
        .filter(|s| crate::provider::engine::log_follow::valid_timestamp(s))
        .ok_or_else(refused)?
        .to_owned();
    let mounted_slot = interactive_environment_slot(&container, managed.is_some())?;
    let slot = if receipt.environment_attached {
        crate::provider::environment_recovery::active_exec_slot(
            candidate,
            engine.guest(),
            &receipt.run,
            options.service,
            &resource.name,
            mounted_slot.as_deref(),
        )?
    } else {
        None
    };
    let argv = if let Some(managed) = managed {
        #[cfg(feature = "environment-launcher")]
        {
            managed.validate_binding(&receipt.plan_id, &receipt.run)?;
            started_with_environment(receipt.environment_attached, mounted_slot.as_deref())?;
            if managed.values().len() != 1
                || managed
                    .values()
                    .get(options.service)
                    .is_none_or(|v| v.is_empty())
            {
                return Err(refused());
            }
            require_current_launcher(&container, &super::launcher::current_source()).map_err(|_| error(
                "graph_service_exec_launcher",
                "Interactive exec needs the current verified launcher. Use HACK_NO_INTERACTIVE=1 hack exec for finite exec, or restart the service with the matching candidate.",
            ))?;
            let mut argv = vec![
                "/run/hack-environment-launcher".into(),
                "--exec-environment-tty-v2".into(),
            ];
            argv.extend_from_slice(options.argv);
            argv
        }
        #[cfg(not(feature = "environment-launcher"))]
        {
            let _ = managed;
            return Err(refused());
        }
    } else {
        managed_exec_argv(&container, slot.as_deref(), options.argv)?
    };
    let fresh = || {
        live()?;
        crate::provider::managed_environment::remaining_until(deadline)?;
        let (current, root) = load(candidate, &engine, options.run)?;
        super::startup::require_dependency_rebind_complete(&root, &current)?;
        binding(
            &current,
            engine.guest().boot_id(),
            root.join("state.pending")
                .try_exists()
                .map_err(|_| refused())?,
            options,
        )?;
        let value = inspect_resource(&engine, &receipt, resource)?.ok_or_else(refused)?;
        if value["State"]["Running"] != true
            || value["State"]["Paused"] != false
            || value["State"]["Restarting"] != false
            || value["State"]["StartedAt"] != generation
        {
            return Err(refused());
        }
        Ok(())
    };
    fresh()?;
    let attached = engine.interactive_start(
        candidate,
        Binding {
            backend: Backend::Adopted,
            namespace: receipt.namespace.clone(),
            run: receipt.run.clone(),
            owner: receipt.owner.clone(),
            boot: engine.guest().boot_id().to_owned(),
            container: options.expected_container.to_owned(),
            generation: generation.clone(),
            service: options.service.to_owned(),
        },
        crate::provider::engine::interactive_exec::Command {
            argv: &argv,
            workdir: options.workdir,
            console_size,
            session,
        },
        deadline,
        &fresh,
    )?;
    // No provider mutation lease crosses the return into the terminal loop.
    Ok(attached)
}

/// Execute argv once with stdin closed and TTY disabled, retaining the VM mutation
/// lease throughout. A timeout or interrupted response is uncertain: the command
/// may still run and must not be replayed automatically. Inherits container user,
/// environment and filesystem access; command output is returned only to caller.
pub fn service_exec(
    candidate: &Candidate,
    options: ServiceExecOptions<'_>,
) -> Result<ServiceExecResult, CandidateError> {
    service_exec_inner(candidate, options, None)
}
/// Explicit fresh per-command environment; never changes the startup allocation.
pub fn service_exec_with_environment(
    candidate: &Candidate,
    options: ServiceExecOptions<'_>,
    managed: &super::super::managed_environment::Managed,
) -> Result<ServiceExecResult, CandidateError> {
    service_exec_inner(candidate, options, Some(managed))
}
fn service_exec_inner(
    candidate: &Candidate,
    options: ServiceExecOptions<'_>,
    managed: Option<&super::super::managed_environment::Managed>,
) -> Result<ServiceExecResult, CandidateError> {
    validate(&options)?;
    // Waits out a brief holder, such as the ready owner's restart supervision,
    // instead of refusing `provider_busy` at random (HACK-2669). The exec's own
    // timeout starts after acquisition. Fresh per-command values have their own
    // delivery lifetime, which started when the CLI received them: the wait stops
    // once it has passed, before admission, rather than admit a command whose
    // values can no longer be delivered.
    let check = || match managed {
        Some(managed) => {
            super::super::managed_environment::remaining_until(managed.deadline()).map(|_| ())
        }
        None => Ok(()),
    };
    let engine = Engine::connect_command(
        candidate,
        std::time::Instant::now() + super::super::lifecycle::COMMAND_LEASE_WAIT,
        &check,
    )?;
    let (receipt, root) = load(candidate, &engine, options.run)?;
    super::startup::require_dependency_rebind_complete(&root, &receipt)?;
    let pending = root.join("state.pending");
    let pending = match pending.symlink_metadata() {
        Ok(_) => true,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
        Err(_) => return Err(refused()),
    };
    let resource = binding(&receipt, engine.guest().boot_id(), pending, &options)?;
    let container = inspect_resource(&engine, &receipt, resource)?.ok_or_else(refused)?;
    if container["State"]["Running"] != true
        || container["State"]["Paused"] == true
        || container["State"]["Restarting"] == true
    {
        return Err(refused());
    }
    let result = if let Some(managed) = managed {
        #[cfg(all(target_os = "macos", feature = "environment-launcher"))]
        {
            managed.validate_binding(&receipt.plan_id, &receipt.run)?;
            let mounted = mounted_environment_slot(&container)?;
            started_with_environment(receipt.environment_attached, mounted.as_deref())?;
            let slot = super::super::environment_recovery::active_exec_slot(
                candidate,
                engine.guest(),
                &receipt.run,
                options.service,
                &resource.name,
                mounted.as_deref(),
            )?;
            // The existing allocation must still belong to this exact container.
            // Its expiry is not renewed or read; only this command gets fresh values.
            managed_exec_argv(&container, slot.as_deref(), options.argv)?;

            if managed.values().len() != 1 {
                return Err(refused());
            }
            let values = managed
                .values()
                .get(options.service)
                .filter(|v| !v.is_empty())
                .ok_or_else(refused)?;
            require_current_launcher(&container, &super::launcher::current_source())?;
            let mut argv = vec![
                "/run/hack-environment-launcher".into(),
                "--exec-environment-stdin-v1".into(),
            ];
            argv.extend_from_slice(options.argv);
            // The values' lifetime bounds their delivery; the exec's own timeout bounds the
            // command and its output (HACK-2357).
            let deadline = std::time::Instant::now() + options.timeout;
            engine.service_exec_private(
                options.expected_container,
                &argv,
                options.workdir,
                deadline,
                managed.deadline(),
                values,
            )?
        }
        #[cfg(not(all(target_os = "macos", feature = "environment-launcher")))]
        {
            let _ = managed;
            return Err(refused());
        }
    } else {
        let selected = if receipt.environment_attached {
            super::super::environment_recovery::active_exec_slot(
                candidate,
                engine.guest(),
                &receipt.run,
                options.service,
                &resource.name,
                mounted_environment_slot(&container)?.as_deref(),
            )?
        } else {
            None
        };
        if selected.is_some() && !options.argv[0].starts_with('/') {
            #[cfg(all(target_os = "macos", feature = "environment-launcher"))]
            require_current_launcher(&container, &super::launcher::current_source())?;
            #[cfg(not(all(target_os = "macos", feature = "environment-launcher")))]
            return Err(refused());
        }
        let argv = managed_exec_argv(&container, selected.as_deref(), options.argv)?;
        engine.service_exec(
            options.expected_container,
            &argv,
            options.workdir,
            options.timeout,
        )?
    };
    // An external engine mutation must not be mistaken for a stable completion.
    if inspect_resource(&engine, &receipt, resource)
        .ok()
        .flatten()
        .is_none()
    {
        return Err(error(
            "graph_service_exec_uncertain",
            "Service identity changed after exec; command effects may have occurred. No request was replayed.",
        ));
    }
    Ok(ServiceExecResult {
        exit_code: result.exit_code,
        stdout_base64: base64::engine::general_purpose::STANDARD.encode(result.stdout),
        stderr_base64: base64::engine::general_purpose::STANDARD.encode(result.stderr),
        truncated: result.truncated,
    })
}

#[cfg(any(all(target_os = "macos", feature = "environment-launcher"), test))]
fn require_current_launcher(container: &Value, source: &str) -> Result<(), CandidateError> {
    let mounts = container["HostConfig"]["Mounts"]
        .as_array()
        .ok_or_else(refused)?;
    let selected: Vec<_> = mounts
        .iter()
        .filter(|m| m["Target"] == "/run/hack-environment-launcher")
        .collect();
    if selected.len() != 1
        || selected[0]["Type"] != "bind"
        || selected[0]["ReadOnly"] != true
        || selected[0]["Source"] != source
    {
        return Err(error(
            "graph_service_exec_launcher",
            "Fresh exec requires the current verified launcher already mounted in this service; restart with the matching candidate before retrying.",
        ));
    }
    Ok(())
}

/// A peer service's allocation cannot require fresh delivery for this container.
/// Attached values still require a fresh envelope; partial mounts never count as absence.
#[cfg(any(target_os = "macos", test))]
fn interactive_environment_slot(
    container: &Value,
    fresh: bool,
) -> Result<Option<String>, CandidateError> {
    let slot = mounted_environment_slot(container)?;
    managed_exec_argv(container, slot.as_deref(), &["/bin/true".into()])?;
    if slot.is_some() && !fresh {
        return Err(error(
            "interactive_exec_environment_required",
            "Interactive exec requires fresh selected-service environment delivery. Use HACK_NO_INTERACTIVE=1 hack exec for finite exec, or restart the service with the current candidate.",
        ));
    }
    Ok(slot)
}

/// Infer only from the exact inspected container, never historical run inventory.
fn mounted_environment_slot(container: &Value) -> Result<Option<String>, CandidateError> {
    let mounts = container["HostConfig"]["Mounts"]
        .as_array()
        .ok_or_else(refused)?;
    let mut payloads = mounts
        .iter()
        .filter(|m| m["Target"] == "/run/hack-environment.json");
    let Some(payload) = payloads.next() else {
        return Ok(None);
    };
    if payloads.next().is_some() || payload["Type"] != "bind" || payload["ReadOnly"] != true {
        return Err(refused());
    }
    let slot = payload["Source"]
        .as_str()
        .and_then(|source| source.strip_prefix("/run/"))
        .and_then(|source| source.strip_suffix("/values.json"))
        .filter(|slot| !slot.contains('/') && slot.starts_with("hack-env-lease-"))
        .ok_or_else(refused)?;
    // Check the complete mount trio before loading any allocation metadata.
    managed_exec_argv(container, Some(slot), &["/bin/true".into()])?;
    Ok(Some(slot.into()))
}
/// Reuse only the service's already attached environment. The guest launcher checks
/// owner-only payload files and the original expiry; exec never renews the lease.
fn managed_exec_argv(
    container: &Value,
    slot: Option<&str>,
    argv: &[String],
) -> Result<Vec<String>, CandidateError> {
    const LAUNCHER: &str = "/run/hack-environment-launcher";
    const PAYLOAD: &str = "/run/hack-environment.json";
    const EXPIRY: &str = "/run/hack-environment.expires";
    let mounts = container["HostConfig"]["Mounts"].as_array();
    let selected = |target: &str| -> Result<Option<&Value>, CandidateError> {
        let mut matches = mounts
            .into_iter()
            .flatten()
            .filter(|m| m["Target"] == target);
        let found = matches.next();
        if matches.next().is_some() {
            return Err(refused());
        }
        Ok(found)
    };
    let launcher = selected(LAUNCHER)?;
    let payload = selected(PAYLOAD)?;
    let expiry = selected(EXPIRY)?;
    let Some(slot) = slot else {
        if launcher.is_some() || payload.is_some() || expiry.is_some() {
            return Err(refused());
        }
        return Ok(argv.to_vec());
    };
    let valid_mount = |mount: Option<&Value>, source: &str| {
        mount.is_some_and(|m| m["Type"] == "bind" && m["Source"] == source && m["ReadOnly"] == true)
    };
    let launcher_source = launcher
        .and_then(|m| m["Source"].as_str())
        .ok_or_else(refused)?;
    if !launcher_source
        .strip_prefix("/storage/hack-environment-launcher/")
        .is_some_and(|hash| hex(hash, 64))
        || !valid_mount(launcher, launcher_source)
        || !valid_mount(payload, &format!("/run/{slot}/values.json"))
        || !valid_mount(expiry, &format!("/run/{slot}/expires"))
    {
        return Err(refused());
    }
    let mut wrapped = vec![LAUNCHER.into()];
    if !argv.first().is_some_and(|arg| arg.starts_with('/')) {
        // The caller checked that this exact container mounts the current
        // launcher before selecting the new PATH-aware mode.
        wrapped.push("--exec-mounted-v1".into());
    }
    wrapped.extend([PAYLOAD.into(), EXPIRY.into()]);
    wrapped.extend_from_slice(argv);
    Ok(wrapped)
}

fn binding<'a>(
    receipt: &'a Receipt,
    boot: &str,
    pending: bool,
    options: &ServiceExecOptions<'_>,
) -> Result<&'a Resource, CandidateError> {
    if !matches!(receipt.phase.as_str(), "ready-observed" | STARTED_OBSERVED)
        || pending
        || boot != options.expected_boot
        || service_exec_generation(receipt)? != options.expected_generation
    {
        return Err(refused());
    }
    let resource = receipt
        .resources
        .get(&format!("container:{}", options.service))
        .ok_or_else(refused)?;
    // While warming (`started-observed`, as Compose `exec`), only a started service.
    if resource.kind != Kind::Container
        || resource.key != options.service
        || resource.id.as_deref() != Some(options.expected_container)
        || (receipt.phase == STARTED_OBSERVED && resource.phase != "started")
    {
        return Err(refused());
    }
    Ok(resource)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fresh_exec_refuses_old_missing_duplicate_and_writable_launchers() {
        let source = format!("/storage/hack-environment-launcher/{}", "a".repeat(64));
        let valid = json!({"Type":"bind","Target":"/run/hack-environment-launcher","Source":source,"ReadOnly":true});
        let container = |mounts: Value| json!({"HostConfig":{"Mounts":mounts}});
        assert!(require_current_launcher(&container(json!([valid.clone()])), &source).is_ok());
        assert!(require_current_launcher(&container(json!([])), &source).is_err());
        assert!(
            require_current_launcher(&container(json!([valid.clone(), valid.clone()])), &source)
                .is_err()
        );
        let mut old = valid.clone();
        old["Source"] = json!("/storage/hack-environment-launcher/old");
        assert!(require_current_launcher(&container(json!([old])), &source).is_err());
        let mut writable = valid;
        writable["ReadOnly"] = json!(false);
        assert!(require_current_launcher(&container(json!([writable])), &source).is_err());
    }
    #[test]
    fn managed_exec_reuses_only_exact_readonly_bound_mounts() {
        let slot = "owned-slot";
        let args = vec!["/bin/sh".into(), "-c".into(), "exit 7".into()];
        let mut container = json!({"HostConfig":{"Mounts":[
            {"Type":"bind","Source":format!("/storage/hack-environment-launcher/{}", "a".repeat(64)),"Target":"/run/hack-environment-launcher","ReadOnly":true},
            {"Type":"bind","Source":"/run/owned-slot/values.json","Target":"/run/hack-environment.json","ReadOnly":true},
            {"Type":"bind","Source":"/run/owned-slot/expires","Target":"/run/hack-environment.expires","ReadOnly":true}
        ]}});
        let wrapped = managed_exec_argv(&container, Some(slot), &args).unwrap();
        assert_eq!(&wrapped[3..], args);
        assert_eq!(wrapped[0], "/run/hack-environment-launcher");
        assert!(managed_exec_argv(&container, None, &args).is_err());
        assert!(managed_exec_argv(&container, Some("another-slot"), &args).is_err());
        assert_eq!(
            managed_exec_argv(&container, Some(slot), &["bun".into(), "--version".into()]).unwrap(),
            vec![
                "/run/hack-environment-launcher",
                "--exec-mounted-v1",
                "/run/hack-environment.json",
                "/run/hack-environment.expires",
                "bun",
                "--version"
            ]
        );
        container["HostConfig"]["Mounts"][1]["ReadOnly"] = json!(false);
        assert!(managed_exec_argv(&container, Some(slot), &args).is_err());
        let plain = json!({"HostConfig":{"Mounts":[]}});
        assert_eq!(managed_exec_argv(&plain, None, &args).unwrap(), args);
        assert!(managed_exec_argv(&plain, Some(slot), &args).is_err());
    }
    #[test]
    fn interactive_fresh_delivery_depends_on_selected_container_mounts() {
        let slot = format!(
            "hack-env-lease-dddddddd-dddd-4ddd-8ddd-dddddddddddd-{}",
            "a".repeat(32)
        );
        let managed = json!({"HostConfig":{"Mounts":[
            {"Type":"bind","Source":format!("/storage/hack-environment-launcher/{}", "a".repeat(64)),"Target":"/run/hack-environment-launcher","ReadOnly":true},
            {"Type":"bind","Source":format!("/run/{slot}/values.json"),"Target":"/run/hack-environment.json","ReadOnly":true},
            {"Type":"bind","Source":format!("/run/{slot}/expires"),"Target":"/run/hack-environment.expires","ReadOnly":true}
        ]}});
        let plain = json!({"HostConfig":{"Mounts":[]}});
        // Both services may share a graph whose environment_attached bit is true.
        assert_eq!(interactive_environment_slot(&plain, false).unwrap(), None);
        assert_eq!(
            interactive_environment_slot(&managed, false)
                .unwrap_err()
                .code,
            "interactive_exec_environment_required"
        );
        assert_eq!(
            interactive_environment_slot(&managed, true).unwrap(),
            Some(slot)
        );
        for fresh in [false, true] {
            let mut partial = managed.clone();
            partial["HostConfig"]["Mounts"]
                .as_array_mut()
                .unwrap()
                .remove(1);
            assert!(interactive_environment_slot(&partial, fresh).is_err());
            let mut writable = managed.clone();
            writable["HostConfig"]["Mounts"][1]["ReadOnly"] = json!(false);
            assert!(interactive_environment_slot(&writable, fresh).is_err());
        }
    }
    #[test]
    fn mounted_allocation_selection_rejects_ambiguous_partial_or_escaping_mounts() {
        let slot = format!(
            "hack-env-lease-dddddddd-dddd-4ddd-8ddd-dddddddddddd-{}",
            "a".repeat(32)
        );
        let valid = json!({"HostConfig":{"Mounts":[
            {"Type":"bind","Source":format!("/storage/hack-environment-launcher/{}", "a".repeat(64)),"Target":"/run/hack-environment-launcher","ReadOnly":true},
            {"Type":"bind","Source":format!("/run/{slot}/values.json"),"Target":"/run/hack-environment.json","ReadOnly":true},
            {"Type":"bind","Source":format!("/run/{slot}/expires"),"Target":"/run/hack-environment.expires","ReadOnly":true}
        ]}});
        assert_eq!(mounted_environment_slot(&valid).unwrap(), Some(slot));
        let mut duplicate = valid.clone();
        let payload = duplicate["HostConfig"]["Mounts"][1].clone();
        duplicate["HostConfig"]["Mounts"]
            .as_array_mut()
            .unwrap()
            .push(payload);
        assert!(mounted_environment_slot(&duplicate).is_err());
        for source in [
            "/run/hack-env-lease-../other/values.json",
            "/run/foreign/values.json",
        ] {
            let mut changed = valid.clone();
            changed["HostConfig"]["Mounts"][1]["Source"] = json!(source);
            assert!(mounted_environment_slot(&changed).is_err());
        }
        let mut partial = valid.clone();
        partial["HostConfig"]["Mounts"]
            .as_array_mut()
            .unwrap()
            .pop();
        assert!(mounted_environment_slot(&partial).is_err());
        let mut writable = valid;
        writable["HostConfig"]["Mounts"][1]["ReadOnly"] = json!(false);
        assert!(mounted_environment_slot(&writable).is_err());
    }
    #[test]
    fn rejects_unsafe_or_unbounded_arguments_before_connecting() {
        let run = "a".repeat(32);
        let id = "b".repeat(64);
        let args = vec!["/bin/true".into()];
        let mut opts = ServiceExecOptions {
            run: &run,
            service: "web",
            expected_container: &id,
            expected_boot: "boot",
            expected_generation: &id,
            argv: &args,
            workdir: None,
            timeout: Duration::from_secs(1),
        };
        assert!(validate(&opts).is_ok());
        opts.service = "../web";
        assert!(validate(&opts).is_err());
        opts.service = "web";
        opts.workdir = Some("relative");
        assert!(validate(&opts).is_err());
        opts.workdir = None;
        opts.timeout = Duration::ZERO;
        assert!(validate(&opts).is_err());
        opts.timeout = Duration::from_secs(1);
        let bad = vec!["bad\0command".into()];
        opts.argv = &bad;
        assert!(validate(&opts).is_err());
        let large = vec!["a".repeat(16385)];
        opts.argv = &large;
        assert!(validate(&opts).is_err());
        opts.argv = &[];
        assert!(validate(&opts).is_err());
    }
    #[test]
    fn stale_boot_receipt_container_and_pending_journal_refuse() {
        let id = "e".repeat(64);
        let mut receipt: Receipt = serde_json::from_value(json!({"version":1,"run":"a".repeat(32),"owner":"b".repeat(32),"namespace":"c".repeat(64),"plan_id":"d".repeat(64),"phase":"ready-observed","readiness":{},"resources":{"container:web":{"kind":"container","key":"web","name":"owned-web","id":id,"image":null,"phase":"started"}}})).unwrap();
        let generation = service_exec_generation(&receipt).unwrap();
        let args = vec!["true".into()];
        let opts = ServiceExecOptions {
            run: &receipt.run.clone(),
            service: "web",
            expected_container: &id,
            expected_boot: "boot-one",
            expected_generation: &generation,
            argv: &args,
            workdir: None,
            timeout: Duration::from_secs(1),
        };
        assert!(binding(&receipt, "boot-one", false, &opts).is_ok());
        assert!(binding(&receipt, "boot-two", false, &opts).is_err());
        assert!(binding(&receipt, "boot-one", true, &opts).is_err());
        receipt.resources.get_mut("container:web").unwrap().id = Some("f".repeat(64));
        assert!(binding(&receipt, "boot-one", false, &opts).is_err());
        receipt.resources.get_mut("container:web").unwrap().id = Some(id.clone());
        receipt.phase = "cleanup-intent".into();
        assert!(binding(&receipt, "boot-one", false, &opts).is_err());
    }
    #[test]
    fn exec_reaches_a_started_service_of_a_warming_graph() {
        let id = "e".repeat(64);
        let mut receipt: Receipt = serde_json::from_value(json!({"version":1,"run":"a".repeat(32),"owner":"b".repeat(32),"namespace":"c".repeat(64),"plan_id":"d".repeat(64),"phase":"preparing","readiness":{},"resources":{"container:web":{"kind":"container","key":"web","name":"owned-web","id":id,"image":null,"phase":"started"}}})).unwrap();
        super::super::mark_started(&mut receipt).unwrap();
        let args = vec!["true".into()];
        let generation = service_exec_generation(&receipt).unwrap();
        let opts = ServiceExecOptions {
            run: &receipt.run.clone(),
            service: "web",
            expected_container: &id,
            expected_boot: "boot-one",
            expected_generation: &generation,
            argv: &args,
            workdir: None,
            timeout: Duration::from_secs(1),
        };
        assert!(binding(&receipt, "boot-one", false, &opts).is_ok());
        // A service the warming graph has not started is refused.
        receipt.resources.get_mut("container:web").unwrap().phase = "create-intent".into();
        let generation = service_exec_generation(&receipt).unwrap();
        let opts = ServiceExecOptions {
            expected_generation: &generation,
            ..opts
        };
        assert!(binding(&receipt, "boot-one", false, &opts).is_err());
        // A start still in progress is refused as before.
        receipt.set_phase("preparing");
        receipt.resources.get_mut("container:web").unwrap().phase = "started".into();
        let generation = service_exec_generation(&receipt).unwrap();
        let opts = ServiceExecOptions {
            expected_generation: &generation,
            ..opts
        };
        assert!(binding(&receipt, "boot-one", false, &opts).is_err());
    }

    #[test]
    fn new_env_on_a_run_without_delivery_names_the_restart() {
        // HACK-2740: a fixed, one-line sentence the CLI prints as is.
        let value = serde_json::to_value(environment_changed()).unwrap();
        assert_eq!(value["code"], "graph_service_exec_environment_changed");
        assert_eq!(value["message_fixed"], true);
        let message = value["message"].as_str().unwrap();
        assert!(message.len() <= 400 && message.bytes().all(|b| (0x20..0x7f).contains(&b)));
        assert!(message.contains("hack down, then hack up"));
        // Per service: another service's delivery does not count for this one.
        let slot = Some("hack-env-lease-1");
        assert!(started_with_environment(true, slot).is_ok());
        for (attached, mounted) in [(true, None), (false, slot), (false, None)] {
            assert_eq!(
                started_with_environment(attached, mounted)
                    .unwrap_err()
                    .code,
                "graph_service_exec_environment_changed"
            );
        }
    }
}
