//! Materialize only reviewed, value-free registry configuration in an immutable artifact.
use super::*;
use crate::project::{PlanData, registry};

fn refused() -> CandidateError {
    problem(
        "source_registry",
        "Registry template or source binding differs from the reviewed configuration; values omitted.",
    )
}

fn configured(plan: &PlanData) -> Result<Option<&registry::RegistryTemplate>, CandidateError> {
    let Some(config) = &plan.registry else {
        return Ok(None);
    };
    if !plan
        .services
        .values()
        .any(|s| s.active && s.dependency_cache.is_some())
        || registry::parse(&config.template)? != *config
    {
        return Err(refused());
    }
    Ok(Some(config))
}

impl ContentRevision {
    pub fn verify_registry(&self, plan: &PlanData) -> Result<(), CandidateError> {
        self.validate()?;
        let Some(config) = configured(plan)? else {
            return Ok(());
        };
        if self.selection_sha256 != plan.source_selection.metadata_sha256
            || !self.entries.iter().any(|entry| {
                entry.path == ".npmrc"
                    && entry.kind == "file"
                    && !entry.executable
                    && entry.bytes == config.template.len() as u64
                    && entry.sha256.as_deref() == Some(config.sha256.as_str())
                    && entry.link_target.is_none()
            })
        {
            return Err(refused());
        }
        Ok(())
    }
}

impl Snapshot {
    pub fn with_registry(mut self, plan: &PlanData) -> Result<Self, CandidateError> {
        self.receipt.validate()?;
        if self.receipt.selection_sha256 != plan.source_selection.metadata_sha256 {
            return Err(refused());
        }
        let selected = plan
            .services
            .values()
            .any(|s| s.active && s.dependency_cache.is_some());
        if selected && registry::read(&plan.source)? != plan.registry {
            return Err(refused());
        }
        let Some(config) = configured(plan)? else {
            return Ok(self);
        };
        let entry = ContentEntry {
            path: ".npmrc".into(),
            kind: "file".into(),
            executable: false,
            bytes: config.template.len() as u64,
            sha256: Some(config.sha256.clone()),
            link_target: None,
        };
        let mut entries: BTreeMap<_, _> = self
            .receipt
            .entries
            .into_iter()
            .zip(self.files)
            .map(|(entry, bytes)| (entry.path.clone(), (entry, bytes)))
            .collect();
        if let Some((old, bytes)) = entries.get(".npmrc") {
            if old != &entry || bytes != config.template.as_bytes() {
                return Err(refused());
            }
        } else {
            self.receipt.total_bytes = self
                .receipt
                .total_bytes
                .checked_add(entry.bytes)
                .ok_or_else(refused)?;
            entries.insert(
                entry.path.clone(),
                (entry, config.template.as_bytes().to_vec()),
            );
        }
        (self.receipt.entries, self.files) = entries.into_values().unzip();
        self.receipt.revision = format!(
            "{:x}",
            Sha256::digest(
                serde_json::to_vec(&(1_u32, &self.receipt.entries)).map_err(|_| refused())?
            )
        );
        self.receipt.verify_registry(plan)?;
        Ok(self)
    }
}
