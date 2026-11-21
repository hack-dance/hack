use super::*;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicU64, Ordering},
};
#[derive(Default)]
struct Memory(Mutex<Vec<String>>);
impl Sink for Memory {
    fn write_line(&self, line: &[u8]) -> bool {
        self.0
            .lock()
            .unwrap()
            .push(String::from_utf8(line.to_vec()).unwrap());
        true
    }
}
#[derive(Default)]
struct Tick(AtomicU64);
impl TimeSource for Tick {
    fn sample(&self) -> Option<(u64, u64)> {
        let n = self.0.fetch_add(100, Ordering::SeqCst);
        Some((1_000_000 + n, 1000 + n))
    }
}
fn setup() -> (Arc<Collector>, Arc<Tick>, Arc<Memory>) {
    let time = Arc::new(Tick::default());
    let sink = Arc::new(Memory::default());
    let collector = Collector::new(
        Config {
            trace: "4bf92f3577b34da6a3ce929d0e0e4736".into(),
            parent: None,
            role: Role::Runtime,
            clock: Clock::Host,
            spawn_mono_us: None,
            service_index_stable: false,
        },
        time.clone(),
        sink.clone(),
    )
    .unwrap();
    (collector, time, sink)
}
fn records(sink: &Memory) -> Vec<Record> {
    sink.0
        .lock()
        .unwrap()
        .iter()
        .map(|s| Record::parse_line(s).unwrap())
        .collect()
}
#[test]
fn disabled_and_enabled_use_the_same_observer_without_global_installation() {
    let (collector, time, sink) = setup();
    let before = time.0.load(Ordering::SeqCst);
    assert_eq!(
        observe(None, Step::VmBoot, None, |id| {
            assert!(id.is_none());
            Err::<(), _>(7)
        }),
        Err(7)
    );
    assert_eq!(time.0.load(Ordering::SeqCst), before);
    assert!(records(&sink).is_empty());
    assert_eq!(
        observe(Some(&collector), Step::VmBoot, None, |id| {
            assert!(id.is_some());
            Err::<(), _>(7)
        }),
        Err(7)
    );
    assert!(time.0.load(Ordering::SeqCst) > before);
    assert_eq!(records(&sink)[0].outcome, Outcome::Error);
}
#[test]
fn nesting_streams_before_parent_finishes_and_reader_is_additive() {
    let (collector, _, sink) = setup();
    observe(Some(&collector), Step::VmEnsure, None, |_| {
        observe(
            Some(&collector),
            Step::VmReattach,
            None,
            |_| Ok::<_, ()>(()),
        )
        .unwrap();
        assert_eq!(records(&sink).len(), 1);
        Ok::<_, ()>(())
    })
    .unwrap();
    let data = records(&sink);
    assert_eq!(data[0].parent.as_ref(), Some(&data[1].span));
    assert_eq!(data[0].step, "vm.reattach");
    assert_eq!(data[1].step, "vm.ensure");
    let mut json = serde_json::to_value(&data[0]).unwrap();
    json["new_field"] = serde_json::json!({"future":true});
    json["step"] = "future.step".into();
    json["attrs"]["future_count"] = 3.into();
    json["attrs"]["future_ratio"] = serde_json::json!(0.5);
    assert_eq!(
        Record::parse_line(&json.to_string()).unwrap().step,
        "future.step"
    );
}
#[test]
fn concurrent_children_keep_parent_ids_without_arrival_order() {
    let (collector, _, sink) = setup();
    let root = collector.start(Step::RuntimeDispatch, None).unwrap();
    let barrier = Arc::new(std::sync::Barrier::new(8));
    std::thread::scope(|scope| {
        for _ in 0..8 {
            let p = root.parent();
            let barrier = barrier.clone();
            scope.spawn(move || {
                measure(Step::ContainerStart, p, |_| {
                    barrier.wait();
                    Ok::<_, ()>(())
                })
                .unwrap();
            });
        }
    });
    let parent = root.parent().unwrap();
    root.finish(Outcome::Ok, false, None, Attrs::default());
    let mut data = records(&sink);
    data.reverse();
    assert_eq!(
        data.iter()
            .filter(|r| r.parent.as_ref() == Some(&parent.span))
            .count(),
        8
    );
    let ids: std::collections::BTreeSet<_> = data.iter().map(|r| &r.span).collect();
    assert_eq!(ids.len(), 9);
    let siblings: Vec<_> = data
        .iter()
        .filter(|r| r.parent.as_ref() == Some(&parent.span))
        .collect();
    let latest_start = siblings.iter().map(|r| r.start_us).max().unwrap();
    assert!(
        siblings
            .iter()
            .all(|r| r.start_us + r.dur_us >= latest_start)
    );
}

#[test]
fn per_request_traces_share_the_process_anchor_and_restore_scope() {
    let (collector, _, sink) = setup();
    let request = collector
        .for_trace("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".into(), None)
        .unwrap();
    observe(Some(&collector), Step::RuntimeDispatch, None, |_| {
        observe(Some(&request), Step::RuntimeDispatch, None, |_| {
            measure(Step::PlanCompile, None, |_| Ok::<_, ()>(()))
        })
        .unwrap();
        measure(Step::ContainerInspect, None, |_| Ok::<_, ()>(()))
    })
    .unwrap();
    let data = records(&sink);
    assert_eq!(data.len(), 4);
    assert!(
        data.iter()
            .all(|r| r.origin_mono_us == data[0].origin_mono_us
                && r.origin_unix_us == data[0].origin_unix_us)
    );
    assert_eq!(data[0].trace, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    assert_eq!(data[0].parent.as_ref(), Some(&data[1].span));
    assert_eq!(data[2].parent.as_ref(), Some(&data[3].span));
    assert_ne!(data[0].trace, data[2].trace);
}
#[test]
fn cached_success_incomplete_elapsed_and_prefix_preserving_truncation() {
    let (collector, _, sink) = setup();
    collector.start(Step::PlanCompile, None).unwrap().finish(
        Outcome::Ok,
        true,
        None,
        Attrs {
            service_index: Some(3),
            ..Attrs::default()
        },
    );
    let unfinished = collector.start(Step::ContainerRun, None).unwrap();
    collector.shutdown(None);
    drop(unfinished);
    let data = records(&sink);
    assert_eq!(data[0].cached, Some(true));
    assert_eq!(
        serde_json::to_value(Code::from_error(&crate::error::CandidateError::new(
            "engine_rejected",
            "fixed"
        )))
        .unwrap(),
        "engine_rejected"
    );
    assert_eq!(data[1].outcome, Outcome::Incomplete);
    assert!(data[1].dur_us > 0);
    for _ in 0..RECORD_LIMIT {
        collector.start(Step::ContainerStart, None).unwrap().finish(
            Outcome::Ok,
            false,
            None,
            Attrs::default(),
        );
    }
    collector.shutdown(None);
    let data = records(&sink);
    assert_eq!(data.len(), RECORD_LIMIT);
    assert_eq!(data.last().unwrap().step, "timings.truncated");
    assert_eq!(data[0].step, "plan.compile");
    assert_eq!(
        data.last().unwrap().attrs["dropped"],
        Attr::Number(3.into())
    );
}
#[test]
fn host_anchor_joins_startup_and_guest_clock_is_not_subtracted() {
    let (collector, _, sink) = setup();
    collector.start(Step::RuntimeRequest, None).unwrap().finish(
        Outcome::Ok,
        false,
        None,
        Attrs::default(),
    );
    let mut child = records(&sink).remove(0);
    child.origin_mono_us = 1500;
    child.start_us = 200;
    assert_eq!(child.host_start_us(1000), Some(700));
    child.clock = Clock::Guest;
    assert_eq!(child.host_start_us(1000), None);
}

#[test]
fn unknown_values_keep_the_span_and_unsafe_names_do_not_enter_stores() {
    let (collector, _, sink) = setup();
    collector.start(Step::VmEnsure, None).unwrap().finish(
        Outcome::Ok,
        true,
        None,
        Attrs::default(),
    );
    let mut value = serde_json::to_value(&records(&sink)[0]).unwrap();
    value["proc"] = "future_role".into();
    value["clock"] = "future_clock".into();
    value["outcome"] = "future_outcome".into();
    value["step"] = "future.step".into();
    value["code"] = "../unsafe".into();
    value["attrs"]["future.count"] = 4.into();
    value["attrs"]["future_text"] = "ignored".into();
    value["attrs"]["../unsafe"] = true.into();
    let record = Record::parse_line(&value.to_string()).unwrap();
    assert_eq!(
        serde_json::from_value::<Record>(value.clone()).unwrap(),
        record
    );
    assert_eq!(record.proc, Role::Unknown);
    assert_eq!(record.clock, Clock::Unknown);
    assert_eq!(record.outcome, Outcome::Unknown);
    assert_eq!(record.cached, None);
    assert_eq!(record.code, None);
    assert_eq!(
        record.attrs.get("future.count"),
        Some(&Attr::Number(4.into()))
    );
    assert!(!record.attrs.contains_key("future_text"));
    assert!(!record.attrs.contains_key("../unsafe"));
    for name in ["/unsafe", "Upper", "a..b", "a/b", "a b", "a."] {
        value["step"] = name.into();
        assert!(Record::parse_line(&value.to_string()).is_none());
    }
    assert!(!valid_name(&"a".repeat(129)));
    assert!(valid_name("a.1_b"));
}

#[test]
fn startup_outside_cap_uses_fresh_anchor_without_disabling_collection() {
    struct Fixed;
    impl TimeSource for Fixed {
        fn sample(&self) -> Option<(u64, u64)> {
            Some((20_000_000_000, 12_000_000_000))
        }
    }
    for spawn in [12_000_000_001, 1_200_000_000, 11_939_999_999] {
        let sink = Arc::new(Memory::default());
        let collector = Collector::new(
            Config {
                trace: "4bf92f3577b34da6a3ce929d0e0e4736".into(),
                parent: None,
                role: Role::Runtime,
                clock: Clock::Host,
                spawn_mono_us: Some(spawn),
                service_index_stable: false,
            },
            Arc::new(Fixed),
            sink.clone(),
        )
        .unwrap();
        collector
            .start(Step::RuntimeDispatch, None)
            .unwrap()
            .finish(Outcome::Ok, false, None, Attrs::default());
        let data = records(&sink);
        assert_eq!(data.len(), 1);
        assert_eq!(data[0].origin_mono_us, 12_000_000_000);
        assert_eq!(data[0].start_us, 0);
    }
}
