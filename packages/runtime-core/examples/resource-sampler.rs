//! Read-only, bounded native sampling without a CLI subprocess per observation.
use hack_runtime_core::provider::resources;
use serde_json::json;
use std::{
    collections::BTreeSet,
    io::Write,
    path::Path,
    time::{Duration, Instant},
};

fn observation_error(error: hack_runtime_core::CandidateError) -> std::io::Error {
    std::io::Error::other(format!("{}: {}", error.code, error.message))
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.len() < 5 || (args.len() - 2) % 3 != 0 || args.len() > 26 {
        return Err("usage: resource-sampler COUNT INTERVAL_MS LABEL PID EXACT_EXECUTABLE [LABEL PID EXACT_EXECUTABLE ...]; 1-8 disjoint roots".into());
    }
    let count: u32 = args[0].parse()?;
    let interval_ms: u64 = args[1].parse()?;
    if !(1..=3600).contains(&count)
        || !(100..=60_000).contains(&interval_ms)
        || u64::from(count) * interval_ms > 3_600_000
    {
        return Err(
            "sampling requires 1-3600 samples, 100-60000 ms cadence and at most one hour".into(),
        );
    }
    let mut labels = BTreeSet::new();
    let mut roots = Vec::new();
    for triple in args[2..].chunks_exact(3) {
        let label = &triple[0];
        if label.is_empty()
            || label.len() > 64
            || !label
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
            || !labels.insert(label.clone())
        {
            return Err(
                "labels must be unique, 1-64 ASCII letters, digits, hyphens or underscores".into(),
            );
        }
        roots.push((
            label.clone(),
            resources::bind(triple[1].parse()?, Path::new(&triple[2]))
                .map_err(observation_error)?,
        ));
    }
    let observer = resources::bind(std::process::id() as i32, &std::env::current_exe()?)
        .map_err(observation_error)?;
    let start = Instant::now();
    let mut out = std::io::BufWriter::new(std::io::stdout().lock());
    serde_json::to_writer(
        &mut out,
        &json!({"kind":"protocol","schema":1,"count":count,"interval_ms":interval_ms,"roots":roots,"observer":observer,"scope":"sequential native trees; excludes exited/reparented processes; memory may share pages; CPU deltas require identical identities; any failed sample exits nonzero"}),
    )?;
    writeln!(out)?;
    out.flush()?;
    for index in 0..count {
        // Absolute deadlines avoid accumulating observer time into the requested cadence.
        let deadline = start + Duration::from_millis(u64::from(index) * interval_ms);
        std::thread::sleep(deadline.saturating_duration_since(Instant::now()));
        let sample_start = start.elapsed().as_micros();
        let mut seen = BTreeSet::new();
        let mut trees = Vec::new();
        for (label, root) in &roots {
            let tree = resources::observe(root).map_err(observation_error)?;
            for process in &tree.processes {
                if process.identity.pid == observer.pid || !seen.insert(process.identity.pid) {
                    return Err("selected trees overlap each other or the observer; no partial sample emitted".into());
                }
            }
            trees.push(json!({"label":label,"tree":tree}));
        }
        let observer_usage = resources::observe(&observer).map_err(observation_error)?;
        serde_json::to_writer(
            &mut out,
            &json!({"kind":"sample","index":index,"start_microseconds":sample_start,"end_microseconds":start.elapsed().as_micros(),"trees":trees,"observer":observer_usage}),
        )?;
        writeln!(out)?;
        out.flush()?;
    }
    serde_json::to_writer(
        &mut out,
        &json!({"kind":"complete","samples":count,"elapsed_microseconds":start.elapsed().as_micros()}),
    )?;
    writeln!(out)?;
    out.flush()?;
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("resource sampler failed: {error}");
        std::process::exit(1);
    }
}
