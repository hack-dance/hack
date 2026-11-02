"""Failure controls for the owned-backend measurement harness."""
import importlib.util
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

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


if __name__ == "__main__":
    unittest.main()
