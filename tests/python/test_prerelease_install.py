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


# Smallest Linux ARM64 ELF header the runtime's byte contract accepts (e_machine 183).
STORAGE_TOOL_BYTES = b"\x7fELF\x02\x01\x01" + bytes(11) + (183).to_bytes(2, "little") + bytes(44)


def with_storage_tool(entries, change=None):
    """Add the witness and a manifest bound to its bytes and the archive's provenance."""
    payload = {name: value for name, value, _ in entries if name != "SHA256SUMS"}
    tool = STORAGE_TOOL_BYTES
    manifest = {"version": 1, "kind": "native-storage-root-witness", "platform": "linux",
                "architecture": "arm64", "file": installer.STORAGE_TOOL, "sha256": sha(tool),
                "bytes": len(tool),
                "sourceRevision": json.loads(payload["prerelease.json"])["source_revision"]}
    if change:
        tool, manifest = change(tool, manifest)
    payload[installer.STORAGE_TOOL] = tool
    payload[installer.STORAGE_TOOL_MANIFEST] = (
        manifest if isinstance(manifest, bytes) else (json.dumps(manifest) + "\n").encode())
    payload["SHA256SUMS"] = "".join(sha(value) + "  " + name + "\n"
                                    for name, value in sorted(payload.items())).encode()
    return [(name, value, tarfile.REGTYPE) for name, value in payload.items()]


def with_current_payload(entries):
    """The complete layout scripts/build-native-candidate.sh produces for a versioned build."""
    return with_storage_tool(with_mcp(with_compiler(entries)))


# A hypothetical reviewed top-level bundle file. Tests patch it into the installer's
# allowlist to stand in for the next reviewed installer that ships a new file.
EXTENSION = "hack-reviewed-extension.json"
EXTENSION_BYTES = b'{"reviewed": true}\n'


def with_extended_payload(entries):
    """The current 17-member layout plus one reviewed addition: 18 archive members."""
    payload = {name: value for name, value, _ in entries if name != "SHA256SUMS"}
    payload[EXTENSION] = EXTENSION_BYTES
    # with_current_payload recomputes SHA256SUMS over every member, including this one.
    return with_current_payload([(name, value, tarfile.REGTYPE) for name, value in payload.items()])


def reviewed_extension():
    """Admit EXTENSION as a required core file, as a later reviewed installer would."""
    stack = contextlib.ExitStack()
    stack.enter_context(mock.patch.object(installer, "PAYLOAD", installer.PAYLOAD | {EXTENSION}))
    stack.enter_context(mock.patch.object(installer, "BUNDLE_FILES",
                                          installer.BUNDLE_FILES | {EXTENSION}))
    return stack


def archive_members(archive):
    with tarfile.open(archive, "r:gz") as source:
        return [entry.name for entry in source]


class OfficialResponse:
    """One HTTP response read through the installer's real download loop.

    `declared` is the Content-Length header. `step` bounds each read so a `fault`
    can interrupt the stream after the first bytes were delivered.
    """

    def __init__(self, url, body, declared=None, step=None, fault=None):
        self.url = url
        self.body = body
        self.headers = {} if declared is None else {"Content-Length": str(declared)}
        self.step = step
        self.fault = fault
        self.offset = 0

    def __enter__(self):
        return self

    def __exit__(self, *_error):
        return False

    def geturl(self):
        return self.url

    def read(self, amount):
        if self.fault is not None and self.offset:
            raise self.fault
        amount = min(amount, self.step or amount)
        chunk = self.body[self.offset:self.offset + amount]
        self.offset += len(chunk)
        return chunk


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
        # A manually exported native selection naming a foreign executor and home:
        # the launcher must still pin its own. Backend selection has its own tests.
        self.env_patch = mock.patch.dict(os.environ, {
            "HOME": str(self.stable_home), "HACK_HOME": str(self.stable_home / ".hack"),
            "HACK_GLOBAL_CONFIG_PATH": str(self.stable_home / ".hack/config.json"),
            "HACK_NATIVE_HOME": str(self.stable_home / "foreign-native"),
            "HACK_NATIVE_BINARY": str(self.brew / "hack"), "HACK_RUNTIME_BACKEND": "native",
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
        signed = {Path(path).name for arguments, _ in self.calls
                  if arguments[0] == "/usr/bin/codesign" for path in arguments[3:]}
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
        signed = {Path(path).name for arguments, _ in self.calls
                  if arguments[0] == "/usr/bin/codesign" for path in arguments[3:]}
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
            if arguments[0] == "/usr/bin/codesign" and any(
                    Path(path).name == "hack-config-compiler" for path in arguments[3:]):
                return subprocess.CompletedProcess(arguments, 1)
            return original(arguments, **options)
        with mock.patch.object(installer.subprocess, "run", side_effect=fail_compiler):
            with self.channel.lock():
                with self.assertRaisesRegex(installer.Refusal, "Candidate code signature failed"):
                    self.channel.install("5.0.0-next.2", archive, checksum, True)
        self.assertEqual(self.selection(), before)

    def test_signature_batch_covers_all_executable_assets_in_one_strict_call(self):
        archive, checksum = self.archive(mutate=with_current_payload)
        with self.channel.lock():
            self.channel.install("5.0.0-next.1", archive, checksum)
        bundle = self.channel.root / "versions/5.0.0-next.1/bundle"
        self.calls.clear()
        installer.verify_signatures(bundle)
        self.assertEqual(len(self.calls), 1)
        arguments, options = self.calls[0]
        self.assertEqual(arguments[:3], ["/usr/bin/codesign", "--verify", "--strict"])
        paths = [Path(path) for path in arguments[3:]]
        self.assertEqual([path.name for path in paths], [
            "hack-native", "hack-cli", "hack-config-compiler",
            "hack-mcp-adapter", "hack-mcp-backend", "hack-mcp-owner"])
        self.assertEqual(len(set(paths)), 6)
        self.assertTrue(all(path.is_relative_to(bundle) for path in paths))
        self.assertEqual(options, {"stdin": subprocess.DEVNULL, "stdout": subprocess.DEVNULL,
                                   "stderr": subprocess.DEVNULL, "timeout": 30, "check": False})

    def test_signature_batch_failures_preserve_selection_and_refuse_before_spawn(self):
        archive, checksum = self.archive(mutate=lambda entries: with_mcp(with_compiler(entries)))
        with self.channel.lock():
            self.channel.install("5.0.0-next.1", archive, checksum)
        before = self.retained_snapshot()
        cases = ("hack-native", "hack-mcp-adapter", "hack-mcp-owner", "timeout", "os-error")
        for case in cases:
            with self.subTest(failure=case):
                calls = []
                def fail_signature(arguments, **options):
                    self.assertEqual(arguments[:3], ["/usr/bin/codesign", "--verify", "--strict"])
                    calls.append((arguments, options))
                    if case == "timeout":
                        raise subprocess.TimeoutExpired(arguments, 30, stderr=b"private-signature-sentinel")
                    if case == "os-error":
                        raise OSError("private-signature-sentinel")
                    failed = any(Path(path).name == case for path in arguments[3:])
                    return subprocess.CompletedProcess(arguments, int(failed),
                                                       stderr=b"private-signature-sentinel")
                child = mock.Mock()
                child.wait.return_value = 0
                current = installer.Channel(self.channel.root)
                with mock.patch.object(installer.subprocess, "run", side_effect=fail_signature), \
                        mock.patch.object(installer.subprocess, "Popen", return_value=child) as spawn:
                    with self.assertRaises(installer.Refusal) as refusal:
                        with current.lock(shared=True):
                            current.run(["--version"])
                    message = ("Cannot verify candidate code signature." if case in ("timeout", "os-error")
                               else "Candidate code signature failed.")
                    self.assertEqual(str(refusal.exception), message)
                    spawn.assert_not_called()
                self.assertEqual(len(calls), 1)
                self.assertEqual(self.retained_snapshot(), before)

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

    def test_storage_tool_pair_installs_with_runtime_modes_beside_older_layouts(self):
        self.install()
        for version, mutate in (("5.0.0-next.2", with_storage_tool), ("5.0.0-next.3", with_current_payload)):
            archive, checksum = self.archive(version, mutate)
            self.calls.clear()
            with self.channel.lock():
                self.channel.install(version, archive, checksum, True)
            bundle = self.channel.root / "versions" / version / "bundle"
            _, manifest = installer.verify_bundle(bundle, version)
            self.assertEqual(set(manifest) & installer.STORAGE_TOOL_PAYLOAD, installer.STORAGE_TOOL_PAYLOAD)
            # Runtime admission resolves both as owned siblings of hack-native in a 0700 directory.
            self.assertEqual(bundle.stat().st_mode & 0o777, 0o700)
            self.assertEqual((bundle / "hack-native").stat().st_mode & 0o777, 0o755)
            self.assertEqual((bundle / installer.STORAGE_TOOL).stat().st_mode & 0o777, 0o500)
            self.assertEqual((bundle / installer.STORAGE_TOOL_MANIFEST).stat().st_mode & 0o777, 0o600)
            self.assertEqual((bundle / installer.STORAGE_TOOL).read_bytes(), STORAGE_TOOL_BYTES)
            signed = {Path(path).name for arguments, _ in self.calls
                      if arguments[0] == "/usr/bin/codesign" for path in arguments[3:]}
            self.assertIn("hack-native", signed)
            self.assertFalse(signed & installer.STORAGE_TOOL_PAYLOAD)
        for prior in ("5.0.0-next.1", "5.0.0-next.2", "5.0.0-next.3"):
            with self.channel.lock():
                self.channel.select(prior)
            self.assertEqual(self.selection()["selected"], prior)

    def test_incomplete_and_unbound_storage_tool_refuses_despite_matching_checksums(self):
        def drop(name):
            def mutate(entries):
                payload = {key: value for key, value, _ in with_storage_tool(entries)
                           if key not in (name, "SHA256SUMS")}
                payload["SHA256SUMS"] = "".join(sha(value) + "  " + key + "\n"
                                                for key, value in sorted(payload.items())).encode()
                return [(key, value, tarfile.REGTYPE) for key, value in payload.items()]
            return mutate

        def manifest_change(field, value):
            return lambda entries: with_storage_tool(
                entries, lambda tool, manifest: (tool, dict(manifest, **{field: value})))

        def tool_change(tool, manifest):
            return bytes([tool[0] ^ 1]) + tool[1:], manifest

        def raw(text):
            return lambda entries: with_storage_tool(entries, lambda tool, _manifest: (tool, text))

        cases = [
            (drop(installer.STORAGE_TOOL), "Incomplete storage tool payload"),
            (drop(installer.STORAGE_TOOL_MANIFEST), "Incomplete storage tool payload"),
            (lambda entries: with_storage_tool(entries, tool_change), "Storage tool fingerprint mismatch"),
            (manifest_change("sha256", sha(b"other")), "Storage tool fingerprint mismatch"),
            (manifest_change("bytes", len(STORAGE_TOOL_BYTES) + 1), "Storage tool fingerprint mismatch"),
            (manifest_change("bytes", float(len(STORAGE_TOOL_BYTES))), "Storage tool fingerprint mismatch"),
            (manifest_change("sourceRevision", "b" * 40), "Storage tool source revision mismatch"),
            (manifest_change("kind", "native-storage-other"), "Incompatible storage tool manifest"),
            (manifest_change("architecture", "x64"), "Incompatible storage tool manifest"),
            (manifest_change("file", "hack-relay-guest"), "Incompatible storage tool manifest"),
            (manifest_change("version", True), "Incompatible storage tool manifest"),
            (manifest_change("extra", "field"), "Invalid storage tool manifest fields"),
            (raw(b'{"version":1,"version":1}'), "Duplicate JSON field"),
            (raw(b"not json"), "Malformed JSON"),
            (raw(b" " * 4097), "Oversized storage tool manifest"),
            (lambda entries: [*with_storage_tool(entries),
                              (installer.STORAGE_TOOL + ".sig", b"foreign", tarfile.REGTYPE)],
             "Foreign, duplicate or traversing archive entry"),
        ]
        for mutate, message in cases:
            with self.subTest(message=message, mutate=mutate):
                self.rejects_install(mutate, message)

    def test_partial_tampered_and_aliased_storage_tool_archives_preserve_selection(self):
        for name in sorted(installer.STORAGE_TOOL_PAYLOAD):
            for case in ("missing", "tampered", tarfile.SYMTYPE, tarfile.LNKTYPE):
                with self.subTest(name=name, case=case):
                    def mutate(entries):
                        return [(key, b"changed" if case == "tampered" and key == name else value,
                                 case if case in (tarfile.SYMTYPE, tarfile.LNKTYPE) and key == name else kind)
                                for key, value, kind in with_current_payload(entries)
                                if not (case == "missing" and key == name)]
                    self.rejects_install(mutate, "storage tool payload|checksum mismatch|regular archive files")

    def test_installed_storage_tool_tampering_and_modes_are_refused(self):
        archive, checksum = self.archive(mutate=with_current_payload)
        with self.channel.lock():
            self.channel.install("5.0.0-next.1", archive, checksum)
        bundle = self.channel.root / "versions/5.0.0-next.1/bundle"
        for name in sorted(installer.STORAGE_TOOL_PAYLOAD):
            path = bundle / name
            before = path.read_bytes()
            mode = path.stat().st_mode & 0o777
            for case in ("bytes", "mode", "executable", "hardlink", "symlink"):
                with self.subTest(name=name, case=case):
                    alias = self.root / "storage-alias"
                    if case == "bytes":
                        path.chmod(0o600)
                        path.write_bytes(bytes([before[0] ^ 1]) + before[1:])
                        path.chmod(mode)
                    elif case == "mode":
                        path.chmod(0o755)
                    elif case == "executable":
                        path.chmod(0o600 if name == installer.STORAGE_TOOL else 0o700)
                    elif case == "hardlink":
                        os.link(path, alias)
                    else:
                        path.rename(alias)
                        path.symlink_to(alias)
                    with self.assertRaises(installer.Refusal):
                        installer.verify_bundle(bundle, "5.0.0-next.1")
                    with mock.patch.object(installer.subprocess, "Popen") as spawn:
                        with self.assertRaises(installer.Refusal):
                            with self.channel.lock(shared=True):
                                self.channel.run(["--version"])
                        spawn.assert_not_called()
                    if case == "symlink":
                        path.unlink()
                        alias.rename(path)
                    elif case == "hardlink":
                        alias.unlink()
                    else:
                        path.chmod(0o600)
                        path.write_bytes(before)
                        path.chmod(mode)
                    installer.verify_bundle(bundle, "5.0.0-next.1")

    def test_released_and_reviewed_managers_upgrade_before_accepting_storage_tool(self):
        # The 5.0.0-next.2 tag shipped mcp-v2; batch-v4 is the last reviewed manager on next.
        fixtures = (("prerelease-manager-mcp-v2.py",
                     "ca432b7fc6562bb091d17d3217f5d1daf9f91621a6919c8964ca51bee2111d0c", with_mcp),
                    ("prerelease-manager-batch-v4.py",
                     "c7562953361b6b37141e126df31edefabc05e4441e3c6e0a38b1c3cda6b645da",
                     lambda entries: with_mcp(with_compiler(entries))))
        for name, predecessor, prior_layout in fixtures:
            with self.subTest(manager=name):
                source = SOURCE.parent.parent / "tests/fixtures" / name
                self.assertEqual(installer.digest(source), predecessor)
                self.assertIn(predecessor, installer.MANAGER_PREDECESSORS)
                spec = importlib.util.spec_from_file_location("storage_predecessor_" + name[19:-3], source)
                previous = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(previous)
                self.channel = previous.Channel(self.root / ("storage-" + name[:-3]))
                self.channel.initialize()
                self.install()
                archive, checksum = self.archive("5.0.0-next.2", prior_layout)
                with self.channel.lock():
                    self.channel.install("5.0.0-next.2", archive, checksum, True)
                for version in ("5.0.0-next.1", "5.0.0-next.2"):
                    for home in ("native-home", "cli-home"):
                        (self.channel.root / "versions" / version / home / "marker").write_text(version + home)
                before = self.retained_snapshot()
                archive, checksum = self.archive("5.0.0-next.3", with_current_payload)
                # The retained manager cannot validate the new layout, so it must never select it.
                with self.channel.lock():
                    with self.assertRaisesRegex(previous.Refusal, "Foreign"):
                        self.channel.install("5.0.0-next.3", archive, checksum, True)
                self.assertEqual(self.retained_snapshot(), before)
                current = installer.Channel(self.channel.root)
                with current.lock():
                    with self.assertRaisesRegex(installer.Refusal, "upgrade-manager"):
                        current.install("5.0.0-next.3", archive, checksum, True)
                self.assertEqual(self.retained_snapshot(), before)
                self.channel = self.upgrade_manager()
                self.assertEqual(self.retained_snapshot(), before)
                self.assertEqual((self.channel.root / "manager.py").read_bytes(), SOURCE.read_bytes())
                with self.channel.lock():
                    self.channel.install("5.0.0-next.3", archive, checksum, True)
                bundle = self.channel.root / "versions/5.0.0-next.3/bundle"
                self.assertEqual((bundle / installer.STORAGE_TOOL).stat().st_mode & 0o777, 0o500)
                self.assertEqual((bundle / installer.STORAGE_TOOL_MANIFEST).stat().st_mode & 0o777, 0o600)
                for prior in ("5.0.0-next.2", "5.0.0-next.1", "5.0.0-next.3"):
                    with self.channel.lock():
                        self.channel.select(prior)
                    self.assertEqual(self.selection()["selected"], prior)
                child = mock.Mock()
                child.wait.return_value = 0
                with self.channel.lock(shared=True), \
                        mock.patch.object(installer.subprocess, "Popen", return_value=child) as spawn:
                    self.assertEqual(self.channel.run(["--version"]), 0)
                self.assertEqual(Path(spawn.call_args.args[0][0]), bundle / "hack-v5")
                self.assertEqual(spawn.call_args.kwargs["env"]["HACK_NATIVE_BINARY"], str(bundle / "hack-native"))
                for version in ("5.0.0-next.1", "5.0.0-next.2"):
                    for home in ("native-home", "cli-home"):
                        self.assertEqual((self.channel.root / "versions" / version / home / "marker").read_text(),
                                         version + home)

    def test_member_ceiling_is_fixed_above_the_largest_reviewed_inventory(self):
        archive, _ = self.archive(mutate=with_current_payload)
        reviewed = len(installer.BUNDLE_FILES | installer.COMPILER_PAYLOAD
                       | installer.STORAGE_TOOL_PAYLOAD) + len(installer.MCP_FILES) + 1
        self.assertEqual(len(archive_members(archive)), reviewed)
        self.assertGreater(installer.MAX_ARCHIVE_MEMBERS, reviewed)
        with reviewed_extension():
            # The bound no longer follows the allowlist sizes; growing them leaves it unchanged.
            self.assertEqual(installer.MAX_ARCHIVE_MEMBERS, 64)

    def test_reviewed_addition_beyond_seventeen_members_installs_and_rolls_back(self):
        with reviewed_extension():
            for number in (1, 2):
                version = "5.0.0-next." + str(number)
                archive, checksum = self.archive(version, with_extended_payload)
                self.assertEqual(len(archive_members(archive)), 18)
                with self.channel.lock():
                    self.channel.install(version, archive, checksum, number == 2)
                bundle = self.channel.root / "versions" / version / "bundle"
                _, manifest = installer.verify_bundle(bundle, version)
                self.assertEqual(len(manifest), 17)
                self.assertIn(EXTENSION, manifest)
                self.assertEqual((bundle / EXTENSION).read_bytes(), EXTENSION_BYTES)
                self.assertEqual((bundle / EXTENSION).stat().st_mode & 0o777, 0o600)
                self.assertEqual((bundle / installer.STORAGE_TOOL).stat().st_mode & 0o777, 0o500)
            for prior in ("5.0.0-next.1", "5.0.0-next.2"):
                with self.channel.lock():
                    self.channel.select(prior)
                self.assertEqual(self.selection()["selected"], prior)

    def test_member_ceiling_refuses_excess_headers_before_inventory(self):
        # MCP members are the only digest-wildcard names, so distinct identities are
        # allowlisted one by one. The ceiling bounds them; the inventory refuses below it.
        def mcp_identities(count):
            return lambda entries: [*entries, *(("mcp/%064x/manifest.json" % index, b"{}\n",
                                                 tarfile.REGTYPE) for index in range(count))]
        flat = 8
        self.rejects_install(mcp_identities(installer.MAX_ARCHIVE_MEMBERS - flat + 1),
                             r"\AToo many archive entries\.\Z")
        self.rejects_install(mcp_identities(installer.MAX_ARCHIVE_MEMBERS - flat),
                             "one MCP bundle identity")

    def test_larger_reviewed_inventory_keeps_member_refusals(self):
        with reviewed_extension():
            archive, checksum = self.archive(mutate=with_extended_payload)
            with self.channel.lock():
                self.channel.install("5.0.0-next.1", archive, checksum)

            def extended(change):
                return lambda entries: change(with_extended_payload(entries))

            def replace(name=None, value=None, kind=None):
                return extended(lambda entries: [
                    (name if name and key == EXTENSION else key,
                     value if value is not None and key == EXTENSION else data,
                     kind if kind is not None and key == EXTENSION else entry_kind)
                    for key, data, entry_kind in entries])

            foreign = "Foreign, duplicate or traversing archive entry"
            cases = [
                (extended(lambda entries: [*entries, next(entry for entry in entries
                                                          if entry[0] == EXTENSION)]), foreign),
                (replace(name="../" + EXTENSION), foreign),
                (replace(name="/tmp/" + EXTENSION), foreign),
                (replace(name="bundle/" + EXTENSION), foreign),
                (replace(name="hack-unreviewed-extension.json"), foreign),
                (replace(kind=tarfile.SYMTYPE), "regular archive files"),
                (replace(kind=tarfile.LNKTYPE), "regular archive files"),
                (replace(value=b'{"reviewed": false}\n'), "checksum mismatch"),
                (extended(lambda entries: [entry for entry in entries if entry[0] != EXTENSION]),
                 "Incomplete candidate bundle"),
            ]
            for mutate, message in cases:
                with self.subTest(message=message, mutate=mutate):
                    self.rejects_install(mutate, message)
            limit = 4096
            with mock.patch.object(installer, "MAX_ARCHIVE", limit):
                for mutate, message in (
                        (replace(value=bytes(limit + 1)), "Only bounded regular archive files"),
                        (extended(lambda entries: [
                            (key, bytes(limit // 2) if key in (EXTENSION, "hack-cli") else value, kind)
                            for key, value, kind in entries]), "Oversized archive")):
                    with self.subTest(message=message):
                        archive, _ = self.archive("5.0.0-next.2", mutate)
                        self.assertLessEqual(archive.stat().st_size, limit)
                        self.rejects_install(mutate, message)

    def test_released_storage_manager_upgrades_before_accepting_new_installer_payloads(self):
        # 5.0.0-next.3, next.4 and next.5 all shipped this manager byte for byte.
        source = SOURCE.parent.parent / "tests/fixtures/prerelease-manager-storage-v5.py"
        predecessor = "e2e2bcbacf58b21d1086047c94727e5e814776384439700adcf5aabe5c49c2fa"
        self.assertEqual(installer.digest(source), predecessor)
        self.assertIn(predecessor, installer.MANAGER_PREDECESSORS)
        spec = importlib.util.spec_from_file_location("storage_prerelease_manager", source)
        previous = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(previous)
        self.channel = previous.Channel(self.root / "storage-v5-channel")
        self.channel.initialize()
        self.install()
        for version in ("5.0.0-next.4", "5.0.0-next.5"):
            archive, checksum = self.archive(version, with_current_payload)
            with self.channel.lock():
                self.channel.install(version, archive, checksum, True)
        for version in ("5.0.0-next.1", "5.0.0-next.4", "5.0.0-next.5"):
            for home in ("native-home", "cli-home"):
                (self.channel.root / "versions" / version / home / "marker").write_text(version + home)
        before = self.retained_snapshot()
        # The retained manager filled its derived 17-member bound and knows no new name,
        # so it refuses a larger layout instead of selecting files it cannot verify.
        larger, larger_checksum = self.archive("5.0.0-next.6", with_extended_payload)
        self.assertEqual(len(archive_members(larger)), 18)
        with self.channel.lock():
            with self.assertRaisesRegex(previous.Refusal, "archive entr"):
                self.channel.install("5.0.0-next.6", larger, larger_checksum, True)
        self.assertEqual(self.retained_snapshot(), before)
        archive, checksum = self.archive("5.0.0-next.6", with_current_payload)
        current = installer.Channel(self.channel.root)
        with current.lock():
            with self.assertRaisesRegex(installer.Refusal, "upgrade-manager"):
                current.install("5.0.0-next.6", archive, checksum, True)
        self.assertEqual(self.retained_snapshot(), before)
        self.channel = self.upgrade_manager()
        self.assertEqual(self.retained_snapshot(), before)
        self.assertEqual((self.channel.root / "manager.py").read_bytes(), SOURCE.read_bytes())
        with self.channel.lock():
            self.assertEqual(self.channel.state["selected"], "5.0.0-next.5")
            self.channel.install("5.0.0-next.6", archive, checksum, True)
        for prior in ("5.0.0-next.5", "5.0.0-next.1", "5.0.0-next.4", "5.0.0-next.6"):
            with self.channel.lock():
                self.channel.select(prior)
            self.assertEqual(self.selection()["selected"], prior)
        bundle = self.channel.root / "versions/5.0.0-next.6/bundle"
        child = mock.Mock()
        child.wait.return_value = 0
        with self.channel.lock(shared=True), \
                mock.patch.object(installer.subprocess, "Popen", return_value=child) as spawn:
            self.assertEqual(self.channel.run(["--version"]), 0)
        self.assertEqual(Path(spawn.call_args.args[0][0]), bundle / "hack-v5")
        for version in ("5.0.0-next.1", "5.0.0-next.4", "5.0.0-next.5"):
            for home in ("native-home", "cli-home"):
                self.assertEqual((self.channel.root / "versions" / version / home / "marker").read_text(),
                                 version + home)
        # Repeating the upgrade with the installed manager is a no-op.
        self.upgrade_manager()
        self.assertEqual((self.channel.root / "manager.py").read_bytes(), SOURCE.read_bytes())

    def test_bundle_verification_hashes_each_payload_once_without_cross_call_cache(self):
        archive, checksum = self.archive(mutate=with_current_payload)
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
            if arguments[0] == "/usr/bin/codesign" and any(
                    ".stage-" in path for path in arguments[3:]):
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
        # No backend selection: the channel default is native with private homes.
        os.environ.pop("HACK_RUNTIME_BACKEND")
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
                self.assertEqual(environment["HACK_CANDIDATE_ENTRYPOINT"], "hack-next")
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

    def launch(self, channel=None):
        """Run the selected candidate through `channel` with a stand-in child process."""
        channel = channel or self.channel
        child = mock.Mock()
        child.wait.return_value = 0
        # Every manager imports the same standard-library subprocess module.
        with channel.lock(shared=True), \
                mock.patch.object(installer.subprocess, "Popen", return_value=child) as spawn:
            self.assertEqual(channel.run(["ps", "--path", "a path"]), 0)
        self.assertEqual(spawn.call_args.args[0][1:], ["ps", "--path", "a path"])
        return Path(spawn.call_args.args[0][0]), spawn.call_args.kwargs["env"]

    def test_launcher_respects_explicit_backend_and_keeps_native_default(self):
        self.install()
        version = self.channel.root / "versions/5.0.0-next.1"
        for selection in (None, "", "native"):
            with self.subTest(backend=selection), mock.patch.dict(os.environ):
                if selection is None:
                    os.environ.pop("HACK_RUNTIME_BACKEND")
                else:
                    os.environ["HACK_RUNTIME_BACKEND"] = selection
                command, environment = self.launch()
                self.assertEqual(command, version / "bundle/hack-v5")
                self.assertEqual(environment["HACK_RUNTIME_BACKEND"], "native")
                self.assertEqual(environment["HACK_NATIVE_BINARY"], str(version / "bundle/hack-native"))
                self.assertEqual(environment["HACK_NATIVE_HOME"], str(version / "native-home"))
                self.assertEqual(environment["HACK_HOME"], str(version / "cli-home"))
                self.assertNotIn("HACK_GLOBAL_CONFIG_PATH", environment)
        with mock.patch.dict(os.environ, {"HACK_RUNTIME_BACKEND": "compose"}):
            command, environment = self.launch()
        # Compose runs the same verified CLI with the caller's own Hack home, so the
        # existing global Caddy/CoreDNS and local CA apply; native selectors are removed.
        self.assertEqual(command, version / "bundle/hack-cli")
        self.assertEqual(environment["HACK_RUNTIME_BACKEND"], "compose")
        self.assertEqual(environment["HACK_CANDIDATE_ENTRYPOINT"], "hack-next")
        self.assertEqual(environment["HACK_HOME"], str(self.stable_home / ".hack"))
        self.assertEqual(environment["HACK_GLOBAL_CONFIG_PATH"], str(self.stable_home / ".hack/config.json"))
        self.assertNotIn("HACK_NATIVE_BINARY", environment)
        self.assertNotIn("HACK_NATIVE_HOME", environment)
        for name in ("HACK_NATIVE_ADAPTATION", "HACK_NATIVE_HTTPS_PORT", "HACK_NATIVE_SHARED_SOURCE"):
            self.assertEqual(environment[name], os.environ[name])
        # Unknown selections refuse before verification or spawn; inherited `docker` is
        # not silently replaced by either backend.
        for selection in ("docker", "Native", "native "):
            with self.subTest(backend=selection), \
                    mock.patch.dict(os.environ, {"HACK_RUNTIME_BACKEND": selection}), \
                    mock.patch.object(installer.subprocess, "Popen") as spawn, \
                    mock.patch.object(installer, "verify_signatures") as signatures:
                with self.channel.lock(shared=True):
                    with self.assertRaisesRegex(installer.Refusal, "must be native or compose"):
                        self.channel.run(["up"])
                spawn.assert_not_called()
                signatures.assert_not_called()

    def test_released_next5_manager_needs_upgrade_manager_for_compose_selection(self):
        source = SOURCE.parent.parent / "tests/fixtures/prerelease-manager-storage-v5.py"
        predecessor = "e2e2bcbacf58b21d1086047c94727e5e814776384439700adcf5aabe5c49c2fa"
        self.assertEqual(installer.digest(source), predecessor)
        self.assertIn(predecessor, installer.MANAGER_PREDECESSORS)
        spec = importlib.util.spec_from_file_location("storage_v5_predecessor", source)
        previous = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(previous)
        self.channel = previous.Channel(self.root / "storage-v5")
        self.channel.initialize()
        archive, checksum = self.archive("5.0.0-next.1", with_current_payload)
        with self.channel.lock():
            self.channel.install("5.0.0-next.1", archive, checksum)
        version = self.channel.root / "versions/5.0.0-next.1"
        for home in ("native-home", "cli-home"):
            (version / home / "marker").write_text(home)
        before = self.retained_snapshot()
        with mock.patch.dict(os.environ, {"HACK_RUNTIME_BACKEND": "compose"}):
            # The released manager always selects native and its private homes.
            command, environment = self.launch()
            self.assertEqual(command, version / "bundle/hack-v5")
            self.assertEqual(environment["HACK_RUNTIME_BACKEND"], "native")
            self.assertEqual(environment["HACK_HOME"], str(version / "cli-home"))
            self.channel = self.upgrade_manager()
            self.assertEqual((self.channel.root / "manager.py").read_bytes(), SOURCE.read_bytes())
            self.assertEqual(self.retained_snapshot(), before)
            command, environment = self.launch()
        self.assertEqual(command, version / "bundle/hack-cli")
        self.assertEqual(environment["HACK_RUNTIME_BACKEND"], "compose")
        self.assertEqual(environment["HACK_HOME"], str(self.stable_home / ".hack"))
        os.environ.pop("HACK_RUNTIME_BACKEND")
        command, environment = self.launch()
        self.assertEqual(command, version / "bundle/hack-v5")
        self.assertEqual(environment["HACK_HOME"], str(version / "cli-home"))
        self.assertEqual(self.retained_snapshot(), before)

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
        response.headers = {"Content-Length": str(len(b"verified transport fixture"))}
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

    def official_release(self, version):
        """Intact official responses for one pinned version, keyed by exact URL."""
        tag = "v" + version
        archive_name = "hack-" + version + "-darwin-arm64-native.tar.gz"
        archive, checksum = self.archive(version)
        identity = {"schema": "hack.prerelease/v1", "version": version, "tag": tag,
                    "source_revision": "a" * 40, "platform": "darwin-arm64"}
        base = "https://github.com/hack-dance/hack/releases/download/" + tag + "/"
        release = {"tag_name": tag, "prerelease": True, "draft": False,
                   "assets": [{"name": name, "browser_download_url": base + name}
                              for name in (archive_name, "prerelease.json", "SHA256SUMS")]}
        api = "https://api.github.com/repos/hack-dance/hack/"
        return {
            api + "releases/tags/" + tag: json.dumps(release).encode(),
            api + "git/ref/tags/" + tag: json.dumps({
                "ref": "refs/tags/" + tag,
                "object": {"type": "commit", "sha": identity["source_revision"]}}).encode(),
            base + "prerelease.json": json.dumps(identity).encode(),
            base + "SHA256SUMS": (checksum + "  " + archive_name + "\n").encode(),
            base + archive_name: archive.read_bytes(),
        }

    def official_install(self, version, responses, faults=None):
        """Install through the real download loop; only the HTTP opener is substituted."""
        import urllib.request

        faults = faults or {}
        opened = []

        def respond(request, timeout):
            self.assertEqual(timeout, 30)
            url = request.full_url
            opened.append(url)
            body = responses[url]
            if url in faults:
                return faults[url](url, body)
            # Release assets declare their length; API responses may be chunked.
            declared = len(body) if "/releases/download/" in url else None
            return OfficialResponse(url, body, declared)

        def build_opener(*handlers):
            self.assertEqual(len(handlers), 1)
            self.assertIsInstance(handlers[0], urllib.request.HTTPRedirectHandler)
            opener = mock.Mock()
            opener.open.side_effect = respond
            return opener

        with mock.patch.object(urllib.request, "build_opener", side_effect=build_opener):
            with self.channel.lock():
                self.channel.install(version, upgrade=True)
        return opened

    def test_truncated_reset_and_oversized_official_downloads_refuse_then_clean_retry_succeeds(self):
        import http.client

        version = "5.0.0-next.2"
        tag = "v" + version
        base = "https://github.com/hack-dance/hack/releases/download/" + tag + "/"
        archive_url = base + "hack-" + version + "-darwin-arm64-native.tar.gz"
        budget = 64 * 1024
        cases = {
            "short body": (archive_url, "incomplete", lambda url, body: OfficialResponse(
                url, body[:len(body) // 2], declared=len(body))),
            "incomplete read": (archive_url, "interrupted", lambda url, body: OfficialResponse(
                url, body, declared=len(body), step=len(body) // 2,
                fault=http.client.IncompleteRead(body[:len(body) // 2], len(body) - len(body) // 2))),
            "connection reset": (archive_url, "interrupted", lambda url, body: OfficialResponse(
                url, body, declared=len(body), step=len(body) // 2,
                fault=ConnectionResetError(54, "Connection reset by peer"))),
            "streamed past budget": (base + "SHA256SUMS", "size budget", lambda url, _body: OfficialResponse(
                url, b"0" * (budget + 1), step=16 * 1024)),
            "declared past budget": (base + "prerelease.json", "size budget", lambda url, body: OfficialResponse(
                url, body, declared=budget + 1)),
        }
        for index, (case, (url, message, fault)) in enumerate(cases.items()):
            with self.subTest(case=case):
                self.channel = installer.Channel(self.root / ("download-channel-" + str(index)))
                self.channel.initialize()
                self.install()
                (self.channel.root / "versions/5.0.0-next.1/native-home/marker").write_bytes(b"retained")
                # An earlier interrupted stage is not this call's to remove.
                other = self.channel.root / (".stage-" + "e" * 32)
                other.mkdir(mode=0o700)
                (other / "evidence").write_bytes(b"earlier attempt")
                other_identity = (other.stat().st_ino, (other / "evidence").stat().st_ino)
                responses = self.official_release(version)
                before = self.retained_snapshot()
                selection = (self.channel.root / ".selection.json").read_bytes()

                with self.assertRaisesRegex(installer.Refusal, message):
                    self.official_install(version, responses, {url: fault})

                self.assertEqual((self.channel.root / ".selection.json").read_bytes(), selection)
                self.assertEqual(self.retained_snapshot(), before)
                self.assertFalse((self.channel.root / "versions" / version).exists())
                self.assertEqual(sorted(path.name for path in self.channel.root.glob(".stage-*")),
                                 [other.name])
                self.assertEqual((other.stat().st_ino, (other / "evidence").stat().st_ino), other_identity)
                self.assertEqual((other / "evidence").read_bytes(), b"earlier attempt")
                installer.Channel(self.channel.root).validate()

                opened = self.official_install(version, responses)
                self.assertEqual(opened[-1], archive_url)
                self.assertEqual(self.selection()["selected"], version)
                self.assertEqual(self.selection()["previous"], "5.0.0-next.1")
                self.assertEqual((self.channel.root / "versions" / version / "bundle/hack-cli").read_bytes(),
                                 b"reviewed CLI fixture")
                self.assertEqual((self.channel.root / "versions/5.0.0-next.1/native-home/marker").read_bytes(),
                                 b"retained")
                self.assertEqual(sorted(path.name for path in self.channel.root.glob(".stage-*")),
                                 [other.name])
                installer.Channel(self.channel.root).validate()

    def test_download_refuses_short_interrupted_and_oversized_bodies(self):
        import http.client
        import urllib.request

        origin = "https://github.com/hack-dance/hack/releases/download/v5.0.0-next.1/artifact"
        body = b"complete official body"
        cases = [
            ("short", OfficialResponse(origin, body[:5], declared=len(body)), "incomplete"),
            ("incomplete read", OfficialResponse(origin, body, declared=len(body), step=5,
                                                 fault=http.client.IncompleteRead(b"", 1)), "interrupted"),
            ("reset", OfficialResponse(origin, body, step=5, fault=ConnectionResetError()), "interrupted"),
            ("timeout", OfficialResponse(origin, body, step=5, fault=TimeoutError()), "interrupted"),
            ("streamed budget", OfficialResponse(origin, body, step=5), "size budget"),
            ("declared budget", OfficialResponse(origin, body, declared=len(body) + 1), "size budget"),
            ("malformed length", OfficialResponse(origin, body, declared="-1"), "Malformed"),
            ("past declared length", OfficialResponse(origin, body, declared=5, step=10), "declared length"),
        ]
        for index, (case, response, message) in enumerate(cases):
            with self.subTest(case=case):
                limit = 10 if case == "streamed budget" else len(body)
                opener = mock.Mock()
                opener.open.return_value = response
                target = self.root / ("refused-body-" + str(index))
                with mock.patch.object(urllib.request, "build_opener", return_value=opener):
                    with self.assertRaisesRegex(installer.Refusal, message):
                        installer.download(origin, target, limit)
                if case in ("declared budget", "malformed length"):
                    self.assertFalse(target.exists())
                    self.assertEqual(response.offset, 0)

    def test_failed_install_removes_only_the_stage_it_created(self):
        self.install()
        version = "5.0.0-next.2"
        responses = self.official_release(version)
        before = self.retained_snapshot()
        moved = self.channel.root / (".stage-" + "d" * 32)
        created = []

        def replace_stage(url, path, limit):
            # Simulate an unexpected replacement: the original stage is moved aside
            # and an unrelated directory appears at its path before the failure.
            stage = path.parent
            created.append(stage)
            installer.write_file(path, responses[url][:limit])
            os.rename(str(stage), str(moved))
            stage.mkdir(mode=0o700)
            (stage / "replacement").write_bytes(b"not created by this install")
            raise installer.Refusal("Release download was interrupted.")

        with mock.patch.object(installer, "download", side_effect=replace_stage):
            with self.channel.lock():
                with self.assertRaisesRegex(installer.Refusal, "interrupted"):
                    self.channel.install(version, upgrade=True)
        self.assertEqual(len(created), 1)
        self.assertEqual((created[0] / "replacement").read_bytes(), b"not created by this install")
        self.assertEqual({path.name for path in moved.iterdir()}, {"release-api.json"})
        self.assertEqual(self.retained_snapshot(), before)
        installer.Channel(self.channel.root).validate()

        # The local-archive path removes its own stage too, on failure and success.
        archive, checksum = self.archive(version)
        with self.channel.lock():
            with self.assertRaisesRegex(installer.Refusal, "checksum or size mismatch"):
                self.channel.install(version, archive, "0" * 64, True)
        self.assertEqual(sorted(self.channel.root.glob(".stage-*")), sorted([created[0], moved]))
        with self.channel.lock():
            self.channel.install(version, archive, checksum, True)
        self.assertEqual(sorted(self.channel.root.glob(".stage-*")), sorted([created[0], moved]))
        self.assertEqual(self.selection()["selected"], version)


if __name__ == "__main__":
    unittest.main()
