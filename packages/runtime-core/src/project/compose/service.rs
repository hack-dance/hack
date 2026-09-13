use super::super::*;
use super::fields::*;
use serde_json::{Map, Value};
use std::{collections::BTreeSet, fs, os::unix::fs::MetadataExt};

fn build(
    project: &Path,
    base: &Path,
    value: Option<&Value>,
    field: &str,
    diagnostics: &mut Vec<Diagnostic>,
) -> Result<Option<BuildPlan>, CandidateError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let (context, dockerfile, target, args) = match value {
        Value::String(s) => (s.as_str(), "Dockerfile", None, BTreeMap::new()),
        Value::Object(m) => {
            keys(
                m,
                &["context", "dockerfile", "target", "args"],
                field,
                diagnostics,
            );
            let target = optional_text(m.get("target"))?;
            if let Some(target) = &target {
                identifier(target)?;
            }
            (
                m.get("context").map(string).transpose()?.unwrap_or("."),
                m.get("dockerfile")
                    .map(string)
                    .transpose()?
                    .unwrap_or("Dockerfile"),
                target,
                redacted_map(m.get("args"), true)?,
            )
        }
        _ => {
            return Err(problem(
                "invalid_build",
                "Build must be a local context string or mapping.",
            ));
        }
    };
    let context = source::resolve(project, base, context, false)?;
    if !context.is_dir() {
        return Err(problem(
            "invalid_build",
            "Build context must be an existing project directory.",
        ));
    }
    let dockerfile = source::resolve(project, &context, dockerfile, false)?;
    if !dockerfile.is_file() {
        return Err(problem(
            "invalid_build",
            "Dockerfile must be an existing regular project file.",
        ));
    }
    Ok(Some(BuildPlan { context:relative(project,&context), dockerfile:relative(project,&dockerfile), target, arguments:args, context_policy:"filtered node-native source; Dockerfile is not executed or read; actual build qualification remains WU04/WU07".into() }))
}
fn mounts(
    project: &Path,
    base: &Path,
    value: Option<&Value>,
    declared: &BTreeMap<String, VolumePlan>,
    field: &str,
    diagnostics: &mut Vec<Diagnostic>,
) -> Result<Vec<MountPlan>, CandidateError> {
    let Some(value) = value else {
        return Ok(vec![]);
    };
    let values = value
        .as_array()
        .ok_or_else(|| problem("invalid_mount", "Volumes must be a list."))?;
    let mut result = Vec::new();
    let mut targets = BTreeSet::new();
    for value in values {
        let (kind, from, to, read_only) = match value {
            Value::String(s) => {
                let parts: Vec<_> = s.split(':').collect();
                if !(2..=3).contains(&parts.len()) {
                    return Err(problem(
                        "invalid_mount",
                        "Use source:target[:ro|rw]; anonymous volumes and colon-bearing paths are outside this subset.",
                    ));
                }
                let readonly = match parts.get(2).copied().unwrap_or("rw") {
                    "ro" => true,
                    "rw" => false,
                    _ => {
                        return Err(problem(
                            "unsupported_mount_option",
                            "Only ro/rw mount modes are supported.",
                        ));
                    }
                };
                (
                    if parts[0].starts_with('.') || parts[0].starts_with('/') {
                        "bind"
                    } else {
                        "volume"
                    },
                    parts[0],
                    parts[1],
                    readonly,
                )
            }
            Value::Object(m) => {
                keys(
                    m,
                    &["type", "source", "target", "read_only"],
                    field,
                    diagnostics,
                );
                (
                    m.get("type").map(string).transpose()?.unwrap_or("volume"),
                    string(
                        m.get("source")
                            .ok_or_else(|| problem("invalid_mount", "Mount source is required."))?,
                    )?,
                    string(
                        m.get("target")
                            .ok_or_else(|| problem("invalid_mount", "Mount target is required."))?,
                    )?,
                    boolean(m.get("read_only"), false)?,
                )
            }
            _ => return Err(problem("invalid_mount", "Invalid mount form.")),
        };
        let target = safe_absolute(to)?;
        if target == "/"
            || ["/proc", "/sys", "/dev", "/run", "/var/run"]
                .iter()
                .any(|p| target == *p || target.starts_with(&format!("{p}/")))
        {
            diagnostics.push(Diagnostic::error(
                "reserved_mount_target",
                field,
                "Root, kernel and runtime socket directories cannot be replaced by project mounts.",
            ));
        }
        if !targets.insert(target.clone()) {
            return Err(problem(
                "duplicate_mount_target",
                "Mount targets must be unique per service.",
            ));
        }
        if from.contains('$') || from.starts_with('~') {
            diagnostics.push(Diagnostic::error("unresolved_mount_source",field,"Interpolated or home-relative mount sources are not resolved from ambient environment. Credential directories require scoped credential delivery; declare ordinary source paths relative to the project."));
            result.push(MountPlan {
                kind: "unresolved".into(),
                source: "[unresolved]".into(),
                target,
                read_only,
                source_policy: "refused; no host environment lookup or credential-directory mount"
                    .into(),
            });
            continue;
        }
        let (source, policy) = match kind {
            "bind" => (
                relative(project, &source::resolve(project, base, from, false)?),
                "filtered node-native source; never a direct host mount",
            ),
            "volume" => {
                identifier(from)?;
                if !declared.contains_key(from) {
                    diagnostics.push(Diagnostic::error(
                        "undeclared_volume",
                        field,
                        "Named volumes must be declared and owned by this candidate.",
                    ));
                }
                (
                    from.into(),
                    "candidate-owned volume; no existing v4/global volume adoption",
                )
            }
            _ => {
                diagnostics.push(Diagnostic::error(
                    "unsupported_mount_type",
                    field,
                    "Only project-local bind source and owned named volumes are modeled.",
                ));
                ("[unsupported]".into(), "unsupported")
            }
        };
        result.push(MountPlan {
            kind: if ["bind", "volume"].contains(&kind) {
                kind.into()
            } else {
                "[unsupported]".into()
            },
            source,
            target,
            read_only,
            source_policy: policy.into(),
        });
    }
    Ok(result)
}
fn port_number(value: &str) -> Result<u16, CandidateError> {
    value.parse::<u16>().ok().filter(|p| *p>0).ok_or_else(|| problem("invalid_port", "Ports must be literal integers from 1 to 65535; ranges/interpolation are not supported."))
}
fn port_scalar(value: &Value) -> Result<u16, CandidateError> {
    match value {
        Value::String(s) => port_number(s),
        Value::Number(n) => port_number(&n.to_string()),
        _ => Err(problem("invalid_port", "Invalid port value.")),
    }
}
fn ports(
    value: Option<&Value>,
    field: &str,
    diagnostics: &mut Vec<Diagnostic>,
) -> Result<Vec<PortPlan>, CandidateError> {
    let Some(value) = value else {
        return Ok(vec![]);
    };
    let mut result = Vec::new();
    for value in value
        .as_array()
        .ok_or_else(|| problem("invalid_port", "Ports must be a list."))?
    {
        let (target, published, protocol, host) = if let Value::Object(m) = value {
            keys(
                m,
                &["target", "published", "protocol", "host_ip"],
                field,
                diagnostics,
            );
            (
                port_scalar(
                    m.get("target")
                        .ok_or_else(|| problem("invalid_port", "Port target is required."))?,
                )?,
                m.get("published").map(port_scalar).transpose()?,
                m.get("protocol")
                    .map(string)
                    .transpose()?
                    .unwrap_or("tcp")
                    .to_owned(),
                m.get("host_ip")
                    .map(string)
                    .transpose()?
                    .unwrap_or("0.0.0.0")
                    .to_owned(),
            )
        } else {
            let text = match value {
                Value::String(s) => s.clone(),
                Value::Number(n) => n.to_string(),
                _ => return Err(problem("invalid_port", "Invalid port form.")),
            };
            let (binding, protocol) = text.split_once('/').unwrap_or((&text, "tcp"));
            let parts: Vec<_> = binding.split(':').collect();
            match parts.as_slice() {
                [target] => (
                    port_number(target)?,
                    None,
                    protocol.into(),
                    "0.0.0.0".into(),
                ),
                [published, target] => (
                    port_number(target)?,
                    Some(port_number(published)?),
                    protocol.into(),
                    "0.0.0.0".into(),
                ),
                [host, published, target] => (
                    port_number(target)?,
                    Some(port_number(published)?),
                    protocol.into(),
                    host.to_string(),
                ),
                _ => return Err(problem("invalid_port", "Unsupported port syntax.")),
            }
        };
        if !["tcp", "udp"].contains(&protocol.as_str()) {
            return Err(problem(
                "invalid_port",
                "Only TCP and UDP ports are modeled.",
            ));
        }
        if !["0.0.0.0", "127.0.0.1"].contains(&host.as_str()) {
            diagnostics.push(Diagnostic::error("unsupported_host_binding",field,"Only explicit IPv4 loopback or an explicit proposal to restrict an all-interface binding is supported."));
        }
        if host == "0.0.0.0" {
            diagnostics.push(Diagnostic::warning("proposed_loopback_binding",field,"Enrollment proposes restricting the declared all-interface publication to 127.0.0.1. No port is bound by this checkpoint."));
        }
        result.push(PortPlan {
            target,
            published,
            protocol,
            declared_host_ip: if ["0.0.0.0", "127.0.0.1"].contains(&host.as_str()) {
                host
            } else {
                "[unsupported]".into()
            },
            proposed_host_ip: "127.0.0.1".into(),
        });
    }
    Ok(result)
}
fn dependencies(
    value: Option<&Value>,
    field: &str,
    diagnostics: &mut Vec<Diagnostic>,
) -> Result<BTreeMap<String, DependencyPlan>, CandidateError> {
    let mut result = BTreeMap::new();
    match value {
        None => {}
        Some(Value::Array(values)) => {
            for value in values {
                let name = string(value)?;
                identifier(name)?;
                if result
                    .insert(
                        name.into(),
                        DependencyPlan {
                            condition: "service_started".into(),
                        },
                    )
                    .is_some()
                {
                    return Err(problem(
                        "duplicate_dependency",
                        "Dependency declared more than once.",
                    ));
                }
            }
        }
        Some(Value::Object(values)) => {
            for (name, value) in values {
                identifier(name)?;
                let m = object(value)?;
                keys(m, &["condition", "required", "restart"], field, diagnostics);
                if !boolean(m.get("required"), true)? || boolean(m.get("restart"), false)? {
                    diagnostics.push(Diagnostic::error("unsupported_dependency_option",field,"Optional or restart-propagating dependencies are not supported by this subset."));
                }
                let condition = m
                    .get("condition")
                    .map(string)
                    .transpose()?
                    .unwrap_or("service_started");
                if ![
                    "service_started",
                    "service_healthy",
                    "service_completed_successfully",
                ]
                .contains(&condition)
                {
                    return Err(problem(
                        "invalid_dependency_condition",
                        "Unsupported dependency condition.",
                    ));
                }
                result.insert(
                    name.clone(),
                    DependencyPlan {
                        condition: condition.into(),
                    },
                );
            }
        }
        _ => {
            return Err(problem(
                "invalid_dependency",
                "depends_on must be a list or mapping.",
            ));
        }
    }
    Ok(result)
}
fn health(
    value: Option<&Value>,
    field: &str,
    diagnostics: &mut Vec<Diagnostic>,
) -> Result<Option<HealthPlan>, CandidateError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let m = object(value)?;
    keys(
        m,
        &[
            "test",
            "disable",
            "interval",
            "timeout",
            "start_period",
            "retries",
        ],
        field,
        diagnostics,
    );
    let mut disabled = boolean(m.get("disable"), false)?;
    let test = match m.get("test") {
        Some(Value::String(text)) => Some(CommandPlan {
            form: "CMD-SHELL".into(),
            arguments: vec![redacted(text)?],
            review_field: format!("{field}.test"),
        }),
        Some(Value::Array(values)) => {
            let kind = values.first().map(string).transpose()?.unwrap_or("");
            if !["CMD", "CMD-SHELL", "NONE"].contains(&kind) {
                return Err(problem(
                    "invalid_healthcheck",
                    "Health test must begin with CMD, CMD-SHELL or NONE.",
                ));
            }
            if (kind == "NONE" && values.len() != 1)
                || (kind == "CMD-SHELL" && values.len() != 2)
                || (kind == "CMD" && values.len() < 2)
            {
                return Err(problem(
                    "invalid_healthcheck",
                    "Invalid health test argument count.",
                ));
            }
            disabled |= kind == "NONE";
            Some(CommandPlan {
                form: kind.into(),
                arguments: values[1..]
                    .iter()
                    .map(|v| redacted(string(v)?))
                    .collect::<Result<_, _>>()?,
                review_field: format!("{field}.test"),
            })
        }
        None => None,
        _ => return Err(problem("invalid_healthcheck", "Invalid health test form.")),
    };
    Ok(Some(HealthPlan {
        disabled,
        test,
        interval_nanos: duration(m.get("interval"))?,
        timeout_nanos: duration(m.get("timeout"))?,
        start_period_nanos: duration(m.get("start_period"))?,
        retries: m.get("retries").map(positive_u32).transpose()?,
    }))
}

fn environment_files(
    project: &Path,
    base: &Path,
    value: Option<&Value>,
    field: &str,
    diagnostics: &mut Vec<Diagnostic>,
) -> Result<Vec<String>, CandidateError> {
    let values: Vec<&Value> = match value {
        None => vec![],
        Some(Value::Array(v)) => v.iter().collect(),
        Some(v) => vec![v],
    };
    let mut result = Vec::new();
    for value in values {
        let path = if let Value::Object(m) = value {
            keys(m, &["path", "required", "format"], field, diagnostics);
            if !boolean(m.get("required"), true)?
                || m.get("format")
                    .is_some_and(|v| v.as_str() != Some("default"))
            {
                diagnostics.push(Diagnostic::error("unsupported_env_file_mode",field,"Only required default-format env_file references are modeled. Their contents are never read during planning."));
            }
            string(
                m.get("path")
                    .ok_or_else(|| problem("invalid_env_file", "env_file.path is required."))?,
            )?
        } else {
            string(value)?
        };
        let resolved = source::resolve(project, base, path, true)?;
        if resolved
            .file_name()
            .is_some_and(|name| name == ".gitignore" || name == ".ignore")
        {
            return Err(problem(
                "conflicting_environment_owner",
                "An environment input cannot also own source ignore rules.",
            ));
        }
        let metadata = fs::symlink_metadata(&resolved)
            .map_err(|_| problem("invalid_env_file", "Cannot inspect the env_file reference."))?;
        if !metadata.is_file() || metadata.nlink() != 1 {
            return Err(problem(
                "invalid_env_file",
                "env_file must refer to a regular file; its contents are not loaded.",
            ));
        }
        let relative = relative(project, &resolved);
        if result.contains(&relative) {
            return Err(problem(
                "duplicate_env_file",
                "Duplicate environment file ownership is not accepted.",
            ));
        }
        result.push(relative);
    }
    Ok(result)
}
fn service_networks(
    value: Option<&Value>,
    diagnostics: &mut Vec<Diagnostic>,
    field: &str,
) -> Result<Vec<String>, CandidateError> {
    let mut result = match value {
        None => vec!["default".into()],
        Some(Value::Array(_)) => strings(value)?,
        Some(Value::Object(m)) => {
            for value in m.values() {
                if !value.is_null() {
                    keys(object(value)?, &[], field, diagnostics);
                }
            }
            m.keys().cloned().collect()
        }
        _ => {
            return Err(problem(
                "invalid_network",
                "Service networks must be a list or mapping.",
            ));
        }
    };
    for name in &result {
        identifier(name)?;
    }
    result.sort();
    result.dedup();
    Ok(result)
}
fn limits(
    m: &Map<String, Value>,
    field: &str,
    diagnostics: &mut Vec<Diagnostic>,
) -> Result<LimitsPlan, CandidateError> {
    let mut cpus = m.get("cpus").map(number).transpose()?;
    let mut memory = m.get("mem_limit").map(bytes).transpose()?;
    let mut pids = m.get("pids_limit").map(positive_u32).transpose()?;
    if let Some(deploy) = m.get("deploy") {
        let deploy = object(deploy)?;
        keys(
            deploy,
            &["resources"],
            &format!("{field}.deploy"),
            diagnostics,
        );
        if let Some(resources) = deploy.get("resources") {
            let resources = object(resources)?;
            keys(
                resources,
                &["limits"],
                &format!("{field}.deploy.resources"),
                diagnostics,
            );
            if let Some(value) = resources.get("limits") {
                let value = object(value)?;
                keys(
                    value,
                    &["cpus", "memory", "pids"],
                    &format!("{field}.deploy.resources.limits"),
                    diagnostics,
                );
                let dc = value.get("cpus").map(number).transpose()?;
                let dm = value.get("memory").map(bytes).transpose()?;
                let dp = value.get("pids").map(positive_u32).transpose()?;
                if cpus.zip(dc).is_some_and(|(a, b)| a != b)
                    || memory.zip(dm).is_some_and(|(a, b)| a != b)
                    || pids.zip(dp).is_some_and(|(a, b)| a != b)
                {
                    diagnostics.push(Diagnostic::error(
                        "conflicting_limits",
                        field,
                        "Service and deploy resource limits disagree.",
                    ));
                }
                cpus = cpus.or(dc);
                memory = memory.or(dm);
                pids = pids.or(dp);
            }
        }
    }
    if cpus.is_some_and(|v| v > 1024.0) {
        return Err(problem(
            "invalid_limit",
            "CPU limit exceeds the planner's bounded range.",
        ));
    }
    Ok(LimitsPlan {
        cpus,
        memory_bytes: memory,
        pids,
        shared_memory_bytes: m.get("shm_size").map(bytes).transpose()?,
    })
}
pub(super) fn compile(
    project: &Path,
    base: &Path,
    values: &Map<String, Value>,
    profiles: &[String],
    volumes: &BTreeMap<String, VolumePlan>,
    diagnostics: &mut Vec<Diagnostic>,
) -> Result<BTreeMap<String, ServicePlan>, CandidateError> {
    if values.is_empty() || values.len() > 64 {
        return Err(problem(
            "service_budget",
            "Compose requires 1 to 64 services in WU03.",
        ));
    }
    let mut result = BTreeMap::new();
    for (name, value) in values {
        identifier(name)?;
        let field = format!("services.{name}");
        let m = object(value)?;
        keys(
            m,
            &[
                "image",
                "build",
                "command",
                "entrypoint",
                "profiles",
                "volumes",
                "depends_on",
                "environment",
                "env_file",
                "healthcheck",
                "ports",
                "expose",
                "networks",
                "network_mode",
                "cpus",
                "mem_limit",
                "pids_limit",
                "shm_size",
                "deploy",
                "read_only",
                "init",
                "restart",
                "working_dir",
                "user",
                "platform",
                "labels",
                "logging",
                "stop_grace_period",
                "stop_signal",
                "privileged",
            ],
            &field,
            diagnostics,
        );
        if boolean(m.get("privileged"), false)? {
            diagnostics.push(Diagnostic::error(
                "privileged_service",
                &field,
                "Privileged containers cannot be enrolled.",
            ));
        }
        let image = image(m.get("image"), diagnostics, &format!("{field}.image"))?;
        let build = build(
            project,
            base,
            m.get("build"),
            &format!("{field}.build"),
            diagnostics,
        )?;
        if image.is_none() && build.is_none() {
            diagnostics.push(Diagnostic::error(
                "missing_service_source",
                &field,
                "A service needs a literal image or local build context.",
            ));
        }
        let mut declared_profiles = strings(m.get("profiles"))?;
        for profile in &declared_profiles {
            identifier(profile)?;
        }
        declared_profiles.sort();
        declared_profiles.dedup();
        let active =
            declared_profiles.is_empty() || declared_profiles.iter().any(|p| profiles.contains(p));
        let network_mode = m
            .get("network_mode")
            .map(string)
            .transpose()?
            .unwrap_or("project-networks");
        if !["project-networks", "none"].contains(&network_mode) {
            diagnostics.push(Diagnostic::error(
                "unsupported_network_mode",
                &field,
                "Host, service and container network namespace sharing are not supported.",
            ));
        }
        if m.contains_key("networks") && m.contains_key("network_mode") {
            diagnostics.push(Diagnostic::error(
                "conflicting_network_owners",
                &field,
                "networks and network_mode cannot both own the service network.",
            ));
        }
        let networks = if network_mode == "none" {
            vec![]
        } else {
            service_networks(m.get("networks"), diagnostics, &format!("{field}.networks"))?
        };
        let restart = m
            .get("restart")
            .map(string)
            .transpose()?
            .unwrap_or("no")
            .to_owned();
        if !["no", "always", "unless-stopped", "on-failure"].contains(&restart.as_str())
            && !restart
                .strip_prefix("on-failure:")
                .is_some_and(|n| n.parse::<u32>().is_ok_and(|n| n > 0))
        {
            return Err(problem("invalid_restart", "Unsupported restart policy."));
        }
        let labels = redacted_map(m.get("labels"), false)?;
        if labels.keys().any(|key| {
            ["caddy", "traefik", "hack", "com.docker.compose"]
                .iter()
                .any(|prefix| key == prefix || key.starts_with(&format!("{prefix}.")))
        }) {
            diagnostics.push(Diagnostic::error(
                "external_route_or_owner_label",
                &format!("{field}.labels"),
                "Existing router and runtime ownership labels are not adopted by the candidate.",
            ));
        }
        let logging = if let Some(value) = m.get("logging") {
            let map = object(value)?;
            keys(
                map,
                &["driver", "options"],
                &format!("{field}.logging"),
                diagnostics,
            );
            let driver = map
                .get("driver")
                .map(string)
                .transpose()?
                .unwrap_or("json-file");
            if !["json-file", "local", "none"].contains(&driver) {
                diagnostics.push(Diagnostic::error("external_logging_driver",&format!("{field}.logging"),"Only local, json-file and none logging drivers are modeled; external sinks are not adopted."));
            }
            if let Some(options) = map.get("options") {
                object(options)?;
            }
            Some(LoggingPlan {
                driver: if ["json-file", "local", "none"].contains(&driver) {
                    driver.into()
                } else {
                    "[unsupported]".into()
                },
                options: redacted_map(map.get("options"), false)?,
            })
        } else {
            None
        };
        let platform = optional_text(m.get("platform"))?;
        if platform
            .as_deref()
            .is_some_and(|v| !["linux/arm64", "linux/arm64/v8", "linux/amd64"].contains(&v))
        {
            return Err(problem(
                "unsupported_platform",
                "Only Linux arm64/amd64 image platform declarations are modeled.",
            ));
        }
        let exposed_ports = strings(m.get("expose"))?;
        for value in &exposed_ports {
            let (port, protocol) = value.split_once('/').unwrap_or((value, "tcp"));
            port_number(port)?;
            if !["tcp", "udp"].contains(&protocol) {
                return Err(problem("invalid_port", "Invalid exposed port protocol."));
            }
        }
        let stop_signal = optional_text(m.get("stop_signal"))?;
        if stop_signal.as_deref().is_some_and(|v| {
            ![
                "SIGTERM", "SIGINT", "SIGQUIT", "SIGKILL", "SIGUSR1", "SIGUSR2", "TERM", "INT",
                "QUIT", "KILL", "USR1", "USR2",
            ]
            .contains(&v)
        }) {
            return Err(problem("invalid_stop_signal", "Unsupported stop signal."));
        }
        result.insert(name.clone(),ServicePlan {
            image,build,
            command:command(m.get("command"),&format!("{field}.command"))?,
            entrypoint:command(m.get("entrypoint"),&format!("{field}.entrypoint"))?,
            profiles:declared_profiles,active,
            dependencies:dependencies(m.get("depends_on"),&format!("{field}.depends_on"),diagnostics)?,
            mounts:mounts(project,base,m.get("volumes"),volumes,&format!("{field}.volumes"),diagnostics)?,
            environment:redacted_map(m.get("environment"),true)?,
            environment_files:environment_files(project,base,m.get("env_file"),&format!("{field}.env_file"),diagnostics)?,
            environment_precedence:"Compose environment keys override explicitly listed env_file inputs; bare keys and references remain unresolved; no ambient/.env values are loaded".into(),
            healthcheck:health(m.get("healthcheck"),&format!("{field}.healthcheck"),diagnostics)?,
            ports:ports(m.get("ports"),&format!("{field}.ports"),diagnostics)?,exposed_ports,networks,network_mode:if ["project-networks", "none"].contains(&network_mode) {network_mode.into()} else {"[unsupported]".into()},
            limits:limits(m,&field,diagnostics)?,read_only:boolean(m.get("read_only"),false)?,init:boolean(m.get("init"),false)?,restart,
            working_dir:m.get("working_dir").map(|v| safe_absolute(string(v)?)).transpose()?,
            user:m.get("user").map(|v| match v {Value::String(s)=>redacted(s),Value::Number(n)=>redacted(&n.to_string()),_=>Err(problem("invalid_user","User must be a string or numeric identifier."))}).transpose()?,
            platform,labels,logging,stop_grace_period_nanos:duration(m.get("stop_grace_period"))?,stop_signal,
        });
    }
    Ok(result)
}
