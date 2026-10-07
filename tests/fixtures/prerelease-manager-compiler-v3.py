#!/usr/bin/env python3
"""Explicit, side-by-side native prerelease selection (Python 3.9+, standard library).

Selection changes commit through one atomic receipt. Explicit manager upgrades
use a recoverable journal. Bundles and homes are retained by version; this manager
never migrates runtime state or edits shell PATH.
"""

import argparse
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import signal
import stat
import subprocess
import sys
import tarfile
import tempfile
import urllib.parse
import urllib.request
import uuid


VERSION = re.compile(r"5\.0\.0-next\.([1-9][0-9]*)\Z")
SHA256 = re.compile(r"[0-9a-f]{64}\Z")
REVISION = re.compile(r"[0-9a-f]{40}\Z")
PAYLOAD = frozenset(("hack-native", "hack-relay-guest", "hack-cli", "hack-v5",
                     "provider-pins.json", "README.md", "prerelease.json"))
LEGACY_COMPILER_PAYLOAD = frozenset(("hack-config-compiler", "hack.project.schema.json"))
COMPILER_PAYLOAD = LEGACY_COMPILER_PAYLOAD | {"hack.local.schema.json"}
EXECUTABLES = frozenset(("hack-native", "hack-relay-guest", "hack-cli", "hack-v5",
                         "hack-config-compiler"))
BUNDLE_FILES = PAYLOAD | {"SHA256SUMS"}
MCP_FILES = {"adapter": "hack-mcp-adapter", "owner": "hack-mcp-owner",
             "backend": "hack-mcp-backend"}
MCP_MEMBER = re.compile(r"mcp/([0-9a-f]{64})/(manifest\.json|hack-mcp-adapter|hack-mcp-owner|hack-mcp-backend)\Z")
MAX_ARCHIVE = 512 * 1024 * 1024
METADATA_KEYS = {"schema", "version", "tag", "source_revision", "platform"}
REPOSITORY = "hack-dance/hack"
DOWNLOAD_HOSTS = {"api.github.com", "github.com", "release-assets.githubusercontent.com",
                  "objects.githubusercontent.com"}
# Reviewed flat-layout, shared-MCP, and project-schema compiler managers.
# Keep this an explicit allowlist; a matching user-written receipt is not provenance.
MANAGER_PREDECESSORS = frozenset({
    "b459ffc4f227482119b48e357c91e4607aa4f7d1f88c7ccf5b7d684f66f2c0cd",
    "b7c49e3fec6b06790e833db1d2dcb441d2223c283b792713be46826aa2eef877",
    "ca432b7fc6562bb091d17d3217f5d1daf9f91621a6919c8964ca51bee2111d0c",
})
MANAGER_UPGRADE = ".manager-upgrade.json"


class Refusal(Exception):
    """Untrusted, changed or ambiguous input: preserve the current selection."""


def require(condition, message):
    if not condition:
        raise Refusal(message)


def version_number(value):
    match = VERSION.fullmatch(value) if isinstance(value, str) else None
    require(match is not None, "Version must be 5.0.0-next.N (positive N, no leading zero).")
    return int(match.group(1))


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def json_bytes(value):
    return (json.dumps(value, sort_keys=True, indent=2) + "\n").encode("utf-8")


def parse_json(raw):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, "Duplicate JSON field.")
            result[key] = value
        return result
    try:
        value = json.loads(raw, object_pairs_hook=unique)
    except (ValueError, UnicodeError) as error:
        raise Refusal("Malformed JSON.") from error
    require(isinstance(value, dict), "Expected a JSON object.")
    return value


def metadata(raw, version):
    value = parse_json(raw)
    require(set(value) == METADATA_KEYS, "Unexpected prerelease metadata fields.")
    require(value["schema"] == "hack.prerelease/v1" and value["version"] == version
            and value["tag"] == "v" + version and value["platform"] == "darwin-arm64"
            and isinstance(value["source_revision"], str)
            and REVISION.fullmatch(value["source_revision"]), "Prerelease identity mismatch.")
    return value


def canonical(path):
    path = Path(path)
    require(path.is_absolute() and path == path.resolve(),
            "Use a canonical absolute path without symlinks or traversal.")
    return path


def owned(path, directory=False, mode=None):
    info = path.lstat()
    expected = stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)
    require(expected and info.st_uid == os.getuid(), "Foreign or aliased path: " + str(path))
    if not directory:
        require(info.st_nlink == 1, "Hard-linked file: " + str(path))
    if mode is not None:
        require(stat.S_IMODE(info.st_mode) == mode, "Unsafe mode: " + str(path))
    return info


def private_json(path):
    owned(path, mode=0o600)
    require(path.stat().st_size <= 1024 * 1024, "Oversized installation receipt.")
    return parse_json(path.read_bytes())


def sync_directory(path):
    descriptor = os.open(str(path), os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def write_file(path, contents, mode=0o600):
    descriptor = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    with os.fdopen(descriptor, "wb") as target:
        os.fchmod(target.fileno(), mode)
        target.write(contents)
        target.flush()
        os.fsync(target.fileno())


def atomic_file(path, contents):
    temporary = path.parent / (".selection-" + uuid.uuid4().hex)
    try:
        write_file(temporary, contents)
        os.replace(str(temporary), str(path))
        sync_directory(path.parent)
    finally:
        if temporary.exists():
            temporary.unlink()


def atomic_json(path, value):
    atomic_file(path, json_bytes(value))


def launcher_bytes():
    return ("#!/bin/sh\nset -eu\nroot=$(CDPATH= cd -- \"$(dirname -- \"$0\")/..\" && pwd -P)\n"
            "exec /usr/bin/python3 -I -S \"$root/manager.py\" --root \"$root\" run -- \"$@\"\n").encode()


def checksums(raw, expected):
    try:
        lines = raw.decode("ascii").splitlines()
    except UnicodeError as error:
        raise Refusal("Malformed SHA256SUMS.") from error
    result = {}
    for line in lines:
        match = re.fullmatch(r"([0-9a-f]{64})  ([A-Za-z0-9./-]+)", line)
        require(match is not None, "Malformed SHA256SUMS entry.")
        checksum, name = match.groups()
        require(name in expected and name not in result, "Duplicate or foreign checksum entry.")
        result[name] = checksum
    require(set(result) == set(expected), "Incomplete checksum manifest.")
    return result


def payload_inventory(names):
    """Accept complete optional compiler and MCP groups alongside the original payload."""
    names = set(names)
    require(BUNDLE_FILES <= names, "Incomplete candidate bundle.")
    compiler = names & COMPILER_PAYLOAD
    require(not compiler or compiler in (LEGACY_COMPILER_PAYLOAD, COMPILER_PAYLOAD),
            "Incomplete config compiler payload.")
    extra = names - BUNDLE_FILES - COMPILER_PAYLOAD
    if extra:
        matches = [MCP_MEMBER.fullmatch(name) for name in extra]
        require(all(matches), "Foreign candidate MCP payload.")
        identities = {match.group(1) for match in matches}
        require(len(identities) == 1, "Candidate requires one MCP bundle identity.")
        prefix = "mcp/" + next(iter(identities)) + "/"
        require(extra == {prefix + name for name in (*MCP_FILES.values(), "manifest.json")},
                "Incomplete candidate MCP payload.")
    return names - {"SHA256SUMS"}


def bundle_inventory(bundle):
    names = {entry.name for entry in bundle.iterdir()}
    if "mcp" in names:
        owned(bundle / "mcp", directory=True, mode=0o700)
        identities = list((bundle / "mcp").iterdir())
        require(len(identities) == 1 and SHA256.fullmatch(identities[0].name),
                "Candidate requires one MCP bundle identity.")
        directory = identities[0]
        owned(directory, directory=True, mode=0o700)
        names.remove("mcp")
        names.update("mcp/" + directory.name + "/" + entry.name for entry in directory.iterdir())
    return payload_inventory(names)


def payload_mode(name):
    if MCP_MEMBER.fullmatch(name):
        return 0o400 if name.endswith("/manifest.json") else 0o500
    return 0o755 if name in EXECUTABLES else 0o600


def verify_mcp_bundle(bundle, payload):
    nested = sorted(name for name in payload if MCP_MEMBER.fullmatch(name))
    if not nested:
        return
    prefix = str(Path(nested[0]).parent)
    path = bundle / prefix / "manifest.json"
    require(path.stat().st_size <= 8192, "Oversized MCP manifest.")
    manifest = parse_json(path.read_bytes())
    require(set(manifest) == {"schemaVersion", "startupProtocol", "wireProtocol", "platform",
                              "architecture", "files", "bundleId"}, "Invalid MCP manifest fields.")
    require(all(type(manifest[field]) in (int, float)
                for field in ("schemaVersion", "startupProtocol", "wireProtocol"))
            and manifest["schemaVersion"] == 1 and manifest["startupProtocol"] == 2
            and manifest["wireProtocol"] == 1 and manifest["platform"] == "darwin"
            and manifest["architecture"] == "arm64", "Incompatible MCP protocol or host.")
    files = manifest["files"]
    require(isinstance(files, dict) and set(files) == set(MCP_FILES), "Invalid MCP asset inventory.")
    canonical_files = {}
    for role, name in MCP_FILES.items():
        entry = files[role]
        require(isinstance(entry, dict) and set(entry) == {"sha256", "bytes"}
                and isinstance(entry["sha256"], str) and SHA256.fullmatch(entry["sha256"])
                and type(entry["bytes"]) is int and 0 < entry["bytes"] <= 256 * 1024 * 1024,
                "Invalid MCP asset fingerprint.")
        asset = bundle / prefix / name
        require(asset.stat().st_size == entry["bytes"] and digest(asset) == entry["sha256"],
                "MCP asset fingerprint mismatch.")
        canonical_files[role] = {"sha256": entry["sha256"], "bytes": entry["bytes"]}
    body = {"schemaVersion": 1, "startupProtocol": 2, "wireProtocol": 1,
            "platform": "darwin", "architecture": "arm64", "files": canonical_files}
    identity = hashlib.sha256(json.dumps(body, separators=(",", ":")).encode()).hexdigest()
    require(manifest["bundleId"] == identity and Path(prefix).name == identity,
            "MCP bundle identity mismatch.")


def verify_bundle(bundle, version):
    owned(bundle, directory=True, mode=0o700)
    payload = bundle_inventory(bundle)
    for name in payload | {"SHA256SUMS"}:
        owned(bundle / name, mode=payload_mode(name))
    require((bundle / "SHA256SUMS").stat().st_size <= 64 * 1024
            and (bundle / "prerelease.json").stat().st_size <= 64 * 1024,
            "Oversized bundle metadata or checksum manifest.")
    manifest = checksums((bundle / "SHA256SUMS").read_bytes(), payload)
    for name, checksum in manifest.items():
        require(digest(bundle / name) == checksum, "Candidate checksum mismatch: " + name)
    identity = metadata((bundle / "prerelease.json").read_bytes(), version)
    verify_mcp_bundle(bundle, payload)
    return identity, manifest


def verify_signatures(bundle):
    names = ["hack-native", "hack-cli"]
    payload = bundle_inventory(bundle)
    if "hack-config-compiler" in payload:
        names.append("hack-config-compiler")
    names.extend(name for name in payload
                 if MCP_MEMBER.fullmatch(name) and not name.endswith("/manifest.json"))
    for name in names:
        try:
            result = subprocess.run(["/usr/bin/codesign", "--verify", "--strict", str(bundle / name)],
                                    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                    stderr=subprocess.DEVNULL, timeout=30, check=False)
        except (OSError, subprocess.TimeoutExpired) as error:
            raise Refusal("Cannot verify candidate code signature.") from error
        require(result.returncode == 0, "Candidate code signature failed: " + name)


def extract_archive(archive, checksum, destination, version, release_metadata=None):
    owned(archive)
    require(SHA256.fullmatch(checksum) is not None, "Expected archive SHA-256 is required.")
    require(archive.stat().st_size <= MAX_ARCHIVE and digest(archive) == checksum,
            "Archive checksum or size mismatch.")
    try:
        with tarfile.open(str(archive), "r:gz") as source:
            entries = []
            seen = set()
            total = 0
            for entry in source:
                require(len(entries) < len(BUNDLE_FILES) + len(COMPILER_PAYLOAD) + 4, "Incomplete or duplicate archive entries.")
                require((entry.name in BUNDLE_FILES | COMPILER_PAYLOAD or MCP_MEMBER.fullmatch(entry.name)) and entry.name not in seen,
                        "Foreign, duplicate or traversing archive entry.")
                require(entry.isfile() and not entry.issparse() and entry.size > 0
                        and entry.size <= MAX_ARCHIVE, "Only bounded regular archive files are accepted.")
                seen.add(entry.name)
                total += entry.size
                require(total <= MAX_ARCHIVE, "Oversized archive.")
                entries.append(entry)
            payload = payload_inventory(seen)
            by_name = {entry.name: entry for entry in entries}
            require(by_name["prerelease.json"].size <= 64 * 1024
                    and by_name["SHA256SUMS"].size <= 64 * 1024,
                    "Oversized archive metadata or checksum manifest.")
            with source.extractfile(by_name["prerelease.json"]) as incoming:
                identity = metadata(incoming.read(), version)
            require(release_metadata is None or identity == release_metadata,
                    "Archive metadata differs from the pinned release.")
            with source.extractfile(by_name["SHA256SUMS"]) as incoming:
                manifest = checksums(incoming.read(), payload)
            # Preflight hashes before writing any payload. Revalidation after
            # copying also catches a source changed between these two passes.
            for entry in entries:
                name = entry.name
                if name not in payload:
                    continue
                value = hashlib.sha256()
                with source.extractfile(entry) as incoming:
                    for chunk in iter(lambda: incoming.read(1024 * 1024), b""):
                        value.update(chunk)
                require(value.hexdigest() == manifest[name], "Candidate checksum mismatch: " + name)
            destination.mkdir(mode=0o700)
            nested = {name for name in payload if MCP_MEMBER.fullmatch(name)}
            if nested:
                prefix = Path(next(iter(nested))).parent
                (destination / "mcp").mkdir(mode=0o700)
                (destination / prefix).mkdir(mode=0o700)
            for entry in entries:
                incoming = source.extractfile(entry)
                require(incoming is not None, "Unreadable archive payload.")
                with incoming:
                    descriptor = os.open(str(destination / entry.name),
                                         os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                                         payload_mode(entry.name))
                    with os.fdopen(descriptor, "wb") as target:
                        os.fchmod(target.fileno(), payload_mode(entry.name))
                        remaining = entry.size
                        while remaining:
                            chunk = incoming.read(min(1024 * 1024, remaining))
                            require(bool(chunk), "Truncated archive payload.")
                            target.write(chunk)
                            remaining -= len(chunk)
                        target.flush()
                        os.fsync(target.fileno())
    except (tarfile.TarError, EOFError) as error:
        raise Refusal("Invalid candidate archive.") from error
    identity, manifest = verify_bundle(destination, version)
    require(release_metadata is None or identity == release_metadata,
            "Archive metadata differs from the pinned release.")
    verify_signatures(destination)
    sync_directory(destination)
    return identity, manifest


def secure_url(url):
    parsed = urllib.parse.urlsplit(url)
    require(parsed.scheme == "https" and parsed.hostname in DOWNLOAD_HOSTS
            and parsed.port in (None, 443) and not parsed.username and not parsed.password
            and not parsed.fragment, "Refusing nonofficial or non-HTTPS download.")


class OfficialRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, url):
        secure_url(url)
        return super().redirect_request(request, response, code, message, headers, url)


def download(url, target, limit):
    secure_url(url)
    request = urllib.request.Request(url, headers={"Accept": "application/vnd.github+json",
                                                   "User-Agent": "hack-prerelease-installer"})
    opener = urllib.request.build_opener(OfficialRedirect())
    with opener.open(request, timeout=30) as response:
        secure_url(response.geturl())
        descriptor = os.open(str(target), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "wb") as output:
            size = 0
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                require(size <= limit, "Release download exceeds its size budget.")
                output.write(chunk)
            output.flush()
            os.fsync(output.fileno())


def official_archive(stage, version):
    tag = "v" + version
    api_path = stage / "release-api.json"
    download("https://api.github.com/repos/" + REPOSITORY + "/releases/tags/" + tag,
             api_path, 2 * 1024 * 1024)
    release = parse_json(api_path.read_bytes())
    require(release.get("tag_name") == tag and release.get("prerelease") is True
            and release.get("draft") is False, "Expected a published, pinned official prerelease.")
    archive_name = "hack-" + version + "-darwin-arm64-native.tar.gz"
    wanted = {archive_name, "SHA256SUMS", "prerelease.json"}
    assets = release.get("assets")
    require(isinstance(assets, list), "Missing release assets.")
    selected = {}
    for asset in assets:
        require(isinstance(asset, dict), "Malformed release asset.")
        name = asset.get("name")
        require(isinstance(name, str), "Malformed release asset name.")
        if name in wanted:
            require(name not in selected, "Duplicate release asset.")
            expected = "https://github.com/" + REPOSITORY + "/releases/download/" + tag + "/" + name
            require(asset.get("browser_download_url") == expected, "Foreign release asset URL.")
            selected[name] = expected
    require(set(selected) == wanted, "Incomplete official prerelease assets.")
    download(selected["prerelease.json"], stage / "release-metadata.json", 64 * 1024)
    identity = metadata((stage / "release-metadata.json").read_bytes(), version)
    download("https://api.github.com/repos/" + REPOSITORY + "/git/ref/tags/" + tag,
             stage / "release-tag.json", 64 * 1024)
    reference = parse_json((stage / "release-tag.json").read_bytes())
    commit = reference.get("object")
    require(reference.get("ref") == "refs/tags/" + tag and isinstance(commit, dict)
            and commit.get("type") == "commit" and commit.get("sha") == identity["source_revision"],
            "Official prerelease tag does not match its source revision.")
    download(selected["SHA256SUMS"], stage / "release-checksums", 64 * 1024)
    checksum = checksums((stage / "release-checksums").read_bytes(), {archive_name})[archive_name]
    archive = stage / archive_name
    download(selected[archive_name], archive, MAX_ARCHIVE)
    return archive, checksum, identity


class Channel:
    """Owned private layout; the selection file records immutable receipt hashes."""

    def __init__(self, root):
        self.root = canonical(root)
        self.state = None

    def initialize(self):
        if not self.root.exists():
            owned(self.root.parent, directory=True)
            self.root.mkdir(mode=0o700)
        owned(self.root, directory=True, mode=0o700)
        if (self.root / ".channel.json").exists():
            return
        require(not list(self.root.iterdir()), "Refusing to adopt a nonempty installation root.")
        (self.root / "bin").mkdir(mode=0o700)
        (self.root / "versions").mkdir(mode=0o700)
        write_file(self.root / "manager.py", Path(__file__).read_bytes())
        write_file(self.root / "bin/hack-next", launcher_bytes(), 0o755)
        root_info = self.root.stat()
        write_file(self.root / ".channel.json", json_bytes({
            "schema": "hack.prerelease-install/v1", "root": str(self.root), "uid": os.getuid(),
            "device": root_info.st_dev, "inode": root_info.st_ino,
            "manager_sha256": digest(self.root / "manager.py"),
            "launcher_sha256": digest(self.root / "bin/hack-next")}))
        write_file(self.root / ".selection.json", json_bytes({
            "schema": "hack.prerelease-selection/v1", "installed": {},
            "selected": None, "previous": None}))
        write_file(self.root / ".manager.lock", b"")
        sync_directory(self.root)

    @contextlib.contextmanager
    def lock(self, shared=False, manager_upgrade=False):
        owned(self.root, directory=True, mode=0o700)
        owned(self.root / ".manager.lock", mode=0o600)
        descriptor = os.open(str(self.root / ".manager.lock"), os.O_RDWR | os.O_NOFOLLOW)
        with os.fdopen(descriptor, "rb") as handle:
            try:
                fcntl.flock(handle, (fcntl.LOCK_SH if shared else fcntl.LOCK_EX) | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise Refusal("Another candidate manager or launcher is active.") from error
            self.validate(manager_upgrade=manager_upgrade)
            yield

    def validate(self, manager_upgrade=False):
        root_info = owned(self.root, directory=True, mode=0o700)
        pending = os.path.lexists(self.root / MANAGER_UPGRADE)
        require(not pending or manager_upgrade,
                "Manager upgrade is pending; rerun upgrade-manager with the same reviewed installer.")
        transition = self.read_manager_upgrade() if pending else None
        marker = private_json(self.root / ".channel.json")
        require(set(marker) == {"schema", "root", "uid", "device", "inode",
                                "manager_sha256", "launcher_sha256"}
                and marker["schema"] == "hack.prerelease-install/v1"
                and marker["root"] == str(self.root) and marker["uid"] == os.getuid()
                and marker["device"] == root_info.st_dev and marker["inode"] == root_info.st_ino,
                "Foreign or malformed installation receipt.")
        owned(self.root / "manager.py", mode=0o600)
        owned(self.root / "bin", directory=True, mode=0o700)
        owned(self.root / "bin/hack-next", mode=0o755)
        manager_hash = digest(self.root / "manager.py")
        require((manager_hash == marker["manager_sha256"] or transition is not None
                 and manager_hash == transition["to_sha256"]
                 and marker["manager_sha256"] == transition["from_sha256"])
                and digest(self.root / "bin/hack-next") == marker["launcher_sha256"],
                "Installation manager or launcher changed.")
        require({p.name for p in (self.root / "bin").iterdir()} == {"hack-next"},
                "Foreign launcher entry.")
        state = private_json(self.root / ".selection.json")
        require(set(state) == {"schema", "installed", "selected", "previous"}
                and state["schema"] == "hack.prerelease-selection/v1"
                and isinstance(state["installed"], dict), "Malformed selection receipt.")
        installed = state["installed"]
        require(len(installed) <= 256, "Too many candidate versions; inspection required.")
        for version, checksum in installed.items():
            version_number(version)
            require(isinstance(checksum, str) and SHA256.fullmatch(checksum), "Malformed receipt hash.")
            self.verify_version(version, checksum)
        for key in ("selected", "previous"):
            require(state[key] is None or isinstance(state[key], str) and state[key] in installed,
                    "Unknown selected or previous candidate.")
        require(state["selected"] is None or state["selected"] != state["previous"],
                "Malformed candidate history.")
        owned(self.root / "versions", directory=True, mode=0o700)
        for entry in (self.root / "versions").iterdir():
            if entry.name not in installed:
                version_number(entry.name)
                # Rename can precede selection by a power-loss boundary. Validate
                # the retained directory, but never select/adopt it automatically.
                private_json(entry / ".receipt.json")
                self.verify_version(entry.name, digest(entry / ".receipt.json"))
        allowed = {".channel.json", ".selection.json", ".manager.lock", "manager.py", "bin", "versions"}
        if transition is not None:
            allowed.add(MANAGER_UPGRADE)
        for entry in self.root.iterdir():
            if entry.name in allowed:
                continue
            if re.fullmatch(r"\.stage-[0-9a-f]{32}", entry.name):
                owned(entry, directory=True, mode=0o700)
                continue
            if re.fullmatch(r"\.selection-[0-9a-f]{32}", entry.name):
                owned(entry, mode=0o600)
                continue
            raise Refusal("Foreign installation entry: " + entry.name)
        self.state = state

    def read_manager_upgrade(self):
        """Verify both sides of the only supported two-file transition before recovery.

        The journal closes ordinary launch admission before either file changes.
        Recovery may finish this exact transition, never adopt changed receipts or
        select software. The staged originals remain available for inspection.
        """
        plan = private_json(self.root / MANAGER_UPGRADE)
        require(set(plan) == {"schema", "stage", "from_sha256", "to_sha256",
                              "channel_sha256", "selection_sha256"}
                and plan["schema"] == "hack.prerelease-manager-upgrade/v1"
                and isinstance(plan["stage"], str)
                and re.fullmatch(r"\.stage-[0-9a-f]{32}", plan["stage"]),
                "Malformed manager upgrade journal.")
        require(all(isinstance(plan[key], str) and SHA256.fullmatch(plan[key])
                    for key in ("from_sha256", "to_sha256", "channel_sha256", "selection_sha256")),
                "Malformed manager upgrade digest.")
        require(plan["from_sha256"] in MANAGER_PREDECESSORS
                and plan["to_sha256"] == digest(Path(__file__)),
                "Manager recovery requires the same reviewed installer and a known predecessor.")
        stage = self.root / plan["stage"]
        owned(stage, directory=True, mode=0o700)
        require({p.name for p in stage.iterdir()} == {
            "manager-before.py", "manager-after.py", "channel-before.json", "channel-after.json"},
            "Foreign manager upgrade staging entry.")
        for entry in stage.iterdir():
            owned(entry, mode=0o600)
        before = private_json(stage / "channel-before.json")
        after = private_json(stage / "channel-after.json")
        require(digest(stage / "manager-before.py") == plan["from_sha256"]
                and digest(stage / "manager-after.py") == plan["to_sha256"]
                and digest(stage / "channel-before.json") == plan["channel_sha256"]
                and before.get("manager_sha256") == plan["from_sha256"]
                and after == dict(before, manager_sha256=plan["to_sha256"]),
                "Manager upgrade staging changed.")
        owned(self.root / "manager.py", mode=0o600)
        private_json(self.root / ".channel.json")
        private_json(self.root / ".selection.json")
        old_receipt = (stage / "channel-before.json").read_bytes()
        new_receipt = (stage / "channel-after.json").read_bytes()
        current_receipt = (self.root / ".channel.json").read_bytes()
        current_hash = digest(self.root / "manager.py")
        require((current_hash == plan["from_sha256"] and current_receipt == old_receipt)
                or (current_hash == plan["to_sha256"] and current_receipt in (old_receipt, new_receipt)),
                "Manager upgrade publication state changed.")
        require(digest(self.root / ".selection.json") == plan["selection_sha256"],
                "Selection changed during manager upgrade; inspection required.")
        owned(self.root / "bin", directory=True, mode=0o700)
        owned(self.root / "bin/hack-next", mode=0o755)
        require((self.root / "bin/hack-next").read_bytes() == launcher_bytes(),
                "Custom launcher cannot be upgraded.")
        return plan

    def upgrade_manager(self):
        """Explicitly replace a known manager, with recoverable fail-closed publication."""
        self.validate(manager_upgrade=True)
        pending = os.path.lexists(self.root / MANAGER_UPGRADE)
        source = canonical(Path(__file__).absolute())
        owned(source)
        target = source.read_bytes()
        target_hash = hashlib.sha256(target).hexdigest()
        if not pending:
            current_hash = digest(self.root / "manager.py")
            if current_hash == target_hash:
                return
            require(current_hash in MANAGER_PREDECESSORS,
                    "Unknown or customized manager; explicit upgrade supports only the reviewed flat-layout predecessor.")
            require((self.root / "bin/hack-next").read_bytes() == launcher_bytes(),
                    "Custom launcher cannot be upgraded.")
        # All retained versions share this manager. Keep the existing executor
        # ownership checks, including status/down/status, for each of them.
        for version in self.state["installed"]:
            self.require_quiescent(version, manager_upgrade=True)
        self.validate(manager_upgrade=True)
        if not pending:
            stage = self.root / (".stage-" + uuid.uuid4().hex)
            stage.mkdir(mode=0o700)
            before = (self.root / ".channel.json").read_bytes()
            after = dict(parse_json(before), manager_sha256=target_hash)
            write_file(stage / "manager-before.py", (self.root / "manager.py").read_bytes())
            write_file(stage / "manager-after.py", target)
            write_file(stage / "channel-before.json", before)
            write_file(stage / "channel-after.json", json_bytes(after))
            plan = {"schema": "hack.prerelease-manager-upgrade/v1", "stage": stage.name,
                    "from_sha256": current_hash, "to_sha256": target_hash,
                    "channel_sha256": hashlib.sha256(before).hexdigest(),
                    "selection_sha256": digest(self.root / ".selection.json")}
            write_file(stage / "journal.json", json_bytes(plan))
            sync_directory(stage)
            self.validate()
            os.rename(str(stage / "journal.json"), str(self.root / MANAGER_UPGRADE))
            sync_directory(stage)
            sync_directory(self.root)
        self.validate(manager_upgrade=True)
        plan = self.read_manager_upgrade()
        stage = self.root / plan["stage"]
        if digest(self.root / "manager.py") != target_hash:
            atomic_file(self.root / "manager.py", (stage / "manager-after.py").read_bytes())
        self.validate(manager_upgrade=True)
        if (self.root / ".channel.json").read_bytes() != (stage / "channel-after.json").read_bytes():
            atomic_file(self.root / ".channel.json", (stage / "channel-after.json").read_bytes())
        self.validate(manager_upgrade=True)
        (self.root / MANAGER_UPGRADE).unlink()
        sync_directory(self.root)
        self.validate()

    def verify_version(self, version, checksum):
        directory = self.root / "versions" / version
        owned(directory, directory=True, mode=0o700)
        require({p.name for p in directory.iterdir()} == {"bundle", "native-home", "cli-home", ".receipt.json"},
                "Incomplete or foreign version installation.")
        receipt_path = directory / ".receipt.json"
        receipt = private_json(receipt_path)
        require(digest(receipt_path) == checksum, "Candidate installation receipt changed.")
        require(set(receipt) == {"schema", "metadata", "archive_sha256", "checksums", "homes"}
                and receipt["schema"] == "hack.prerelease-version/v1"
                and isinstance(receipt["archive_sha256"], str)
                and SHA256.fullmatch(receipt["archive_sha256"]), "Malformed version receipt.")
        identity, manifest = verify_bundle(directory / "bundle", version)
        require(receipt["metadata"] == identity and receipt["checksums"] == manifest,
                "Candidate identity or checksum receipt changed.")
        require(isinstance(receipt["homes"], dict) and set(receipt["homes"]) == {"native-home", "cli-home"},
                "Malformed candidate home receipt.")
        for name in ("native-home", "cli-home"):
            info = owned(directory / name, directory=True, mode=0o700)
            require(receipt["homes"][name] == {"device": info.st_dev, "inode": info.st_ino},
                    "Candidate home identity changed.")
        return directory

    def environment(self, version):
        directory = self.root / "versions" / version
        environment = dict(os.environ)
        environment.pop("HACK_GLOBAL_CONFIG_PATH", None)
        environment.update({"HACK_RUNTIME_BACKEND": "native",
                            "HACK_NATIVE_BINARY": str(directory / "bundle/hack-native"),
                            "HACK_NATIVE_HOME": str(directory / "native-home"),
                            "HACK_HOME": str(directory / "cli-home")})
        return environment

    def require_quiescent(self, version, manager_upgrade=False):
        if version is None:
            return
        self.validate(manager_upgrade=manager_upgrade)
        directory = self.verify_version(version, self.state["installed"][version])
        verify_signatures(directory / "bundle")
        for action in ("status", "down", "status"):
            command = [str(directory / "bundle/hack-native"), "--candidate-root",
                       str(directory / "native-home"), "runtime", action, "--json"]
            try:
                result = subprocess.run(command, env=self.environment(version), stdin=subprocess.DEVNULL,
                                        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                        timeout=30, check=False)
            except (OSError, subprocess.TimeoutExpired) as error:
                raise Refusal("Candidate quiescence is unavailable; selection preserved.") from error
            require(result.returncode == 0 and len(result.stdout) <= 1024 * 1024,
                    "Candidate quiescence check failed; failure never means idle.")
            status = parse_json(result.stdout)
            phase = status.get("phase")
            require(phase in ("uninitialized", "stopped") and status.get("process_alive") is False,
                    "Candidate runtime is active or ambiguous; stop it through its supported CLI first.")
            if phase == "uninitialized":
                require(not list((directory / "native-home").iterdir()),
                        "Uninitialized home contains state; inspect it through its owning CLI.")
            self.validate(manager_upgrade=manager_upgrade)

    def select(self, version, installed=None):
        self.require_quiescent(self.state["selected"])
        if version is not None:
            self.require_quiescent(version)
        # Recheck receipts at the effect boundary, then commit exactly one pointer.
        self.validate()
        state = dict(self.state)
        if installed is not None:
            state["installed"] = installed
        if version != state["selected"]:
            state["previous"] = state["selected"]
            state["selected"] = version
        atomic_json(self.root / ".selection.json", state)
        self.state = state

    def install(self, version, archive=None, checksum=None, upgrade=False):
        version_number(version)
        current = self.state["selected"]
        if version in self.state["installed"]:
            require(version == current, "Version is already installed; use rollback to select it.")
            if archive is not None:
                archive = canonical(archive)
                owned(archive)
            require(archive is None or digest(archive) == checksum
                    == private_json(self.root / "versions" / version / ".receipt.json")["archive_sha256"],
                    "Installed version differs from the supplied archive.")
            return
        require(upgrade or current is None, "A candidate is selected; use upgrade with a newer version.")
        require(current is None or version_number(version) > version_number(current),
                "Upgrade must increase the prerelease version; use rollback for an installed version.")
        self.require_quiescent(current)
        stage = self.root / (".stage-" + uuid.uuid4().hex)
        stage.mkdir(mode=0o700)
        if archive is None:
            archive, checksum, release_metadata = official_archive(stage, version)
        else:
            archive = canonical(archive)
            release_metadata = None
        installation = stage / "installation"
        installation.mkdir(mode=0o700)
        identity, manifest = extract_archive(archive, checksum, installation / "bundle", version,
                                             release_metadata)
        # The retained launcher always executes its recorded manager. Never select
        # a new layout that an older manager cannot subsequently validate/rollback.
        # Manager replacement is a separate explicit, recoverable operation.
        require(set(manifest) <= PAYLOAD
                or digest(self.root / "manager.py") == digest(Path(__file__)),
                "Optional candidate payloads require this channel's retained manager to match the installer. "
                "Run upgrade-manager with this reviewed installer, or use a fresh --root; "
                "the existing channel and its selection are unchanged.")
        homes = {}
        for name in ("native-home", "cli-home"):
            (installation / name).mkdir(mode=0o700)
            info = (installation / name).stat()
            homes[name] = {"device": info.st_dev, "inode": info.st_ino}
        write_file(installation / ".receipt.json", json_bytes({
            "schema": "hack.prerelease-version/v1", "metadata": identity,
            "archive_sha256": checksum, "checksums": manifest, "homes": homes}))
        sync_directory(installation)
        # Final refusal happens before publication. A power loss after rename retains
        # an uncommitted directory for inspection, while the old selection stays valid.
        self.require_quiescent(current)
        self.validate()
        destination = self.root / "versions" / version
        require(not destination.exists(), "Refusing to overwrite a candidate version.")
        os.rename(str(installation), str(destination))
        sync_directory(destination.parent)
        installed = dict(self.state["installed"])
        installed[version] = digest(destination / ".receipt.json")
        state = dict(self.state, installed=installed, selected=version, previous=current)
        atomic_json(self.root / ".selection.json", state)
        self.state = state

    def run(self, arguments):
        version = self.state["selected"]
        require(version is not None, "No candidate selected. Use your ordinary stable hack command.")
        directory = self.verify_version(version, self.state["installed"][version])
        verify_signatures(directory / "bundle")
        # Shared launcher locks permit ps/down alongside foreground up, while an
        # exclusive selection switch refuses any in-flight launcher. Background
        # runtime state is gated by the owning executor on later switches.
        child = subprocess.Popen([str(directory / "bundle/hack-v5"), *arguments],
                                 env=self.environment(version))
        handlers = {}
        def forward(signum, _frame):
            child.send_signal(signum)
        try:
            for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
                handlers[signum] = signal.signal(signum, forward)
            code = child.wait()
            return code if code >= 0 else 128 - code
        finally:
            for signum, handler in handlers.items():
                signal.signal(signum, handler)


def parser():
    arguments = argparse.ArgumentParser(description=__doc__)
    arguments.add_argument("--root", type=Path, default=Path.home() / ".hack-next",
                           help="private canonical installation root (default ~/.hack-next)")
    commands = arguments.add_subparsers(dest="command", required=True)
    for command in ("install", "upgrade"):
        install = commands.add_parser(command)
        install.add_argument("--version", required=True)
        install.add_argument("--archive", type=Path, help="explicit local archive instead of GitHub")
        install.add_argument("--sha256", help="required expected digest for --archive")
    rollback = commands.add_parser("rollback")
    rollback.add_argument("--version", help="retained version; default previous selection")
    commands.add_parser("stable", help="deselect candidate; retain all bundles and homes")
    commands.add_parser("status")
    commands.add_parser("upgrade-manager", help="explicitly upgrade a known channel manager, or finish its interrupted upgrade")
    run = commands.add_parser("run")
    run.add_argument("arguments", nargs=argparse.REMAINDER)
    return arguments


def main(argv=None):
    args = parser().parse_args(argv)
    os.umask(0o077)
    require(platform.system() == "Darwin" and platform.machine() == "arm64",
            "Native prereleases support Apple Silicon macOS only.")
    channel = Channel(args.root)
    if args.command in ("install", "upgrade"):
        version_number(args.version)
        require(bool(args.archive) == bool(args.sha256), "--archive and --sha256 must be supplied together.")
        channel.initialize()
    with channel.lock(shared=args.command == "run", manager_upgrade=args.command == "upgrade-manager"):
        if args.command in ("install", "upgrade"):
            channel.install(args.version, args.archive, args.sha256, args.command == "upgrade")
        elif args.command == "upgrade-manager":
            channel.upgrade_manager()
        elif args.command == "rollback":
            version = args.version or channel.state["previous"]
            require(version is not None and version in channel.state["installed"], "No retained rollback version.")
            channel.select(version)
        elif args.command == "stable":
            channel.select(None)
        elif args.command == "run":
            arguments = args.arguments[1:] if args.arguments[:1] == ["--"] else args.arguments
            return channel.run(arguments)
        print(json.dumps({"selected": channel.state["selected"], "previous": channel.state["previous"],
                          "installed": sorted(channel.state["installed"], key=version_number),
                          "launcher": str(channel.root / "bin/hack-next")}))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (Refusal, OSError, ValueError) as error:
        print("hack-next: " + str(error), file=sys.stderr)
        sys.exit(1)
