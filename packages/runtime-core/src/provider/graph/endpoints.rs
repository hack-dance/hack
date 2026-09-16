use super::*;
use sha2::{Digest, Sha256};
use std::net::Ipv4Addr;

/// An observed guest destination, never a host publication or reachability guarantee.
#[derive(Clone, Debug, Serialize)]
pub struct GuestEndpoint {
    pub generation: String,
    pub container_id: String,
    pub network_id: String,
    pub address: Ipv4Addr,
    pub port: u16,
    pub scope: &'static str,
    pub reachability: &'static str,
}

pub(super) struct EndpointScope<'a> {
    pub receipt: &'a Receipt,
    pub boot: &'a str,
    pub service: &'a str,
}

pub(super) fn resolve(
    container: &Value,
    network: &Value,
    port: u16,
    scope: &EndpointScope<'_>,
) -> Result<GuestEndpoint, CandidateError> {
    let invalid = || {
        error(
            "graph_endpoint_identity",
            "Guest endpoint attachments differ from the verified owned network.",
        )
    };
    let container_id = container["Id"]
        .as_str()
        .filter(|id| hex(id, 64))
        .ok_or_else(invalid)?;
    let network_id = network["Id"]
        .as_str()
        .filter(|id| hex(id, 64))
        .ok_or_else(invalid)?;
    let name = network["Name"].as_str().ok_or_else(invalid)?;
    let attachments = container["NetworkSettings"]["Networks"]
        .as_object()
        .ok_or_else(invalid)?;
    if attachments.len() != 1 || port == 0 {
        return Err(invalid());
    }
    let attachment = attachments.get(name).ok_or_else(invalid)?;
    let address = attachment["IPAddress"]
        .as_str()
        .and_then(|ip| ip.parse::<Ipv4Addr>().ok())
        .ok_or_else(invalid)?;
    let endpoint_id = attachment["EndpointID"]
        .as_str()
        .filter(|id| hex(id, 64))
        .ok_or_else(invalid)?;
    let member = &network["Containers"][container_id];
    let (member_ip, prefix) = member["IPv4Address"]
        .as_str()
        .and_then(|ip| ip.split_once('/'))
        .ok_or_else(invalid)?;
    if attachment["NetworkID"] != network_id
        || member["EndpointID"] != endpoint_id
        || member_ip.parse::<Ipv4Addr>().ok() != Some(address)
        || !prefix
            .parse::<u8>()
            .is_ok_and(|bits| (1..=32).contains(&bits))
        || !address.is_private()
    {
        return Err(invalid());
    }
    let started = container["State"]["StartedAt"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 64 && !s.starts_with("0001-"))
        .ok_or_else(invalid)?;
    if container["State"]["Running"] != true {
        return Err(invalid());
    }
    let generation = format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&json!([
                "hack-endpoint-v1",
                scope.receipt.owner,
                scope.receipt.run,
                scope.receipt.plan_id,
                scope.boot,
                scope.service,
                container_id,
                network_id,
                endpoint_id,
                address,
                port,
                started
            ]))
            .map_err(|_| invalid())?
        )
    );
    Ok(GuestEndpoint {
        generation,
        container_id: container_id.into(),
        network_id: network_id.into(),
        address,
        port,
        scope: "guest-only",
        reachability: "not-probed; container health does not prove interface reachability",
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (Value, Value) {
        let container = "a".repeat(64);
        let network = "b".repeat(64);
        let endpoint = "c".repeat(64);
        (
            json!({"Id":container,"State":{"Running":true,"StartedAt":"2026-09-16T00:00:00Z"},"NetworkSettings":{"Networks":{"owned":{"NetworkID":network,"EndpointID":endpoint,"IPAddress":"172.18.0.2"}}}}),
            json!({"Id":network,"Name":"owned","Containers":{container:{"EndpointID":endpoint,"IPv4Address":"172.18.0.2/16"}}}),
        )
    }
    fn scoped(
        container: &Value,
        network: &Value,
        port: u16,
    ) -> Result<GuestEndpoint, CandidateError> {
        let receipt: Receipt = serde_json::from_value(json!({"version":1,"run":"a".repeat(32),"owner":"b".repeat(32),"namespace":"c".repeat(64),"plan_id":"d".repeat(64),"phase":"ready-observed","readiness":{},"resources":{}})).unwrap();
        resolve(
            container,
            network,
            port,
            &EndpointScope {
                receipt: &receipt,
                boot: "boot",
                service: "web",
            },
        )
    }
    #[test]
    fn generation_changes_with_vm_boot_and_graph_identity() {
        let (container, network) = fixture();
        let mut receipt: Receipt = serde_json::from_value(json!({"version":1,"run":"a".repeat(32),"owner":"b".repeat(32),"namespace":"c".repeat(64),"plan_id":"d".repeat(64),"phase":"ready-observed","readiness":{},"resources":{}})).unwrap();
        let first = resolve(
            &container,
            &network,
            3000,
            &EndpointScope {
                receipt: &receipt,
                boot: "boot-one",
                service: "web",
            },
        )
        .unwrap();
        let second = resolve(
            &container,
            &network,
            3000,
            &EndpointScope {
                receipt: &receipt,
                boot: "boot-two",
                service: "web",
            },
        )
        .unwrap();
        assert_ne!(first.generation, second.generation);
        receipt.run = "e".repeat(32);
        let third = resolve(
            &container,
            &network,
            3000,
            &EndpointScope {
                receipt: &receipt,
                boot: "boot-one",
                service: "web",
            },
        )
        .unwrap();
        assert_ne!(first.generation, third.generation);
    }
    #[test]
    fn generation_changes_on_same_container_restart() {
        let (mut container, network) = fixture();
        let before = scoped(&container, &network, 3000).unwrap();
        container["State"]["StartedAt"] = json!("2026-09-16T00:00:01Z");
        let after = scoped(&container, &network, 3000).unwrap();
        assert_eq!(before.container_id, after.container_id);
        assert_ne!(before.generation, after.generation);
        container["State"]["Running"] = json!(false);
        assert!(scoped(&container, &network, 3000).is_err());
    }
    #[test]
    fn endpoint_requires_matching_membership_in_both_directions() {
        let (container, network) = fixture();
        let endpoint = scoped(&container, &network, 3000).unwrap();
        assert_eq!(endpoint.address.to_string(), "172.18.0.2");
        assert_eq!(endpoint.scope, "guest-only");
        for case in 0..8 {
            let (mut container, mut network) = fixture();
            match case {
                0 => container["NetworkSettings"]["Networks"]["foreign"] = json!({}),
                1 => {
                    container["NetworkSettings"]["Networks"]["owned"]["NetworkID"] =
                        json!("d".repeat(64))
                }
                2 => network["Containers"] = json!({}),
                3 => network["Containers"]["a".repeat(64)]["EndpointID"] = json!("d".repeat(64)),
                4 => network["Containers"]["a".repeat(64)]["IPv4Address"] = json!("172.18.0.3/16"),
                5 => network["Containers"]["a".repeat(64)]["IPv4Address"] = json!("172.18.0.2/99"),
                6 => {
                    container["NetworkSettings"]["Networks"]["owned"]["IPAddress"] =
                        json!("127.0.0.1")
                }
                _ => container["NetworkSettings"] = Value::Null,
            }
            assert_eq!(
                scoped(&container, &network, 3000).unwrap_err().code,
                "graph_endpoint_identity"
            );
        }
        assert!(scoped(&container, &network, 0).is_err());
        for address in ["127.0.0.1", "0.0.0.0", "224.0.0.1", "203.0.113.1", "::1"] {
            let (mut container, mut network) = fixture();
            container["NetworkSettings"]["Networks"]["owned"]["IPAddress"] = json!(address);
            network["Containers"]["a".repeat(64)]["IPv4Address"] = json!(format!("{address}/16"));
            assert!(scoped(&container, &network, 3000).is_err());
        }
    }
}
