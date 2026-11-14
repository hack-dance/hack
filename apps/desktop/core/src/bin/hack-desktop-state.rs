//! `hack-desktop-state`: a headless check of the desktop app's live data
//! path. It reads exactly what the window reads (`LiveSource::from_env`
//! then `Source::snapshot`: hackd when its version matches the CLI,
//! plus native `ps` for native projects), applies the
//! result to the same view model, and prints the list and every project's
//! detail view as JSON.
//!
//! Read-only: it runs no action, opens no window and writes nothing.
//! Without a matching daemon it reports Unknown / needs R18 rather than
//! invoking today's registry-writing `hack projects` fallback.
//!
//! ```text
//! hack-desktop-state [--project <name>] [--compact]
//! ```

use std::time::Instant;

use hack_desktop_core::source::{LiveSource, Source};
use hack_desktop_core::viewmodel::{AppModel, Event};
use serde_json::{Value, json};

fn usage() -> ! {
    eprintln!("usage: hack-desktop-state [--project <name>] [--compact]");
    std::process::exit(2)
}

fn main() {
    let mut project: Option<String> = None;
    let mut compact = false;
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--project" => project = Some(args.next().unwrap_or_else(|| usage())),
            "--compact" => compact = true,
            _ => usage(),
        }
    }

    let source = LiveSource::from_env();
    let started = Instant::now();
    let snap = source.snapshot();
    let read_ms = started.elapsed().as_millis();

    let source_info = match &snap {
        Ok(s) => json!({
            "ok": true,
            "cli_version": s.cli_version,
            "daemon": s.daemon,
            "daemon_version_mismatch": s.daemon_mismatch(),
            "runtime_ok": s.projects.runtime_ok,
            "runtime_error": s.projects.runtime_error,
            "project_count": s.projects.projects.len(),
        }),
        Err(e) => json!({ "ok": false, "error": format!("{e:?}") }),
    };

    let mut model = AppModel::new();
    model.apply(Event::Refreshed(snap));
    let list = model.list();

    let names: Vec<String> = match &project {
        Some(p) => vec![p.clone()],
        None => list
            .running
            .iter()
            .chain(list.stopped.iter())
            .map(|r| r.name.clone())
            .collect(),
    };
    let details: Vec<Value> = names
        .iter()
        .map(|name| {
            model.apply(Event::Select(name.clone()));
            match model.detail() {
                Some(d) if d.name == *name => serde_json::to_value(d).unwrap_or(Value::Null),
                _ => json!({ "name": name, "error": "no such project in the snapshot" }),
            }
        })
        .collect();

    let out = json!({
        "read_ms": read_ms,
        "source": source_info,
        "list": list,
        "details": details,
    });
    let text = if compact {
        serde_json::to_string(&out)
    } else {
        serde_json::to_string_pretty(&out)
    };
    println!("{}", text.unwrap_or_default());
}
