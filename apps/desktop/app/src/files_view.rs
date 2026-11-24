//! Files tab body for a single service. The project-level picker is a
//! temporary entry point until the service pane owns the Files tab.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use gpui_kit::component::{
    ActiveTheme as _, Sizable as _,
    button::Button,
    input::{Input, InputEvent, InputState},
    menu::{DropdownMenu as _, PopupMenuItem},
};
use gpui_kit::{
    ClipboardItem, Context, Div, Entity, Render, Stateful, Task, Window, div, prelude::*, px,
    relative,
};
use hack_desktop_core::files::{Encoding, Entry, FileSource, Kind, Read, Report, Target};
use hack_desktop_core::source::Source;
use hack_desktop_core::viewmodel::{DetailView, InstanceKey};
use hack_desktop_ui::{
    components::{StyledExt as _, Ui, action_button, icon},
    icons::Glyph,
    tokens::{Mode, Palette, radius, size, space, text},
};

use crate::view::HackApp;

pub(crate) const FILES_TAB: usize = 4;

#[derive(Default)]
pub(crate) struct ProjectFiles {
    service: Option<String>,
    pane: Option<(InstanceKey, u64, Entity<FilesPane>)>,
}

impl HackApp {
    pub(crate) fn project_files(
        &mut self,
        detail: &DetailView,
        ui: &Ui,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Div {
        let message = |text| {
            div()
                .px(space::S8)
                .type_step(text::BODY)
                .text_color(ui.p.text_secondary)
                .child(text)
        };
        let Some((root, native)) = self.selected_root() else {
            return message("The service checkout is unavailable.");
        };
        if native {
            return message("Files are available for Compose services.");
        }
        let Some(service) = self.files_service(detail).cloned() else {
            return message("No services reported for this project.");
        };
        let target = Target {
            root,
            branch: detail.key.branch.clone(),
            service: service.clone(),
        };
        let epoch = self.model.source_epoch();
        if self
            .files
            .pane
            .as_ref()
            .is_none_or(|(key, bound_epoch, pane)| {
                *key != detail.key || *bound_epoch != epoch || pane.read(cx).target != target
            })
        {
            let source = self.source.pinned().unwrap_or_else(|| self.source.clone());
            let pane = FilesPane::open(target, source, window, cx);
            self.files.pane = Some((detail.key.clone(), epoch, pane));
        }
        div()
            .flex_1()
            .min_h_0()
            .flex()
            .flex_col()
            .px(space::S8)
            .children(self.files.pane.iter().map(|(_, _, pane)| pane.clone()))
    }

    fn files_service<'a>(&'a self, detail: &'a DetailView) -> Option<&'a String> {
        let services = &detail.services;
        self.files
            .service
            .as_ref()
            .filter(|name| services.iter().any(|service| &service.name == *name))
            .or_else(|| services.iter().find(|s| s.running).map(|s| &s.name))
            .or_else(|| services.first().map(|s| &s.name))
    }

    pub(crate) fn project_files_picker(&self, detail: &DetailView, cx: &Context<Self>) -> Div {
        let mut picker = div().ml_auto().flex().items_center();
        if detail.services.len() > 1
            && self.selected_root().is_some_and(|(_, native)| !native)
            && let Some(service) = self.files_service(detail).cloned()
        {
            let app = cx.entity().downgrade();
            let names: Vec<_> = detail.services.iter().map(|s| s.name.clone()).collect();
            picker = picker.child(
                Button::new("files-service")
                    .outline()
                    .small()
                    .label("Choose service")
                    .dropdown_menu(move |menu, _, _| {
                        names.iter().fold(menu, |menu, name| {
                            let app = app.clone();
                            let choice = name.clone();
                            menu.item(
                                PopupMenuItem::new(name.clone())
                                    .checked(*name == service)
                                    .on_click(move |_, _, cx| {
                                        let _ = app.update(cx, |app, cx| {
                                            app.files.service = Some(choice.clone());
                                            cx.notify();
                                        });
                                    }),
                            )
                        })
                    }),
            );
        }
        picker
    }

    pub(crate) fn show_files_fixture(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        use hack_desktop_core::viewmodel::Event;
        let key = InstanceKey::branch("storefront", "feature-search");
        self.model.apply(Event::SelectInstance(key.clone()));
        self.tab = FILES_TAB;
        let Some((root, _)) = self.selected_root() else {
            return;
        };
        let target = Target {
            root,
            branch: key.branch.clone(),
            service: "api".into(),
        };
        let pane = cx.new(|cx| {
            let mut pane = FilesPane::new(target, self.source.clone(), window, cx);
            pane.show_fixture();
            pane
        });
        self.files.service = Some("api".into());
        self.files.pane = Some((key, self.model.source_epoch(), pane));
    }
}

struct Directory {
    path: String,
    entries: Vec<Entry>,
}

struct Preview {
    encoding: Encoding,
    lines: Vec<String>,
    truncated: bool,
}

/// A rendered Files tab bound to one project instance and service.
pub(crate) struct FilesPane {
    target: Target,
    source: Arc<dyn Source>,
    input: Entity<InputState>,
    directory: Option<Directory>,
    selected: Option<Entry>,
    selection_epoch: u64,
    preview: Option<Preview>,
    show_hidden: bool,
    notice: Option<String>,
    pending: Option<Task<()>>,
    reading: Option<Read>,
}

impl FilesPane {
    pub(crate) fn open(
        target: Target,
        source: Arc<dyn Source>,
        window: &mut Window,
        cx: &mut gpui_kit::App,
    ) -> Entity<Self> {
        cx.new(|cx| {
            let mut pane = Self::new(target, source, window, cx);
            pane.load(Read::List, ".".to_owned(), cx);
            pane
        })
    }

    fn new(
        target: Target,
        source: Arc<dyn Source>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let input = cx.new(|cx| InputState::new(window, cx).placeholder("Go to file"));
        cx.subscribe(&input, |pane: &mut Self, state, event: &InputEvent, cx| {
            if matches!(event, InputEvent::PressEnter { .. }) {
                let path = state.read(cx).value().to_string();
                if !path.is_empty() {
                    pane.browse(&path, cx);
                }
            }
        })
        .detach();
        Self {
            target,
            source,
            input,
            directory: None,
            selected: None,
            selection_epoch: 0,
            preview: None,
            show_hidden: false,
            notice: None,
            pending: None,
            reading: None,
        }
    }

    fn browse(&mut self, path: &str, cx: &mut Context<Self>) {
        let path = match &self.directory {
            Some(dir) if !path.starts_with('/') => {
                format!("{}/{}", dir.path.trim_end_matches('/'), path)
            }
            _ => path.to_owned(),
        };
        self.load(Read::List, path, cx);
    }

    fn load(&mut self, op: Read, path: String, cx: &mut Context<Self>) {
        if op == Read::List {
            self.selection_epoch += 1;
        }
        self.reading = Some(op);
        self.notice = None;
        let target = self.target.clone();
        let source = self.source.clone();
        self.pending = Some(cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    match op {
                        Read::List => browse(source.as_ref(), &target, &path),
                        Read::Cat => source
                            .service_files(&target, op, &path)
                            .map(ReadResult::Preview),
                    }
                })
                .await;
            let _ = this.update(cx, |this, cx| {
                this.pending = None;
                this.reading = None;
                match result {
                    Ok(ReadResult::Directory(directory, selected)) => {
                        this.directory = Some(directory);
                        this.selected = None;
                        this.preview = None;
                        if let Some(entry) = selected {
                            this.select(entry, cx);
                        }
                    }
                    Ok(ReadResult::Preview(Report::Cat {
                        entry,
                        encoding,
                        content,
                        truncated,
                    })) => {
                        this.selected = Some(entry);
                        this.preview = Some(Preview::new(encoding, content, truncated));
                    }
                    Ok(ReadResult::Preview(Report::List { .. })) => {
                        this.notice = Some("The Files report did not contain a preview.".into());
                    }
                    Err(error) => this.notice = Some(error),
                }
                cx.notify();
            });
        }));
        cx.notify();
    }

    fn select(&mut self, entry: Entry, cx: &mut Context<Self>) {
        match entry.kind {
            Kind::Directory | Kind::Symlink => self.load(Read::List, entry.path, cx),
            Kind::File | Kind::Other => {
                self.selection_epoch += 1;
                self.pending = None;
                self.reading = None;
                self.notice = None;
                self.preview = None;
                if entry.kind == Kind::File && entry.source == FileSource::Worktree {
                    self.load(Read::Cat, entry.path.clone(), cx);
                }
                self.selected = Some(entry);
                cx.notify();
            }
        }
    }

    fn open_editor(&mut self, entry: Entry, cx: &mut Context<Self>) {
        let target = self.target.clone();
        let source = self.source.clone();
        let selection_epoch = self.selection_epoch;
        let selected_path = entry.path.clone();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    let Report::List { entry: current, .. } =
                        source.service_files(&target, Read::List, &entry.path)?
                    else {
                        return Err("The Files report did not contain the current entry.".into());
                    };
                    let path = entry.editor_path(&current, &target.root)?;
                    open_text_file(&path).map_err(str::to_owned)
                })
                .await;
            if let Err(error) = result {
                let _ = this.update(cx, |this, cx| {
                    if this.selection_epoch == selection_epoch
                        && this
                            .selected
                            .as_ref()
                            .is_some_and(|entry| entry.path == selected_path)
                    {
                        this.notice = Some(error);
                        cx.notify();
                    }
                });
            }
        })
        .detach();
    }

    fn toolbar(&self, ui: &Ui, cx: &mut Context<Self>) -> Div {
        let path = self.directory.as_ref().map_or("…", |d| &d.path);
        let pane = cx.entity().downgrade();
        div()
            .flex()
            .items_center()
            .gap(space::S4)
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(space::S2)
                    .max_w(relative(0.35))
                    .overflow_hidden()
                    .whitespace_nowrap()
                    .font_family(ui.mono.clone())
                    .type_step(text::MONO)
                    .text_color(ui.p.text_secondary)
                    .child(icon(Glyph::Server, size::ICON, ui.p.text_secondary))
                    .child(format!("{}:", self.target.service))
                    .child(
                        div()
                            .truncate()
                            .text_color(ui.p.text_primary)
                            .child(path.to_owned()),
                    ),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .h(size::CONTROL)
                    .rounded(radius::CONTROL)
                    .hairline(ui.p.border_strong)
                    .child(
                        Input::new(&self.input)
                            .small()
                            .appearance(false)
                            .cleanable(true)
                            .prefix(icon(Glyph::Search, size::ICON, ui.p.text_secondary)),
                    ),
            )
            .child(
                action_button("files-hidden", Glyph::Eye, "Show hidden", true, ui)
                    .when(self.show_hidden, |button| button.bg(ui.p.surface_1))
                    .on_click(cx.listener(|pane, _, _, cx| {
                        pane.show_hidden = !pane.show_hidden;
                        cx.notify();
                    })),
            )
            .child(
                Button::new("files-menu")
                    .small()
                    .outline()
                    .icon(icon(Glyph::Ellipsis, size::ICON, ui.p.text_primary))
                    .tooltip("File browser actions")
                    .dropdown_menu(move |menu, _, _| {
                        let pane = pane.clone();
                        menu.item(PopupMenuItem::new("Refresh").on_click(move |_, _, cx| {
                            let _ = pane.update(cx, |pane, cx| {
                                let path = pane.directory.as_ref().map_or(".", |d| &d.path);
                                pane.load(Read::List, path.to_owned(), cx);
                            });
                        }))
                    }),
            )
    }

    fn rows(&self, ui: &Ui, cx: &mut Context<Self>) -> Div {
        let mut rows = div().flex().flex_col();
        let Some(dir) = &self.directory else {
            return rows;
        };
        if dir.path != "/" {
            let parent = parent_path(&dir.path).to_owned();
            rows = rows.child(
                file_row("files-parent", Glyph::Directory, "..", false, ui)
                    .on_click(cx.listener(move |pane, _, _, cx| pane.browse(&parent, cx))),
            );
        }
        let mut visible = dir
            .entries
            .iter()
            .filter(|entry| self.show_hidden || !entry.name.starts_with('.'))
            .peekable();
        if visible.peek().is_none() {
            rows = rows.child(muted("No files in this directory.", ui));
        }
        let now = current_time_ms();
        rows.children(visible.map(|entry| {
            let selected = self.selected.as_ref().is_some_and(|s| s.path == entry.path);
            let row = file_row(
                gpui_kit::SharedString::from(format!("files-entry:{}", entry.path)),
                file_icon(entry.kind),
                &entry.name,
                selected,
                ui,
            )
            .child(
                div()
                    .flex_none()
                    .px(space::S2)
                    .rounded(radius::PILL)
                    .hairline(ui.p.border_strong)
                    .font_family(ui.mono.clone())
                    .type_step(text::MICRO)
                    .child(entry.source.label()),
            )
            .child(
                div()
                    .flex_none()
                    .w(px(56.))
                    .text_right()
                    .text_color(ui.p.text_secondary)
                    .child(
                        entry
                            .size_bytes
                            .map_or_else(String::new, hack_desktop_core::usage::bytes),
                    ),
            )
            .child(
                div()
                    .flex_none()
                    .w(px(34.))
                    .text_right()
                    .text_color(ui.p.text_secondary)
                    .child(age(now, entry.modified_at_ms)),
            );
            let entry = entry.clone();
            row.on_click(cx.listener(move |pane, _, _, cx| pane.select(entry.clone(), cx)))
        }))
    }

    fn preview(&self, ui: &Ui, cx: &mut Context<Self>) -> Div {
        let mut panel = div()
            .flex_1()
            .min_w_0()
            .min_h_0()
            .flex()
            .flex_col()
            .rounded(radius::PANEL)
            .hairline(ui.p.border_strong)
            .overflow_hidden();
        let Some(entry) = &self.selected else {
            return panel.child(muted("Select a file to preview.", ui));
        };
        let path = entry.path.clone();
        let editor = entry.kind == Kind::File
            && entry.source == FileSource::Worktree
            && entry.host_path.is_some();
        let copy =
            preview_button("files-copy", Glyph::Copy, "Copy path", ui).on_click(move |_, _, cx| {
                cx.write_to_clipboard(ClipboardItem::new_string(path.clone()))
            });
        let mut header = div()
            .flex()
            .items_center()
            .flex_wrap()
            .min_h(px(40.))
            .gap(space::S4)
            .px(space::S6)
            .py(space::S2)
            .child(icon(file_icon(entry.kind), size::ICON, ui.p.text_primary))
            .child(
                div()
                    .flex_1()
                    .min_w(px(110.))
                    .flex()
                    .items_center()
                    .gap(space::S2)
                    .font_family(ui.mono.clone())
                    .child(
                        div()
                            .truncate()
                            .type_step(text::BODY_STRONG)
                            .child(entry.name.clone()),
                    )
                    .child(
                        div()
                            .flex_none()
                            .font_family(ui.font.clone())
                            .text_color(ui.p.text_secondary)
                            .child(format!("· {}", entry.source.label())),
                    ),
            )
            .child(copy);
        if editor {
            let entry = entry.clone();
            header = header.child(
                preview_button("files-edit", Glyph::Pencil, "Open in editor", ui).on_click(
                    cx.listener(move |pane, _, _, cx| pane.open_editor(entry.clone(), cx)),
                ),
            );
        } else if entry.kind == Kind::File {
            let path = entry.path.clone();
            header = header.child(
                preview_button("files-read", Glyph::Eye, "Preview", ui).on_click(
                    cx.listener(move |pane, _, _, cx| pane.load(Read::Cat, path.clone(), cx)),
                ),
            );
        }
        panel = panel.child(header);
        let text = match (self.reading, &self.preview, entry.kind) {
            (Some(Read::Cat), _, _) => muted("Reading file…", ui),
            (_, Some(preview), _) => preview.render(ui),
            (_, _, Kind::File) if editor => muted("Preview unavailable.", ui),
            (_, _, Kind::File) => muted("Open a read-only preview of this file.", ui),
            _ => muted("Only regular files can be previewed.", ui),
        };
        panel.child(
            div()
                .id("files-preview")
                .flex_1()
                .min_h_0()
                .overflow_scroll()
                .bg(ui.p.preview_surface)
                .child(text),
        )
    }
}

impl Render for FilesPane {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let ui = Ui {
            p: Palette::for_mode(if theme.is_dark() {
                Mode::Dark
            } else {
                Mode::Light
            }),
            font: theme.font_family.clone(),
            mono: theme.mono_font_family.clone(),
        };
        let status = self
            .notice
            .as_deref()
            .or_else(|| (self.reading == Some(Read::List)).then_some("Reading directory…"));
        let footnote_color = match ui.p.mode {
            Mode::Light => ui.p.text_secondary,
            Mode::Dark => ui.p.text_muted,
        };
        div()
            .flex().flex_col().flex_1().min_h_0().min_w_0().gap(space::S4).pb(space::S5)
            .type_step(text::BODY).text_color(ui.p.text_primary)
            .child(self.toolbar(&ui, cx))
            .children(status.map(|s| div().text_color(ui.p.text_secondary).child(s.to_owned())))
            .child(div().flex().flex_1().min_h_0().min_w_0().gap(space::S6)
                .child(div().id("files-rows").w(relative(0.42)).min_w_0()
                    .overflow_y_scroll().child(self.rows(&ui, cx)))
                .child(self.preview(&ui, cx)))
            .child(div().flex().items_center().gap(space::S4).type_step(text::SMALL)
                .text_color(footnote_color)
                .child(icon(Glyph::Info, size::ICON, footnote_color).flex_none())
                .child("worktree files are your checkout, mounted in. container files outside mounts live only in the container and go away when it is rebuilt."))
    }
}

enum ReadResult {
    Directory(Directory, Option<Entry>),
    Preview(Report),
}

fn browse(source: &dyn Source, target: &Target, path: &str) -> Result<ReadResult, String> {
    let Report::List { entry, entries } = source.service_files(target, Read::List, path)? else {
        return Err("The Files report did not contain a listing.".into());
    };
    if entry.kind == Kind::Directory {
        return Ok(ReadResult::Directory(
            Directory {
                path: entry.path,
                entries,
            },
            None,
        ));
    }
    let Report::List {
        entry: directory,
        entries,
    } = source.service_files(target, Read::List, parent_path(&entry.path))?
    else {
        return Err("The Files report did not contain a listing.".into());
    };
    Ok(ReadResult::Directory(
        Directory {
            path: directory.path,
            entries,
        },
        Some(entry),
    ))
}

fn parent_path(path: &str) -> &str {
    match path.rsplit_once('/') {
        Some((parent, _)) if !parent.is_empty() => parent,
        _ => "/",
    }
}

fn open_text_file(path: &Path) -> Result<(), &'static str> {
    const FAILED: &str = "Could not open the worktree file in your editor.";
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = std::process::Command::new("/usr/bin/open");
        command.arg("-t");
        command
    };
    #[cfg(not(target_os = "macos"))]
    let mut command = {
        // Choose the text handler even for worktree files with another MIME type.
        let output = std::process::Command::new("xdg-mime")
            .args(["query", "default", "text/plain"])
            .stderr(std::process::Stdio::null())
            .output()
            .map_err(|error| match error.kind() {
                std::io::ErrorKind::NotFound => {
                    "Opening worktree files on Linux requires xdg-mime."
                }
                _ => FAILED,
            })?;
        let desktop_id = std::str::from_utf8(&output.stdout)
            .map(str::trim)
            .map_err(|_| FAILED)?;
        if !output.status.success()
            || !desktop_id.ends_with(".desktop")
            || desktop_id.starts_with('-')
        {
            return Err("Choose a default application for text/plain to open worktree files.");
        }
        let mut command = std::process::Command::new("gtk-launch");
        command.arg(desktop_id);
        command
    };
    let result = command
        .arg(path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
    match result {
        Ok(status) if status.success() => Ok(()),
        #[cfg(not(target_os = "macos"))]
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Err("Opening worktree files on Linux requires gtk-launch.")
        }
        _ => Err(FAILED),
    }
}

fn file_icon(kind: Kind) -> Glyph {
    match kind {
        Kind::Directory => Glyph::Directory,
        Kind::Symlink => Glyph::Link,
        Kind::File | Kind::Other => Glyph::FileText,
    }
}

fn file_row(
    id: impl Into<gpui_kit::ElementId>,
    glyph: Glyph,
    name: &str,
    selected: bool,
    ui: &Ui,
) -> Stateful<Div> {
    let p = ui.p;
    let selection = match p.mode {
        Mode::Light => p.surface_2,
        Mode::Dark => p.selection,
    };
    div()
        .id(id)
        .h(size::TABLE_ROW)
        .flex_none()
        .flex()
        .items_center()
        .gap(space::S4)
        .px(space::S4)
        .rounded(radius::CONTROL)
        .cursor_pointer()
        .when(!selected, |row| row.hover(move |row| row.bg(p.surface_1)))
        .when(selected, |row| {
            row.bg(selection).type_step(text::BODY_STRONG)
        })
        .child(icon(glyph, size::ICON, p.text_secondary))
        .child(div().flex_1().min_w_0().truncate().child(name.to_owned()))
}

fn preview_button(id: &'static str, glyph: Glyph, label: &'static str, ui: &Ui) -> Stateful<Div> {
    action_button(id, glyph, label, true, ui)
        .w(px(118.))
        .flex_none()
        .justify_center()
}

fn muted(message: &'static str, ui: &Ui) -> Div {
    div()
        .p(space::S6)
        .text_color(ui.p.text_secondary)
        .child(message)
}

fn current_time_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|d| i64::try_from(d.as_millis()).ok())
        .unwrap_or_default()
}

fn age(now: i64, then: i64) -> String {
    let minutes = now.saturating_sub(then).max(0) / 60_000;
    match minutes {
        0 => "now".into(),
        1..=59 => format!("{minutes}m"),
        60..=1439 => format!("{}h", minutes / 60),
        _ => format!("{}d", minutes / 1440),
    }
}

impl Preview {
    fn new(encoding: Encoding, content: String, truncated: bool) -> Self {
        // A 64 KiB text prefix can contain more line breaks than GPUI should
        // turn into elements. Bound the rendered row count as well.
        const MAX_LINES: usize = 1000;
        let mut lines = Vec::new();
        if encoding == Encoding::Utf8 {
            lines.extend(content.lines().take(MAX_LINES + 1).map(str::to_owned));
        }
        let line_limit = lines.len() > MAX_LINES;
        lines.truncate(MAX_LINES);
        Self {
            encoding,
            lines,
            truncated: truncated || line_limit,
        }
    }

    fn render(&self, ui: &Ui) -> Div {
        if self.encoding == Encoding::Base64 {
            return muted("Binary file. Text preview is unavailable.", ui);
        }
        if self.lines.is_empty() {
            return muted("Empty file.", ui);
        }
        div()
            .p(space::S4)
            .font_family(ui.mono.clone())
            .type_step(text::MONO)
            .children(self.lines.iter().enumerate().map(|(index, line)| {
                let color = if line.trim_start().starts_with("//") {
                    ui.p.text_secondary
                } else {
                    ui.p.text_primary
                };
                div()
                    .flex()
                    .items_start()
                    .gap(space::S6)
                    .child(
                        div()
                            .w(px(24.))
                            .flex_none()
                            .text_right()
                            .text_color(ui.p.text_secondary)
                            .child((index + 1).to_string()),
                    )
                    .child(
                        div()
                            .whitespace_nowrap()
                            .text_color(color)
                            .child(line.clone()),
                    )
            }))
            .children(self.truncated.then(|| muted("Preview truncated.", ui)))
    }
}

impl FilesPane {
    fn show_fixture(&mut self) {
        let now = current_time_ms();
        let entry = |name: &str, kind, source, size_bytes, minutes: i64| Entry {
            name: name.into(),
            path: format!("/app/{name}"),
            kind,
            source,
            host_path: (source == FileSource::Worktree)
                .then(|| PathBuf::from(format!("/work/storefront/{name}"))),
            size_bytes,
            modified_at_ms: now - minutes * 60_000,
        };
        use FileSource::{Container, Volume, Worktree};
        use Kind::{Directory as Folder, File};
        let selected = entry("search.config.ts", File, Worktree, Some(644), 4);
        self.directory = Some(Directory {
            path: "/app".into(),
            entries: vec![
                entry("node_modules", Folder, Container, None, 120),
                entry("src", Folder, Worktree, None, 4),
                entry(".env.example", File, Worktree, Some(212), 1440),
                entry("package.json", File, Worktree, Some(1843), 1440),
                selected.clone(),
                entry("tsconfig.json", File, Worktree, Some(512), 4320),
                entry("tmp", Folder, Container, None, 1),
                entry("index.lock", File, Container, Some(0), 1),
                entry("cache", Folder, Volume, None, 1),
            ],
        });
        self.show_hidden = true;
        self.selected = Some(selected);
        self.preview = Some(Preview::new(
            Encoding::Utf8,
            r#"// example config, not real data
export default {
  index: "products",
  minScore: 0.42,
  slowQueryMs: 250,
  synonyms: {
    lamp: ["light", "sconce"],
    desk: ["table"],
  },
  rebuild: { onStale: true },
}"#
            .into(),
            false,
        ));
    }
}
