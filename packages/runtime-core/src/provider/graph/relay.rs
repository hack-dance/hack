//! Guest allocations stay recorded until both process exit and allocation removal are confirmed.
use super::*;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Relay {
    pub binary_sha256: String,
    pub target_pid: u32,
    pub target_start: u64,
    pub port: u16,
}
impl Relay {
    pub(super) fn valid(&self) -> bool {
        hex(&self.binary_sha256, 64)
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
    ];
    let args = args.iter().map(String::as_str).collect::<Vec<_>>();
    let result = if action == "start" {
        engine
            .guest()
            .execute(include_str!("relay.sh"), &args, input)?
    } else {
        engine
            .guest()
            .execute_cleanup(include_str!("relay.sh"), &args)?
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
