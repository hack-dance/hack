//! Guest allocations stay recorded until both process exit and allocation removal are confirmed.
use super::*;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum Transport {
    #[default]
    #[serde(rename = "raw")]
    Raw,
    #[serde(rename = "reservation-v1")]
    ReservationV1,
}
impl Transport {
    fn argument(self) -> &'static str {
        match self {
            Self::Raw => "raw",
            Self::ReservationV1 => "reservation-v1",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Relay {
    #[serde(default)]
    pub transport: Transport,
    #[serde(default)]
    pub launch_serial: u64,
    pub binary_sha256: String,
    pub target_pid: u32,
    pub target_start: u64,
    pub port: u16,
}
impl Relay {
    pub(super) fn valid(&self) -> bool {
        (self.transport == Transport::Raw || self.launch_serial != 0)
            && self.launch_serial <= i64::MAX as u64
            && hex(&self.binary_sha256, 64)
            && (2..=i32::MAX as u32).contains(&self.target_pid)
            && (1..=i64::MAX as u64).contains(&self.target_start)
            && self.port != 0
    }
}
#[cfg(feature = "native-stream-relay")]
pub(super) fn payload() -> Result<(String, String), CandidateError> {
    use base64::Engine as _;
    use sha2::{Digest, Sha256};
    use std::io::Write;
    let bytes = include_bytes!(concat!(env!("OUT_DIR"), "/stream-relay"));
    let hash = format!("{:x}", Sha256::digest(bytes));
    let mut zip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    zip.write_all(bytes).map_err(state::io)?;
    let input = base64::engine::general_purpose::STANDARD.encode(zip.finish().map_err(state::io)?);
    if input.len() > 48 * 1024 {
        return Err(error(
            "bridge_payload",
            "Relay exceeds bounded transport capacity.",
        ));
    }
    Ok((hash, input))
}
#[cfg(not(feature = "native-stream-relay"))]
pub(super) fn payload() -> Result<(String, String), CandidateError> {
    Err(error(
        "bridge_unavailable",
        "Relay startup requires a native-stream-relay build.",
    ))
}
pub(super) fn target_start(engine: &Engine<'_>, pid: u32) -> Result<u64, CandidateError> {
    let value = engine.guest().execute_cleanup(
        "test -r /proc/$1/stat; sed 's/.*) //' /proc/$1/stat | awk '{print $20}'",
        &[&pid.to_string()],
    )?;
    value
        .trim()
        .parse::<u64>()
        .ok()
        .filter(|v| *v > 0 && *v <= i64::MAX as u64)
        .ok_or_else(|| error("bridge_target", "Cannot establish target process identity."))
}
pub(super) fn operate(
    engine: &Engine<'_>,
    slot: u8,
    assignment: &bridges::Assignment,
    action: &str,
    input: Option<&str>,
) -> Result<String, CandidateError> {
    let relay = assignment
        .relay
        .as_ref()
        .ok_or_else(|| error("bridge_relay", "Missing relay intent."))?;
    let marker = format!(
        "{}:{}:{}:{}",
        engine.guest().incarnation(),
        assignment.run,
        assignment.reservation,
        assignment.boot_id
    );
    let args = [
        action.to_owned(),
        assignment.reservation.clone(),
        marker,
        format!("/run/hack-local/bridge-{slot:02}.sock"),
        relay.binary_sha256.clone(),
        relay.target_pid.to_string(),
        relay.target_start.to_string(),
        relay.port.to_string(),
        relay.launch_serial.to_string(),
        slot.to_string(),
        relay.transport.argument().to_owned(),
    ];
    let args = args.iter().map(String::as_str).collect::<Vec<_>>();
    let script = include_str!("relay.sh").replace("# RELAY_FENCE", include_str!("relay-fence.sh"));
    let result = if action == "start" {
        engine.guest().execute(&script, &args, input)?
    } else {
        engine.guest().execute_cleanup(&script, &args)?
    };
    let confirmed = match action {
        "start" => result == "running\n",
        "inspect" => ["running\n", "exited\n"].contains(&result.as_str()),
        "stop" => result == "stopped\n",
        "remove" => result == "removed\n",
        _ => false,
    };
    if !confirmed {
        return Err(error(
            "bridge_relay",
            "Unconfirmed relay operation; retain intent before recovery.",
        ));
    }
    Ok(result.trim().to_owned())
}

/// Actual relay-child and listener identity captured before their guest receipts
/// are removed. The assignment separately binds boot, reservation and launch serial.
#[cfg(target_os = "macos")]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct CleanupEvidence {
    pid: u32,
    start: u64,
    executable_device: u64,
    executable_inode: u64,
    socket_device: u64,
    socket_inode: u64,
    kernel_socket_inode: u64,
}
#[cfg(target_os = "macos")]
impl CleanupEvidence {
    pub(super) fn valid(&self) -> bool {
        (2..=i32::MAX as u32).contains(&self.pid)
            && (1..=i64::MAX as u64).contains(&self.start)
            && [
                self.executable_inode,
                self.socket_inode,
                self.kernel_socket_inode,
            ]
            .iter()
            .all(|id| *id > 0 && *id <= i64::MAX as u64)
    }
    fn parse(output: &str) -> Result<Self, CandidateError> {
        let fields = output
            .strip_suffix('\n')
            .ok_or_else(observation_refused)?
            .split(' ')
            .collect::<Vec<_>>();
        if fields.len() != 6 || fields[0] != "relay-captured-v1" {
            return Err(observation_refused());
        }
        let number = |value: &str| -> Result<u64, CandidateError> {
            let parsed = value.parse::<u64>().map_err(|_| observation_refused())?;
            if parsed.to_string() != value {
                return Err(observation_refused());
            }
            Ok(parsed)
        };
        let pair = |value: &str| -> Result<(u64, u64), CandidateError> {
            let (device, inode) = value.split_once(':').ok_or_else(observation_refused)?;
            Ok((number(device)?, number(inode)?))
        };
        let (executable_device, executable_inode) = pair(fields[3])?;
        let (socket_device, socket_inode) = pair(fields[4])?;
        let evidence = Self {
            pid: u32::try_from(number(fields[1])?).map_err(|_| observation_refused())?,
            start: number(fields[2])?,
            executable_device,
            executable_inode,
            socket_device,
            socket_inode,
            kernel_socket_inode: number(fields[5])?,
        };
        if !evidence.valid() {
            return Err(observation_refused());
        }
        Ok(evidence)
    }
}
#[cfg(target_os = "macos")]
fn observation_refused() -> CandidateError {
    error(
        "graph_bridge_observation",
        "Bridge cleanup requires complete same-boot reservation-v1 relay evidence; no guest mutation was performed.",
    )
}

#[cfg(target_os = "macos")]
fn observe_cleanup(
    engine: &Engine<'_>,
    slot: u8,
    assignment: &bridges::Assignment,
    evidence: Option<&CleanupEvidence>,
) -> Result<String, CandidateError> {
    let relay = assignment.relay.as_ref().ok_or_else(observation_refused)?;
    if !relay.valid()
        || relay.transport != Transport::ReservationV1
        || relay.launch_serial == 0
        || assignment.boot_id != engine.guest().boot_id()
        || !hex(&assignment.run, 32)
        || !hex(&assignment.reservation, 32)
        || evidence.is_some_and(|e| !e.valid())
    {
        return Err(observation_refused());
    }
    let args = [
        if evidence.is_some() {
            "retired".into()
        } else {
            "capture".into()
        },
        assignment.reservation.clone(),
        format!(
            "{}:{}:{}:{}",
            engine.guest().incarnation(),
            assignment.run,
            assignment.reservation,
            assignment.boot_id
        ),
        format!("/run/hack-local/bridge-{slot:02}.sock"),
        relay.binary_sha256.clone(),
        relay.launch_serial.to_string(),
        slot.to_string(),
        evidence.map_or(0, |e| e.pid).to_string(),
        evidence.map_or(0, |e| e.start).to_string(),
        evidence.map_or(0, |e| e.kernel_socket_inode).to_string(),
    ];
    let borrowed = args.iter().map(String::as_str).collect::<Vec<_>>();
    let output = engine
        .guest()
        .execute_cleanup(include_str!("relay-observe.sh"), &borrowed)?;
    check_observation_stage(&output)?;
    Ok(output)
}

// Only fixed numeric diagnostics are surfaced; guest output is never copied into errors.
#[cfg(target_os = "macos")]
fn check_observation_stage(output: &str) -> Result<(), CandidateError> {
    if !output.starts_with("relay-observation-refused") {
        return Ok(());
    }
    let stages = [
        "arguments",
        "runtime root",
        "fence directory",
        "fence lock",
        "fence state",
        "capture phase",
        "allocation owner",
        "helper binary",
        "process receipt",
        "live process",
        "executable identity",
        "socket identity",
        "namespace socket",
        "listener descriptor",
        "retirement fence",
        "process retirement",
        "allocation absence",
        "socket path absence",
    ];
    for (index, stage) in stages.iter().enumerate() {
        if output == format!("relay-observation-refused {}\n", index + 1) {
            return Err(error(
                "graph_bridge_observation",
                &format!(
                    "Bridge observation refused at stage {} ({stage}); no guest mutation was performed.",
                    index + 1
                ),
            ));
        }
    }
    Err(observation_refused())
}

/// Capture only a complete launched helper. Staging, legacy and uncertain fences
/// are explicit qualification gaps, never inferred to be empty or retired.
#[cfg(target_os = "macos")]
pub(super) fn capture_cleanup(
    engine: &Engine<'_>,
    slot: u8,
    assignment: &bridges::Assignment,
) -> Result<CleanupEvidence, CandidateError> {
    CleanupEvidence::parse(&observe_cleanup(engine, slot, assignment, None)?)
}
/// Independently verify captured generation retirement without invoking the helper,
/// editing its fence, or deleting allocations. This proves the actual helper
/// generation exited and its allocation/socket path vanished, not global descriptor
/// closure. Capture observes the helper's network namespace; no unrelated namespace
/// socket table is used as retirement evidence. A successor slot currently refuses.
#[cfg(target_os = "macos")]
pub(super) fn verify_cleanup(
    engine: &Engine<'_>,
    slot: u8,
    assignment: &bridges::Assignment,
    evidence: &CleanupEvidence,
) -> Result<(), CandidateError> {
    if observe_cleanup(engine, slot, assignment, Some(evidence))? != "relay-retired-v1\n" {
        return Err(observation_refused());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn observer_descriptor_loop_expands_only_its_controlled_glob() {
        use std::os::unix::fs::symlink;
        let directory =
            std::env::temp_dir().join(format!("hack-observe-glob-{}", std::process::id()));
        std::fs::create_dir(&directory).unwrap();
        struct Remove(std::path::PathBuf);
        impl Drop for Remove {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let _remove = Remove(directory.clone());
        std::fs::create_dir_all(directory.join("42/fd")).unwrap();
        symlink("socket:[999]", directory.join("42/fd/3")).unwrap();
        let script = include_str!("relay-observe.sh");
        let start = script.find(" set +f\n for fd").unwrap();
        let end = start + script[start..].find(" set -f\n").unwrap() + " set -f\n".len();
        let loop_body = script[start..end].replace("/proc/", "\"$1\"/");
        let program = format!(
            "set -efu\npid=42; kernel=999; found=0; root=$1; external=$2\n{loop_body}test \"$found\" = 1\nset -- \"$root\"/42/fd/*\ntest \"$#\" = 1\ntest \"$1\" = \"$root/42/fd/*\"\nset -- \"$external\"\ntest \"$1\" = 'untrusted * field'\n"
        );
        let output = std::process::Command::new("/bin/sh")
            .args(["-c", &program, "observer-glob"])
            .arg(&directory)
            .arg("untrusted * field")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn observation_stage_diagnostics_never_surface_arbitrary_guest_output() {
        let failure = check_observation_stage("relay-observation-refused 14\n").unwrap_err();
        assert!(failure.message.contains("stage 14 (listener descriptor)"));
        for invalid in [
            "relay-observation-refused 0\n",
            "relay-observation-refused 19\n",
            "relay-observation-refused 014\n",
            "relay-observation-refused PRIVATE_OUTPUT\n",
        ] {
            let failure = check_observation_stage(invalid).unwrap_err();
            assert!(!failure.message.contains("PRIVATE_OUTPUT"));
            assert!(!failure.message.contains("stage"));
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn cleanup_evidence_parses_only_complete_canonical_child_identity() {
        let line = "relay-captured-v1 42 123 1:456 1:789 999\n";
        let evidence = CleanupEvidence::parse(line).unwrap();
        assert!(evidence.valid());
        assert_eq!(evidence.pid, 42);
        assert_eq!(evidence.start, 123);
        assert_eq!(evidence.kernel_socket_inode, 999);
        let encoded = serde_json::to_vec(&evidence).unwrap();
        assert_eq!(
            serde_json::from_slice::<CleanupEvidence>(&encoded).unwrap(),
            evidence
        );
        for invalid in [
            "relay-captured-v1 1 123 1:456 1:789 999\n",
            "relay-captured-v1 042 123 1:456 1:789 999\n",
            "relay-captured-v1 42 0 1:456 1:789 999\n",
            "relay-captured-v1 42 123 1:0 1:789 999\n",
            "relay-captured-v1 42 123 1:456 1:789 0\n",
            "relay-captured-v1 42 123 1:456 1:789 999",
            "relay-captured-v1 42 123 1:456 1:789 999\nextra\n",
            "relay-captured-v1 42 123 1:456:7 1:789 999\n",
            "relay-captured-v1 4294967296 123 1:456 1:789 999\n",
        ] {
            assert!(
                CleanupEvidence::parse(invalid).is_err(),
                "accepted {invalid:?}"
            );
        }
        let mut invalid: Value = serde_json::from_slice(&encoded).unwrap();
        invalid["pid"] = json!(0);
        assert!(
            !serde_json::from_value::<CleanupEvidence>(invalid.clone())
                .unwrap()
                .valid()
        );
        invalid["unknown"] = json!(true);
        assert!(serde_json::from_value::<CleanupEvidence>(invalid).is_err());
    }

    #[test]
    fn transport_receipts_preserve_legacy_raw_and_reject_unknown_protocols() {
        let mut value = json!({
            "launch_serial":7,"binary_sha256":"a".repeat(64),
            "target_pid":2,"target_start":1,"port":3000
        });
        let legacy: Relay = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(legacy.transport, Transport::Raw);
        assert!(legacy.valid());
        value["transport"] = json!("reservation-v1");
        let guarded: Relay = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(guarded.transport, Transport::ReservationV1);
        assert!(guarded.valid());
        assert_eq!(serde_json::to_value(&guarded).unwrap(), value);
        value["launch_serial"] = json!(0);
        assert!(
            !serde_json::from_value::<Relay>(value.clone())
                .unwrap()
                .valid()
        );
        value["transport"] = json!("unknown");
        assert!(serde_json::from_value::<Relay>(value).is_err());
    }
}
