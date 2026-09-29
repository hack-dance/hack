//! One-off containers borrow the owner's verified endpoints, never old grants.
use super::*;
fn prepare_job(mut original: Service) -> Result<Service, CandidateError> {
    original.generation = crate::provider::graph::probes::token()?;
    original.phase = Phase::Prepared;
    original.started_at = None;
    for binding in original.bindings.values_mut() {
        binding.process = None;
    }
    Ok(original)
}
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
        let selected = prepare_job(original)?;
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
            let resource = receipt
                .resources
                .get(&format!("container:{key}"))
                .filter(|resource| resource.kind == Kind::Container)
                .ok_or_else(refused)?;
            let container_id = resource.id.as_deref().ok_or_else(refused)?;
            engine.guest().reap_relay_after_container_absence(
                self.children.get_mut(&child).ok_or_else(refused)?,
                container_id,
                &resource.name,
            )?;
            self.children.remove(&child);
        }
        cleanup::retire_service(engine, receipt, key)?;
        self.job_targets.remove(key);
        self.dependencies.retain(|(service, _), _| service != key);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn completed_template_gets_fresh_job_intent_not_stopped_container_attachment() {
        let original = Service {
            generation: "a".repeat(32),
            phase: Phase::Completed,
            started_at: Some("original-start".into()),
            bindings: BTreeMap::from([(
                "default".into(),
                Binding {
                    slot: 0,
                    endpoint_generation: Some("b".repeat(64)),
                    port: 25252,
                    aliases: Vec::new(),
                    process: None,
                },
            )]),
        };
        let selected = prepare_job(original.clone()).unwrap();
        assert_eq!(selected.phase, Phase::Prepared);
        assert_eq!(selected.started_at, None);
        assert_ne!(selected.generation, original.generation);
        assert_eq!(
            selected.bindings["default"].endpoint_generation,
            original.bindings["default"].endpoint_generation
        );
        assert!(
            selected
                .bindings
                .values()
                .all(|binding| binding.process.is_none())
        );
    }
}
