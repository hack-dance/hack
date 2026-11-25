use gpui_kit::{
    AnyElement, Context, Entity, Window,
    component::{
        Sizable as _,
        input::{Input, InputState},
    },
    div,
    prelude::*,
};
use hack_desktop_core::config_form::{Field, GLOBAL, Kind, PROJECT, Report};
use hack_desktop_ui::{
    components::{StyledExt as _, Ui, action_button, pill_tab},
    icons::Glyph,
    tokens::{space, text},
};
use std::path::PathBuf;

use crate::{doctor_view::Pane, view::HackApp};

pub(crate) struct Configuration {
    pub(crate) input: Entity<InputState>,
    global: bool,
    field: usize,
    generation: u64,
    saved: bool,
    save_error: Option<&'static str>,
    busy: bool,
    result: Option<Result<Report, &'static str>>,
}

impl Configuration {
    pub(crate) fn new(input: Entity<InputState>) -> Self {
        Self {
            input,
            global: false,
            field: 0,
            generation: 0,
            saved: false,
            save_error: None,
            busy: false,
            result: None,
        }
    }

    pub(crate) fn clear_feedback(&mut self) {
        self.saved = false;
        self.save_error = None;
    }

    pub(crate) fn invalidate_project(&mut self) {
        if !self.global {
            self.invalidate();
        }
    }

    fn fields(&self) -> &'static [Field] {
        if self.global { GLOBAL } else { PROJECT }
    }

    pub(crate) fn invalidate(&mut self) {
        self.generation += 1;
        self.result = Some(Err("Check again to read this setting."));
        self.clear_feedback();
    }
}

impl HackApp {
    pub(crate) fn open_configuration(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.pane = Pane::Configuration;
        self.user_navigated();
        if self.selected_root().is_none() {
            self.configuration.global = true;
            self.configuration.field = 0;
        }
        self.load_configuration(window, cx);
    }

    fn load_configuration(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.configuration.invalidate();
        self.configuration.result = None;
        let selection = self.configuration.generation;
        let option = self.configuration.fields()[self.configuration.field];
        self.configuration
            .input
            .update(cx, |input, cx| input.set_value("", window, cx));
        let root = if self.configuration.global {
            None
        } else {
            let Some((root, _)) = self
                .selected_root()
                .filter(|_| self.model.project_list_readable())
            else {
                self.configuration.result = Some(Err("Select a project with a known checkout."));
                cx.notify();
                return;
            };
            Some(root)
        };
        let source = self.source.pinned().unwrap_or_else(|| self.source.clone());
        cx.spawn_in(window, async move |this, cx| {
            let report = cx
                .background_executor()
                .spawn(async move { source.config_read(root.as_deref(), option) })
                .await;
            let _ = this.update_in(cx, |this, window, cx| {
                if this.configuration.generation == selection {
                    this.apply_configuration(report, window, cx);
                }
            });
        })
        .detach();
        cx.notify();
    }

    fn apply_configuration(
        &mut self,
        report: Result<Report, &'static str>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Ok(report) = &report {
            let value = report.current.clone().unwrap_or_default();
            self.configuration
                .input
                .update(cx, |input, cx| input.set_value(value, window, cx));
        }
        self.configuration.result = Some(report);
        cx.notify();
    }

    fn save_configuration(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.configuration.busy || !self.live {
            return;
        }
        let Some(Ok(report)) = &self.configuration.result else {
            return;
        };
        let option = self.configuration.fields()[self.configuration.field];
        let input = self.configuration.input.read(cx).value().to_string();
        if option.parse(&input).is_err() {
            return;
        }
        let report = report.clone();
        let source = self.source.pinned().unwrap_or_else(|| self.source.clone());
        let selection = self.configuration.generation;
        self.configuration.busy = true;
        self.configuration.clear_feedback();
        cx.spawn_in(window, async move |this, cx| {
            let refreshed = cx
                .background_executor()
                .spawn(async move { source.config_write(&report, option, &input) })
                .await;
            let _ = this.update_in(cx, |this, window, cx| {
                this.configuration.busy = false;
                if this.configuration.generation == selection {
                    match refreshed {
                        Ok(report) => {
                            let project = report.root.is_some();
                            this.apply_configuration(Ok(report), window, cx);
                            this.configuration.saved = true;
                            if project {
                                this.reset_changes(cx);
                            }
                        }
                        Err(why) => this.configuration.save_error = Some(why),
                    }
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    pub(crate) fn render_configuration(&self, ui: &Ui, cx: &mut Context<Self>) -> AnyElement {
        let p = ui.p;
        let c = &self.configuration;
        let scope = div()
            .flex()
            .gap(space::S3)
            .children([false, true].into_iter().map(|global| {
                pill_tab(
                    ("config-scope", usize::from(global)),
                    if global { "Global" } else { "Project" },
                    c.global == global,
                    ui,
                )
                .on_click(cx.listener(move |this, _, window, cx| {
                    if !this.configuration.busy && this.configuration.global != global {
                        this.configuration.global = global;
                        this.configuration.field = 0;
                        this.load_configuration(window, cx);
                    }
                }))
            }));
        let choices =
            div()
                .flex()
                .flex_wrap()
                .gap(space::S3)
                .children(c.fields().iter().enumerate().map(|(index, field)| {
                    pill_tab(("config-field", index), field.label, c.field == index, ui).on_click(
                        cx.listener(move |this, _, window, cx| {
                            if !this.configuration.busy && this.configuration.field != index {
                                this.configuration.field = index;
                                this.load_configuration(window, cx);
                            }
                        }),
                    )
                }));
        let field = c.fields()[c.field];
        let value = c.input.read(cx).value().to_string();
        let (notice, argv) = match &c.result {
            None => ("Reading setting…", None),
            Some(Err(why)) => (*why, None),
            Some(Ok(report)) => match report.command(field, &value) {
                Ok(command) => (
                    if c.saved { "Saved and verified" } else { "" },
                    Some(command),
                ),
                Err(why) => (why, None),
            },
        };
        let names: Vec<String> = match field.kind {
            Kind::Options(options) => options.iter().map(|v| (*v).to_owned()).collect(),
            Kind::Overlay => c
                .result
                .as_ref()
                .and_then(|r| r.as_ref().ok())
                .map(|r| r.names.clone())
                .unwrap_or_default(),
            Kind::Address => vec![],
        };
        let suggestions = div().flex().flex_wrap().gap(space::S3).children(
            names
                .into_iter()
                .filter(|name| name.contains(value.trim()))
                .enumerate()
                .map(|(i, name)| {
                    pill_tab(("config-value", i), name.clone(), name == value, ui).on_click(
                        cx.listener(move |this, _, window, cx| {
                            if !this.configuration.busy {
                                this.configuration.input.update(cx, |input, cx| {
                                    input.set_value(name.clone(), window, cx)
                                });
                            }
                        }),
                    )
                }),
        );
        let notice = c.save_error.unwrap_or(notice);
        let enabled = argv.is_some() && !c.busy && self.live;
        let mut save = action_button(
            "save-setting",
            Glyph::Check,
            if c.busy { "Saving…" } else { "Save" },
            enabled,
            ui,
        );
        if enabled {
            save = save
                .on_click(cx.listener(|this, _, window, cx| this.save_configuration(window, cx)));
        }
        div()
            .id("configuration-form")
            .flex_1()
            .min_h_0()
            .min_w_0()
            .overflow_y_scroll()
            .px(space::S8)
            .py(space::S6)
            .flex()
            .flex_col()
            .gap(space::S5)
            .type_step(text::BODY)
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(space::S5)
                    .child(div().type_step(text::TITLE).child("Configuration"))
                    .child(
                        action_button(
                            "refresh-config",
                            Glyph::Restart,
                            "Check again",
                            self.live && !c.busy,
                            ui,
                        )
                        .on_click(cx.listener(|this, _, window, cx| {
                            if this.live && !this.configuration.busy {
                                this.load_configuration(window, cx);
                            }
                        })),
                    ),
            )
            .child(scope)
            .children(
                (!c.global)
                    .then(|| self.model.selected_key().map(|key| key.project))
                    .flatten(),
            )
            .child(choices)
            .child(
                div()
                    .type_step(text::SMALL)
                    .text_color(p.text_secondary)
                    .child(field.key),
            )
            .child(
                Input::new(&c.input)
                    .small()
                    .disabled(c.busy || c.result.is_none()),
            )
            .child(suggestions)
            .children(argv.map(|command| {
                div()
                    .type_step(text::MONO)
                    .font_family(ui.mono.clone())
                    .child(command)
            }))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(space::S5)
                    .child(save)
                    .child(notice),
            )
            .into_any_element()
    }

    pub(crate) fn show_configuration_fixture(
        &mut self,
        name: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.pane = Pane::Configuration;
        match name {
            "config-loading" => return,
            "config-error" => {
                self.configuration.result = Some(Err("Could not read this setting"));
                return;
            }
            _ => {}
        }
        let global = matches!(name, "config-global" | "config-invalid" | "config-saved");
        self.configuration.global = global;
        self.configuration.field = if global { 2 } else { 0 };
        let report = Ok(Report {
            executable: PathBuf::from("hack-next"),
            root: (!global).then(|| PathBuf::from("/work/storefront")),
            current: Some(if global { "127.0.0.1" } else { "stag" }.into()),
            names: vec!["dev".into(), "staging".into(), "staging-local".into()],
        });
        self.apply_configuration(report, window, cx);
        self.configuration.saved = name == "config-saved";
        if name == "config-invalid" {
            self.configuration
                .input
                .update(cx, |input, cx| input.set_value("local", window, cx));
        }
    }
}
