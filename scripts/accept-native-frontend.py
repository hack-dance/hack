#!/usr/bin/env python3
"""Native frontend acceptance: prepared-base startup through ordinary `hack up` in a linked worktree.

Preview-first: without --run this prints the plan and changes nothing. It is a correctness check
only, and records no timing claims.

Sequence, all inside one private owned --root:
  1. A harness-owned repository and one linked `git worktree add` checkout (a Hack project
     whose web service serves the worktree over HTTPS).
  2. A private candidate home prepared with the pinned provider, engine and network tools, and
     one prepared base built and independently verified into a private store.
  3. `hack-v5 up` from the worktree with HACK_NATIVE_PREPARED_BASE=require, so the frontend
     itself creates the pool from that base with the worktree as its exact project share.
  4. Healthy HTTPS and the committed source, prepared selection and share readback, a /data
     marker, `hack-v5 down` (the foreground exits 0).
  5. A host edit of the served file, `hack-v5 up` again: the same run in a new container,
     HTTPS serving exactly the edited source, and the retained marker.
  6. `hack-v5 down`, then disposal with readbacks: the pool stops (`process_alive: false`), the
     base is removed, no process or provider alias references the root, and only evidence
     remains.

With --domain-migration, before the final down: preview/apply the linked checkout's
legacy/OAuth routes, restart with the added local aliases, refuse rollback over a
file edit, restore the original files, and restart back to the original routes.
Run/owner/plan/volume bindings and the exact marker must survive both transitions.
This uses explicit-CA loopback HTTPS; it does not prove DNS or browser trust.

On any failure, or when --budget runs out, the driver issues no further commands and removes
nothing: the pool, its state and any live `hack up` foreground stay for diagnosis, and
evidence/failure.json records what happened. The only process it can terminate is one of its
own bounded commands: `subprocess.run` kills that direct child when its timeout expires. It
never signals a foreground, a VM or any other process.

Only the selections declared here reach the candidate: ambient HACK_NATIVE_* variables are
dropped, so another session's overrides cannot change what this run tests.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import sys
import time

COMPOSE = """services:
  web:
    image: {image}
    command: ["sh", "-c", "exec httpd -f -p 8080 -h /workspace"]
    working_dir: /workspace
    volumes:
      - "../:/workspace"
      - "data:/data"
    labels:
      caddy: {dev_host}
      caddy.reverse_proxy: "{{{{upstreams 8080}}}}"
      caddy.tls: internal
    healthcheck:
      x-hack-http: {{port: 8080, path: /index.txt, interval_ms: 1000, timeout_ms: 2000, retries: 20, start_period_ms: 1000}}
volumes:
  data: {{}}
"""
DEV_HOST = "frontend-accept.hack.local"


class Failure(RuntimeError):
    pass


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as file:
        for block in iter(lambda: file.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def git(*argv):
    """Git without system or global configuration, templates, hooks or signing."""
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": os.environ.get("HOME", "/"),
           "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull, "LC_ALL": "C"}
    result = subprocess.run(
        ["git", "-c", "init.templateDir=", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false",
         "-c", "user.name=Hack acceptance", "-c", "user.email=acceptance@example.invalid", *argv],
        env=env, capture_output=True, text=True, timeout=60)
    if result.returncode != 0:
        raise Failure(f"git {' '.join(argv)[:160]}: {result.stderr.strip()[-300:]}")
    return result.stdout.strip()


def lineage(listing):
    """This process and the processes that launched it, from `pid ppid args` rows."""
    parents = {}
    for line in listing.splitlines():
        fields = line.split(None, 2)
        if len(fields) >= 2 and fields[0].isdigit() and fields[1].isdigit():
            parents[int(fields[0])] = int(fields[1])
    own, pid = set(), os.getpid()
    while pid > 1 and pid not in own:
        own.add(pid)
        pid = parents.get(pid, 0)
    return own


def referencing(root, listing, own):
    """Rows outside `own` whose command line names `root`. The driver and its launchers name
    the root in their own arguments, so they alone are excluded."""
    hits = []
    for line in listing.splitlines():
        fields = line.split(None, 2)
        if len(fields) == 3 and fields[0].isdigit() and int(fields[0]) not in own and str(root) in fields[2]:
            hits.append(line.strip())
    return hits


def port_free(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        try:
            probe.bind(("127.0.0.1", port))
        except OSError:
            return False
    return True


class Acceptance:
    def __init__(self, args):
        self.args = args
        self.root = Path(args.root)
        self.evidence = self.root / "evidence"
        self.home = self.root / "home"
        self.store = self.root / "store"
        self.main = self.root / "main"
        self.project = self.root / "worktrees" / "app"
        self.branch = f"accept-{secrets.token_hex(3)}"
        self.domain_migration = getattr(args, "domain_migration", False)
        self.dev_host = "frontend-accept.hack" if self.domain_migration else DEV_HOST
        self.host = f"{self.branch}.{self.dev_host}"
        self.bundle = Path(args.bundle)
        self.native = self.bundle / "hack-native"
        self.frontend = self.bundle / "hack-v5"
        self.deadline = None
        # How long a route may take to serve the expected source.
        self.https_wait = 60
        self.foregrounds = []
        self.checks = []
        self.declared = {
            "HACK_NATIVE_HOME": str(self.home), "HACK_HOME": str(self.root / "cli-home"),
            "HACK_NATIVE_SHARED_SOURCE": "1", "HACK_NO_INTERACTIVE": "1", "HACK_LOGGER": "console",
            "HACK_NATIVE_CADDY_BINARY": args.caddy, "HACK_NATIVE_CADDY_SHA256": args.caddy_sha256 or "",
            "HACK_NATIVE_HTTPS_PORT": str(args.https_port),
            "HACK_NATIVE_PREPARED_BASE": "require", "HACK_NATIVE_PREPARED_BASE_STORE": str(self.store),
        }
        self.env = {k: v for k, v in os.environ.items() if not k.startswith("HACK_NATIVE_")}
        self.env.update(self.declared)

    def note(self, line):
        self.checks.append(line)
        print(line, flush=True)

    def check(self, name, value):
        if not value:
            raise Failure(name)
        self.note(f"PASS {name}")

    def remaining(self, timeout):
        left = self.deadline - time.monotonic()
        if left <= 0:
            raise Failure("live budget exhausted")
        return min(timeout, left)

    def command(self, label, argv, timeout=120, cwd=None):
        """Run one bounded command; keep its output as evidence; fail on a non-zero exit."""
        result = subprocess.run(argv, env=self.env, cwd=cwd or self.root, capture_output=True,
                                timeout=self.remaining(timeout))
        (self.evidence / f"{label}.stdout").write_bytes(result.stdout)
        (self.evidence / f"{label}.stderr").write_bytes(result.stderr)
        if result.returncode != 0:
            raise Failure(f"{label}: exit {result.returncode}: {(result.stdout + result.stderr).decode(errors='replace')[-600:]}")
        text = result.stdout.decode(errors="replace")
        return json.loads(text) if text.strip().startswith("{") else text

    def runtime(self, label, *argv, timeout=120):
        return self.command(label, [str(self.native), "--candidate-root", str(self.home), *argv], timeout)

    def cli(self, label, *argv, timeout=60):
        return self.command(label, [str(self.frontend), *argv], timeout, cwd=self.project)

    def fixture(self):
        (self.main / ".hack").mkdir(parents=True, mode=0o700)
        config = {"name": "frontend-accept", "dev_host": self.dev_host}
        hosts = self.dev_host
        if self.domain_migration:
            config["oauth"] = {"enabled": True}
            hosts = ", ".join(self.domain_hosts())
        (self.main / ".hack/hack.config.json").write_text(json.dumps(config))
        (self.main / ".hack/docker-compose.yml").write_text(COMPOSE.format(image=self.args.image, dev_host=hosts))
        (self.main / "package.json").write_text("{}\n")
        (self.main / "index.txt").write_text(f"committed-{secrets.token_hex(8)}\n")
        git("init", "--quiet", "--initial-branch=main", str(self.main))
        git("-C", str(self.main), "add", ".")
        git("-C", str(self.main), "commit", "--quiet", "-m", "fixture")
        self.project.parent.mkdir(mode=0o700)
        git("-C", str(self.main), "worktree", "add", "--quiet", "-b", self.branch, str(self.project), "main")
        # The runtime refuses a share that other users can write.
        self.project.chmod(0o700)
        common = git("-C", str(self.project), "rev-parse", "--path-format=absolute", "--git-common-dir")
        self.check("linked worktree registered on its own branch",
                   (self.project / ".git").is_file() and Path(common) == self.main / ".git"
                   and git("-C", str(self.project), "branch", "--show-current") == self.branch)

    def prepare(self):
        self.home.mkdir(mode=0o700)
        self.store.mkdir(mode=0o700)
        self.runtime("prepare", "runtime", "prepare", "--archive", self.args.provider_archive)
        self.runtime("prepare-engine", "runtime", "prepare-engine", "--archive", self.args.engine_archive)
        self.runtime("prepare-network-tools", "runtime", "prepare-network-tools", "--directory", self.args.network_tools)
        built = self.runtime("base-build", "runtime", "prepared-base", "build", "--profile", "development",
                             "--store", str(self.store), "--json", timeout=300)
        self.base = built["receipt"]["base_id"]
        self.runtime("base-verify", "runtime", "prepared-base", "verify", "--store", str(self.store),
                     "--base-id", self.base, "--json", timeout=300)
        status = self.runtime("base-status", "runtime", "prepared-base", "status", "--profile", "development",
                              "--store", str(self.store), "--json")
        self.check("one verified owned base and no abandoned work",
                   [(b["base_id"], b.get("verified")) for b in status["bases"]] == [(self.base, True)]
                   and status["abandoned_work"] == [])

    def up(self, label, previous_container=None, command="up"):
        with (self.evidence / f"{label}.stdout").open("wb") as out, (self.evidence / f"{label}.stderr").open("wb") as err:
            process = subprocess.Popen([str(self.frontend), command, "--path", str(self.project)], env=self.env,
                                       cwd=self.project, stdin=subprocess.DEVNULL, stdout=out, stderr=err)
        self.foregrounds.append((label, process))
        deadline = time.monotonic() + self.remaining(240)
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise Failure(f"{label} exited {process.returncode} before readiness")
            try:
                ps = self.cli(f"{label}-ps", "ps", "--path", str(self.project), "--branch", self.branch, "--json", timeout=20)
            except Failure:
                ps = {}
            ps = ps if isinstance(ps, dict) else {}
            items = ps.get("items") or []
            if (ps.get("status") == "observed" and ps.get("phase") == "ready-observed"
                    and items and items[0].get("container") != previous_container):
                return process, ps
            time.sleep(0.5)
        raise Failure(f"{label} readiness deadline")

    def fetch(self):
        """The served index.txt over HTTPS, trusting only this home's private Caddy root."""
        roots = sorted((self.home / "native-https").rglob("root.crt"))
        if not roots:
            return None
        result = subprocess.run(
            ["/usr/bin/curl", "--silent", "--show-error", "--fail", "--noproxy", "*", "--cacert", str(roots[0]),
             "--resolve", f"{self.host}:{self.args.https_port}:127.0.0.1",
             f"https://{self.host}:{self.args.https_port}/index.txt"], capture_output=True, timeout=8)
        return result.stdout.decode() if result.returncode == 0 else None

    def https(self, label, expected):
        deadline = time.monotonic() + self.remaining(self.https_wait)
        body = None
        while time.monotonic() < deadline:
            body = self.fetch()
            if body == expected:
                (self.evidence / f"{label}.https").write_text(body)
                return True
            time.sleep(0.3)
        (self.evidence / f"{label}.https").write_text(repr(body))
        return False

    def domain_hosts(self, migrated=False, branched=False):
        """The independent expected route set, including service and OAuth aliases."""
        base = f"{self.branch}.frontend-accept" if branched else "frontend-accept"
        suffixes = ["hack", "hack.gy", *(["hack.local"] if migrated else [])]
        return sorted(f"{prefix}{base}.{suffix}" for prefix in ("", "api.") for suffix in suffixes)

    def files(self, checkout):
        return {name: ((checkout / name).read_bytes(), (checkout / name).stat().st_mode & 0o777)
                for name in (".hack/hack.config.json", ".hack/docker-compose.yml")}

    def graph_bindings(self, label, run):
        receipt = self.runtime(label, "graph", "inspect", "--run-id", run, "--json")["receipt"]
        self.check(f"{label} inspects the selected ready run",
                   receipt["run"] == run and receipt["phase"] == "ready-observed")
        volumes = {key: value for key, value in receipt["resources"].items() if value["kind"] == "volume"}
        self.check(f"{label} has the retained data volume", len(volumes) == 1)
        routes = sorted(host for value in receipt["resources"].values()
                        for host in (value.get("routing") or {}).get("hostnames", []))
        return {"run": receipt["run"], "owner": receipt["owner"], "plan": receipt["plan_id"],
                "volumes": volumes}, routes

    def domain_routes(self, label, expected, hosts):
        previous = self.host
        try:
            for index, host in enumerate(hosts):
                self.host = host
                self.check(f"{label} serves exact source at {host}", self.https(f"{label}-{index}", expected))
        finally:
            self.host = previous

    def removed_route(self, host):
        """Accept an explicit TLS/HTTP route rejection, never a connection failure or timeout."""
        roots = sorted((self.home / "native-https").rglob("root.crt"))
        if len(roots) != 1:
            raise Failure("expected one private Caddy root")
        result = subprocess.run(
            ["/usr/bin/curl", "--silent", "--show-error", "--noproxy", "*", "--cacert", str(roots[0]),
             "--max-time", "8", "--resolve", f"{host}:{self.args.https_port}:127.0.0.1",
             "--write-out", "\n%{http_code}", f"https://{host}:{self.args.https_port}/index.txt"],
            capture_output=True, timeout=self.remaining(10))
        status = result.stdout.decode(errors="replace").rsplit("\n", 1)[-1]
        return result.returncode == 35 or (result.returncode == 0 and status in ("404", "421"))

    def domain_roundtrip(self, process, ps, expected, marker):
        """Exercise real file migration and retained runtime transitions in the linked checkout."""
        original, primary = self.files(self.project), self.files(self.main)
        baseline, routes = self.graph_bindings("domain-before", ps["run"])
        self.check("initial receipt has exactly the legacy and OAuth branch routes",
                   routes == self.domain_hosts(branched=True))
        self.domain_routes("domain-initial", expected, routes)
        preview = self.cli("domain-preview", "doctor", "--domain-migration", "preview", "--json")
        self.check("domain preview has no file effects", preview["status"] == "preview"
                   and self.files(self.project) == original)
        applied = self.cli("domain-apply", "doctor", "--domain-migration", "apply", "--json")
        self.check("domain migration applied the expected host", applied["status"] == "applied"
                   and applied["toHost"] == DEV_HOST)
        migrated_files = self.files(self.project)
        self.check("migration changes only the linked checkout", self.files(self.main) == primary)
        self.check("file application leaves running graph bindings unchanged",
                   self.graph_bindings("domain-applied-not-restarted", ps["run"]) == (baseline, routes))
        process, ps = self.domain_restart("domain-forward", process, ps, baseline, expected, marker, True)

        # Rollback must not overwrite a user edit, even when the running routes are valid.
        compose = self.project / ".hack/docker-compose.yml"
        compose.write_bytes(compose.read_bytes() + b"\n# independent edit\n")
        drifted = self.files(self.project)
        result = subprocess.run([str(self.frontend), "doctor", "--domain-migration", "rollback", "--json"],
                                cwd=self.project, env=self.env, capture_output=True, timeout=self.remaining(30))
        self.check("rollback refuses independent file drift without writing either file",
                   result.returncode != 0 and b"Project domain migration refused" in result.stdout + result.stderr
                   and self.files(self.project) == drifted)
        compose.write_bytes(migrated_files[".hack/docker-compose.yml"][0])
        rollback = self.cli("domain-rollback", "doctor", "--domain-migration", "rollback", "--json")
        self.check("rollback restores exact original bytes and modes", rollback["status"] == "restored"
                   and self.files(self.project) == original)
        process, ps = self.domain_restart("domain-reverse", process, ps, baseline, expected, marker, False)
        removed = sorted(set(self.domain_hosts(True, True)) - set(self.domain_hosts(False, True)))
        for host in removed:
            self.check(f"rollback stops serving removed route {host}", self.removed_route(host))
        # Bracket negative requests with a known live route; a dead proxy cannot make this pass.
        self.domain_routes("domain-after-negative", expected, self.domain_hosts(branched=True))
        self.check("primary checkout remains byte and mode identical", self.files(self.main) == primary)
        (self.evidence / "domain-roundtrip.json").write_text(json.dumps({
            "bindings": baseline, "removed_routes": removed, "branch": self.branch,
            "inferred_branch": True, "browser_verified": False, "dns_verified": False,
            "primary_unchanged": True, "original_files_restored": True}, indent=2))
        return process, ps

    def domain_restart(self, label, previous, ps, baseline, expected, marker, migrated):
        process, current = self.up(label, previous_container=ps["items"][0]["container"], command="restart")
        self.check(f"{label} retired its previous foreground", previous.wait(timeout=self.remaining(60)) == 0)
        bindings, routes = self.graph_bindings(f"{label}-bindings", current["run"])
        self.check(f"{label} retains run, ownership and exact volume bindings", bindings == baseline)
        self.check(f"{label} publishes exactly the expected branch routes",
                   routes == self.domain_hosts(migrated, True))
        self.domain_routes(label, expected, routes)
        read = self.cli(f"{label}-marker", "exec", "web", "--", "/bin/busybox", "cat", "/data/marker")
        self.check(f"{label} retains the exact data marker", read.strip() == marker)
        return process, current

    def down(self, label, process):
        self.cli(label, "down", "--path", str(self.project), "--branch", self.branch, timeout=120)
        try:
            return process.wait(timeout=self.remaining(60))
        except subprocess.TimeoutExpired:
            raise Failure(f"{label}: foreground still running after down") from None

    def accept(self):
        self.fixture()
        self.prepare()
        committed = (self.project / "index.txt").read_text()
        first, ps1 = self.up("up-first")
        status = self.runtime("pool-status", "runtime", "status", "--json")
        selection = (status.get("prepared_base") or {}).get("selection") or {}
        self.check("the frontend created the pool from the verified base",
                   selection.get("source") == "prepared" and selection.get("base_id") == self.base
                   and (status.get("prepared_base") or {}).get("activation") == "consumed")
        self.check("the pool shares exactly the worktree root",
                   (status.get("project_share") or {}).get("project") == str(self.project))
        self.check("first HTTPS serves the committed source", self.https("first", committed))
        marker = f"retained-{secrets.token_hex(8)}"
        self.cli("marker-write", "exec", "--branch", self.branch, "--path", str(self.project), "web", "--",
                 "/bin/busybox", "sh", "-c", f"echo {marker} > /data/marker")
        self.check("first foreground exits 0 after down", self.down("down-1", first) == 0)

        edited = f"edited-{secrets.token_hex(8)}\n"
        (self.project / "index.txt").write_text(edited)
        second, ps2 = self.up("up-second", previous_container=ps1["items"][0]["container"])
        self.check("second up restores the same run in a new container",
                   ps2.get("run") == ps1.get("run") and ps2["items"][0]["container"] != ps1["items"][0]["container"])
        self.check("second HTTPS serves exactly the edited source", self.https("second", edited))
        read = self.cli("marker-read", "exec", "--branch", self.branch, "--path", str(self.project), "web", "--",
                        "/bin/busybox", "cat", "/data/marker")
        self.check("the /data marker is retained across down, edit and up", marker in read)
        if self.domain_migration:
            second, ps2 = self.domain_roundtrip(second, ps2, edited, marker)
        self.check("second foreground exits 0 after down", self.down("down-2", second) == 0)
        return {"run": ps1.get("run"), "containers": [ps1["items"][0]["container"], ps2["items"][0]["container"]],
                "base_id": self.base, "branch": self.branch, "origin": f"https://{self.host}:{self.args.https_port}",
                "machine": status.get("machine")}

    def dispose(self):
        """Owned disposal with readbacks. Any refusal keeps the remaining state."""
        self.runtime("dispose-down", "runtime", "down", "--json", timeout=180)
        status = self.runtime("dispose-status", "runtime", "status", "--json")
        if status.get("process_alive") is not False:
            raise Failure(f"pool not confirmed stopped: {json.dumps(status)[:300]}")
        owner = self.home / ".hack-local/run/smolvm/owner.json"
        alias = Path(json.loads(owner.read_text())["short_home"]) if owner.exists() else None
        self.runtime("base-remove", "runtime", "prepared-base", "remove", "--base-id", self.base,
                     "--store", str(self.store), "--json")
        bases = self.runtime("base-removed-status", "runtime", "prepared-base", "status", "--profile", "development",
                             "--store", str(self.store), "--json")
        if bases["bases"] or bases["abandoned_work"]:
            raise Failure(f"store not empty after removal: {bases}")
        listing = subprocess.run(["ps", "-A", "-ww", "-o", "pid=,ppid=,args="], capture_output=True, text=True)
        others = referencing(self.root, listing.stdout, lineage(listing.stdout)) if listing.returncode == 0 else None
        if others is None or others:
            raise Failure(f"a process may still reference the acceptance root: {others}")
        if alias and alias.is_symlink():
            if not os.readlink(alias).startswith(str(self.home) + "/"):
                raise Failure(f"provider alias {alias} does not point into this home")
            alias.unlink()
        for path in (self.home, self.root / "cli-home", self.store, self.main, self.project.parent):
            if path.exists():
                shutil.rmtree(path)
        left = sorted(p.name for p in self.root.iterdir())
        if left != ["evidence"] or (alias and os.path.lexists(alias)):
            raise Failure(f"disposal left {left}, alias present={bool(alias and os.path.lexists(alias))}")
        return {"pool_stopped": True, "base_removed": self.base, "alias_removed": str(alias) if alias else None,
                "root_left": left}

    def run(self):
        self.evidence.mkdir(mode=0o700)
        (self.evidence / "preflight.json").write_text(json.dumps({
            "declared_env": self.declared, "branch": self.branch, "budget_s": self.args.budget,
            "bundle_sha256": {p.name: sha256(p) for p in sorted(self.bundle.iterdir()) if p.is_file()},
            "free_disk_bytes": shutil.disk_usage(self.root).free}, indent=2))
        self.deadline = time.monotonic() + self.args.budget
        try:
            accepted = self.accept()
            accepted["disposal"] = self.dispose()
            accepted["checks"] = self.checks
            (self.evidence / "acceptance.json").write_text(json.dumps(accepted, indent=2))
            self.note("PASS owned pool, base, alias, fixture and home removed; evidence retained")
            return 0
        except (Failure, subprocess.TimeoutExpired, OSError, ValueError, KeyError) as failure:
            (self.evidence / "failure.json").write_text(json.dumps({
                "failure": f"{type(failure).__name__}: {failure}", "checks": self.checks,
                "live_foregrounds": [(label, p.pid) for label, p in self.foregrounds if p.poll() is None],
                "note": "no further commands; nothing removed; foregrounds and the pool were not signalled"},
                indent=2))
            print(f"FAILED: {failure}", flush=True)
            return 1


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--bundle", required=True, help="absolute candidate bundle directory (hack-v5, hack-native)")
    parser.add_argument("--root", required=True, help="absolute private (0700) empty directory owned by this user")
    parser.add_argument("--provider-archive", required=True)
    parser.add_argument("--engine-archive", required=True)
    parser.add_argument("--network-tools", required=True, help="directory of pinned network-tool packages")
    parser.add_argument("--image", required=True, help="pinned image reference (repository@sha256:...)")
    parser.add_argument("--caddy", required=True, help="absolute Caddy executable for native HTTPS")
    parser.add_argument("--https-port", type=int, required=True, help="unprivileged loopback HTTPS port")
    parser.add_argument("--budget", type=float, default=600.0, help="live-test budget in seconds")
    parser.add_argument("--domain-migration", action="store_true",
                        help="also verify legacy/OAuth aliases, retained migration and rollback in the linked worktree")
    parser.add_argument("--run", action="store_true", help="execute; without it only the plan is printed")
    args = parser.parse_args()
    for name in ("bundle", "root", "provider_archive", "engine_archive", "network_tools", "caddy"):
        if not os.path.isabs(getattr(args, name)):
            parser.error(f"--{name.replace('_', '-')} must be absolute")
    if "@sha256:" not in args.image:
        parser.error("--image must be pinned by digest")
    if not 1024 <= args.https_port <= 65535:
        parser.error("--https-port must be unprivileged")
    args.caddy_sha256 = sha256(args.caddy) if os.path.isfile(args.caddy) else None
    plan = {"bundle": args.bundle, "root": args.root, "https_port": args.https_port, "budget_s": args.budget,
            "domain_migration": args.domain_migration, "browser_verified": False,
            "image": args.image, "caddy": args.caddy, "caddy_sha256": args.caddy_sha256,
            "sequence": ["fixture", "prepare home", "build+verify base", "up (prepared, require)", "https committed",
                         "marker", "down", "host edit", "up (same run)", "https edited", "marker readback",
                         "down", "dispose"]}
    if args.domain_migration:
        plan["sequence"][-2:-2] = ["domain preview/apply", "retained restart and every alias",
                                   "rollback drift refusal", "exact file rollback", "retained reverse restart",
                                   "removed alias refusal with live positive control"]
    if not args.run:
        print(json.dumps({"preview": plan}, indent=2))
        return 0
    root = Path(args.root)
    if (not root.is_dir() or root.stat().st_mode & 0o077 or root.stat().st_uid != os.geteuid()
            or any(root.iterdir())):
        parser.error("--root must be an existing empty private (0700) directory owned by this user")
    if args.caddy_sha256 is None:
        parser.error("--caddy must be an existing executable")
    if not port_free(args.https_port):
        parser.error(f"port {args.https_port} is in use")
    return Acceptance(args).run()


if __name__ == "__main__":
    sys.exit(main())
