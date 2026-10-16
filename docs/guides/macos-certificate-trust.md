# macOS certificate trust

After Caddy rotates its local root CA, an older trusted certificate with a similar
name does not establish trust in the new root. `hack doctor` checks the exported
CA's validity dates, exact certificate identity in the System keychain, macOS TLS
trust evaluation, and inclusion in Hack's host CA bundle.

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

These checks concern the exported root and host configuration. They do not prove
that every running service presents a valid leaf certificate or that an existing
browser process has refreshed its trust state.
