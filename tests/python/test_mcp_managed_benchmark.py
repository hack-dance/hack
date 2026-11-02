"""Accounting and failure controls; cgroup CPU test requires an isolated toolchain."""
import importlib.util
import json
import os
from pathlib import Path
import resource
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

source = Path(__file__).resolve().parents[2] / "scripts/benchmark-mcp-managed.py"
spec = importlib.util.spec_from_file_location("managed_benchmark", source)
benchmark = importlib.util.module_from_spec(spec)
spec.loader.exec_module(benchmark)


class ManagedBenchmark(unittest.TestCase):
    def test_compatible_schema_allows_only_optional_boolean_indicator(self):
        base = {"tools": [{"name": "hack.projects.list", "inputSchema": {"type": "object"},
                          "outputSchema": {"properties": {"ok": {"type": "boolean"}}, "required": ["ok"]}}]}
        extended = json.loads(json.dumps(base))
        extended["tools"][0]["outputSchema"]["properties"]["outputTruncated"] = {"type": "boolean"}
        self.assertEqual(benchmark.compatible_schema_hash(base), benchmark.compatible_schema_hash(extended))
        self.assertIn("outputTruncated", extended["tools"][0]["outputSchema"]["properties"])
        for mutation in ("required", "type", "extra"):
            bad = json.loads(json.dumps(extended))
            output = bad["tools"][0]["outputSchema"]
            if mutation == "required":
                output["required"].append("outputTruncated")
            elif mutation == "type":
                output["properties"]["outputTruncated"]["type"] = "string"
            else:
                output["properties"]["outputTruncated"]["enum"] = [True]
            with self.assertRaisesRegex(RuntimeError, "Unsupported"):
                benchmark.compatible_schema_hash(bad)
        for mutation in ("input", "output", "name"):
            changed = json.loads(json.dumps(extended))
            tool = changed["tools"][0]
            if mutation == "input":
                tool["inputSchema"]["required"] = ["new_argument"]
            elif mutation == "output":
                tool["outputSchema"]["properties"]["ok"]["type"] = "string"
            else:
                tool["name"] = "different-tool"
            self.assertNotEqual(benchmark.compatible_schema_hash(base), benchmark.compatible_schema_hash(changed))

    def test_cli_rejects_an_unbounded_rss_budget_before_launch(self):
        command = [sys.executable, str(source)]
        for name in ("stdio", "adapter", "backend", "owner", "output"):
            command.extend([f"--{name}", "/must-not-be-opened"])
        command.extend(["--rss-ceiling-mib", "8192"])
        result = subprocess.run(command, capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 2)
        self.assertIn("invalid choice", result.stderr)

    def test_executable_fingerprint_detects_same_size_replacement(self):
        with tempfile.TemporaryDirectory() as root:
            executable = Path(root, "candidate")
            executable.write_bytes(b"first")
            before = benchmark.binary_hashes({"stdio": executable})
            executable.write_bytes(b"other")
            self.assertNotEqual(before, benchmark.binary_hashes({"stdio": executable}))

    def test_runtime_validation_rejects_host_discovery_without_echoing_metadata(self):
        def tool(data):
            return {"structuredContent": {"exitCode": 0, "command": "/candidate projects --json", "data": data}}
        benchmark.verify_isolated_tool(tool({"projects": [], "runtime_ok": False}), "/candidate")
        for data in ({"projects": [{"name": "private-host-project"}], "runtime_ok": True},
                     {"projects": [], "runtime_ok": True}, {}, None):
            with self.assertRaisesRegex(RuntimeError, "runtime isolation") as raised:
                benchmark.verify_isolated_tool(tool(data), "/candidate")
            self.assertNotIn("private-host-project", str(raised.exception))

    def test_client_environment_has_no_host_runtime_search_path(self):
        with tempfile.TemporaryDirectory() as root:
            env = benchmark.isolated_environment(Path(root), "/candidate")
            self.assertIsNone(shutil.which("docker", path=env["PATH"]))
            self.assertFalse(Path(env["DOCKER_HOST"].removeprefix("unix://")).exists())
            self.assertNotIn("DOCKER_CONTEXT", env)
            self.assertNotIn("SSH_AUTH_SOCK", env)

    def test_failed_client_retains_failure_and_closes_clean_empty_fixture(self):
        binaries = {name: shutil.which("false") for name in ("stdio", "adapter", "backend", "owner")}
        result = benchmark.run_cohort(binaries, "managed", 1, 5)
        self.assertIn("error", result)
        self.assertTrue(result["cleanup_verified"])
        self.assertFalse(result["startup_cpu_complete"])
        self.assertNotIn("startup_cpu_seconds", result)
        self.assertNotIn("retained_fixture", result)

    def test_receipt_refuses_public_file_and_nonpositive_pid(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root, "benchmark-process.json")
            path.write_text(json.dumps({"pid": 0, "supervisor": 1}))
            path.chmod(0o644)
            with self.assertRaisesRegex(RuntimeError, "Unsafe measurement receipt"):
                benchmark.backend_identity(Path(root))
            path.chmod(0o600)
            with self.assertRaisesRegex(RuntimeError, "Invalid measured process identity"):
                benchmark.backend_identity(Path(root))

    @unittest.skipUnless(os.environ.get("HACK_TEST_ISOLATED_CGROUP") == "1", "Requires explicitly isolated Linux toolchain")
    def test_cgroup_counts_cpu_of_a_detached_exited_grandchild(self):
        group = benchmark.Cgroup()
        before = group.sample()["cpu_seconds"]
        children_before = resource.getrusage(resource.RUSAGE_CHILDREN)
        with tempfile.TemporaryDirectory(prefix="hack-cgroup-control-") as root:
            marker = Path(root, "done")
            child = os.fork()
            if child == 0:
                os.setsid()
                grandchild = os.fork()
                if grandchild:
                    os._exit(0)
                started = time.process_time()
                while time.process_time() - started < 0.15:
                    pass
                marker.write_text(str(os.getpid()))
                os._exit(0)
            os.waitpid(child, 0)
            benchmark.wait_until(marker.exists, 5)
            pid = int(marker.read_text())
            benchmark.wait_until(lambda: not benchmark.alive(pid), 3)
        after = group.sample()["cpu_seconds"]
        children_after = resource.getrusage(resource.RUSAGE_CHILDREN)
        waited_cpu = (children_after.ru_utime + children_after.ru_stime) - (children_before.ru_utime + children_before.ru_stime)
        self.assertGreaterEqual(after - before, 0.14)
        self.assertLess(waited_cpu, 0.08)
        group.assert_idle()


if __name__ == "__main__":
    unittest.main()
