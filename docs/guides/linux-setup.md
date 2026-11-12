# Linux host setup

`hack global install` starts Hack's proxy (Caddy) and DNS server (CoreDNS) on the
`hack-dev` Docker network. On Linux, three host pieces sit outside Docker:

1. **DNS**: routing Hack's suffixes (`*.hack`, `*.hack.local`, `*.hack.gy` and a
   custom `default_domain`) to CoreDNS.
2. **Trust**: making the host trust Caddy's local CA, so `https://` URLs work.
3. **The daemon service**: optional; see [`hack daemon`](../cli.md).

Hack never runs `sudo` without asking. It uses only the system `sudo`
(`/usr/bin/sudo` or `/bin/sudo`, a root-owned setuid file in root-owned
directories), never one found on your `PATH`, with a fixed system `PATH` for the
root commands. Every root step is shown first, with the
files it writes and the exact commands; it runs only after you answer yes in a
terminal. A run that cannot prompt (no TTY, `HACK_NO_INTERACTIVE=1` or
`--no-interactive`) changes nothing and prints the commands with a stable code.

`hack global install` exits 0 when the DNS route is configured, and also when you
declined or the run could not prompt (it then prints the steps). It exits 1 when
a root step you confirmed failed, naming that step. The log line
`Linux DNS result:` says `configured`, `skipped` or `failed`.

## DNS

Hack detects how the host resolves names and acts on the result:

| Resolver | What Hack does |
| --- | --- |
| systemd-resolved, `/etc/resolv.conf` points at its stub (`127.0.0.53`) | Installs the route below |
| systemd-resolved, reached through `/etc/nsswitch.conf` (`hosts: ... resolve`) | Installs the route below |
| systemd-resolved running but bypassed (neither of the above) | Installs the route, which has no effect until lookups reach resolved, and prints dnsmasq-style forwarding lines for the resolver you do use (`linux_dns_resolved_bypassed`). See [Switching resolvers](#switching-resolvers) |
| NetworkManager with `dns=dnsmasq` | Prints the lines for `/etc/NetworkManager/dnsmasq.d/hack.conf` and the reload command (`linux_dns_resolver_manual`) |
| Plain `/etc/resolv.conf`, or none | Leaves the resolver alone and prints dnsmasq-style lines that forward Hack's suffixes to CoreDNS, for a resolver you run (`linux_dns_resolver_manual`). See [Switching resolvers](#switching-resolvers) |

`/etc/nsswitch.conf` counts as reaching resolved only when an uncommented
`hosts:` line lists `resolve` before `dns` with no earlier `[...=return]` action.

### The systemd-resolved route

Hack adds a per-link DNS route on the Docker bridge that carries the `hack-dev`
gateway address (`172.30.0.1`): the link's DNS server is CoreDNS (`172.30.0.53`),
its routing-only domains are Hack's suffixes (`~hack ~hack.local ~hack.gy`), and
it is not a default route. Only lookups for Hack's suffixes reach CoreDNS;
everything else keeps your normal DNS, VPN split DNS included.

Docker names that bridge `br-<network id>`, and the name changes whenever the
network is recreated. Hack therefore installs two files that never name it.
Hack configures interface names made of letters, digits, `_`, `.` and `-` (not
starting with `-` or `.`, at most 15 characters), which covers Docker's own
names; for any other name it prints the `resolvectl` commands to run by hand
(`linux_dns_interface_unsupported`), which last until the bridge is recreated.

- `/etc/udev/rules.d/90-hack-dns.rules` starts `hack-dns@<interface>.service`
  whenever a bridge interface appears;
- `/etc/systemd/system/hack-dns@.service` first applies the same interface-name
  rule itself, then waits up to about ten seconds for the gateway address on
  that interface and exits without changes on every other bridge. On Hack's bridge it runs `resolvectl dns`, `resolvectl domain`,
  `resolvectl default-route no`, `resolvectl dnssec no` and
  `resolvectl dnsovertls no` (CoreDNS serves plain DNS).

The design re-applies the route whenever Docker creates the bridge: after a
reboot, and after the network is removed and recreated. Hack also starts the
unit once for the current bridge. Neither reboot nor network recreation has
been verified on a real host yet; the evidence so far is unit tests with fake
`resolvectl`, `ip` and root runner, and static checks of the unit and rule
(`systemd-analyze verify`, `udevadm verify`).

Each confirmed repair runs the whole sequence: install the files if they differ,
then `systemctl daemon-reload`, `udevadm control --reload` and a restart of the
unit, so a retry after a failed reload repeats the reload.

Root never opens a file you can write. Hack sends each file's content to the
root step on standard input; root accepts exactly the declared number of bytes
(longer or shorter input is refused) within 30 seconds, checks them against the
SHA-256 digest of the content you were shown, writes a root-owned temporary file
in the destination directory and renames it into place. The destination
directory and every directory above it must be root-owned, not writable by
others and not links; if the ownership check itself cannot run, the step is
refused. A missing directory is created only after that check. Nothing is
staged in your home or `/tmp`.

The route counts as configured only when both files match, the bridge carries
exactly Hack's settings (CoreDNS as its only server, exactly Hack's suffixes,
default-route, DNSSEC and DNS-over-TLS off, as read back from the link) and
systemd reports no pending reload for the unit. Anything else is a repair.

It needs systemd 240 or later, `resolvectl`
and `ip`; on older systemd Hack reports `linux_dns_systemd_too_old` and prints
a dnsmasq alternative. Docker Desktop and rootless Docker keep the bridge out of
the host's reach, so Hack reports `linux_dns_bridge_missing` and writes nothing.

If `hack global install` could not prompt, it printed the commands as one block
without any prefix. Each file is installed by the same root step Hack runs
itself (byte count, digest, directory checks, rename into place), with the
file's content as a heredoc; paste the block into a shell as it is, then check
with `hack doctor`. A later `default_domain` change makes the installed unit
stale; rerun `hack global install` to update it.

### Check and remove

`hack doctor` reports the route as `linux dns route`, and `hack global status`
shows it under **Host DNS** (`host_dns` in `--json`). The codes are:

| Code | Meaning | Fix |
| --- | --- | --- |
| `linux_dns_route_missing` | Neither file is installed | `hack global install` |
| `linux_dns_route_stale` | A file is missing or differs (for example after a `default_domain` change) | `hack global install` |
| `linux_dns_route_not_applied` | Files are current, but the bridge does not carry exactly Hack's route (CoreDNS as its only server, exactly Hack's suffixes, default-route, DNSSEC and DNS-over-TLS off) | `hack global install` |
| `linux_dns_reload_pending` | The bridge matches, but systemd has not loaded the current unit (a reload is pending, or its state is unknown) | `hack global install` |
| `linux_dns_bridge_missing` | No host interface carries `172.30.0.1`: the network is down, or Docker runs in a VM (Docker Desktop) or rootless | `hack global up`; not supported on Docker Desktop or rootless Docker |
| `linux_dns_systemd_too_old` | systemd is older than 240 | Upgrade systemd, or use the printed dnsmasq lines |
| `linux_dns_resolved_bypassed` | The route exists, but lookups skip systemd-resolved | Forward the suffixes from the resolver you use, or see [Switching resolvers](#switching-resolvers) |
| `linux_dns_resolver_manual` | The host does not use systemd-resolved | Follow the printed steps |
| `linux_dns_interface_unsupported` | Hack's bridge has a name outside the configurable set | Run the printed `resolvectl` commands |

`hack global down` offers to remove the route (the Linux counterpart of stopping
dnsmasq on macOS). It defaults to no. It deletes a file at Hack's fixed path only
when its first line is Hack's marker with a format this Hack knows
(`# Managed by hack (hack global install), format=2. ...`; files from older
Hack versions carry the same line without `format=`), so an upgrade does not
strand an older file. A file with a format this Hack does not know (written by
a newer Hack) is reported and left in place. It reverts the bridge's
resolver settings when its DNS servers are exactly Hack's CoreDNS; because
`resolvectl revert` clears every per-link setting, the confirmation lists any
setting on that link that is not Hack's first. A file without the marker, or a
bridge with other DNS servers next to CoreDNS, is left in place, and Hack prints
what it found and the command to remove it by hand.

### Switching resolvers

Hack never changes which resolver your host uses, and its printed steps never
replace `/etc/resolv.conf`. If you decide to move a host to systemd-resolved,
or to point a bypassed `/etc/resolv.conf` at its stub, these are the risks to
handle first:

- A static `/etc/resolv.conf` may be the only place your upstream nameservers
  and search domains are configured. systemd-resolved can show them while it
  runs (it imports them), but once `/etc/resolv.conf` is replaced by the stub
  link they are gone after the next restart or reboot. Configure them in
  resolved itself first (`DNS=` and `Domains=` in `/etc/systemd/resolved.conf`
  or a drop-in, or your network manager), restart it, and confirm with
  `resolvectl status` that they appear for the right link.
- Keep a copy of the current file (`sudo cp -P /etc/resolv.conf
  /etc/resolv.conf.before-switch`) so you can restore it.
- After switching, check an ordinary name and a private name you depend on
  (`getent hosts example.com`), not only a Hack name. If anything fails,
  restore the copy.
- VPN clients and container runtimes may manage `/etc/resolv.conf` themselves;
  check their documentation before replacing it.

### Why a per-link route

- A global `resolved.conf.d` drop-in (`DNS=172.30.0.53`, `Domains=~hack ...`) is a
  single file, but systemd-resolved always uses global servers as a default
  route, so every lookup on the host would also go to CoreDNS. Docker can then
  copy that server into its upstream list and loop lookups back through CoreDNS.
- Publishing CoreDNS on a loopback port has the same default-route problem, and
  `127.0.0.53:53` already belongs to the resolved stub.
- A NetworkManager dispatcher hook that runs `resolvectl` for one named bridge
  breaks as soon as Docker recreates the network under a new name.

## TLS trust

`hack global trust` exports Caddy's local root CA and prepares Hack's host trust
bundle for Bun, Node, curl and git. Adding the root to the distribution trust
store and to browsers is a separate step; this section will cover it per
distribution family. Until then, `hack global trust` prints the Debian/Ubuntu
commands.

## Daemon

The optional `hack daemon` speeds up JSON status. See the [CLI overview](../cli.md)
and `hack daemon --help` for the service options on this platform.
