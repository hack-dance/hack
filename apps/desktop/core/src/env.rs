//! Metadata for the names-only Env tab.

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
            Self::Legacy(s) if s.is_empty() => "global".into(),
            Self::Legacy(s) => s.join(", "),
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct EnvRow {
    pub key: String,
    pub scope: Scope,
    #[serde(skip)]
    pub missing: bool,
}
impl EnvRow {
    /// The scope name, `global` when the listing does not name one.
    #[must_use]
    pub fn scope_name(&self) -> String {
        match &self.scope {
            Scope::Canonical(s) if s.is_empty() || s == "project" => "global".into(),
            other => other.label(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct EnvReport {
    pub vars: Vec<EnvRow>,
    pub missing_required: Vec<String>,
    #[serde(default)]
    pub files: Vec<String>,
    #[serde(default)]
    pub scopes: Vec<String>,
    pub selected_scope: Option<String>,
    #[serde(default)]
    pub key_state: KeyState,
    /// Overlay names the CLI selected: requested, default and effective.
    #[serde(default)]
    pub env_selection: Option<EnvSelection>,
    #[serde(default)]
    pub overlays: Vec<EnvOverlay>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct EnvOverlay {
    pub name: String,
}

/// `env_selection` in `hack env list --json`: overlay names, no values.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Deserialize)]
#[serde(default)]
pub struct EnvSelection {
    pub requested: Option<String>,
    pub default: Option<String>,
    pub effective: Option<String>,
}

/// One overlay tab: its label and the `--env` value that lists it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OverlayTab {
    pub label: String,
    /// `--env` argument: `default` lists the base layers.
    pub env: String,
    /// The project's configured default overlay.
    pub is_default: bool,
}

impl EnvSelection {
    /// Base first, then each CLI-reported overlay once.
    #[must_use]
    pub fn tabs(&self, available: &[EnvOverlay]) -> Vec<OverlayTab> {
        let mut out = vec![OverlayTab {
            label: "base".into(),
            env: "default".into(),
            is_default: false,
        }];
        for name in [&self.default, &self.requested, &self.effective]
            .into_iter()
            .flatten()
            .chain(available.iter().map(|overlay| &overlay.name))
        {
            if name.is_empty()
                || matches!(name.as_str(), "base" | "default")
                || out.iter().any(|t| &t.env == name)
            {
                continue;
            }
            out.push(OverlayTab {
                label: name.clone(),
                env: name.clone(),
                is_default: self.default.as_ref() == Some(name),
            });
        }
        out
    }

    /// The overlays a host shell can be opened with: the project's default
    /// and the effective one, without repeats.
    #[must_use]
    pub fn overlays(&self) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for name in [&self.default, &self.effective].into_iter().flatten() {
            if !name.is_empty() && !out.contains(name) {
                out.push(name.clone());
            }
        }
        out
    }
}
impl EnvReport {
    /// An empty default-scope listing does not establish project-wide absence.
    #[must_use]
    pub fn empty_label(&self) -> &'static str {
        if self.files.is_empty() && self.scopes.is_empty() && self.selected_scope.is_none() {
            "This project has no env layers"
        } else {
            "No names in this scope. Other env scopes or layers may be configured."
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum EnvView {
    #[default]
    Loading,
    Unreadable,
    Report(Box<EnvReport>),
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
                    scope: Scope::Canonical("unknown".into()),
                    missing: true,
                });
            }
        }
        report
            .vars
            .sort_by(|a, b| b.missing.cmp(&a.missing).then(a.key.cmp(&b.key)));
        Self::Report(Box::new(report))
    }
}

/// The quiet line under the overlay tabs: whether the CLI could read the
/// project's secret key. The CLI does not say which source it used
/// (DESIGN.md request R26), so the line names the two it looks in.
#[must_use]
pub fn key_line(state: KeyState) -> Option<(bool, &'static str)> {
    match state {
        KeyState::Ok => Some((true, "Secret key found")),
        KeyState::Missing => Some((
            false,
            "No secret key: add .hack.secret.key to the checkout or set HACK_ENV_SECRET_KEY",
        )),
        KeyState::Unreadable => Some((false, "Secret key found but unreadable")),
        KeyState::Unknown => None,
    }
}

/// Monotonic request identity also rejects A → B → A stale completions.
#[derive(Default)]
pub struct EnvModel {
    pub view: EnvView,
    generation: u64,
    /// The overlay tab shown (`--env` value); `None` until chosen.
    pub env: Option<String>,
    /// The scope listed (`--service` value); `None` is the CLI's default.
    pub scope: Option<String>,
    /// The overlay the selected instance is running, when known. The CLI
    /// does not report it per instance yet (DESIGN.md R22); fixtures set it.
    pub running: Option<String>,
}
impl EnvModel {
    /// Start a fresh names-only listing.
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
    let row = |key: &str, kind: &str, scope: &str| {
        format!(
            r#"{{"key":"{key}","required":false,"storage":{{"kind":"{kind}"}},"resolved_from":"project_env_config","has_value":true,"scope":"{scope}","layer":".hack/hack.env.default.yaml"}}"#
        )
    };
    match name {
        "env-loading" => EnvView::Loading,
        "env-error" => EnvView::Unreadable,
        "env-empty" => EnvView::parse(r#"{"vars":[],"missing_required":[]}"#, Some(0)),
        // Several overlays, long names, a scoped secret, and a
        // required name that is missing.
        "env-overlays" | "env-running" | "env-locked" | "env-missing" | "env-long" => {
            let key_state = if name == "env-locked" {
                "missing"
            } else {
                "ok"
            };
            let missing = if name == "env-missing" {
                r#""PAYMENTS_WEBHOOK_SECRET""#
            } else {
                ""
            };
            let mut vars = vec![
                row("APP_MODE", "plaintext", "global"),
                row("DATABASE_URL", "secret", "global"),
                row("LOG_LEVEL", "plaintext", "global"),
                row("API_TOKEN", "secret", "api"),
            ];
            if name == "env-long" {
                vars.push(row(
                    "AN_UNUSUALLY_LONG_VARIABLE_NAME_THAT_KEEPS_GOING_FOR_THE_LAYOUT",
                    "plaintext",
                    "global",
                ));
            }
            EnvView::parse(
                &format!(
                    r#"{{"files":["hack.env.default.yaml","hack.env.staging.yaml"],"scopes":["global","api","web"],"selected_scope":"global","key_state":"{key_state}","missing_required":[{missing}],"env_selection":{{"requested":"staging","default":"dev","effective":"staging"}},"overlays":[{{"name":"dev"}},{{"name":"staging"}},{{"name":"qa"}}],"vars":[{}]}}"#,
                    vars.join(",")
                ),
                Some(0),
            )
        }
        _ => {
            let key_state = "unknown";
            EnvView::parse(
                &format!(
                    r#"{{"files":["hack.env.default.yaml"],"scopes":["global","api"],"selected_scope":"global","key_state":"{key_state}","missing_required":[],"vars":[{{"key":"APP_MODE","required":false,"storage":{{"kind":"plain"}},"resolved_from":"project","has_value":true,"scope":"project","layer":null}},{{"key":"API_TOKEN","required":true,"storage":{{"kind":"encrypted"}},"resolved_from":null,"has_value":false,"scope":["runtime"],"layer":"local"}}]}}"#
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
        assert!(
            matches!(fixture("env-missing"), EnvView::Report(r) if r.vars[0].missing && r.vars[0].key == "PAYMENTS_WEBHOOK_SECRET")
        );
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
    fn empty_default_scope_does_not_hide_configured_layers() {
        let view = EnvView::parse(
            r#"{"vars":[],"missing_required":[],"files":["hack.env.default.yaml"],"scopes":["api"],"selected_scope":"global"}"#,
            Some(0),
        );
        let EnvView::Report(report) = view else {
            panic!("report");
        };
        assert_ne!(report.empty_label(), "This project has no env layers");
        assert_eq!(report.selected_scope.as_deref(), Some("global"));
        let EnvView::Report(empty) = fixture("env-empty") else {
            panic!("report");
        };
        assert_eq!(empty.empty_label(), "This project has no env layers");
    }

    #[test]
    fn the_key_line_names_both_sources_when_none_is_found() {
        assert_eq!(key_line(KeyState::Ok), Some((true, "Secret key found")));
        let (ok, text) = key_line(KeyState::Missing).unwrap();
        assert!(!ok);
        assert!(text.contains(".hack.secret.key") && text.contains("HACK_ENV_SECRET_KEY"));
        assert_eq!(key_line(KeyState::Unknown), None);
    }

    #[test]
    fn overlay_tabs_are_base_then_each_named_overlay_once() {
        let EnvView::Report(r) = fixture("env-overlays") else {
            panic!("report");
        };
        let tabs = r.env_selection.unwrap().tabs(&r.overlays);
        let labels: Vec<&str> = tabs.iter().map(|t| t.label.as_str()).collect();
        assert_eq!(labels, ["base", "dev", "staging", "qa"]);
        assert_eq!(tabs[0].env, "default", "base is --env default");
        assert!(tabs[1].is_default);
    }

    #[test]
    fn legacy_empty_scope_is_global() {
        assert_eq!(Scope::Legacy(vec![]).label(), "global");
        assert_eq!(Scope::Legacy(vec!["api".into()]).label(), "api");
        assert_eq!(Scope::Canonical("global".into()).label(), "global");
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
