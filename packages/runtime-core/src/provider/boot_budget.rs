//! Command-line budget for the pinned SmolVM 1.35.4 macOS launcher.
//! Review when changing the provider pin or allowing new machine settings.
use super::PoolLayout;
use super::{BridgeIntent, DependencySocketIntent, state::Owner};
use crate::CandidateError;

const MAX_BYTES_WITH_NUL: usize = 2048;

// libkrun's aarch64 command line plus Hack's engine mount and the pinned
// launcher settings. Include both IP families, Rosetta, and kernel options
// that may be appended after the guest environment. Reserve the balance of
// 980 bytes for the provider's optional arguments and separators.
const FIXED_WITH_NUL: usize = 980;
const PUBLISH_SOCKETS_ENV: usize = 25;

fn bytes(layout: PoolLayout, shares: usize, bridges: u8, dependencies: u8) -> usize {
    let (share, bridge, dependency) = match layout {
        PoolLayout::Legacy => (112, 43, 53),
        PoolLayout::CompactV1 => (53, 23, 22),
    };
    let sockets = if bridges == 0 && dependencies == 0 {
        0
    } else {
        PUBLISH_SOCKETS_ENV + bridge * usize::from(bridges) + dependency * usize::from(dependencies)
    };
    FIXED_WITH_NUL + share * shares + sockets
}

pub(super) fn fits(layout: PoolLayout, shares: usize, bridges: u8, dependencies: u8) -> bool {
    bytes(layout, shares, bridges, dependencies) <= MAX_BYTES_WITH_NUL
}

pub(super) fn check(
    layout: PoolLayout,
    shares: usize,
    bridges: Option<BridgeIntent>,
    dependencies: Option<DependencySocketIntent>,
) -> Result<(), CandidateError> {
    let bridges = bridges.map_or(0, |intent| intent.slots);
    let dependencies = dependencies.map_or(0, |intent| intent.slots);
    if !fits(layout, shares, bridges, dependencies) {
        return Err(CandidateError::new(
            "pool_boot_command_line_budget",
            "This native pool configuration exceeds the provider's boot command-line budget. Reduce the published endpoints, host dependencies, or project shares before retrying. Existing pool data is kept.",
        ));
    }
    Ok(())
}

pub(super) fn check_owner(owner: &Owner) -> Result<(), CandidateError> {
    check(
        owner.socket_layout,
        owner.project_shares().len(),
        owner.application_bridge,
        owner.dependency_sockets,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::MAX_PROJECT_SHARES;

    // Construct the pinned launcher's longest audited setting combination.
    // IPv6 is the provider's default two addresses, with no custom subnet.
    const FIXED: &str = concat!(
        "reboot=k panic=-1 panic_print=0 nomodule console=hvc0 rootfstype=virtiofs rw quiet no-kvmapf ",
        "init=/init.krun arm64.nopauth  KRUN_INIT=/sbin/init KRUN_WORKDIR=/   ",
        "\"HOME=/root\" \"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\" ",
        "\"TERM=xterm-256color\" \"SMOLVM_HOST_TIME_NS=9999999999999999999\" ",
        "\"SMOLVM_DISK_TRIM=0\" \"SMOLVM_MACHINE_NAME=hack-ffffffffffff\" ",
        "\"SMOLVM_MOUNT_0=smolvm0:/opt/hack-engine:ro\" \"SMOLVM_MOUNT_COUNT=9\" ",
        "\"SMOLVM_DOCKER_SOCKET=1\" \"SMOLVM_READY_MARKER=.smolvm-ready.ffffffffffffffff\" ",
        "\"SMOLVM_ROSETTA=1\" \"SMOLVM_NETWORK_BACKEND=virtio-net\" ",
        "\"SMOLVM_NETWORK_GUEST_IP=100.96.0.2\" \"SMOLVM_NETWORK_GATEWAY=100.96.0.1\" ",
        "\"SMOLVM_NETWORK_PREFIX_LEN=30\" \"SMOLVM_NETWORK_GUEST_MAC=02:53:4d:00:00:02\" ",
        "\"SMOLVM_NETWORK_GUEST_IP6=fd53:4d00::2\" \"SMOLVM_NETWORK_GATEWAY6=fd53:4d00::1\" ",
        "\"SMOLVM_NETWORK_PREFIX_LEN6=64\" \"SMOLVM_NETWORK_DNS=100.96.0.1\" ",
        "\"SMOLVM_NETWORK_MTU=65520\" \"SMOLVM_IDLE_POLL_US=50\" ",
        "maxcpus=4 tsi_host_network=0  -- \"/sbin/init\""
    );

    #[test]
    fn both_layouts_charge_their_encoded_paths() {
        assert_eq!(crate::provider::artifact::VERSION, "1.35.4");
        for (layout, bridges, dependencies, reserved) in [
            (PoolLayout::Legacy, 2, 1, 2040),
            (PoolLayout::CompactV1, 16, 8, 1973),
        ] {
            let mut line = FIXED.to_string();
            let digest = "f".repeat(64);
            for index in 1..=MAX_PROJECT_SHARES {
                line.push_str(&format!(
                    " \"SMOLVM_MOUNT_{index}=smolvm{index}:{}:rw\"",
                    layout.project(&digest)
                ));
            }
            let sockets = (0..bridges)
                .map(|slot| format!("{}|expose|{}", 6100 + u16::from(slot), layout.bridge(slot)))
                .chain((0..dependencies).map(|slot| {
                    format!(
                        "{}|mount|{}",
                        6100 + u16::from(bridges) + u16::from(slot),
                        layout.dependency(slot)
                    )
                }))
                .collect::<Vec<_>>();
            line.push_str(&format!(
                " \"SMOLVM_PUBLISH_SOCKETS={}\"",
                sockets.join(";")
            ));
            let modeled = bytes(layout, MAX_PROJECT_SHARES, bridges, dependencies);
            assert_eq!(modeled, reserved);
            assert_eq!(
                modeled - (line.len() + 1),
                FIXED_WITH_NUL - (FIXED.len() + 1)
            );
            assert!(fits(layout, MAX_PROJECT_SHARES, bridges, dependencies));
        }
        assert!(!fits(PoolLayout::Legacy, 1, 27, 0));
        assert!(!fits(PoolLayout::CompactV1, MAX_PROJECT_SHARES, 24, 8));
    }
}
