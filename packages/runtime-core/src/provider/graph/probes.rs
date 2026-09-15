use super::super::http_probe::HttpProbe;
use super::*;
#[cfg(feature = "native-http-probe")]
use {
    base64::Engine as _,
    sha2::{Digest, Sha256},
};
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Probe {
    pub config: HttpProbe,
    pub allocation: String,
    pub generation: String,
    pub binary: String,
    pub uid: u32,
    pub gid: u32,
    pub exec_id: Option<String>,
    pub started_ms: u64,
    pub phase: String,
}
fn token() -> Result<String, CandidateError> {
    use std::io::Read;
    let mut bytes = [0u8; 16];
    fs::File::open("/dev/urandom")
        .map_err(state::io)?
        .read_exact(&mut bytes)
        .map_err(state::io)?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}
fn now() -> Result<u64, CandidateError> {
    Ok(std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| error("probe_clock", "Invalid observation clock."))?
        .as_millis() as u64)
}
pub(super) fn fresh(
    engine: &Engine<'_>,
    configs: &BTreeMap<String, Value>,
    probes: BTreeMap<String, HttpProbe>,
) -> Result<BTreeMap<String, Probe>, CandidateError> {
    if probes.is_empty() {
        return Ok(BTreeMap::new());
    }
    let binary = publish(engine)?;
    probes
        .into_iter()
        .map(|(name, config)| {
            let (uid, gid) = launcher::identity(&configs[&name])?;
            Ok((
                name,
                Probe {
                    config,
                    allocation: token()?,
                    generation: token()?,
                    binary: binary.clone(),
                    uid,
                    gid,
                    exec_id: None,
                    started_ms: 0,
                    phase: "reserved".into(),
                },
            ))
        })
        .collect()
}
pub(super) fn validate(receipt: &Receipt) -> Result<(), CandidateError> {
    if receipt.probes.len() > MAX_SERVICES {
        return Err(error("graph_probe_receipt", "Probe budget exceeded."));
    }
    let mut allocations = std::collections::BTreeSet::new();
    for (name, p) in &receipt.probes {
        p.config.validate()?;
        if (["starting", "running"].contains(&p.phase.as_str())
            && (p.exec_id.is_none() || p.started_ms == 0))
            || (["reserved", "allocation-intent", "allocated", "exec-intent"]
                .contains(&p.phase.as_str())
                && (p.exec_id.is_some() || p.started_ms != 0))
        {
            return Err(error(
                "graph_probe_receipt",
                "Probe phase and exec intent differ.",
            ));
        }
        if !receipt.resources.contains_key(&format!("container:{name}"))
            || !hex(&p.allocation, 32)
            || !hex(&p.generation, 32)
            || !allocations.insert(&p.allocation)
            || !p
                .binary
                .strip_prefix("/storage/hack-native-http-probe/")
                .is_some_and(|s| hex(s, 64))
            || p.exec_id.as_ref().is_some_and(|id| !hex(id, 64))
            || p.uid > i32::MAX as u32
            || p.gid > i32::MAX as u32
            || ![
                "reserved",
                "allocation-intent",
                "allocated",
                "exec-intent",
                "starting",
                "running",
                "retired",
            ]
            .contains(&p.phase.as_str())
        {
            return Err(error(
                "graph_probe_receipt",
                "Invalid graph probe identity.",
            ));
        }
    }
    Ok(())
}
fn path(p: &Probe) -> String {
    format!("/run/hack-local/http-probes/{}", p.allocation)
}
fn marker(receipt: &Receipt, name: &str, p: &Probe) -> String {
    format!(
        "{}:{}:{}:{}",
        receipt.owner,
        receipt.run,
        receipt.resources[&format!("container:{name}")].name,
        p.allocation
    )
}
fn execute(
    engine: &Engine<'_>,
    receipt: &Receipt,
    name: &str,
    action: &str,
) -> Result<(), CandidateError> {
    let p = &receipt.probes[name];
    let path = path(p);
    let marker = marker(receipt, name, p);
    let uid = p.uid.to_string();
    let gid = p.gid.to_string();
    let args = [
        action,
        path.as_str(),
        marker.as_str(),
        uid.as_str(),
        gid.as_str(),
        p.binary.as_str(),
    ];
    let output = if action == "remove" {
        engine.guest().execute_cleanup(STORAGE, &args)?
    } else {
        engine.guest().execute(STORAGE, &args, None)?
    };
    if output != "probe-storage-ready\n" {
        return Err(error(
            "graph_probe_storage",
            "Probe storage operation was not confirmed.",
        ));
    }
    Ok(())
}
fn attach(config: &mut Value, p: &Probe) {
    let mounts = config["HostConfig"]["Mounts"]
        .as_array_mut()
        .expect("prepared mounts");
    mounts.push(
        json!({"Type":"bind","Source":p.binary,"Target":"/run/hack-http-probe","ReadOnly":true}),
    );
    mounts.push(json!({"Type":"bind","Source":format!("{}/state",path(p)),"Target":"/run/hack-http-probe-state","ReadOnly":false}));
}
fn exec(
    engine: &Engine<'_>,
    receipt: &Receipt,
    name: &str,
) -> Result<Option<Value>, CandidateError> {
    let p = &receipt.probes[name];
    let Some(id) = &p.exec_id else {
        return Ok(None);
    };
    let value = match engine.request(Method::GET, &format!("/v1.53/exec/{id}/json"), None) {
        Ok(v) => v,
        Err(e) if e.code == "engine_not_found" => return Ok(None),
        Err(e) => return Err(e),
    };
    let container = receipt.resources[&format!("container:{name}")]
        .id
        .as_ref()
        .ok_or_else(|| error("graph_probe_identity", "Probe lacks a container identity."))?;
    if value["ContainerID"] != *container
        || value["ProcessConfig"]["entrypoint"] != "/run/hack-http-probe"
        || value["ProcessConfig"]["arguments"]
            != json!(
                p.config
                    .arguments("/run/hack-http-probe-state", &p.generation)?
            )
    {
        return Err(error(
            "graph_probe_identity",
            "Probe exec identity differs.",
        ));
    }
    Ok(Some(value))
}
pub(super) fn observe(
    engine: &Engine<'_>,
    receipt: &Receipt,
    name: &str,
    value: &Value,
) -> Result<Observation, CandidateError> {
    let observed = observation(value)?;
    let Some(p) = receipt.probes.get(name) else {
        return Ok(observed);
    };
    if !matches!(observed, Observation::Running { .. }) {
        return Ok(observed);
    }
    let healthy = if exec(engine, receipt, name)?.is_some_and(|v| v["Running"] == true) {
        let id = receipt.resources[&format!("container:{name}")]
            .id
            .as_ref()
            .unwrap();
        let now = now()?;
        match engine.probe_status(id)? {
            Some(raw) => p
                .config
                .health(&raw, &p.generation, true, now)
                .unwrap_or(Health::Unhealthy),
            None if now.saturating_sub(p.started_ms)
                <= p.config.interval_ms + p.config.timeout_ms + 1000 =>
            {
                Health::Starting
            }
            None => Health::Unhealthy,
        }
    } else {
        Health::Unhealthy
    };
    Ok(Observation::Running { health: healthy })
}
pub(super) fn cleanup(engine: &Engine<'_>, receipt: &mut Receipt) -> Result<(), CandidateError> {
    validate(receipt)?;
    for name in receipt.probes.keys().cloned().collect::<Vec<_>>() {
        if inspect_resource(
            engine,
            receipt,
            &receipt.resources[&format!("container:{name}")],
        )?
        .is_some()
            || exec(engine, receipt, &name)?.is_some_and(|v| v["Running"] == true)
        {
            return Err(error(
                "graph_probe_running",
                "Probe storage remains reserved while a container or exec exists.",
            ));
        }
        execute(engine, receipt, &name, "remove")?;
        receipt.probes.get_mut(&name).unwrap().phase = "retired".into();
    }
    Ok(())
}
impl Session<'_> {
    pub(super) fn prepare_probe(&mut self, name: &str) -> Result<(), CandidateError> {
        if !self.receipt.probes.contains_key(name) {
            return Ok(());
        }
        attach(
            self.configs.get_mut(name).unwrap(),
            &self.receipt.probes[name],
        );
        if self.restarting {
            let resource = &self.receipt.resources[&format!("container:{name}")];
            let value = inspect_resource(&self.engine, &self.receipt, resource)?
                .ok_or_else(|| error("graph_probe_identity", "Restart container disappeared."))?;
            self.verify_config(name, &value)?;
            if !matches!(observation(&value)?, Observation::Exited { .. }) {
                return Err(error(
                    "graph_probe_running",
                    "Restart container is not stopped.",
                ));
            }
            if exec(&self.engine, &self.receipt, name)?.is_some_and(|v| v["Running"] == true) {
                return Err(error(
                    "graph_probe_running",
                    "Prior probe is still running.",
                ));
            }
            let p = self.receipt.probes.get_mut(name).unwrap();
            p.generation = token()?;
            p.exec_id = None;
            p.started_ms = 0;
        }
        self.receipt.probes.get_mut(name).unwrap().phase = "allocation-intent".into();
        self.save()?;
        execute(
            &self.engine,
            &self.receipt,
            name,
            if self.restarting { "reset" } else { "create" },
        )?;
        #[cfg(test)]
        self.fault_pause("probe-after-allocation")?;
        self.receipt.probes.get_mut(name).unwrap().phase = "allocated".into();
        self.save()
    }
    pub(super) fn start_probe(&mut self, name: &str, id: &str) -> Result<(), CandidateError> {
        let Some(p) = self.receipt.probes.get_mut(name) else {
            return Ok(());
        };
        if p.phase != "allocated" || p.exec_id.is_some() {
            return Err(error(
                "graph_probe_replay",
                "Probe start cannot be replayed.",
            ));
        }
        p.phase = "exec-intent".into();
        self.save()?;
        let p = &self.receipt.probes[name];
        let mut args = vec!["/run/hack-http-probe".to_owned()];
        args.extend(
            p.config
                .arguments("/run/hack-http-probe-state", &p.generation)?,
        );
        let value=self.engine.request(Method::POST,&format!("/v1.53/containers/{id}/exec"),Some(&json!({"AttachStdout":false,"AttachStderr":false,"User":format!("{}:{}",p.uid,p.gid),"Cmd":args})))?;
        #[cfg(test)]
        self.fault_pause("probe-after-exec-create")?;
        let exec_id = value["Id"]
            .as_str()
            .filter(|v| hex(v, 64))
            .ok_or_else(|| error("graph_probe_identity", "Missing created probe identity."))?
            .to_owned();
        let p = self.receipt.probes.get_mut(name).unwrap();
        p.exec_id = Some(exec_id.clone());
        p.started_ms = now()?;
        p.phase = "starting".into();
        self.save()?;
        self.engine.request(
            Method::POST,
            &format!("/v1.53/exec/{exec_id}/start"),
            Some(&json!({"Detach":true,"Tty":false})),
        )?;
        #[cfg(test)]
        self.fault_pause("probe-after-exec-start")?;
        self.receipt.probes.get_mut(name).unwrap().phase = "running".into();
        self.save()
    }
}
const STORAGE: &str = r#"
(
set -eu
umask 077
action="$1"; root="$2"; marker="$3"; uid="$4"; gid="$5"; binary="$6"
parent=/run/hack-local/http-probes
test ! -L "$parent"
if test ! -e "$parent"; then mkdir -m 700 "$parent"; fi
test "$(stat -c %u:%g:%a "$parent")" = 0:0:700
test ! -L "$root"
if test "$action" = create; then
 test ! -e "$root"
 mkdir -m 700 "$root"
 printf %s "$marker" > "$root/owner"
 chmod 400 "$root/owner"
 mkdir -m 700 "$root/state"
else
 if test ! -e "$root"; then test "$action" = remove; exit 0; fi
fi
test "$(stat -c %u:%g:%a "$root")" = 0:0:700
test ! -L "$root/owner"
test "$(stat -c %u:%g:%a:%h "$root/owner")" = 0:0:400:1
test "$(cat "$root/owner")" = "$marker"
test ! -L "$root/state"
if findmnt -n --mountpoint "$root/state" >/dev/null; then
 test "$(findmnt -n -o FSTYPE --mountpoint "$root/state")" = tmpfs
 test "$action" != create
 umount "$root/state"
fi
if test "$action" = remove; then
 rmdir "$root/state"
 rm "$root/owner"
 rmdir "$root"
else
 test "$(stat -c %u:%g:%a "$root/state")" = 0:0:700
 test ! -L "$binary"
 test "$(stat -c %u:%g:%a:%h "$binary")" = 0:0:555:1
 test "$(sha256sum "$binary" | cut -d' ' -f1)" = "${binary##*/}"
 mount -t tmpfs -o "size=65536,mode=0700,uid=$uid,gid=$gid,nosuid,nodev,noexec" tmpfs "$root/state"
fi
) >/dev/null 2>&1
printf 'probe-storage-ready
'
"#;
#[cfg(feature = "native-http-probe")]
pub(super) fn publish(engine: &Engine<'_>) -> Result<String, CandidateError> {
    let bytes = super::super::http_probe::guest_binary();
    let hash = format!("{:x}", Sha256::digest(bytes));
    use std::io::Write;
    let mut compressed = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    compressed.write_all(bytes).map_err(state::io)?;
    let input =
        base64::engine::general_purpose::STANDARD.encode(compressed.finish().map_err(state::io)?);
    if input.len() > 56 * 1024 {
        return Err(error(
            "native_http_probe_budget",
            "Compressed launcher exceeds the bounded transport profile.",
        ));
    }
    let output = engine.guest().execute(PUBLISH, &[&hash], Some(&input))?;
    if output != "launcher-ready-v1\n" {
        return Err(error(
            "native_http_probe",
            "Launcher publication was not confirmed.",
        ));
    }
    Ok(format!("/storage/hack-native-http-probe/{hash}"))
}
#[cfg(feature = "native-http-probe")]
const PUBLISH: &str = r#"
(
set -eu
umask 077
root=/storage/hack-native-http-probe
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

#[cfg(not(feature = "native-http-probe"))]
fn publish(_: &Engine<'_>) -> Result<String, CandidateError> {
    Err(error(
        "native_http_unavailable",
        "Native HTTP binary was not built.",
    ))
}

pub(super) fn unchanged(
    configs: &BTreeMap<String, Value>,
    planned: &BTreeMap<String, HttpProbe>,
    receipt: &Receipt,
) -> Result<(), CandidateError> {
    if planned.len() != receipt.probes.len() {
        return Err(error(
            "graph_probe_plan",
            "Probe declarations differ from the reviewed plan.",
        ));
    }
    for (name, p) in &receipt.probes {
        if planned.get(name) != Some(&p.config)
            || launcher::identity(&configs[name])? != (p.uid, p.gid)
        {
            return Err(error(
                "graph_probe_plan",
                "Probe configuration differs from the reviewed plan.",
            ));
        }
    }
    Ok(())
}
