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
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn refused() -> CandidateError {
    error(
        "graph_service_exec",
        "Service exec requires a current ready graph, exact container and boot identities, bounded argv, and noninteractive input.",
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
    let engine = Engine::connect(candidate)?;
    let (receipt, root) = load(candidate, &engine, options.run)?;
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
            if !receipt.environment_attached {
                return Err(refused());
            }
            let slot = super::super::environment_recovery::active_exec_slot(
                candidate,
                engine.guest(),
                &receipt.run,
                options.service,
                &resource.name,
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
            if !options.argv[0].starts_with('/') {
                return Err(error(
                    "graph_service_exec_path",
                    "Managed native exec requires an absolute executable path.",
                ));
            }
            let mut argv = vec![
                "/run/hack-environment-launcher".into(),
                "--exec-environment-stdin-v1".into(),
            ];
            argv.extend_from_slice(options.argv);
            let deadline = managed
                .deadline()
                .min(std::time::Instant::now() + options.timeout);
            engine.service_exec_private(
                options.expected_container,
                &argv,
                options.workdir,
                deadline,
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
            )?
        } else {
            None
        };
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
    // Existing mounted launcher versions require an absolute executable. Refuse
    // before creating an exec instead of silently dropping private environment.
    if !argv.first().is_some_and(|arg| arg.starts_with('/')) {
        return Err(error(
            "graph_service_exec_path",
            "Managed native exec requires an absolute executable path.",
        ));
    }
    let mut wrapped = vec![LAUNCHER.into(), PAYLOAD.into(), EXPIRY.into()];
    wrapped.extend_from_slice(argv);
    Ok(wrapped)
}

fn binding<'a>(
    receipt: &'a Receipt,
    boot: &str,
    pending: bool,
    options: &ServiceExecOptions<'_>,
) -> Result<&'a Resource, CandidateError> {
    if receipt.phase != "ready-observed"
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
    if resource.kind != Kind::Container
        || resource.key != options.service
        || resource.id.as_deref() != Some(options.expected_container)
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
        assert!(managed_exec_argv(&container, Some(slot), &["bun".into()]).is_err());
        container["HostConfig"]["Mounts"][1]["ReadOnly"] = json!(false);
        assert!(managed_exec_argv(&container, Some(slot), &args).is_err());
        let plain = json!({"HostConfig":{"Mounts":[]}});
        assert_eq!(managed_exec_argv(&plain, None, &args).unwrap(), args);
        assert!(managed_exec_argv(&plain, Some(slot), &args).is_err());
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
}
