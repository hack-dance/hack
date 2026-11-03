//! Harness budgets for tests that drive fake backends.

use std::time::Duration;

/// Harness deadline for one fake-backend operation in a test: a graph run, selection,
/// exec, log read, or a persistent-data enrollment or retained read.
///
/// The fakes answer at once, so a passing call returns without waiting on this budget;
/// it only bounds a call that would otherwise hang. It is a test budget, not a product
/// bound: `execution::run` still refuses budgets above its own 600 s limit, and cases
/// that exercise expiry pass their own short or zero deadline. Fixed 1-5 s deadlines
/// failed with `graph_timeout` under host load (journal writes and syncs on a loaded
/// host), so these calls take their deadline from this one constant.
pub(crate) const TEST_RUN_BUDGET: Duration = Duration::from_secs(120);
