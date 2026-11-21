use super::*;
use std::cell::RefCell;
use std::sync::{Arc, Mutex};

/// One process's clock seam. Samples are (Unix microseconds, monotonic microseconds).
pub trait TimeSource: Send + Sync {
    fn sample(&self) -> Option<(u64, u64)>;
}
/// A dedicated, nonblocking sink: each write accepts a whole line or no bytes.
pub trait Sink: Send + Sync {
    fn write_line(&self, line: &[u8]) -> bool;
    fn atomic_limit(&self) -> usize {
        4096
    }
}
#[derive(Clone)]
/// Capture this handle for work on another thread; never infer parentage from arrival order.
pub struct Parent {
    pub trace: String,
    pub span: String,
    pub(crate) collector: Arc<Collector>,
}
/// Explicit process context supplied by the launching parent, without user environment values.
pub struct Config {
    pub trace: String,
    pub parent: Option<String>,
    pub role: Role,
    pub clock: Clock,
    /// Observed on the same host-wide clock, before the child was spawned.
    pub spawn_mono_us: Option<u64>,
    /// False: plan positions. True: stable slots from the reuse implementation.
    pub service_index_stable: bool,
}
struct State {
    open: BTreeMap<String, Record>,
    attempted: usize,
    dropped: u64,
}
/// An owned process collector. Actions execute outside its metadata lock.
pub struct Collector {
    config: Config,
    origin: (u64, u64),
    time: Arc<dyn TimeSource>,
    sink: Arc<dyn Sink>,
    state: Mutex<State>,
}
thread_local! { static CURRENT: RefCell<Option<Parent>> = const { RefCell::new(None) }; }
pub(crate) fn current() -> Option<Parent> {
    CURRENT.with(|current| current.borrow().clone())
}
struct Scope(Option<Parent>);
impl Drop for Scope {
    fn drop(&mut self) {
        CURRENT.with(|current| *current.borrow_mut() = self.0.take());
    }
}
impl Collector {
    /// Owns the clock and sink seams. No global installation is needed for tests.
    pub fn new(
        config: Config,
        time: Arc<dyn TimeSource>,
        sink: Arc<dyn Sink>,
    ) -> Option<Arc<Self>> {
        if !valid_id(&config.trace, 32) || config.parent.as_ref().is_some_and(|p| !valid_id(p, 16))
        {
            return None;
        }
        let (unix, mono) = time.sample()?;
        if unix > MAX_NUMBER || mono > MAX_NUMBER {
            return None;
        }
        let startup = if config.clock == Clock::Host {
            mono.checked_sub(config.spawn_mono_us.unwrap_or(mono))?
        } else {
            0
        };
        let origin = (unix.checked_sub(startup)?, mono - startup);
        let collector = Arc::new(Self {
            config,
            origin,
            time,
            sink,
            state: Mutex::new(State {
                open: BTreeMap::new(),
                attempted: 0,
                dropped: 0,
            }),
        });
        if startup > 0 {
            let mut record = collector.record(Step::ProcessStartup, None)?;
            record.start_us = 0;
            record.dur_us = startup;
            record.outcome = Outcome::Ok;
            collector.emit(record);
        }
        Some(collector)
    }
    fn record(&self, step: Step, parent: Option<Parent>) -> Option<Record> {
        let mono = self.time.sample()?.1;
        let parent = parent.or_else(|| current().filter(|p| p.trace == self.config.trace));
        if parent
            .as_ref()
            .is_some_and(|p| p.trace != self.config.trace || !valid_id(&p.span, 16))
        {
            return None;
        }
        let is_root = parent.is_none();
        Some(Record {
            schema: SCHEMA.into(),
            trace: self.config.trace.clone(),
            span: random_id()?,
            parent: parent
                .map(|p| p.span)
                .or_else(|| self.config.parent.clone()),
            proc: self.config.role,
            clock: self.config.clock,
            origin_unix_us: self.origin.0,
            origin_mono_us: self.origin.1,
            step: step.name().into(),
            start_us: mono.checked_sub(self.origin.1)?,
            dur_us: 0,
            outcome: Outcome::Incomplete,
            cached: None,
            code: None,
            attrs: if is_root || matches!(step, Step::ProcessStartup) {
                BTreeMap::from([(
                    "service_index_stable".into(),
                    Attr::Boolean(self.config.service_index_stable),
                )])
            } else {
                BTreeMap::new()
            },
        })
    }
    /// Starts a span under an explicit handle, or the current synchronous observation scope.
    pub fn start(self: &Arc<Self>, step: Step, parent: Option<Parent>) -> Option<Span> {
        let record = self.record(step, parent)?;
        let mut state = self.state.lock().ok()?;
        if state.open.len() >= RECORD_LIMIT {
            state.dropped = state.dropped.saturating_add(1);
            return None;
        }
        let id = record.span.clone();
        state.open.insert(id.clone(), record);
        Some(Span {
            collector: Arc::clone(self),
            id: Some(id),
        })
    }

    /// A service request gets its own trace and record budget, retaining the
    /// process anchor, clock and sink. Use handles from this context across awaits.
    pub fn for_trace(&self, trace: String, parent: Option<String>) -> Option<Arc<Self>> {
        if !valid_id(&trace, 32) || parent.as_ref().is_some_and(|p| !valid_id(p, 16)) {
            return None;
        }
        Some(Arc::new(Self {
            config: Config {
                trace,
                parent,
                role: self.config.role,
                clock: self.config.clock,
                spawn_mono_us: None,
                service_index_stable: self.config.service_index_stable,
            },
            origin: self.origin,
            time: self.time.clone(),
            sink: self.sink.clone(),
            state: Mutex::new(State {
                open: BTreeMap::new(),
                attempted: 0,
                dropped: 0,
            }),
        }))
    }
    fn emit(&self, record: Record) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        if state.attempted >= RECORD_LIMIT - 1 {
            state.dropped = state.dropped.saturating_add(1);
            return;
        }
        state.attempted += 1;
        drop(state);
        if !self.write(&record) {
            let Ok(mut state) = self.state.lock() else {
                return;
            };
            state.dropped = state.dropped.saturating_add(1);
        }
    }
    fn write(&self, record: &Record) -> bool {
        if !record.valid() {
            return false;
        }
        let Ok(mut line) = serde_json::to_vec(record) else {
            return false;
        };
        line.push(b'\n');
        line.len() <= self.sink.atomic_limit() && self.sink.write_line(&line)
    }
    fn finish(&self, id: &str, outcome: Outcome, cached: bool, code: Option<Code>, attrs: Attrs) {
        let Some(mut record) = self
            .state
            .lock()
            .ok()
            .and_then(|mut state| state.open.remove(id))
        else {
            return;
        };
        record.dur_us = self
            .time
            .sample()
            .and_then(|(_, mono)| mono.checked_sub(self.origin.1 + record.start_us))
            .unwrap_or(0);
        record.outcome = outcome;
        record.cached = (cached && outcome == Outcome::Ok).then_some(true);
        record.code =
            code.and_then(|code| serde_json::to_value(code).ok()?.as_str().map(String::from));
        if let Ok(serde_json::Value::Object(values)) = serde_json::to_value(attrs) {
            record
                .attrs
                .extend(values.into_iter().filter_map(|(key, value)| match value {
                    serde_json::Value::Number(n) => Some((key, Attr::Number(n))),
                    serde_json::Value::Bool(b) => Some((key, Attr::Boolean(b))),
                    _ => None,
                }));
        }
        self.emit(record);
    }
    /// Explicit exits finish dispatch from its known status; other live work is incomplete.
    pub fn shutdown(&self, exit_status: Option<i32>) {
        let open: Vec<_> = self
            .state
            .lock()
            .map(|state| {
                state
                    .open
                    .values()
                    .map(|r| (r.span.clone(), r.step == Step::RuntimeDispatch.name()))
                    .collect()
            })
            .unwrap_or_default();
        for (id, dispatch) in open {
            let outcome = match (dispatch, exit_status) {
                (true, Some(0)) => Outcome::Ok,
                (true, Some(_)) => Outcome::Error,
                _ => Outcome::Incomplete,
            };
            self.finish(&id, outcome, false, None, Attrs::default());
        }
        let dropped = self
            .state
            .lock()
            .map(|mut state| std::mem::take(&mut state.dropped))
            .unwrap_or(0);
        if dropped > 0
            && let Some(mut record) = self.record(Step::Truncated, None)
        {
            record.outcome = Outcome::Ok;
            record.attrs.insert(
                "dropped".into(),
                Attr::Number(dropped.min(MAX_NUMBER).into()),
            );
            if !self.write(&record)
                && let Ok(mut state) = self.state.lock()
            {
                state.dropped = state.dropped.saturating_add(dropped);
            }
        }
    }
}
/// Finishing emits once; dropping unfinished work records elapsed time as incomplete.
pub struct Span {
    collector: Arc<Collector>,
    id: Option<String>,
}
impl Span {
    pub fn parent(&self) -> Option<Parent> {
        Some(Parent {
            trace: self.collector.config.trace.clone(),
            span: self.id.clone()?,
            collector: Arc::clone(&self.collector),
        })
    }
    pub fn finish(mut self, outcome: Outcome, cached: bool, code: Option<Code>, attrs: Attrs) {
        if let Some(id) = self.id.take() {
            self.collector.finish(&id, outcome, cached, code, attrs);
        }
    }
}
impl Drop for Span {
    fn drop(&mut self) {
        if let Some(id) = self.id.take() {
            self.collector
                .finish(&id, Outcome::Incomplete, false, None, Attrs::default());
        }
    }
}
/// Run unchanged work with an optional collector. Disabled observation reads no clock or sink.
pub fn observe<T, E>(
    collector: Option<&Arc<Collector>>,
    step: Step,
    parent: Option<Parent>,
    action: impl FnOnce(Option<Parent>) -> Result<T, E>,
) -> Result<T, E> {
    let Some(collector) = collector else {
        return action(None);
    };
    let span = collector.start(step, parent);
    let handle = span.as_ref().and_then(Span::parent);
    let _scope = Scope(CURRENT.with(|current| current.replace(handle.clone())));
    let result = action(handle);
    if let Some(span) = span {
        span.finish(
            if result.is_ok() {
                Outcome::Ok
            } else {
                Outcome::Error
            },
            false,
            None,
            Attrs::default(),
        );
    }
    result
}
fn random_id() -> Option<String> {
    let mut bytes = [0_u8; 8];
    // SAFETY: the fixed output buffer is writable for its full length; getentropy retains no pointer.
    if unsafe { libc::getentropy(bytes.as_mut_ptr().cast(), bytes.len()) } != 0 {
        return None;
    }
    let id = bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    valid_id(&id, 16).then_some(id)
}
