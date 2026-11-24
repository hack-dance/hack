"""Failure controls for the owned-backend measurement harness."""
import importlib.util
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

source = Path(__file__).resolve().parents[2] / "scripts/benchmark-mcp-adapter.py"
spec = importlib.util.spec_from_file_location("mcp_benchmark", source)
benchmark = importlib.util.module_from_spec(spec)
spec.loader.exec_module(benchmark)


class BenchmarkFailures(unittest.TestCase):
    def test_owner_failure_is_retained_without_a_lease(self):
        result = benchmark.shared_cohort("unused", "unused", 1, shutil.which("false"))
        self.assertIn("error", result)
        self.assertEqual(result["clients"], 1)
        self.assertEqual(result["backend_cleanup"], {"exit_code": 1, "forced": False})
        self.assertIsNone(result["retained_lease"])

    def test_foreign_socket_path_never_reaches_adapter(self):
        with tempfile.TemporaryDirectory(prefix="hack-benchmark-control-") as root:
            backend = Path(root, "backend")
            backend.write_text(f"#!{sys.executable}\nimport json\nprint(json.dumps({{'backendId':'benchmark-v1','socketPath':'/foreign.sock'}}))\n")
            backend.chmod(0o700)
            result = benchmark.shared_cohort("must-not-execute", str(backend), 1)
            self.assertIn("Unexpected backend socket path", result["error"])
            self.assertNotIn("initialized", result)


class ManagedBenchmarkScratch(unittest.TestCase):
    def test_honors_tmpdir_and_removes_failed_fixture(self):
        source = Path(__file__).resolve().parents[2] / "scripts/benchmark-mcp-managed.py"
        spec = importlib.util.spec_from_file_location("mcp_managed_benchmark", source)
        managed = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(managed)

        with tempfile.TemporaryDirectory() as parent:
            with (
                patch.dict(os.environ, {"TMPDIR": parent}),
                patch.object(tempfile, "tempdir", None),
                patch.object(managed, "isolated_environment", side_effect=RuntimeError("fixture control")) as isolate,
            ):
                result = managed.run_cohort({"stdio": "unused"}, "stdio", 1, 5)
            fixture = isolate.call_args.args[0]
            self.assertEqual(fixture.parent, Path(parent).resolve())
            self.assertIn("fixture control", result["error"])
            self.assertTrue(result["cleanup_verified"])
            self.assertFalse(fixture.exists())


if __name__ == "__main__":
    unittest.main()
