//! The Upgrade pane (HACK-2289): `hack upgrade check | review | snapshot |
//! rollback`, opened from the sidebar's Machine group.
//!
//! - **Check** (read-only) shows the CLI's own verdict, what blocks it, what
//!   could not be checked, and the plan. Run starts the selected command in
//!   the shared drawer, then refreshes the check.
//! - **Save snapshot** keeps a private copy of the files an upgrade changes,
//!   under the CLI's home.
//! - **Review** (read-only) explains the findings that cannot be applied
//!   safely.
//! - **Restore** puts back one of the CLI's listed snapshots after an
//!   explicit confirm, never with `--overwrite`: a file changed since the
//!   snapshot stays as it is.
//!
//! Snapshot and restore are machine actions: they go through the shared
//! machine gate. Every command runs the selected CLI in its checked context;
//! a result from a CLI switched away from is dropped.

use gpui_kit::{
    AnyElement, ClipboardItem, Context, IntoElement, ParentElement, SharedString, Styled, div,
    prelude::*, px,
};

use hack_desktop_core::machine_gate::Holder;
use hack_desktop_core::terminal::CommandSpec;
#[cfg(hack_terminal)]
use hack_desktop_core::terminal::{CommandAvailability, CommandControl, CommandControlSize};
use hack_desktop_core::upgrade::{
    CheckReport, ReleaseUpdate, Review, Rollback, Snapshot, SnapshotList,
};
use hack_desktop_ui::components::{StyledExt as _, Ui, action_button, dot, empty_pane};
use hack_desktop_ui::icons::Glyph;
use hack_desktop_ui::status::Status;
use hack_desktop_ui::tokens::{radius, space, text};

use crate::doctor_view::Pane;
use crate::view::HackApp;

/// What the Upgrade pane has read and is doing.
#[derive(Default)]
pub(crate) struct UpgradePane {
    pub check: Option<Result<CheckReport, String>>,
    pub checking: bool,
    pub snapshots: Option<Result<SnapshotList, String>>,
    pub review: Option<Result<Review, String>>,
    pub reviewing: bool,
    pub snapshot: Option<Result<Snapshot, String>>,
    /// The snapshot id waiting for the user to confirm its restore.
    pub confirm: Option<String>,
    pub restore: Option<Result<Rollback, String>>,
    /// A snapshot or restore is running (it holds the machine gate).
    pub working: Option<&'static str>,
    /// Bumped when a command, snapshot, or restore finishes. Reads from an
    /// earlier generation are discarded and retried.
    pub generation: u64,
}

impl HackApp {
    pub(crate) fn open_upgrade(&mut self, cx: &mut Context<Self>) {
        self.pane = Pane::Upgrade;
        self.user_navigated();
        if self.upgrade.check.is_none() {
            self.load_upgrade(cx);
        }
        cx.notify();
    }

    /// Fixtures and screenshots: the pane with its check and listing read.
    pub fn show_upgrade_now(&mut self) {
        self.pane = Pane::Upgrade;
        self.upgrade.check = Some(self.source.upgrade_check());
        self.upgrade.snapshots = Some(self.source.upgrade_snapshots());
    }

    /// Run the check and list the snapshots, off the UI thread.
    pub(crate) fn load_upgrade(&mut self, cx: &mut Context<Self>) {
        if !self.live {
            self.show_upgrade_now();
            cx.notify();
            return;
        }
        if self.upgrade.checking {
            return;
        }
        self.upgrade.checking = true;
        let source = self.source.pinned().unwrap_or_else(|| self.source.clone());
        let epoch = self.model.source_epoch();
        let generation = self.upgrade.generation;
        cx.notify();
        cx.spawn(async move |this, cx| {
            let (check, snapshots) = cx
                .background_executor()
                .spawn(async move { (source.upgrade_check(), source.upgrade_snapshots()) })
                .await;
            let _ = this.update(cx, |this, cx| {
                if this.model.source_epoch() != epoch {
                    return;
                }
                this.upgrade.checking = false;
                if this.upgrade.generation != generation {
                    this.load_upgrade(cx);
                    return;
                }
                this.upgrade.check = Some(check);
                this.upgrade.snapshots = Some(snapshots);
                cx.notify();
            });
        })
        .detach();
    }

    pub(crate) fn review_upgrade(&mut self, cx: &mut Context<Self>) {
        if self.upgrade.reviewing {
            return;
        }
        if !self.live {
            self.upgrade.review = Some(self.source.upgrade_review());
            cx.notify();
            return;
        }
        self.upgrade.reviewing = true;
        let source = self.source.pinned().unwrap_or_else(|| self.source.clone());
        let epoch = self.model.source_epoch();
        let generation = self.upgrade.generation;
        cx.notify();
        cx.spawn(async move |this, cx| {
            let review = cx
                .background_executor()
                .spawn(async move { source.upgrade_review() })
                .await;
            let _ = this.update(cx, |this, cx| {
                if this.model.source_epoch() != epoch {
                    return;
                }
                this.finish_upgrade_review(generation, review, cx);
            });
        })
        .detach();
    }

    fn finish_upgrade_review(
        &mut self,
        generation: u64,
        review: Result<Review, String>,
        cx: &mut Context<Self>,
    ) {
        self.upgrade.reviewing = false;
        if self.upgrade.generation != generation {
            self.review_upgrade(cx);
            return;
        }
        self.upgrade.review = Some(review);
        cx.notify();
    }

    /// Keep a snapshot, then list the snapshots again.
    pub(crate) fn save_upgrade_snapshot(&mut self, cx: &mut Context<Self>) {
        let Some(ticket) = self.machine.try_begin(Holder::Upgrade) else {
            return;
        };
        self.upgrade.working = Some("snapshot");
        self.upgrade.confirm = None;
        let source = self.source.pinned().unwrap_or_else(|| self.source.clone());
        let epoch = self.model.source_epoch();
        let live = self.live;
        cx.notify();
        cx.spawn(async move |this, cx| {
            let (snapshot, snapshots) = if live {
                cx.background_executor()
                    .spawn(async move { (source.upgrade_snapshot(), source.upgrade_snapshots()) })
                    .await
            } else {
                (source.upgrade_snapshot(), source.upgrade_snapshots())
            };
            let _ = this.update(cx, |this, cx| {
                if this.model.source_epoch() != epoch {
                    return;
                }
                this.machine.finish(ticket);
                this.upgrade.working = None;
                this.upgrade.generation += 1;
                this.upgrade.snapshot = Some(snapshot);
                this.upgrade.snapshots = Some(snapshots);
                cx.notify();
            });
        })
        .detach();
    }

    /// Ask to restore a listed snapshot: nothing runs until it is confirmed.
    pub(crate) fn ask_upgrade_restore(&mut self, id: String, cx: &mut Context<Self>) {
        self.upgrade.confirm = Some(id);
        self.upgrade.restore = None;
        cx.notify();
    }

    pub(crate) fn cancel_upgrade_restore(&mut self, cx: &mut Context<Self>) {
        self.upgrade.confirm = None;
        cx.notify();
    }

    /// Restore the confirmed snapshot (the one the CLI listed with that id).
    pub(crate) fn confirm_upgrade_restore(&mut self, cx: &mut Context<Self>) {
        let Some(entry) = self.upgrade.confirm.as_ref().and_then(|id| {
            self.upgrade
                .snapshots
                .as_ref()
                .and_then(|l| l.as_ref().ok())
                .and_then(|l| l.snapshots.iter().find(|s| &s.id == id))
                .cloned()
        }) else {
            return;
        };
        let Some(ticket) = self.machine.try_begin(Holder::Upgrade) else {
            return;
        };
        self.upgrade.working = Some("restore");
        self.upgrade.confirm = None;
        let source = self.source.pinned().unwrap_or_else(|| self.source.clone());
        let epoch = self.model.source_epoch();
        let live = self.live;
        cx.notify();
        cx.spawn(async move |this, cx| {
            let result = if live {
                cx.background_executor()
                    .spawn(async move { source.upgrade_restore(&entry) })
                    .await
            } else {
                source.upgrade_restore(&entry)
            };
            let _ = this.update(cx, |this, cx| {
                if this.model.source_epoch() != epoch {
                    return;
                }
                this.machine.finish(ticket);
                this.upgrade.working = None;
                this.upgrade.generation += 1;
                this.upgrade.restore = Some(result);
                // What the check said is about the files before the restore.
                this.upgrade.check = None;
                this.load_upgrade(cx);
                cx.notify();
            });
        })
        .detach();
    }

    /// What the pane says, as text (the drive's `expect-upgrade`).
    #[cfg(hack_terminal)]
    pub(crate) fn upgrade_lines(&self) -> Vec<String> {
        let u = &self.upgrade;
        let mut lines = Vec::new();
        match &u.check {
            Some(Ok(r)) => {
                lines.push(r.verdict());
                lines.extend(
                    r.blockers
                        .iter()
                        .map(|b| format!("{} {}", b.scope, b.summary)),
                );
            }
            Some(Err(e)) => lines.push(format!("Could not check: {e}")),
            None => {}
        }
        if let Some(s) = &u.snapshot {
            lines.push(s.as_ref().map_or_else(|e| e.clone(), Snapshot::summary));
        }
        if let Some(Ok(l)) = &u.snapshots {
            lines.extend(l.snapshots.iter().map(|s| format!("snapshot {}", s.id)));
        }
        if let Some(r) = &u.restore {
            lines.push(r.as_ref().map_or_else(|e| e.clone(), Rollback::summary));
        }
        lines
    }

    /// The newest listed snapshot's id (the drive's `upgrade-restore`).
    #[cfg(hack_terminal)]
    pub(crate) fn newest_upgrade_snapshot(&self) -> Option<String> {
        self.upgrade
            .snapshots
            .as_ref()?
            .as_ref()
            .ok()?
            .snapshots
            .first()
            .map(|s| s.id.clone())
    }

    #[cfg(all(test, feature = "screenshots"))]
    fn newest_listed_for_test(&self) -> Option<String> {
        self.upgrade
            .snapshots
            .as_ref()?
            .as_ref()
            .ok()?
            .snapshots
            .first()
            .map(|s| s.id.clone())
    }

    /// The sidebar dot: the last check's verdict.
    pub(crate) fn upgrade_status(&self) -> Status {
        match &self.upgrade.check {
            Some(Ok(r)) if r.ready => Status::Running,
            Some(Ok(_)) => Status::Failed,
            _ => Status::Unknown,
        }
    }
}

pub fn render(app: &HackApp, ui: &Ui, cx: &mut Context<HackApp>) -> AnyElement {
    let p = ui.p;
    let u = &app.upgrade;
    let mut recheck = action_button(
        "upgrade-recheck",
        Glyph::Restart,
        if u.checking {
            "Checking…"
        } else {
            "Check again"
        },
        !u.checking,
        ui,
    );
    if !u.checking {
        recheck = recheck.on_click(cx.listener(|this, _, _, cx| this.load_upgrade(cx)));
    }
    let header = div()
        .px(space::S8)
        .pt(space::S7)
        .pb(space::S5)
        .flex()
        .items_center()
        .gap(space::S4)
        .hairline_b(p.border)
        .child(
            div()
                .type_step(text::TITLE)
                .text_color(p.text_primary)
                .child("Upgrade"),
        )
        .child(div().flex_1())
        .child(recheck);
    let body: AnyElement = match &u.check {
        None => empty_pane(
            Glyph::Loader,
            "Checking for the upgrade…",
            "Reads this machine and every registered project; it changes nothing.",
            None,
            ui,
        )
        .into_any_element(),
        // The check failed, but snapshots may still be listed: restoring
        // must not depend on the diagnostics working.
        Some(Err(e)) => div()
            .id("upgrade-pane")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .px(space::S8)
            .py(space::S6)
            .gap(space::S7)
            .child(line(
                Status::Failed,
                format!("Could not check for the upgrade: {e}"),
                ui,
            ))
            .child(note(
                "Run hack upgrade check in a terminal to see more.",
                ui,
            ))
            .child(restore(app, ui, cx))
            .into_any_element(),
        Some(Ok(r)) => div()
            .id("upgrade-pane")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .px(space::S8)
            .py(space::S6)
            .gap(space::S7)
            .child(verdict(r, ui))
            .child(plan(app, r, ui, cx))
            .child(snapshot(app, ui, cx))
            .child(review(app, ui, cx))
            .child(restore(app, ui, cx))
            .into_any_element(),
    };
    div()
        .flex_1()
        .min_w_0()
        .h_full()
        .flex()
        .flex_col()
        .child(header)
        .children(
            app.health
                .signals
                .update
                .as_ref()
                .map(|release| release_review(app, release, ui, cx)),
        )
        .child(body)
        .into_any_element()
}

fn release_review(
    app: &HackApp,
    release: &ReleaseUpdate,
    ui: &Ui,
    cx: &mut Context<HackApp>,
) -> gpui_kit::Div {
    let panel = div()
        .flex()
        .flex_col()
        .gap(space::S3)
        .px(space::S8)
        .py(space::S5)
        .hairline_b(ui.p.border)
        .child(section("Release update", ui).child(line(
            Status::Unknown,
            format!("Hack {} is available", release.latest),
            ui,
        )));
    if let Some(command) = release.terminal_command() {
        panel.child(upgrade_command(
            app,
            "release-update".into(),
            &command,
            release.command(app.health_report()),
            true,
            ui,
            cx,
        ))
    } else {
        panel.child(note(
            "Update Hack using the method you used to install it.",
            ui,
        ))
    }
}

fn upgrade_command(
    app: &HackApp,
    id: String,
    label: &str,
    spec: Option<CommandSpec>,
    expects_password: bool,
    ui: &Ui,
    cx: &mut Context<HackApp>,
) -> AnyElement {
    #[cfg(hack_terminal)]
    if let Some(spec) = spec {
        let release = id == "release-update";
        let control = CommandControl {
            id,
            label: label.into(),
            title: "Upgrade".into(),
            availability: CommandAvailability::Ready(spec),
            size: CommandControlSize::Standard,
            cwd: None,
            expects_password,
        };
        let busy = app.upgrade.checking || app.upgrade.reviewing;
        return crate::command_control::render(
            control,
            busy,
            app,
            ui,
            cx,
            move |app, result, cx| {
                app.command_output_ready(result.run, cx);
                app.upgrade.generation += 1;
                app.load_upgrade(cx);
                if app.upgrade.review.is_some() {
                    app.review_upgrade(cx);
                }
                if release {
                    app.health.update_started = None;
                    app.refresh_update_notice(cx);
                    app.refresh_now_async(cx);
                }
            },
        );
    }
    #[cfg(not(hack_terminal))]
    let _ = (app, spec, expects_password);
    copy_chip(format!("copy-{id}"), label, ui, cx)
        .flex_wrap()
        .into_any_element()
}

fn section(title: &'static str, ui: &Ui) -> gpui_kit::Div {
    div().flex().flex_col().gap(space::S4).child(
        div()
            .type_step(text::SMALL_STRONG)
            .text_color(ui.p.text_muted)
            .child(title),
    )
}

fn line(status: Status, text_: impl Into<SharedString>, ui: &Ui) -> gpui_kit::Div {
    div()
        .flex()
        .items_center()
        .gap(space::S4)
        .type_step(text::BODY)
        .text_color(ui.p.text_primary)
        .child(dot(status, ui))
        .child(text_.into())
}

fn note(text_: impl Into<SharedString>, ui: &Ui) -> gpui_kit::Div {
    div()
        .type_step(text::BODY)
        .text_color(ui.p.text_secondary)
        .child(text_.into())
}

fn copy_chip(
    id: impl Into<SharedString>,
    command: &str,
    ui: &Ui,
    cx: &mut Context<HackApp>,
) -> gpui_kit::Div {
    let p = ui.p;
    let to_copy = command.to_owned();
    let id = id.into();
    div()
        .flex()
        .items_center()
        .gap(space::S3)
        .child(
            div()
                .px(space::S4)
                .py(px(1.))
                .rounded(radius::PILL)
                .bg(p.surface_1)
                .font_family(ui.mono.clone())
                .type_step(text::MONO)
                .text_color(p.text_primary)
                .child(command.to_owned()),
        )
        .child(action_button(
            format!("{id}-run"),
            Glyph::Play,
            "Run",
            false,
            ui,
        ))
        .child(
            action_button(id, Glyph::Copy, "Copy", true, ui).on_click(cx.listener(
                move |_, _, _, cx| {
                    cx.write_to_clipboard(ClipboardItem::new_string(to_copy.clone()));
                },
            )),
        )
}

fn verdict(r: &CheckReport, ui: &Ui) -> AnyElement {
    let p = ui.p;
    let mut card = div()
        .flex()
        .flex_col()
        .gap(space::S3)
        .p(space::S6)
        .rounded(radius::PANEL)
        .hairline(p.border)
        .bg(p.surface)
        .child(
            div()
                .flex()
                .items_center()
                .gap(space::S4)
                .child(dot(
                    if r.ready {
                        Status::Running
                    } else {
                        Status::Failed
                    },
                    ui,
                ))
                .child(
                    div()
                        .type_step(text::BODY_STRONG)
                        .text_color(p.text_primary)
                        .child(r.verdict()),
                ),
        )
        .child(note(
            format!(
                "hack {} ({}) · {} projects checked",
                r.cli.version,
                r.cli.channel,
                r.projects.len()
            ),
            ui,
        ));
    for b in &r.blockers {
        card = card.child(line(
            Status::Failed,
            format!("{} · {}", b.scope, b.summary),
            ui,
        ));
    }
    for i in &r.incomplete {
        card = card.child(line(
            Status::Unknown,
            format!("{} · {}", i.scope, i.summary),
            ui,
        ));
    }
    card.into_any_element()
}

fn plan(app: &HackApp, r: &CheckReport, ui: &Ui, cx: &mut Context<HackApp>) -> AnyElement {
    let mut col = section("Plan", ui);
    if r.plan.is_empty() {
        return col.child(note("Nothing to change.", ui)).into_any_element();
    }
    for step in &r.plan {
        let row = div().flex().flex_col().gap(space::S2).child(line(
            if step.blocker {
                Status::Failed
            } else {
                Status::Degraded
            },
            format!("{}. {} · {}", step.order, step.why, step.how()),
            ui,
        ));
        let mut detail = div().flex().flex_col().gap(space::S2).pl(space::S7);
        if step.count > 0 {
            detail = detail.child(note(
                format!(
                    "{} checkout{}",
                    step.count,
                    if step.count == 1 { "" } else { "s" }
                ),
                ui,
            ));
        }
        if let Some(action) = step.action.as_deref().filter(|a| !a.is_empty()) {
            detail = detail.child(note(action.to_owned(), ui));
        }
        if let Some(cmd) = step.command.as_deref().filter(|_| step.id != "snapshot") {
            detail = detail.child(upgrade_command(
                app,
                format!("upgrade-step-{}", step.id),
                cmd,
                step.args
                    .as_ref()
                    .and_then(|args| app.health_report().command(args.clone()).ok()),
                step.kind == "admin",
                ui,
                cx,
            ));
        }
        col = col.child(row.child(detail));
    }
    col.child(note(
        "Run opens the command in Hack’s terminal drawer. Copy lets you run it in your own terminal.",
        ui,
    ))
    .into_any_element()
}

fn snapshot(app: &HackApp, ui: &Ui, cx: &mut Context<HackApp>) -> AnyElement {
    let working = app.upgrade.working == Some("snapshot");
    let enabled = !app.machine.busy();
    let mut button = action_button(
        "upgrade-snapshot",
        Glyph::Folder,
        if working {
            "Saving…"
        } else {
            "Save snapshot"
        },
        enabled,
        ui,
    );
    if enabled {
        button = button.on_click(cx.listener(|this, _, _, cx| this.save_upgrade_snapshot(cx)));
    }
    let mut col = section("Snapshot", ui).child(
        div()
            .flex()
            .items_center()
            .gap(space::S4)
            .child(note(
                "Keep a private copy of the files an upgrade changes, under the CLI's home.",
                ui,
            ))
            .child(div().flex_1())
            .child(button),
    );
    match &app.upgrade.snapshot {
        Some(Ok(s)) => {
            let ok = s.status == "created" && s.complete && s.gaps.is_empty();
            col = col.child(line(
                if ok {
                    Status::Running
                } else {
                    Status::Degraded
                },
                s.summary(),
                ui,
            ));
            for g in &s.gaps {
                col = col.child(note(format!("not covered: {} ({})", g.name, g.reason), ui));
            }
        }
        Some(Err(e)) => col = col.child(line(Status::Failed, e.clone(), ui)),
        None => {}
    }
    col.into_any_element()
}

fn review(app: &HackApp, ui: &Ui, cx: &mut Context<HackApp>) -> AnyElement {
    let reviewing = app.upgrade.reviewing;
    let mut button = action_button(
        "upgrade-review",
        Glyph::Stethoscope,
        if reviewing {
            "Reviewing…"
        } else {
            "Review findings"
        },
        !reviewing,
        ui,
    );
    if !reviewing {
        button = button.on_click(cx.listener(|this, _, _, cx| this.review_upgrade(cx)));
    }
    let mut col = section("Review", ui).child(
        div()
            .flex()
            .items_center()
            .gap(space::S4)
            .child(note(
                "Explains the findings that cannot be applied safely; changes nothing.",
                ui,
            ))
            .child(div().flex_1())
            .child(button),
    );
    match &app.upgrade.review {
        Some(Ok(r)) if r.status == "review" => {
            if r.checkouts.is_empty() {
                col = col.child(note("Nothing to review.", ui));
            }
            for c in &r.checkouts {
                for f in &c.findings {
                    col = col.child(line(
                        if f.status == "blocker" {
                            Status::Failed
                        } else {
                            Status::Degraded
                        },
                        format!("{} · {}", c.scope, f.summary),
                        ui,
                    ));
                    // The checkout's own remedy (for example rotating an
                    // exposed key), not only the generic reason below.
                    let mut remedy = div().flex().flex_col().gap(space::S2).pl(space::S7);
                    if let Some(action) = f.action.as_deref().filter(|a| !a.is_empty()) {
                        remedy = remedy.child(note(action.to_owned(), ui));
                    }
                    if let Some(cmd) = f.command.as_deref().filter(|c| !c.is_empty()) {
                        remedy = remedy.child(upgrade_command(
                            app,
                            format!("upgrade-review-{}-{}", c.scope, f.id),
                            cmd,
                            f.args
                                .as_ref()
                                .and_then(|args| app.health_report().command(args.clone()).ok()),
                            f.kind.as_deref() == Some("admin"),
                            ui,
                            cx,
                        ));
                    }
                    col = col.child(remedy);
                }
            }
            for reason in &r.reasons {
                col = col.child(note(format!("{}: {}", reason.id, reason.reason), ui));
            }
        }
        Some(Ok(r)) => {
            col = col.child(line(
                Status::Failed,
                format!(
                    "Review refused: {}",
                    r.message.as_deref().unwrap_or("no reason given")
                ),
                ui,
            ));
        }
        Some(Err(e)) => col = col.child(line(Status::Failed, e.clone(), ui)),
        None => {}
    }
    col.into_any_element()
}

/// One restore result in words, with where a displaced file was kept.
fn restore_line(f: &hack_desktop_core::upgrade::RestoredFile) -> String {
    let mut text = format!("{} · {}", f.label, f.status);
    if let Some(m) = f.message.as_deref().filter(|m| !m.is_empty()) {
        text.push_str(&format!(": {m}"));
    }
    if let Some(k) = f.kept_as.as_deref().filter(|k| !k.is_empty()) {
        text.push_str(&format!(" · kept at {k}"));
    }
    text
}

fn restore(app: &HackApp, ui: &Ui, cx: &mut Context<HackApp>) -> AnyElement {
    let mut col = section("Restore", ui);
    let list = match &app.upgrade.snapshots {
        Some(Ok(l)) => l,
        Some(Err(e)) => {
            return col
                .child(line(
                    Status::Failed,
                    format!("Could not list snapshots: {e}"),
                    ui,
                ))
                .into_any_element();
        }
        None => return col.into_any_element(),
    };
    if list.snapshots.is_empty() {
        col = col.child(note("No snapshots yet.", ui));
    }
    let busy = app.machine.busy();
    for s in &list.snapshots {
        let id = s.id.clone();
        let listed = s.manifest().is_some();
        let mut row = div()
            .flex()
            .items_center()
            .gap(space::S4)
            .child(note(
                format!(
                    "{} · {} file{}{}",
                    s.id,
                    s.files,
                    if s.files == 1 { "" } else { "s" },
                    s.created_at
                        .as_deref()
                        .map(|c| format!(" · {c}"))
                        .unwrap_or_default()
                ),
                ui,
            ))
            .child(div().flex_1());
        if app.upgrade.confirm.as_deref() == Some(s.id.as_str()) {
            row = row
                .child(
                    action_button(
                        "upgrade-restore-confirm",
                        Glyph::Restart,
                        "Restore",
                        !busy,
                        ui,
                    )
                    .on_click(cx.listener(|this, _, _, cx| this.confirm_upgrade_restore(cx))),
                )
                .child(
                    action_button("upgrade-restore-cancel", Glyph::Close, "Cancel", true, ui)
                        .on_click(cx.listener(|this, _, _, cx| this.cancel_upgrade_restore(cx))),
                );
            col = col.child(row).child(note(
                format!(
                    "Put back {} file{} from {}? A file changed since the snapshot stays as it is; whatever is replaced is kept in the snapshot.",
                    s.files,
                    if s.files == 1 { "" } else { "s" },
                    s.id
                ),
                ui,
            ));
        } else {
            let enabled = listed && !busy;
            let mut button = action_button(
                SharedString::from(format!("upgrade-restore-{}", s.id)),
                Glyph::Restart,
                "Restore…",
                enabled,
                ui,
            );
            if enabled {
                button = button.on_click(
                    cx.listener(move |this, _, _, cx| this.ask_upgrade_restore(id.clone(), cx)),
                );
            }
            col = col.child(row.child(button));
        }
    }
    if app.upgrade.working == Some("restore") {
        col = col.child(note("Restoring…", ui));
    }
    match &app.upgrade.restore {
        Some(Ok(r)) => {
            let ok = r.status == "restored";
            col = col.child(line(
                if ok {
                    Status::Running
                } else {
                    Status::Degraded
                },
                r.summary(),
                ui,
            ));
            // Every file not simply back, and every file with a kept copy:
            // where the CLI kept a displaced file is how it is found again.
            for f in r.results.iter().filter(|f| {
                f.kept_as.is_some() || !matches!(f.status.as_str(), "restored" | "already-restored")
            }) {
                col = col.child(note(restore_line(f), ui));
            }
        }
        Some(Err(e)) => col = col.child(line(Status::Failed, e.clone(), ui)),
        None => {}
    }
    col.into_any_element()
}

#[cfg(all(test, feature = "screenshots"))]
mod tests {
    use super::*;
    use gpui_kit::{HeadlessAppContext, WindowOptions};
    use hack_desktop_core::fixtures::Fixture;
    use hack_desktop_core::source::FixtureSource;
    use std::sync::Arc;

    #[cfg(hack_terminal)]
    #[test]
    fn plan_run_preserves_argv_in_the_drawer_and_refreshes_the_plan() {
        use gpui_kit::test::TestWindowExt as _;
        use hack_desktop_core::execution::ExecutionContext;
        use std::{
            fs,
            os::unix::fs::PermissionsExt,
            time::{Duration, Instant},
        };

        let home = std::env::temp_dir().join(format!("hack-upgrade-drawer-{}", std::process::id()));
        fs::create_dir(&home).unwrap();
        let program = home.join("hack");
        fs::write(
            &program,
            "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$HOME/invocation\"\n",
        )
        .unwrap();
        fs::set_permissions(&program, fs::Permissions::from_mode(0o700)).unwrap();
        let mut report = hack_desktop_core::setup_fixtures::load("ready").unwrap();
        report.cli_program = Some(program.to_str().unwrap().into());
        report.context = Some(
            ExecutionContext::from_values(&[("HOME".into(), home.to_str().unwrap().into())])
                .unwrap(),
        );
        let mut cx = HeadlessAppContext::with_platform(
            Arc::new(gpui_kit::NoopTextSystem::new()),
            Arc::new(hack_desktop_ui::icons::Assets),
            || Ok(None),
        );
        cx.update(gpui_kit::init);
        let (handle, app) = cx
            .update(|cx| {
                gpui_kit::open_window(crate::window_options(), cx, |window, cx| {
                    cx.new(|cx| {
                        let mut app = HackApp::new(
                            Arc::new(FixtureSource(Fixture::Upgrade)),
                            false,
                            window,
                            cx,
                        );
                        app.show_setup_now(report);
                        app.show_upgrade_now();
                        app.live = true;
                        app
                    })
                })
            })
            .unwrap();
        cx.update_window(handle, |_, window, cx| {
            window.render_frame(cx);
            window
                .within("command-upgrade-step-env-format")
                .click("run", cx);
        })
        .unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            cx.update(|cx| app.update(cx, |app, cx| app.settle_command_fixture(cx)));
            cx.run_until_parked();
            if cx.update(|cx| app.read(cx).upgrade.generation > 0 && !app.read(cx).upgrade.checking)
            {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "upgrade drawer run did not settle"
            );
        }
        assert_eq!(
            fs::read_to_string(home.join("invocation")).unwrap(),
            "upgrade\nreview\n--only\nenv-format\n",
        );
        cx.update(|cx| assert!(app.read(cx).panels.command.visible()));
        cx.update_window(handle, |_, window, cx| {
            app.update(cx, |app, cx| app.reset_command_drawer(window, cx));
            window.remove_window();
        })
        .unwrap();
        fs::remove_dir_all(home).unwrap();
    }

    fn window(f: Fixture) -> (HeadlessAppContext, gpui_kit::Entity<HackApp>) {
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
        let (_, app) = cx
            .update(|cx| {
                gpui_kit::open_window(options, cx, |window, cx| {
                    cx.new(|cx| HackApp::new(Arc::new(FixtureSource(f)), false, window, cx))
                })
            })
            .unwrap();
        (cx, app)
    }

    #[test]
    fn a_restore_runs_only_after_its_confirm_and_only_a_listed_snapshot() {
        let (mut cx, app) = window(Fixture::Upgrade);
        cx.update(|cx| {
            app.update(cx, |a, cx| {
                a.open_upgrade(cx);
                assert!(a.upgrade.check.as_ref().is_some_and(Result::is_ok));
                let id = a.newest_listed_for_test().unwrap();
                // Asking runs nothing.
                a.ask_upgrade_restore(id.clone(), cx);
                assert!(a.upgrade.restore.is_none());
                a.cancel_upgrade_restore(cx);
                a.confirm_upgrade_restore(cx);
                assert!(a.upgrade.restore.is_none(), "cancelled: nothing to confirm");
                // A snapshot id the CLI did not list is never restored.
                a.ask_upgrade_restore("not-listed".into(), cx);
                a.confirm_upgrade_restore(cx);
                assert!(a.upgrade.restore.is_none());
            });
        });
        cx.update(|cx| {
            app.update(cx, |a, cx| {
                let id = a.newest_listed_for_test().unwrap();
                a.ask_upgrade_restore(id, cx);
                a.confirm_upgrade_restore(cx);
            });
        });
        cx.run_until_parked();
        let summary = cx.update(|cx| {
            let a = app.read(cx);
            assert!(!a.machine.busy(), "the gate is released");
            a.upgrade
                .restore
                .as_ref()
                .map(|r| r.as_ref().map(Rollback::summary).map_err(Clone::clone))
        });
        assert_eq!(
            summary,
            Some(Ok(
                "Restored 1 of 2 · 1 changed since the snapshot, left as it is".into()
            ))
        );
    }

    #[test]
    fn snapshot_and_restore_wait_while_another_machine_action_runs() {
        let (mut cx, app) = window(Fixture::Upgrade);
        cx.update(|cx| {
            app.update(cx, |a, cx| {
                a.open_upgrade(cx);
                let held = a.machine.try_begin(Holder::Recovery).unwrap();
                a.save_upgrade_snapshot(cx);
                let id = a.newest_listed_for_test().unwrap();
                a.ask_upgrade_restore(id, cx);
                a.confirm_upgrade_restore(cx);
                assert!(a.upgrade.working.is_none(), "nothing started");
                assert!(a.machine.finish(held));
            });
        });
        cx.run_until_parked();
        cx.update(|cx| {
            let a = app.read(cx);
            assert!(a.upgrade.snapshot.is_none() && a.upgrade.restore.is_none());
        });
    }

    #[test]
    fn a_failed_check_still_lets_a_listed_snapshot_be_restored() {
        let (mut cx, app) = window(Fixture::Upgrade);
        cx.update(|cx| {
            app.update(cx, |a, cx| {
                a.open_upgrade(cx);
                a.upgrade.check = Some(Err("upgrade check timed out".into()));
                let id = a.newest_listed_for_test().unwrap();
                a.ask_upgrade_restore(id, cx);
                a.confirm_upgrade_restore(cx);
            });
        });
        cx.run_until_parked();
        cx.update(|cx| {
            assert!(
                app.read(cx)
                    .upgrade
                    .restore
                    .as_ref()
                    .is_some_and(Result::is_ok)
            );
        });
    }

    #[test]
    fn review_keeps_each_checkouts_own_remedy() {
        let (mut cx, app) = window(Fixture::Upgrade);
        let finding = cx.update(|cx| {
            app.update(cx, |a, cx| {
                a.open_upgrade(cx);
                a.review_upgrade(cx);
                a.upgrade.review.clone().unwrap().unwrap().checkouts[0].findings[0].clone()
            })
        });
        assert_eq!(finding.command.as_deref(), Some("hack env migrate"));
        assert_eq!(
            finding.action.as_deref(),
            Some("Check the converted layers before committing them.")
        );
    }

    #[test]
    fn a_review_read_before_a_command_finished_is_retried() {
        let (mut cx, app) = window(Fixture::Upgrade);
        cx.update(|cx| {
            app.update(cx, |app, cx| {
                app.upgrade.generation = 1;
                app.upgrade.reviewing = true;
                app.finish_upgrade_review(0, Err("stale result".into()), cx);

                let review = app.upgrade.review.as_ref().unwrap().as_ref().unwrap();
                assert_eq!(review.status, "review");
                assert!(!app.upgrade.reviewing);
            });
        });
    }

    #[test]
    fn a_restore_result_names_where_a_displaced_file_was_kept() {
        let f = hack_desktop_core::upgrade::RestoredFile {
            path: "/work/.hack/hack.config.json".into(),
            label: "global: hack.config.json".into(),
            status: "error".into(),
            kept_as: Some("/work/.hack/upgrade/snapshots/s1/displaced/hack.config.json".into()),
            message: Some("could not publish the snapshot copy; kept at keptAs".into()),
        };
        assert!(
            restore_line(&f)
                .ends_with("· kept at /work/.hack/upgrade/snapshots/s1/displaced/hack.config.json"),
            "{}",
            restore_line(&f)
        );
    }

    #[test]
    fn a_blocked_check_shows_its_blocker_and_a_red_sidebar_dot() {
        let (mut cx, app) = window(Fixture::UpgradeBlocked);
        let (status, verdict) = cx.update(|cx| {
            app.update(cx, |a, cx| {
                a.open_upgrade(cx);
                (
                    a.upgrade_status(),
                    a.upgrade.check.clone().unwrap().unwrap().verdict(),
                )
            })
        });
        assert_eq!(status, Status::Failed);
        assert_eq!(verdict, "Not ready: 1 blocker, 1 check that could not run");
    }
}
