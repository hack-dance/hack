//! Pool creation/admission intent, distinct from per-graph free-slot allocation.
use super::{BridgeIntent, DependencySocketIntent, bridge, dependency_socket};
use crate::CandidateError;

/// Each transport direction may select exact capacity or a minimum, never both.
/// Omission preserves the existing pool. New development project pools keep spare slots.
#[derive(Default)]
pub struct SocketRequests {
    pub bridges: Option<BridgeIntent>,
    pub minimum_bridges: Option<BridgeIntent>,
    pub dependencies: Option<DependencySocketIntent>,
    pub minimum_dependencies: Option<DependencySocketIntent>,
}
impl SocketRequests {
    pub(super) fn resolve(
        self,
    ) -> Result<(bridge::Request, dependency_socket::Request), CandidateError> {
        if (self.bridges.is_some() && self.minimum_bridges.is_some())
            || (self.dependencies.is_some() && self.minimum_dependencies.is_some())
        {
            return Err(CandidateError::new(
                "invalid_arguments",
                "Exact and minimum capacity are mutually exclusive for each transport direction.",
            ));
        }
        let bridge = self.minimum_bridges.map_or(
            bridge::Request::Exact(self.bridges),
            bridge::Request::Minimum,
        );
        let dependency = self.minimum_dependencies.map_or(
            dependency_socket::Request::Exact(self.dependencies),
            dependency_socket::Request::Minimum,
        );
        dependency_socket::check_capacity(bridge.initial(), dependency.initial())?;
        Ok((bridge, dependency))
    }
}

/// Size a fresh development project pool after checking both requested counts.
/// Allocate required slots first, then give bridge headroom priority.
pub(super) fn fresh_project_capacity(
    bridge: bridge::Request,
    dependency: dependency_socket::Request,
) -> Result<(Option<BridgeIntent>, Option<DependencySocketIntent>), CandidateError> {
    // Leave room for the maximum eight project mounts in the provider's
    // boot command line. Actual project requirements take precedence.
    const DEFAULT_BRIDGES: u8 = 2;
    const DEFAULT_DEPENDENCIES: u8 = 1;

    let mut bridges = bridge.initial();
    let mut dependencies = dependency.initial();
    dependency_socket::check_capacity(bridges, dependencies)?;
    let requested_bridges = bridges.map_or(0, |intent| intent.slots);
    let requested_dependencies = dependencies.map_or(0, |intent| intent.slots);
    if !matches!(bridge, bridge::Request::Exact(Some(_))) {
        let slots = requested_bridges
            .max(DEFAULT_BRIDGES.min(dependency_socket::MAX_POOL_SOCKETS - requested_dependencies));
        bridges = (slots > 0).then_some(BridgeIntent { slots });
    }
    if !matches!(dependency, dependency_socket::Request::Exact(Some(_))) {
        let bridge_slots = bridges.map_or(0, |intent| intent.slots);
        let slots = requested_dependencies
            .max(DEFAULT_DEPENDENCIES.min(dependency_socket::MAX_POOL_SOCKETS - bridge_slots));
        dependencies = (slots > 0).then_some(DependencySocketIntent { slots });
    }
    if !super::boot_budget::fits(
        1,
        bridges.map_or(0, |value| value.slots),
        dependencies.map_or(0, |value| value.slots),
    ) {
        // Spare capacity must never make an otherwise admissible request fail.
        return Ok((bridge.initial(), dependency.initial()));
    }
    Ok((bridges, dependencies))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fresh_project_defaults_apply_only_to_unspecified_or_minimum_counts() {
        let size = |requests: SocketRequests| {
            let (bridge, dependency) = requests.resolve().unwrap();
            let (bridge, dependency) = fresh_project_capacity(bridge, dependency).unwrap();
            (
                bridge.map_or(0, |v| v.slots),
                dependency.map_or(0, |v| v.slots),
            )
        };
        assert_eq!(size(SocketRequests::default()), (2, 1));
        assert_eq!(
            size(SocketRequests {
                bridges: Some(BridgeIntent::new(1).unwrap()),
                minimum_dependencies: Some(DependencySocketIntent::new(5).unwrap()),
                ..Default::default()
            }),
            (1, 5)
        );
        assert_eq!(
            size(SocketRequests {
                minimum_bridges: Some(BridgeIntent::new(21).unwrap()),
                ..Default::default()
            }),
            (21, 0)
        );
        assert_eq!(
            size(SocketRequests {
                dependencies: Some(DependencySocketIntent::new(32).unwrap()),
                ..Default::default()
            }),
            (0, 32)
        );
    }

    #[test]
    fn exact_and_minimum_requirements_do_not_resize_or_overcommit() {
        let one = DependencySocketIntent::new(1).unwrap();
        let four = DependencySocketIntent::new(4).unwrap();
        let (_, request) = SocketRequests {
            minimum_dependencies: Some(one),
            ..Default::default()
        }
        .resolve()
        .unwrap();
        assert_eq!(request.initial(), Some(one));
        request.check(Some(one)).unwrap();
        request.check(Some(four)).unwrap();
        assert_eq!(
            request.check(None).unwrap_err().code,
            "dependency_socket_conflict"
        );
        assert!(
            dependency_socket::Request::Minimum(four)
                .check(Some(one))
                .is_err()
        );
        assert!(
            dependency_socket::Request::Exact(Some(one))
                .check(Some(four))
                .is_err()
        );
        dependency_socket::Request::Exact(None)
            .check(Some(four))
            .unwrap();
        assert!(
            SocketRequests {
                dependencies: Some(one),
                minimum_dependencies: Some(one),
                ..Default::default()
            }
            .resolve()
            .is_err()
        );
        assert!(
            SocketRequests {
                minimum_bridges: Some(BridgeIntent::new(32).unwrap()),
                minimum_dependencies: Some(one),
                ..Default::default()
            }
            .resolve()
            .is_err()
        );
    }
}
