//! Stats tab body (HACK-2595 m05) and its app-owned, read-only sampler.

use std::time::Instant;

use gpui_kit::{AnyElement, Div, FontWeight, IntoElement, div, prelude::*, px, relative};
use hack_desktop_core::models::{Container, ProjectRow};
use hack_desktop_core::state::ServiceView;
use hack_desktop_core::stats::{
    HISTORY_WINDOW, MemoryLimit, SAMPLE_INTERVAL, SampleClock, ServiceKey, StatsHistory,
    StatsPoint, has_running_services,
};
use hack_desktop_core::usage;
use hack_desktop_core::viewmodel::DetailView;
use hack_desktop_ui::components::{StyledExt as _, Ui, dot, icon_button};
use hack_desktop_ui::icons::Glyph;
use hack_desktop_ui::status::Status;
use hack_desktop_ui::tokens::{radius, size, space, text};

use crate::doctor_view::Pane;
use crate::view::HackApp;

const BAR_COUNT: usize = 24;
const BAR_HEIGHT: f32 = 36.0;

#[derive(Default)]
pub(crate) struct ServiceStats {
    pub history: StatsHistory,
    attempted_at: Option<Instant>,
    in_flight: bool,
    sample_failed: bool,
}

impl HackApp {
    /// Share the usage tick, with one machine-wide sample in flight.
    /// Running services are collected even when the window is hidden.
    pub(crate) fn read_stats_if_due(&mut self, cx: &mut gpui_kit::Context<Self>) {
        let now = Instant::now();
        self.stats.history.prune(now);
        if self.stats.in_flight
            || self
                .stats
                .attempted_at
                .is_some_and(|at| now - at < SAMPLE_INTERVAL)
            || !self.model.project_list_readable()
            || !self.model.snapshot().is_some_and(|s| {
                !s.projects.engine_down()
                    && (has_running_services(&s.projects) || self.stats_visible())
            })
        {
            return;
        }
        self.stats.attempted_at = Some(now);
        self.stats.in_flight = true;
        let epoch = self.model.source_epoch();
        let source = self.source.pinned().unwrap_or_else(|| self.source.clone());
        cx.spawn(async move |this, cx| {
            let (report, sampled_at) = cx
                .background_executor()
                .spawn(async move {
                    let began = SampleClock::now();
                    let mut report = source.stats_sample();
                    let received = SampleClock::now();
                    let observed = report
                        .as_mut()
                        .map_or(received.instant, |r| r.anchor_time(began, received));
                    (report, observed)
                })
                .await;
            let _ = this.update(cx, |this, cx| {
                this.stats.in_flight = false;
                if this.model.source_epoch() != epoch || !this.model.project_list_readable() {
                    return;
                }
                if let Some(snapshot) = this.model.snapshot() {
                    this.stats.sample_failed = report.is_err();
                    this.stats.history.record(
                        &snapshot.projects,
                        &report.unwrap_or_default(),
                        sampled_at,
                    );
                    cx.notify();
                }
            });
        })
        .detach();
    }

    fn stats_visible(&self) -> bool {
        self.window_visible
            && self.pane == Pane::Project
            && self.selected_service().is_some()
            && self.service_pane.tab == crate::service_view::ServiceTab::Stats
            && self
                .model
                .selected_row()
                .is_some_and(|row| !row.is_native())
    }

    pub(crate) fn reset_stats_source(&mut self) {
        // The previous source's in-flight read releases the slot itself.
        self.stats.history = StatsHistory::default();
        self.stats.attempted_at = None;
        self.stats.sample_failed = false;
    }

    /// Service-pane integration: render this for the selected service inside
    /// the Stats tab. The caller owns service navigation and the tab strip.
    pub(crate) fn service_stats_tab(
        &self,
        detail: &DetailView,
        service: &ServiceView,
        ui: &Ui,
        cx: &mut gpui_kit::Context<Self>,
    ) -> impl IntoElement {
        let row = self.model.selected_row();
        let key = row.as_ref().and_then(|row| {
            ServiceKey::new(detail.key.clone(), row, row.runtime.as_ref(), &service.name)
        });
        let now = Instant::now();
        let points: Vec<_> = key
            .iter()
            .flat_map(|key| self.stats.history.points(key, now))
            .collect();
        let readable = self.model.project_list_readable()
            && self
                .model
                .snapshot()
                .is_some_and(|s| !s.projects.engine_down());
        let current = key
            .as_ref()
            .filter(|_| readable && service.running)
            .zip(row.as_ref().and_then(|row| row.runtime.as_ref()))
            .and_then(|(key, runtime)| self.stats.history.current(key, runtime, now));
        let status = if row.as_ref().is_some_and(ProjectRow::is_native) {
            "Usage is available for Compose services"
        } else if !readable {
            "Usage is unavailable"
        } else if !service.created {
            "Service has not been created"
        } else if !service.running {
            "Service is stopped"
        } else if self.stats.sample_failed {
            "Usage could not be read"
        } else if current.is_none() {
            "Waiting for a usage sample"
        } else {
            "Last 10 min"
        };
        div()
            .id("service-stats-body")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .pb(space::S5)
            .child(cards(&points, current, status, now, ui))
            .child(service_info(row.as_ref(), service, ui, cx))
    }
}

fn cards(
    points: &[&StatsPoint],
    current: Option<&StatsPoint>,
    status: &str,
    now: Instant,
    ui: &Ui,
) -> Div {
    let cpu = current.and_then(|p| p.cpu_percent);
    let peak = points.iter().filter_map(|p| p.cpu_percent).reduce(f64::max);
    let cpu_detail = peak.map_or_else(
        || "% of 1 core".to_owned(),
        |value| format!("% of 1 core · peak {value:.0}%"),
    );
    let cpu_card = card(
        "CPU",
        &cpu.map_or_else(|| "—".into(), |v| format!("{v:.1}")),
        &cpu_detail,
        bars(bucket(points, now, |p| p.cpu_percent), 40.0, 1.23, true, ui),
        note(status, ui),
        ui,
    );

    let limit = current.map_or(MemoryLimit::Unknown, |p| p.memory_limit);
    let (memory, unit) = byte_value(current.and_then(|p| p.memory_bytes), false);
    let limit_note = match limit {
        MemoryLimit::Bytes(n) => format!("of {} limit", usage::bytes(n)),
        MemoryLimit::Unlimited => "· No Compose limit".into(),
        MemoryLimit::Unknown => "· Compose limit unavailable".into(),
    };
    let limit_meter = current.and_then(|p| {
        let MemoryLimit::Bytes(limit) = p.memory_limit else {
            return None;
        };
        Some((byte_float(p.memory_bytes?) / byte_float(limit)).min(1.0))
    });
    let memory_card = card(
        "MEMORY",
        &memory,
        &format!("{unit} {limit_note}"),
        bars(
            bucket(points, now, |p| p.memory_bytes.map(byte_float)),
            1.0,
            1.23,
            false,
            ui,
        ),
        limit_meter.map_or_else(|| div().h(space::S2), |fraction| meter(fraction, ui)),
        ui,
    );

    let (network, net_unit) = byte_value(
        current.and_then(|p| p.net_in_per_second).map(rate_bytes),
        true,
    );
    let out = current.and_then(|p| p.net_out_per_second).map(rate_bytes);
    let net_detail = format!(
        "{net_unit} in · {} out",
        out.map_or_else(|| "—".into(), |n| format!("{}/s", usage::bytes(n)))
    );
    let disk = current.and_then(|p| p.disk_per_second).map(rate_bytes);
    let written = current.and_then(|p| p.disk_written_bytes);
    let disk_detail = match (disk, written) {
        (Some(rate), Some(total)) => format!(
            "Disk {}/s · {} written",
            usage::bytes(rate),
            usage::bytes(total)
        ),
        (None, Some(total)) => format!("Disk · {} written", usage::bytes(total)),
        _ => "Disk —".to_owned(),
    };
    let network_card = card(
        "NETWORK",
        &network,
        &net_detail,
        bars(
            bucket(points, now, |p| p.network_per_second),
            1.0,
            2.5,
            true,
            ui,
        ),
        note(&disk_detail, ui),
        ui,
    );

    div()
        .flex()
        .gap(space::S6)
        .child(cpu_card)
        .child(memory_card)
        .child(network_card)
}

fn card(label: &str, value: &str, detail: &str, chart: Div, footer: Div, ui: &Ui) -> Div {
    div()
        .min_w_0()
        .flex_1()
        .flex()
        .flex_col()
        .justify_between()
        .min_h(px(150.))
        .p(space::S6)
        .hairline(ui.p.border_strong)
        .rounded(radius::PANEL)
        .child(
            div().child(section_heading(label, ui)).child(
                div()
                    .pt(space::S5)
                    .flex()
                    .flex_wrap()
                    .items_baseline()
                    .gap_x(space::S2)
                    .child(
                        div()
                            .font_family(ui.mono.clone())
                            .text_size(px(23.))
                            .line_height(px(28.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(ui.p.text_primary)
                            .child(value.to_owned()),
                    )
                    .child(
                        div()
                            .type_step(text::SMALL)
                            .text_color(ui.p.text_secondary)
                            .child(detail.to_owned()),
                    ),
            ),
        )
        .child(
            div().pt(space::S4).child(chart).child(
                div()
                    .pt(space::S4)
                    .child(div().min_h(text::SMALL.line).child(footer)),
            ),
        )
}

fn section_heading(label: &str, ui: &Ui) -> Div {
    div()
        .type_step(text::MICRO)
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(ui.p.text_secondary)
        .child(label.to_owned())
}

fn note(text: &str, ui: &Ui) -> Div {
    div()
        .type_step(text::SMALL)
        .text_color(ui.p.text_secondary)
        .child(text.to_owned())
}

/// The maximum in each 25-second slot keeps short spikes visible; unmeasured
/// slots keep their horizontal space so an incomplete window reads as a gap.
fn bucket(
    points: &[&StatsPoint],
    now: Instant,
    value: impl Fn(&StatsPoint) -> Option<f64>,
) -> [Option<f64>; BAR_COUNT] {
    let mut buckets: [Option<f64>; BAR_COUNT] = [None; BAR_COUNT];
    for point in points {
        let age = now.saturating_duration_since(point.at);
        let index = age.as_secs() / (HISTORY_WINDOW.as_secs() / BAR_COUNT as u64);
        if let Some(slot) = usize::try_from(index)
            .ok()
            .and_then(|i| (BAR_COUNT - 1).checked_sub(i))
            .and_then(|i| buckets.get_mut(i))
            && let Some(value) = value(point)
        {
            *slot = Some(slot.map_or(value, |max| max.max(value)));
        }
    }
    buckets
}

fn bars(
    values: [Option<f64>; BAR_COUNT],
    floor: f64,
    headroom: f64,
    mark_peak: bool,
    ui: &Ui,
) -> Div {
    let max = values.iter().flatten().copied().fold(0.0, f64::max);
    let min = values.iter().flatten().copied().fold(max, f64::min);
    let ceiling = floor.max(max * headroom);
    div()
        .h(px(BAR_HEIGHT))
        .flex()
        .items_end()
        .gap(space::S1)
        .children(values.into_iter().map(|value| {
            div().flex_1().min_w_0().when_some(value, |bar, v| {
                let peak = mark_peak && max > min * 1.5 && v >= max * 0.8;
                #[allow(clippy::cast_possible_truncation)] // scaled to the small chart height
                let height = ((v / ceiling) as f32 * BAR_HEIGHT).max(4.0);
                bar.h(px(height)).rounded_t(space::S1).bg(if peak {
                    ui.p.text_primary
                } else {
                    ui.p.text_muted
                })
            })
        }))
}

fn meter(fraction: f64, ui: &Ui) -> Div {
    #[allow(clippy::cast_possible_truncation)] // fraction is in [0, 1]
    let fill = relative(fraction as f32);
    div().h(space::S2).rounded_full().bg(ui.p.surface_2).child(
        div()
            .w(fill)
            .h_full()
            .rounded_full()
            .bg(ui.p.text_secondary),
    )
}

#[allow(clippy::cast_precision_loss)] // display scale
fn byte_float(bytes: u64) -> f64 {
    bytes as f64
}

#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)] // rates are nonnegative
fn rate_bytes(rate: f64) -> u64 {
    rate.round() as u64
}

fn byte_value(bytes: Option<u64>, per_second: bool) -> (String, String) {
    let Some(bytes) = bytes else {
        return (
            "—".into(),
            if per_second {
                "B/s".into()
            } else {
                String::new()
            },
        );
    };
    let label = usage::bytes(bytes);
    let (number, unit) = label.split_once(' ').unwrap_or((&label, ""));
    (
        number.into(),
        if per_second {
            format!("{unit}/s")
        } else {
            unit.into()
        },
    )
}

fn service_info(
    project: Option<&ProjectRow>,
    service: &ServiceView,
    ui: &Ui,
    cx: &mut gpui_kit::Context<HackApp>,
) -> Div {
    let containers = project
        .and_then(|p| p.runtime.as_ref())
        .and_then(|rt| rt.services.iter().find(|s| s.service == service.name))
        .map_or(&[][..], |s| &s.containers);
    let container = containers
        .iter()
        .find(|c| c.is_running())
        .or_else(|| containers.first());
    let image = container.and_then(|c| c.image.as_deref()).unwrap_or("—");
    let route = service.route.as_deref();
    let url = route.and_then(route_url);
    let port = container.and_then(upstream_port);
    let route_row = div()
        .flex()
        .items_center()
        .gap(space::S4)
        .child(mono(route.unwrap_or("—"), ui))
        .children(port.map(|p| note(&format!("→ :{p}"), ui).flex_none()))
        .child(div().flex_1())
        .children(url.as_ref().map(|u| {
            let url = u.clone();
            icon_button("stats-copy-route", Glyph::Copy, ui)
                .tooltip(|window, cx| {
                    gpui_kit::component::tooltip::Tooltip::new("Copy route").build(window, cx)
                })
                .on_click(cx.listener(move |this, _, _, cx| this.copy_url(url.clone(), cx)))
        }))
        .children(url.map(|url| {
            icon_button("stats-open-route", Glyph::ExternalLink, ui)
                .tooltip(|window, cx| {
                    gpui_kit::component::tooltip::Tooltip::new("Open route").build(window, cx)
                })
                .on_click(move |_, _, cx| cx.open_url(&url))
        }));
    let health = ["unhealthy", "health: starting", "healthy"]
        .into_iter()
        .find(|label| {
            let suffix = format!("({label})");
            containers
                .iter()
                .any(|c| c.is_running() && c.status.ends_with(&suffix))
        });
    let health_row = div()
        .flex()
        .items_center()
        .gap(space::S4)
        .children(health.map(|label| {
            dot(
                match label {
                    "healthy" => Status::Running,
                    "unhealthy" => Status::Failed,
                    _ => Status::Degraded,
                },
                ui,
            )
        }))
        .child(health.unwrap_or("—"));
    let mounts = container.map_or_else(Vec::new, |c| {
        c.mounts
            .iter()
            .map(|m| {
                let source = m.name.as_deref().unwrap_or(&m.source);
                if m.kind == "tmpfs" && source.is_empty() {
                    return format!("tmpfs → {}", m.destination);
                }
                let kind = match (
                    m.kind.as_str(),
                    project.and_then(|p| p.repo_root.as_deref()),
                ) {
                    ("bind", Some(root)) if std::path::Path::new(source).starts_with(root) => {
                        "worktree"
                    }
                    ("bind", _) => "bind",
                    ("volume", _) => "volume",
                    _ => "container",
                };
                let source = if kind == "worktree" {
                    let root = project
                        .and_then(|p| p.repo_root.as_deref())
                        .unwrap_or_default();
                    std::path::Path::new(source)
                        .strip_prefix(root)
                        .ok()
                        .map_or_else(|| source.to_owned(), |path| format!("./{}", path.display()))
                } else {
                    source.to_owned()
                };
                format!("{source} → {} · {kind}", m.destination)
            })
            .collect()
    });
    let mount_row = if mounts.is_empty() {
        mono("—", ui)
    } else {
        div()
            .flex()
            .flex_wrap()
            .gap_x(space::S7)
            .children(mounts.iter().map(|m| mono(m, ui)))
    };
    let ports = container
        .and_then(|c| c.ports.as_deref())
        .filter(|p| !p.is_empty());
    let started = container
        .and_then(Container::uptime)
        .map(|p| format!("{p} ago"));
    let rows: [(&str, AnyElement); 6] = [
        ("Image", mono(image, ui).into_any_element()),
        ("Route", route_row.into_any_element()),
        ("Health", health_row.into_any_element()),
        ("Mounts", mount_row.into_any_element()),
        ("Ports", mono(ports.unwrap_or("—"), ui).into_any_element()),
        (
            "Started",
            div()
                .child(started.unwrap_or_else(|| "—".into()))
                .into_any_element(),
        ),
    ];
    div()
        .pt(space::S9)
        .child(div().pb(space::S4).child(section_heading("INFO", ui)))
        .children(rows.into_iter().enumerate().map(|(i, (label, value))| {
            div()
                .min_h(size::TABLE_ROW)
                .py(space::S2)
                .flex()
                .items_center()
                .type_step(text::BODY)
                .text_color(ui.p.text_primary)
                .when(i > 0, |row| row.hairline_t(ui.p.border))
                .child(
                    div()
                        .w(px(152.0))
                        .flex_none()
                        .text_color(ui.p.text_secondary)
                        .child(label),
                )
                .child(div().flex_1().min_w_0().child(value))
        }))
}

fn mono(label: &str, ui: &Ui) -> Div {
    div()
        .min_w_0()
        .truncate()
        .font_family(ui.mono.clone())
        .type_step(text::MONO)
        .child(label.to_owned())
}

fn route_url(route: &str) -> Option<String> {
    if route.starts_with("https://") || route.starts_with("http://") {
        Some(route.to_owned())
    } else if !route.is_empty()
        && route
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || ".-:".contains(c))
    {
        Some(format!("https://{route}"))
    } else {
        None
    }
}

fn upstream_port(container: &Container) -> Option<u16> {
    let port = container
        .labels
        .get("caddy.reverse_proxy")?
        .strip_prefix("{{upstreams ")?
        .strip_suffix("}}")?;
    port.strip_prefix("http ").unwrap_or(port).parse().ok()
}

#[cfg(feature = "screenshots")]
impl HackApp {
    /// Fill ten minutes through the same history path as live samples.
    pub(crate) fn show_stats_fixture(
        &mut self,
        window: &mut gpui_kit::Window,
        cx: &mut gpui_kit::Context<Self>,
    ) {
        use hack_desktop_core::models::ContainerMount;
        use hack_desktop_core::stats::{ContainerUsage, IoCounterErrorBytes, StatsReport};
        use hack_desktop_core::viewmodel::Event;

        let Some(mut snapshot) = self.model.snapshot().cloned() else {
            return;
        };
        let Some(project) = snapshot
            .projects
            .projects
            .iter_mut()
            .find(|p| p.name == "storefront")
        else {
            return;
        };
        let root = project.repo_root.as_deref().unwrap_or("/work/storefront");
        let Some(container) = project
            .runtime
            .as_mut()
            .and_then(|rt| rt.services.iter_mut().find(|s| s.service == "api"))
            .and_then(|s| s.containers.first_mut())
        else {
            return;
        };
        let fixture_id = Some("fixture-api".to_owned());
        container.id.clone_from(&fixture_id);
        container.image = Some("storefront-api:dev".into());
        container.status = "Up 2 hours (healthy)".into();
        container.ports = Some("3000/tcp".into());
        container.mounts = vec![
            ContainerMount {
                kind: "bind".into(),
                source: root.into(),
                destination: "/app".into(),
                ..ContainerMount::default()
            },
            ContainerMount {
                kind: "tmpfs".into(),
                destination: "/app/tmp".into(),
                ..ContainerMount::default()
            },
        ];
        container
            .labels
            .insert("caddy.reverse_proxy".into(), "{{upstreams 3000}}".into());
        let now = Instant::now();
        let mut received = 1_048_576;
        let mut sent = 1_048_576;
        const KIB: u64 = 1024;
        const MIB: u64 = KIB * KIB;
        let cpu = [
            2.0, 2.2, 1.0, 6.0, 5.0, 1.5, 2.0, 1.6, 17.0, 26.0, 22.0, 7.0, 5.0, 2.0, 1.0, 2.0, 5.5,
            2.0, 1.8, 2.0, 1.5, 1.5, 1.3, 2.1,
        ];
        for slot in 0..120 {
            let bucket = slot / 5;
            let incoming = match bucket {
                4 => 20,
                8 => 29,
                9 => 43,
                10 => 39,
                _ => 12,
            };
            received += incoming * KIB * 5;
            sent += 4 * KIB * 5;
            let report = StatsReport {
                containers: vec![ContainerUsage {
                    container_id: fixture_id.clone(),
                    project: "storefront".into(),
                    service: "api".into(),
                    started_at: Some("fixture start".into()),
                    cpu_percent: Some(cpu[bucket]),
                    mem_used_bytes: Some(if bucket < 7 { 128 * MIB } else { 148 * MIB }),
                    configured_memory_limit_bytes: Some(512 * MIB),
                    net_input_bytes: Some(received),
                    net_output_bytes: Some(sent),
                    block_input_bytes: Some(0),
                    block_output_bytes: Some(1229 * MIB),
                    io_counter_error_bytes: IoCounterErrorBytes {
                        net_input: Some(0),
                        net_output: Some(0),
                        block_input: Some(0),
                        block_output: Some(0),
                    },
                }],
                ..StatsReport::default()
            };
            self.stats.history.record(
                &snapshot.projects,
                &report,
                now - SAMPLE_INTERVAL * (119 - u32::try_from(slot).unwrap_or_default()),
            );
        }
        self.model.apply(Event::Refreshed(Ok(snapshot)));
        if let Some(key) = self.model.selected_key() {
            self.select_service(key, "api".into(), window, cx);
            self.set_service_tab(crate::service_view::ServiceTab::Stats, window, cx);
        }
    }
}
