//! Static public cache declarations only; filesystem identity and cache admission are runtime work.
use super::super::*;
use serde_json::Value;

const VOLUME: &str = "hack.dependencies.cache-volume";
const LOCKFILES: &str = "hack.dependencies.lockfiles";
const RUNTIME: &str = "hack.dependencies.runtime-files";
const BOOTSTRAP: &str = "hack.dependencies.bootstrap";
const DEFAULT_LOCKFILES: &[&str] = &[
    "bun.lock",
    "bun.lockb",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "uv.lock",
    "poetry.lock",
    "Cargo.lock",
    "go.sum",
];
const DEFAULT_RUNTIME: &[&str] = &[
    "package.json",
    ".mise.toml",
    "mise.toml",
    ".tool-versions",
    ".node-version",
    ".nvmrc",
];
pub(super) fn recognized(key: &str) -> bool {
    matches!(key, VOLUME | LOCKFILES | RUNTIME | BOOTSTRAP)
}
fn detail(
    key: &str,
    message: &'static str,
    fix: &'static str,
) -> crate::error::ConfigurationRefusal {
    let field = match key {
        VOLUME => "labels.hack.dependencies.cache-volume",
        LOCKFILES => "labels.hack.dependencies.lockfiles",
        RUNTIME => "labels.hack.dependencies.runtime-files",
        BOOTSTRAP => "labels.hack.dependencies.bootstrap",
        _ => "labels",
    };
    crate::error::ConfigurationRefusal::new(field, message, fix)
}
fn refused(findings: Vec<crate::error::ConfigurationRefusal>) -> CandidateError {
    problem(
        "invalid_dependency_cache",
        "Dependency cache declarations are invalid; values omitted.",
    )
    .with_configuration_refusals(findings)
}
fn paths(value: Option<&String>, defaults: &[&str]) -> Option<(Vec<String>, bool)> {
    let mut paths = std::collections::BTreeSet::new();
    if let Some(value) = value {
        if value.len() > 8192 {
            return None;
        }
        for path in value.split(',').map(str::trim).filter(|p| !p.is_empty()) {
            if path.len() > 512
                || path.contains(['$', '\\', '\0'])
                || path.chars().any(char::is_control)
                || path
                    .split('/')
                    .any(|p| p.is_empty() || p == "." || p == "..")
            {
                return None;
            }
            paths.insert(path.to_owned());
            if paths.len() > 32 {
                return None;
            }
        }
    }
    let explicit = !paths.is_empty();
    if !explicit {
        paths.extend(defaults.iter().map(|p| (*p).to_owned()));
    }
    Some((paths.into_iter().collect(), explicit))
}
/// Collect independent label errors without ever storing a label value in a diagnostic.
/// The accepted cache and the standalone-bootstrap exception are unchanged.
pub(super) fn parse(value: Option<&Value>) -> Result<Option<DependencyCachePlan>, CandidateError> {
    let mut labels = BTreeMap::new();
    let mut findings = Vec::new();
    let mut insert = |key: &str, value: &Value| {
        if !recognized(key) {
            return;
        }
        let value = match value {
            Value::String(v) => v.clone(),
            Value::Bool(v) if key == BOOTSTRAP => v.to_string(),
            _ => {
                findings.push(detail(key, "A dependency-cache label has the wrong type.", "Use a string for cache-volume and file lists; bootstrap accepts a boolean or its literal string form."));
                return;
            }
        };
        if labels.insert(key.to_owned(), value).is_some() {
            findings.push(detail(
                key,
                "A dependency-cache label is declared more than once.",
                "Keep exactly one declaration of this label.",
            ));
        }
    };
    match value {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::Object(values)) => {
            for (key, value) in values {
                insert(key, value);
            }
        }
        Some(Value::Array(values)) => {
            for value in values {
                if let Some(value) = value.as_str() {
                    let (key, value) = value.split_once('=').unwrap_or((value, ""));
                    insert(key, &Value::String(value.into()));
                } else {
                    findings.push(detail(
                        "",
                        "The label list contains a non-string entry.",
                        "Use a mapping or a list of key=value strings for labels.",
                    ));
                    return Err(refused(findings));
                }
            }
        }
        _ => {
            return Err(refused(vec![detail(
                "",
                "Labels are neither a mapping nor a list.",
                "Use a mapping or a list of key=value strings for labels.",
            )]));
        }
    }
    if labels.is_empty() || (labels.len() == 1 && labels.contains_key(BOOTSTRAP)) {
        return if findings.is_empty() {
            Ok(None)
        } else {
            Err(refused(findings))
        };
    }
    let volume = labels
        .get(VOLUME)
        .map(|v| v.trim().to_owned())
        .unwrap_or_default();
    if super::fields::identifier(&volume).is_err() {
        findings.push(detail(VOLUME, "The dependency cache has no literal named-volume identifier.", "Set hack.dependencies.cache-volume to one declared named volume, without interpolation."));
    }
    let lockfiles = paths(labels.get(LOCKFILES), DEFAULT_LOCKFILES);
    let runtime = paths(labels.get(RUNTIME), DEFAULT_RUNTIME);
    for (key, valid) in [
        (LOCKFILES, lockfiles.is_some()),
        (RUNTIME, runtime.is_some()),
    ] {
        if !valid {
            findings.push(detail(key, "The dependency-cache file list is not a bounded list of relative paths.", "Use at most 32 comma-separated relative paths (512 bytes each, 8192 bytes total), without variables, backslashes, control characters, empty, dot or parent components."));
        }
    }
    let bootstrap = match labels.get(BOOTSTRAP).map(String::as_str) {
        None | Some("false") => false,
        Some("true") => true,
        _ => {
            findings.push(detail(
                BOOTSTRAP,
                "The dependency-cache bootstrap declaration is not boolean.",
                "Use true or false for hack.dependencies.bootstrap.",
            ));
            false
        }
    };
    if !findings.is_empty() {
        return Err(refused(findings));
    }
    let (Some((lockfiles, lockfiles_explicit)), Some((runtime_files, _))) = (lockfiles, runtime)
    else {
        return Err(refused(vec![]));
    };
    Ok(Some(DependencyCachePlan {
        volume,
        lockfiles,
        lockfiles_explicit,
        runtime_files,
        bootstrap,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn duplicate_label_flood_keeps_a_small_error_with_prior_findings() {
        let mut values = vec![json!("hack.dependencies.lockfiles=private-sentinel"); 4096];
        values.push(json!(42));
        let error = parse(Some(&Value::Array(values))).unwrap_err();
        assert_eq!(error.code, "invalid_dependency_cache");
        let wire = serde_json::to_value(error).unwrap();
        let details = wire["configuration_refusals"].as_array().unwrap();
        assert_eq!(details.len(), 2);
        assert_eq!(details[0]["field"], "labels.hack.dependencies.lockfiles");
        assert_eq!(details[1]["field"], "labels");
        assert!(wire.to_string().len() < 8192);
        assert!(!wire.to_string().contains("private-sentinel"));
    }

    #[test]
    fn actual_declaration_and_list_form_are_equivalent() {
        let map = json!({"hack.dependencies.cache-volume":"node_modules", "hack.dependencies.lockfiles":"bun.lock", "hack.dependencies.runtime-files":"package.json,bunfig.toml,mise.toml,.tool-versions,packages/db/prisma/schema.prisma", "hack.dependencies.bootstrap":"true"});
        let list = Value::Array(
            map.as_object()
                .unwrap()
                .iter()
                .map(|(k, v)| Value::String(format!("{k}={}", v.as_str().unwrap())))
                .collect(),
        );
        let parsed = parse(Some(&map)).unwrap().unwrap();
        assert_eq!(parsed, parse(Some(&list)).unwrap().unwrap());
        assert!(parsed.bootstrap && parsed.lockfiles_explicit);
        assert_eq!(parsed.lockfiles, ["bun.lock"]);
        assert_eq!(parsed.runtime_files.len(), 5);
    }
    #[test]
    fn defaults_empty_csv_and_duplicate_paths_follow_stable_semantics() {
        let mut labels = json!({"hack.dependencies.cache-volume":"deps"});
        let default = parse(Some(&labels)).unwrap().unwrap();
        assert!(!default.lockfiles_explicit);
        assert_eq!(default.lockfiles.len(), 9);
        labels[LOCKFILES] = json!(" , ");
        assert_eq!(default, parse(Some(&labels)).unwrap().unwrap());
        labels[LOCKFILES] = json!("bun.lock, bun.lock");
        assert_eq!(
            parse(Some(&labels)).unwrap().unwrap().lockfiles,
            ["bun.lock"]
        );
    }
    #[test]
    fn unsafe_or_incomplete_declarations_refuse_without_echoing_values() {
        for path in [
            "/secret-canary",
            "../secret-canary",
            "a/../secret-canary",
            "${SECRET_CANARY}",
            "a//b",
            "./a",
            "a\\b",
            "a\0b",
        ] {
            let error = parse(Some(&json!({(VOLUME):"deps", (LOCKFILES):path}))).unwrap_err();
            assert_eq!(error.code, "invalid_dependency_cache");
            assert!(!error.message.contains("secret-canary"));
        }
        for value in [
            json!({(LOCKFILES):"bun.lock"}),
            json!({(VOLUME):"deps",(BOOTSTRAP):"yes"}),
            json!([
                "hack.dependencies.cache-volume=one",
                "hack.dependencies.cache-volume=two"
            ]),
        ] {
            assert!(parse(Some(&value)).is_err());
        }
        assert!(
            parse(Some(&json!({"hack.bootstrap":"true"})))
                .unwrap()
                .is_none()
        );
        assert!(parse(Some(&json!({(BOOTSTRAP):"true"}))).unwrap().is_none());
    }
}
