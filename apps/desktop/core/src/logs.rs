//! Logs tab model (DESIGN.md, "Logs tab"). Pure: no I/O, no clock.
//!
//! Contract:
//! - The buffer is a ring bounded by lines **and** bytes; the oldest lines go
//!   first and are counted in `dropped`.
//! - Pause never stops reading: lines keep arriving and are counted as unseen.
//! - Search filters what is shown, never what is kept.
//! - One service filter at a time, passed to the CLI as the positional
//!   `hack logs <service>` (`--services` is Loki-only and native rejects it).
//! - An `end` event while following is "Follow ended" (normal), not an error;
//!   an `error` event, an unsuccessful end reason or a non-zero exit is a
//!   failure. A stream the app closes itself leaves no banner.
//! - Nothing here is written to disk.

use std::collections::VecDeque;

use crate::models::LogEvent;

pub const MAX_LINES: usize = 10_000;
pub const MAX_BYTES: usize = 8 * 1024 * 1024;
/// Lines longer than this are cut on screen until expanded.
pub const DISPLAY_CUT: usize = 4 * 1024;
/// Longest message kept per line; the rest is dropped on intake and
/// counted in `LogLine::cut`, so one line can never exceed the byte bound.
pub const MAX_LINE_BYTES: usize = 64 * 1024;
pub const FOLLOW_TAIL: u32 = 500;
pub const STOPPED_TAIL: u32 = 200;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogLine {
    pub seq: u64,
    pub service: Option<String>,
    pub message: String,
    pub stderr: bool,
    pub error_level: bool,
    pub timestamp: Option<String>,
    /// The CLI cut this line (`entry.truncated`).
    pub truncated_by_hack: bool,
    /// Bytes the app dropped from this line on intake (over `MAX_LINE_BYTES`).
    pub cut: usize,
}

impl LogLine {
    /// Bytes this line holds in the buffer (message, service, timestamp).
    #[must_use]
    pub fn retained_bytes(&self) -> usize {
        self.message.len()
            + self.service.as_ref().map_or(0, String::len)
            + self.timestamp.as_ref().map_or(0, String::len)
    }
}

impl LogLine {
    /// The text to draw, and how many bytes were hidden, when not expanded.
    #[must_use]
    pub fn display(&self, expanded: bool) -> (&str, usize) {
        if expanded || self.message.len() <= DISPLAY_CUT {
            return (&self.message, 0);
        }
        let mut cut = DISPLAY_CUT;
        while !self.message.is_char_boundary(cut) {
            cut -= 1;
        }
        (&self.message[..cut], self.message.len() - cut)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StreamState {
    /// No stream (tab not open, or the app closed it).
    Idle,
    Connecting,
    Following,
    /// A `--no-follow` read reached its end.
    Finished,
    /// A followed stream ended normally (`end` eof/closed, exit 0).
    FollowEnded,
    Failed {
        reason: String,
    },
    /// Not available for this project in this version.
    Unavailable {
        reason: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogsModel {
    lines: VecDeque<LogLine>,
    bytes: usize,
    next_seq: u64,
    pub dropped: u64,
    pub state: StreamState,
    /// Following (`true`) or a finite `--no-follow` read.
    pub follow: bool,
    pub paused: bool,
    pub unseen: usize,
    pub search: String,
    pub service: Option<String>,
    /// Lines the user expanded past `DISPLAY_CUT`.
    pub expanded: Vec<u64>,
    max_lines: usize,
    max_bytes: usize,
}

impl Default for LogsModel {
    fn default() -> Self {
        Self::with_limits(MAX_LINES, MAX_BYTES)
    }
}

impl LogsModel {
    #[must_use]
    pub fn with_limits(max_lines: usize, max_bytes: usize) -> Self {
        Self {
            lines: VecDeque::new(),
            bytes: 0,
            next_seq: 0,
            dropped: 0,
            state: StreamState::Idle,
            follow: true,
            paused: false,
            unseen: 0,
            search: String::new(),
            service: None,
            expanded: Vec::new(),
            max_lines,
            max_bytes,
        }
    }

    /// CLI arguments (after `hack`, before `--path`) for the current filter.
    /// A stopped project gets a finite read of the last lines.
    #[must_use]
    pub fn cli_args(&self, project_running: bool) -> Vec<String> {
        let mut a = vec!["logs".to_owned(), "--json".to_owned()];
        if project_running {
            a.extend(["--tail".to_owned(), FOLLOW_TAIL.to_string()]);
        } else {
            a.extend([
                "--no-follow".to_owned(),
                "--tail".to_owned(),
                STOPPED_TAIL.to_string(),
            ]);
        }
        if let Some(s) = &self.service {
            a.push(s.clone());
        }
        a
    }

    /// A new stream starts: clear the buffer and wait for events.
    pub fn start(&mut self, follow: bool) {
        self.lines.clear();
        self.bytes = 0;
        self.dropped = 0;
        self.unseen = 0;
        self.expanded.clear();
        self.follow = follow;
        self.state = StreamState::Connecting;
    }

    /// The app closed the stream (tab or project change): no banner.
    pub fn close(&mut self) {
        self.state = StreamState::Idle;
    }

    pub fn unavailable(&mut self, reason: &str) {
        self.lines.clear();
        self.bytes = 0;
        self.state = StreamState::Unavailable {
            reason: reason.to_owned(),
        };
    }

    /// Choose a service (or all). Returns `true` when the stream must restart.
    pub fn set_service(&mut self, service: Option<String>) -> bool {
        if self.service == service {
            return false;
        }
        self.service = service;
        true
    }

    pub fn set_paused(&mut self, paused: bool) {
        self.paused = paused;
        if !paused {
            self.unseen = 0;
        }
    }

    pub fn toggle_expanded(&mut self, seq: u64) {
        if let Some(i) = self.expanded.iter().position(|s| *s == seq) {
            self.expanded.remove(i);
        } else {
            self.expanded.push(seq);
        }
    }

    #[must_use]
    pub fn is_expanded(&self, seq: u64) -> bool {
        self.expanded.contains(&seq)
    }

    /// Apply one ndjson event from `hack logs --json`.
    pub fn apply(&mut self, e: &LogEvent) {
        match e.kind.as_str() {
            "start" => {
                if self.state == StreamState::Connecting {
                    self.state = if self.follow {
                        StreamState::Following
                    } else {
                        StreamState::Connecting
                    };
                }
            }
            "log" => {
                if let Some(entry) = &e.entry {
                    if self.state == StreamState::Connecting && self.follow {
                        self.state = StreamState::Following;
                    }
                    self.push(LogLine {
                        seq: 0,
                        service: entry.service.clone(),
                        message: entry.message.clone(),
                        stderr: entry.stream.as_deref() == Some("stderr"),
                        error_level: entry.level.as_deref() == Some("error"),
                        timestamp: entry.timestamp.clone(),
                        truncated_by_hack: entry.truncated == Some(true),
                        cut: 0,
                    });
                }
            }
            "error" => {
                self.state = StreamState::Failed {
                    reason: e
                        .message
                        .clone()
                        .unwrap_or_else(|| "log stream failed".into()),
                };
            }
            "end" => {
                let reason = e.reason.as_deref().unwrap_or("");
                let failed =
                    reason == "error" || (reason.starts_with("exit:") && reason != "exit:0");
                if failed {
                    // Keep a specific reason from an earlier `error` event.
                    if !matches!(self.state, StreamState::Failed { .. }) {
                        self.state = StreamState::Failed {
                            reason: format!("log stream ended with {reason}"),
                        };
                    }
                } else if !matches!(self.state, StreamState::Failed { .. }) {
                    self.state = if self.follow {
                        StreamState::FollowEnded
                    } else {
                        StreamState::Finished
                    };
                }
            }
            // `notice` (and unparsable lines the runner wraps as notices)
            // and `heartbeat` carry no log line.
            _ => {}
        }
    }

    /// The CLI process exited. A non-zero exit is a failure even after an
    /// `end`; exit 0 without an `end` is a normal end.
    pub fn exited(&mut self, code: Option<i32>) {
        match code {
            Some(0) => {
                if matches!(self.state, StreamState::Connecting | StreamState::Following) {
                    self.state = if self.follow {
                        StreamState::FollowEnded
                    } else {
                        StreamState::Finished
                    };
                }
            }
            other => {
                if !matches!(self.state, StreamState::Failed { .. } | StreamState::Idle) {
                    self.state = StreamState::Failed {
                        reason: format!("hack logs exited with {other:?}"),
                    };
                }
            }
        }
    }

    fn push(&mut self, mut line: LogLine) {
        line.seq = self.next_seq;
        self.next_seq += 1;
        if line.message.len() > MAX_LINE_BYTES {
            let mut keep = MAX_LINE_BYTES;
            while !line.message.is_char_boundary(keep) {
                keep -= 1;
            }
            line.cut = line.message.len() - keep;
            // A new string: `truncate` would keep the large allocation.
            line.message = line.message[..keep].to_owned();
        }
        self.bytes += line.retained_bytes();
        self.lines.push_back(line);
        if self.paused {
            self.unseen += 1;
        }
        // Strict: lines are capped on intake, so this always terminates
        // with the buffer within both bounds.
        while self.lines.len() > self.max_lines || self.bytes > self.max_bytes {
            if let Some(old) = self.lines.pop_front() {
                self.bytes -= old.retained_bytes();
                self.dropped += 1;
                self.expanded.retain(|s| *s != old.seq);
            }
        }
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.lines.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.lines.is_empty()
    }

    #[must_use]
    pub fn bytes(&self) -> usize {
        self.bytes
    }

    /// Buffer indices of the lines to show (see [`Self::visible`]).
    #[must_use]
    pub fn visible_indices(&self) -> Vec<usize> {
        let q = self.search.trim().to_lowercase();
        (0..self.lines.len())
            .filter(|&i| {
                q.is_empty() || {
                    let l = &self.lines[i];
                    l.message.to_lowercase().contains(&q)
                        || l.service
                            .as_deref()
                            .is_some_and(|s| s.to_lowercase().contains(&q))
                }
            })
            .collect()
    }

    /// Position in `visible` (buffer indices) of the line with sequence
    /// `seq`, or of the next surviving line if it was evicted. Used to keep
    /// a paused viewport on the lines being read while old lines drop off.
    #[must_use]
    pub fn position_of_seq(&self, visible: &[usize], seq: u64) -> usize {
        visible.partition_point(|&i| self.lines.get(i).is_some_and(|l| l.seq < seq))
    }

    #[must_use]
    pub fn line(&self, index: usize) -> Option<&LogLine> {
        self.lines.get(index)
    }

    /// The expanded lines still in the buffer, oldest first.
    #[must_use]
    pub fn expanded_lines(&self) -> Vec<&LogLine> {
        self.lines
            .iter()
            .filter(|l| self.expanded.contains(&l.seq))
            .collect()
    }

    /// Lines to show: all, or those matching the search (case-insensitive).
    #[must_use]
    pub fn visible(&self) -> Vec<&LogLine> {
        let q = self.search.trim().to_lowercase();
        if q.is_empty() {
            return self.lines.iter().collect();
        }
        self.lines
            .iter()
            .filter(|l| {
                l.message.to_lowercase().contains(&q)
                    || l.service
                        .as_deref()
                        .is_some_and(|s| s.to_lowercase().contains(&q))
            })
            .collect()
    }

    /// The banner for the current state, if any.
    #[must_use]
    pub fn banner(&self) -> Option<String> {
        match &self.state {
            StreamState::Idle | StreamState::Following => None,
            StreamState::Connecting => Some("Connecting…".into()),
            StreamState::Finished => Some("End of log".into()),
            StreamState::FollowEnded => Some("Log stream ended".into()),
            StreamState::Failed { reason } => Some(format!("Log stream failed: {reason}")),
            StreamState::Unavailable { reason } => Some(reason.clone()),
        }
    }

    /// A finite read was opened while the project was stopped; once it runs,
    /// the tab should switch to following.
    #[must_use]
    pub fn should_follow_now(&self, project_running: bool) -> bool {
        project_running
            && !self.follow
            && !matches!(
                self.state,
                StreamState::Unavailable { .. } | StreamState::Idle
            )
    }

    /// Offer Reconnect after the stream ended or failed.
    #[must_use]
    pub fn can_reconnect(&self) -> bool {
        matches!(
            self.state,
            StreamState::FollowEnded | StreamState::Failed { .. }
        )
    }
}

/// Canned log streams for the Logs tab fixtures.
pub mod fixtures {
    use super::{LogsModel, StreamState};
    use crate::models::{LogEntry, LogEvent};

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum LogsFixture {
        Following,
        PausedSearch,
        LongLines,
        ServiceFilter,
        FollowEnded,
        Failed,
        Native,
        Stopped,
    }

    impl LogsFixture {
        pub const ALL: [Self; 8] = [
            Self::Following,
            Self::PausedSearch,
            Self::LongLines,
            Self::ServiceFilter,
            Self::FollowEnded,
            Self::Failed,
            Self::Native,
            Self::Stopped,
        ];

        #[must_use]
        pub fn name(self) -> &'static str {
            match self {
                Self::Following => "logs-following",
                Self::PausedSearch => "logs-paused-search",
                Self::LongLines => "logs-long-lines",
                Self::ServiceFilter => "logs-service-filter",
                Self::FollowEnded => "logs-follow-ended",
                Self::Failed => "logs-failed",
                Self::Native => "logs-native",
                Self::Stopped => "logs-stopped",
            }
        }

        #[must_use]
        pub fn parse(name: &str) -> Option<Self> {
            Self::ALL.into_iter().find(|f| f.name() == name)
        }
    }

    fn log(service: &str, level: &str, message: &str) -> LogEvent {
        LogEvent {
            kind: "log".into(),
            entry: Some(LogEntry {
                service: Some(service.into()),
                message: message.into(),
                stream: Some(if level == "error" { "stderr" } else { "stdout" }.into()),
                timestamp: None,
                level: Some(level.into()),
                truncated: None,
            }),
            ..LogEvent::default()
        }
    }

    fn ev(kind: &str, reason: Option<&str>, message: Option<&str>) -> LogEvent {
        LogEvent {
            kind: kind.into(),
            reason: reason.map(str::to_owned),
            message: message.map(str::to_owned),
            ..LogEvent::default()
        }
    }

    /// The canned "following" stream, as events.
    #[must_use]
    pub fn events() -> Vec<LogEvent> {
        traffic()
    }

    fn traffic() -> Vec<LogEvent> {
        let mut v = vec![ev("start", None, None)];
        for i in 0..40 {
            v.push(match i % 5 {
                0 => log("api", "info", &format!("GET /health 200 {}ms", 1 + i % 4)),
                1 => log("web", "info", &format!("GET /products?page={i} 200 12ms")),
                2 => log(
                    "worker",
                    "info",
                    &format!("processed job {} in 41ms", 1000 + i),
                ),
                3 => log("db", "info", "checkpoint complete: wrote 12 buffers"),
                _ => log("api", "warn", "slow query: 312ms on orders.list"),
            });
        }
        v.push(log(
            "worker",
            "error",
            "retrying job 1039: connection reset by peer",
        ));
        v
    }

    /// A model in the state the fixture shows.
    #[must_use]
    pub fn model(f: LogsFixture) -> LogsModel {
        let mut m = LogsModel::default();
        match f {
            LogsFixture::Native => {
                m.unavailable(crate::source::NATIVE_LOGS_NOTE);
                return m;
            }
            LogsFixture::Stopped => {
                m.start(false);
                for e in traffic().iter().take(12) {
                    m.apply(e);
                }
                m.apply(&ev("end", Some("eof"), None));
                m.exited(Some(0));
                return m;
            }
            _ => m.start(true),
        }
        if f == LogsFixture::ServiceFilter {
            m.set_service(Some("worker".into()));
            for e in traffic().iter().filter(|e| {
                e.entry
                    .as_ref()
                    .is_none_or(|x| x.service.as_deref() == Some("worker"))
            }) {
                m.apply(e);
            }
            return m;
        }
        for e in traffic() {
            m.apply(&e);
        }
        match f {
            LogsFixture::PausedSearch => {
                m.set_paused(true);
                for e in traffic().iter().skip(1).take(7) {
                    m.apply(e);
                }
                m.search = "health".into();
            }
            LogsFixture::LongLines => {
                let long = format!(
                    "payload dump: {}",
                    "{\"id\":42,\"items\":[1,2,3],\"note\":\"lorem ipsum dolor sit amet\"} "
                        .repeat(120)
                );
                m.apply(&log("api", "info", &long));
                let mut cut = log("web", "info", "response body (truncated by hack) …");
                if let Some(entry) = cut.entry.as_mut() {
                    entry.truncated = Some(true);
                }
                m.apply(&cut);
            }
            LogsFixture::FollowEnded => {
                m.apply(&ev("end", Some("eof"), None));
                m.exited(Some(0));
            }
            LogsFixture::Failed => {
                m.apply(&ev(
                    "error",
                    None,
                    Some("Cannot connect to the Docker daemon"),
                ));
                m.exited(Some(1));
            }
            _ => {}
        }
        debug_assert!(!matches!(m.state, StreamState::Idle));
        m
    }
}

#[cfg(test)]
mod tests {
    use super::fixtures::{LogsFixture, model};
    use super::*;
    use crate::models::LogEntry;

    fn line(msg: &str) -> LogEvent {
        LogEvent {
            kind: "log".into(),
            entry: Some(LogEntry {
                service: Some("api".into()),
                message: msg.into(),
                ..LogEntry::default()
            }),
            ..LogEvent::default()
        }
    }

    fn ev(kind: &str, reason: Option<&str>) -> LogEvent {
        LogEvent {
            kind: kind.into(),
            reason: reason.map(str::to_owned),
            ..LogEvent::default()
        }
    }

    #[test]
    fn ring_buffer_bounds_lines_and_bytes() {
        let mut m = LogsModel::with_limits(3, 1_000);
        m.start(true);
        for i in 0..5 {
            m.apply(&line(&format!("l{i}")));
        }
        assert_eq!(m.len(), 3);
        assert_eq!(m.dropped, 2);
        assert_eq!(m.visible()[0].message, "l2");

        // "api" (3) + 6 = 9 bytes per line; the bound is strict.
        let mut b = LogsModel::with_limits(100, 10);
        b.start(true);
        b.apply(&line("aaaaaa"));
        b.apply(&line("bbbbbb"));
        assert_eq!(b.len(), 1, "byte bound drops the oldest");
        assert!(b.bytes() <= 10);
        b.apply(&line(&"z".repeat(20)));
        assert!(b.bytes() <= 10, "a line over the bound is not kept");
    }

    #[test]
    fn huge_lines_are_capped_on_intake() {
        let mut m = LogsModel::default();
        m.start(true);
        m.apply(&line(&"y".repeat(MAX_LINE_BYTES + 5000)));
        let l = m.visible()[0];
        assert_eq!(l.message.len(), MAX_LINE_BYTES);
        assert!(
            l.message.capacity() < MAX_LINE_BYTES + 1024,
            "no oversized allocation kept"
        );
        assert_eq!(l.cut, 5000);
        assert_eq!(m.bytes(), MAX_LINE_BYTES + "api".len());
    }

    #[test]
    fn loki_error_then_end_error_keeps_the_specific_reason() {
        let mut m = LogsModel::default();
        m.start(true);
        m.apply(&LogEvent {
            kind: "error".into(),
            message: Some("Loki query failed: 502".into()),
            ..LogEvent::default()
        });
        m.apply(&ev("end", Some("error")));
        m.exited(Some(1));
        assert_eq!(
            m.state,
            StreamState::Failed {
                reason: "Loki query failed: 502".into()
            }
        );
    }

    #[test]
    fn paused_anchor_survives_eviction() {
        let mut m = LogsModel::with_limits(5, 1_000_000);
        m.start(true);
        for i in 0..5 {
            m.apply(&line(&format!("l{i}")));
        }
        // Reading line seq 3 (index 3) while paused.
        let anchor = m.line(3).unwrap().seq;
        m.set_paused(true);
        m.apply(&line("l5"));
        m.apply(&line("l6")); // evicts seq 0 and 1
        let v = m.visible_indices();
        let pos = m.position_of_seq(&v, anchor);
        assert_eq!(
            m.line(v[pos]).unwrap().message,
            "l3",
            "same line, new index"
        );
        assert_eq!(pos, 1);
        // An evicted anchor lands on the next surviving line.
        assert_eq!(m.line(v[m.position_of_seq(&v, 0)]).unwrap().message, "l2");
    }

    #[test]
    fn pause_keeps_reading_and_counts_unseen() {
        let mut m = LogsModel::default();
        m.start(true);
        m.set_paused(true);
        m.apply(&line("a"));
        m.apply(&line("b"));
        assert_eq!((m.len(), m.unseen), (2, 2));
        m.set_paused(false);
        assert_eq!(m.unseen, 0);
    }

    #[test]
    fn search_filters_view_not_buffer() {
        let mut m = LogsModel::default();
        m.start(true);
        m.apply(&line("GET /health"));
        m.apply(&line("POST /orders"));
        m.search = "HEALTH".into();
        assert_eq!(m.visible().len(), 1);
        assert_eq!(m.visible_indices(), vec![0]);
        assert_eq!(m.line(0).unwrap().message, "GET /health");
        assert_eq!(m.len(), 2);
        m.search = "api".into();
        assert_eq!(m.visible().len(), 2, "service name matches too");
    }

    #[test]
    fn service_filter_is_positional_and_restarts_once() {
        let mut m = LogsModel::default();
        assert_eq!(m.cli_args(true), ["logs", "--json", "--tail", "500"]);
        assert!(m.set_service(Some("api".into())));
        assert!(!m.set_service(Some("api".into())));
        assert_eq!(m.cli_args(true).last().map(String::as_str), Some("api"));
        assert!(
            !m.cli_args(true)
                .iter()
                .any(|a| a == "--services" || a == "--compose")
        );
        assert_eq!(
            m.cli_args(false),
            ["logs", "--json", "--no-follow", "--tail", "200", "api"]
        );
    }

    #[test]
    fn long_lines_are_cut_on_a_char_boundary_until_expanded() {
        let msg = "é".repeat(DISPLAY_CUT); // 2 bytes each
        let l = LogLine {
            seq: 7,
            service: None,
            message: msg.clone(),
            stderr: false,
            error_level: false,
            timestamp: None,
            truncated_by_hack: false,
            cut: 0,
        };
        let (shown, hidden) = l.display(false);
        assert!(shown.len() <= DISPLAY_CUT);
        assert_eq!(shown.len() + hidden, msg.len());
        assert_eq!(l.display(true), (msg.as_str(), 0));
        let mut m = LogsModel::default();
        m.toggle_expanded(7);
        assert!(m.is_expanded(7));
        m.toggle_expanded(7);
        assert!(!m.is_expanded(7));
    }

    #[test]
    fn end_states_are_distinguished() {
        let mut follow_end = LogsModel::default();
        follow_end.start(true);
        follow_end.apply(&ev("start", None));
        assert_eq!(follow_end.state, StreamState::Following);
        follow_end.apply(&ev("end", Some("closed")));
        follow_end.exited(Some(0));
        assert_eq!(follow_end.state, StreamState::FollowEnded);
        assert!(follow_end.can_reconnect());

        let mut finished = LogsModel::default();
        finished.start(false);
        finished.apply(&line("x"));
        finished.apply(&ev("end", Some("eof")));
        finished.exited(Some(0));
        assert_eq!(finished.state, StreamState::Finished);
        assert!(!finished.can_reconnect());

        let mut bad_end = LogsModel::default();
        bad_end.start(true);
        bad_end.apply(&line("x"));
        bad_end.apply(&ev("end", Some("exit:1")));
        assert!(matches!(bad_end.state, StreamState::Failed { .. }));

        let mut nonzero = LogsModel::default();
        nonzero.start(true);
        nonzero.apply(&ev("end", Some("eof")));
        nonzero.exited(Some(1));
        assert!(
            matches!(nonzero.state, StreamState::Failed { .. }),
            "exit≠0 wins over end"
        );

        let mut closed = LogsModel::default();
        closed.start(true);
        closed.close();
        closed.exited(None);
        assert_eq!(
            closed.state,
            StreamState::Idle,
            "app-closed stream shows nothing"
        );
        assert_eq!(closed.banner(), None);
    }

    #[test]
    fn a_stopped_read_switches_to_follow_when_the_project_starts() {
        let mut m = LogsModel::default();
        m.start(false);
        m.apply(&ev("end", Some("eof")));
        m.exited(Some(0));
        assert!(!m.should_follow_now(false), "still stopped");
        assert!(m.should_follow_now(true), "started: follow");
        m.start(true);
        assert!(!m.should_follow_now(true), "already following");
        let mut n = LogsModel::default();
        n.unavailable("native");
        assert!(!n.should_follow_now(true), "native stays unavailable");
    }

    #[test]
    fn every_logs_fixture_builds_its_state() {
        for f in LogsFixture::ALL {
            assert_eq!(LogsFixture::parse(f.name()), Some(f));
            let m = model(f);
            match f {
                LogsFixture::Following | LogsFixture::LongLines | LogsFixture::ServiceFilter => {
                    assert_eq!(m.state, StreamState::Following, "{f:?}");
                }
                LogsFixture::PausedSearch => {
                    assert!(m.paused && m.unseen > 0 && !m.search.is_empty())
                }
                LogsFixture::FollowEnded => assert_eq!(m.state, StreamState::FollowEnded),
                LogsFixture::Failed => assert!(matches!(m.state, StreamState::Failed { .. })),
                LogsFixture::Native => assert!(matches!(m.state, StreamState::Unavailable { .. })),
                LogsFixture::Stopped => assert_eq!(m.state, StreamState::Finished),
            }
        }
        assert!(
            model(LogsFixture::ServiceFilter)
                .visible()
                .iter()
                .all(|l| l.service.as_deref() == Some("worker"))
        );
    }
}
