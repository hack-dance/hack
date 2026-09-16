use super::*;
use std::net::Ipv4Addr;

/// An observed guest destination, never a host publication or reachability guarantee.
#[derive(Debug, Serialize)]
pub struct GuestEndpoint {
    pub container_id: String,
    pub network_id: String,
    pub address: Ipv4Addr,
    pub port: u16,
    pub scope: &'static str,
    pub reachability: &'static str,
}

pub(super) fn resolve(
    container: &Value,
    network: &Value,
    port: u16,
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
    Ok(GuestEndpoint {
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
            json!({"Id":container,"NetworkSettings":{"Networks":{"owned":{"NetworkID":network,"EndpointID":endpoint,"IPAddress":"172.18.0.2"}}}}),
            json!({"Id":network,"Name":"owned","Containers":{container:{"EndpointID":endpoint,"IPv4Address":"172.18.0.2/16"}}}),
        )
    }
    #[test]
    fn endpoint_requires_matching_membership_in_both_directions() {
        let (container, network) = fixture();
        let endpoint = resolve(&container, &network, 3000).unwrap();
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
                resolve(&container, &network, 3000).unwrap_err().code,
                "graph_endpoint_identity"
            );
        }
        assert!(resolve(&container, &network, 0).is_err());
        for address in ["127.0.0.1", "0.0.0.0", "224.0.0.1", "203.0.113.1", "::1"] {
            let (mut container, mut network) = fixture();
            container["NetworkSettings"]["Networks"]["owned"]["IPAddress"] = json!(address);
            network["Containers"]["a".repeat(64)]["IPv4Address"] = json!(format!("{address}/16"));
            assert!(resolve(&container, &network, 3000).is_err());
        }
    }
}
