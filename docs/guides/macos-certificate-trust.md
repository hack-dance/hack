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
