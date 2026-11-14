//! Names-only environment metadata. Unknown fields are discarded at deserialization;
//! neither raw CLI output nor parse diagnostics escape this boundary.
use serde::Deserialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KeyState {
    Ok,
    Missing,
    Unreadable,
    #[default]
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(untagged)]
pub enum Scope {
    Canonical(String),
    Legacy(Vec<String>),
}
impl Scope {
    #[must_use]
    pub fn label(&self) -> String {
        match self {
            Self::Canonical(s) => s.clone(),
            Self::Legacy(s) => s.join(", "),
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Storage {
    pub kind: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct EnvRow {
    pub key: String,
    pub required: bool,
    pub storage: Storage,
    pub resolved_from: Option<String>,
    pub has_value: bool,
    pub scope: Scope,
    pub layer: Option<String>,
    #[serde(skip)]
    pub missing: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct EnvReport {
    pub vars: Vec<EnvRow>,
    pub missing_required: Vec<String>,
    #[serde(default)]
    pub key_state: KeyState,
}
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum EnvView {
    #[default]
    Loading,
    Unreadable,
    Report(EnvReport),
}
impl EnvView {
    /// A bare report on exit 1 is valid. Malformed output never becomes empty.
    #[must_use]
    pub fn parse(output: &str, code: Option<i32>) -> Self {
        if !matches!(code, Some(0 | 1)) {
            return Self::Unreadable;
        }
        let Ok(mut report) = serde_json::from_str::<EnvReport>(output) else {
            return Self::Unreadable;
        };
        for row in &mut report.vars {
            row.missing = report.missing_required.contains(&row.key);
        }
        for key in &report.missing_required {
            if !report.vars.iter().any(|r| &r.key == key) {
                report.vars.push(EnvRow {
                    key: key.clone(),
                    required: true,
                    storage: Storage {
                        kind: "unknown".into(),
                    },
                    resolved_from: None,
                    has_value: false,
                    scope: Scope::Canonical("unknown".into()),
                    layer: None,
                    missing: true,
                });
            }
        }
        report
            .vars
            .sort_by(|a, b| b.missing.cmp(&a.missing).then(a.key.cmp(&b.key)));
        Self::Report(report)
    }
}

/// Monotonic request identity also rejects A → B → A stale completions.
#[derive(Default)]
pub struct EnvModel {
    pub view: EnvView,
    generation: u64,
}
impl EnvModel {
    pub fn begin(&mut self) -> u64 {
        self.generation += 1;
        self.view = EnvView::Loading;
        self.generation
    }
    pub fn finish(&mut self, generation: u64, view: EnvView) {
        if generation == self.generation {
            self.view = view;
        }
    }
}

#[must_use]
pub fn fixture(name: &str) -> EnvView {
    match name {
        "env-loading" => EnvView::Loading,
        "env-error" => EnvView::Unreadable,
        "env-empty" => EnvView::parse(r#"{"vars":[],"missing_required":[]}"#, Some(0)),
        _ => {
            let key_state = if name == "env-locked" {
                "missing"
            } else {
                "unknown"
            };
            let missing = if name == "env-missing" {
                r#""API_TOKEN""#
            } else {
                ""
            };
            EnvView::parse(
                &format!(
                    r#"{{"key_state":"{key_state}","missing_required":[{missing}],"vars":[{{"key":"APP_MODE","required":false,"storage":{{"kind":"plain"}},"resolved_from":"project","has_value":true,"scope":"project","layer":null}},{{"key":"API_TOKEN","required":true,"storage":{{"kind":"encrypted"}},"resolved_from":null,"has_value":false,"scope":["runtime"],"layer":"local"}}]}}"#
                ),
                Some(1),
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn metadata_only_and_missing_first() {
        let view = EnvView::parse(
            r#"{"vars":[{"key":"Z","required":true,"storage":{"kind":"plain"},"resolved_from":null,"has_value":false,"scope":["runtime"],"layer":null,"value":"SECRET_SENTINEL","materialized":"SECRET_SENTINEL"}],"missing_required":["A"]}"#,
            Some(1),
        );
        let EnvView::Report(r) = &view else {
            panic!("report")
        };
        assert_eq!(r.vars[0].key, "A");
        assert!(r.vars[0].missing);
        assert_eq!(r.key_state, KeyState::Unknown);
        assert!(!format!("{view:?}").contains("SECRET_SENTINEL"));
        assert_eq!(
            EnvView::parse("SECRET_SENTINEL", Some(1)),
            EnvView::Unreadable
        );
        assert_eq!(
            EnvView::parse(r#"{"missing_required":[]}"#, Some(0)),
            EnvView::Unreadable
        );
        assert!(matches!(fixture("env-empty"), EnvView::Report(r) if r.vars.is_empty()));
    }
    #[test]
    fn fixtures_and_key_states_preserve_unknowns() {
        assert_eq!(fixture("env-loading"), EnvView::Loading);
        assert_eq!(fixture("env-error"), EnvView::Unreadable);
        assert!(
            matches!(fixture("env-locked"), EnvView::Report(r) if r.key_state == KeyState::Missing)
        );
        assert!(matches!(fixture("env-missing"), EnvView::Report(r) if r.vars[0].missing));
        for state in ["ok", "missing", "unreadable", "future"] {
            let report = EnvView::parse(
                &format!(r#"{{"vars":[],"missing_required":[],"key_state":"{state}"}}"#),
                Some(0),
            );
            let EnvView::Report(report) = report else {
                panic!("valid metadata");
            };
            assert_eq!(
                report.key_state,
                match state {
                    "ok" => KeyState::Ok,
                    "missing" => KeyState::Missing,
                    "unreadable" => KeyState::Unreadable,
                    _ => KeyState::Unknown,
                }
            );
        }
        let EnvView::Report(report) = fixture("env-normal") else {
            panic!("report");
        };
        assert!(
            report
                .vars
                .iter()
                .any(|r| matches!(r.scope, Scope::Canonical(_)))
        );
        assert!(
            report
                .vars
                .iter()
                .any(|r| matches!(r.scope, Scope::Legacy(_)))
        );
    }

    #[test]
    fn stale_completion_is_ignored() {
        let mut model = EnvModel::default();
        let old = model.begin();
        let current = model.begin();
        model.finish(old, fixture("env-empty"));
        assert_eq!(model.view, EnvView::Loading);
        model.finish(current, fixture("env-normal"));
        assert!(matches!(model.view, EnvView::Report(_)));
    }
}
