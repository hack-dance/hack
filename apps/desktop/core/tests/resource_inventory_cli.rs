use hack_desktop_core::resource_inventory::{InventoryReport, RemovalPlan};

#[test]
fn reads_the_resource_report_emitted_by_the_docker_cli_test() {
    let Some(path) = std::env::var_os("HACK_RESOURCE_CLI_OUTPUT") else {
        return;
    };
    let text = std::fs::read_to_string(path).expect("read the CLI integration output");
    let output: serde_json::Value = serde_json::from_str(&text).expect("CLI JSON");
    let envelope = &output["inventory"];
    assert_eq!(envelope["ok"], true);
    assert_eq!(envelope["data"]["schema"], "hack.resources.v1");
    let report: InventoryReport =
        serde_json::from_value(envelope["data"].clone()).expect("desktop reads the CLI result");
    assert!(report.rows.iter().any(|row| row.kind == "volume"
        && row.bytes.is_some()
        && row.owners.iter().any(|owner| owner.detached)));
    assert!(
        report
            .rows
            .iter()
            .any(|row| row.kind == "container" && row.state.as_deref() == Some("running"))
    );
    let preview = &output["preview"];
    assert_eq!(preview["data"]["schema"], "hack.resource-remove.v1");
    let plan: RemovalPlan =
        serde_json::from_value(preview["data"].clone()).expect("desktop removal preview");
    assert!(
        !plan.removed
            && plan.message.contains("cannot be undone")
            && plan.message.contains("Checkouts:")
    );
}
