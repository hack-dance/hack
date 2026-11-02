//! Volatile tool authority of one run on its original Engine/provider lease.
//! No persistence, retry, worker or resource effects. The first admission binds
//! the run for this lease's entire lifetime, including after successful use.
use super::refused;
use crate::CandidateError;
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct State {
    run: Option<String>,
    active: usize,
    attempted: bool,
}
impl State {
    fn admit(&mut self, run: &str) -> Result<(), CandidateError> {
        if self.attempted || self.run.as_deref().is_some_and(|bound| bound != run) {
            return Err(refused());
        }
        if self.run.is_none() {
            self.run = Some(run.to_owned());
        }
        Ok(())
    }
}
#[derive(Clone, Default)]
pub(in crate::provider) struct Lifetime(Arc<Mutex<State>>);
pub(in crate::provider) struct Use {
    lifetime: Lifetime,
    completed: bool,
}
impl Lifetime {
    pub(in crate::provider) fn bound_run(&self) -> Result<Option<String>, CandidateError> {
        let state = self.0.lock().map_err(|_| refused())?;
        if state.attempted {
            return Err(refused());
        }
        Ok(state.run.clone())
    }
    pub(in crate::provider) fn check(
        &self,
        current: &Self,
        run: &str,
    ) -> Result<(), CandidateError> {
        if !Arc::ptr_eq(&self.0, &current.0) {
            return Err(refused());
        }
        self.0.lock().map_err(|_| refused())?.admit(run)
    }
    pub(in crate::provider) fn enter(
        &self,
        current: &Self,
        run: &str,
    ) -> Result<Use, CandidateError> {
        if !Arc::ptr_eq(&self.0, &current.0) {
            return Err(refused());
        }
        let mut state = self.0.lock().map_err(|_| refused())?;
        state.admit(run)?;
        state.active = state.active.checked_add(1).ok_or_else(refused)?;
        Ok(Use {
            lifetime: self.clone(),
            completed: false,
        })
    }
    pub(in crate::provider) fn retire(
        &self,
        current: &Self,
        run: &str,
    ) -> Result<(), CandidateError> {
        if !Arc::ptr_eq(&self.0, &current.0) {
            return Err(refused());
        }
        let mut state = self.0.lock().map_err(|_| refused())?;
        state.admit(run)?;
        if state.active != 0 {
            return Err(refused());
        }
        state.attempted = true;
        Ok(())
    }
    pub(in crate::provider) fn uncertain(&self, run: &str) {
        // A poisoned lock already refuses all admission. An in-flight guard owns
        // this run; uncertainty is permanent even after that guard is dropped.
        if let Ok(mut state) = self.0.lock()
            && state.run.as_deref() == Some(run)
        {
            state.attempted = true;
        }
    }
}
impl Use {
    pub(in crate::provider) fn complete(mut self) {
        self.completed = true;
    }
}
impl Drop for Use {
    fn drop(&mut self) {
        if let Ok(mut state) = self.lifetime.0.lock() {
            if !self.completed {
                state.attempted = true;
            }
            state.active = state.active.saturating_sub(1);
        }
    }
}
