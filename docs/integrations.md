# Local Helpers

Hack v3 no longer ships hosted or broker-backed integrations.

What remains:

- local tickets stored with the repo — optional and opt-in: the `dance.hack.tickets` extension is
  disabled by default and must be enabled via `controlPlane.extensions["dance.hack.tickets"].enabled`
  (or auto-enabled by running `hack x tickets setup`); it is no longer part of default agent
  instructions
- local env management and host/container injection
- local sessions and runtime orchestration
- optional coding-agent setup helpers: `hack init --with claude|codex|both`, `hack agent onboard` /
  `hack agent init` / `hack agent prime`, and `hack setup sync --all-scopes`

What was removed:

- built-in GitHub integration
- built-in Linear integration
- hosted auth/account/org/team surfaces
- web dashboard control plane

Removed surfaces still exist as explicit tombstone commands (`hack auth`, `hack org`, `hack team`,
`hack linear`) that print a removal reason and the replacement, so hitting them redirects you
instead of failing hard.

Recommended replacements:

- GitHub: native `git` and `gh`
- planning systems: keep them outside Hack, or use repo-local tickets when you want the workflow to stay self-contained
