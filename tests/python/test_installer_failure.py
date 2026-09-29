"""Failure-report controls; no runtimes, credentials, or external services."""
import importlib.util
from pathlib import Path
import unittest

path = Path(__file__).resolve().parents[2] / 'scripts/lib/installer_failure.py'
spec = importlib.util.spec_from_file_location('installer_failure', path)
failure = importlib.util.module_from_spec(spec)
spec.loader.exec_module(failure)


def observed(**changes):
    return dict(observer_started=True, container_exit_code=1, install_failure=True,
                initialized=False, reused=False, credential_echo_detected=False,
                log_budget_exceeded=False, log_stream_ended=True,
                **changes)


class Observer:
    run = 'current'
    service = 'deps'

    def __init__(self, summary):
        self.summary = summary

    def persist(self):
        return self.summary


class InstallerFailureTests(unittest.TestCase):
    def test_integrity_is_retained_with_original_exception(self):
        original = AssertionError('sampler identity assertion')
        result = {}
        observer = Observer(observed(integrity_failure=True))
        with self.assertRaises(AssertionError) as caught:
            try:
                raise original
            except BaseException as error:
                result['error_type'] = type(error).__name__
                failure.record_installer_failures(result, [observer], 'current')
                raise
        self.assertIs(caught.exception, original)
        self.assertEqual(result['error_type'], 'AssertionError')
        self.assertEqual(result['observed_installer_failures'][0]['signals'], ['integrity_failure'])

    def test_late_exit_is_collected_after_observer_retirement(self):
        observer = Observer(observed())
        observer.summary.pop('container_exit_code')
        result = {'error_type': 'AssertionError'}
        failure.record_installer_failures(result, [observer], 'current')
        self.assertNotIn('observed_installer_failures', result)
        observer.summary['container_exit_code'] = 1
        failure.record_installer_failures(result, [observer], 'current')
        self.assertEqual(result['observed_installer_failures'][0]['exit_code'], 1)

    def test_foreign_run_and_other_services_are_not_attributed(self):
        for attr, value in [('run', 'other'), ('service', 'www')]:
            observer = Observer(observed())
            setattr(observer, attr, value)
            result = {'error_type': 'AssertionError'}
            failure.record_installer_failures(result, [observer], 'current')
            self.assertNotIn('observed_installer_failures', result)

    def test_late_conflicting_evidence_removes_earlier_classification(self):
        for flag in ['initialized', 'reused']:
            observer = Observer(observed(integrity_failure=True))
            result = {'error_type': 'AssertionError'}
            failure.record_installer_failures(result, [observer], 'current')
            self.assertIn('observed_installer_failures', result)
            observer.summary[flag] = True
            failure.record_installer_failures(result, [observer], 'current')
            self.assertNotIn('observed_installer_failures', result)
            self.assertEqual(result['error_type'], 'AssertionError')

    def test_nonterminal_or_inconsistent_evidence_has_no_classification(self):
        for key, values in {
            'container_exit_code': [None, 0, True, '1', -1, 256],
            'observer_started': [False, None],
            'install_failure': [False, None],
            'initialized': [True, None],
            'reused': [True, None],
        }.items():
            for value in values:
                summary = observed(integrity_failure=True)
                summary[key] = value
                self.assertIsNone(failure.installer_failure(summary))

    def test_privacy_breach_keeps_exit_but_discards_classification(self):
        for key in ['credential_echo_detected', 'log_budget_exceeded', 'log_observer_failed']:
            summary = observed(integrity_failure=True, sanitized_error_excerpts=['SYNTHETIC_SECRET'])
            summary[key] = True
            result = failure.installer_failure(summary)
            self.assertEqual(result['signals'], [])
            self.assertFalse(result['classification_complete'])
            self.assertNotIn('SYNTHETIC_SECRET', str(result))

    def test_multiple_signals_are_not_relabelled_as_one_root_cause(self):
        result = failure.installer_failure(observed(integrity_failure=True, archive_failure=True,
            unknown_private_field='SYNTHETIC_SECRET', dns_failure='true'))
        self.assertEqual(result['signals'], ['integrity_failure', 'archive_failure'])
        self.assertNotIn('SYNTHETIC_SECRET', str(result))

    def test_observation_error_does_not_replace_original_failure(self):
        class Broken(Observer):
            def persist(self):
                raise OSError('SYNTHETIC_SECRET')
        result = {'error_type': 'AssertionError'}
        failure.record_installer_failures(result, [Broken({})], 'current')
        self.assertEqual(result, {'error_type': 'AssertionError',
            'installer_failure_observation_unavailable': True})

    def test_eof_does_not_claim_complete_log_delivery(self):
        result = failure.installer_failure(observed(integrity_failure=True))
        self.assertFalse(result['classification_complete'])
        self.assertEqual(result['signals'], ['integrity_failure'])

    def test_reporting_io_failure_never_skips_remaining_cleanup(self):
        class FullDisk:
            def write_text(self, _):
                raise OSError('SYNTHETIC_SECRET')
        original = AssertionError('sampler')
        result = {'error_type': 'AssertionError'}
        cleanup = []
        with self.assertRaises(AssertionError) as caught:
            try:
                raise original
            finally:
                failure.persist_failure_report(result, [Observer(observed())], 'current', FullDisk())
                cleanup.append('remaining-owned-resources')
        self.assertIs(caught.exception, original)
        self.assertEqual(cleanup, ['remaining-owned-resources'])
        self.assertTrue(result['installer_failure_report_unavailable'])
        self.assertNotIn('SYNTHETIC_SECRET', str(result))

    def test_malformed_observer_metadata_is_reporting_unavailability(self):
        result = {'error_type': 'AssertionError'}
        failure.record_installer_failures(result, [object()], 'current')
        self.assertTrue(result['installer_failure_observation_unavailable'])

    def test_success_is_not_modified(self):
        result = {'qualified': True}
        failure.record_installer_failures(result, [Observer(observed())], 'current')
        self.assertEqual(result, {'qualified': True})


if __name__ == '__main__':
    unittest.main()
