//! Explicit upgrade effects share setup/recovery singleflight gates.
use super::*;
use hack_desktop_core::upgrade::State;
impl HackApp {
    pub fn show_upgrade_now(&mut self, flow: hack_desktop_core::upgrade::Flow) {
        self.upgrade = flow;
        self.pane = Pane::Upgrade;
    }
    pub fn open_upgrade(&mut self, cx: &mut Context<Self>) {
        self.pane = Pane::Upgrade;
        cx.notify();
    }
    fn upgrade_gated(&self) -> bool {
        self.upgrade.busy
            || self.setup.action_busy
            || self.setup.loading
            || self.recovery_busy
            || !self.action_started.is_empty()
            || (self.live && !self.setup.report.cli_ready())
    }
    pub fn review_upgrade(&mut self, cx: &mut Context<Self>) {
        if self.upgrade_gated() {
            return;
        }
        if !self.live {
            self.upgrade.message = Some("Fixture: no CLI read executed".into());
            cx.notify();
            return;
        }
        self.upgrade.begin(State::Checking);
        let source = self.source.clone();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { source.upgrade_check() })
                .await;
            let _ = this.update(cx, |this, cx| {
                match result {
                    Ok(observation) => this.upgrade.checked(observation),
                    Err(e) => {
                        this.upgrade.busy = false;
                        this.upgrade.state = State::Unknown;
                        this.upgrade.observation.report = None;
                        this.upgrade.message = Some(e);
                    }
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
    pub fn save_upgrade_files(&mut self, cx: &mut Context<Self>) {
        if self.upgrade_gated() || !self.upgrade.can_snapshot() {
            return;
        }
        if !self.live {
            self.upgrade.message = Some("Fixture: no files written".into());
            cx.notify();
            return;
        }
        // Invalidate any previous receipt before a new write is attempted.
        self.upgrade.snapshot = None;
        self.upgrade.begin(State::Snapshotting);
        let source = self.source.clone();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { source.upgrade_snapshot() })
                .await;
            let _ = this.update(cx, |this, cx| {
                match result {
                    Ok(s) => this.upgrade.saved(s),
                    Err(e) => this.upgrade.failed(e),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
    pub fn run_upgrade_terminal(&mut self, cx: &mut Context<Self>) {
        if self.upgrade_gated() || !self.upgrade.can_upgrade() {
            return;
        }
        if !self.live {
            self.upgrade.message = Some("Fixture: no terminal opened".into());
            cx.notify();
            return;
        }
        let source = self.source.clone();
        let expected_cli = self.upgrade.observation.cli_program.clone();
        self.upgrade.begin(State::Applying);
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    use hack_desktop_core::terminal::{
                        Platform, Script, SystemLauncher, linux_adapter,
                    };
                    if source.cli_program()? != expected_cli {
                        return Err("The selected CLI changed. Review readiness again.".into());
                    }
                    let adapter = linux_adapter();
                    let platform = if cfg!(target_os = "macos") {
                        Platform::Mac
                    } else {
                        Platform::Linux
                    };
                    Script::create_sequence(
                        &std::env::temp_dir(),
                        &hack_desktop_core::upgrade::homebrew_commands(),
                    )?
                    .open(platform, adapter.as_deref(), &SystemLauncher)
                })
                .await;
            let _ = this.update(cx, |this, cx| {
                match result {
                    Ok(()) => this.upgrade.handed_off(),
                    Err(e) => this.upgrade.failed(e),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
    pub fn rollback_upgrade_files(&mut self, cx: &mut Context<Self>) {
        if self.upgrade_gated() || !self.upgrade.can_rollback() {
            return;
        }
        if !self.live {
            self.upgrade.message = Some("Fixture: no files restored".into());
            cx.notify();
            return;
        }
        let Some(snapshot) = self.upgrade.snapshot.clone() else {
            return;
        };
        self.upgrade.begin(State::RollingBack);
        let source = self.source.clone();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { source.upgrade_rollback(&snapshot) })
                .await;
            let _ = this.update(cx, |this, cx| {
                match result {
                    Ok(result) => this.upgrade.rolled_back(result),
                    Err(e) => this.upgrade.failed(e),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
    pub fn restart_upgrade_daemon(&mut self, cx: &mut Context<Self>) {
        if self.upgrade_gated() || self.upgrade.previous.is_none() {
            return;
        }
        if !self.live {
            self.upgrade.message = Some("Fixture: no daemon restarted".into());
            cx.notify();
            return;
        }
        // Shared recovery gate; no automatic restart and no auto-starting poll.
        self.recovery_busy = true;
        self.upgrade.begin(State::Restarting);
        let source = self.source.clone();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    source.recover_daemon(DaemonRecovery::Restart)?;
                    source.upgrade_check()
                })
                .await;
            let _ = this.update(cx, |this, cx| {
                this.recovery_busy = false;
                match result {
                    Ok(observation) => {
                        let matches =
                            observation.cli.is_some() && observation.daemon == observation.cli;
                        this.upgrade.checked(observation);
                        if !matches {
                            this.upgrade.failed(
                                "hackd still differs from the CLI or could not be read".into(),
                            );
                        }
                    }
                    Err(e) => this.upgrade.failed(e),
                }
                this.refresh_now_async(cx);
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
}
