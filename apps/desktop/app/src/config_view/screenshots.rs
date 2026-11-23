//! Render each Config frame using the app's actual component and synthetic
//! config. No user's checkout, env or runtime is read for these screenshots.

use std::{path::Path, sync::Arc};

use gpui_kit::{
    AppContext as _, Bounds, HeadlessAppContext, WindowBounds, WindowOptions,
    component::{Theme, ThemeMode},
    px, size,
    test::TestWindowExt as _,
};
use hack_desktop_core::{
    config::{ConfigReport, ConfigSaved, ConfigState, ConfigValidation},
    fixtures::{self, Fixture},
};
use serde_json::{Value, json};

use super::{ConfigChange, Selection, TAB, View};
use crate::view::HackApp;

const FILES: [(&str, &str, &str, &str, bool); 7] = [
    (
        "1",
        "/work/storefront-search/.hack/hack.config.json",
        "project",
        "shared",
        true,
    ),
    (
        "2",
        "/work/storefront-search/.hack/docker-compose.yml",
        "compose",
        "shared",
        true,
    ),
    (
        "3",
        "/work/storefront-search/.hack/hack.env.default.yaml",
        "env",
        "shared",
        true,
    ),
    (
        "3:qa",
        "/work/storefront-search/.hack/hack.env.qa.yaml",
        "env",
        "shared",
        false,
    ),
    (
        "4",
        "/work/storefront/.hack/hack.env.local.yaml",
        "env",
        "local",
        false,
    ),
    (
        "5",
        "/work/storefront-search/.hack/hack.env.local.yaml",
        "env",
        "local",
        true,
    ),
    (
        "6",
        "/work/storefront-search/.hack/.branch/compose.feature-search.override.yml",
        "branch",
        "generated",
        false,
    ),
];

const COMPOSE: &str = r#"name: storefront
services:
  api:
    image: storefront-api:dev
    labels:
      caddy: "api.storefront.hack, api.shop.hack"
      caddy.reverse_proxy: "{{upstreams 3000}}"
    depends_on: [db]
  db:
    image: postgres:17
    environment:
      POSTGRES_DB: shop
  web:
    image: storefront-web:dev
"#;

fn env(key: &str, scope: &str, values: &[(&str, &str)]) -> Value {
    json!({
        "key": key, "scope": scope, "winning": values.last().map(|pair| pair.0),
        "values": values.iter().map(|(layer, value)| json!({"layer":layer,"secret":false,"value":value})).collect::<Vec<_>>(),
    })
}

fn service(
    name: &str,
    image: &str,
    port: u16,
    dependencies: &[&str],
    base_host: &str,
    host: &str,
) -> Value {
    let routes = if host.is_empty() {
        json!([])
    } else {
        json!([{"host":host,"port":port,"tls":true,"from":["2","6"]}])
    };
    json!({
        "name": name, "image": image, "ports": [port], "depends_on": dependencies, "routes": routes,
        "route_edit": {"sites":base_host,"port":port},
    })
}

fn report() -> ConfigReport {
    let layers: Vec<_> = FILES
        .iter()
        .map(|(id, file, kind, ownership, writable)| {
            json!({
                "id": id, "file": file, "kind": kind, "ownership": ownership, "writable": writable,
                "active": *id != "3:qa", "revision": "fixture", "exists": true,
                "source": (*id == "2").then_some(COMPOSE), "hidden": false,
                "source_writable": *id == "2", "inherited": *id == "4",
                "overlay": (*id == "3:qa").then_some("qa"),
            })
        })
        .collect();
    serde_json::from_value(json!({
        "state":"ready", "checkout":"/work/storefront-search", "branch":"feature-search",
        "overlay":null, "overlays":["qa"], "writable":true, "issues":[], "layers":layers,
        "project":{"name":"storefront","dev_host":"storefront.hack","internal":{"dns":true,"tls":true}},
        "services":[
            service("web","storefront-web:dev",3000,&["api"],"storefront.hack","feature-search.storefront.hack"),
            service("api","storefront-api:dev",3000,&["db"],"api.storefront.hack","api.feature-search.storefront.hack"),
            service("db","postgres:17",5432,&[],"",""),
            service("worker","storefront-worker:dev",9000,&["db"],"",""),
        ],
        "env":[
            env("API_BASE_URL","global",&[("3","https://storefront.hack"),("5","https://feature-search.storefront.hack")]),
            env("SEARCH_INDEX","api",&[("3","products"),("4","products_main"),("5","products_fs")]),
            env("LOG_LEVEL","global",&[("3","info"),("4","debug")]),
            env("PORT","api",&[("3","3000")]),
            env("DATABASE_URL","api",&[("3","postgres://db:5432/shop")]),
            {"key":"SERVICE_TOKEN","scope":"api","winning":"3","values":[{"layer":"3","secret":true}]},
            env("FEATURE_FLAGS","global",&[("5","search_v2")]),
        ],
    })).expect("config screenshot fixture")
}

fn setup(app: &mut HackApp, frame: &str) {
    let mut report = report();
    app.tab = TAB;
    app.config.draft.base = report.revisions();
    app.config.selection = Selection {
        root: "/work/storefront-search".into(),
        ..Default::default()
    };
    app.config.service = "api".into();
    app.config.scope = "api".into();
    match frame {
        "m08-map" => app.config.layer = Some("5".into()),
        "m09-edit" => {
            app.config.view = View::Edit;
            app.config.stage(
                "project/dev_host".into(),
                Some(ConfigChange::Project {
                    layer: "1".into(),
                    path: "dev_host".into(),
                    value: json!("storefront hack"),
                }),
            );
            app.config.stage(
                "project/oauth.enabled".into(),
                Some(ConfigChange::Project {
                    layer: "1".into(),
                    path: "oauth.enabled".into(),
                    value: json!(true),
                }),
            );
            app.config.stage(
                "route/api".into(),
                Some(ConfigChange::Route {
                    layer: "2".into(),
                    service: "api".into(),
                    sites: "api.storefront.hack, api.shop.hack".into(),
                    port: "3000".into(),
                }),
            );
            app.config.validation = Some(serde_json::from_value(json!({
                "valid":false, "previews":{}, "issues":[{"layer":"1","path":["dev_host"],"line":2,"code":"E_CONFIG_INVALID","message":"Use letters, digits, dots and dashes, such as storefront.hack."}]
            })).expect("edit fixture validation"));
        }
        "m10-env-layers" => {
            app.config.view = View::Env;
            app.config.active_cell = Some("env/5/api/SEARCH_INDEX".into());
            app.config.stage(
                "env/5/api/SEARCH_INDEX".into(),
                Some(ConfigChange::Env {
                    layer: "5".into(),
                    scope: "api".into(),
                    key: "SEARCH_INDEX".into(),
                    value: Some("products_fs".into()),
                }),
            );
            app.config.validation = Some(ConfigValidation {
                valid: true,
                ..Default::default()
            });
        }
        "m11-source" => {
            let draft = COMPOSE.replace("depends_on: [db]", "depends_on: [db, cache]");
            app.config.view = View::Source;
            app.config.file = "2".into();
            app.config.stage(
                "source/2".into(),
                Some(ConfigChange::Source {
                    layer: "2".into(),
                    text: draft,
                }),
            );
            app.config.validation = Some(serde_json::from_value(json!({
                "valid":false, "previews":{}, "issues":[{"layer":"2","path":["services","api","depends_on"],"line":8,"code":"E_CONFIG_INVALID","message":"depends_on names a service that is not defined: cache"}]
            })).expect("source fixture validation"));
        }
        "m12-saved" => {
            app.config.saved = Some(ConfigSaved {
                changed: vec!["2".into()],
                restart_offered: true,
            })
        }
        "m12-unreadable" => {
            report.state = ConfigState::Invalid;
            report.issues = serde_json::from_value(json!([
                {"layer":"1","path":[],"line":7,"code":"E_CONFIG_PARSE","message":"Expected a valid JSON object."},
            ])).expect("invalid fixture issues");
        }
        "m12-missing" => report = ConfigReport::default(),
        _ => unreachable!(),
    }
    app.config.settle_report(Ok(report));
}

/// Uses the same headless native renderer as the existing desktop fixtures.
pub(crate) fn run(dir: &Path) {
    std::fs::create_dir_all(dir).expect("config screenshot directory");
    let mut cx = HeadlessAppContext::with_platform(
        gpui_kit::platform::current_platform(true).text_system(),
        Arc::new(hack_desktop_ui::icons::Assets),
        gpui_kit::platform::current_headless_renderer,
    );
    cx.update(hack_desktop_ui::tokens::init);
    for (mode, suffix) in [(ThemeMode::Light, "light"), (ThemeMode::Dark, "dark")] {
        cx.update(|cx| Theme::change(mode, None, cx));
        for frame in [
            "m08-map",
            "m09-edit",
            "m10-env-layers",
            "m11-source",
            "m12-saved",
            "m12-unreadable",
            "m12-missing",
        ] {
            let opts = WindowOptions {
                focus: false,
                show: false,
                window_bounds: Some(WindowBounds::Windowed(Bounds {
                    origin: Default::default(),
                    size: size(px(1280.), px(800.)),
                })),
                ..crate::window_options()
            };
            let (handle, _app) = cx
                .update(|cx| {
                    gpui_kit::open_window(opts, cx, |window, cx| {
                        cx.new(|cx| {
                            let fixture = Fixture::Running;
                            let mut app =
                                HackApp::new(crate::source_for(Some(fixture)), false, window, cx);
                            app.select(fixtures::selected(fixture));
                            setup(&mut app, frame);
                            app
                        })
                    })
                })
                .expect("config screenshot window");
            cx.update_window(handle, |_, window, cx| window.render_frame(cx))
                .expect("render config");
            let path = dir.join(format!("{frame}-{suffix}.png"));
            cx.capture_screenshot(handle)
                .expect("capture config")
                .save(&path)
                .expect("save config");
            println!("{}", path.display());
            cx.update_window(handle, |_, window, _| window.remove_window())
                .ok();
        }
    }
}
