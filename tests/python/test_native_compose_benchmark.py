"""Offline controls for matched NC03 overhead; no Docker daemon or timed fixture trials."""
import base64
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest import mock

SOURCE = Path(__file__).resolve().parents[2] / "scripts/benchmark-native-compose.py"
SPEC = importlib.util.spec_from_file_location("native_compose_benchmark", SOURCE)
benchmark = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(benchmark)


def route(host, dial="172.20.0.2:3000"):
    return {"match": [{"host": [host]}], "handle": [{"handler": "reverse_proxy", "upstreams": [{"dial": dial}]}]}


def samples():
    return [{"cohort": cohort, "round": index, "action": action, "lane": lane,
             "ok": True, "admitted": True, "wall_s": 1, "ready_wall_s": 1, "cli_cpu_s": .1}
            for cohort in benchmark.GATES["cohorts"] for index in range(benchmark.GATES["rounds"])
            for action in benchmark.ACTIONS for lane in ("legacy", "native")]


class Planning(unittest.TestCase):
    def test_preview_spawns_no_docker_or_candidate_and_creates_no_directory(self):
        with tempfile.TemporaryDirectory() as root:
            docker = Path(root, "docker")
            marker = Path(root, "invoked")
            docker.write_text(f"#!{sys.executable}\nfrom pathlib import Path\nPath({str(marker)!r}).touch()\n")
            docker.chmod(0o700)
            output = Path(root, "must-not-create")
            result = subprocess.run([sys.executable, str(SOURCE), "--cli", str(docker), "--output-root", str(output),
                                     "--proxy-fixture-receipt", str(Path(root, "absent-receipt.json"))],
                                    env={**os.environ, "PATH": root}, capture_output=True, text=True, timeout=5)
            self.assertEqual(result.returncode, 0, result.stderr)
            plan = json.loads(result.stdout)
            self.assertTrue(plan["preview"])
            self.assertEqual(plan["gates"]["rounds"], 8)
            self.assertEqual(plan["gates"]["cohorts"], [1, 2])
            self.assertFalse(marker.exists())
            self.assertFalse(output.exists())

    def test_run_refuses_missing_qualification_without_launch(self):
        result = subprocess.run([sys.executable, str(SOURCE), "--run"], capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 2)
        self.assertIn("frozen", result.stderr)

    def test_paired_order_has_equal_first_lane_counts(self):
        orders = [benchmark.paired_order(index) for index in range(benchmark.GATES["rounds"])]
        self.assertEqual(sum(order[0] == "native" for order in orders), 4)
        self.assertEqual(sum(order[0] == "legacy" for order in orders), 4)

    def test_environment_drops_ambient_backend_profiles_and_credentials(self):
        with mock.patch.dict(os.environ, {"AWS_SECRET_ACCESS_KEY": "never-forward", "COMPOSE_PROFILES": "foreign",
                                         "HACK_RUNTIME_BACKEND": "native", "HTTP_PROXY": "foreign"}):
            env = benchmark.environment(Path("/isolated/home"), Path("/qualified/compiler"))
        self.assertNotIn("AWS_SECRET_ACCESS_KEY", env)
        self.assertNotIn("COMPOSE_PROFILES", env)
        self.assertNotIn("HTTP_PROXY", env)
        self.assertEqual(env["HACK_RUNTIME_BACKEND"], "compose")
        self.assertEqual(env["HACK_HOME"], "/isolated/home")
        self.assertEqual(env["HACK_CONFIG_COMPILER_BINARY"], "/qualified/compiler")

    def test_authored_formats_keep_the_same_image_commands_dependencies_and_health(self):
        image = "sha256:" + "1" * 64
        native, legacy, config = benchmark.fixture_documents("fixture", image, "fixture.benchmark.invalid", "a" * 32)
        self.assertEqual(native["services"]["web"]["command"]["exec"], legacy["services"]["web"]["command"])
        self.assertEqual(native["jobs"]["initializer"]["command"]["exec"], legacy["services"]["initializer"]["command"])
        self.assertEqual(native["services"]["web"]["readiness"]["command"]["exec"], legacy["services"]["web"]["healthcheck"]["test"][1:])
        self.assertEqual(native["services"]["web"]["image"], image)
        self.assertEqual(legacy["services"]["web"]["image"], image)
        self.assertEqual(native["services"]["web"]["pull_policy"], "never")
        self.assertEqual(legacy["services"]["web"]["pull_policy"], "never")
        self.assertFalse(config["internal"]["dns"])
        self.assertFalse(config["internal"]["tls"])
        self.assertNotIn("ports", legacy["services"]["web"])


class Accounting(unittest.TestCase):
    def test_real_child_and_reaped_grandchild_cpu_are_accounted(self):
        # Functional wait4 oracle: one short, deterministic offline child tree.
        with tempfile.TemporaryDirectory() as root:
            cpu_child = "value = 0\nfor i in range(500000): value += i*i\n"
            parent = f"import subprocess,sys\nsubprocess.run([sys.executable,'-c',{cpu_child!r}],check=True)\nprint('complete')"
            result = benchmark.command([sys.executable, "-c", parent], cwd=root, env=os.environ, timeout=5)
        self.assertEqual(result["exit"], 0)
        self.assertEqual(result["stdout"].strip(), "complete")
        self.assertGreater(result["cli_cpu_s"], .001)
        self.assertGreater(result["wall_s"], 0)
        self.assertIsNone(result["interrupted"])

    def test_success_sends_no_signal_to_former_process_group(self):
        with tempfile.TemporaryDirectory() as root, mock.patch.object(benchmark.os, "killpg", wraps=os.killpg) as kill:
            result = benchmark.command([sys.executable, "-c", "print('done')"], cwd=root, env=os.environ, timeout=5)
        self.assertEqual(result["exit"], 0)
        kill.assert_not_called()

    def test_timeout_reaps_only_its_owned_group_and_preserves_sibling_canary(self):
        with tempfile.TemporaryDirectory() as root:
            canary = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"], start_new_session=True)
            try:
                result = benchmark.command([sys.executable, "-c", "import time; time.sleep(30)"],
                                           cwd=root, env=os.environ, timeout=.05)
                self.assertEqual(result["interrupted"], "timeout")
                self.assertEqual(result["exit"], -signal.SIGKILL)
                self.assertIsNone(canary.poll())
            finally:
                canary.kill()
                canary.wait(timeout=3)

    def test_same_size_executable_tamper_with_restored_mtime_is_detected(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root, "candidate")
            path.write_bytes(b"first")
            before = benchmark.fingerprint(path)
            stat = path.stat()
            path.write_bytes(b"other")
            os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns))
            bench = object.__new__(benchmark.Benchmark)
            bench.expected_hashes = {path: before}
            with self.assertRaisesRegex(benchmark.Failure, "changed"):
                bench.assert_frozen()

    def test_output_budget_is_not_a_successful_zero_exit_sample(self):
        with tempfile.TemporaryDirectory() as root:
            result = benchmark.command([sys.executable, "-c", "import sys; sys.stdout.write('x'*3000000)"],
                                       cwd=root, env=os.environ, timeout=5)
        self.assertEqual(result["interrupted"], "output-budget")


class AdmissionAndSummary(unittest.TestCase):
    def test_eight_clean_pairs_qualify_and_dropped_pairs_do_not(self):
        rows = samples()
        self.assertTrue(benchmark.summary(rows)["qualified"])
        rows.pop()
        result = benchmark.summary(rows)
        self.assertFalse(result["qualified"])
        self.assertEqual(len(result["failures"]), 1)

    def test_duplicate_or_missing_lane_is_not_a_complete_pair(self):
        rows = samples()
        rows.append(copy.deepcopy(rows[0]))
        self.assertFalse(benchmark.summary(rows)["qualified"])
        rows = samples()
        rows[0]["lane"] = "native"
        self.assertFalse(benchmark.summary(rows)["qualified"])

    def test_lifecycle_exit_time_is_diagnostic_but_common_readiness_is_gated(self):
        rows = samples()
        for row in rows:
            if row["lane"] == "native" and row["action"] in ("up", "restart", "down"):
                row["wall_s"] = 5
        result = benchmark.summary(rows)
        self.assertTrue(result["qualified"])
        self.assertIsNone(result["actions"]["1:up"]["metrics"]["wall_s"]["accepted"])
        for row in rows:
            if row["lane"] == "native" and row["action"] == "up":
                row["ready_wall_s"] = 5
        self.assertFalse(benchmark.summary(rows)["qualified"])

    def test_noise_on_either_lane_excludes_pair_instead_of_false_win(self):
        rows = samples()
        rows[0].update(admitted=False, cli_cpu_s=100)
        result = benchmark.summary(rows)
        self.assertFalse(result["qualified"])
        cell = result["actions"]["1:up"]
        self.assertEqual(cell["pairs"], 7)
        self.assertEqual(cell["metrics"]["cli_cpu_s"]["legacy_median"], .1)

    def test_regression_gate_trips_even_with_correct_complete_trials(self):
        rows = samples()
        for row in rows:
            if row["lane"] == "native" and row["action"] == "exec":
                row["cli_cpu_s"] = .5
        result = benchmark.summary(rows)
        self.assertFalse(result["qualified"])
        self.assertFalse(result["actions"]["1:exec"]["metrics"]["cli_cpu_s"]["accepted"])

    def test_dispersion_and_tail_are_not_hidden_by_a_good_median(self):
        rows = samples()
        for row in rows:
            if row["cohort"] == 1 and row["action"] == "up":
                if row["lane"] == "legacy":
                    row["wall_s"] = .2 if row["round"] % 2 else 2
                elif row["round"] == 7:
                    row["ready_wall_s"] = 4
        result = benchmark.summary(rows)
        self.assertFalse(result["qualified"])
        cell = result["actions"]["1:up"]["metrics"]
        self.assertTrue(cell["wall_s"]["noise"])
        self.assertFalse(cell["ready_wall_s"]["accepted"])

    def test_failed_correctness_record_never_enters_ratios(self):
        rows = samples()
        rows[0].update(ok=False, cli_cpu_s=100)
        result = benchmark.summary(rows)
        self.assertFalse(result["qualified"])
        self.assertEqual(result["actions"]["1:up"]["pairs"], 7)

    def test_unobserved_admission_and_large_gap_refuse(self):
        admission = benchmark.Admission({}, "/")
        self.assertFalse(admission.admitted())
        admission.samples = [{"admitted": True, "at_monotonic": 0}, {"admitted": True, "at_monotonic": 6}]
        self.assertFalse(admission.admitted())
        with mock.patch.object(benchmark, "noise_snapshot", side_effect=OSError):
            admission.sample()
        self.assertFalse(admission.samples[-1]["admitted"])


class PrivateReceipts(unittest.TestCase):
    def test_only_bounded_private_owned_regular_receipt_is_accepted(self):
        with tempfile.TemporaryDirectory() as root:
            receipt = Path(root, "receipt.json")
            receipt.write_text('{"identity":{"ownerToken":"public-random-token"}}')
            receipt.chmod(0o600)
            self.assertEqual(benchmark.private_json(receipt)["identity"]["ownerToken"], "public-random-token")
            receipt.chmod(0o644)
            with self.assertRaises(benchmark.Failure):
                benchmark.private_json(receipt)
            receipt.chmod(0o600)
            alias = Path(root, "alias")
            alias.symlink_to(receipt)
            with self.assertRaises(OSError):
                benchmark.private_json(alias)
            alias.unlink()
            os.link(receipt, alias)
            with self.assertRaises(benchmark.Failure):
                benchmark.private_json(receipt)
            alias.unlink()
            receipt.write_bytes(b"x" * 65537)
            with self.assertRaises(benchmark.Failure):
                benchmark.private_json(receipt)

    def test_named_replacement_during_read_refuses_and_keeps_both_files(self):
        with tempfile.TemporaryDirectory() as root:
            receipt = Path(root, "receipt.json")
            other = Path(root, "other.json")
            receipt.write_text('{"owned":true}')
            other.write_text('{"foreign":true}')
            receipt.chmod(0o600)
            other.chmod(0o600)
            read = os.read
            def replace(descriptor, length):
                result = read(descriptor, length)
                os.replace(other, receipt)
                return result
            with mock.patch.object(benchmark.os, "read", side_effect=replace), self.assertRaises(benchmark.Failure):
                benchmark.private_json(receipt)
            self.assertEqual(json.loads(receipt.read_text()), {"foreign": True})

    def test_growth_during_read_refuses(self):
        with tempfile.TemporaryDirectory() as root:
            receipt = Path(root, "receipt.json")
            receipt.write_text('{"owned":true}')
            receipt.chmod(0o600)
            read = os.read
            def grow(descriptor, length):
                result = read(descriptor, length)
                with open(receipt, "ab") as file:
                    file.write(b" ")
                return result
            with mock.patch.object(benchmark.os, "read", side_effect=grow), self.assertRaises(benchmark.Failure):
                benchmark.private_json(receipt)


class OwnershipAndSemantics(unittest.TestCase):
    def test_same_name_foreign_and_old_native_owner_refuse(self):
        row = {"id": "a" * 64, "project": "fixture", "service": "web", "oneoff": "False", "owner": "b" * 32,
               "nativeOwner": "b" * 32, "instance": "fixture"}
        self.assertEqual(benchmark.owned_rows([row], "fixture", "b" * 32, "native"), [row])
        for lane in ("legacy", "native"):
            with self.assertRaisesRegex(benchmark.Failure, "ownership"):
                benchmark.owned_rows([row], "fixture", "c" * 32, lane)
        with self.assertRaises(benchmark.Failure):
            benchmark.owned_rows([{**row, "service": "foreign"}], "fixture", "b" * 32, "native")

    def test_runtime_policy_difference_cannot_be_normalized_away(self):
        row = {"image": "sha256:" + "a" * 64, "command": ["bun", "-e", "fixture"], "init": True,
               "signal": "SIGTERM", "grace": 5, "restart": {"Name": "no"}, "health": {}, "memory": 0, "cpus": 0,
               "mounts": [{"Type": "volume", "Destination": "/data", "RW": True, "Name": "left"}]}
        baseline = benchmark.semantic_projection(row)
        other_volume = copy.deepcopy(row)
        other_volume["mounts"][0]["Name"] = "right"
        benchmark.require_matched(baseline, benchmark.semantic_projection(other_volume))
        for field, changed in (("image", "sha256:" + "b" * 64), ("init", False), ("signal", "SIGKILL"),
                               ("grace", 1), ("memory", 1024), ("command", ["different"]), ("health", None)):
            with self.subTest(field=field), self.assertRaisesRegex(benchmark.Failure, "semantics"):
                benchmark.require_matched(baseline, benchmark.semantic_projection({**row, field: changed}))

    def test_ps_empty_or_other_project_cannot_qualify_by_engine_readback(self):
        legacy = {"composeProject": "fixture", "items": [{"Service": "web", "State": "running", "Health": "healthy"}]}
        native = {"ok": True, "data": {"composeProject": "fixture", "services": [{"service": "web", "status": "running", "health": "healthy"}]}}
        benchmark.require_ps(legacy, "legacy", "fixture")
        benchmark.require_ps(native, "native", "fixture")
        for payload, lane in (({"composeProject": "fixture", "items": []}, "legacy"),
                              ({"ok": False, "data": native["data"]}, "native"), (native, "legacy")):
            with self.assertRaises(benchmark.Failure):
                benchmark.require_ps(payload, lane, "fixture")
        with self.assertRaises(benchmark.Failure):
            benchmark.require_ps(legacy, "legacy", "other")

    def test_interrupted_engine_child_retains_resources_without_cleanup_effects(self):
        fixture = object.__new__(benchmark.Fixture)
        fixture.started = True
        fixture.bench = mock.Mock(uncertain=True)
        fixture.cli = mock.Mock()
        fixture.rows = mock.Mock()
        with self.assertRaisesRegex(benchmark.Failure, "Interrupted"):
            fixture.cleanup()
        fixture.cli.assert_not_called()
        fixture.rows.assert_not_called()

    def test_unknown_owner_stops_cleanup_before_cli_or_volume_removal(self):
        fixture = object.__new__(benchmark.Fixture)
        fixture.started = True
        fixture.bench = mock.Mock(uncertain=False)
        fixture.rows = mock.Mock(side_effect=benchmark.Failure("unknown"))
        fixture.cli = mock.Mock()
        with self.assertRaises(benchmark.Failure):
            fixture.cleanup()
        fixture.cli.assert_not_called()
        fixture.bench.docker.assert_not_called()

    def test_partial_start_unknown_volume_is_retained_and_cleanup_cannot_pass(self):
        fixture = object.__new__(benchmark.Fixture)
        fixture.started = True
        fixture.bench = mock.Mock(uncertain=False)
        fixture.rows = mock.Mock(return_value=[])
        fixture.assert_resource_ownership = mock.Mock()
        fixture.cli = mock.Mock()
        fixture.down_verified = mock.Mock()
        fixture.volume = None
        fixture.project = "fixture"
        fixture.lane = "native"
        fixture.bench.docker.return_value = "unobserved-volume"
        with self.assertRaisesRegex(benchmark.Failure, "preserve unknown storage"):
            fixture.cleanup()
        self.assertEqual(fixture.bench.docker.call_args.args[:2], ("volume", "ls"))
        self.assertEqual(fixture.bench.docker.call_count, 1)


class PreMutationOwnership(unittest.TestCase):
    def fixture(self, network=None, volume=None):
        fixture = object.__new__(benchmark.Fixture)
        fixture.lane = "legacy"
        fixture.project, fixture.owner = "fixture", "b" * 32
        fixture.volume, fixture.volume_created = None, None
        fixture.identity = mock.Mock()
        fixture.check_root = mock.Mock()
        fixture.rows = mock.Mock(return_value=[])
        fixture.started = True
        fixture.bench = mock.Mock(uncertain=False)
        network = network or {"id": "a" * 64, "name": "fixture_default", "project": "fixture", "owner": fixture.owner}
        volume = volume or {"name": "fixture_data", "project": "fixture", "owner": fixture.owner, "created": "stable-created"}
        listed = {
            "network": {key: network[key] for key in ("id", "name", "project")},
            "volume": {"id": volume["name"], "name": volume["name"], "project": volume["project"]},
        }
        fixture.bench.docker.side_effect = lambda kind, *_: json.dumps(listed[kind])
        fixture.bench.json_docker.side_effect = lambda kind, *_: network if kind == "network" else volume
        fixture.cli = mock.Mock()
        return fixture

    def test_exact_owned_selected_network_and_volume_are_checked_without_mutation(self):
        fixture = self.fixture()
        fixture.assert_resource_ownership()
        self.assertEqual(fixture.bench.json_docker.call_count, 2)
        fixture.cli.assert_not_called()

    def test_same_name_foreign_network_with_no_containers_refuses_before_down(self):
        fixture = self.fixture(network={"id": "a" * 64, "name": "fixture_default", "project": "foreign", "owner": "c" * 32})
        with tempfile.TemporaryDirectory() as root:
            canary = Path(root, "effect")
            fixture.cli.side_effect = lambda *_: canary.touch()
            with self.assertRaisesRegex(benchmark.Failure, "network ownership"):
                fixture.cleanup()
            self.assertFalse(canary.exists())
        fixture.cli.assert_not_called()

    def test_same_name_unlabelled_volume_refuses_measured_down_and_restart(self):
        for action in ("down", "restart"):
            with self.subTest(action=action):
                fixture = self.fixture(volume={"name": "fixture_data", "project": "", "owner": None, "created": "stable-created"})
                with self.assertRaisesRegex(benchmark.Failure, "volume ownership"):
                    fixture.step(action)
                fixture.cli.assert_not_called()

    def test_unknown_same_project_network_and_replaced_volume_refuse(self):
        fixture = self.fixture(network={"id": "a" * 64, "name": "unknown-network", "project": "fixture", "owner": "b" * 32})
        with self.assertRaisesRegex(benchmark.Failure, "network ownership"):
            fixture.assert_resource_ownership()
        fixture = self.fixture()
        fixture.volume_created = "earlier-created"
        with self.assertRaisesRegex(benchmark.Failure, "volume ownership"):
            fixture.assert_resource_ownership()
        fixture.cli.assert_not_called()

    def test_late_volume_replacement_cannot_be_removed_with_copied_owner_labels(self):
        fixture = self.fixture()
        fixture.assert_resource_ownership = mock.Mock()
        fixture.down_verified = mock.Mock()
        fixture.volume, fixture.volume_created = "fixture_data", "earlier-created"
        fixture.bench.json_docker.return_value = {"name": "fixture_data", "created": "later-created",
                                                 "project": fixture.project, "owner": fixture.owner}
        fixture.bench.json_docker.side_effect = None
        with self.assertRaisesRegex(benchmark.Failure, "volume ownership changed"):
            fixture.cleanup()
        fixture.bench.docker.assert_not_called()


class ProxyFixtureAdapter(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.root.chmod(0o700)
        self.public_der = b"synthetic-public-certificate-pin"
        self.certificate = "-----BEGIN CERTIFICATE-----\n" + base64.b64encode(self.public_der).decode() + "\n-----END CERTIFICATE-----\n"
        self.receipt = {"fixture_version": 1, "phase": "qualified", "engine_id": "fixture-engine", "docker_endpoint": "unix:///fixture.sock",
            "proxy_id": "a" * 64, "proxy_name": "nc03-overhead-proxy-" + "b" * 32, "owner_token": "b" * 32,
            "image_id": "sha256:" + "c" * 64, "network_id": "d" * 64, "started_at": "2026-10-07T00:00:00Z",
            "ca_sha256": hashlib.sha256(self.public_der).hexdigest(),
            "canary": {"hostname": "canary-" + "b" * 32 + ".benchmark.invalid", "marker": "e" * 32}}
        self.path = self.root / "proxy-receipt.json"
        self.save()
        args = SimpleNamespace(output_root=str(self.root / "new-output"), cli="/qualified/hack", compiler="/qualified/compiler",
                               cli_sha256="1" * 64, compiler_sha256="2" * 64)
        self.bench = benchmark.Benchmark(args)
        self.bench.env["DOCKER_HOST"] = self.receipt["docker_endpoint"]
        self.bench.read_proxy_fixture(self.path)
        self.proxy = {"id": self.receipt["proxy_id"], "image": self.receipt["image_id"], "name": "/" + self.receipt["proxy_name"],
            "running": True, "started": self.receipt["started_at"], "project": "hack-dev-proxy", "service": "caddy",
            "owner": self.receipt["owner_token"], "network": self.receipt["network_id"], "networkMode": self.receipt["network_id"],
            "ports": {}, "publishAll": False, "publishedPorts": {"80/tcp": None, "443/tcp": []},
            "privileged": False, "networks": {"hack-dev": {"NetworkID": self.receipt["network_id"]}},
            "mounts": [{"Type": "bind", "Source": "/var/run/docker.sock", "Destination": "/var/run/docker.sock", "RW": False}],
            "tmpfs": {"/data": benchmark.PRIVATE_TMPFS, "/config": benchmark.PRIVATE_TMPFS}}
        self.bench.docker = mock.Mock(return_value=self.receipt["proxy_id"])
        def inspect(kind, *_):
            if kind == "info":
                return self.receipt["engine_id"]
            if kind == "network":
                return {"id": self.receipt["network_id"], "name": "hack-dev"}
            return copy.deepcopy(self.proxy)
        self.bench.json_docker = mock.Mock(side_effect=inspect)
        self.response = '{"initialized":"initializer-completed","boot":"fresh-boot","marker":null}\n200'
        self.bench.run = mock.Mock(side_effect=lambda argv, **_: {"stdout": self.certificate if argv[3] == "cat" else self.response})

    def save(self):
        self.path.write_text(json.dumps(self.receipt))
        self.path.chmod(0o600)

    def test_exact_fixture_binding_accepts_no_ports_and_reads_only_public_ca(self):
        binding = self.bench.proxy_binding()
        self.assertEqual(binding["id"], self.receipt["proxy_id"])
        self.assertEqual(binding["ca_sha256"], self.receipt["ca_sha256"])
        argv = self.bench.run.call_args.args[0]
        self.assertEqual(argv, ["docker", "exec", self.receipt["proxy_id"], "cat", benchmark.ROOT_CA])
        self.assertNotIn(".Config.Env", benchmark.PROXY_FIXTURE)
        self.assertEqual(self.bench.run.call_args.kwargs, {"timeout": 5, "output_limit": 16384})

    def test_fixture_refuses_foreign_owner_ports_privilege_extra_network_mount_or_tmpfs(self):
        changes = [{"owner": "f" * 32}, {"ports": {"80/tcp": [{"HostPort": "80"}]}}, {"privileged": True},
                   {"networks": {**self.proxy["networks"], "foreign": {"NetworkID": "f" * 64}}},
                   {"mounts": self.proxy["mounts"] + [{"Type": "volume", "Name": "foreign", "Destination": "/foreign"}]},
                   {"tmpfs": {"/data": benchmark.PRIVATE_TMPFS, "/config": "rw"}},
                   {"tmpfs": {**self.proxy["tmpfs"], "/foreign": benchmark.PRIVATE_TMPFS}}]
        original = copy.deepcopy(self.proxy)
        for changed in changes:
            with self.subTest(changed=changed), self.assertRaises(benchmark.Failure):
                self.proxy.update(changed)
                self.bench.proxy_binding()
            self.proxy = copy.deepcopy(original)
        self.bench.run.assert_not_called()

    def test_fixture_refuses_ca_rotation_and_engine_or_endpoint_replacement(self):
        self.bench.run.side_effect = None
        self.bench.run.return_value = {"stdout": "-----BEGIN CERTIFICATE-----\nY2hhbmdlZA==\n-----END CERTIFICATE-----"}
        with self.assertRaisesRegex(benchmark.Failure, "CA changed"):
            self.bench.proxy_binding()
        with self.assertRaisesRegex(benchmark.Failure, "engine or selected"):
            self.bench.fixture_proxy_binding("foreign-engine", self.receipt["proxy_id"])
        self.bench.env["DOCKER_HOST"] = "unix:///foreign.sock"
        with self.assertRaisesRegex(benchmark.Failure, "endpoint changed"):
            self.bench.proxy_binding()

    def test_publish_all_or_dynamic_host_bindings_refuse_with_empty_portbindings(self):
        original = copy.deepcopy(self.proxy)
        for change in ({"publishAll": True},
                       {"publishedPorts": {"443/tcp": [{"HostIp": "0.0.0.0", "HostPort": "49153"}]}},
                       {"publishedPorts": {"443/tcp": False}}):
            with self.subTest(change=change), self.assertRaises(benchmark.Failure):
                self.proxy.update(change)
                self.assertEqual(self.proxy["ports"], {})
                self.bench.proxy_binding()
            self.proxy = copy.deepcopy(original)
        self.assertIn(".HostConfig.PublishAllPorts", benchmark.PROXY_FIXTURE)
        self.assertIn(".NetworkSettings.Ports", benchmark.PROXY_FIXTURE)
        self.bench.run.assert_not_called()

    def test_changed_receipt_content_or_inode_refuses_before_public_reader(self):
        self.save()
        with self.assertRaisesRegex(benchmark.Failure, "receipt changed"):
            self.bench.proxy_binding()
        self.bench.read_proxy_fixture(self.path)
        self.path.rename(self.root / "original-receipt.json")
        self.save()
        with self.assertRaisesRegex(benchmark.Failure, "receipt changed"):
            self.bench.proxy_binding()
        self.bench.run.assert_not_called()

    def test_symlink_receipt_or_unqualified_shape_refuses(self):
        alias = self.root / "alias.json"
        alias.symlink_to(self.path)
        with self.assertRaises(benchmark.Failure):
            self.bench.read_proxy_fixture(alias)
        self.receipt["phase"] = "create-armed"
        self.save()
        with self.assertRaisesRegex(benchmark.Failure, "unqualified"):
            self.bench.read_proxy_fixture(self.path)

    def test_same_fixed_bounded_http_get_post_oracle_is_used_by_both_lanes(self):
        self.bench.proxy = self.bench.proxy_binding()
        host = "nc03-" + "f" * 32 + ".benchmark.invalid"
        requests = []
        for lane in ("legacy", "native"):
            fixture = object.__new__(benchmark.Fixture)
            fixture.bench, fixture.lane, fixture.hostname = self.bench, lane, host
            fixture.marker, fixture.boot = "1" * 32, None
            self.assertEqual(fixture.request()["boot"], "fresh-boot")
            requests.append(next(call for call in reversed(self.bench.run.call_args_list) if call.args[0][3] == "curl"))
        self.assertEqual(requests[0], requests[1])
        argv = requests[0].args[0]
        self.assertEqual(argv[:5], ["docker", "exec", self.receipt["proxy_id"], "curl", "--disable"])
        for flag, value in (("--proxy", ""), ("--noproxy", "*"), ("--proto", "=http"), ("--max-redirs", "0"),
                            ("--max-time", "3"), ("--max-filesize", "4096"), ("--header", "Host: " + host)):
            self.assertEqual(argv[argv.index(flag) + 1], value)
        self.assertEqual(requests[0].kwargs, {"timeout": 5, "output_limit": 4100})
        self.response = self.response.replace("null", '"' + fixture.marker + '"')
        self.assertEqual(fixture.request(write=True)["marker"], fixture.marker)
        posted = next(call.args[0] for call in reversed(self.bench.run.call_args_list) if call.args[0][3] == "curl")
        self.assertEqual(posted[posted.index("--data-raw") + 1], fixture.marker)
        self.assertNotIn("--location", posted)

    def test_status_body_or_binding_errors_cannot_qualify_readiness(self):
        self.bench.proxy = self.bench.proxy_binding()
        host = "nc03-" + "f" * 32 + ".benchmark.invalid"
        for response in ("redirect\n302", "large" * 900 + "\n200", "missing status"):
            self.response = response
            with self.subTest(response=response[:20]), self.assertRaises(benchmark.Failure):
                self.bench.proxy_request(host)
        self.response = "{}\n200"
        self.proxy["started"] = "restarted"
        with self.assertRaises(benchmark.Failure):
            self.bench.proxy_request(host)

    def test_tls_canary_is_fixed_to_pinned_ca_and_literal_marker(self):
        self.bench.proxy = self.bench.proxy_binding()
        self.response = self.receipt["canary"]["marker"] + "\n200"
        self.bench.proxy_request("ignored", canary=True)
        argv = next(call.args[0] for call in reversed(self.bench.run.call_args_list) if call.args[0][3] == "curl")
        self.assertEqual(argv[argv.index("--cacert") + 1], benchmark.ROOT_CA)
        self.assertEqual(argv[argv.index("--resolve") + 1], self.receipt["canary"]["hostname"] + ":443:127.0.0.1")
        self.response = "wrong canary\n200"
        with self.assertRaisesRegex(benchmark.Failure, "TLS canary"):
            self.bench.proxy_request("ignored", canary=True)

    def test_normal_host80_mode_still_refuses_unpublished_ingress(self):
        self.bench.proxy_fixture = None
        self.bench.json_docker.side_effect = lambda kind, *_: "fixture-engine" if kind == "info" else {
            "id": self.receipt["proxy_id"], "running": True, "network": self.receipt["network_id"], "ports": {}}
        with self.assertRaisesRegex(benchmark.Failure, "Standard verified HTTP"):
            self.bench.proxy_binding()

    def test_real_adapter_subprocess_output_and_timeout_bounds_refuse_without_http_fallback(self):
        real_run = benchmark.Benchmark.run.__get__(self.bench)
        with self.assertRaises(benchmark.Failure):
            real_run([sys.executable, "-c", "print('x'*5000)"], cwd=self.root, output_limit=4100, timeout=2)
        with self.assertRaises(benchmark.Failure):
            real_run([sys.executable, "-c", "import time; time.sleep(30)"], cwd=self.root, timeout=.03, output_limit=4100)
        self.assertTrue(self.bench.uncertain)

    def test_proxy_changed_after_http_success_cannot_qualify_readiness(self):
        self.bench.proxy = self.bench.proxy_binding()
        host = "nc03-" + "f" * 32 + ".benchmark.invalid"
        def request(argv, **_):
            if argv[3] == "cat":
                return {"stdout": self.certificate}
            self.proxy["started"] = "restarted-during-request"
            return {"stdout": self.response}
        self.bench.run.side_effect = request
        with self.assertRaisesRegex(benchmark.Failure, "ownership or isolation"):
            self.bench.proxy_request(host)

    def test_curl_error_never_falls_back_to_host_http(self):
        self.bench.proxy = self.bench.proxy_binding()
        fixture = object.__new__(benchmark.Fixture)
        fixture.bench, fixture.hostname = self.bench, "nc03-" + "f" * 32 + ".benchmark.invalid"
        fixture.marker, fixture.boot = "1" * 32, None
        def request(argv, **_):
            if argv[3] == "cat":
                return {"stdout": self.certificate}
            raise benchmark.Failure("curl refused")
        self.bench.run.side_effect = request
        with mock.patch.object(benchmark.http.client, "HTTPConnection") as host_http:
            with self.assertRaisesRegex(benchmark.Failure, "curl refused"):
                fixture.request()
            host_http.assert_not_called()

    def test_malformed_app_or_retained_marker_refuses_same_oracle(self):
        self.bench.proxy = self.bench.proxy_binding()
        fixture = object.__new__(benchmark.Fixture)
        fixture.bench, fixture.hostname = self.bench, "nc03-" + "f" * 32 + ".benchmark.invalid"
        fixture.marker, fixture.boot = "1" * 32, "previous-boot"
        for body in ("invalid-json", "[]", '{"initialized":"initializer-completed","boot":"new","marker":null}'):
            self.response = body + "\n200"
            with self.subTest(body=body), self.assertRaises((benchmark.Failure, ValueError)):
                fixture.request()

    def test_receipt_parent_mode_or_identity_replacement_refuses_before_reader(self):
        self.root.chmod(0o755)
        with self.assertRaisesRegex(benchmark.Failure, "private owned parent"):
            self.bench.proxy_binding()
        self.root.chmod(0o700)
        original = self.root.with_name(self.root.name + "-original")
        self.root.rename(original)
        self.root.mkdir(mode=0o700)
        try:
            with self.assertRaisesRegex(benchmark.Failure, "parent changed"):
                self.bench.proxy_binding()
        finally:
            self.root.rmdir()
            original.rename(self.root)
        self.bench.run.assert_not_called()


class Routes(unittest.TestCase):
    def test_exact_live_host_and_upstream_are_required(self):
        servers = {"srv0": {"routes": [route("fixture.benchmark.invalid")]}}
        self.assertEqual(benchmark.routes_for_host(servers, "fixture.benchmark.invalid"), ["172.20.0.2:3000"])
        self.assertEqual(benchmark.routes_for_host(servers, "absent.benchmark.invalid"), [])

    def test_wildcard_or_conditional_matching_route_is_never_absent(self):
        for pattern in ("*.benchmark.invalid", "*"):
            with self.assertRaises(benchmark.Failure):
                benchmark.routes_for_host({"srv0": {"routes": [route(pattern)]}}, "fixture.benchmark.invalid")
        conditional = route("fixture.benchmark.invalid")
        conditional["match"][0]["path"] = ["/private"]
        with self.assertRaises(benchmark.Failure):
            benchmark.routes_for_host({"srv0": {"routes": [conditional]}}, "fixture.benchmark.invalid")

    def test_or_matchers_and_empty_subroute_cannot_hide_hostname_presence(self):
        value = route("fixture.benchmark.invalid")
        value["match"].append({"host": ["other.benchmark.invalid"]})
        with self.assertRaises(benchmark.Failure):
            benchmark.routes_for_host({"srv0": {"routes": [value]}}, "fixture.benchmark.invalid")
        empty = {"match": [{"host": ["fixture.benchmark.invalid"]}], "handle": [{"handler": "subroute", "routes": []}]}
        self.assertNotEqual(benchmark.routes_for_host({"srv0": {"routes": [empty]}}, "fixture.benchmark.invalid"), [])

    def test_deep_or_malformed_config_refuses(self):
        with self.assertRaises(benchmark.Failure):
            benchmark.routes_for_host({"srv0": {"routes": None}}, "fixture.benchmark.invalid")
        malformed = route("fixture.benchmark.invalid")
        malformed["handle"] = None
        with self.assertRaises(benchmark.Failure):
            benchmark.routes_for_host({"srv0": {"routes": [malformed]}}, "fixture.benchmark.invalid")
        value = route("fixture.benchmark.invalid")
        for _ in range(66):
            value = {"handle": [{"handler": "subroute", "routes": [value]}]}
        with self.assertRaises(benchmark.Failure):
            benchmark.routes_for_host({"srv0": {"routes": [value]}}, "fixture.benchmark.invalid")

    def test_upstream_protocol_difference_cannot_pass_exact_dial_check(self):
        value = route("fixture.benchmark.invalid")
        value["handle"][0]["transport"] = {"protocol": "http", "tls": {}}
        with self.assertRaises(benchmark.Failure):
            benchmark.routes_for_host({"srv0": {"routes": [value]}}, "fixture.benchmark.invalid")


if __name__ == "__main__":
    unittest.main()
