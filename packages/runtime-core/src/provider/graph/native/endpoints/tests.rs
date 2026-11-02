use super::*;
use crate::project::native::{CompileOptions, ManagedValues};
use std::time::{Duration, Instant};

const OWNER: &str = "cccccccccccccccccccccccccccccccc";
const BOOT: &str = "12345678-abcd-abcd-abcd-123456789abc";

struct Fixture {
    receipt: Receipt,
    container: Value,
    networks: BTreeMap<String, Option<Value>>,
}

impl Fixture {
    fn endpoint(&self) -> Result<GuestEndpoint, CandidateError> {
        observe(ObserveOptions {
            receipt: &self.receipt,
            boot: &self.receipt.boot,
            service: "web",
            port: 3000,
            container: &self.container,
            networks: &self.networks,
        })
    }

    fn relabel(&mut self) {
        self.container["Config"]["Labels"] = labels(
            &self.receipt.owner,
            &self.receipt.review,
            &self.receipt.resources["container:web"],
        );
        for (key, network) in &mut self.networks {
            network.as_mut().unwrap()["Labels"] = labels(
                &self.receipt.owner,
                &self.receipt.review,
                &self.receipt.resources[key],
            );
        }
    }
}

fn fixture(two: bool, run: char, name: &str) -> Fixture {
    fixture_with_readiness(two, run, name, true)
}

fn fixture_with_readiness(two: bool, run: char, name: &str, healthy: bool) -> Fixture {
    // The real native compiler/configuration owner produces the receipt shape;
    // captured Engine inspections below are synthetic and perform no effects.
    let mut project = json!({"schema_version":1,"name":name,"services":{"web":{
        "image":format!("sha256:{}", "d".repeat(64)),
        "readiness":{"kind":"exec","command":{"exec":["true"]},
            "interval":"1s","timeout":"1s","retries":3}
    }}});
    if !healthy {
        project["services"]["web"]
            .as_object_mut()
            .unwrap()
            .remove("readiness");
    }
    if two {
        project["networks"] = json!({"inside":{"internal":true},"outbound":{"internal":false}});
        project["services"]["web"]["networks"] = json!({"inside":{},"outbound":{}});
    }
    let request = serde_json::to_vec(&json!({"request_version":1,"project":project.to_string(),
        "env_metadata":{"metadata_version":1,"overlay":null,"overlay_exists":false,
            "workloads":{"web":{}},"inactive_scopes":[]}}))
    .unwrap();
    let namespace = "a".repeat(64);
    let run = run.to_string().repeat(32);
    let scope = native_input::Scope {
        namespace: &namespace,
        run: &run,
    };
    let review = native_input::review(&request, &[], scope).unwrap();
    let values = ManagedValues::new();
    let prepared = native_input::prepare(native_input::PrepareOptions {
        compile: CompileOptions {
            request: &request,
            profiles: &[],
            managed_values: &values,
        },
        scope,
        expected_review: &review,
        deadline: Instant::now() + Duration::from_secs(30),
    })
    .unwrap();
    let config = configuration(&prepared, OWNER).unwrap();
    let mut receipt = Receipt::preparing(&config, OWNER, BOOT).unwrap();
    receipt.phase = Phase::ReadyObserved;
    let container_id = "a".repeat(64);
    let resource = receipt.resources.get_mut("container:web").unwrap();
    resource.id = Some(container_id.clone());
    resource.phase = "started".into();
    let declared = resource.networks.as_ref().unwrap().clone();
    let mut attachments = serde_json::Map::new();
    let mut networks = BTreeMap::new();
    for (index, logical) in declared.iter().enumerate() {
        let key = format!("network:{logical}");
        let network = receipt.resources.get_mut(&key).unwrap();
        let id = char::from(b'b' + index as u8).to_string().repeat(64);
        let endpoint = char::from(b'e' + index as u8).to_string().repeat(64);
        let address = format!("172.{}.0.2", 18 + index);
        network.id = Some(id.clone());
        network.phase = "created".into();
        attachments.insert(
            network.name.clone(),
            json!({"NetworkID":id,"EndpointID":endpoint,
            "IPAddress":address}),
        );
        networks.insert(
            key,
            Some(json!({"Id":id,"Name":network.name,"Driver":"bridge",
            "Internal":!network.outbound,"Containers":{&container_id:{"EndpointID":endpoint,
                "IPv4Address":format!("{address}/16")}}})),
        );
    }
    let resource = &receipt.resources["container:web"];
    let primary = &receipt.resources[&format!("network:{}", declared[0])].name;
    let container = json!({"Id":container_id,"Name":format!("/{}",resource.name),
        "Image":resource.image,"Config":{"Labels":{}},"HostConfig":{"NetworkMode":primary},
        "State":{"Running":true,"Paused":false,"Restarting":false,"Dead":false,"OOMKilled":false,
            "Status":"running","Pid":123,
            "StartedAt":"2026-10-09T00:00:00Z","Health":{"Status":"healthy"}},
        "NetworkSettings":{"Networks":attachments}});
    let mut fixture = Fixture {
        receipt,
        container,
        networks,
    };
    fixture.relabel();
    fixture.receipt.validate(&run, OWNER).unwrap();
    fixture
}

#[test]
fn native_default_endpoint_is_only_a_guest_observation() {
    let f = fixture(false, 'b', "fixture");
    let observed = f.endpoint().unwrap();
    assert_eq!(observed.address.to_string(), "172.18.0.2");
    assert_eq!(observed.port, 3000);
    assert_eq!(observed.container_id, "a".repeat(64));
    assert_eq!(observed.scope, "guest-only");
    assert!(observed.reachability.starts_with("not-probed;"));
    assert_eq!(observed.generation.len(), 64);
}

#[test]
fn native_two_bridge_primary_is_receipt_selected() {
    let f = fixture(true, 'b', "fixture");
    let observed = f.endpoint().unwrap();
    assert_eq!(observed.network_id, "b".repeat(64));
    assert_eq!(observed.address.to_string(), "172.18.0.2");
    assert_eq!(f.networks.len(), 2);
}

#[test]
fn started_only_service_needs_running_state_but_not_an_invented_healthcheck() {
    let mut f = fixture_with_readiness(false, 'b', "fixture", false);
    f.container["State"]
        .as_object_mut()
        .unwrap()
        .remove("Health");
    assert!(f.endpoint().is_ok());
    f.container["State"]["Health"] = json!({"Status":"unhealthy"});
    assert_eq!(f.endpoint().unwrap_err().code, "native_endpoint_identity");
    f.container["State"]
        .as_object_mut()
        .unwrap()
        .remove("Health");
    f.receipt
        .readiness
        .insert("web".into(), Condition::Completed);
    assert_eq!(f.endpoint().unwrap_err().code, "native_endpoint_identity");
}

#[test]
fn private_inspection_fields_neither_leave_observation_nor_affect_generation() {
    let mut f = fixture(false, 'b', "fixture");
    let before = f.endpoint().unwrap();
    f.container["Config"]["Env"] = json!(["PRIVATE_CANARY=value-not-for-output"]);
    f.container["Config"]["Cmd"] = json!(["PRIVATE_COMMAND_CANARY"]);
    let after = f.endpoint().unwrap();
    assert_eq!(before.generation, after.generation);
    let output = serde_json::to_string(&after).unwrap();
    assert!(!output.contains("CANARY"));
    f.container["Image"] = json!("PRIVATE_IMAGE_CANARY");
    let error = serde_json::to_string(&f.endpoint().unwrap_err()).unwrap();
    assert!(!error.contains("CANARY"));
}

#[test]
fn coherent_secondary_replacement_revokes_generation_without_changing_primary() {
    let mut f = fixture(true, 'b', "fixture");
    let before = f.endpoint().unwrap();
    let resource = f.receipt.resources.get_mut("network:outbound").unwrap();
    resource.id = Some("d".repeat(64));
    let name = resource.name.clone();
    f.networks
        .get_mut("network:outbound")
        .unwrap()
        .as_mut()
        .unwrap()["Id"] = json!("d".repeat(64));
    f.container["NetworkSettings"]["Networks"][name]["NetworkID"] = json!("d".repeat(64));
    let after = f.endpoint().unwrap();
    assert_eq!(before.network_id, after.network_id);
    assert_eq!(before.address, after.address);
    assert_ne!(before.generation, after.generation);
}

#[test]
fn native_generation_binds_boot_owner_run_review_image_start_and_port() {
    let original = fixture(false, 'b', "fixture").endpoint().unwrap();
    for case in 0..5 {
        let mut f = fixture(false, 'b', "fixture");
        match case {
            0 => f.receipt.boot = "12345678-abcd-abcd-abcd-123456789abd".into(),
            1 => {
                f.receipt.owner = "d".repeat(32);
                f.relabel();
            }
            2 => {
                f.receipt.resources.get_mut("container:web").unwrap().image =
                    Some(format!("sha256:{}", "e".repeat(64)));
                f.container["Image"] = json!(format!("sha256:{}", "e".repeat(64)));
            }
            3 => f.container["State"]["StartedAt"] = json!("2026-10-09T00:00:01Z"),
            _ => f = fixture(false, 'c', "fixture"),
        }
        assert_ne!(
            original.generation,
            f.endpoint().unwrap().generation,
            "case {case}"
        );
    }
    assert_ne!(
        original.generation,
        fixture(false, 'b', "other-fixture")
            .endpoint()
            .unwrap()
            .generation
    );
    let f = fixture(false, 'b', "fixture");
    let other_port = observe(ObserveOptions {
        receipt: &f.receipt,
        boot: BOOT,
        service: "web",
        port: 3001,
        container: &f.container,
        networks: &f.networks,
    })
    .unwrap();
    assert_ne!(original.generation, other_port.generation);
}

#[test]
fn native_observation_refuses_foreign_incomplete_or_unready_captures() {
    for case in 0..25 {
        let mut f = fixture(true, 'b', "fixture");
        let primary = f.receipt.resources["network:inside"].name.clone();
        let secondary = f.receipt.resources["network:outbound"].name.clone();
        match case {
            0 => f.receipt.phase = Phase::Stopped,
            1 => f.receipt.resources.get_mut("container:web").unwrap().phase = "stopped".into(),
            2 => f.container["Image"] = json!(format!("sha256:{}", "f".repeat(64))),
            3 => f.container["Id"] = json!("d".repeat(64)),
            4 => f.container["Name"] = json!("/foreign"),
            5 => f.container["Config"]["Labels"]["io.hack-local.owner"] = json!("d".repeat(32)),
            6 => f.container["State"]["Running"] = json!(false),
            7 => f.container["State"]["Health"]["Status"] = json!("unhealthy"),
            8 => f.container["State"]["Health"]["Status"] = json!("starting"),
            9 => f.container["State"]["StartedAt"] = json!("0001-01-01T00:00:00Z"),
            10 => {
                f.networks.remove("network:outbound");
            }
            11 => {
                f.networks.insert("network:foreign".into(), None);
            }
            12 => {
                f.networks.insert("network:outbound".into(), None);
            }
            13 => f.container["NetworkSettings"]["Networks"]["foreign"] = json!({}),
            14 => f.container["HostConfig"]["NetworkMode"] = json!(secondary),
            15 => {
                f.container["NetworkSettings"]["Networks"][&secondary]["NetworkID"] =
                    json!("d".repeat(64))
            }
            16 => {
                f.container["NetworkSettings"]["Networks"][&secondary]["EndpointID"] =
                    json!("d".repeat(64))
            }
            17 => {
                f.container["NetworkSettings"]["Networks"][&secondary]["IPAddress"] =
                    json!("172.19.0.3")
            }
            18 => {
                f.networks
                    .get_mut("network:outbound")
                    .unwrap()
                    .as_mut()
                    .unwrap()["Containers"] = json!({})
            }
            19 => {
                f.networks
                    .get_mut("network:outbound")
                    .unwrap()
                    .as_mut()
                    .unwrap()["Containers"]["a".repeat(64)]["IPv4Address"] = json!("172.19.0.2/99")
            }
            20 => {
                f.networks
                    .get_mut("network:outbound")
                    .unwrap()
                    .as_mut()
                    .unwrap()["Labels"]["io.hack-local.input-kind"] = json!("compose")
            }
            21 => {
                f.networks
                    .get_mut("network:outbound")
                    .unwrap()
                    .as_mut()
                    .unwrap()["Id"] = json!("d".repeat(64))
            }
            22 => {
                f.networks
                    .get_mut("network:outbound")
                    .unwrap()
                    .as_mut()
                    .unwrap()["Name"] = json!(primary)
            }
            23 => {
                f.networks
                    .get_mut("network:outbound")
                    .unwrap()
                    .as_mut()
                    .unwrap()["Driver"] = json!("overlay")
            }
            _ => {
                f.networks
                    .get_mut("network:outbound")
                    .unwrap()
                    .as_mut()
                    .unwrap()["Internal"] = json!(true)
            }
        }
        let error = f.endpoint().unwrap_err();
        assert!(
            matches!(
                error.code,
                "native_endpoint_identity" | "graph_endpoint_identity"
            ),
            "case {case}"
        );
    }
}

#[test]
fn native_observation_requires_current_boot_exact_selection_and_nonzero_port() {
    let f = fixture(false, 'b', "fixture");
    for (boot, service, port) in [
        ("other-boot", "web", 3000),
        (BOOT, "foreign", 3000),
        (BOOT, "web", 0),
    ] {
        assert!(
            observe(ObserveOptions {
                receipt: &f.receipt,
                boot,
                service,
                port,
                container: &f.container,
                networks: &f.networks
            })
            .is_err()
        );
    }
}

#[test]
fn native_observation_refuses_paused_restarting_and_unknown_state_flags() {
    let original = fixture(false, 'b', "fixture");
    for key in ["Running", "Paused", "Restarting", "Dead", "OOMKilled"] {
        for malformed in [Value::Null, json!(0), json!("false"), json!([]), json!({})] {
            let mut container = original.container.clone();
            container["State"][key] = malformed;
            assert!(
                observe(ObserveOptions {
                    receipt: &original.receipt,
                    boot: BOOT,
                    service: "web",
                    port: 3000,
                    container: &container,
                    networks: &original.networks
                })
                .is_err(),
                "{key}"
            );
        }
        let mut container = original.container.clone();
        container["State"].as_object_mut().unwrap().remove(key);
        assert!(
            observe(ObserveOptions {
                receipt: &original.receipt,
                boot: BOOT,
                service: "web",
                port: 3000,
                container: &container,
                networks: &original.networks
            })
            .is_err(),
            "{key}"
        );
    }
    for key in ["Paused", "Restarting"] {
        let mut container = original.container.clone();
        container["State"][key] = json!(true);
        assert!(
            observe(ObserveOptions {
                receipt: &original.receipt,
                boot: BOOT,
                service: "web",
                port: 3000,
                container: &container,
                networks: &original.networks
            })
            .is_err(),
            "{key}"
        );
    }
}

#[test]
fn malformed_receipt_and_duplicate_attachment_identity_refuse() {
    let mut f = fixture(true, 'b', "fixture");
    f.receipt.resources.get_mut("network:outbound").unwrap().id = Some("b".repeat(64));
    assert_eq!(f.endpoint().unwrap_err().code, "native_endpoint_identity");
    let f = fixture(false, 'b', "fixture");
    for version in [1, 3, 4, 5] {
        let mut wire = serde_json::to_value(&f.receipt).unwrap();
        wire["version"] = json!(version);
        assert!(serde_json::from_value::<Receipt>(wire).is_err());
    }
}
