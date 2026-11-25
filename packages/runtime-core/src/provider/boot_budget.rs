//! Command-line budget for the pinned SmolVM 1.35.4 macOS launcher.
//! Review when changing the provider pin or allowing new machine settings.
use super::{BridgeIntent, DependencySocketIntent, state::Owner};
use crate::CandidateError;

const MAX_BYTES_WITH_NUL: usize = 2048;

// libkrun's aarch64 command line plus Hack's engine mount and the pinned
// launcher settings. Include both IP families, Rosetta, and kernel options
// that may be appended after the guest environment. Reserve the balance of
// 980 bytes for the provider's optional arguments and separators.
const FIXED_WITH_NUL: usize = 980;
const PER_PROJECT_SHARE: usize = 112;
const PUBLISH_SOCKETS_ENV: usize = 25;
const PER_BRIDGE: usize = 43;
const PER_DEPENDENCY: usize = 53;

fn bytes(shares: usize, bridges: u8, dependencies: u8) -> usize {
    let sockets = if bridges == 0 && dependencies == 0 {
        0
    } else {
        PUBLISH_SOCKETS_ENV
            + PER_BRIDGE * usize::from(bridges)
            + PER_DEPENDENCY * usize::from(dependencies)
    };
    FIXED_WITH_NUL + PER_PROJECT_SHARE * shares + sockets
}

pub(super) fn fits(shares: usize, bridges: u8, dependencies: u8) -> bool {
    bytes(shares, bridges, dependencies) <= MAX_BYTES_WITH_NUL
}

pub(super) fn check(
    shares: usize,
    bridges: Option<BridgeIntent>,
    dependencies: Option<DependencySocketIntent>,
) -> Result<(), CandidateError> {
    let bridges = bridges.map_or(0, |intent| intent.slots);
    let dependencies = dependencies.map_or(0, |intent| intent.slots);
    if !fits(shares, bridges, dependencies) {
        return Err(CandidateError::new(
            "pool_boot_command_line_budget",
            "This native pool configuration exceeds the provider's boot command-line budget. Reduce the published endpoints, host dependencies, or project shares before retrying. Existing pool data is kept.",
        ));
    }
    Ok(())
}

pub(super) fn check_owner(owner: &Owner) -> Result<(), CandidateError> {
    check(
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
    fn oversized_fresh_start_refuses_without_creating_provider_state() {
        let project = std::env::temp_dir().canonicalize().unwrap().join(format!(
            "boot-budget-{}-{}",
            std::process::id(),
            crate::next_test_scratch()
        ));
        std::fs::create_dir(&project).unwrap();
        let manifest = project.join("package.json");
        std::fs::write(&manifest, "{}").unwrap();
        let candidate = crate::Candidate::discover(&project).unwrap();
        let share = crate::provider::ProjectShareIntent::approve(&project, true).unwrap();
        let error = crate::provider::up_with_socket_requests(
            &candidate,
            crate::provider::Profile::Development,
            crate::provider::SocketRequests {
                minimum_bridges: Some(BridgeIntent::new(27).unwrap()),
                ..Default::default()
            },
            None,
            Some(share),
            None,
        )
        .unwrap_err();
        assert_eq!(error.code, "pool_boot_command_line_budget");
        assert!(!candidate.state_root.exists());
        std::fs::remove_file(manifest).unwrap();
        std::fs::remove_dir(project).unwrap();
    }

    #[test]
    fn all_project_shares_fit_the_default_mixed_socket_split() {
        assert_eq!(crate::provider::artifact::VERSION, "1.35.4");
        let mut line = FIXED.to_string();
        let fixed = line.len() + 1;
        assert!(fixed <= FIXED_WITH_NUL);
        for index in 1..=MAX_PROJECT_SHARES {
            line.push_str(&format!(
                " \"SMOLVM_MOUNT_{index}=smolvm{index}:/mnt/hack-projects/{}:rw\"",
                "f".repeat(64)
            ));
        }
        assert_eq!(line.len() + 1 - fixed, 8 * PER_PROJECT_SHARE);
        let without_sockets = line.len();
        line.push_str(concat!(
            " \"SMOLVM_PUBLISH_SOCKETS=6100|expose|/run/hack-local/bridge-00.sock;",
            "6101|expose|/run/hack-local/bridge-01.sock;",
            "6102|mount|/run/hack-dependencies/dependency-00.sock\""
        ));
        assert_eq!(
            line.len() - without_sockets,
            PUBLISH_SOCKETS_ENV + 2 * PER_BRIDGE + PER_DEPENDENCY
        );
        assert!(line.len() < MAX_BYTES_WITH_NUL);
        assert!(fits(MAX_PROJECT_SHARES, 2, 1));
        assert!(!fits(MAX_PROJECT_SHARES, 3, 1));
        assert!(!fits(MAX_PROJECT_SHARES, 2, 2));
        assert!(!fits(1, 27, 0));
    }
}
