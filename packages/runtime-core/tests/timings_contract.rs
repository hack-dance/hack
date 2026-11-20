//! Real process transport checks: diagnostics never replace a structured error.
use hack_runtime_core::timings::{PREFIX, REQUEST_ARGUMENT, Report, Step};
use std::process::Command;

#[test]
fn timing_transport_is_opt_in_and_preserves_failure() {
    for enabled in [false, true] {
        let mut command = Command::new(env!("CARGO_BIN_EXE_hack-runtime-candidate"));
        command
            .env_clear()
            .env("HACK_DAEMON_AUTOSTART_DISABLE", "1");
        if enabled {
            command.arg(REQUEST_ARGUMENT);
        }
        // Missing candidate root fails before discovery or any runtime operation.
        let output = command.output().unwrap();
        assert_eq!(output.status.code(), Some(2));
        assert!(output.stdout.is_empty());
        let stderr = String::from_utf8(output.stderr).unwrap();
        let mut reports = 0;
        let mut failures = 0;
        for line in stderr.lines() {
            if let Some(json) = line.strip_prefix(PREFIX) {
                let report: Report = serde_json::from_str(json).unwrap();
                assert!(report.valid());
                assert_eq!(report.records.len(), 1);
                assert_eq!(report.records[0].step, Step::RuntimeDispatch);
                assert_eq!(
                    report.records[0].outcome,
                    hack_runtime_core::timings::Outcome::Error
                );
                reports += 1;
            } else {
                let error: serde_json::Value = serde_json::from_str(line).unwrap();
                assert_eq!(error["code"], "missing_candidate_root");
                failures += 1;
            }
        }
        assert_eq!(failures, 1);
        assert_eq!(reports, usize::from(enabled));
    }
}
