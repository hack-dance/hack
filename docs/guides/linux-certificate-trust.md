# Linux certificate trust

`hack global trust` makes the host trust Caddy's local root CA, so
`https://*.hack` and the other routed names open without warnings.

![Linux trust flow](../diagrams/linux-trust.svg)

[Diagram source](../diagrams/linux-trust.mmd).

## Which certificate

Before it changes any trust store, Hack checks the exported CA
(`~/.hack/caddy/pki/caddy-local-authority.crt`):

- it holds exactly one PEM certificate, at most 64 KiB;
- the certificate is a CA, self-signed (a root), and valid now;
- its bytes equal the root of the Caddy container this Hack home is running,
  read through the system Docker client (`/usr/bin/docker`,
  `/usr/local/bin/docker` or `/bin/docker`, root-owned and not writable by
  others) talking to the system engine socket (`/var/run/docker.sock` or
  `/run/docker.sock`, root-owned). Your Docker context, `DOCKER_HOST` and
  client configuration are ignored for this check, so a process running as
  you cannot answer it. Rootless Docker and Docker Desktop have no system
  engine, so automatic trust is refused there (`linux_trust_ca_unverified`).

If any check fails, Hack changes nothing and says why
(`linux_trust_ca_invalid` or `linux_trust_ca_unverified`). A stale export (Caddy
rotated its root) or one Hack cannot confirm (Docker or the proxy is down) is
refused. Run `hack global up`, then `hack global trust`.

On Linux, `global trust` uses that vetted client for runtime selection and CA
export from the start. It never runs PATH-selected Docker probes, Compose or a
Docker bootstrap before the trust prompt. An unavailable vetted engine stops
the command before any trust store is changed.

Hack passes the inspected bytes to the trust tools on stdin. A change to the
export while Hack is running cannot change what is trusted. The prompt shows the
certificate's subject and SHA-256 fingerprint. Docker, certutil and sudo receive
a fixed system PATH, the C locale and only identity/terminal variables; loader,
interpreter, locale-path and tool-selection variables are not inherited.

## What Hack updates

1. **Hack's host trust bundle and shell env** for Bun, Node, curl and git (no root).
   The verified CA is persisted as `~/.hack/caddy/pki/caddy-verified-authority.crt`.
   The generated `NODE_EXTRA_CA_CERTS` and `HACK_LOCAL_CA_CERT` reference that
   copy, including when no system CA bundle is available.
   Load it in the current shell with
   `source ~/.hack/caddy/pki/caddy-host-trust-env.sh` (the path is printed).
2. **The distribution trust store** (root). Hack reads `ID` and `ID_LIKE` from
   `/etc/os-release` and uses the family's own tool:

   | Family | Commands (each runs with `sudo`) |
   | --- | --- |
   | Debian, Ubuntu | `install … /usr/local/share/ca-certificates/hack-caddy-local-ca.crt`, then `update-ca-certificates` |
   | Fedora, RHEL, CentOS, Rocky, AlmaLinux | `install … /etc/pki/ca-trust/source/anchors/hack-caddy-local-ca.crt`, then `update-ca-trust extract` |
   | Arch and derivatives | `trust anchor --store <ca>`, then `update-ca-trust extract` |
   | openSUSE, SLES | `install … /etc/pki/trust/anchors/hack-caddy-local-ca.crt`, then `update-ca-certificates` |

   Hack shows the commands first and runs them only after you answer yes in a
   terminal. If the CA is already in the family's extracted bundle, nothing runs.
   The install and `trust anchor` steps run through a small `sh -c` script: root
   reads exactly the approved byte count from stdin under a time limit, checks
   its SHA-256 and installs atomically inside a root-owned directory with checked
   ancestors. Root never opens the user export. Arch first installs a root-owned
   copy at `/var/lib/hack/trust/caddy-local-ca.crt`, then passes that path to
   p11-kit. Printed manual commands open the export as your user before sudo;
   changed bytes fail the size or digest check. A failed or unverified system
   step stops the command before NSS or the host bundle is written.
   Printed manual commands use the same vetted absolute sudo path, fixed system
   PATH and C locale as the automatic path. If no sudo qualifies, Hack reports
   the missing tool without printing runnable root commands.
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
   shared directory) is skipped and reported. The `cert9.db` and `key4.db` files
   themselves must be regular files in that directory, including before
   initialization; dangling links are refused. Each ancestor must be owned by
   you or root and not group- or world-writable. Hack checks directory and
   ancestor identities immediately before and after each certutil operation.
   A change fails the command. These checks detect replacement; they cannot
   prevent a same-user process from swapping and restoring paths between checks.
   After import or a trust change, Hack reads the stored certificate back and
   compares it with the validated CA.

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

## Privileged manual commands

For the rotation and removal commands below, first define this helper in your
terminal. It uses the distribution's root-owned setuid `/usr/bin/sudo`, clears
loader variables before starting a helper process, and restores the fixed
environment after sudo. It does not look up sudo on your PATH.

```sh
hack_trust_root() (
  unset LD_PRELOAD LD_LIBRARY_PATH LD_AUDIT LD_DEBUG LD_DEBUG_OUTPUT \
    LD_PROFILE LD_ORIGIN_PATH LD_HWCAP_MASK GLIBC_TUNABLES GCONV_PATH \
    LOCPATH NLSPATH BASH_ENV ENV || return
  /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LANG=C LC_ALL=C \
    /usr/bin/sudo /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin \
    LANG=C LC_ALL=C "$@"
)
```

If that system sudo is unavailable, repair the distribution's sudo installation
before using these privileged commands. The helper changes only its child
environment; it does not change the current shell's environment.

## When Caddy rotates its root

Rerun `hack global trust`. Debian, Fedora and openSUSE overwrite Hack's anchor
file, so the old root is no longer trusted. On Arch, `trust anchor --store` adds
the new root next to the old one. After it adds a root, Hack lists every other
Caddy root still in the system bundle by SHA-256 fingerprint; remove one with
`trust list --filter=ca-anchors` to list candidate PKCS#11 URIs. That listing
does not include SHA-256 fingerprints. For each candidate URI, export it with
`trust extract --filter='pkcs11:…' --format=pem-bundle candidate.pem` and run
`openssl x509 -in candidate.pem -noout -fingerprint -sha256`. Compare that result
with the printed stale fingerprint before running
`hack_trust_root trust anchor --remove 'pkcs11:…'` with that exact URI, followed by
`hack_trust_root update-ca-trust extract`. Labels and subjects alone do not identify the old
root. Hack does not automatically enumerate or remove PKCS#11 objects.

## Remove what Hack added

Hack has no untrust command yet. With `hack_trust_root` defined above, remove its
changes by hand:

| Store | Commands |
| --- | --- |
| Debian, Ubuntu | `hack_trust_root rm /usr/local/share/ca-certificates/hack-caddy-local-ca.crt && hack_trust_root update-ca-certificates --fresh` |
| Fedora, RHEL | `hack_trust_root rm /etc/pki/ca-trust/source/anchors/hack-caddy-local-ca.crt && hack_trust_root update-ca-trust extract` |
| openSUSE, SLES | `hack_trust_root rm /etc/pki/trust/anchors/hack-caddy-local-ca.crt && hack_trust_root update-ca-certificates` |
| Arch | `trust list`, then `hack_trust_root trust anchor --remove 'pkcs11:…'` for the Caddy root's verified URI, then `hack_trust_root update-ca-trust extract` |
| Each NSS database | `certutil -d sql:<database dir> -D -n "Hack Caddy Local CA"` (repeat until it reports no such entry) |

The anchor files and nickname are fixed names, so these commands also remove an
entry with the same name that something other than Hack added.

Hack runs the system `sudo` itself (`/usr/bin/sudo` or `/bin/sudo`, which must be
a root-owned setuid file in root-owned directories), never one found on your
`PATH`. The fixed system `PATH` and C locale are reapplied after sudo, so its
`secure_path` cannot select a different root helper. If no vetted `sudo` exists,
system trust stays unchanged and Hack reports `linux_trust_tool_missing` without
printing runnable root commands. User-level NSS and host trust setup can still
continue, and the command can exit 0 if those steps succeed.

Never send a password to an agent or put it in a command; `sudo` asks in your
terminal.
