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

/// Resolve a publishable primary endpoint only after checking the complete
/// recorded attachment set. `networks` contains ownership-verified inspections;
/// labels/immutable resource identities are checked again at this boundary.
/// A legacy receipt can authorize exactly one attachment, never infer a new set.
pub(super) fn resolve_attached(
    container: &Value,
    networks: &BTreeMap<String, Option<Value>>,
    port: u16,
    scope: &EndpointScope<'_>,
) -> Result<GuestEndpoint, CandidateError> {
    let invalid = || {
        error(
            "graph_endpoint_identity",
            "Declared graph network attachments are missing, foreign or inconsistent.",
        )
    };
    let resource = scope
        .receipt
        .resources
        .get(&format!("container:{}", scope.service))
        .ok_or_else(invalid)?;
    let container_id = resource
        .id
        .as_deref()
        .filter(|id| hex(id, 64))
        .ok_or_else(invalid)?;
    if resource.kind != Kind::Container
        || resource.key != scope.service
        || Some(container_id) != container["Id"].as_str()
    {
        return Err(invalid());
    }
    let labels_match = |resource: &Resource, labels: &Value| {
        expected_labels(scope.receipt, resource)
            .as_object()
            .is_some_and(|expected| {
                expected
                    .iter()
                    .all(|(key, value)| labels.get(key) == Some(value))
            })
    };
    if !labels_match(resource, &container["Config"]["Labels"]) {
        return Err(invalid());
    }
    let attachments = container["NetworkSettings"]["Networks"]
        .as_object()
        .ok_or_else(invalid)?;
    let mode = container["HostConfig"]["NetworkMode"]
        .as_str()
        .ok_or_else(invalid)?;
    let declared = match &resource.networks {
        Some(names) => names.clone(),
        None => {
            if attachments.len() != 1 {
                return Err(invalid());
            }
            let mut found = scope
                .receipt
                .resources
                .values()
                .filter(|r| r.kind == Kind::Network && r.name == mode);
            let selected = found.next().ok_or_else(invalid)?;
            if found.next().is_some() {
                return Err(invalid());
            }
            vec![selected.key.clone()]
        }
    };
    if declared.is_empty() || declared.len() > 32 || attachments.len() != declared.len() {
        return Err(invalid());
    }
    let mut identities = BTreeMap::new();
    let mut actual_names = std::collections::BTreeSet::new();
    let mut actual_ids = std::collections::BTreeSet::new();
    let mut primary = None;
    let mut view = container.clone();
    for (index, logical) in declared.iter().enumerate() {
        let key = format!("network:{logical}");
        let owned = scope.receipt.resources.get(&key).ok_or_else(invalid)?;
        let network = networks
            .get(&key)
            .and_then(Option::as_ref)
            .ok_or_else(invalid)?;
        let id = owned
            .id
            .as_deref()
            .filter(|id| hex(id, 64))
            .ok_or_else(invalid)?;
        if owned.kind != Kind::Network
            || owned.key != *logical
            || owned.networks.is_some()
            || network["Id"].as_str() != Some(id)
            || network["Name"].as_str() != Some(owned.name.as_str())
            || !labels_match(owned, &network["Labels"])
            || !actual_names.insert(owned.name.clone())
            || !actual_ids.insert(id)
            || (index == 0 && mode != owned.name)
        {
            return Err(invalid());
        }
        let attachment = attachments.get(&owned.name).ok_or_else(invalid)?;
        view["NetworkSettings"]["Networks"] = json!({owned.name.clone():attachment});
        let endpoint = resolve(&view, network, port, scope)?;
        let member = &network["Containers"][&endpoint.container_id];
        if identities
            .insert(
                logical.clone(),
                json!([
                    owned.name,
                    id,
                    attachment["EndpointID"],
                    endpoint.address,
                    member["IPv4Address"]
                ]),
            )
            .is_some()
        {
            return Err(invalid());
        }
        if index == 0 {
            primary = Some(endpoint);
        }
    }
    let mut endpoint = primary.ok_or_else(invalid)?;
    if identities.len() > 1 {
        endpoint.generation = format!(
            "{:x}",
            Sha256::digest(
                serde_json::to_vec(&json!([
                    "hack-endpoint-attachments-v2",
                    endpoint.generation,
                    identities
                ]))
                .map_err(|_| invalid())?
            )
        );
    }
    Ok(endpoint)
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
    fn attached_fixture() -> (Receipt, Value, BTreeMap<String, Option<Value>>) {
        let (mut container, mut primary) = fixture();
        let mut receipt: Receipt = serde_json::from_value(json!({
            "version":1,"run":"a".repeat(32),"owner":"b".repeat(32),
            "namespace":"c".repeat(64),"plan_id":"d".repeat(64),
            "phase":"ready-observed","readiness":{},"resources":{
                "container:web":{"kind":"container","key":"web","name":"web-owned",
                    "id":"a".repeat(64),"image":null,"phase":"started","networks":["z-primary","a-secondary"]},
                "network:z-primary":{"kind":"network","key":"z-primary","name":"owned",
                    "id":"b".repeat(64),"image":null,"phase":"created"},
                "network:a-secondary":{"kind":"network","key":"a-secondary","name":"secondary",
                    "id":"d".repeat(64),"image":null,"phase":"created"}
            }
        })).unwrap();
        // A graph network unrelated to this service sorts before both attachments.
        let mut unrelated = receipt.resources["network:a-secondary"].clone();
        unrelated.key = "0-unrelated".into();
        unrelated.name = "unrelated".into();
        unrelated.id = Some("f".repeat(64));
        receipt
            .resources
            .insert("network:0-unrelated".into(), unrelated);
        container["HostConfig"] = json!({"NetworkMode":"owned"});
        container["Config"] =
            json!({"Labels":expected_labels(&receipt,&receipt.resources["container:web"])});
        primary["Labels"] = expected_labels(&receipt, &receipt.resources["network:z-primary"]);
        container["NetworkSettings"]["Networks"]["secondary"] = json!({
            "NetworkID":"d".repeat(64),"EndpointID":"e".repeat(64),"IPAddress":"172.19.0.2"});
        let secondary = json!({"Id":"d".repeat(64),"Name":"secondary",
            "Labels":expected_labels(&receipt,&receipt.resources["network:a-secondary"]),
            "Containers":{"a".repeat(64):{"EndpointID":"e".repeat(64),"IPv4Address":"172.19.0.2/16"}}});
        (
            receipt,
            container,
            BTreeMap::from([
                ("network:z-primary".into(), Some(primary)),
                ("network:a-secondary".into(), Some(secondary)),
            ]),
        )
    }

    fn attached(
        receipt: &Receipt,
        container: &Value,
        networks: &BTreeMap<String, Option<Value>>,
    ) -> Result<GuestEndpoint, CandidateError> {
        resolve_attached(
            container,
            networks,
            3000,
            &EndpointScope {
                receipt,
                boot: "boot",
                service: "web",
            },
        )
    }

    #[test]
    fn all_attachments_bind_generation_without_changing_primary_selection() {
        let (mut receipt, mut container, mut networks) = attached_fixture();
        let before = attached(&receipt, &container, &networks).unwrap();
        assert_eq!(before.network_id, "b".repeat(64));
        assert_eq!(before.address.to_string(), "172.18.0.2");
        // A fully coherent replacement of only the secondary network revokes the generation.
        receipt.resources.get_mut("network:a-secondary").unwrap().id = Some("f".repeat(64));
        networks
            .get_mut("network:a-secondary")
            .unwrap()
            .as_mut()
            .unwrap()["Id"] = json!("f".repeat(64));
        container["NetworkSettings"]["Networks"]["secondary"]["NetworkID"] = json!("f".repeat(64));
        let after = attached(&receipt, &container, &networks).unwrap();
        assert_eq!(before.network_id, after.network_id);
        assert_ne!(before.generation, after.generation);
        networks
            .get_mut("network:a-secondary")
            .unwrap()
            .as_mut()
            .unwrap()["Containers"]["a".repeat(64)]["EndpointID"] = json!("9".repeat(64));
        container["NetworkSettings"]["Networks"]["secondary"]["EndpointID"] = json!("9".repeat(64));
        assert_ne!(
            after.generation,
            attached(&receipt, &container, &networks)
                .unwrap()
                .generation
        );
    }

    #[test]
    fn attachment_set_rejects_missing_foreign_extra_and_reciprocal_drift() {
        for case in 0..11 {
            let (mut receipt, mut container, mut networks) = attached_fixture();
            match case {
                0 => {
                    container["NetworkSettings"]["Networks"]
                        .as_object_mut()
                        .unwrap()
                        .remove("owned");
                }
                1 => {
                    networks.insert("network:a-secondary".into(), None);
                }
                2 => {
                    container["NetworkSettings"]["Networks"]["unrelated"] =
                        json!({"NetworkID":"f".repeat(64)});
                }
                3 => {
                    container["HostConfig"]["NetworkMode"] = json!("secondary");
                }
                4 => {
                    networks
                        .get_mut("network:a-secondary")
                        .unwrap()
                        .as_mut()
                        .unwrap()["Id"] = json!("f".repeat(64));
                }
                5 => {
                    networks
                        .get_mut("network:a-secondary")
                        .unwrap()
                        .as_mut()
                        .unwrap()["Labels"]["io.hack-local.graph"] = json!("f".repeat(32));
                }
                6 => {
                    networks
                        .get_mut("network:a-secondary")
                        .unwrap()
                        .as_mut()
                        .unwrap()["Containers"]["a".repeat(64)]["IPv4Address"] =
                        json!("172.19.0.3/16");
                }
                7 => {
                    container["Config"]["Labels"]["io.hack-local.owner"] = json!("f".repeat(32));
                }
                8 => {
                    receipt.resources.get_mut("container:web").unwrap().networks =
                        Some(vec!["z-primary".into(), "z-primary".into()]);
                }
                9 => {
                    receipt.resources.get_mut("container:web").unwrap().id = None;
                }
                _ => {
                    receipt.resources.get_mut("container:web").unwrap().networks = None;
                }
            }
            assert_eq!(
                attached(&receipt, &container, &networks).unwrap_err().code,
                "graph_endpoint_identity",
                "case {case}"
            );
        }
    }

    #[test]
    fn single_declared_and_legacy_attachment_preserve_v1_generation() {
        let (mut receipt, mut container, networks) = attached_fixture();
        container["NetworkSettings"]["Networks"]
            .as_object_mut()
            .unwrap()
            .remove("secondary");
        receipt.resources.get_mut("container:web").unwrap().networks =
            Some(vec!["z-primary".into()]);
        let expected = resolve(
            &container,
            networks["network:z-primary"].as_ref().unwrap(),
            3000,
            &EndpointScope {
                receipt: &receipt,
                boot: "boot",
                service: "web",
            },
        )
        .unwrap();
        assert_eq!(
            attached(&receipt, &container, &networks)
                .unwrap()
                .generation,
            expected.generation
        );
        receipt.resources.get_mut("container:web").unwrap().networks = None;
        assert_eq!(
            attached(&receipt, &container, &networks)
                .unwrap()
                .generation,
            expected.generation
        );
        receipt.resources.get_mut("container:web").unwrap().networks = Some(vec![]);
        assert!(attached(&receipt, &container, &networks).is_err());
    }
}
