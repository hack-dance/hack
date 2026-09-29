use super::super::*;
use serde_json::{Map, Value};
use std::collections::BTreeSet;

pub(super) fn identifier(value: &str) -> Result<(), CandidateError> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .next()
            .is_some_and(|b| b.is_ascii_alphanumeric())
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
    {
        return Err(problem(
            "invalid_identifier",
            "Compose names and profiles must be bounded alphanumeric identifiers with '.', '_' or '-'.",
        ));
    }
    Ok(())
}
pub(super) fn object(value: &Value) -> Result<&Map<String, Value>, CandidateError> {
    value.as_object().ok_or_else(|| {
        problem(
            "invalid_compose_field",
            "Expected a Compose mapping; values are omitted from errors.",
        )
    })
}
pub(super) fn string(value: &Value) -> Result<&str, CandidateError> {
    value.as_str().ok_or_else(|| {
        problem(
            "invalid_compose_field",
            "Expected a Compose string; values are omitted from errors.",
        )
    })
}
pub(super) fn boolean(value: Option<&Value>, default: bool) -> Result<bool, CandidateError> {
    value
        .map(|v| {
            v.as_bool()
                .ok_or_else(|| problem("invalid_compose_field", "Expected a boolean."))
        })
        .unwrap_or(Ok(default))
}
pub(super) fn optional_text(value: Option<&Value>) -> Result<Option<String>, CandidateError> {
    value
        .filter(|v| !v.is_null())
        .map(|v| string(v).map(str::to_owned))
        .transpose()
}
pub(super) fn strings(value: Option<&Value>) -> Result<Vec<String>, CandidateError> {
    match value {
        None | Some(Value::Null) => Ok(vec![]),
        Some(Value::Array(values)) => values
            .iter()
            .map(|v| string(v).map(str::to_owned))
            .collect(),
        _ => Err(problem(
            "invalid_compose_field",
            "Expected a list of strings.",
        )),
    }
}
pub(super) fn keys(
    value: &Map<String, Value>,
    allowed: &[&str],
    field: &str,
    diagnostics: &mut Vec<Diagnostic>,
) {
    for key in value.keys().filter(|k| !allowed.contains(&k.as_str())) {
        let safe = if identifier(key).is_ok() {
            key.as_str()
        } else {
            "[unsupported-key]"
        };
        if key.starts_with("x-") {
            diagnostics.push(Diagnostic::warning("compose_extension_metadata", &format!("{field}.{safe}"), "Extension metadata is not executed. Mapping fragments have already been merged; provider-specific extension behavior is not implemented."));
            continue;
        }
        diagnostics.push(Diagnostic::error("unsupported_field", &format!("{field}.{safe}"), "This Compose field is not supported by the WU03 enrollment subset; it is not silently discarded."));
    }
}
pub(super) fn variable_name(value: &str) -> bool {
    value
        .bytes()
        .next()
        .is_some_and(|b| b.is_ascii_alphabetic() || b == b'_')
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_')
}
pub(super) fn redacted(value: &str) -> Result<RedactedText, CandidateError> {
    let bytes = value.as_bytes();
    let mut references = BTreeSet::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'$' {
            index += 1;
            continue;
        }
        index += 1;
        if bytes.get(index) == Some(&b'$') {
            index += 1;
            continue;
        }
        let braced = bytes.get(index) == Some(&b'{');
        if braced {
            index += 1;
        }
        let start = index;
        while bytes
            .get(index)
            .is_some_and(|b| b.is_ascii_alphanumeric() || *b == b'_')
        {
            index += 1;
        }
        let name = &value[start..index];
        if !name.is_empty() && variable_name(name) {
            references.insert(name.to_owned());
        } else if braced {
            return Err(problem(
                "invalid_interpolation",
                "Malformed environment reference; no values were resolved.",
            ));
        }
        if braced && (!valid_variable_suffix(&bytes[index..]) || !closes_variable(&bytes[index..]))
        {
            return Err(problem(
                "invalid_interpolation",
                "Malformed environment reference; no values were resolved.",
            ));
        }
    }
    Ok(RedactedText {
        environment_references: references.into_iter().collect(),
        literal_redacted: true,
    })
}
pub(super) fn valid_variable_suffix(bytes: &[u8]) -> bool {
    match bytes.first() {
        Some(b'}' | b'-' | b'+' | b'?') => true,
        Some(b':') => bytes.get(1).is_some_and(|b| b"-+?".contains(b)),
        _ => false,
    }
}
pub(super) fn closes_variable(bytes: &[u8]) -> bool {
    let mut depth = 1;
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index..].starts_with(b"$$") {
            index += 2;
            continue;
        }
        if bytes[index..].starts_with(b"${") {
            depth += 1;
            index += 2;
            continue;
        }
        if bytes[index] == b'}' {
            depth -= 1;
            if depth == 0 {
                return true;
            }
        }
        index += 1;
    }
    false
}
pub(super) fn redacted_map(
    value: Option<&Value>,
    environment: bool,
) -> Result<BTreeMap<String, RedactedText>, CandidateError> {
    let mut result = BTreeMap::new();
    let pairs: Vec<(String, Option<String>)> = match value {
        None | Some(Value::Null) => vec![],
        Some(Value::Object(map)) => map
            .iter()
            .map(|(k, v)| {
                let scalar = match v {
                    Value::Null => None,
                    Value::String(s) => Some(s.clone()),
                    Value::Bool(_) | Value::Number(_) => Some(v.to_string()),
                    _ => {
                        return Err(problem(
                            "invalid_compose_field",
                            "Expected scalar map values.",
                        ));
                    }
                };
                Ok((k.clone(), scalar))
            })
            .collect::<Result<_, _>>()?,
        Some(Value::Array(values)) => values
            .iter()
            .map(|v| {
                let text = string(v)?;
                let (key, value) = text
                    .split_once('=')
                    .map(|(k, v)| (k, Some(v.to_owned())))
                    .unwrap_or((text, None));
                Ok((key.to_owned(), value))
            })
            .collect::<Result<_, CandidateError>>()?,
        _ => {
            return Err(problem(
                "invalid_compose_field",
                "Expected a scalar mapping or KEY=VALUE list.",
            ));
        }
    };
    for (key, value) in pairs {
        if key.len() > 128
            || (environment && !variable_name(&key))
            || key.is_empty()
            || key
                .bytes()
                .any(|b| !b.is_ascii() || b.is_ascii_control() || b == b'=')
        {
            return Err(problem(
                "invalid_environment_key",
                "Invalid environment/metadata key; values remain redacted.",
            ));
        }
        let item = match value {
            Some(value) => redacted(&value)?,
            None => RedactedText {
                environment_references: if environment {
                    vec![key.clone()]
                } else {
                    vec![]
                },
                literal_redacted: false,
            },
        };
        if result.insert(key, item).is_some() {
            return Err(problem(
                "duplicate_environment_key",
                "Duplicate environment/metadata keys are not accepted.",
            ));
        }
    }
    Ok(result)
}
pub(super) fn command(
    value: Option<&Value>,
    field: &str,
) -> Result<Option<CommandPlan>, CandidateError> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Array(values)) => Ok(Some(CommandPlan {
            form: "argv".into(),
            arguments: values
                .iter()
                .map(|v| redacted(string(v)?))
                .collect::<Result<_, _>>()?,
            review_field: field.into(),
        })),
        Some(Value::String(text)) if text.is_empty() => Ok(Some(CommandPlan {
            form: "empty-override".into(),
            arguments: vec![],
            review_field: field.into(),
        })),
        Some(Value::String(text)) => Ok(Some(CommandPlan {
            form: "compose-string-after-interpolation".into(),
            arguments: vec![redacted(text)?],
            review_field: field.into(),
        })),
        _ => Err(problem(
            "invalid_command",
            "Commands must be null, strings or argv lists.",
        )),
    }
}
pub(super) fn safe_absolute(value: &str) -> Result<String, CandidateError> {
    if !value.starts_with('/')
        || value.contains('$')
        || value.contains('\0')
        || Path::new(value)
            .components()
            .any(|p| matches!(p, std::path::Component::ParentDir))
    {
        return Err(problem(
            "invalid_container_path",
            "Container paths must be literal absolute paths without parent traversal.",
        ));
    }
    Ok(Path::new(value)
        .components()
        .collect::<PathBuf>()
        .to_string_lossy()
        .into_owned())
}
pub(super) fn relative(project: &Path, path: &Path) -> String {
    let value = path
        .strip_prefix(project)
        .expect("verified source prefix")
        .to_string_lossy();
    if value.is_empty() {
        ".".into()
    } else {
        value.into_owned()
    }
}
pub(super) fn image(
    value: Option<&Value>,
    diagnostics: &mut Vec<Diagnostic>,
    field: &str,
) -> Result<Option<String>, CandidateError> {
    let Some(value) = optional_text(value)? else {
        return Ok(None);
    };
    if value.contains('$') {
        diagnostics.push(Diagnostic::error("structural_environment_reference", field, "Image interpolation requires an explicit future value-binding step; ambient environment is not read."));
        return Ok(None);
    }
    if value.len() > 512
        || value.is_empty()
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-/:@".contains(&b))
        || value.contains("://")
    {
        return Err(problem(
            "invalid_image",
            "Image must be a literal OCI-style reference without URLs, credentials or whitespace.",
        ));
    }
    if let Some((_, digest)) = value.split_once('@') {
        let Some(digest) = digest.strip_prefix("sha256:") else {
            return Err(problem(
                "invalid_image",
                "Only sha256 image digests are supported.",
            ));
        };
        if digest.len() != 64 || !digest.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(problem("invalid_image", "Invalid image digest."));
        }
    }
    let reference = value.split('@').next().unwrap_or("");
    if !valid_image_name(reference) {
        return Err(problem("invalid_image", "Invalid image reference."));
    }
    Ok(Some(value))
}
fn valid_image_name(reference: &str) -> bool {
    let last = reference.rsplit('/').next().unwrap_or("");
    let repository = if let Some((_, tag)) = last.rsplit_once(':') {
        if tag.is_empty()
            || tag.len() > 128
            || !tag
                .bytes()
                .next()
                .is_some_and(|b| b.is_ascii_alphanumeric() || b == b'_')
            || !tag
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
        {
            return false;
        }
        &reference[..reference.len() - tag.len() - 1]
    } else {
        reference
    };
    let parts: Vec<_> = repository.split('/').collect();
    for (index, part) in parts.iter().enumerate() {
        if index == 0
            && parts.len() > 1
            && (part.contains('.') || part.contains(':') || *part == "localhost")
        {
            let host = if let Some((host, port)) = part.split_once(':') {
                if port.parse::<u16>().ok().filter(|p| *p > 0).is_none() {
                    return false;
                }
                host
            } else {
                part
            };
            if host.is_empty()
                || !host
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b".-".contains(&b))
            {
                return false;
            }
            continue;
        }
        let bytes = part.as_bytes();
        let mut cursor = 0;
        while cursor < bytes.len() {
            let start = cursor;
            while bytes
                .get(cursor)
                .is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
            {
                cursor += 1;
            }
            if start == cursor {
                return false;
            }
            if cursor == bytes.len() {
                break;
            }
            match bytes[cursor] {
                b'.' => cursor += 1,
                b'_' => {
                    cursor += 1;
                    if bytes.get(cursor) == Some(&b'_') {
                        cursor += 1;
                    }
                }
                b'-' => {
                    while bytes.get(cursor) == Some(&b'-') {
                        cursor += 1;
                    }
                }
                _ => return false,
            }
            if cursor == bytes.len() {
                return false;
            }
        }
        if bytes.is_empty() {
            return false;
        }
    }
    true
}
pub(super) fn number(value: &Value) -> Result<f64, CandidateError> {
    let number = match value {
        Value::String(s) => s.parse().ok(),
        _ => value.as_f64(),
    };
    number
        .filter(|v: &f64| v.is_finite() && *v > 0.0)
        .ok_or_else(|| {
            problem(
                "invalid_limit",
                "Resource limits must be finite positive numbers.",
            )
        })
}
pub(super) fn bytes(value: &Value) -> Result<u64, CandidateError> {
    if let Some(v) = value.as_u64().filter(|v| *v > 0) {
        return Ok(v);
    }
    let text = string(value)?.to_ascii_lowercase();
    let split = text
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(text.len());
    let amount = text[..split].parse::<u64>().ok();
    let multiplier = match &text[split..] {
        "" | "b" => 1,
        "k" | "kb" => 1024,
        "m" | "mb" => 1024 * 1024,
        "g" | "gb" => 1024 * 1024 * 1024,
        _ => {
            return Err(problem(
                "invalid_limit",
                "Memory must be an integer byte value with optional b/k/m/g suffix.",
            ));
        }
    };
    amount
        .and_then(|v| v.checked_mul(multiplier))
        .filter(|v| *v > 0)
        .ok_or_else(|| problem("invalid_limit", "Memory limit is zero or overflows."))
}
pub(super) fn positive_u32(value: &Value) -> Result<u32, CandidateError> {
    value
        .as_u64()
        .and_then(|v| u32::try_from(v).ok())
        .filter(|v| *v > 0)
        .ok_or_else(|| problem("invalid_limit", "Expected a positive bounded integer."))
}
pub(super) fn duration(value: Option<&Value>) -> Result<Option<u64>, CandidateError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let text = string(value)?;
    let mut remaining = text;
    let mut total = 0_u64;
    while !remaining.is_empty() {
        let end = remaining
            .find(|c: char| !c.is_ascii_digit())
            .unwrap_or(remaining.len());
        let amount = remaining[..end].parse::<u64>().map_err(|_| {
            problem(
                "invalid_duration",
                "Durations require integer components and explicit h/m/s/ms/us/ns units.",
            )
        })?;
        remaining = &remaining[end..];
        let (unit, scale) = [
            ("ms", 1_000_000_u64),
            ("us", 1_000),
            ("ns", 1),
            ("h", 3_600_000_000_000),
            ("m", 60_000_000_000),
            ("s", 1_000_000_000),
        ]
        .into_iter()
        .find(|(unit, _)| remaining.starts_with(unit))
        .ok_or_else(|| problem("invalid_duration", "Unsupported duration unit."))?;
        remaining = &remaining[unit.len()..];
        total = amount
            .checked_mul(scale)
            .and_then(|v| total.checked_add(v))
            .ok_or_else(|| problem("invalid_duration", "Duration overflows."))?;
    }
    if total == 0 {
        return Err(problem(
            "invalid_duration",
            "Explicit durations must be positive.",
        ));
    }
    Ok(Some(total))
}
