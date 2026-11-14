# Local CA trust check

`hack doctor` reports whether the operating system trusts Hack's Caddy Local CA,
the root that signs `https://*.hack` certificates on the Compose path. The check
is `local ca trust`. `caddy local ca` checks only that the exported copy matches
the running Caddy.

The check is read-only and bounded. It never prompts, never asks for an
administrator password, and never changes a trust store or NSS database.

## What it reads

| Platform | Store | Reads | Deadline |
|---|---|---|---|
| all | the exported CA, `~/.hack/caddy/pki/caddy-local-authority.crt` | the file | — |
| macOS | the System keychain | `security find-certificate -a -p /Library/Keychains/System.keychain`, then `security verify-cert -c <exported CA> -p ssl -l -k /Library/Keychains/System.keychain -L -q` (local trust settings only, no network) | 5 s each |
| Linux | the distribution's system bundle (from `/etc/os-release`: Debian/Ubuntu `/etc/ssl/certs/ca-certificates.crt`, Fedora `/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem`, SUSE `/var/lib/ca-certificates/ca-bundle.pem`, Arch `/etc/ssl/certs/ca-certificates.crt`) | the file | — |
| Linux | each NSS database that exists (the shared user database and Chromium/Firefox profiles, as `hack global trust` finds them) | `certutil -d sql:<db> -L`, then `certutil -d sql:<db> -L -n "Hack Caddy Local CA" -a` | 5 s each |

`certutil` is the vetted absolute path `hack global trust` uses; queries run with
Hack's fixed helper environment.

## Result

Each store is `trusted`, `not_trusted` or `unknown`. Unknown means Hack could not
tell (a read that failed or timed out, an unrecognised distribution, no
`certutil`, no exported CA); it is never reported as "not trusted".

- macOS: trusted when the keychain holds the exact exported CA and `verify-cert`
  accepts it for TLS.
- Linux system: trusted when the bundle contains the exact CA; a missing bundle is
  not trusted.
- Linux NSS: trusted when Hack's entry carries TLS issuer trust (`C`) and holds the
  exact CA. A profile without `cert9.db` is not a database and is not listed.

The overall state is `not_trusted` if any store is, otherwise `unknown` if any is,
otherwise `trusted`. The check is `ok` when trusted and a warning otherwise; the
message says which store and why. Fix: `hack global trust`.

`hack doctor --json` adds the report to the check:

```json
{
  "id": "local ca trust",
  "status": "warn",
  "detail": "The local CA is not trusted everywhere: …",
  "caTrust": {
    "platform": "linux",
    "ca": { "path": "~/.hack/caddy/pki/caddy-local-authority.crt", "state": "valid", "fingerprint256": "AB:CD:…" },
    "system": { "store": "/etc/ssl/certs/ca-certificates.crt", "state": "trusted", "detail": "…" },
    "nss": [ { "db": "~/.mozilla/firefox/<profile>", "state": "not_trusted", "detail": "…" } ],
    "state": "not_trusted"
  }
}
```

`ca.state` is `valid`, `missing`, `unreadable` or `invalid` (not a CA, expired or
not yet valid); when it is not `valid`, every store is `unknown`. Paths in the
report are absolute.
