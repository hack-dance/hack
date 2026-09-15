//! Feature-gated static launcher; no resident wrapper or runtime credential provider.
use super::*;
#[cfg(feature = "environment-launcher")]
use base64::Engine as _;
#[cfg(feature = "environment-launcher")]
use sha2::{Digest, Sha256};

#[cfg(feature = "environment-launcher")]
pub(super) fn publish(engine: &Engine<'_>) -> Result<String, CandidateError> {
    let bytes = include_bytes!(concat!(env!("OUT_DIR"), "/environment-launcher"));
    let hash = format!("{:x}", Sha256::digest(bytes));
    use std::io::Write;
    let mut compressed = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    compressed.write_all(bytes).map_err(state::io)?;
    let input =
        base64::engine::general_purpose::STANDARD.encode(compressed.finish().map_err(state::io)?);
    if input.len() > 56 * 1024 {
        return Err(error(
            "environment_launcher_budget",
            "Compressed launcher exceeds the bounded transport profile.",
        ));
    }
    let output = engine.guest().execute(PUBLISH, &[&hash], Some(&input))?;
    if output != "launcher-ready-v1\n" {
        return Err(error(
            "environment_launcher",
            "Launcher publication was not confirmed.",
        ));
    }
    Ok(format!("/storage/hack-environment-launcher/{hash}"))
}
#[cfg(feature = "environment-launcher")]
const PUBLISH: &str = r#"
(
set -eu
umask 077
root=/storage/hack-environment-launcher
test ! -L "$root"
if test ! -e "$root"; then mkdir -m 755 "$root"; fi
test "$(stat -c %u:%g:%a "$root")" = 0:0:755
file="$root/$1"
test ! -L "$file"
if test ! -e "$file"; then
 test ! -L "$file.pending"
 if test ! -e "$file.pending"; then base64 -d | gzip -d > "$file.pending"; else cat >/dev/null; fi
 test -f "$file.pending"
 test "$(stat -c %u:%g:%h "$file.pending")" = 0:0:1
 test "$(sha256sum "$file.pending" | cut -d' ' -f1)" = "$1"
 chmod 555 "$file.pending"
 mv "$file.pending" "$file"
else
 cat >/dev/null
fi
test -f "$file"
test "$(stat -c %u:%g:%a:%h "$file")" = 0:0:555:1
test "$(sha256sum "$file" | cut -d' ' -f1)" = "$1"
) >/dev/null 2>&1
printf 'launcher-ready-v1\n'
"#;

pub(super) fn identity(config: &Value) -> Result<(u32, u32), CandidateError> {
    let user = config["User"].as_str().unwrap_or("0:0");
    let (uid, gid) = user.split_once(':').ok_or_else(|| {
        error(
            "environment_user",
            "Environment delivery requires an explicit numeric UID:GID.",
        )
    })?;
    let parse = |v: &str| -> Result<u32, CandidateError> {
        if v.is_empty() || v.len() > 10 || !v.bytes().all(|b| b.is_ascii_digit()) {
            return Err(error("environment_user", "Invalid numeric UID:GID."));
        }
        v.parse::<u32>()
            .ok()
            .filter(|v| *v <= i32::MAX as u32)
            .ok_or_else(|| error("environment_user", "Invalid numeric UID:GID."))
    };
    Ok((parse(uid)?, parse(gid)?))
}

pub(super) fn validate(config: &Value) -> Result<(), CandidateError> {
    identity(config)?;
    let entry = config["Entrypoint"]
        .as_array()
        .filter(|a| !a.is_empty())
        .ok_or_else(|| {
            error(
                "environment_entrypoint",
                "Environment delivery requires an explicit absolute entrypoint.",
            )
        })?;
    if !entry[0].as_str().is_some_and(|s| s.starts_with('/'))
        || config.get("Healthcheck").is_some()
        || config["StopSignal"]
            .as_str()
            .is_some_and(|s| !["SIGTERM", "SIGINT", "SIGQUIT", "SIGKILL"].contains(&s))
    {
        return Err(error(
            "environment_entrypoint",
            "Environment delivery requires an absolute entrypoint and no separate health exec; unsupported stop signals remain gated.",
        ));
    }
    for mount in config["HostConfig"]["Mounts"]
        .as_array()
        .into_iter()
        .flatten()
    {
        let target = mount["Target"].as_str().unwrap_or("");
        if ["/run", "/"].contains(&target) || target.starts_with("/run/hack-environment") {
            return Err(error(
                "environment_mount",
                "A mount overlaps reserved environment paths.",
            ));
        }
    }
    Ok(())
}
pub(super) fn attach(config: &mut Value, path: &str, launcher: &str) -> Result<(), CandidateError> {
    validate(config)?;
    let (uid, gid) = identity(config)?;
    config["User"] = json!(format!("{uid}:{gid}"));
    config["Healthcheck"] = json!({"Test":["NONE"]});
    let mut command = config["Entrypoint"].as_array().unwrap().clone();
    command.extend(config["Cmd"].as_array().into_iter().flatten().cloned());
    let mut entry = vec![
        json!("/run/hack-environment-launcher"),
        json!("/run/hack-environment.json"),
        json!("/run/hack-environment.expires"),
    ];
    entry.extend(command);
    config["Entrypoint"] = json!(entry);
    config["Cmd"] = json!([]);
    let expiry = format!(
        "{}/expires",
        path.rsplit_once('/').expect("verified path").0
    );
    let mounts = config["HostConfig"]["Mounts"]
        .as_array_mut()
        .expect("compiled mounts");
    for (source, target) in [
        (path, "/run/hack-environment.json"),
        (expiry.as_str(), "/run/hack-environment.expires"),
        (launcher, "/run/hack-environment-launcher"),
    ] {
        mounts.push(json!({"Type":"bind","Source":source,"Target":target,"ReadOnly":true,"BindOptions":{"Propagation":"rprivate"}}));
    }
    Ok(())
}

#[cfg(not(feature = "environment-launcher"))]
pub(super) fn publish(_: &Engine<'_>) -> Result<String, CandidateError> {
    Err(error(
        "environment_launcher_disabled",
        "Build with the environment-launcher feature for experimental delivery.",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config() -> Value {
        json!({"Entrypoint":["/bin/app","--flag"],"Cmd":["space argument"],"User":"1001:1002","HostConfig":{"Init":true,"Mounts":[]}})
    }
    #[test]
    fn adapter_preserves_argv_and_identity_without_environment_values() {
        let mut value = config();
        attach(&mut value, "/run/slot/values.json", "/storage/launcher").unwrap();
        assert_eq!(
            value["Entrypoint"],
            json!([
                "/run/hack-environment-launcher",
                "/run/hack-environment.json",
                "/run/hack-environment.expires",
                "/bin/app",
                "--flag",
                "space argument"
            ])
        );
        assert_eq!(value["User"], "1001:1002");
        assert_eq!(value["Cmd"], json!([]));
        assert!(value.get("Env").is_none());
        assert_eq!(value["Healthcheck"]["Test"], json!(["NONE"]));
        assert!(
            value["HostConfig"]["Mounts"]
                .as_array()
                .unwrap()
                .iter()
                .all(|m| m["ReadOnly"] == true)
        );
    }
    #[test]
    fn ambiguous_users_health_exec_and_mount_collisions_refuse_before_attachment() {
        for user in ["bun", "1000", "-1:2", "1:4294967295", "1:", "1:2:3"] {
            let mut value = config();
            value["User"] = json!(user);
            assert!(validate(&value).is_err());
        }
        for target in ["/", "/run", "/run/hack-environment.json"] {
            let mut value = config();
            value["HostConfig"]["Mounts"] = json!([{"Target":target}]);
            assert!(validate(&value).is_err());
        }
        let mut value = config();
        value["Healthcheck"] = json!({"Test":["CMD","true"]});
        assert!(validate(&value).is_err());
        let mut value = config();
        value["Entrypoint"] = json!(["app"]);
        assert!(validate(&value).is_err());
    }
}
