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
        if s.running {
            Self::Running
        } else if s.exit_code.is_some_and(|c| c != 0) {
            Self::Failed
        } else if s.status.to_ascii_lowercase().contains("unknown") {
            Self::Unknown
        } else {
            Self::Stopped
        }
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

/// Short state cell for a service row: "running", "exited 1", "not created".
#[must_use]
pub fn service_label(s: &ServiceView) -> String {
    if s.running {
        return "running".into();
    }
    if let Some(code) = s.exit_code {
        return format!("exited {code}");
    }
    if !s.created {
        return "not created".into();
    }
    let lower = s.status.to_ascii_lowercase();
    if lower.contains("unknown") {
        "unknown".into()
    } else {
        "stopped".into()
    }
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

    #[test]
    fn unknown_is_not_stopped() {
        let u = ProjectState::Unknown { reason: "x".into() };
        assert_eq!(Status::of(&u), Status::Unknown);
        assert_ne!(Status::of(&u), Status::of(&ProjectState::Stopped));
    }
}
