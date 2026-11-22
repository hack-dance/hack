# macOS certificate trust

After Caddy rotates its local root CA, an older trusted certificate with a similar
name does not establish trust in the new root. `hack doctor` checks the exported
CA's validity dates, exact certificate identity in the System keychain, macOS TLS
trust evaluation, and inclusion in Hack's host CA bundle.
It also reads the public root from the running Caddy container and compares its
certificate bytes with the export. An old export, old keychain entry and old host
bundle agreeing with one another cannot establish that Caddy's current root is
trusted. An unavailable runtime is reported as unverified, not healthy.

Run `hack global trust` to export the current root from the running Caddy instance,
install it in the System keychain, and refresh the host trust bundle and shell
environment. The keychain step uses the local administrator prompt. Never send an
administrator password to an agent or put it in a command. Non-interactive runs
skip this step when sudo would need a password; host environment preparation can
still finish independently.

`hack doctor --fix` can offer the same repair. After installation, Hack verifies
trust again before reporting success. Fully quit and reopen Chrome if it retains
the old trust state. Existing roots are preserved because another local service
may still depend on them.

Refreshing a stale public CA export is a separate confirmation from system trust.
Doctor rechecks the running root after confirmation and replaces only the export;
it leaves an existing export intact if the runtime cannot be verified. It refuses
symlink or non-regular export destinations. An expired, not-yet-valid, malformed
or non-CA certificate is refused before native import or host trust-bundle changes.
The export must contain exactly one PEM certificate, with no appended certificates
or other content, and fit within 64 KiB.
Trusting an expired root cannot renew it: investigate Caddy's PKI state first.

These checks concern the exported root and host configuration. They do not prove
that every running service presents a valid leaf certificate or that an existing
browser process has refreshed its trust state.

## Superseded Caddy roots

Each Caddy rotation or reinstall can leave an older root in the System keychain.
Doctor's `superseded caddy roots` check lists them. It reads the same System
keychain listing as the trust check and counts self-issued CA certificates with
the current root's subject but different certificate bytes. It ignores the year
in Caddy's root name, so a stale `2025 ECC Root` belongs with a live
`2026 ECC Root`. It also counts how many are expired or not yet valid. The
current root and roots with unrelated names are never counted.

The check is informational. A superseded root is never accepted as current trust.
Doctor and `hack doctor --fix` never remove keychain certificates, because
another local service may still depend on an older root. The JSON output adds a
`supersededRoots` object with `count`, `expired`, `notYetValid` and up to 32
public SHA-256 fingerprints (`sha256`), and nothing else. Both the Docker and
native Doctor paths run this check.

To remove a superseded root yourself:

1. Run `hack doctor --json > doctor-before.json` and note the
   `superseded caddy roots` count and the SHA-256 fingerprint you intend to remove.
2. List the matching keychain entries with their hashes:
   `security find-certificate -a -Z -c "Caddy Local Authority" /Library/Keychains/System.keychain`.
   Find the entry whose `SHA-256 hash` line equals a fingerprint from Doctor and
   copy the `SHA-1 hash` from that same entry. Use only a fingerprint that Doctor
   listed. A name match alone is not enough.
3. In your own terminal, run
   `sudo security delete-certificate -Z <SHA-1> /Library/Keychains/System.keychain`.
   Enter your password only at the native macOS administrator prompt. Never give
   an administrator password to an agent or put it in a command.
4. Run `hack doctor --json > doctor-after.json` and confirm that the count dropped
   and the removed fingerprint is gone. The current root's trust check must still
   pass.

The two files are a before and after record. That check holds only counts and
public fingerprints, but the full Doctor report holds other local details, so
review both files before you share them.
