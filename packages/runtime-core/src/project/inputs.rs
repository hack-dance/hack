//! Ephemeral executable values bound to an exact fresh review. Never serialize these structures.
use super::{PlanOptions, PlanReport, plan, source, yaml};
use crate::{Candidate, CandidateError};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

/// Values are held only for delivery to the owned runtime. Intentionally not Debug or Serialize.
pub struct ServiceInputs {
    pub command: Option<Vec<String>>,
    pub entrypoint: Option<Vec<String>>,
    pub environment: Vec<String>,
    pub health_test: Option<Vec<String>>,
    pub user: Option<String>,
}
pub struct ExecutionInputs {
    pub review: PlanReport,
    pub services: BTreeMap<String, ServiceInputs>,
}
fn error(code: &'static str, message: &str) -> CandidateError {
    CandidateError::new(code, message)
}
const MAX_EXPANDED: usize = 1024 * 1024;
struct Resolver<'a> {
    values: &'a BTreeMap<String, String>,
    remaining: usize,
}
fn variable(name: &str) -> bool {
    let mut bytes = name.bytes();
    bytes
        .next()
        .is_some_and(|b| b.is_ascii_alphabetic() || b == b'_')
        && bytes.all(|b| b.is_ascii_alphanumeric() || b == b'_')
}
impl Resolver<'_> {
    fn charge(&mut self, text: &str) -> Result<(), CandidateError> {
        if text.contains('\0') || text.len() > self.remaining {
            return Err(error(
                "execution_input_budget",
                "Executable values contain NUL or exceed the 1 MiB expanded budget.",
            ));
        }
        self.remaining -= text.len();
        Ok(())
    }
    fn lookup(&self, name: &str) -> Result<&str, CandidateError> {
        if !variable(name) {
            return Err(error(
                "execution_interpolation",
                "Unsupported environment reference; use NAME or braced NAME without operators.",
            ));
        }
        let value = self.values.get(name).ok_or_else(|| error("execution_environment_missing", "An explicitly required runtime input was not supplied; ambient environment is not consulted."))?;
        if value.len() > self.remaining || value.contains('\0') {
            return Err(error(
                "execution_input_budget",
                "Supplied value exceeds the expanded budget or contains NUL.",
            ));
        }
        Ok(value)
    }
    fn resolve(&mut self, text: &str) -> Result<String, CandidateError> {
        let mut result = String::new();
        let mut rest = text;
        while let Some(index) = rest.find('$') {
            self.charge(&rest[..index])?;
            result.push_str(&rest[..index]);
            rest = &rest[index + 1..];
            if let Some(tail) = rest.strip_prefix('$') {
                self.charge("$")?;
                result.push('$');
                rest = tail;
                continue;
            }
            let (name, tail) = if let Some(braced) = rest.strip_prefix('{') {
                let end = braced.find('}').ok_or_else(|| {
                    error("execution_interpolation", "Unclosed environment reference.")
                })?;
                (&braced[..end], &braced[end + 1..])
            } else {
                let end = rest
                    .bytes()
                    .take_while(|b| b.is_ascii_alphanumeric() || *b == b'_')
                    .count();
                (&rest[..end], &rest[end..])
            };
            let value = self.lookup(name)?.to_owned();
            self.charge(&value)?;
            result.push_str(&value);
            rest = tail;
        }
        self.charge(rest)?;
        result.push_str(rest);
        Ok(result)
    }
    fn inherited(&mut self, key: &str) -> Result<String, CandidateError> {
        let value = self.lookup(key)?.to_owned();
        self.charge(&value)?;
        Ok(value)
    }
    fn argv(&mut self, value: Option<&Value>) -> Result<Option<Vec<String>>, CandidateError> {
        match value {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(s)) => tokenize(&self.resolve(s)?).map(Some),
            Some(Value::Array(values)) if values.len() <= 4096 => values
                .iter()
                .map(|v| {
                    self.resolve(v.as_str().ok_or_else(|| {
                        error("execution_argv", "Executable argv entries must be strings.")
                    })?)
                })
                .collect::<Result<Vec<_>, _>>()
                .map(Some),
            _ => Err(error(
                "execution_argv",
                "Executable command must be a string or an argv list.",
            )),
        }
    }
    fn environment(&mut self, value: Option<&Value>) -> Result<Vec<String>, CandidateError> {
        let pairs: Vec<(String, Option<String>)> = match value {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Object(values)) => values
                .iter()
                .map(|(key, value)| {
                    let value = match value {
                        Value::Null => None,
                        Value::String(s) => Some(s.clone()),
                        Value::Number(n) => Some(n.to_string()),
                        Value::Bool(b) => Some(b.to_string()),
                        _ => {
                            return Err(error(
                                "execution_environment",
                                "Environment values must be scalar.",
                            ));
                        }
                    };
                    Ok((key.clone(), value))
                })
                .collect::<Result<_, _>>()?,
            Some(Value::Array(values)) => values
                .iter()
                .map(|v| {
                    let text = v.as_str().ok_or_else(|| {
                        error(
                            "execution_environment",
                            "Environment list must contain strings.",
                        )
                    })?;
                    Ok(match text.split_once('=') {
                        Some((k, v)) => (k.into(), Some(v.into())),
                        None => (text.into(), None),
                    })
                })
                .collect::<Result<_, CandidateError>>()?,
            _ => return Err(error("execution_environment", "Invalid environment form.")),
        };
        let mut result = BTreeMap::new();
        for (key, value) in pairs {
            if !variable(&key) || result.contains_key(&key) {
                return Err(error(
                    "execution_environment",
                    "Invalid or duplicate environment key.",
                ));
            }
            self.charge(&key)?;
            self.charge("=")?;
            let value = match value {
                Some(v) => self.resolve(&v)?,
                None => self.inherited(&key)?,
            };
            result.insert(key, value);
        }
        Ok(result
            .into_iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect())
    }
}

/// Bounded Compose-compatible word splitting for ordinary argv strings. This never runs a shell.
/// Unquoted control syntax is deliberately refused rather than silently truncating the command.
fn tokenize(text: &str) -> Result<Vec<String>, CandidateError> {
    let fail = || {
        error(
            "execution_argv",
            "Unclosed quote, escape, control syntax or excessive argv; use an explicit argv list or an explicitly quoted shell command.",
        )
    };
    let mut result = Vec::new();
    let mut word = String::new();
    let mut quote = None;
    let mut started = false;
    let mut chars = text.chars();
    while let Some(ch) = chars.next() {
        if ch == '\\' && quote != Some('\'') {
            word.push(chars.next().ok_or_else(fail)?);
            started = true;
        } else if Some(ch) == quote {
            quote = None;
        } else if quote.is_none() && matches!(ch, '\'' | '"') {
            quote = Some(ch);
            started = true;
        } else if quote.is_none() && matches!(ch, ';' | '&' | '|' | '<' | '>' | '`') {
            return Err(fail());
        } else if quote.is_none() && matches!(ch, ' ' | '\t' | '\r' | '\n') {
            if started {
                result.push(std::mem::take(&mut word));
                started = false;
                if result.len() > 4096 {
                    return Err(fail());
                }
            }
        } else {
            word.push(ch);
            started = true;
        }
    }
    if quote.is_some() {
        return Err(fail());
    }
    if started {
        result.push(word);
    }
    if result.len() > 4096 {
        return Err(fail());
    }
    Ok(result)
}

/// Resolve values only from the caller's explicitly supplied map (e.g. an authorized managed-env
/// injection). No process environment, dotenv file, shell or ambient credential lookup occurs.
/// The fresh plan must match `expected_plan`; parsing uses those exact Compose bytes. Building
/// images and env_file loading remain separate gates and are rejected here.
pub fn compile(
    candidate: &Candidate,
    options: PlanOptions<'_>,
    expected_plan: &str,
    supplied: &BTreeMap<String, String>,
) -> Result<ExecutionInputs, CandidateError> {
    let review = plan(candidate, options)?;
    if review.plan_id != expected_plan {
        return Err(error(
            "execution_plan_changed",
            "Executable inputs no longer match the reviewed plan.",
        ));
    }
    if !review.plan.enrollment_compatible {
        return Err(error(
            "execution_incompatible",
            "Blocking review diagnostics prevent executable compilation.",
        ));
    }
    let path = source::resolve(
        &review.plan.source,
        &review.plan.source,
        &review.plan.compose_file,
        false,
    )?;
    let bytes = source::read_compose(&path)?;
    if format!("{:x}", Sha256::digest(&bytes)) != review.plan.compose_sha256 {
        return Err(error(
            "execution_plan_changed",
            "Compose bytes changed after review.",
        ));
    }
    let value = yaml::parse(&bytes)?;
    let raw = value["services"]
        .as_object()
        .ok_or_else(|| error("execution_services", "Missing reviewed services."))?;
    let mut resolver = Resolver {
        values: supplied,
        remaining: MAX_EXPANDED,
    };
    let mut services = BTreeMap::new();
    for (name, service) in &review.plan.services {
        if !service.active {
            continue;
        }
        if service.build.is_some() || !service.environment_files.is_empty() {
            return Err(error(
                "execution_input_unsupported",
                "Build and env_file inputs require separately qualified delivery.",
            ));
        }
        let raw = raw
            .get(name)
            .and_then(Value::as_object)
            .ok_or_else(|| error("execution_services", "Reviewed service is missing."))?;
        let health_test = if service.healthcheck.as_ref().is_some_and(|h| h.disabled) {
            Some(vec!["NONE".into()])
        } else {
            match raw.get("healthcheck").and_then(|h| h.get("test")) {
                Some(Value::String(s)) => Some(vec!["CMD-SHELL".into(), resolver.resolve(s)?]),
                Some(v) => resolver.argv(Some(v))?,
                None => None,
            }
        };
        let user = match raw.get("user") {
            None => None,
            Some(Value::String(s)) => Some(resolver.resolve(s)?),
            Some(Value::Number(n)) => Some(resolver.resolve(&n.to_string())?),
            _ => return Err(error("execution_user", "Unsupported service user.")),
        };
        services.insert(
            name.clone(),
            ServiceInputs {
                command: resolver.argv(raw.get("command"))?,
                entrypoint: resolver.argv(raw.get("entrypoint"))?,
                environment: resolver.environment(raw.get("environment"))?,
                health_test,
                user,
            },
        );
    }
    if source::read_compose(&path)? != bytes {
        return Err(error(
            "execution_plan_changed",
            "Compose changed while executable inputs were compiled.",
        ));
    }
    Ok(ExecutionInputs { review, services })
}

#[cfg(test)]
mod argv_tests {
    use super::*;
    #[test]
    fn command_words_match_recorded_compose_reference() {
        let cases: Vec<serde_json::Value> =
            serde_json::from_str(include_str!("../../tests/fixtures/compose-argv.json")).unwrap();
        for case in cases {
            let text = case["input"].as_str().unwrap();
            if case["candidate_refuses"].as_bool() == Some(true) {
                assert!(tokenize(text).is_err(), "{text:?}");
            } else {
                assert_eq!(
                    serde_json::json!(tokenize(text).unwrap()),
                    case["compose"],
                    "{text:?}"
                );
            }
        }
        assert!(tokenize(&"a ".repeat(4097)).is_err());
        assert!(tokenize("echo a && b").is_err());
        assert!(tokenize("echo `date`").is_err());
        assert_eq!(tokenize("echo \\; \\|").unwrap(), ["echo", ";", "|"]);
    }
}
