//! A tabbed terminal panel: one tab per session, with its label and badge.
//!
//! [`PanelState`] is the tab logic with no GUI in it. [`TerminalPanel`] is
//! the GPUI entity that owns the tabs' views, draws the tab strip and the
//! active terminal, and handles the actions in [`crate::actions`]. It binds
//! no keys and decides nothing about what a new tab is: [`NewTab`] becomes
//! a [`PanelEvent::NewTabRequested`] for the app, which builds a view from
//! a [`crate::launch::SessionPlan`] and calls [`TerminalPanel::add_tab`].
//!
//! Where the panel sits and how large it is belong to the app's layout. The
//! panel reports [`TerminalPanel::is_visible`] and
//! [`TerminalPanel::is_maximized`]; the app sizes it accordingly.
//!
//! Closing a tab ends its session on a reaper thread. If anything in that
//! session could not be ended (see `session.rs`), the panel shows how many
//! processes were left running.

use std::time::{Duration, Instant};

use gpui_kit::component::ActiveTheme as _;
use gpui_kit::{
    App, Context, Entity, EventEmitter, FocusHandle, Focusable, InteractiveElement as _,
    IntoElement, ParentElement as _, Render, StatefulInteractiveElement as _, Styled as _, Window,
    div, px,
};

use crate::actions::{CloseTab, Find, NewTab, NextTab, PrevTab, ToggleMaximize, TogglePanel};
use crate::launch::{BadgeTone, SessionKind};
use crate::session::PendingTeardown;
use crate::view::{QUIT_DEADLINE, TerminalView};

/// Tabs, which one is active, and whether the panel is shown or maximized.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PanelState<T> {
    tabs: Vec<T>,
    active: usize,
    visible: bool,
    maximized: bool,
}

impl<T> Default for PanelState<T> {
    fn default() -> Self {
        Self {
            tabs: Vec::new(),
            active: 0,
            visible: false,
            maximized: false,
        }
    }
}

impl<T> PanelState<T> {
    pub fn tabs(&self) -> &[T] {
        &self.tabs
    }

    pub fn active_index(&self) -> Option<usize> {
        (!self.tabs.is_empty()).then_some(self.active)
    }

    pub fn active(&self) -> Option<&T> {
        self.tabs.get(self.active)
    }

    pub fn is_visible(&self) -> bool {
        self.visible
    }

    /// Maximized only counts while the panel is shown.
    pub fn is_maximized(&self) -> bool {
        self.visible && self.maximized
    }

    /// Add a tab after the others, activate it and show the panel.
    pub fn add(&mut self, tab: T) -> usize {
        self.tabs.push(tab);
        self.active = self.tabs.len() - 1;
        self.visible = true;
        self.active
    }

    /// Put `tab` in place of the tab at `index` and return the old one.
    /// The active tab and visibility do not change.
    pub fn swap(&mut self, index: usize, tab: T) -> Option<T> {
        let slot = self.tabs.get_mut(index)?;
        Some(std::mem::replace(slot, tab))
    }

    /// Put a tab at `index` (clamped to the end), activate it and show the
    /// panel.
    pub fn insert(&mut self, index: usize, tab: T) -> usize {
        let index = index.min(self.tabs.len());
        self.tabs.insert(index, tab);
        self.active = index;
        self.visible = true;
        index
    }

    pub fn activate(&mut self, index: usize) -> bool {
        if index >= self.tabs.len() {
            return false;
        }
        self.active = index;
        true
    }

    /// Activate the next tab, wrapping. Nothing to do with fewer than two.
    pub fn select_next(&mut self) -> bool {
        self.step(1)
    }

    /// Activate the previous tab, wrapping.
    pub fn select_prev(&mut self) -> bool {
        self.step(self.tabs.len().saturating_sub(1))
    }

    fn step(&mut self, by: usize) -> bool {
        if self.tabs.len() < 2 {
            return false;
        }
        self.active = (self.active + by) % self.tabs.len();
        true
    }

    /// Remove a tab. The tab to its right becomes active, or the new last
    /// one. Closing the last tab hides the panel.
    pub fn close(&mut self, index: usize) -> Option<T> {
        if index >= self.tabs.len() {
            return None;
        }
        let tab = self.tabs.remove(index);
        if index < self.active || self.active >= self.tabs.len() {
            self.active = self.active.saturating_sub(1);
        }
        if self.tabs.is_empty() {
            self.visible = false;
            self.maximized = false;
        }
        Some(tab)
    }

    pub fn close_active(&mut self) -> Option<T> {
        self.close(self.active)
    }

    /// Show or hide. Returns the new visibility. Hiding keeps the tabs and
    /// their sessions running.
    pub fn toggle_visible(&mut self) -> bool {
        self.visible = !self.visible;
        self.visible
    }

    /// Maximize or restore; only when the panel is shown.
    pub fn toggle_maximized(&mut self) -> bool {
        if self.visible {
            self.maximized = !self.maximized;
        }
        self.is_maximized()
    }
}

/// What the app needs to react to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PanelEvent {
    /// The user asked for a new tab; the app chooses the kind and adds it.
    NewTabRequested,
    /// The panel was shown, hidden, maximized or restored, or its tabs
    /// changed: the app may need to lay out again.
    Changed,
}

pub struct TerminalPanel {
    state: PanelState<Entity<TerminalView>>,
    focus: FocusHandle,
    /// Teardowns of closed tabs that have not reported yet.
    closing: Vec<PendingTeardown>,
    /// Processes that outlived tabs closed so far.
    left_running: usize,
    /// The session leaders of tabs closed or replaced so far, with each
    /// tab's label. See [`Self::leaders`].
    retired_leaders: Vec<(u32, String)>,
    /// Embedded in a host that draws its own chrome: render only the
    /// active terminal, and leave panel actions to the host.
    embedded: bool,
}

impl EventEmitter<PanelEvent> for TerminalPanel {}

impl TerminalPanel {
    pub fn new(cx: &mut Context<Self>) -> Self {
        // A closed tab's teardown runs on a reaper thread that GPUI does not
        // wait for. On quit, cut every pending teardown's grace short and
        // await them inside GPUI's shutdown window, as each open tab's own
        // quit handler does for its session.
        cx.on_app_quit(|this, cx| {
            let closing = std::mem::take(&mut this.closing);
            for pending in &closing {
                pending.hurry();
            }
            cx.background_executor().spawn(async move {
                let deadline = Instant::now() + QUIT_DEADLINE;
                for pending in &closing {
                    let left = deadline.saturating_duration_since(Instant::now());
                    if pending.wait(left).is_none() && left.is_zero() {
                        break;
                    }
                }
            })
        })
        .detach();
        Self {
            state: PanelState::default(),
            focus: cx.focus_handle(),
            closing: Vec::new(),
            left_running: 0,
            retired_leaders: Vec::new(),
            embedded: false,
        }
    }

    /// For a host that draws its own tab strip and handles the panel
    /// actions (`TogglePanel`, `NewTab`, `CloseTab`, tab switching,
    /// `ToggleMaximize`): the panel then renders only the active terminal
    /// and registers no action handlers, so those actions reach the host.
    /// Session ownership and teardown are unchanged.
    pub fn set_embedded(&mut self, embedded: bool, cx: &mut Context<Self>) {
        self.embedded = embedded;
        cx.notify();
    }

    pub fn is_visible(&self) -> bool {
        self.state.is_visible()
    }

    pub fn is_maximized(&self) -> bool {
        self.state.is_maximized()
    }

    pub fn tab_count(&self) -> usize {
        self.state.tabs().len()
    }

    pub fn active_index(&self) -> Option<usize> {
        self.state.active_index()
    }

    pub fn active(&self) -> Option<&Entity<TerminalView>> {
        self.state.active()
    }

    /// The tab at `index`.
    pub fn tab(&self, index: usize) -> Option<&Entity<TerminalView>> {
        self.state.tabs().get(index)
    }

    /// Each tab's kind, in order: what the labels and badges are made from.
    pub fn kinds(&self, cx: &App) -> Vec<SessionKind> {
        self.state
            .tabs()
            .iter()
            .map(|t| t.read(cx).kind().clone())
            .collect()
    }

    /// How many processes outlived tabs closed in this panel.
    /// Every session leader any tab of this panel has started, with the
    /// tab's label: tabs closed or replaced, then the open ones. Each
    /// leader is also its session's id, so a caller can account for what
    /// those sessions left running.
    pub fn leaders(&self, cx: &App) -> Vec<(u32, String)> {
        let mut out = self.retired_leaders.clone();
        for view in self.state.tabs() {
            let v = view.read(cx);
            let label = v.kind().label();
            out.extend(v.leaders().iter().map(|&leader| (leader, label.clone())));
        }
        out
    }

    pub fn left_running(&self) -> usize {
        self.left_running
    }

    fn changed(&mut self, cx: &mut Context<Self>) {
        cx.emit(PanelEvent::Changed);
        cx.notify();
    }

    fn focus_active(&self, window: &mut Window, cx: &mut App) {
        match self.state.active() {
            Some(view) if self.state.is_visible() => {
                let handle = view.read(cx).focus_handle(cx);
                window.focus(&handle, cx);
            }
            _ => window.focus(&self.focus, cx),
        }
    }

    /// Add a tab, activate it, show the panel and focus the terminal.
    pub fn add_tab(
        &mut self,
        view: Entity<TerminalView>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        // A tab's label can change (bash was missing, sh started).
        cx.observe(&view, |_, _, cx| cx.notify()).detach();
        self.state.add(view);
        self.focus_active(window, cx);
        self.changed(cx);
    }

    /// Append a background tab with no change to window focus.
    pub fn add_tab_in_place(&mut self, view: Entity<TerminalView>, cx: &mut Context<Self>) {
        let active = self.state.active_index();
        cx.observe(&view, |_, _, cx| cx.notify()).detach();
        self.state.add(view);
        if let Some(active) = active {
            self.state.activate(active);
        }
        self.changed(cx);
    }

    pub fn activate(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        if self.state.activate(index) {
            self.focus_active(window, cx);
            self.changed(cx);
        }
    }

    pub fn next_tab(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.state.select_next() {
            self.focus_active(window, cx);
            self.changed(cx);
        }
    }

    pub fn prev_tab(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.state.select_prev() {
            self.focus_active(window, cx);
            self.changed(cx);
        }
    }

    /// Replace the tab at `index` with `view`, ending the old tab's session
    /// as [`Self::close`] does (for example a log stream that ended and is
    /// started again).
    pub fn replace(
        &mut self,
        index: usize,
        view: Entity<TerminalView>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.close(index, window, cx);
        cx.observe(&view, |_, _, cx| cx.notify()).detach();
        self.state.insert(index, view);
        self.focus_active(window, cx);
        self.changed(cx);
    }

    /// Close the active tab and end its session.
    pub fn close_active(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(index) = self.state.active_index() {
            self.close(index, window, cx);
        }
    }

    /// Close one tab and end its session.
    pub fn close(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        self.close_tab(index, true, window, cx);
    }

    /// End a retired tab's session without moving focus from another view.
    pub fn close_in_place(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        let had_focus = self
            .tab(index)
            .is_some_and(|tab| tab.read(cx).focus_handle(cx).contains_focused(window, cx));
        self.close_tab(index, had_focus, window, cx);
    }

    fn close_tab(
        &mut self,
        index: usize,
        focus: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(view) = self.state.close(index) else {
            return;
        };
        self.retire_view(&view, cx);
        if focus {
            self.focus_active(window, cx);
        }
        self.changed(cx);
    }

    /// Replace the tab at `index` with `view` in place, ending the old
    /// tab's session: the active tab, focus and visibility are unchanged.
    /// For work the user did not ask for (a log stream restarted in the
    /// background), so it never interrupts the tab being typed in.
    ///
    /// If the old view had focus, the new one takes it, so its keys (find,
    /// follow, scrolling) keep working; focus anywhere else is left alone.
    pub fn replace_in_place(
        &mut self,
        index: usize,
        view: Entity<TerminalView>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        cx.observe(&view, |_, _, cx| cx.notify()).detach();
        let incoming = view.read(cx).focus_handle(cx);
        let Some(old) = self.state.swap(index, view) else {
            return;
        };
        let had_focus = old.read(cx).focus_handle(cx).contains_focused(window, cx);
        self.retire_view(&old, cx);
        if had_focus {
            window.focus(&incoming, cx);
        }
        self.changed(cx);
    }

    /// End a removed tab's session on a reaper thread, keeping its
    /// teardown so quit can await it and survivors are reported.
    fn retire_view(&mut self, view: &Entity<TerminalView>, cx: &mut Context<Self>) {
        // End the session now, on a reaper thread, and keep the handle so
        // anything that could not be ended is reported.
        let (shutdown, retired) = view.update(cx, |v, _| (v.take_shutdown(), v.take_retired()));
        let label = view.read(cx).kind().label();
        self.retired_leaders.extend(
            view.read(cx)
                .leaders()
                .iter()
                .map(|&leader| (leader, label.clone())),
        );
        // The view may be dropped now, and its quit handler with it, so the
        // panel keeps every teardown it had: the one starting here and any
        // the session started by itself.
        let any = shutdown.is_some() || !retired.pending.is_empty();
        self.left_running += retired.survivors;
        self.closing.extend(retired.pending);
        if let Some(shutdown) = shutdown {
            self.closing.push(shutdown.terminate_in_background());
        }
        if any {
            cx.spawn(async move |this, cx| {
                // Long enough for the grace period and SIGKILL to have run.
                for _ in 0..20 {
                    cx.background_executor()
                        .timer(Duration::from_millis(100))
                        .await;
                    let pending = this.update(cx, |p, cx| p.collect_teardowns(cx));
                    if !matches!(pending, Ok(true)) {
                        break;
                    }
                }
            })
            .detach();
        }
    }

    /// Take finished teardown results. Returns whether any are still pending.
    fn collect_teardowns(&mut self, cx: &mut Context<Self>) -> bool {
        let before = self.left_running;
        self.closing.retain(|pending| match pending.try_result() {
            Some(done) => {
                self.left_running += done.survivors.len();
                false
            }
            None => true,
        });
        if self.left_running != before {
            cx.notify();
        }
        !self.closing.is_empty()
    }

    /// Show or hide the panel. Hidden tabs keep running.
    pub fn toggle(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.state.toggle_visible();
        self.focus_active(window, cx);
        self.changed(cx);
    }

    pub fn toggle_maximize(&mut self, cx: &mut Context<Self>) {
        self.state.toggle_maximized();
        self.changed(cx);
    }

    /// Ask the app for a new tab.
    pub fn request_new_tab(&mut self, cx: &mut Context<Self>) {
        cx.emit(PanelEvent::NewTabRequested);
    }

    /// Open find in the active terminal.
    pub fn find(&mut self, cx: &mut Context<Self>) {
        if let Some(view) = self.state.active() {
            view.update(cx, |v, cx| v.open_find(cx));
        }
    }

    /// Open find on the active tab and focus that terminal, which takes
    /// the find query's typing (a click on a find button, while focus may
    /// be in another input).
    pub fn find_focused(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.find(cx);
        self.focus_active(window, cx);
    }
}

impl Focusable for TerminalPanel {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for TerminalPanel {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.embedded {
            return div()
                .id("terminal-panel")
                .track_focus(&self.focus)
                .size_full()
                .children(self.state.active().cloned());
        }
        let root = div()
            .id("terminal-panel")
            .key_context("TerminalPanel")
            .track_focus(&self.focus)
            .on_action(cx.listener(|this, _: &TogglePanel, window, cx| this.toggle(window, cx)))
            .on_action(cx.listener(|this, _: &NewTab, _, cx| this.request_new_tab(cx)))
            .on_action(cx.listener(|this, _: &CloseTab, window, cx| {
                this.close_active(window, cx);
            }))
            .on_action(cx.listener(|this, _: &NextTab, window, cx| this.next_tab(window, cx)))
            .on_action(cx.listener(|this, _: &PrevTab, window, cx| this.prev_tab(window, cx)))
            .on_action(cx.listener(|this, _: &ToggleMaximize, _, cx| this.toggle_maximize(cx)))
            .on_action(cx.listener(|this, _: &Find, _, cx| this.find(cx)));
        if !self.state.is_visible() {
            return root;
        }
        let t = cx.theme();
        let active = self.state.active_index();
        let tabs = self.state.tabs().iter().enumerate().map(|(i, view)| {
            let kind = view.read(cx).kind().clone();
            let is_active = active == Some(i);
            let badge = kind.badge().map(|b| {
                let (bg, fg) = match b.tone {
                    BadgeTone::Warning => (t.warning.opacity(0.18), t.warning),
                    BadgeTone::Neutral => (t.secondary, t.muted_foreground),
                };
                div()
                    .id(("terminal-tab-badge", i))
                    .px(px(6.))
                    .py(px(1.))
                    .rounded(px(4.))
                    .bg(bg)
                    .text_color(fg)
                    .text_size(px(11.))
                    .child(b.text)
            });
            div()
                .id(("terminal-tab", i))
                .flex()
                .items_center()
                .gap(px(8.))
                .px(px(12.))
                .h_full()
                .text_size(px(12.))
                .border_b_2()
                .border_color(if is_active { t.primary } else { t.transparent })
                .text_color(if is_active {
                    t.foreground
                } else {
                    t.muted_foreground
                })
                .cursor_pointer()
                .on_click(cx.listener(move |this, _, window, cx| this.activate(i, window, cx)))
                .child(kind.label())
                .children(badge)
        });
        let left_running = (self.left_running > 0).then(|| {
            let n = self.left_running;
            div()
                .id("terminal-panel-left-running")
                .px(px(10.))
                .text_size(px(11.))
                .text_color(t.warning)
                .child(if n == 1 {
                    "1 process from a closed tab is still running".to_owned()
                } else {
                    format!("{n} processes from closed tabs are still running")
                })
        });
        root.flex()
            .flex_col()
            .size_full()
            .bg(t.background)
            .child(
                div()
                    .id("terminal-tabs")
                    .flex()
                    .items_center()
                    .justify_between()
                    .h(px(32.))
                    .flex_none()
                    .border_b_1()
                    .border_color(t.border)
                    .child(div().flex().h_full().children(tabs))
                    .children(left_running),
            )
            .children(
                self.state
                    .active()
                    .map(|view| div().flex_1().min_h_0().child(view.clone())),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::PanelState;

    fn panel(tabs: &[&'static str]) -> PanelState<&'static str> {
        let mut p = PanelState::default();
        for t in tabs {
            p.add(*t);
        }
        p
    }

    #[test]
    fn adding_a_tab_activates_it_and_shows_the_panel() {
        let mut p = PanelState::default();
        assert!(!p.is_visible() && p.active().is_none() && p.active_index().is_none());
        assert_eq!(p.add("logs"), 0);
        assert_eq!(p.add("api · sh"), 1);
        assert!(p.is_visible());
        assert_eq!((p.active_index(), p.active()), (Some(1), Some(&"api · sh")));
        assert_eq!(p.tabs(), ["logs", "api · sh"]);
    }

    #[test]
    fn swapping_keeps_the_active_tab() {
        let mut p = panel(&["logs", "shell"]);
        assert_eq!(p.active(), Some(&"shell"));
        assert_eq!(p.swap(0, "logs2"), Some("logs"));
        assert_eq!(p.tabs(), ["logs2", "shell"]);
        assert_eq!(p.active(), Some(&"shell"), "the shell stays active");
        assert_eq!(p.swap(5, "x"), None);
    }

    #[test]
    fn inserting_puts_the_tab_in_place_and_activates_it() {
        let mut p = panel(&["a", "c"]);
        assert_eq!(p.insert(1, "b"), 1);
        assert_eq!(p.tabs(), ["a", "b", "c"]);
        assert_eq!(p.active(), Some(&"b"));
        assert_eq!(p.insert(9, "d"), 3, "clamped to the end");
    }

    #[test]
    fn next_and_previous_wrap() {
        let mut p = panel(&["a", "b", "c"]);
        assert!(p.select_next());
        assert_eq!(p.active(), Some(&"a"), "wraps from the last to the first");
        assert!(p.select_prev());
        assert_eq!(p.active(), Some(&"c"), "and back");
        assert!(p.select_prev() && p.select_prev());
        assert_eq!(p.active(), Some(&"a"));
        let mut one = panel(&["only"]);
        assert!(
            !one.select_next() && !one.select_prev(),
            "nothing to switch to"
        );
        assert!(!PanelState::<u8>::default().select_next());
        assert!(p.activate(2) && !p.activate(3));
        assert_eq!(p.active(), Some(&"c"));
    }

    #[test]
    fn closing_keeps_a_sensible_tab_active_and_hides_when_empty() {
        let mut p = panel(&["a", "b", "c"]);
        p.activate(1);
        assert_eq!(p.close_active(), Some("b"));
        assert_eq!(p.active(), Some(&"c"), "the tab to the right");
        assert_eq!(p.close_active(), Some("c"));
        assert_eq!(p.active(), Some(&"a"), "the new last tab");
        // Closing a tab left of the active one keeps the same tab active.
        let mut q = panel(&["a", "b", "c"]);
        assert_eq!(q.close(0), Some("a"));
        assert_eq!(q.active(), Some(&"c"));
        assert_eq!(q.close(9), None);
        // The last tab: the panel hides and is no longer maximized.
        p.toggle_maximized();
        assert!(p.is_maximized());
        assert_eq!(p.close_active(), Some("a"));
        assert!(!p.is_visible() && !p.is_maximized() && p.active().is_none());
        assert_eq!(p.close_active(), None);
    }

    #[test]
    fn hiding_keeps_tabs_and_maximize_needs_a_visible_panel() {
        let mut p = panel(&["a", "b"]);
        assert!(p.toggle_maximized());
        assert!(!p.toggle_visible(), "hidden");
        assert_eq!(p.tabs().len(), 2, "tabs and their sessions stay");
        assert!(!p.is_maximized(), "a hidden panel is not maximized");
        assert!(!p.toggle_maximized(), "and cannot become so");
        assert!(p.toggle_visible());
        assert!(p.is_maximized(), "shown again as it was");
        assert!(!p.toggle_maximized());
    }
}
