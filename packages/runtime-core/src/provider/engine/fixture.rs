//! Thread-scoped provider effects for foreground graph tests without a VM.
use super::*;
use std::{cell::RefCell, path::PathBuf};

type Request = dyn FnMut(Method, &str, Option<&Value>) -> Result<Value, CandidateError>;
type Execute = dyn FnMut(&str, &[&str], Option<&str>) -> String;

struct Fixture {
    state_root: PathBuf,
    request: Box<Request>,
    execute: Box<Execute>,
    journal: PathBuf,
    writes: Vec<Vec<u8>>,
}

thread_local! {
    static FIXTURE: RefCell<Option<Fixture>> = const { RefCell::new(None) };
}

pub(in crate::provider) fn with_provider<T>(
    candidate: &Candidate,
    journal: PathBuf,
    request: impl FnMut(Method, &str, Option<&Value>) -> Result<Value, CandidateError> + 'static,
    execute: impl FnMut(&str, &[&str], Option<&str>) -> String + 'static,
    test: impl FnOnce() -> T,
) -> (T, Vec<Vec<u8>>) {
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            FIXTURE.with(|fixture| fixture.borrow_mut().take());
        }
    }

    FIXTURE.with(|fixture| {
        let mut fixture = fixture.borrow_mut();
        assert!(fixture.is_none());
        *fixture = Some(Fixture {
            state_root: candidate.state_root.clone(),
            request: Box::new(request),
            execute: Box::new(execute),
            journal,
            writes: Vec::new(),
        });
    });
    let _reset = Reset;
    let result = test();
    let writes =
        FIXTURE.with(|fixture| std::mem::take(&mut fixture.borrow_mut().as_mut().unwrap().writes));
    (result, writes)
}

pub(in crate::provider) fn active(candidate: &Candidate) -> bool {
    FIXTURE.with(|fixture| {
        fixture
            .borrow()
            .as_ref()
            .is_some_and(|fixture| fixture.state_root == candidate.state_root)
    })
}

pub(super) fn request(
    method: Method,
    path: &str,
    body: Option<&Value>,
) -> Result<Value, CandidateError> {
    FIXTURE.with(|fixture| (fixture.borrow_mut().as_mut().unwrap().request)(method, path, body))
}

pub(in crate::provider) fn execute(
    script: &str,
    arguments: &[&str],
    input: Option<&str>,
) -> String {
    FIXTURE
        .with(|fixture| (fixture.borrow_mut().as_mut().unwrap().execute)(script, arguments, input))
}

pub(in crate::provider) fn record_write(path: &Path, bytes: Vec<u8>) {
    FIXTURE.with(|fixture| {
        if let Some(fixture) = fixture.borrow_mut().as_mut()
            && fixture.journal == path
        {
            fixture.writes.push(bytes);
        }
    });
}
