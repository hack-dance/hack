//! Named, collected refusals of a private process wrapper's selected process.
//!
//! A wrapper (private environment delivery or the host-dependency release
//! barrier) runs the exact process Docker would run, so every wrapped service is
//! checked before any runtime state is reserved. Each refusal keeps its fixed
//! code and value-free message and also names the service and the closed field
//! to change. All wrapped services are checked in one pass so a project with
//! several affected stock images learns about all of them from one start.
use crate::error::{CandidateError, ProcessField, ProcessRefusal, ProcessRefusalsDiagnostic};

/// One wrapper refusal before it is attributed to a service.
#[derive(Debug)]
pub(super) struct Refused {
    pub(super) field: ProcessField,
    pub(super) error: CandidateError,
}

impl Refused {
    pub(super) fn new(field: ProcessField, code: &'static str, message: &'static str) -> Self {
        Self {
            field,
            error: CandidateError::new(code, message),
        }
    }

    /// The plain refusal, for a caller that checks one process only.
    pub(super) fn into_error(self) -> CandidateError {
        self.error
    }
}

/// Bounded like other value-free per-service diagnostics.
const MAX_REFUSALS: usize = 32;

/// Collects refusals across services; the first refusal's code is reported.
#[derive(Default)]
pub(super) struct Collector {
    first: Option<CandidateError>,
    refusals: Vec<ProcessRefusal>,
}

impl Collector {
    pub(super) fn check(&mut self, service: &str, result: Result<(), Refused>) {
        let Err(refused) = result else {
            return;
        };
        if self.refusals.len() < MAX_REFUSALS
            && !self
                .refusals
                .iter()
                .any(|known| known.service == service && known.field == refused.field)
        {
            self.refusals.push(ProcessRefusal {
                service: service.into(),
                field: refused.field,
            });
        }
        self.first.get_or_insert(refused.error);
    }

    pub(super) fn finish(self) -> Result<(), CandidateError> {
        match self.first {
            None => Ok(()),
            Some(mut error) => {
                error.message = format!(
                    "{} Refused process settings are named in process_refusals.",
                    error.message
                );
                error.process_refusals = Some(Box::new(ProcessRefusalsDiagnostic {
                    version: 1,
                    refusals: self.refusals,
                }));
                Err(error)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collects_every_service_and_field_and_keeps_the_first_code() {
        let mut collector = Collector::default();
        collector.check("web", Ok(()));
        collector.check(
            "db",
            Err(Refused::new(
                ProcessField::User,
                "environment_user",
                "Invalid.",
            )),
        );
        collector.check(
            "api",
            Err(Refused::new(
                ProcessField::Healthcheck,
                "environment_health",
                "Invalid.",
            )),
        );
        collector.check(
            "db",
            Err(Refused::new(
                ProcessField::User,
                "environment_user",
                "Again.",
            )),
        );
        let error = collector.finish().unwrap_err();
        assert_eq!(error.code, "environment_user");
        let detail = error.process_refusals.expect("named refusals");
        assert_eq!(detail.version, 1);
        assert_eq!(
            detail.refusals,
            vec![
                ProcessRefusal {
                    service: "db".into(),
                    field: ProcessField::User
                },
                ProcessRefusal {
                    service: "api".into(),
                    field: ProcessField::Healthcheck
                },
            ]
        );
        let reply = serde_json::to_value(CandidateError {
            process_refusals: Some(Box::new(ProcessRefusalsDiagnostic {
                version: 1,
                refusals: detail.refusals,
            })),
            ..CandidateError::new("environment_user", "Invalid.")
        })
        .unwrap();
        assert_eq!(
            reply["process_refusals"],
            serde_json::json!({"version":1,"refusals":[
                {"service":"db","field":"user"},
                {"service":"api","field":"healthcheck"}
            ]})
        );
        assert!(Collector::default().finish().is_ok());
    }
}
