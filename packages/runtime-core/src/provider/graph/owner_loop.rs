//! Foreground event decisions, shared by the native loop and portable regressions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Wake {
    Signal,
    Ready,
    ListenerExit,
    Timeout,
    PublisherExit,
    FrontendExit,
}
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Action {
    Cleanup,
    ReapPublisher,
    RefreshDependencies,
    Continue,
}

#[derive(Clone, Copy)]
pub(super) enum PublisherReadiness {
    Startup,
    Replacement,
}
impl PublisherReadiness {
    /// A new graph requires its whole set live; a replacement must not turn a
    /// retained sibling's historical exit into a new startup/cleanup failure.
    pub(super) fn blocked_by_exit(self, selected_down: bool, any_down: bool) -> bool {
        selected_down || (matches!(self, Self::Startup) && any_down)
    }
}
#[derive(Default)]
pub(super) struct OwnerLoop {
    pub(super) cleanup_attempted: bool,
}
impl OwnerLoop {
    /// Publisher loss degrades observation, but leaves authenticated down and
    /// later signal cleanup available. It never grants replacement authority.
    pub(super) fn step(&mut self, wake: Wake) -> Action {
        match wake {
            Wake::Signal | Wake::FrontendExit => {
                self.cleanup_attempted = true;
                Action::Cleanup
            }
            Wake::PublisherExit => Action::ReapPublisher,
            Wake::ListenerExit => Action::RefreshDependencies,
            Wake::Ready | Wake::Timeout => Action::Continue,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replacement_readiness_ignores_sibling_exits_but_never_its_own() {
        for selected in [false, true] {
            for any in [false, true] {
                assert_eq!(
                    PublisherReadiness::Startup.blocked_by_exit(selected, any),
                    selected || any
                );
                assert_eq!(
                    PublisherReadiness::Replacement.blocked_by_exit(selected, any),
                    selected
                );
            }
        }
    }

    #[test]
    fn publisher_exit_keeps_services_and_later_cleanup_available() {
        for stop in [Wake::Signal, Wake::FrontendExit, Wake::Ready] {
            let mut owner = OwnerLoop::default();
            let mut services_running = true;
            let mut port_up = true;
            let mut reaps = 0;
            let mut cleanups = 0;
            for wake in [Wake::PublisherExit, Wake::Timeout, stop] {
                match owner.step(wake) {
                    Action::Cleanup => {
                        cleanups += 1;
                        services_running = false;
                    }
                    Action::ReapPublisher => {
                        reaps += 1;
                        port_up = false;
                    }
                    Action::Continue if wake == Wake::Ready => {
                        // The ready descriptor admits the separately authenticated
                        // down request; publisher loss did not close control.
                        assert!(services_running);
                        cleanups += 1;
                        services_running = false;
                    }
                    Action::Continue | Action::RefreshDependencies => {}
                }
                if wake == Wake::PublisherExit {
                    assert!(services_running);
                    assert!(!owner.cleanup_attempted);
                    assert_eq!(cleanups, 0);
                }
            }
            assert_eq!((reaps, cleanups), (1, 1));
            assert!(!services_running);
            assert!(!port_up);
        }
    }

    #[test]
    fn listener_drift_does_not_stop_the_owner() {
        let mut owner = OwnerLoop::default();
        assert_eq!(owner.step(Wake::ListenerExit), Action::RefreshDependencies);
        assert!(!owner.cleanup_attempted);
    }
}
