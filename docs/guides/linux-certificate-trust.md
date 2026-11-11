# Linux certificate trust

`hack global trust` makes the host trust Caddy's local root CA, so
`https://*.hack` and the other routed names open without warnings.

## Which certificate

Before it changes any trust store, Hack checks the exported CA
(`~/.hack/caddy/pki/caddy-local-authority.crt`):

- it holds exactly one PEM certificate, at most 64 KiB;
- the certificate is a CA, self-signed (a root), and valid now;
- its bytes equal the root of the Caddy container this Hack home is running.

If any check fails, Hack changes nothing and says why
(`linux_trust_ca_invalid` or `linux_trust_ca_unverified`). A stale export (Caddy
rotated its root) or one Hack cannot confirm (Docker or the proxy is down) is
refused. Run `hack global up`, then `hack global trust`.

Hack then copies those inspected bytes into a private temporary file (0600 in a
0700 directory) and gives only that copy to the trust tools, so a change to the
export while Hack is running cannot change what is trusted. The prompt shows the
certificate's subject and SHA-256 fingerprint.

## What Hack updates

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
   The install and `trust anchor` steps run through a small `sh -c` script: root
   copies the staged CA into a root-owned temporary file and checks its SHA-256
   against the bytes Hack inspected, so a file replaced after you answer is
   refused. On an unknown distribution Hack prints the same commands, quoted, for
   each family.
3. **NSS databases** for Chrome, Chromium and Firefox (no root). With `certutil`
   installed, Hack runs it by its resolved absolute path and adds the CA as a
   trusted TLS issuer (trust attributes `C,,`), nickname `Hack Caddy Local CA`,
   to:
   - the shared user database Chromium uses: an existing `~/.pki/nssdb`, else an
     existing `$XDG_DATA_HOME/pki/nssdb` (default `~/.local/share/pki/nssdb`,
     Chromium M146 and later), else a new `~/.pki/nssdb` (Hack creates the
     directory, mode 0700, then the database);
   - existing snap or Flatpak Chromium databases
     (`~/snap/chromium/current/.pki/nssdb`, `~/.var/app/<app>/.pki/nssdb`);
   - every Firefox profile with a `cert9.db` under `~/.mozilla/firefox/`,
     `$XDG_CONFIG_HOME/mozilla/firefox/` (default `~/.config/mozilla/firefox/`),
     `~/snap/firefox/common/.mozilla/firefox/` or
     `~/.var/app/org.mozilla.firefox/{.mozilla,config/mozilla}/firefox/`.

   An older CA under the same nickname is replaced. An entry with the current CA
   but without TLS issuer trust gets `C,,` set. Restart the browser afterwards.
   Without `certutil`, Hack says so and names the package (`libnss3-tools`,
   `nss-tools`, `mozilla-nss-tools` or `nss`).

   **Ownership policy.** Hack writes to a database only when, after resolving
   every symlink, its directory is inside your home directory (or your XDG
   config directory), and both the directory and its `cert9.db` are owned by
   you and not group- or world-writable. Symlinks that stay inside your home,
   such as snap's `current` revision link and Flatpak's per-app tree, are
   followed. A database that resolves elsewhere (another user's profile, a
   shared directory) is skipped and reported.

A run that cannot prompt (no TTY, `HACK_NO_INTERACTIVE=1` or `--no-interactive`)
never runs `sudo`. It still prepares the host bundle and the NSS databases,
prints the root commands, and reports a stable code:

| Code | Meaning |
| --- | --- |
| `linux_trust_system_pending` | Root step not run (no prompt possible, or declined); commands printed |
| `linux_trust_system_failed` | A root command failed; `hack global trust` exits 1 |
| `linux_trust_distro_unknown` | `/etc/os-release` matched no known family; manual commands printed |
| `linux_trust_ca_invalid` | The export is missing, not exactly one certificate, not a self-signed CA, or outside its validity; nothing changes and `hack global trust` exits 1 |
| `linux_trust_ca_unverified` | The export is not confirmed as the running Caddy root (stale, foreign, or Docker unavailable); nothing changes and `hack global trust` exits 1 |
| `linux_trust_tool_missing` | The family's refresh tool is not installed |
| `linux_trust_nss_certutil_missing` | `certutil` is missing; browsers were not updated |

## When Caddy rotates its root

Rerun `hack global trust`. Debian, Fedora and openSUSE overwrite Hack's anchor
file, so the old root is no longer trusted. On Arch, `trust anchor --store` adds
the new root next to the old one. After it adds a root, Hack lists every other
Caddy root still in the system bundle by SHA-256 fingerprint; remove one with
`trust list` (find the entry with that fingerprint) and
`sudo trust anchor --remove 'pkcs11:…'` using the URI it prints.

## Remove what Hack added

Hack has no untrust command yet. To remove its changes by hand:

| Store | Commands |
| --- | --- |
| Debian, Ubuntu | `sudo rm /usr/local/share/ca-certificates/hack-caddy-local-ca.crt && sudo update-ca-certificates --fresh` |
| Fedora, RHEL | `sudo rm /etc/pki/ca-trust/source/anchors/hack-caddy-local-ca.crt && sudo update-ca-trust extract` |
| openSUSE, SLES | `sudo rm /etc/pki/trust/anchors/hack-caddy-local-ca.crt && sudo update-ca-certificates` |
| Arch | `trust list`, then `sudo trust anchor --remove 'pkcs11:…'` for the Caddy root's URI |
| Each NSS database | `certutil -d sql:<database dir> -D -n "Hack Caddy Local CA"` (repeat until it reports no such entry) |

The anchor files and nickname are fixed names, so these commands also remove an
entry with the same name that something other than Hack added.

Never send a password to an agent or put it in a command; `sudo` asks in your
terminal.
