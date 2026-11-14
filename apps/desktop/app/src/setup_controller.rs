//! Setup controller; blocking adapters always run off the UI thread.
use super::*;

impl HackApp {
    pub fn show_setup_now(&mut self, report: hack_desktop_core::setup::Report) {
        self.pane = Pane::Setup;
        let generation = self.setup.begin();
        self.setup.finish(generation, report);
    }
    pub fn open_setup(&mut self, cx: &mut Context<Self>) {
        self.pane = Pane::Setup;
        self.load_setup(cx);
    }
    pub fn load_setup(&mut self, cx: &mut Context<Self>) {
        if self.setup.loading {
            self.setup.refresh_again = true;
            return;
        }
        if self.setup.action_busy || self.recovery_busy || self.upgrade.busy {
            return;
        }
        let generation = self.setup.begin();
        if !self.live {
            self.setup.finish(generation, self.source.setup());
            cx.notify();
            return;
        }
        let source = self.source.clone();
        cx.spawn(async move |this, cx| {
            let report = cx
                .background_executor()
                .spawn(async move { source.setup() })
                .await;
            let _ = this.update(cx, |this, cx| {
                let needed = report.needed();
                this.setup.finish(generation, report);
                if this.setup.refresh_again {
                    this.setup.refresh_again = false;
                    this.load_setup(cx);
                }
                if this.setup_initial {
                    this.setup_initial = false;
                    this.pane = if needed { Pane::Setup } else { Pane::Project };
                }
                // Losing the CLI always restores the required setup gate.
                if !this.setup.report.cli_ready() {
                    this.pane = Pane::Setup;
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
    pub fn skip_setup(&mut self, id: &str, cx: &mut Context<Self>) {
        self.setup.skip(id);
        cx.notify();
    }
    pub fn finish_setup(&mut self, cx: &mut Context<Self>) {
        if self.setup.report.cli_ready()
            && !self.setup.loading
            && !self.setup.action_busy
            && !self.recovery_busy
            && !self.upgrade.busy
        {
            self.pane = Pane::Project;
            cx.notify();
        }
    }
    pub fn run_setup_action(
        &mut self,
        action: hack_desktop_core::setup::SafeAction,
        cx: &mut Context<Self>,
    ) {
        use hack_desktop_core::setup::{Remedy, Status};
        if self.recovery_busy
            || self.upgrade.busy
            || self.setup.loading
            || self.setup.action_busy
            || !self.setup.report.cli_ready()
            || !self
                .setup
                .report
                .cards
                .iter()
                .any(|c| c.remedy == Remedy::Run(action) && c.status != Status::Passed)
        {
            return;
        }
        if !self.live {
            self.setup.result = Some("Fixture: no action executed".into());
            cx.notify();
            return;
        }
        self.setup.action_busy = true;
        let source = self.source.clone();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { source.setup_action(action) })
                .await;
            let _ = this.update(cx, |this, cx| {
                this.setup.action_busy = false;
                this.setup.result = Some(result);
                this.refresh_now_async(cx);
                this.load_setup(cx);
            });
        })
        .detach();
        cx.notify();
    }
    pub fn open_setup_terminal(&mut self, args: Vec<String>, cx: &mut Context<Self>) {
        use hack_desktop_core::terminal::{
            CommandSpec, Platform, Script, SystemLauncher, linux_adapter,
        };
        if !self.live {
            self.setup.result = Some("Fixture: no terminal opened".into());
            cx.notify();
            return;
        }
        if self.recovery_busy
            || self.upgrade.busy
            || self.setup.loading
            || self.setup.action_busy
            || !self.setup.report.cli_ready()
            || !self
                .setup
                .report
                .cards
                .iter()
                .any(|c| c.remedy == hack_desktop_core::setup::Remedy::Admin(args.clone()))
        {
            return;
        }
        self.setup.action_busy = true;
        let source = self.source.clone();
        cx.spawn(async move |this, cx| {
            let result = cx.background_executor().spawn(async move {
                let spec = CommandSpec { program: source.cli_program()?, args };
                let adapter = linux_adapter();
                if !cfg!(target_os = "macos") && adapter.is_none() {
                    return Err("xdg-terminal-exec unavailable; use Copy command".into());
                }
                let platform = if cfg!(target_os = "macos") { Platform::Mac } else { Platform::Linux };
                Script::create(&std::env::temp_dir(), &spec)?.open(platform, adapter.as_deref(), &SystemLauncher)
            }).await;
            let _ = this.update(cx, |this, cx| {
                this.setup.action_busy = false;
                this.setup.result = Some(match result {
                    Ok(()) => "Terminal hand-off requested. Press Enter there, then Check again; launch does not prove setup.".into(),
                    Err(e) => e,
                });
                cx.notify();
            });
        }).detach();
        cx.notify();
    }
}
