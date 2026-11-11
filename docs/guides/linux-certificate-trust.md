# Linux certificate trust

`hack global trust` makes the host trust Caddy's local root CA, so
`https://*.hack` and the other routed names open without warnings. On Linux it
updates three places:

1. **Hack's host trust bundle and shell env** for Bun, Node, curl and git (no root).
   Load it in the current shell with
   `source ~/.hack/caddy/pki/caddy-host-trust-env.sh` (the path is printed).
2. **The distribution trust store** (root). Hack reads `ID` and `ID_LIKE` from
   `/etc/os-release` and uses the family's own tool:

   | Family | Commands (each runs with `sudo`) |
   | --- | --- |
   | Debian, Ubuntu | `install … /usr/local/share/ca-certificates/hack-caddy-local-ca.crt`, then `update-ca-certificates` |
   | Fedora, RHEL, CentOS, Rocky, AlmaLinux | `install … /etc/pki/ca-trust/source/anchors/hack-caddy-local-ca.crt`, then `update-ca-trust extract` |
   | Arch and derivatives | `trust anchor --store <ca>` |
   | openSUSE, SLES | `install … /etc/pki/trust/anchors/hack-caddy-local-ca.crt`, then `update-ca-certificates` |

   Hack shows the commands first and runs them only after you answer yes in a
   terminal. If the CA is already in the family's extracted bundle, nothing runs.
3. **NSS databases** for Chrome, Chromium and Firefox (no root). With `certutil`
   installed, Hack adds the CA as a trusted TLS issuer, nickname
   `Hack Caddy Local CA`, to `~/.pki/nssdb` (it creates the database when
   missing), to existing snap or Flatpak Chromium databases
   (`~/snap/chromium/current/.pki/nssdb`, `~/.var/app/<app>/.pki/nssdb`), and to
   every Firefox profile with a `cert9.db` under `~/.mozilla/firefox/`,
   `$XDG_CONFIG_HOME/mozilla/firefox/` (default `~/.config/mozilla/firefox/`),
   `~/snap/firefox/common/.mozilla/firefox/` or
   `~/.var/app/org.mozilla.firefox/{.mozilla,config/mozilla}/firefox/`. An older CA under the same
   nickname is replaced. Restart the browser afterwards.
   Without `certutil`, Hack says so and names the package (`libnss3-tools`,
   `nss-tools`, `mozilla-nss-tools` or `nss`).

A run that cannot prompt (no TTY, `HACK_NO_INTERACTIVE=1` or `--no-interactive`)
never runs `sudo`. It still prepares the host bundle and the NSS databases,
prints the root commands, and reports a stable code:

| Code | Meaning |
| --- | --- |
| `linux_trust_system_pending` | Root step not run (no prompt possible, or declined); commands printed |
| `linux_trust_system_failed` | A root command failed; `hack global trust` exits 1 |
| `linux_trust_distro_unknown` | `/etc/os-release` matched no known family; manual commands printed |
| `linux_trust_tool_missing` | The family's refresh tool is not installed |
| `linux_trust_nss_certutil_missing` | `certutil` is missing; browsers were not updated |

When Caddy rotates its root, rerun `hack global trust`. Debian, Fedora and
openSUSE overwrite Hack's anchor file; on Arch, `trust anchor --store` adds the
new root next to the old one, which stays trusted until you remove it with
`sudo trust anchor --remove <old-ca-file>` (or by its `pkcs11:` URI from
`trust list`).

To undo: `certutil -d sql:<db> -D -n "Hack Caddy Local CA"` for each NSS
database, then remove the anchor (`sudo rm` the anchor file and run the refresh
command above, or `sudo trust anchor --remove` on Arch).

Never send a password to an agent or put it in a command; `sudo` asks in your
terminal.
