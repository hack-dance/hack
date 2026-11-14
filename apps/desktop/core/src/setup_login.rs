//! Login service evidence and admission; unavailable managers must never reach install.
use crate::setup::{Card, Remedy, Report, SafeAction, Status, boolean, card};

/// Installation is a supported effect only with both manager availability and
/// ownership of the ordinary home. Missing capability is never permission.
pub fn qualify_login(report: &mut Report, daemon: Option<&serde_json::Value>) {
    if let Some(card) = report.cards.iter_mut().find(|c| c.id == "login") {
        *card = login_card(daemon, report.context.as_ref());
    }
}
pub(crate) fn login_card(
    daemon: Option<&serde_json::Value>,
    context: Option<&crate::execution::ExecutionContext>,
) -> Card {
    let service = daemon
        .and_then(|d| d.get("service"))
        .filter(|s| s.is_object());
    let bool_field = |key: &str| {
        service
            .and_then(|s| s.get(key))
            .and_then(serde_json::Value::as_bool)
    };
    let next = service
        .and_then(|s| s.get("next_step"))
        .and_then(serde_json::Value::as_str);
    let mut state = boolean(
        bool_field("installed"),
        "Login service installed",
        "Always-on needs the login service",
    );
    if bool_field("installed") == Some(true)
        && (bool_field("enabled") == Some(false)
            || bool_field("active") == Some(false)
            || daemon
                .and_then(|s| s.pointer("/launchd/loaded"))
                .and_then(serde_json::Value::as_bool)
                == Some(false)
            || daemon
                .and_then(|s| s.pointer("/launchd/exit_status"))
                .and_then(serde_json::Value::as_i64)
                .is_some_and(|code| code != 0)
            || next.is_some()
            || service
                .and_then(|s| s.get("severity"))
                .and_then(serde_json::Value::as_str)
                == Some("warn"))
    {
        state = (
            Status::NeedsAttention,
            "Login service needs attention".into(),
        );
    }
    if let Some(summary) = service
        .and_then(|s| s.get("summary"))
        .and_then(serde_json::Value::as_str)
    {
        state.1 = summary.chars().take(2048).collect();
    }
    let refusal = installation_refusal(daemon, context);
    if state.0 == Status::Passed && refusal.is_some() {
        state.0 = Status::Unknown;
    }
    let fix_is_install =
        bool_field("installed") != Some(true) || next == Some("hack daemon install");
    let remedy = if refusal.is_none() && fix_is_install {
        Remedy::Run(SafeAction::InstallDaemon)
    } else {
        Remedy::Doc(
            "https://github.com/hack-dance/hack/blob/next/docs/architecture.md#daemon".into(),
        )
    };
    if let Some(why) = refusal {
        state.1 = format!("{}; {why}", state.1);
    }
    card("login", "Login service", state, remedy)
}
/// Recheck both explicit context and the CLI's effective socket home. A launcher
/// can choose a private home even when HACK_HOME was absent in the app.
pub fn installation_refusal(
    daemon: Option<&serde_json::Value>,
    context: Option<&crate::execution::ExecutionContext>,
) -> Option<String> {
    let Some(context) = context else {
        return Some("Execution context has not been checked".into());
    };
    if let Some(why) = context.install_refusal() {
        return Some(why.into());
    }
    let available = daemon
        .and_then(|d| d.get("service"))
        .and_then(|s| s.get("available"))
        .and_then(serde_json::Value::as_bool);
    if available != Some(true) {
        return Some("Login service manager is unavailable or could not be confirmed".into());
    }
    let expected = context
        .value("HOME")
        .map(|h| std::path::Path::new(h).join(".hack/daemon/hackd.sock"));
    match daemon
        .and_then(|d| d.get("socket_path"))
        .and_then(serde_json::Value::as_str)
    {
        Some(path) if Some(std::path::PathBuf::from(path)) != expected => {
            Some("The checked daemon uses a different or isolated Hack home".into())
        }
        None if context.value("HACK_HOME").is_none() => {
            Some("The login-service home could not be confirmed".into())
        }
        _ => None,
    }
}
