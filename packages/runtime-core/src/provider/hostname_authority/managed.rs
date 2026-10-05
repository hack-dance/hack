//! Explicit foreground authority bound to the candidate pool's lifetime.
use super::super::{lifecycle, state, status};
use crate::{Candidate, CandidateError};
use std::{path::PathBuf, time::Duration};
fn socket(owner: &state::Owner) -> PathBuf {
    PathBuf::from(format!(
        "/private/tmp/hka-{}-{}/route.sock",
        unsafe { libc::geteuid() },
        owner.token
    ))
}
pub fn inspect(c: &Candidate) -> Result<serde_json::Value, CandidateError> {
    let owner = state::Owner::load(c)?;
    let path = socket(&owner);
    let state = if path
        .parent()
        .is_some_and(|p| !p.exists() && !p.is_symlink())
    {
        serde_json::json!({"present":false})
    } else {
        super::ownership::inspect(c, &path)?
    };
    Ok(serde_json::json!({"socket":path,"authority":state,"automatic_start":false}))
}
pub fn serve(c: &Candidate) -> Result<(), CandidateError> {
    serve_with_certificate_limit(c, None)
}
pub fn serve_with_certificate_limit(
    c: &Candidate,
    limit: Option<usize>,
) -> Result<(), CandidateError> {
    serve_with_startup_wait(c, limit, lifecycle::STARTUP_LEASE_WAIT)
}
fn serve_with_startup_wait(
    c: &Candidate,
    limit: Option<usize>,
    wait: Duration,
) -> Result<(), CandidateError> {
    // Graph inspection also holds this lease. Wait before admission, then reload
    // the current pool identity; neither socket publication nor serving is replayed.
    let lock = lifecycle::startup_lease(&c.state_root.join("run/smolvm"), wait)?;
    let current = status(c)?;
    if current.phase != "running" || current.process_alive != Some(true) {
        return Err(super::error());
    }
    let owner = state::Owner::load(c)?;
    let path = socket(&owner);
    state::private_directory(path.parent().ok_or_else(super::error)?)?;
    let budget = limit
        .map(|limit| {
            super::certificates::Budget::open(&super::certificates::root(c), &owner.token, limit)
        })
        .transpose()?;
    super::serve_locked(c, &path, Some(lock), budget)
}
/// Caller holds the provider operation lock, fencing concurrent managed startup.
pub(crate) fn stop(c: &Candidate, owner: &state::Owner) -> Result<(), CandidateError> {
    let path = socket(owner);
    let parent = path.parent().ok_or_else(super::error)?;
    if !parent.exists() && !parent.is_symlink() {
        return Ok(());
    }
    let inspection = super::ownership::inspect(c, &path)?;
    if inspection["present"] == false {
        return Ok(());
    }
    let hash = inspection["sha256"].as_str().ok_or_else(super::error)?;
    super::ownership::stop(c, &path, hash)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        time::{Instant, SystemTime, UNIX_EPOCH},
    };

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root = fs::canonicalize(std::env::temp_dir())
                .unwrap()
                .join(format!(
                    "hkl-authority-admission-{}-{}",
                    std::process::id(),
                    SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap()
                        .as_nanos()
                ));
            state::private_directory(&root).unwrap();
            Self(root)
        }
        fn candidate(&self) -> Candidate {
            Candidate::discover(&self.0).unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn authority_startup_waits_for_inspection_before_reading_pool_state() {
        let fixture = Fixture::new();
        let candidate = fixture.candidate();
        let root = candidate.state_root.join("run/smolvm");
        let held = state::Lock::acquire(&root).unwrap();
        let worker = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
            drop(held);
        });
        let start = Instant::now();
        let result = serve_with_startup_wait(&candidate, None, Duration::from_secs(2));
        worker.join().unwrap();
        assert!(start.elapsed() >= Duration::from_millis(100));
        // The exact production path gets past contention and rejects the unprepared
        // pool. It must not publish an authority just because the lock became free.
        assert!(matches!(result, Err(e) if e.code == "hostname_authority"));
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        assert!(!root.join("owner.json").exists());
        assert!(
            !candidate
                .state_root
                .join("run/certificate-admission")
                .exists()
        );
        assert!(state::Lock::acquire(&root).is_ok());
    }

    #[test]
    fn authority_startup_contention_deadline_admits_no_pool_or_socket_effect() {
        let fixture = Fixture::new();
        let candidate = fixture.candidate();
        let root = candidate.state_root.join("run/smolvm");
        let _held = state::Lock::acquire(&root).unwrap();
        let start = Instant::now();
        let result = serve_with_startup_wait(&candidate, None, Duration::from_millis(100));
        assert!(start.elapsed() >= Duration::from_millis(75));
        assert!(
            matches!(result, Err(e) if e.code == "provider_busy" && e.message.contains("no operation was admitted"))
        );
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        assert!(!root.join("owner.json").exists());
        assert!(
            !candidate
                .state_root
                .join("run/certificate-admission")
                .exists()
        );
        assert!(matches!(state::Lock::acquire(&root), Err(e) if e.code == "provider_busy"));
    }
}
