//! JSON object boundaries that Serde's sequence-to-struct fallback would otherwise accept.
use crate::{Diagnostic, diagnostic_at, json};
use serde_json::Value;

pub(crate) fn object(document: &json::Document, pointer: &str) -> Result<(), Diagnostic> {
    if !document
        .value
        .pointer(pointer)
        .is_some_and(Value::is_object)
    {
        return Err(diagnostic_at(&document.positions, "invalid_shape", pointer));
    }
    Ok(())
}
fn optional_object(document: &json::Document, pointer: &str) -> Result<(), Diagnostic> {
    if document.value.pointer(pointer).is_some() {
        object(document, pointer)?;
    }
    Ok(())
}

pub(crate) fn project(document: &json::Document) -> Result<(), Diagnostic> {
    object(document, "")?;
    for key in [
        "source",
        "environment",
        "worktree",
        "routes",
        "open",
        "host_bindings",
        "networks",
        "configs",
        "secrets",
    ] {
        optional_object(document, &json::child("", key))?;
    }
    for namespace in ["configs", "secrets"] {
        if let Some(entries) = document.value.get(namespace).and_then(Value::as_object) {
            for name in entries.keys() {
                object(document, &json::child(&format!("/{namespace}"), name))?;
            }
        }
    }
    if let Some(bindings) = document
        .value
        .get("host_bindings")
        .and_then(Value::as_object)
    {
        for name in bindings.keys() {
            object(document, &json::child("/host_bindings", name))?;
        }
    }
    if let Some(storage) = document.value.get("storage").and_then(Value::as_object) {
        for key in storage.keys() {
            object(document, &json::child("/storage", key))?;
        }
    }
    if let Some(networks) = document.value.get("networks").and_then(Value::as_object) {
        for name in networks.keys() {
            object(document, &json::child("/networks", name))?;
        }
    }
    for namespace in ["services", "jobs"] {
        let root = json::child("", namespace);
        if let Some(workloads) = document.value.get(namespace).and_then(Value::as_object) {
            for key in workloads.keys() {
                let pointer = json::child(&root, key);
                object(document, &pointer)?;
                let policy_pointer = json::child(&pointer, "pull_policy");
                if document
                    .value
                    .pointer(&policy_pointer)
                    .is_some_and(|value| !value.is_string())
                {
                    return Err(diagnostic_at(
                        &document.positions,
                        "invalid_shape",
                        &policy_pointer,
                    ));
                }
                for field in [
                    "build",
                    "command",
                    "readiness",
                    "entrypoint",
                    "shutdown",
                    "restart",
                    "networks",
                ] {
                    optional_object(document, &json::child(&pointer, field))?;
                }
                optional_object(document, &format!("{pointer}/readiness/command"))?;
                let networks = json::child(&pointer, "networks");
                if let Some(values) = document.value.pointer(&networks).and_then(Value::as_object) {
                    for name in values.keys() {
                        object(document, &json::child(&networks, name))?;
                    }
                }
                if let Some(env) = document
                    .value
                    .pointer(&format!("{pointer}/environment"))
                    .and_then(Value::as_object)
                {
                    for key in env.keys() {
                        let entry = json::child(&format!("{pointer}/environment"), key);
                        object(
                            document,
                            &json::child(&format!("{pointer}/environment"), key),
                        )?;
                        optional_object(document, &format!("{entry}/endpoint"))?;
                    }
                }
                for field in ["mounts", "depends_on"] {
                    let items = json::child(&pointer, field);
                    if let Some(values) = document.value.pointer(&items).and_then(Value::as_array) {
                        for index in 0..values.len() {
                            object(document, &json::child(&items, &index.to_string()))?;
                        }
                    }
                }
            }
        }
    }
    optional_object(document, "/host")?;
    for phase in ["up", "down"] {
        optional_object(document, &format!("/host/{phase}"))?;
        for stage in ["before", "after"] {
            let pointer = format!("/host/{phase}/{stage}");
            if let Some(items) = document.value.pointer(&pointer).and_then(Value::as_array) {
                for index in 0..items.len() {
                    host_invocation(document, &format!("{pointer}/{index}"))?;
                }
            }
        }
    }
    if let Some(processes) = document
        .value
        .pointer("/host/processes")
        .and_then(Value::as_object)
    {
        for name in processes.keys() {
            host_invocation(document, &json::child("/host/processes", name))?;
        }
    }
    for namespace in ["aliases", "http"] {
        if let Some(entries) = document
            .value
            .pointer(&format!("/routes/{namespace}"))
            .and_then(Value::as_object)
        {
            for name in entries.keys() {
                object(
                    document,
                    &json::child(&format!("/routes/{namespace}"), name),
                )?;
            }
        }
    }
    Ok(())
}

fn host_invocation(document: &json::Document, pointer: &str) -> Result<(), Diagnostic> {
    object(document, pointer)?;
    for field in ["command", "env_target", "singleton"] {
        optional_object(document, &json::child(pointer, field))?;
    }
    if let Some(environment) = document
        .value
        .pointer(&format!("{pointer}/environment"))
        .and_then(Value::as_object)
    {
        for name in environment.keys() {
            object(
                document,
                &json::child(&format!("{pointer}/environment"), name),
            )?;
            optional_object(
                document,
                &format!(
                    "{}/endpoint",
                    json::child(&format!("{pointer}/environment"), name)
                ),
            )?;
        }
    }
    Ok(())
}
