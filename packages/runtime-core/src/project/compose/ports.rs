//! Review of Compose `ports` entries.
//!
//! Review is value-free: it never reads ambient environment values. A port
//! component may therefore use interpolation only in the form
//! `${NAME:-literal}` or `${NAME-literal}`, and native publication always uses
//! the declared literal default. The plan records the variable name (never a
//! value) and a warning says that ambient values are not read. A reference with
//! no literal default, a nested or non-literal default, or a reference that
//! spans more than one component is a located `unresolved_port_binding`
//! error, so the rest of the review still runs and the plan is not
//! enrollment compatible.
//!
//! Short-form splitting follows Docker's port-spec rule after interpolation:
//! the last component is the target, the one before it is the published port,
//! and anything before that is the host IP (optionally in IPv6 brackets).
//!
//! Host binding: native publishes only on host loopback. `127.0.0.1` and `::1`
//! are kept. An all-interface binding (`0.0.0.0`, `::` or no host IP) is
//! narrowed to the matching loopback address with a warning. Any other host
//! address is refused (`unsupported_host_binding`): binding a LAN interface
//! would expose a development service to the network.
use super::super::*;
use super::fields::*;
use serde_json::Value;

pub(super) fn port_number(value: &str) -> Result<u16, CandidateError> {
    value.parse::<u16>().ok().filter(|p| *p > 0).ok_or_else(|| {
        problem(
            "invalid_port",
            "Ports must be literal integers from 1 to 65535; ranges are not supported.",
        )
    })
}

const UNRESOLVED: &str = "Port interpolation needs one literal default per component, such as ${NAME:-8080}; native publication never reads ambient values.";
const TARGET_LITERAL: &str =
    "Port targets must be literal; only the host IP and published port may use ${NAME:-literal}.";

/// Review every declared port entry. An entry outside the modeled subset becomes
/// an error diagnostic that points at `services.<name>.ports[<i>]` (messages
/// never echo the authored value), so one unsupported port neither hides the
/// rest of the review nor makes the plan enrollment compatible.
pub(super) fn ports(
    value: Option<&Value>,
    field: &str,
    diagnostics: &mut Vec<Diagnostic>,
) -> Result<Vec<PortPlan>, CandidateError> {
    let Some(value) = value else {
        return Ok(vec![]);
    };
    let Some(values) = value.as_array() else {
        diagnostics.push(Diagnostic::error(
            "invalid_port",
            field,
            "Ports must be a list.",
        ));
        return Ok(vec![]);
    };
    let mut result = Vec::new();
    for (index, value) in values.iter().enumerate() {
        let located = format!("{field}[{index}]");
        match port(value, field, &located, diagnostics) {
            Ok(plan) => result.push(plan),
            Err(error) if ["invalid_port", "unresolved_port_binding"].contains(&error.code) => {
                diagnostics.push(Diagnostic::error(error.code, &located, &error.message))
            }
            Err(error) => return Err(error),
        }
    }
    Ok(result)
}

/// One port component after review: the literal native uses, and the variable
/// name when the literal came from a `${NAME:-literal}` default.
#[derive(Debug, PartialEq, Eq)]
struct Component {
    literal: String,
    reference: Option<String>,
}

impl Component {
    fn literal(text: &str) -> Self {
        Self {
            literal: text.into(),
            reference: None,
        }
    }
}

/// A reference expanded into `text` at `start..end`.
struct Expanded {
    name: String,
    start: usize,
    end: usize,
}

/// Expand every `${NAME:-literal}` / `${NAME-literal}` to its literal default.
/// `$$` is a literal `$`. Any other reference form is unresolved.
fn expand(value: &str) -> Result<(String, Vec<Expanded>), CandidateError> {
    let bytes = value.as_bytes();
    let mut text = String::new();
    let mut references = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'$' {
            let next = value[index..]
                .find('$')
                .map_or(value.len(), |offset| index + offset);
            text.push_str(&value[index..next]);
            index = next;
            continue;
        }
        if bytes.get(index + 1) == Some(&b'$') {
            text.push('$');
            index += 2;
            continue;
        }
        if bytes.get(index + 1) != Some(&b'{') {
            return Err(problem("unresolved_port_binding", UNRESOLVED));
        }
        let body_start = index + 2;
        let close = value[body_start..]
            .find('}')
            .map(|offset| body_start + offset)
            .ok_or_else(|| problem("unresolved_port_binding", UNRESOLVED))?;
        let body = &value[body_start..close];
        let name_end = body
            .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
            .unwrap_or(body.len());
        let name = &body[..name_end];
        let default = body[name_end..]
            .strip_prefix(":-")
            .or_else(|| body[name_end..].strip_prefix('-'));
        let valid_name = name
            .as_bytes()
            .first()
            .is_some_and(|b| b.is_ascii_alphabetic() || *b == b'_');
        match default {
            Some(default) if valid_name && !default.contains(['$', '{']) => {
                let start = text.len();
                text.push_str(default);
                references.push(Expanded {
                    name: name.into(),
                    start,
                    end: text.len(),
                });
                index = close + 1;
            }
            _ => return Err(problem("unresolved_port_binding", UNRESOLVED)),
        }
    }
    Ok((text, references))
}

/// Review one scalar that must be exactly one component.
fn component(value: &str) -> Result<Component, CandidateError> {
    let (text, references) = expand(value)?;
    components(&text, &references, &[(0, text.len())]).map(|mut parts| parts.remove(0))
}

/// Split expanded text into the given byte ranges. A component is either fully
/// literal or exactly one whole reference; a reference that is partial, mixed
/// with literal text or spans a separator is unresolved.
fn components(
    text: &str,
    references: &[Expanded],
    ranges: &[(usize, usize)],
) -> Result<Vec<Component>, CandidateError> {
    for reference in references {
        let whole = ranges
            .iter()
            .any(|(start, end)| reference.start == *start && reference.end == *end);
        // An empty default leaves an empty component, which the port number
        // check refuses afterwards.
        if !whole {
            return Err(problem("unresolved_port_binding", UNRESOLVED));
        }
    }
    Ok(ranges
        .iter()
        .map(|(start, end)| Component {
            literal: text[*start..*end].into(),
            reference: references
                .iter()
                .find(|r| r.start == *start && r.end == *end)
                .map(|r| r.name.clone()),
        })
        .collect())
}

/// Short form `[host_ip:][published:]target[/protocol]` after expansion.
fn short_form(
    value: &str,
) -> Result<(Component, Option<Component>, String, Component), CandidateError> {
    let (text, references) = expand(value)?;
    let (binding_end, protocol) = match text.rfind('/') {
        Some(slash) => (slash, text[slash + 1..].to_owned()),
        None => (text.len(), "tcp".to_owned()),
    };
    if references.iter().any(|r| r.end > binding_end) {
        return Err(problem("unresolved_port_binding", UNRESOLVED));
    }
    let separators: Vec<usize> = text[..binding_end]
        .match_indices(':')
        .map(|(index, _)| index)
        .collect();
    let ranges: Vec<(usize, usize)> = match separators.as_slice() {
        [] => vec![(0, binding_end)],
        [one] => vec![(0, *one), (one + 1, binding_end)],
        [.., host_end, published_end] => vec![
            (0, *host_end),
            (host_end + 1, *published_end),
            (published_end + 1, binding_end),
        ],
    };
    let mut parts = components(&text, &references, &ranges)?;
    let target = parts.pop().expect("one range at least");
    let published = parts.pop();
    let host = parts.pop().unwrap_or_else(|| Component::literal("0.0.0.0"));
    Ok((host, published, protocol, target))
}

fn literal_target(component: Component) -> Result<u16, CandidateError> {
    if component.reference.is_some() {
        return Err(problem("unresolved_port_binding", TARGET_LITERAL));
    }
    port_number(&component.literal)
}

fn scalar_component(value: &Value) -> Result<Component, CandidateError> {
    match value {
        Value::String(s) => component(s),
        Value::Number(n) => Ok(Component::literal(&n.to_string())),
        _ => Err(problem("invalid_port", "Invalid port value.")),
    }
}

/// Strip IPv6 brackets, as Docker's port-spec parser does.
fn host_address(text: &str) -> &str {
    text.strip_prefix('[')
        .and_then(|rest| rest.strip_suffix(']'))
        .unwrap_or(text)
}

fn port(
    value: &Value,
    field: &str,
    located: &str,
    diagnostics: &mut Vec<Diagnostic>,
) -> Result<PortPlan, CandidateError> {
    let (host, published, protocol, target) = if let Value::Object(m) = value {
        keys(
            m,
            &["target", "published", "protocol", "host_ip"],
            field,
            diagnostics,
        );
        let target = literal_target(scalar_component(
            m.get("target")
                .ok_or_else(|| problem("invalid_port", "Port target is required."))?,
        )?)?;
        let protocol = m
            .get("protocol")
            .map(string)
            .transpose()?
            .unwrap_or("tcp")
            .to_owned();
        if protocol.contains('$') {
            return Err(problem("unresolved_port_binding", UNRESOLVED));
        }
        (
            m.get("host_ip")
                .map(|v| string(v).and_then(component))
                .transpose()?
                .unwrap_or_else(|| Component::literal("0.0.0.0")),
            m.get("published").map(scalar_component).transpose()?,
            protocol,
            target,
        )
    } else {
        let text = match value {
            Value::String(s) => s.clone(),
            Value::Number(n) => n.to_string(),
            _ => return Err(problem("invalid_port", "Invalid port form.")),
        };
        let (host, published, protocol, target) = short_form(&text)?;
        (host, published, protocol, literal_target(target)?)
    };
    if !["tcp", "udp"].contains(&protocol.as_str()) {
        return Err(problem(
            "invalid_port",
            "Only TCP and UDP ports are modeled.",
        ));
    }
    let published_reference = published.as_ref().and_then(|p| p.reference.clone());
    let published = published.map(|p| port_number(&p.literal)).transpose()?;
    let host_ip_reference = host.reference.clone();
    let address = host_address(&host.literal);
    // Keep the historical field and text for literal entries so their plan
    // identity does not change.
    match address {
        "127.0.0.1" | "::1" => {}
        "0.0.0.0" => diagnostics.push(Diagnostic::warning("proposed_loopback_binding",field,"Enrollment proposes restricting the declared all-interface publication to 127.0.0.1. No port is bound by this checkpoint.")),
        "::" => diagnostics.push(Diagnostic::warning(
            "proposed_loopback_binding",
            located,
            "Enrollment proposes restricting the declared all-interface IPv6 publication to ::1.",
        )),
        // An entry with this error is never enrollment compatible, so its
        // location and text are free to be precise.
        _ => diagnostics.push(Diagnostic::error(
            "unsupported_host_binding",
            located,
            "Native publishes ports only on host loopback (127.0.0.1 or ::1) or narrows an all-interface binding to it; a specific non-loopback host address is refused because it would expose the service to the network.",
        )),
    }
    if published_reference.is_some() || host_ip_reference.is_some() {
        diagnostics.push(Diagnostic::warning(
            "interpolated_port_default",
            located,
            "Native publication uses the declared literal default; ambient values are not read.",
        ));
    }
    let (declared_host_ip, proposed_host_ip) = match address {
        "0.0.0.0" | "127.0.0.1" => (address.to_owned(), "127.0.0.1"),
        "::" | "::1" => (address.to_owned(), "::1"),
        _ => ("[unsupported]".to_owned(), "127.0.0.1"),
    };
    Ok(PortPlan {
        target,
        published,
        protocol,
        declared_host_ip,
        proposed_host_ip: proposed_host_ip.into(),
        published_reference,
        host_ip_reference,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn review(value: Value) -> (Result<PortPlan, CandidateError>, Vec<Diagnostic>) {
        let mut diagnostics = Vec::new();
        let result = port(
            &value,
            "services.s.ports",
            "services.s.ports[0]",
            &mut diagnostics,
        );
        (result, diagnostics)
    }

    fn accepted(value: Value) -> (PortPlan, Vec<String>) {
        let (result, diagnostics) = review(value.clone());
        let plan = result.unwrap_or_else(|error| panic!("{value}: {}", error.code));
        assert!(
            diagnostics.iter().all(|d| d.severity == "warning"),
            "{value}: {diagnostics:?}"
        );
        (plan, diagnostics.into_iter().map(|d| d.code).collect())
    }

    fn refused(value: Value) -> String {
        review(value.clone())
            .0
            .map(|_| ())
            .expect_err(&value.to_string())
            .code
            .to_owned()
    }

    #[test]
    fn interpolated_defaults_publish_their_literal_and_record_only_names() {
        let (plan, codes) = accepted(json!("${A_BIND:-127.0.0.1}:${A_PORT:-8108}:8108"));
        assert_eq!(
            (plan.declared_host_ip.as_str(), plan.published, plan.target),
            ("127.0.0.1", Some(8108), 8108)
        );
        assert_eq!(plan.host_ip_reference.as_deref(), Some("A_BIND"));
        assert_eq!(plan.published_reference.as_deref(), Some("A_PORT"));
        assert_eq!(codes, vec!["interpolated_port_default"]);

        let (plan, codes) = accepted(json!("${A_PORT-8108}:8108/udp"));
        assert_eq!(
            (plan.published, plan.protocol.as_str()),
            (Some(8108), "udp")
        );
        assert_eq!(plan.host_ip_reference, None);
        assert_eq!(
            codes,
            vec!["proposed_loopback_binding", "interpolated_port_default"]
        );

        let (plan, codes) = accepted(
            json!({"target": 80, "published": "${P:-8080}", "host_ip": "${B:-127.0.0.1}"}),
        );
        assert_eq!(plan.published, Some(8080));
        assert_eq!(plan.published_reference.as_deref(), Some("P"));
        assert_eq!(plan.host_ip_reference.as_deref(), Some("B"));
        assert_eq!(codes, vec!["interpolated_port_default"]);
    }

    #[test]
    /// Plan identity is the hash of the serialized plan, diagnostics included.
    /// Literal entries must serialize exactly as before the interpolation
    /// fields existed, with the same warning field and text.
    fn literal_entries_keep_their_plan_fields() {
        let (result, diagnostics) = review(json!("8108:8108"));
        assert_eq!(
            serde_json::to_string(&result.unwrap()).unwrap(),
            r#"{"target":8108,"published":8108,"protocol":"tcp","declared_host_ip":"0.0.0.0","proposed_host_ip":"127.0.0.1"}"#
        );
        assert_eq!(
            serde_json::to_string(&diagnostics).unwrap(),
            r#"[{"severity":"warning","code":"proposed_loopback_binding","field":"services.s.ports","message":"Enrollment proposes restricting the declared all-interface publication to 127.0.0.1. No port is bound by this checkpoint."}]"#
        );
        let (plan, codes) = accepted(json!("8108"));
        assert_eq!((plan.published, plan.target), (None, 8108));
        assert_eq!(codes, vec!["proposed_loopback_binding"]);
        let (plan, codes) = accepted(json!("127.0.0.1:8787:8787"));
        assert!(codes.is_empty());
        assert_eq!(
            serde_json::to_string(&plan).unwrap(),
            r#"{"target":8787,"published":8787,"protocol":"tcp","declared_host_ip":"127.0.0.1","proposed_host_ip":"127.0.0.1"}"#
        );
    }

    #[test]
    fn ipv6_loopback_and_all_interface_bindings_map_to_ipv6_loopback() {
        for value in [
            json!("[::1]:8080:80"),
            json!("::1:8080:80"),
            json!({"target": 80, "published": 8080, "host_ip": "::1"}),
        ] {
            let (plan, codes) = accepted(value);
            assert_eq!(
                (
                    plan.declared_host_ip.as_str(),
                    plan.proposed_host_ip.as_str()
                ),
                ("::1", "::1")
            );
            assert!(codes.is_empty());
        }
        let (plan, codes) = accepted(json!("[::]:8080:80"));
        assert_eq!(plan.proposed_host_ip, "::1");
        assert_eq!(codes, vec!["proposed_loopback_binding"]);
    }

    #[test]
    fn unresolvable_or_ambiguous_interpolation_is_a_located_refusal() {
        for value in [
            json!("${A_PORT}:80"),
            json!("$A_PORT:80"),
            json!("${A_PORT:?required}:80"),
            json!("${A_PORT:+8080}:80"),
            json!("${A:-${B:-8080}}:80"),
            json!("${A:-8080:80}"),
            json!("1${A:-080}:80"),
            json!("8080:${T:-80}"),
            json!("8080:80/${P:-tcp}"),
            json!("${A:-8080"),
            json!({"target": "${T:-80}", "published": 8080}),
            json!({"target": 80, "published": "${P}"}),
        ] {
            assert_eq!(refused(value.clone()), "unresolved_port_binding", "{value}");
        }
    }

    #[test]
    fn invalid_values_stay_invalid_and_foreign_hosts_are_refused() {
        for value in [
            json!("70000:80"),
            json!("8000-8001:80"),
            json!("80/sctp"),
            json!("${A:-}:80"),
            json!("${A:-x}:80"),
        ] {
            assert_eq!(refused(value.clone()), "invalid_port", "{value}");
        }
        let (result, diagnostics) = review(json!("${B:-10.9.8.7}:9092:82"));
        let plan = result.unwrap();
        assert_eq!(plan.declared_host_ip, "[unsupported]");
        assert!(
            diagnostics
                .iter()
                .any(|d| d.code == "unsupported_host_binding"
                    && d.severity == "error"
                    && d.field == "services.s.ports[0]")
        );
    }

    #[test]
    fn messages_never_echo_authored_values() {
        let canary = "C4NARY_VALUE";
        for value in [
            json!(format!("${{{canary}}}:80")),
            json!(format!("${{X:-{canary}}}:80")),
            json!(format!("${{X:-10.1.2.3}}:${{Y:-{canary}}}:80")),
        ] {
            let mut diagnostics = Vec::new();
            let _ = ports(Some(&json!([value])), "services.s.ports", &mut diagnostics);
            let text = serde_json::to_string(&diagnostics).unwrap();
            assert!(
                !text.contains(canary) && !text.contains("10.1.2.3"),
                "{text}"
            );
            assert!(!diagnostics.is_empty());
        }
    }
}
