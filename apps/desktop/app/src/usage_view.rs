//! Resource use in the Services tab (DESIGN.md section 10): CPU and memory
//! per service, an `emulated` marker, and the instance total in the header.
//!
//! Read-only. Usage is read every [`EVERY`] only while the Services tab of
//! a running Compose instance is shown in a visible window, one read at a
//! time; the emulated flag is read again when the instance or its running
//! services change, and every [`EMULATED_EVERY`] (a recreated container can
//! change architecture under the same name). A result for an instance, a
//! checkout, a Compose project or a CLI no longer shown is dropped, and a
//! kept result is shown only while all of them still match.

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::time::{Duration, Instant};

use gpui_kit::Context;
use hack_desktop_core::usage::{self, ServiceUsage};
use hack_desktop_core::viewmodel::InstanceKey;

use crate::doctor_view::Pane;
use crate::view::HackApp;

/// How often usage is read while it is shown.
pub(crate) const EVERY: Duration = Duration::from_secs(5);
/// How often the emulated flag is read again when nothing else changed.
pub(crate) const EMULATED_EVERY: Duration = Duration::from_secs(60);

/// What the Services tab knows about one instance's resource use.
#[derive(Debug, Clone)]
pub(crate) struct UsageState {
    pub key: InstanceKey,
    /// The checkout and Compose project the values were read for.
    pub root: PathBuf,
    pub compose_project: String,
    pub rows: Result<BTreeMap<String, ServiceUsage>, String>,
    pub emulated: BTreeSet<String>,
    /// The running services the emulated flag was read for.
    pub emulated_for: Vec<String>,
    pub emulated_at: Instant,
    pub at: Instant,
}

impl UsageState {
    /// Read for this target's instance, checkout and Compose project.
    fn is_for(&self, t: &UsageTarget) -> bool {
        self.key == t.key && self.root == t.root && self.compose_project == t.compose_project
    }
}

/// The instance the Services tab shows, when usage applies to it.
pub(crate) struct UsageTarget {
    pub key: InstanceKey,
    pub root: PathBuf,
    pub branch: Option<String>,
    pub compose_project: String,
    pub running: Vec<String>,
}

/// Why CPU and memory show a dash for a row, by the reason.
pub(crate) const NATIVE_NOTE: &str = "Not reported for native projects yet (DESIGN.md R29)";
pub(crate) const NOT_RUNNING_NOTE: &str = "Not running";
pub(crate) const NO_VALUE_NOTE: &str = "Docker reported no value in the last sample";

impl HackApp {
    /// The shown instance, when its Services tab of a running Compose
    /// instance is on screen.
    pub(crate) fn usage_target(&self) -> Option<UsageTarget> {
        self.target(true)
    }

    /// `visible`: also require a visible window (live reads); fixtures
    /// render offscreen.
    fn target(&self, visible: bool) -> Option<UsageTarget> {
        if self.pane != Pane::Project
            || self.tab != 0
            || self.selected_service().is_some()
            || (visible && !self.window_visible)
        {
            return None;
        }
        let key = self.model.selected_key()?;
        let row = self.model.selected_row()?;
        if row.is_native() {
            return None;
        }
        let detail = self.model.detail()?;
        if !detail.state.is_active() {
            return None;
        }
        let running: Vec<String> = detail
            .services
            .iter()
            .filter(|s| s.running)
            .map(|s| s.name.clone())
            .collect();
        if running.is_empty() {
            return None;
        }
        Some(UsageTarget {
            branch: key.branch.clone(),
            key,
            root: PathBuf::from(row.repo_root.as_ref()?),
            compose_project: row.runtime.as_ref()?.project.clone()?,
            running,
        })
    }

    /// Start the one-second tick that reads usage when it is due.
    pub(crate) fn start_usage_polling(&mut self, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(Duration::from_secs(1)).await;
                if this
                    .update(cx, |this, cx| {
                        this.read_usage_if_due(cx);
                        this.read_stats_if_due(cx);
                    })
                    .is_err()
                {
                    return;
                }
            }
        })
        .detach();
    }

    fn read_usage_if_due(&mut self, cx: &mut Context<Self>) {
        if self.usage_loading {
            return;
        }
        let Some(target) = self.usage_target() else {
            return;
        };
        let fresh = self
            .usage
            .as_ref()
            .is_some_and(|u| u.is_for(&target) && u.at.elapsed() < EVERY);
        if fresh {
            return;
        }
        let need_emulated = self.usage.as_ref().is_none_or(|u| {
            !u.is_for(&target)
                || u.emulated_for != target.running
                || u.emulated_at.elapsed() >= EMULATED_EVERY
        });
        self.usage_loading = true;
        let source = self.source.pinned().unwrap_or_else(|| self.source.clone());
        let epoch = self.model.source_epoch();
        cx.spawn(async move |this, cx| {
            let root = target.root.clone();
            let branch = target.branch.clone();
            let (report, emulated) = cx
                .background_executor()
                .spawn(async move {
                    let report = source.service_usage(&root);
                    let emulated =
                        need_emulated.then(|| source.emulated_services(&root, branch.as_deref()));
                    (report, emulated)
                })
                .await;
            let _ = this.update(cx, |this, cx| {
                this.usage_loading = false;
                // Another CLI, instance, checkout or backend is shown now.
                let same = this.target(false).is_some_and(|now| {
                    now.key == target.key
                        && now.root == target.root
                        && now.compose_project == target.compose_project
                });
                if this.model.source_epoch() != epoch || !same {
                    return;
                }
                this.apply_usage(&target, report, emulated);
                cx.notify();
            });
        })
        .detach();
    }

    fn apply_usage(
        &mut self,
        target: &UsageTarget,
        report: Result<usage::UsageReport, String>,
        emulated: Option<Result<BTreeSet<String>, String>>,
    ) {
        let now = Instant::now();
        let previous = self.usage.take().filter(|u| u.is_for(target));
        let (emulated, emulated_for, emulated_at) = match emulated {
            Some(Ok(e)) => (e, target.running.clone(), now),
            // Not read this time, or the read failed: keep what was known
            // (and when it was read, so a failed re-read is retried).
            Some(Err(_)) | None => previous.as_ref().map_or_else(
                || (BTreeSet::new(), Vec::new(), now),
                |p| (p.emulated.clone(), p.emulated_for.clone(), p.emulated_at),
            ),
        };
        self.usage = Some(UsageState {
            key: target.key.clone(),
            root: target.root.clone(),
            compose_project: target.compose_project.clone(),
            emulated_at,
            rows: report.map(|r| r.for_instance(&target.compose_project)),
            emulated,
            emulated_for,
            at: now,
        });
    }

    /// Fixtures and screenshots: read usage for the shown instance now.
    #[cfg(feature = "screenshots")]
    pub fn show_usage_now(&mut self) {
        let Some(target) = self.target(false) else {
            return;
        };
        let report = self.source.service_usage(&target.root);
        let emulated = self
            .source
            .emulated_services(&target.root, target.branch.as_deref());
        self.apply_usage(&target, report, Some(emulated));
    }

    /// What the Services tab shows of usage, as text (the drive's
    /// `expect-usage`): one line per service with values, each emulated
    /// service, and the header total.
    #[cfg(hack_terminal)]
    pub(crate) fn usage_lines(&self) -> Vec<String> {
        let Some(u) = self.shown_usage() else {
            return Vec::new();
        };
        let mut lines = Vec::new();
        match &u.rows {
            Ok(rows) => {
                for (name, r) in rows {
                    lines.push(format!(
                        "{name} {} {}",
                        r.cpu_percent.map_or_else(|| "—".into(), usage::cpu),
                        r.mem_used_bytes.map_or_else(|| "—".into(), usage::bytes)
                    ));
                }
            }
            Err(e) => lines.push(format!("usage error: {e}")),
        }
        lines.extend(u.emulated.iter().map(|s| format!("emulated {s}")));
        lines.extend(self.usage_total_label());
        lines
    }

    /// This instance's usage, when it is the shown one and was read for its
    /// current checkout and Compose project (a native or moved instance
    /// shows none).
    pub(crate) fn shown_usage(&self) -> Option<&UsageState> {
        let target = self.target(false)?;
        self.usage.as_ref().filter(|u| u.is_for(&target))
    }

    /// The header's instance total, when every running service has a value.
    pub(crate) fn usage_total_label(&self) -> Option<String> {
        let u = self.shown_usage()?;
        let rows = u.rows.as_ref().ok()?;
        let detail = self.model.detail()?;
        let running: Vec<String> = detail
            .services
            .iter()
            .filter(|s| s.running)
            .map(|s| s.name.clone())
            .collect();
        let (cpu, mem) = usage::total(rows, &running)?;
        Some(format!("CPU {} · {}", usage::cpu(cpu), usage::bytes(mem)))
    }
}

/// The read path in a window: when usage is read, what is kept, and what a
/// late result for another selection does.
#[cfg(all(test, feature = "screenshots"))]
mod tests {
    use super::*;
    use gpui_kit::{AppContext as _, Entity, HeadlessAppContext, WindowOptions};
    use hack_desktop_core::doctor::DoctorRun;
    use hack_desktop_core::fixtures::Fixture;
    use hack_desktop_core::models::LogEntry;
    use hack_desktop_core::source::{
        ActionOutcome, DoctorTarget, FixtureSource, LogFeed, Snapshot, Source, SourceError,
    };
    use hack_desktop_core::state::Action;
    use std::path::Path;
    use std::sync::{Arc, Mutex};

    /// The usage fixture, recording each usage and ps read; `fail` makes
    /// the usage read fail as it does without Docker.
    struct Recorded {
        calls: Mutex<Vec<String>>,
        fail: Mutex<bool>,
    }

    impl Recorded {
        fn log(&self, call: String) {
            self.calls.lock().unwrap().push(call);
        }
        fn take(&self) -> Vec<String> {
            std::mem::take(&mut *self.calls.lock().unwrap())
        }
    }

    const F: FixtureSource = FixtureSource(Fixture::Usage);

    impl Source for Recorded {
        fn snapshot(&self) -> Result<Snapshot, SourceError> {
            F.snapshot()
        }
        fn act(
            &self,
            r: &Path,
            n: bool,
            b: Option<&str>,
            a: Action,
        ) -> Result<ActionOutcome, SourceError> {
            F.act(r, n, b, a)
        }
        fn log_tail(
            &self,
            r: &Path,
            n: bool,
            b: Option<&str>,
            l: u32,
        ) -> Result<Vec<LogEntry>, String> {
            F.log_tail(r, n, b, l)
        }
        fn doctor_runs(&self, p: &[DoctorTarget]) -> Vec<DoctorRun> {
            F.doctor_runs(p)
        }
        fn open_logs(
            &self,
            r: &Path,
            n: bool,
            b: Option<&str>,
            a: &[String],
        ) -> Result<Box<dyn LogFeed>, String> {
            F.open_logs(r, n, b, a)
        }
        fn service_usage(&self, root: &Path) -> Result<usage::UsageReport, String> {
            self.log(format!("usage {}", root.display()));
            if *self.fail.lock().unwrap() {
                return Err("Docker is not running".into());
            }
            F.service_usage(root)
        }
        fn stats_sample(&self) -> Result<hack_desktop_core::stats::StatsReport, String> {
            self.log("stats sample".into());
            Ok(hack_desktop_core::stats::StatsReport::default())
        }
        fn emulated_services(
            &self,
            root: &Path,
            branch: Option<&str>,
        ) -> Result<BTreeSet<String>, String> {
            self.log(format!("ps {} {branch:?}", root.display()));
            F.emulated_services(root, branch)
        }
    }

    fn window() -> (HeadlessAppContext, Entity<HackApp>, Arc<Recorded>) {
        let source = Arc::new(Recorded {
            calls: Mutex::new(Vec::new()),
            fail: Mutex::new(false),
        });
        let mut cx = HeadlessAppContext::with_platform(
            Arc::new(gpui_kit::NoopTextSystem::new()),
            Arc::new(hack_desktop_ui::icons::Assets),
            || Ok(None),
        );
        cx.update(gpui_kit::init);
        let options = WindowOptions {
            focus: false,
            show: false,
            ..WindowOptions::default()
        };
        let s = source.clone();
        let (_, app) = cx
            .update(|cx| {
                gpui_kit::open_window(options, cx, |window, cx| {
                    cx.new(|cx| HackApp::new(s, false, window, cx))
                })
            })
            .unwrap();
        cx.update(|cx| {
            app.update(cx, |a, _| {
                a.select("storefront");
                a.window_visible = true;
            });
        });
        source.take();
        (cx, app, source)
    }

    fn tick(cx: &mut HeadlessAppContext, app: &Entity<HackApp>) {
        cx.update(|cx| app.update(cx, |a, cx| a.read_usage_if_due(cx)));
        cx.run_until_parked();
    }

    #[test]
    fn stats_samples_running_services_while_another_pane_is_hidden() {
        let (mut cx, app, source) = window();
        cx.update(|cx| {
            app.update(cx, |a, cx| {
                a.window_visible = false;
                a.pane = Pane::Doctor;
                a.read_stats_if_due(cx);
                a.read_stats_if_due(cx);
            });
        });
        cx.run_until_parked();
        assert_eq!(source.take(), ["stats sample"]);
        cx.update(|cx| app.update(cx, |a, cx| a.read_stats_if_due(cx)));
        cx.run_until_parked();
        assert!(
            source.take().is_empty(),
            "wait for the next sample interval"
        );
    }

    #[test]
    fn usage_is_read_only_for_a_shown_services_tab_of_a_running_compose_instance() {
        let (mut cx, app, source) = window();
        cx.update(|cx| {
            app.update(cx, |a, cx| {
                assert!(a.usage_target().is_some(), "services tab, running, visible");
                a.window_visible = false;
                assert!(a.usage_target().is_none(), "hidden window");
                a.window_visible = true;
                a.set_tab(1, cx);
                assert!(a.usage_target().is_none(), "logs tab");
                a.set_tab(0, cx);
                a.pane = Pane::Doctor;
                assert!(a.usage_target().is_none(), "another pane");
                a.pane = Pane::Project;
            });
        });
        cx.update(|cx| app.update(cx, |a, _| a.window_visible = false));
        tick(&mut cx, &app);
        assert!(source.take().is_empty(), "nothing read while hidden");
    }

    #[test]
    fn one_read_fills_the_rows_and_ps_is_read_again_only_when_services_change() {
        let (mut cx, app, source) = window();
        tick(&mut cx, &app);
        let calls = source.take();
        assert_eq!(calls.len(), 2, "usage and ps: {calls:?}");
        assert!(calls[0].starts_with("usage "), "{calls:?}");
        assert!(
            calls[1].starts_with("ps ") && calls[1].ends_with(" None"),
            "{calls:?}"
        );
        cx.update(|cx| {
            let a = app.read(cx);
            let u = a.shown_usage().expect("applied");
            let rows = u.rows.as_ref().expect("read");
            assert_eq!(rows["api"].cpu_percent, Some(3.2));
            assert!(
                !rows.keys().any(|k| k.contains("feature")),
                "only this instance's Compose project"
            );
            assert_eq!(u.emulated, BTreeSet::from(["worker".to_owned()]));
            assert!(a.usage_total_label().is_some_and(|l| l.starts_with("CPU ")));
        });
        // Fresh: nothing read again within EVERY.
        tick(&mut cx, &app);
        assert!(source.take().is_empty());
        // Due again: usage only; the running set is unchanged.
        cx.update(|cx| {
            app.update(cx, |a, _| {
                if let Some(u) = a.usage.as_mut() {
                    u.at = Instant::now().checked_sub(EVERY).unwrap();
                }
            });
        });
        tick(&mut cx, &app);
        let calls = source.take();
        assert_eq!(calls.len(), 1, "{calls:?}");
        assert!(calls[0].starts_with("usage "));
        cx.update(|cx| {
            assert_eq!(
                app.read(cx).shown_usage().map(|u| u.emulated.clone()),
                Some(BTreeSet::from(["worker".to_owned()])),
                "the emulated set is kept"
            );
        });
    }

    #[test]
    fn values_read_for_another_checkout_or_compose_project_are_not_shown() {
        let (mut cx, app, source) = window();
        tick(&mut cx, &app);
        source.take();
        cx.update(|cx| {
            app.update(cx, |a, _| {
                // As if a refresh moved the instance to another checkout.
                if let Some(u) = a.usage.as_mut() {
                    u.root = PathBuf::from("/elsewhere");
                }
                assert!(a.shown_usage().is_none(), "another checkout");
                assert_eq!(a.usage_total_label(), None);
            });
        });
        tick(&mut cx, &app);
        let calls = source.take();
        assert_eq!(calls.len(), 2, "read again, ps included: {calls:?}");
        cx.update(|cx| {
            app.update(cx, |a, _| {
                assert!(a.shown_usage().is_some(), "read for this checkout");
                if let Some(u) = a.usage.as_mut() {
                    u.compose_project = "other".into();
                }
                assert!(a.shown_usage().is_none(), "another Compose project");
            });
        });
    }

    #[test]
    fn the_emulated_flag_is_read_again_after_a_while_with_the_same_services() {
        let (mut cx, app, source) = window();
        tick(&mut cx, &app);
        source.take();
        cx.update(|cx| {
            app.update(cx, |a, _| {
                if let Some(u) = a.usage.as_mut() {
                    u.at = Instant::now().checked_sub(EVERY).unwrap();
                    u.emulated_at = Instant::now().checked_sub(EMULATED_EVERY).unwrap();
                }
            });
        });
        tick(&mut cx, &app);
        let calls = source.take();
        assert_eq!(calls.len(), 2, "{calls:?}");
        assert!(calls[1].starts_with("ps "), "{calls:?}");
    }

    #[test]
    fn a_failed_read_is_unknown_and_shows_no_total() {
        let (mut cx, app, source) = window();
        *source.fail.lock().unwrap() = true;
        tick(&mut cx, &app);
        cx.update(|cx| {
            let a = app.read(cx);
            assert!(a.shown_usage().is_some_and(|u| u.rows.is_err()));
            assert_eq!(a.usage_total_label(), None, "unknown, not zero");
        });
    }

    #[test]
    fn a_result_for_an_instance_no_longer_shown_is_dropped() {
        let (mut cx, app, _source) = window();
        cx.update(|cx| {
            app.update(cx, |a, cx| {
                a.read_usage_if_due(cx);
                let list = a.model.list();
                let other = list
                    .running
                    .iter()
                    .chain(&list.stopped)
                    .map(|r| r.name.clone())
                    .find(|n| n != "storefront")
                    .expect("another project");
                a.select_project(other, cx);
            });
        });
        cx.run_until_parked();
        cx.update(|cx| {
            let a = app.read(cx);
            assert!(a.usage.is_none(), "dropped, not shown on another project");
            assert!(!a.usage_loading);
        });
    }
}
