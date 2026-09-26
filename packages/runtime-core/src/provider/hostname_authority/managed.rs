//! Explicit foreground authority bound to the candidate pool's lifetime.
use super::super::{state, status};
use crate::{Candidate, CandidateError};
use std::path::PathBuf;
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
    let lock = state::Lock::acquire(&c.state_root.join("run/smolvm"))?;
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
