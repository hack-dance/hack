"""Isolated channel controls. Subprocess stand-ins never execute candidate software."""

import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest import mock


SOURCE = Path(__file__).resolve().parents[2] / "scripts/install-prerelease.py"
SPEC = importlib.util.spec_from_file_location("install_prerelease", SOURCE)
installer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(installer)
REAL_PROCESS_RUN = subprocess.run


def sha(contents):
    return hashlib.sha256(contents).hexdigest()


def with_mcp(entries, change=None):
    payload = {name: value for name, value, _ in entries if name != "SHA256SUMS"}
    assets = {role: ("synthetic " + role).encode() for role in installer.MCP_FILES}
    files = {role: {"sha256": sha(value), "bytes": len(value)} for role, value in assets.items()}
    body = {"schemaVersion": 1, "startupProtocol": 2, "wireProtocol": 1,
            "platform": "darwin", "architecture": "arm64", "files": files}
    identity = sha(json.dumps(body, separators=(",", ":")).encode())
    prefix = "mcp/" + identity + "/"
    for role, name in installer.MCP_FILES.items():
        payload[prefix + name] = assets[role]
    payload[prefix + "manifest.json"] = json.dumps(dict(body, bundleId=identity)).encode()
    if change:
        change(payload, prefix)
    payload["SHA256SUMS"] = "".join(sha(value) + "  " + name + "\n"
                                    for name, value in sorted(payload.items())).encode()
    return [(name, value, tarfile.REGTYPE) for name, value in payload.items()]


def with_compiler(entries, local=True):
    payload = {name: value for name, value, _ in entries if name != "SHA256SUMS"}
    payload.update({"hack-config-compiler": b"synthetic compiler", "hack.project.schema.json": b"{}\n"})
    if local:
        payload["hack.local.schema.json"] = b"{}\n"
    payload["SHA256SUMS"] = "".join(sha(value) + "  " + name + "\n"
                                    for name, value in sorted(payload.items())).encode()
    return [(name, value, tarfile.REGTYPE) for name, value in payload.items()]


class ChannelTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="hack-prerelease-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.old_umask = os.umask(0o077)
        self.addCleanup(os.umask, self.old_umask)
        self.stable_home = self.root / "stable-home"
        (self.stable_home / ".hack").mkdir(parents=True, mode=0o700)
        (self.stable_home / ".hack/data").write_bytes(b"stable app data\x00unchanged")
        self.brew = self.root / "homebrew"
        self.brew.mkdir(mode=0o700)
        (self.brew / "hack-4.2.1").write_bytes(b"stable executable unchanged")
        (self.brew / "hack").symlink_to("hack-4.2.1")
        self.stable_before = self.stable_snapshot()
        self.addCleanup(self.assert_stable_unchanged)
        self.calls = []
        self.runtime_responses = []
        self.run_patch = mock.patch.object(installer.subprocess, "run", side_effect=self.process)
        self.run_patch.start()
        self.addCleanup(self.run_patch.stop)
        self.env_patch = mock.patch.dict(os.environ, {
            "HOME": str(self.stable_home), "HACK_HOME": str(self.stable_home / ".hack"),
            "HACK_GLOBAL_CONFIG_PATH": str(self.stable_home / ".hack/config.json"),
            "HACK_NATIVE_HOME": str(self.stable_home / "foreign-native"),
            "HACK_NATIVE_BINARY": str(self.brew / "hack"), "HACK_RUNTIME_BACKEND": "docker",
            "HACK_NATIVE_ADAPTATION": "/private/project/adaptation.json",
            "HACK_NATIVE_DEPENDENCIES": "/private/project/dependencies.json",
            "HACK_NATIVE_AWS_PROFILE": "fixture-qa",
            "HACK_NATIVE_HTTPS_PORT": "443", "HACK_NATIVE_SHARED_SOURCE": "1"})
        self.env_patch.start()
        self.addCleanup(self.env_patch.stop)
        self.channel = installer.Channel(self.root / "channel")
        self.channel.initialize()

    def stable_snapshot(self):
        return {(str(path.relative_to(self.root)), "symlink" if path.is_symlink() else "file"):
                os.readlink(path) if path.is_symlink() else sha(path.read_bytes())
                for directory in (self.stable_home, self.brew)
                for path in directory.rglob("*") if path.is_file() or path.is_symlink()}

    def assert_stable_unchanged(self):
        self.assertEqual(self.stable_snapshot(), self.stable_before)

    def process(self, arguments, **options):
        self.calls.append((arguments, options))
        if arguments[0] == "/usr/bin/codesign":
            return subprocess.CompletedProcess(arguments, 0)
        self.assertEqual(arguments[1], "--candidate-root")
        home = Path(arguments[2])
        self.assertTrue(home.is_relative_to(self.channel.root / "versions"))
        self.assertEqual(arguments[3], "runtime")
        self.assertIn(arguments[4], ("status", "down"))
        self.assertEqual(arguments[5], "--json")
        self.assertEqual(options["env"]["HACK_NATIVE_HOME"], str(home))
        self.assertEqual(options["env"]["HACK_HOME"], str(home.parent / "cli-home"))
        self.assertNotIn("HACK_GLOBAL_CONFIG_PATH", options["env"])
        response = self.runtime_responses.pop(0) if self.runtime_responses else {
            "phase": "stopped" if list(home.iterdir()) else "uninitialized", "process_alive": False}
        if isinstance(response, Exception):
            raise response
        if isinstance(response, tuple):
            return subprocess.CompletedProcess(arguments, response[0], response[1])
        return subprocess.CompletedProcess(arguments, 0, json.dumps(response).encode())

    def archive(self, version="5.0.0-next.1", mutate=None):
        identity = {"schema": "hack.prerelease/v1", "version": version, "tag": "v" + version,
                    "source_revision": "a" * 40, "platform": "darwin-arm64"}
        files = {"hack-native": b"reviewed native fixture", "hack-cli": b"reviewed CLI fixture",
                 "hack-relay-guest": b"reviewed guest fixture", "hack-v5": b"reviewed launcher fixture",
                 "provider-pins.json": b"{}\n", "README.md": b"candidate documentation\n",
                 "prerelease.json": json.dumps(identity).encode()}
        files["SHA256SUMS"] = "".join(sha(value) + "  " + name + "\n"
                                      for name, value in sorted(files.items())).encode()
        entries = [(name, value, tarfile.REGTYPE) for name, value in files.items()]
        if mutate:
            entries = mutate(entries)
        archive = self.root / ("archive-" + str(len(list(self.root.glob("archive-*")))) + ".tar.gz")
        with tarfile.open(archive, "w:gz") as target:
            for name, value, kind in entries:
                entry = tarfile.TarInfo(name)
                entry.type = kind
                entry.mode = 0o777
                entry.size = len(value) if kind == tarfile.REGTYPE else 0
                if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE):
                    entry.linkname = str(self.brew / "hack")
                target.addfile(entry, io.BytesIO(value) if kind == tarfile.REGTYPE else None)
        return archive, installer.digest(archive)

    def install(self, version="5.0.0-next.1", upgrade=False):
        archive, checksum = self.archive(version)
        with self.channel.lock():
            self.channel.install(version, archive, checksum, upgrade)
        return archive, checksum

    def selection(self):
        return installer.private_json(self.channel.root / ".selection.json")

    def legacy_channel(self, name="legacy-channel"):
        source = SOURCE.parent.parent / "tests/fixtures/prerelease-manager-flat-v1.py"
        self.assertEqual(installer.digest(source),
                         "b7c49e3fec6b06790e833db1d2dcb441d2223c283b792713be46826aa2eef877")
        spec = importlib.util.spec_from_file_location("legacy_prerelease_manager", source)
        legacy = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(legacy)
        self.channel = legacy.Channel(self.root / name)
        self.channel.initialize()
        self.assertEqual((self.channel.root / "bin/hack-next").read_bytes(), installer.launcher_bytes())
        return legacy

    def retained_snapshot(self):
        paths = [self.channel.root / ".selection.json", self.channel.root / "bin/hack-next",
                 *sorted((self.channel.root / "versions").rglob("*"))]
        return {str(path.relative_to(self.channel.root)): (
                    path.stat().st_dev, path.stat().st_ino, path.stat().st_mode,
                    path.read_bytes() if path.is_file() else None)
                for path in paths}

    def upgrade_manager(self):
        current = installer.Channel(self.channel.root)
        with current.lock(manager_upgrade=True):
            current.upgrade_manager()
        return current

    def assert_pending_refuses_installed_readers(self, legacy):
        # Exercise the real predecessor and the exact manager bytes addressed by
        # the unchanged legacy launcher. Only platform detection is substituted;
        # refusal must occur before any candidate subprocess can be reached.
        source = self.channel.root / "manager.py"
        spec = importlib.util.spec_from_file_location("retained_prerelease_manager", source)
        retained = importlib.util.module_from_spec(spec)
        # Import the retained reader without adding unowned bytecode to its
        # channel. This must hold even when unittest itself runs without -B.
        with mock.patch.object(sys, "dont_write_bytecode", True):
            spec.loader.exec_module(retained)
        self.assertFalse((self.channel.root / "__pycache__").exists())
        for module in (legacy, retained, installer):
            for command in ("status", "run"):
                with self.subTest(reader=module.__name__, command=command), \
                        mock.patch.object(module.platform, "system", return_value="Darwin"), \
                        mock.patch.object(module.platform, "machine", return_value="arm64"), \
                        mock.patch.object(module.subprocess, "Popen") as spawn:
                    with self.assertRaisesRegex(module.Refusal, "pending|Foreign installation entry|manager or launcher changed"):
                        module.main(["--root", str(self.channel.root), command])
                    spawn.assert_not_called()
        self.assertEqual((self.channel.root / "bin/hack-next").read_bytes(), installer.launcher_bytes())

        if sys.platform == "darwin" and installer.platform.machine() == "arm64":
            # On the supported host, run the unchanged shell launcher itself.
            # A pending transition must fail before codesign or candidate startup.
            result = REAL_PROCESS_RUN([str(self.channel.root / "bin/hack-next"), "--version"],
                                      env={"HOME": str(self.stable_home), "PATH": "/usr/bin:/bin"},
                                      capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stdout, "")
            self.assertRegex(result.stderr, "pending|Foreign installation entry|manager or launcher changed")

    def rejects_install(self, mutate, message):
        if not self.selection()["installed"]:
            self.install()
        before = (self.channel.root / ".selection.json").read_bytes()
        archive, checksum = self.archive("5.0.0-next.2", mutate)
        with self.channel.lock():
            with self.assertRaisesRegex(installer.Refusal, message):
                self.channel.install("5.0.0-next.2", archive, checksum, True)
        self.assertEqual((self.channel.root / ".selection.json").read_bytes(), before)
        with self.channel.lock():
            self.assertEqual(self.channel.state["selected"], "5.0.0-next.1")

    def test_install_upgrade_rollback_and_stable_preserve_prior_homes(self):
        self.install()
        first_home = self.channel.root / "versions/5.0.0-next.1/native-home"
        (first_home / "saved-application-data").write_bytes(b"first-version-marker")
        self.install("5.0.0-next.2", True)
        second_home = self.channel.root / "versions/5.0.0-next.2/native-home"
        self.assertEqual(list(second_home.iterdir()), [])
        (second_home / "saved-application-data").write_bytes(b"second-version-marker")
        self.assertEqual(self.selection()["selected"], "5.0.0-next.2")
        self.assertEqual(self.selection()["previous"], "5.0.0-next.1")
        with self.channel.lock():
            self.channel.select("5.0.0-next.1")
        self.assertEqual(first_home.joinpath("saved-application-data").read_bytes(), b"first-version-marker")
        self.assertEqual(second_home.joinpath("saved-application-data").read_bytes(), b"second-version-marker")
        with self.channel.lock():
            self.channel.select(None)
        self.assertIsNone(self.selection()["selected"])
        self.assertEqual(self.selection()["previous"], "5.0.0-next.1")
        self.assertEqual(len(self.selection()["installed"]), 2)
        actions = [arguments[4] for arguments, _ in self.calls if arguments[0] != "/usr/bin/codesign"]
        self.assertEqual(actions, ["status", "down", "status"] * 5)

    def test_idempotent_install_revalidates_without_mutating_selection(self):
        archive, checksum = self.install()
        before = (self.channel.root / ".selection.json").read_bytes()
        with self.channel.lock():
            self.channel.install("5.0.0-next.1", archive, checksum)
        self.assertEqual(before, (self.channel.root / ".selection.json").read_bytes())
        (self.channel.root / "versions/5.0.0-next.1/bundle/hack-cli").write_bytes(b"changed")
        with self.assertRaisesRegex(installer.Refusal, "checksum mismatch"):
            with self.channel.lock():
                self.fail("Changed installation was accepted")

    def test_optional_mcp_upgrade_keeps_modes_and_legacy_rollback(self):
        self.install()
        archive, checksum = self.archive("5.0.0-next.2", with_mcp)
        with self.channel.lock():
            self.channel.install("5.0.0-next.2", archive, checksum, True)
        bundle = self.channel.root / "versions/5.0.0-next.2/bundle"
        _identity, manifest = installer.verify_bundle(bundle, "5.0.0-next.2")
        nested = set(manifest) - installer.PAYLOAD
        self.assertEqual(len(nested), 4)
        for name in nested:
            self.assertEqual((bundle / name).stat().st_mode & 0o777,
                             0o400 if name.endswith("manifest.json") else 0o500)
        signed = {Path(arguments[-1]).name for arguments, _ in self.calls
                  if arguments[0] == "/usr/bin/codesign"}
        self.assertTrue(set(installer.MCP_FILES.values()) <= signed)
        with self.channel.lock():
            self.channel.select("5.0.0-next.1")
        self.assertEqual(self.selection()["selected"], "5.0.0-next.1")
        with self.channel.lock():
            self.channel.select("5.0.0-next.2")
        self.assertEqual(self.selection()["selected"], "5.0.0-next.2")
        before = (self.channel.root / ".selection.json").read_bytes()
        directory = next((bundle / "mcp").iterdir())
        moved = self.root / "saved-mcp"
        directory.rename(moved)
        directory.symlink_to(moved, target_is_directory=True)
        with self.assertRaises(installer.Refusal):
            with self.channel.lock():
                self.fail("Aliased MCP bundle accepted")
        self.assertEqual((self.channel.root / ".selection.json").read_bytes(), before)

    def test_compiler_pair_upgrade_preserves_old_layouts_and_installed_modes(self):
        self.install()
        archive, checksum = self.archive("5.0.0-next.2", with_mcp)
        with self.channel.lock():
            self.channel.install("5.0.0-next.2", archive, checksum, True)
        for number, mutate in ((3, lambda entries: with_compiler(entries, local=False)),
                               (4, with_compiler), (5, lambda entries: with_compiler(with_mcp(entries)))):
            version = "5.0.0-next." + str(number)
            archive, checksum = self.archive(version, mutate)
            with self.channel.lock():
                self.channel.install(version, archive, checksum, True)
            bundle = self.channel.root / "versions" / version / "bundle"
            _, manifest = installer.verify_bundle(bundle, version)
            compiler = installer.LEGACY_COMPILER_PAYLOAD if number == 3 else installer.COMPILER_PAYLOAD
            self.assertEqual(set(manifest) & installer.COMPILER_PAYLOAD, compiler)
            for name in compiler:
                self.assertEqual((bundle / name).stat().st_mode & 0o777,
                                 0o755 if name == "hack-config-compiler" else 0o600)
            for prior in ("5.0.0-next.1", "5.0.0-next.2", "5.0.0-next.3", version):
                with self.channel.lock():
                    self.channel.select(prior)
                self.assertEqual(self.selection()["selected"], prior)
        signed = {Path(arguments[-1]).name for arguments, _ in self.calls
                  if arguments[0] == "/usr/bin/codesign"}
        self.assertIn("hack-config-compiler", signed)
        self.assertNotIn("hack.project.schema.json", signed)
        self.assertNotIn("hack.local.schema.json", signed)

    def test_incomplete_compiler_groups_refuse_even_matching_checksums(self):
        invalid = (("hack-config-compiler",), ("hack.project.schema.json",), ("hack.local.schema.json",),
                   ("hack-config-compiler", "hack.local.schema.json"),
                   ("hack.project.schema.json", "hack.local.schema.json"))
        for members in invalid:
            with self.subTest(members=members):
                def mutate(entries):
                    payload = {name: value for name, value, _ in with_compiler(entries)
                               if name != "SHA256SUMS" and
                               (name not in installer.COMPILER_PAYLOAD or name in members)}
                    payload["SHA256SUMS"] = "".join(sha(value) + "  " + name + "\n"
                                                    for name, value in sorted(payload.items())).encode()
                    return [(name, value, tarfile.REGTYPE) for name, value in payload.items()]
                self.rejects_install(mutate, "Incomplete config compiler payload")

    def test_partial_tampered_and_aliased_compiler_archives_preserve_selection(self):
        for name in installer.COMPILER_PAYLOAD:
            for case in ("missing", "tampered", tarfile.SYMTYPE, tarfile.LNKTYPE):
                with self.subTest(name=name, case=case):
                    def mutate(entries):
                        return [(key, b"changed" if case == "tampered" and key == name else value,
                                 case if case in (tarfile.SYMTYPE, tarfile.LNKTYPE) and key == name else kind)
                                for key, value, kind in with_compiler(entries)
                                if not (case == "missing" and key == name)]
                    self.rejects_install(mutate, "compiler payload|checksum mismatch|checksum entry|regular archive files")

    def test_installed_compiler_pair_tampering_and_modes_are_refused(self):
        archive, checksum = self.archive(mutate=with_compiler)
        with self.channel.lock():
            self.channel.install("5.0.0-next.1", archive, checksum)
        bundle = self.channel.root / "versions/5.0.0-next.1/bundle"
        for name in installer.COMPILER_PAYLOAD:
            path = bundle / name
            before = path.read_bytes()
            mode = path.stat().st_mode & 0o777
            for case in ("bytes", "mode", "hardlink", "symlink"):
                with self.subTest(name=name, case=case):
                    alias = self.root / "compiler-alias"
                    if case == "bytes":
                        path.write_bytes(b"changed")
                    elif case == "mode":
                        path.chmod(0o777)
                    elif case == "hardlink":
                        os.link(path, alias)
                    else:
                        path.rename(alias)
                        path.symlink_to(alias)
                    with self.assertRaises(installer.Refusal):
                        installer.verify_bundle(bundle, "5.0.0-next.1")
                    if case == "symlink":
                        path.unlink()
                        alias.rename(path)
                    elif case == "hardlink":
                        alias.unlink()
                    else:
                        path.write_bytes(before)
                        path.chmod(mode)

    def test_failed_compiler_signature_preserves_selection(self):
        self.install()
        archive, checksum = self.archive("5.0.0-next.2", with_compiler)
        before = self.selection()
        original = self.process
        def fail_compiler(arguments, **options):
            if arguments[0] == "/usr/bin/codesign" and Path(arguments[-1]).name == "hack-config-compiler":
                return subprocess.CompletedProcess(arguments, 1)
            return original(arguments, **options)
        with mock.patch.object(installer.subprocess, "run", side_effect=fail_compiler):
            with self.channel.lock():
                with self.assertRaisesRegex(installer.Refusal, "signature failed: hack-config-compiler"):
                    self.channel.install("5.0.0-next.2", archive, checksum, True)
        self.assertEqual(self.selection(), before)

    def test_reviewed_mcp_manager_upgrades_before_accepting_compiler_pair(self):
        source = SOURCE.parent.parent / "tests/fixtures/prerelease-manager-mcp-v2.py"
        self.assertEqual(installer.digest(source),
                         "ca432b7fc6562bb091d17d3217f5d1daf9f91621a6919c8964ca51bee2111d0c")
        spec = importlib.util.spec_from_file_location("mcp_prerelease_manager", source)
        previous = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(previous)
        self.channel = previous.Channel(self.root / "mcp-channel")
        self.channel.initialize()
        self.install()
        archive, checksum = self.archive("5.0.0-next.2", with_mcp)
        with self.channel.lock():
            self.channel.install("5.0.0-next.2", archive, checksum, True)
        before = self.retained_snapshot()
        archive, checksum = self.archive("5.0.0-next.3", with_compiler)
        current = installer.Channel(self.channel.root)
        with current.lock():
            with self.assertRaisesRegex(installer.Refusal, "upgrade-manager"):
                current.install("5.0.0-next.3", archive, checksum, True)
        self.assertEqual(self.retained_snapshot(), before)
        self.channel = self.upgrade_manager()
        self.assertEqual(self.retained_snapshot(), before)
        with self.channel.lock():
            self.channel.install("5.0.0-next.3", archive, checksum, True)
            self.channel.select("5.0.0-next.2")
        self.assertEqual(self.selection()["selected"], "5.0.0-next.2")

    def test_reviewed_compiler_manager_upgrade_preserves_selection_and_payloads(self):
        source = SOURCE.parent.parent / "tests/fixtures/prerelease-manager-compiler-v3.py"
        predecessor = "d39e77623be1876567e9db66c468e8da96067aeac0d88089df28efc11f850ef8"
        self.assertEqual(installer.digest(source), predecessor)
        self.assertIn(predecessor, installer.MANAGER_PREDECESSORS)
        spec = importlib.util.spec_from_file_location("compiler_prerelease_manager", source)
        previous = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(previous)
        self.channel = previous.Channel(self.root / "compiler-channel")
        self.channel.initialize()
        archive, checksum = self.archive(mutate=lambda entries: with_mcp(with_compiler(entries)))
        with self.channel.lock():
            self.channel.install("5.0.0-next.1", archive, checksum)
        for home in ("native-home", "cli-home"):
            (self.channel.root / "versions/5.0.0-next.1" / home / "marker").write_bytes(home.encode())
        before = self.retained_snapshot()
        self.assertEqual(installer.digest(self.channel.root / "manager.py"), predecessor)
        self.channel = self.upgrade_manager()
        self.assertEqual(self.retained_snapshot(), before)
        self.assertEqual((self.channel.root / "manager.py").read_bytes(), SOURCE.read_bytes())
        with self.channel.lock():
            self.assertEqual(self.channel.state["selected"], "5.0.0-next.1")
        child = mock.Mock()
        child.wait.return_value = 17
        with self.channel.lock(shared=True), \
                mock.patch.object(installer.subprocess, "Popen", return_value=child) as spawn:
            self.assertEqual(self.channel.run(["--version"]), 17)
        self.assertEqual(spawn.call_args.args[0][1:], ["--version"])
        self.assertEqual(self.retained_snapshot(), before)

    def test_bundle_verification_hashes_each_payload_once_without_cross_call_cache(self):
        archive, checksum = self.archive(mutate=lambda entries: with_mcp(with_compiler(entries)))
        with self.channel.lock():
            self.channel.install("5.0.0-next.1", archive, checksum)
        bundle = self.channel.root / "versions/5.0.0-next.1/bundle"
        payload = installer.bundle_inventory(bundle)
        for _ in range(2):
            with mock.patch.object(installer, "digest", wraps=installer.digest) as reads:
                identity, manifest = installer.verify_bundle(bundle, "5.0.0-next.1")
            self.assertEqual(identity["version"], "5.0.0-next.1")
            self.assertEqual(set(manifest), payload)
            self.assertCountEqual([call.args[0] for call in reads.call_args_list],
                                  [bundle / name for name in payload])

    def test_nested_mcp_fingerprint_refuses_changed_bytes_despite_valid_outer_sums(self):
        def same_size_asset_change(payload, prefix):
            path = prefix + "hack-mcp-backend"
            before = payload[path]
            payload[path] = bytes([before[0] ^ 1]) + before[1:]
            self.assertEqual(len(payload[path]), len(before))
        self.rejects_install(lambda entries: with_mcp(entries, same_size_asset_change),
                             "MCP asset fingerprint mismatch")

    def test_retained_payload_tamper_with_restored_mtime_refuses_next_launch(self):
        for version in ("5.0.0-next.1", "5.0.0-next.2"):
            archive, checksum = self.archive(version, with_mcp)
            with self.channel.lock():
                self.channel.install(version, archive, checksum, version.endswith(".2"))
        before = self.selection()
        for version in ("5.0.0-next.1", "5.0.0-next.2"):
            bundle = self.channel.root / "versions" / version / "bundle"
            paths = [bundle / "hack-cli", next((bundle / "mcp").glob("*/hack-mcp-backend"))]
            for path in paths:
                with self.subTest(version=version, payload=path.name):
                    contents, info = path.read_bytes(), path.stat()
                    try:
                        path.chmod(info.st_mode | 0o200)
                        path.write_bytes(bytes([contents[0] ^ 1]) + contents[1:])
                        path.chmod(info.st_mode)
                        os.utime(path, ns=(info.st_atime_ns, info.st_mtime_ns))
                        self.assertEqual(path.stat().st_size, info.st_size)
                        self.assertEqual(path.stat().st_mtime_ns, info.st_mtime_ns)
                        self.assertEqual(path.stat().st_mode, info.st_mode)
                        self.assertEqual(path.stat().st_ino, info.st_ino)
                        current = installer.Channel(self.channel.root)
                        with mock.patch.object(installer.subprocess, "Popen") as spawn:
                            with self.assertRaisesRegex(installer.Refusal, "checksum mismatch"):
                                with current.lock(shared=True):
                                    current.run(["--version"])
                            spawn.assert_not_called()
                        self.assertEqual(self.selection(), before)
                    finally:
                        path.chmod(info.st_mode | 0o200)
                        path.write_bytes(contents)
                        path.chmod(info.st_mode)
                        os.utime(path, ns=(info.st_atime_ns, info.st_mtime_ns))

    def test_selected_payload_changed_after_validation_refuses_before_spawn(self):
        self.install()
        path = self.channel.root / "versions/5.0.0-next.1/bundle/hack-cli"
        contents, info = path.read_bytes(), path.stat()
        with self.channel.lock(shared=True):
            path.write_bytes(bytes([contents[0] ^ 1]) + contents[1:])
            os.utime(path, ns=(info.st_atime_ns, info.st_mtime_ns))
            with mock.patch.object(installer.subprocess, "Popen") as spawn:
                with self.assertRaisesRegex(installer.Refusal, "checksum mismatch"):
                    self.channel.run(["--version"])
                spawn.assert_not_called()

    def test_status_and_run_do_not_load_archive_or_download_modules(self):
        self.install()
        script = """
import importlib.util, io, json, sys
spec = importlib.util.spec_from_file_location('isolated_installer', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
def loaded():
    return sorted(name for name in sys.modules
                  if name == 'tarfile' or name in ('urllib.request', 'urllib.error'))
stages = {'import': loaded()}
module.platform.system = lambda: 'Darwin'
module.platform.machine = lambda: 'arm64'
module.verify_signatures = lambda bundle: None
class Child:
    def __init__(self, *arguments, **options): pass
    def wait(self): return 0
    def send_signal(self, signum): pass
module.subprocess.Popen = Child
with module.contextlib.redirect_stdout(io.StringIO()):
    assert module.main(['--root', sys.argv[2], 'status']) == 0
stages['status'] = loaded()
assert module.main(['--root', sys.argv[2], 'run', '--', '--version']) == 0
stages['run'] = loaded()
print(json.dumps(stages))
"""
        result = REAL_PROCESS_RUN([sys.executable, "-I", "-B", "-S", "-c", script,
                                   str(SOURCE), str(self.channel.root)],
                                  capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {"import": [], "status": [], "run": []})

    def test_mcp_corruption_and_nested_inventory_preserve_previous_selection(self):
        def manifest_change(payload, prefix, field, value):
            path = prefix + "manifest.json"
            manifest = json.loads(payload[path])
            manifest[field] = value
            payload[path] = json.dumps(manifest).encode()
        changes = [
            lambda data, prefix: data.pop(prefix + "hack-mcp-owner"),
            lambda data, prefix: data.update({prefix + "foreign": b"foreign"}),
            lambda data, prefix: data.update({prefix + "../hack-cli": b"traversal"}),
            lambda data, prefix: data.update({prefix + "hack-mcp-backend": b"changed"}),
            lambda data, prefix: manifest_change(data, prefix, "startupProtocol", 1),
            lambda data, prefix: manifest_change(data, prefix, "schemaVersion", True),
            lambda data, prefix: manifest_change(data, prefix, "architecture", "x64"),
            lambda data, prefix: manifest_change(data, prefix, "bundleId", "0" * 64),
            lambda data, prefix: data.update({"mcp/" + "0" * 64 + "/hack-mcp-owner": b"second"}),
        ]
        for change in changes:
            with self.subTest(change=change):
                self.rejects_install(lambda entries: with_mcp(entries, change),
                                     "MCP|archive entr")
        for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.DIRTYPE):
            with self.subTest(kind=kind):
                def link(entries):
                    return [(name, value, kind if name.endswith("hack-mcp-owner") else original)
                            for name, value, original in with_mcp(entries)]
                self.rejects_install(link, "regular archive files")

    def test_actual_legacy_manager_refuses_new_layout_without_losing_status_or_rollback(self):
        # Unmodified flat-payload manager from next09032e13. Only its native
        # subprocess boundary is replaced, as in the other channel fixtures.
        source = SOURCE.parent.parent / "tests/fixtures/prerelease-manager-flat-v1.py"
        self.assertEqual(installer.digest(source),
                         "b7c49e3fec6b06790e833db1d2dcb441d2223c283b792713be46826aa2eef877")
        spec = importlib.util.spec_from_file_location("legacy_prerelease_manager", source)
        legacy = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(legacy)
        self.channel = legacy.Channel(self.root / "legacy-channel")
        self.channel.initialize()
        self.install()
        self.install("5.0.0-next.2", True)
        paths = (".selection.json", ".channel.json", "manager.py", "bin/hack-next")
        before = {name: (self.channel.root / name).read_bytes() for name in paths}
        versions = sorted(path.name for path in (self.channel.root / "versions").iterdir())
        current = installer.Channel(self.channel.root)
        archive, checksum = self.archive("5.0.0-next.3", with_mcp)
        with current.lock():
            with self.assertRaisesRegex(installer.Refusal, "fresh --root"):
                current.install("5.0.0-next.3", archive, checksum, True)
        self.assertEqual({name: (self.channel.root / name).read_bytes() for name in paths}, before)
        self.assertEqual(sorted(path.name for path in (self.channel.root / "versions").iterdir()), versions)
        with mock.patch.object(legacy.platform, "system", return_value="Darwin"), \
                mock.patch.object(legacy.platform, "machine", return_value="arm64"):
            with contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(legacy.main(["--root", str(self.channel.root), "status"]), 0)
            self.assertEqual(json.loads(output.getvalue())["selected"], "5.0.0-next.2")
            with contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(legacy.main(["--root", str(self.channel.root), "rollback"]), 0)
            self.assertEqual(json.loads(output.getvalue())["selected"], "5.0.0-next.1")

    def test_explicit_manager_upgrade_preserves_retained_data_and_enables_mcp_rollback(self):
        self.legacy_channel()
        self.install()
        self.install("5.0.0-next.2", True)
        for version in ("5.0.0-next.1", "5.0.0-next.2"):
            for home in ("native-home", "cli-home"):
                (self.channel.root / "versions" / version / home / "marker").write_text(version + home)
        before = self.retained_snapshot()
        original_manager = (self.channel.root / "manager.py").read_bytes()
        self.calls = []
        with mock.patch.object(installer.platform, "system", return_value="Darwin"), \
                mock.patch.object(installer.platform, "machine", return_value="arm64"), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(installer.main(["--root", str(self.channel.root), "upgrade-manager"]), 0)
        self.assertEqual(json.loads(output.getvalue())["selected"], "5.0.0-next.2")
        self.assertEqual(self.retained_snapshot(), before)
        self.assertEqual((self.channel.root / "manager.py").read_bytes(), SOURCE.read_bytes())
        self.assertEqual(installer.private_json(self.channel.root / ".channel.json")["manager_sha256"],
                         installer.digest(SOURCE))
        stage = next(self.channel.root.glob(".stage-*/manager-before.py"))
        self.assertEqual(stage.read_bytes(), original_manager)
        self.assertFalse((self.channel.root / installer.MANAGER_UPGRADE).exists())
        self.assertEqual([args[4] for args, _ in self.calls if args[0] != "/usr/bin/codesign"],
                         ["status", "down", "status"] * 2)
        manager_stat = (self.channel.root / "manager.py").stat()
        self.upgrade_manager()
        self.assertEqual((self.channel.root / "manager.py").stat(), manager_stat)
        self.assertEqual(self.retained_snapshot(), before)
        self.channel = installer.Channel(self.channel.root)
        archive, checksum = self.archive("5.0.0-next.3", with_mcp)
        with self.channel.lock():
            self.channel.install("5.0.0-next.3", archive, checksum, True)
            self.channel.select("5.0.0-next.1")
            self.channel.select("5.0.0-next.3")
        self.assertEqual(self.selection()["selected"], "5.0.0-next.3")
        for version in ("5.0.0-next.1", "5.0.0-next.2"):
            for home in ("native-home", "cli-home"):
                self.assertEqual((self.channel.root / "versions" / version / home / "marker").read_text(), version + home)

    def test_manager_upgrade_refuses_custom_changed_and_aliased_inputs_without_writes(self):
        for case in ("custom-manager", "changed-manager", "custom-launcher", "manager-symlink",
                     "manager-hardlink", "receipt-symlink", "unsafe-root"):
            with self.subTest(case=case):
                self.legacy_channel(case)
                self.install()
                manager = self.channel.root / "manager.py"
                marker_path = self.channel.root / ".channel.json"
                marker = installer.private_json(marker_path)
                if case in ("custom-manager", "changed-manager"):
                    manager.write_bytes(manager.read_bytes() + b"# custom\n")
                    if case == "custom-manager":
                        marker["manager_sha256"] = installer.digest(manager)
                        marker_path.write_bytes(installer.json_bytes(marker))
                elif case == "custom-launcher":
                    launcher = self.channel.root / "bin/hack-next"
                    launcher.write_bytes(launcher.read_bytes() + b"# custom\n")
                    marker["launcher_sha256"] = installer.digest(launcher)
                    marker_path.write_bytes(installer.json_bytes(marker))
                elif case in ("manager-symlink", "receipt-symlink"):
                    path = manager if case == "manager-symlink" else marker_path
                    saved = self.root / (case + "-saved")
                    path.rename(saved)
                    path.symlink_to(saved)
                elif case == "manager-hardlink":
                    os.link(manager, self.root / "manager-link")
                else:
                    self.channel.root.chmod(0o755)
                before = self.retained_snapshot()
                entries = sorted(path.name for path in self.channel.root.iterdir())
                self.calls = []
                with self.assertRaises(installer.Refusal):
                    self.upgrade_manager()
                self.assertEqual(self.retained_snapshot(), before)
                self.assertEqual(sorted(path.name for path in self.channel.root.iterdir()), entries)
                self.assertEqual(self.calls, [])

    def test_manager_upgrade_keeps_launcher_and_runtime_quiescence_gates(self):
        self.legacy_channel()
        self.install()
        self.install("5.0.0-next.2", True)
        manager = (self.channel.root / "manager.py").read_bytes()
        before = self.retained_snapshot()
        with self.channel.lock(shared=True):
            with self.assertRaisesRegex(installer.Refusal, "active"):
                self.upgrade_manager()
        stopped = {"phase": "uninitialized", "process_alive": False}
        for response in ({"phase": "running", "process_alive": True},
                         {"phase": "unknown", "process_alive": False}, (1, b""), (0, b"malformed"),
                         subprocess.TimeoutExpired(["status"], 30)):
            self.runtime_responses = [stopped] * 3 + [response]
            with self.assertRaises(installer.Refusal):
                self.upgrade_manager()
            self.assertEqual((self.channel.root / "manager.py").read_bytes(), manager)
            self.assertEqual(self.retained_snapshot(), before)
            self.assertFalse((self.channel.root / installer.MANAGER_UPGRADE).exists())

    def test_real_process_exit_at_each_manager_publication_boundary_is_recoverable(self):
        for boundary in ("journal", "manager", "receipt", "complete"):
            with self.subTest(boundary=boundary):
                legacy = self.legacy_channel("interrupt-" + boundary)
                self.install()
                marker = self.channel.root / "versions/5.0.0-next.1/native-home/marker"
                marker.write_bytes(b"retained data")
                before = self.retained_snapshot()
                pid = os.fork()
                if pid == 0:
                    original_rename, original_replace, original_unlink = os.rename, os.replace, Path.unlink
                    def rename(source, destination):
                        original_rename(source, destination)
                        if boundary == "journal" and Path(destination).name == installer.MANAGER_UPGRADE:
                            os._exit(86)
                    def replace(source, destination):
                        original_replace(source, destination)
                        if Path(destination).name == {"manager": "manager.py", "receipt": ".channel.json"}.get(boundary):
                            os._exit(86)
                    def unlink(path, *args, **kwargs):
                        original_unlink(path, *args, **kwargs)
                        if boundary == "complete" and path.name == installer.MANAGER_UPGRADE:
                            os._exit(86)
                    try:
                        with mock.patch.object(os, "rename", side_effect=rename), \
                                mock.patch.object(os, "replace", side_effect=replace), \
                                mock.patch.object(Path, "unlink", new=unlink):
                            self.upgrade_manager()
                    finally:
                        os._exit(87)
                _, status = os.waitpid(pid, 0)
                self.assertEqual(os.waitstatus_to_exitcode(status), 86)
                self.assertEqual(self.retained_snapshot(), before)
                if boundary != "complete":
                    self.assert_pending_refuses_installed_readers(legacy)
                else:
                    with installer.Channel(self.channel.root).lock():
                        pass
                self.upgrade_manager()
                self.assertEqual(self.retained_snapshot(), before)
                self.assertEqual((self.channel.root / "manager.py").read_bytes(), SOURCE.read_bytes())
                self.assertFalse((self.channel.root / installer.MANAGER_UPGRADE).exists())
                with installer.Channel(self.channel.root).lock():
                    pass

    def test_manager_staging_failure_leaves_actual_legacy_status_usable(self):
        legacy = self.legacy_channel()
        self.install()
        before = self.retained_snapshot()
        manager = (self.channel.root / "manager.py").read_bytes()
        original = installer.write_file
        def fail(path, contents, mode=0o600):
            if path.name == "manager-after.py":
                raise OSError("injected staging failure")
            return original(path, contents, mode)
        with mock.patch.object(installer, "write_file", side_effect=fail):
            with self.assertRaisesRegex(OSError, "staging failure"):
                self.upgrade_manager()
        self.assertEqual(self.retained_snapshot(), before)
        self.assertEqual((self.channel.root / "manager.py").read_bytes(), manager)
        self.assertFalse((self.channel.root / installer.MANAGER_UPGRADE).exists())
        with mock.patch.object(legacy.platform, "system", return_value="Darwin"), \
                mock.patch.object(legacy.platform, "machine", return_value="arm64"), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(legacy.main(["--root", str(self.channel.root), "status"]), 0)
        self.assertEqual(json.loads(output.getvalue())["selected"], "5.0.0-next.1")
        self.upgrade_manager()
        self.assertEqual(self.retained_snapshot(), before)

    def test_manager_recovery_refuses_changed_journal_stage_selection_and_unordered_state(self):
        for case in ("new-bytes", "old-bytes", "other-installer", "bad-digest-type",
                     "stage-symlink", "stage-extra", "journal-symlink", "journal-hardlink",
                     "selection", "unordered-receipt", "changed-bundle"):
            with self.subTest(case=case):
                self.legacy_channel("recovery-" + case)
                self.install()
                with mock.patch.object(installer, "atomic_file", side_effect=OSError("before manager publication")):
                    with self.assertRaisesRegex(OSError, "before manager publication"):
                        self.upgrade_manager()
                journal = self.channel.root / installer.MANAGER_UPGRADE
                plan = installer.private_json(journal)
                stage = self.channel.root / plan["stage"]
                if case in ("new-bytes", "old-bytes"):
                    path = stage / ("manager-after.py" if case == "new-bytes" else "manager-before.py")
                    path.write_bytes(path.read_bytes() + b"# changed\n")
                elif case in ("other-installer", "bad-digest-type"):
                    plan["to_sha256"] = "0" * 64 if case == "other-installer" else {}
                    journal.write_bytes(installer.json_bytes(plan))
                elif case in ("stage-symlink", "journal-symlink"):
                    path = stage if case == "stage-symlink" else journal
                    saved = self.root / (case + "-saved")
                    path.rename(saved)
                    path.symlink_to(saved)
                elif case == "stage-extra":
                    (stage / "foreign").write_bytes(b"not owned")
                elif case == "journal-hardlink":
                    os.link(journal, self.root / "journal-alias")
                elif case == "selection":
                    state = self.selection()
                    state.update(selected=None, previous=state["selected"])
                    (self.channel.root / ".selection.json").write_bytes(installer.json_bytes(state))
                elif case == "unordered-receipt":
                    (self.channel.root / ".channel.json").write_bytes((stage / "channel-after.json").read_bytes())
                else:
                    (self.channel.root / "versions/5.0.0-next.1/bundle/hack-cli").chmod(0o700)
                    (self.channel.root / "versions/5.0.0-next.1/bundle/hack-cli").write_bytes(b"changed")
                before = self.retained_snapshot()
                manager_before = (self.channel.root / "manager.py").read_bytes()
                channel_before = (self.channel.root / ".channel.json").read_bytes()
                self.calls = []
                with self.assertRaises(installer.Refusal):
                    self.upgrade_manager()
                self.assertEqual(self.calls, [])
                self.assertEqual(self.retained_snapshot(), before)
                self.assertEqual((self.channel.root / "manager.py").read_bytes(), manager_before)
                self.assertEqual((self.channel.root / ".channel.json").read_bytes(), channel_before)
                self.assertTrue(os.path.lexists(journal))

    def test_active_unknown_failed_and_timed_out_status_never_trigger_down(self):
        self.install()
        cases = [{"phase": "running", "process_alive": True},
                 {"phase": "process-exited", "process_alive": False},
                 {"phase": "stopped", "process_alive": None},
                 {"phase": "stopped", "process_alive": 0},
                 {"phase": "initializing", "process_alive": False},
                 (1, b""), (0, b"not json"),
                 subprocess.TimeoutExpired(["status"], 30)]
        for response in cases:
            with self.subTest(response=response):
                before = (self.channel.root / ".selection.json").read_bytes()
                self.calls = []
                self.runtime_responses = [response]
                with self.channel.lock():
                    with self.assertRaises(installer.Refusal):
                        self.channel.select(None)
                actions = [args[4] for args, _ in self.calls if args[0] != "/usr/bin/codesign"]
                self.assertEqual(actions, ["status"])
                self.assertEqual((self.channel.root / ".selection.json").read_bytes(), before)

    def test_down_failure_and_post_down_running_refuse_switch(self):
        self.install()
        stopped = {"phase": "stopped", "process_alive": False}
        for responses in ([stopped, (1, b"failure")],
                          [stopped, stopped, {"phase": "running", "process_alive": True}]):
            with self.subTest(responses=responses):
                self.runtime_responses = list(responses)
                with self.channel.lock():
                    with self.assertRaises(installer.Refusal):
                        self.channel.select(None)
                self.assertEqual(self.selection()["selected"], "5.0.0-next.1")

    def test_uninitialized_home_with_leftover_state_is_ambiguous(self):
        self.install()
        native_home = self.channel.root / "versions/5.0.0-next.1/native-home"
        (native_home / ".hack-local").mkdir(mode=0o700)
        (native_home / ".hack-local/leftover-owner.json").write_text("{}")
        self.runtime_responses = [{"phase": "uninitialized", "process_alive": False}]
        with self.channel.lock():
            with self.assertRaisesRegex(installer.Refusal, "contains state"):
                self.channel.select(None)
        self.assertEqual(self.selection()["selected"], "5.0.0-next.1")

    def test_receipt_changed_during_runtime_probe_is_rejected(self):
        self.install()
        original = self.process
        def changed(arguments, **options):
            result = original(arguments, **options)
            if arguments[0] != "/usr/bin/codesign":
                path = self.channel.root / "versions/5.0.0-next.1/.receipt.json"
                path.write_bytes(path.read_bytes() + b" ")
            return result
        with mock.patch.object(installer.subprocess, "run", side_effect=changed):
            with self.channel.lock():
                with self.assertRaisesRegex(installer.Refusal, "receipt changed"):
                    self.channel.select(None)
        self.assertEqual(self.selection()["selected"], "5.0.0-next.1")

    def test_bad_archive_checksum_preserves_previous_selected_bundle(self):
        self.install()
        archive, _ = self.archive("5.0.0-next.2")
        with self.channel.lock():
            with self.assertRaisesRegex(installer.Refusal, "Archive checksum"):
                self.channel.install("5.0.0-next.2", archive, "0" * 64, True)
        self.assertEqual(self.selection()["selected"], "5.0.0-next.1")
        with self.channel.lock():
            pass

    def test_duplicate_and_traversing_archive_entries_are_rejected(self):
        mutations = [lambda entries: [*entries[:-1], entries[0]],
                     lambda entries: [("../stable-home/.hack/data", *entries[0][1:]), *entries[1:]],
                     lambda entries: [("/tmp/hack", *entries[0][1:]), *entries[1:]],
                     lambda entries: [("bundle/hack-native", *entries[0][1:]), *entries[1:]]]
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                self.rejects_install(mutate, "archive entry|archive entries")

    def test_symlink_hardlink_and_nonregular_archive_entries_are_rejected(self):
        for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.FIFOTYPE, tarfile.DIRTYPE):
            with self.subTest(kind=kind):
                self.rejects_install(lambda entries: [(entries[0][0], b"", kind), *entries[1:]],
                                     "regular archive files")

    def test_manifest_and_metadata_are_verified_before_activation(self):
        def replace(entries, name, content):
            return [(key, content if key == name else value, kind) for key, value, kind in entries]
        mutations = [lambda entries: replace(entries, "hack-cli", b"tampered"),
                     lambda entries: replace(entries, "SHA256SUMS", b"not checksums"),
                     lambda entries: replace(entries, "SHA256SUMS", b"0" * 64 + b"  foreign\n")]
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                self.rejects_install(mutate, "checksum|SHA256SUMS")

    def test_wrong_version_revision_platform_and_duplicate_json_fields_refuse(self):
        for field, value in (("version", "5.0.0-next.99"), ("source_revision", "short"),
                             ("platform", "linux-arm64"), ("schema", "hack.prerelease/v2")):
            with self.subTest(field=field):
                identity = {"schema": "hack.prerelease/v1", "version": "5.0.0-next.2",
                            "tag": "v5.0.0-next.2", "source_revision": "a" * 40, "platform": "darwin-arm64"}
                identity[field] = value
                with self.assertRaises(installer.Refusal):
                    installer.metadata(json.dumps(identity), "5.0.0-next.2")
        with self.assertRaisesRegex(installer.Refusal, "Duplicate JSON"):
            installer.parse_json('{"selected":null,"selected":"foreign"}')
        for version in ("5.0.0-next.0", "5.0.0-next.01", "5.0.0-next.-1", "4.2.1", "5.0.0-next.1/../x"):
            with self.assertRaises(installer.Refusal):
                installer.version_number(version)

    def test_checksummed_malformed_metadata_is_rejected_before_extraction(self):
        def malformed(entries):
            payload = {name: value for name, value, _kind in entries if name != "SHA256SUMS"}
            identity = json.loads(payload["prerelease.json"])
            identity["source_revision"] = "short"
            payload["prerelease.json"] = json.dumps(identity).encode()
            payload["SHA256SUMS"] = "".join(sha(value) + "  " + name + "\n"
                                               for name, value in sorted(payload.items())).encode()
            return [(name, value, tarfile.REGTYPE) for name, value in payload.items()]
        archive, checksum = self.archive(mutate=malformed)
        destination = self.root / "must-not-be-extracted"
        with self.assertRaisesRegex(installer.Refusal, "identity mismatch"):
            installer.extract_archive(archive, checksum, destination, "5.0.0-next.1")
        self.assertFalse(destination.exists())

    def test_failed_signature_verification_preserves_previous_version(self):
        self.install()
        archive, checksum = self.archive("5.0.0-next.2")
        original = self.process
        def fail_signature(arguments, **options):
            if arguments[0] == "/usr/bin/codesign" and ".stage-" in arguments[-1]:
                return subprocess.CompletedProcess(arguments, 1)
            return original(arguments, **options)
        with mock.patch.object(installer.subprocess, "run", side_effect=fail_signature):
            with self.channel.lock():
                with self.assertRaisesRegex(installer.Refusal, "signature failed"):
                    self.channel.install("5.0.0-next.2", archive, checksum, True)
        self.assertEqual(self.selection()["selected"], "5.0.0-next.1")

    def test_interrupted_pointer_commit_keeps_old_selection_usable(self):
        self.install()
        before = (self.channel.root / ".selection.json").read_bytes()
        archive, checksum = self.archive("5.0.0-next.2")
        with mock.patch.object(installer.os, "replace", side_effect=OSError("interrupted switch")):
            with self.channel.lock():
                with self.assertRaisesRegex(OSError, "interrupted switch"):
                    self.channel.install("5.0.0-next.2", archive, checksum, True)
        self.assertEqual((self.channel.root / ".selection.json").read_bytes(), before)
        self.assertTrue((self.channel.root / "versions/5.0.0-next.2/.receipt.json").is_file())
        with self.channel.lock():
            self.assertEqual(self.channel.state["selected"], "5.0.0-next.1")
        with self.channel.lock():
            with self.assertRaisesRegex(installer.Refusal, "overwrite"):
                self.channel.install("5.0.0-next.2", archive, checksum, True)

    def test_partial_extraction_keeps_old_selection_usable(self):
        self.install()
        archive, checksum = self.archive("5.0.0-next.2")
        with mock.patch.object(installer, "extract_archive", side_effect=OSError("partial extraction")):
            with self.channel.lock():
                with self.assertRaisesRegex(OSError, "partial extraction"):
                    self.channel.install("5.0.0-next.2", archive, checksum, True)
        with self.channel.lock():
            self.assertEqual(self.channel.state["selected"], "5.0.0-next.1")

    def test_changed_home_symlink_and_malformed_receipts_are_refused(self):
        self.install()
        home = self.channel.root / "versions/5.0.0-next.1/native-home"
        retained = home.with_name("saved-native-home")
        home.rename(retained)
        home.symlink_to(retained)
        with self.assertRaises(installer.Refusal):
            with self.channel.lock():
                self.fail("Aliased home accepted")
        home.unlink()
        retained.rename(home)
        receipt = self.channel.root / "versions/5.0.0-next.1/.receipt.json"
        receipt.write_text("{}")
        with self.assertRaisesRegex(installer.Refusal, "receipt changed"):
            with self.channel.lock():
                self.fail("Malformed receipt accepted")

    def test_foreign_root_alias_and_hardlinked_payload_are_refused(self):
        foreign = self.root / "foreign"
        foreign.mkdir(mode=0o700)
        (foreign / "data").write_bytes(b"do not replace")
        with self.assertRaisesRegex(installer.Refusal, "nonempty"):
            installer.Channel(foreign).initialize()
        alias = self.root / "alias"
        alias.symlink_to(self.channel.root)
        with self.assertRaisesRegex(installer.Refusal, "canonical"):
            installer.Channel(alias)
        self.install()
        binary = self.channel.root / "versions/5.0.0-next.1/bundle/hack-cli"
        os.link(binary, self.root / "hardlink")
        with self.assertRaisesRegex(installer.Refusal, "Hard-linked"):
            with self.channel.lock():
                self.fail("Hard-linked payload accepted")

    def test_manager_and_selected_receipt_changes_refuse_status(self):
        self.install()
        manager = self.channel.root / "manager.py"
        before = manager.read_bytes()
        manager.write_bytes(before + b"# changed\n")
        with self.assertRaisesRegex(installer.Refusal, "manager or launcher changed"):
            with self.channel.lock():
                self.fail("Changed manager accepted")
        manager.write_bytes(before)
        selection = self.selection()
        selection["selected"] = "5.0.0-next.999"
        (self.channel.root / ".selection.json").write_bytes(installer.json_bytes(selection))
        with self.assertRaisesRegex(installer.Refusal, "Unknown selected"):
            with self.channel.lock():
                self.fail("Unknown selection accepted")

    def test_launcher_pins_private_homes_arguments_exit_code_and_allows_peer_launchers(self):
        self.install()
        child = mock.Mock()
        child.wait.return_value = 23
        with self.channel.lock(shared=True):
            with self.channel.lock(shared=True):
                with mock.patch.object(installer.subprocess, "Popen", return_value=child) as spawn:
                    self.assertEqual(self.channel.run(["ps", "--path", "a path"]), 23)
                command = spawn.call_args.args[0]
                self.assertEqual(command[1:], ["ps", "--path", "a path"])
                environment = spawn.call_args.kwargs["env"]
                self.assertEqual(environment["HACK_HOME"], str(self.channel.root / "versions/5.0.0-next.1/cli-home"))
                self.assertEqual(environment["HACK_NATIVE_HOME"], str(self.channel.root / "versions/5.0.0-next.1/native-home"))
                self.assertEqual(environment["HACK_NATIVE_BINARY"], str(self.channel.root / "versions/5.0.0-next.1/bundle/hack-native"))
                self.assertEqual(environment["HACK_RUNTIME_BACKEND"], "native")
                for name in ("HACK_NATIVE_ADAPTATION", "HACK_NATIVE_DEPENDENCIES", "HACK_NATIVE_AWS_PROFILE",
                             "HACK_NATIVE_HTTPS_PORT", "HACK_NATIVE_SHARED_SOURCE"):
                    self.assertEqual(environment[name], os.environ[name])
                self.assertNotIn("HACK_GLOBAL_CONFIG_PATH", environment)
            with self.assertRaisesRegex(installer.Refusal, "active"):
                with self.channel.lock():
                    self.fail("Selection switch raced active launcher")
        child.wait.return_value = -15
        with self.channel.lock(shared=True), mock.patch.object(installer.subprocess, "Popen", return_value=child):
            self.assertEqual(self.channel.run(["ps"]), 143)

    def test_host_and_local_archive_cli_contract(self):
        for system, machine in (("Linux", "aarch64"), ("Darwin", "x86_64")):
            with mock.patch.object(installer.platform, "system", return_value=system), \
                 mock.patch.object(installer.platform, "machine", return_value=machine):
                with self.assertRaisesRegex(installer.Refusal, "Apple Silicon"):
                    installer.main(["--root", str(self.root / "not-created"), "install", "--version", "5.0.0-next.1"])
                self.assertFalse((self.root / "not-created").exists())
        with mock.patch.object(installer.platform, "system", return_value="Darwin"), \
             mock.patch.object(installer.platform, "machine", return_value="arm64"):
            with self.assertRaisesRegex(installer.Refusal, "supplied together"):
                installer.main(["--root", str(self.root / "not-created"), "install", "--version", "5.0.0-next.1",
                                "--archive", str(self.root / "archive")])

    def test_only_pinned_official_github_prerelease_assets_are_downloaded(self):
        version = "5.0.0-next.2"
        tag = "v" + version
        archive_name = "hack-" + version + "-darwin-arm64-native.tar.gz"
        archive, checksum = self.archive(version)
        identity = {"schema": "hack.prerelease/v1", "version": version, "tag": tag,
                    "source_revision": "a" * 40, "platform": "darwin-arm64"}
        base = "https://github.com/hack-dance/hack/releases/download/" + tag + "/"
        release = {"tag_name": tag, "prerelease": True, "draft": False,
                   "assets": [{"name": name, "browser_download_url": base + name}
                              for name in (archive_name, "prerelease.json", "SHA256SUMS")]}
        downloaded = []
        def fetch(url, path, limit):
            downloaded.append(url)
            if "/git/ref/tags/" in url:
                content = json.dumps({"ref": "refs/tags/" + tag,
                                      "object": {"type": "commit", "sha": identity["source_revision"]}}).encode()
            elif "api.github.com" in url:
                content = json.dumps(release).encode()
            elif url.endswith("prerelease.json"):
                content = json.dumps(identity).encode()
            elif url.endswith("SHA256SUMS"):
                content = (checksum + "  " + archive_name + "\n").encode()
            else:
                content = archive.read_bytes()
            installer.write_file(path, content)
        with mock.patch.object(installer, "download", side_effect=fetch):
            with self.channel.lock():
                self.channel.install(version)
        self.assertEqual(downloaded[0], "https://api.github.com/repos/hack-dance/hack/releases/tags/" + tag)
        self.assertIn("https://api.github.com/repos/hack-dance/hack/git/ref/tags/" + tag, downloaded)
        self.assertEqual(self.selection()["selected"], version)
        self.assertEqual(len(downloaded), 5)
        for url in ("http://github.com/hack-dance/hack/x", "https://example.com/x",
                    "https://github.com.evil.test/x", "https://user@github.com/x", "file:///tmp/x"):
            with self.assertRaises(installer.Refusal):
                installer.secure_url(url)

    def test_official_redirect_factory_accepts_assets_and_refuses_foreign_targets(self):
        import urllib.request

        origin = "https://github.com/hack-dance/hack/releases/download/v5.0.0-next.1/artifact"
        request = urllib.request.Request(origin)
        handler = installer.official_redirect_handler()
        self.assertIsInstance(handler, urllib.request.HTTPRedirectHandler)
        assets = "https://release-assets.githubusercontent.com/github-production-release-asset/fixture"
        redirected = handler.redirect_request(request, None, 302, "Found", {}, assets)
        self.assertEqual(redirected.full_url, assets)
        for url in ("http://release-assets.githubusercontent.com/fixture", "https://example.com/fixture",
                    "https://github.com.evil.test/fixture", "https://user:password@github.com/fixture",
                    "https://github.com:444/fixture", "https://github.com/fixture#fragment"):
            with self.subTest(url=url), self.assertRaisesRegex(installer.Refusal, "nonofficial"):
                handler.redirect_request(request, None, 302, "Found", {}, url)

    def test_download_uses_restricted_handler_and_writes_owned_exclusive_output(self):
        import urllib.request

        origin = "https://github.com/hack-dance/hack/releases/download/v5.0.0-next.1/artifact"
        target = self.root / "official-download"
        response = mock.MagicMock()
        response.__enter__.return_value = response
        response.geturl.return_value = "https://release-assets.githubusercontent.com/fixture"
        response.read.side_effect = [b"verified transport fixture", b""]
        opener = mock.Mock()
        opener.open.return_value = response
        with mock.patch.object(urllib.request, "build_opener", return_value=opener) as build:
            installer.download(origin, target, 128)
        build.assert_called_once()
        self.assertEqual(len(build.call_args.args), 1)
        handler = build.call_args.args[0]
        self.assertIsInstance(handler, urllib.request.HTTPRedirectHandler)
        with self.assertRaises(installer.Refusal):
            handler.redirect_request(urllib.request.Request(origin), None, 302, "Found", {},
                                     "https://example.com/fixture")
        opener.open.assert_called_once()
        self.assertEqual(opener.open.call_args.args[0].full_url, origin)
        self.assertEqual(opener.open.call_args.kwargs, {"timeout": 30})
        self.assertEqual(target.read_bytes(), b"verified transport fixture")
        self.assertEqual(target.stat().st_mode & 0o777, 0o600)
        with mock.patch.object(urllib.request, "build_opener", return_value=opener):
            with self.assertRaises(FileExistsError):
                installer.download(origin, target, 128)
        self.assertEqual(target.read_bytes(), b"verified transport fixture")

    def test_download_refuses_final_foreign_url_before_target_creation_or_read(self):
        import urllib.request

        response = mock.MagicMock()
        response.__enter__.return_value = response
        response.geturl.return_value = "https://example.com/fixture"
        opener = mock.Mock()
        opener.open.return_value = response
        target = self.root / "refused-download"
        with mock.patch.object(urllib.request, "build_opener", return_value=opener) as build:
            with self.assertRaisesRegex(installer.Refusal, "nonofficial"):
                installer.download("https://github.com/hack-dance/hack/fixture", target, 128)
        build.assert_called_once()
        opener.open.assert_called_once()
        response.read.assert_not_called()
        self.assertFalse(target.exists())

    def test_moved_annotated_foreign_and_malformed_tags_never_activate(self):
        self.install()
        version = "5.0.0-next.2"
        tag = "v" + version
        archive_name = "hack-" + version + "-darwin-arm64-native.tar.gz"
        identity = {"schema": "hack.prerelease/v1", "version": version, "tag": tag,
                    "source_revision": "a" * 40, "platform": "darwin-arm64"}
        base = "https://github.com/hack-dance/hack/releases/download/" + tag + "/"
        release = {"tag_name": tag, "prerelease": True, "draft": False,
                   "assets": [{"name": name, "browser_download_url": base + name}
                              for name in (archive_name, "prerelease.json", "SHA256SUMS")]}
        valid = {"ref": "refs/tags/" + tag, "object": {"type": "commit", "sha": "a" * 40}}
        references = [dict(valid, object={"type": "commit", "sha": "b" * 40}),
                      dict(valid, ref="refs/tags/v5.0.0-next.99"),
                      dict(valid, object={"type": "tag", "sha": "a" * 40}),
                      dict(valid, object={"type": "commit", "sha": "short"}),
                      dict(valid, object={"sha": "a" * 40}), dict(valid, object=None),
                      {"ref": "refs/tags/" + tag}, {}]
        before = (self.channel.root / ".selection.json").read_bytes()
        for reference in references:
            with self.subTest(reference=reference):
                downloaded = []
                def fetch(url, path, _limit):
                    downloaded.append(url)
                    if "/git/ref/tags/" in url:
                        content = reference
                    elif "api.github.com" in url:
                        content = release
                    elif url.endswith("prerelease.json"):
                        content = identity
                    else:
                        self.fail("Artifact download started before tag provenance passed")
                    installer.write_file(path, json.dumps(content).encode())
                with mock.patch.object(installer, "download", side_effect=fetch):
                    with self.channel.lock():
                        with self.assertRaisesRegex(installer.Refusal, "tag does not match"):
                            self.channel.install(version, upgrade=True)
                self.assertEqual(len(downloaded), 3)
                self.assertFalse((self.channel.root / "versions" / version).exists())
                self.assertEqual((self.channel.root / ".selection.json").read_bytes(), before)

    def test_draft_stable_missing_duplicate_and_foreign_release_assets_refuse(self):
        version = "5.0.0-next.1"
        tag = "v" + version
        names = ("hack-" + version + "-darwin-arm64-native.tar.gz", "prerelease.json", "SHA256SUMS")
        base = "https://github.com/hack-dance/hack/releases/download/" + tag + "/"
        valid = {"tag_name": tag, "prerelease": True, "draft": False,
                 "assets": [{"name": name, "browser_download_url": base + name} for name in names]}
        cases = [dict(valid, draft=True), dict(valid, prerelease=False), dict(valid, tag_name="latest"),
                 dict(valid, assets=valid["assets"][:-1]),
                 dict(valid, assets=valid["assets"] + [valid["assets"][0]]),
                 dict(valid, assets=[dict(valid["assets"][0], browser_download_url="https://example.com/a"),
                                     *valid["assets"][1:]])]
        for index, release in enumerate(cases):
            with self.subTest(index=index):
                stage = self.root / ("download-" + str(index))
                stage.mkdir(mode=0o700)
                def fetch(_url, path, _limit):
                    installer.write_file(path, json.dumps(release).encode())
                with mock.patch.object(installer, "download", side_effect=fetch) as download:
                    with self.assertRaises(installer.Refusal):
                        installer.official_archive(stage, version)
                self.assertEqual(download.call_count, 1)


if __name__ == "__main__":
    unittest.main()
