import os
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
MODULE_PATH = SCRIPTS_DIR / "tla_agent_checks.py"


def run_python(args, cwd=None):
    return subprocess.run(
        [sys.executable, *args],
        cwd=cwd,
        text=True,
        capture_output=True,
        check=False,
    )


class TlaAgentChecksTests(unittest.TestCase):
    def test_dry_run_is_bounded_and_does_not_write_configuration(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp) / "tools"
            spec = Path(tmp) / "Sample.tla"
            spec.write_text("---- MODULE Sample ----\n====\n")
            (Path(tmp) / "external.cfg").write_text("INIT Init\nNEXT Next\n")
            result = subprocess.run(
                [sys.executable, str(SCRIPTS_DIR / "run-tlc"), str(spec), "--config", str(Path(tmp) / "external.cfg"), "--dry-run"],
                env={**os.environ, "TLA_AGENT_CHECKS_HOME": str(home)},
                text=True, capture_output=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse(home.exists())
            self.assertNotIn("mise use", result.stdout)
            self.assertIn("mise install java@temurin-17.0.20+101", result.stdout)
            self.assertIn("-Xmx512m", result.stdout)
            self.assertIn("-workers 2", result.stdout)
            self.assertNotIn("Downloading https://github.com/apalache", result.stdout)

    def test_corrupt_cached_tlc_is_rejected(self):
        sys.path.insert(0, str(SCRIPTS_DIR))
        import tla_agent_checks as helper
        with tempfile.TemporaryDirectory() as tmp:
            corrupt = Path(tmp) / "bad.jar"
            corrupt.write_bytes(b"not the pinned artifact")
            with self.assertRaisesRegex(SystemExit, "SHA256 mismatch"):
                helper.verify_checksum(corrupt, helper.TLA_SHA256)

    @unittest.skipUnless(os.environ.get("TLA_LIVE_TESTS") == "1", "opt-in installed model checkers")
    def test_live_checkers_and_trace_conformance(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            spec = root / "Smoke.tla"
            spec.write_text("---- MODULE Smoke ----\nEXTENDS Integers\n"
                            "VARIABLE\n\\* @type: Int;\nx\nStart == x = 0\n"
                            "Step == x' = IF x < 2 THEN x + 1 ELSE x\nInit == Start\nNext == Step\n"
                            "Safe == x <= 2\nBroken == x < 2\n====\n")
            for checker in ["run-tlc", "run-apalache"]:
                for name, invariant in [("positive", "Safe"), ("negative", "Broken")]:
                    cfg = root / (name + ".cfg")
                    cfg.write_text("INIT Start\nNEXT Step\nINVARIANT " + invariant + "\n")
                    result = run_python([str(SCRIPTS_DIR / checker), str(spec), "--config", str(cfg)], cwd=root)
                    output = result.stdout + result.stderr
                    if name == "positive":
                        self.assertEqual(result.returncode, 0, output)
                    else:
                        self.assertNotEqual(result.returncode, 0, output)
                        self.assertIn("violat", output.lower(), output)
            cfg = root / "trace.cfg"
            cfg.write_text("")
            for values, expected in [([0, 1, 2], True), ([0, 2], False), ([1, 2], False)]:
                trace = root / "trace.json"
                trace.write_text(json.dumps([{"x": x} for x in values]))
                result = run_python([str(SCRIPTS_DIR / "validate-trace"), str(spec), str(trace), "--config", str(cfg)], cwd=root)
                self.assertEqual(result.returncode == 0, expected, result.stdout + result.stderr)

    def test_module_exists(self):
        self.assertTrue(MODULE_PATH.exists(), f"expected helper module at {MODULE_PATH}")

    def test_new_agent_spec_scaffolds_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            out_dir = Path(tmp) / "specs"
            result = run_python(
                [
                    str(SCRIPTS_DIR / "new-agent-spec"),
                    "agent-loop",
                    "--name",
                    "TicketRouter",
                    "--output-dir",
                    str(out_dir),
                ]
            )
            self.assertEqual(result.returncode, 0, result.stderr)

            tla = out_dir / "TicketRouter.tla"
            cfg = out_dir / "TicketRouter.cfg"
            self.assertTrue(tla.exists(), "expected scaffolded TLA file")
            self.assertTrue(cfg.exists(), "expected scaffolded cfg file")

            tla_text = tla.read_text()
            cfg_text = cfg.read_text()
            self.assertIn("---- MODULE TicketRouter ----", tla_text)
            self.assertIn("Invariant_TypeOK", tla_text)
            self.assertIn("SPECIFICATION Spec", cfg_text)
            self.assertIn("generated .cfg is template-specific", result.stdout)

    def test_validate_trace_generates_harness_in_dry_run(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            spec_path = tmp_path / "Traceable.tla"
            cfg_path = tmp_path / "Traceable.cfg"
            trace_path = tmp_path / "trace.json"

            spec_path.write_text(
                """---- MODULE Traceable ----
EXTENDS Integers

VARIABLES phase, attempts

Vars == <<phase, attempts>>

Init ==
    /\\ phase = "idle"
    /\\ attempts = 0

Next ==
    \\/ /\\ phase = "idle"
       /\\ phase' = "running"
       /\\ attempts' = attempts + 1
    \\/ /\\ phase = "running"
       /\\ phase' = "done"
       /\\ attempts' = attempts

Spec == Init /\\ [][Next]_Vars

====
"""
            )
            cfg_path.write_text("SPECIFICATION Spec\n")
            trace_path.write_text(
                json.dumps(
                    {
                        "states": [
                            {"phase": "idle", "attempts": 0},
                            {"phase": "running", "attempts": 1},
                            {"phase": "done", "attempts": 1},
                        ]
                    }
                )
            )

            result = run_python(
                [
                    str(SCRIPTS_DIR / "validate-trace"),
                    str(spec_path),
                    str(trace_path),
                    "--dry-run",
                ],
                cwd=tmp_path,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("TraceValidation", result.stdout)
            self.assertIn("TraceMatches", result.stdout)
            self.assertIn("phase", result.stdout)
            self.assertIn("attempts", result.stdout)

    def test_spec_to_tests_generates_practical_regressions(self):
        with tempfile.TemporaryDirectory() as tmp:
            trace_path = Path(tmp) / "counterexample.json"
            trace_path.write_text(
                json.dumps(
                    {
                        "states": [
                            {"phase": "idle", "attempts": 0},
                            {"phase": "running", "attempts": 1},
                            {"phase": "failed", "attempts": 3},
                        ]
                    }
                )
            )
            result = run_python([str(SCRIPTS_DIR / "spec-to-tests"), str(trace_path)])
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("Regression checklist", result.stdout)
            self.assertIn("initial state", result.stdout.lower())
            self.assertIn("transition", result.stdout.lower())
            self.assertIn("failed", result.stdout)

    def test_ensure_tla_tools_dry_run_reports_pinned_versions(self):
        result = run_python([str(SCRIPTS_DIR / "ensure-tla-tools"), "--dry-run"])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("java@temurin-17", result.stdout)
        self.assertIn("v1.7.4", result.stdout)
        self.assertIn("v0.62.2", result.stdout)


if __name__ == "__main__":
    unittest.main()
