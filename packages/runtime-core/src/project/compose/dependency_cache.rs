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
fn refused() -> CandidateError {
    problem(
        "invalid_dependency_cache",
        "Dependency cache requires a literal named volume, bounded relative file paths and a boolean bootstrap declaration; values omitted.",
    )
}
fn paths(value: Option<&String>, defaults: &[&str]) -> Result<(Vec<String>, bool), CandidateError> {
    let mut paths = std::collections::BTreeSet::new();
    if let Some(value) = value {
        if value.len() > 8192 {
            return Err(refused());
        }
        for path in value.split(',').map(str::trim).filter(|p| !p.is_empty()) {
            if path.len() > 512
                || path.contains(['$', '\\', '\0'])
                || path.chars().any(char::is_control)
                || path
                    .split('/')
                    .any(|p| p.is_empty() || p == "." || p == "..")
            {
                return Err(refused());
            }
            paths.insert(path.to_owned());
            if paths.len() > 32 {
                return Err(refused());
            }
        }
    }
    let explicit = !paths.is_empty();
    if !explicit {
        paths.extend(defaults.iter().map(|p| (*p).to_owned()));
    }
    Ok((paths.into_iter().collect(), explicit))
}
pub(super) fn parse(value: Option<&Value>) -> Result<Option<DependencyCachePlan>, CandidateError> {
    let mut labels = BTreeMap::new();
    let mut insert = |key: &str, value: &Value| -> Result<(), CandidateError> {
        if !recognized(key) {
            return Ok(());
        }
        let value = match value {
            Value::String(v) => v.clone(),
            Value::Bool(v) if key == BOOTSTRAP => v.to_string(),
            _ => return Err(refused()),
        };
        if labels.insert(key.to_owned(), value).is_some() {
            return Err(refused());
        }
        Ok(())
    };
    match value {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::Object(values)) => {
            for (key, value) in values {
                insert(key, value)?;
            }
        }
        Some(Value::Array(values)) => {
            for value in values {
                let value = value.as_str().ok_or_else(refused)?;
                let (key, value) = value.split_once('=').unwrap_or((value, ""));
                insert(key, &Value::String(value.into()))?;
            }
        }
        _ => return Err(refused()),
    }
    if labels.is_empty() || (labels.len() == 1 && labels.contains_key(BOOTSTRAP)) {
        return Ok(None);
    }
    let volume = labels.get(VOLUME).ok_or_else(refused)?.trim().to_owned();
    super::fields::identifier(&volume).map_err(|_| refused())?;
    let (lockfiles, lockfiles_explicit) = paths(labels.get(LOCKFILES), DEFAULT_LOCKFILES)?;
    let (runtime_files, _) = paths(labels.get(RUNTIME), DEFAULT_RUNTIME)?;
    let bootstrap = match labels.get(BOOTSTRAP).map(String::as_str) {
        None | Some("false") => false,
        Some("true") => true,
        _ => return Err(refused()),
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
