//! One-off containers borrow the owner's verified endpoints, never old grants.
use super::*;
impl HostRelayRuntime {
    pub(in crate::provider::graph) fn job_template(
        &self,
        service: &str,
    ) -> Result<Value, CandidateError> {
        self.templates.get(service).cloned().ok_or_else(refused)
    }
    pub(in crate::provider::graph) fn enroll_job(
        &mut self,
        engine: &Engine<'_>,
        receipt: &mut Receipt,
        root: &Path,
        service: &str,
        job_service: &str,
    ) -> Result<(), CandidateError> {
        self.check(engine, receipt)?;
        let Some(original) = receipt
            .relay_startup
            .as_ref()
            .and_then(|s| s.services.get(service))
            .cloned()
        else {
            return Ok(());
        };
        if !job_service.starts_with("job-")
            || receipt
                .relay_startup
                .as_ref()
                .is_some_and(|s| s.services.contains_key(job_service))
        {
            return Err(refused());
        }
        let mut selected = original;
        selected.generation = crate::provider::graph::probes::token()?;
        selected.phase = Phase::Prepared;
        selected.started_at = None;
        for binding in selected.bindings.values_mut() {
            binding.process = None;
        }
        let dependencies: Vec<_> = self
            .dependencies
            .iter()
            .filter(|((name, _), _)| name == service)
            .map(|((_, binding), dependency)| (binding.clone(), dependency.clone()))
            .collect();
        for (binding, mut dependency) in dependencies {
            dependency.service = job_service.into();
            self.dependencies
                .insert((job_service.into(), binding), dependency);
        }
        receipt
            .relay_startup
            .as_mut()
            .ok_or_else(refused)?
            .services
            .insert(job_service.into(), selected.clone());
        if !receipt
            .relay_startup
            .as_ref()
            .ok_or_else(refused)?
            .valid(receipt)
        {
            return Err(refused());
        }
        state::write(&root.join("state.json"), receipt)?;
        engine
            .guest()
            .execute(GATE, &[&receipt.run, &selected.generation], None)?;
        Ok(())
    }
    pub(in crate::provider::graph) fn retire_job(
        &mut self,
        engine: &Engine<'_>,
        key: &str,
        receipt: &Receipt,
    ) -> Result<(), CandidateError> {
        for target in self.job_targets.get(key).into_iter().flatten() {
            self.managed.retire(target.clone())?;
        }
        let keys: Vec<_> = self
            .children
            .keys()
            .filter(|(service, _)| service == key)
            .cloned()
            .collect();
        for child in keys {
            engine.guest().stop_relay_listener(
                self.children.get_mut(&child).ok_or_else(refused)?,
                Duration::from_secs(10),
            )?;
            self.children.remove(&child);
        }
        cleanup::retire_service(engine, receipt, key)?;
        self.job_targets.remove(key);
        self.dependencies.retain(|(service, _), _| service != key);
        Ok(())
    }
}
