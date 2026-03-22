# GitHub Workflows

Use GitHub when you want Hack to do GitHub work for you.

GitHub is not part of the base Hack setup. You do not need it for `hack init`, `hack up`,
`hack open`, logs, local sessions, tickets, or public-repo remote workflows.

GitHub currently unlocks three things:

1. PR automation from Hack.
2. Private GitHub repo bootstrap on remote nodes when the node cannot already clone the repo.
3. A named GitHub profile that Hack Desktop and the CLI can route explicitly.

This is also separate from signing in to Hack with GitHub. `Sign in to Hack` controls your Hack
account. `Connect GitHub integration` gives Hack a GitHub identity it can use for GitHub-specific
workflows.

## When GitHub Is Optional

Leave GitHub disconnected if you are only using Hack for:

- local orchestration
- project routing and HTTPS
- logs and diagnostics
- tickets or Linear workflows
- remote execution against public repos
- remote execution where the node already has working Git credentials

## When GitHub Is Required

Connect GitHub when you want either of these workflows:

- `hack dispatch run --pr` or `hack x github pr-upsert`
- controller-assisted clone fallback for a private GitHub repo on a remote node

If the remote node can already clone the repo on its own, GitHub stays optional even for remote
execution.

## Fastest Setup By Goal

### 1. Interactive setup for a person using Hack

Use browser auth and pick an installation:

```bash
hack x github oauth-connect --profile personal --set-default
```

Use this when you want the simplest path to PR automation or private-repo fallback.

### 2. Bring an existing token

Use this when you already manage a token outside Hack:

```bash
hack x github connect --profile default --token-env HACK_GITHUB_APP_TOKEN

# or:
printf "%s" "$HACK_GITHUB_APP_TOKEN" | hack x github connect --profile default --stdin
```

### 3. Use GitHub App credentials for least privilege

Use this when you want installation-scoped auth that can refresh automatically:

```bash
hack x github connect \
  --profile work \
  --set-default \
  --app-id 12345 \
  --installation-id 67890 \
  --private-key-env HACK_GITHUB_APP_PRIVATE_KEY
```

## Common Commands

```bash
hack x github profiles
hack x github use --profile work
hack x github status --profile work
hack x github disconnect --profile work
```

PR creation/update:

```bash
hack x github pr-upsert \
  --profile work \
  --repo owner/repo \
  --head my-branch \
  --base main \
  --title "My PR" \
  --body "Details"
```

## Profile Selection

Hack resolves the GitHub profile in this order:

1. `--profile`
2. `controlPlane.routing.overrides.github.profile`
3. `controlPlane.extensions["dance.hack.github"].config.defaultProfile`

Use separate profiles when you need different GitHub identities for different repos or automations.

## Browser Auth Requirements

`hack x github oauth-connect` needs the GitHub OAuth app config in global Hack config:

- `controlPlane.extensions["dance.hack.github"].config.oauthClientId`
- `controlPlane.extensions["dance.hack.github"].config.oauthClientSecretAuthRef`

The referenced secret is stored in the OS keychain under service `hack-github-auth`.
