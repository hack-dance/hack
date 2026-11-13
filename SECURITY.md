# Security Policy

## Supported Versions

Hack has two release lines:

| Line | Versions to report against |
| --- | --- |
| v4 stable (`main`) | The latest published 4.x release. Include the original version if an older installation is affected. |
| v5 prerelease (`next`) | The latest published `5.0.0-next.N`, with its exact tag or commit and selected backend. A prerelease is not a stable-support or production-readiness claim. |

Keep stable-line and prerelease reports separate. If possible, check the latest
release in the affected line; inability to upgrade does not prevent reporting.

## Reporting a Vulnerability

Please do not open public GitHub issues for suspected vulnerabilities.

Use one of these private channels instead:

1. If GitHub private vulnerability reporting is enabled, use this repository's
   `Security` tab -> `Report a vulnerability`.
2. If that option is unavailable, open a [maintainer contact issue](https://github.com/hack-dance/hack/issues/new)
   asking for a private follow-up channel. Include no affected secret values,
   exploit details, reproduction steps or sensitive attachments in that public
   contact request. Send the report below only through the private follow-up.

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

For v5 project env values, pipe input with `--value-stdin` and select `--secret`
to encrypt it, for example:

```sh
<secret-source> | hack env set <KEY> --secret --value-stdin
```

The project-key provider uses `.hack.secret.key` or the `HACK_ENV_SECRET_KEY`
override. Keep the key out of Git, images, logs and agent transcripts. The env
override can currently be inherited by child processes; do not treat it as
isolated key custody. Local `hack.env*.local.yaml` layers are local-only and can
hold plaintext; neither their filename nor Git ignore rules encrypts them.
Commit only reviewed non-sensitive configuration and example placeholders.

Read the [env and secrets threat model](docs/security/env-secrets-threat-model.md)
for custody paths, output risks and open gaps. It describes the audited v5
code; it is not a claim that every v4 installation has the same behavior.
