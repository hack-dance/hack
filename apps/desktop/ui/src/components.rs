//! Small presentational components. Each takes data and [`Ui`], returns an
//! element, and holds no state. Click handlers are passed in by the caller.

use gpui_kit::component::{Icon, Sizable as _, switch::Switch};
use gpui_kit::{
    Div, ElementId, Hsla, IntoElement, ParentElement, SharedString, Stateful, Styled, div,
    prelude::*, px, relative,
};

use crate::icons::Glyph;
use crate::status::Status;
use crate::tokens::{HAIRLINE, Palette, TypeStep, radius, size, space, text};

/// Everything a component needs to draw: palette and font families.
#[derive(Clone)]
pub struct Ui {
    pub p: Palette,
    pub font: SharedString,
    pub mono: SharedString,
}

/// Type-scale and hairline helpers on any styled element.
pub trait StyledExt: Styled + Sized {
    fn type_step(self, t: TypeStep) -> Self {
        self.text_size(t.size)
            .line_height(t.line)
            .font_weight(t.weight)
    }
    fn hairline_t(mut self, color: Hsla) -> Self {
        self.style().border_widths.top = Some(HAIRLINE.into());
        self.border_color(color)
    }
    fn hairline_b(mut self, color: Hsla) -> Self {
        self.style().border_widths.bottom = Some(HAIRLINE.into());
        self.border_color(color)
    }
    fn hairline_r(mut self, color: Hsla) -> Self {
        self.style().border_widths.right = Some(HAIRLINE.into());
        self.border_color(color)
    }
    fn hairline(mut self, color: Hsla) -> Self {
        let s = self.style();
        s.border_widths.top = Some(HAIRLINE.into());
        s.border_widths.bottom = Some(HAIRLINE.into());
        s.border_widths.left = Some(HAIRLINE.into());
        s.border_widths.right = Some(HAIRLINE.into());
        self.border_color(color)
    }
}
impl<T: Styled> StyledExt for T {}

/// 8px state dot. Unknown is a ring so it never reads as "stopped".
pub fn dot(status: Status, ui: &Ui) -> Div {
    let c = status.colors(&ui.p);
    let d = div().size(size::DOT).rounded_full().flex_none();
    if status == Status::Unknown {
        d.border_color(c.dot).border(px(1.5))
    } else {
        d.bg(c.dot)
    }
}

/// An icon from the app's icon set.
pub fn icon(glyph: Glyph, px_size: gpui_kit::Pixels, color: Hsla) -> Icon {
    Icon::default()
        .path(glyph.path())
        .with_size(px_size)
        .text_color(color)
}

/// Rounded label pill: state, backend, counts.
pub fn pill(label: impl Into<SharedString>, bg: Hsla, fg: Hsla) -> Div {
    div()
        .flex_none()
        .px(space::S4)
        .py(px(1.))
        .rounded(radius::PILL)
        .bg(bg)
        .text_color(fg)
        .type_step(text::SMALL_STRONG)
        .whitespace_nowrap()
        .child(label.into())
}

/// State pill with the short label.
pub fn state_pill(status: Status, label: impl Into<SharedString>, ui: &Ui) -> Div {
    let c = status.colors(&ui.p);
    pill(label, c.bg, c.fg)
}

/// Neutral pill (backend name).
pub fn neutral_pill(label: impl Into<SharedString>, ui: &Ui) -> Div {
    pill(label, ui.p.surface_1, ui.p.text_secondary)
}

/// Count pill on the Doctor row; amber when there are findings.
pub fn count_pill(n: usize, ui: &Ui) -> Div {
    let c = ui.p.states.degraded;
    div()
        .flex_none()
        .min_w(px(18.))
        .h(px(16.))
        .px(space::S2)
        .rounded(radius::PILL)
        .flex()
        .items_center()
        .justify_center()
        .bg(c.bg)
        .text_color(c.fg)
        .type_step(text::MICRO)
        .child(n.to_string())
}

/// Sidebar section caption: "Running", "Stopped", "Machine".
pub fn caption(label: impl Into<SharedString>, ui: &Ui) -> Div {
    div()
        .px(space::S5)
        .pt(space::S6)
        .pb(space::S2)
        .type_step(text::SMALL_STRONG)
        .text_color(ui.p.text_muted)
        .child(label.into())
}

/// Sidebar project row: dot, name, optional always-on pin.
pub fn project_row(
    id: impl Into<ElementId>,
    name: impl Into<SharedString>,
    status: Status,
    always_on: bool,
    selected: bool,
    ui: &Ui,
) -> Stateful<Div> {
    let dim = matches!(status, Status::Stopped | Status::Unknown) && !selected;
    let p = ui.p;
    div()
        .id(id)
        .h(size::ROW)
        .flex_none()
        .px(space::S5)
        .flex()
        .items_center()
        .gap(space::S4)
        .rounded(radius::CONTROL)
        .cursor_pointer()
        .when(selected, |d| d.bg(p.selection))
        .when(!selected, |d| d.hover(move |d| d.bg(p.surface_1)))
        .child(dot(status, ui))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .truncate()
                .type_step(if selected {
                    text::BODY_STRONG
                } else {
                    text::BODY
                })
                .text_color(if dim {
                    p.text_secondary
                } else {
                    p.text_primary
                })
                .child(name.into()),
        )
        .when(always_on, |d| {
            d.child(icon(Glyph::Pin, size::ICON, p.text_muted))
        })
}

/// Sidebar branch-instance row, under its project: indented, branch icon,
/// state dot and branch name.
pub fn branch_row(
    id: impl Into<ElementId>,
    branch: impl Into<SharedString>,
    status: Status,
    selected: bool,
    ui: &Ui,
) -> Stateful<Div> {
    let dim = matches!(status, Status::Stopped | Status::Unknown) && !selected;
    let p = ui.p;
    div()
        .id(id)
        .h(size::ROW)
        .flex_none()
        .pl(space::S9)
        .pr(space::S5)
        .flex()
        .items_center()
        .gap(space::S3)
        .rounded(radius::CONTROL)
        .cursor_pointer()
        .when(selected, |d| d.bg(p.selection))
        .when(!selected, |d| d.hover(move |d| d.bg(p.surface_1)))
        .child(icon(Glyph::Branch, size::ICON, p.text_muted))
        .child(dot(status, ui))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .truncate()
                .type_step(if selected {
                    text::BODY_STRONG
                } else {
                    text::BODY
                })
                .text_color(if dim {
                    p.text_secondary
                } else {
                    p.text_primary
                })
                .child(branch.into()),
        )
}

/// A small square icon button (copy, close): no label, hover tint.
pub fn icon_button(id: impl Into<ElementId>, glyph: Glyph, ui: &Ui) -> Stateful<Div> {
    let p = ui.p;
    div()
        .id(id)
        .size(px(22.))
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .rounded(radius::CONTROL)
        .cursor_pointer()
        .hover(move |d| d.bg(p.surface_1))
        .active(move |d| d.bg(p.surface_2))
        .child(icon(glyph, size::ICON, p.text_secondary))
}

/// Sidebar machine row: leading icon, label, trailing dot or count.
pub fn machine_row(
    id: impl Into<ElementId>,
    glyph: Glyph,
    label: impl Into<SharedString>,
    trailing: impl IntoElement,
    ui: &Ui,
) -> Stateful<Div> {
    let p = ui.p;
    div()
        .id(id)
        .h(size::ROW)
        .flex_none()
        .px(space::S5)
        .flex()
        .items_center()
        .gap(space::S4)
        .rounded(radius::CONTROL)
        .cursor_pointer()
        .hover(move |d| d.bg(p.surface_1))
        .child(icon(glyph, size::ICON_ROW, p.text_secondary))
        .child(
            div()
                .flex_1()
                .type_step(text::BODY)
                .text_color(p.text_primary)
                .child(label.into()),
        )
        .child(trailing)
}

/// Header action button: icon and label, quiet until hovered.
pub fn action_button(
    id: impl Into<ElementId>,
    glyph: Glyph,
    label: impl Into<SharedString>,
    enabled: bool,
    ui: &Ui,
) -> Stateful<Div> {
    let p = ui.p;
    let fg = if enabled {
        p.text_primary
    } else {
        p.text_muted
    };
    div()
        .id(id)
        .h(size::CONTROL)
        .px(space::S5)
        .flex()
        .items_center()
        .gap(space::S3)
        .rounded(radius::CONTROL)
        .hairline(p.border_strong)
        .bg(p.surface)
        .text_color(fg)
        .type_step(text::BODY)
        .when(enabled, |d| {
            d.cursor_pointer()
                .hover(move |d| d.bg(p.surface_1))
                .active(move |d| d.bg(p.surface_2))
        })
        .child(icon(glyph, size::ICON, fg))
        .child(label.into())
}

/// Primary action (Start on a stopped project): filled.
pub fn primary_button(
    id: impl Into<ElementId>,
    glyph: Glyph,
    label: impl Into<SharedString>,
    ui: &Ui,
) -> Stateful<Div> {
    let p = ui.p;
    let fg = p.surface;
    div()
        .id(id)
        .h(size::CONTROL)
        .px(space::S5)
        .flex()
        .items_center()
        .gap(space::S3)
        .rounded(radius::CONTROL)
        .bg(p.text_primary)
        .text_color(fg)
        .type_step(text::BODY_STRONG)
        .cursor_pointer()
        .hover(move |d| d.opacity(0.88))
        .child(icon(glyph, size::ICON, fg))
        .child(label.into())
}

/// "Always on" switch (gpui-kit Switch, accent colour, small). A disabled
/// switch says why in its tooltip.
pub fn always_on_switch(checked: bool, disabled_reason: Option<&'static str>, ui: &Ui) -> Switch {
    use gpui_kit::component::Disableable as _;
    let switch = Switch::new("always-on")
        .checked(checked)
        .small()
        .color(ui.p.accent)
        .label("Always on")
        .disabled(disabled_reason.is_some());
    match disabled_reason {
        Some(reason) => switch.tooltip(reason),
        None => switch,
    }
}

/// One pill tab: the selected tab gets a filled background, not an
/// underline. The caller adds the click handler.
pub fn pill_tab(
    id: impl Into<ElementId>,
    label: &'static str,
    sel: bool,
    ui: &Ui,
) -> Stateful<Div> {
    let p = ui.p;
    div()
        .id(id)
        .h(size::CONTROL)
        .px(space::S5)
        .flex()
        .items_center()
        .rounded(radius::CONTROL)
        .cursor_pointer()
        .type_step(if sel { text::BODY_STRONG } else { text::BODY })
        .text_color(if sel {
            p.text_primary
        } else {
            p.text_secondary
        })
        .when(sel, |d| d.bg(p.selection))
        .when(!sel, |d| d.hover(move |d| d.text_color(p.text_primary)))
        .child(label)
}

/// Pill tabs, for renders that need no click handlers.
pub fn pill_tabs(labels: &[&'static str], selected: usize, ui: &Ui) -> Div {
    let mut row = div().flex().items_center().gap(space::S2);
    for (i, label) in labels.iter().enumerate() {
        row = row.child(pill_tab(("tab", i), label, i == selected, ui));
    }
    row
}

/// Title bar: traffic-light inset (macOS), app name, search field (Cmd-K).
pub fn title_bar(show_traffic_lights: bool, ui: &Ui) -> Div {
    let p = ui.p;
    let lights = div()
        .w(size::TRAFFIC_LIGHTS)
        .flex_none()
        .flex()
        .items_center()
        .gap(space::S4)
        .pl(space::S6)
        .when(show_traffic_lights, |d| {
            // Stand-in for the native controls in offscreen renders only.
            let l = |c: u32| {
                div()
                    .size(px(12.))
                    .rounded_full()
                    .bg(gpui_kit::rgb(c))
                    .hairline(p.border)
            };
            d.child(l(0xFF5F57)).child(l(0xFEBC2E)).child(l(0x28C840))
        });
    div()
        .h(size::TITLE_BAR)
        .flex_none()
        .flex()
        .items_center()
        .bg(p.chrome)
        .hairline_b(p.border)
        .child(lights)
        .child(
            div()
                .pl(space::S4)
                .type_step(text::BODY_STRONG)
                .text_color(p.text_primary)
                .child("Hack"),
        )
        .child(div().flex_1())
        .child(search_field(ui))
        .child(div().w(space::S6))
}

/// The Cmd-K search affordance in the title bar.
pub fn search_field(ui: &Ui) -> Stateful<Div> {
    let p = ui.p;
    div()
        .id("search")
        .w(size::SEARCH_W)
        .h(px(24.))
        .px(space::S4)
        .flex()
        .items_center()
        .gap(space::S3)
        .rounded(radius::CONTROL)
        .bg(p.surface)
        .hairline(p.border_strong)
        .cursor_pointer()
        .child(icon(Glyph::Search, size::ICON, p.text_muted))
        .child(
            div()
                .flex_1()
                .type_step(text::BODY)
                .text_color(p.text_muted)
                .child("Search"),
        )
        .child(
            div()
                .px(space::S2)
                .rounded(px(4.))
                .bg(p.surface_1)
                .type_step(text::MICRO)
                .text_color(p.text_secondary)
                .child("⌘K"),
        )
}

/// Status bar: summary items on the left, version on the right.
pub fn status_bar(items: Vec<(Option<Status>, String)>, version: Option<String>, ui: &Ui) -> Div {
    let p = ui.p;
    let mut left = div().flex().items_center().gap(space::S3);
    for (i, (status, label)) in items.into_iter().enumerate() {
        if i > 0 {
            left = left.child(div().text_color(p.text_muted).child("·"));
        }
        left = left.child(
            div()
                .flex()
                .items_center()
                .gap(space::S3)
                .when_some(status, |d, s| d.child(dot(s, ui).size(px(6.))))
                .child(label),
        );
    }
    div()
        .h(size::STATUS_BAR)
        .flex_none()
        .px(space::S6)
        .flex()
        .items_center()
        .bg(p.chrome)
        .hairline_t(p.border)
        .type_step(text::SMALL)
        .text_color(p.text_secondary)
        .child(left)
        .child(div().flex_1())
        .children(version)
}

/// One row of the services table.
pub struct ServiceRow {
    pub name: String,
    pub status: Status,
    pub state: String,
    pub cpu: Option<String>,
    pub memory: Option<String>,
    /// The memory column's tooltip when a value is shown (the limit).
    pub memory_note: Option<String>,
    /// Why CPU and memory show a dash, when they do.
    pub usage_note: &'static str,
    /// The image architecture differs from the engine's (`hack ps`).
    pub emulated: bool,
    /// `Ok(route)` is shown in mono; `Err(note)` is a muted note ("internal").
    pub route: Result<String, String>,
}

/// Why CPU and memory show a dash before a usage read arrives.
pub const UNKNOWN_USAGE: &str = "Not read yet";
/// The tooltip of the `emulated` pill.
pub const EMULATED_NOTE: &str = "The image architecture differs from the engine's: this service runs under emulation, which is slower. Doctor names the fix.";

/// Services table: Service, State, CPU, Memory, Route. Hairline row
/// separators, no outer box, numbers right-aligned.
pub fn services_table(rows: &[ServiceRow], ui: &Ui) -> Div {
    services_table_with_rows(rows, ui, |row, _| row)
}

/// The project window supplies navigation while the gallery keeps static rows.
pub fn services_table_with_rows(
    rows: &[ServiceRow],
    ui: &Ui,
    mut decorate: impl FnMut(Stateful<Div>, &ServiceRow) -> Stateful<Div>,
) -> Div {
    let p = ui.p;
    let column = relative(size::SERVICE_COL_FRACTION);
    let num = |id: (&'static str, usize),
               v: Option<String>,
               note: SharedString,
               width: gpui_kit::Pixels,
               ui: &Ui| {
        div()
            .id(id)
            .w(width)
            .flex_none()
            .flex()
            .justify_end()
            .pr(space::S6)
            .text_color(if v.is_some() {
                ui.p.text_primary
            } else {
                ui.p.text_muted
            })
            .child(v.unwrap_or_else(|| "—".into()))
            .when(!note.is_empty(), |d| {
                d.tooltip(move |window, cx| {
                    gpui_kit::component::tooltip::Tooltip::new(note.clone()).build(window, cx)
                })
            })
    };
    let header = div()
        .h(px(26.))
        .flex()
        .items_center()
        .type_step(text::SMALL)
        .text_color(p.text_muted)
        .child(div().w(column).flex_none().child("SERVICE"))
        .child(div().w(column).flex_none().child("STATE"))
        .child(
            div()
                .w(size::CPU_COL)
                .flex_none()
                .flex()
                .justify_end()
                .pr(space::S6)
                .child("CPU"),
        )
        .child(
            div()
                .w(size::MEMORY_COL)
                .flex_none()
                .flex()
                .justify_end()
                .pr(space::S6)
                .child("MEMORY"),
        )
        .child(div().flex_1().min_w_0().pl(space::S4).child("ROUTE"));
    let mut table = div().flex().flex_col().child(header);
    for (i, r) in rows.iter().enumerate() {
        let state_color = match r.status {
            Status::Failed => p.states.failed.fg,
            Status::Degraded => p.states.degraded.fg,
            Status::Running => p.text_primary,
            _ => p.text_secondary,
        };
        let route = match &r.route {
            Ok(route) => div()
                .font_family(ui.mono.clone())
                .type_step(text::MONO)
                .text_color(p.text_secondary)
                .child(route.clone()),
            Err(note) => div().text_color(p.text_muted).child(note.clone()),
        };
        let row = div()
            .id(("svc", i))
            .h(size::TABLE_ROW)
            .flex_none()
            .flex()
            .items_center()
            .hairline_t(p.border)
            .type_step(text::BODY)
            .text_color(p.text_primary)
            .child(
                div()
                    .w(column)
                    .flex_none()
                    .min_w_0()
                    .flex()
                    .items_center()
                    .gap(space::S4)
                    .child(dot(r.status, ui))
                    .child(div().truncate().child(r.name.clone()))
                    .when(r.emulated, |d| {
                        d.child(
                            div()
                                .id(("emulated", i))
                                .flex_none()
                                .child(pill("emulated", p.states.degraded.bg, p.states.degraded.fg))
                                .tooltip(|window, cx| {
                                    gpui_kit::component::tooltip::Tooltip::new(EMULATED_NOTE)
                                        .build(window, cx)
                                }),
                        )
                    }),
            )
            .child(
                div()
                    .w(column)
                    .flex_none()
                    .truncate()
                    .text_color(state_color)
                    .child(r.state.clone()),
            )
            .child(num(
                ("cpu", i),
                r.cpu.clone(),
                if r.cpu.is_some() {
                    SharedString::default()
                } else {
                    r.usage_note.into()
                },
                size::CPU_COL,
                ui,
            ))
            .child(num(
                ("mem", i),
                r.memory.clone(),
                match (&r.memory, &r.memory_note) {
                    (Some(_), Some(n)) => n.clone().into(),
                    (Some(_), None) => SharedString::default(),
                    (None, _) => r.usage_note.into(),
                },
                size::MEMORY_COL,
                ui,
            ))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .pl(space::S4)
                    .truncate()
                    .child(route),
            );
        table = table.child(decorate(row, r));
    }
    table
}

/// Tone of an inline banner.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BannerTone {
    Warn,
    Error,
}

/// Inline banner under the title bar: icon, one line of text, optional action.
pub fn banner(
    tone: BannerTone,
    message: impl Into<SharedString>,
    action: Option<(Glyph, &'static str)>,
    ui: &Ui,
) -> Div {
    let p = ui.p;
    let c = match tone {
        BannerTone::Warn => p.states.degraded,
        BannerTone::Error => p.states.failed,
    };
    div()
        .flex()
        .items_center()
        .gap(space::S4)
        .px(space::S7)
        .py(space::S3)
        .bg(c.bg)
        .hairline_b(p.border)
        .type_step(text::BODY)
        .text_color(p.text_primary)
        .child(icon(Glyph::Alert, size::ICON, c.fg))
        .child(div().flex_1().min_w_0().truncate().child(message.into()))
        .when_some(action, |d, (glyph, label)| {
            d.child(action_button("banner-action", glyph, label, true, ui))
        })
}

/// Centered empty or error pane: icon, headline, body, optional command.
pub fn empty_pane(
    glyph: Glyph,
    title: impl Into<SharedString>,
    body: impl Into<SharedString>,
    command: Option<&str>,
    ui: &Ui,
) -> Div {
    let p = ui.p;
    div()
        .flex_1()
        .flex()
        .flex_col()
        .items_center()
        .justify_center()
        .gap(space::S4)
        .child(
            div()
                .size(px(40.))
                .rounded(radius::PANEL)
                .bg(p.surface_1)
                .flex()
                .items_center()
                .justify_center()
                .child(icon(glyph, px(20.), p.text_secondary)),
        )
        .child(
            div()
                .pt(space::S2)
                .type_step(text::HEADLINE)
                .text_color(p.text_primary)
                .child(title.into()),
        )
        .child(
            div()
                .max_w(px(360.))
                .text_center()
                .type_step(text::BODY)
                .text_color(p.text_secondary)
                .child(body.into()),
        )
        .when_some(command, |d, cmd| {
            d.child(
                div()
                    .mt(space::S4)
                    .px(space::S5)
                    .py(space::S2)
                    .rounded(radius::CONTROL)
                    .bg(p.surface_1)
                    .font_family(ui.mono.clone())
                    .type_step(text::MONO)
                    .text_color(p.text_primary)
                    .child(cmd.to_owned()),
            )
        })
}

/// Placeholder skeleton bar for the loading state.
pub fn skeleton(width: f32, ui: &Ui) -> Div {
    div()
        .h(px(10.))
        .w(px(width))
        .rounded(px(4.))
        .bg(ui.p.surface_1)
}
