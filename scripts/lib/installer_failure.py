"""Fixed diagnostics from an owned installer observer; never serialize raw logs."""

import json

SIGNALS = (
    "integrity_failure", "archive_failure", "authentication_failure",
    "dns_failure", "timeout_failure", "connection_failure", "tls_failure",
    "read_only_failure", "permission_failure", "space_failure",
    "allocation_failure", "io_failure", "prisma_failure", "frozen_lock_failure",
)


def installer_failure(observation):
    """A classifier hit alone is not proof that an installation failed."""
    code = observation.get("container_exit_code")
    if (observation.get("observer_started") is not True
            or type(code) is not int or not 1 <= code <= 255
            or observation.get("install_failure") is not True
            or observation.get("initialized") is not False
            or observation.get("reused") is not False):
        return None
    # A breached observation cannot support a diagnostic classification.
    if (observation.get("credential_echo_detected") is not False
            or observation.get("log_budget_exceeded") is not False
            or observation.get("log_observer_failed", False) is not False):
        return {"service": "deps", "exit_code": code,
                "kind": "installer_failed", "signals": [],
                "classification_complete": False}
    return {"service": "deps", "exit_code": code,
            "kind": "installer_failed",
            "signals": [name for name in SIGNALS if observation.get(name) is True],
            "classification_complete": False}


def record_installer_failures(result, observers, active_run):
    """Preserve the triggering exception; enrich only failed runs with live evidence.

    Call once on failure and again after observer retirement. Callers own observer
    identity/locking; summaries are read from owned objects, never arbitrary files.
    """
    if "error_type" not in result or active_run is None:
        return
    # Refresh must not retain a classification contradicted by later evidence.
    result.pop("observed_installer_failures", None)
    # EOF may be induced by observer retirement; positive signals are not exhaustive.
    failures = []
    unavailable = False
    for observer in observers:
        try:
            if observer.run != active_run or observer.service != "deps":
                continue
            failure = installer_failure(observer.persist())
        except Exception:
            unavailable = True
            continue
        if failure is not None and failure not in failures:
            failures.append(failure)
    if failures:
        result["observed_installer_failures"] = failures
    if unavailable:
        result["installer_failure_observation_unavailable"] = True


def persist_failure_report(result, observers, active_run, path):
    """Reporting must never replace an existing exception or skip owned cleanup."""
    try:
        record_installer_failures(result, observers, active_run)
        path.write_text(json.dumps(result, indent=2))
    except Exception:
        result["installer_failure_report_unavailable"] = True
