//! Environment metadata and, on request, one value at a time.
//!
//! Listings are names and kinds only (`hack env list --json`); unknown
//! fields, values included, are discarded at deserialization, and neither
//! raw CLI output nor parse diagnostics escape this boundary. A value is
//! read only when the user asks for that one name (`hack env get`), held as
//! [`Revealed`], which never prints, and dropped after [`REVEAL_FOR`] or
//! when the tab, overlay, project or window changes.
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
impl EnvRow {
    /// A secret (stored encrypted): masked until its eye is pressed.
    #[must_use]
    pub fn is_secret(&self) -> bool {
        matches!(self.storage.kind.as_str(), "secret" | "encrypted")
    }

    /// The value comes from a worktree-local layer: `hack.env.local.yaml`,
    /// `hack.env.<overlay>.local.yaml`, or a legacy dotenv file (`.env`,
    /// `.env.<overlay>`) or `local` layer, which are not committed either. A
    /// write must go there too (`--local`): otherwise the local value keeps
    /// winning, and a value kept out of the repository would be copied into
    /// the shared, committed YAML.
    #[must_use]
    pub fn is_local_layer(&self) -> bool {
        matches!(self.write_layer(), Ok(true))
    }

    /// Where a write to this existing row may go: `Ok(true)` its
    /// worktree-local layer (`--local`), `Ok(false)` the shared, committed
    /// `hack.env*.yaml`. Only a layer known to be one of those is written; any
    /// other (a backend such as `portable_backend`, or a name the app does not
    /// know) is refused, so a value never moves from a place kept out of the
    /// repository into the shared file. A row without a layer writes to the
    /// shared file only when it has no stored value to move (a missing
    /// required name); a stored value whose layer is not listed is refused.
    ///
    /// # Errors
    /// The reason, for a layer the app does not write.
    pub fn write_layer(&self) -> Result<bool, String> {
        let Some(layer) = self.layer.as_deref() else {
            if self.missing || !self.has_value {
                return Ok(false);
            }
            return Err(format!(
                "{} has a value but the listing does not say where it is stored: edit it with the CLI so it stays there.",
                self.key
            ));
        };
        let name = layer.rsplit('/').next().unwrap_or(layer);
        if name == "local"
            || name == ".env"
            || name.starts_with(".env.")
            || (name.starts_with("hack.env") && name.ends_with(".local.yaml"))
        {
            return Ok(true);
        }
        if name.starts_with("hack.env") && name.ends_with(".yaml") {
            return Ok(false);
        }
        Err(format!(
            "{} is stored in {layer}, which the app does not write: edit it with the CLI so it stays there.",
            self.key
        ))
    }

    /// A plaintext value: shown with the listing, no eye needed.
    #[must_use]
    pub fn is_plaintext(&self) -> bool {
        matches!(self.storage.kind.as_str(), "plaintext" | "plain")
    }

    /// The service scope to read this row's value in (`--service`), when
    /// the listing did not choose one: a legacy row limited to services
    /// names its first service, a canonical row its scope. `None` for
    /// global rows. Without it the CLI resolves in the global scope and a
    /// service-only variable cannot be read.
    #[must_use]
    pub fn value_scope(&self) -> Option<String> {
        match &self.scope {
            Scope::Legacy(services) => services.first().cloned(),
            Scope::Canonical(s)
                if !s.is_empty() && !matches!(s.as_str(), "global" | "project" | "unknown") =>
            {
                Some(s.clone())
            }
            Scope::Canonical(_) => None,
        }
    }

    /// The one scope a write to this row goes to (`--service`). A legacy
    /// row limited to several services has none: one write cannot cover
    /// them, so editing it in the app is refused and the reason says how.
    ///
    /// # Errors
    /// The reason, for a row the app cannot write in one scope.
    pub fn write_scope(&self) -> Result<String, String> {
        match &self.scope {
            Scope::Legacy(services) if services.len() > 1 => Err(format!(
                "{} applies to {}; one write cannot cover several services. Edit it with the CLI per service, or migrate the project's env (hack env migrate).",
                self.key,
                services.join(", ")
            )),
            Scope::Legacy(services) => {
                Ok(services.first().cloned().unwrap_or_else(|| "global".into()))
            }
            Scope::Canonical(_) => Ok(self.scope_name()),
        }
    }

    /// Why the app will not write this row, if it will not: a scope one
    /// write cannot cover, or a layer it does not write (see
    /// [`Self::write_layer`]).
    #[must_use]
    pub fn write_blocked(&self) -> Option<String> {
        self.write_scope()
            .err()
            .or_else(|| self.write_layer().err())
    }

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
        Self::Report(Box::new(report))
    }
}

/// How long a revealed value stays on screen.
pub const REVEAL_FOR: std::time::Duration = std::time::Duration::from_secs(60);

/// One value the user asked to see. It never prints: `Debug` shows only
/// its length, and nothing formats it but the cell that draws it and the
/// clipboard write.
#[derive(Clone, PartialEq, Eq)]
pub struct Revealed(String);

impl Revealed {
    #[must_use]
    pub fn new(value: String) -> Self {
        Self(value)
    }
    /// The value, for the one cell that shows it or the clipboard.
    #[must_use]
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for Revealed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Revealed({} bytes)", self.0.len())
    }
}

/// A variable's identity in a listing: overlay, scope and name.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ValueKey {
    pub env: String,
    pub scope: String,
    pub name: String,
}

/// What a value cell shows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ValueState {
    /// Not asked for (secrets), or not read yet.
    Hidden,
    Reading,
    Shown {
        value: Revealed,
        at: std::time::Instant,
    },
    /// Could not be read; the message names no value.
    Failed(String),
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
    /// The value last copied, for its check mark until the clipboard clears.
    pub copied: Option<ValueKey>,
    /// The value the app last put on the clipboard, until it clears it
    /// (after `REVEAL_FOR`, or on quit) or something else replaces it.
    pub clipboard: Option<Revealed>,
    /// Counts copies: each copy's timer clears only if no later copy (of
    /// the same value or another) has happened since.
    pub clipboard_copy: u64,
    /// Bumped by every hide of all values (a new listing, focus or
    /// visibility lost): a reveal or copy started before it must not
    /// complete after it. Those hides also drop the "Reading" marks.
    reveal_epoch: u64,
    /// The reveal request each name is waiting for: a cancelled request's
    /// late result never fills a newer one's place.
    reveal_tokens: std::collections::HashMap<ValueKey, u64>,
    next_token: u64,
    values: std::collections::HashMap<ValueKey, ValueState>,
}
impl EnvModel {
    /// A new listing: every value shown so far is dropped.
    pub fn begin(&mut self) -> u64 {
        self.generation += 1;
        self.reveal_epoch += 1;
        self.reveal_tokens.clear();
        self.view = EnvView::Loading;
        self.values.clear();
        self.generation
    }
    pub fn finish(&mut self, generation: u64, view: EnvView) {
        if generation == self.generation {
            self.view = view;
        }
    }
    #[must_use]
    pub fn generation(&self) -> u64 {
        self.generation
    }
    /// See `reveal_epoch`: a pending reveal or copy compares it on completion.
    #[must_use]
    pub fn reveal_epoch(&self) -> u64 {
        self.reveal_epoch
    }
    /// What `key`'s cell shows now; a value older than [`REVEAL_FOR`] is
    /// hidden again.
    #[must_use]
    pub fn value(&self, key: &ValueKey) -> ValueState {
        match self.values.get(key) {
            Some(ValueState::Shown { at, .. }) if at.elapsed() >= REVEAL_FOR => ValueState::Hidden,
            Some(v) => v.clone(),
            None => ValueState::Hidden,
        }
    }
    pub fn set_value(&mut self, generation: u64, key: ValueKey, state: ValueState) {
        if generation == self.generation {
            self.values.insert(key, state);
        }
    }
    /// Start reading one name for a reveal: marks it "Reading" and returns
    /// the token its result must present.
    pub fn start_reveal(&mut self, key: ValueKey) -> u64 {
        self.next_token += 1;
        self.reveal_tokens.insert(key.clone(), self.next_token);
        self.values.insert(key, ValueState::Reading);
        self.next_token
    }

    /// Install a reveal's result only if it answers the latest request for
    /// that name and the name is still being read. Hiding it meanwhile, or
    /// a newer request, drops a late result. Returns whether it was
    /// installed.
    pub fn finish_reveal(
        &mut self,
        generation: u64,
        key: ValueKey,
        token: u64,
        state: ValueState,
    ) -> bool {
        let pending = generation == self.generation
            && self.reveal_tokens.get(&key) == Some(&token)
            && matches!(self.values.get(&key), Some(ValueState::Reading));
        if pending {
            self.reveal_tokens.remove(&key);
            self.values.insert(key, state);
        }
        pending
    }
    pub fn hide(&mut self, key: &ValueKey) {
        self.reveal_tokens.remove(key);
        self.values.remove(key);
    }
    /// Drop every value (the window lost focus, a tab changed).
    pub fn hide_all(&mut self) {
        self.reveal_epoch += 1;
        self.reveal_tokens.clear();
        self.values.clear();
    }
    /// Hide every revealed value. Returns whether a value was showing or loading.
    pub fn hide_revealed(&mut self) -> bool {
        self.reveal_epoch += 1;
        self.reveal_tokens.clear();
        let before = self.values.len();
        self.values
            .retain(|_, v| matches!(v, ValueState::Failed(_)));
        before != self.values.len()
    }
    /// Drop values shown longer than [`REVEAL_FOR`]; whether any was.
    pub fn expire(&mut self) -> bool {
        let before = self.values.len();
        self.values.retain(
            |_, v| !matches!(v, ValueState::Shown { at, .. } if at.elapsed() >= REVEAL_FOR),
        );
        before != self.values.len()
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
        "env-overlays" | "env-running" | "env-locked" | "env-missing" | "env-long" | "env-edit"
        | "env-revealed" => {
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

/// An obviously fake value for a fixture name; long for the long fixture.
#[must_use]
pub fn fixture_value(key: &str) -> String {
    if key.starts_with("AN_UNUSUALLY_LONG") || key == "DATABASE_URL" {
        "fake-fixture-value-repeated-fake-fixture-value-repeated-fake-fixture-value".into()
    } else {
        format!("fake-{}-value", key.to_ascii_lowercase().replace('_', "-"))
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
    fn fixture_values_are_obviously_fake() {
        for key in ["APP_MODE", "DATABASE_URL", "API_TOKEN"] {
            let v = fixture_value(key);
            assert!(v.contains("fake") || v.contains("fixture"), "{v}");
        }
    }

    #[test]
    fn a_revealed_value_expires_and_never_prints() {
        let mut model = EnvModel::default();
        let generation = model.begin();
        let key = ValueKey {
            env: "staging".into(),
            scope: "global".into(),
            name: "DATABASE_URL".into(),
        };
        let at = std::time::Instant::now()
            .checked_sub(REVEAL_FOR + std::time::Duration::from_secs(1))
            .expect("clock");
        model.set_value(
            generation,
            key.clone(),
            ValueState::Shown {
                value: Revealed::new("SECRET_SENTINEL".into()),
                at,
            },
        );
        assert!(!format!("{:?}", model.values).contains("SECRET_SENTINEL"));
        assert_eq!(model.value(&key), ValueState::Hidden, "past its time");
        assert!(model.expire());
        assert_eq!(model.value(&key), ValueState::Hidden);
    }

    #[test]
    fn hiding_everything_invalidates_reads_still_in_flight() {
        let mut model = EnvModel::default();
        model.begin();
        let key = |name: &str| ValueKey {
            env: "staging".into(),
            scope: "global".into(),
            name: name.into(),
        };
        // An eye pressed, then focus lost before `hack env get` answered.
        let epoch = model.reveal_epoch();
        model.set_value(model.generation(), key("DATABASE_URL"), ValueState::Reading);
        assert!(model.hide_revealed());
        assert_ne!(model.reveal_epoch(), epoch, "the pending reveal is dropped");
        assert_eq!(model.value(&key("DATABASE_URL")), ValueState::Hidden);
        // Hiding one value with its own eye leaves another read alone.
        let epoch = model.reveal_epoch();
        model.hide(&key("API_TOKEN"));
        assert_eq!(model.reveal_epoch(), epoch);
        // A new listing invalidates too.
        model.begin();
        assert_ne!(model.reveal_epoch(), epoch);
    }

    #[test]
    fn a_reveal_hidden_while_reading_never_lands() {
        let mut model = EnvModel::default();
        let generation = model.begin();
        let key = ValueKey {
            env: "staging".into(),
            scope: "global".into(),
            name: "DATABASE_URL".into(),
        };
        let shown = || ValueState::Shown {
            value: Revealed::new("fake-value".into()),
            at: std::time::Instant::now(),
        };
        let a = model.start_reveal(key.clone());
        model.hide(&key);
        assert!(!model.finish_reveal(generation, key.clone(), a, shown()));
        assert_eq!(model.value(&key), ValueState::Hidden);
        // Cancelled A, then B started: A's late result does not fill B's place.
        let a = model.start_reveal(key.clone());
        model.hide(&key);
        let b = model.start_reveal(key.clone());
        assert!(!model.finish_reveal(generation, key.clone(), a, shown()));
        assert_eq!(model.value(&key), ValueState::Reading);
        assert!(model.finish_reveal(generation, key.clone(), b, shown()));
        assert!(matches!(model.value(&key), ValueState::Shown { .. }));
    }

    #[test]
    fn a_service_only_row_reads_its_value_in_that_service() {
        let row = |scope: Scope| EnvRow {
            key: "K".into(),
            required: false,
            storage: Storage {
                kind: "plaintext".into(),
            },
            resolved_from: None,
            has_value: true,
            scope,
            layer: None,
            missing: false,
        };
        assert_eq!(
            row(Scope::Legacy(vec!["api".into(), "web".into()])).value_scope(),
            Some("api".into())
        );
        assert_eq!(row(Scope::Legacy(vec![])).value_scope(), None);
        assert_eq!(
            row(Scope::Canonical("api".into())).value_scope(),
            Some("api".into())
        );
        assert_eq!(row(Scope::Canonical("global".into())).value_scope(), None);
        assert_eq!(row(Scope::Canonical("project".into())).value_scope(), None);
    }

    #[test]
    fn a_local_layer_is_told_from_the_shared_one() {
        let row = |layer: Option<&str>| EnvRow {
            key: "K".into(),
            required: false,
            storage: Storage {
                kind: "plaintext".into(),
            },
            resolved_from: None,
            has_value: true,
            scope: Scope::Canonical("global".into()),
            layer: layer.map(Into::into),
            missing: false,
        };
        assert!(row(Some("/work/p/.hack/hack.env.local.yaml")).is_local_layer());
        assert!(row(Some(".hack/hack.env.staging.local.yaml")).is_local_layer());
        assert!(!row(Some(".hack/hack.env.default.yaml")).is_local_layer());
        assert!(!row(Some(".hack/hack.env.staging.yaml")).is_local_layer());
        // Legacy dotenv files and the legacy `local` layer are local too.
        assert!(row(Some("/work/p/.hack/.env")).is_local_layer());
        assert!(row(Some(".hack/.env.staging")).is_local_layer());
        assert!(row(Some("local")).is_local_layer());
        assert!(!row(Some(".hack/hack.env.json")).is_local_layer());
        assert!(!row(None).is_local_layer());
    }

    #[test]
    fn a_value_held_outside_the_env_files_is_never_written() {
        // A legacy project mirroring plaintext into its encrypted backend
        // lists those values as `portable_backend`. Saving one without
        // `--local` would copy it into the shared, committed YAML; with it,
        // into a new local file. Neither keeps it where it is, so the app
        // refuses and points at the CLI.
        let row = |layer: Option<&str>| EnvRow {
            key: "K".into(),
            required: false,
            storage: Storage {
                kind: "plaintext".into(),
            },
            resolved_from: layer.map(Into::into),
            has_value: true,
            scope: Scope::Legacy(vec![]),
            layer: layer.map(Into::into),
            missing: false,
        };
        for layer in ["portable_backend", "keychain", "process", "unknown"] {
            let r = row(Some(layer));
            let why = r.write_blocked().expect(layer);
            assert!(why.contains(layer) && why.contains("CLI"), "{why}");
            assert!(!r.is_local_layer());
        }
        assert_eq!(row(Some(".hack/hack.env.yaml")).write_layer(), Ok(false));
        assert_eq!(row(Some(".hack/.env")).write_layer(), Ok(true));
        // No layer: a missing name writes to the shared file; a stored
        // value of unknown origin is refused.
        let mut absent = row(None);
        absent.has_value = false;
        absent.missing = true;
        assert_eq!(absent.write_blocked(), None);
        let why = row(None).write_blocked().expect("stored, no layer");
        assert!(why.contains("CLI"), "{why}");
    }

    #[test]
    fn a_legacy_row_for_several_services_has_no_single_write_scope() {
        let row = |scope: Scope| EnvRow {
            key: "K".into(),
            required: false,
            storage: Storage {
                kind: "plaintext".into(),
            },
            resolved_from: None,
            has_value: true,
            scope,
            layer: None,
            missing: false,
        };
        assert_eq!(row(Scope::Legacy(vec![])).write_scope().unwrap(), "global");
        assert_eq!(
            row(Scope::Legacy(vec!["api".into()]))
                .write_scope()
                .unwrap(),
            "api"
        );
        assert_eq!(
            row(Scope::Canonical("web".into())).write_scope().unwrap(),
            "web"
        );
        let refused = row(Scope::Legacy(vec!["api".into(), "web".into()]))
            .write_scope()
            .unwrap_err();
        assert!(refused.contains("api, web") && refused.contains("hack env migrate"));
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
