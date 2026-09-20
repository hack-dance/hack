//! Typed private relay delivery. Dropping a transport is not proof of guest exit.
use super::{OwnedGuest, command};
use crate::{CandidateError, provider::relay_auth::PrivateInput};
use serde::{Deserialize, Serialize};
use std::{
    io::{self, Read},
    net::Ipv4Addr,
    os::fd::AsRawFd,
    process::{Child, ChildStderr, ChildStdout, ExitStatus, Stdio},
    time::{Duration, Instant},
};
fn refused() -> CandidateError {
    CandidateError::new(
        "relay_private_child",
        "Private relay child operation was refused; guest state may require reconciliation.",
    )
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RelayProcess {
    pub pid: u32,
    pub start: u64,
    pub port: u16,
    #[serde(default = "legacy_address", skip_serializing_if = "is_legacy_address")]
    pub address: Ipv4Addr,
}
fn legacy_address() -> Ipv4Addr {
    Ipv4Addr::LOCALHOST
}
fn is_legacy_address(address: &Ipv4Addr) -> bool {
    *address == Ipv4Addr::LOCALHOST
}
fn valid_address(slot: u8, address: Ipv4Addr) -> bool {
    slot < 32 && (address == Ipv4Addr::LOCALHOST || address == Ipv4Addr::new(127, 0, 0, slot + 2))
}
pub(crate) struct RelayLaunch<'a> {
    pub container: &'a str,
    pub uid: u32,
    pub gid: u32,
    pub slot: u8,
    pub port: u16,
    pub address: Ipv4Addr,
}
impl RelayLaunch<'_> {
    fn valid(&self) -> bool {
        self.container.len() == 64
            && self
                .container
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            && valid_address(self.slot, self.address)
            && self.port != 0
    }
}
/// Owns only the host transport process. Guest identity is retained separately;
/// Drop kills/waits the transport but cannot claim to have stopped its guest child.
pub(crate) struct RelayChild {
    child: Option<Child>,
    status: Option<ExitStatus>,
    stdout: ChildStdout,
    stderr: ChildStderr,
    out: Vec<u8>,
    err: Vec<u8>,
    container: String,
    runtime: String,
    boot: String,
    port: u16,
    address: Ipv4Addr,
    slot: u8,
    uid: u32,
    gid: u32,
    process: Option<RelayProcess>,
}
fn nonblocking(fd: i32) -> Result<(), CandidateError> {
    // SAFETY: callers retain ownership of this live pipe descriptor.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(refused());
    }
    Ok(())
}
fn drain(
    reader: &mut impl Read,
    output: &mut Vec<u8>,
    available: usize,
) -> Result<(), CandidateError> {
    let mut bytes = [0; 512];
    let mut remaining = available;
    loop {
        match reader.read(&mut bytes) {
            Ok(0) => return Ok(()),
            Ok(n) if n <= remaining => {
                output.extend_from_slice(&bytes[..n]);
                remaining -= n;
            }
            Ok(_) => return Err(refused()),
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => return Ok(()),
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(_) => return Err(refused()),
        }
    }
}
fn parse(
    bytes: &[u8],
    address: Ipv4Addr,
    port: u16,
) -> Result<Option<RelayProcess>, CandidateError> {
    if !bytes.contains(&b'\n') {
        return Ok(None);
    }
    let text = std::str::from_utf8(bytes).map_err(|_| refused())?;
    let line = text.strip_suffix('\n').ok_or_else(refused)?;
    let (rest, version) = if let Some(rest) = line.strip_prefix("hack-relay-listener-v1 pid=") {
        if address != Ipv4Addr::LOCALHOST {
            return Err(refused());
        }
        (rest, 1)
    } else {
        (
            line.strip_prefix("hack-relay-listener-v2 pid=")
                .ok_or_else(refused)?,
            2,
        )
    };
    let (pid, rest) = rest.split_once(" start=").ok_or_else(refused)?;
    let (start, selected_port) = if version == 1 {
        rest.split_once(" port=").ok_or_else(refused)?
    } else {
        let (start, rest) = rest.split_once(" address=").ok_or_else(refused)?;
        let (selected, port) = rest.split_once(" port=").ok_or_else(refused)?;
        if selected != address.to_string() {
            return Err(refused());
        }
        (start, port)
    };
    let process = RelayProcess {
        address,
        pid: pid.parse().map_err(|_| refused())?,
        start: start.parse().map_err(|_| refused())?,
        port: selected_port.parse().map_err(|_| refused())?,
    };
    if process.pid <= 1
        || process.start == 0
        || process.port != port
        || process.pid.to_string() != pid
        || process.start.to_string() != start
        || process.port.to_string() != selected_port
    {
        return Err(refused());
    }
    Ok(Some(process))
}
impl RelayChild {
    // Retained from this process's checked launch, never reconstructed from a
    // receipt or supplied by a cleanup caller. Root with all capabilities dropped
    // cannot inspect/signal another UID; the launch UID needs no added privilege.
    fn stop_user(&self) -> String {
        format!("{}:{}", self.uid, self.gid)
    }
    fn from_child(
        mut child: Child,
        launch: RelayLaunch<'_>,
        runtime: &str,
        boot: &str,
    ) -> Result<Self, CandidateError> {
        let (stdout, stderr) = match (child.stdout.take(), child.stderr.take()) {
            (Some(out), Some(err)) => (out, err),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(refused());
            }
        };
        let handle = Self {
            child: Some(child),
            status: None,
            stdout,
            stderr,
            out: Vec::new(),
            err: Vec::new(),
            container: launch.container.into(),
            runtime: runtime.into(),
            boot: boot.into(),
            port: launch.port,
            address: launch.address,
            slot: launch.slot,
            uid: launch.uid,
            gid: launch.gid,
            process: None,
        };
        nonblocking(handle.stdout.as_raw_fd())?;
        nonblocking(handle.stderr.as_raw_fd())?;
        Ok(handle)
    }
    fn drain(&mut self) -> Result<(), CandidateError> {
        let available = 4096_usize
            .checked_sub(self.out.len() + self.err.len())
            .ok_or_else(refused)?;
        drain(&mut self.stdout, &mut self.out, available)?;
        let available = 4096_usize
            .checked_sub(self.out.len() + self.err.len())
            .ok_or_else(refused)?;
        drain(&mut self.stderr, &mut self.err, available)
    }
    // May be called only after independent guest absence proof.
    fn reap_after_absence(&mut self) -> Result<(), CandidateError> {
        if let Some(transport) = self.child.as_mut() {
            let status = match transport.try_wait().map_err(|_| refused())? {
                Some(status) => status,
                None => {
                    if transport.kill().is_err()
                        && transport.try_wait().map_err(|_| refused())?.is_none()
                    {
                        return Err(refused());
                    }
                    transport.wait().map_err(|_| refused())?
                }
            };
            self.status = Some(status);
            self.child.take();
        }
        Ok(())
    }
    /// Nonblocking observation; readiness proves a listener, not authentication.
    pub(crate) fn poll_ready(&mut self) -> Result<Option<RelayProcess>, CandidateError> {
        if self.poll_exit()?.is_some() {
            return Err(refused());
        }
        let process = parse(&self.out, self.address, self.port)?;
        if let Some(process) = process {
            self.process = Some(process);
        }
        Ok(process)
    }
    pub(crate) fn poll_exit(&mut self) -> Result<Option<ExitStatus>, CandidateError> {
        self.drain()?;
        if let Some(child) = self.child.as_mut() {
            if let Some(status) = child.try_wait().map_err(|_| refused())? {
                self.status = Some(status);
                self.child.take();
                self.drain()?;
            }
        }
        Ok(self.status)
    }
}
impl Drop for RelayChild {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
impl OwnedGuest<'_> {
    /// Caller must persist launch intent, verify container ownership/configuration,
    /// and revoke the grant on failure. Credentials travel only through child stdin.
    pub(in crate::provider) fn launch_relay_listener(
        &self,
        options: RelayLaunch<'_>,
        input: PrivateInput,
    ) -> Result<RelayChild, CandidateError> {
        if !options.valid()
            || self
                .owner
                .dependency_sockets
                .is_none_or(|intent| options.slot >= intent.slots)
        {
            return Err(refused());
        }
        self.require_allocation()?;
        self.verify()?;
        self.before_effect()?;
        let user = format!("{}:{}", options.uid, options.gid);
        let slot = options.slot.to_string();
        let port = options.port.to_string();
        let address = options.address.to_string();
        let child = command(self.candidate, &self.owner)
            .args([
                "machine",
                "exec",
                "--name",
                &self.owner.machine,
                "-i",
                "--",
                "/opt/hack-engine/docker",
                "--host",
                "unix:///run/hack-local/docker.sock",
                "exec",
                "-i",
                "--user",
                &user,
                options.container,
                "/run/hack-relay-guest",
                "--slot",
                &slot,
                "--listen-port",
                &port,
                "--listen-address",
                &address,
            ])
            .stdin(input.into_stdin())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|_| refused())?;
        let handle = RelayChild::from_child(child, options, self.incarnation(), self.boot_id())?;
        self.verify()?;
        Ok(handle)
    }
    /// Recheck the retained container and process generation. Accept independently
    /// proven guest absence, or signal the matching process and prove its absence.
    /// Reap the outer transport separately; its exit is never guest-death evidence.
    pub(in crate::provider) fn stop_relay_listener(
        &self,
        child: &mut RelayChild,
        budget: Duration,
    ) -> Result<(), CandidateError> {
        if budget.is_zero()
            || budget > Duration::from_secs(30)
            || child.runtime != self.incarnation()
            || child.boot != self.boot_id()
        {
            return Err(refused());
        }
        self.verify()?;
        let process = child.process.ok_or_else(refused)?;
        if process.address != child.address
            || process.port != child.port
            || !valid_address(child.slot, child.address)
        {
            return Err(refused());
        }
        let deadline = Instant::now() + budget;
        let script = STOP;
        let guarded = format!(
            "set -eu\ntest \"$(cat /proc/sys/kernel/random/boot_id)\" = \"$1\"\ntest \"$(cat /storage/.hack-local-owner)\" = \"$2\"\nshift 2\n{script}"
        );
        let stop = command(self.candidate, &self.owner)
            .args([
                "machine",
                "exec",
                "--name",
                &self.owner.machine,
                "--",
                "/bin/sh",
                "-c",
                &guarded,
                "sh",
                self.boot_id(),
                self.incarnation(),
                &child.container,
                &process.pid.to_string(),
                &process.start.to_string(),
                &child.slot.to_string(),
                &process.address.to_string(),
                &process.port.to_string(),
                &child.stop_user(),
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|_| refused())?;
        let mut stop = RelayChild::from_child(
            stop,
            RelayLaunch {
                container: &child.container,
                uid: child.uid,
                gid: child.gid,
                slot: child.slot,
                port: child.port,
                address: child.address,
            },
            self.incarnation(),
            self.boot_id(),
        )?;
        loop {
            if Instant::now() >= deadline {
                return Err(refused());
            }
            if let Some(status) = stop.poll_exit()? {
                if !status.success() || stop.out != b"relay-guest-absent-v1\n" {
                    return Err(refused());
                }
                break;
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        self.verify()?;
        // Guest absence is independently established above. Reap the owned host
        // transport even if its exit was nonzero or Docker retained its connection.
        // This signal is not used as evidence of guest process death.
        child.reap_after_absence()?;
        Ok(())
    }
}
// Container absence is not inferred from a failed Docker request. A stopped
// container must still have its exact immutable identity and zero host PID.
// A reused process identity refuses without signalling the replacement.
const STOP: &str = r#"
set -eu
id=$1; p=$2; s=$3; slot=$4; address=$5; port=$6; user=$7
state=$(/opt/hack-engine/docker --host unix:///run/hack-local/docker.sock inspect --format '{{.Id}} {{.State.Running}} {{.State.Pid}}' "$id")
set -- $state
test "$#" = 3; test "$1" = "$id"
if test "$2" = false; then
  test "$3" = 0
else
  test "$2" = true
  case "$3" in ''|*[!0-9]*|0) exit 1;; esac
  /opt/hack-engine/docker --host unix:///run/hack-local/docker.sock exec --user "$user" "$id" /bin/sh -c '
set -eu
p=$1; s=$2; slot=$3; address=$4; port=$5
test "$(stat -f -c %T /proc)" = proc
if test ! -e "/proc/$p"; then exit 0; fi
test "$(readlink /proc/$p/exe)" = /run/hack-relay-guest
expected=$(printf "/run/hack-relay-guest\000--slot\000%s\000--listen-port\000%s\000--listen-address\000%s\000" "$slot" "$port" "$address" | od -An -tx1)
test "$(od -An -tx1 /proc/$p/cmdline)" = "$expected"
v=$(cat /proc/$p/stat); v=${v##*) }; set -- $v; shift 19
test "$1" = "$s"
kill -TERM "$p"
i=0
while test -e "/proc/$p"; do
  # Refuse a reused PID; never send another signal.
  v=$(cat /proc/$p/stat) || { test ! -e "/proc/$p"; break; }
  v=${v##*) }; set -- $v; shift 19; test "$1" = "$s"
  i=$((i+1)); test "$i" -lt 1000
  sleep 0.01
done
' sh "$p" "$s" "$slot" "$address" "$port"
fi
printf 'relay-guest-absent-v1\n'
"#;
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn marker_is_exact_canonical_and_port_bound() {
        assert_eq!(
            parse(
                b"hack-relay-listener-v1 pid=42 start=9 port=25252\n",
                Ipv4Addr::LOCALHOST,
                25252
            )
            .unwrap(),
            Some(RelayProcess {
                pid: 42,
                start: 9,
                port: 25252,
                address: Ipv4Addr::LOCALHOST,
            })
        );
        assert!(
            parse(b"hack-relay-listener-v1 pid=42", Ipv4Addr::LOCALHOST, 25252)
                .unwrap()
                .is_none()
        );
        for invalid in [
            "hack-relay-listener-v1 pid=01 start=9 port=25252\n",
            "hack-relay-listener-v1 pid=42 start=0 port=25252\n",
            "hack-relay-listener-v1 pid=42 start=9 port=25253\n",
            "hack-relay-listener-v1 pid=42 start=9 port=25252\nextra\n",
        ] {
            assert!(parse(invalid.as_bytes(), Ipv4Addr::LOCALHOST, 25252).is_err());
        }
    }
    #[test]
    fn selected_marker_and_legacy_receipt_bind_exact_address() {
        let address = Ipv4Addr::new(127, 0, 0, 2);
        let marker = b"hack-relay-listener-v2 pid=42 start=9 address=127.0.0.2 port=443\n";
        assert_eq!(
            parse(marker, address, 443).unwrap().unwrap().address,
            address
        );
        assert!(parse(marker, Ipv4Addr::LOCALHOST, 443).is_err());
        assert!(parse(marker, address, 444).is_err());
        assert!(
            parse(
                b"hack-relay-listener-v1 pid=42 start=9 port=443\n",
                address,
                443
            )
            .is_err()
        );
        assert!(
            parse(
                b"hack-relay-listener-v2 pid=42 start=9 address=127.000.0.2 port=443\n",
                address,
                443
            )
            .is_err()
        );
        let old: RelayProcess =
            serde_json::from_value(serde_json::json!({"pid":42,"start":9,"port":443})).unwrap();
        assert_eq!(old.address, Ipv4Addr::LOCALHOST);
        assert_ne!(old.address, address);
        assert_eq!(
            serde_json::to_value(old).unwrap(),
            serde_json::json!({"pid":42,"start":9,"port":443})
        );
        let selected = parse(marker, address, 443).unwrap().unwrap();
        assert_eq!(
            serde_json::to_value(selected).unwrap()["address"],
            "127.0.0.2"
        );
    }
    #[test]
    fn launch_address_cannot_escape_or_borrow_another_slot() {
        let id = "a".repeat(64);
        let mut launch = RelayLaunch {
            container: &id,
            uid: 1000,
            gid: 1000,
            slot: 0,
            port: 443,
            address: Ipv4Addr::new(127, 0, 0, 2),
        };
        assert!(launch.valid());
        for address in [
            Ipv4Addr::UNSPECIFIED,
            Ipv4Addr::new(127, 0, 0, 3),
            Ipv4Addr::new(127, 1, 0, 2),
        ] {
            launch.address = address;
            assert!(!launch.valid());
        }
        launch.slot = 31;
        launch.address = Ipv4Addr::new(127, 0, 0, 33);
        assert!(launch.valid());
    }
    #[test]
    fn launch_target_and_capacity_are_constrained() {
        let id = "a".repeat(64);
        let mut options = RelayLaunch {
            container: &id,
            uid: 1000,
            gid: 1000,
            slot: 31,
            port: 65535,
            address: Ipv4Addr::LOCALHOST,
        };
        assert!(options.valid());
        options.slot = 32;
        assert!(!options.valid());
        options.slot = 0;
        options.port = 0;
        assert!(!options.valid());
        options.port = 1;
        options.container = "a; injected";
        assert!(!options.valid());
    }
    #[test]
    fn output_limit_refuses_overflow_without_returning_bytes() {
        let mut output = Vec::new();
        assert!(drain(&mut &b"12345"[..], &mut output, 4).is_err());
        assert!(output.is_empty());
        drain(&mut &b"1234"[..], &mut output, 4).unwrap();
        assert_eq!(output.len(), 4);
    }
    #[test]
    fn independently_absent_guest_allows_reaping_failed_or_live_outer_transport() {
        for (command, uid, gid, expected_user) in [
            ("exit 7", 0, 0, "0:0"),
            ("exec /bin/sleep 30", 1001, 1002, "1001:1002"),
        ] {
            let child = std::process::Command::new("/bin/sh")
                .args(["-c", command])
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            let mut handle = RelayChild::from_child(
                child,
                RelayLaunch {
                    container: &"a".repeat(64),
                    uid,
                    gid,
                    slot: 0,
                    port: 25252,
                    address: Ipv4Addr::LOCALHOST,
                },
                "runtime",
                "boot",
            )
            .unwrap();
            if command == "exit 7" {
                let deadline = Instant::now() + Duration::from_secs(2);
                while handle.poll_exit().unwrap().is_none() {
                    assert!(Instant::now() < deadline);
                    std::thread::sleep(Duration::from_millis(2));
                }
                assert_eq!(handle.status.unwrap().code(), Some(7));
            }
            assert_eq!(handle.stop_user(), expected_user);
            // This tests host reaping only; production must first obtain STOP proof.
            handle.reap_after_absence().unwrap();
            assert!(handle.child.is_none());
            assert!(handle.status.is_some());
            handle.reap_after_absence().unwrap();
        }
    }
}
