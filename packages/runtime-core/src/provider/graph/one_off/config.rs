//! Derive a one-off request only from an admitted pre-wrapper service template.
use super::*;

/// Keep application entrypoint, user, limits and storage; command overrides replace
/// Cmd. One-off jobs get a distinct identity and no service DNS alias or host ports.
pub(super) fn prepare(
    template: &Value,
    receipt: &Receipt,
    resource: &Resource,
    argv: &[String],
    workdir: Option<&str>,
) -> Result<Value, CandidateError> {
    if argv.len() > 256
        || argv.first().is_some_and(String::is_empty)
        || argv.iter().any(|v| v.contains('\0') || v.len() > 16_384)
        || argv.iter().map(String::len).sum::<usize>() > 65_536
        || workdir.is_some_and(|v| !v.starts_with('/') || v.contains('\0') || v.len() > 4096)
        || resource.kind != Kind::Container
        || resource.id.is_some()
    {
        return Err(refused());
    }
    let mut config = template.clone();
    let object = config.as_object_mut().ok_or_else(refused)?;
    object.insert(
        "Labels".into(),
        serde_json::to_value(expected_labels(receipt, resource)).map_err(|_| refused())?,
    );
    if !argv.is_empty() {
        object.insert("Cmd".into(), json!(argv));
    }
    if let Some(path) = workdir {
        object.insert("WorkingDir".into(), json!(path));
    }
    object.insert("Tty".into(), json!(false));
    object.insert("OpenStdin".into(), json!(false));
    object.insert("AttachStdin".into(), json!(false));
    object.insert("Healthcheck".into(), json!({"Test":["NONE"]}));
    let host = config["HostConfig"].as_object_mut().ok_or_else(refused)?;
    host.insert("PortBindings".into(), json!({}));
    host.insert("AutoRemove".into(), json!(false));
    host.insert("RestartPolicy".into(), json!({"Name":"no"}));
    if let Some(mounts) = host.get("Mounts").and_then(Value::as_array) {
        for mount in mounts {
            if mount["Target"]
                .as_str()
                .is_some_and(|p| p.starts_with("/run/hack-"))
            {
                return Err(refused());
            }
        }
    }
    if let Some(networks) = config["NetworkingConfig"]["EndpointsConfig"].as_object_mut() {
        for endpoint in networks.values_mut() {
            endpoint
                .as_object_mut()
                .ok_or_else(refused)?
                .insert("Aliases".into(), json!([resource.key]));
        }
    }
    Ok(config)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn command_override_keeps_storage_identity_user_and_entrypoint_without_service_ports() {
        let receipt:Receipt=serde_json::from_value(json!({"version":1,"run":"a".repeat(32),"owner":"b".repeat(32),"namespace":"c".repeat(64),"plan_id":"d".repeat(64),"phase":"ready-observed","readiness":{},"resources":{}})).unwrap();
        let resource:Resource=serde_json::from_value(json!({"kind":"container","key":"job-123","name":"hkg-owned-container-1","id":null,"image":"sha256:pin","phase":"reserved"})).unwrap();
        let template = json!({"Image":"sha256:pin","User":"1000:1000","Entrypoint":["/entrypoint"],"Cmd":["default"],"WorkingDir":"/app","Env":["PUBLIC=value"],"HostConfig":{"Memory":123,"NanoCpus":456,"Mounts":[{"Type":"volume","Source":"shared-cache","Target":"/app/node_modules"}],"PortBindings":{"3000/tcp":[{"HostPort":"3000"}]},"RestartPolicy":{"Name":"always"}},"NetworkingConfig":{"EndpointsConfig":{"owned-network":{"Aliases":["web","other-alias"]}}}});
        let derived = prepare(
            &template,
            &receipt,
            &resource,
            &["argument with spaces".into()],
            Some("/work"),
        )
        .unwrap();
        for key in ["Image", "User", "Entrypoint", "Env"] {
            assert_eq!(derived[key], template[key]);
        }
        for key in ["Memory", "NanoCpus", "Mounts"] {
            assert_eq!(derived["HostConfig"][key], template["HostConfig"][key]);
        }
        assert_eq!(derived["Cmd"], json!(["argument with spaces"]));
        assert_eq!(derived["HostConfig"]["PortBindings"], json!({}));
        assert_eq!(
            derived["NetworkingConfig"]["EndpointsConfig"]["owned-network"]["Aliases"],
            json!([resource.key])
        );
        assert_eq!(
            prepare(&template, &receipt, &resource, &[], None).unwrap()["Cmd"],
            template["Cmd"]
        );
        let mut wrapped = template.clone();
        wrapped["HostConfig"]["Mounts"][0]["Target"] = json!("/run/hack-environment.json");
        assert!(prepare(&wrapped, &receipt, &resource, &[], None).is_err());
    }
}
