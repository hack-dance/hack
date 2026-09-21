//! Explicit pool egress capability; host endpoint identity is a separate contract.
use crate::CandidateError;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
pub enum NetworkIntent {
    #[default]
    Isolated,
    /// Permit the provider gateway's host-loopback translation across TCP ports.
    /// This does not authorize a service alias or identify the listener owner.
    HostGateway,
    /// Canonical approved DNS inputs; Smol also allows their descendants and
    /// TTL-learned addresses. Initial public CIDRs/configuration are pinned, not
    /// the complete dynamic runtime address set. Provider launch forces its
    /// strict private/loopback/metadata floor for this mode.
    ApprovedHosts {
        hosts: Vec<String>,
        #[serde(default)]
        cidrs: Vec<String>,
    },
}

impl NetworkIntent {
    pub fn approved_hosts(mut hosts: Vec<String>) -> Result<Self, CandidateError> {
        hosts.sort();
        let intent = Self::ApprovedHosts {
            hosts,
            cidrs: Vec::new(),
        };
        intent.validate()?;
        Ok(intent)
    }
    pub(super) fn validate(&self) -> Result<(), CandidateError> {
        if let Self::ApprovedHosts { hosts, cidrs } = self {
            if hosts.is_empty()
                || hosts.len() > 32
                || hosts.windows(2).any(|w| w[0] >= w[1])
                || hosts.iter().any(|h| {
                    super::publication::normalize_hostname(h).ok().as_ref() != Some(h)
                        || !h.contains('.')
                        || h.ends_with(".localhost")
                        || h.ends_with(".local")
                        || h.parse::<std::net::IpAddr>().is_ok()
                })
                || cidrs.len() > 256
                || cidrs.iter().any(|c| !public_host_cidr(c))
            {
                return Err(invalid());
            }
        }
        Ok(())
    }
    pub(super) fn arguments(&self) -> Vec<String> {
        match self {
            Self::Isolated => Vec::new(),
            Self::HostGateway => [
                "--net-backend",
                "virtio-net",
                "--allow-cidr",
                "100.96.0.1/32",
            ]
            .map(str::to_owned)
            .to_vec(),
            Self::ApprovedHosts { hosts, .. } => {
                let mut args = vec!["--net-backend".into(), "virtio-net".into()];
                for host in hosts {
                    args.extend(["--allow-host".into(), host.clone()]);
                }
                args
            }
        }
    }
    pub(super) fn same_request(&self, requested: &Self) -> bool {
        match (self, requested) {
            (Self::ApprovedHosts { hosts: a, .. }, Self::ApprovedHosts { hosts: b, .. }) => a == b,
            _ => self == requested,
        }
    }
    pub(super) fn pin(&self, record: &Value) -> Result<Self, CandidateError> {
        let Self::ApprovedHosts { hosts, cidrs } = self else {
            self.verify(record)?;
            return Ok(self.clone());
        };
        if !cidrs.is_empty() {
            self.verify(record)?;
            return Ok(self.clone());
        }
        let cidrs: Vec<String> =
            serde_json::from_value(record["allowed_cidrs"].clone()).map_err(|_| invalid())?;
        let pinned = Self::ApprovedHosts {
            hosts: hosts.clone(),
            cidrs,
        };
        pinned.verify(record)?;
        Ok(pinned)
    }
    /// Pinned SmolVM re-resolves approved hosts at each boot and appends public
    /// addresses. Trust that provider resolution, not independent hostname proof:
    /// runtime observations may contain bounded public additions, while the
    /// durable provider database remains byte-for-byte policy-pinned.
    pub(super) fn verify_resources(&self, record: &Value) -> Result<(), CandidateError> {
        self.verify_resource_record(record, true)
    }
    fn verify_resource_record(&self, record: &Value, runtime: bool) -> Result<(), CandidateError> {
        self.validate()?;
        let (enabled, backend, cidrs) = match self {
            Self::Isolated => (false, Value::Null, Value::Null),
            Self::HostGateway => (true, json!("virtio-net"), json!(["100.96.0.1/32"])),
            Self::ApprovedHosts { cidrs, .. } if !cidrs.is_empty() => {
                (true, json!("virtio-net"), json!(cidrs))
            }
            _ => return Err(invalid()),
        };
        let addresses_match = match self {
            Self::ApprovedHosts { cidrs, .. } if runtime => {
                runtime_addresses_match(&record["allowed_cidrs"], cidrs)
            }
            _ => record["allowed_cidrs"] == cidrs,
        };
        if record["network"] != enabled
            || record["network_backend"] != backend
            || !addresses_match
            || !record["network_name"].is_null()
            || !record["dns"].is_null()
        {
            return Err(invalid());
        }
        Ok(())
    }
    pub(super) fn verify(&self, record: &Value) -> Result<(), CandidateError> {
        self.verify_resource_record(record, false)?;
        let hosts = match self {
            Self::ApprovedHosts { hosts, .. } => json!(hosts),
            _ => Value::Null,
        };
        if record["dns_filter_hosts"] != hosts {
            return Err(invalid());
        }
        Ok(())
    }
}
fn runtime_addresses_match(record: &Value, pinned: &[String]) -> bool {
    let Some(entries) = record.as_array() else {
        return false;
    };
    // The pinned policy has at most 256 entries. Bound the entire provider boot
    // result, including duplicates and freshly resolved addresses, independently
    // of set cardinality. Every durable address must remain present.
    if entries.is_empty() || entries.len() > 512 {
        return false;
    }
    let mut observed = std::collections::BTreeSet::new();
    for entry in entries {
        let Some(cidr) = entry.as_str() else {
            return false;
        };
        if !public_host_cidr(cidr) {
            return false;
        }
        observed.insert(cidr);
    }
    pinned.iter().all(|cidr| observed.contains(cidr.as_str()))
}

fn invalid() -> CandidateError {
    CandidateError::new(
        "unaudited_provider_config",
        "Provider network settings differ from the bounded owned intent.",
    )
}
fn public_host_cidr(value: &str) -> bool {
    let Some((ip, prefix)) = value.split_once('/') else {
        return false;
    };
    match ip.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(ip)) => {
            let [a, b, c, _] = ip.octets();
            prefix == "32"
                && ip.to_string() == value[..value.len() - 3]
                && !ip.is_private()
                && !ip.is_loopback()
                && !ip.is_link_local()
                && !ip.is_multicast()
                && !ip.is_unspecified()
                && !ip.is_broadcast()
                && a != 0
                && a < 224
                && !(a == 100 && (64..=127).contains(&b))
                && !(a == 192 && (b == 0 || (b == 88 && c == 99)))
                && !(a == 198 && (18..=19).contains(&b))
                && !ip.is_documentation()
        }
        Ok(std::net::IpAddr::V6(ip)) => {
            prefix == "128"
                && ip.to_string() == value[..value.len() - 4]
                && (ip.segments()[0] & 0xe000) == 0x2000
                && ip.segments()[0] != 0x2002
                && !(ip.segments()[0] == 0x2001
                    && (ip.segments()[1] <= 0x01ff || ip.segments()[1] == 0x0db8))
        }
        _ => false,
    }
}

pub(super) fn check_request(
    existing: &NetworkIntent,
    requested: Option<&NetworkIntent>,
) -> Result<(), CandidateError> {
    if requested.is_some_and(|requested| !existing.same_request(requested)) {
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
            check_request(&mode, None).unwrap();
            check_request(&mode, Some(&mode)).unwrap();
        }
        assert!(
            check_request(&NetworkIntent::Isolated, Some(&NetworkIntent::HostGateway)).is_err()
        );
        assert!(
            check_request(&NetworkIntent::HostGateway, Some(&NetworkIntent::Isolated)).is_err()
        );
        assert!(serde_json::from_value::<NetworkIntent>(json!("unrestricted")).is_err());
    }

    #[test]
    fn approved_names_pin_addresses_and_reject_widening() {
        let intent = NetworkIntent::approved_hosts(vec!["registry.example.com".into()]).unwrap();
        let record = json!({"network":true,"network_backend":"virtio-net", "allowed_cidrs":["1.1.1.1/32"], "dns_filter_hosts":["registry.example.com"]});
        assert!(intent.verify(&record).is_err());
        let pinned = intent.pin(&record).unwrap();
        pinned.verify(&record).unwrap();
        check_request(&pinned, Some(&intent)).unwrap();
        assert_eq!(
            serde_json::from_value::<NetworkIntent>(serde_json::to_value(&pinned).unwrap())
                .unwrap(),
            pinned
        );
        for cidrs in [
            json!(["1.1.1.1/32", "8.8.8.8/32"]),
            json!(["1.1.1.0/24"]),
            json!(["127.0.0.1/32"]),
            json!(["100.96.0.1/32"]),
            json!([]),
        ] {
            let mut changed = record.clone();
            changed["allowed_cidrs"] = cidrs;
            assert!(pinned.verify(&changed).is_err());
        }
        for cidr in [
            "127.0.0.1/32",
            "100.96.0.1/32",
            "169.254.169.254/32",
            "10.0.0.1/32",
            "::1/128",
            "fd00::1/128",
            "0.0.0.0/0",
        ] {
            let mut changed = record.clone();
            changed["allowed_cidrs"] = json!([cidr]);
            assert!(intent.pin(&changed).is_err());
        }
        for hosts in [
            vec![],
            vec!["*.example.com".into()],
            vec!["localhost".into()],
            vec!["127.0.0.1".into()],
            vec!["registry.example.com".into(), "registry.example.com".into()],
        ] {
            assert!(NetworkIntent::approved_hosts(hosts).is_err());
        }
    }

    #[test]
    fn retained_runtime_accepts_bounded_public_dns_additions_preserving_all_pins() {
        let intent = NetworkIntent::approved_hosts(vec!["registry.example.com".into()]).unwrap();
        let record = json!({"network":true,"network_backend":"virtio-net",
            "allowed_cidrs":["1.1.1.1/32","8.8.8.8/32"],"dns_filter_hosts":["registry.example.com"]});
        let pinned = intent.pin(&record).unwrap();
        for addresses in [
            json!(["8.8.8.8/32", "1.1.1.1/32"]),
            json!(["1.1.1.1/32", "8.8.8.8/32", "9.9.9.9/32"]),
            json!(["2606:4700::6810:922/128", "8.8.8.8/32", "1.1.1.1/32"]),
            json!(["1.1.1.1/32", "8.8.8.8/32", "1.1.1.1/32", "8.8.8.8/32"]),
        ] {
            let mut runtime = record.clone();
            runtime["allowed_cidrs"] = addresses;
            pinned.verify_resources(&runtime).unwrap();
            // Equivalent runtime normalization must never relax persisted pins.
            assert!(pinned.verify(&runtime).is_err());
        }
        for addresses in [
            json!([]),
            Value::Null,
            json!(["1.1.1.1/32"]),
            json!(["1.1.1.0/24", "8.8.8.8/32"]),
            json!(["1.1.1.1/32", "8.8.8.8/32", "100.96.0.1/32"]),
            json!(["1.1.1.1/32", "8.8.8.8/32", 42]),
            json!(["1.1.1.1/32", "8.8.8.8/32", "garbage"]),
        ] {
            let mut runtime = record.clone();
            runtime["allowed_cidrs"] = addresses;
            assert!(pinned.verify_resources(&runtime).is_err());
        }
        for forbidden in [
            "127.0.0.1/32",
            "10.0.0.1/32",
            "169.254.169.254/32",
            "::1/128",
            "fc00::1/128",
            "2606:4700::/64",
            "8.8.8.0/24",
        ] {
            let mut runtime = record.clone();
            runtime["allowed_cidrs"] = json!(["1.1.1.1/32", "8.8.8.8/32", forbidden]);
            assert!(pinned.verify_resources(&runtime).is_err());
        }
        let mut oversized = record.clone();
        oversized["allowed_cidrs"] = json!(
            (0..513)
                .map(|n| if n % 2 == 0 {
                    "1.1.1.1/32"
                } else {
                    "8.8.8.8/32"
                })
                .collect::<Vec<_>>()
        );
        assert!(pinned.verify_resources(&oversized).is_err());
        pinned.verify(&record).unwrap();
    }

    #[test]
    fn rotating_provider_restart_fixture_does_not_modify_durable_intent() {
        // Public addresses observed in the stopped six-host pool: creation pins
        // remain in Smol's database; reboot appends fresh DNS results and repeats.
        let intent = NetworkIntent::approved_hosts(vec![
            "npm.pkg.github.com".into(),
            "s3.us-east-1.amazonaws.com".into(),
        ])
        .unwrap();
        let database = json!({"network":true,"network_backend":"virtio-net",
            "allowed_cidrs":["140.82.113.34/32", "52.217.232.56/32"],
            "dns_filter_hosts":["npm.pkg.github.com", "s3.us-east-1.amazonaws.com"]});
        let pinned = intent.pin(&database).unwrap();
        let before = serde_json::to_value(&pinned).unwrap();
        let mut runtime = database.clone();
        runtime["allowed_cidrs"] = json!([
            "16.15.199.36/32",
            "52.217.232.56/32",
            "140.82.114.34/32",
            "140.82.113.34/32",
            "52.217.232.56/32"
        ]);
        pinned.verify_resources(&runtime).unwrap();
        assert!(pinned.verify(&runtime).is_err());
        pinned.verify(&database).unwrap();
        assert_eq!(serde_json::to_value(&pinned).unwrap(), before);
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
