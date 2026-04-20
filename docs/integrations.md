# Local Helpers

Hack v3 no longer ships hosted or broker-backed integrations.

What remains:

- local tickets stored with the repo
- local env management and host/container injection
- local sessions and runtime orchestration
- optional coding-agent setup helpers

What was removed:

- built-in GitHub integration
- built-in Linear integration
- hosted auth/account/org/team surfaces
- web dashboard control plane

Recommended replacements:

- GitHub: native `git` and `gh`
- planning systems: keep them outside Hack, or use repo-local tickets when you want the workflow to stay self-contained
