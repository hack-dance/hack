//! Hack's authored one-shot role marker, `hack.service.one-shot: "true"`.
//!
//! This exact key is the only `hack.service.*` label the review consumes. It
//! grants a successful-completion readiness role and nothing else: it is not
//! ownership evidence, it installs no route and it adds no resource label. Any
//! other `hack.*` key, and every Hack ownership namespace, stays refused by the
//! service label review.
use serde_json::Value;

/// The documented one-shot label key, matching `hack config import`.
pub(super) const LABEL: &str = "hack.service.one-shot";

/// What a service's labels say about the one-shot marker.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Declaration {
    /// The marker key is absent.
    Absent,
    /// The marker key carries the exact literal string `true`.
    OneShot,
    /// The marker key is present with any other value or form.
    Invalid,
}

/// Whether `key` is the one-shot marker key itself (not a prefix match).
pub(super) fn recognized(key: &str) -> bool {
    key == LABEL
}

/// Classify the marker in either Compose label form. Only the literal string
/// value `true` (map form) or the entry `hack.service.one-shot=true` (list form)
/// declares a one-shot service; booleans, other strings and a bare key do not.
/// Label shape errors are reported by the generic label review, not here.
pub(super) fn parse(labels: Option<&Value>) -> Declaration {
    let value = match labels {
        Some(Value::Object(map)) => match map.get(LABEL) {
            None => return Declaration::Absent,
            Some(Value::String(value)) => Some(value.as_str()),
            Some(_) => None,
        },
        Some(Value::Array(entries)) => {
            let mut found = None;
            for entry in entries.iter().filter_map(Value::as_str) {
                let (key, value) = entry
                    .split_once('=')
                    .map_or((entry, None), |(key, value)| (key, Some(value)));
                if key == LABEL {
                    found = Some(value);
                }
            }
            match found {
                None => return Declaration::Absent,
                Some(value) => value,
            }
        }
        _ => return Declaration::Absent,
    };
    if value == Some("true") {
        Declaration::OneShot
    } else {
        Declaration::Invalid
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn exact_map_and_list_forms_declare_a_one_shot() {
        assert_eq!(
            parse(Some(&json!({"hack.service.one-shot": "true"}))),
            Declaration::OneShot
        );
        assert_eq!(
            parse(Some(&json!(["hack.service.one-shot=true"]))),
            Declaration::OneShot
        );
        assert_eq!(
            parse(Some(
                &json!({"other": "x", "hack.service.one-shot": "true"})
            )),
            Declaration::OneShot
        );
    }

    #[test]
    fn other_values_and_forms_are_invalid_not_one_shot() {
        for labels in [
            json!({"hack.service.one-shot": "false"}),
            json!({"hack.service.one-shot": "TRUE"}),
            json!({"hack.service.one-shot": " true"}),
            json!({"hack.service.one-shot": true}),
            json!({"hack.service.one-shot": null}),
            json!(["hack.service.one-shot"]),
            json!(["hack.service.one-shot=1"]),
        ] {
            assert_eq!(parse(Some(&labels)), Declaration::Invalid, "{labels}");
        }
    }

    #[test]
    fn absent_and_near_miss_keys_are_not_the_marker() {
        for labels in [
            json!({}),
            json!([]),
            json!({"hack.service.one-shot.extra": "true"}),
            json!({"hack.service": "true"}),
            json!({"hack.service.oneshot": "true"}),
            json!(["hack.service.one-shotx=true"]),
        ] {
            assert_eq!(parse(Some(&labels)), Declaration::Absent, "{labels}");
        }
        assert_eq!(parse(None), Declaration::Absent);
        assert!(recognized(LABEL));
        assert!(!recognized("hack.service.one-shot.extra"));
        assert!(!recognized("hack.service."));
    }
}
