use crate::{Diagnostic, json::child, model::*};
use std::collections::{BTreeMap, BTreeSet};

type At<'a> = dyn Fn(&str, &str) -> Diagnostic + 'a;
fn name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 63
        && value.bytes().enumerate().all(|(i, c)| {
            c.is_ascii_lowercase()
                || c.is_ascii_digit()
                || (i > 0 && matches!(c, b'-' | b'_' | b'.'))
        })
}
fn env_name(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .enumerate()
            .all(|(i, c)| c.is_ascii_alphabetic() || c == b'_' || (i > 0 && c.is_ascii_digit()))
}
// Canonical spelling only, equivalent to project.ts normalizeEnvConfigName(value) === value.
// Managed layer selection remains exclusively owned by the environment subsystem.
fn overlay_name(value: &str) -> bool {
    !value.is_empty()
        && value.split('-').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        })
}
// References use the managed owner's PROJECT_ENV_KEY_PATTERN, not arbitrary process env keys.
fn managed_key(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .enumerate()
            .all(|(i, b)| b.is_ascii_uppercase() || b == b'_' || (i > 0 && b.is_ascii_digit()))
}
fn relative(value: &str) -> Option<String> {
    if value.starts_with('/') || value.contains(['\\', '\0', ':']) || value.is_empty() {
        return None;
    }
    let mut parts = Vec::new();
    for part in value.split('/') {
        match part {
            ".." => return None,
            "" | "." => {}
            other => parts.push(other),
        }
    }
    Some(if parts.is_empty() {
        ".".into()
    } else {
        parts.join("/")
    })
}
fn absolute(value: &str) -> Option<String> {
    if !value.starts_with('/')
        || value.contains(['\\', '\0'])
        || value.split('/').any(|p| p == "..")
    {
        return None;
    }
    Some(format!(
        "/{}",
        value
            .split('/')
            .filter(|p| !matches!(*p, "" | "."))
            .collect::<Vec<_>>()
            .join("/")
    ))
}
fn duration(value: &str) -> Option<String> {
    let (digits, factor) = if let Some(s) = value.strip_suffix("ms") {
        (s, 1)
    } else if let Some(s) = value.strip_suffix('s') {
        (s, 1000)
    } else if let Some(s) = value.strip_suffix('m') {
        (s, 60_000)
    } else {
        let s = value.strip_suffix('h')?;
        (s, 3_600_000)
    };
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let n = digits.parse::<u64>().ok()?.checked_mul(factor)?;
    (n > 0 && n <= u32::MAX as u64).then(|| format!("{n}ms"))
}
fn command(command: &Command, pointer: &str, at: &At) -> Result<(), Diagnostic> {
    let valid = match command {
        Command::Exec { exec } => {
            !exec.is_empty() && !exec[0].is_empty() && exec.iter().all(|s| !s.contains('\0'))
        }
        Command::Shell { shell } => !shell.is_empty() && !shell.contains('\0'),
    };
    if !valid {
        return Err(at("invalid_command", pointer));
    }
    Ok(())
}
fn names(names: &mut [String], pointer: &str, at: &At) -> Result<(), Diagnostic> {
    let mut seen = BTreeSet::new();
    for (i, n) in names.iter().enumerate() {
        if !name(n) || !seen.insert(n) {
            return Err(at("invalid_name", &child(pointer, &i.to_string())));
        }
    }
    names.sort();
    Ok(())
}

pub fn lower(mut project: Project, profiles: &[String], at: &At) -> Result<Plan, Diagnostic> {
    if !name(&project.name) {
        return Err(at("invalid_name", "/name"));
    }
    project.source.root =
        relative(&project.source.root).ok_or_else(|| at("invalid_path", "/source/root"))?;
    if project
        .environment
        .default_overlay
        .as_ref()
        .is_some_and(|s| !overlay_name(s))
    {
        return Err(at("invalid_name", "/environment/default_overlay"));
    }
    names(&mut project.profiles, "/profiles", at)?;
    let mut selected = profiles.to_vec();
    names(&mut selected, "/profiles", at)?;
    if selected.iter().any(|p| !project.profiles.contains(p)) {
        return Err(at("unknown_profile", "/profiles"));
    }
    for key in project.storage.keys() {
        if !name(key) {
            return Err(at("invalid_name", &child("/storage", key)));
        }
    }
    for (kind, workloads) in [
        ("services", &mut project.services),
        ("jobs", &mut project.jobs),
    ] {
        for (key, workload) in workloads.iter_mut() {
            let pointer = child(&format!("/{kind}"), key);
            if !name(key) {
                return Err(at("invalid_name", &pointer));
            }
            validate_workload(workload, &pointer, &project.profiles, &project.storage, at)?;
        }
    }
    for key in project.services.keys() {
        if project.jobs.contains_key(key) {
            return Err(at("duplicate_workload", &child("/jobs", key)));
        }
    }
    let all: BTreeMap<&str, (&str, &Workload)> = project
        .services
        .iter()
        .map(|(k, v)| (k.as_str(), ("services", v)))
        .chain(project.jobs.iter().map(|(k, v)| (k.as_str(), ("jobs", v))))
        .collect();
    let active =
        |w: &Workload| w.profiles.is_empty() || w.profiles.iter().any(|p| selected.contains(p));
    for (key, (kind, w)) in &all {
        for (index, dep) in w.depends_on.iter().enumerate() {
            let pointer = format!("{}/depends_on/{index}", child(&format!("/{kind}"), key));
            let target = match dep {
                Dependency::Service { service, .. } => project.services.get(service),
                Dependency::Job { job, .. } => project.jobs.get(job),
            }
            .ok_or_else(|| at("unknown_dependency", &pointer))?;
            if matches!(
                dep,
                Dependency::Service {
                    condition: ServiceCondition::Ready,
                    ..
                }
            ) && target.readiness.is_none()
            {
                return Err(at("missing_readiness", &pointer));
            }
            if active(w) && !active(target) {
                return Err(at("inactive_dependency", &pointer));
            }
        }
    }
    check_cycles(&all, at)?;
    project.services.retain(|_, w| active(w));
    project.jobs.retain(|_, w| active(w));
    for workload in project
        .services
        .values_mut()
        .chain(project.jobs.values_mut())
    {
        workload.depends_on.sort_by(|a, b| a.name().cmp(b.name()));
    }
    Ok(Plan {
        plan_version: 1,
        name: project.name,
        source: project.source,
        environment: project.environment,
        selected_profiles: selected,
        storage: project.storage,
        services: project.services,
        jobs: project.jobs,
    })
}
fn validate_workload(
    workload: &mut Workload,
    pointer: &str,
    profiles: &[String],
    storage: &BTreeMap<String, Storage>,
    at: &At,
) -> Result<(), Diagnostic> {
    if workload.image.is_some() == workload.build.is_some() {
        return Err(at("image_build_exclusive", pointer));
    }
    if let Some(image) = &workload.image
        && (image.is_empty() || image.chars().any(char::is_whitespace) || image.contains('\0'))
    {
        return Err(at("invalid_image", &child(pointer, "image")));
    }
    if let Some(build) = &mut workload.build {
        build.context = relative(&build.context)
            .ok_or_else(|| at("invalid_path", &format!("{pointer}/build/context")))?;
        build.dockerfile = relative(&build.dockerfile)
            .filter(|p| p != ".")
            .ok_or_else(|| at("invalid_path", &format!("{pointer}/build/dockerfile")))?;
        if build.target.as_ref().is_some_and(|s| !name(s)) {
            return Err(at("invalid_name", &format!("{pointer}/build/target")));
        }
    }
    if let Some(c) = &workload.command {
        command(c, &child(pointer, "command"), at)?;
    }
    if let Some(wd) = &mut workload.working_directory {
        *wd =
            absolute(wd).ok_or_else(|| at("invalid_path", &child(pointer, "working_directory")))?;
    }
    names(&mut workload.profiles, &child(pointer, "profiles"), at)?;
    if workload.profiles.iter().any(|p| !profiles.contains(p)) {
        return Err(at("unknown_profile", &child(pointer, "profiles")));
    }
    for (key, value) in &workload.environment {
        let path = child(&child(pointer, "environment"), key);
        if !env_name(key) {
            return Err(at("invalid_environment_key", &path));
        }
        match value {
            EnvironmentValue::Reference { env_ref } if !managed_key(env_ref) => {
                return Err(at("invalid_environment_key", &child(&path, "env_ref")));
            }
            EnvironmentValue::Literal { literal: value }
            | EnvironmentValue::Default { default: value }
                if value.contains('\0') =>
            {
                return Err(at("invalid_environment_value", &path));
            }
            _ => {}
        }
    }
    let mut targets = BTreeSet::new();
    for (index, mount) in workload.mounts.iter_mut().enumerate() {
        let path = format!("{pointer}/mounts/{index}");
        let target = match mount {
            Mount::Source { source, target, .. } => {
                *source =
                    relative(source).ok_or_else(|| at("invalid_path", &child(&path, "source")))?;
                target
            }
            Mount::Storage {
                storage: key,
                target,
                ..
            } => {
                if !storage.contains_key(key) {
                    return Err(at("unknown_storage", &child(&path, "storage")));
                }
                target
            }
        };
        *target = absolute(target).ok_or_else(|| at("invalid_path", &child(&path, "target")))?;
        if !targets.insert(target.clone()) {
            return Err(at("duplicate_mount_target", &child(&path, "target")));
        }
    }
    let mut deps = BTreeSet::new();
    for (i, dep) in workload.depends_on.iter().enumerate() {
        if !deps.insert(dep.name()) {
            return Err(at(
                "duplicate_dependency",
                &format!("{pointer}/depends_on/{i}"),
            ));
        }
    }
    // Reference validation occurs before sorting so diagnostics retain authored positions.
    if let Some(readiness) = &mut workload.readiness {
        let (interval, timeout, retries) = match readiness {
            Readiness::Exec {
                command: c,
                interval,
                timeout,
                retries,
            } => {
                command(c, &format!("{pointer}/readiness/command"), at)?;
                (interval, timeout, retries)
            }
            Readiness::Http {
                port,
                path,
                interval,
                timeout,
                retries,
            } => {
                if *port == 0 || !path.starts_with('/') || path.contains(['\0', '\r', '\n']) {
                    return Err(at("invalid_readiness", &child(pointer, "readiness")));
                }
                (interval, timeout, retries)
            }
            Readiness::Tcp {
                port,
                interval,
                timeout,
                retries,
            } => {
                if *port == 0 {
                    return Err(at("invalid_readiness", &child(pointer, "readiness")));
                }
                (interval, timeout, retries)
            }
        };
        *interval = duration(interval)
            .ok_or_else(|| at("invalid_duration", &format!("{pointer}/readiness/interval")))?;
        *timeout = duration(timeout)
            .ok_or_else(|| at("invalid_duration", &format!("{pointer}/readiness/timeout")))?;
        if *retries == 0 {
            return Err(at(
                "invalid_readiness",
                &format!("{pointer}/readiness/retries"),
            ));
        }
    }
    Ok(())
}
/// Iterative cycle checking keeps deeply chained graphs off the call stack.
fn check_cycles(all: &BTreeMap<&str, (&str, &Workload)>, at: &At) -> Result<(), Diagnostic> {
    let mut pending: BTreeMap<&str, usize> = all
        .iter()
        .map(|(name, (_, w))| (*name, w.depends_on.len()))
        .collect();
    let mut dependants: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for (name, (_, w)) in all {
        for dependency in &w.depends_on {
            dependants.entry(dependency.name()).or_default().push(name);
        }
    }
    let mut ready: BTreeSet<&str> = pending
        .iter()
        .filter(|(_, n)| **n == 0)
        .map(|(name, _)| *name)
        .collect();
    while let Some(name) = ready.pop_first() {
        pending.remove(name);
        if let Some(dependants) = dependants.get(name) {
            for dependant in dependants {
                if let Some(count) = pending.get_mut(dependant) {
                    *count -= 1;
                    if *count == 0 {
                        ready.insert(dependant);
                    }
                }
            }
        }
    }
    if let Some((name, _)) = pending.first_key_value()
        && let Some((kind, _)) = all.get(name)
    {
        return Err(at(
            "dependency_cycle",
            &format!("{}/depends_on", child(&format!("/{kind}"), name)),
        ));
    }
    Ok(())
}
