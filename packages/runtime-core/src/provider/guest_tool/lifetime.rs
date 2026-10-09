//! Volatile tool authority of one original Engine/provider lease. No persistence,
//! retry, worker or resource effects; dropping the lease never transfers authority.
use super::refused;
use crate::CandidateError;
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};

#[derive(Default)]
struct State {
    active: u16,
    attempted: bool,
}
#[derive(Clone, Default)]
pub(in crate::provider) struct Lifetime(Arc<Mutex<BTreeMap<String, State>>>);
pub(in crate::provider) struct Use {
    lifetime: Lifetime,
    run: String,
    completed: bool,
}
impl Lifetime {
    pub(in crate::provider) fn check(
        &self,
        current: &Self,
        run: &str,
    ) -> Result<(), CandidateError> {
        if !Arc::ptr_eq(&self.0, &current.0)
            || self
                .0
                .lock()
                .map_err(|_| refused())?
                .get(run)
                .is_some_and(|state| state.attempted)
        {
            return Err(refused());
        }
        Ok(())
    }
    pub(in crate::provider) fn enter(
        &self,
        current: &Self,
        run: &str,
    ) -> Result<Use, CandidateError> {
        if !Arc::ptr_eq(&self.0, &current.0) {
            return Err(refused());
        }
        let mut states = self.0.lock().map_err(|_| refused())?;
        if !states.contains_key(run) && states.len() >= 64 {
            return Err(refused());
        }
        let state = states.entry(run.to_owned()).or_default();
        if state.attempted {
            return Err(refused());
        }
        state.active = state.active.checked_add(1).ok_or_else(refused)?;
        Ok(Use {
            lifetime: self.clone(),
            run: run.to_owned(),
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
        let mut states = self.0.lock().map_err(|_| refused())?;
        if !states.contains_key(run) && states.len() >= 64 {
            return Err(refused());
        }
        let state = states.entry(run.to_owned()).or_default();
        if state.active != 0 || state.attempted {
            return Err(refused());
        }
        state.attempted = true;
        Ok(())
    }
    pub(in crate::provider) fn uncertain(&self, run: &str) {
        // A poisoned lock already refuses all admission. An in-flight guard owns
        // this entry; uncertainty is permanent even after that guard is dropped.
        if let Ok(mut states) = self.0.lock()
            && let Some(state) = states.get_mut(run)
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
        if let Ok(mut states) = self.lifetime.0.lock()
            && let Some(state) = states.get_mut(&self.run)
        {
            if !self.completed {
                state.attempted = true;
            }
            state.active = state.active.saturating_sub(1);
            if state.active == 0 && !state.attempted {
                states.remove(&self.run);
            }
        }
    }
}
