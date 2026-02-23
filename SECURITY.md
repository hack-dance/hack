# Security Policy

## Supported Versions

Security fixes are prioritized for the latest release on the default branch.

If you are running an older release, upgrade to the latest version before reporting runtime behavior as a security issue.

## Reporting a Vulnerability

Please do not open public GitHub issues for suspected vulnerabilities.

Use one of these private channels instead:

1. GitHub Security Advisories for this repository (`Security` tab -> `Report a vulnerability`)
2. If private reporting is unavailable, open a maintainer contact issue that contains no exploit details and asks for a private follow-up channel

Include:

1. Affected version/commit
2. Impact summary
3. Reproduction steps or proof of concept
4. Suggested mitigation if available

## Response Expectations

1. Initial triage target: within 3 business days
2. Status updates: at least weekly for confirmed issues
3. Remediation and release timing depends on severity and exploitability

## Secret Handling for Contributors

Never commit real credentials, tokens, private keys, or production environment values.

Use local `.env.local` files and keychain/secret-store references. Commit only example templates such as `.env.example` files with empty or placeholder values.
