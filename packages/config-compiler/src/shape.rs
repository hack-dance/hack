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
    for key in ["source", "environment", "worktree"] {
        optional_object(document, &json::child("", key))?;
    }
    if let Some(storage) = document.value.get("storage").and_then(Value::as_object) {
        for key in storage.keys() {
            object(document, &json::child("/storage", key))?;
        }
    }
    for namespace in ["services", "jobs"] {
        let root = json::child("", namespace);
        if let Some(workloads) = document.value.get(namespace).and_then(Value::as_object) {
            for key in workloads.keys() {
                let pointer = json::child(&root, key);
                object(document, &pointer)?;
                for field in ["build", "command", "readiness"] {
                    optional_object(document, &json::child(&pointer, field))?;
                }
                optional_object(document, &format!("{pointer}/readiness/command"))?;
                if let Some(env) = document
                    .value
                    .pointer(&format!("{pointer}/environment"))
                    .and_then(Value::as_object)
                {
                    for key in env.keys() {
                        object(
                            document,
                            &json::child(&format!("{pointer}/environment"), key),
                        )?;
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
        }
    }
    Ok(())
}
