//! Explicit public bytes, never a request to read an ignored host file.
use super::{CandidateError, PlanData, problem};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::Path;

pub(super) fn refused() -> CandidateError {
    problem(
        "source_generated",
        "Generated public file declaration is invalid or conflicts with source or mounts; values omitted.",
    )
}

pub(super) fn declarations(files: &BTreeMap<String, String>) -> Result<(), CandidateError> {
    if files.len() > 16 || files.values().map(String::len).sum::<usize>() > 65536 {
        return Err(refused());
    }
    let mut folded = std::collections::BTreeSet::new();
    for (path, content) in files {
        if !folded.insert(super::source::folded_name(path)) {
            return Err(refused());
        }
        if path.is_empty()
            || path.len() > 512
            || path.contains(['\\', '$'])
            || path.chars().any(char::is_control)
            || path.split('/').any(|part| {
                let lower = part.to_ascii_lowercase();
                part.is_empty()
                    || part == "."
                    || part == ".."
                    || matches!(
                        lower.as_str(),
                        ".aws"
                            | ".ssh"
                            | ".git"
                            | ".npmrc"
                            | ".netrc"
                            | ".pypirc"
                            | ".docker"
                            | ".kube"
                            | "credentials"
                            | "credentials.json"
                    )
                    || lower == ".env"
                    || lower.starts_with(".env.")
            })
            || path == ".hack/.internal"
            || path == ".hack/.branch"
            || path.starts_with(".hack/.internal/")
            || path.starts_with(".hack/.branch/")
            || content.len() > 16384
            || content
                .chars()
                .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
            || files
                .keys()
                .any(|other| other != path && Path::new(path).starts_with(other))
        {
            return Err(refused());
        }
    }
    Ok(())
}

pub(super) fn parse(value: Option<&Value>) -> Result<BTreeMap<String, String>, CandidateError> {
    let Some(value) = value else {
        return Ok(BTreeMap::new());
    };
    let object = value.as_object().ok_or_else(refused)?;
    let files = object
        .iter()
        .map(|(path, value)| {
            value
                .as_str()
                .map(|text| (path.clone(), text.to_owned()))
                .ok_or_else(refused)
        })
        .collect::<Result<BTreeMap<_, _>, _>>()?;
    declarations(&files)?;
    Ok(files)
}

/// Generated targets must be visible beneath a reviewed bind and cannot be
/// concealed by another mount. Existing captured entries are never replaced.
pub(super) fn validate_plan(plan: &PlanData) -> Result<(), CandidateError> {
    declarations(&plan.generated_files)?;
    for path in plan.generated_files.keys() {
        let target = Path::new(path);
        if plan
            .source_selection
            .entries
            .iter()
            .any(|e| Path::new(&e.path).starts_with(target))
        {
            return Err(refused());
        }
        for parent in target
            .ancestors()
            .skip(1)
            .filter(|p| !p.as_os_str().is_empty())
        {
            if !plan
                .source_selection
                .entries
                .iter()
                .any(|e| Path::new(&e.path) == parent && e.kind == "directory")
            {
                return Err(refused());
            }
        }
        let mut visible = false;
        for service in plan.services.values().filter(|s| s.active) {
            for bind in service.mounts.iter().filter(|m| m.kind == "bind") {
                let suffix = if bind.source == "." {
                    Some(target)
                } else {
                    target.strip_prefix(&bind.source).ok()
                };
                let Some(suffix) = suffix else {
                    continue;
                };
                if suffix.as_os_str().is_empty() || !bind.read_only {
                    return Err(refused());
                }
                let destination = Path::new(&bind.target).join(suffix);
                if service.mounts.iter().any(|other| {
                    other.target != bind.target
                        && Path::new(&other.target).starts_with(&bind.target)
                        && destination.starts_with(&other.target)
                }) {
                    return Err(refused());
                }
                visible = true;
            }
        }
        if !visible {
            return Err(refused());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn accepts_exact_public_bytes_and_hidden_noncredential_names() {
        let parsed = parse(Some(&json!({"apps/www/next-env.d.ts":"/// <reference types=\"next\" />\n", "apps/www/.public-info":"ok"}))).unwrap();
        assert_eq!(parsed["apps/www/.public-info"], "ok");
        assert!(parse(None).unwrap().is_empty());
    }
    #[test]
    fn rejects_credential_paths_aliases_collisions_and_limits() {
        for path in [
            "../file",
            "/file",
            "a//b",
            "a/./b",
            "a/.env.local",
            "a/.AWS/config",
            ".npmrc",
            "a/.ssh/key",
            "a\\b",
        ] {
            assert!(parse(Some(&json!({path:"public"}))).is_err(), "{path}");
        }
        assert!(parse(Some(&json!({"a":"x", "a/b":"y"}))).is_err());
        assert!(parse(Some(&json!({"a":"x".repeat(16385)}))).is_err());
        assert!(parse(Some(&json!({"a":false}))).is_err());
        assert!(parse(Some(&json!({"a":"\u{0}"}))).is_err());
    }
}
