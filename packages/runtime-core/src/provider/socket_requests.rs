//! Pool creation/admission intent, distinct from per-graph free-slot allocation.
use super::{BridgeIntent, DependencySocketIntent, bridge, dependency_socket};
use crate::CandidateError;

/// Each transport direction may select exact capacity or a minimum, never both.
/// Omission preserves the existing pool. New pools use the requested capacities.
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

#[cfg(test)]
mod tests {
    use super::*;
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
