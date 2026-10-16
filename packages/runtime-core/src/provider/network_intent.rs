//! Explicit pool egress capability; host endpoint identity is a separate contract.
use crate::CandidateError;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum NetworkIntent {
    #[default]
    Isolated,
    /// Permit the provider gateway's host-loopback translation across TCP ports.
    /// This does not authorize a service alias or identify the listener owner.
    HostGateway,
}

impl NetworkIntent {
    pub(super) fn arguments(self) -> &'static [&'static str] {
        match self {
            Self::Isolated => &[],
            Self::HostGateway => &[
                "--net-backend",
                "virtio-net",
                "--allow-cidr",
                "100.96.0.1/32",
            ],
        }
    }

    pub(super) fn verify(self, record: &Value) -> Result<(), CandidateError> {
        let (enabled, backend, cidrs) = match self {
            Self::Isolated => (false, Value::Null, Value::Null),
            Self::HostGateway => (true, json!("virtio-net"), json!(["100.96.0.1/32"])),
        };
        if record["network"] != enabled
            || record["network_backend"] != backend
            || record["allowed_cidrs"] != cidrs
            || !record["dns_filter_hosts"].is_null()
            || !record["network_name"].is_null()
            || !record["dns"].is_null()
        {
            return Err(CandidateError::new(
                "unaudited_provider_config",
                "Provider network settings differ from the owned intent.",
            ));
        }
        Ok(())
    }
}

pub(super) fn check_request(
    existing: NetworkIntent,
    requested: Option<NetworkIntent>,
) -> Result<(), CandidateError> {
    if requested.is_some_and(|requested| requested != existing) {
        return Err(CandidateError::new(
            "network_conflict",
            "Existing pool has different network intent. No update or replacement was attempted.",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_mode_changes_refuse_and_omission_preserves_intent() {
        for mode in [NetworkIntent::Isolated, NetworkIntent::HostGateway] {
            check_request(mode, None).unwrap();
            check_request(mode, Some(mode)).unwrap();
        }
        assert!(check_request(NetworkIntent::Isolated, Some(NetworkIntent::HostGateway)).is_err());
        assert!(check_request(NetworkIntent::HostGateway, Some(NetworkIntent::Isolated)).is_err());
        assert!(serde_json::from_value::<NetworkIntent>(json!("unrestricted")).is_err());
    }

    #[test]
    fn gateway_requires_exact_backend_and_policy() {
        let record = json!({"network":true,"network_backend":"virtio-net",
            "allowed_cidrs":["100.96.0.1/32"]});
        NetworkIntent::HostGateway.verify(&record).unwrap();
        assert!(NetworkIntent::Isolated.verify(&record).is_err());
        for (field, value) in [
            ("network", json!(false)),
            ("network_backend", json!("tsi")),
            ("allowed_cidrs", json!(["0.0.0.0/0"])),
            ("allowed_cidrs", json!(["100.96.0.1/32", "127.0.0.1/32"])),
            ("allowed_cidrs", Value::Null),
            ("dns_filter_hosts", json!(["private-sentinel.invalid"])),
            ("network_name", json!("foreign")),
            ("dns", json!("1.1.1.1")),
        ] {
            let mut changed = record.clone();
            changed[field] = value;
            let error = NetworkIntent::HostGateway.verify(&changed).unwrap_err();
            assert_eq!(error.code, "unaudited_provider_config");
            assert!(!error.message.contains("private-sentinel"));
        }
    }
}
