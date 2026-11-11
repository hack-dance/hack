# Linux host setup

`hack global install` starts Hack's proxy (Caddy) and DNS server (CoreDNS) on the
`hack-dev` Docker network. On Linux, three host pieces sit outside Docker:

1. **DNS**: routing Hack's suffixes (`*.hack`, `*.hack.local`, `*.hack.gy` and a
   custom `default_domain`) to CoreDNS.
2. **Trust**: making the host trust Caddy's local CA, so `https://` URLs work.
3. **The daemon service**: optional; see [`hack daemon`](../cli.md).

Hack never runs `sudo` without asking. Every root step is shown first, with the
files it writes and the exact commands; it runs only after you answer yes in a
terminal. A run that cannot prompt (no TTY, `HACK_NO_INTERACTIVE=1` or
`--no-interactive`) changes nothing and prints the commands with a stable code.

## DNS

Hack detects how the host resolves names and acts on the result:

| Resolver | What Hack does |
| --- | --- |
| systemd-resolved, `/etc/resolv.conf` points at its stub (`127.0.0.53`) | Installs the route below |
| systemd-resolved, reached through `/etc/nsswitch.conf` (`hosts: ... resolve`) | Installs the route below |
| systemd-resolved running but bypassed (neither of the above) | Installs the route and tells you to point `/etc/resolv.conf` at the stub (`linux_dns_resolved_bypassed`) |
| NetworkManager with `dns=dnsmasq` | Prints the lines for `/etc/NetworkManager/dnsmasq.d/hack.conf` and the reload command (`linux_dns_resolver_manual`) |
| Plain `/etc/resolv.conf`, or none | Prints how to enable systemd-resolved, or a dnsmasq alternative (`linux_dns_resolver_manual`) |

### The systemd-resolved route

Hack adds a per-link DNS route on the Docker bridge that carries the `hack-dev`
gateway address (`172.30.0.1`): the link's DNS server is CoreDNS (`172.30.0.53`),
its routing-only domains are Hack's suffixes (`~hack ~hack.local ~hack.gy`), and
it is not a default route. Only lookups for Hack's suffixes reach CoreDNS;
everything else keeps your normal DNS, VPN split DNS included.

Docker names that bridge `br-<network id>`, and the name changes whenever the
network is recreated. Hack therefore installs two files that never name it:

- `/etc/udev/rules.d/90-hack-dns.rules` starts `hack-dns@<interface>.service`
  whenever a bridge interface appears;
- `/etc/systemd/system/hack-dns@.service` waits up to about ten seconds for the
  gateway address on that interface and exits without changes on every other
  bridge. On Hack's bridge it runs `resolvectl dns`, `resolvectl domain`,
  `resolvectl default-route no` and `resolvectl dnssec no`.

The design re-applies the route whenever Docker creates the bridge: after a
reboot, and after the network is removed and recreated. Hack also starts the
unit once for the current bridge. It needs systemd 240 or later, `resolvectl`
and `ip`; on older systemd Hack reports `linux_dns_systemd_too_old` and prints
a dnsmasq alternative. Docker Desktop and rootless Docker keep the bridge out of
the host's reach, so Hack reports `linux_dns_bridge_missing` and writes nothing.

If `hack global install` could not prompt, it printed the commands; run them, then
check with `hack doctor`. A later `default_domain` change makes the installed unit
stale; rerun `hack global install` to update it.

### Check and remove

`hack doctor` reports the route as `linux dns route`, and `hack global status`
shows it under **Host DNS** (`host_dns` in `--json`). The codes are:

| Code | Meaning | Fix |
| --- | --- | --- |
| `linux_dns_route_missing` | Neither file is installed | `hack global install` |
| `linux_dns_route_stale` | A file is missing or differs (for example after a `default_domain` change) | `hack global install` |
| `linux_dns_route_not_applied` | Files are current, the bridge has no route yet | `sudo systemctl start hack-dns@<interface>.service` |
| `linux_dns_bridge_missing` | No host interface carries `172.30.0.1`: the network is down, or Docker runs in a VM (Docker Desktop) or rootless | `hack global up`; not supported on Docker Desktop or rootless Docker |
| `linux_dns_systemd_too_old` | systemd is older than 240 | Upgrade systemd, or use the printed dnsmasq lines |
| `linux_dns_resolved_bypassed` | The route exists, but lookups skip systemd-resolved | Point `/etc/resolv.conf` at the stub |
| `linux_dns_resolver_manual` | The host does not use systemd-resolved | Follow the printed steps |

`hack global down` offers to remove the route (the Linux counterpart of stopping
dnsmasq on macOS). It defaults to no. Yes reverts the bridge's resolver settings
(whenever they point at CoreDNS, even after a `default_domain` change) and
deletes both files.

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
