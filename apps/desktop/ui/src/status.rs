//! Display status: the six visual states and their short labels.
//!
//! Maps the core's [`ProjectState`] and [`ServiceView`] to what the window
//! shows. Labels are short and lowercase, like the approved mockup
//! ("running · 3d 4h"); the full reason stays in the reason line or tooltip.

use hack_desktop_core::state::{ProjectState, ServiceView};

use crate::tokens::{Palette, StateColors};

/// The visual states. Each has one dot colour and one pill style.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Running,
    /// Starting or stopping: an action is in flight.
    Busy,
    Degraded,
    Failed,
    Stopped,
    /// Not observed. Drawn as a ring, never as a solid "stopped" dot.
    Unknown,
}

impl Status {
    #[must_use]
    pub fn of(state: &ProjectState) -> Self {
        match state {
            ProjectState::Running { .. } => Self::Running,
            ProjectState::Starting | ProjectState::Stopping => Self::Busy,
            ProjectState::Degraded { .. } => Self::Degraded,
            ProjectState::FailedStart { .. } | ProjectState::NeedsAttention { .. } => Self::Failed,
            ProjectState::Stopped => Self::Stopped,
            ProjectState::Unknown { .. } => Self::Unknown,
        }
    }

    #[must_use]
    pub fn of_service(s: &ServiceView) -> Self {
        Self::service(s).0
    }

    /// Visual status and short label for a service, from one decision so
    /// the dot and the text never disagree. Order matters: an unobserved
    /// service is Unknown whatever was last known about it; unhealthy
    /// running is Degraded; restarting or dead is Failed; a container in any
    /// state the app does not recognise (paused, created, removing) is
    /// Unknown, never Stopped.
    fn service(s: &ServiceView) -> (Self, String) {
        let lower = s.status.to_ascii_lowercase();
        if lower.contains("status unknown") || lower == "unknown" {
            return (Self::Unknown, "unknown".into());
        }
        if s.running {
            if lower.contains("unhealthy") {
                return (Self::Degraded, "unhealthy".into());
            }
            return (Self::Running, "running".into());
        }
        if s.intentionally_stopped {
            return (Self::Stopped, "stopped".into());
        }
        if lower.starts_with("restarting") {
            return (Self::Failed, "restarting".into());
        }
        if lower.starts_with("dead") {
            return (Self::Failed, "dead".into());
        }
        if let Some(code) = s.exit_code {
            let status = if code == 0 {
                Self::Stopped
            } else {
                Self::Failed
            };
            return (status, format!("exited {code}"));
        }
        if !s.created {
            return (Self::Stopped, "not created".into());
        }
        if lower.contains("paused") {
            return (Self::Unknown, "paused".into());
        }
        (Self::Unknown, "unknown".into())
    }

    #[must_use]
    pub fn colors(self, p: &Palette) -> StateColors {
        match self {
            Self::Running => p.states.running,
            Self::Busy => p.states.busy,
            Self::Degraded => p.states.degraded,
            Self::Failed => p.states.failed,
            Self::Stopped => p.states.stopped,
            Self::Unknown => p.states.unknown,
        }
    }
}

/// Short pill label for a project: "running · 2h", "degraded · worker",
/// "failed · api, worker", "needs attention".
#[must_use]
pub fn project_label(state: &ProjectState) -> String {
    match state {
        ProjectState::Running {
            uptime: Some(u), ..
        } => format!("running · {}", short_duration(u)),
        ProjectState::Running { uptime: None, .. } => "running".into(),
        ProjectState::Starting => "starting…".into(),
        ProjectState::Stopping => "stopping…".into(),
        ProjectState::Degraded { down } => format!("degraded · {} down", list(down)),
        ProjectState::FailedStart { services } => format!("failed · {}", list(services)),
        ProjectState::NeedsAttention { .. } => "needs attention".into(),
        ProjectState::Stopped => "stopped".into(),
        ProjectState::Unknown { .. } => "unknown".into(),
    }
}

/// Short state cell for a service row: "running", "unhealthy", "exited 1",
/// "not created", "paused", "unknown".
#[must_use]
pub fn service_label(s: &ServiceView) -> String {
    Status::service(s).1
}

fn list(names: &[String]) -> String {
    match names {
        [] => String::new(),
        [one] => one.clone(),
        [a, b] => format!("{a}, {b}"),
        [a, rest @ ..] => format!("{a} +{}", rest.len()),
    }
}

/// "2 hours" -> "2h", "3 days" -> "3d", "About a minute" -> "1m".
/// Anything unrecognised is returned unchanged.
#[must_use]
pub fn short_duration(text: &str) -> String {
    let lower = text.trim().to_ascii_lowercase();
    let mut words = lower.split_whitespace();
    let (Some(first), Some(unit)) = (words.next(), words.next()) else {
        return text.to_owned();
    };
    let n = match first {
        "a" | "an" | "about" => "1".to_owned(),
        n if n.chars().all(|c| c.is_ascii_digit()) => n.to_owned(),
        _ => return text.to_owned(),
    };
    let unit = if first == "about" {
        words.next().unwrap_or(unit)
    } else {
        unit
    };
    let suffix = match unit.trim_end_matches('s') {
        "second" => "s",
        "minute" => "m",
        "hour" => "h",
        "day" => "d",
        "week" => "w",
        "month" => "mo",
        "year" => "y",
        _ => return text.to_owned(),
    };
    format!("{n}{suffix}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn durations_shorten() {
        assert_eq!(short_duration("2 hours"), "2h");
        assert_eq!(short_duration("3 days"), "3d");
        assert_eq!(short_duration("About a minute"), "1m");
        assert_eq!(short_duration("an hour"), "1h");
        assert_eq!(short_duration("forever"), "forever");
    }

    #[test]
    fn project_labels_are_short() {
        let s = ProjectState::FailedStart {
            services: vec!["api".into(), "worker".into(), "db".into()],
        };
        assert_eq!(project_label(&s), "failed · api +2");
        let r = ProjectState::Running {
            uptime: Some("2 hours".into()),
            exited_ok: vec![],
        };
        assert_eq!(project_label(&r), "running · 2h");
    }

    fn svc(running: bool, status: &str, exit: Option<i32>, created: bool) -> ServiceView {
        ServiceView {
            name: "api".into(),
            running,
            status: status.into(),
            exit_code: exit,
            completed: !running && exit == Some(0),
            created,
            route: None,
            compose_container: created,
            intentionally_stopped: false,
        }
    }

    #[test]
    fn unobserved_service_is_unknown_even_if_never_created() {
        let s = svc(false, "Status unknown", None, false);
        assert_eq!(Status::of_service(&s), Status::Unknown);
        assert_eq!(service_label(&s), "unknown");
    }

    #[test]
    fn unhealthy_running_service_is_degraded() {
        let s = svc(true, "Up 2 minutes (unhealthy)", None, true);
        assert_eq!(Status::of_service(&s), Status::Degraded);
        assert_eq!(service_label(&s), "unhealthy");
    }

    #[test]
    fn paused_or_unrecognised_container_is_not_stopped() {
        let paused = svc(false, "Up 2 minutes (Paused)", None, true);
        assert_eq!(Status::of_service(&paused), Status::Unknown);
        assert_eq!(service_label(&paused), "paused");
        let created = svc(false, "Created", None, true);
        assert_eq!(Status::of_service(&created), Status::Unknown);
    }

    #[test]
    fn restarting_and_failed_exits_are_failed() {
        let r = svc(false, "Restarting (1) 5 seconds ago", Some(1), true);
        assert_eq!(service_label(&r), "restarting");
        assert_eq!(Status::of_service(&r), Status::Failed);
        let e = svc(false, "Exited (2) 20 seconds ago", Some(2), true);
        assert_eq!(
            (Status::of_service(&e), service_label(&e).as_str()),
            (Status::Failed, "exited 2")
        );
        let ok = svc(false, "Exited (0) 20 seconds ago", Some(0), true);
        assert_eq!(Status::of_service(&ok), Status::Stopped);
    }

    #[test]
    fn unknown_is_not_stopped() {
        let u = ProjectState::Unknown { reason: "x".into() };
        assert_eq!(Status::of(&u), Status::Unknown);
        assert_ne!(Status::of(&u), Status::of(&ProjectState::Stopped));
    }
}
