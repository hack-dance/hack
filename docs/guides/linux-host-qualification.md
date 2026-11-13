# Qualify a fresh Linux host

This runbook checks, on a clean Linux host, the Linux pieces that
[Linux host setup](linux-setup.md) describes: the DNS route on Hack's Docker
bridge, certificate trust, and the `hackd` systemd user service. It also checks
what happens to them when Docker recreates the network and when the host
reboots. Those last two have so far been covered only by unit tests with fake
system tools; this runbook is how a person checks them on a real host.

One person can run it in about 30 minutes on a host that is already
provisioned. Every step is a command to paste, then something to look at. The
[pass criteria](#pass-criteria) say what counts as a pass. Write the results
into the [result record](#result-record).

It tests the CLI built from an exact commit of the `next` branch. v5
prerelease bundles are published for Apple Silicon macOS only, so on Linux you
build `hack` from source.

## The host

Use a disposable virtual machine. The runbook changes system files (a udev
rule, a systemd unit, the CA trust store) and reboots the host.

- **OS:** Ubuntu Server 24.04 LTS, x86_64 or arm64, fresh install. The server
  image resolves names through systemd-resolved's stub at `127.0.0.53` and does
  not route `.local` names to mDNS, which is the case Hack's route supports
  directly. Other distributions and desktop images are outside this runbook;
  see [what this does not cover](#what-this-does-not-cover).
- **Size:** at least 2 vCPUs, 4 GB of memory and 20 GB of free disk.
- **Access:** a non-root user with `sudo`, reached over SSH. Keep a console
  (the provider's web or serial console) available in case the network does
  not come back after the reboot.
- **Docker:** Docker Engine installed as a system service, as in step 1. Not
  Docker Desktop and not rootless Docker: in both, the bridge is out of the
  host's reach, and Hack reports `linux_dns_bridge_missing`.

## Timeline

| Step | What | About |
| --- | --- | --- |
| 1 | Install packages, log in again | 4 min |
| 2 | Build and install `hack` | 5 min |
| 3 | Set up DNS, trust and the daemon | 6 min |
| 4 | Check the setup (baseline) | 3 min |
| 5 | Recreate the Docker network | 3 min |
| 6 | Reboot and check again | 6 min |
| 7 | Clean up (optional) | 3 min |

## 1. Install packages

Record what you are testing, then install Docker and the tools the runbook
uses:

```sh
export HACK_SHA=<full 40-character commit SHA on next>
sudo apt-get update
sudo apt-get install -y docker.io docker-compose-v2 git jq curl unzip
sudo usermod -aG docker "$USER"
```

Log out and log back in over SSH, so the `docker` group applies and Ubuntu's
`~/.profile` adds `~/.local/bin` to `PATH` (it does so when the directory
exists at login, so create it first):

```sh
mkdir -p ~/.local/bin
exit
```

After you log back in, set `HACK_SHA` again and record the host:

```sh
export HACK_SHA=<the same SHA>
. /etc/os-release && echo "$PRETTY_NAME"
uname -srm
systemctl --version | head -1
docker version --format 'docker {{.Server.Version}}'
docker compose version
readlink -f /etc/resolv.conf
grep '^hosts:' /etc/nsswitch.conf
echo "$PATH" | tr ':' '\n' | grep -c "$HOME/.local/bin"
```

Expect `/run/systemd/resolve/stub-resolv.conf` from `readlink`, and a count of
at least `1` from the last line. If `docker version` fails with a permission error, the
group change has not applied: log out and in again.

## 2. Build and install `hack`

Clone the exact commit, install the Bun version the repository pins, and build:

```sh
git clone --filter=blob:none https://github.com/hack-dance/hack.git ~/hack-src
git -C ~/hack-src checkout --detach "$HACK_SHA"
git -C ~/hack-src rev-parse HEAD
BUN_VERSION=$(jq -r '.packageManager | sub("^bun@"; "")' ~/hack-src/package.json)
curl -fsSL https://bun.sh/install | bash -s "bun-v$BUN_VERSION"
cd ~/hack-src
~/.bun/bin/bun install --frozen-lockfile
~/.bun/bin/bun run build
install -m 0755 dist/hack ~/.local/bin/hack
cd ~
command -v hack
hack --version
```

`git rev-parse HEAD` must print `HACK_SHA`. `command -v hack` must print
`~/.local/bin/hack` (as an absolute path): `hack daemon install` writes the
path of the `hack` it finds on `PATH` into the unit. The binary is a copy, so
the checkout can change later without affecting the unit.

## 3. Set up DNS, trust and the daemon

Run these in an interactive SSH session, not a script: Hack asks before every
root step, and a run that cannot prompt changes nothing.

```sh
hack global install
```

Answer yes to the DNS route step (it shows the files it writes and the
commands), and to certificate trust if it offers it. Expect exit code 0 and the
log line `Linux DNS result: configured`.

```sh
hack global trust
```

Answer yes. It adds Caddy's local root CA to the Ubuntu trust store
(`/usr/local/share/ca-certificates/hack-caddy-local-ca.crt`, then
`update-ca-certificates`). If it reports that the CA is already trusted, go on.

```sh
hack daemon install
sudo loginctl enable-linger "$USER"
loginctl show-user "$USER" -p Linger
```

Expect `Linger=yes`. Linger makes your systemd user manager, and so `hackd`,
start at boot rather than at your first login. Hack never turns it on itself.

## 4. Check the setup (baseline)

Save this snapshot script. Every later check runs it, and it saves its
output to a file named after the label. It runs the systemd checks before any
`hack` command, so the systemd state it shows is what systemd started on its
own.

```sh
cat > ~/hack-qual-snapshot.sh <<'EOF'
#!/bin/sh
# Usage: sh ~/hack-qual-snapshot.sh LABEL
label=${1:?usage: hack-qual-snapshot.sh LABEL}
{
echo "== $label $(date -u +%Y-%m-%dT%H:%M:%SZ) boot_id=$(cat /proc/sys/kernel/random/boot_id)"
echo "-- hackd (systemd, before any hack command)"
systemctl --user show hackd.service -p ActiveState -p SubState -p MainPID -p ActiveEnterTimestamp -p NRestarts
loginctl show-user "$USER" -p Linger
if [ -n "${XDG_SESSION_ID:-}" ]; then
  loginctl show-session "$XDG_SESSION_ID" -p Timestamp
else
  echo "session Timestamp=unknown (no XDG_SESSION_ID)"
fi
echo "-- bridge"
link=$(ip -o -4 addr show | awk '$4 ~ /^172\.30\.0\.1\// {print $2; exit}')
echo "bridge=${link:-none}"
if [ -n "$link" ]; then
  resolvectl dns "$link"
  resolvectl domain "$link"
  resolvectl default-route "$link"
  systemctl show "hack-dns@$link.service" -p Result -p ExecMainStatus -p ExecMainExitTimestamp
fi
echo "-- proxy containers"
docker ps -a --filter label=com.docker.compose.project=hack-dev-proxy --format '{{.Names}} {{.Status}}'
echo "-- lookups"
getent hosts schemas.hack || echo "schemas.hack: no answer"
if getent hosts example.com >/dev/null; then echo "example.com: resolves"; else echo "example.com: no answer"; fi
curl -sS -o /dev/null -w 'https://schemas.hack/hack.config.schema.json -> HTTP %{http_code}\n' \
  https://schemas.hack/hack.config.schema.json || echo "curl failed"
echo "-- hack"
command -v hack
hack --version
hack global status --json | jq -c '{host_dns: .host_dns, summary: .summary}'
hack daemon status --json | jq -c '{running, api_ok, pid, managed_by, service}'
hack doctor --json | jq -c '.data.checks[] | select(.id == "linux dns route" or .id == "daemon service" or .id == "daemon") | {id, status, detail}'
} 2>&1 | tee "$HOME/hack-qual-$label.txt"
EOF
sh ~/hack-qual-snapshot.sh baseline
```

Check the output against [baseline](#baseline). If `service.owns_daemon` is
`false` (the running `hackd` was started directly, not by systemd), run
`hack daemon restart` once, note that you needed it, and run the snapshot again
as `baseline2`.

Then check that systemd restarts `hackd` after a crash. This sends `SIGKILL`
to the service's processes only; it does not touch anything else:

```sh
systemctl --user show hackd.service -p NRestarts -p MainPID
systemctl --user kill --signal=SIGKILL hackd.service
sleep 5
systemctl --user show hackd.service -p NRestarts -p MainPID -p ActiveState
```

Expect `NRestarts` one higher, a new `MainPID` and `ActiveState=active`.

## 5. Recreate the Docker network

Docker gives the `hack-dev` bridge a new interface name (`br-<network id>`)
each time it creates the network. Only `hack global install` applies the route
itself; `hack global up` does not. So after the steps below, the only thing
that can put the route on the new bridge is Hack's udev rule.

```sh
grep '^bridge=' ~/hack-qual-baseline.txt
hack global down
```

When `hack global down` offers to remove the DNS route, answer **no** (the
default). Then:

```sh
docker network rm hack-dev
hack global up
sleep 15
sh ~/hack-qual-snapshot.sh recreated
```

Do not run `hack global install` in this step. If `docker network rm` reports
active endpoints, record the output of
`docker network inspect hack-dev --format '{{range .Containers}}{{.Name}} {{end}}'`
and stop: the runbook's assumption that nothing else uses the network does not
hold on this host.

## 6. Reboot and check again

```sh
sudo reboot
```

Wait about a minute, then log in over SSH. **Run the snapshot before any other
`hack` command**, so a `hack` command cannot start `hackd` or the proxy first:

```sh
sh ~/hack-qual-snapshot.sh rebooted
```

Hack's proxy and DNS containers (Caddy and CoreDNS) have no Docker restart
policy, so they are expected to be stopped after a reboot. The `hack-dev`
network still exists, and Docker normally creates its bridge when it starts,
even with no container running; the route should then already be on it. Record
what you see, then start the containers and take a last snapshot:

```sh
hack global up
sleep 15
sh ~/hack-qual-snapshot.sh rebooted-up
```

Keep the four or five `~/hack-qual-*.txt` files: they are the evidence. They
contain no secrets; they do contain this host's IP addresses and your user
name, so review them before attaching them anywhere public.

## Pass criteria

Each row is one check. The run passes when every row passes. A row that
cannot be checked (for example the console showed the host did not boot) is a
fail with a note, not a skip.

### Baseline

| ID | Check | Pass |
| --- | --- | --- |
| P1 | `hack global install` | Exit code 0 and `Linux DNS result: configured` |
| P2 | Bridge route | `bridge=br-…`; `resolvectl dns` lists only `172.30.0.53`; `resolvectl domain` lists `~hack ~hack.local ~hack.gy` (and `~<default_domain>` if you set one); `default-route` is `no` |
| P3 | Hack's own view | `host_dns.state` is `configured`; doctor `linux dns route` is `ok` |
| P4 | Name lookups | `schemas.hack` answers `172.30.0.2`; `example.com: resolves` (ordinary DNS still works) |
| P5 | TLS | The `curl` line prints `HTTP 200` and no `curl failed`; a certificate error means trust did not apply |
| P6 | Daemon service | `ActiveState=active`; `managed_by` is `"systemd"`; doctor `daemon service` is `ok`; `service.summary` starts with `installed, enabled, active` |
| P7 | Crash restart | After `SIGKILL`, `NRestarts` went up by one and `hackd.service` is active again with a new `MainPID` |

### Network recreated

| ID | Check | Pass |
| --- | --- | --- |
| R1 | New bridge | `bridge=` names a different interface than in `baseline` |
| R2 | Route reapplied without `hack global install` | The P2 values hold on the new bridge; `hack-dns@<new bridge>.service` shows `Result=success` and `ExecMainStatus=0` |
| R3 | Hack's own view and lookups | P3, P4 and P5 hold |

### After reboot

| ID | Check | Pass |
| --- | --- | --- |
| B1 | `hackd` started at boot | In `rebooted`, `ActiveState=active`, and its `ActiveEnterTimestamp` is earlier than the session `Timestamp` (it started before you logged in) |
| B2 | Route at boot | In `rebooted`, with no `hack` command run since boot: the P2 values hold on the bridge, and `hack-dns@<bridge>.service` shows `Result=success`. If `rebooted` shows `bridge=none`, Docker had not created the bridge yet; record that, and B4 decides whether the route followed the bridge when it appeared |
| B3 | Containers | Recorded either way. Stopped is the expected state today (no restart policy); it is not a fail |
| B4 | Everything after `hack global up` | In `rebooted-up`, P2 to P6 hold, still without running `hack global install` |

If B2 fails but B4 passes, note it: the route then depends on something
`hack global up` does, not on the boot. If P2 to P5 fail in `rebooted-up`,
run `hack doctor` and record its `linux dns route` code; the table in
[Check and remove](linux-setup.md#check-and-remove) says what each code means.

## Result record

Copy this into the issue or PR that asked for the qualification. Use the
values from your snapshots, not from this page.

```text
Linux host qualification
Commit:            <HACK_SHA>
hack --version:    <output>
Bun:               <BUN_VERSION>
OS:                <PRETTY_NAME>, <uname -srm>
systemd:           <systemctl --version first line>
Docker:            <server version>, <compose version>
Resolver:          <readlink -f /etc/resolv.conf>; <hosts: line>
Date (UTC):        <date>

P1 <pass|fail>  P2 <...>  P3 <...>  P4 <...>  P5 <...>  P6 <...>  P7 <...>
R1 <...>  R2 <...>  R3 <...>
B1 <...>  B2 <...>  B3 <stopped|running>  B4 <...>
Needed `hack daemon restart` after install: <yes|no>
Notes: <anything unexpected, with the snapshot file and line>
```

## Clean up

On a disposable VM, deleting the VM is enough. To return the same host to its
starting state instead:

```sh
hack daemon uninstall
sudo loginctl disable-linger "$USER"
hack global down
```

Answer **yes** when `hack global down` offers to remove the DNS route. It
deletes only files that carry Hack's marker and reverts only the bridge's
settings that are exactly Hack's. The CA stays in the trust store; to remove it,
see [Linux certificate trust](linux-certificate-trust.md).

## What this does not cover

A pass qualifies the tested commit on this host type for the steps above. It
does not cover:

- other distributions (Fedora, Arch, openSUSE) or desktop images, including a
  `hosts:` line with `mdns4_minimal [NOTFOUND=return]`, which sends `.local`
  names to mDNS before systemd-resolved;
- hosts where resolved is bypassed or not used (`linux_dns_resolved_bypassed`,
  `linux_dns_resolver_manual`), Docker Desktop or rootless Docker;
- a restart of `systemd-resolved` on its own, without a reboot or a new bridge;
- a host without linger, where `hackd` starts at the first login instead of at
  boot;
- browser trust stores, project workloads, or the installers and release
  packages: the binary here is built from source.
