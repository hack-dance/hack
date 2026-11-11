# Unsupported retained surfaces

Hack is a local-first CLI. Some older subsystems remain in the repository for
explicit maintenance but are outside the supported product. They are hidden from
`hack --help` (list them with `hack help --all`) and print a warning when invoked.

- `hack remote`, `hack gateway`, `hack node`, `hack dispatch`: remote execution and
  the control-plane gateway.
- `hack x <namespace> <command>`: the extension dispatcher, with the built-in
  `gateway`, `supervisor`, `cloudflare` and `tailscale` namespaces. `hack x list`
  shows registered extensions; enablement lives under `controlPlane.extensions`.
- The macOS app under `apps/macos/`, which is not distributed with the CLI.

Hosted accounts, organizations and teams, the web dashboard, Hack Tickets and the
built-in GitHub and Linear integrations are retired and no longer registered.

Do not depend on any of these for onboarding or default workflows. Bugs here are
treated as experimental unless they break the core local runtime. For the
supported product, read [Core concepts](core.md) and the [CLI overview](cli.md);
for the state models of the retained supervisor, see
[the supervisor statechart](supervisor-job-statechart.md).
