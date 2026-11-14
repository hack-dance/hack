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
| Linux | each discovered NSS database candidate (the shared user database and Chromium/Firefox profiles, as `hack global trust` finds them) | `certutil -d sql:<db> -L`, then `certutil -d sql:<db> -L -n "Hack Caddy Local CA" -a` | 5 s each |

`certutil` is the vetted absolute path `hack global trust` uses; queries run with
Hack's fixed helper environment. `certutil -L` opens databases read-only.

The whole check has a 20 s budget (doctor's own timeout for it is 30 s): no read or
query starts after it, each query's 5 s deadline is cut to what is left (a stopped
query's process group also gets a short termination grace), at most 16 NSS
databases are queried, and files over 32 MiB are not read. A read, directory
listing or tool lookup still pending at the deadline answers `unknown` then, and
its late result is dropped. Whatever was not reached is reported `unknown`, so the
check returns a complete report by the budget.

## Result

Each store is `trusted`, `not_trusted` or `unknown`. Unknown means Hack could not
tell (a read that failed or timed out, a directory that could not be listed while
looking for NSS databases, an unrecognised distribution, no `certutil`, no
exported CA, a query that could not start, or the budget ran out); it is never
reported as "not trusted". On macOS only `verify-cert`'s exit 1 (a completed
evaluation that failed) means not trusted.

- macOS: trusted when the keychain holds the exact exported CA and `verify-cert`
  accepts it for TLS.
- Linux system: trusted when the bundle contains the exact CA; a missing bundle is
  not trusted.
- Linux NSS: trusted when Hack's entry carries TLS issuer trust (`C`) and holds the
  exact CA. A discovered candidate with missing or unreadable database/module
  metadata is unknown. Optional browser roots that do not exist are not stores.

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

## Linux NSS read safety

![NSS read admission](../diagrams/nss-read-safety.svg)

[Diagram source](../diagrams/nss-read-safety.mmd).

Opening an NSS database can load PKCS#11 code even for `certutil -L`. Doctor
therefore applies the existing trust-install ownership and identity guard before
admitting a read. The selected home, XDG config and XDG data roots are preserved;
there is no substitute HOME, copied profile, NSS initialization or repair.

A candidate must resolve inside those selected roots. Its directory and both traversed and resolved
ancestors must be owned by the user or root and not writable by another user;
`cert9.db`, `key4.db` and `pkcs11.txt` must be private regular files owned by the
current user. Database and metadata file links, including dangling links, are
refused. Profile-directory aliases contained within the selected roots remain
supported. Missing or unreadable required files are Unknown, never proof that
trust is absent or healthy.

Module discovery is deliberately conservative. `pkcs11.txt` is limited to 16 KiB
and must exactly match a supported single built-in `NSS Internal PKCS #11 Module`
template: empty `library`, the selected SQL configuration directory, empty
certificate/key prefixes and flags, the literal `secmod.db` parameter, and absent
or empty update parameters. The internal module flags are exactly
`internal,critical`, trust/cipher ordering is 75/100, and the default slot list
(with or without ECC) uses `askpw=any timeout=30`. Escapes, comments, alternate
quoting/case/order, duplicate keys, extra records and other configurations are
unsupported. Doctor does not run NSS to interpret them. All external module
libraries, including apparently owned ones, are refused. A legacy `secmod.db`,
`cert8.db` or `key3.db` file, or a SQLite `-wal`, `-shm` or `-journal` sidecar for
either SQL database, also makes the result Unknown, avoiding migration or journal
recovery during observation. The metadata parameter `secmod='secmod.db'` is
allowed only while that legacy file is provably absent.

Immediately before and after each query, Doctor rechecks the pinned database,
directory and ancestor identities, module-file identity and metadata digest,
and the absence of legacy/sidecar files. It discards results if a check fails
and starts no later query for that database. Queries use the vetted absolute
`certutil`, explicit `-d sql:<selected database>` and the existing fixed helper
environment, which removes inherited NSS and loader selectors while preserving
the selected home. Discovery admits at most 256 entries per directory; oversized
or unreadable discovery is Unknown. The existing 16-database and 20-second limits
also cover these safety checks.

These path checks are not an atomic binding to NSS's later opens. A process
running as the same user can still swap a database or metadata after the last
check and restore it before the next check, or edit database contents in place.
Doctor accepts that residual same-user race; it does not claim to isolate NSS
from a hostile process with the same user identity. Unknown does not prove the
browser distrusts the CA: external modules such as p11-kit may provide trust that
this observer deliberately refuses to load. A completed negative result concerns
Hack's entry in that admitted user database, not every browser trust source.
